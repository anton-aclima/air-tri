/**
 * SeasonalStrip / CalendarHeat — the campaign, day by day.
 *
 * Two forms of the same data, for two questions:
 *   SeasonalStrip — a continuous barcode. "When did it get bad?" Reads as a
 *                   season at a glance and fits in a card header.
 *   CalendarHeat  — weeks × weekdays. "Is it a weekday thing?" The grid exposes
 *                   the weekly cycle a strip hides.
 *
 * Both are heatmaps, so both use one ordered ramp and both carry a scale legend.
 */

import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { SeriesPoint } from '@/core/types';
import { fmtDay, fmtNum, isoDate } from '@/core/format';
import { useTheme } from '../lib/theme';
import { makeColorScale, robustDomain } from '../lib/scales';
import type { RampName } from '../lib/scales';
import { ChartFrame, ChartTooltip, EmptyPlot, TableTwin } from './primitives';
import { useSize } from '../lib/useSize';
import s from './chart.module.css';
import c from './SeasonalStrip.module.css';

interface CommonProps {
  points: SeriesPoint[];
  domain?: [number, number];
  ramp?: RampName;
  unit?: string;
  decimals?: number;
  title?: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  /** Vertical rules with labels — advisories, mitigations, scenario fires. */
  markers?: { t: string; label: string; color?: string }[];
  onDayClick?(t: string): void;
  showTable?: boolean;
  showScale?: boolean;
  className?: string;
  style?: CSSProperties;
}

export interface SeasonalStripProps extends CommonProps {
  height?: number;
  /** Month ticks under the strip. Default true. */
  monthTicks?: boolean;
}

export function SeasonalStrip(props: SeasonalStripProps) {
  const {
    points, domain, ramp = 'map', unit = '', decimals = 1, height = 34,
    monthTicks = true, title, subtitle, aside, markers, onDayClick,
    showTable = true, showScale = true, className, style,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useTheme(rootRef);
  const [wrapRef, size] = useSize<HTMLDivElement>({ width: 520, height });
  const [hover, setHover] = useState<number | null>(null);

  const scale = useMemo(
    () => makeColorScale(theme, {
      domain: domain ?? robustDomain(points.map((p) => p.v)),
      ramp,
    }),
    [theme, domain, points, ramp],
  );

  if (!points.length) {
    return (
      <ChartFrame title={title} subtitle={subtitle} aside={aside} className={className} style={style}>
        <EmptyPlot height={height + 20} />
      </ChartFrame>
    );
  }

  const width = Math.max(120, size.width || 520);
  const cellW = width / points.length;

  // Only label the first day of a month, and only when it will not collide.
  const monthMarks = monthTicks
    ? points.reduce<{ i: number; label: string }[]>((acc, p, i) => {
      const d = new Date(p.t);
      if (Number.isNaN(d.getTime())) return acc;
      if (d.getDate() <= 1 || i === 0) {
        const label = d.toLocaleDateString('en-US', { month: 'short' });
        if (!acc.length || i - acc[acc.length - 1].i > 26 / cellW * 1.2) acc.push({ i, label });
      }
      return acc;
    }, [])
    : [];

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      aside={aside}
      footer={showTable ? (
        <TableTwin
          columns={['Day', `Value${unit ? ` (${unit})` : ''}`]}
          rows={points.map((p) => [isoDate(p.t), p.v === null ? '—' : fmtNum(p.v, decimals)])}
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
            height={height + (monthTicks ? 15 : 0)}
            viewBox={`0 0 ${width} ${height + (monthTicks ? 15 : 0)}`}
            role="img"
            aria-label={`Daily intensity across ${points.length} days`}
            onPointerLeave={() => setHover(null)}
          >
            {points.map((p, i) => (
              <rect
                key={p.t + i}
                x={i * cellW}
                y={0}
                width={Math.max(0.8, cellW - (cellW > 3 ? 0.6 : 0))}
                height={height}
                fill={p.v === null ? theme.css('line') : scale.css(p.v)}
                opacity={hover === null || hover === i ? 1 : 0.62}
                onPointerEnter={() => setHover(i)}
                onClick={() => onDayClick?.(p.t)}
                style={{ cursor: onDayClick ? 'pointer' : 'default' }}
              />
            ))}

            {hover !== null && (
              <rect
                x={hover * cellW - 0.5} y={-1}
                width={Math.max(2, cellW + 1)} height={height + 2}
                fill="none" stroke={theme.css('ink')} strokeWidth={1.5}
              />
            )}

            {markers?.map((mk) => {
              const idx = points.findIndex((p) => isoDate(p.t) === isoDate(mk.t));
              if (idx < 0) return null;
              return (
                <g key={mk.t + mk.label}>
                  <line
                    x1={idx * cellW + cellW / 2} x2={idx * cellW + cellW / 2}
                    y1={-3} y2={height + 3}
                    stroke={mk.color ?? theme.css('ink')} strokeWidth={1.5}
                  />
                  <circle
                    cx={idx * cellW + cellW / 2} cy={-3} r={3}
                    fill={mk.color ?? theme.css('ink')}
                    stroke={theme.css('surface')} strokeWidth={1.5}
                  />
                </g>
              );
            })}

            {monthMarks.map((mk) => (
              <text
                key={mk.i}
                className={s.tick}
                x={mk.i * cellW + 1}
                y={height + 12}
                textAnchor="start"
              >
                {mk.label}
              </text>
            ))}
          </svg>

          {hover !== null && (
            <ChartTooltip
              x={hover * cellW}
              y={height + 4}
              head={fmtDay(points[hover].t)}
              rows={[{
                id: 'v',
                label: 'value',
                value: points[hover].v === null ? '—' : `${fmtNum(points[hover].v, decimals)}${unit ? ` ${unit}` : ''}`,
                color: points[hover].v === null ? theme.css('line') : scale.css(points[hover].v),
              }]}
              width={width}
            />
          )}
        </div>

        {showScale && <ScaleKey stops={scale.stops} lo={scale.domain[0]} hi={scale.domain[1]} unit={unit} decimals={decimals} />}
      </div>
    </ChartFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────

export interface CalendarHeatProps extends CommonProps {
  /** Cell edge in px. Default 13. */
  cell?: number;
  /** Weekday row labels. Default true. */
  weekdayLabels?: boolean;
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function CalendarHeat(props: CalendarHeatProps) {
  const {
    points, domain, ramp = 'map', unit = '', decimals = 1, cell = 13,
    weekdayLabels = true, title, subtitle, aside, onDayClick,
    showTable = true, showScale = true, className, style,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useTheme(rootRef);
  const [hover, setHover] = useState<string | null>(null);

  const scale = useMemo(
    () => makeColorScale(theme, {
      domain: domain ?? robustDomain(points.map((p) => p.v)),
      ramp,
    }),
    [theme, domain, points, ramp],
  );

  const cells = useMemo(() => {
    const rows = points
      .map((p) => ({ p, d: new Date(p.t) }))
      .filter((r) => !Number.isNaN(r.d.getTime()))
      .sort((a, b) => a.d.getTime() - b.d.getTime());
    if (!rows.length) return { items: [], weeks: 0, monthMarks: [] as { week: number; label: string }[] };

    const first = rows[0].d;
    // Align the grid to the Sunday on or before the first day.
    const origin = new Date(first);
    origin.setDate(origin.getDate() - origin.getDay());

    const monthMarks: { week: number; label: string }[] = [];
    let lastMonth = -1;
    const items = rows.map((r) => {
      const days = Math.floor((r.d.getTime() - origin.getTime()) / 86_400_000);
      const week = Math.floor(days / 7);
      const dow = r.d.getDay();
      if (r.d.getMonth() !== lastMonth) {
        lastMonth = r.d.getMonth();
        monthMarks.push({ week, label: r.d.toLocaleDateString('en-US', { month: 'short' }) });
      }
      return { t: r.p.t, v: r.p.v, week, dow, date: r.d };
    });
    return { items, weeks: Math.max(...items.map((i) => i.week)) + 1, monthMarks };
  }, [points]);

  if (!cells.items.length) {
    return (
      <ChartFrame title={title} subtitle={subtitle} aside={aside} className={className} style={style}>
        <EmptyPlot height={cell * 7 + 24} />
      </ChartFrame>
    );
  }

  const pad = 2;
  const left = weekdayLabels ? 16 : 0;
  const top = 14;
  const width = left + cells.weeks * (cell + pad);
  const height = top + 7 * (cell + pad);
  const hovered = cells.items.find((i) => i.t === hover) ?? null;

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      aside={aside}
      footer={showTable ? (
        <TableTwin
          columns={['Day', `Value${unit ? ` (${unit})` : ''}`]}
          rows={points.map((p) => [isoDate(p.t), p.v === null ? '—' : fmtNum(p.v, decimals)])}
        />
      ) : undefined}
      className={className}
      style={style}
    >
      <div ref={rootRef} className={s.scrollX}>
        <div className={s.plotWrap} style={{ inlineSize: width }}>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className={s.plot}
            role="img"
            aria-label={`Day-by-day calendar over ${cells.weeks} weeks`}
            onPointerLeave={() => setHover(null)}
          >
            {weekdayLabels && WEEKDAYS.map((w, i) => (
              i % 2 === 1 ? (
                <text
                  key={i}
                  className={s.tick}
                  x={left - 5}
                  y={top + i * (cell + pad) + cell * 0.78}
                  textAnchor="end"
                >{w}</text>
              ) : null
            ))}
            {cells.monthMarks.map((mk) => (
              <text
                key={`${mk.week}-${mk.label}`}
                className={s.tick}
                x={left + mk.week * (cell + pad)}
                y={9}
                textAnchor="start"
              >{mk.label}</text>
            ))}
            {cells.items.map((it) => (
              <rect
                key={it.t}
                x={left + it.week * (cell + pad)}
                y={top + it.dow * (cell + pad)}
                width={cell}
                height={cell}
                rx={2.5}
                fill={it.v === null ? theme.css('surface-2') : scale.css(it.v)}
                stroke={hover === it.t ? theme.css('ink') : 'none'}
                strokeWidth={1.5}
                onPointerEnter={() => setHover(it.t)}
                onClick={() => onDayClick?.(it.t)}
                style={{ cursor: onDayClick ? 'pointer' : 'default' }}
              />
            ))}
          </svg>

          {hovered && (
            <ChartTooltip
              x={left + hovered.week * (cell + pad)}
              y={top + hovered.dow * (cell + pad) + cell}
              head={fmtDay(hovered.t)}
              rows={[{
                id: 'v',
                label: 'value',
                value: hovered.v === null ? '—' : `${fmtNum(hovered.v, decimals)}${unit ? ` ${unit}` : ''}`,
                color: hovered.v === null ? theme.css('line') : scale.css(hovered.v),
              }]}
              width={width}
            />
          )}
        </div>
        {showScale && <ScaleKey stops={scale.stops} lo={scale.domain[0]} hi={scale.domain[1]} unit={unit} decimals={decimals} />}
      </div>
    </ChartFrame>
  );
}

/** Every heatmap ships with a scale legend. Non-negotiable for a value ramp. */
export function ScaleKey(p: {
  stops: string[];
  lo: number;
  hi: number;
  unit?: string;
  decimals?: number;
}) {
  const { stops, lo, hi, unit = '', decimals = 1 } = p;
  return (
    <div className={c.scaleKey}>
      <span className={c.scaleNum}>{fmtNum(lo, decimals)}</span>
      <span className={c.scaleBar} style={{ background: `linear-gradient(90deg, ${stops.join(', ')})` }} />
      <span className={c.scaleNum}>{fmtNum(hi, decimals)}{unit ? ` ${unit}` : ''}</span>
    </div>
  );
}
