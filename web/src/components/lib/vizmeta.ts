/**
 * Presentation metadata the charts and map marks need, which `@/core/measures`
 * does not carry. Deliberately small: everything that overlaps with core
 * (`riskLabel`, `METRIC_LABEL`, `SEVERITY_LABEL`, `fmtNum`, `fmtBearing`, …)
 * is imported from core rather than restated here.
 */

import type { Severity } from '@/core/types';

/**
 * Severity → a glyph, so severity is NEVER carried by colour alone.
 * Geometric rather than emoji: these have to read at 10px beside a map mark.
 *
 * The WORDS for the same four levels are `SEVERITY_LABEL` in `@/core/measures`
 * — Critical / Warning / Watch / Info — and that is the only severity
 * vocabulary (PLAN-refocus F3). There is no annunciator ladder here: the deck's
 * CAUTION / ADVISORY / NORMAL was a second vocabulary for the same alert, and a
 * second vocabulary is how one screen said ADVISORY above a banner saying
 * CAUTION.
 */
export const SEVERITY_GLYPH: Record<Severity, string> = {
  info: '·', watch: '△', warning: '▲', critical: '◆',
};

/** One-line explanations for `MetricPicker`, shown as a title/description. */
export const METRIC_HELP: Record<string, string> = {
  median: 'Typical concentration across every pass.',
  p90: 'The high end — one pass in ten is above this.',
  max: 'Highest single pass recorded.',
  persistence: 'Share of passes over the reference level — how often, not how much.',
  risk: 'Unitless 0–100 health framing. No units, no acronyms.',
};

export const CONCERN_LABEL: Record<string, string> = {
  smell: 'Smell', noise: 'Noise', smoke: 'Smoke', dust: 'Dust', health: 'Health',
  light: 'Light', traffic: 'Traffic', vibration: 'Vibration', other: 'Other',
};

/** Community language — plain, no acronyms. Used in feeds and popovers. */
export const CONCERN_EMOJI: Record<string, string> = {
  smell: '👃', noise: '🔊', smoke: '🌫️', dust: '🏜️', health: '🫁',
  light: '💡', traffic: '🚚', vibration: '〰️', other: '❓',
};

export const ALERT_KIND_LABEL: Record<string, string> = {
  exceedance: 'Exceedance',
  integrated_exposure: 'Integrated exposure',
  concern_cluster: 'Community cluster',
  mobile_detection: 'Mobile detection',
  fleet_anomaly: 'Fleet anomaly',
  regulatory_notice: 'Regulatory notice',
  wind_shift: 'Wind shift',
};

/**
 * The three model registers of CONTRACT §10b, as stroke specs.
 *
 * One table, read by BOTH the map layers (`DispersionLayer` style 'outline',
 * `FiledStudyLayer`) and the legend swatch (`PlumeSwatch`), so the key cannot
 * drift from the marks it explains.
 *
 * `dash` is deck.gl's `PathStyleExtension` unit — multiples of the line
 * WIDTH, not pixels — so the swatch multiplies by `width` to draw the same
 * pattern in SVG.
 *
 * `beyond` and `filed` are both "an outline with no fill" under §10b, so with
 * the filed study switched on they would differ by colour alone
 * (PLAN-refocus §8: "confirmed"). They are separated on two channels: a dash
 * against a dot, and ink against the filed study's own `accent-2`. Never give
 * them the same pattern.
 */
export const PLUME_STROKE = {
  /** Aclima's model, inside the detection envelope: a solid hairline. */
  model: { token: 'ink', alpha: 0.9, width: 1.25, dash: null },
  /** Aclima's model past the envelope — "beyond measurement range — model only". */
  beyond: { token: 'ink', alpha: 0.7, width: 1.25, dash: [6, 4] },
  /**
   * The centreline axis. Solid to the envelope, then `beyond`'s dash. §10b
   * asks for a FAINTER axis than the outline: at 0.7 against the edges' 0.9
   * the three lines from the stack read as three bearing lines (phase 3
   * review), so it sits well under the edge and the reach tick carries it.
   */
  axis: { token: 'ink', alpha: 0.38, width: 1, dash: null },
  /** The filed / permit study: dotted, in its own token. */
  filed: { token: 'accent-2', alpha: 0.9, width: 1.5, dash: [1.5, 3] },
} as const satisfies Record<string, {
  token: string; alpha: number; width: number; dash: readonly [number, number] | null;
}>;

export type PlumeRegister = keyof typeof PLUME_STROKE;

/** Axis-tick rounding: the smallest 1/2/5×10ⁿ step at or above `raw`. */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

/**
 * A rounder ladder than `niceStep`, for range rings and gauges where jumping
 * 5.9 → 10 would bury the data in the middle of the dial.
 */
export function niceCeil(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (norm <= step) return step * mag;
  }
  return 10 * mag;
}

/** `count` nice ticks spanning `[lo, hi]`, snapped outward to the step. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo || 0];
  const step = niceStep((hi - lo) / Math.max(1, count));
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-6; v += step) out.push(Number(v.toFixed(10)));
  return out;
}
