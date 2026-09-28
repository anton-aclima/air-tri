/**
 * Wind field sampling — the maths behind the particle advection.
 *
 * `WindField.cells` arrives as a flat list of grid cells. To advect a particle we
 * need to ask "what is the wind *here*", between cells, thousands of times per
 * frame. So we index the cells into typed arrays once and bilinearly interpolate,
 * which is both smooth and allocation-free.
 *
 * Two honesty rules are baked in:
 *   · `dir_deg` is meteorological — the direction the wind blows FROM — so the
 *     motion vector is `dir + 180`. Getting this backwards is the classic bug.
 *   · every node carries a CONFIDENCE derived from `n` and `dir_sd`. Cells built
 *     from few, disagreeing observations thin their particles out instead of
 *     inventing a confident stream. Fabricated certainty is off-brand for a
 *     measurement company.
 */

import type { BBox, WindField } from '@/core/types';
import { M_PER_LAT, mPerLon } from './geo';

export interface FieldSample { u: number; v: number; speed: number; conf: number }

export interface FieldIndex {
  bbox: BBox;
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  minLon: number;
  minLat: number;
  /** Mean wind speed across the field — used for step sizing. */
  meanSpeed: number;
  maxSpeed: number;
  /** Writes into `out` and returns it. `out.conf` is 0 outside the field. */
  sample(lon: number, lat: number, out: FieldSample): FieldSample;
}

/**
 * Confidence 0–1 from sample count and directional steadiness.
 * `n = 12` and `dir_sd = 0` is fully trusted; 2 observations swinging 90° is not.
 */
export function cellConfidence(n: number, dirSd: number, nRef = 12): number {
  const byCount = Math.min(1, Math.max(0, (n || 0) / nRef));
  const bySteadiness = 1 - Math.min(1, Math.max(0, (dirSd || 0) / 75));
  return Math.max(0, Math.min(1, byCount * (0.35 + 0.65 * bySteadiness)));
}

const EMPTY_SAMPLE: FieldSample = { u: 0, v: 0, speed: 0, conf: 0 };

export function buildFieldIndex(field: WindField | null | undefined): FieldIndex | null {
  const cells = field?.cells ?? [];
  if (!cells.length) return null;

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const c of cells) {
    if (c.lon < minLon) minLon = c.lon;
    if (c.lon > maxLon) maxLon = c.lon;
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
  }
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null;

  const midLat = (minLat + maxLat) / 2;
  const size = field?.cell_size_m && field.cell_size_m > 0 ? field.cell_size_m : 400;
  const dy = size / M_PER_LAT;
  const dx = size / Math.max(1, mPerLon(midLat));

  const nx = Math.max(2, Math.round((maxLon - minLon) / dx) + 1);
  const ny = Math.max(2, Math.round((maxLat - minLat) / dy) + 1);
  const n = nx * ny;

  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const conf = new Float32Array(n);
  const has = new Uint8Array(n);

  let sumSpeed = 0;
  let maxSpeed = 0;
  for (const c of cells) {
    const ix = Math.round((c.lon - minLon) / dx);
    const iy = Math.round((c.lat - minLat) / dy);
    if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) continue;
    const i = iy * nx + ix;
    // meteorological → motion vector
    const a = ((c.dir_deg ?? 0) + 180) * (Math.PI / 180);
    const sp = Math.max(0, c.speed_ms ?? 0);
    u[i] = Math.sin(a) * sp;
    v[i] = Math.cos(a) * sp;
    conf[i] = cellConfidence(c.n, c.dir_sd);
    has[i] = 1;
    sumSpeed += sp;
    if (sp > maxSpeed) maxSpeed = sp;
  }

  // Fill holes so a particle never stalls in a gap — but only ONE pass. Each
  // pass grows the field a full cell beyond where we actually measured, and the
  // index's bounding box is a rectangle while a campaign is a polygon: three
  // passes is how a particle field ends up flowing confidently over ground no
  // vehicle ever drove. One pass closes interior holes and stops there.
  for (let pass = 0; pass < 1; pass++) {
    let filled = 0;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iy * nx + ix;
        if (has[i]) continue;
        let su = 0;
        let sv = 0;
        let sc = 0;
        let k = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const jx = ix + ox;
            const jy = iy + oy;
            if (jx < 0 || jx >= nx || jy < 0 || jy >= ny) continue;
            const j = jy * nx + jx;
            if (!has[j]) continue;
            su += u[j]; sv += v[j]; sc += conf[j]; k++;
          }
        }
        if (k >= 2) {
          u[i] = su / k; v[i] = sv / k;
          // interpolated nodes are explicitly less trusted than measured ones
          conf[i] = (sc / k) * 0.3;
          has[i] = 2;
          filled++;
        }
      }
    }
    if (!filled) break;
  }

  const meanSpeed = cells.length ? sumSpeed / cells.length : 0;

  const sample = (lon: number, lat: number, out: FieldSample): FieldSample => {
    const fx = (lon - minLon) / dx;
    const fy = (lat - minLat) / dy;
    if (fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) {
      out.u = 0; out.v = 0; out.speed = 0; out.conf = 0;
      return out;
    }
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const ix1 = Math.min(nx - 1, ix + 1);
    const iy1 = Math.min(ny - 1, iy + 1);

    const i00 = iy * nx + ix;
    const i10 = iy * nx + ix1;
    const i01 = iy1 * nx + ix;
    const i11 = iy1 * nx + ix1;

    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;

    out.u = u[i00] * w00 + u[i10] * w10 + u[i01] * w01 + u[i11] * w11;
    out.v = v[i00] * w00 + v[i10] * w10 + v[i01] * w01 + v[i11] * w11;
    out.conf = conf[i00] * w00 + conf[i10] * w10 + conf[i01] * w01 + conf[i11] * w11;
    out.speed = Math.sqrt(out.u * out.u + out.v * out.v);
    return out;
  };

  return {
    bbox: [minLon, minLat, maxLon, maxLat],
    nx, ny, dx, dy, minLon, minLat,
    meanSpeed, maxSpeed,
    sample,
  };
}

export function emptySample(): FieldSample { return { ...EMPTY_SAMPLE }; }

// ───────────────────────────────────────────────────────── projections

/**
 * A projector maps geography to canvas pixels and back, writing into caller-owned
 * arrays so the hot loop allocates nothing.
 */
export interface Projector {
  project(lon: number, lat: number, out: [number, number]): [number, number];
  unproject(x: number, y: number, out: [number, number]): [number, number];
  /** Pixels are only valid inside this shape. */
  clip: 'rect' | 'circle';
  width: number;
  height: number;
  /**
   * The clip circle, when `clip === 'circle'`. A circular frame's ring is usually
   * SMALLER than its box, so consumers must clip to this rather than assuming
   * an inscribed circle — otherwise particles fill the corners outside the ring.
   */
  cx?: number;
  cy?: number;
  r?: number;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * Web Mercator, matching what deck.gl and both basemap backends draw — built by
 * hand rather than via `WebMercatorViewport.project()` because that allocates an
 * array per call, and this runs thousands of times a frame.
 *
 * Pitch is ignored: a tilted camera would need the full matrix, and the wind
 * field is only used on flat views.
 */
export function mercatorProjector(view: {
  longitude: number; latitude: number; zoom: number; bearing?: number;
}, width: number, height: number): Projector {
  const scale = 512 * Math.pow(2, view.zoom);
  const worldX = (lon: number) => ((lon + 180) / 360) * scale;
  const worldY = (lat: number) => {
    const s = Math.sin(Math.max(-85, Math.min(85, lat)) * D2R);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  };

  const cx = worldX(view.longitude);
  const cy = worldY(view.latitude);
  const rot = -(view.bearing ?? 0) * D2R;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const hw = width / 2;
  const hh = height / 2;

  return {
    clip: 'rect',
    width,
    height,
    project(lon, lat, out) {
      const dxp = worldX(lon) - cx;
      const dyp = worldY(lat) - cy;
      out[0] = hw + dxp * cosR - dyp * sinR;
      out[1] = hh + dxp * sinR + dyp * cosR;
      return out;
    },
    unproject(x, y, out) {
      const px = x - hw;
      const py = y - hh;
      // inverse rotation
      const dxp = px * cosR + py * sinR;
      const dyp = -px * sinR + py * cosR;
      const wx = cx + dxp;
      const wy = cy + dyp;
      out[0] = (wx / scale) * 360 - 180;
      const t = Math.PI * (1 - (2 * wy) / scale);
      out[1] = R2D * Math.atan(Math.sinh(t));
      return out;
    },
  };
}

