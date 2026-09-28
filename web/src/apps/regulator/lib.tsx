/**
 * regulator/lib — the pieces the agency's screens share.
 *
 * The regulator's interface answers three questions in order (owner,
 * 2026-09-23): what the reference monitors report, what the fleet's streets
 * add between them and where each site's plume is modelled to go, and where
 * residents are reporting. The helpers here keep those answers on the data
 * rather than in prose — the reference network's channel list and radii are
 * facts on the wire, so the gap between what DRAQA's monitors carry and what
 * the fleet measures is arithmetic, not a claim.
 */

import { useMemo } from 'react'

import { haversine } from '@/components'
import type { SegmentFeature } from '@/components'
import { STREETS_WINDOW_HOURS } from '@/core/api'
import { addHours, campaignMs, floorTo } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import { happenedBy } from '@/core/events'
import { fmtDay, fmtTime24 } from '@/core/format'
import { severityRank } from '@/core/measures'
import { useBootstrap, useMonitors } from '@/core/queries'
import { useNowCampaign } from '@/core/session'
import type {
  ActionLevel, Concern, ConcernCluster, MeasureCode, MeasureDef, Monitor, Position,
  RegulatorNetworkPlume, RegulatorStreetsWindow, StreetsWindow, TouchdownState,
} from '@/core/types'

import s from './regulator.module.css'

// ───────────────────────────────────────────────── a stable time window

/**
 * A trailing window ending at the demo's now, in naive campaign time.
 *
 * This used to build both ends with `toISOString()` — UTC, with a `Z` — which
 * the server reads as Chicago digits, so in a Pacific browser every trace here
 * ended seven hours from the moment on screen. It also ticked a wall-clock
 * interval, which at the end of the data meant a window a month past the last
 * reading. Now the end is the session's now (the cursor, or the end of the
 * data), floored to the bucket so a playing cursor re-keys the query once per
 * bucket rather than on every step.
 */
export function useStableWindow(hours = 24, bucketMin = 5): { from: CampaignTime; to: CampaignTime } {
  const now = useNowCampaign()
  return useMemo(() => {
    const to = floorTo(now, bucketMin)
    return { from: addHours(to, -hours), to }
  }, [now, bucketMin, hours])
}

// ─────────────────────────────────────────────────── the street window

/**
 * The Network's street window, in the words the screen prints (F2, F4). ONE
 * window, ending at the moment shown, for the coloured streets on the map
 * and for every street figure in the panel and the header — so no line needs
 * a "whole day" or a "by 06:00" to explain why the map and a count disagree.
 */
export const STREETS_WINDOWS: readonly { value: StreetsWindow; label: string; title: string }[] = [
  { value: '24h', label: '24 h', title: 'Streets measured in the 24 hours to the moment shown' },
  { value: '7d', label: '7 d', title: 'Streets measured in the 7 days to the moment shown' },
  { value: 'todate', label: 'To date', title: 'Every street measured up to the moment shown' },
]

/** "24 h", "7 days"; null for `todate`, which has no length. */
function spanOf(kind: StreetsWindow): string | null {
  return kind === '24h' ? '24 h' : kind === '7d' ? '7 days' : null
}

/** "Aug 25 06:00": a window's end, in campaign time. */
export function stampOf(t: CampaignTime): string {
  return `${fmtDay(t)} ${fmtTime24(t)}`
}

/** "7 days to Aug 25 06:00", "to Aug 25 06:00". */
export function windowPhrase(kind: StreetsWindow, at: CampaignTime): string {
  const span = spanOf(kind)
  return span ? `${span} to ${stampOf(at)}` : `to ${stampOf(at)}`
}

/**
 * The window relative to a moment the sentence already names ("At 06:00 …"):
 * "in the last 24 h", "in the last 7 days", "to date".
 */
export function windowRelative(kind: StreetsWindow): string {
  const span = spanOf(kind)
  return span ? `in the last ${span}` : 'to date'
}

/** The street key's title: "Measured, 7 days to Aug 25 06:00" / "Measured to Aug 25 06:00". */
export function windowTitle(kind: StreetsWindow, at: CampaignTime): string {
  return spanOf(kind) ? `Measured, ${windowPhrase(kind, at)}` : `Measured ${windowPhrase(kind, at)}`
}

/**
 * The header number's label, short for the R9 budget: "street-km measured,
 * 7 days to 13:54". `todate` says "to date": at a replayed moment that is up
 * to the moment shown, which every header number already is.
 */
export function windowKmLabel(kind: StreetsWindow, at: CampaignTime): string {
  const span = spanOf(kind)
  return span ? `street-km measured, ${span} to ${fmtTime24(at)}` : 'street-km measured to date'
}

/**
 * A window with no pass in it, said as such rather than as an empty ramp:
 * "No NO2 passes in the 7 days to Aug 24 06:00 · last one Aug 15 20:30". Said
 * for the pollutant, not for the driving: the server judges a window empty
 * per pollutant, so a window whose every pass had this pollutant invalid is
 * empty although the fleet drove it. `label` is the measure's short name. The
 * fleet drives day shifts Monday to Saturday with an off-week (61 of ~90
 * days have driving, none Aug 16–23), so a trailing 24 h is often empty.
 */
export function emptyWindowLine(
  kind: StreetsWindow, at: CampaignTime, lastPass: CampaignTime | null, label: string,
): string {
  const span = spanOf(kind)
  const head = span
    ? `No ${label} passes in the ${span} to ${stampOf(at)}`
    : `No ${label} passes up to ${stampOf(at)}`
  return lastPass ? `${head} · last one ${stampOf(lastPass)}` : head
}

/**
 * Is this payload's `streets_window` the window asked for? Judged on the
 * length, so it holds whatever `kind` spells. A payload kept on screen
 * (`TIMED`) from before a window switch fails it: its street figures belong
 * to the other window and are not printed under this one's label.
 */
export function isStreetsWindow(w: RegulatorStreetsWindow | null | undefined, kind: StreetsWindow): boolean {
  return !!w && (w.hours ?? null) === STREETS_WINDOW_HOURS[kind]
}

/**
 * The window holds no pass: none at or before its end, or none after its
 * start. Either window shape — the network payload's `streets_window` or a
 * computed `/segments` body's `window` — carries the two fields it reads.
 */
export function windowIsEmpty(w: Pick<RegulatorStreetsWindow, 'from' | 'last_pass_at'>): boolean {
  if (!w.last_pass_at) return true
  return w.from != null && campaignMs(w.last_pass_at) <= campaignMs(w.from)
}

// ─────────────────────────────────────────────── the reference monitors

/**
 * DRAQA's own reference-grade network. (Named `useTowers` in code — the tower
 * glyph stays on the map; the copy says "reference monitors", D10.)
 */
export function useTowers() {
  return useMonitors({ owner_type: 'regulator' })
}

/**
 * Every measure the reference network can produce a number for, at all.
 *
 * This is the leapfrog, and it is a property of the instrument list rather than
 * anything we assert: no DRAQA reference monitor carries a BC, CH4 or diesel
 * channel, so those action levels are unreachable by their own network no
 * matter how the thresholds are set.
 */
export function towerMeasures(towers: Monitor[] | undefined): Set<MeasureCode> {
  const out = new Set<MeasureCode>()
  for (const m of towers ?? []) for (const c of m.measures) out.add(c)
  return out
}

export function towersFor(towers: Monitor[] | undefined, measure: MeasureCode): Monitor[] {
  return (towers ?? []).filter((m) => m.measures.includes(measure))
}

// ─────────────────────────────────────────────────── a monitor's ring

function segMid(coords: Position[]): Position {
  return coords[Math.floor(coords.length / 2)] ?? coords[0]
}

/**
 * The streets whose midpoint falls inside a monitor's representativeness ring
 * (`radius_m`). The one geometry the monitor detail compares against: the
 * streets highlighted on the map are exactly the streets in the range printed
 * beside the monitor's own number.
 */
export function streetsInRing(
  features: readonly SegmentFeature[] | undefined,
  m: { lon: number; lat: number; radius_m: number | null },
): SegmentFeature[] {
  const r = m.radius_m ?? 0
  if (r <= 0 || !features?.length) return []
  const at: Position = [m.lon, m.lat]
  return features.filter((f) => haversine(segMid(f.geometry.coordinates), at) <= r)
}

/** The middle value, or null for an empty list. Even counts average the pair. */
export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/**
 * A place name short enough for a map label: "Riverport Rd", "West Shelby Dr".
 * The panel prints the full name; the map has 40 px between the Riverport
 * Road monitor and the Riverport site, and every character there is a
 * collision (PLAN-refocus R3's own example reads "Riverport Rd 10.6").
 */
export function shortPlace(name: string): string {
  return name
    .replace(/\bRoad\b/g, 'Rd')
    .replace(/\bAvenue\b/g, 'Ave')
    .replace(/\bDrive\b/g, 'Dr')
    .replace(/\bStreet\b/g, 'St')
    .replace(/\bBoulevard\b/g, 'Blvd')
}

/** Words that describe a facility rather than name its operator. */
const FACILITY_WORDS = new Set([
  'north', 'south', 'east', 'west', 'campus', 'terminal', 'intermodal', 'channel', 'avenue',
  'works', 'plant', 'facility', 'site', 'yard', 'center', 'centre',
])

/**
 * A site's short name for a map label and a panel line: the words before the
 * first facility word — "Ridgeline", "Riverport", "Delta Forge". "Delta Forge
 * Channel Avenue Works" was 32 characters of mono across the Harbor Avenue
 * monitor, and five of the page's ~120-word budget (R9). The full name stays
 * in the detail. Falls back to the whole name when it starts with one.
 */
export function shortSite(name: string): string {
  const words = name.split(/\s+/)
  const cut = words.findIndex((w) => FACILITY_WORDS.has(w.toLowerCase()))
  return cut > 0 ? words.slice(0, cut).join(' ') : name
}

// ───────────────────────────────────────────────────────── the plumes

/**
 * Does this site's modelled outline touch anything the regulator can check —
 * a reference monitor (inside the solid part only), a street the fleet drove
 * in the street window, or an open resident cluster? Only those sites get an
 * axis, a label and a Plumes row (R2): three full cones with axes and dashed
 * tails over one map is the busy map the owner objected to, and a plume over
 * nothing anyone measured has nothing to say yet.
 */
export function plumeTouches(p: RegulatorNetworkPlume): boolean {
  return p.touches.monitor_ids.length > 0
    || p.touches.streets_driven > 0
    || p.touches.open_cluster_ids.length > 0
}

/**
 * The coverage floor (P6-E): fewer streets than this inside an outline's solid
 * part and nothing is said about the streets there. The server's
 * `network.COVERAGE_FLOOR_STREETS` — it sets `below_coverage_floor` from the
 * same 8 — and the payload does not carry it, so it is written here once.
 */
export const COVERAGE_FLOOR_STREETS = 8

/**
 * Why a plume's streets say nothing, or null when they may. Two different
 * reasons, said differently: an outline over too few streets can never be
 * judged by driving it more ("its outline covers only 5 streets — too few to
 * say"); an outline over enough streets that the fleet did not drive enough
 * of can ("not enough of this area was driven to say").
 */
export function plumeCoverageLine(p: RegulatorNetworkPlume): string | null {
  const inside = p.streets_inside
  if (inside < COVERAGE_FLOOR_STREETS) {
    const n = inside === 0 ? 'no streets' : `only ${inside} ${inside === 1 ? 'street' : 'streets'}`
    return `its outline covers ${n} — too few to say`
  }
  return p.below_coverage_floor ? 'not enough of this area was driven to say' : null
}

/**
 * The measured downwind test, as a sentence per state. Figures are printed
 * ONLY for `elevated_downwind` (CONTRACT §10a.4): Delta Forge's 1.8 ppb with a
 * CI and a sample size was printed for a stratum whose rotated bearings came
 * within 0.73 of it — a number for a test it failed.
 */
export const TOUCHDOWN_SENTENCE: Record<TouchdownState, string> = {
  elevated_downwind: 'measured downwind excess · passed the rotation check',
  no_detection: 'measured, inside the noise',
  contested: 'a rotated bearing matched it',
  insufficient_passes: 'not enough to say',
  not_measured: 'not enough to say',
}

export function touchdownSentence(state: string | null | undefined): string {
  return (state && (TOUCHDOWN_SENTENCE as Record<string, string>)[state]) ?? 'not enough to say'
}

// ──────────────────────────────────────────────────────── resident reports

/**
 * The reports as they stood at the demo's now. Replay rewinds events too
 * (docs/PLAN-refocus.md D2): a report is drawn once it was filed, and a
 * cluster only once one of its reports was, with its count and "last" taken
 * from the reports filed by then. The stored row carries the cluster's final
 * count, which in replay is the future. Each report's `status` and
 * `corroborations` already arrive as they stood at `at` (server/statusat.py);
 * a step the data does not stamp under-claims, never runs ahead.
 */
export function reportsAsOf(
  allConcerns: Concern[] | undefined,
  allClusters: ConcernCluster[] | undefined,
  now: CampaignTime,
): { concerns: Concern[]; clusters: ConcernCluster[] } {
  const concerns = happenedBy(allConcerns, now)
  const at = campaignMs(now)
  const begun = (allClusters ?? []).filter((g) => campaignMs(g.first_at) <= at)
  // Until the reports load there are no members to count from.
  if (!allConcerns) return { concerns, clusters: begun }
  const members = new Map<string, { count: number; last: string }>()
  for (const c of concerns) {
    if (!c.cluster_id) continue
    const m = members.get(c.cluster_id)
    if (!m) members.set(c.cluster_id, { count: 1, last: c.occurred_at })
    else {
      m.count += 1
      if (campaignMs(c.occurred_at) > campaignMs(m.last)) m.last = c.occurred_at
    }
  }
  const clusters = begun.flatMap((g) => {
    const m = members.get(g.id)
    if (!m) return []
    return m.count === g.count ? [g] : [{ ...g, count: m.count, last_at: m.last }]
  })
  return { concerns, clusters }
}

// ──────────────────────────────────────────────────────── action levels

/** Sort the action levels the way the agency reads them: worst rule first. */
export function sortLevels(levels: ActionLevel[]): ActionLevel[] {
  return [...levels].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.measure.localeCompare(b.measure) ||
      a.threshold - b.threshold,
  )
}

/**
 * A slider needs a range, and a regulatory limit needs a range that makes the
 * *interesting* part of the travel wide. Anchored on the seeded value so the
 * standard sits comfortably mid-scale and both directions are reachable.
 */
export function sliderRange(level: ActionLevel, seeded: number): [number, number, number] {
  const base = seeded > 0 ? seeded : level.threshold || 1
  const max = base * 2.5
  const step = base >= 50 ? 1 : base >= 10 ? 0.5 : base >= 2 ? 0.1 : 0.05
  return [0, Math.round(max / step) * step, step]
}

export function levelUnit(level: ActionLevel): string {
  return level.unit === 'ug/m3' ? 'µg/m³' : level.unit
}

// ──────────────────────────────────────────────────────── diurnal binning

/**
 * `SegmentDetail.diurnal` labels its points `'02'`, `MonitorReadings` labels
 * them with a naive ISO stamp, and `DiurnalClock` documents `'hour:HH'` — so its
 * own parser silently falls back to *array index* for the first two, which puts
 * a 03:00 peak wherever it happens to sit in the list. Normalising to a fixed
 * 24-slot array here means the clock is fed plain numbers and cannot misplace
 * an hour. (Reported; not fixed in shared code.)
 */
export function hourOf(t: string, fallback: number): number {
  const tagged = /hour:(\d{1,2})/.exec(t)
  if (tagged) return Number(tagged[1]) % 24
  if (/^\d{1,2}$/.test(t.trim())) return Number(t) % 24
  // Naive stamps carry campaign-local time: read the digits (core/clock), on
  // the campaign axis so a DST gap in the viewer's zone cannot move the hour. A
  // `Z` or offset is dropped, not converted.
  const ms = campaignMs(t)
  return Number.isFinite(ms) ? new Date(ms).getUTCHours() : fallback % 24
}

/** Any per-hour series → 24 slots, means where an hour repeats. */
export function toDiurnal24(points: { t: string; v: number | null }[] | undefined): (number | null)[] {
  const sum = new Array<number>(24).fill(0)
  const n = new Array<number>(24).fill(0)
  for (let i = 0; i < (points?.length ?? 0); i += 1) {
    const p = points![i]
    if (p.v == null) continue
    const h = hourOf(p.t, i)
    sum[h] += p.v
    n[h] += 1
  }
  return sum.map((total, i) => (n[i] ? total / n[i] : null))
}

/** Peak hour and how many times the day's own median it is. */
export function peakOf(values: (number | null)[]): { hour: number; value: number; ratio: number; covered: number } | null {
  const present = values
    .map((v, h) => ({ v, h }))
    .filter((x): x is { v: number; h: number } => x.v != null)
  if (present.length < 3) return null
  const sorted = [...present].sort((a, b) => a.v - b.v)
  const med = sorted[Math.floor(sorted.length / 2)].v
  const top = present.reduce((a, b) => (b.v > a.v ? b : a))
  return { hour: top.h, value: top.v, ratio: med > 0 ? top.v / med : 1, covered: present.length }
}

// ─────────────────────────────────────────────────────────── measures

export function useMeasureMap(): Map<MeasureCode, MeasureDef> {
  const boot = useBootstrap().data
  return useMemo(() => {
    const m = new Map<MeasureCode, MeasureDef>()
    for (const d of boot?.measures ?? []) m.set(d.code, d)
    return m
  }, [boot])
}

// ────────────────────────────────────────────────────────── presentational
//
// Retired with the old screens (R8, CONTRACT §10a.7): the all-caps source
// tags (STATION, TOWER, RESIDENT), the kind codes (SPIKE, INTEG, EXCD), the
// capitals severity annunciator and the threat-red `invader` chip, with the
// alert helpers that printed them. The words the Alerts, Levels and Push
// screens print live in `alerting.ts`, in sentence case; `Panel` lives in
// `Panel.tsx`, so this file exports no component and every screen keeps fast
// refresh.

export const styles = s
