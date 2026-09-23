/** Small spherical-geometry helpers. No dependency on the basemap backend. */

import type { BBox, GeoGeometry, Position } from '@/core/types';

const R = 6371008.8; // mean Earth radius, metres
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function haversine(a: Position, b: Position): number {
  const dLat = (b[1] - a[1]) * D2R;
  const dLon = (b[0] - a[0]) * D2R;
  const la1 = a[1] * D2R;
  const la2 = b[1] * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial bearing a→b, degrees clockwise from true north. */
export function bearingBetween(a: Position, b: Position): number {
  const la1 = a[1] * D2R;
  const la2 = b[1] * D2R;
  const dLon = (b[0] - a[0]) * D2R;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Move `dist` metres from `origin` along `bearingDeg`. */
export function destination(origin: Position, bearingDeg: number, dist: number): Position {
  const br = bearingDeg * D2R;
  const la1 = origin[1] * D2R;
  const lo1 = origin[0] * D2R;
  const dr = dist / R;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(
    Math.sin(br) * Math.sin(dr) * Math.cos(la1),
    Math.cos(dr) - Math.sin(la1) * Math.sin(la2),
  );
  return [((lo2 * R2D + 540) % 360) - 180, la2 * R2D];
}

/** Metres per degree of longitude at a latitude — for fast local maths. */
export function mPerLon(lat: number): number { return 111320 * Math.cos(lat * D2R); }
export const M_PER_LAT = 110540;

export function bboxOfPositions(pts: Position[]): BBox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pts) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}

export function bboxCenter(b: BBox): Position { return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }

export function expandBBox(b: BBox, factor: number): BBox {
  const [w, s, e, n] = b;
  const dx = ((e - w) * (factor - 1)) / 2;
  const dy = ((n - s) * (factor - 1)) / 2;
  return [w - dx, s - dy, e + dx, n + dy];
}

/** A closed rectangle ring, counter-clockwise. */
export function bboxRing(b: BBox): Position[] {
  const [w, s, e, n] = b;
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

/** Normalise any GeoJSON geometry to a list of polygons (each = list of rings). */
export function toPolygons(geom: GeoGeometry | null | undefined): Position[][][] {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

/** All vertices in a geometry — for fitting a viewport. */
export function geometryPositions(geom: GeoGeometry | null | undefined): Position[] {
  if (!geom) return [];
  switch (geom.type) {
    case 'Point': return [geom.coordinates];
    case 'LineString': return geom.coordinates;
    case 'Polygon': return geom.coordinates.flat();
    case 'MultiPolygon': return geom.coordinates.flat(2);
    default: return [];
  }
}

/** Cumulative length of a polyline in metres, plus the running totals. */
export function pathMetrics(path: Position[]): { total: number; cum: number[] } {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversine(path[i - 1], path[i]);
    cum.push(total);
  }
  return { total, cum };
}

/** Point at fraction `t` (0–1) along a polyline, plus the local heading. */
export function alongPath(path: Position[], t: number): { position: Position; heading: number } {
  if (path.length === 0) return { position: [0, 0], heading: 0 };
  if (path.length === 1) return { position: path[0], heading: 0 };
  const { total, cum } = pathMetrics(path);
  const target = Math.max(0, Math.min(1, t)) * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const seg = cum[i] - cum[i - 1];
  const f = seg === 0 ? 0 : (target - cum[i - 1]) / seg;
  const a = path[i - 1];
  const b = path[i];
  return {
    position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
    heading: bearingBetween(a, b),
  };
}

/** Great-circle-ish linear interpolation. Fine at neighbourhood scale. */
export function lerpPosition(a: Position, b: Position, t: number): Position {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** A wedge polygon (for radar sweeps and dispersion cones), closed. */
export function wedge(
  center: Position,
  radiusM: number,
  fromDeg: number,
  toDeg: number,
  steps = 24,
): Position[] {
  const ring: Position[] = [center];
  for (let i = 0; i <= steps; i++) {
    ring.push(destination(center, fromDeg + ((toDeg - fromDeg) * i) / steps, radiusM));
  }
  ring.push(center);
  return ring;
}

/** A circle as a closed ring — used for coverage rings. */
export function circleRing(center: Position, radiusM: number, steps = 64): Position[] {
  const ring: Position[] = [];
  for (let i = 0; i <= steps; i++) ring.push(destination(center, (360 * i) / steps, radiusM));
  return ring;
}

/** Web-mercator metres-per-pixel at a zoom/latitude. Powers `MapScale`. */
export function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos(lat * D2R)) / Math.pow(2, zoom);
}

/** Zoom that fits a bbox into a pixel viewport. */
export function fitZoom(b: BBox, width: number, height: number, padding = 48): number {
  const [w, s, e, n] = b;
  const worldW = 512;
  const lonFrac = Math.max(1e-9, (e - w) / 360);
  const latRad = (v: number) => Math.log(Math.tan(Math.PI / 4 + (v * D2R) / 2));
  const latFrac = Math.max(1e-9, (latRad(n) - latRad(s)) / (2 * Math.PI));
  const zx = Math.log2(Math.max(1, width - padding * 2) / (worldW * lonFrac));
  const zy = Math.log2(Math.max(1, height - padding * 2) / (worldW * latFrac));
  return Math.max(1, Math.min(20, Math.min(zx, zy)));
}

/**
 * Is a point inside a closed ring? Even-odd ray cast, planar.
 *
 * Planar is correct here and not a shortcut: the rings this is asked about are
 * a few kilometres across at mid-latitudes, and the question is which side of
 * an edge a road midpoint falls on — not a distance. A great-circle version
 * would move answers by less than the coordinate rounding already applied.
 *
 * Points exactly on an edge are unspecified, as they are for every even-odd
 * implementation. Callers must not depend on the boundary case: the shapes
 * this is used with are deliberately soft, and a caller that cares whether a
 * street is just inside or just outside a modelled plume edge is asking a
 * question the plume cannot answer.
 */
export function pointInRing(ring: Position[], p: Position): boolean {
  let inside = false;
  const [x, y] = p;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
