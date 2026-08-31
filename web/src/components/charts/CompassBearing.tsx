/**
 * CompassBearing — one bearing, spelled out.
 *
 * The smallest possible answer to "which way?": a dial, a needle, three digits and
 * a distance. Used beside an RWR contact and in an alert card, where a whole
 * radar scope would be too much.
 */

import { useRef } from 'react';
import type { CSSProperties } from 'react';
import type { Severity } from '@/core/types';
import { severityVar } from '@/core/measures';
import { compassPoint, fmtBearing, fmtDistance } from '@/core/format';
import { useTheme } from '../lib/theme';
import s from './chart.module.css';
import b from './CompassBearing.module.css';

export interface CompassBearingProps {
  /** Degrees clockwise from north. */
  bearing: number | null | undefined;
  distanceM?: number | null;
  size?: number;
  /** Colours the needle. Defaults to the role accent. */
  severity?: Severity | null;
  label?: string;
  /** Show the cardinal word ("ESE") as well as the digits. */
  cardinal?: boolean;
  /** Stack the readout under the dial instead of beside it. */
  vertical?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function CompassBearing(props: CompassBearingProps) {
  const {
    bearing, distanceM, size = 46, severity, label,
    cardinal = true, vertical = false, className, style,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme(ref);
  const deg = bearing === null || bearing === undefined || !Number.isFinite(bearing) ? null : bearing;
  const color = severity ? severityVar(severity) : theme.css('accent');
  const r = size / 2;

  return (
    <div
      ref={ref}
      className={[b.root, vertical ? b.vertical : '', className].filter(Boolean).join(' ')}
      style={style}
    >
      <svg
        width={size} height={size}
        viewBox={`${-r} ${-r} ${size} ${size}`}
        role="img"
        aria-label={deg === null
          ? 'No bearing'
          : `Bearing ${fmtBearing(deg)}${distanceM ? `, ${fmtDistance(distanceM)}` : ''}`}
      >
        <circle r={r - 2} fill="none" stroke={theme.css('line')} strokeWidth={1} />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <line
            key={a}
            x1={0} y1={-(r - 3)} x2={0} y2={-(r - (a % 90 === 0 ? 6.5 : 4.5))}
            stroke={theme.css(a === 0 ? 'ink-3' : 'line')}
            strokeWidth={a % 90 === 0 ? 1.1 : 0.8}
            transform={`rotate(${a})`}
          />
        ))}
        <text
          x={0} y={-(r - 8)} textAnchor="middle" dy="0.3em"
          className={s.tick} fontSize={6.5}
        >N</text>
        {deg !== null && (
          <g transform={`rotate(${deg})`}>
            {/* a filled arrow: direction is in the shape, not only the colour */}
            <path
              d={`M 0,${-(r - 7)} L ${r * 0.2},${r * 0.14} L 0,${r * 0.02} L ${-r * 0.2},${r * 0.14} Z`}
              fill={color}
            />
          </g>
        )}
        <circle r={1.6} fill={theme.css('ink-3')} />
      </svg>

      <div className={b.readout}>
        {label && <span className={s.capLabel}>{label}</span>}
        <span className={b.bearing}>
          {fmtBearing(deg)}
          {cardinal && deg !== null && <span className={b.cardinal}>{compassPoint(deg)}</span>}
        </span>
        {distanceM !== null && distanceM !== undefined && (
          <span className={b.distance}>{fmtDistance(distanceM)}</span>
        )}
      </div>
    </div>
  );
}
