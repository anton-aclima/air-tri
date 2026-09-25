/**
 * SegmentLayer — THE flagship Aclima visualisation.
 *
 * A ~200 m road segment is the atom of this product, so the map is a road grid,
 * not hexbins and not points. Each segment is painted by `value` through the
 * role's `--ramp-map-*` ramp, and — this is the part that makes it Aclima —
 * optionally *modulated by persistence*, so magnitude and persistence read at
 * the same time:
 *
 *   hue     = HOW MUCH  (median / p90 / max / risk)
 *   weight  = HOW OFTEN (share of passes over the reference level)
 *
 * A thick, saturated street is bad all the time. A thin, saturated street spiked
 * once. A thick, pale street is chronically a little dirty. Three different
 * stories, one glance. `MapLegend` documents exactly this key.
 *
 * Composition (bottom → top):
 *   1. casing   — a basemap-coloured halo that makes a 2px line crisp over any tile
 *   2. glow     — hover / selection ring
 *   3. grid     — the data
 *
 * `tone: 'context'` is a different, much quieter mark on the same streets: a
 * neutral hairline with no value, no casing and no picking, for "measured
 * earlier, not in the window shown". Build it as its own call, BELOW the
 * coloured window's call, so the window's casing cuts it where they overlap.
 */

import { PathLayer } from '@deck.gl/layers';
import type { LayersList, PickingInfo } from 'deck.gl';
import type { Position, SegmentCollection, SegmentMetric, SegmentProps } from '@/core/types';
import { INDEX_DOMAIN } from '@/core/measures';
import type { Theme } from '../../lib/theme';
import type { ColorScale } from '../../lib/scales';
import { makeColorScale, persistenceAlpha, persistenceWidth, robustDomain } from '../../lib/scales';

export type SegmentFeature = SegmentCollection['features'][number];
export type DualEncoding = 'width' | 'opacity' | 'both' | 'none';
/** `'ramp'` paints the value (the default); `'context'` is the quiet neutral grid. */
export type SegmentTone = 'ramp' | 'context';

export interface SegmentLayerProps {
  id?: string;
  /** GeoJSON from `GET /segments`. */
  data: SegmentCollection | null | undefined;
  theme: Theme;
  /**
   * `'ramp'` (default): every street painted by its value, as below.
   *
   * `'context'`: every street in `data` as one neutral hairline
   * (`CONTEXT_STROKE`) — no value colour, no casing, no persistence width, no
   * hover/selection/highlight ring, never pickable. For "measured earlier,
   * not in this window": the streets the fleet has driven to date, drawn
   * under a coloured window so a street driven last week reads as measured
   * ground rather than as a street nobody drove. It IS measurement (it only
   * ever carries streets with passes), so it is a solid line, never the
   * model's dash (§10b), and quiet so it never competes with a value.
   * `scale`, `metric`, `dualEncode`, `minPasses`, `fewPassesBelow`,
   * `hoveredId`, `selectedId`, `highlightIds`, `onHover` and `onClick` are
   * ignored in this tone; `id`, `visible` and `opacity` still apply.
   */
  tone?: SegmentTone;
  /** Colour scale. Omit and one is derived from the data with a p2–p98 domain. */
  scale?: ColorScale;
  /** Which number `value` holds — labels and unit handling only. */
  metric?: SegmentMetric;
  /** How persistence is expressed alongside magnitude. Default `'width'`. */
  dualEncode?: DualEncoding;
  /** Nominal road width in metres before persistence modulation. */
  baseWidthM?: number;
  /** Keeps the grid visible when zoomed out to the whole campaign. */
  widthMinPixels?: number;
  widthMaxPixels?: number;
  /** Basemap-coloured halo under every line. Makes the grid crisp. Default true. */
  casing?: boolean;
  hoveredId?: string | null;
  selectedId?: string | null;
  /** Segments below this pass count draw as "not enough data" rather than a value. */
  minPasses?: number;
  /**
   * Streets measured on fewer passes than this (and at least `minPasses`)
   * still draw their value, but THIN and without the persistence width —
   * a short street window's case (R4: a day, or the Network's 24 h / 7 d
   * windows). On a light skin they are also faint (72% alpha) and cased; on
   * a dark skin they draw at 90% with NO casing, see `FEW`.
   *
   * Measured (NO2, `date:2026-08-25`): 781 driven streets, 515 of them on
   * exactly two passes and only 4 on eight or more — the 90-day
   * `minPasses: 8` would grey out 777 of the day's 781, and hiding them would
   * erase the very streets the fleet drove under the hour's plume.
   * Persistence (share of passes over the reference level) on two passes
   * came back as ½, 1 or null and nothing else, so its width channel would be
   * noise; these streets draw at one fixed thin width instead (a null
   * persistence would otherwise land on the THICKEST rung, see `rungOf`).
   *
   * Thin, not hatched or dashed: CONTRACT §10b gives the dash to "beyond
   * measurement range — model only" and the dot to the filed study, and a
   * measured street must never borrow a model's stroke. Default 0 (off).
   */
  fewPassesBelow?: number;
  /**
   * Segments to ring with the soft selection halo, e.g. the streets inside a
   * selected monitor's coverage ring. Omit for none.
   */
  highlightIds?: readonly string[] | null;
  /**
   * The measure the values belong to. Nothing is drawn from it — it exists only
   * so that switching measures always invalidates deck's cached accessors. Two
   * measures can share a domain, a ramp and a metric (any two unitless 0-100
   * scores do), and without this the grid keeps the previous measure's colours.
   */
  measure?: string;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  visible?: boolean;
  opacity?: number;
  pickable?: boolean;
}

const EMPTY: SegmentFeature[] = [];

/**
 * How a few-pass street (`fewPassesBelow`) draws: 40% of the nominal road
 * width, under the thinnest persistence rung's pixel floor (0.7× against the
 * rung's 0.8×). Thin enough to read as "measured, lightly"; still the ramp
 * colour, because it IS a measurement. Checked on the regulator skin at the
 * default view: at a 0.6× floor (1.1 px) the day's two-pass streets blurred
 * into the basemap's own road lines.
 *
 * Alpha and casing depend on the skin's polarity, because on a dark ground
 * "faint" and "cased" both push a thin line toward the ground:
 *   - light skins: 72% alpha, cased — unchanged.
 *   - dark skins: 90% alpha and NO casing. A translucent stroke composites
 *     over whatever is under it, and the casing under it is --bg at 80%, so
 *     the casing darkened the stroke itself. Measured (gamma-space blend, the
 *     WebGL default): the old ramp's stop 0 at 72% over its casing came out
 *     1.07:1 against the regulator --bg, i.e. black. The lifted ramp's stop 0
 *     at 90% straight over the land (--map-urban) is 3.01–3.31:1 across the
 *     four dark skins; at 72% it would be 2.37–2.49.
 */
const FEW = { width: 0.4, floor: 0.7, alpha: 0.72, alphaDark: 0.9 } as const;

/** The alpha a few-pass street draws at on this skin. `MapLegend`'s swatch uses it. */
export function fewPassAlpha(theme: Theme): number {
  return theme.dark ? FEW.alphaDark : FEW.alpha;
}

/**
 * The `tone: 'context'` mark, exported so `MapLegend`'s swatch is the same
 * line. `--ink-3` at 50%, 1.25 px, whatever the zoom.
 *
 * Measured on the dark skins (`--ink-3` at 50% over `--map-urban`): 1.87–2.10:1
 * against --bg, and 1.74–1.87:1 against the basemap's own minor road it sits
 * on (1.54–1.65 on a major road) — so a street measured earlier is visibly a
 * different thing from a street never driven, which the basemap draws at
 * 1.21–1.29:1 (minor) and 1.65–1.84 (major). It stays under the lifted ramp's
 * stop 0 (3.66–3.88) and carries no hue, so it never reads as a low value.
 * At the 35% first proposed it was 1.48–1.67:1, under the basemap's major
 * roads: the quiet grid vanished into the streets it was meant to mark.
 */
export const CONTEXT_STROKE = { token: 'ink-3', alpha: 0.5, widthPx: 1.25 } as const;

/** Robust colour domain for a segment collection — p2..p98, floored at zero. */
export function segmentDomain(data: SegmentCollection | null | undefined): [number, number] {
  return robustDomain((data?.features ?? []).map((f) => f.properties.value));
}

/**
 * The colour domain for painting *this measure's* values.
 *
 * Concentrations get the robust p2–p98 stretch, because ppb, µg/m³ and ppm share
 * no scale and a fixed domain would be meaningless across them. An index does
 * not: it is already defined on 0–100, it means the same thing in every city,
 * and stretching it to whatever happens to be in view is the one thing that
 * would turn an honest, uniform map into a manufactured alarm. `aclima_sense`
 * spans roughly 25–32 across this whole campaign; auto-stretched, that seven
 * point spread paints full-scale red.
 *
 * The test is the unit rather than the family so it needs no type import and
 * says what it means: a measure with no unit is a score.
 *
 * See `INDEX_DOMAIN` for why an index is pinned to [0,60] rather than [0,100],
 * and why the community map is the one place that does not use this.
 */
export function measureDomain(
  measure: { unit: string } | null | undefined,
  data: SegmentCollection | null | undefined,
): [number, number] {
  return measure?.unit === '' ? INDEX_DOMAIN : segmentDomain(data);
}

/**
 * Build the layer stack for the road grid.
 * Not a React component — call it inside your `layers` array:
 *   `layers={[...SegmentLayer({ data, theme })]}`
 */
export function SegmentLayer(props: SegmentLayerProps): LayersList {
  const {
    id = 'segments', data, theme, tone = 'ramp', metric = 'median', dualEncode = 'width',
    baseWidthM = 15, widthMinPixels = 1.6, widthMaxPixels = 15,
    casing = true, hoveredId, selectedId, minPasses = 0, fewPassesBelow = 0, highlightIds, measure,
    onHover, onClick, visible = true, opacity = 1, pickable = true,
  } = props;

  const features = data?.features ?? EMPTY;
  if (!features.length) return [];

  const getPath = (f: SegmentFeature) => f.geometry.coordinates as unknown as Position[];

  if (tone === 'context') {
    // One flat layer: a fixed pixel hairline, so it reads the same at every
    // zoom and never swells into a road-width band that competes with a value.
    return [new PathLayer<SegmentFeature>({
      id: `${id}-context`,
      data: features,
      visible,
      opacity,
      pickable: false,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      getPath,
      getWidth: CONTEXT_STROKE.widthPx,
      getColor: theme.color(CONTEXT_STROKE.token, CONTEXT_STROKE.alpha),
      updateTriggers: { getColor: theme.css(CONTEXT_STROKE.token) },
    })];
  }

  const fewAlpha = fewPassAlpha(theme);
  const scale = props.scale ?? makeColorScale(theme, { domain: segmentDomain(data) });
  const wantWidth = dualEncode === 'width' || dualEncode === 'both';
  const wantAlpha = dualEncode === 'opacity' || dualEncode === 'both';

  const thin = (p: SegmentProps) => p.n_passes < minPasses;
  const few = (p: SegmentProps) => !thin(p) && p.value !== null && p.n_passes < fewPassesBelow;

  const getWidth = (f: SegmentFeature) => {
    const p = f.properties;
    if (thin(p)) return baseWidthM * 0.45;
    if (few(p)) return baseWidthM * FEW.width;
    return baseWidthM * (wantWidth ? persistenceWidth(p.persistence) : 1);
  };

  const getColor = (f: SegmentFeature) => {
    const p = f.properties;
    if (thin(p) || p.value === null) return theme.color('line-strong', 0.45);
    if (few(p)) return scale.rgba(p.value, fewAlpha);
    const a = wantAlpha ? persistenceAlpha(theme, p.persistence, 0.32) : 1;
    return scale.rgba(p.value, a);
  };

  const trigger = [
    scale.domain.join(','), scale.mode, scale.ramp, theme.ramp.join(','),
    dualEncode, metric, measure, minPasses, fewPassesBelow, fewAlpha, baseWidthM,
  ].join('|');

  const layers: LayersList = [];

  /**
   * The width channel has to survive the pixel floor.
   *
   * `widthMinPixels` is a layer-level prop, not an accessor, so at campaign zoom
   * (~20 m/px) a 15 m road clamps to the floor and EVERY segment draws the same
   * width — silently destroying the persistence encoding exactly where the map is
   * most used. The fix is to split the grid into persistence rungs and give each
   * rung its own floor. Colour still varies continuously across all of them.
   */
  const RUNGS = 3;
  const rungOf = (p: SegmentProps) => {
    const v = p.persistence;
    if (v === null || v === undefined || !Number.isFinite(v)) return RUNGS - 1;
    return Math.max(0, Math.min(RUNGS - 1, Math.floor(v * RUNGS)));
  };
  const FLOOR_SCALE = [0.8, 1.35, 2.15];

  // Few-pass streets are their own group, under every rung: a street driven
  // once must never be drawn over one driven twenty times.
  const fewGroup = fewPassesBelow > 0 ? features.filter((f) => few(f.properties)) : EMPTY;
  const rest = fewGroup.length ? features.filter((f) => !few(f.properties)) : features;

  const groups: SegmentFeature[][] = wantWidth
    ? Array.from({ length: RUNGS }, () => [])
    : [rest];
  if (wantWidth) for (const f of rest) groups[rungOf(f.properties)].push(f);
  const fewFloor = widthMinPixels * FEW.floor;

  // 1 ─ casing. Painted in the basemap's own background colour so it reads as a
  //     cut-out rather than an outline; this is what makes a 2px data line crisp
  //     over aerial-ish tiles at every zoom. Not under a few-pass street on a
  //     dark skin: that stroke is translucent, so a --bg casing under it
  //     darkens the stroke itself (see `FEW`). Opaque strokes keep theirs.
  if (casing) {
    if (fewGroup.length && !theme.dark) {
      layers.push(new PathLayer<SegmentFeature>({
        id: `${id}-casing-few`,
        data: fewGroup,
        visible,
        pickable: false,
        widthUnits: 'meters',
        widthMinPixels: fewFloor + 1.5,
        widthMaxPixels: widthMaxPixels + 6,
        capRounded: true,
        jointRounded: true,
        getPath,
        getWidth: (f: SegmentFeature) => getWidth(f) * 1.55,
        getColor: theme.color('bg', theme.dark ? 0.8 : 0.62),
        updateTriggers: { getWidth: trigger, getColor: theme.css('bg') },
      }));
    }
    groups.forEach((group, ri) => {
      if (!group.length) return;
      const floor = widthMinPixels * (wantWidth ? FLOOR_SCALE[ri] : 1);
      layers.push(new PathLayer<SegmentFeature>({
        id: `${id}-casing-${ri}`,
        data: group,
        visible,
        pickable: false,
        widthUnits: 'meters',
        widthMinPixels: floor + 1.5,
        widthMaxPixels: widthMaxPixels + 6,
        capRounded: true,
        jointRounded: true,
        getPath,
        getWidth: (f: SegmentFeature) => getWidth(f) * 1.55,
        getColor: theme.color('bg', theme.dark ? 0.8 : 0.62),
        updateTriggers: { getWidth: trigger, getColor: theme.css('bg') },
      }));
    });
  }

  // 2 ─ hover / selection ring, drawn under the data so it reads as a halo.
  const lit = highlightIds?.length ? new Set(highlightIds) : null;
  const litKey = lit ? [...lit].sort().join(',') : '';
  const marked = features.filter(
    (f) => f.properties.id === hoveredId || f.properties.id === selectedId || Boolean(lit?.has(f.properties.id)),
  );
  if (marked.length) {
    layers.push(new PathLayer<SegmentFeature>({
      id: `${id}-marked`,
      data: marked,
      visible,
      pickable: false,
      widthUnits: 'meters',
      widthMinPixels: widthMinPixels + 6,
      widthMaxPixels: widthMaxPixels + 16,
      capRounded: true,
      jointRounded: true,
      getPath,
      getWidth: (f: SegmentFeature) => getWidth(f) * (f.properties.id === selectedId ? 3.1 : 2.5),
      getColor: (f: SegmentFeature) => (f.properties.id === selectedId
        ? theme.color('accent', 0.95)
        : f.properties.id === hoveredId
          ? theme.color('accent', 0.5)
          // A highlighted SET is often a hundred streets: at the hover
          // strength the ring's streets read as one accent blob.
          : theme.color('accent', 0.34)),
      updateTriggers: {
        getWidth: [trigger, hoveredId, selectedId],
        getColor: [hoveredId, selectedId, litKey, theme.css('accent')],
      },
    }));
  }

  // 3 ─ the data. Few-pass streets first, then low-persistence rungs, so a
  //     street that is bad ALL the time is never hidden under one that spiked
  //     once, nor under one driven once.
  if (fewGroup.length) {
    layers.push(new PathLayer<SegmentFeature>({
      id: `${id}-grid-few`,
      data: fewGroup,
      visible,
      opacity,
      pickable,
      autoHighlight: false,
      widthUnits: 'meters',
      widthMinPixels: fewFloor,
      widthMaxPixels: Math.max(fewFloor, widthMaxPixels * FEW.width),
      capRounded: true,
      jointRounded: true,
      getPath,
      getWidth,
      getColor,
      onHover,
      onClick,
      updateTriggers: { getColor: trigger, getWidth: trigger },
    }));
  }
  groups.forEach((group, ri) => {
    if (!group.length) return;
    const floor = widthMinPixels * (wantWidth ? FLOOR_SCALE[ri] : 1);
    layers.push(new PathLayer<SegmentFeature>({
      id: `${id}-grid-${ri}`,
      data: group,
      visible,
      opacity,
      pickable,
      autoHighlight: false,
      widthUnits: 'meters',
      widthMinPixels: floor,
      widthMaxPixels,
      capRounded: true,
      jointRounded: true,
      getPath,
      getWidth,
      getColor,
      onHover,
      onClick,
      updateTriggers: { getColor: trigger, getWidth: trigger },
    }));
  });

  return layers;
}

/** Rows for `MapTooltip` / `SegmentInspector`, in a fixed order. */
export function segmentTooltipRows(
  p: SegmentProps,
  opts: { unit?: string; decimals?: number; metric?: SegmentMetric } = {},
): { label: string; value: string }[] {
  const { unit = '', decimals = 1 } = opts;
  const f = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(decimals));
  const u = unit ? ` ${unit}` : '';
  return [
    { label: 'Median', value: `${f(p.median)}${u}` },
    { label: 'P90', value: `${f(p.p90)}${u}` },
    { label: 'Max', value: `${f(p.max)}${u}` },
    { label: 'Persistence', value: p.persistence === null ? '—' : `${Math.round(p.persistence * 100)}%` },
    { label: 'Risk', value: p.risk === null ? '—' : String(Math.round(p.risk)) },
    { label: 'Passes', value: String(p.n_passes) },
  ];
}

/** Highlight one segment on its own — used when the grid itself is hidden. */
export function SegmentHighlightLayer(opts: {
  id?: string;
  path: Position[] | null | undefined;
  theme: Theme;
  widthM?: number;
}): LayersList {
  const { id = 'segment-highlight', path, theme, widthM = 22 } = opts;
  if (!path?.length) return [];
  const data = [{ path }];
  return [
    new PathLayer<{ path: Position[] }>({
      id: `${id}-halo`,
      data,
      widthUnits: 'meters',
      widthMinPixels: 8,
      capRounded: true,
      jointRounded: true,
      getPath: (d) => d.path,
      getWidth: widthM * 2.2,
      getColor: theme.color('accent', 0.28),
    }),
    new PathLayer<{ path: Position[] }>({
      id: `${id}-core`,
      data,
      widthUnits: 'meters',
      widthMinPixels: 3,
      capRounded: true,
      jointRounded: true,
      getPath: (d) => d.path,
      getWidth: widthM,
      getColor: theme.color('accent', 1),
    }),
  ];
}
