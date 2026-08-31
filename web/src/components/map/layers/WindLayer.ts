/**
 * DispersionLayer — plume cones on the map.
 *
 * NOTE: the *wind* visual is no longer a deck.gl layer. Particle advection needs
 * frame-to-frame canvas history (the trail is the decay of previous frames), which
 * deck.gl's declarative redraw cannot express. See
 * `components/wind/WindFieldCanvas.tsx` and `components/wind/MapWindField.tsx` —
 * drop `<MapWindField>` into `<BaseMap fullBleed={…}>`.
 *
 * What stays here is the consultant-style contour: a modelled plume as filled,
 * banded polygons. On the map it is a layer; on the radar scope the same contours
 * are drawn as a reference outline the observed particle field visibly disagrees
 * with.
 */

import { PathLayer, PolygonLayer } from '@deck.gl/layers';
import type { LayersList } from 'deck.gl';
import type { DispersionPlume, Position } from '@/core/types';
import type { Theme } from '../../lib/theme';

export interface DispersionLayerProps {
  id?: string;
  /** GeoJSON from `GET /wind/dispersion`. */
  data: DispersionPlume | null | undefined;
  theme: Theme;
  /** Bands per plume, used to normalise alpha. Auto-detected when omitted. */
  bandCount?: number;
  /** Outline the plume edge. Default true. */
  outline?: boolean;
  maxOpacity?: number;
  visible?: boolean;
  pickable?: boolean;
}

type PlumeFeature = DispersionPlume['features'][number];

/**
 * Plume cones. Each `band` is a concentration contour, so the fill is stepped
 * through the intensity ramp and the alpha falls off outward — the shape of a
 * plume, not a flat cone.
 */
export function DispersionLayer(props: DispersionLayerProps): LayersList {
  const {
    id = 'dispersion', data, theme, bandCount, outline = true,
    maxOpacity = 0.5, visible = true, pickable = false,
  } = props;

  const features = data?.features ?? [];
  if (!features.length) return [];

  const bands = bandCount ?? (Math.max(...features.map((f) => f.properties.band ?? 0)) + 1);
  const norm = (f: PlumeFeature) => 1 - (f.properties.band ?? 0) / Math.max(1, bands);

  const layers: LayersList = [
    new PolygonLayer<PlumeFeature>({
      id: `${id}-fill`,
      data: features,
      visible,
      pickable,
      stroked: false,
      filled: true,
      getPolygon: (f) => f.geometry.coordinates[0] as unknown as Position[],
      getFillColor: (f) => theme.rampColor(0.35 + norm(f) * 0.6, Math.pow(norm(f), 1.4) * maxOpacity, 'intensity'),
      updateTriggers: { getFillColor: [theme.intensity.join(','), maxOpacity, bands] },
    }),
  ];

  if (outline) {
    layers.push(new PathLayer<PlumeFeature>({
      id: `${id}-edge`,
      data: features,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (f) => f.geometry.coordinates[0] as unknown as Position[],
      getWidth: 1,
      getColor: (f) => theme.rampColor(0.45 + norm(f) * 0.5, 0.42 * norm(f) + 0.14, 'intensity'),
      updateTriggers: { getColor: theme.intensity.join(',') },
    }));
  }

  return layers;
}
