import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Feature, FeatureCollection, MapMeta, Coordinate, Tags } from './types';
import { getTags, polygonsOf, linesOf, coordinatesFlat } from './types';
import { addUtilitySimulation } from './utilities';
import { createMapInterface } from './interface';
const activeMounts = new WeakMap<HTMLElement, symbol>();
type MapEntity = {
    feature: Feature;
    t: Tags;
    name: string;
    category: string;
    x: number;
    y: number;
    bounds: [
        number,
        number,
        number,
        number
    ];
    position: THREE.Vector3;
    label?: HTMLButtonElement;
    marker?: THREE.Mesh;
};
type NamedEntity = MapEntity & {
    label: HTMLButtonElement;
};
export async function mountMap(root: HTMLElement, signal: AbortSignal): Promise<() => void> {
    const instance = Symbol('aleppo-map');
    activeMounts.set(root, instance);
    let disposed = false;
    root.innerHTML = "<div id=\"hud\"><h1>حلب القديمة · 3D</h1><p id=\"counts\">جارٍ تحميل الخريطة…</p><label for=\"height\">الارتفاع <span id=\"factor\">1.0×</span></label><input id=\"height\" type=\"range\" min=\"0.3\" max=\"2\" step=\"0.1\" value=\"1\"><p class=\"muted\">W / S: أمام / خلف · A / D: جانبيًا<br>Space: صعود · C / Ctrl: نزول<br>Shift: سرعة ×٣ · عجلة الفأرة: السرعة<br>الفأرة: النظر · Esc: تحرير المؤشر</p><p id=\"status\"></p></div><div id=\"crosshair\"></div><div id=\"error\" role=\"alert\"></div><div id=\"credit\">© <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noopener\">OpenStreetMap contributors</a></div>\r\n";
    let scene: THREE.Scene, renderer: THREE.WebGLRenderer, orbit: OrbitControls;
    let frame = 0;
    const listeners: Array<() => void> = [];
    const element = (id: string): HTMLElement => { const found = root.querySelector<HTMLElement>('#' + id); if (!found)
        throw new Error('Missing UI: ' + id); return found; };
    const listen = <K extends keyof WindowEventMap>(name: K, handler: (event: WindowEventMap[K]) => void) => { window.addEventListener(name, handler as EventListener); listeners.push(() => window.removeEventListener(name, handler as EventListener)); };
    const requestAnimationFrame = (callback: FrameRequestCallback) => { frame = window.requestAnimationFrame(callback); return frame; };
    const cleanup = () => { if (disposed)
        return; disposed = true; window.cancelAnimationFrame(frame); listeners.forEach(stop => stop()); orbit?.dispose(); const textures = new Set<THREE.Texture>(); scene?.traverse(obj => { if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const material of materials) {
            for (const value of Object.values(material))
                if (value instanceof THREE.Texture)
                    textures.add(value);
            material.dispose();
        }
    } }); textures.forEach(texture => texture.dispose()); renderer?.dispose(); if (activeMounts.get(root) === instance) {
        root.replaceChildren();
        activeMounts.delete(root);
    } };
    signal.addEventListener('abort', cleanup, { once: true });
    try {
        const FOG = true;
        async function load<T = ArrayBuffer>(path: string, json = false): Promise<T> { const r = await fetch(path, { signal }); if (!r.ok)
            throw new Error(`${path}: HTTP ${r.status}; run build.mjs`); return (json ? await r.json() : await r.arrayBuffer()) as T; }
        const [meta, groundBuffer, source, treeBuffer, roadSource] = await Promise.all([load<MapMeta>('/old/meta.json', true), load('/old/ground.bin'), load<FeatureCollection>('/old/details.geojson', true), load('/old/trees.bin'), load<FeatureCollection>('/old/roads.geojson', true)]);
        signal.throwIfAborted();
        const { S, W, H } = meta;
        if (![S, W, H].every(v => Number.isFinite(v) && v > 0) || !Number.isInteger(W) || !Number.isInteger(H))
            throw new Error('بيانات الشبكة غير صالحة');
        const ground = new Uint8Array(groundBuffer), treeData = new DataView(treeBuffer);
        if (ground.length !== W * H || treeData.byteLength % 12 || !Array.isArray(source.features))
            throw new Error('ملفات البيانات ناقصة؛ run build.mjs');
        let count = 0;
        const treeCount = treeData.byteLength / 12;
        scene = new THREE.Scene();
        scene.background = new THREE.Color('#bdd0dc');
        if (FOG)
            scene.fog = new THREE.Fog('#bdd0dc', 1700, 6500);
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
        renderer.setSize(innerWidth, innerHeight);
        renderer.localClippingEnabled = true;
        root.prepend(renderer.domElement);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.shadowMap.autoUpdate = false;
        const surfaceTime = { value: 0 };
        // Procedural world-scale materials need no downloaded textures.
        function naturalMaterial(options: THREE.MeshStandardMaterialParameters = {}, facades = false) {
            const material = new THREE.MeshStandardMaterial({ roughness: .92, metalness: 0, ...options });
            material.onBeforeCompile = shader => {
                shader.uniforms.surfaceTime = surfaceTime;
                shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      varying vec3 surfacePosition; varying vec3 surfaceNormal;
      ${facades ? 'attribute vec3 facadeData; varying vec3 facadeInfo;' : ''}`);
                shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      ${facades ? 'surfacePosition=position;facadeInfo=facadeData;' : `vec4 sp=vec4(position,1.0);
      #ifdef USE_INSTANCING
      sp=instanceMatrix*sp;
      #endif
      surfacePosition=(modelMatrix*sp).xyz;`}
      surfaceNormal=normal;`);
                shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      uniform float surfaceTime;varying vec3 surfacePosition;varying vec3 surfaceNormal;
      ${facades ? 'varying vec3 facadeInfo;' : ''}
      float grain(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}`);
                shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      vec3 sn=normalize(surfaceNormal);vec2 horizontal=surfacePosition.xz;
      float textureGrain=grain(floor(horizontal*18.0));
      diffuseColor.rgb*=mix(1.0,.94+.12*textureGrain,1.0-smoothstep(.1,.5,length(fwidth(horizontal))));
      ${facades ? `
      if(abs(sn.y)<.5){
        float along=abs(sn.x)>abs(sn.z)?surfacePosition.z:surfacePosition.x;
        vec2 masonry=vec2(along,surfacePosition.y);
        float row=floor(masonry.y/.42);
        vec2 brick=vec2(fract(masonry.x/.85+mod(row,2.0)*.5),fract(masonry.y/.42));
        float joint=max(1.0-smoothstep(.015,.04,min(brick.x,1.0-brick.x)),1.0-smoothstep(.025,.055,min(brick.y,1.0-brick.y)));
        float wear=grain(vec2(floor(masonry.x/.85+mod(row,2.0)*.5),row));
        float antialiasWidth=fwidth(along)+fwidth(surfacePosition.y);
        float detailFade=1.0-smoothstep(.12,.5,antialiasWidth);
        diffuseColor.rgb*=mix(1.0,(.88+.18*wear)*(1.0-.12*joint),detailFade);
        if(facadeInfo.y>.5&&facadeInfo.x>4.0){
          float localHeight=surfacePosition.y-facadeInfo.z;
          diffuseColor.rgb*=.88+.12*smoothstep(0.0,1.1,localHeight);
          vec2 cell=vec2(fract((along+.7)/3.6),fract(localHeight/3.2));
          float windowMask=step(.31,cell.x)*step(cell.x,.69)*step(.33,cell.y)*step(cell.y,.79)*step(2.3,localHeight)*step(localHeight,facadeInfo.x-.65);
          float frame=step(.34,cell.x)*step(cell.x,.66)*step(.36,cell.y)*step(cell.y,.76);
          vec3 glass=mix(vec3(.30,.27,.22),vec3(.10,.17,.19),frame);
          float mullion=1.0-smoothstep(.008,.02,abs(cell.x-.5));glass=mix(glass,vec3(.44,.39,.29),mullion);
          diffuseColor.rgb=mix(diffuseColor.rgb,glass,windowMask*detailFade);
          float door=step(.40,fract((along+1.1)/10.8))*step(fract((along+1.1)/10.8),.50)*step(localHeight,2.1);
          diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.23,.15,.09),door*detailFade);
        }
      }else{diffuseColor.rgb*=.93+.06*grain(floor(horizontal*3.0));}
      ` : `
      bool water=diffuseColor.b>diffuseColor.r*1.15&&diffuseColor.b>diffuseColor.g*.95;
      if(water){float ripple=sin(horizontal.x*1.4+surfaceTime*.7)*sin(horizontal.y*1.8-surfaceTime*.5);diffuseColor.rgb*=.94+.10*ripple;}
      `}`);
                if (!facades)
                    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      if(diffuseColor.b>diffuseColor.r*1.15&&diffuseColor.b>diffuseColor.g*.95)roughnessFactor=.3;`);
            };
            material.customProgramCacheKey = () => facades ? 'aleppo-facades-v1' : 'aleppo-surfaces-v1';
            return material;
        }
        const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, .5, 8000);
        // A +90 degree plane rotation maps texture v=0 (south) to z=0, v=1 to negative z.
        const palette = [[205, 191, 157], [111, 154, 78], [59, 130, 196], [74, 79, 87], [189, 179, 155]], pixels = new Uint8Array(W * H * 4);
        ground.forEach((c, i) => { if (!palette[c])
            throw new Error('فئة أرض غير صالحة'); pixels.set([...palette[c === 3 || c === 4 ? 0 : c], 255], i * 4); });
        const texture = new THREE.DataTexture(pixels, W, H, THREE.RGBAFormat);
        texture.magFilter = texture.minFilter = THREE.NearestFilter;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.needsUpdate = true;
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(W * S, H * S), naturalMaterial({ map: texture, side: THREE.DoubleSide }));
        plane.rotation.x = Math.PI / 2;
        plane.position.set(W * S / 2, 0, -H * S / 2);
        plane.receiveShadow = true;
        scene.add(plane);
        const outer = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshBasicMaterial({ color: '#b9ad8a', side: THREE.DoubleSide }));
        outer.rotation.x = -Math.PI / 2;
        outer.position.set(W * S / 2, -.1, -H * S / 2);
        scene.add(outer);
        const colors = ['#d9cdb3', '#cdbb98', '#bda781', '#ece7d9', '#b9b2a2', '#a68c73', '#c5b28d', '#8a857b'];
        const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), rotation = new THREE.Quaternion();
        const jitter = (x: number, y: number) => { let n = Math.imul(x ^ Math.imul(y, 19349663), 73856093); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n >>> 0) / 4294967296; };
        const project = (p: Coordinate) => new THREE.Vector2((p[0] - meta.lon0) * meta.kx, (p[1] - meta.lat0) * meta.ky);
        const moundRings = source.features.filter(f => f.properties?.historic === 'castle' && f.properties?.natural === 'bare_rock').flatMap(f => polygonsOf(f.geometry)).map(rings => {
            const ring = rings[0].map(project), center = ring.reduce((sum, p) => sum.add(p), new THREE.Vector2()).divideScalar(ring.length);
            return { ring, center, height: 24 };
        });
        function groundElevation(x: number, y: number) {
            for (const mound of moundRings) {
                const p = new THREE.Vector2(x, y).sub(mound.center), distance = p.length();
                if (!distance)
                    return mound.height;
                const dir = p.clone().normalize();
                let boundary = Infinity;
                for (let i = 1; i < mound.ring.length; i++) {
                    const a = mound.ring[i - 1].clone().sub(mound.center), edge = mound.ring[i].clone().sub(mound.ring[i - 1]), den = dir.cross(edge);
                    if (Math.abs(den) < 1e-8)
                        continue;
                    const t = a.cross(edge) / den, u = a.cross(dir) / den;
                    if (t > 0 && u >= 0 && u <= 1)
                        boundary = Math.min(boundary, t);
                }
                if (Number.isFinite(boundary) && distance < boundary)
                    return mound.height * Math.min(1, (1 - distance / boundary) / .12);
            }
            return 0;
        }
        // Continuous vector road surfaces, curbs and dashed center lines.
        const roadWidths: Record<string, number> = { motorway: 12, trunk: 12, primary: 11, secondary: 9, tertiary: 7.5, residential: 6, unclassified: 6, living_street: 4, service: 4, pedestrian: 3.8, footway: 2.2, path: 2.2, steps: 2.2, cycleway: 2.5, track: 3.5, corridor: 2.2 };
        const roadVertices: number[] = [], roadColors: number[] = [];
        function roadTriangle(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, y: number, color: THREE.Color) { for (const p of [a, b, c]) {
            roadVertices.push(p.x, y, -p.y);
            roadColors.push(color.r, color.g, color.b);
        } }
        function ribbon(a: THREE.Vector2, b: THREE.Vector2, width: number, y: number, color: THREE.Color) { const length = a.distanceTo(b); if (!length)
            return; const dx = -(b.y - a.y) / length * width / 2, dy = (b.x - a.x) / length * width / 2; const p = [new THREE.Vector2(a.x + dx, a.y + dy), new THREE.Vector2(a.x - dx, a.y - dy), new THREE.Vector2(b.x - dx, b.y - dy), new THREE.Vector2(b.x + dx, b.y + dy)]; roadTriangle(p[0], p[1], p[2], y, color); roadTriangle(p[0], p[2], p[3], y, color); }
        function roadJoint(p: THREE.Vector2, r: number, y: number, color: THREE.Color) { for (let i = 0; i < 12; i++) {
            const a = i * Math.PI / 6, b = (i + 1) * Math.PI / 6;
            roadTriangle(p, new THREE.Vector2(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r), new THREE.Vector2(p.x + Math.cos(b) * r, p.y + Math.sin(b) * r), y, color);
        } }
        const curbColor = new THREE.Color('#e9dfc9'), asphaltColor = new THREE.Color('#39424b'), pathColor = new THREE.Color('#d7c6a5'), markColor = new THREE.Color('#f5e2a3'), roofColor = new THREE.Color('#9c8870');
        for (const f of roadSource.features) {
            const t = getTags(f.properties), width = roadWidths[t.highway];
            if (!width)
                continue;
            const pedestrian = ['pedestrian', 'footway', 'path', 'steps', 'corridor', 'living_street'].includes(t.highway), surface = t.surface === 'unpaved' ? new THREE.Color('#a08c6b') : pedestrian ? new THREE.Color('#93836b') : asphaltColor;
            const border = pedestrian ? .35 : 1;
            const tunnel = t.tunnel && t.tunnel !== 'no', bridge = t.bridge && t.bridge !== 'no';
            const level = Number(t.layer) || 0, base = tunnel ? -.4 : Math.max(0, level * 5, bridge ? 5 : 0);
            const lanes = THREE.MathUtils.clamp(parseInt(t.lanes) || 2, 1, 6);
            const lines = linesOf(f.geometry);
            for (const line of lines) {
                const points = line.map(project);
                let travelled = 0;
                for (let i = 1; i < points.length; i++) {
                    const a = points[i - 1], b = points[i], length = a.distanceTo(b);
                    if (!length)
                        continue;
                    const visible = Math.max(a.x, b.x) >= -width && Math.min(a.x, b.x) <= W * S + width && Math.max(a.y, b.y) >= -width && Math.min(a.y, b.y) <= H * S + width;
                    if (visible) {
                        ribbon(a, b, width + border, base + .06, curbColor);
                        roadJoint(a, (width + border) / 2, base + .06, curbColor);
                        roadJoint(b, (width + border) / 2, base + .06, curbColor);
                        ribbon(a, b, width, base + .09, surface);
                        roadJoint(a, width / 2, base + .09, surface);
                        roadJoint(b, width / 2, base + .09, surface);
                        // Staggered sandstone paving distinguishes alleys from asphalt streets.
                        if (pedestrian && t.surface !== 'unpaved') {
                            const rows = Math.max(2, Math.round(width / .8)), tileWidth = width / rows, side = new THREE.Vector2(-(b.y - a.y) / length, (b.x - a.x) / length), tileLength = t.highway === 'steps' ? .45 : 1.4;
                            for (let row = 0; row < rows; row++)
                                for (let at = Math.floor(travelled / tileLength) * tileLength + (row % 2) * tileLength / 2 - tileLength; at < travelled + length; at += tileLength) {
                                    const lo = Math.max(0, at - travelled + .05), hi = Math.min(length, at - travelled + tileLength - .05);
                                    if (hi <= lo)
                                        continue;
                                    const offset = side.clone().multiplyScalar((row + .5) * tileWidth - width / 2), p = a.clone().lerp(b, lo / length).add(offset), q = a.clone().lerp(b, hi / length).add(offset);
                                    if (Math.max(p.x, q.x) < 0 || Math.min(p.x, q.x) > W * S || Math.max(p.y, q.y) < 0 || Math.min(p.y, q.y) > H * S)
                                        continue;
                                    const shade = ((Math.floor(at / tileLength) * 13 + row * 7) % 4 + 4) % 4, color = new THREE.Color(['#cfb993', '#dcc7a4', '#c6ad86', '#e0cdab'][shade]);
                                    ribbon(p, q, tileWidth - .06, base + .115, color);
                                }
                        }
                        if (t.covered === 'yes') {
                            ribbon(a, b, width + 1, base + 4, roofColor);
                            roadJoint(a, (width + 1) / 2, base + 4, roofColor);
                            roadJoint(b, (width + 1) / 2, base + 4, roofColor);
                        }
                        if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(t.highway))
                            for (let lane = 1; lane < lanes; lane++)
                                for (let start = Math.floor(travelled / 12) * 12; start < travelled + length; start += 12) {
                                    const lo = Math.max(0, start - travelled), hi = Math.min(length, start + 5 - travelled), offset = new THREE.Vector2(-(b.y - a.y) / length, (b.x - a.x) / length).multiplyScalar(width * (lane / lanes - .5));
                                    if (hi > lo)
                                        ribbon(a.clone().lerp(b, lo / length).add(offset), a.clone().lerp(b, hi / length).add(offset), .25, base + .12, markColor);
                                }
                        if (!pedestrian && (t.oneway === 'yes' || t.oneway === '-1'))
                            for (let at = Math.ceil(travelled / 35) * 35; at < travelled + length; at += 35) {
                                const p = a.clone().lerp(b, (at - travelled) / length), dir = b.clone().sub(a).normalize().multiplyScalar(t.oneway === '-1' ? -1 : 1), side = new THREE.Vector2(-dir.y, dir.x);
                                roadTriangle(p.clone().addScaledVector(dir, 1.8), p.clone().addScaledVector(dir, -1).addScaledVector(side, .9), p.clone().addScaledVector(dir, -1).addScaledVector(side, -.9), base + .14, markColor);
                            }
                    }
                    travelled += length;
                }
            }
        }
        for (const f of source.features) {
            const t = getTags(f.properties), g = f.geometry;
            if (!['river', 'drain', 'stream', 'canal', 'ditch'].includes(t.waterway) || !['LineString', 'MultiLineString'].includes(g?.type || ''))
                continue;
            const lines = linesOf(g);
            for (const line of lines)
                for (let i = 1; i < line.length; i++) {
                    const a = project(line[i - 1]), b = project(line[i]);
                    if (Math.max(a.x, b.x) < 0 || Math.min(a.x, b.x) > W * S || Math.max(a.y, b.y) < 0 || Math.min(a.y, b.y) > H * S)
                        continue;
                    ribbon(a, b, t.waterway === 'river' ? 10 : 3, t.tunnel && t.tunnel !== 'no' ? -.2 : .04, new THREE.Color(t.intermittent === 'yes' ? '#87a5a0' : '#428db8'));
                }
        }
        if (roadVertices.length) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(roadVertices, 3));
            geometry.setAttribute('color', new THREE.Float32BufferAttribute(roadColors, 3));
            geometry.computeVertexNormals();
            const material = naturalMaterial({ vertexColors: true, side: THREE.DoubleSide, clippingPlanes: [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), new THREE.Plane(new THREE.Vector3(-1, 0, 0), W * S), new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), new THREE.Plane(new THREE.Vector3(0, 0, 1), H * S)] });
            const roadMesh = new THREE.Mesh(geometry, material);
            roadMesh.receiveShadow = true;
            scene.add(roadMesh);
        }
        const geometries: THREE.BufferGeometry[] = [];
        function append(geometry: THREE.BufferGeometry, color: string | number, roof?: string, facade = false) {
            const g = geometry.index ? geometry.toNonIndexed() : geometry;
            if (g !== geometry)
                geometry.dispose();
            g.deleteAttribute('uv');
            g.clearGroups();
            const c = new THREE.Color(typeof color === 'string' ? color : colors[color]), top = roof ? new THREE.Color(roof) : c, values = new Float32Array(g.attributes.position.count * 3);
            for (let i = 0; i < values.length; i += 3) {
                const v = g.attributes.normal?.getY(i / 3) > .5 ? top : c;
                values[i] = v.r;
                values[i + 1] = v.g;
                values[i + 2] = v.b;
            }
            g.setAttribute('color', new THREE.BufferAttribute(values, 3));
            geometries.push(g);
            g.computeBoundingBox();
            const data = new Float32Array(g.attributes.position.count * 3);
            for (let i = 0; i < data.length; i += 3) {
                data[i] = g.boundingBox!.max.y - g.boundingBox!.min.y;
                data[i + 1] = facade ? 1 : 0;
                data[i + 2] = g.boundingBox!.min.y;
            }
            g.setAttribute('facadeData', new THREE.BufferAttribute(data, 3));
        }
        function hash(id: string | number) { let n = Number(id) | 0; n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; }
        const number = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : undefined; };
        const roofTanks: THREE.Matrix4[] = [], roofUnits: THREE.Matrix4[] = [];
        for (const feature of source.features) {
            const t = getTags(feature.properties), g = feature.geometry;
            if (!g)
                continue;
            const castle = ['castle', 'citadel'].includes(t.historic), minaret = t['tower:type'] === 'minaret', tower = t.man_made === 'tower', wall = ['city_wall', 'wall', 'fence'].includes(t.barrier) || t.historic === 'citywalls';
            if (!t.building && !castle && !minaret && !tower && !wall)
                continue;
            const religious = t.amenity === 'place_of_worship' || ['mosque', 'church', 'religious', 'cathedral', 'chapel'].includes(t.building);
            const r = hash(String(feature.id || t.osm_id || 0).split('/').pop() || 0);
            let h = number(t.height) ?? number(t['building:height']) ?? (number(t['building:levels']) ? number(t['building:levels'])! * 3.2 + .5 : castle ? 24 : religious ? 9 + r * 4 : 4.5 + Math.floor(r * 4) * 1.5);
            let color: string | number = castle || wall ? 4 : religious || minaret ? 3 : t.shop || t.amenity === 'marketplace' || ['retail', 'commercial'].includes(t.building) ? 6 : r < .45 ? 0 : r < .8 ? 1 : r < .95 ? 2 : 5;
            if (minaret)
                h = Math.max(h, 26);
            if (tower)
                h = Math.max(h, 12);
            if ((t.damage && t.damage !== 'no') || t.ruins === 'yes' || t['ruins:building'] || t['razed:building'] || t['destroyed:building'] || (t.destroyed && t.destroyed !== 'no') || t.building === 'ruins') {
                h = Math.min(h, 2.5);
                color = 7;
            }
            h = THREE.MathUtils.clamp(h, 2, 120);
            if (color !== 7 && /^#[0-9a-f]{6}$/i.test(t['building:colour'] || t.colour || ''))
                color = t['building:colour'] || t.colour;
            const roof = /^#[0-9a-f]{6}$/i.test(t['roof:colour'] || '') ? t['roof:colour'] : ['#cec3ad','#bfb39b','#d8cbb4'][Math.floor(r*3)];
            const polygons = polygonsOf(g);
            let added = false;
            for (const rings of polygons) {
                const outer = rings[0]?.map(project);
                if (!outer || outer.length < 3)
                    continue;
                if (Math.max(...outer.map(p => p.x)) < 0 || Math.min(...outer.map(p => p.x)) > W * S || Math.max(...outer.map(p => p.y)) < 0 || Math.min(...outer.map(p => p.y)) > H * S)
                    continue;
                const shape = new THREE.Shape(outer);
                for (const ring of rings.slice(1))
                    if (ring.length >= 3)
                        shape.holes.push(new THREE.Path(ring.map(project)));
                const center = outer.reduce((sum, p) => sum.add(p), new THREE.Vector2()).divideScalar(outer.length), base = castle ? 0 : groundElevation(center.x, center.y);
                const geometry = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, steps: 1 });
                geometry.rotateX(-Math.PI / 2);
                if (castle && t.natural === 'bare_rock') {
                    const attr = geometry.attributes.position;
                    for (let i = 0; i < attr.count; i++)
                        if (attr.getY(i) > h / 2)
                            attr.setXYZ(i, center.x + (attr.getX(i) - center.x) * .88, attr.getY(i), -center.y + (attr.getZ(i) + center.y) * .88);
                    geometry.computeVertexNormals();
                }
                // Citadel buildings retain plain stone facades without invented openings.
                const inCitadel = groundElevation(center.x, center.y) > 0 || outer.some(p => groundElevation(p.x, p.y) > 0);
                geometry.translate(0, base, 0);
                append(geometry, color, roof, !castle && !inCitadel && !minaret && !tower && color !== 7);
                // Generic roof equipment is decorative, not surveyed building data.
                if (!castle && !inCitadel && !religious && !minaret && !tower && color!==7 && h>=5 && r<.23) {
                    const insideRing=(p:THREE.Vector2,ring:THREE.Vector2[])=>{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;};
                    const holes=rings.slice(1).map(ring=>ring.map(project));
                    const spanX=Math.max(...outer.map(p=>p.x))-Math.min(...outer.map(p=>p.x)),spanY=Math.max(...outer.map(p=>p.y))-Math.min(...outer.map(p=>p.y));
                    if(spanX>5&&spanY>5&&insideRing(center,outer)&&!holes.some(ring=>insideRing(center,ring))){
                        matrix.compose(position.set(center.x,base+h,-center.y),rotation,scale.set(1,1,1));
                        (r<.12?roofTanks:roofUnits).push(matrix.clone());
                    }
                }
                added = true;
                // Low roof parapets follow original footprints, including courtyard edges.
                if (color !== 7 && h >= 4 && !minaret && !tower) {
                    for (const ring of rings) {
                        const pts = ring.map(project);
                        if (castle && t.natural === 'bare_rock')
                            for (const p of pts)
                                p.sub(center).multiplyScalar(.88).add(center);
                        for (let i = 1; i < pts.length; i++) {
                            const a = pts[i - 1], b = pts[i], length = a.distanceTo(b);
                            if (length < .5)
                                continue;
                            const parapet = new THREE.BoxGeometry(length, castle ? 3 : .45, castle ? 1 : .18);
                            parapet.rotateY(Math.atan2(b.y - a.y, b.x - a.x));
                            parapet.translate((a.x + b.x) / 2, base + h + (castle ? 1.5 : .225), -(a.y + b.y) / 2);
                            append(parapet, color, roof);
                        }
                    }
                }
            }
            if ((minaret || tower) && g.type === 'Point') {
                const p = project(g.coordinates);
                if (p.x >= 0 && p.y >= 0 && p.x <= W * S && p.y <= H * S) {
                    const geometry=new THREE.CylinderGeometry(minaret?1:3,minaret?1.4:3.5,h,12);
                    geometry.translate(p.x,groundElevation(p.x,p.y)+h/2,-p.y);
                    append(geometry,minaret?3:4);
                    added = true;
                }
            }
            if (wall) {
                const wallHeight = number(t.height) ?? (t.barrier === 'fence' ? 1.8 : t.barrier === 'wall' ? 3 : 10), thickness = t.barrier === 'fence' ? .15 : t.barrier === 'wall' ? .6 : 2.5;
                const lines = linesOf(g);
                for (const line of lines)
                    for (let i = 1; i < line.length; i++) {
                        const a = project(line[i - 1]), b = project(line[i]), length = a.distanceTo(b);
                        if (!length)
                            continue;
                        const geometry = new THREE.BoxGeometry(length, wallHeight, thickness);
                        geometry.rotateY(Math.atan2(b.y - a.y, b.x - a.x));
                        geometry.translate((a.x + b.x) / 2, wallHeight / 2, -(a.y + b.y) / 2);
                        append(geometry, 4);
                        added = true;
                    }
            }
            if (added)
                count++;
        }
        const buildings = new THREE.Group();
        if (geometries.length) {
            const merged = mergeGeometries(geometries);
            if (!merged)
                throw new Error('تعذر إنشاء أشكال المباني');
            geometries.forEach(g => g.dispose());
            const material = naturalMaterial({ vertexColors: true, clippingPlanes: [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), new THREE.Plane(new THREE.Vector3(-1, 0, 0), W * S), new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), new THREE.Plane(new THREE.Vector3(0, 0, 1), H * S)] }, true);
            const mesh = new THREE.Mesh(merged, material);
            mesh.castShadow = mesh.receiveShadow = true;
            buildings.add(mesh);
        }
        for(const [transforms,geometry,color]of [
            [roofTanks,new THREE.CylinderGeometry(.48,.52,.95,12).translate(0,.475,0),'#4f5754'],
            [roofUnits,new THREE.BoxGeometry(.85,.65,.65).translate(0,.325,0),'#b6bab4']
        ] as Array<[THREE.Matrix4[],THREE.BufferGeometry,string]>){
            if(!transforms.length){geometry.dispose();continue;}
            const fittings=new THREE.InstancedMesh(geometry,new THREE.MeshStandardMaterial({color,roughness:.8,metalness:.12}),transforms.length);
            transforms.forEach((transform,index)=>fittings.setMatrixAt(index,transform));fittings.castShadow=fittings.receiveShadow=true;buildings.add(fittings);
        }
        scene.add(buildings);
        const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(.30, .5, 1, 8).translate(0, .5, 0), naturalMaterial({ color: '#705238' }), treeCount);
        const foliageGeometry = new THREE.IcosahedronGeometry(.5, 2);
        const foliagePositions = foliageGeometry.attributes.position;
        for (let i = 0; i < foliagePositions.count; i++) {
            const p = new THREE.Vector3().fromBufferAttribute(foliagePositions, i), r = .9 + .2 * jitter(Math.round(p.x * 100), Math.round(p.z * 100));
            foliagePositions.setXYZ(i, p.x * r, p.y * r, p.z * r);
        }
        foliageGeometry.computeVertexNormals();
        const crowns = new THREE.InstancedMesh(foliageGeometry, naturalMaterial(), treeCount * 3);
        const greens = ['#4b7337', '#547d3d', '#3f642d', '#638647'];
        for (let i = 0; i < treeCount; i++) {
            const x = treeData.getFloat32(i * 12, true), y = treeData.getFloat32(i * 12 + 4, true), h = treeData.getFloat32(i * 12 + 8, true);
            matrix.compose(position.set(x, 0, -y), rotation, scale.set(.7, h * .65, .7));
            trunks.setMatrixAt(i, matrix);
            const w = 2 + h * .4;
            for (let j = 0; j < 3; j++) {
                const angle = j * Math.PI * 2 / 3 + jitter(i, j), size = .65 + .2 * jitter(i + 1, j);
                matrix.compose(position.set(x + Math.cos(angle) * w * .2, h * (.55 + j * .1), -y + Math.sin(angle) * w * .2), rotation, scale.set(w * size, h * .55, w * size));
                crowns.setMatrixAt(i * 3 + j, matrix);
                crowns.setColorAt(i * 3 + j, new THREE.Color(greens[Math.floor(jitter(i, j) * 4)]));
            }
        }
        trunks.frustumCulled = crowns.frustumCulled = false;
        trunks.castShadow = crowns.castShadow = true;
        trunks.receiveShadow = crowns.receiveShadow = true;
        scene.add(trunks, crowns);
        scene.add(new THREE.HemisphereLight('#d8e7f3', '#8b795b', 1.25));
        const sun = new THREE.DirectionalLight('#fff0d3', 2.7);
        sun.position.set(-500, 1000, 400);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.camera.left = sun.shadow.camera.bottom = -400;
        sun.shadow.camera.right = sun.shadow.camera.top = 400;
        sun.shadow.camera.near = 10;
        sun.shadow.camera.far = 2200;
        sun.shadow.normalBias = .12;
        sun.shadow.bias = -.00015;
        scene.add(sun, sun.target);
        // All remaining OSM attributes remain available through search and inspection.
        const detailStyle = document.createElement('style');
        detailStyle.textContent = `
#legend{position:fixed;bottom:34px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 24px);border:1px solid #ffffff30;border-radius:12px;background:#202c39ed;color:white;padding:10px 14px;z-index:2;font:12px Tahoma;box-shadow:0 5px 20px #0003}#legend summary{cursor:pointer;font-weight:bold;text-align:right}#legend-items{display:flex;flex-wrap:wrap;justify-content:center;gap:10px 16px;max-width:1000px;margin-top:10px;max-height:24vh;overflow:auto}.legend-item{display:flex;align-items:center;gap:6px;white-space:nowrap}.legend-swatch{display:inline-block;width:25px;height:16px;border-radius:3px;border:1px solid #ffffff55;flex:none}.legend-building{box-shadow:3px -3px 0 #ffffff30}.legend-road{background:#39424b;border-top:3px solid #e9dfc9;border-bottom:3px solid #e9dfc9;position:relative}.legend-road:after{content:'';position:absolute;left:2px;right:2px;top:4px;border-top:2px dashed #f5e2a3}.legend-alley{background:repeating-linear-gradient(0deg,transparent 0 5px,#93836b 5px 6px),repeating-linear-gradient(90deg,#dcc7a4 0 7px,#93836b 7px 8px)}.legend-tree{background:#4e8f45;border-radius:50%;width:16px;height:16px}.legend-service{background:#edb657;border-radius:50%;width:10px;height:10px}.legend-wall{background:#b9b2a2;height:8px}.legend-ring{border:3px solid #ffda68;border-radius:50%;background:transparent;width:17px;height:17px}
#hud-close{float:left;border:1px solid #ffffff40;border-radius:6px;background:#ffffff15;color:white;font:13px Tahoma;padding:4px 8px;cursor:pointer}#hud-open{position:fixed;top:18px;right:18px;z-index:4;padding:10px 14px;border:1px solid #ffffff40;border-radius:9px;background:#202c39ee;color:white;font:14px Tahoma;cursor:pointer;display:none}
#labels{position:fixed;inset:0;pointer-events:none;overflow:hidden}.map-label{position:absolute;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid #fff9;border-radius:5px;background:#203140dd;color:white;padding:4px 7px;font:12px Tahoma;cursor:pointer;pointer-events:auto;transform:translate(-50%,-100%)}
#info{position:fixed;left:16px;top:16px;width:340px;max-width:calc(100vw - 32px);max-height:80vh;overflow:auto;background:#202c39f2;border-radius:12px;padding:16px;display:none;z-index:3}#info h2{font-size:18px}#info table{width:100%;border-collapse:collapse;font-size:12px}#info td{padding:7px;border-bottom:1px solid #ffffff20;overflow-wrap:anywhere}#info td:first-child{color:#d8c39d}#search{margin-top:8px;padding:8px;border:0;border-radius:6px}#results{max-height:180px;overflow:auto}#results button{display:block;width:100%;text-align:right;padding:6px;background:#ffffff12;border:0;color:white;cursor:pointer;margin-top:3px}#hud label.toggle{display:block;font-size:12px;margin-top:8px}#hud label.toggle input{width:auto;margin-left:6px}`;
        root.append(detailStyle);
        const hud = element('hud');
        const closeHud = document.createElement('button');
        closeHud.id = 'hud-close';
        closeHud.type = 'button';
        closeHud.textContent = 'إغلاق ×';
        closeHud.setAttribute('aria-label', 'إغلاق لوحة التحكم');
        hud.prepend(closeHud);
        const openHud = document.createElement('button');
        openHud.id = 'hud-open';
        openHud.type = 'button';
        openHud.textContent = '☰ لوحة التحكم';
        openHud.setAttribute('aria-controls', 'hud');
        openHud.setAttribute('aria-expanded', 'true');
        root.append(openHud);
        closeHud.onclick = () => { hud.hidden = true; openHud.style.display = 'block'; openHud.setAttribute('aria-expanded', 'false'); openHud.focus(); };
        openHud.onclick = () => { hud.hidden = false; openHud.style.display = 'none'; openHud.setAttribute('aria-expanded', 'true'); closeHud.focus(); };
        const legend = document.createElement('details');
        legend.id = 'legend';
        legend.dir = 'rtl';
        legend.open = true;
        const legendTitle = document.createElement('summary');
        legendTitle.textContent = 'مفتاح الخريطة — الألوان والأشكال';
        legend.append(legendTitle);
        const legendItems = document.createElement('div');
        legendItems.id = 'legend-items';
        legend.append(legendItems);
        for (const [name, color, style] of ([
            ['مبانٍ سكنية وعادية', '#d9cdb3', 'legend-building'],
            ['مبانٍ بلون حجري داكن', '#a68c73', 'legend-building'],
            ['أماكن عبادة ومآذن', '#ece7d9', 'legend-building'],
            ['أسواق ومبانٍ تجارية', '#c5b28d', 'legend-building'],
            ['قلعة وأبراج وأسوار', '#b9b2a2', 'legend-building'],
            ['آثار ضرر أو تهدّم مسجّلة', '#8a857b', 'legend-building'],
            ['شوارع أسفلتية', null, 'legend-road'],
            ['أزقة وممرات حجرية', null, 'legend-alley'],
            ['سقوف ممرات مغطّاة', '#9c8870', ''],
            ['مياه ومسابح', '#428db8', ''],
            ['حدائق ومناطق خضراء', '#82a66b', ''],
            ['مقابر', '#91a18b', ''],
            ['مناطق صخرية', '#a29b8c', ''],
            ['أشجار', null, 'legend-tree'],
            ['جدران وأسوار', null, 'legend-wall'],
            ['مرافق وخدمات', null, 'legend-service'],
            ['المعلم المحدّد', null, 'legend-ring']
        ] as Array<[
            string,
            string | null,
            string
        ]>)) {
            const item = document.createElement('span');
            item.className = 'legend-item';
            const swatch = document.createElement('span');
            swatch.className = 'legend-swatch ' + style;
            swatch.setAttribute('aria-hidden', 'true');
            if (color)
                swatch.style.background = color;
            item.append(swatch, document.createTextNode(name));
            legendItems.append(item);
        }
        const legendNote = document.createElement('p');
        legendNote.textContent = 'ألوان المباني تقديرية عند غياب اللون المسجّل. الأسهم تبيّن اتجاه السير، والخطوط المتقطعة تفصل المسارات. الجسور مرتفعة والأنفاق تحت الأرض. انقر العنوان لطي المفتاح.';
        legendNote.style.cssText = 'font-size:11px;color:#ccdae6;max-width:1000px;margin:10px 0 0;line-height:1.6';
        legend.append(legendNote);
        root.append(legend);
        const labelsLayer = document.createElement('div');
        labelsLayer.id = 'labels';
        root.append(labelsLayer);
        const info = document.createElement('aside');
        info.id = 'info';
        info.dir = 'rtl';
        root.append(info);
        const search = document.createElement('input');
        search.id = 'search';
        search.placeholder = 'بحث عن اسم أو نوع أو أي وسم…';
        search.setAttribute('aria-label', 'البحث في بيانات qgis');
        element('hud').append(search);
        const results = document.createElement('div');
        results.id = 'results';
        element('hud').append(results);
        const toggles: Record<string, boolean> = { labels: true, services: true, shadows: true };
        for (const [key, text] of [['services', 'رموز الخدمات والمرافق'], ['shadows', 'الظلال — أوقفها لتحسين الأداء']]) {
            const label = document.createElement('label');
            label.className = 'toggle';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = true;
            input.onchange = () => { toggles[key] = input.checked; renderer.shadowMap.needsUpdate = true; };
            label.append(input, document.createTextNode(text));
            element('hud').append(label);
        }
        const namesButton = document.createElement('button');
        namesButton.type = 'button';
        namesButton.id = 'names-toggle';
        namesButton.textContent = 'إخفاء جميع الأسماء';
        namesButton.setAttribute('aria-pressed', 'true');
        namesButton.style.cssText = 'width:100%;margin-top:10px;padding:9px;border:1px solid #ffffff40;border-radius:7px;background:#ffffff15;color:white;font:13px Tahoma;cursor:pointer';
        namesButton.onclick = () => { toggles.labels = !toggles.labels; namesButton.textContent = toggles.labels ? 'إخفاء جميع الأسماء' : 'إظهار جميع الأسماء'; namesButton.setAttribute('aria-pressed', String(toggles.labels)); labelFrame = 5; updateDetails(); };
        hud.append(namesButton);
        const serviceNames: Record<string, string> = { place_of_worship: 'مكان عبادة', marketplace: 'سوق', school: 'مدرسة', restaurant: 'مطعم', fuel: 'وقود', bicycle_parking: 'موقف دراجات', hospital: 'مستشفى', hotel: 'فندق', museum: 'متحف', viewpoint: 'إطلالة', platform: 'موقف حافلات', stop_position: 'موقف حافلات', park: 'حديقة', garden: 'حديقة', cemetery: 'مقبرة', sauna: 'حمّام', stadium: 'ملعب', swimming_pool: 'مسبح', monument: 'معلم تاريخي', archaeological_site: 'موقع أثري', ruins: 'آثار', tower: 'برج', suburb: 'حي', neighbourhood: 'حي' };
        const entities: MapEntity[] = [], named: NamedEntity[] = [], serviceGroup = new THREE.Group();
        scene.add(serviceGroup);
        const markerGeometry = new THREE.SphereGeometry(1.5, 8, 6), markerMaterial = new THREE.MeshBasicMaterial({ color: '#edb657' });
        for (const feature of source.features) {
            const g = feature.geometry;
            if (!g?.coordinates)
                continue;
            const t = getTags(feature.properties), coords = coordinatesFlat(g.coordinates);
            if (!coords.length)
                continue;
            let x = 0, y = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const coord of coords) {
                const p = project(coord);
                x += p.x;
                y += p.y;
                minX = Math.min(minX, p.x);
                maxX = Math.max(maxX, p.x);
                minY = Math.min(minY, p.y);
                maxY = Math.max(maxY, p.y);
            }
            if (maxX < 0 || minX > W * S || maxY < 0 || minY > H * S)
                continue;
            x = THREE.MathUtils.clamp(x / coords.length, 0, W * S);
            y = THREE.MathUtils.clamp(y / coords.length, 0, H * S);
            const category = t.amenity || t.tourism || t.public_transport || t.historic || t.leisure || t.place || (t.man_made === 'tower' ? 'tower' : undefined) || t.healthcare || '';
            const name = t['name:ar'] || t.name || t['name:en'] || serviceNames[category] || t.building || t.highway || String(feature.id);
            const entity: MapEntity = { feature, t, name, category, x, y, bounds: [minX, minY, maxX, maxY], position: new THREE.Vector3(x, groundElevation(x, y) + (parseFloat(t.height) || parseFloat(t['building:levels']) * 3.2 || (t.building ? 10 : 0)) + 4, -y) };
            entities.push(entity);
            if (t.name || t['name:ar'] || serviceNames[category]) {
                const button = document.createElement('button');
                button.className = 'map-label';
                button.textContent = (serviceNames[category] ? '● ' : '') + name;
                button.title = serviceNames[category] || 'معلم';
                button.onclick = () => selectEntity(entity);
                labelsLayer.append(button);
                entity.label = button;
                named.push(entity as NamedEntity);
            }
            if (serviceNames[category]) {
                const marker = new THREE.Mesh(markerGeometry, markerMaterial);
                marker.position.set(x, groundElevation(x, y) + 2, -y);
                serviceGroup.add(marker);
                entity.marker = marker;
            }
        }
        const selection = new THREE.Mesh(new THREE.RingGeometry(4, 5, 32), new THREE.MeshBasicMaterial({ color: '#ffda68', side: THREE.DoubleSide, depthTest: false }));
        selection.rotation.x = -Math.PI / 2;
        selection.visible = false;
        selection.renderOrder = 10;
        scene.add(selection);
        const translatedKeys: Record<string, string> = { height: 'الارتفاع', name: 'الاسم', building: 'نوع المبنى', 'building:levels': 'عدد الطوابق', historic: 'النوع التاريخي', religion: 'الديانة', material: 'الخامة', highway: 'نوع الطريق', oneway: 'اتجاه واحد', lanes: 'المسارات', layer: 'المستوى', covered: 'مغطّى', tunnel: 'نفق', bridge: 'جسر', surface: 'السطح', description: 'الوصف', opening_hours: 'ساعات العمل', phone: 'الهاتف', email: 'البريد', operator: 'المشغّل', tourism: 'السياحة', amenity: 'المرفق', ele: 'منسوب مسجّل', elevation: 'ارتفاع مسجّل', 'razed:building': 'مبنى مزال' };
        function valueLink(key: string, value: string) {
            let url;
            if (key === 'website' || key.endsWith(':facebook') || key.endsWith(':instagram')) {
                try {
                    const u = new URL(value);
                    if (['https:', 'http:'].includes(u.protocol))
                        url = u.href;
                }
                catch { }
            }
            if (key === 'wikipedia') {
                const match = String(value).match(/^([a-z-]+):(.+)$/);
                if (match)
                    url = `https://${match[1]}.wikipedia.org/wiki/${encodeURIComponent(match[2])}`;
            }
            if (key === 'wikidata' && /^Q\d+$/.test(value))
                url = 'https://www.wikidata.org/wiki/' + value;
            if (key === 'wikimedia_commons')
                url = 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(value);
            if (url) {
                const a = document.createElement('a');
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener';
                a.textContent = value;
                return a;
            }
            return document.createTextNode(String(value));
        }
        function selectEntity(entity: MapEntity) {
            info.replaceChildren();
            info.style.display = 'block';
            const close = document.createElement('button');
            close.textContent = 'إغلاق ×';
            close.onclick = () => { info.style.display = 'none'; selection.visible = false; };
            const title = document.createElement('h2');
            title.textContent = entity.name;
            const go = document.createElement('button');
            go.textContent = 'انتقل إلى الموقع';
            go.onclick = () => { orbit.reset(); camera.position.set(entity.x + 70, Math.max(60, entity.position.y + 40), -entity.y + 100); orbit.target.set(entity.x, groundElevation(entity.x, entity.y), -entity.y); orbit.update(); };
            const note = document.createElement('p');
            note.textContent = 'الوسوم كما وردت في الملف؛ الأبعاد غير المسجّلة تقديرية. أوصاف الضرر قديمة ولا تثبت الحالة الحالية.';
            const table = document.createElement('table');
            for (const [key, value] of Object.entries(entity.t)) {
                const row = table.insertRow();
                row.insertCell().textContent = translatedKeys[key] || key;
                row.insertCell().append(valueLink(key, value));
            }
            const id = document.createElement('p');
            id.textContent = String(entity.feature.id || '');
            info.append(close, title, go, note, id, table);
            selection.position.set(entity.x, groundElevation(entity.x, entity.y) + .3, -entity.y);
            selection.visible = true;
        }
        let searchTimer: ReturnType<typeof setTimeout> | undefined;
        search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { results.replaceChildren(); const query = search.value.trim().toLowerCase(); if (!query)
            return; const matches = entities.filter(e => Object.values(e.t).some(v => String(v).toLowerCase().includes(query)) || String(e.feature.id).includes(query)); const summary = document.createElement('p'); summary.textContent = `النتائج: ${matches.length} — عرض أول 30`; results.append(summary); for (const e of matches.slice(0, 30)) {
            const b = document.createElement('button');
            b.textContent = e.name;
            b.onclick = () => selectEntity(e);
            results.append(b);
        } }, 150); });
        // Supplementary vector land cover, water, pools, marketplaces and rock areas.
        const landGroup = new THREE.Group();
        scene.add(landGroup);
        for (const e of entities) {
            const t = e.t, g = e.feature.geometry;
            let color;
            if (t.natural === 'water' || t.water || t.waterway === 'riverbank' || t.leisure === 'swimming_pool' || t.amenity === 'fountain')
                color = '#428db8';
            else if (['park', 'garden', 'pitch', 'playground', 'golf_course'].includes(t.leisure) || ['grass', 'forest', 'meadow', 'village_green', 'orchard'].includes(t.landuse) || ['wood', 'scrub', 'grassland'].includes(t.natural))
                color = '#82a66b';
            else if (t.natural === 'bare_rock')
                color = '#a29b8c';
            else if (t.landuse === 'cemetery')
                color = '#91a18b';
            else if (t.highway === 'pedestrian' || t.amenity === 'marketplace')
                color = '#ccb995';
            if (!color || t.building)
                continue;
            const polygons = polygonsOf(g);
            for (const rings of polygons) {
                if (!rings[0]?.length)
                    continue;
                const shape = new THREE.Shape(rings[0].map(project));
                for (const r of rings.slice(1))
                    shape.holes.push(new THREE.Path(r.map(project)));
                const geometry = new THREE.ShapeGeometry(shape);
                geometry.rotateX(-Math.PI / 2);
                const mesh = new THREE.Mesh(geometry, naturalMaterial({ color, side: THREE.DoubleSide, clippingPlanes: [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), new THREE.Plane(new THREE.Vector3(-1, 0, 0), W * S), new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), new THREE.Plane(new THREE.Vector3(0, 0, 1), H * S)] }));
                mesh.position.y = .025;
                mesh.receiveShadow = true;
                landGroup.add(mesh);
            }
        }
        // Display only nearby labels and avoid stacking names over one another.
        let labelFrame = 0;
        const projected = new THREE.Vector3();
        function updateDetails() {
            serviceGroup.visible = toggles.services;
            if (++labelFrame % 6)
                return;
            const occupied: Array<{
                x: number;
                y: number;
            }> = [];
            camera.updateMatrixWorld();
            let displayed = 0;
            for (const e of [...named].sort((a, b) => a.position.distanceToSquared(camera.position) - b.position.distanceToSquared(camera.position))) {
                e.label.style.display = 'none';
                if (!toggles.labels || displayed >= 55 || e.position.distanceTo(camera.position) > 1400)
                    continue;
                projected.copy(e.position).project(camera);
                if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1)
                    continue;
                const x = (projected.x + 1) * innerWidth / 2, y = (1 - projected.y) * innerHeight / 2;
                if (!hud.hidden && x > innerWidth - 330 && y < 620)
                    continue;
                if (occupied.some(p => Math.abs(p.x - x) < 155 && Math.abs(p.y - y) < 32))
                    continue;
                occupied.push({ x, y });
                e.label.style.left = x + 'px';
                e.label.style.top = y + 'px';
                e.label.style.display = 'block';
                displayed++;
            }
        }
        // ---------- موقع الكاميرا ----------
        const c0 = meta.citadel || [(W * S) / 2, (H * S) / 2];
        const cx = c0[0], cz = -c0[1];
        camera.position.set(cx + 250, 200, cz + 330);
        camera.lookAt(cx, 0, cz);
        const canvas = renderer.domElement;
        canvas.style.touchAction = 'none';
        canvas.style.cursor = 'grab';
        orbit = new OrbitControls(camera, canvas);
        orbit.target.set(cx, groundElevation(cx, -cz), cz);
        orbit.enableDamping = true;
        orbit.dampingFactor = .09;
        orbit.screenSpacePanning = false;
        orbit.zoomToCursor = true;
        orbit.minDistance = 8;
        orbit.maxDistance = 6000;
        orbit.maxPolarAngle = Math.PI / 2 - .04;
        orbit.panSpeed = 1;
        orbit.rotateSpeed = .65;
        orbit.zoomSpeed = .9;
        orbit.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
        orbit.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
        orbit.update();
        orbit.saveState();
        const forward = new THREE.Vector3();
        const navigation = document.createElement('div');
        navigation.id = 'map-navigation';
        navigation.setAttribute('aria-label','أدوات التنقّل في الخريطة');
        navigation.style.cssText = 'position:fixed;left:16px;bottom:42px;z-index:3;display:flex;flex-direction:column;gap:5px';
        for (const [text, title, action] of ([
            ['+', 'تقريب', () => zoomMap(.8)], ['−', 'ابتعاد', () => zoomMap(1.25)],
            ['⌂', 'العودة إلى القلعة', () => { orbit.reset(); renderer.shadowMap.needsUpdate = true; }],
            ['↑', 'توجيه الشمال إلى أعلى', () => { const offset = camera.position.clone().sub(orbit.target), horizontal = Math.hypot(offset.x, offset.z); camera.position.set(orbit.target.x, orbit.target.y + offset.y, orbit.target.z + horizontal); orbit.update(); }]
        ] as Array<[
            string,
            string,
            () => void
        ]>)) {
            const button = document.createElement('button');
            button.textContent = text;
            button.title = title;
            button.setAttribute('aria-label', title);
            button.style.cssText = 'width:38px;height:38px;border:1px solid #ffffff50;background:#202c39ed;color:white;border-radius:7px;cursor:pointer;font-size:22px';
            button.onclick = action;
            navigation.append(button);
        }
        root.append(navigation);
        function zoomMap(factor: number) { const offset = camera.position.clone().sub(orbit.target), distance = THREE.MathUtils.clamp(offset.length() * factor, orbit.minDistance, orbit.maxDistance); offset.setLength(distance); camera.position.copy(orbit.target).add(offset); orbit.update(); }
        let drag: {
            id: number;
            x: number;
            y: number;
        } | null = null, dragDistance = 0;
        canvas.addEventListener('pointerdown', e => { dragDistance = 0; drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; canvas.style.cursor = 'grabbing'; });
        canvas.addEventListener('pointermove', e => {
            if (!drag || drag.id !== e.pointerId)
                return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            dragDistance += Math.hypot(dx, dy);
            drag.x = e.clientX;
            drag.y = e.clientY;
        });
        function endDrag() { drag = null; canvas.style.cursor = 'grab'; }
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);
        canvas.addEventListener('lostpointercapture', () => { drag = null; canvas.style.cursor = 'grab'; });
        listen('blur', endDrag);
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        const utilities = addUtilitySimulation({
            root, scene, roads: roadSource, meta, elevation: groundElevation, buildings: source,
            solidObjects: () => [plane, outer, buildings, landGroup].filter(object => object.visible),
            onChange: () => { renderer.shadowMap.needsUpdate = true; },
            focus: (x,y,level) => { orbit.reset();orbit.target.set(x,level,-y);camera.position.set(x+28,level+22,-y+35);orbit.update(); },
            setCutaway: enabled => {
                for (const object of [plane, outer, buildings, trunks, crowns, landGroup]) object.visible = !enabled;
                renderer.shadowMap.needsUpdate = true;
            },
        });
        listeners.push(() => utilities.dispose());
        const pickRay = new THREE.Raycaster();
        canvas.addEventListener('click', event => { if (dragDistance > 5 || event.ctrlKey)
            return; pickRay.setFromCamera(new THREE.Vector2(event.clientX / innerWidth * 2 - 1, 1 - event.clientY / innerHeight * 2), camera); if (utilities.handlePick(pickRay)) { info.style.display = 'none'; selection.visible = false; return; } if (utilities.cutaway) return; const hit = pickRay.intersectObjects([...buildings.children, plane, ...serviceGroup.children], false)[0]; if (!hit)
            return; const x = hit.point.x, y = -hit.point.z; let nearest = null, distance = Infinity; for (const e of entities) {
            const [a, b, c, d] = e.bounds;
            if (x < a - 3 || x > c + 3 || y < b - 3 || y > d + 3)
                continue;
            const dist = (e.x - x) ** 2 + (e.y - y) ** 2;
            if (dist < distance) {
                distance = dist;
                nearest = e;
            }
        } if (nearest)
            selectEntity(nearest); });
        element('height').addEventListener('input', e => { const v = Number((e.target as HTMLInputElement).value); buildings.scale.y = trunks.scale.y = crowns.scale.y = v; element('factor').textContent = v.toFixed(1) + '×'; renderer.shadowMap.needsUpdate = true; });
        listen('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
        element('counts').textContent = `المباني: ${count.toLocaleString('ar')} · الأشجار: ${treeCount.toLocaleString('ar')}`;
        root.querySelector<HTMLParagraphElement>('#hud .muted')!.innerHTML = 'سحب بالزر الأيسر: تحريك الخريطة<br>العجلة: تقريب / ابتعاد نحو المؤشر<br>Ctrl + سحب أو الزر الأيمن: دوران وميل<br>⌂: العودة إلى القلعة · ↑: اتجاه الشمال';
        root.querySelector<HTMLParagraphElement>('#hud .muted')!.append(document.createElement('br'), document.createTextNode('انقر على معلم أو ابحث لعرض جميع بياناته'));
        listeners.push(createMapInterface(root));
        let lastShadow = 0;
        const shadowCenter = new THREE.Vector3(), lastShadowCenter = new THREE.Vector3(Infinity, 0, Infinity);
        function animate(now: number) {
            requestAnimationFrame(animate);
            surfaceTime.value = now * .001;
            orbit.update();
            sun.castShadow = toggles.shadows && !utilities.cutaway && camera.position.y < 1600;
            if (sun.castShadow && now - lastShadow > 500) {
                camera.getWorldDirection(forward);
                const reach = forward.y < -.1 ? Math.min(400, Math.max(0, camera.position.y / -forward.y)) : 200;
                shadowCenter.copy(camera.position).addScaledVector(forward, reach);
                shadowCenter.y = 0;
                if (shadowCenter.distanceTo(lastShadowCenter) > 20 || !Number.isFinite(lastShadowCenter.x)) {
                    sun.target.position.copy(shadowCenter);
                    sun.position.copy(shadowCenter).add(new THREE.Vector3(-450, 850, 350));
                    sun.target.updateMatrixWorld();
                    renderer.shadowMap.needsUpdate = true;
                    lastShadowCenter.copy(shadowCenter);
                }
                lastShadow = now;
            }
            element('status').textContent = `ارتفاع الكاميرا: ${Math.round(camera.position.y)} م`;
            updateDetails();
            renderer.render(scene, camera);
        }
        requestAnimationFrame(animate);
    }
    catch (error) {
        if (!signal.aborted) {
            console.error(error);
            const bar = root.querySelector<HTMLElement>('#error');
            if (bar) {
                bar.style.display = 'block';
                bar.textContent = '???? ????? ???????: ' + (error instanceof Error ? error.message : String(error)) + ' ? npm run data:build';
            }
        }
    }
    return () => { signal.removeEventListener('abort', cleanup); cleanup(); };
}
