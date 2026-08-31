/**
 * AlertTimeline — how long has this been up?
 *
 * The industry interface needs duration to be a *shape*, not a timestamp you have
 * to subtract. One row per contact, a bar spanning start → end, and an open bar
 * with a live edge for anything still running. Severity carries colour AND a
 * glyph, so nothing depends on hue alone.
 */

import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { scaleTime } from 'd3-scale';
import type { Alert, Severity } from '@/core/types';
import { SEVERITY_LABEL, severityRank, severityVar } from '@/core/measures';
import { fmtTime24, fmtDay, fmtDurationMin, fmtStamp } from '@/core/format';
import { useNow, usePulse } from '../lib/anim';
import { ALERT_KIND_CODE, SEVERITY_GLYPH } from '../lib/vizmeta';
import { ChartFrame, ChartTooltip, EmptyPlot, TableTwin, useChart } from './primitives';
import type { Margins } from './primitives';
import s from './chart.module.css';
import a from './AlertTimeline.module.css';

export interface TimelineAlert {
  id: string;
  label: string;
  code?: string;
  severity: Severity;
  startedAt: string;
  /** null = still up. Draws an open bar with a live edge. */
  endedAt?: string | null;
  acknowledged?: boolean;
}

export interface AlertTimelineProps {
  alerts: TimelineAlert[];
  /** Window start. Default the earliest alert. */
  from?: string;
  /** Window end. Default now. */
  to?: string;
  rowHeight?: number;
  /** Cap the rows drawn; the rest fold into a "+N more" line. Default 8. */
  maxRows?: number;
  selectedId?: string | null;
  onSelect?(id: string | null): void;
  title?: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  /** Show the row labels on the left. Off gives a pure ribbon. */
  labels?: boolean;
  showTable?: boolean;
  margin?: Partial<Margins>;
  className?: string;
  style?: CSSProperties;
}

/** `GET /alerts` rows → timeline rows. */
export function timelineFromAlerts(alerts: Alert[]): TimelineAlert[] {
  return alerts.map((x) => ({
    id: x.id,
    label: x.title,
    code: ALERT_KIND_CODE[x.kind] ?? x.kind.slice(0, 4).toUpperCase(),
    severity: x.severity,
    startedAt: x.started_at,
    endedAt: x.ended_at,
    acknowledged: x.status === 'acknowledged',
  }));
}

/**
 * Squeeze an alert title into the ribbon's narrow label gutter.
 *
 * A blind `slice(0, 10)` cut words in half and left no sign it had done so, so
 * the axis read "BC HIGHES", "CH4 METHAN", "MEASUR" — which looks like a
 * spelling bug rather than a truncation. Break on a word boundary where one is
 * close enough to be worth it, and always mark the cut.
 */
function shortLabel(label: string, max = 11): string {
  const clean = label.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const stem = space >= max - 4 ? cut.slice(0, space) : cut.slice(0, max - 1);
  return `${stem.replace(/[\s,.;:-]+$/, '')}\u2026`;
}

export function AlertTimeline(props: AlertTimelineProps) {
  const {
    alerts, from, to, rowHeight = 22, maxRows = 8,
    selectedId, onSelect, title, subtitle, aside,
    labels = true, showTable = true, margin, className, style,
  } = props;

  const now = useNow(30_000);
  const pulse = usePulse(1600);
  const [hover, setHover] = useState<string | null>(null);

  const rows = useMemo(
    () => [...alerts].sort((x, y) => {
      const live = Number(!y.endedAt) - Number(!x.endedAt);
      if (live !== 0) return live;
      const sev = severityRank(y.severity) - severityRank(x.severity);
      if (sev !== 0) return sev;
      return Date.parse(y.startedAt) - Date.parse(x.startedAt);
    }),
    [alerts],
  );
  const shown = rows.slice(0, maxRows);
  const hidden = rows.length - shown.length;

  const labelW = labels ? 92 : 8;
  const height = Math.max(58, shown.length * rowHeight + 26);
  const { rootRef, wrapRef, theme, width, innerW, margin: m } = useChart({
    height,
    margin: { top: 6, right: margin?.right ?? 10, bottom: 20, left: labelW },
  });

  const [t0, t1] = useMemo<[number, number]>(() => {
    const starts = rows.map((r) => Date.parse(r.startedAt)).filter(Number.isFinite);
    const ends = rows.map((r) => (r.endedAt ? Date.parse(r.endedAt) : now)).filter(Number.isFinite);
    const lo = from ? Date.parse(from) : (starts.length ? Math.min(...starts) : now - 6 * 3.6e6);
    const hi = to ? Date.parse(to) : (ends.length ? Math.max(...ends, now) : now);
    // Always leave a sliver of future so a live bar's edge is visible.
    const pad = Math.max((hi - lo) * 0.03, 60_000);
    return [lo, hi + pad];
  }, [rows, from, to, now]);

  const x = useMemo(() => scaleTime().domain([t0, t1]).range([0, innerW]), [t0, t1, innerW]);
  const spanH = (t1 - t0) / 3.6e6;
  const ticks = x.ticks(Math.max(2, Math.floor(innerW / 92)));

  /**
   * Label a tick with its date only when the date changes.
   *
   * `x.ticks()` picks a sensible *interval*, which over a three-to-seven day
   * span is six hours — but the label was chosen from the span alone, so every
   * one of those ticks printed `fmtDay`, and the axis read
   * "Aug 24 · Aug 24 · Aug 24 · Aug 24 · Aug 25 · …". The date belongs on the
   * first tick of each day; the ticks in between should say what they actually
   * are, which is a time.
   */
  const tickLabel = (d: Date, i: number, arr: Date[]): string => {
    if (spanH <= 48) return fmtTime24(d);
    const day = fmtDay(d);
    if (i === 0 || day !== fmtDay(arr[i - 1])) return day;
    return fmtTime24(d);
  };

  if (!alerts.length) {
    return (
      <ChartFrame title={title} subtitle={subtitle} aside={aside} className={className} style={style}>
        <EmptyPlot height={72} label="No alerts in window" />
      </ChartFrame>
    );
  }

  const hovered = shown.find((r) => r.id === hover) ?? null;
  const barH = Math.min(11, rowHeight - 9);

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      aside={aside}
      footer={showTable ? (
        <TableTwin
          columns={['Alert', 'Severity', 'Started', 'Duration']}
          rows={rows.map((r) => [
            r.label,
            SEVERITY_LABEL[r.severity],
            fmtStamp(r.startedAt),
            fmtDurationMin(((r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(r.startedAt)) / 60000),
          ])}
          label="Show alert table"
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
            aria-label={`${rows.length} alerts over ${fmtDurationMin(spanH * 60)}`}
            onPointerLeave={() => setHover(null)}
          >
            <g transform={`translate(${m.left},${m.top})`}>
              {/* time grid: solid hairlines */}
              {ticks.map((d) => (
                <line
                  key={d.getTime()}
                  x1={x(d)} x2={x(d)} y1={0} y2={shown.length * rowHeight}
                  stroke={theme.css('line')} strokeWidth={1} shapeRendering="crispEdges"
                />
              ))}

              {/* now */}
              <line
                x1={x(now)} x2={x(now)} y1={-4} y2={shown.length * rowHeight + 2}
                stroke={theme.css('accent')} strokeWidth={1.5}
              />
              <text className={s.tick} x={x(now)} y={-1} textAnchor="middle" fill={theme.css('accent')}>
                now
              </text>

              {shown.map((r, i) => {
                const st = Date.parse(r.startedAt);
                const en = r.endedAt ? Date.parse(r.endedAt) : now;
                const live = !r.endedAt;
                const y0 = i * rowHeight + (rowHeight - barH) / 2;
                const bx = Math.max(0, x(st));
                const bw = Math.max(2.5, x(en) - bx);
                const col = severityVar(r.severity);
                const on = r.id === hover || r.id === selectedId;
                return (
                  <g
                    key={r.id}
                    className={s.markFocus}
                    tabIndex={onSelect ? 0 : -1}
                    role={onSelect ? 'button' : undefined}
                    aria-label={`${r.label}, ${SEVERITY_LABEL[r.severity]}, ${live ? 'still up' : 'ended'}, ${fmtDurationMin((en - st) / 60000)}`}
                    onPointerEnter={() => setHover(r.id)}
                    onFocus={() => setHover(r.id)}
                    onClick={() => onSelect?.(r.id === selectedId ? null : r.id)}
                    style={{ cursor: onSelect ? 'pointer' : 'default' }}
                  >
                    {/* full-row hit target, ≥24px tall in practice */}
                    <rect x={-m.left} y={i * rowHeight} width={innerW + m.left} height={rowHeight} fill="transparent" />

                    {labels && (
                      <text
                        className={a.rowLabel}
                        x={-8} y={i * rowHeight + rowHeight / 2}
                        dy="0.34em"
                        textAnchor="end"
                        fill={on ? theme.css('ink') : theme.css('ink-2')}
                      >
                        {r.code ?? shortLabel(r.label)}
                      </text>
                    )}

                    {/* the duration bar: 4px rounded ends, square where it is open */}
                    <rect
                      x={bx} y={y0}
                      width={bw} height={barH}
                      rx={3}
                      fill={col}
                      opacity={r.acknowledged ? 0.5 : on ? 1 : 0.88}
                    />
                    {/* severity glyph inside the bar when it fits, else beside it */}
                    {bw > 16 ? (
                      <text
                        x={bx + 4} y={y0 + barH / 2} dy="0.33em"
                        className={a.glyph}
                        fill={theme.css('bg-sunk')}
                      >{SEVERITY_GLYPH[r.severity]}</text>
                    ) : null}

                    {/* live edge: an open bar with a breathing cap */}
                    {live && (
                      <>
                        <rect
                          x={bx + bw - 2} y={y0 - 2}
                          width={2.5} height={barH + 4}
                          fill={col}
                          opacity={0.5 + pulse * 0.5}
                        />
                        <circle
                          cx={bx + bw} cy={y0 + barH / 2}
                          r={2.6 + pulse * 2.4}
                          fill="none" stroke={col}
                          strokeWidth={1.2}
                          opacity={0.8 * (1 - pulse)}
                        />
                      </>
                    )}
                  </g>
                );
              })}

              {ticks.map((d, i) => (
                <text
                  key={`t${d.getTime()}`}
                  className={s.tick}
                  x={x(d)} y={shown.length * rowHeight + 14}
                  textAnchor="middle"
                >
                  {tickLabel(d, i, ticks)}
                </text>
              ))}
            </g>
          </svg>

          {hovered && (
            <ChartTooltip
              x={m.left + Math.max(0, x(Date.parse(hovered.startedAt)))}
              y={m.top + shown.indexOf(hovered) * rowHeight}
              head={hovered.label}
              rows={[
                {
                  id: 'sev',
                  label: 'severity',
                  value: `${SEVERITY_GLYPH[hovered.severity]} ${SEVERITY_LABEL[hovered.severity]}`,
                  color: severityVar(hovered.severity),
                },
                {
                  id: 'dur',
                  label: hovered.endedAt ? 'lasted' : 'up for',
                  value: fmtDurationMin(
                    ((hovered.endedAt ? Date.parse(hovered.endedAt) : now) - Date.parse(hovered.startedAt)) / 60000,
                  ),
                  color: theme.css('ink-3'),
                },
                { id: 'start', label: 'started', value: fmtStamp(hovered.startedAt), color: theme.css('ink-3') },
              ]}
              width={width}
            />
          )}
        </div>
        {hidden > 0 && <span className={s.capLabel}>+{hidden} more not shown</span>}
      </div>
    </ChartFrame>
  );
}
