import type { Feature, FeatureCollection } from '../src/lib/map/types';
import { getTags } from '../src/lib/map/types';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
// QGIS exports nullable columns and stores OSM identities in properties.
export async function readQgis(directory: string): Promise<FeatureCollection> {
    const names = (await readdir(directory)).filter(name => name.endsWith('.geojson')).sort();
    if (!names.length)
        throw new Error(`No GeoJSON files in ${directory}`);
    const merged = new Map<string | number, Feature>();
    let total = 0;
    for (const name of names) {
        const data = JSON.parse(await readFile(join(directory, name), 'utf8')) as FeatureCollection;
        const crs = data.crs?.properties?.name;
        if (crs && !/CRS84|4326/i.test(crs))
            throw new Error(`${name}: expected longitude/latitude CRS, got ${crs}`);
        if (!Array.isArray(data.features))
            throw new Error(`${name}: expected FeatureCollection`);
        for (const [index, feature] of data.features.entries()) {
            if (!feature.geometry)
                continue;
            const properties = getTags(feature.properties);
            const type = ({ n: 'node', w: 'way', r: 'relation' } as Record<string, string>)[properties.full_id?.[0] || ''] || properties.osm_type;
            const numericId = properties.osm_id ?? properties.full_id?.slice(1);
            const id = feature.id ?? (type && numericId ? `${type}/${numericId}` : `${name}/${index}`);
            const previous = merged.get(id);
            merged.set(id, { type: 'Feature', id, properties: { ...previous?.properties, ...properties }, geometry: feature.geometry });
            total++;
        }
        console.log(`QGIS ${name}: ${data.features.length} features`);
    }
    console.log(`QGIS merged: ${merged.size} features; removed ${total - merged.size} duplicates`);
    return { type: 'FeatureCollection', features: [...merged.values()] };
}
