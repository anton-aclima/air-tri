/**
 * Presentation metadata the charts and map marks need, which `@/core/measures`
 * does not carry. Deliberately small: everything that overlaps with core
 * (`riskLabel`, `METRIC_LABEL`, `SEVERITY_LABEL`, `fmtNum`, `fmtBearing`, …)
 * is imported from core rather than restated here.
 */

import type { Severity } from '@/core/types';

/**
 * Severity → a glyph, so severity is NEVER carried by colour alone.
 * Geometric rather than emoji: these have to read at 10px inside a radar scope.
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

/** Four-character RWR codes. Anything longer will not fit beside a contact. */
export const ALERT_KIND_CODE: Record<string, string> = {
  exceedance: 'EXCD',
  integrated_exposure: 'DOSE',
  concern_cluster: 'COMM',
  mobile_detection: 'MOBL',
  fleet_anomaly: 'FLET',
  regulatory_notice: 'RGLT',
  wind_shift: 'WIND',
};

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
