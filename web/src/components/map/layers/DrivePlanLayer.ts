/**
 * DrivePlanLayer — the admin drafting table.
 *
 * Two modes over the same plan, because the admin is answering two different
 * questions:
 *
 *   'routes'   — WHO drives WHERE. One fixed categorical hue per vehicle, never
 *                cycled, never reassigned when a route is filtered out.
 *   'coverage' — is the plan GOOD ENOUGH. Segments coloured by passes ÷ target,
 *                on one sequential ramp, with everything below target visibly
 *                hot. This is the number the whole tool exists to move.
 */

import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { LayersList, PickingInfo } from 'deck.gl';
import type { CoverageCell, DriveRoute, Position, SegmentCollection } from '@/core/types';
import type { RGBA, Theme } from '../../lib/theme';
import { parseColor, withAlpha } from '../../lib/theme';
import { makeColorScale } from '../../lib/scales';

export type DrivePlanMode = 'routes' | 'coverage';

export interface DrivePlanLayerProps {
  id?: string;
  mode?: DrivePlanMode;
  /** `DrivePlan.routes` — used in 'routes' mode. */
  routes?: DriveRoute[] | null | undefined;
  /** `GET /drive-plan/{id}/coverage` — used in 'coverage' mode. */
  coverage?: CoverageCell[] | null | undefined;
  /** Segment geometry, so coverage can be drawn on the real streets. */
  segments?: SegmentCollection | null | undefined;
  theme: Theme;
  /** Only these vehicles / day indices. Colour never changes when filtered. */
  vehicleIds?: string[] | null;
  dayIndex?: number | null;
  /** Route direction arrows every N vertices. 0 disables. */
  arrowEvery?: number;
  /** Start-of-route markers with the shift label. Default true in routes mode. */
  endpoints?: boolean;
  target?: number;
  hoveredId?: string | null;
  selectedId?: string | null;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  visible?: boolean;
  pickable?: boolean;
}

/**
 * Stable vehicle → hue. Keyed on the sorted vehicle-id list of the *whole plan*
 * so filtering to one vehicle never repaints the survivors.
 */
export function vehicleColorIndex(routes: DriveRoute[] | null | undefined): Map<string, number> {
  const ids = Array.from(new Set((routes ?? []).map((r) => r.vehicle_id ?? '—'))).sort();
  return new Map(ids.map((id, i) => [id, i]));
}

export function DrivePlanLayer(props: DrivePlanLayerProps): LayersList {
  const {
    id = 'drive-plan', mode = 'routes', routes, coverage, segments, theme,
    vehicleIds, dayIndex, arrowEvery = 0, endpoints = true, target,
    hoveredId, selectedId, onHover, onClick, visible = true, pickable = true,
  } = props;

  if (mode === 'coverage') {
    return coverageLayers({ id, coverage, segments, theme, target, onHover, onClick, visible, pickable, hoveredId, selectedId });
  }

  const all = routes ?? [];
  const hues = vehicleColorIndex(all);
  const shown = all.filter((r) => {
    if (vehicleIds && vehicleIds.length && !vehicleIds.includes(r.vehicle_id ?? '')) return false;
    if (dayIndex !== null && dayIndex !== undefined && r.day_index !== dayIndex) return false;
    return r.geometry?.length > 1;
  });
  if (!shown.length) return [];

  const hueOf = (r: DriveRoute) => {
    const i = hues.get(r.vehicle_id ?? '—') ?? 0;
    return theme.categorical[i % Math.max(1, theme.categorical.length)] ?? theme.css('accent');
  };
  // `theme.categorical` already holds RESOLVED colour strings pulled from
  // `--mod-*`, so parse them straight to RGBA rather than re-looking-up a token.
  const colorOf = (r: DriveRoute, alpha: number): RGBA =>
    withAlpha(parseColor(hueOf(r)), alpha);

  const layers: LayersList = [
    // casing, so overlapping routes stay countable
    new PathLayer<DriveRoute>({
      id: `${id}-casing`,
      data: shown,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      widthMinPixels: 3,
      capRounded: true,
      jointRounded: true,
      getPath: (r) => r.geometry as unknown as Position[],
      getWidth: 5.5,
      getColor: theme.color('bg', 0.75),
      updateTriggers: { getColor: theme.css('bg') },
    }),
    new PathLayer<DriveRoute>({
      id: `${id}-routes`,
      data: shown,
      visible,
      pickable,
      widthUnits: 'pixels',
      widthMinPixels: 1.6,
      capRounded: true,
      jointRounded: true,
      getPath: (r) => r.geometry as unknown as Position[],
      getWidth: (r) => (r.id === selectedId ? 4 : r.id === hoveredId ? 3.2 : 2.2),
      getColor: (r) => colorOf(r, r.id === selectedId || r.id === hoveredId ? 1 : 0.82),
      onHover,
      onClick,
      updateTriggers: {
        getWidth: [hoveredId, selectedId],
        getColor: [hoveredId, selectedId, theme.categorical.join(',')],
      },
    }),
  ];

  if (arrowEvery > 0) {
    type Tick = { r: DriveRoute; position: Position; angle: number };
    const ticks: Tick[] = [];
    for (const r of shown) {
      const g = r.geometry;
      for (let i = arrowEvery; i < g.length - 1; i += arrowEvery) {
        const a = g[i - 1];
        const b = g[i];
        ticks.push({
          r,
          position: g[i],
          angle: -(Math.atan2(b[0] - a[0], b[1] - a[1]) * (180 / Math.PI)),
        });
      }
    }
    if (ticks.length) {
      layers.push(new TextLayer<Tick>({
        id: `${id}-arrows`,
        data: ticks,
        visible,
        pickable: false,
        getPosition: (d) => d.position as unknown as [number, number],
        getText: () => '▲',
        getSize: 9,
        sizeUnits: 'pixels',
        getAngle: (d) => d.angle,
        getColor: (d) => colorOf(d.r, 0.9),
        characterSet: 'auto',
        fontSettings: { sdf: true },
        updateTriggers: { getColor: theme.categorical.join(',') },
      }));
    }
  }

  if (endpoints) {
    layers.push(new ScatterplotLayer<DriveRoute>({
      id: `${id}-start`,
      data: shown,
      visible,
      pickable,
      radiusUnits: 'pixels',
      stroked: true,
      filled: true,
      lineWidthUnits: 'pixels',
      getPosition: (r) => r.geometry[0] as unknown as [number, number],
      getRadius: 4.5,
      getFillColor: theme.color('bg', 0.95),
      getLineWidth: 2,
      getLineColor: (r) => colorOf(r, 1),
      onHover,
      onClick,
      updateTriggers: { getLineColor: theme.categorical.join(',') },
    }));
  }

  return layers;
}

function coverageLayers(o: {
  id: string;
  coverage: CoverageCell[] | null | undefined;
  segments: SegmentCollection | null | undefined;
  theme: Theme;
  target?: number;
  hoveredId?: string | null;
  selectedId?: string | null;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  visible: boolean;
  pickable: boolean;
}): LayersList {
  const { id, coverage, segments, theme, target, onHover, onClick, visible, pickable, hoveredId, selectedId } = o;
  const cells = coverage ?? [];
  const feats = segments?.features ?? [];
  if (!cells.length || !feats.length) return [];

  const byId = new Map(cells.map((c) => [c.segment_id, c]));
  const rows = feats
    .map((f) => ({ f, c: byId.get(f.properties.id) }))
    .filter((r): r is { f: typeof feats[number]; c: CoverageCell } => Boolean(r.c));
  if (!rows.length) return [];

  // 0 → 1.2× target, so "at target" sits at ~0.83 of the ramp and over-covered
  // segments are visibly *past* the goal rather than clamped at the top.
  const scale = makeColorScale(theme, { domain: [0, 1.2], ramp: 'intensity' });
  const pctOf = (c: CoverageCell) => {
    const t = target ?? c.target ?? 1;
    return t > 0 ? c.passes / t : 0;
  };

  type Row = { f: typeof feats[number]; c: CoverageCell };
  return [
    new PathLayer<Row>({
      id: `${id}-coverage-casing`,
      data: rows,
      visible,
      pickable: false,
      widthUnits: 'meters',
      widthMinPixels: 3,
      widthMaxPixels: 20,
      capRounded: true,
      jointRounded: true,
      getPath: (r) => r.f.geometry.coordinates as unknown as Position[],
      getWidth: 26,
      getColor: theme.color('bg', 0.8),
      updateTriggers: { getColor: theme.css('bg') },
    }),
    new PathLayer<Row>({
      id: `${id}-coverage`,
      data: rows,
      visible,
      pickable,
      widthUnits: 'meters',
      widthMinPixels: 2,
      widthMaxPixels: 16,
      capRounded: true,
      jointRounded: true,
      getPath: (r) => r.f.geometry.coordinates as unknown as Position[],
      // under-covered draws THICKER: the gap is what the admin is hunting for
      getWidth: (r) => 16 * (pctOf(r.c) < 1 ? 1.35 : 0.85),
      getColor: (r) => scale.rgba(pctOf(r.c), pctOf(r.c) < 1 ? 1 : 0.72),
      onHover,
      onClick,
      updateTriggers: {
        getColor: [theme.intensity.join(','), target],
        getWidth: [target, hoveredId, selectedId],
      },
    }),
  ];
}
