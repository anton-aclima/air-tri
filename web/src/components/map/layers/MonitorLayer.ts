/**
 * MonitorLayer — the regulator's towers.
 *
 * The regulator narrative is tower defence, so a stationary monitor is not a dot:
 * it is an *asset* with a footprint. Reference-grade instruments draw as masts
 * with a coverage ring and a slow radar sweep; low-cost fenceline sensors draw as
 * small pucks. Two orthogonal channels, so neither is colour-alone:
 *
 *   shape  = grade      (reference mast / FEM mast / low-cost puck)
 *   colour = owner_type (regulator / industry / community / aclima)
 *   ring   = radius_m coverage, sweeping when the instrument is online
 *   pulse  = an exceedance is live on this instrument
 */

import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { LayersList, PickingInfo } from 'deck.gl';
import type { MeasureCode, Monitor, Position } from '@/core/types';
import type { Theme } from '../../lib/theme';
import { circleRing } from '../../lib/geo';
import { icon, monitorGlyph } from '../../lib/glyphs';

export interface MonitorLayerProps {
  id?: string;
  data: Monitor[] | null | undefined;
  theme: Theme;
  /** 0–1 triangle wave — feed from `usePulse()`. Drives the exceedance pulse. */
  pulse?: number;
  /** Draw `radius_m` coverage rings. Default true. */
  rings?: boolean;
  /** Which measure's `latest.exceeds` decides the alarm state. */
  measure?: MeasureCode;
  /** Monitor code + latest value beside each mark. Default true. */
  labels?: boolean;
  /** Pixel size of the tower glyph at nominal zoom. */
  sizePx?: number;
  hoveredId?: string | null;
  selectedId?: string | null;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  visible?: boolean;
  pickable?: boolean;
}

function ownerToken(owner: string): string {
  switch (owner) {
    case 'regulator': return 'tower';
    case 'industry': return 'actor-industry';
    case 'community': return 'actor-community';
    default: return 'actor-aclima';
  }
}

export function monitorExceeds(m: Monitor, measure?: MeasureCode): boolean {
  const latest = m.latest ?? {};
  if (measure) return Boolean(latest[measure]?.exceeds);
  return Object.values(latest).some((l) => l?.exceeds);
}

export function MonitorLayer(props: MonitorLayerProps): LayersList {
  const {
    id = 'monitors', data, theme, pulse = 0, rings = true,
    measure, labels = true, sizePx = 34, hoveredId, selectedId,
    onHover, onClick, visible = true, pickable = true,
  } = props;

  const monitors = (data ?? []).filter((m) => Number.isFinite(m.lon) && Number.isFinite(m.lat));
  if (!monitors.length) return [];

  const layers: LayersList = [];
  const withRings = monitors.filter((m) => rings && (m.radius_m ?? 0) > 0);
  const dimFor = (m: Monitor) => (m.status === 'online' ? 1 : m.status === 'degraded' ? 0.62 : 0.34);

  // ── coverage discs ────────────────────────────────────────────────────────
  if (withRings.length) {
    layers.push(new ScatterplotLayer<Monitor>({
      id: `${id}-coverage-fill`,
      data: withRings,
      visible,
      pickable: false,
      radiusUnits: 'meters',
      stroked: false,
      filled: true,
      getPosition: (m) => [m.lon, m.lat] as unknown as [number, number],
      getRadius: (m) => m.radius_m ?? 0,
      getFillColor: (m) => theme.color(ownerToken(m.owner_type), 0.05 * dimFor(m)),
      updateTriggers: { getFillColor: [theme.css('tower'), measure] },
    }));

    // Two concentric rings — the outer at radius, the inner at 55%, so the
    // reader can judge distance inside the footprint, not just its edge.
    const ringData = withRings.flatMap((m) => [
      { m, path: circleRing([m.lon, m.lat], m.radius_m ?? 0, 72), major: true },
      { m, path: circleRing([m.lon, m.lat], (m.radius_m ?? 0) * 0.55, 56), major: false },
    ]);
    layers.push(new PathLayer<{ m: Monitor; path: Position[]; major: boolean }>({
      id: `${id}-coverage-rings`,
      data: ringData,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (d) => d.path as unknown as Position[],
      getWidth: (d) => (d.major ? 1.4 : 1),
      getColor: (d) => theme.color(ownerToken(d.m.owner_type), (d.major ? 0.42 : 0.2) * dimFor(d.m)),
      updateTriggers: { getColor: theme.css('tower') },
    }));
  }

  // ── exceedance pulse ──────────────────────────────────────────────────────
  const alarmed = monitors.filter((m) => monitorExceeds(m, measure));
  if (alarmed.length) {
    layers.push(new ScatterplotLayer<Monitor>({
      id: `${id}-alarm`,
      data: alarmed,
      visible,
      pickable: false,
      radiusUnits: 'pixels',
      stroked: true,
      filled: false,
      lineWidthUnits: 'pixels',
      getPosition: (m) => [m.lon, m.lat] as unknown as [number, number],
      getRadius: sizePx * (0.72 + pulse * 0.75),
      getLineWidth: 1.6 + (1 - pulse) * 1.4,
      getLineColor: theme.color('sev-critical', 0.28 + (1 - pulse) * 0.55),
      updateTriggers: { getRadius: pulse, getLineWidth: pulse, getLineColor: pulse },
    }));
  }

  // ── ground plate, so a mast reads as standing on the map ──────────────────
  layers.push(new ScatterplotLayer<Monitor>({
    id: `${id}-base`,
    data: monitors,
    visible,
    pickable,
    radiusUnits: 'pixels',
    radiusMinPixels: 4,
    stroked: true,
    filled: true,
    lineWidthUnits: 'pixels',
    getPosition: (m) => [m.lon, m.lat] as unknown as [number, number],
    getRadius: (m) => (m.id === selectedId ? 8 : m.id === hoveredId ? 7 : 5.5),
    getFillColor: (m) => theme.color('bg', 0.9 * dimFor(m)),
    getLineWidth: 1.6,
    getLineColor: (m) => theme.color(ownerToken(m.owner_type), dimFor(m)),
    onHover,
    onClick,
    updateTriggers: {
      getRadius: [hoveredId, selectedId],
      getLineColor: theme.css('tower'),
      getFillColor: theme.css('bg'),
    },
  }));

  // ── the instrument itself ─────────────────────────────────────────────────
  layers.push(new IconLayer<Monitor>({
    id: `${id}-glyph`,
    data: monitors,
    visible,
    pickable,
    sizeUnits: 'pixels',
    getPosition: (m) => [m.lon, m.lat] as unknown as [number, number],
    getIcon: (m) => icon(monitorGlyph(m.grade), 'bottom'),
    getSize: (m) => sizePx * (m.grade === 'lowcost' ? 0.55 : 1) * (m.id === selectedId ? 1.18 : 1),
    getColor: (m) => (monitorExceeds(m, measure)
      ? theme.color('sev-critical', dimFor(m))
      : theme.color(ownerToken(m.owner_type), dimFor(m))),
    onHover,
    onClick,
    updateTriggers: {
      getSize: [sizePx, selectedId],
      getColor: [measure, theme.css('tower'), theme.css('sev-critical')],
    },
  }));

  // ── labels ────────────────────────────────────────────────────────────────
  if (labels) {
    layers.push(new TextLayer<Monitor>({
      id: `${id}-label`,
      data: monitors,
      visible,
      pickable: false,
      getPosition: (m) => [m.lon, m.lat] as unknown as [number, number],
      getText: (m) => (m.code ?? m.name ?? '').toUpperCase(),
      getSize: 10,
      sizeUnits: 'pixels',
      getColor: (m) => theme.color('ink-2', dimFor(m)),
      getPixelOffset: [0, 12],
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'top',
      fontFamily: theme.css('font-mono') || 'monospace',
      fontWeight: 600,
      characterSet: 'auto',
      outlineWidth: 3,
      outlineColor: theme.color('bg', 0.9),
      fontSettings: { sdf: true },
      updateTriggers: { getColor: theme.css('ink-2'), outlineColor: theme.css('bg') },
    }));
  }

  return layers;
}
