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
 *
 * AT CITY ZOOM THE LAYER FOLDS (`zoom` < `aggregateBelow`). Every map used to
 * draw every report at full weight on top of the road grid — two hundred glyph
 * pins, "+N" badges and stacked halo labels, over the measurement the screen
 * exists to show. Below the threshold:
 *
 *   · reports inside a drawn cluster halo are not drawn separately — the halo,
 *     with its count, already stands for them;
 *   · the rest fold into count bubbles by on-screen distance, and split apart
 *     as you zoom in (`onBubbleClick` is the caller's cue to zoom there);
 *   · "+N" corroboration badges appear only from `badgesFrom`.
 *
 * Which reports reach this layer at all is `components/lib/reports.ts`.
 */

import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { LayersList, PickingInfo } from 'deck.gl';
import type { Concern, ConcernCluster, Position } from '@/core/types';
import type { Theme } from '../../lib/theme';
import { circleRing, metersPerPixel } from '../../lib/geo';
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
  /** Current map zoom. Omit and the layer never folds (e.g. a one-pin preview). */
  zoom?: number;
  /** Below this zoom, nearby reports fold into count bubbles. */
  aggregateBelow?: number;
  /** "+N" corroboration badges only from this zoom. */
  badgesFrom?: number;
  /** A bubble was clicked — `info.object` is a `ConcernBubble`. Zoom there. */
  onBubbleClick?: (info: PickingInfo) => void;
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

/** Reports folded together at city zoom. */
export interface ConcernBubble {
  position: Position;
  count: number;
  /** Still waiting on a response — decides the bubble's colour. */
  open: number;
  members: Concern[];
}

/** Zoom at which a bubble tap should land so the bubble has split. */
export const BUBBLE_SPLIT_ZOOM = 14.6;

/** Bubble reach, in screen pixels. */
const FOLD_PX = 40;

// deck.gl diffs `data` by reference and the map re-renders on every animation
// frame, so the folding is cached per (input array, half-zoom step) instead of
// recomputed — the same reason `softShells` keeps a WeakMap.
const foldCache = new WeakMap<object, Map<string, { singles: Concern[]; bubbles: ConcernBubble[] }>>();

/**
 * Greedy distance folding. A grid would split two pins that sit either side of
 * a cell edge; this takes the most severe unassigned report, gathers everything
 * within `FOLD_PX` of it, and repeats. Two hundred points — quadratic is fine.
 */
function fold(
  source: object, tag: string, concerns: Concern[], zoom: number,
): { singles: Concern[]; bubbles: ConcernBubble[] } {
  // Keyed on the CALLER's array, not `concerns` — that is filtered afresh on
  // every render and would miss the cache every frame.
  const step = Math.floor(zoom * 2) / 2;
  const key = `${step}|${tag}`;
  let byZoom = foldCache.get(source);
  if (!byZoom) { byZoom = new Map(); foldCache.set(source, byZoom); }
  const hit = byZoom.get(key);
  if (hit) return hit;

  const lat0 = concerns.reduce((a, c) => a + c.lat, 0) / Math.max(1, concerns.length);
  const reachM = FOLD_PX * metersPerPixel(lat0, step);
  const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 110_540;
  const order = [...concerns].sort((a, b) => b.severity - a.severity);
  const used = new Set<string>();
  const singles: Concern[] = [];
  const bubbles: ConcernBubble[] = [];
  for (const seed of order) {
    if (used.has(seed.id)) continue;
    const members = order.filter((c) => !used.has(c.id)
      && Math.hypot((c.lon - seed.lon) * mx, (c.lat - seed.lat) * my) <= reachM);
    for (const m of members) used.add(m.id);
    if (members.length === 1) { singles.push(seed); continue; }
    bubbles.push({
      position: [
        members.reduce((a, c) => a + c.lon, 0) / members.length,
        members.reduce((a, c) => a + c.lat, 0) / members.length,
      ],
      count: members.length,
      open: members.filter((c) => c.status !== 'resolved' && c.status !== 'closed').length,
      members,
    });
  }
  const out = { singles, bubbles };
  byZoom.set(key, out);
  return out;
}

export function ConcernLayer(props: ConcernLayerProps): LayersList {
  const {
    id = 'concerns', data, clusters, theme, pulse = 0, labels = true,
    hoveredId, selectedId, onHover, onClick, onClusterClick,
    zoom, aggregateBelow = 14, badgesFrom = 15, onBubbleClick,
    visible = true, pickable = true,
  } = props;

  const all = data ?? [];
  const groups = clusters ?? [];
  if (!all.length && !groups.length) return [];

  const folding = zoom != null && zoom < aggregateBelow;
  let concerns = all.filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat));
  let bubbles: ConcernBubble[] = [];
  if (folding) {
    // The halo already says "N reports here"; drawing its members as well is
    // the double-count that made the busiest blocks unreadable. The selected
    // report is never folded away.
    const haloed = new Set(groups.map((g) => g.id));
    const loose = concerns.filter((c) => !(c.cluster_id && haloed.has(c.cluster_id)) || c.id === selectedId);
    const tag = `${groups.map((g) => g.id).join(',')}|${selectedId ?? ''}`;
    const f = fold(all, tag, loose, zoom);
    concerns = f.singles;
    bubbles = f.bubbles;
    if (selectedId) {
      const sel = bubbles.find((b) => b.members.some((m) => m.id === selectedId));
      if (sel) concerns = [...concerns, ...sel.members.filter((m) => m.id === selectedId)];
    }
  }

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
      // Overlapping halos printed their labels on top of each other ("9
      // REPORTS" over "6 REPORTS" at Ridgeline). At city zoom the bigger one
      // keeps its label; zoom in and both come back.
      let labelled = groups;
      if (folding) {
        const lat0 = groups[0].centroid[1];
        const reachM = FOLD_PX * 1.4 * metersPerPixel(lat0, zoom);
        const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
        labelled = [];
        for (const g of [...groups].sort((a, b) => b.count - a.count)) {
          const clash = labelled.some((k) => Math.hypot(
            (k.centroid[0] - g.centroid[0]) * mx, (k.centroid[1] - g.centroid[1]) * 110_540,
          ) < reachM);
          if (!clash) labelled.push(g);
        }
      }
      layers.push(new TextLayer<ConcernCluster>({
        id: `${id}-cluster-count`,
        data: labelled,
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

  // ── count bubbles, city zoom only ─────────────────────────────────────────
  if (bubbles.length) {
    const radius = (b: ConcernBubble) => 10 + 3.2 * Math.sqrt(b.count);
    layers.push(new ScatterplotLayer<ConcernBubble>({
      id: `${id}-bubble`,
      data: bubbles,
      visible,
      pickable,
      radiusUnits: 'pixels',
      stroked: true,
      filled: true,
      lineWidthUnits: 'pixels',
      getPosition: (b) => b.position as unknown as [number, number],
      getRadius: radius,
      // Answered-only bubbles go quiet, like an answered pin does.
      getFillColor: (b) => theme.color(b.open ? 'actor-community' : 'sev-ok', b.open ? 0.9 : 0.55),
      getLineColor: theme.color('bg', 0.95),
      getLineWidth: 2,
      onHover,
      onClick: onBubbleClick,
      updateTriggers: { getFillColor: theme.css('actor-community') },
    }));
    layers.push(new TextLayer<ConcernBubble>({
      id: `${id}-bubble-count`,
      data: bubbles,
      visible,
      pickable: false,
      getPosition: (b) => b.position as unknown as [number, number],
      getText: (b) => String(b.count),
      getSize: 12,
      sizeUnits: 'pixels',
      getColor: theme.color('bg', 1),
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      fontFamily: theme.css('font-mono') || 'monospace',
      fontWeight: 700,
      characterSet: '0123456789',
      updateTriggers: { getColor: theme.css('bg') },
    }));
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

  // Corroboration count — a small badge, only where more than one person
  // agreed, and only close in. At city zoom it was a scatter of "+1"s that
  // read as noise; the report card still says it.
  const corroborated = concerns.filter((c) => c.corroborations > 0);
  if (labels && corroborated.length && (zoom == null || zoom >= badgesFrom)) {
    layers.push(new TextLayer<Concern>({
      id: `${id}-corroborations`,
      data: corroborated,
      visible,
      pickable: false,
      getPosition: (c) => [c.lon, c.lat] as unknown as [number, number],
      getText: (c) => `+${c.corroborations}`,
      getSize: theme.labelPx(9),
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
