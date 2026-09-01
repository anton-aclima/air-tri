/**
 * The token bridge.
 *
 * deck.gl wants `[r,g,b,a]` and SVG wants strings, but the *authority* for every
 * colour in this product is `src/design/tokens.css`, re-bound per `data-role`.
 * So: never hard-code. Read the resolved custom-property values out of the DOM at
 * runtime, and re-read whenever the role skin changes.
 *
 * Usage in a component:
 *   const ref = useRef<HTMLDivElement>(null);
 *   const theme = useTheme(ref);      // resolves against ref's [data-role] ancestor
 *   ... theme.css('ink') ... theme.color('accent', 0.4) ... theme.ramp
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Role } from '@/core/types';

export type RGBA = [number, number, number, number];
export type MapSkin = 'light' | 'dark' | 'night' | 'blueprint';

/** Every token this library reads. Keyed without the leading `--`. */
export const TOKENS = [
  // surfaces / ink
  'bg', 'bg-sunk', 'surface', 'surface-2', 'surface-raised',
  'line', 'line-strong', 'ink', 'ink-2', 'ink-3', 'ink-inv',
  'accent', 'accent-ink', 'accent-soft', 'accent-2',
  // severity
  'sev-info', 'sev-watch', 'sev-warning', 'sev-critical', 'sev-ok',
  // actors
  'actor-community', 'actor-regulator', 'actor-industry', 'actor-aclima',
  // modality identity hues
  'mod-no2', 'mod-pm25', 'mod-bc', 'mod-o3', 'mod-co', 'mod-co2', 'mod-ch4',
  // role-specific map furniture (present only in some skins — fall back gracefully)
  'tower', 'tower-ring', 'invader', 'fleet',
  'scope', 'scope-dim', 'scope-grid', 'threat', 'threat-glow',
  'bandit-community', 'bandit-regulator',
  // terrain — the basemap's own palette, never borrowed from a semantic hue
  'map-water', 'map-green', 'map-urban',
  // shape / motion
  'radius-card', 'font-mono', 'font-body', 'font-heading', 'grid-overlay',
] as const;

export type TokenName = (typeof TOKENS)[number];

/**
 * Last-resort mirror of `tokens.css`, used ONLY when a component is mounted
 * outside any `[data-role]` subtree (or before first paint / in a non-DOM env).
 * Components never reference these directly.
 */
const NEUTRAL: Record<string, string> = {
  bg: '#0C1017', 'bg-sunk': '#080B10', surface: '#141A23', 'surface-2': '#1A222D',
  'surface-raised': '#1F2833', line: '#232E3C', 'line-strong': '#334154',
  ink: '#E6EDF3', 'ink-2': '#9BAAB9', 'ink-3': '#6B7B8C', 'ink-inv': '#080B10',
  accent: '#00D3A7', 'accent-ink': '#00160F', 'accent-soft': '#06302A', 'accent-2': '#7CA9FF',
};

/** Tokens that only exist inside one role skin get a role-independent stand-in. */
const ALIAS: Record<string, string> = {
  tower: 'sev-ok', invader: 'sev-critical', fleet: 'mod-ch4',
  scope: 'accent', 'scope-dim': 'line-strong', 'scope-grid': 'line',
  threat: 'sev-critical', 'threat-glow': 'sev-critical',
  'bandit-community': 'actor-community', 'bandit-regulator': 'actor-regulator',
};

// ───────────────────────────────────────────────────────────── colour parsing

const HEX = /^#([0-9a-f]{3,8})$/i;

function clamp255(n: number) { return n < 0 ? 0 : n > 255 ? 255 : Math.round(n); }

/** Parse any CSS colour string this design system uses into `[r,g,b,a]` 0–255. */
export function parseColor(input: string | undefined | null): RGBA {
  if (!input) return [0, 0, 0, 0];
  const s = input.trim();
  const hex = HEX.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const p = h.split('').map((c) => parseInt(c + c, 16));
      return [p[0], p[1], p[2], h.length === 4 ? p[3] : 255];
    }
    if (h.length === 6 || h.length === 8) {
      const p = [0, 2, 4, 6].slice(0, h.length / 2).map((i) => parseInt(h.slice(i, i + 2), 16));
      return [p[0], p[1], p[2], p.length === 4 ? p[3] : 255];
    }
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length >= 3) {
      const a = parts.length > 3 ? (parts[3] <= 1 ? parts[3] * 255 : parts[3]) : 255;
      return [clamp255(parts[0]), clamp255(parts[1]), clamp255(parts[2]), clamp255(a)];
    }
  }
  return [0, 0, 0, 0];
}

export function withAlpha(c: RGBA, alpha: number): RGBA {
  return [c[0], c[1], c[2], clamp255(alpha <= 1 ? alpha * 255 : alpha)];
}

export function rgbaCss(c: RGBA): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)})`;
}

/** Relative luminance 0–1 — used to pick ink-on-fill. */
export function luminance(c: RGBA): number {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  const u = 1 - t;
  return [
    clamp255(a[0] * u + b[0] * t), clamp255(a[1] * u + b[1] * t),
    clamp255(a[2] * u + b[2] * t), clamp255(a[3] * u + b[3] * t),
  ];
}

// ───────────────────────────────────────────────────────────── the Theme object

export interface Theme {
  /** The active role skin, read from the nearest `[data-role]`. */
  role: Role | 'none';
  /** Basemap skin, from `--map-style`. */
  skin: MapSkin;
  /** Is this a light-on-dark skin? Drives glow, casing and label choices. */
  dark: boolean;
  /** Raw resolved token strings, keyed without `--`. */
  v: Record<string, string>;
  /** `--ramp-map-0..7` — THE road-grid ramp for this role. */
  ramp: string[];
  /** `--ramp-aqi-0..6` — public-health language. Community risk only. */
  aqi: string[];
  /** `--ramp-intensity-0..7` — analytical magnitude, role-independent. */
  intensity: string[];
  /** `--persist-0..5` opacity ladder for the persistence channel. */
  persist: number[];
  /** Fixed categorical hue order for multi-series identity. Never cycled. */
  categorical: string[];
  /** Token → CSS string. */
  css(name: TokenName | string): string;
  /** Token → deck.gl `[r,g,b,a]`; `alpha` (0–1) overrides the token's own alpha. */
  color(name: TokenName | string, alpha?: number): RGBA;
  /** Ramp position 0–1 → CSS string (continuous, interpolated). */
  rampAt(t: number, which?: 'map' | 'aqi' | 'intensity'): string;
  /** Ramp position 0–1 → `[r,g,b,a]`. */
  rampColor(t: number, alpha?: number, which?: 'map' | 'aqi' | 'intensity'): RGBA;
  /** Severity token for a `Severity` value. */
  sev(s: string): string;
}

function stripQuotes(s: string) { return s.replace(/^['"]|['"]$/g, ''); }

function readVars(el: Element | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof window === 'undefined' || !el) return { ...NEUTRAL };
  const cs = getComputedStyle(el);
  const get = (n: string) => cs.getPropertyValue(`--${n}`).trim();
  for (const t of TOKENS) {
    let val = get(t);
    if (!val && ALIAS[t]) val = get(ALIAS[t]);
    if (!val && NEUTRAL[t]) val = NEUTRAL[t];
    out[t] = val;
  }
  for (let i = 0; i < 8; i++) {
    out[`ramp-map-${i}`] = get(`ramp-map-${i}`) || get(`ramp-intensity-${i}`);
    out[`ramp-intensity-${i}`] = get(`ramp-intensity-${i}`);
  }
  for (let i = 0; i < 7; i++) out[`ramp-aqi-${i}`] = get(`ramp-aqi-${i}`);
  for (let i = 0; i < 6; i++) out[`persist-${i}`] = get(`persist-${i}`);
  out['map-style'] = stripQuotes(get('map-style'));
  out['dur-sweep'] = get('dur-sweep');
  return out;
}

function makeTheme(v: Record<string, string>, role: Role | 'none'): Theme {
  const ramp = Array.from({ length: 8 }, (_, i) => v[`ramp-map-${i}`] || '');
  const aqi = Array.from({ length: 7 }, (_, i) => v[`ramp-aqi-${i}`] || '');
  const intensity = Array.from({ length: 8 }, (_, i) => v[`ramp-intensity-${i}`] || '');
  const persist = Array.from({ length: 6 }, (_, i) => Number(v[`persist-${i}`]) || (i + 1) / 6);
  const skin = (['light', 'dark', 'night', 'blueprint'] as MapSkin[])
    .includes(v['map-style'] as MapSkin) ? (v['map-style'] as MapSkin) : 'dark';
  const dark = skin !== 'light';

  const pick = (which: 'map' | 'aqi' | 'intensity') =>
    which === 'aqi' ? aqi : which === 'intensity' ? intensity : ramp;

  const rampColorAt = (t: number, which: 'map' | 'aqi' | 'intensity'): RGBA => {
    const stops = pick(which).filter(Boolean);
    if (!stops.length) return [0, 0, 0, 0];
    const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    if (stops.length === 1) return parseColor(stops[0]);
    return mix(parseColor(stops[i]), parseColor(stops[i + 1]), x - i);
  };

  return {
    role, skin, dark, v, ramp, aqi, intensity, persist,
    categorical: [
      v['mod-no2'], v['mod-pm25'], v['mod-bc'], v['mod-o3'],
      v['mod-co'], v['mod-ch4'], v['mod-co2'], v['actor-industry'],
    ].filter(Boolean),
    css: (n) => v[n] ?? '',
    color: (n, alpha) => {
      const c = parseColor(v[n]);
      return alpha === undefined ? c : withAlpha(c, alpha);
    },
    rampAt: (t, which = 'map') => rgbaCss(rampColorAt(t, which)),
    rampColor: (t, alpha, which = 'map') => {
      const c = rampColorAt(t, which);
      return alpha === undefined ? c : withAlpha(c, alpha);
    },
    sev: (s) => v[`sev-${s}`] || v['sev-info'] || '',
  };
}

/** A theme resolved against `document` — for code outside a React tree. */
export function readTheme(el?: Element | null): Theme {
  const target = el ?? (typeof document !== 'undefined'
    ? document.querySelector('[data-role]') ?? document.documentElement
    : null);
  const role = (target?.closest?.('[data-role]')?.getAttribute('data-role') ?? 'none') as Role | 'none';
  return makeTheme(readVars(target), role);
}

/**
 * Resolve the role theme for the subtree containing `ref`.
 * Re-reads when the nearest `[data-role]` attribute changes, so a role switch
 * repaints deck.gl layers and SVG charts without a remount.
 */
export function useTheme(ref: RefObject<Element | null>): Theme {
  const [state, setState] = useState<{ v: Record<string, string>; role: Role | 'none' }>(
    () => ({ v: { ...NEUTRAL }, role: 'none' }),
  );
  const attached = useRef<Element | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const alive = useRef(true);

  /**
   * Deliberately runs after EVERY render, not on a dependency list.
   *
   * `ref.current` is null until the caller actually mounts an element, and any
   * component that renders a placeholder while its query is in flight —
   * `if (!points.length) return <EmptyPlot/>` — mounts nothing on the first
   * pass. The previous version bailed on the null ref and re-tried exactly once
   * on the next animation frame, which is still long before the data lands, and
   * then never again: its deps were `[ref, tick]`, `ref` is a stable object and
   * `tick` was pinned at 1 by its own updater. So the hook kept the NEUTRAL
   * fallback for the rest of the component's life — and NEUTRAL carries no
   * `ramp-*` tokens, so `theme.ramp` came back empty, `makeColorScale` returned
   * transparent, and the chart painted nothing at all while its CSS-driven axis
   * labels rendered perfectly. That failure looks exactly like missing data,
   * which is what made it expensive.
   *
   * Re-checking every render is cheap: one identity comparison, and the real
   * work only happens when the element actually changes.
   */
  useEffect(() => {
    const el = ref.current;
    if (el === attached.current) return;
    attached.current = el;
    cleanup.current?.();
    cleanup.current = null;
    // Element unmounted. Keep the last good tokens rather than snapping back to
    // NEUTRAL, which would flash a themed chart to invisible on its way out.
    if (!el) return;

    const roleEl = el.closest('[data-role]');
    const read = () => {
      if (!alive.current) return;
      setState({
        v: readVars(el),
        role: (roleEl?.getAttribute('data-role') ?? 'none') as Role | 'none',
      });
    };
    read();

    // One more read after the frame settles, in case this commit landed before
    // tokens.css applied.
    const raf = requestAnimationFrame(read);
    const mo = new MutationObserver(read);
    for (const t of [roleEl, document.documentElement].filter(Boolean) as Element[]) {
      mo.observe(t, { attributes: true, attributeFilter: ['data-role', 'class', 'style'] });
    }
    cleanup.current = () => { cancelAnimationFrame(raf); mo.disconnect(); };
  });

  useEffect(() => () => {
    alive.current = false;
    cleanup.current?.();
    cleanup.current = null;
  }, []);

  return useMemo(() => makeTheme(state.v, state.role), [state]);
}

/** Convenience for components that own no element of their own. */
export function useDocumentTheme(): Theme {
  const ref = useRef<Element | null>(
    typeof document === 'undefined'
      ? null
      : document.querySelector('[data-role]') ?? document.documentElement,
  );
  return useTheme(ref);
}
