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
 *  - each published limit is a line across the bar at its value, so you can
 *    see whether the streets on screen sit under the WHO guideline, between it
 *    and the EPA standard, or over both;
 *  - a limit OUTSIDE the range is never dropped: it is listed above or below
 *    the bar with an arrow and what it means ("every street in view is under
 *    it"). Stretching a clean area until 6 ppb looks dark is exactly when the
 *    reader most needs to see that the guideline is still far above.
 *
 * Colours come from `--ramp-contrast-*`, the relative ramp (no green "clean",
 * no red "danger"); the waterlines carry the health meaning, not the hue.
 */

import { useId } from 'react';

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
  /** The window the colours describe ("these three months"). */
  window?: string;
  /**
   * A narrow map (a phone): a slim card — the bar, its ends, the lines with
   * short labels ("EPA 9.0"), the off-scale arrows and the switch. The
   * sentences go; the numbers and the lines stay.
   */
  compact?: boolean;
}

/** CSS gradient over the eight `--ramp-contrast-*` stops, bottom to top. */
const GRADIENT = `linear-gradient(to top, ${Array.from({ length: 8 }, (_, i) => `var(--ramp-contrast-${i})`).join(', ')})`;

export function RampKey({
  title, unit, domain, extremes, limits, stretched, onStretchedChange, empty, decimals = 1, height = 240,
  window: windowWords, compact = false,
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

  const summary = empty
    ? empty
    : `${title}: colours run from ${fmt(d0)} to ${fmt(d1)}${u}${stretched ? ', stretched to the streets in view' : ''}.`
      + limits.map((l) => ` ${l.label} (annual) ${fmt(l.value)}${u}: ${l.value > d1 ? 'above every colour' : l.value < d0 ? 'below every colour' : 'inside the range'}.`).join('');

  // Compact: the body's name and the value, unit once at the ends.
  const lineText = (l: PublishedLimit) => (compact ? `${l.body} ${fmt(l.value)}` : `${l.label} ${fmt(l.value)}${u}`);

  return (
    <section className={compact ? `${s.key} ${s.compact}` : s.key} aria-labelledby={`${id}-t`}>
      <header className={s.head}>
        <h3 id={`${id}-t`} className={compact ? s.srOnly : s.title}>{title}</h3>
        {windowWords && !compact ? <p className={s.window}>{windowWords}</p> : null}
        {limits.length && !compact ? <p className={s.window}>Lines: published annual limits</p> : null}
        {onStretchedChange ? (
          <label className={s.toggle}>
            <input
              type="checkbox"
              checked={stretched}
              onChange={(e) => onStretchedChange(e.currentTarget.checked)}
            />
            <span>{compact ? 'Stretch to view' : <>Stretch colours to what&rsquo;s in view</>}</span>
          </label>
        ) : null}
      </header>

      {empty ? (
        <p className={s.empty}>{empty}</p>
      ) : (
        <>
          {above.length ? (
            <ul className={s.offScale} aria-label="Limits above every colour">
              {above.map((l) => (
                <li key={l.label} title={l.source}>
                  <span className={s.arrow} aria-hidden>↑</span>
                  <span>
                    {compact ? lineText(l) : <><b>{l.label}</b> {fmt(l.value)}{u}</>}
                    {compact ? null : <span className={s.offNote}> — above every street shown</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className={s.scale} role="img" aria-label={summary} style={{ height }}>
            <div className={s.bar} style={{ backgroundImage: GRADIENT }} />
            <span className={s.end} style={{ bottom: '100%' }}>{fmt(d1)}{u}</span>
            <span className={s.end} style={{ bottom: '0%' }}>{fmt(d0)}{u}</span>
            {inside.map((l) => (
              <div key={l.label} className={s.water} style={{ bottom: `${pct(l.value)}%` }} title={l.source}>
                <span className={s.waterLine} />
                <span className={s.waterLabel}>
                  {compact ? lineText(l) : <><b>{l.label}</b> {fmt(l.value)}{u}</>}
                </span>
              </div>
            ))}
          </div>

          {below.length ? (
            <ul className={s.offScale} aria-label="Limits below every colour">
              {below.map((l) => (
                <li key={l.label} title={l.source}>
                  <span className={s.arrow} aria-hidden>↓</span>
                  <span>
                    {compact ? lineText(l) : <><b>{l.label}</b> {fmt(l.value)}{u}</>}
                    {compact ? null : <span className={s.offNote}> — every street shown is above it</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <p className={s.foot}>
            {compact
              ? (stretched && extremes ? `${fmtNum(extremes.n, 0)} streets in view` : 'Whole area')
              : stretched && extremes
              ? `${fmtNum(extremes.n, 0)} streets in view, ${fmt(extremes.min)}–${fmt(extremes.max)}${u}. Darker is higher for this view, not a health level.`
              : 'Darker is higher. The same scale everywhere on the map.'}
            {limits.length || compact ? null : ' No annual health limit is published for this one.'}
          </p>
        </>
      )}
    </section>
  );
}
