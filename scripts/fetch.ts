import type { Coordinate, Coordinates, Geometry, Tags, FeatureCollection } from '../src/lib/map/types';
import { getTags, coordinatesFlat } from '../src/lib/map/types';
type MetricPoint = [
    number,
    number
];
type Job = {
    g: Geometry;
    T: Tags;
    id: number;
};
type LandJob = {
    g: Geometry;
    pk?: boolean;
};
type Painter = (ix: number, iy: number) => void;
// node build.mjs [cell=3] [folder=qgis] [--bbox=S,W,N,E]
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const pos = argv.filter((a) => !a.startsWith("--"));
const S = Number(pos[0] || 3); // حجم المكعب بالمتر
const DIR = pos[1] || "qgis";
const OUT = "public/old";
const RUBBLE = true; // المباني المتضررة تطلع ركام
// ---------- قراءة ملفات QGIS ----------
if (!fs.existsSync(DIR)) {
    console.error(`المجلد ${DIR}/ غير موجود`);
    process.exit(1);
}
const files = fs
    .readdirSync(DIR)
    .filter((f) => f.toLowerCase().endsWith(".geojson"));
if (!files.length) {
    console.error(`ما في ملفات .geojson داخل ${DIR}/`);
    process.exit(1);
}
const clean = getTags;
const items: Job[] = [];
const seen = new Set();
let seq = 0;
for (const f of files) {
    const gj = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as FeatureCollection;
    let n = 0;
    for (const ft of gj.features || []) {
        const g = ft.geometry;
        if (!g)
            continue;
        const T = clean(ft.properties);
        const key = T.full_id || (T.osm_type && T.osm_id ? T.osm_type + T.osm_id : null);
        if (key) {
            const k = key + "|" + g.type;
            if (seen.has(k))
                continue;
            seen.add(k);
        }
        const id = parseInt(T.osm_id) ||
            parseInt(String(T.full_id || "").replace(/\D/g, "")) ||
            ++seq;
        items.push({ g, T, id });
        n++;
    }
    console.log(`${f}: ${n} عنصر`);
}
console.log(`المجموع بعد إزالة التكرار: ${items.length}`);
// ---------- حدود المنطقة ----------
const eachCoord = (a: Coordinates, fn: (coordinate: Coordinate) => void) => coordinatesFlat(a).forEach(fn);
let minLon = 1e9, minLat = 1e9, maxLon = -1e9, maxLat = -1e9;
const grow = (c: Coordinate) => {
    if (c[0] < minLon)
        minLon = c[0];
    if (c[0] > maxLon)
        maxLon = c[0];
    if (c[1] < minLat)
        minLat = c[1];
    if (c[1] > maxLat)
        maxLat = c[1];
};
if (flags.bbox) {
    const [s, w, n, e] = flags.bbox.split(",").map(Number);
    minLat = s;
    minLon = w;
    maxLat = n;
    maxLon = e;
}
else {
    for (const it of items)
        if (it.T.building && /Polygon/.test(it.g.type))
            eachCoord(it.g.coordinates, grow);
    if (minLon > maxLon)
        for (const it of items)
            eachCoord(it.g.coordinates, grow);
}
const kx = 111320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
const ky = 110540;
const BW = minLon - 40 / kx, BS = minLat - 40 / ky;
const BE = maxLon + 40 / kx, BN = maxLat + 40 / ky;
const W = Math.ceil(((BE - BW) * kx) / S);
const H = Math.ceil(((BN - BS) * ky) / S);
console.log(`المنطقة: ${((W * S) / 1000).toFixed(2)} × ${((H * S) / 1000).toFixed(2)} كم | الشبكة ${W}×${H}`);
if (W * H > 40e6) {
    console.error("المنطقة كبيرة جداً. استخدم --bbox أو خلية أكبر.");
    process.exit(1);
}
const proj = ([lo, la]: Coordinate): MetricPoint => [(lo - BW) * kx, (la - BS) * ky];
const ground = new Uint8Array(W * H); // 0 أرض، 1 عشب، 2 ماء، 3 إسفلت، 4 حجر
const bh = new Uint8Array(W * H);
const bc = new Uint8Array(W * H);
const park = new Uint8Array(W * H);
const trees: Array<[
    number,
    number,
    number
]> = [];
let citadel: MetricPoint | null = null;
const hash = (n: number) => {
    n = n ^ 61 ^ (n >>> 16);
    n = (n + (n << 3)) | 0;
    n = n ^ (n >>> 4);
    n = Math.imul(n, 0x27d4eb2d);
    n = n ^ (n >>> 15);
    return (n >>> 0) / 4294967296;
};
// ---------- هندسة ----------
const inRing = (x: number, y: number, ring: MetricPoint[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
            inside = !inside;
    }
    return inside;
};
const inPoly = (x: number, y: number, rings: MetricPoint[][]) => {
    if (!inRing(x, y, rings[0]))
        return false;
    for (let k = 1; k < rings.length; k++)
        if (inRing(x, y, rings[k]))
            return false;
    return true;
};
const polysOf = (g: Geometry): Coordinate[][][] => g.type === "Polygon"
    ? [g.coordinates]
    : g.type === "MultiPolygon"
        ? g.coordinates
        : [];
const linesOf = (g: Geometry): Coordinate[][] => g.type === "LineString"
    ? [g.coordinates]
    : g.type === "MultiLineString"
        ? g.coordinates
        : [];
function fillPoly(rings: MetricPoint[][], cb: Painter) {
    let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
    for (const [x, y] of rings[0]) {
        if (x < x0)
            x0 = x;
        if (x > x1)
            x1 = x;
        if (y < y0)
            y0 = y;
        if (y > y1)
            y1 = y;
    }
    const ax = Math.max(0, Math.floor(x0 / S)), bx = Math.min(W - 1, Math.floor(x1 / S));
    const ay = Math.max(0, Math.floor(y0 / S)), by = Math.min(H - 1, Math.floor(y1 / S));
    let any = false;
    for (let ix = ax; ix <= bx; ix++)
        for (let iy = ay; iy <= by; iy++)
            if (inPoly((ix + 0.5) * S, (iy + 0.5) * S, rings)) {
                cb(ix, iy);
                any = true;
            }
    return any;
}
function disc(mx: number, my: number, r: number, cb: Painter) {
    const ix0 = Math.floor((mx - r) / S), ix1 = Math.floor((mx + r) / S);
    const iy0 = Math.floor((my - r) / S), iy1 = Math.floor((my + r) / S);
    for (let ix = ix0; ix <= ix1; ix++)
        for (let iy = iy0; iy <= iy1; iy++) {
            if (ix < 0 || iy < 0 || ix >= W || iy >= H)
                continue;
            const dx = (ix + 0.5) * S - mx, dy = (iy + 0.5) * S - my;
            if (dx * dx + dy * dy <= r * r + S * S * 0.25)
                cb(ix, iy);
        }
}
function drawLine(pts: MetricPoint[], width: number, cb: Painter) {
    for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (S / 2)));
        for (let s = 0; s <= n; s++) {
            const t = s / n;
            disc(ax + (bx - ax) * t, ay + (by - ay) * t, width / 2, cb);
        }
    }
}
const putBld = (ix: number, iy: number, h: number, c: number) => {
    if (ix < 0 || iy < 0 || ix >= W || iy >= H)
        return;
    const i = ix + iy * W;
    if (h >= bh[i]) {
        bh[i] = h;
        bc[i] = c;
    }
};
const addTree = (x: number, y: number, h: number) => {
    if (x < 0 || y < 0 || x >= W * S || y >= H * S)
        return;
    trees.push([x, y, h]);
};
// ---------- نمط المبنى ----------
function bldStyle(T: Tags, id: number): MetricPoint {
    const r = hash(id);
    let h = parseFloat(T.height) || parseFloat(T["building:height"]);
    if (!h) {
        const lv = parseFloat(T["building:levels"]);
        if (lv)
            h = lv * 3.2 + 0.5;
    }
    const worship = T.amenity === "place_of_worship" ||
        ["mosque", "church", "religious", "cathedral", "chapel"].includes(T.building);
    const castle = T.historic === "castle" ||
        T.historic === "citadel" ||
        T.building === "castle";
    const shop = T.amenity === "marketplace" ||
        T.shop ||
        ["retail", "commercial", "kiosk"].includes(T.building);
    if (!h)
        h = castle ? 24 : worship ? 9 + r * 4 : 4.5 + Math.floor(r * 4) * 1.5;
    let c = castle
        ? 4
        : worship
            ? 3
            : shop
                ? 6
                : r < 0.45
                    ? 0
                    : r < 0.8
                        ? 1
                        : r < 0.95
                            ? 2
                            : 5;
    if (T["tower:type"] === "minaret") {
        h = Math.max(h, 26);
        c = 3;
    }
    const damaged = (T.damage && T.damage !== "no") ||
        T.ruins === "yes" ||
        T["ruins:building"] ||
        T["destroyed:building"] ||
        T.destroyed ||
        T.building === "ruins";
    if (RUBBLE && damaged) {
        h = Math.min(h, 2.5);
        c = 7;
    }
    return [Math.max(2, Math.min(120, Math.round(h))), c];
}
// ---------- تصنيف ----------
const GRASS_LEISURE = [
    "park",
    "garden",
    "pitch",
    "playground",
    "recreation_ground",
    "golf_course",
];
const GRASS_LANDUSE = [
    "grass",
    "forest",
    "meadow",
    "village_green",
    "recreation_ground",
    "orchard",
    "cemetery",
];
const GRASS_NATURAL = ["wood", "scrub", "grassland"];
const jobs: {
    grass: LandJob[];
    plaza: LandJob[];
    water: LandJob[];
    bld: Job[];
    lines: Job[];
    pts: Array<{
        T: Tags;
        id: number;
        pt: Coordinate;
    }>;
} = { grass: [], plaza: [], water: [], bld: [], lines: [], pts: [] };
for (const { g, T, id } of items) {
    if (T.historic === "castle" || T.historic === "citadel") {
        if (!citadel) {
            const pts: Coordinate[] = [];
            eachCoord(g.coordinates, (c) => pts.push(c));
            citadel = proj([
                pts.reduce((s, c) => s + c[0], 0) / pts.length,
                pts.reduce((s, c) => s + c[1], 0) / pts.length,
            ]);
        }
    }
    if (g.type === "Point") {
        jobs.pts.push({ T, id, pt: g.coordinates });
        continue;
    }
    if (g.type === "MultiPoint") {
        for (const c of g.coordinates)
            jobs.pts.push({ T, id, pt: c });
        continue;
    }
    if (g.type === "Polygon" || g.type === "MultiPolygon") {
        if (T.building ||
            T.historic === "castle" ||
            T.historic === "citadel" ||
            T["tower:type"] === "minaret")
            jobs.bld.push({ T, id, g });
        else if (T.natural === "water" ||
            T.water ||
            T.waterway === "riverbank" ||
            T.amenity === "fountain")
            jobs.water.push({ g });
        else if (T.highway === "pedestrian" ||
            T.place === "square" ||
            T.amenity === "marketplace")
            jobs.plaza.push({ g });
        else if (GRASS_LEISURE.includes(T.leisure) ||
            GRASS_LANDUSE.includes(T.landuse) ||
            GRASS_NATURAL.includes(T.natural)) {
            const pk = ["park", "garden"].includes(T.leisure) ||
                ["forest", "orchard", "village_green"].includes(T.landuse) ||
                ["wood", "scrub"].includes(T.natural);
            jobs.grass.push({ g, pk });
        }
    }
    else if (g.type === "LineString" || g.type === "MultiLineString") {
        jobs.lines.push({ T, id, g });
    }
}
// ---------- الأرض ----------
const paint = (arr: LandJob[], val: number) => {
    for (const { g, pk } of arr)
        for (const poly of polysOf(g))
            fillPoly(poly.map((r) => r.map(proj)), (ix, iy) => {
                ground[ix + iy * W] = val;
                if (pk)
                    park[ix + iy * W] = 1;
            });
};
paint(jobs.grass, 1);
paint(jobs.plaza, 4);
paint(jobs.water, 2);
// ---------- الخطوط ----------
const ROAD_W: Record<string, number> = {
    motorway: 10,
    trunk: 10,
    primary: 9,
    secondary: 7,
    tertiary: 6,
    residential: 5,
    unclassified: 5,
    living_street: 4,
    service: 3.5,
    pedestrian: 4,
    footway: 2,
    path: 2,
    steps: 2,
    cycleway: 2,
    track: 3,
    corridor: 2,
};
const STONE = new Set([
    "pedestrian",
    "footway",
    "path",
    "steps",
    "corridor",
    "living_street",
]);
for (const { T, id, g } of jobs.lines) {
    for (const line of linesOf(g)) {
        const pts = line.map(proj);
        if (T.highway && ROAD_W[T.highway]) {
            const v = STONE.has(T.highway) ? 4 : 3;
            drawLine(pts, ROAD_W[T.highway], (ix, iy) => {
                ground[ix + iy * W] = v;
            });
        }
        else if (["river", "canal", "stream", "drain", "ditch"].includes(T.waterway)) {
            drawLine(pts, T.waterway === "river" ? 10 : 3, (ix, iy) => {
                ground[ix + iy * W] = 2;
            });
        }
        else if (T.barrier === "city_wall" || T.historic === "citywalls") {
            drawLine(pts, 2.5, (ix, iy) => putBld(ix, iy, 10, 4));
        }
        else if (T.natural === "tree_row") {
            for (let i = 1; i < pts.length; i++) {
                const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
                const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 7));
                for (let s = 0; s <= n; s++)
                    addTree(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n, 4 + hash(id + s) * 3);
            }
        }
    }
}
// ---------- المباني ----------
for (const { T, id, g } of jobs.bld) {
    const [h, c] = bldStyle(T, id);
    for (const poly of polysOf(g)) {
        const rings = poly.map((r) => r.map(proj));
        const any = fillPoly(rings, (ix, iy) => putBld(ix, iy, h, c));
        if (!any) {
            const n = rings[0].length;
            const mx = rings[0].reduce((s, p) => s + p[0], 0) / n;
            const my = rings[0].reduce((s, p) => s + p[1], 0) / n;
            putBld(Math.floor(mx / S), Math.floor(my / S), h, c);
        }
    }
}
// ---------- النقاط ----------
for (const { T, id, pt } of jobs.pts) {
    const [x, y] = proj(pt);
    if (T.natural === "tree")
        addTree(x, y, parseFloat(T.height) || 4 + hash(id) * 4);
    else if (T.amenity === "fountain")
        disc(x, y, 2, (ix, iy) => {
            ground[ix + iy * W] = 2;
        });
    else if (T["tower:type"] === "minaret")
        putBld(Math.floor(x / S), Math.floor(y / S), 26, 3);
}
// ---------- أشجار الحدائق ----------
for (let iy = 0; iy < H; iy++)
    for (let ix = 0; ix < W; ix++) {
        const i = ix + iy * W;
        if (park[i] &&
            ground[i] === 1 &&
            !bh[i] &&
            hash((ix * 73856093) ^ (iy * 19349663)) < 0.12)
            addTree((ix + 0.2 + hash(i + 7) * 0.6) * S, (iy + 0.2 + hash(i + 13) * 0.6) * S, 4 + hash(i + 29) * 4);
    }
// ---------- الكتابة ----------
fs.mkdirSync(OUT, { recursive: true });
let nb = 0;
for (let i = 0; i < W * H; i++)
    if (bh[i])
        nb++;
const bbuf = Buffer.alloc(4 + nb * 6);
bbuf.writeUInt32LE(nb, 0);
let o = 4;
for (let iy = 0; iy < H; iy++)
    for (let ix = 0; ix < W; ix++) {
        const i = ix + iy * W;
        if (!bh[i])
            continue;
        bbuf.writeUInt16LE(ix, o);
        bbuf.writeUInt16LE(iy, o + 2);
        bbuf.writeUInt8(bh[i], o + 4);
        bbuf.writeUInt8(bc[i], o + 5);
        o += 6;
    }
const inGrid = citadel &&
    citadel[0] >= 0 &&
    citadel[1] >= 0 &&
    citadel[0] < W * S &&
    citadel[1] < H * S;
fs.writeFileSync(`${OUT}/bld.bin`, bbuf);
fs.writeFileSync(`${OUT}/ground.bin`, Buffer.from(ground));
fs.writeFileSync(`${OUT}/trees.bin`, Buffer.from(new Float32Array(trees.flat()).buffer));
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({
    S,
    W,
    H,
    lon0: BW,
    lat0: BS,
    kx,
    ky,
    citadel: inGrid ? citadel : null,
}));
const cnt = (v: number) => ground.reduce((s, x) => s + Number(x === v), 0);
console.log("-----------------------------");
console.log(`أعمدة مباني: ${nb.toLocaleString()}`);
console.log(`أشجار: ${trees.length.toLocaleString()}`);
console.log(`عشب: ${cnt(1).toLocaleString()} | ماء: ${cnt(2).toLocaleString()} | طرق: ${cnt(3).toLocaleString()} | حجر: ${cnt(4).toLocaleString()}`);
console.log(`القلعة: ${inGrid ? "موجودة" : "غير موجودة بالبيانات"}`);
const collection: FeatureCollection = { type: 'FeatureCollection', features: items.map(({ g, T, id }) => ({ type: 'Feature', id: (T.osm_type || g.type) + '/' + id, properties: T, geometry: g })) };
fs.writeFileSync(OUT + '/details.geojson', JSON.stringify(collection));
fs.writeFileSync(OUT + '/roads.geojson', JSON.stringify({ ...collection, features: collection.features.filter(f => f.properties.highway && ['LineString', 'MultiLineString'].includes(f.geometry!.type)) }));
fs.writeFileSync(OUT + '/buildings.geojson', JSON.stringify({ ...collection, features: collection.features.filter(f => f.properties.building || f.properties.historic === 'castle') }));
