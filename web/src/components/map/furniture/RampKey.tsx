/**
 * RampKey — a tall vertical colour key for a road grid, with the published
 * limits drawn on it as waterlines (owner, 2026-10-08).
 *
 * The grid can be stretched to the streets in view (components/lib/viewRange),
 * so a colour stops meaning a level and starts meaning "high for what you are
 * looking at". This key is what keeps that honest while you pan and zoom:
 *
 *  - the bar's ends ARE the current range, in the measure's own unit, and
 *    re-label as the view changes;
 *  - each published limit is a line across the bar at its value;
 *  - a limit OUTSIDE the range is never dropped: it is listed above or below
 *    the bar with an arrow. Stretching a clean area until 6 ppb looks dark is
 *    exactly when the reader most needs to see the guideline is far away.
 *
 * SLIM ON PURPOSE (owner: "the text in the concentration key makes it much
 * wider than it should be"). On the map: the switch, the bar, its numbers and
 * short line labels ("EPA 9.0"). Everything that explains — what the colours
 * mean, the full names and sources of the limits, how many streets are in
 * view — is behind the ⓘ button, in a popover portalled to <body> so the map
 * frame's `overflow: hidden` cannot clip it.
 *
 * Colours come from `--ramp-contrast-*`, the relative ramp (no green "clean",
 * no red "danger"); the waterlines carry the health meaning, not the hue.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { fmtNum } from '@/core/format';
import type { PublishedLimit } from '../../lib/limits';
import s from './RampKey.module.css';

export interface RampKeyProps {
  /** Plain-language name of what is coloured ("traffic and engine fumes"). */
  title: string;
  /** Unit as people write it ("ppb", "µg/m³"); '' for an index. */
  unit: string;
  /** The colour domain [bottom, top] the grid is drawn with. */
  domain: [number, number];
  /** True extremes of the streets in view, when stretched. */
  extremes?: { min: number; max: number; n: number } | null;
  /** Published limits for this measure, lowest first. */
  limits: readonly PublishedLimit[];
  /** Stretched to the view (true) or the fixed whole-area scale (false). */
  stretched: boolean;
  onStretchedChange?(next: boolean): void;
  /** Replaces the bar when nothing in view can be drawn. */
  empty?: string | null;
  /** Decimals for the end labels. */
  decimals?: number;
  /** Bar height in px. */
  height?: number;
  /** The window the colours describe ("Typical reading · these three months"). */
  window?: string;
}

/** CSS gradient over the eight `--ramp-contrast-*` stops, bottom to top. */
const GRADIENT = `linear-gradient(to top, ${Array.from({ length: 8 }, (_, i) => `var(--ramp-contrast-${i})`).join(', ')})`;

/** The explanation popover's width and its gap from the viewport edge, px. */
const POP_W = 300;
const POP_GUTTER = 8;

export function RampKey({
  title, unit, domain, extremes, limits, stretched, onStretchedChange, empty, decimals = 1, height = 240,
  window: windowWords,
}: RampKeyProps) {
  const id = useId();
  const [d0, d1] = domain;
  const span = d1 - d0 || 1;
  const fmt = (v: number) => fmtNum(v, Math.abs(v) >= 100 ? 0 : decimals);
  const u = unit ? ` ${unit}` : '';

  const inside = limits.filter((l) => l.value >= d0 && l.value <= d1);
  const above = limits.filter((l) => l.value > d1);
  const below = limits.filter((l) => l.value < d0);
  // Position from the bottom, 0–100 %.
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - d0) / span) * 100));
  // On the bar: the body and the number. The unit is on the ends.
  const short = (l: PublishedLimit) => `${l.body} ${fmt(l.value)}`;
  const where = (l: PublishedLimit) =>
    l.value > d1 ? 'above every street shown' : l.value < d0 ? 'every street shown is above it' : 'inside the range shown';

  const summary = empty
    ? empty
    : `${title}: colours run from ${fmt(d0)} to ${fmt(d1)}${u}${stretched ? ', stretched to the streets in view' : ''}.`
      + limits.map((l) => ` ${l.label} (annual) ${fmt(l.value)}${u}: ${where(l)}.`).join('');

  // ── the explanation popover ─────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r) return;
      const vw = document.documentElement.clientWidth;
      const w = Math.min(POP_W, vw - POP_GUTTER * 2);
      // Opens toward the map: right-aligned to the button, kept on screen.
      const left = Math.max(POP_GUTTER, Math.min(r.right - w, vw - POP_GUTTER - w));
      setPos({ top: r.bottom + 6, left, width: w });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <section className={s.key} aria-label={`Colour key: ${title}`}>
      <header className={s.head}>
        {onStretchedChange ? (
          <label className={s.toggle}>
            <input
              type="checkbox"
              checked={stretched}
              onChange={(e) => onStretchedChange(e.currentTarget.checked)}
            />
            <span>Stretch to view</span>
          </label>
        ) : <span />}
        <button
          ref={btn}
          type="button"
          className={s.info}
          aria-label="What the colours and lines mean"
          aria-expanded={open}
          aria-controls={open ? `${id}-pop` : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          i
        </button>
      </header>

      {empty ? (
        <p className={s.empty}>{empty}</p>
      ) : (
        <>
          {above.length ? (
            <ul className={s.offScale} aria-label="Limits above every colour">
              {above.map((l) => (
                <li key={l.label}><span className={s.arrow} aria-hidden>↑</span>{short(l)}</li>
              ))}
            </ul>
          ) : null}

          <div className={s.scale} role="img" aria-label={summary} style={{ height }}>
            <div className={s.bar} style={{ backgroundImage: GRADIENT }} />
            <span className={s.end} style={{ bottom: '100%' }}>{fmt(d1)}{u}</span>
            <span className={s.end} style={{ bottom: '0%' }}>{fmt(d0)}{u}</span>
            {inside.map((l) => (
              <div key={l.label} className={s.water} style={{ bottom: `${pct(l.value)}%` }}>
                <span className={s.waterLine} />
                <span className={s.waterLabel}>{short(l)}</span>
              </div>
            ))}
          </div>

          {below.length ? (
            <ul className={s.offScale} aria-label="Limits below every colour">
              {below.map((l) => (
                <li key={l.label}><span className={s.arrow} aria-hidden>↓</span>{short(l)}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      {open && pos
        ? createPortal(
            <div
              ref={pop}
              id={`${id}-pop`}
              role="dialog"
              aria-label="What the colours and lines mean"
              className={s.pop}
              style={{ top: pos.top, left: pos.left, width: pos.width }}
            >
              <p className={s.popTitle}>{title}</p>
              {windowWords ? <p className={s.popSub}>{windowWords}</p> : null}
              <p className={s.popText}>
                {stretched
                  ? 'The colours are stretched to the streets in view: darker is higher for what you are looking at, not a health level. Pan or zoom and the range follows.'
                  : 'One scale for the whole map: darker is higher, everywhere.'}
              </p>
              {stretched && extremes ? (
                <p className={s.popText}>
                  {fmtNum(extremes.n, 0)} streets in view read {fmt(extremes.min)}–{fmt(extremes.max)}{u}.
                </p>
              ) : null}
              {limits.length ? (
                <>
                  <p className={s.popHead}>The lines: published annual limits</p>
                  <ul className={s.popList}>
                    {limits.map((l) => (
                      <li key={l.label}>
                        <b>{l.label}</b> {fmt(l.value)}{u} — {where(l)}.
                        <span className={s.popSource}>{l.source}</span>
                      </li>
                    ))}
                  </ul>
                  <p className={s.popNote}>
                    A street&rsquo;s colour is its typical reading over many passes, so it is held against the
                    annual limits — a comparison, not a verdict.
                  </p>
                </>
              ) : (
                <p className={s.popNote}>No annual health limit is published for this one, so there are no lines.</p>
              )}
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
