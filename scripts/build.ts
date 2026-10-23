import type { FeatureCollection, Geometry, Tags, Coordinate } from '../src/lib/map/types';
import { getTags, polygonsOf, linesOf, pointsOf } from '../src/lib/map/types';
type RasterFeature = {
    T: Tags;
    id: number;
    geometry: Geometry;
};
type MetricPoint = [
    number,
    number
];
type CellPainter = (index: number) => void;
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { BBOX, CITADEL, kx, ky } from './config';
import { readQgis } from './qgis-source';
export function hash(id: number | string) {
    let n = Number(id) | 0;
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
const RUBBLE = true;
try {
    const S = Number(process.argv[2] ?? 3);
    if (!Number.isFinite(S) || S <= 0)
        throw new Error('Cell size must be a positive number');
    const W = Math.ceil((BBOX[3] - BBOX[1]) * kx / S), H = Math.ceil((BBOX[2] - BBOX[0]) * ky / S);
    if (W > 65535 || H > 65535 || W * H > 20000000)
        throw new Error('Cell size too small for binary grid');
    const ground = new Uint8Array(W * H), park = new Uint8Array(W * H), bh = new Uint8Array(W * H), bc = new Uint8Array(W * H);
    let sourcePath = process.argv[3];
    if (!sourcePath) {
        try {
            sourcePath = (await stat('qgis')).isDirectory() ? 'qgis' : 'old.geojson';
        }
        catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
            sourcePath = 'old.geojson';
        }
    }
    const source: FeatureCollection = (await stat(sourcePath)).isDirectory()
        ? await readQgis(sourcePath)
        : JSON.parse(await readFile(sourcePath, 'utf8'));
    if (sourcePath === 'qgis')
        await writeFile('old.geojson', JSON.stringify(source));
    console.log(`Source: ${sourcePath}`);
    if (!Array.isArray(source.features))
        throw new Error('Expected GeoJSON FeatureCollection');
    const project = (p: Coordinate): MetricPoint => [(p[0] - BBOX[1]) * kx, (p[1] - BBOX[0]) * ky];
    const features: RasterFeature[] = source.features.filter(f => f.geometry).map(f => ({ T: getTags(f.properties), id: Number(String(f.id ?? f.properties?.id ?? 0).split('/').pop()) || 0, geometry: f.geometry! }));
    const polygons = (f: RasterFeature) => polygonsOf(f.geometry).map(p => p.map(r => r.map(project)));
    const lines = (f: RasterFeature) => linesOf(f.geometry).map(l => l.map(project));
    const points = (f: RasterFeature) => pointsOf(f.geometry).map(project);
    const inside = (x: number, y: number, rings: MetricPoint[][]) => {
        let yes = false;
        for (const ring of rings)
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const a = ring[i], b = ring[j];
                if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])
                    yes = !yes;
            }
        return yes;
    };
    function fill(rings: MetricPoint[][], fn: CellPainter) {
        const outer = rings[0];
        if (!outer?.length)
            return 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y] of outer) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
        let count = 0;
        for (let iy = Math.max(0, Math.floor(minY / S)); iy <= Math.min(H - 1, Math.floor(maxY / S)); iy++)
            for (let ix = Math.max(0, Math.floor(minX / S)); ix <= Math.min(W - 1, Math.floor(maxX / S)); ix++)
                if (inside((ix + .5) * S, (iy + .5) * S, rings)) {
                    fn(ix + iy * W);
                    count++;
                }
        return count;
    }
    function cell(x: number, y: number, fn: CellPainter) { const ix = Math.floor(x / S), iy = Math.floor(y / S); if (ix >= 0 && iy >= 0 && ix < W && iy < H)
        fn(ix + iy * W); }
    function disc(x: number, y: number, r: number, fn: CellPainter) {
        const reach = Math.sqrt(r * r + S * S / 4);
        for (let iy = Math.max(0, Math.floor((y - reach) / S)); iy <= Math.min(H - 1, Math.floor((y + reach) / S)); iy++)
            for (let ix = Math.max(0, Math.floor((x - reach) / S)); ix <= Math.min(W - 1, Math.floor((x + reach) / S)); ix++)
                if (((ix + .5) * S - x) ** 2 + ((iy + .5) * S - y) ** 2 <= reach * reach)
                    fn(ix + iy * W);
    }
    function sample(line: MetricPoint[], spacing: number, fn: (x: number, y: number) => void) {
        let next = 0, travelled = 0;
        for (let i = 1; i < line.length; i++) {
            const a = line[i - 1], b = line[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (!length)
                continue;
            while (next <= travelled + length) {
                const t = (next - travelled) / length;
                fn(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]));
                next += spacing;
            }
            travelled += length;
        }
    }
    const has = (value: string, list: string[]) => list.includes(value);
    for (const f of features) {
        const t = f.T, grass = has(t.leisure, ['park', 'garden', 'pitch', 'playground', 'recreation_ground', 'golf_course']) || has(t.landuse, ['grass', 'forest', 'meadow', 'village_green', 'recreation_ground', 'orchard', 'cemetery']) || has(t.natural, ['wood', 'scrub', 'grassland']);
        if (grass)
            for (const p of polygons(f))
                fill(p, i => { ground[i] = 1; if (has(t.leisure, ['park', 'garden']) || has(t.landuse, ['forest', 'orchard', 'village_green']) || has(t.natural, ['wood', 'scrub']))
                    park[i] = 1; });
    }
    for (const f of features)
        if (f.T.highway === 'pedestrian' || f.T.place === 'square' || f.T.amenity === 'marketplace')
            for (const p of polygons(f))
                fill(p, i => ground[i] = 4);
    for (const f of features) {
        const t = f.T;
        if (t.natural === 'water' || t.water !== undefined || t.waterway === 'riverbank' || t.amenity === 'fountain')
            for (const p of polygons(f))
                fill(p, i => ground[i] = 2);
        if (t.amenity === 'fountain')
            for (const [x, y] of points(f))
                disc(x, y, 2, i => ground[i] = 2);
    }
    const widths: Record<string, number> = { motorway: 10, trunk: 10, primary: 9, secondary: 7, tertiary: 6, residential: 5, unclassified: 5, living_street: 4, service: 3.5, pedestrian: 4, footway: 2, path: 2, steps: 2, cycleway: 2, track: 3, corridor: 2 };
    for (const f of features)
        for (const l of lines(f)) {
            if (widths[f.T.highway])
                sample(l, S / 2, (x, y) => disc(x, y, widths[f.T.highway] / 2, i => ground[i] = has(f.T.highway, ['pedestrian', 'footway', 'path', 'steps', 'corridor', 'living_street']) ? 4 : 3));
            if (has(f.T.waterway, ['river', 'canal', 'stream', 'drain', 'ditch']))
                sample(l, S / 2, (x, y) => disc(x, y, f.T.waterway === 'river' ? 5 : 1.5, i => ground[i] = 2));
        }
    const number = (value: string) => { const n = parseFloat(value); return Number.isFinite(n) && n > 0 ? n : undefined; };
    function centroid(ring: MetricPoint[]): MetricPoint {
        let area = 0, x = 0, y = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[j], b = ring[i], cross = a[0] * b[1] - b[0] * a[1];
            area += cross;
            x += (a[0] + b[0]) * cross;
            y += (a[1] + b[1]) * cross;
        }
        return Math.abs(area) > 1e-8 ? [x / (3 * area), y / (3 * area)] : ring.reduce<MetricPoint>((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
    }
    for (const f of features) {
        const t = f.T, r = hash(f.id), castle = has(t.historic, ['castle', 'citadel']), religious = t.amenity === 'place_of_worship' || has(t.building, ['mosque', 'church', 'religious', 'cathedral', 'chapel']), minaret = t['tower:type'] === 'minaret';
        let h = number(t.height) ?? number(t['building:height']) ?? (number(t['building:levels']) ? number(t['building:levels'])! * 3.2 + .5 : castle ? 24 : religious ? 9 + r * 4 : 4.5 + Math.floor(r * 4) * 1.5);
        let color = castle ? 4 : religious ? 3 : t.shop || t.amenity === 'marketplace' || has(t.building, ['retail', 'commercial']) || has(t.landuse, ['retail', 'commercial']) ? 6 : r < .45 ? 0 : r < .8 ? 1 : r < .95 ? 2 : 5;
        if (minaret) {
            h = Math.max(h, 26);
            color = 3;
        }
        if (RUBBLE && ((t.damage !== undefined && t.damage !== 'no') || t.ruins === 'yes' || t['ruins:building'] !== undefined || t['destroyed:building'] !== undefined || (t.destroyed !== undefined && t.destroyed !== 'no') || t.building === 'ruins')) {
            h = Math.min(h, 2.5);
            color = 7;
        }
        h = Math.max(2, Math.min(120, Math.round(h)));
        const put = (i: number) => { if (h > bh[i]) {
            bh[i] = h;
            bc[i] = color;
        } };
        if (t.building !== undefined || castle || minaret)
            for (const p of polygons(f))
                if (!fill(p, put) && p[0]?.length)
                    cell(...centroid(p[0]), put);
        if (minaret)
            for (const p of points(f))
                cell(...p, put);
        if (t.barrier === 'city_wall' || t.historic === 'citywalls')
            for (const l of lines(f))
                sample(l, S / 2, (x, y) => disc(x, y, 1.25, i => { if (bh[i] < 10) {
                    bh[i] = 10;
                    bc[i] = 4;
                } }));
    }
    const trees: number[] = [];
    const tree = (x: number, y: number, h: number) => { if (x >= 0 && y >= 0 && x < W * S && y < H * S)
        trees.push(x, y, h); };
    for (const f of features) {
        if (f.T.natural === 'tree')
            for (const [x, y] of points(f))
                tree(x, y, number(f.T.height) ?? 4 + hash(f.id) * 4);
        if (f.T.natural === 'tree_row')
            for (const l of lines(f)) {
                let n = 0;
                sample(l, 7, (x, y) => tree(x, y, 4 + hash(f.id + n++) * 3));
            }
    }
    for (let iy = 0; iy < H; iy++)
        for (let ix = 0; ix < W; ix++) {
            const i = ix + iy * W, seed = ix * 73856093 ^ iy * 19349663;
            if (park[i] && ground[i] === 1 && !bh[i] && hash(seed) < .12)
                tree((ix + .1 + .8 * hash(seed + 1)) * S, (iy + .1 + .8 * hash(seed + 2)) * S, 4 + hash(seed + 3) * 4);
        }
    const count = bh.reduce((n, h) => n + Number(h > 0), 0), bld = Buffer.alloc(4 + 6 * count);
    bld.writeUInt32LE(count);
    let offset = 4;
    for (let i = 0; i < bh.length; i++)
        if (bh[i]) {
            bld.writeUInt16LE(i % W, offset);
            bld.writeUInt16LE(Math.floor(i / W), offset + 2);
            bld[offset + 4] = bh[i];
            bld[offset + 5] = bc[i];
            offset += 6;
        }
    const treeBuffer = Buffer.alloc(trees.length * 4);
    trees.forEach((v, i) => treeBuffer.writeFloatLE(v, i * 4));
    await mkdir('public/old', { recursive: true });
    await writeFile('public/old/details.geojson', JSON.stringify(source));
    await writeFile('public/old/roads.geojson', JSON.stringify({ type: 'FeatureCollection', features: source.features.filter(f => {
            const t = getTags(f.properties);
            return t.highway && ['LineString', 'MultiLineString'].includes(f.geometry?.type || '');
        }) }));
    // Preserve vector footprints and holes for the smooth 3D viewer.
    await writeFile('public/old/buildings.geojson', JSON.stringify({ type: 'FeatureCollection', features: source.features.filter(f => {
            const t = getTags(f.properties);
            return t.building || ['castle', 'citadel'].includes(t.historic) || t['tower:type'] === 'minaret' || t.barrier === 'city_wall' || t.historic === 'citywalls';
        }).map(f => ({ ...f, properties: Object.fromEntries(Object.entries(getTags(f.properties)).filter(([, v]) => v !== null && v !== undefined && v !== '')) })) }));
    await writeFile('public/old/meta.json', JSON.stringify({ S, W, H, lon0: BBOX[1], lat0: BBOX[0], kx, ky, citadel: [(CITADEL[0] - BBOX[1]) * kx, (CITADEL[1] - BBOX[0]) * ky] }, null, 2));
    await writeFile('public/old/ground.bin', ground);
    await writeFile('public/old/bld.bin', bld);
    await writeFile('public/old/trees.bin', treeBuffer);
    console.log(`Grid ${W} x ${H}, cell ${S}m; building columns ${count}; trees ${trees.length / 3}`);
    console.log('Ground classes:', Array.from({ length: 5 }, (_, c) => ground.reduce((n, v) => n + Number(v === c), 0)));
}
catch (error) {
    console.error(`Build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
