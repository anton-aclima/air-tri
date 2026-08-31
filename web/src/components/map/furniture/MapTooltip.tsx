/**
 * MapTooltip / MapPopover — hover and click, kept separate.
 *
 * Tooltip: follows the pointer, never traps it, enhances but never *gates* — every
 * value it shows is also in the inspector. Values lead, labels follow.
 * Popover: click-anchored, focusable, holds actions.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Severity } from '@/core/types';
import { SEVERITY_LABEL, severityVar } from '@/core/measures';
import { SEVERITY_GLYPH } from '../../lib/vizmeta';
import s from './furniture.module.css';

export interface TooltipRow { label: string; value: string; hue?: string }

export interface MapTooltipProps {
  /** Viewport coordinates, straight from a deck.gl `PickingInfo` (`x`, `y`). */
  x: number | null | undefined;
  y: number | null | undefined;
  title?: string | null;
  subtitle?: string | null;
  /** The one number the reader came for. */
  hero?: { value: string; unit?: string } | null;
  rows?: TooltipRow[];
  severity?: Severity | null;
  children?: ReactNode;
  /** Force-hide without unmounting. */
  visible?: boolean;
  offset?: number;
  className?: string;
  style?: CSSProperties;
}

/** Flip the card so it never leaves the viewport. */
function place(x: number, y: number, w: number, h: number, offset: number) {
  const vw = typeof window === 'undefined' ? 1600 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 1200 : window.innerHeight;
  let left = x + offset;
  let top = y + offset;
  if (left + w > vw - 8) left = x - w - offset;
  if (top + h > vh - 8) top = y - h - offset;
  return { left: Math.max(8, left), top: Math.max(8, top) };
}

export function MapTooltip(props: MapTooltipProps) {
  const {
    x, y, title, subtitle, hero, rows, severity, children,
    visible = true, offset = 14, className, style,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 180, h: 90 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setBox({ w: el.offsetWidth, h: el.offsetHeight });
  }, [title, subtitle, hero, rows, children]);

  if (!visible || x === null || x === undefined || y === null || y === undefined) return null;
  const pos = place(x, y, box.w, box.h, offset);

  return (
    <div
      ref={ref}
      className={[s.tooltip, className].filter(Boolean).join(' ')}
      style={{ ...pos, ...style }}
      role="tooltip"
    >
      {subtitle && <span className={s.tooltipSub}>{subtitle}</span>}
      {title && <span className={s.tooltipTitle}>{title}</span>}
      {severity && (
        <span className={s.tooltipSub} style={{ color: severityVar(severity) }}>
          {SEVERITY_GLYPH[severity]} {SEVERITY_LABEL[severity]}
        </span>
      )}
      {hero && (
        <span className={s.hero}>
          {hero.value}
          {hero.unit ? <span className={s.heroUnit}>{hero.unit}</span> : null}
        </span>
      )}
      {rows?.map((r) => (
        <span key={r.label} className={s.kv}>
          <span className={s.kvKey}>
            {r.hue && (
              <span
                style={{
                  display: 'inline-block', inlineSize: 10, blockSize: 2,
                  borderRadius: 2, background: r.hue, marginInlineEnd: 5,
                  verticalAlign: 'middle',
                }}
              />
            )}
            {r.label}
          </span>
          <span className={s.kvVal}>{r.value}</span>
        </span>
      ))}
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

export interface MapPopoverProps {
  x: number | null | undefined;
  y: number | null | undefined;
  title?: ReactNode;
  subtitle?: string | null;
  children?: ReactNode;
  actions?: { label: string; onClick(): void; primary?: boolean }[];
  onClose?(): void;
  offset?: number;
  className?: string;
  style?: CSSProperties;
}

export function MapPopover(props: MapPopoverProps) {
  const {
    x, y, title, subtitle, children, actions, onClose,
    offset = 12, className, style,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 288, h: 160 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setBox({ w: el.offsetWidth, h: el.offsetHeight });
  }, [title, subtitle, children, actions]);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus the card on open so keyboard users land inside it, not behind it —
  // but never scroll to do it. A popover anchored to a map mark that yanks the
  // page is worse than no focus management at all.
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);

  if (x === null || x === undefined || y === null || y === undefined) return null;
  const pos = place(x, y, box.w, box.h, offset);

  return (
    <div
      ref={ref}
      className={[s.popover, className].filter(Boolean).join(' ')}
      style={{ ...pos, ...style }}
      role="dialog"
      aria-label={typeof title === 'string' ? title : 'Map details'}
      tabIndex={-1}
    >
      <div className={s.between}>
        <div style={{ display: 'grid', gap: 2 }}>
          {subtitle && <span className={s.tooltipSub}>{subtitle}</span>}
          {title && <span className={s.title} style={{ fontSize: 'var(--text-md)' }}>{title}</span>}
        </div>
        {onClose && (
          <button type="button" className={s.close} onClick={onClose} aria-label="Close">×</button>
        )}
      </div>
      {children}
      {actions?.length ? (
        <div className={s.actions}>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={[s.action, a.primary ? s.actionPrimary : ''].filter(Boolean).join(' ')}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
