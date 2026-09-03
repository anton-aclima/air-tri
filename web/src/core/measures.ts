/**
 * air — the measurement language.
 *
 * One place that knows how to turn a raw concentration into something a screen
 * can show: a formatted string, a 0–100 risk score, a ramp colour, a band
 * label, and the right *word* for the audience.
 *
 * Two ramps, never mixed (CONTRACT §6):
 *   'aqi'       → public health framing (community, anything called "risk")
 *   'intensity' → analytical magnitude (regulator / industry / admin)
 *   'map'       → the per-role alias the road grid paints with (`--ramp-map-*`)
 *
 * Colours are read *out of the tokens* at runtime (`getComputedStyle`) so
 * deck.gl gets real RGB arrays without anybody hard-coding a hex anywhere.
 */

import type {
  MeasureCode,
  MeasureDef,
  Role,
  SegmentMetric,
  SegmentProps,
  Severity,
} from '@/core/types'
import { clamp, piecewise, piecewiseInverse } from '@/core/util'
import { EMPTY, fmtNum } from '@/core/format'

export type RampFamily = 'aqi' | 'intensity' | 'map' | 'intensity-light'
export type RGB = [number, number, number]
export type RGBA = [number, number, number, number]

/** Number of stops in each token ramp. */
const RAMP_STOPS: Record<RampFamily, number> = {
  aqi: 7,
  intensity: 8,
  map: 8,
  'intensity-light': 8,
}

const RAMP_PREFIX: Record<RampFamily, string> = {
  aqi: '--ramp-aqi-',
  intensity: '--ramp-intensity-',
  map: '--ramp-map-',
  'intensity-light': '--ramp-intensity-light-',
}

// ───────────────────────────────────────────────── token colour resolution

/**
 * The element whose computed style we read tokens from. The shell also mirrors
 * `data-role` onto `<html>`, so the default is correct even before mount.
 */
function themeEl(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

function themeKey(): string {
  return themeEl()?.dataset.role ?? 'none'
}

const cssCache = new Map<string, string>()
let cssCacheKey = ''

function cssRaw(name: string): string {
  const key = themeKey()
  if (key !== cssCacheKey) {
    cssCache.clear()
    cssCacheKey = key
  }
  const hit = cssCache.get(name)
  if (hit !== undefined) return hit
  const el = themeEl()
  let v = el ? getComputedStyle(el).getPropertyValue(name).trim() : ''
  // Some engines hand back an un-substituted `var(--other)`; follow the chain.
  let guard = 0
  while (v.startsWith('var(') && guard < 6) {
    const inner = v.slice(4, v.indexOf(')') === -1 ? v.length : v.lastIndexOf(')')).split(',')[0].trim()
    v = el ? getComputedStyle(el).getPropertyValue(inner).trim() : ''
    guard += 1
  }
  cssCache.set(name, v)
  return v
}

/** Invalidate the token cache — the shell calls this when the role changes. */
export function refreshTokenCache(): void {
  cssCache.clear()
  cssCacheKey = ''
}

function parseColor(input: string): RGB | null {
  const s = input.trim()
  if (!s) return null
  if (s.startsWith('#')) {
    const h = s.slice(1)
    const hex = h.length === 3 || h.length === 4
      ? h.slice(0, 3).split('').map((c) => c + c).join('')
      : h.slice(0, 6)
    if (hex.length !== 6) return null
    const n = Number.parseInt(hex, 16)
    if (Number.isNaN(n)) return null
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const m = s.match(/-?\d+(\.\d+)?%?/g)
  if (s.startsWith('rgb') && m && m.length >= 3) {
    return [Number(m[0]), Number(m[1]), Number(m[2])] as RGB
  }
  return null
}

/** Resolve any token name (`--sev-warning`) to an RGB triplet. */
export function tokenRgb(name: string, fallback: RGB = [128, 128, 128]): RGB {
  return parseColor(cssRaw(name)) ?? fallback
}

/** Resolve a numeric token (`--persist-3` → 0.7). */
export function tokenNumber(name: string, fallback = 0): number {
  const n = Number.parseFloat(cssRaw(name))
  return Number.isFinite(n) ? n : fallback
}

// ─────────────────────────────────────────────────────────────── ramps

/** `rampVar('aqi', 3)` → `'var(--ramp-aqi-3)'`. Use this in inline styles. */
export function rampVar(family: RampFamily, index: number): string {
  const n = RAMP_STOPS[family]
  return `var(${RAMP_PREFIX[family]}${clamp(Math.round(index), 0, n - 1)})`
}

/** Every stop of a ramp as `var(...)` strings — for legends and gradients. */
export function rampVars(family: RampFamily): string[] {
  return Array.from({ length: RAMP_STOPS[family] }, (_, i) => rampVar(family, i))
}

/** A CSS `linear-gradient(...)` across a ramp, for legend bars. */
export function rampGradient(family: RampFamily, angle = '90deg'): string {
  return `linear-gradient(${angle}, ${rampVars(family).join(', ')})`
}

/** Quantised stop index for `t` in 0–1. */
export function rampIndex(family: RampFamily, t: number): number {
  const n = RAMP_STOPS[family]
  return clamp(Math.floor(clamp(t, 0, 1) * n), 0, n - 1)
}

/** Nearest ramp stop as a `var(...)`, for chips and dots. */
export function rampColor(family: RampFamily, t: number): string {
  return rampVar(family, rampIndex(family, t))
}

/** All stops of a ramp as RGB triplets, read from the live tokens. */
export function rampStops(family: RampFamily): RGB[] {
  const n = RAMP_STOPS[family]
  return Array.from({ length: n }, (_, i) => tokenRgb(`${RAMP_PREFIX[family]}${i}`))
}

/**
 * Smoothly interpolated ramp colour for `t` in 0–1, as `[r, g, b]`.
 * This is what deck.gl layers should paint the road grid with.
 */
export function rampRgb(family: RampFamily, t: number): RGB {
  const stops = rampStops(family)
  if (stops.length === 0) return [128, 128, 128]
  const x = clamp(t, 0, 1) * (stops.length - 1)
  const i = Math.floor(x)
  const j = Math.min(stops.length - 1, i + 1)
  const f = x - i
  const a = stops[i]
  const b = stops[j]
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]
}

/** Ramp colour with an alpha byte, ready for deck.gl `getColor`. */
export function rampRgba(family: RampFamily, t: number, alpha = 1): RGBA {
  const [r, g, b] = rampRgb(family, t)
  return [r, g, b, Math.round(clamp(alpha, 0, 1) * 255)]
}

/** `'rgb(240 138 60)'` — for canvas/SVG fills that can't take a var(). */
export function rgbCss(rgb: RGB, alpha = 1): string {
  return alpha >= 1 ? `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})` : `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${alpha})`
}

/** The 6-step persistence opacity ladder (`--persist-*`). */
export function persistAlpha(persistence: number | null | undefined): number {
  if (persistence == null || !Number.isFinite(persistence)) return tokenNumber('--persist-2', 0.52)
  const i = clamp(Math.floor(clamp(persistence, 0, 1) * 6), 0, 5)
  return tokenNumber(`--persist-${i}`, 0.2 + i * 0.16)
}

/** Which ramp family a role should paint magnitude with. */
export function familyForRole(role: Role | null): RampFamily {
  return role === 'community' ? 'aqi' : 'map'
}

// ───────────────────────────────────────────────────────── risk & bands

/**
 * The colour domain for a derived index (`aclima_sense`) on the ANALYTICAL maps
 * — regulator, industry, admin, where the grid paints `median` on the intensity
 * ramp and no band word is attached to the colour.
 *
 * 60, not 100. Both are absolute: the point of pinning an index rather than
 * auto-stretching it is that a given value must be the same colour in every
 * campaign and every city, which is exactly what a health score is for.
 * `[0,100]` delivered that and cost too much contrast — measured on this
 * campaign, segment medians span 22.9-37.0, which is 14 % of a `[0,100]` ramp
 * against the 100 % every concentration gets from its auto-stretch. The map
 * went nearly monochrome.
 *
 * 60 = AQHI 6 = the top of Health Canada's Moderate band, so it is a published
 * boundary rather than a number read off this dataset. That distinction is the
 * whole point: `[0,45]` would have looked better still (31 % of the ramp) and
 * was rejected because 45 is just above THIS campaign's maximum, which is
 * auto-stretching through the back door. Nothing clamps at 60 here — the
 * highest segment median is 43.8.
 *
 * NOT used on the community map. That one paints `metric: 'risk'` on the AQI
 * ramp, where a colour position corresponds to a RISK_BANDS word — 40 is
 * "Moderate". Rescaling to [0,60] would put 40 at 67 % of the ramp, painting it
 * in the High colours while the label says Moderate. Community keeps [0,100].
 */
export const INDEX_DOMAIN: [number, number] = [0, 60]

export const RISK_BANDS: { min: number; label: string; short: string }[] = [
  { min: 0, label: 'Good', short: 'GOOD' },
  { min: 20, label: 'Fair', short: 'FAIR' },
  { min: 40, label: 'Moderate', short: 'MOD' },
  { min: 55, label: 'Elevated', short: 'ELEV' },
  { min: 70, label: 'High', short: 'HIGH' },
  { min: 85, label: 'Very high', short: 'V.HIGH' },
  { min: 95, label: 'Hazardous', short: 'HAZ' },
]

/** Band index 0–6 for a 0–100 risk score. Aligns 1:1 with `--ramp-aqi-*`. */
export function riskBand(risk: number | null | undefined): number {
  if (risk == null || !Number.isFinite(risk)) return 0
  let idx = 0
  for (let i = 0; i < RISK_BANDS.length; i++) if (risk >= RISK_BANDS[i].min) idx = i
  return idx
}

/** `"Elevated"` — the community-facing word for a risk score. */
export function riskLabel(risk: number | null | undefined): string {
  if (risk == null || !Number.isFinite(risk)) return 'No data'
  return RISK_BANDS[riskBand(risk)].label
}

/** `"ELEV"` — the dense/uppercase variant. */
export function riskLabelShort(risk: number | null | undefined): string {
  if (risk == null || !Number.isFinite(risk)) return EMPTY
  return RISK_BANDS[riskBand(risk)].short
}

/** `var(--ramp-aqi-N)` for a risk score. Always the AQI ramp — it is health. */
export function riskColorVar(risk: number | null | undefined): string {
  return rampVar('aqi', riskBand(risk))
}

export function riskRgb(risk: number | null | undefined): RGB {
  return tokenRgb(`--ramp-aqi-${riskBand(risk)}`)
}

/** Risk 0–100 → the concentration that produced it, via `measure_def.scale`. */
export function valueForRisk(def: MeasureDef | undefined, risk: number): number | null {
  if (!def?.scale?.length) return null
  return piecewiseInverse(def.scale, clamp(risk, 0, 100))
}

/** Concentration → 0–100 risk, via the measure's piecewise breakpoint scale. */
export function riskFromValue(def: MeasureDef | undefined, value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  if (!def?.scale?.length) return null
  return clamp(piecewise(def.scale, value), 0, 100)
}

/**
 * Normalise any metric to 0–1 for a colour ramp.
 *  · 'risk'        → risk / 100
 *  · 'persistence' → already 0–1
 *  · magnitudes    → pushed through the risk breakpoints so the ramp is
 *                    health-anchored rather than min/max-anchored.
 */
export function rampT(
  def: MeasureDef | undefined,
  value: number | null | undefined,
  metric: SegmentMetric = 'median',
): number | null {
  if (value == null || !Number.isFinite(value)) return null
  if (metric === 'risk') return clamp(value / 100, 0, 1)
  if (metric === 'persistence') return clamp(value, 0, 1)
  const risk = riskFromValue(def, value)
  if (risk != null) return clamp(risk / 100, 0, 1)
  const hi = def?.healthy_max ?? def?.ref_level
  return hi ? clamp(value / (hi * 2), 0, 1) : null
}

/** The road-grid colour for one segment feature. `null` value → transparent. */
export function segmentRgba(
  def: MeasureDef | undefined,
  props: Pick<SegmentProps, 'value' | 'persistence'>,
  metric: SegmentMetric,
  family: RampFamily = 'map',
  usePersistence = true,
): RGBA {
  const t = rampT(def, props.value, metric)
  if (t == null) return [0, 0, 0, 0]
  const alpha = usePersistence && metric !== 'persistence' ? persistAlpha(props.persistence) : 1
  return rampRgba(family, t, alpha)
}

// ────────────────────────────────────────────────────── labels & formatting

/**
 * The right *name* for the audience. Community never sees "NO₂" or a unit —
 * `measure_def.plain_name` exists for exactly this (CONTRACT §9.3).
 */
export function plainName(def: MeasureDef | undefined, role: Role | null = null): string {
  if (!def) return EMPTY
  if (role === 'community') return def.plain_name ?? def.label
  return def.label
}

/** Short label for axes and chips (community still gets plain words). */
export function shortName(def: MeasureDef | undefined, role: Role | null = null): string {
  if (!def) return EMPTY
  if (role === 'community') return def.plain_name ?? def.short_label
  return def.short_label
}

/** `''` for community, `'µg/m³'` elsewhere. */
export function unitFor(def: MeasureDef | undefined, role: Role | null = null): string {
  if (!def || role === 'community') return ''
  return def.unit ?? ''
}

export interface FormatValueOpts {
  role?: Role | null
  /** Append the unit. Ignored for community. Default true. */
  unit?: boolean
  /** Override `measure_def.decimals`. */
  decimals?: number
  /** Render as a 0–100 risk score instead of a concentration. */
  asRisk?: boolean
}

/**
 * The one function every screen should use to print a measurement.
 *   formatValue(no2, 23.4)                       → "23.4 ppb"
 *   formatValue(no2, 23.4, { unit: false })      → "23.4"
 *   formatValue(no2, 23.4, { role: 'community' })→ "61"   (risk, no unit)
 */
export function formatValue(
  def: MeasureDef | undefined,
  value: number | null | undefined,
  opts: FormatValueOpts = {},
): string {
  const { role = null, unit = true, decimals, asRisk } = opts
  if (value == null || !Number.isFinite(value)) return EMPTY
  const risk = asRisk ?? role === 'community'
  if (risk) {
    const r = riskFromValue(def, value)
    return r == null ? EMPTY : fmtNum(r, 0)
  }
  const d = decimals ?? def?.decimals ?? 1
  const n = fmtNum(value, d)
  const u = unit ? unitFor(def, role) : ''
  return u ? `${n} ${u}` : n
}

/** Split form, so a component can style the unit differently from the number. */
export function formatValueParts(
  def: MeasureDef | undefined,
  value: number | null | undefined,
  opts: FormatValueOpts = {},
): { value: string; unit: string } {
  const unit = opts.unit === false ? '' : unitFor(def, opts.role ?? null)
  return { value: formatValue(def, value, { ...opts, unit: false }), unit }
}

export const METRIC_LABEL: Record<SegmentMetric, string> = {
  median: 'Median',
  p90: '90th percentile',
  max: 'Maximum',
  persistence: 'Persistence',
  risk: 'Risk score',
}

export const METRIC_LABEL_SHORT: Record<SegmentMetric, string> = {
  median: 'MED',
  p90: 'P90',
  max: 'MAX',
  persistence: 'PERS',
  risk: 'RISK',
}

/** Metric-aware formatting: persistence prints as a %, risk as a bare score. */
export function formatMetric(
  def: MeasureDef | undefined,
  value: number | null | undefined,
  metric: SegmentMetric,
  role: Role | null = null,
): string {
  if (value == null || !Number.isFinite(value)) return EMPTY
  if (metric === 'persistence') return `${fmtNum(value * 100, 0)}%`
  if (metric === 'risk') return fmtNum(value, 0)
  return formatValue(def, value, { role })
}

/** Metrics that carry no unit and must never be shown with one. */
export function metricIsUnitless(metric: SegmentMetric): boolean {
  return metric === 'risk' || metric === 'persistence'
}

/** Look a measure up by code from the bootstrap list. */
export function findMeasure(
  measures: readonly MeasureDef[] | undefined,
  code: MeasureCode | null | undefined,
): MeasureDef | undefined {
  if (!measures || !code) return undefined
  return measures.find((m) => m.code === code)
}

export type MeasureFamily = MeasureDef['family']

/**
 * Sorted, filtered by family — `measuresOf(all, 'modality')`, or a list:
 * `measuresOf(all, ['modality', 'composite'])`.
 *
 * The list form exists because `aclima_sense` is a third family and every
 * caller that used to say `'modality'` now has to mean one of two different
 * things: "the lenses a reader may choose" (which includes the composite) or
 * "the species an instrument can carry" (which cannot). They looked identical
 * before the composite existed.
 */
export function measuresOf(
  measures: readonly MeasureDef[] | undefined,
  family?: MeasureFamily | readonly MeasureFamily[],
): MeasureDef[] {
  const want = family == null ? null : (Array.isArray(family) ? family : [family]) as MeasureFamily[]
  return (measures ?? [])
    .filter((m) => !want || want.includes(m.family))
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
}

/** The lenses a reader may pick on a map: real species plus derived indices. */
export const PICKABLE: readonly MeasureFamily[] = ['composite', 'modality']

/** Per-modality identity hue (`--mod-no2`), for multi-series charts only. */
export function modalityVar(code: MeasureCode): string {
  return `var(--mod-${code}, var(--accent))`
}

export function modalityRgb(code: MeasureCode): RGB {
  return tokenRgb(`--mod-${code}`, tokenRgb('--accent'))
}

/** Is this value over the measure's reference level? Drives the exceed styling. */
export function exceedsRef(def: MeasureDef | undefined, value: number | null | undefined): boolean {
  if (!def?.ref_level || value == null || !Number.isFinite(value)) return false
  return value > def.ref_level
}

// ──────────────────────────────────────────────────────────────── severity

export const SEVERITY_ORDER: Severity[] = ['info', 'watch', 'warning', 'critical']

export const SEVERITY_LABEL: Record<Severity, string> = {
  info: 'Info',
  watch: 'Watch',
  warning: 'Warning',
  critical: 'Critical',
}

/** Higher = worse. For sorting alert lists. */
export function severityRank(sev: Severity | null | undefined): number {
  const i = sev ? SEVERITY_ORDER.indexOf(sev) : -1
  return i < 0 ? 0 : i
}

export function severityVar(sev: Severity | null | undefined): string {
  return `var(--sev-${sev ?? 'info'})`
}

export function severityRgb(sev: Severity | null | undefined): RGB {
  return tokenRgb(`--sev-${sev ?? 'info'}`)
}

/** Community-safe wording for a severity — no jargon, no shouting. */
export const SEVERITY_PLAIN: Record<Severity, string> = {
  info: 'Heads up',
  watch: 'Keep an eye out',
  warning: 'Take care',
  critical: 'Act now',
}

/** `var(--actor-community)` — who is speaking. Consistent in all four skins. */
export function actorVar(role: Role | 'aclima' | null | undefined): string {
  return `var(--actor-${role ?? 'aclima'})`
}
