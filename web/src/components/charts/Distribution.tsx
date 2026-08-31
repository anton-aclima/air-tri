/**
 * Distribution — "where does this street sit?"
 *
 * A concentration on its own is meaningless to almost everyone. The same number
 * plus the campaign's whole distribution and a marker answers the question the
 * reader actually has: is my street unusual?
 *
 * One hue (magnitude is ordered), a 2px surface gap between bars, and the one
 * bar the reader cares about is emphasised while the rest stay context.
 */

import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { bin, quantile } from 'd3-array';
import { scaleLinear } from 'd3-scale';
import { fmtNum } from '@/core/format';
import { makeColorScale } from '../lib/scales';
import type { RampName } from '../lib/scales';
import { ChartFrame, ChartTooltip, EmptyPlot, TableTwin, useChart } from './primitives';
import type { Margins } from './primitives';
import s from './chart.module.css';

export interface DistributionProps {
  /** Every segment's value across the campaign. */
  values: number[];
  /** The one segment the reader is looking at. */
  marker?: number | null;
  markerLabel?: string;
  /** Supply to skip recomputing it from `values`. 0–100. */
  percentile?: number | null;
  bins?: number;
  height?: number;
  unit?: string;
  decimals?: number;
  ramp?: RampName;
  /** Colour each bar by its own value. Off = one hue, emphasis on the marker. */
  colorByValue?: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  showTable?: boolean;
  margin?: Partial<Margins>;
  className?: string;
  style?: CSSProperties;
}

export function Distribution(props: DistributionProps) {
  const {
    values, marker, markerLabel = 'this street', percentile,
    bins = 22, height = 150, unit = '', decimals = 1, ramp = 'map',
    colorByValue = true, title, subtitle, aside, showTable = true,
    margin, className, style,
  } = props;

  const { rootRef, wrapRef, theme, width, innerW, innerH, margin: m } = useChart({
    height, margin: { ...(margin ?? {}), left: margin?.left ?? 30, bottom: margin?.bottom ?? 24 },
  });
  const [hover, setHover] = useState<number | null>(null);

  const clean = useMemo(
    () => values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b),
    [values],
  );

  const buckets = useMemo(() => {
    if (!clean.length) return [];
    const lo = clean[0];
    const hi = clean[clean.length - 1];
    return bin<number, number>()
      .domain([lo, hi === lo ? lo + 1 : hi])
      .thresholds(bins)(clean);
  }, [clean, bins]);

  const pct = useMemo(() => {
    if (percentile !== null && percentile !== undefined) return percentile;
    if (marker === null || marker === undefined || !clean.length) return null;
    let below = 0;
    for (const v of clean) { if (v <= marker) below++; else break; }
    return (below / clean.length) * 100;
  }, [percentile, marker, clean]);

  if (!clean.length) {
    return (
      <ChartFrame title={title} subtitle={subtitle} aside={aside} className={className} style={style}>
        <EmptyPlot height={height} />
      </ChartFrame>
    );
  }

  const lo = buckets[0]?.x0 ?? clean[0];
  const hi = buckets[buckets.length - 1]?.x1 ?? clean[clean.length - 1];
  const maxCount = Math.max(...buckets.map((b) => b.length), 1);

  const x = scaleLinear().domain([lo, hi]).range([0, innerW]);
  const y = scaleLinear().domain([0, maxCount]).range([innerH, 0]);
  const scale = makeColorScale(theme, { domain: [lo, hi], ramp });

  const markerBin = marker === null || marker === undefined
    ? -1
    : buckets.findIndex((b) => marker >= (b.x0 ?? 0) && marker < (b.x1 ?? 0));

  const median = quantile(clean, 0.5) ?? 0;
  const gap = 2; // the surface gap does the separating, never a stroke

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      aside={aside}
      footer={showTable ? (
        <TableTwin
          columns={[`Range${unit ? ` (${unit})` : ''}`, 'Segments']}
          rows={buckets.map((b) => [
            `${fmtNum(b.x0 ?? 0, decimals)}–${fmtNum(b.x1 ?? 0, decimals)}`,
            b.length,
          ])}
          label="Show distribution table"
        />
      ) : undefined}
      className={className}
      style={style}
    >
      <div ref={rootRef}>
        <div ref={wrapRef} className={s.plotWrap}>
          <svg
            className={s.plot}
            width="100%"
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={
              marker !== null && marker !== undefined && pct !== null
                ? `Distribution of ${clean.length} segments. ${markerLabel} is at ${fmtNum(marker, decimals)} ${unit}, the ${Math.round(pct)}th percentile.`
                : `Distribution of ${clean.length} segments.`
            }
            onPointerLeave={() => setHover(null)}
          >
            <g transform={`translate(${m.left},${m.top})`}>
              {buckets.map((b, i) => {
                const bx = x(b.x0 ?? 0);
                const bw = Math.max(1, x(b.x1 ?? 0) - bx - gap);
                const bh = innerH - y(b.length);
                const mid = ((b.x0 ?? 0) + (b.x1 ?? 0)) / 2;
                const isMarker = i === markerBin;
                const dim = markerBin >= 0 && !isMarker;
                const rTop = Math.min(4, bw / 2, bh);
                return (
                  <g key={i} onPointerEnter={() => setHover(i)}>
                    <rect x={bx} y={0} width={bw + gap} height={innerH} fill="transparent" />
                    {/* 4px rounded data-end, square at the baseline */}
                    <path
                      className={s.mark}
                      d={bh <= 0.6
                        ? `M ${bx} ${innerH} h ${bw} v -0.6 h ${-bw} Z`
                        : `M ${bx} ${innerH} V ${y(b.length) + rTop} `
                          + `Q ${bx} ${y(b.length)} ${bx + rTop} ${y(b.length)} `
                          + `H ${bx + bw - rTop} Q ${bx + bw} ${y(b.length)} ${bx + bw} ${y(b.length) + rTop} `
                          + `V ${innerH} Z`}
                      fill={colorByValue ? scale.css(mid) : theme.css('accent')}
                      opacity={dim ? 0.38 : hover === i ? 1 : 0.92}
                    />
                  </g>
                );
              })}

              {/* the campaign median: context, in ink not a series colour */}
              <line
                x1={x(median)} x2={x(median)} y1={0} y2={innerH}
                stroke={theme.css('ink-3')} strokeWidth={1} strokeDasharray="3 3"
              />
              <text className={s.tick} x={x(median)} y={-1} textAnchor="middle">
                median
              </text>

              {/* the marker: direct-labelled, because it is the whole point */}
              {marker !== null && marker !== undefined && (
                <g>
                  <line
                    x1={x(marker)} x2={x(marker)} y1={-2} y2={innerH}
                    stroke={theme.css('ink')} strokeWidth={2}
                  />
                  <circle
                    cx={x(marker)} cy={-2} r={4}
                    fill={theme.css('ink')}
                    stroke={theme.css('surface')}
                    strokeWidth={2}
                  />
                </g>
              )}

              <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke={theme.css('line')} strokeWidth={1} />

              {[lo, (lo + hi) / 2, hi].map((v, i) => (
                <text
                  key={v}
                  className={s.tick}
                  x={x(v)} y={innerH + 13}
                  textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
                >
                  {fmtNum(v, decimals)}{i === 2 && unit ? ` ${unit}` : ''}
                </text>
              ))}
            </g>
          </svg>

          {hover !== null && buckets[hover] && (
            <ChartTooltip
              x={m.left + x(((buckets[hover].x0 ?? 0) + (buckets[hover].x1 ?? 0)) / 2)}
              y={m.top + y(buckets[hover].length)}
              head={`${fmtNum(buckets[hover].x0 ?? 0, decimals)}–${fmtNum(buckets[hover].x1 ?? 0, decimals)}${unit ? ` ${unit}` : ''}`}
              rows={[{
                id: 'n',
                label: 'segments',
                value: String(buckets[hover].length),
                color: scale.css(((buckets[hover].x0 ?? 0) + (buckets[hover].x1 ?? 0)) / 2),
              }]}
              width={width}
            />
          )}
        </div>

        {marker !== null && marker !== undefined && pct !== null && (
          <p className={s.subtitle} style={{ marginBlockStart: 'var(--s-2)' }}>
            <strong style={{ color: 'var(--ink)' }}>{markerLabel}</strong> sits at the{' '}
            <strong style={{ color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}>
              {Math.round(pct)}
              {pct % 10 === 1 && pct !== 11 ? 'st' : pct % 10 === 2 && pct !== 12 ? 'nd' : pct % 10 === 3 && pct !== 13 ? 'rd' : 'th'}
            </strong>{' '}
            percentile of {clean.length} monitored segments.
          </p>
        )}
      </div>
    </ChartFrame>
  );
}
