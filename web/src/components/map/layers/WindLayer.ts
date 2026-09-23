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

import { PathStyleExtension } from '@deck.gl/extensions';
import type { PathStyleExtensionProps } from '@deck.gl/extensions';
import { PathLayer, PolygonLayer } from '@deck.gl/layers';
import type { LayersList } from 'deck.gl';
import type { DispersionPlume, Position } from '@/core/types';
import type { Theme } from '../../lib/theme';

/**
 * The legend line that MUST accompany any band drawn past the detection
 * envelope. CONTRACT §10b — exported so the four screens print the same
 * sentence rather than four paraphrases that drift.
 */
export const BEYOND_ENVELOPE_NOTE = 'beyond measurement range — model only';

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

/**
 * Does this plume have anything drawn past the detection envelope? Screens
 * call it to decide whether to print `BEYOND_ENVELOPE_NOTE`; the dashed
 * geometry alone is not a caption.
 */
export function hasBeyondEnvelope(data: DispersionPlume | null | undefined): boolean {
  return (data?.features ?? []).some((f) => f.properties.beyond_envelope);
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
  const ring = (f: PlumeFeature) => f.geometry.coordinates[0] as unknown as Position[];

  // CONTRACT §10b, the register split. Inside the detection envelope a band is
  // a filled contour; past it there is nothing to compare the model against,
  // so it is drawn as a dashed outline with NO FILL and the screen prints
  // `BEYOND_ENVELOPE_NOTE`.
  //
  // This is not decoration. Under stable air the kernel's plume reaches across
  // the whole monitored area — a 10 km cone from Ridgeline covers 96.7% of the
  // road grid — and without a visible change of register every
  // model-versus-measurement picture becomes a picture of the campaign
  // boundary, with the modelled layer reading as the measured one because it
  // is the bigger and smoother of the two.
  const inside = features.filter((f) => !f.properties.beyond_envelope);
  const beyond = features.filter((f) => f.properties.beyond_envelope);

  const layers: LayersList = [];

  if (inside.length) {
    layers.push(new PolygonLayer<PlumeFeature>({
      id: `${id}-fill`,
      data: inside,
      visible,
      pickable,
      stroked: false,
      filled: true,
      getPolygon: ring,
      getFillColor: (f) => theme.rampColor(0.35 + norm(f) * 0.6, Math.pow(norm(f), 1.4) * maxOpacity, 'intensity'),
      updateTriggers: { getFillColor: [theme.intensity.join(','), maxOpacity, bands] },
    }));
  }

  if (outline && inside.length) {
    layers.push(new PathLayer<PlumeFeature>({
      id: `${id}-edge`,
      data: inside,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      getPath: ring,
      getWidth: 1,
      getColor: (f) => theme.rampColor(0.45 + norm(f) * 0.5, 0.42 * norm(f) + 0.14, 'intensity'),
      updateTriggers: { getColor: theme.intensity.join(',') },
    }));
  }

  if (beyond.length) {
    layers.push(new PathLayer<PlumeFeature, PathStyleExtensionProps<PlumeFeature>>({
      id: `${id}-model-only`,
      data: beyond,
      visible,
      // Not pickable: a dashed outline is a statement that we do not know, and
      // there is nothing to inspect behind it.
      pickable: false,
      widthUnits: 'pixels',
      getPath: ring,
      getWidth: 1.25,
      getColor: (f) => theme.rampColor(0.5 + norm(f) * 0.4, 0.5, 'intensity'),
      // Screen-space dashes, so the pattern reads the same at every zoom —
      // a metre-based dash turns solid when you zoom out, which is exactly
      // when the distinction matters most.
      getDashArray: [6, 4],
      dashJustified: true,
      dashGapPickable: false,
      extensions: [new PathStyleExtension({ dash: true, highPrecisionDash: true })],
      updateTriggers: { getColor: theme.intensity.join(',') },
    }));
  }

  return layers;
}
