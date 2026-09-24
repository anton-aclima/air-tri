/**
 * MapWindField — the particle field, wired to whatever camera the map has.
 *
 * Drop it into `<BaseMap fullBleed={…}>`. It reads the live view state out of
 * `MapContext`, so it works identically over the Google and MapLibre backends and
 * needs no props from the caller beyond the field itself.
 */

import type { CSSProperties } from 'react';
import type { WindField } from '@/core/types';
import { useMapContext } from '../map/MapContext';
import { WindFieldCanvas, mapProjector, viewSignature } from './WindFieldCanvas';

export interface MapWindFieldProps {
  field: WindField | null | undefined;
  particles?: number;
  keep?: number;
  speedDomain?: [number, number];
  speedScale?: number;
  ramp?: 'map' | 'intensity' | 'aqi';
  /**
   * `'neutral'` paints every particle in `--ink-2` (or `colorToken`), speed
   * on alpha — for a map whose ramp is the measured street ramp, so the wind
   * never reads as measured ink (CONTRACT §10b). Default `'ramp'`.
   */
  colorMode?: 'ramp' | 'neutral';
  /** One token for every particle instead of the ramp. See `WindFieldCanvas`. */
  colorToken?: string;
  opacity?: number;
  lineWidth?: number;
  minConfidence?: number;
  running?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function MapWindField(props: MapWindFieldProps) {
  // Over the map the field is CONTEXT — the road grid is the hero visual, and a
  // full-rate field hatches into a mat that out-draws it. The scope is a small
  // frame and needs the full step, so this restraint lives here rather than in
  // the engine.
  const { field, speedScale = 0.55, ...rest } = props;
  const ctx = useMapContext();
  if (!ctx || !ctx.theme) return null;

  const projector = mapProjector(ctx.view, ctx.size);
  if (!projector) return null;

  return (
    <WindFieldCanvas
      field={field}
      projector={projector}
      theme={ctx.theme}
      viewKey={viewSignature(ctx.view)}
      speedScale={speedScale}
      {...rest}
    />
  );
}
