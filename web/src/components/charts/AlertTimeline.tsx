/**
 * AlertTimeline — how long has this been up?
 *
 * The industry interface needs duration to be a *shape*, not a timestamp you have
 * to subtract. One row per alert, a bar spanning start → end, and an open bar
 * with a live edge for anything still running. Severity carries colour AND a
 * glyph, so nothing depends on hue alone.
 *
 * "Now" is the demo's now, and replay rewinds the rows (docs/PLAN-refocus.md
 * F2): an alert that had not begun at the moment shown is not drawn, and one
 * that ended after it was still running then, so it draws open, to "now".
 */

import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { scaleTime } from 'd3-scale';
import type { Alert, Severity } from '@/core/types';
import { SEVERITY_LABEL, severityRank, severityVar } from '@/core/measures';
import { parseCampaign } from '@/core/clock';
import { hasStarted, isOngoing } from '@/core/events';
import { fmtTime24, fmtDay, fmtDurationMin, fmtStamp } from '@/core/format';
import { useNowCampaign } from '@/core/session';
import { usePulse } from '../lib/anim';
import { SEVERITY_GLYPH } from '../lib/vizmeta';
import { ChartFrame, ChartTooltip, EmptyPlot, TableTwin, useChart } from './primitives';
import type { Margins } from './primitives';
import s from './chart.module.css';
import a from './AlertTimeline.module.css';

export interface TimelineAlert {
  id: string;
  label: string;
  /** A short row label for the gutter. Omitted, the label is shortened on a word break. */
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

/**
 * `GET /alerts` rows → timeline rows.
 *
 * No `code`: the gutter used to print the four-letter kind codes (EXCD, DOSE)
 * from the retired radar dial, which PLAN-refocus I11 takes out of user copy.
 * The row reads the alert's own title, shortened on a word break.
 */
export function timelineFromAlerts(alerts: Alert[]): TimelineAlert[] {
  return alerts.map((x) => ({
    id: x.id,
    label: x.title,
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

/**
 * `shortLabel` for a "what · where" row: the part after the last ` · ` is
 * where the alert is ("NNW", "site-wide") and survives whole; only the part
 * before it is shortened. Cutting from the right, as `shortLabel` alone does,
 * kept the word everyone could guess and dropped the one that said where —
 * "Reports ·…", "Wind · sit…".
 */
function fitLabel(label: string, max: number): string {
  const clean = label.trim();
  if (clean.length <= max) return clean;
  const at = clean.lastIndexOf(' \u00b7 ');
  if (at > 0) {
    const tail = clean.slice(at + 3);
    const room = max - tail.length - 3;
    if (room >= 3) return `${shortLabel(clean.slice(0, at), room)} \u00b7 ${tail}`;
  }
  return shortLabel(clean, max);
}

/**
 * The gutter's type: `--text-3xs` (10px) mono at 0.05em tracking — about
 * 6.5px a character, rounded up so a measured-to-fit label never clips.
 */
const GUTTER_CHAR_PX = 6.6;
/** Room around the gutter's text: the 8px gap to the bars and a little air. */
const GUTTER_PAD_PX = 14;
/** The gutter never narrows below the old fixed width, nor eats the plot. */
const GUTTER_MIN_PX = 92;
const GUTTER_MAX_PX = 140;

/** Local-epoch ms of a naive timestamp: the axis `scaleTime` draws on. */
const tMs = (t: string) => parseCampaign(t).getTime();

export function AlertTimeline(props: AlertTimelineProps) {
  const {
    alerts, from, to, rowHeight = 22, maxRows = 8,
    selectedId, onSelect, title, subtitle, aside,
    labels = true, showTable = true, margin, className, style,
  } = props;

  const nowAt = useNowCampaign();
  const now = tMs(nowAt);
  const pulse = usePulse(1600);
  const [hover, setHover] = useState<string | null>(null);

  const rows = useMemo(
    () => alerts
      .filter((r) => hasStarted({ started_at: r.startedAt }, nowAt))
      .map((r) => (r.endedAt && isOngoing({ started_at: r.startedAt, ended_at: r.endedAt }, nowAt)
        ? { ...r, endedAt: null } : r))
      .sort((x, y) => {
        const live = Number(!y.endedAt) - Number(!x.endedAt);
        if (live !== 0) return live;
        const sev = severityRank(y.severity) - severityRank(x.severity);
        if (sev !== 0) return sev;
        return tMs(y.startedAt) - tMs(x.startedAt);
      }),
    [alerts, nowAt],
  );
  const shown = rows.slice(0, maxRows);
  const hidden = rows.length - shown.length;

  // The gutter fits its labels, between the old fixed 92px and a cap, so a
  // row's "where" is not cut to make room for nothing. Callers that pass a
  // short `code` (the regulator) keep exactly the gutter they had.
  const wanted = labels
    ? Math.max(0, ...shown.map((r) => (r.code ?? r.label.trim()).length))
    : 0;
  const labelW = labels
    ? Math.min(GUTTER_MAX_PX, Math.max(GUTTER_MIN_PX, Math.ceil(wanted * GUTTER_CHAR_PX) + GUTTER_PAD_PX))
    : 8;
  const labelChars = Math.max(4, Math.floor((labelW - GUTTER_PAD_PX) / GUTTER_CHAR_PX));
  const height = Math.max(58, shown.length * rowHeight + 26);
  const { rootRef, wrapRef, theme, width, innerW, margin: m } = useChart({
    height,
    margin: { top: 6, right: margin?.right ?? 10, bottom: 20, left: labelW },
  });

  const [t0, t1] = useMemo<[number, number]>(() => {
    const starts = rows.map((r) => tMs(r.startedAt)).filter(Number.isFinite);
    const ends = rows.map((r) => (r.endedAt ? tMs(r.endedAt) : now)).filter(Number.isFinite);
    const lo = from ? tMs(from) : (starts.length ? Math.min(...starts) : now - 6 * 3.6e6);
    const hi = to ? tMs(to) : (ends.length ? Math.max(...ends, now) : now);
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

  if (!rows.length) {
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
            fmtDurationMin(((r.endedAt ? tMs(r.endedAt) : now) - tMs(r.startedAt)) / 60000),
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
                const st = tMs(r.startedAt);
                const en = r.endedAt ? tMs(r.endedAt) : now;
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
                    aria-label={`${r.label}, ${SEVERITY_LABEL[r.severity]}, ${live ? 'ongoing' : 'ended'}, ${fmtDurationMin((en - st) / 60000)}`}
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
                        {r.code ?? fitLabel(r.label, labelChars)}
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
              x={m.left + Math.max(0, x(tMs(hovered.startedAt)))}
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
                  // "ongoing", the Phase 2 word for begun-and-not-ended
                  // (`isOngoing`); "up for" was the cockpit's (I11).
                  label: hovered.endedAt ? 'lasted' : 'ongoing for',
                  value: fmtDurationMin(
                    ((hovered.endedAt ? tMs(hovered.endedAt) : now) - tMs(hovered.startedAt)) / 60000,
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
