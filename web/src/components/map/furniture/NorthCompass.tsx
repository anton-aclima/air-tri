/**
 * NorthCompass — orientation, and a way back.
 *
 * Rotates with the map bearing and tilts with the pitch; clicking resets both.
 * Hidden by default when the map is already north-up and flat, because a control
 * that never does anything is noise — pass `alwaysVisible` to keep it.
 */

import { useRef } from 'react';
import type { CSSProperties } from 'react';
import { fmtBearing, compassPoint } from '@/core/format';
import { useTheme } from '../../lib/theme';
import { useMapContext } from '../MapContext';
import s from './furniture.module.css';

export interface NorthCompassProps {
  bearing?: number;
  pitch?: number;
  onReset?(): void;
  size?: number;
  /** Show even when the map is north-up. Default false. */
  alwaysVisible?: boolean;
  /** Numeric bearing readout under the dial. */
  readout?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function NorthCompass(props: NorthCompassProps) {
  const { size = 40, alwaysVisible = false, readout = false, className, style } = props;
  const ctx = useMapContext();
  const ref = useRef<HTMLButtonElement>(null);
  const theme = useTheme(ref);

  const bearing = props.bearing ?? ctx?.view.bearing ?? 0;
  const pitch = props.pitch ?? ctx?.view.pitch ?? 0;
  const idle = Math.abs(bearing) < 0.5 && Math.abs(pitch) < 0.5;
  if (idle && !alwaysVisible) return null;

  const reset = () => {
    if (props.onReset) props.onReset();
    else ctx?.setView({ bearing: 0, pitch: 0 });
  };

  const r = size / 2;
  const needle = 'M 0,-8.2 L 2.9,3.4 L 0,1.6 L -2.9,3.4 Z';

  return (
    <button
      ref={ref}
      type="button"
      className={[s.compass, className].filter(Boolean).join(' ')}
      style={{ inlineSize: size, blockSize: size, ...style }}
      onClick={reset}
      title={`${compassPoint(bearing)} ${fmtBearing(bearing)} — click to reset north`}
      aria-label={`Map bearing ${fmtBearing(bearing)}. Reset to north.`}
    >
      <svg width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`} aria-hidden="true">
        <circle r={r - 3.5} fill="none" stroke={theme.css('line')} strokeWidth={1} />
        {[0, 90, 180, 270].map((a) => (
          <line
            key={a}
            x1={0} y1={-(r - 4)} x2={0} y2={-(r - 7)}
            stroke={theme.css('ink-3')}
            strokeWidth={a === 0 ? 1.4 : 0.9}
            transform={`rotate(${a - bearing})`}
          />
        ))}
        <g transform={`rotate(${-bearing})`}>
          {/* North half in the accent, south half recessive: never colour-alone —
              the shape already points, the colour only confirms. */}
          <path d={needle} fill={theme.css('accent')} />
          <path d={needle} fill={theme.css('ink-3')} transform="rotate(180)" opacity={0.55} />
        </g>
        <text
          x={0} y={-(r - 9.5)}
          textAnchor="middle"
          fontSize={7}
          fontFamily={theme.css('font-mono') || 'monospace'}
          fill={theme.css('ink-2')}
          transform={`rotate(${-bearing})`}
        >N</text>
      </svg>
      {readout && (
        <span className={s.capLabel} style={{ position: 'absolute', insetBlockEnd: -14 }}>
          {fmtBearing(bearing)}
        </span>
      )}
    </button>
  );
}
