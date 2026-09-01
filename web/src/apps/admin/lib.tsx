/**
 * admin/lib — the drafting table's shared furniture.
 *
 * Every admin screen is a *sheet* in one drawing set: a title block across the
 * top, numbered sheets underneath, measured readouts in the margins. The pieces
 * here exist so all seven screens read as pages of the same drawing rather than
 * seven dashboards that happen to share a skin.
 */

import { useMemo, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { create } from 'zustand'

import { API_BASE } from '@/core/api'
import { fmtNum } from '@/core/format'
import { useDrivePlan as useDrivePlanRaw } from '@/core/queries'
import { DEFAULT_VIEW, useDemoClock } from '@/core/session'
import type { Campaign, DrivePlan, Position, Role, SegmentCollection } from '@/core/types'

import s from './admin.module.css'

export { s as styles }

// ══════════════════════════════════════════════════════════ the drawing set

/** Sheet numbers are the spine of the whole interface — one per route. */
export const SHEET = {
  overview: { no: '01', code: 'OVR', title: 'Campaign overview' },
  campaign: { no: '02', code: 'CMPGN', title: 'Area of concern' },
  driveplan: { no: '03', code: 'PLAN', title: 'Drive plan' },
  fleet: { no: '04', code: 'FLEET', title: 'Fleet' },
  data: { no: '05', code: 'DATA', title: 'Measurement language' },
  oversight: { no: '06', code: 'OVRST', title: 'Oversight' },
  director: { no: '07', code: 'DRCT', title: 'Demo director' },
} as const

export type SheetKey = keyof typeof SHEET

// ══════════════════════════════════════════════════════════════ primitives

export function Caps({
  children, ink, accent, className,
}: { children: ReactNode; ink?: boolean; accent?: boolean; className?: string }) {
  return (
    <span
      className={[s.caps, ink ? s.capsInk : '', accent ? s.capsAccent : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  )
}

export interface TitleBlockCell {
  label: ReactNode
  value: ReactNode
  tone?: 'accent' | 'warn'
}

/**
 * The engineering title block. Project on the left, sheet number in its own
 * box, the numbers that define this sheet ruled off on the right.
 */
export function TitleBlock({
  sheet, title, subtitle, cells, aside,
}: {
  sheet: SheetKey
  title?: string
  subtitle?: ReactNode
  cells?: TitleBlockCell[]
  aside?: ReactNode
}) {
  const meta = SHEET[sheet]
  return (
    <div className={s.titleBlock}>
      <div className={s.tbSheet}>
        <Caps>sheet</Caps>
        <span className={s.tbSheetNo}>{meta.no}</span>
      </div>
      <div className={s.tbMain}>
        <span className={s.tbTitle}>{title ?? meta.title}</span>
        <span className={s.tbSub}>{subtitle}</span>
      </div>
      {cells?.length ? (
        <div className={s.tbCells}>
          {cells.map((c, i) => (
            <div className={s.tbCell} key={i}>
              <Caps>{c.label}</Caps>
              <span
                className={[
                  s.tbCellValue,
                  c.tone === 'accent' ? s.tbCellAccent : '',
                  c.tone === 'warn' ? s.tbCellWarn : '',
                ].filter(Boolean).join(' ')}
              >
                {c.value}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {aside ? <div className={s.tbCell}>{aside}</div> : null}
    </div>
  )
}

/** A numbered sheet: code chip, uppercase title, an aside, a scrolling body. */
export function Sheet({
  code, title, aside, children, className, bodyClass, flat, pad,
}: {
  code?: string
  title?: ReactNode
  aside?: ReactNode
  children?: ReactNode
  className?: string
  bodyClass?: string
  /** The body is a positioning context that does not scroll (maps). */
  flat?: boolean
  pad?: boolean
}) {
  return (
    <section className={[s.sheet, className ?? ''].filter(Boolean).join(' ')}>
      {code || title || aside ? (
        <header className={s.sheetHead}>
          {code ? <span className={s.sheetCode}>{code}</span> : null}
          {title ? <h2 className={s.sheetTitle}>{title}</h2> : null}
          {aside ? <div className={s.sheetAside}>{aside}</div> : null}
        </header>
      ) : null}
      <div
        className={[
          s.sheetBody,
          flat ? s.sheetBodyFlat : '',
          pad ? s.pad : '',
          bodyClass ?? '',
        ].filter(Boolean).join(' ')}
      >
        {children}
      </div>
    </section>
  )
}

export type Tone = 'accent' | 'warn' | 'crit' | 'dim'

const TONE_CLASS: Record<Tone, string> = {
  accent: s.rAccent, warn: s.rWarn, crit: s.rCrit, dim: s.rDim,
}

export function Readout({
  label, value, foot, tone, size = 'md',
}: {
  label: ReactNode
  value: ReactNode
  foot?: ReactNode
  tone?: Tone
  size?: 'sm' | 'md' | 'lg'
}) {
  return (
    <div className={s.readout}>
      <Caps>{label}</Caps>
      <span
        className={[
          s.readoutValue,
          size === 'lg' ? s.readoutBig : '',
          size === 'sm' ? s.readoutSm : '',
          tone ? TONE_CLASS[tone] : '',
        ].filter(Boolean).join(' ')}
      >
        {value}
      </span>
      {foot ? <span className={s.readoutFoot}>{foot}</span> : null}
    </div>
  )
}

export function Readouts({ children }: { children: ReactNode }) {
  return <div className={s.readouts}>{children}</div>
}

export function KV({ rows, wide }: { rows: [ReactNode, ReactNode][]; wide?: boolean }) {
  return (
    <div className={[s.kv, wide ? s.kvWide : ''].filter(Boolean).join(' ')}>
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <div className={s.kvKey}>{k}</div>
          <div className={s.kvVal}>{v}</div>
        </div>
      ))}
    </div>
  )
}

/** A measured dimension line — how far along something is, drawn not written. */
export function Dimension({ pct, label }: { pct: number; label: ReactNode }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className={s.dimension}>
      <div className={s.dimensionFill} style={{ width: `${clamped}%` }} />
      <span className={s.dimensionLabel}>{label}</span>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════ actors

export const ACTOR_VAR: Record<Role, string> = {
  community: 'var(--actor-community)',
  regulator: 'var(--actor-regulator)',
  industry: 'var(--actor-industry)',
  admin: 'var(--actor-aclima)',
}

export const ACTOR_LABEL: Record<Role, string> = {
  community: 'Boxtown Air Watch',
  regulator: 'DRAQA',
  industry: 'Operators',
  admin: 'Aclima',
}

export function actorStyle(role: Role | null): CSSProperties {
  return { ['--laneColor' as string]: ACTOR_VAR[role ?? 'admin'] }
}

// ═════════════════════════════════════════════════════════════════ geometry

/** Metres per degree at a given latitude — good enough for a campaign-sized area. */
function scaleAt(lat: number): { mx: number; my: number } {
  return { mx: 111_320 * Math.cos((lat * Math.PI) / 180), my: 110_540 }
}

export function ringPerimeterM(ring: Position[], closed: boolean): number {
  if (ring.length < 2) return 0
  const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length
  const { mx, my } = scaleAt(lat0)
  let total = 0
  const n = closed ? ring.length : ring.length - 1
  for (let i = 0; i < n; i += 1) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    total += Math.hypot((b[0] - a[0]) * mx, (b[1] - a[1]) * my)
  }
  return total
}

export function ringAreaM2(ring: Position[]): number {
  if (ring.length < 3) return 0
  const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length
  const { mx, my } = scaleAt(lat0)
  let sum = 0
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    sum += (a[0] * mx) * (b[1] * my) - (b[0] * mx) * (a[1] * my)
  }
  return Math.abs(sum) / 2
}

/** Even-odd point-in-polygon over a set of rings. */
export function pointInRings(pt: Position, rings: Position[][]): boolean {
  let inside = false
  for (const ring of rings) {
    if (ring.length < 3) continue
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if ((yi > pt[1]) !== (yj > pt[1])) {
        const x = ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi
        if (pt[0] < x) inside = !inside
      }
    }
  }
  return inside
}

export function ringCentroid(ring: Position[]): Position {
  const n = Math.max(1, ring.length)
  return [
    ring.reduce((a, p) => a + p[0], 0) / n,
    ring.reduce((a, p) => a + p[1], 0) / n,
  ]
}

export interface EnclosedStats {
  segments: number
  km: number
  passes: number
  districts: string[]
}

/** What a boundary actually contains — the numbers that make a drawing real. */
export function enclosedBy(
  data: SegmentCollection | undefined,
  rings: Position[][],
): EnclosedStats {
  const out: EnclosedStats = { segments: 0, km: 0, passes: 0, districts: [] }
  if (!data) return out
  const districts = new Set<string>()
  for (const f of data.features) {
    const coords = f.geometry?.coordinates ?? []
    if (!coords.length) continue
    const mid = coords[Math.floor(coords.length / 2)]
    if (rings.length && !pointInRings(mid as Position, rings)) continue
    out.segments += 1
    out.km += (f.properties.length_m ?? 0) / 1000
    out.passes += f.properties.n_passes ?? 0
    if (f.properties.district) districts.add(f.properties.district)
  }
  out.districts = [...districts].sort()
  return out
}

// ═════════════════════════════════════════════════ the draft boundary store

/**
 * The drafting table's own state: rings the admin has drawn on sheet 02.
 *
 * The backend has no boundary-write endpoint, so a draft never becomes the
 * committed campaign — but it *does* travel between sheets, so the sequence
 * (draw → size the fleet → generate the plan) is a real sequence and not four
 * unconnected screens.
 */
export interface DraftState {
  /** Closed rings. Each is one polyline the admin drew and closed. */
  rings: Position[][]
  /** The ring currently being drawn, open. */
  active: Position[]
  /** Sheet 02 hands the plan a fleet size; sheet 03 reads it. */
  fleetSize: number
  targetPasses: number
  shiftHours: number
  addVertex(p: Position): void
  undoVertex(): void
  closeRing(): void
  /** Load an existing outline in as an editable ring. */
  traceRing(ring: Position[]): void
  clear(): void
  setFleet(n: number): void
  setTarget(n: number): void
  setShift(h: number): void
}

export const useDraft = create<DraftState>((set) => ({
  rings: [],
  active: [],
  fleetSize: 5,
  targetPasses: 25,
  shiftHours: 5,
  addVertex: (p) => set((st) => ({ active: [...st.active, p] })),
  undoVertex: () => set((st) => (st.active.length
    ? { active: st.active.slice(0, -1) }
    : { rings: st.rings.slice(0, -1) })),
  closeRing: () => set((st) => (st.active.length >= 3
    ? { rings: [...st.rings, st.active], active: [] }
    : st)),
  traceRing: (ring) => set({ rings: [ring], active: [] }),
  clear: () => set({ rings: [], active: [] }),
  setFleet: (n) => set({ fleetSize: n }),
  setTarget: (n) => set({ targetPasses: n }),
  setShift: (h) => set({ shiftHours: h }),
}))

// ════════════════════════════════════════════════════════════════ time bits

/**
 * A window quantised to a bucket. `timeRange()` in core/session re-derives `to`
 * from `new Date()` on every call, so any hook that defaults its window gets a
 * fresh query key every render and refetches forever.
 */
export function useStableWindow(hours: number, bucketMin = 5): { from: string; to: string } {
  const bucket = Math.floor(Date.now() / (bucketMin * 60_000))
  return useMemo(() => {
    const to = new Date(bucket * bucketMin * 60_000)
    const from = new Date(to.getTime() - hours * 3_600_000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [bucket, bucketMin, hours])
}

/** A ticking clock, for "up for 4 m" labels that stay honest. */
/** The demo's clock. Honours a pinned simulation cursor — see `useDemoClock`. */
export function useNowTick(ms = 30_000): Date {
  return useDemoClock(ms)
}

/** Keeps the previous non-undefined value so a refetch never blanks a panel. */
export function useSticky<T>(value: T | undefined): T | undefined {
  const ref = useRef<T | undefined>(undefined)
  if (value !== undefined) ref.current = value
  return ref.current
}

// ══════════════════════════════════════════════════════════════════ numbers

export function pct(part: number, whole: number, decimals = 1): string {
  if (!whole) return '—'
  return `${fmtNum((100 * part) / whole, decimals)}%`
}

export function daysBetween(a: string, b: string): number {
  const t0 = new Date(a).getTime()
  const t1 = new Date(b).getTime()
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return 0
  return Math.round((t1 - t0) / 86_400_000)
}

// ══════════════════════════════════════════════ the drive plan, defect-proofed

/**
 * `useDrivePlan()` in core is typed `DrivePlan` but `GET /drive-plan` returns a
 * LIST of plans and never includes routes, so `plan.routes.length` throws and
 * the map draws nothing. Both problems are reported; this is the local
 * workaround:
 *
 *   · `useActivePlan()`  — coerce the list to the active plan
 *   · `usePlanRoutes()`  — the one request that actually carries the geometry
 */
export function useActivePlan(): DrivePlan | undefined {
  const q = useDrivePlanRaw()
  const raw = q.data as unknown
  if (Array.isArray(raw)) {
    const list = raw as DrivePlan[]
    return list.find((p) => p.status === 'active') ?? list[0]
  }
  return (raw as DrivePlan | undefined) ?? undefined
}

export function usePlanRoutes(planId: string | undefined): UseQueryResult<DrivePlan, Error> {
  return useQuery<DrivePlan, Error>({
    queryKey: ['admin', 'drive-plan-routes', planId ?? ''],
    enabled: !!planId,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `${API_BASE}/drive-plan/${encodeURIComponent(planId as string)}?include_routes=true`,
        { signal, headers: { accept: 'application/json' } },
      )
      if (!res.ok) throw new Error(`drive plan ${res.status}`)
      return (await res.json()) as DrivePlan
    },
  })
}

// ═════════════════════════════════════════════════════════════ the camera

/**
 * `initialView` is read once at mount, and on that first render the bootstrap
 * has usually not resolved — so `campaign?.center[0]` is `undefined` and
 * MapLibre throws `Invalid LngLat object`. Always hand the map real numbers.
 */
export function campaignView(
  campaign: Campaign | undefined,
  zoomDelta = 0,
  center?: Position | null,
): { longitude: number; latitude: number; zoom: number } {
  return {
    longitude: center?.[0] ?? campaign?.center[0] ?? DEFAULT_VIEW.longitude,
    latitude: center?.[1] ?? campaign?.center[1] ?? DEFAULT_VIEW.latitude,
    zoom: (campaign?.default_zoom ?? DEFAULT_VIEW.zoom) + zoomDelta,
  }
}
