/**
 * BoundaryLayer — "this community, not the world".
 *
 * Every map in this product is about one campaign area, so the boundary is not a
 * thin dashed outline: it is the frame. Three moves, bottom to top:
 *
 *   1. an exterior mask — the world outside the polygon, dimmed toward `bg`,
 *      built as one polygon with the campaign as its hole
 *   2. an inner glow — three concentric strokes of falling width and rising
 *      alpha *inside* the edge, so the boundary reads as lit from within
 *   3. the edge itself — a confident 2px accent line plus a faint offset
 *      companion stroke, which is what makes it look drawn rather than computed
 */

import { PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import type { LayersList } from 'deck.gl';
import type { FeatureCollection, GeoGeometry, Position } from '@/core/types';
import type { Theme } from '../../lib/theme';
import { bboxRing, toPolygons } from '../../lib/geo';

export interface BoundaryLayerProps {
  id?: string;
  /** `GET /campaigns/{id}/boundary` — a FeatureCollection, Feature, or geometry. */
  data: FeatureCollection | GeoGeometry | { type: 'Feature'; geometry: GeoGeometry } | null | undefined;
  theme: Theme;
  /** Dim everything outside the campaign. Default true. */
  mask?: boolean;
  /** 0–1 how hard the exterior is dimmed. Default 0.62. */
  maskStrength?: number;
  /** Soft inner glow. Default true. */
  glow?: boolean;
  /** Token for the edge. Default `accent`. */
  colorToken?: string;
  edgeWidthPx?: number;
  visible?: boolean;
}

/** The world, minus this campaign. A single polygon whose holes are the rings. */
const WORLD: Position[] = bboxRing([-179.9, -85, 179.9, 85]);

function normalise(
  data: BoundaryLayerProps['data'],
): Position[][][] {
  if (!data) return [];
  if ('type' in data && data.type === 'FeatureCollection') {
    return (data as FeatureCollection).features.flatMap((f) => toPolygons(f.geometry));
  }
  if ('type' in data && data.type === 'Feature') {
    return toPolygons((data as { geometry: GeoGeometry }).geometry);
  }
  return toPolygons(data as GeoGeometry);
}

export function BoundaryLayer(props: BoundaryLayerProps): LayersList {
  const {
    // Recessed, not erased. At 0.62 the exterior washed almost entirely to the
    // background, which took the river, the parks and the neighbourhood names
    // with it — and those are exactly what tells an operator what a plume is
    // drifting over. The campaign keeps its focus from the data being inside
    // it, not from the world outside being deleted.
    id = 'boundary', data, theme, mask = true, maskStrength = 0.28,
    glow = true, colorToken = 'accent', edgeWidthPx = 2, visible = true,
  } = props;

  const polys = normalise(data);
  if (!polys.length) return [];

  const outerRings = polys.map((p) => p[0]).filter((r) => r?.length);
  const allRings = polys.flat().filter((r) => r?.length);
  const layers: LayersList = [];

  // 1 ─ exterior mask
  if (mask) {
    layers.push(new SolidPolygonLayer<{ polygon: Position[][] }>({
      id: `${id}-mask`,
      data: [{ polygon: [WORLD, ...outerRings] }],
      visible,
      pickable: false,
      filled: true,
      getPolygon: (d) => d.polygon as unknown as Position[][],
      getFillColor: theme.color('bg', maskStrength),
      updateTriggers: { getFillColor: [theme.css('bg'), maskStrength] },
    }));
  }

  // 2 ─ inner glow: wide + faint, then narrower + brighter.
  if (glow) {
    const rungs: [number, number][] = [[16, 0.07], [9, 0.11], [4.5, 0.16]];
    rungs.forEach(([w, a], i) => {
      layers.push(new PathLayer<{ path: Position[] }>({
        id: `${id}-glow-${i}`,
        data: allRings.map((path) => ({ path })),
        visible,
        pickable: false,
        widthUnits: 'pixels',
        getPath: (d) => d.path as unknown as Position[],
        getWidth: w,
        getColor: theme.color(colorToken, a),
        updateTriggers: { getColor: theme.css(colorToken) },
      }));
    });
  }

  // 3 ─ the drawn edge: a soft companion stroke under a crisp line.
  layers.push(new PathLayer<{ path: Position[] }>({
    id: `${id}-edge-soft`,
    data: allRings.map((path) => ({ path })),
    visible,
    pickable: false,
    widthUnits: 'pixels',
    getPath: (d) => d.path as unknown as Position[],
    getWidth: edgeWidthPx * 2.6,
    getColor: theme.color(colorToken, 0.24),
    updateTriggers: { getColor: theme.css(colorToken) },
  }));
  layers.push(new PathLayer<{ path: Position[] }>({
    id: `${id}-edge`,
    data: allRings.map((path) => ({ path })),
    visible,
    pickable: false,
    widthUnits: 'pixels',
    capRounded: true,
    jointRounded: true,
    getPath: (d) => d.path as unknown as Position[],
    getWidth: edgeWidthPx,
    getColor: theme.color(colorToken, 0.95),
    updateTriggers: { getColor: theme.css(colorToken) },
  }));

  return layers;
}
