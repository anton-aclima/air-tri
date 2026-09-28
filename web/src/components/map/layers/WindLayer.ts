/**
 * DispersionLayer — the modelled plume on the map, in one of two registers.
 *
 * NOTE: the *wind* visual is no longer a deck.gl layer. Particle advection needs
 * frame-to-frame canvas history (the trail is the decay of previous frames), which
 * deck.gl's declarative redraw cannot express. See
 * `components/wind/WindFieldCanvas.tsx` and `components/wind/MapWindField.tsx` —
 * drop `<MapWindField>` into `<BaseMap fullBleed={…}>`.
 *
 * `style: 'fill'` (the default, and what every caller got before PLAN-refocus
 * F6) is the consultant-style contour: banded filled polygons inside the
 * detection envelope, a dashed unfilled outline past it. The gallery draws it.
 *
 * `style: 'outline'` is CONTRACT §10b as written for Aclima's model: one
 * hairline around the whole plume, solid to the detection envelope and dashed
 * past it, a centreline axis with a reach tick, and NO FILL anywhere. It reads
 * the `kind` features that `GET /wind/dispersion?outline=1` adds and ignores
 * the bands. Without them it draws nothing rather than falling back to a fill:
 * a screen that asked for the model register must never get the measured one.
 *
 * `FiledStudyLayer`, the third register (the operator's filed permit study), is
 * here too, so the one rule that separates it from "beyond measurement range"
 * — a different dash on a different token — lives in one file.
 */

import { PathStyleExtension } from '@deck.gl/extensions';
import type { PathStyleExtensionProps } from '@deck.gl/extensions';
import { IconLayer, PathLayer, PolygonLayer, TextLayer } from '@deck.gl/layers';
import type { LayersList, PickingInfo } from 'deck.gl';
import type {
  DispersionAxisFeature, DispersionAxisProps, DispersionBandFeature, DispersionFeature,
  DispersionModel, DispersionOutlineFeature, DispersionOutlineProps, DispersionPlume,
  DispersionPlumeOutlined, Position,
} from '@/core/types';
import type { Theme } from '../../lib/theme';
import {
  alongPath, bearingBetween, haversine, lerpPosition, pathMetrics, splitPathAt, toPolygons,
} from '../../lib/geo';
import { icon } from '../../lib/glyphs';
import { PLUME_STROKE } from '../../lib/vizmeta';

/**
 * The legend line that MUST accompany any band drawn past the detection
 * envelope. CONTRACT §10b — exported so the four screens print the same
 * sentence rather than four paraphrases that drift.
 */
export const BEYOND_ENVELOPE_NOTE = 'beyond measurement range — model only';

// ───────────────────────────────────────────── the `?outline=1` features
//
// The shapes are core's (`DispersionPlumeOutlined` and friends in
// `@/core/types`); these aliases are the names this layer's API speaks in.
// Server contract (PLAN-refocus Phase 3, "plume outline"): the band features
// are unchanged and come first, and each site gains an `outline` (part
// `inside`, and `beyond` when the reach passes the envelope) and an `axis`,
// told apart by `properties.kind`.

export type PlumeBandFeature = DispersionBandFeature;
export type PlumeOutlineFeature = DispersionOutlineFeature;
export type PlumeAxisFeature = DispersionAxisFeature;
export type PlumeFeatureAny = DispersionFeature;
export type PlumeOutlineProps = DispersionOutlineProps;
export type PlumeAxisProps = DispersionAxisProps;
export type { DispersionPlumeOutlined };

/** Either response shape: `DispersionPlume` is assignable to the outlined one. */
export type DispersionData = DispersionPlume | DispersionPlumeOutlined;

// Local rather than core/api's `isBandFeature` & co.: the layer library reads
// types from core, never the fetch module. `kind == null` for the same reason
// core's guard uses it — a band has no `kind`, and JSON can hand back `null`.
function isBand(f: PlumeFeatureAny): f is PlumeBandFeature {
  return f.properties.kind == null;
}

function isOutline(f: PlumeFeatureAny): f is PlumeOutlineFeature {
  return f.properties.kind === 'outline';
}

function isAxis(f: PlumeFeatureAny): f is PlumeAxisFeature {
  return f.properties.kind === 'axis';
}

function featuresOf(data: DispersionData | null | undefined): PlumeFeatureAny[] {
  return (data?.features ?? []) as PlumeFeatureAny[];
}

// ─────────────────────────────────────────────────────────────── props

export interface DispersionLayerProps {
  id?: string;
  /** GeoJSON from `GET /wind/dispersion` (`?outline=1` for style 'outline'). */
  data: DispersionData | null | undefined;
  theme: Theme;
  /**
   * `'fill'` (default): banded filled contours inside the envelope, dashed past
   * it. `'outline'`: CONTRACT §10b's model register, from the `kind` features
   * only — hairline outline, axis, reach tick, never a fill.
   */
  style?: 'fill' | 'outline';
  /** Fill style: bands per plume, used to normalise alpha. Auto-detected when omitted. */
  bandCount?: number;
  /** Fill style: outline each band's edge. Default true. */
  outline?: boolean;
  /** Fill style: peak fill alpha. */
  maxOpacity?: number;
  /**
   * Outline style: sites whose plume draws MUTED — the outline only, at
   * `MUTED_PLUME` of its strength, with no axis, reach tick or "truncated".
   * The regulator Network (R2) gives an axis only to a plume that touches a
   * monitor, a street driven that day or an open cluster: three full
   * outline-plus-axis sets at once are the busy map the owner objected to
   * (under stable air all three reach 8 km at the same hour). The register
   * is kept — solid inside, dashed beyond — only its weight drops. Omit for
   * every site at full strength, as before.
   */
  mutedSiteIds?: readonly string[] | null;
  visible?: boolean;
  /**
   * Outline style: the solid outline and axis pick (the dashed part never
   * does — see below). `info.object.properties` is the feature's properties.
   */
  pickable?: boolean;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
}

/**
 * Does this plume have anything drawn past the detection envelope? Screens
 * call it to decide whether to print `BEYOND_ENVELOPE_NOTE`; the dashed
 * geometry alone is not a caption. True of either response shape.
 */
export function hasBeyondEnvelope(data: DispersionData | null | undefined): boolean {
  return featuresOf(data).some((f) => (isBand(f)
    ? Boolean(f.properties.beyond_envelope)
    : isOutline(f) && f.properties.part === 'beyond'));
}

export function DispersionLayer(props: DispersionLayerProps): LayersList {
  return props.style === 'outline' ? outlineLayers(props) : fillLayers(props);
}

// ─────────────────────────────────────────────────────── style: 'fill'

interface BandSplit { inside: PlumeBandFeature[]; beyond: PlumeBandFeature[]; bands: number }

/**
 * Memoised on the features array, for the reason `softShells` gives: a screen
 * with a pulsing layer rebuilds its layer list every animation frame, deck
 * diffs `data` by reference, and a fresh `filter()` each frame is a re-upload
 * and re-tessellation sixty times a second of a shape that changes hourly.
 */
const BAND_CACHE = new WeakMap<object, BandSplit>();

function splitBands(features: PlumeFeatureAny[]): BandSplit {
  const hit = BAND_CACHE.get(features);
  if (hit) return hit;
  // Only the bands. An `?outline=1` payload also carries an axis, whose
  // coordinates are a LineString — read as a polygon ring it is garbage.
  const bands = features.filter(isBand);
  const split: BandSplit = {
    inside: bands.filter((f) => !f.properties.beyond_envelope),
    beyond: bands.filter((f) => f.properties.beyond_envelope),
    bands: bands.length ? Math.max(...bands.map((f) => f.properties.band ?? 0)) + 1 : 0,
  };
  BAND_CACHE.set(features, split);
  return split;
}

/**
 * Plume cones. Each `band` is a concentration contour, so the fill is stepped
 * through the intensity ramp and the alpha falls off outward — the shape of a
 * plume, not a flat cone.
 */
function fillLayers(props: DispersionLayerProps): LayersList {
  const {
    id = 'dispersion', data, theme, bandCount, outline = true,
    maxOpacity = 0.5, visible = true, pickable = false,
  } = props;

  const features = featuresOf(data);
  if (!features.length) return [];
  const { inside, beyond, bands: detected } = splitBands(features);
  if (!inside.length && !beyond.length) return [];

  const bands = bandCount ?? detected;
  const norm = (f: PlumeBandFeature) => 1 - (f.properties.band ?? 0) / Math.max(1, bands);
  const ring = (f: PlumeBandFeature) => f.geometry.coordinates[0] as unknown as Position[];

  // CONTRACT §10b, the register split. Inside the detection envelope a band is
  // a filled contour; past it there is nothing to compare the model against,
  // so it is drawn as a dashed outline with NO FILL and the screen prints
  // `BEYOND_ENVELOPE_NOTE`.
  //
  // This is not decoration. Under stable air the kernel's plume reaches across
  // the whole monitored area — a 10 km cone from Ridgeline covers 96.7% of the
  // road grid — and without a visible change of register every
  // model-versus-measurement picture becomes a picture of the campaign
  // boundary, with the modelled layer reading as the measured one because it
  // is the bigger and smoother of the two.
  const layers: LayersList = [];

  if (inside.length) {
    layers.push(new PolygonLayer<PlumeBandFeature>({
      id: `${id}-fill`,
      data: inside,
      visible,
      pickable,
      stroked: false,
      filled: true,
      getPolygon: ring,
      getFillColor: (f) => theme.rampColor(0.35 + norm(f) * 0.6, Math.pow(norm(f), 1.4) * maxOpacity, 'intensity'),
      updateTriggers: { getFillColor: [theme.intensity.join(','), maxOpacity, bands] },
    }));
  }

  if (outline && inside.length) {
    layers.push(new PathLayer<PlumeBandFeature>({
      id: `${id}-edge`,
      data: inside,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      getPath: ring,
      getWidth: 1,
      getColor: (f) => theme.rampColor(0.45 + norm(f) * 0.5, 0.42 * norm(f) + 0.14, 'intensity'),
      updateTriggers: { getColor: theme.intensity.join(',') },
    }));
  }

  if (beyond.length) {
    layers.push(new PathLayer<PlumeBandFeature, PathStyleExtensionProps<PlumeBandFeature>>({
      id: `${id}-model-only`,
      data: beyond,
      visible,
      // Not pickable: a dashed outline is a statement that we do not know, and
      // there is nothing to inspect behind it.
      pickable: false,
      widthUnits: 'pixels',
      getPath: ring,
      getWidth: 1.25,
      getColor: (f) => theme.rampColor(0.5 + norm(f) * 0.4, 0.5, 'intensity'),
      // Screen-space dashes, so the pattern reads the same at every zoom —
      // a metre-based dash turns solid when you zoom out, which is exactly
      // when the distinction matters most.
      getDashArray: [6, 4],
      dashJustified: true,
      dashGapPickable: false,
      extensions: [new PathStyleExtension({ dash: true, highPrecisionDash: true })],
      updateTriggers: { getColor: theme.intensity.join(',') },
    }));
  }

  return layers;
}

// ──────────────────────────────────────────────────── style: 'outline'

/** One stretch of outline between envelope cuts — a whole closed ring when there is no cut. */
export interface PlumeOutlineRun {
  path: Position[];
  part: 'inside' | 'beyond';
  properties: PlumeOutlineProps;
}

export interface PlumeAxisRun {
  path: Position[];
  part: 'inside' | 'beyond';
  properties: PlumeAxisProps;
}

/** A point on the axis with the axis heading there (compass degrees). */
export interface PlumeAxisMark {
  position: Position;
  heading: number;
  properties: PlumeAxisProps;
}

export interface PlumeOutlineGeometry {
  runs: PlumeOutlineRun[];
  axes: PlumeAxisRun[];
  /** Where the axis meets the envelope — or its end, when the plume stops short of it. */
  ticks: PlumeAxisMark[];
  /** The far end of a truncated axis, where "truncated" is printed. */
  ends: PlumeAxisMark[];
}

/**
 * Metres along the transport axis from its origin, for any vertex.
 *
 * Polar, on the same sphere the server places vertices on (`geo.destination`,
 * R = 6,371,008.8 m), so a vertex placed `envelope_m` down the axis reads back
 * as `envelope_m`. A flat metres-per-degree frame was the obvious spelling and
 * is 0.6% short north-south — 24 m at a 4 km envelope, which is more than the
 * whole tolerance below.
 */
function alongAxis(origin: Position, axisDeg: number): (p: Position) => number {
  return (p) => {
    const d = haversine(origin, p);
    if (d === 0) return 0;
    return d * Math.cos(((bearingBetween(origin, p) - axisDeg) * Math.PI) / 180);
  };
}

/**
 * Clip a ring to one side of the envelope line — the line across the axis
 * `envelope` metres from its origin — and mark which of the resulting
 * vertices lie ON that line.
 *
 * WHY THE CLIENT CLIPS. `inside` and `beyond` are meant to be one outline cut
 * in two at the envelope. As served they are built per emission point (each
 * source's own span ends at the envelope), and Ridgeline's sources are spread
 * a few hundred metres along the axis, so the two parts OVERLAP: measured on
 * the checked-in data, `inside` runs to 137 m past the envelope and `beyond`
 * starts 210 m before it, each ending in a staircase of per-source steps.
 * Drawn as given, that is a 350 m zone where a solid staircase and a dashed
 * one cross — and a solid line past the envelope is exactly what CONTRACT
 * §10b forbids. Clipping both at the same line the axis's tick sits on puts
 * the change of register in one place. It moves no plume edge the server
 * drew inside its own part; when the parts arrive already split at that line
 * it is a no-op.
 *
 * Sutherland–Hodgman against one line. `eps` absorbs the 5-decimal
 * coordinate rounding (under a metre along the axis), and the intersection is
 * taken at the same `envelope ± eps` the side test uses, so it always lands
 * on the segment.
 */
function clipAtEnvelope(
  ring: Position[], along: number[], envelope: number, keep: 'near' | 'far', eps: number,
): { pts: Position[]; onCut: boolean[] } {
  const thr = keep === 'near' ? envelope + eps : envelope - eps;
  const kept = (a: number) => (keep === 'near' ? a <= thr : a >= thr);
  const pts: Position[] = [];
  const onCut: boolean[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    const cur = kept(along[i]);
    if (cur !== kept(along[j])) {
      pts.push(lerpPosition(ring[j], ring[i], (thr - along[j]) / (along[i] - along[j])));
      onCut.push(true);
    }
    if (cur) {
      pts.push(ring[i]);
      onCut.push(Math.abs(along[i] - envelope) <= eps);
    }
  }
  return { pts, onCut };
}

/** Split a ring into the open runs left once its cut edges are removed. */
function openRuns(ring: Position[], cut: boolean[]): Position[][] {
  const n = ring.length;
  const first = cut.indexOf(true);
  if (first < 0) return [[...ring, ring[0]]];
  const runs: Position[][] = [];
  let cur: Position[] = [];
  // Start just past a cut so the ring's seam never splits a run in two.
  for (let s = 1; s <= n; s++) {
    const j = (first + s) % n;
    if (cut[j]) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
      continue;
    }
    if (!cur.length) cur.push(ring[j]);
    cur.push(ring[(j + 1) % n]);
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/** A GeoJSON ring without its closing duplicate vertex. */
function openRing(ring: Position[]): Position[] {
  if (ring.length > 1) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring;
}

const OUTLINE_CACHE = new WeakMap<object, PlumeOutlineGeometry>();

/**
 * The outline style's drawable geometry, from an `?outline=1` payload.
 * Exported so a screen can read where the tick fell or whether the axis was
 * truncated without re-deriving it. Memoised on the features array.
 */
export function plumeOutlineGeometry(data: DispersionData | null | undefined): PlumeOutlineGeometry {
  const features = featuresOf(data);
  const hit = OUTLINE_CACHE.get(features);
  if (hit) return hit;

  const outlines = features.filter(isOutline);
  const axesIn = features.filter(isAxis);
  const out: PlumeOutlineGeometry = { runs: [], axes: [], ticks: [], ends: [] };

  const sites = new Set([...outlines, ...axesIn].map((f) => f.properties.site_id));
  for (const site of sites) {
    const parts = outlines.filter((f) => f.properties.site_id === site);
    const axis = axesIn.find((f) => f.properties.site_id === site);
    const split = parts.some((f) => f.properties.part === 'beyond')
      && parts.some((f) => f.properties.part === 'inside');

    // Where the register changes: the axis's own origin and envelope, so the
    // outline's cut and the reach tick are one line, not two.
    const origin = axis?.geometry.coordinates[0];
    const envelope = axis ? (axis.properties.envelope_m ?? axis.properties.detection_envelope_m) : NaN;
    const clip = axis && origin && split && Number.isFinite(envelope)
      ? alongAxis(origin, (axis.properties.wind_dir_deg + 180) % 360)
      : null;

    for (const f of parts) {
      const p = f.properties;
      for (const poly of toPolygons(f.geometry)) {
        for (const raw of poly) {
          const ring = openRing(raw);
          if (ring.length < 3) continue;
          if (!clip) {
            // One part only: its ends are the plume's own onset and reach,
            // real edges, drawn closed.
            out.runs.push({ path: [...ring, ring[0]], part: p.part, properties: p });
            continue;
          }
          // Both parts: each is cut at the envelope, and the cut itself is
          // dropped. Drawn, it would be a bar across the plume — solid, with a
          // dashed one on top — reading as "the plume ends here", which is the
          // one thing the model does not say. The reach tick marks it instead.
          const { pts, onCut } = clipAtEnvelope(
            ring, ring.map(clip), envelope, p.part === 'inside' ? 'near' : 'far', 1.5,
          );
          if (pts.length < 2) continue;
          const cut = pts.map((_, k) => onCut[k] && onCut[(k + 1) % pts.length]);
          for (const path of openRuns(pts, cut)) out.runs.push({ path, part: p.part, properties: p });
        }
      }
    }

    if (axis && axis.geometry.coordinates.length >= 2) {
      const p = axis.properties;
      const path = axis.geometry.coordinates;
      const { total } = pathMetrics(path);
      if (total > 0) {
        // One metre of slack: a reach that equals the envelope to the rounding
        // is a plume that stops at it, and a zero-length dashed stub would
        // otherwise hang off the end.
        if (Number.isFinite(envelope) && envelope < total - 1) {
          const [solid, dashed] = splitPathAt(path, envelope);
          if (solid.length >= 2) out.axes.push({ path: solid, part: 'inside', properties: p });
          if (dashed.length >= 2) out.axes.push({ path: dashed, part: 'beyond', properties: p });
          const m = alongPath(path, envelope / total);
          out.ticks.push({ position: m.position, heading: m.heading, properties: p });
        } else {
          // The whole plume is inside measurement range: the tick marks its
          // reach, which is the §10b "reach tick" in its plainest form.
          out.axes.push({ path, part: 'inside', properties: p });
          const m = alongPath(path, 1);
          out.ticks.push({ position: m.position, heading: m.heading, properties: p });
        }
        if (p.truncated) {
          const m = alongPath(path, 1);
          out.ends.push({ position: m.position, heading: m.heading, properties: p });
        }
      }
    }
  }

  OUTLINE_CACHE.set(features, out);
  return out;
}

/** Deck's dash accessor wants a mutable pair; the spec table is frozen. */
function dashOf(reg: { dash: readonly [number, number] | null }): [number, number] {
  return reg.dash ? [reg.dash[0], reg.dash[1]] : [0, 0];
}

/**
 * How far a `mutedSiteIds` plume steps back: its outline at 40% of the
 * register's alpha (0.36 inside, 0.28 beyond, against the axis's 0.38), so a
 * muted outline sits under every lit plume's axis and still reads as a shape.
 */
export const MUTED_PLUME = 0.4;

function outlineLayers(props: DispersionLayerProps): LayersList {
  const {
    id = 'dispersion', data, theme, visible = true, pickable = false, onHover, onClick, mutedSiteIds,
  } = props;
  const g0 = plumeOutlineGeometry(data);
  if (!g0.runs.length && !g0.axes.length) return [];

  const { model, beyond, axis } = PLUME_STROKE;
  const color = (reg: { token: string; alpha: number }) => theme.color(reg.token, reg.alpha);
  const dashed = [new PathStyleExtension({ dash: true, highPrecisionDash: true })];
  const layers: LayersList = [];

  // Muting filters a COPY: the geometry is memoised on the payload and shared
  // with every screen that reads it.
  const muted = mutedSiteIds?.length ? new Set(mutedSiteIds) : null;
  const isMuted = (p: { site_id: string }) => Boolean(muted?.has(p.site_id));
  const mutedKey = muted ? [...muted].sort().join(',') : '';
  const g: PlumeOutlineGeometry = muted
    ? {
      runs: g0.runs,
      axes: g0.axes.filter((r) => !isMuted(r.properties)),
      ticks: g0.ticks.filter((m) => !isMuted(m.properties)),
      ends: g0.ends.filter((m) => !isMuted(m.properties)),
    }
    : g0;
  const runColor = (reg: { token: string; alpha: number }) => (r: PlumeOutlineRun) => theme.color(
    reg.token, reg.alpha * (isMuted(r.properties) ? MUTED_PLUME : 1),
  );
  const trigger = [theme.css(model.token), mutedKey].join('|');

  const insideRuns = g.runs.filter((r) => r.part === 'inside');
  const beyondRuns = g.runs.filter((r) => r.part === 'beyond');
  const insideAxis = g.axes.filter((r) => r.part === 'inside');
  const beyondAxis = g.axes.filter((r) => r.part === 'beyond');

  if (insideRuns.length) {
    layers.push(new PathLayer<PlumeOutlineRun>({
      id: `${id}-outline`,
      data: insideRuns,
      visible,
      pickable,
      onHover,
      onClick,
      widthUnits: 'pixels',
      getPath: (r) => r.path,
      getWidth: model.width,
      getColor: muted ? runColor(model) : color(model),
      updateTriggers: { getColor: trigger },
    }));
  }

  if (beyondRuns.length) {
    layers.push(new PathLayer<PlumeOutlineRun, PathStyleExtensionProps<PlumeOutlineRun>>({
      id: `${id}-outline-beyond`,
      data: beyondRuns,
      visible,
      // Never pickable, as in the fill style: the dashed part says we do not
      // know, and there is nothing to inspect behind it.
      pickable: false,
      widthUnits: 'pixels',
      getPath: (r) => r.path,
      getWidth: beyond.width,
      getColor: muted ? runColor(beyond) : color(beyond),
      // Screen-space (multiples of the pixel width), so the dash reads the
      // same at every zoom — a metre-based dash turns solid zoomed out, which
      // is exactly when the distinction matters most.
      getDashArray: dashOf(beyond),
      dashJustified: true,
      dashGapPickable: false,
      extensions: dashed,
      updateTriggers: { getColor: trigger },
    }));
  }

  if (insideAxis.length) {
    layers.push(new PathLayer<PlumeAxisRun>({
      id: `${id}-axis`,
      data: insideAxis,
      visible,
      pickable,
      onHover,
      onClick,
      widthUnits: 'pixels',
      getPath: (r) => r.path,
      getWidth: axis.width,
      getColor: color(axis),
      updateTriggers: { getColor: trigger },
    }));
  }

  if (beyondAxis.length) {
    layers.push(new PathLayer<PlumeAxisRun, PathStyleExtensionProps<PlumeAxisRun>>({
      id: `${id}-axis-beyond`,
      data: beyondAxis,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (r) => r.path,
      getWidth: axis.width,
      // Past the envelope the axis steps down by the same ratio the outline
      // does and takes the same dash: one register, one mark, whether it is
      // the edge or the centreline.
      getColor: color({ token: axis.token, alpha: axis.alpha * (beyond.alpha / model.alpha) }),
      getDashArray: dashOf(beyond),
      dashJustified: true,
      dashGapPickable: false,
      extensions: dashed,
      updateTriggers: { getColor: trigger },
    }));
  }

  if (g.ticks.length) {
    // Pixel-sized, so the tick stays a tick at every zoom; a metre-sized one
    // vanishes zoomed out and swallows the plume zoomed in.
    layers.push(new IconLayer<PlumeAxisMark>({
      id: `${id}-reach-tick`,
      data: g.ticks,
      visible,
      pickable: false,
      sizeUnits: 'pixels',
      getPosition: (m) => m.position as unknown as [number, number],
      getIcon: () => icon('tick'),
      getSize: 13,
      // The stencil is an east-west bar; turned by the axis heading it lies
      // across the axis. deck.gl angles run counter-clockwise, bearings
      // clockwise.
      getAngle: (m) => -m.heading,
      getColor: color(model),
      updateTriggers: { getColor: trigger },
    }));
  }

  if (g.ends.length) {
    layers.push(new TextLayer<PlumeAxisMark>({
      id: `${id}-truncated`,
      data: g.ends,
      visible,
      pickable: false,
      getPosition: (m) => m.position as unknown as [number, number],
      // The kernel stops at 8,000 m; the plume does not. Printed where the
      // line stops so nobody reads the end of the drawing as the end of the air.
      getText: () => 'truncated',
      getSize: theme.labelPx(10),
      sizeUnits: 'pixels',
      getColor: theme.color('ink-2', 0.95),
      // Just past the end, on the side the axis is heading.
      getPixelOffset: (m) => {
        const r = (m.heading * Math.PI) / 180;
        return [Math.sin(r) * 6, -Math.cos(r) * 6];
      },
      getTextAnchor: (m) => {
        const x = Math.sin((m.heading * Math.PI) / 180);
        return x > 0.35 ? 'start' : x < -0.35 ? 'end' : 'middle';
      },
      getAlignmentBaseline: (m) => {
        const y = Math.cos((m.heading * Math.PI) / 180);
        return y > 0.35 ? 'bottom' : y < -0.35 ? 'top' : 'center';
      },
      fontFamily: theme.css('font-mono') || 'monospace',
      fontWeight: 500,
      characterSet: 'auto',
      outlineWidth: 3,
      outlineColor: theme.color('bg', 0.9),
      fontSettings: { sdf: true },
      updateTriggers: { getColor: theme.css('ink-2'), outlineColor: theme.css('bg') },
    }));
  }

  return layers;
}

// ────────────────────────────────────────────── the filed permit study

export interface FiledStudyLayerProps {
  id?: string;
  /** `DispersionModel.contours`, verbatim — the study as the operator filed it. */
  contours: DispersionModel['contours'] | null | undefined;
  theme: Theme;
  /**
   * `'outer'` (default): only the outermost band, the study's own footprint
   * edge (PLAN-refocus I7). `'all'`: every band, the outer one heavier.
   */
  bands?: 'outer' | 'all';
  visible?: boolean;
}

interface StudyRing { path: Position[]; outer: boolean }

/** Planar shoelace area in square degrees — only ever compared, never shown. */
function ringArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}

const STUDY_CACHE = new WeakMap<object, { bands: 'outer' | 'all'; rings: StudyRing[] }>();

/**
 * The filed permit study: dotted, `accent-2`, NO FILL (CONTRACT §10b).
 *
 * Its dot and token are `PLUME_STROKE.filed` — deliberately neither the
 * `beyond` dash nor its ink, because both are "an outline with no fill" and
 * with the comparison switched on they have to be told apart before any label
 * is read. The outline it replaces had a 0.05 fill and a solid line; the fill
 * was faint, but it was a fill, and a filed study is not a measurement.
 *
 * The OUTERMOST band is found by area, not by index or level. The served
 * Ridgeline study numbers outward (band 0 is the 42-unit contour, ~1.1 km
 * across; band 3 the 11-unit one, ~2.4 km) and the gallery fixture numbers
 * inward, so either rule on the numbers is wrong for one of them; the ring
 * that encloses the rest is the largest whichever way it was numbered.
 */
export function FiledStudyLayer(props: FiledStudyLayerProps): LayersList {
  const { id = 'filed-study', contours, theme, bands = 'outer', visible = true } = props;
  if (!contours?.length) return [];

  let rings: StudyRing[];
  const hit = STUDY_CACHE.get(contours);
  if (hit && hit.bands === bands) {
    rings = hit.rings;
  } else {
    const areas = contours.map((c) => toPolygons(c.geometry)
      .reduce((sum, poly) => sum + (poly[0] ? ringArea(poly[0]) : 0), 0));
    const top = areas.indexOf(Math.max(...areas));
    rings = [];
    contours.forEach((c, i) => {
      if (bands === 'outer' && i !== top) return;
      for (const poly of toPolygons(c.geometry)) {
        for (const r of poly) rings.push({ path: r, outer: i === top });
      }
    });
    STUDY_CACHE.set(contours, { bands, rings });
  }
  if (!rings.length) return [];

  const { filed } = PLUME_STROKE;
  return [
    new PathLayer<StudyRing, PathStyleExtensionProps<StudyRing>>({
      id,
      data: rings,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (r) => r.path,
      getWidth: (r) => (r.outer ? filed.width : filed.width * 0.7),
      getColor: (r) => theme.color(filed.token, r.outer ? filed.alpha : filed.alpha * 0.55),
      getDashArray: dashOf(filed),
      dashJustified: true,
      dashGapPickable: false,
      extensions: [new PathStyleExtension({ dash: true, highPrecisionDash: true })],
      updateTriggers: { getColor: theme.css(filed.token) },
    }),
  ];
}
