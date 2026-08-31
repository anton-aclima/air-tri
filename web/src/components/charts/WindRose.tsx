/**
 * WindRose — where the wind comes from, and how often.
 *
 * Two jobs, one component:
 *  1. A plain rose from observations or a pre-binned frequency list.
 *  2. **Two roses superimposed** — the consultant's *assumed* rose as a dashed
 *     reference outline, our *observed* rose filled underneath. That single
 *     picture is the "verify your consultant" argument: the gap between the
 *     outline and the fill is the part of the study that was wrong.
 *
 * Meteorological convention throughout: `dir_deg` is the direction the wind blows
 * FROM, and the petals point that way.
 */

import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { WindPoint } from '@/core/types';
import { compassPoint, fmtNum } from '@/core/format';
import { useTheme } from '../lib/theme';
import { makeColorScale } from '../lib/scales';
import { ChartFrame, EmptyPlot, Legend, TableTwin } from './primitives';
import type { LegendSeries } from './primitives';
import s from './chart.module.css';
import w from './WindRose.module.css';

/** The shape `ModelVerification.observed_wind` / `assumed_wind` already use. */
export interface RoseBin { dir_deg: number; freq: number; mean_speed_ms: number }

export interface WindRoseProps {
  /** Raw observations — binned internally. */
  points?: WindPoint[];
  /** Pre-binned frequencies. Wins over `points` when both are given. */
  rose?: RoseBin[];
  /** A second rose, drawn as a dashed reference outline over the first. */
  compare?: RoseBin[];
  compareLabel?: string;
  roseLabel?: string;
  sectors?: 8 | 16;
  /** Speed bin edges in m/s, for the stacked form. */
  speedBins?: number[];
  size?: number;
  /** 'speed' stacks petals by speed band; 'freq' draws one petal per sector. */
  mode?: 'speed' | 'freq';
  title?: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  /** Warn when the sample is thin. Pass `n_obs`. */
  nObs?: number | null;
  showTable?: boolean;
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_BINS = [0, 1.5, 3, 5, 8];

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function petal(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M ${x0} ${y0} A ${r1} ${r1} 0 0 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 0 0 ${x3} ${y3} Z`;
}

export function WindRose(props: WindRoseProps) {
  const {
    points, rose, compare, compareLabel = 'Assumed', roseLabel = 'Observed',
    sectors = 16, speedBins = DEFAULT_BINS, size = 220, mode = 'speed',
    title, subtitle, aside, nObs, showTable = true, className, style,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useTheme(rootRef);
  const [hover, setHover] = useState<number | null>(null);

  const step = 360 / sectors;

  /** Stacked speed bands per sector, from raw observations. */
  const stacked = useMemo(() => {
    if (!points?.length || mode !== 'speed') return null;
    const grid: number[][] = Array.from({ length: sectors }, () => speedBins.map(() => 0));
    let total = 0;
    for (const p of points) {
      if (!Number.isFinite(p.dir_deg) || !Number.isFinite(p.speed_ms)) continue;
      const sec = Math.round((((p.dir_deg % 360) + 360) % 360) / step) % sectors;
      let bi = 0;
      for (let i = 0; i < speedBins.length; i++) if (p.speed_ms >= speedBins[i]) bi = i;
      grid[sec][bi] += 1;
      total += 1;
    }
    if (!total) return null;
    return { grid: grid.map((row) => row.map((n) => n / total)), total };
  }, [points, mode, sectors, speedBins, step]);

  /** Simple per-sector frequency, from `rose` or from raw observations. */
  const freq = useMemo<RoseBin[] | null>(() => {
    if (rose?.length) return rose;
    if (!points?.length) return null;
    const counts = Array.from({ length: sectors }, () => ({ n: 0, sum: 0 }));
    for (const p of points) {
      if (!Number.isFinite(p.dir_deg)) continue;
      const sec = Math.round((((p.dir_deg % 360) + 360) % 360) / step) % sectors;
      counts[sec].n += 1;
      counts[sec].sum += p.speed_ms ?? 0;
    }
    const total = counts.reduce((t, c) => t + c.n, 0) || 1;
    return counts.map((c, i) => ({
      dir_deg: i * step,
      freq: c.n / total,
      mean_speed_ms: c.n ? c.sum / c.n : 0,
    }));
  }, [rose, points, sectors, step]);

  const maxFreq = useMemo(() => {
    let mx = 0;
    if (stacked) for (const row of stacked.grid) mx = Math.max(mx, row.reduce((t, v) => t + v, 0));
    for (const b of freq ?? []) mx = Math.max(mx, b.freq);
    for (const b of compare ?? []) mx = Math.max(mx, b.freq);
    return mx || 0.2;
  }, [stacked, freq, compare]);

  if (!freq && !stacked) {
    return (
      <ChartFrame title={title} subtitle={subtitle} aside={aside} className={className} style={style}>
        <EmptyPlot height={size} label="No wind data" />
      </ChartFrame>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const rMax = size / 2 - 20;
  const rr = (f: number) => (Math.max(0, f) / (maxFreq * 1.08)) * rMax;

  const speedScale = makeColorScale(theme, {
    domain: [speedBins[0], speedBins[speedBins.length - 1] + 3],
    ramp: 'intensity',
  });

  const gridRings = [0.33, 0.66, 1].map((k) => maxFreq * 1.08 * k);

  /** The comparison rose as one closed outline — a shape, not more petals. */
  const compareOutline = useMemo(() => {
    if (!compare?.length) return null;
    const pts = [...compare]
      .sort((a, b) => a.dir_deg - b.dir_deg)
      .map((b) => polar(cx, cy, rr(b.freq), b.dir_deg));
    if (pts.length < 3) return null;
    return `M ${pts.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join(' L ')} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare, cx, cy, maxFreq, rMax]);

  const legend: LegendSeries[] = compare?.length
    ? [
      { id: 'obs', label: roseLabel, color: theme.css('accent'), shape: 'rect' },
      { id: 'asm', label: compareLabel, color: theme.css('ink-2'), shape: 'dash' },
    ]
    : mode === 'speed' && stacked
      ? speedBins.map((b, i) => ({
        id: `b${i}`,
        label: i === speedBins.length - 1 ? `${b}+ m/s` : `${b}–${speedBins[i + 1]} m/s`,
        color: speedScale.css(b + 0.4),
        shape: 'rect' as const,
      }))
      : [];

  const thin = nObs !== null && nObs !== undefined && nObs < 40;

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      aside={aside}
      legend={<Legend series={legend} />}
      footer={showTable ? (
        <TableTwin
          columns={compare?.length
            ? ['Direction', `${roseLabel} %`, `${compareLabel} %`, 'Δ pts']
            : ['Direction', 'Frequency %', 'Mean speed (m/s)']}
          rows={(freq ?? []).map((b) => {
            const cmp = compare?.find((x) => Math.abs(x.dir_deg - b.dir_deg) < step / 2);
            return compare?.length
              ? [
                compassPoint(b.dir_deg),
                fmtNum(b.freq * 100, 1),
                cmp ? fmtNum(cmp.freq * 100, 1) : '—',
                cmp ? fmtNum((b.freq - cmp.freq) * 100, 1) : '—',
              ]
              : [compassPoint(b.dir_deg), fmtNum(b.freq * 100, 1), fmtNum(b.mean_speed_ms, 1)];
          })}
          label="Show wind table"
        />
      ) : undefined}
      className={className}
      style={style}
    >
      <div ref={rootRef} style={{ display: 'grid', justifyItems: 'center', gap: 'var(--s-2)' }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className={s.plot}
          style={{ inlineSize: size, maxInlineSize: '100%' }}
          role="img"
          aria-label={`Wind rose, ${sectors} sectors${compare?.length ? `, ${roseLabel} against ${compareLabel}` : ''}`}
          onPointerLeave={() => setHover(null)}
        >
          {/* frequency rings + their labels */}
          {gridRings.map((f, i) => (
            <g key={f}>
              <circle cx={cx} cy={cy} r={rr(f)} fill="none" stroke={theme.css('line')} strokeWidth={1} />
              {i === gridRings.length - 1 && (
                <text className={s.tick} x={cx + 3} y={cy - rr(f) + 9}>
                  {Math.round(f * 100)}%
                </text>
              )}
            </g>
          ))}
          {Array.from({ length: sectors }, (_, i) => i * step).map((deg) => {
            const [x1, y1] = polar(cx, cy, rMax, deg);
            return <line key={deg} x1={cx} y1={cy} x2={x1} y2={y1} stroke={theme.css('line')} strokeWidth={0.6} />;
          })}

          {/* petals */}
          {stacked ? (
            stacked.grid.map((row, sec) => {
              let acc = 0;
              return (
                <g key={sec} onPointerEnter={() => setHover(sec)}>
                  {row.map((v, bi) => {
                    if (v <= 0) return null;
                    const r0 = rr(acc);
                    acc += v;
                    const r1 = rr(acc);
                    return (
                      <path
                        key={bi}
                        d={petal(cx, cy, r0, r1, sec * step - step * 0.42, sec * step + step * 0.42)}
                        fill={speedScale.css(speedBins[bi] + 0.4)}
                        stroke={theme.css('surface')}
                        strokeWidth={1}
                        opacity={hover === null || hover === sec ? 1 : 0.55}
                      />
                    );
                  })}
                </g>
              );
            })
          ) : (
            (freq ?? []).map((b, i) => (
              <path
                key={b.dir_deg}
                d={petal(cx, cy, 0, rr(b.freq), b.dir_deg - step * 0.42, b.dir_deg + step * 0.42)}
                fill={theme.css('accent')}
                opacity={hover === null || hover === i ? 0.78 : 0.4}
                stroke={theme.css('surface')}
                strokeWidth={1}
                onPointerEnter={() => setHover(i)}
              />
            ))
          )}

          {/* the consultant's assumed rose, as a reference outline */}
          {compareOutline && (
            <path
              d={compareOutline}
              fill="none"
              stroke={theme.css('ink-2')}
              strokeWidth={1.8}
              strokeDasharray="5 4"
              strokeLinejoin="round"
            />
          )}

          {/* cardinals */}
          {[['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([lab, deg]) => {
            const [tx, ty] = polar(cx, cy, rMax + 11, deg as number);
            return (
              <text
                key={lab as string}
                className={`${s.tick} ${s.tickStrong}`}
                x={tx} y={ty}
                textAnchor="middle" dy="0.34em"
                fontWeight={700}
              >{lab}</text>
            );
          })}
        </svg>

        {hover !== null && freq?.[hover] && (
          <span className={w.readout}>
            {compassPoint(freq[hover].dir_deg)} · {fmtNum(freq[hover].freq * 100, 1)}%
            {' · '}{fmtNum(freq[hover].mean_speed_ms, 1)} m/s
          </span>
        )}
        {thin && (
          <span className={w.caution}>
            ◆ {nObs} observations — treat as indicative
          </span>
        )}
      </div>
    </ChartFrame>
  );
}
