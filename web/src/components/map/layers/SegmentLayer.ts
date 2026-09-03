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

export interface SegmentLayerProps {
  id?: string;
  /** GeoJSON from `GET /segments`. */
  data: SegmentCollection | null | undefined;
  theme: Theme;
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
    id = 'segments', data, theme, metric = 'median', dualEncode = 'width',
    baseWidthM = 15, widthMinPixels = 1.6, widthMaxPixels = 15,
    casing = true, hoveredId, selectedId, minPasses = 0, measure,
    onHover, onClick, visible = true, opacity = 1, pickable = true,
  } = props;

  const features = data?.features ?? EMPTY;
  if (!features.length) return [];

  const scale = props.scale ?? makeColorScale(theme, { domain: segmentDomain(data) });
  const wantWidth = dualEncode === 'width' || dualEncode === 'both';
  const wantAlpha = dualEncode === 'opacity' || dualEncode === 'both';

  const getPath = (f: SegmentFeature) => f.geometry.coordinates as unknown as Position[];
  const thin = (p: SegmentProps) => p.n_passes < minPasses;

  const getWidth = (f: SegmentFeature) => {
    const p = f.properties;
    if (thin(p)) return baseWidthM * 0.45;
    return baseWidthM * (wantWidth ? persistenceWidth(p.persistence) : 1);
  };

  const getColor = (f: SegmentFeature) => {
    const p = f.properties;
    if (thin(p) || p.value === null) return theme.color('line-strong', 0.45);
    const a = wantAlpha ? persistenceAlpha(theme, p.persistence, 0.32) : 1;
    return scale.rgba(p.value, a);
  };

  const trigger = [
    scale.domain.join(','), scale.mode, scale.ramp, theme.ramp.join(','),
    dualEncode, metric, measure, minPasses, baseWidthM,
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

  const groups: SegmentFeature[][] = wantWidth
    ? Array.from({ length: RUNGS }, () => [])
    : [features];
  if (wantWidth) for (const f of features) groups[rungOf(f.properties)].push(f);

  // 1 ─ casing. Painted in the basemap's own background colour so it reads as a
  //     cut-out rather than an outline; this is what makes a 2px data line crisp
  //     over aerial-ish tiles at every zoom.
  if (casing) {
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
  const marked = features.filter(
    (f) => f.properties.id === hoveredId || f.properties.id === selectedId,
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
        : theme.color('accent', 0.5)),
      updateTriggers: {
        getWidth: [trigger, hoveredId, selectedId],
        getColor: [hoveredId, selectedId, theme.css('accent')],
      },
    }));
  }

  // 3 ─ the data. Low-persistence rungs first, so a street that is bad ALL the
  //     time is never hidden under one that spiked once.
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
