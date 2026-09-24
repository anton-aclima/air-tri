/**
 * TimeSeries — the regulator's core read.
 *
 * A concentration trace is only half the story; the other half is *where the
 * tripwires are*. So action levels are first-class: each one draws a dashed rule
 * in its severity colour and shades every stretch of time the series spent above
 * it. An exceedance stops being a number you look up and becomes a shape.
 *
 *   band  → p10–p90, a 12% wash (uncertainty, not a series)
 *   line  → the median, 2px
 *   rule  → an action level; dashed *because* it is a threshold, not a gridline
 *   shade → time spent over that action level
 *
 * Timestamps are naive campaign time (core/clock). They are read with
 * `parseCampaign`, so a date-only daily point is local midnight rather than the
 * UTC midnight `Date.parse` gives (the evening before, in the Americas), and a
 * brush hands back naive strings — `toISOString()` wrote UTC, and the server
 * then served a window hours away from the one selected.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { scaleLinear, scaleTime } from 'd3-scale';
import { area, curveMonotoneX, line } from 'd3-shape';
import type { SeriesPoint, Severity } from '@/core/types';
import { parseCampaign, toCampaign } from '@/core/clock';
import { severityVar } from '@/core/measures';
import { fmtNum, fmtDay, fmtTime24 } from '@/core/format';
import { niceTicks } from '../lib/vizmeta';
import {
  AxisBottom, AxisLeft, ChartFrame, ChartTooltip, EmptyPlot, GridLines, Legend,
  TableTwin, useChart, useCrosshair,
} from './primitives';
import type { LegendSeries, Margins, TipRow } from './primitives';
import s from './chart.module.css';

/** Local-epoch ms of a naive timestamp: the axis `scaleTime` draws on. */
const tMs = (t: string) => parseCampaign(t).getTime();

export interface BandPoint { t: string; lo: number | null; hi: number | null }

export interface TimeSeriesSeries {
  id: string;
  label: string;
  /** Resolved colour. Omit to take the next fixed categorical hue. */
  color?: string;
  points: SeriesPoint[];
  /** p10–p90 (or any interval) drawn as a wash under the line. */
  band?: BandPoint[];
  /** Draw the line dashed — for modelled or provisional series. */
  dashed?: boolean;
  hidden?: boolean;
}

export interface TimeSeriesThreshold {
  id: string;
  label: string;
  value: number;
  severity?: Severity;
  /** Shade the time spent above this level. Default true. */
  shade?: boolean;
}

/** Naive campaign time, ready for a `from`/`to` query param. */
export interface TimeSeriesRange { from: string; to: string }

export interface TimeSeriesProps {
  series: TimeSeriesSeries[];
  thresholds?: TimeSeriesThreshold[];
  height?: number;
  unit?: string;
  decimals?: number;
  yDomain?: [number, number];
  /** Force the y-axis to include zero. Default true for concentrations. */
  yZero?: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  /** Drag to select a time range. */
  brushable?: boolean;
  brush?: TimeSeriesRange | null;
  onBrush?(range: TimeSeriesRange | null): void;
  /** Which series the exceedance shading follows. Default the first visible. */
  exceedanceSeriesId?: string;
  /** Hourly data gets a clock on the axis, daily gets a date. */
  xFormat?(d: Date): string;
  showTable?: boolean;
  margin?: Partial<Margins>;
  className?: string;
  style?: CSSProperties;
}

export function TimeSeries(props: TimeSeriesProps) {
  const {
    series, thresholds = [], height = 200, unit = '', decimals = 1,
    yDomain, yZero = true, title, subtitle, aside,
    brushable = false, brush, onBrush, exceedanceSeriesId,
    xFormat, showTable = true, margin, className, style,
  } = props;

  const { rootRef, wrapRef, theme, width, innerW, innerH, margin: m } = useChart({
    height, margin: { ...(margin ?? {}), left: margin?.left ?? 42 },
  });

  const [muted, setMuted] = useState<Set<string>>(() => new Set());
  const shown = series.filter((x) => !x.hidden && !muted.has(x.id));

  // Colour follows the ENTITY, never its rank: the hue index comes from the
  // series' position in the full list, so hiding one never repaints the others.
  const colorOf = useCallback((id: string) => {
    const declared = series.find((x) => x.id === id)?.color;
    if (declared) return declared;
    const i = series.findIndex((x) => x.id === id);
    const pal = theme.categorical;
    return pal[(i < 0 ? 0 : i) % Math.max(1, pal.length)] ?? theme.css('accent');
  }, [series, theme]);

  const times = useMemo(() => {
    const all: number[] = [];
    for (const x of series) for (const p of x.points) {
      const t = tMs(p.t);
      if (Number.isFinite(t)) all.push(t);
    }
    return all;
  }, [series]);

  const anchor = shown[0] ?? series[0];
  const stamps = useMemo(
    () => (anchor?.points ?? []).map((p) => tMs(p.t)).filter(Number.isFinite),
    [anchor],
  );

  const yExtent = useMemo<[number, number]>(() => {
    if (yDomain) return yDomain;
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of shown) {
      for (const p of x.points) if (p.v !== null && Number.isFinite(p.v)) {
        lo = Math.min(lo, p.v); hi = Math.max(hi, p.v);
      }
      for (const b of x.band ?? []) {
        if (b.lo !== null && Number.isFinite(b.lo)) lo = Math.min(lo, b.lo);
        if (b.hi !== null && Number.isFinite(b.hi)) hi = Math.max(hi, b.hi);
      }
    }
    // Thresholds belong inside the frame — a tripwire off-screen is useless.
    for (const t of thresholds) { lo = Math.min(lo, t.value); hi = Math.max(hi, t.value); }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (yZero) lo = Math.min(0, lo);
    const pad = (hi - lo) * 0.08 || 1;
    return [lo, hi + pad];
  }, [shown, thresholds, yDomain, yZero]);

  const x = useMemo(() => scaleTime()
    .domain(times.length ? [Math.min(...times), Math.max(...times)] : [0, 1])
    .range([0, innerW]), [times, innerW]);
  const y = useMemo(() => scaleLinear().domain(yExtent).range([innerH, 0]).nice(), [yExtent, innerH]);

  const yTicks = useMemo(() => niceTicks(y.domain()[0], y.domain()[1], 4), [y]);
  const xTicks = useMemo(() => x.ticks(Math.max(2, Math.floor(innerW / 88))).map((d) => d.getTime()), [x, innerW]);

  const spanHours = times.length ? (Math.max(...times) - Math.min(...times)) / 3.6e6 : 0;
  const fmtX = xFormat ?? ((d: Date) => (spanHours <= 72 ? fmtTime24(d) : fmtDay(d)));

  const xOf = useCallback((i: number) => x(stamps[i] ?? 0), [x, stamps]);
  const { hover, ref: svgRef, handlers } = useCrosshair(stamps.length, xOf);

  // ── brush ───────────────────────────────────────────────────────────────
  const dragFrom = useRef<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);

  const onDown = (e: React.PointerEvent<SVGRectElement>) => {
    if (!brushable) return;
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    dragFrom.current = e.clientX - box.left - m.left;
    setDragTo(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onDrag = (e: React.PointerEvent<SVGRectElement>) => {
    if (dragFrom.current === null) return;
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    setDragTo(e.clientX - box.left - m.left);
  };
  const onUp = () => {
    const a = dragFrom.current;
    dragFrom.current = null;
    if (a === null || dragTo === null) { setDragTo(null); return; }
    const [p0, p1] = [Math.min(a, dragTo), Math.max(a, dragTo)];
    setDragTo(null);
    // A flick without a drag clears the selection rather than making a 3px one.
    if (p1 - p0 < 6) { onBrush?.(null); return; }
    onBrush?.({
      from: toCampaign(x.invert(Math.max(0, p0))),
      to: toCampaign(x.invert(Math.min(innerW, p1))),
    });
  };

  const brushRect = useMemo(() => {
    if (dragFrom.current !== null && dragTo !== null) {
      const [a, b] = [Math.min(dragFrom.current, dragTo), Math.max(dragFrom.current, dragTo)];
      return { x0: Math.max(0, a), x1: Math.min(innerW, b), live: true };
    }
    if (brush) {
      const a = x(tMs(brush.from));
      const b = x(tMs(brush.to));
      if (Number.isFinite(a) && Number.isFinite(b)) {
        return { x0: Math.min(a, b), x1: Math.max(a, b), live: false };
      }
    }
    return null;
  }, [dragTo, brush, x, innerW]);

  // ── exceedance runs ─────────────────────────────────────────────────────
  const exceedance = useMemo(() => {
    const src = exceedanceSeriesId
      ? series.find((v) => v.id === exceedanceSeriesId)
      : shown[0];
    if (!src) return [];
    const out: { id: string; x0: number; x1: number; color: string }[] = [];
    for (const th of thresholds) {
      if (th.shade === false) continue;
      const color = severityVar(th.severity ?? 'warning');
      let start: number | null = null;
      src.points.forEach((p, i) => {
        const over = p.v !== null && Number.isFinite(p.v) && p.v > th.value;
        const t = tMs(p.t);
        if (over && start === null) start = t;
        if (!over && start !== null) {
          out.push({ id: `${th.id}-${i}`, x0: x(start), x1: x(t), color });
          start = null;
        }
      });
      if (start !== null) {
        const last = tMs(src.points[src.points.length - 1].t);
        out.push({ id: `${th.id}-end`, x0: x(start), x1: x(last), color });
      }
    }
    return out;
  }, [series, shown, thresholds, exceedanceSeriesId, x]);

  if (!series.length || !times.length) {
    return (
      <ChartFrame title={title} subtitle={subtitle} aside={aside} className={className} style={style}>
        <EmptyPlot height={height} />
      </ChartFrame>
    );
  }

  const mkLine = line<{ t: number; v: number | null }>()
    .defined((d) => d.v !== null && Number.isFinite(d.v))
    .x((d) => x(d.t))
    .y((d) => y(d.v as number))
    .curve(curveMonotoneX);

  const mkBand = area<{ t: number; lo: number | null; hi: number | null }>()
    .defined((d) => d.lo !== null && d.hi !== null)
    .x((d) => x(d.t))
    .y0((d) => y(d.lo as number))
    .y1((d) => y(d.hi as number))
    .curve(curveMonotoneX);

  const legendItems: LegendSeries[] = [
    ...series.map((v) => ({
      id: v.id, label: v.label, color: colorOf(v.id),
      shape: 'line' as const, muted: muted.has(v.id) || v.hidden,
    })),
    ...thresholds.map((t) => ({
      id: t.id, label: t.label, color: severityVar(t.severity ?? 'warning'),
      shape: 'dash' as const,
    })),
  ];

  const tipRows: TipRow[] = hover
    ? shown.map((v) => {
      const p = v.points[hover.index];
      return {
        id: v.id,
        label: v.label,
        value: p?.v === null || p?.v === undefined ? '—' : `${fmtNum(p.v, decimals)}${unit ? ` ${unit}` : ''}`,
        color: colorOf(v.id),
      };
    })
    : [];

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      aside={aside}
      legend={<Legend series={legendItems} onToggle={(id) => setMuted((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      })} />}
      footer={showTable ? (
        <TableTwin
          columns={['Time', ...series.map((v) => `${v.label}${unit ? ` (${unit})` : ''}`)]}
          rows={(anchor?.points ?? []).map((p, i) => [
            fmtDay(p.t),
            ...series.map((v) => {
              const q = v.points[i];
              return q?.v === null || q?.v === undefined ? '—' : fmtNum(q.v, decimals);
            }),
          ])}
        />
      ) : undefined}
      className={className}
      style={style}
    >
      <div ref={rootRef}>
        <div ref={wrapRef} className={s.plotWrap}>
          <svg
            ref={svgRef}
            className={[s.plot, brushable ? s.hit : ''].filter(Boolean).join(' ')}
            width="100%"
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            tabIndex={0}
            role="img"
            aria-label={typeof title === 'string' ? title : 'Time series'}
            {...handlers}
          >
            <g transform={`translate(${m.left},${m.top})`}>
              {/* exceedance shading, under everything */}
              {exceedance.map((r) => (
                <rect
                  key={r.id}
                  x={r.x0} y={0}
                  width={Math.max(1, r.x1 - r.x0)} height={innerH}
                  fill={r.color} opacity={0.14}
                />
              ))}

              <GridLines theme={theme} x0={0} x1={innerW} values={yTicks} scale={(v) => y(v)} />

              {/* bands first: they are context, not a series */}
              {shown.map((v) => v.band?.length ? (
                <path
                  key={`${v.id}-band`}
                  d={mkBand(v.band.map((b) => ({ t: tMs(b.t), lo: b.lo, hi: b.hi }))) ?? ''}
                  fill={colorOf(v.id)}
                  opacity={0.12}
                />
              ) : null)}

              {/* action levels */}
              {thresholds.map((t) => {
                const ty = y(t.value);
                const color = severityVar(t.severity ?? 'warning');
                return (
                  <g key={t.id}>
                    <line
                      x1={0} x2={innerW} y1={ty} y2={ty}
                      stroke={color} strokeWidth={1.5} strokeDasharray="5 4"
                    />
                    <text
                      className={s.tick}
                      x={innerW - 2} y={ty - 4}
                      textAnchor="end"
                      fill={color}
                    >
                      {t.label}
                    </text>
                  </g>
                );
              })}

              {shown.map((v) => (
                <path
                  key={v.id}
                  d={mkLine(v.points.map((p) => ({ t: tMs(p.t), v: p.v }))) ?? ''}
                  fill="none"
                  stroke={colorOf(v.id)}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={v.dashed ? '6 4' : undefined}
                />
              ))}

              {/* brush selection */}
              {brushRect && (
                <rect
                  x={brushRect.x0} y={0}
                  width={Math.max(1, brushRect.x1 - brushRect.x0)} height={innerH}
                  fill={theme.css('accent')}
                  opacity={brushRect.live ? 0.16 : 0.1}
                  stroke={theme.css('accent')}
                  strokeWidth={1}
                />
              )}

              {/* crosshair + markers. 2px surface ring keeps a dot legible on a line. */}
              {hover && (
                <g pointerEvents="none">
                  <line
                    x1={hover.px} x2={hover.px} y1={0} y2={innerH}
                    stroke={theme.css('ink-3')} strokeWidth={1}
                  />
                  {shown.map((v) => {
                    const p = v.points[hover.index];
                    if (!p || p.v === null || !Number.isFinite(p.v)) return null;
                    return (
                      <circle
                        key={v.id}
                        cx={hover.px} cy={y(p.v)} r={4}
                        fill={colorOf(v.id)}
                        stroke={theme.css('surface')}
                        strokeWidth={2}
                      />
                    );
                  })}
                </g>
              )}

              <AxisLeft
                theme={theme} x={0} values={yTicks} scale={(v) => y(v)}
                format={(v) => fmtNum(v, v >= 100 ? 0 : decimals)}
                label={unit || undefined} labelY={-1}
              />
              <AxisBottom
                y={innerH} values={xTicks} scale={(v) => x(v)}
                format={(v) => fmtX(new Date(v))}
              />

              {/* hit surface last so it captures the pointer */}
              <rect
                x={0} y={0} width={innerW} height={innerH}
                fill="transparent"
                onPointerDown={onDown}
                onPointerMove={onDrag}
                onPointerUp={onUp}
                style={{ cursor: brushable ? 'crosshair' : 'default' }}
              />
            </g>
          </svg>

          {hover && tipRows.length > 0 && (
            <ChartTooltip
              x={hover.px + m.left}
              y={m.top}
              head={fmtDay(new Date(stamps[hover.index]))}
              rows={tipRows}
              width={width}
            />
          )}
        </div>
      </div>
    </ChartFrame>
  );
}
