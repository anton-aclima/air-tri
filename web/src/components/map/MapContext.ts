/**
 * Shared map state, so furniture can be dropped inside `<BaseMap>` without the
 * caller wiring view state through by hand:
 *
 *   <BaseMap …>
 *     <MapScale />      ← reads zoom + latitude from context
 *     <NorthCompass />  ← reads bearing/pitch, and can reset them
 *   </BaseMap>
 */

import { createContext, useContext } from 'react';
import type { Theme } from '../lib/theme';

export interface MapView {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface MapContextValue {
  view: MapView;
  /** Which backend actually mounted. */
  backend: 'google' | 'maplibre';
  theme: Theme | null;
  /** Fly/jump to a partial view. Furniture uses this to reset north. */
  setView(next: Partial<MapView>): void;
  /** Pixel size of the map canvas. */
  size: { width: number; height: number };
}

export const MapContext = createContext<MapContextValue | null>(null);

/** `null` when used outside a `<BaseMap>` — furniture must degrade gracefully. */
export function useMapContext(): MapContextValue | null {
  return useContext(MapContext);
}

export const DEFAULT_VIEW: MapView = {
  longitude: -90.132, latitude: 35.058, zoom: 12.6, bearing: 0, pitch: 0,
};
