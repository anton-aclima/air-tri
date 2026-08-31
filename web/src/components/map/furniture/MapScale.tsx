/**
 * MapScale — a real scale bar, computed from the live zoom and latitude.
 *
 * Picks a round distance (1/2/5 × 10ⁿ) that fits inside `maxWidth`, so the bar
 * always reads as "500 m", never "473 m".
 */

import { useRef } from 'react';
import type { CSSProperties } from 'react';
import { metersPerPixel } from '../../lib/geo';
import { niceStep } from '../../lib/vizmeta';
import { useMapContext } from '../MapContext';
import s from './furniture.module.css';

export interface MapScaleProps {
  /** Overrides the map context — for a standalone scale bar. */
  zoom?: number;
  latitude?: number;
  /** Longest the bar may be, in pixels. Default 110. */
  maxWidth?: number;
  units?: 'metric' | 'imperial' | 'both';
  className?: string;
  style?: CSSProperties;
}

function pickRound(maxMeters: number): { meters: number; label: string } {
  const step = niceStep(maxMeters);
  const meters = step > maxMeters ? step / 2 : step;
  return {
    meters,
    label: meters >= 1000 ? `${+(meters / 1000).toFixed(meters % 1000 ? 1 : 0)} km` : `${Math.round(meters)} m`,
  };
}

function pickImperial(maxMeters: number): { meters: number; label: string } {
  const feetPerMeter = 3.28084;
  const maxFeet = maxMeters * feetPerMeter;
  if (maxFeet < 1000) {
    const step = niceStep(maxFeet);
    const feet = step > maxFeet ? step / 2 : step;
    return { meters: feet / feetPerMeter, label: `${Math.round(feet)} ft` };
  }
  const maxMi = maxMeters / 1609.344;
  const step = niceStep(maxMi);
  const mi = step > maxMi ? step / 2 : step;
  return { meters: mi * 1609.344, label: `${+mi.toFixed(mi < 1 ? 2 : 1)} mi` };
}

export function MapScale(props: MapScaleProps) {
  const { maxWidth = 110, units = 'metric', className, style } = props;
  const ctx = useMapContext();
  const ref = useRef<HTMLDivElement>(null);

  const zoom = props.zoom ?? ctx?.view.zoom ?? 12;
  const lat = props.latitude ?? ctx?.view.latitude ?? 0;
  const mpp = metersPerPixel(lat, zoom);
  const maxMeters = mpp * maxWidth;

  const rows: { meters: number; label: string }[] = [];
  if (units === 'metric' || units === 'both') rows.push(pickRound(maxMeters));
  if (units === 'imperial' || units === 'both') rows.push(pickImperial(maxMeters));

  return (
    <div ref={ref} className={[s.scale, className].filter(Boolean).join(' ')} style={style}>
      {rows.map((r) => (
        <div key={r.label} className={s.scaleRow}>
          <span className={s.scaleBar} style={{ inlineSize: Math.round(r.meters / mpp) }} />
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}
