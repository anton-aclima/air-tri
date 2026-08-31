/**
 * Value → colour, the one place it happens.
 *
 * The magnitude ramp is the design system's `--ramp-map-*` (an 8-step,
 * monotonic-luminance "semantic heat" scale — the documented multi-hue exception
 * to one-hue sequential, and it always ships with a scale legend).
 *
 * The persistence channel is separate and orthogonal: `--persist-0..5`, an
 * opacity ladder that multiplies over the magnitude colour without fighting it.
 * That is the Aclima dual encoding — HOW MUCH in hue, HOW OFTEN in weight.
 */

import { quantile } from 'd3-array';
import type { RGBA, Theme } from './theme';
import { parseColor, rgbaCss, withAlpha } from './theme';

export type RampName = 'map' | 'aqi' | 'intensity';
export type ScaleMode = 'continuous' | 'quantized';

export interface ColorScale {
  domain: [number, number];
  mode: ScaleMode;
  ramp: RampName;
  /** The 8 (or 7) discrete stops, for legend swatches. */
  stops: string[];
  /** Normalised position of a value, 0–1 (null passthrough). */
  t(v: number | null | undefined): number | null;
  /** value → css colour string. */
  css(v: number | null | undefined): string;
  /** value → deck.gl `[r,g,b,a]`. */
  rgba(v: number | null | undefined, alpha?: number): RGBA;
  /** Boundary values for the legend ticks. */
  ticks(count?: number): number[];
}

/** Empty / no-data colour: a recessive line-weight grey, never a ramp step. */
export function noDataColor(theme: Theme, alpha = 0.5): RGBA {
  return theme.color('line-strong', alpha);
}

export function makeColorScale(
  theme: Theme,
  opts: {
    domain: [number, number];
    mode?: ScaleMode;
    ramp?: RampName;
    /** Gamma < 1 lifts the low end (more contrast among low values). */
    gamma?: number;
  },
): ColorScale {
  const { domain, mode = 'continuous', ramp = 'map', gamma = 1 } = opts;
  const stops = (ramp === 'aqi' ? theme.aqi : ramp === 'intensity' ? theme.intensity : theme.ramp)
    .filter(Boolean);
  const [d0, d1] = domain;
  const span = d1 - d0 || 1;

  const norm = (v: number | null | undefined): number | null => {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    const raw = Math.max(0, Math.min(1, (v - d0) / span));
    return gamma === 1 ? raw : Math.pow(raw, gamma);
  };

  const at = (t: number): RGBA => {
    if (!stops.length) return [0, 0, 0, 0];
    if (mode === 'quantized') {
      const i = Math.min(stops.length - 1, Math.floor(t * stops.length));
      return parseColor(stops[i]);
    }
    return theme.rampColor(t, undefined, ramp);
  };

  return {
    domain, mode, ramp, stops,
    t: norm,
    css: (v) => {
      const t = norm(v);
      return t === null ? rgbaCss(noDataColor(theme)) : rgbaCss(at(t));
    },
    rgba: (v, alpha) => {
      const t = norm(v);
      const c = t === null ? noDataColor(theme) : at(t);
      return alpha === undefined ? c : withAlpha(c, alpha);
    },
    ticks: (count = 5) => Array.from({ length: count }, (_, i) => d0 + (span * i) / (count - 1)),
  };
}

/**
 * A robust domain from the data itself. Clipping at p98 stops one runaway
 * segment from flattening the whole grid to the bottom of the ramp — the single
 * most common way a choropleth turns into one colour.
 */
export function robustDomain(
  values: (number | null | undefined)[],
  opts: { low?: number; high?: number; floorAtZero?: boolean } = {},
): [number, number] {
  const { low = 0.02, high = 0.98, floorAtZero = true } = opts;
  const xs = values.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!xs.length) return [0, 1];
  const lo = quantile(xs, low) ?? xs[0];
  const hi = quantile(xs, high) ?? xs[xs.length - 1];
  const d0 = floorAtZero ? Math.min(0, lo) : lo;
  return d0 === hi ? [d0, d0 + 1] : [d0, hi];
}

/** Persistence 0–1 → the `--persist-*` opacity ladder (6 rungs). */
export function persistenceAlpha(theme: Theme, persistence: number | null | undefined, floor = 0): number {
  const rungs = theme.persist;
  if (persistence === null || persistence === undefined || !Number.isFinite(persistence)) {
    return Math.max(floor, rungs[rungs.length - 2] ?? 0.86);
  }
  const i = Math.max(0, Math.min(rungs.length - 1, Math.floor(persistence * rungs.length)));
  return Math.max(floor, rungs[i] ?? 1);
}

/**
 * Persistence 0–1 → a width multiplier. A street where a pollutant is over the
 * reference level on 9 passes in 10 draws thick; a one-off spike draws hairline.
 */
export function persistenceWidth(persistence: number | null | undefined, min = 0.5, max = 1.7): number {
  if (persistence === null || persistence === undefined || !Number.isFinite(persistence)) return 1;
  const p = Math.max(0, Math.min(1, persistence));
  // ease so mid-persistence still reads as "sometimes", not "always"
  return min + (max - min) * Math.pow(p, 0.75);
}

/** Which discrete rung a persistence value sits on — for the legend key. */
export function persistenceRung(theme: Theme, persistence: number): number {
  const n = theme.persist.length;
  return Math.max(0, Math.min(n - 1, Math.floor(persistence * n)));
}
