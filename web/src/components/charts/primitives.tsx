/**
 * Chart primitives — the pieces every chart in this library is built from.
 *
 * Deliberately small and boring so that ten different charts end up looking like
 * one instrument family: hairline solid axes one step off the surface, 2px lines,
 * ≥8px markers with a 2px surface ring, a legend whenever there are two or more
 * series, and a table twin so no value is ever gated behind a hover.
 */

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTheme } from '../lib/theme';
import type { Theme } from '../lib/theme';
import { useSize } from '../lib/useSize';
import s from './chart.module.css';

// ───────────────────────────────────────────────────────────── frame

export interface Margins { top: number; right: number; bottom: number; left: number }

export const DEFAULT_MARGIN: Margins = { top: 8, right: 12, bottom: 22, left: 38 };

export interface ChartFrameProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Right-hand slot in the header — pickers, a hero value, a chip. */
  aside?: ReactNode;
  /** Rendered under the header, above the plot. Legends go here. */
  legend?: ReactNode;
  /** Rendered under the plot. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Header + plot + footer. Sized by its container, never a fixed height. */
export function ChartFrame(p: ChartFrameProps) {
  const { title, subtitle, aside, legend, footer, children, className, style } = p;
  return (
    <div className={[s.root, className].filter(Boolean).join(' ')} style={style}>
      {(title || subtitle || aside) && (
        <div className={s.head}>
          <div className={s.headText}>
            {title && <p className={s.title}>{title}</p>}
            {subtitle && <p className={s.subtitle}>{subtitle}</p>}
          </div>
          {aside}
        </div>
      )}
      {legend}
      {children}
      {footer}
    </div>
  );
}

/** Nothing to draw — say so, don't render an empty axis. */
export function EmptyPlot(p: { height?: number; label?: string }) {
  return (
    <div className={s.empty} style={{ minBlockSize: p.height ?? 90 }}>
      {p.label ?? 'No data'}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── legend

export interface LegendSeries {
  id: string;
  label: string;
  color: string;
  /** 'line' for lines, 'rect' for areas/bars, 'dash' for thresholds. */
  shape?: 'line' | 'rect' | 'dash';
  muted?: boolean;
}

export function Legend(p: {
  series: LegendSeries[];
  onToggle?(id: string): void;
  className?: string;
}) {
  const { series, onToggle, className } = p;
  // A single series needs no legend box: the title already names it.
  if (series.length < 2) return null;
  return (
    <div className={[s.legend, className].filter(Boolean).join(' ')}>
      {series.map((x) => {
        const key = (
          <span
            className={x.shape === 'rect' ? s.legendRect : x.shape === 'dash' ? s.legendDash : s.legendLine}
            style={x.shape === 'dash'
              ? { color: x.color, borderBlockStartStyle: 'dashed' }
              : { background: x.color }}
          />
        );
        const body = <>{key}{x.label}</>;
        return onToggle ? (
          <button
            key={x.id}
            type="button"
            className={[s.legendItem, s.legendItemButton, x.muted ? s.legendMuted : ''].filter(Boolean).join(' ')}
            aria-pressed={!x.muted}
            onClick={() => onToggle(x.id)}
          >
            {body}
          </button>
        ) : (
          <span
            key={x.id}
            className={[s.legendItem, x.muted ? s.legendMuted : ''].filter(Boolean).join(' ')}
          >
            {body}
          </span>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── axes

export function GridLines(p: {
  theme: Theme;
  x0: number; x1: number;
  values: number[];
  scale(v: number): number;
  orientation?: 'horizontal' | 'vertical';
  y0?: number; y1?: number;
}) {
  const { theme, x0, x1, values, scale, orientation = 'horizontal', y0 = 0, y1 = 0 } = p;
  const stroke = theme.css('line');
  return (
    <g aria-hidden="true">
      {values.map((v) => {
        const c = scale(v);
        return orientation === 'horizontal'
          ? <line key={v} x1={x0} x2={x1} y1={c} y2={c} stroke={stroke} strokeWidth={1} shapeRendering="crispEdges" />
          : <line key={v} x1={c} x2={c} y1={y0} y2={y1} stroke={stroke} strokeWidth={1} shapeRendering="crispEdges" />;
      })}
    </g>
  );
}

export function AxisLeft(p: {
  theme: Theme;
  x: number;
  values: number[];
  scale(v: number): number;
  format(v: number): string;
  label?: string;
  labelY?: number;
}) {
  const { theme, x, values, scale, format, label, labelY } = p;
  return (
    <g aria-hidden="true">
      {values.map((v) => (
        <text key={v} className={s.tick} x={x - 6} y={scale(v)} dy="0.32em" textAnchor="end">
          {format(v)}
        </text>
      ))}
      {label && (
        <text className={s.axisLabel} x={x - 6} y={labelY ?? 8} textAnchor="end" fill={theme.css('ink-3')}>
          {label}
        </text>
      )}
    </g>
  );
}

export function AxisBottom(p: {
  y: number;
  values: number[];
  scale(v: number): number;
  format(v: number): string;
  /** Skip labels that would collide, keeping first and last. */
  minGap?: number;
}) {
  const { y, values, scale, format, minGap = 34 } = p;
  const kept: number[] = [];
  let lastX = -Infinity;
  values.forEach((v, i) => {
    const cx = scale(v);
    if (i === values.length - 1 || cx - lastX >= minGap) { kept.push(v); lastX = cx; }
  });
  return (
    <g aria-hidden="true">
      {kept.map((v) => (
        <text key={String(v)} className={s.tick} x={scale(v)} y={y + 13} textAnchor="middle">
          {format(v)}
        </text>
      ))}
    </g>
  );
}

// ───────────────────────────────────────────────────────────── tooltip

export interface TipRow { id: string; label: string; value: string; color: string }

export function ChartTooltip(p: {
  x: number;
  y: number;
  head?: string;
  rows: TipRow[];
  /** Plot width, so the card flips rather than overflowing. */
  width: number;
}) {
  const { x, y, head, rows, width } = p;
  const flip = x > width * 0.62;
  return (
    <div
      className={s.tip}
      style={{
        left: flip ? undefined : x + 12,
        right: flip ? Math.max(0, width - x + 12) : undefined,
        top: Math.max(0, y - 8),
      }}
      role="tooltip"
    >
      {head && <span className={s.tipHead}>{head}</span>}
      {rows.map((r) => (
        <span key={r.id} className={s.tipRow}>
          <span className={s.tipKey} style={{ background: r.color }} />
          <span className={s.tipName}>{r.label}</span>
          <span className={s.tipVal}>{r.value}</span>
        </span>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── hover

export interface HoverState { index: number; px: number; py: number }

/**
 * Crosshair hover: the reader aims at a *date*, not at a 2px line. Snaps to the
 * nearest data position and reports the same thing on keyboard focus, so the
 * tooltip is never the only route to a value.
 */
export function useCrosshair(count: number, xOf: (i: number) => number) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const ref = useRef<SVGSVGElement | null>(null);

  const onMove = useCallback((e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const el = ref.current;
    if (!el || count === 0) return;
    const box = el.getBoundingClientRect();
    const px = e.clientX - box.left;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < count; i++) {
      const d = Math.abs(xOf(i) - px);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHover({ index: best, px: xOf(best), py: e.clientY - box.top });
  }, [count, xOf]);

  const onLeave = useCallback(() => setHover(null), []);

  const onKey = useCallback((e: React.KeyboardEvent<SVGSVGElement>) => {
    if (count === 0) return;
    const cur = hover?.index ?? 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = Math.max(0, Math.min(count - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)));
      setHover({ index: next, px: xOf(next), py: 0 });
    } else if (e.key === 'Home') {
      e.preventDefault(); setHover({ index: 0, px: xOf(0), py: 0 });
    } else if (e.key === 'End') {
      e.preventDefault(); setHover({ index: count - 1, px: xOf(count - 1), py: 0 });
    } else if (e.key === 'Escape') {
      setHover(null);
    }
  }, [count, hover, xOf]);

  return { hover, setHover, ref, handlers: { onPointerMove: onMove, onPointerLeave: onLeave, onKeyDown: onKey } };
}

// ───────────────────────────────────────────────────────────── table twin

export function TableTwin(p: {
  columns: string[];
  rows: (string | number)[][];
  label?: string;
}) {
  const { columns, rows, label = 'Show data table' } = p;
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!rows.length) return null;
  return (
    <>
      <button
        type="button"
        className={s.tableToggle}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '− Hide table' : `+ ${label}`}
      </button>
      {open && (
        <div id={id} className={s.tableScroll}>
          <table className={s.table}>
            <thead>
              <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ───────────────────────────────────────────────────────────── plumbing

/**
 * Everything a chart needs to start drawing: a root ref for token resolution, a
 * measured box, and the inner plot rectangle.
 */
export function useChart(opts: {
  height: number;
  margin?: Partial<Margins>;
  minWidth?: number;
}) {
  const { height, minWidth = 220 } = opts;
  const [wrapRef, size] = useSize<HTMLDivElement>({ width: 560, height });
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useTheme(rootRef);

  const margin = useMemo<Margins>(
    () => ({ ...DEFAULT_MARGIN, ...opts.margin }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.margin?.top, opts.margin?.right, opts.margin?.bottom, opts.margin?.left],
  );

  const width = Math.max(minWidth, size.width || minWidth);
  const innerW = Math.max(10, width - margin.left - margin.right);
  const innerH = Math.max(10, height - margin.top - margin.bottom);

  return { rootRef, wrapRef, theme, width, height, margin, innerW, innerH, styles: s };
}

export { s as chartStyles };
