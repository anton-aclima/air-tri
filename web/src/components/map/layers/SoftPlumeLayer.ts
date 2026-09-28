/**
 * SoftPlumeLayer — the plume as a cloud with no edge, for residents.
 *
 * THE COMMUNITY RENDERER, and deliberately not `DispersionLayer`. That one
 * draws banded contours with an outline, which is right for an operator
 * reading a model and wrong for a resident reading their street: a contour has
 * an inside and an outside, and the outside is a line somebody can screenshot
 * into a house listing.
 *
 * A blur has neither. That is the whole epistemic point — the model does not
 * know where the air stops, so the drawing must not claim to either.
 *
 * WHAT IT DRAWS: ONLY THE MEASUREMENT RANGE (PLAN-refocus C2 / D4)
 * ----------------------------------------------------------------
 * The cloud is the `kind: 'outline'`, `part: 'inside'` polygon from
 * `GET /wind/dispersion?outline=1` — the plume's outer edge from its onset out
 * to the detection envelope, cut straight across the axis there — filled with
 * four nested shells that fade from the source to nothing at that cut.
 * Nothing is drawn past the envelope, at any zoom, in any mode.
 *
 * The earlier version filled the BANDS, which run to the kernel's reach —
 * 8 km on a typical neutral hour, against an envelope of 1.5 km (4 km only in
 * stable air, classes E/F). CONTRACT §10b and the 4,200 m rule forbid drawing
 * a filled model past the range anything was measured in, and on the
 * resident's map there is no dashed register to fall back to (that would be a
 * boundary). So the far field is gone rather than restyled. Clipping the bands
 * in the browser was tried on paper and rejected: the payload carries no site
 * centre to clip from, the bands overlapped at their seams (~1–1.5 km, the
 * darkest spots on the old cloud, alpha 0.148), and the halos stacked over the
 * last band would still have stacked after a clip. The server's outline has
 * one ring, one cut, and the axis origin it was built from, so none of that
 * survives into this layer.
 *
 * A payload WITHOUT outline features (bands only — an old server, or a caller
 * that forgot `outline: true`) draws NOTHING. Falling back to the bands would
 * silently put the 8 km fill back on the map.
 *
 * HOW THE FADE IS MADE
 * --------------------
 * Four shells, outermost first. The outer one IS the served ring. Each inner
 * one is built from the ring in the plume's own frame (origin = the axis's
 * first vertex, the emission-weighted source; x along the transport
 * direction, y across it), station by station:
 *
 *   - it runs from the ring's upwind end (its onset) for a share of the ring's
 *     length, and ends in a rounded nose, so the far ends step back from the
 *     envelope and none of them is a straight line across the plume;
 *   - at every station it is the ring's OWN cross-section there, shrunk toward
 *     its own middle, so the FLANKS fade as well as the far end.
 *
 * Both are what keep every shell inside the ring — past the envelope and past
 * the flanks alike — by construction rather than by a property of the shape.
 * Two cheaper constructions were measured on this campaign's payloads and
 * rejected:
 *
 *   - a uniform scale about the source. A plume widens roughly in proportion
 *     to distance, so a wedge scaled about its apex is the same wedge,
 *     shorter: every shell shares the flanks, and the flanks carry the full
 *     stacked alpha as a hard edge. (The halo code this replaces found the
 *     same thing from the other side.)
 *   - an affine shrink toward the onset (along) and the axis (across). Exact
 *     along the axis, but near the fence the ring is a sliver shaped by
 *     release points joining one after another, and the shrink dragged wider
 *     parts of the ring into it: inner shells stood up to 77 m outside the
 *     outer one, on all three sites, in stable and neutral hours.
 *
 * Where all four overlap (near the source, on the centreline) the cloud is
 * darkest; toward the envelope and the flanks fewer shells overlap, and the
 * outermost shell is 0.4% and stops short of the envelope — there is no step
 * to nothing at the cut, because nothing reaches it.
 *
 * Three rules, each with a reason:
 *
 *  1. **No outline, ever.** Not a style preference. See above. `stroked:
 *     false` below is the rule, and the inner shells end in rounded noses
 *     rather than straight cuts, which would read as lines across the plume.
 *  2. **`level` is never read.** It is a modelled contour label, and putting
 *     it on a resident's screen would assert a measured concentration at
 *     their address. CONTRACT §10a rule 1. The outline carries no `level` at
 *     all, and the alpha comes from the shell's index alone — the discard
 *     lives here rather than in the screen because a screen can be rewritten
 *     by someone who has not read §10a.
 *  3. **The alpha is very low, at every zoom.** It guards one failure: three
 *     sites merging into an "everywhere is affected" wash, which is a
 *     different and much worse claim than any of them makes alone. Where
 *     plumes overlap the alpha compounds to 1-(1-a)^n; at 0.18 per shell the
 *     left half of the map went solid. Per shell it is 0.01–0.10, so one
 *     site's core — all ten shells — peaks near 0.43, and two sites' far
 *     fields crossing, a few faint outer shells each, stay near 0.11. Too
 *     faint fails too: a cloud nobody can see fails the resident as surely as
 *     a wash does. At 0.004–0.040 (core ~0.20) the owner found it "too
 *     transparent, very hard to see" (2026-09-28), so the shells were raised
 *     2.5× with the shape unchanged; the cloud still sits under the streets,
 *     so it never tints a measurement.
 *
 *     There used to be a zoom cutoff too (nothing below z11.5). It was a
 *     guard for the old HeatmapLayer, whose radius was in PIXELS, and it was
 *     kept after the switch as a "second guard". It guarded nothing: these
 *     polygons are in METRES, so zooming out makes the cloud a smaller share
 *     of the frame (~4% at z10.8 against ~40% at z12.4), and the share of the
 *     neighbourhood it covers is the same at every zoom. All the cutoff did
 *     was make the cloud vanish when you zoomed out, which read as a bug.
 *
 * The colour is `--plume-soft`, a warm neutral of its own (PLAN-refocus C7).
 * It used to be the analysis intensity ramp at 0.55 (≈#B74082), which sits
 * next to the resident's "very unhealthy" purple on the AQI ramp — a guess
 * painted in the colour of a health finding.
 */

import { PolygonLayer } from '@deck.gl/layers';
import type { LayersList } from 'deck.gl';
import type {
  DispersionAxisFeature, DispersionFeature, DispersionOutlineFeature, DispersionPlume,
  DispersionPlumeOutlined, Position,
} from '@/core/types';
import type { Theme } from '../../lib/theme';

export interface SoftPlumeLayerProps {
  id?: string;
  /**
   * GeoJSON from `GET /wind/dispersion?outline=1` —
   * `useDispersion({ …, outline: true })`. Only the `kind: 'outline'`,
   * `part: 'inside'` polygons (and each site's `axis`, for its origin) are
   * read; a bands-only payload draws nothing.
   */
  data: DispersionPlume | DispersionPlumeOutlined | null | undefined;
  theme: Theme;
  visible?: boolean;
  /** Multiplies every shell's alpha. Low: this is a guess, not a finding. */
  intensity?: number;
}

/**
 * The shells, outermost first. NONE is the served ring itself.
 *
 * The first cut drew four shells with the ring as the outermost, at a flat
 * 2.4% (3.8% on the community map): a review sampled the pixels and found the
 * cloud stopping in a straight line exactly at the envelope, with hard flanks
 * tracing the model outline — the edge the caveat beneath says does not
 * exist. Now there are ten, every one a rounded inner shell, the outermost at
 * 0.4% and short of the cut, so the cloud dissolves before the envelope
 * instead of ending at it, and each step is too small to read as a line.
 *
 * `along`: the share of the ring's length the shell runs, from the onset.
 * `across`: the share of the ring's own cross-section it keeps at each
 * station. Across shrinks a little harder than along, so the flanks fade at
 * least as fast as the far end. `alpha` is per shell, before `intensity`, and
 * rises inward so the steps get smaller toward the edge, where a step would
 * read as a line.
 */
const SHELLS = [
  { along: 0.97, across: 0.95, alpha: 0.01 },
  { along: 0.9, across: 0.86, alpha: 0.02 },
  { along: 0.82, across: 0.77, alpha: 0.03 },
  { along: 0.73, across: 0.68, alpha: 0.04 },
  { along: 0.64, across: 0.58, alpha: 0.05 },
  { along: 0.55, across: 0.49, alpha: 0.06 },
  { along: 0.46, across: 0.4, alpha: 0.07 },
  { along: 0.37, across: 0.31, alpha: 0.08 },
  { along: 0.28, across: 0.22, alpha: 0.09 },
  { along: 0.19, across: 0.14, alpha: 0.1 },
] as const;

/** Metres per degree of latitude. An equirectangular plane about the source
 *  is well under 0.1% off at 4 km — far below a pixel at any zoom this map
 *  reaches — and the outer shell is the served ring itself, untouched. */
const M_PER_DEG = 111_320;

// Local rather than core/api's `isOutlineFeature` & co.: the layer library
// reads types from core, never the fetch module (the same choice WindLayer
// makes).
function isInside(f: DispersionFeature): f is DispersionOutlineFeature {
  return f.properties.kind === 'outline' && f.properties.part === 'inside';
}

function isAxis(f: DispersionFeature): f is DispersionAxisFeature {
  return f.properties.kind === 'axis';
}

/** Share of each inner shell's length given to its rounded nose. */
const NOSE = 0.3;
/** Extra stations across the nose, so the curve is a curve at any zoom. */
const NOSE_STEPS = 10;

type XY = readonly [number, number];

/**
 * The plume's own frame: x metres along the transport bearing (`towardDeg`,
 * `wind_dir_deg + 180`, the bearing the server built the ring on), y metres
 * to its right, about `origin` (the axis's first vertex).
 */
function plumeFrame(origin: Position, towardDeg: number) {
  const kx = M_PER_DEG * Math.cos((origin[1] * Math.PI) / 180);
  const ky = M_PER_DEG;
  const t = (towardDeg * Math.PI) / 180;
  const s = Math.sin(t);
  const c = Math.cos(t);
  return {
    into([lon, lat]: Position): XY {
      const e = (lon - origin[0]) * kx;
      const n = (lat - origin[1]) * ky;
      return [e * s + n * c, e * c - n * s];
    },
    out([x, y]: XY): Position {
      return [origin[0] + (x * s + y * c) / kx, origin[1] + (x * c - y * s) / ky];
    },
  };
}

/**
 * The ring's cross-section at station `x`: the lowest and highest y where a
 * line across the axis meets it. The server's ring is one pair of rails from
 * onset to far end, so this is a single interval wherever it exists.
 */
function crossSection(ring: readonly XY[], x: number): XY | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 1; i < ring.length; i += 1) {
    const [xa, ya] = ring[i - 1];
    const [xb, yb] = ring[i];
    if ((x < xa && x < xb) || (x > xa && x > xb) || xa === xb) continue;
    const y = ya + ((yb - ya) * (x - xa)) / (xb - xa);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * One inner shell, in the plume frame: the ring's own cross-section at each
 * station, shrunk by `across` toward its middle, from the onset for `along`
 * of the ring's length, with an elliptical nose over the last `NOSE` of it.
 *
 * Stations are the ring's own vertex stations (the cross-section is linear
 * between them, so nothing between two stations can cut a corner outside the
 * ring — that is where a release point joins and the ring steps out), plus a
 * few across the nose.
 */
function innerShell(ring: readonly XY[], along: number, across: number): XY[] {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const [x] of ring) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
  }
  const end = x0 + (x1 - x0) * along;
  const noseAt = end - (end - x0) * NOSE;
  // Just inside both ends: at the extremes the cross-section is one vertex.
  const eps = Math.min(0.5, (end - x0) / 1000);
  const stations = new Set<number>([x0 + eps, end - eps]);
  for (const [x] of ring) if (x > x0 + eps && x < end - eps) stations.add(x);
  for (let i = 1; i < NOSE_STEPS; i += 1) stations.add(noseAt + ((end - noseAt) * i) / NOSE_STEPS);

  const left: XY[] = [];
  const right: XY[] = [];
  for (const x of [...stations].sort((a, b) => a - b)) {
    const cs = crossSection(ring, x);
    if (!cs) continue;
    const u = x > noseAt ? (x - noseAt) / (end - noseAt) : 0;
    const k = across * Math.sqrt(Math.max(0, 1 - u * u));
    const mid = (cs[0] + cs[1]) / 2;
    const half = ((cs[1] - cs[0]) / 2) * k;
    left.push([x, mid - half]);
    right.push([x, mid + half]);
  }
  if (left.length < 2) return [];
  const out = [...left, ...right.reverse()];
  out.push(out[0]);
  return out;
}

interface Shell {
  ring: Position[];
  alpha: number;
}

/**
 * Memoised on the features array's identity.
 *
 * NOT an optimisation, a correctness-of-cost fix. `usePhase` calls `setPhase`
 * inside a `requestAnimationFrame` loop, so any screen with a pulsing layer
 * re-renders at 60 fps and rebuilds its entire layer list every frame. deck
 * diffs `data` BY REFERENCE, so a freshly-built array each frame means a
 * re-upload and a re-tessellation sixty times a second for a shape that
 * changes once an hour.
 *
 * A `WeakMap` on the payload rather than a `useMemo` at the call site: every
 * consumer of this layer has the same problem, and one of them will forget.
 * react-query hands back a stable `data` reference between refetches, so the
 * key is stable for exactly as long as the answer is.
 */
const SHELL_CACHE = new WeakMap<object, { intensity: number; shells: Shell[] }>();

export function softShells(features: DispersionFeature[], intensity: number): Shell[] {
  const hit = SHELL_CACHE.get(features);
  if (hit && hit.intensity === intensity) return hit.shells;
  const shells = buildShells(features, intensity);
  SHELL_CACHE.set(features, { intensity, shells });
  return shells;
}

function buildShells(features: DispersionFeature[], intensity: number): Shell[] {
  // Filtered here rather than by the caller, so the cache above stays keyed
  // on the payload itself. The bands are skipped on purpose — see the header.
  const origins = new Map<string, Position>();
  for (const f of features) {
    if (!isAxis(f)) continue;
    const first = f.geometry.coordinates[0];
    if (first) origins.set(f.properties.site_id, first);
  }

  const perSite: Position[][][] = [];
  for (const f of features) {
    if (!isInside(f)) continue;
    const ring = f.geometry.coordinates[0];
    // The server emits the axis with the outline, from the same origin. A
    // site without one has no frame to shrink in, and the only thing left to
    // draw would be the ring flat — a filled shape with a hard edge. Nothing
    // is the honest fallback.
    const origin = origins.get(f.properties.site_id);
    if (!ring || ring.length < 4 || !origin) continue;
    const frame = plumeFrame(origin, (f.properties.wind_dir_deg + 180) % 360);
    const local = ring.map(frame.into);
    perSite.push(SHELLS.map((sh) => innerShell(local, sh.along, sh.across).map(frame.out)));
  }

  // Order does not matter: every shell is the same colour, and "over" of one
  // colour at alphas a and b is 1-(1-a)(1-b) whichever lands first.
  return perSite.flatMap((rings) => rings.flatMap((ring, i) => (ring.length < 4
    ? []
    : [{ ring, alpha: SHELLS[i].alpha * intensity }])));
}

export function SoftPlumeLayer(props: SoftPlumeLayerProps): LayersList {
  const {
    id = 'soft-plume', data, theme, visible = true, intensity = 1,
  } = props;

  const features = (data?.features ?? []) as DispersionFeature[];
  if (!features.length || !visible) return [];

  const shells = softShells(features, intensity);
  if (!shells.length) return [];

  const plume = theme.css('plume-soft');
  return [
    new PolygonLayer<Shell>({
      id: `${id}-cloud`,
      data: shells,
      // `stroked: false` is the rule, not a default. A one-pixel outline here
      // would undo the entire point of this layer.
      stroked: false,
      filled: true,
      pickable: false,
      getPolygon: (d) => d.ring,
      getFillColor: (d) => theme.color('plume-soft', d.alpha),
      updateTriggers: { getFillColor: [plume, intensity] },
    }),
  ];
}
