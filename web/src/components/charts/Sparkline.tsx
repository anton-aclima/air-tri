/**
 * Sparkline — a trend at the size of a word.
 *
 * No axes, no gridlines, no tooltip: it is a shape beside a number, and the
 * number carries the value. One end dot marks "now" with a 2px surface ring so
 * it survives on top of the line.
 */

import { useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { scaleLinear } from 'd3-scale';
import { area, curveMonotoneX, line } from 'd3-shape';
import type { SeriesPoint } from '@/core/types';
import { useTheme } from '../lib/theme';

export interface SparklineProps {
  points: SeriesPoint[] | (number | null)[];
  /** p10–p90 or any interval, aligned to `points`. */
  band?: { lo: number | null; hi: number | null }[];
  width?: number;
  height?: number;
  /** Resolved colour. Default the role accent. */
  color?: string;
  /** Wash under the line. Default true for a single series. */
  fill?: boolean;
  /** A reference or action level. */
  threshold?: number | null;
  showEndDot?: boolean;
  domain?: [number, number];
  /** Screen-reader text. Always supply something meaningful. */
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

export function Sparkline(props: SparklineProps) {
  const {
    points, band, width = 96, height = 26, color, fill = true,
    threshold, showEndDot = true, domain, ariaLabel, className, style,
  } = props;

  const ref = useRef<HTMLSpanElement>(null);
  const theme = useTheme(ref);

  const values = useMemo<(number | null)[]>(
    () => points.map((p) => (typeof p === 'number' || p === null ? p : (p as SeriesPoint).v)),
    [points],
  );

  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const stroke = color ?? theme.css('accent');

  const [lo, hi] = useMemo<[number, number]>(() => {
    if (domain) return domain;
    let a = finite.length ? Math.min(...finite) : 0;
    let b = finite.length ? Math.max(...finite) : 1;
    for (const x of band ?? []) {
      if (x.lo !== null && Number.isFinite(x.lo)) a = Math.min(a, x.lo);
      if (x.hi !== null && Number.isFinite(x.hi)) b = Math.max(b, x.hi);
    }
    if (threshold !== null && threshold !== undefined) { a = Math.min(a, threshold); b = Math.max(b, threshold); }
    return a === b ? [a - 1, b + 1] : [a, b];
  }, [domain, finite, band, threshold]);

  const pad = 3;
  const x = scaleLinear().domain([0, Math.max(1, values.length - 1)]).range([pad, width - pad]);
  const y = scaleLinear().domain([lo, hi]).range([height - pad, pad]);

  if (!finite.length) {
    return <span ref={ref} className={className} style={{ display: 'inline-block', inlineSize: width, blockSize: height, ...style }} />;
  }

  const data = values.map((v, i) => ({ i, v }));
  const mkLine = line<{ i: number; v: number | null }>()
    .defined((d) => d.v !== null && Number.isFinite(d.v))
    .x((d) => x(d.i))
    .y((d) => y(d.v as number))
    .curve(curveMonotoneX);
  const mkFill = area<{ i: number; v: number | null }>()
    .defined((d) => d.v !== null && Number.isFinite(d.v))
    .x((d) => x(d.i))
    .y0(height - pad)
    .y1((d) => y(d.v as number))
    .curve(curveMonotoneX);
  const mkBand = area<{ i: number; lo: number | null; hi: number | null }>()
    .defined((d) => d.lo !== null && d.hi !== null)
    .x((d) => x(d.i))
    .y0((d) => y(d.lo as number))
    .y1((d) => y(d.hi as number))
    .curve(curveMonotoneX);

  let lastIdx = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null && Number.isFinite(values[i] as number)) { lastIdx = i; break; }
  }

  return (
    <span
      ref={ref}
      className={className}
      style={{ display: 'inline-block', lineHeight: 0, ...style }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel ?? `Trend, ${finite.length} points`}
        style={{ overflow: 'visible' }}
      >
        {band?.length ? (
          <path
            d={mkBand(band.map((b, i) => ({ i, lo: b.lo, hi: b.hi }))) ?? ''}
            fill={stroke}
            opacity={0.14}
          />
        ) : null}
        {fill && <path d={mkFill(data) ?? ''} fill={stroke} opacity={0.1} />}
        {threshold !== null && threshold !== undefined && (
          <line
            x1={0} x2={width} y1={y(threshold)} y2={y(threshold)}
            stroke={theme.css('sev-warning')} strokeWidth={1} strokeDasharray="3 3" opacity={0.8}
          />
        )}
        <path
          d={mkLine(data) ?? ''}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {showEndDot && lastIdx >= 0 && (
          <circle
            cx={x(lastIdx)}
            cy={y(values[lastIdx] as number)}
            r={2.6}
            fill={stroke}
            stroke={theme.css('surface')}
            strokeWidth={2}
          />
        )}
      </svg>
    </span>
  );
}
