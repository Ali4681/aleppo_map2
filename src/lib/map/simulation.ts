import type { Coordinate, FeatureCollection, MapMeta } from './types';
import { getTags, linesOf, polygonsOf } from './types';

export type NetworkKind = 'electricity' | 'sewer' | 'telephone' | 'water';
export type Point2 = [number, number];
export type NodeType = 'pole' | 'transformer' | 'manhole' | 'valve' | 'junction';
export interface NetworkSpec { name: string; color: string; depth: number; height: number; node: string; overhead: boolean; }
export const NETWORKS: Record<NetworkKind, NetworkSpec> = {
  electricity: { name: 'الكهرباء', color: '#e8b946', depth: 0, height: 8.8, node: 'عمود كهرباء', overhead: true },
  sewer: { name: 'الصرف الصحي', color: '#ba7952', depth: 2.6, height: 0, node: 'غرفة تفتيش', overhead: false },
  telephone: { name: 'الهاتف والاتصالات', color: '#a899c2', depth: 0, height: 6.2, node: 'عمود اتصالات', overhead: true },
  water: { name: 'المياه', color: '#4f9fae', depth: 1.35, height: 0, node: 'صمام مياه', overhead: false },
};
export const NETWORK_KINDS = Object.keys(NETWORKS) as NetworkKind[];
export interface NetworkEdge {
  id: string; kind: NetworkKind; from: Point2; to: Point2;
  fromHeight: number; toHeight: number; depth: number; height: number;
  diameterMm: number; length: number; road: string; status: 'normal' | 'maintenance';
  attributes: Record<string, string | number>; simulated: true;
}
export interface NetworkNode {
  id: string; kind: NetworkKind; point: Point2; depth: number; height: number;
  connections: number; nodeType: NodeType; simulated: true;
}
export interface SimulatedNetworks { edges: NetworkEdge[]; nodes: NetworkNode[]; }
export function seededValue(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0) / 4294967296;
}
const WIDTHS: Record<string, number> = { primary: 11, secondary: 9, tertiary: 7.5, residential: 6, unclassified: 6, living_street: 4, service: 4, pedestrian: 3.8, footway: 2.2, path: 2.2, corridor: 2.2 };
const keyOf = (point: Point2) => `${point[0].toFixed(2)},${point[1].toFixed(2)}`;

function clip(a: Point2, b: Point2, width: number, height: number): [Point2, Point2] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1]; let low = 0, high = 1;
  for (const [p, q] of [[-dx, a[0]], [dx, width - a[0]], [-dy, a[1]], [dy, height - a[1]]]) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return null; continue; }
    if (p < 0) low = Math.max(low, q / p); else high = Math.min(high, q / p);
    if (low > high) return null;
  }
  return [[a[0] + low * dx, a[1] + low * dy], [a[0] + high * dx, a[1] + high * dy]];
}
function inRing(point: Point2, ring: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function simplify(points: Point2[], protectedKeys: Set<string>): Point2[] {
  if(points.length<3)return points;
  const keep=new Set<number>([0,points.length-1]);
  points.forEach((point,index)=>{if(protectedKeys.has(keyOf(point)))keep.add(index);});
  const anchors=[...keep].sort((a,b)=>a-b),stack:Array<[number,number]>=[];
  for(let i=1;i<anchors.length;i++)stack.push([anchors[i-1],anchors[i]]);
  while(stack.length){const [first,last]=stack.pop()!;const a=points[first],b=points[last],dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;let furthest=-1,best=.8*.8;
    for(let i=first+1;i<last;i++){const p=points[i],t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)):0,dist=(p[0]-a[0]-t*dx)**2+(p[1]-a[1]-t*dy)**2;if(dist>best){best=dist;furthest=i;}}
    if(furthest>=0){keep.add(furthest);stack.push([first,furthest],[furthest,last]);}
  }
  return [...keep].sort((a,b)=>a-b).map(index=>points[index]);
}

/** Spatial buckets avoid scanning every building for each support or pipe. */
function buildingMask(buildings: FeatureCollection | undefined, project: (p: Coordinate) => Point2) {
  type Footprint = { rings: Point2[][]; bounds: number[] };
  const buckets = new Map<string, Footprint[]>(), size = 40;
  for (const feature of buildings?.features || []) {
    if (!getTags(feature.properties).building) continue;
    for (const polygon of polygonsOf(feature.geometry)) {
      const rings = polygon.map(ring => ring.map(project)); if (!rings[0]?.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of rings[0]) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const item = { rings, bounds: [x0, y0, x1, y1] };
      for (let y = Math.floor(y0 / size); y <= Math.floor(y1 / size); y++) for (let x = Math.floor(x0 / size); x <= Math.floor(x1 / size); x++) {
        const key = `${x},${y}`, bucket = buckets.get(key) || []; bucket.push(item); buckets.set(key, bucket);
      }
    }
  }
  return (point: Point2): boolean => (buckets.get(`${Math.floor(point[0] / size)},${Math.floor(point[1] / size)}`) || []).some(item => {
    const [x0, y0, x1, y1] = item.bounds;
    return point[0] >= x0 && point[0] <= x1 && point[1] >= y0 && point[1] <= y1 && inRing(point, item.rings[0]) && !item.rings.slice(1).some(ring => inRing(point, ring));
  });
}

/** Plausible demonstration geometry, not a network survey or engineering solver. */
export function generateNetworks(roads: FeatureCollection, meta: MapMeta, elevation: (x: number, y: number) => number = () => 0, buildings?: FeatureCollection): SimulatedNetworks {
  const edges: NetworkEdge[] = [], nodeMap = new Map<string, NetworkNode>(), seen = new Set<string>();
  const project = (p: Coordinate): Point2 => [(p[0] - meta.lon0) * meta.kx, (p[1] - meta.lat0) * meta.ky];
  const blocked = buildingMask(buildings, project), width = meta.W * meta.S, height = meta.H * meta.S;
  const occurrences=new Map<string,number>();
  for(const road of roads.features)for(const line of linesOf(road.geometry))for(const point of line){const key=keyOf(project(point));occurrences.set(key,(occurrences.get(key)||0)+1);}
  const junctionKeys=new Set([...occurrences].filter(([,count])=>count>1).map(([key])=>key));
  const inside = (p: Point2) => p[0] >= 0 && p[1] >= 0 && p[0] <= width && p[1] <= height && !blocked(p) && elevation(...p) <= 0;
  const placements = new Map<string, Point2 | null>();
  // One height function per buried network keeps junction invert depths consistent.
  const levelAt = (kind: NetworkKind, point: Point2) => NETWORKS[kind].overhead ? NETWORKS[kind].height : kind === 'sewer' ? -(2 + point[0] / width * 1.1 + (height - point[1]) / height * .6) : -1.35;
  for (const road of roads.features) {
    const tags = getTags(road.properties), roadWidth = WIDTHS[tags.highway];
    if (!roadWidth || tags.bridge === 'yes' || (tags.tunnel && tags.tunnel !== 'no')) continue;
    for (const [lineIndex, coordinates] of linesOf(road.geometry).entries()) {
     const line=simplify(coordinates.map(project),junctionKeys);
     for (let index = 1; index < line.length; index++) {
      const clipped = clip(line[index - 1], line[index], width, height); if (!clipped) continue;
      const [start, end] = clipped, total = Math.hypot(end[0] - start[0], end[1] - start[1]); if (total < 3) continue;
      // Break long spans into supports/chambers instead of drawing kilometre-long wires.
      const pieces = Math.max(1, Math.ceil(total / 32));
      for (let piece = 0; piece < pieces; piece++) {
        const a: Point2 = [start[0] + (end[0] - start[0]) * piece / pieces, start[1] + (end[1] - start[1]) * piece / pieces];
        const b: Point2 = [start[0] + (end[0] - start[0]) * (piece + 1) / pieces, start[1] + (end[1] - start[1]) * (piece + 1) / pieces];
        const routeKey = [keyOf(a), keyOf(b)].sort().join('|'); if (seen.has(routeKey)) continue; seen.add(routeKey);
        const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const normal: Point2 = [-(b[1] - a[1]) / distance, (b[0] - a[0]) / distance];
        for (const kind of NETWORK_KINDS) {
          const spec = NETWORKS[kind];
          if (spec.overhead && (tags.covered === 'yes' || roadWidth < 3)) continue;
          function place(point: Point2): Point2 | null {
            const key = `${kind}:${keyOf(point)}`;
            if (placements.has(key)) return placements.get(key)!;
            const side = kind === 'telephone' ? -1 : 1;
            const offsets = spec.overhead ? [side * roadWidth * .42, side * roadWidth * .3, -side * roadWidth * .4, 0] : kind === 'water' ? [roadWidth * .2, 0, -roadWidth * .2] : [0];
            const found = offsets.map(offset => [point[0] + normal[0] * offset, point[1] + normal[1] * offset] as Point2).find(inside) || null;
            placements.set(key, found); return found;
          }
          let from = place(a), to = place(b); if (!from || !to) continue;
          let fromHeight = levelAt(kind, from), toHeight = levelAt(kind, to);
          if (kind === 'sewer' && fromHeight < toHeight) { [from, to] = [to, from]; [fromHeight, toHeight] = [toHeight, fromHeight]; }
          const length = Math.hypot(to[0] - from[0], to[1] - from[1]); if (length < 1) continue;
          let clear = true;
          for (let step = 0; step <= Math.ceil(length / 3); step++) {
            const t = step / Math.ceil(length / 3);
            if (!inside([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t])) { clear = false; break; }
          }
          if (!clear) continue;
          const id = `SIM-${kind}-${road.id ?? routeKey}-${lineIndex}-${index}-${piece}`, r = seededValue(id);
          const main = ['primary', 'secondary', 'tertiary'].includes(tags.highway);
          const diameterMm = kind === 'water' ? main ? 250 : 110 : kind === 'sewer' ? main ? 500 : 250 : kind === 'electricity' ? 22 : 15;
          const depth = spec.overhead ? 0 : -(fromHeight + toHeight) / 2;
          const attributes: Record<string, string | number> = {
            'طريقة التمديد الافتراضية': spec.overhead ? 'هوائي على أعمدة بجانب الطريق' : 'مدفون تحت الطريق',
            'الخامة الافتراضية': kind === 'water' ? 'بولي إيثيلين' : kind === 'sewer' ? 'أنبوب صرف' : kind === 'electricity' ? 'موصل ألمنيوم' : 'كابل اتصالات معزول',
          };
          if (kind === 'water') Object.assign(attributes, { 'قطر افتراضي (مم)': diameterMm, 'ضغط افتراضي (بار)': +(2.5 + r * 2).toFixed(1) });
          if (kind === 'sewer') Object.assign(attributes, { 'قطر افتراضي (مم)': diameterMm, 'الميل الهندسي التجريبي (%)': +((fromHeight - toHeight) / length * 100).toFixed(3), 'اتجاه الجريان الافتراضي': 'نحو نهاية المقطع الأقل منسوبًا' });
          if (kind === 'electricity') Object.assign(attributes, { 'جهد افتراضي (فولت)': 400, 'عدد الموصلات': 4, 'حمل افتراضي (%)': Math.round(20 + r * 60) });
          if (kind === 'telephone') Object.assign(attributes, { 'النوع الافتراضي': 'كابل اتصالات / ألياف', 'عدد الألياف الافتراضي': main ? 96 : 24 });
          edges.push({ id, kind, from, to, fromHeight, toHeight, depth, height: spec.height, diameterMm, length: +length.toFixed(2), road: tags['name:ar'] || tags.name || 'شارع دون اسم', status: r > .98 ? 'maintenance' : 'normal', attributes, simulated: true });
          for (const point of [from, to]) {
            const key = `${kind}:${keyOf(point)}`, previous = nodeMap.get(key);
            if (previous) previous.connections++;
            else nodeMap.set(key, { id: `SIM-NODE-${key}`, kind, point, depth: spec.overhead ? 0 : -levelAt(kind, point), height: spec.height, connections: 1, nodeType: spec.overhead ? 'pole' : kind === 'sewer' ? 'manhole' : 'junction', simulated: true });
          }
        }
      }
    }
    }
  }
  for (const node of nodeMap.values()) {
    if (node.kind === 'water' && (node.connections !== 2 || seededValue(node.id) > .92)) node.nodeType = 'valve';
    if (node.kind === 'electricity' && node.connections >= 3 && seededValue(node.id) > .55) node.nodeType = 'transformer';
  }
  return { edges, nodes: [...nodeMap.values()] };
}

export function networkGeoJson(data: SimulatedNetworks, meta: MapMeta): FeatureCollection {
  const coordinate = (p: Point2): Coordinate => [meta.lon0 + p[0] / meta.kx, meta.lat0 + p[1] / meta.ky];
  const common = { simulated: true, disclaimer: 'نموذج بصري وهمي؛ ليس مسحًا لشبكات حقيقية أو تصميمًا هندسيًا' };
  return { type: 'FeatureCollection', features: [
    ...data.edges.map(edge => ({ type: 'Feature' as const, id: edge.id, properties: { ...common, network: edge.kind, network_name: NETWORKS[edge.kind].name, installation: NETWORKS[edge.kind].overhead ? 'overhead' : 'underground', depth_m: edge.depth, height_m: edge.height, from_level_m: edge.fromHeight, to_level_m: edge.toHeight, diameter_mm: edge.diameterMm, length_m: edge.length, status: edge.status, road: edge.road, ...edge.attributes }, geometry: { type: 'LineString' as const, coordinates: [coordinate(edge.from), coordinate(edge.to)] } })),
    ...data.nodes.map(node => ({ type: 'Feature' as const, id: node.id, properties: { ...common, network: node.kind, node_type: node.nodeType, depth_m: node.depth, height_m: node.height, connections: node.connections }, geometry: { type: 'Point' as const, coordinates: coordinate(node.point) } })),
  ] };
}
