/**
 * The contract both basemap backends implement.
 *
 * `BaseMap` is ONE component with two backends, not two components: everything
 * below is backend-agnostic, so a caller never learns which engine drew the
 * tiles. Google is the real path (the team's preference); MapLibre with keyless
 * CARTO styles is what makes the demo run before a key exists.
 */

import type { LayersList, PickingInfo } from 'deck.gl';
import type { MapSkin, Theme } from '../../lib/theme';
import type { MapView } from '../MapContext';

export interface BackendProps {
  view: MapView;
  onViewChange(next: MapView): void;
  layers: LayersList;
  skin: MapSkin;
  theme: Theme;
  interactive: boolean;
  minZoom: number;
  maxZoom: number;
  maxPitch: number;
  cursor?: string;
  pickingRadius?: number;
  getTooltip?: (info: PickingInfo) => string | null;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  /** Called once the engine has drawn its first frame. */
  onReady?(): void;
  /** Called when the engine cannot start at all (bad key, offline, no WebGL). */
  onError?(message: string): void;
}
