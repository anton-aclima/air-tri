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
 * HOW THE SOFTNESS IS MADE, AND WHY NOT WITH A HEATMAP
 * -----------------------------------------------------
 * The first version fed `HeatmapLayer` a point per ring VERTEX plus the ring's
 * centroid. That draws the outline, not the shape: the vertices trace the edge
 * of an acute wedge and the centroid is one dot in the middle of an otherwise
 * empty plume. It also re-aggregated on every frame, because the map
 * re-renders on the fleet pulse and the layer handed it a fresh array each
 * time — a density estimator running continuously over a thousand points.
 *
 * So: fill each band as a polygon, at an alpha stepping down from the source
 * outward, plus a few halo rings past the last band to feather the boundary
 * away. Eighteen polygons, no aggregation, no per-frame work.
 *
 * Note the bands TILE the plume along its axis — they are disjoint downwind
 * ranges, not nested contours (`dispersion.bands` returns `x_onset->x1`,
 * `x1->x2`, `x2->x_reach`). An earlier draft assumed they nested and expected
 * overlapping fills to build the gradient for free; they do not overlap at
 * all, so each band carries its own alpha and the gradient is the sequence.
 *
 * Three rules, each with a reason:
 *
 *  1. **No outline, ever.** Not a style preference. See above.
 *  2. **`level` is discarded at this boundary** — see `bandAlpha`. It is a
 *     modelled contour label, and putting it on a resident's screen would
 *     assert a measured concentration at their address. CONTRACT §10a rule 1.
 *  3. **The alpha is very low, at every zoom.** It guards one failure: three
 *     sites merging into an "everywhere is affected" wash, which is a
 *     different and much worse claim than any of them makes alone. Each site
 *     contributes six shells, so where three plumes overlap the alpha
 *     compounds to 1-(1-a)^n; at 0.18 the left half of the map went solid.
 *     The per-shell peak is 0.075 because it is chosen for what three
 *     overlapping plumes look like, not one.
 *
 *     There used to be a zoom cutoff too (nothing below z11.5). It was a
 *     guard for the old HeatmapLayer, whose radius was in PIXELS, and it was
 *     kept after the switch as a "second guard". It guarded nothing: these
 *     polygons are in METRES, so zooming out makes the cloud a smaller share
 *     of the frame (~4% at z10.8 against ~40% at z12.4), and the share of the
 *     neighbourhood it covers is the same at every zoom. All the cutoff did
 *     was make the cloud vanish when you zoomed out, which read as a bug.
 */

import { PolygonLayer } from '@deck.gl/layers';
import type { LayersList } from 'deck.gl';
import type { DispersionPlume, Position } from '@/core/types';
import type { Theme } from '../../lib/theme';

export interface SoftPlumeLayerProps {
  id?: string;
  /** GeoJSON from `GET /wind/dispersion`. */
  data: DispersionPlume | null | undefined;
  theme: Theme;
  visible?: boolean;
  /** Peak alpha where all bands overlap. Low: this is a guess, not a finding. */
  intensity?: number;
}

type PlumeFeature = DispersionPlume['features'][number];

/** How many haloes past the outermost band, and how far each steps out. */
const HALOES = 3;
const HALO_STEP = 0.07;

/**
 * Alpha for one band. Band INDEX only — never `level`.
 *
 * `level` is a modelled contour value. Mapping it to opacity would put a
 * fabricated concentration on a resident's screen as a visual quantity, which
 * is the same claim as printing it. The discard lives here rather than in the
 * screen because a screen can be rewritten by someone who has not read
 * CONTRACT §10a.
 */
function bandAlpha(band: number, bands: number, intensity: number): number {
  const t = 1 - band / Math.max(1, bands);
  return 0.075 * intensity * (0.45 + 0.55 * t);
}

function ringOf(f: PlumeFeature): Position[] {
  return f.geometry.coordinates[0] as unknown as Position[];
}

function centroidOf(ring: Position[]): Position {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

/** Push every vertex away from `origin` by `k`, for the feathered haloes. */
function expandRing(ring: Position[], origin: Position, k: number): Position[] {
  return ring.map(([x, y]) => [
    origin[0] + (x - origin[0]) * k,
    origin[1] + (y - origin[1]) * k,
  ] as Position);
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

export function softShells(features: PlumeFeature[], intensity: number): Shell[] {
  const hit = SHELL_CACHE.get(features);
  if (hit && hit.intensity === intensity) return hit.shells;
  const shells = buildShells(features, intensity);
  SHELL_CACHE.set(features, { intensity, shells });
  return shells;
}

/** Outermost first, so later draws land on top and the overlaps build density. */
function buildShells(features: PlumeFeature[], intensity: number): Shell[] {
  const bySite = new Map<string, PlumeFeature[]>();
  for (const f of features) {
    const key = f.properties.site_id ?? '?';
    const list = bySite.get(key);
    if (list) list.push(f);
    else bySite.set(key, [f]);
  }

  const shells: Shell[] = [];
  for (const group of bySite.values()) {
    const bands = Math.max(...group.map((f) => f.properties.band ?? 0)) + 1;
    const sorted = [...group].sort((a, b) => (b.properties.band ?? 0) - (a.properties.band ?? 0));
    const outer = sorted[0];
    if (!outer) continue;

    // Haloes first and faintest — they are the part that says "no edge".
    //
    // Scaled about the OUTER BAND'S OWN centroid, so the feather grows around
    // it on every side. Scaling about the source instead — which reads as the
    // natural origin — pushes the halo further downwind rather than outward,
    // and leaves the plume's flanks as hard as they started.
    const outerRing = ringOf(outer);
    const origin = centroidOf(outerRing);
    for (let i = HALOES; i >= 1; i -= 1) {
      shells.push({
        ring: expandRing(outerRing, origin, 1 + HALO_STEP * i),
        alpha: bandAlpha(bands - 1, bands, intensity) * (0.55 / i),
      });
    }
    for (const f of sorted) {
      shells.push({ ring: ringOf(f), alpha: bandAlpha(f.properties.band ?? 0, bands, intensity) });
    }
  }
  return shells;
}

export function SoftPlumeLayer(props: SoftPlumeLayerProps): LayersList {
  const {
    id = 'soft-plume', data, theme, visible = true, intensity = 1,
  } = props;

  const features = data?.features ?? [];
  if (!features.length || !visible) return [];

  const shells = softShells(features, intensity);
  if (!shells.length) return [];

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
      getFillColor: (d) => theme.rampColor(0.55, d.alpha, 'intensity'),
      updateTriggers: { getFillColor: [theme.intensity.join(','), intensity] },
    }),
  ];
}
