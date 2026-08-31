/**
 * RiskDial — the community's headline number.
 *
 * Unitless 0–100 with a word beside it, because a resident should never have to
 * meet "µg/m³" to find out whether their street is fine. The track is the full
 * public-health ramp so the reader can see where they sit on the whole scale, not
 * just their own value; the band label is what they actually read.
 */

import { useMemo, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { RISK_BANDS, riskBand, riskLabel } from '@/core/measures';
import { fmtTrend } from '@/core/format';
import { useTheme } from '../lib/theme';
import s from './chart.module.css';

export interface RiskDialProps {
  /** 0–100, unitless. Never show a unit next to this. */
  risk: number | null | undefined;
  size?: number;
  /** Small caps label above the number. */
  label?: string;
  /** Overrides the derived band word ("Good", "Moderate"…). */
  bandLabel?: string;
  /** Signed percentage change vs the previous window. */
  trendPct?: number | null;
  /** Is up bad? Default true for pollution. Drives the trend colour. */
  upIsBad?: boolean;
  /** Show the tick marks between bands. Default true. */
  showBands?: boolean;
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** 270° dial: opens at the bottom, which reads as a gauge rather than a pie. */
const START = -225;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg + 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${a1 > a0 ? 1 : 0} ${x1} ${y1}`;
}

export function RiskDial(props: RiskDialProps) {
  const {
    risk, size = 176, label = 'Air quality today', bandLabel,
    trendPct, upIsBad = true, showBands = true, footer, className, style,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme(ref);

  const v = risk === null || risk === undefined || !Number.isFinite(risk)
    ? null : Math.max(0, Math.min(100, risk));
  const band = riskBand(v ?? 0);
  const word = bandLabel ?? (v === null ? 'No data' : riskLabel(v));

  const cx = size / 2;
  const cy = size / 2;
  const rr = size / 2 - 15;
  const thickness = Math.max(9, size * 0.075);

  // Band boundaries as a fraction of the dial, straight from the risk breakpoints.
  const stops = useMemo(() => {
    const out: { from: number; to: number; color: string }[] = [];
    let prev = 0;
    RISK_BANDS.forEach((_b, i) => {
      const next = i === RISK_BANDS.length - 1 ? 100 : (RISK_BANDS[i + 1]?.min ?? 100);
      out.push({ from: prev, to: next, color: theme.aqi[i] ?? theme.aqi[theme.aqi.length - 1] });
      prev = next;
    });
    return out;
  }, [theme]);

  const angleOf = (pct: number) => START + (SWEEP * Math.max(0, Math.min(100, pct))) / 100;
  const needleColor = theme.aqi[band] ?? theme.css('accent');
  const trendGood = trendPct === null || trendPct === undefined
    ? null
    : (upIsBad ? trendPct < 0 : trendPct > 0);

  return (
    <div
      ref={ref}
      className={[s.root, className].filter(Boolean).join(' ')}
      style={{ justifyItems: 'center', ...style }}
    >
      <div style={{ position: 'relative', inlineSize: size, blockSize: size * 0.86 }}>
        <svg
          width={size}
          height={size * 0.86}
          viewBox={`0 0 ${size} ${size * 0.86}`}
          role="img"
          aria-label={v === null ? 'Air quality: no data' : `Air quality score ${Math.round(v)} out of 100: ${word}`}
        >
          {/* the whole public-health scale as the track */}
          {stops.map((b) => (
            <path
              key={b.from}
              d={arc(cx, cy, rr, angleOf(b.from), angleOf(b.to))}
              fill="none"
              stroke={b.color}
              strokeWidth={thickness}
              strokeLinecap="butt"
              opacity={v === null ? 0.3 : 0.34}
            />
          ))}

          {/* the reader's own value, drawn solid over its band */}
          {v !== null && (
            <path
              d={arc(cx, cy, rr, angleOf(0), angleOf(v))}
              fill="none"
              stroke={needleColor}
              strokeWidth={thickness}
              strokeLinecap="round"
            />
          )}

          {/* band boundary ticks: a 2px surface gap does the separating */}
          {showBands && stops.slice(1).map((b) => {
            const [x0, y0] = polar(cx, cy, rr - thickness / 2, angleOf(b.from));
            const [x1, y1] = polar(cx, cy, rr + thickness / 2, angleOf(b.from));
            return (
              <line
                key={`tick-${b.from}`}
                x1={x0} y1={y0} x2={x1} y2={y1}
                stroke={theme.css('surface')}
                strokeWidth={2}
              />
            );
          })}

          {/* the marker: a notch, so the value survives without colour */}
          {v !== null && (() => {
            const a = angleOf(v);
            const [x0, y0] = polar(cx, cy, rr - thickness / 2 - 3, a);
            const [x1, y1] = polar(cx, cy, rr + thickness / 2 + 3, a);
            return (
              <line
                x1={x0} y1={y0} x2={x1} y2={y1}
                stroke={theme.css('ink')}
                strokeWidth={2.4}
                strokeLinecap="round"
              />
            );
          })()}

          <text x={cx} y={cy - 3} textAnchor="middle" className={s.tick} fill={theme.css('ink-3')}>
            0
          </text>
        </svg>

        <div
          style={{
            position: 'absolute', inset: 0,
            display: 'grid', placeContent: 'center', gap: 1,
            justifyItems: 'center', pointerEvents: 'none',
            paddingBlockStart: size * 0.05,
          }}
        >
          <span className={s.capLabel}>{label}</span>
          <span className={s.hero} style={{ fontSize: size * 0.26 }}>
            {v === null ? '—' : Math.round(v)}
          </span>
          <span className={s.heroWord} style={{ color: needleColor }}>{word}</span>
          {trendPct !== null && trendPct !== undefined && (
            <span
              className={s.capLabel}
              style={{ color: trendGood ? theme.css('sev-ok') : theme.css('sev-warning') }}
            >
              {fmtTrend(trendPct)} vs last week
            </span>
          )}
        </div>
      </div>
      {footer}
    </div>
  );
}
