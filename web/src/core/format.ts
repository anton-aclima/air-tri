/**
 * air — formatting helpers.
 *
 * Everything a screen needs to render a number, a date, a distance or a
 * bearing. All numerals are meant to be rendered in `--font-mono` with
 * `font-variant-numeric: tabular-nums` (see `design/base.css` → `.num`).
 *
 * Rule of thumb: these functions never return `undefined`. A missing value
 * always formats as `EMPTY` ("—") so tables never jump.
 */

import { parseCampaign } from '@/core/clock'
import { clamp } from '@/core/util'
import type { Position } from '@/core/types'

export const EMPTY = '—'

// ─────────────────────────────────────────────────────────────── numbers

const nfCache = new Map<string, Intl.NumberFormat>()

function nf(decimals: number, opts: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${decimals}|${JSON.stringify(opts)}`
  let f = nfCache.get(key)
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      ...opts,
    })
    nfCache.set(key, f)
  }
  return f
}

/** `fmtNum(12.345, 1)` → `"12.3"`. Null-safe. */
export function fmtNum(v: number | null | undefined, decimals = 1): string {
  if (v == null || !Number.isFinite(v)) return EMPTY
  return nf(decimals).format(v)
}

/** Auto-picks decimals from magnitude: 1234 → "1,234", 0.42 → "0.42". */
export function fmtAuto(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EMPTY
  const a = Math.abs(v)
  if (a >= 100) return fmtNum(v, 0)
  if (a >= 10) return fmtNum(v, 1)
  if (a >= 1) return fmtNum(v, 2)
  return fmtNum(v, 3)
}

/** `fmtCompact(24500)` → `"24.5k"`. For KPI tiles. */
export function fmtCompact(v: number | null | undefined, decimals = 1): string {
  if (v == null || !Number.isFinite(v)) return EMPTY
  const a = Math.abs(v)
  if (a < 1000) return fmtNum(v, a < 10 && !Number.isInteger(v) ? decimals : 0)
  if (a < 1e6) return `${fmtNum(v / 1e3, a < 1e4 ? decimals : 0)}k`
  if (a < 1e9) return `${fmtNum(v / 1e6, decimals)}M`
  return `${fmtNum(v / 1e9, decimals)}B`
}

/** `fmtPct(0.734)` → `"73%"`. Pass `fraction: false` if the value is already 0–100. */
export function fmtPct(
  v: number | null | undefined,
  decimals = 0,
  fraction = true,
): string {
  if (v == null || !Number.isFinite(v)) return EMPTY
  return `${fmtNum(fraction ? v * 100 : v, decimals)}%`
}

/** `fmtSigned(-3.2, 1)` → `"−3.2"` (true minus sign), `+3.2` for positives. */
export function fmtSigned(v: number | null | undefined, decimals = 1): string {
  if (v == null || !Number.isFinite(v)) return EMPTY
  if (v === 0) return fmtNum(0, decimals)
  const sign = v > 0 ? '+' : '−'
  return `${sign}${fmtNum(Math.abs(v), decimals)}`
}

/** Trend badge text: `fmtTrend(-12)` → `"−12%"`. */
export function fmtTrend(pct: number | null | undefined, decimals = 0): string {
  if (pct == null || !Number.isFinite(pct)) return EMPTY
  return `${fmtSigned(pct, decimals)}%`
}

export function fmtRange(
  lo: number | null | undefined,
  hi: number | null | undefined,
  decimals = 1,
): string {
  if (lo == null && hi == null) return EMPTY
  return `${fmtNum(lo, decimals)}–${fmtNum(hi, decimals)}`
}

/** Pads to a fixed width so mono readouts don't shift: `padNum(7, 3)` → `"007"`. */
export function padNum(v: number, width = 2): string {
  return Math.trunc(Math.abs(v)).toString().padStart(width, '0')
}

export function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`)
}

/** `countOf(3, 'concern')` → `"3 concerns"`. */
export function countOf(n: number, singular: string, plural?: string): string {
  return `${fmtNum(n, 0)} ${pluralize(n, singular, plural)}`
}

// ─────────────────────────────────────────────────────────────── dates

function toDate(input: string | number | Date | null | undefined): Date | null {
  if (input == null) return null
  // Strings are naive campaign time (core/clock): the digits are the truth, a
  // `Z` or offset is dropped rather than converted, and a date-only string is
  // local midnight — `new Date('2026-05-31')` is UTC midnight, the day before
  // in the Americas.
  const d = input instanceof Date ? input
    : typeof input === 'string' ? parseCampaign(input)
      : new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}

const dtCache = new Map<string, Intl.DateTimeFormat>()
function dtf(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts)
  let f = dtCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', opts)
    dtCache.set(key, f)
  }
  return f
}

/** `"Aug 27"` */
export function fmtDay(input: string | Date | null | undefined): string {
  const d = toDate(input)
  return d ? dtf({ month: 'short', day: 'numeric' }).format(d) : EMPTY
}

/** `"Wed Aug 27"` */
export function fmtDayFull(input: string | Date | null | undefined): string {
  const d = toDate(input)
  return d ? dtf({ weekday: 'short', month: 'short', day: 'numeric' }).format(d) : EMPTY
}

/** `"2026-08-27"` — the wire/window format used by `window=date:YYYY-MM-DD`. */
export function isoDate(input: string | Date | null | undefined): string {
  const d = toDate(input)
  if (!d) return EMPTY
  return `${d.getFullYear()}-${padNum(d.getMonth() + 1)}-${padNum(d.getDate())}`
}

/** `"5:42 PM"` */
export function fmtTime(input: string | Date | null | undefined): string {
  const d = toDate(input)
  return d ? dtf({ hour: 'numeric', minute: '2-digit' }).format(d) : EMPTY
}

/** `"17:42"` — 24 h, for consoles and RWR readouts. */
export function fmtTime24(input: string | Date | null | undefined): string {
  const d = toDate(input)
  return d ? `${padNum(d.getHours())}:${padNum(d.getMinutes())}` : EMPTY
}

/** `"17:42:09"` */
export function fmtClock(input: string | Date | null | undefined): string {
  const d = toDate(input)
  return d ? `${padNum(d.getHours())}:${padNum(d.getMinutes())}:${padNum(d.getSeconds())}` : EMPTY
}

/** `"Aug 27, 5:42 PM"` */
export function fmtDateTime(input: string | Date | null | undefined): string {
  const d = toDate(input)
  return d
    ? dtf({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
    : EMPTY
}

/** `"27 Aug 17:42Z"`-flavoured dense stamp for regulator/industry chrome. */
export function fmtStamp(input: string | Date | null | undefined): string {
  const d = toDate(input)
  if (!d) return EMPTY
  return `${padNum(d.getDate())} ${dtf({ month: 'short' }).format(d).toUpperCase()} ${padNum(d.getHours())}:${padNum(d.getMinutes())}`
}

/** `"14"` from `'hour:14'`, or the hour of a date. For diurnal axes. */
export function fmtHourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  if (h === 0) return '12a'
  if (h === 12) return '12p'
  return h < 12 ? `${h}a` : `${h - 12}p`
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/**
 * `"14 min ago"`, `"just now"`, `"3 d ago"`, `"in 2 h"`.
 * `now` defaults to wall-clock now — pass the session time cursor when the UI
 * is scrubbed into the past so relative labels stay honest.
 */
/**
 * `"3 min ago"`, measured from the DEMO's now — which is required, so nothing
 * can silently measure from the wall clock again (a month past the data, every
 * age read "4 wk"). A time after `now` is not shown as "in 2 d": the event had
 * not happened yet at the moment on screen, and the caller should not have
 * rendered it (docs/PLAN-refocus.md F2). It reads "just now" as a last resort.
 */
export function relativeTime(
  input: string | Date | null | undefined,
  now: string | Date,
): string {
  const d = toDate(input)
  const n = toDate(now)
  if (!d || !n) return EMPTY
  const ms = n.getTime() - d.getTime()
  const a = Math.max(0, ms)
  let text: string
  if (a < 45_000) return 'just now'
  else if (a < HOUR) text = `${Math.round(a / MIN)} min`
  else if (a < DAY) text = `${Math.round(a / HOUR)} h`
  else if (a < 7 * DAY) text = `${Math.round(a / DAY)} d`
  else if (a < 60 * DAY) text = `${Math.round(a / (7 * DAY))} wk`
  else text = `${Math.round(a / (30 * DAY))} mo`
  return `${text} ago`
}

/** Short form for dense lists: `"14m"`, `"3h"`, `"2d"`. */
/**
 * Short form for dense lists: `"14m"`, `"3h"`, `"2d"`. Same rules as
 * `relativeTime`. It used `Math.abs`, which turned a start in the future into
 * a past duration — "UP FOR 16d" on an alert that had not begun.
 */
export function relativeShort(
  input: string | Date | null | undefined,
  now: string | Date,
): string {
  const d = toDate(input)
  const n = toDate(now)
  if (!d || !n) return EMPTY
  const a = Math.max(0, n.getTime() - d.getTime())
  if (a < MIN) return 'now'
  if (a < HOUR) return `${Math.round(a / MIN)}m`
  if (a < DAY) return `${Math.round(a / HOUR)}h`
  return `${Math.round(a / DAY)}d`
}

/** `"01:24:09"` elapsed — how long an RWR contact has been up. */
export function fmtElapsed(
  since: string | Date | null | undefined,
  until: string | Date,
): string {
  const d = toDate(since)
  const end = toDate(until)
  if (!d || !end) return EMPTY
  const secs = Math.max(0, Math.round((end.getTime() - d.getTime()) / 1000))
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return h > 0 ? `${padNum(h)}:${padNum(m)}:${padNum(s)}` : `${padNum(m)}:${padNum(s)}`
}

/** `fmtDuration(5_400_000)` → `"1 h 30 m"`. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return EMPTY
  const mins = Math.round(Math.abs(ms) / MIN)
  if (mins < 60) return `${mins} m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 24) return m ? `${h} h ${m} m` : `${h} h`
  const d = Math.floor(h / 24)
  return `${d} d ${h % 24} h`
}

export function fmtDurationMin(minutes: number | null | undefined): string {
  return minutes == null ? EMPTY : fmtDuration(minutes * MIN)
}

// ─────────────────────────────────────────────────────────── space & bearing

/** `"820 m"` / `"1.2 km"`. */
export function fmtDistance(metres: number | null | undefined, decimals = 1): string {
  if (metres == null || !Number.isFinite(metres)) return EMPTY
  const m = Math.abs(metres)
  if (m < 1000) return `${fmtNum(m, 0)} m`
  return `${fmtNum(m / 1000, decimals)} km`
}

/** `"0.5 mi"` — for community copy, which reads in miles. */
export function fmtDistanceImperial(metres: number | null | undefined): string {
  if (metres == null || !Number.isFinite(metres)) return EMPTY
  const feet = metres * 3.280_84
  if (feet < 1000) return `${fmtNum(Math.round(feet / 10) * 10, 0)} ft`
  return `${fmtNum(feet / 5280, 1)} mi`
}

export function fmtKm(metres: number | null | undefined, decimals = 1): string {
  if (metres == null || !Number.isFinite(metres)) return EMPTY
  return `${fmtNum(metres / 1000, decimals)} km`
}

const POINTS_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
] as const

/** 16-point compass abbreviation: `compassPoint(112)` → `"ESE"`. */
export function compassPoint(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return EMPTY
  const d = ((deg % 360) + 360) % 360
  return POINTS_16[Math.round(d / 22.5) % 16]
}

const POINT_NAMES: Record<string, string> = {
  N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast',
  E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast',
  S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest',
  W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest',
}

/** Plain-words direction for community copy: `"east-southeast"`. */
export function compassWords(deg: number | null | undefined): string {
  const p = compassPoint(deg)
  return POINT_NAMES[p] ?? EMPTY
}

/** `"ESE 112°"` — the RWR bearing readout. */
export function fmtBearing(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return EMPTY
  const d = ((deg % 360) + 360) % 360
  return `${compassPoint(d)} ${padNum(Math.round(d), 3)}°`
}

/** `"112°"` only. */
export function fmtDegrees(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return EMPTY
  return `${padNum(Math.round(((deg % 360) + 360) % 360), 3)}°`
}

/** Wind: `"from the SW at 3.4 m/s"`. Meteorological convention (blows FROM). */
export function fmtWind(speedMs: number | null | undefined, dirDeg: number | null | undefined): string {
  if (speedMs == null && dirDeg == null) return EMPTY
  return `${compassPoint(dirDeg)} ${fmtNum(speedMs, 1)} m/s`
}

export function fmtWindWords(speedMs: number | null | undefined, dirDeg: number | null | undefined): string {
  if (speedMs == null && dirDeg == null) return EMPTY
  return `from the ${compassWords(dirDeg)} at ${fmtNum((speedMs ?? 0) * 2.236_94, 0)} mph`
}

const R_EARTH_M = 6_371_008.8

/** Great-circle distance in metres between two `[lon, lat]` positions. */
export function distanceBetween(a: Position, b: Position): number {
  const [lon1, lat1] = a
  const [lon2, lat2] = b
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dp = p2 - p1
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing in degrees (0–360) from `a` to `b`. */
export function bearingBetween(a: Position, b: Position): number {
  const [lon1, lat1] = a
  const [lon2, lat2] = b
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360
}

/** `"35.0581, −90.1320"` */
export function fmtLatLon(pos: Position | null | undefined, decimals = 4): string {
  if (!pos) return EMPTY
  return `${fmtNum(pos[1], decimals)}, ${fmtNum(pos[0], decimals)}`
}

// ─────────────────────────────────────────────────────────────── text

export function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** `'concern_cluster'` → `'Concern cluster'`. Enum → prose. */
export function humanize(s: string | null | undefined): string {
  if (!s) return EMPTY
  const t = s.replace(/[_-]+/g, ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** `'Marla Whitfield'` → `'MW'`. */
export function initials(name: string | null | undefined): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'
}

export function truncate(s: string | null | undefined, max = 120): string {
  if (!s) return ''
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}

/** Clamp a 0–1 progress value and format as a bar width percentage string. */
export function pctWidth(t: number): string {
  return `${clamp(t, 0, 1) * 100}%`
}
