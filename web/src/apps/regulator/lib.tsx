/**
 * regulator/lib — the pieces every watchtower screen shares.
 *
 * The regulator's whole interface is two questions: "what is over the line?"
 * and "how far past my towers can I actually see?". The helpers here answer the
 * second one from the data rather than from prose — the reference network's
 * measure list and coverage radii are facts on the wire, so the gap between
 * what DRAQA can sense and what the fleet senses is arithmetic, not a claim.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { SEVERITY_GLYPH, haversine } from '@/components'
import { fmtNum } from '@/core/format'
import { SEVERITY_LABEL, severityRank, severityVar } from '@/core/measures'
import { useBootstrap, useMonitors, useSegments } from '@/core/queries'
import { useSession } from '@/core/session'
import type {
  ActionLevel, Alert, MeasureCode, MeasureDef, Monitor, Position,
  SegmentCollection, Severity,
} from '@/core/types'

import s from './regulator.module.css'

// ───────────────────────────────────────────────── a stable time window

/**
 * `timeRange()` re-derives `to` from `new Date()` on every call, so any hook
 * that defaults its window gets a fresh query key on EVERY RENDER and refetches
 * forever. Quantising to a bucket makes the key stable. (Same fix the industry
 * app carries; it belongs in `core/session`, reported rather than moved.)
 */
export function useStableWindow(hours = 24, bucketMin = 5): { from: string; to: string } {
  const cursor = useSession((x) => x.time.cursor)
  const bucketMs = bucketMin * 60_000
  const [tick, setTick] = useState(() => Math.floor(Date.now() / bucketMs))
  useEffect(() => {
    const t = setInterval(() => setTick(Math.floor(Date.now() / bucketMs)), 30_000)
    return () => clearInterval(t)
  }, [bucketMs])
  return useMemo(() => {
    const end = cursor ? new Date(cursor) : new Date(tick * bucketMs)
    return {
      from: new Date(end.getTime() - hours * 3_600_000).toISOString(),
      to: end.toISOString(),
    }
  }, [cursor, tick, bucketMs, hours])
}

export function useNowTick(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

// ───────────────────────────────────────────────────────── the towers

/** DRAQA's own reference-grade network. These are the towers. */
export function useTowers() {
  return useMonitors({ owner_type: 'regulator' })
}

export function monitorPos(m: Monitor): Position {
  return [m.lon, m.lat]
}

export const MONITOR_STATUS_LABEL: Record<string, string> = {
  online: 'ONLINE', degraded: 'DEGRADED', offline: 'OFFLINE', maintenance: 'MAINT',
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

// ──────────────────────────────────────────────────────── reach & coverage

export interface Reach {
  /** Road segments whose midpoint falls inside at least one tower's radius. */
  inside: number
  outside: number
  total: number
  kmInside: number
  kmOutside: number
  /** Per-tower: what the instrument reads, and the spread of the streets it stands for. */
  perTower: TowerReach[]
}

export interface TowerReach {
  monitor: Monitor
  segments: number
  km: number
  lo: number | null
  mid: number | null
  hi: number | null
  /** The tower's own latest number for this measure, if it carries the channel. */
  towerValue: number | null
  /** hi / towerValue — how much the single number flattens. */
  spread: number | null
}

function segMid(coords: Position[]): Position {
  return coords[Math.floor(coords.length / 2)] ?? coords[0]
}

/**
 * How far past the towers the fleet actually reaches, and how much detail is
 * lost inside a coverage ring. Both halves of the argument in one pass: the
 * streets beyond the edge that nothing stationary can see, and the 3× spread of
 * street values that one tower number stands in for.
 */
export function computeReach(
  segments: SegmentCollection | undefined,
  towers: Monitor[] | undefined,
  measure: MeasureCode,
): Reach {
  const empty: Reach = { inside: 0, outside: 0, total: 0, kmInside: 0, kmOutside: 0, perTower: [] }
  const feats = segments?.features ?? []
  const mons = towers ?? []
  if (!feats.length || !mons.length) return empty

  const buckets = new Map<string, { vals: number[]; km: number }>()
  for (const m of mons) buckets.set(m.id, { vals: [], km: 0 })

  let inside = 0
  let kmInside = 0
  let kmTotal = 0
  for (const f of feats) {
    const km = (f.properties.length_m ?? 0) / 1000
    kmTotal += km
    const mid = segMid(f.geometry.coordinates)
    let covered = false
    for (const m of mons) {
      const r = m.radius_m ?? 0
      if (r <= 0) continue
      if (haversine(mid, [m.lon, m.lat]) <= r) {
        covered = true
        const b = buckets.get(m.id)
        if (b) {
          b.km += km
          if (f.properties.value != null) b.vals.push(f.properties.value)
        }
      }
    }
    if (covered) { inside += 1; kmInside += km }
  }

  const perTower: TowerReach[] = mons.map((m) => {
    const b = buckets.get(m.id) ?? { vals: [], km: 0 }
    const v = [...b.vals].sort((a, c) => a - c)
    const towerValue = m.measures.includes(measure) ? (m.latest?.[measure]?.value ?? null) : null
    const hi = v.length ? v[v.length - 1] : null
    return {
      monitor: m,
      segments: v.length,
      km: b.km,
      lo: v.length ? v[0] : null,
      mid: v.length ? v[Math.floor(v.length / 2)] : null,
      hi,
      towerValue,
      spread: hi != null && towerValue != null && towerValue > 0 ? hi / towerValue : null,
    }
  })

  return {
    inside,
    outside: feats.length - inside,
    total: feats.length,
    kmInside,
    kmOutside: kmTotal - kmInside,
    perTower,
  }
}

export function useReach(measure: MeasureCode): { reach: Reach; segments: SegmentCollection | undefined } {
  const towers = useTowers().data
  const segs = useSegments({ measure, metric: 'p90', window: 'all' }).data
  const reach = useMemo(() => computeReach(segs, towers, measure), [segs, towers, measure])
  return { reach, segments: segs }
}

// ──────────────────────────────────────────────────────── action levels

export const KIND_LABEL: Record<ActionLevel['kind'], string> = {
  spike: 'Magnitude spike',
  integrated: 'Integrated exposure',
}
export const KIND_CODE: Record<ActionLevel['kind'], string> = {
  spike: 'SPIKE', integrated: 'INTEG',
}

/** Sort the tripwires the way an operator reads them: worst rule first. */
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

// ───────────────────────────────────────────────────────── alert helpers

export const LIVE_STATUSES = new Set(['active', 'acknowledged'])

export function liveAlerts(alerts: Alert[] | undefined): Alert[] {
  return (alerts ?? []).filter((a) => LIVE_STATUSES.has(a.status))
}

export const SOURCE_LABEL: Record<string, string> = {
  monitor: 'STATION', mobile: 'FLEET', community: 'RESIDENT', regulator: 'DRAQA', model: 'MODEL',
}

/** A monitor-sourced alert is only "one of ours" if the instrument is ours. */
export function sourceTag(a: Alert, towerIds: Set<string>): 'tower' | 'fenceline' | 'fleet' | 'community' | 'model' {
  if (a.source_type === 'mobile') return 'fleet'
  if (a.source_type === 'community') return 'community'
  if (a.source_type === 'model') return 'model'
  if (a.source_type === 'monitor') return towerIds.has(a.source_id ?? '') ? 'tower' : 'fenceline'
  return 'model'
}

export const SOURCE_TAG_LABEL: Record<string, string> = {
  tower: 'TOWER', fenceline: 'FENCE', fleet: 'FLEET', community: 'RESIDENT', model: 'MODEL',
}

/** Value ÷ threshold. The one number that says how far over the line it is. */
export function overBy(a: Alert): number | null {
  if (a.value == null || a.threshold == null || a.threshold === 0) return null
  return a.value / a.threshold
}

/** <=10 chars, for the alert-timeline label gutter. */
/** Kind → a stable short code, for alerts that name no instrument. */
const KIND_SHORT: Record<string, string> = {
  exceedance: 'EXCD',
  integrated_exposure: 'EXPO',
  concern_cluster: 'CLUSTER',
  mobile_detection: 'MOBILE',
  fleet_anomaly: 'FLEET',
  wind_shift: 'MODEL',
  regulatory_notice: 'NOTICE',
}

/**
 * A short code for the timeline gutter.
 *
 * The place half only comes from the title when the title actually names an
 * instrument — a monitor exceedance reads "… exceeded at Riverport Road", and
 * "Riverport" is a genuinely useful six characters. Everything else falls back
 * to the alert's *kind*, which is a field rather than prose.
 *
 * The previous version took the first word of whatever the title happened to
 * say, for every alert. That is fine until the copy changes, at which point the
 * gutter fills with "BC HIGHES", "CH4 METHAN", "MEASUR" and a code that is
 * literally "6" — each one looking like a spelling mistake rather than an
 * abbreviation. A code has to survive a copy edit.
 */
export function tinyCode(a: Alert): string {
  const where = shortWhere(a)
  const fence = /fenceline\s+([NSEW]{1,2})$/i.exec(where)
  const namesInstrument = / at /i.test(a.title)
  const place = fence
    ? `RL-${fence[1].toUpperCase()}`
    : namesInstrument
      ? where.split(/\s+/)[0].slice(0, 6).toUpperCase()
      : (KIND_SHORT[a.kind] ?? a.kind.slice(0, 6).toUpperCase())
  return a.measure ? `${a.measure.toUpperCase()} ${place}` : place
}

export function shortWhere(a: Alert): string {
  return a.title
    .replace(/^.* at /i, '')
    .replace(/^Mobile monitoring peak on /i, '')
    .replace(/^Community concern cluster · /i, '')
    .replace(/^Observed wind diverges from /i, '')
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
  // Naive stamps carry campaign-local time; treating them as UTC keeps the hour.
  const d = new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`)
  return Number.isNaN(d.getTime()) ? fallback % 24 : d.getUTCHours()
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

export function Caps({ children, tone }: { children: ReactNode; tone?: 'ink' | 'accent' }) {
  const cls = tone === 'ink' ? `${s.caps} ${s.capsInk}` : tone === 'accent' ? `${s.caps} ${s.capsAccent}` : s.caps
  return <span className={cls}>{children}</span>
}

export function Tag({
  tone, children, title,
}: {
  tone?: 'tower' | 'fleet' | 'invader' | 'accent' | 'community'
  children: ReactNode
  title?: string
}) {
  const map = {
    tower: s.tagTower, fleet: s.tagFleet, invader: s.tagInvader,
    accent: s.tagAccent, community: s.tagCommunity,
  } as const
  return <span className={tone ? `${s.tag} ${map[tone]}` : s.tag} title={title}>{children}</span>
}

export function Readout({
  label, value, unit, tone, big, title,
}: {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  tone?: 'over' | 'tower' | 'fleet' | 'accent'
  big?: boolean
  title?: string
}) {
  const color =
    tone === 'over' ? 'var(--invader)'
      : tone === 'tower' ? 'var(--tower)'
        : tone === 'fleet' ? 'var(--fleet)'
          : tone === 'accent' ? 'var(--accent)'
            : undefined
  return (
    <div className={s.readout} title={title}>
      <span className={`${s.readoutValue}${big ? ` ${s.readoutBig}` : ''}`} style={{ color }}>
        {value}
        {unit ? <span className={s.readoutUnit}>{unit}</span> : null}
      </span>
      <Caps>{label}</Caps>
    </div>
  )
}

export function Panel({
  title, aside, children, className, bodyClass, flat,
}: {
  title?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  flat?: boolean
}) {
  return (
    <section className={[s.panel, flat ? s.panelFlat : '', className ?? ''].filter(Boolean).join(' ')}>
      {title ? (
        <header className={s.panelHead}>
          <Caps tone="ink">{title}</Caps>
          <span className={s.spacer} />
          {aside}
        </header>
      ) : null}
      <div className={[s.panelBody, bodyClass ?? ''].filter(Boolean).join(' ')}>{children}</div>
    </section>
  )
}

/** Severity as glyph + word + colour. Never colour alone. */
export function Sev({ severity }: { severity: Severity }) {
  return (
    <span className={s.sev} style={{ color: severityVar(severity) }}>
      {SEVERITY_GLYPH[severity]} {SEVERITY_LABEL[severity].toUpperCase()}
    </span>
  )
}

/**
 * The tripwire bar. The threshold is pinned at a fixed fraction of the track so
 * every rule's line sits in the same place down the column — the eye compares
 * the *overshoot*, not the units.
 */
const WIRE_AT = 0.58

export function Wire({ value, threshold, severity }: { value: number | null; threshold: number; severity: Severity }) {
  const ratio = value != null && threshold > 0 ? value / threshold : 0
  const pct = Math.min(100, ratio * WIRE_AT * 100)
  const over = ratio >= 1
  return (
    <div className={s.wire} role="presentation">
      <div
        className={s.wireFill}
        style={{
          width: `${pct}%`,
          background: over ? severityVar(severity) : 'color-mix(in srgb, var(--accent) 55%, transparent)',
        }}
      />
      <div className={`${s.wireMark}${over ? ` ${s.wireMarkHot}` : ''}`} style={{ left: `${WIRE_AT * 100}%` }} />
    </div>
  )
}

/**
 * A unit is a symbol, not a label. `text-transform: uppercase` on a caps class
 * turns µg/m³ into MG/M³ — three orders of magnitude, silently. Units get their
 * own class and never the caps one.
 */
export function Unit({ children }: { children: ReactNode }) {
  return <span className={s.unit}>{children}</span>
}

export function fmtRatio(r: number | null): string {
  return r == null ? '—' : `${fmtNum(r, 2)}×`
}

export const styles = s
