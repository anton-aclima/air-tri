/**
 * DiurnalClock — the 24-hour fingerprint, as a clock.
 *
 * The diurnal pattern is one of the few things about a street that is genuinely
 * *diagnostic*: a morning-and-evening double hump is traffic, a flat overnight
 * plateau is a generator running all night. A bar chart hides that; a clock makes
 * it a silhouette you can recognise at a glance.
 *
 * Midnight sits at the top and hours run clockwise, like a watch face, with the
 * night hours washed so the working day reads as the lit part of the dial.
 *
 *   wedge radius → magnitude at that hour
 *   wedge hue    → the same magnitude on the role ramp (ordered scale, so hue
 *                  reinforces rather than misstates)
 *   annulus      → p10–p90 spread for the hour
 *   spline       → the median profile, closed, so the shape is the signature
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { scaleLinear } from 'd3-scale';
import { curveCardinalClosed, lineRadial } from 'd3-shape';
import type { MeasureDef, SeriesPoint } from '@/core/types';
import { fmtNum, fmtHourLabel } from '@/core/format';
import { plainName, unitFor } from '@/core/measures';
import { useTheme } from '../lib/theme';
import { makeColorScale } from '../lib/scales';
import type { RampName } from '../lib/scales';
import { ChartFrame, EmptyPlot, TableTwin } from './primitives';
import s from './chart.module.css';

export interface DiurnalBand { lo: number | null; hi: number | null }

export interface DiurnalClockProps {
  /** 24 values. `SeriesPoint[]` (t = 'hour:HH' or an ISO stamp) or plain numbers. */
  points: SeriesPoint[] | (number | null)[];
  /** Per-hour spread, aligned to `points`. */
  band?: DiurnalBand[];
  size?: number;
  measure?: MeasureDef | null;
  unit?: string;
  decimals?: number;
  domain?: [number, number];
  ramp?: RampName;
  /** 'area' varies the radius (default). 'ring' is a constant-radius heat ring. */
  mode?: 'area' | 'ring';
  /** Reference level — draws a labelled circle, the "over this is a problem" line. */
  refLevel?: number | null;
  /** Community framing: plain name, no units. */
  plainLanguage?: boolean;
  /** Call out the peak hour with a direct label. Default true. */
  labelPeak?: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  showTable?: boolean;
  onHourClick?(hour: number): void;
  className?: string;
  style?: CSSProperties;
}

/** Night hours get a wash: 21:00–05:00. Reinforces "this is a day". */
const NIGHT_FROM = 21;
const NIGHT_TO = 5;

/** θ in degrees, 0 = midnight at the top, increasing clockwise. */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function ringPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r1} ${r1} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 ${large} 0 ${x3} ${y3} Z`;
}

/**
 * Place each point on the 24-hour dial by the hour it actually belongs to.
 *
 * Three label formats reach this chart and all three are legitimate:
 *   `"hour:03"`             — a `segment_stat` window key
 *   `"03"`                  — what `GET /segments/{id}` sends in `diurnal`
 *   `"2026-08-28T03:00:00"` — a raw reading timestamp
 *
 * The bare-hour form used to fall through to `new Date("03")`, which does not
 * parse, and then to the point's **array index** — so a series that only
 * carries the hours it has data for (the `diurnal` payload is sparse; four
 * populated hours out of twenty-four is normal) drew its 18:00 value at 03:00.
 * Silently, at plausible-looking positions, on a chart whose whole job is
 * telling you *when* something peaks.
 *
 * An index is never a defensible guess at an hour, so an unparseable label now
 * drops the point instead. A gap in the dial is honest; a value in the wrong
 * place is not.
 */
function toValues(points: DiurnalClockProps['points']): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: 24 }, () => null);
  points.forEach((p, i) => {
    if (p === null || p === undefined) return;
    // A bare number[] is positional by definition — 24 values, midnight first.
    if (typeof p === 'number') { out[i % 24] = p; return; }
    const sp = p as SeriesPoint;
    const label = (sp.t ?? '').trim();

    let hour: number | null = null;
    const tagged = /hour:(\d{1,2})/.exec(label);
    if (tagged) {
      hour = Number(tagged[1]) % 24;
    } else if (/^\d{1,2}$/.test(label)) {
      hour = Number(label) % 24;
    } else {
      const d = new Date(label);
      if (!Number.isNaN(d.getTime())) hour = d.getHours();
    }
    if (hour === null) return;
    out[hour] = sp.v;
  });
  return out;
}

export function DiurnalClock(props: DiurnalClockProps) {
  const {
    points, band, size = 240, measure, unit: unitProp, decimals: decProp,
    domain, ramp = 'map', mode = 'area', refLevel, plainLanguage = false,
    labelPeak = true, title, subtitle, aside, showTable = true,
    onHourClick, className, style,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useTheme(rootRef);
  const [hover, setHover] = useState<number | null>(null);

  const values = useMemo(() => toValues(points), [points]);
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));

  const unit = plainLanguage ? '' : (unitProp ?? unitFor(measure ?? undefined));
  const decimals = decProp ?? measure?.decimals ?? 1;
  const name = measure ? plainName(measure, plainLanguage ? 'community' : null) : null;

  const extent = useMemo<[number, number]>(() => {
    if (domain) return domain;
    let hi = finite.length ? Math.max(...finite) : 1;
    for (const b of band ?? []) if (b.hi !== null && Number.isFinite(b.hi)) hi = Math.max(hi, b.hi);
    if (refLevel !== null && refLevel !== undefined) hi = Math.max(hi, refLevel);
    return [0, hi * 1.06 || 1];
  }, [domain, finite, band, refLevel]);

  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 24;
  const rInner = rOuter * 0.34;
  const r = useMemo(
    () => scaleLinear().domain(extent).range([rInner, rOuter]).clamp(true),
    [extent, rInner, rOuter],
  );
  const color = useMemo(() => makeColorScale(theme, { domain: extent, ramp }), [theme, extent, ramp]);

  const step = 360 / 24;
  const gap = 1.4;

  const peak = useMemo(() => {
    let best = -1;
    let bestV = -Infinity;
    values.forEach((v, h) => { if (v !== null && v > bestV) { bestV = v; best = h; } });
    return best >= 0 ? { hour: best, value: bestV } : null;
  }, [values]);

  const radialTicks = useMemo(() => {
    const [, hi] = extent;
    return [hi * 0.33, hi * 0.66, hi].map((v) => Number(v.toFixed(2)));
  }, [extent]);

  const spline = useMemo(() => {
    const pts: [number, number][] = [];
    values.forEach((v, h) => {
      if (v === null || !Number.isFinite(v)) return;
      pts.push([((h + 0.5) * step * Math.PI) / 180, r(v)]);
    });
    if (pts.length < 3) return null;
    return lineRadial<[number, number]>()
      .angle((d) => d[0])
      .radius((d) => d[1])
      .curve(curveCardinalClosed.tension(0.62))(pts);
  }, [values, r, step]);

  const onKey = useCallback((e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setHover((h) => (((h ?? -1) + (e.key === 'ArrowRight' ? 1 : -1) + 24) % 24));
    } else if (e.key === 'Escape') setHover(null);
  }, []);

  if (!finite.length) {
    return (
      <ChartFrame title={title} subtitle={subtitle} aside={aside} className={className} style={style}>
        <EmptyPlot height={size} label="No diurnal data" />
      </ChartFrame>
    );
  }

  const hv = hover !== null ? values[hover] : null;

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      aside={aside}
      footer={showTable ? (
        <TableTwin
          columns={['Hour', `${name ?? 'Value'}${unit ? ` (${unit})` : ''}`]}
          rows={values.map((v, h) => [
            `${String(h).padStart(2, '0')}:00`,
            v === null ? '—' : fmtNum(v, decimals),
          ])}
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
          tabIndex={0}
          role="img"
          aria-label={`24-hour profile${name ? ` for ${name}` : ''}. Peak at ${peak ? fmtHourLabel(peak.hour) : 'unknown'}.`}
          onKeyDown={onKey}
          onPointerLeave={() => setHover(null)}
        >
          {/* night wash — the dial's own dark side */}
          <path
            d={ringPath(cx, cy, rInner * 0.62, rOuter + 9, NIGHT_FROM * step, (24 + NIGHT_TO) * step)}
            fill={theme.css('ink-3')}
            opacity={theme.dark ? 0.1 : 0.07}
          />

          {/* concentric value grid: solid hairlines, recessive */}
          {radialTicks.map((v) => (
            <circle
              key={v}
              cx={cx} cy={cy} r={r(v)}
              fill="none"
              stroke={theme.css('line')}
              strokeWidth={1}
            />
          ))}
          <circle cx={cx} cy={cy} r={rInner} fill="none" stroke={theme.css('line')} strokeWidth={1} />

          {/* the reference level — "over this is a problem" */}
          {refLevel !== null && refLevel !== undefined && (
            <g>
              <circle
                cx={cx} cy={cy} r={r(refLevel)}
                fill="none"
                stroke={theme.css('sev-warning')}
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
              <text
                className={s.tick}
                x={cx + 4} y={cy - r(refLevel) - 3}
                fill={theme.css('sev-warning')}
              >
                ref
              </text>
            </g>
          )}

          {/* p10–p90 spread */}
          {band?.length ? (
            <g>
              {band.map((b, h) => {
                if (b.lo === null || b.hi === null) return null;
                return (
                  <path
                    key={h}
                    d={ringPath(cx, cy, r(b.lo), r(b.hi), h * step + gap, (h + 1) * step - gap)}
                    fill={theme.css('ink-2')}
                    opacity={0.16}
                  />
                );
              })}
            </g>
          ) : null}

          {/* the hours */}
          <g>
            {values.map((v, h) => {
              if (v === null || !Number.isFinite(v)) return null;
              const a0 = h * step + gap;
              const a1 = (h + 1) * step - gap;
              const rr = mode === 'ring' ? rOuter : r(v);
              const r0 = mode === 'ring' ? rOuter * 0.72 : rInner;
              const on = hover === h;
              return (
                <path
                  key={h}
                  className={s.mark}
                  d={ringPath(cx, cy, r0, rr, a0, a1)}
                  fill={color.css(v)}
                  opacity={hover === null || on ? 1 : 0.5}
                  stroke={on ? theme.css('ink') : theme.css('surface')}
                  strokeWidth={on ? 1.4 : 1}
                  onPointerEnter={() => setHover(h)}
                  onClick={() => onHourClick?.(h)}
                  style={{ cursor: onHourClick ? 'pointer' : 'default' }}
                />
              );
            })}
          </g>

          {/* the silhouette */}
          {spline && mode === 'area' && (
            <path
              d={spline}
              transform={`translate(${cx},${cy})`}
              fill="none"
              stroke={theme.css('ink')}
              strokeWidth={1.6}
              strokeLinejoin="round"
              opacity={0.55}
              pointerEvents="none"
            />
          )}

          {/* hour labels every three hours */}
          {Array.from({ length: 8 }, (_, i) => i * 3).map((h) => {
            const [tx, ty] = polar(cx, cy, rOuter + 15, (h + 0.5) * step);
            return (
              <text
                key={h}
                className={h === 0 || h === 12 ? `${s.tick} ${s.tickStrong}` : s.tick}
                x={tx} y={ty}
                textAnchor="middle"
                dy="0.34em"
                fontWeight={h === 0 || h === 12 ? 700 : 400}
              >
                {fmtHourLabel(h)}
              </text>
            );
          })}

          {/* radial tick values on the midnight spoke */}
          {radialTicks.map((v) => (
            <text key={`t${v}`} className={s.tick} x={cx + 3} y={cy - r(v) + 9} textAnchor="start">
              {fmtNum(v, v >= 100 ? 0 : 0)}
            </text>
          ))}

          {/* centre readout: the hovered hour, or the peak */}
          <g pointerEvents="none">
            <text
              x={cx} y={cy - 4}
              textAnchor="middle"
              fontFamily={theme.css('font-mono') || 'monospace'}
              fontSize={rInner * 0.46}
              fontWeight={600}
              fill={theme.css('ink')}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {hv !== null ? fmtNum(hv, decimals) : peak ? fmtNum(peak.value, decimals) : '—'}
            </text>
            <text
              x={cx} y={cy + rInner * 0.4}
              textAnchor="middle"
              className={s.tick}
              fill={theme.css('ink-3')}
            >
              {hover !== null
                ? `${String(hover).padStart(2, '0')}:00`
                : labelPeak && peak ? `peak ${fmtHourLabel(peak.hour)}` : (unit || '')}
            </text>
          </g>
        </svg>

        {unit && (
          <span className={s.capLabel}>
            {name ? `${name} · ` : ''}{unit}
          </span>
        )}
      </div>
    </ChartFrame>
  );
}
