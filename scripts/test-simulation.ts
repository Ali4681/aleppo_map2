import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateNetworks, networkGeoJson, NETWORK_KINDS, NETWORKS } from '../src/lib/map/simulation';
import type { FeatureCollection, MapMeta } from '../src/lib/map/types';

const meta: MapMeta = { S: 1, W: 100, H: 100, lon0: 0, lat0: 0, kx: 1, ky: 1 };
const roads: FeatureCollection = { type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'crossing', properties: { highway: 'residential' }, geometry: { type: 'LineString', coordinates: [[-20, 20], [50, 20], [120, 20]] } },
  { type: 'Feature', id: 'branch', properties: { highway: 'service' }, geometry: { type: 'LineString', coordinates: [[50, 20], [50, 80]] } },
  { type: 'Feature', id: 'duplicate', properties: { highway: 'residential' }, geometry: { type: 'LineString', coordinates: [[50, 20], [-20, 20]] } },
  { type: 'Feature', id: 'bridge', properties: { highway: 'primary', bridge: 'yes' }, geometry: { type: 'LineString', coordinates: [[10, 10], [80, 80]] } },
  { type: 'Feature', id: 'outside', properties: { highway: 'primary' }, geometry: { type: 'LineString', coordinates: [[-20, -20], [-10, -10]] } },
] };
const data = generateNetworks(roads, meta);
assert.deepEqual(data, generateNetworks(roads, meta), 'Output must be deterministic');
assert.equal(data.edges.length, 24, 'Long segments are split into support spans, duplicates excluded');
assert.equal(new Set(data.edges.map(edge => edge.id)).size, data.edges.length);
assert.equal(data.nodes.filter(node => node.connections === 3).length, 4, 'Shared junctions stay connected');
assert.equal(generateNetworks(roads, meta, () => 24).edges.length, 0, 'Exclude citadel mound');
for (const edge of data.edges) {
  assert.ok(edge.simulated && edge.length > 0 && edge.length < 40);
  if (NETWORKS[edge.kind].overhead) {
    assert.ok(edge.height > 0 && edge.depth === 0 && edge.fromHeight > 0 && edge.toHeight > 0);
  } else {
    assert.ok(edge.depth > 0 && edge.height === 0 && edge.fromHeight < 0 && edge.toHeight < 0);
  }
  if (edge.kind === 'sewer') assert.ok(edge.fromHeight >= edge.toHeight, 'Flow follows decreasing invert levels');
  for (const point of [edge.from, edge.to]) assert.ok(point.every(value => Number.isFinite(value) && value >= 0 && value <= 100));
}
for (const kind of NETWORK_KINDS) assert.ok(data.edges.some(edge => edge.kind === kind));
const exported = networkGeoJson(data, meta);
assert.equal(exported.features.length, data.edges.length + data.nodes.length);
for (const feature of exported.features) {
  assert.equal(feature.properties.simulated, true);
  assert.ok(feature.properties.disclaimer);
  assert.ok(Number(feature.properties.depth_m) > 0 || Number(feature.properties.height_m) > 0);
}
// Invert levels at shared junctions must match across every incident sewer.
const levels = new Map<string, number>();
for (const edge of data.edges.filter(edge => edge.kind === 'sewer')) {
  for (const [point, level] of [[edge.from, edge.fromHeight], [edge.to, edge.toHeight]] as const) {
    const key = point.join(',');
    if (levels.has(key)) assert.equal(levels.get(key), level);
    levels.set(key, level);
  }
}
const blockers: FeatureCollection = { type:'FeatureCollection', features:[{type:'Feature',properties:{building:'yes'},geometry:{type:'Polygon',coordinates:[[[40,10],[60,10],[60,40],[40,40],[40,10]]]}}] };
const avoided = generateNetworks(roads, meta, () => 0, blockers);
assert.ok(avoided.edges.length < data.edges.length, 'Building crossings are rejected');
for (const edge of avoided.edges) for (let step=0;step<=20;step++) {
  const x=edge.from[0]+(edge.to[0]-edge.from[0])*step/20,y=edge.from[1]+(edge.to[1]-edge.from[1])*step/20;
  assert.ok(!(x>40&&x<60&&y>10&&y<40), 'Do not route through building interiors');
}
const liveMeta = JSON.parse(await readFile('public/old/meta.json', 'utf8')) as MapMeta;
const liveRoads = JSON.parse(await readFile('public/old/roads.geojson', 'utf8')) as FeatureCollection;
const generated = generateNetworks(liveRoads, liveMeta);
assert.ok(generated.edges.length > 0);
assert.deepEqual(generated, generateNetworks(liveRoads, liveMeta));
console.log(`Simulation checks passed. Local roads: ${generated.edges.length} segments, ${generated.nodes.length} nodes.`);
