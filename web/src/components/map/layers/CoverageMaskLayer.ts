/**
 * CoverageMaskLayer — dim the ground the fleet never drove.
 *
 * CONTRACT §10b's last row: "anything outside the driven-coverage mask —
 * dimmed or hatched, and excluded from every agreement metric". On the
 * regulator Network (R2) an hourly plume outline lies across whole
 * neighbourhoods the fleet did not drive that day; without the mask, the
 * outline over undriven ground reads exactly like the outline over measured
 * streets, and the reader fills the gap with the model.
 *
 * How: a world-sized veil in the basemap's own `--bg`, cut away along a
 * corridor around every driven street. The cut is deck.gl's `MaskExtension`
 * with `maskInverted` — the GPU equivalent of "a world polygon with holes
 * buffered around the driven paths", without a polygon-buffer library or
 * unioning 781 corridors on the CPU every time the day changes.
 *
 * Very low alpha and no stroke, by design: it recedes the undriven ground, it
 * does not draw a new edge on the map for a reader to interpret.
 *
 * Put it directly above the basemap / `BoundaryLayer` and BELOW the street
 * grid and every model layer, so it dims tiles only and never the data.
 */

import { PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { MaskExtension } from '@deck.gl/extensions';
import type { MaskExtensionProps } from '@deck.gl/extensions';
import type { LayersList } from 'deck.gl';
import type { Position, SegmentCollection } from '@/core/types';
import type { Theme } from '../../lib/theme';
import { bboxRing } from '../../lib/geo';

export interface CoverageMaskLayerProps {
  id?: string;
  /**
   * The driven streets — for the Network, the same window the coloured
   * streets are drawn from (`GET /segments?window=trailing:<N>h|todate&at=…`),
   * so "driven" means driven in the window shown. `null`/`undefined` (still
   * loading) draws nothing; an EMPTY collection dims everything, because in
   * a window with no driving that is the honest picture.
   */
  data: SegmentCollection | null | undefined;
  theme: Theme;
  /**
   * Full width of the undimmed corridor around each driven street, metres.
   * Default 120: the street and its frontage either side, about the distance
   * a curbside reading can speak for. At the default view (~10 m/px) that is
   * a 12 px lane, wide enough to read as "driven" around a 2 px street.
   */
  corridorM?: number;
  /** Veil strength, 0–1 alpha of `--bg`. Default 0.2 — see below. */
  strength?: number;
  /** Streets with fewer passes than this do not count as driven. Default 1. */
  minPasses?: number;
  visible?: boolean;
}

/** The world. Same extent `BoundaryLayer` uses for its exterior mask. */
const WORLD: Position[] = bboxRing([-179.9, -85, 179.9, 85]);

export function CoverageMaskLayer(props: CoverageMaskLayerProps): LayersList {
  const {
    // 0.2, under BoundaryLayer's 0.28 for "outside the campaign": undriven
    // ground inside the campaign is still the campaign — recessed less than
    // the world outside it, and the two stack where both apply.
    id = 'coverage-mask', data, theme, corridorM = 120, strength = 0.2, minPasses = 1, visible = true,
  } = props;
  if (!data) return [];

  const paths: Position[][] = [];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of data.features ?? []) {
    if ((f.properties?.n_passes ?? 0) < minPasses) continue;
    const coords = f.geometry?.coordinates as Position[] | undefined;
    if (!coords || coords.length < 2) continue;
    paths.push(coords);
    for (const p of coords) {
      if (p[0] < w) w = p[0];
      if (p[0] > e) e = p[0];
      if (p[1] < s) s = p[1];
      if (p[1] > n) n = p[1];
    }
  }

  const maskId = `${id}-corridors`;
  const veilColor = theme.color('bg', strength);
  const veil = new SolidPolygonLayer<{ polygon: Position[] }, MaskExtensionProps>({
    id: `${id}-veil`,
    data: [{ polygon: WORLD }],
    visible,
    pickable: false,
    filled: true,
    getPolygon: (d) => d.polygon as unknown as Position[],
    getFillColor: veilColor,
    updateTriggers: { getFillColor: [theme.css('bg'), strength] },
    ...(paths.length
      ? { extensions: [new MaskExtension()], maskId, maskInverted: true }
      : {}),
  });
  if (!paths.length) return [veil];

  /*
    The mask texture is fitted to the mask layer's BOUNDS, and deck computes a
    PathLayer's bounds from its vertices alone, not its width: a corridor on
    the outermost street would be cut in half at the texture's edge and its
    outer half dimmed. One zero-width diagonal, padded out by half a corridor,
    stretches the bounds without drawing anything.
  */
  const half = corridorM / 2;
  const dLat = half / 111_320;
  const dLon = dLat / Math.max(0.1, Math.cos((((s + n) / 2) * Math.PI) / 180));
  const pad: Position[] = [[w - dLon, s - dLat], [e + dLon, n + dLat]];
  const corridors = [...paths.map((path) => ({ path, width: corridorM })), { path: pad, width: 0 }];

  const mask = new PathLayer<{ path: Position[]; width: number }>({
    id: maskId,
    operation: 'mask',
    data: corridors,
    visible,
    pickable: false,
    widthUnits: 'meters',
    capRounded: true,
    jointRounded: true,
    getPath: (d) => d.path as unknown as Position[],
    getWidth: (d) => d.width,
    updateTriggers: { getWidth: corridorM },
  });

  return [mask, veil];
}
