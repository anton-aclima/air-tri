/**
 * ConcernLayer — what residents reported, and where three of them agreed.
 *
 * Individual concerns are glyph marks (shape = kind, so kind is never
 * colour-alone) sized by the resident's own 1–5 severity. Clusters — the thing
 * that fires cross-role loop #1 — draw as a labelled halo at `radius_m`, which
 * is how "≥3 concerns within 600 m / 24 h" becomes something you can see.
 *
 * Colour carries *what happened to the report*, so the same mark tells a
 * community reader "someone is looking at this":
 *   community hue → new / corroborated        (nobody has responded yet)
 *   industry hue  → mitigation_proposed       (an operator answered)
 *   regulator hue → under_review              (the agency picked it up)
 *   ok            → resolved / closed
 */

import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { LayersList, PickingInfo } from 'deck.gl';
import type { Concern, ConcernCluster, Position } from '@/core/types';
import type { Theme } from '../../lib/theme';
import { circleRing } from '../../lib/geo';
import { concernGlyph, icon } from '../../lib/glyphs';

export interface ConcernLayerProps {
  id?: string;
  data: Concern[] | null | undefined;
  clusters?: ConcernCluster[] | null | undefined;
  theme: Theme;
  /** 0–1 pulse for clusters that are still forming. Feed from `usePulse()`. */
  pulse?: number;
  /** Corroboration count inside each cluster halo. Default true. */
  labels?: boolean;
  hoveredId?: string | null;
  selectedId?: string | null;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  onClusterClick?: (info: PickingInfo) => void;
  visible?: boolean;
  pickable?: boolean;
}

export function concernStatusToken(status: string): string {
  switch (status) {
    case 'mitigation_proposed': return 'actor-industry';
    case 'under_review': return 'actor-regulator';
    case 'resolved':
    case 'closed': return 'sev-ok';
    default: return 'actor-community';
  }
}

/** 1–5 severity → mark radius in pixels. Small enough to stay a mark, not a blob. */
function severityRadius(sev: number): number {
  return 9 + (Math.max(1, Math.min(5, sev)) - 1) * 2.6;
}

export function ConcernLayer(props: ConcernLayerProps): LayersList {
  const {
    id = 'concerns', data, clusters, theme, pulse = 0, labels = true,
    hoveredId, selectedId, onHover, onClick, onClusterClick,
    visible = true, pickable = true,
  } = props;

  const concerns = (data ?? []).filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat));
  const groups = clusters ?? [];
  if (!concerns.length && !groups.length) return [];

  const layers: LayersList = [];
  const fade = (c: Concern) => (c.status === 'resolved' || c.status === 'closed' ? 0.5 : 1);

  // ── cluster halos, under everything ───────────────────────────────────────
  if (groups.length) {
    layers.push(new ScatterplotLayer<ConcernCluster>({
      id: `${id}-cluster-fill`,
      data: groups,
      visible,
      pickable,
      radiusUnits: 'meters',
      stroked: false,
      filled: true,
      getPosition: (g) => g.centroid as unknown as [number, number],
      getRadius: (g) => g.radius_m,
      getFillColor: theme.color('actor-community', 0.1),
      onHover,
      onClick: onClusterClick ?? onClick,
      updateTriggers: { getFillColor: theme.css('actor-community') },
    }));

    layers.push(new PathLayer<{ g: ConcernCluster; path: Position[] }>({
      id: `${id}-cluster-ring`,
      data: groups.map((g) => ({ g, path: circleRing(g.centroid, g.radius_m, 72) })),
      visible,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (d) => d.path as unknown as Position[],
      getWidth: 1.6,
      getColor: theme.color('actor-community', 0.5 + pulse * 0.35),
      updateTriggers: { getColor: pulse },
    }));

    if (labels) {
      layers.push(new TextLayer<ConcernCluster>({
        id: `${id}-cluster-count`,
        data: groups,
        visible,
        pickable: false,
        getPosition: (g) => g.centroid as unknown as [number, number],
        getText: (g) => `${g.count} REPORTS`,
        getSize: 11,
        sizeUnits: 'pixels',
        getColor: theme.color('actor-community', 1),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        getPixelOffset: [0, -26],
        fontFamily: theme.css('font-mono') || 'monospace',
        fontWeight: 700,
        characterSet: 'auto',
        outlineWidth: 3.5,
        outlineColor: theme.color('bg', 0.92),
        fontSettings: { sdf: true },
        updateTriggers: { getColor: theme.css('actor-community'), outlineColor: theme.css('bg') },
      }));
    }
  }

  if (!concerns.length) return layers;

  // ── the reports themselves ────────────────────────────────────────────────
  layers.push(new ScatterplotLayer<Concern>({
    id: `${id}-disc`,
    data: concerns,
    visible,
    pickable,
    radiusUnits: 'pixels',
    radiusMinPixels: 7,
    stroked: true,
    filled: true,
    lineWidthUnits: 'pixels',
    getPosition: (c) => [c.lon, c.lat] as unknown as [number, number],
    getRadius: (c) => severityRadius(c.severity) * (c.id === selectedId ? 1.25 : 1),
    getFillColor: (c) => theme.color('bg', 0.88 * fade(c)),
    getLineWidth: (c) => (c.id === hoveredId || c.id === selectedId ? 2.6 : 1.8),
    getLineColor: (c) => theme.color(concernStatusToken(c.status), fade(c)),
    onHover,
    onClick,
    updateTriggers: {
      getRadius: selectedId,
      getLineWidth: [hoveredId, selectedId],
      getLineColor: theme.css('actor-community'),
      getFillColor: theme.css('bg'),
    },
  }));

  layers.push(new IconLayer<Concern>({
    id: `${id}-glyph`,
    data: concerns,
    visible,
    pickable,
    sizeUnits: 'pixels',
    getPosition: (c) => [c.lon, c.lat] as unknown as [number, number],
    getIcon: (c) => icon(concernGlyph(c.kind)),
    getSize: (c) => severityRadius(c.severity) * 1.35,
    getColor: (c) => theme.color(concernStatusToken(c.status), fade(c)),
    onHover,
    onClick,
    updateTriggers: { getColor: theme.css('actor-community'), getSize: selectedId },
  }));

  // Corroboration count — a small badge, only where more than one person agreed.
  const corroborated = concerns.filter((c) => c.corroborations > 0);
  if (labels && corroborated.length) {
    layers.push(new TextLayer<Concern>({
      id: `${id}-corroborations`,
      data: corroborated,
      visible,
      pickable: false,
      getPosition: (c) => [c.lon, c.lat] as unknown as [number, number],
      getText: (c) => `+${c.corroborations}`,
      getSize: 9,
      sizeUnits: 'pixels',
      getColor: theme.color('ink', 1),
      getTextAnchor: 'start',
      getAlignmentBaseline: 'center',
      getPixelOffset: (c) => [severityRadius(c.severity) + 2, -severityRadius(c.severity) + 2],
      fontFamily: theme.css('font-mono') || 'monospace',
      fontWeight: 700,
      characterSet: 'auto',
      outlineWidth: 4,
      outlineColor: theme.color('bg', 0.95),
      fontSettings: { sdf: true },
      updateTriggers: { getColor: theme.css('ink'), outlineColor: theme.css('bg') },
    }));
  }

  return layers;
}
