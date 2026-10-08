/**
 * What the streets IN VIEW measure — the domain a road grid is stretched to
 * when it is normalised to the viewport (owner, 2026-10-08).
 *
 * Aclima's street differences are real and small: on a fixed 0–100 scale most
 * of a neighbourhood lands in one pale band. Stretching the ramp to the streets
 * currently on screen spends the whole ramp on the differences you are looking
 * at, and re-stretches as you pan and zoom. The price is that a colour no
 * longer means a level — "dark" is "high for this view" — so the key must say
 * what the range is and where the published limits sit (RampKey).
 *
 * The domain is ROBUST (2nd–98th percentile of the streets in view), not
 * min–max: one hot block would otherwise compress every other street into the
 * bottom of the ramp, which is the problem this exists to fix. `min`/`max` are
 * still returned, for the key to print the true extremes.
 */

import { WebMercatorViewport } from 'deck.gl';

import type { MapView } from '../map/MapContext';
import type { SegmentCollection } from '@/core/types';
import { robustDomain } from './scales';

export type Bounds = [west: number, south: number, east: number, north: number];

/** The geographic box a camera shows in a `width × height` px frame. */
export function viewBounds(
  view: Pick<MapView, 'longitude' | 'latitude' | 'zoom'> | null | undefined,
  width: number,
  height: number,
): Bounds | null {
  if (!view || width <= 0 || height <= 0) return null;
  const vp = new WebMercatorViewport({
    width, height, longitude: view.longitude, latitude: view.latitude, zoom: view.zoom,
  });
  const [w, s, e, n] = vp.getBounds();
  return [w, s, e, n];
}

export interface ViewRange {
  /** The stretched domain: 2nd–98th percentile of the streets in view. */
  lo: number;
  hi: number;
  /** The true extremes in view. */
  min: number;
  max: number;
  /** Streets in view with a value. */
  n: number;
}

/** Streets with at least this many values in view before a range is worth stretching to. */
export const MIN_STREETS_IN_VIEW = 4;

/**
 * The range of `value` over every feature with a vertex inside `bounds`.
 * Null when fewer than `MIN_STREETS_IN_VIEW` streets are in view (a stretched
 * ramp over two streets is noise), or when no bounds are known yet.
 */
export function viewRange(
  data: SegmentCollection | null | undefined,
  bounds: Bounds | null,
  opts: {
    minPasses?: number
    /**
     * The narrowest domain the ramp may be stretched over, in the value's
     * unit. Zoomed onto one block, 21 streets read 8.1–9.4 µg/m³ and the
     * whole ramp was spent on 1.3 µg/m³ — teal against plum for a difference
     * inside measurement noise. A narrower range widens evenly around its
     * middle, and the key prints the widened ends, so it never claims a
     * contrast the streets do not have.
     */
    minSpan?: number
  } = {},
): ViewRange | null {
  if (!data || !bounds) return null;
  const [w, s, e, n] = bounds;
  const minPasses = opts.minPasses ?? 0;
  const vals: number[] = [];
  for (const f of data.features) {
    const p = f.properties;
    if (p.value == null || !Number.isFinite(p.value) || (p.n_passes ?? 0) < minPasses) continue;
    const coords = f.geometry?.coordinates as [number, number][] | undefined;
    if (!coords?.some(([x, y]) => x >= w && x <= e && y >= s && y <= n)) continue;
    vals.push(p.value);
  }
  if (vals.length < MIN_STREETS_IN_VIEW) return null;
  let [lo, hi] = robustDomain(vals, { floorAtZero: false });
  const minSpan = opts.minSpan ?? 0;
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { lo, hi, min, max, n: vals.length };
}
