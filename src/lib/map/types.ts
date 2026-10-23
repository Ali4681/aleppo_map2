export type Coordinate = [
    number,
    number,
    ...number[]
];
export type Coordinates = Coordinate | Coordinates[];
export type Tags = Record<string, string>;
export type Geometry = {
    type: 'Point';
    coordinates: Coordinate;
} | {
    type: 'MultiPoint' | 'LineString';
    coordinates: Coordinate[];
} | {
    type: 'MultiLineString' | 'Polygon';
    coordinates: Coordinate[][];
} | {
    type: 'MultiPolygon';
    coordinates: Coordinate[][][];
};
export interface Feature {
    type: 'Feature';
    id?: string | number;
    properties: Record<string, unknown>;
    geometry: Geometry | null;
}
export interface FeatureCollection {
    type: 'FeatureCollection';
    features: Feature[];
    crs?: {
        properties: {
            name: string;
        };
    };
}
export interface MapMeta {
    S: number;
    W: number;
    H: number;
    lon0: number;
    lat0: number;
    kx: number;
    ky: number;
    citadel?: [
        number,
        number
    ] | null;
}
export function getTags(properties: Record<string, unknown> | undefined): Tags {
    const source = properties?.tags && typeof properties.tags === 'object' ? properties.tags : properties || {};
    return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== null && value !== undefined && value !== '' && value !== 'NULL').map(([key, value]) => [key, String(value)]));
}
export function polygonsOf(g: Geometry | null): Coordinate[][][] {
    return g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
}
export function linesOf(g: Geometry | null): Coordinate[][] {
    return g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
}
export function pointsOf(g: Geometry | null): Coordinate[] {
    return g?.type === 'Point' ? [g.coordinates] : g?.type === 'MultiPoint' ? g.coordinates : [];
}
export function coordinatesFlat(c: Coordinates, out: Coordinate[] = []): Coordinate[] {
    if (typeof c[0] === 'number')
        out.push(c as Coordinate);
    else
        for (const child of c as Coordinates[])
            coordinatesFlat(child, out);
    return out;
}
