/**
 * FleetLayer — little balls moving around the drive plan.
 *
 * The design doc asks for exactly this: our cars visible on the map, so the
 * measurement feels alive rather than archival. Each vehicle is a heading-aware
 * chevron with a breadcrumb trail that fades behind it.
 *
 * The fade is built from per-segment alpha rather than one polyline, because
 * `PathLayer` has no per-vertex opacity — so the trail is drawn as N short
 * segments whose alpha rises toward the vehicle.
 *
 * Pair with `useFleetAnimation()` so the dots drive between polls instead of
 * teleporting:
 *   const fleet = useFleetAnimation(data, { durationMs: 4000 });
 *   FleetLayer({ data: fleet, theme })
 */

import { IconLayer, LineLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { LayersList, PickingInfo } from 'deck.gl';
import type { FleetPosition, Position } from '@/core/types';
import type { AnimatedFleetPosition } from '../../lib/anim';
import type { Theme } from '../../lib/theme';
import { icon } from '../../lib/glyphs';

export interface FleetLayerProps {
  id?: string;
  /** Raw `GET /fleet` rows, or the output of `useFleetAnimation()`. */
  data: (FleetPosition | AnimatedFleetPosition)[] | null | undefined;
  theme: Theme;
  /** Breadcrumb trail. Default true. */
  trails?: boolean;
  /** Vehicles to keep in the trail, from the newest end. Default 40. */
  trailLength?: number;
  /** Call sign labels. Default true. */
  labels?: boolean;
  /** 0–1 pulse — a driving vehicle breathes gently. Feed from `usePulse(2200)`. */
  pulse?: number;
  sizePx?: number;
  hoveredId?: string | null;
  selectedId?: string | null;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  visible?: boolean;
  pickable?: boolean;
}

type Any = FleetPosition | AnimatedFleetPosition;
type Seg = { v: Any; source: Position; target: Position; t: number };

function pos(v: Any): Position {
  return 'animated' in v ? v.animated : [v.lon, v.lat];
}
function heading(v: Any): number {
  return 'animatedHeading' in v ? v.animatedHeading : (v.heading_deg ?? 0);
}

const STATUS_ALPHA: Record<string, number> = {
  driving: 1, idle: 0.6, charging: 0.45, maintenance: 0.35, offline: 0.22,
};

export function FleetLayer(props: FleetLayerProps): LayersList {
  const {
    id = 'fleet', data, theme, trails = true, trailLength = 40, labels = true,
    pulse = 0, sizePx = 22, hoveredId, selectedId,
    onHover, onClick, visible = true, pickable = true,
  } = props;

  const fleet = (data ?? []).filter((v) => Number.isFinite(v.lon) && Number.isFinite(v.lat));
  if (!fleet.length) return [];

  const layers: LayersList = [];
  const dim = (v: Any) => STATUS_ALPHA[v.status] ?? 0.5;

  // ── fading breadcrumb ─────────────────────────────────────────────────────
  if (trails) {
    const segs: Seg[] = [];
    for (const v of fleet) {
      const raw = v.trail ?? [];
      const tail = raw.length > trailLength ? raw.slice(-trailLength) : raw;
      const pts = [...tail, pos(v)];
      for (let i = 1; i < pts.length; i++) {
        segs.push({ v, source: pts[i - 1], target: pts[i], t: i / (pts.length - 1) });
      }
    }
    if (segs.length) {
      layers.push(new LineLayer<Seg>({
        id: `${id}-trail`,
        data: segs,
        visible,
        pickable: false,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        getSourcePosition: (d) => d.source as unknown as [number, number],
        getTargetPosition: (d) => d.target as unknown as [number, number],
        getWidth: (d) => 1 + d.t * 2.4,
        getColor: (d) => theme.color('fleet', Math.pow(d.t, 2.1) * 0.85 * dim(d.v)),
        updateTriggers: { getColor: theme.css('fleet') },
      }));
    }
  }

  // ── a soft under-glow so the dot survives a bright road grid ──────────────
  layers.push(new ScatterplotLayer<Any>({
    id: `${id}-glow`,
    data: fleet,
    visible,
    pickable: false,
    radiusUnits: 'pixels',
    stroked: false,
    filled: true,
    getPosition: (v) => pos(v) as unknown as [number, number],
    getRadius: (v) => (v.status === 'driving' ? sizePx * (0.62 + pulse * 0.16) : sizePx * 0.5),
    getFillColor: (v) => theme.color('fleet', 0.22 * dim(v)),
    updateTriggers: { getRadius: pulse, getFillColor: theme.css('fleet') },
  }));

  layers.push(new ScatterplotLayer<Any>({
    id: `${id}-hit`,
    data: fleet,
    visible,
    pickable,
    radiusUnits: 'pixels',
    // a generous transparent hit target — a 22px chevron is a pinpoint otherwise
    getPosition: (v) => pos(v) as unknown as [number, number],
    getRadius: 14,
    stroked: false,
    filled: true,
    getFillColor: [0, 0, 0, 0],
    onHover,
    onClick,
  }));

  // ── the vehicle ───────────────────────────────────────────────────────────
  layers.push(new IconLayer<Any>({
    id: `${id}-vehicle`,
    data: fleet,
    visible,
    pickable,
    sizeUnits: 'pixels',
    getPosition: (v) => pos(v) as unknown as [number, number],
    getIcon: () => icon('vehicle'),
    // deck.gl angles run counter-clockwise; compass bearings run clockwise.
    getAngle: (v) => -heading(v),
    getSize: (v) => sizePx * (v.vehicle_id === selectedId ? 1.25 : v.vehicle_id === hoveredId ? 1.12 : 1),
    getColor: (v) => theme.color('fleet', dim(v)),
    onHover,
    onClick,
    updateTriggers: {
      getAngle: fleet.map((v) => heading(v)).join(','),
      getPosition: fleet.map((v) => pos(v).join(',')).join('|'),
      getSize: [hoveredId, selectedId, sizePx],
      getColor: theme.css('fleet'),
    },
  }));

  if (labels) {
    layers.push(new TextLayer<Any>({
      id: `${id}-label`,
      data: fleet,
      visible,
      pickable: false,
      getPosition: (v) => pos(v) as unknown as [number, number],
      getText: (v) => (v.call_sign ?? v.label ?? '').toUpperCase(),
      getSize: 9.5,
      sizeUnits: 'pixels',
      getColor: (v) => theme.color('fleet', dim(v)),
      getTextAnchor: 'start',
      getAlignmentBaseline: 'center',
      getPixelOffset: [sizePx * 0.62, 0],
      fontFamily: theme.css('font-mono') || 'monospace',
      fontWeight: 700,
      characterSet: 'auto',
      outlineWidth: 4,
      outlineColor: theme.color('bg', 0.9),
      fontSettings: { sdf: true },
      updateTriggers: {
        getPosition: fleet.map((v) => pos(v).join(',')).join('|'),
        getColor: theme.css('fleet'),
        outlineColor: theme.css('bg'),
      },
    }));
  }

  return layers;
}
