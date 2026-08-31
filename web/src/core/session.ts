/**
 * air — UI state. One small zustand store, persisted to localStorage.
 *
 * Everything here is *what the operator is looking at*: which role, which
 * persona, which site, what is selected, where the map is, and — the one the
 * whole demo hangs off — the **global time cursor**.
 *
 * Server state never lives here. That is TanStack Query's job (`core/queries`).
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import type { MeasureCode, Position, Role, SegmentMetric, StatWindow, User } from '@/core/types'
import { ROLES } from '@/core/roles'
import { clamp } from '@/core/util'

// ────────────────────────────────────────────────────────────────── shapes

export interface MapView {
  longitude: number
  latitude: number
  zoom: number
  pitch: number
  bearing: number
}

export interface Selection {
  segmentId: string | null
  alertId: string | null
  concernId: string | null
  monitorId: string | null
  siteId: string | null
  clusterId: string | null
}

export interface TimeState {
  /**
   * The demo's "now". `null` means *live* — follow the wall clock.
   * ISO string when scrubbed into the past.
   */
  cursor: string | null
  /** Playing back through time. */
  playing: boolean
  /** Playback rate in simulated minutes per real second. */
  speed: number
  /** Trailing analysis window, hours. Drives `from`/`to` on series queries. */
  windowHours: number
}

export const EMPTY_SELECTION: Selection = {
  segmentId: null,
  alertId: null,
  concernId: null,
  monitorId: null,
  siteId: null,
  clusterId: null,
}

/** Southwest Memphis — the campaign centre from CONTRACT §2. */
export const DEFAULT_VIEW: MapView = {
  longitude: -90.132,
  latitude: 35.058,
  zoom: 12.4,
  pitch: 0,
  bearing: 0,
}

export const PLAYBACK_SPEEDS = [1, 15, 60, 360] as const

// ──────────────────────────────────────────────────────────────── the store

export interface SessionState {
  /** `null` on the landing page — no role skin applied yet. */
  role: Role | null
  /** Current persona per role, so switching back remembers who you were. */
  personaByRole: Partial<Record<Role, string>>
  /** Hydrated `User` for the active persona (cached copy of the bootstrap row). */
  user: User | null
  /** Which industry site the industry persona operates. */
  siteId: string | null

  selection: Selection
  mapView: MapView
  time: TimeState

  /** Which measure/metric the maps and charts are painting. Shared across roles. */
  measure: MeasureCode
  metric: SegmentMetric
  /** `segment_stat.window` — 'all' | 'date:YYYY-MM-DD' | 'hour:HH'. */
  statWindow: StatWindow

  /** Chrome flags. */
  switcherOpen: boolean
  /** Set for ~1 frame while the role cross-fade runs. */
  transitioningTo: Role | null

  // actions ---------------------------------------------------------------
  setRole: (role: Role | null) => void
  setPersona: (user: User | null) => void
  setSite: (siteId: string | null) => void
  select: (patch: Partial<Selection>) => void
  clearSelection: () => void
  setMapView: (view: Partial<MapView>) => void
  flyTo: (center: Position, zoom?: number) => void
  resetView: () => void
  setMeasure: (measure: MeasureCode) => void
  setMetric: (metric: SegmentMetric) => void
  setStatWindow: (window: StatWindow) => void
  setTimeCursor: (iso: string | null) => void
  stepTime: (hours: number) => void
  goLive: () => void
  setPlaying: (playing: boolean) => void
  togglePlaying: () => void
  setSpeed: (speed: number) => void
  setWindowHours: (hours: number) => void
  setSwitcherOpen: (open: boolean) => void
  toggleSwitcher: () => void
  setTransitioningTo: (role: Role | null) => void
  reset: () => void
}

const INITIAL = {
  role: null as Role | null,
  personaByRole: {} as Partial<Record<Role, string>>,
  user: null as User | null,
  siteId: null as string | null,
  selection: EMPTY_SELECTION,
  mapView: DEFAULT_VIEW,
  time: { cursor: null, playing: false, speed: 60, windowHours: 24 } as TimeState,
  measure: 'no2' as MeasureCode,
  metric: 'median' as SegmentMetric,
  statWindow: 'all' as StatWindow,
  switcherOpen: false,
  transitioningTo: null as Role | null,
}

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      ...INITIAL,

      setRole: (role) =>
        set((s) => ({
          role,
          // Selections are role-scoped — carrying them across skins is confusing.
          selection: EMPTY_SELECTION,
          switcherOpen: false,
          user: role && s.user?.role === role ? s.user : null,
        })),

      setPersona: (user) =>
        set((s) => ({
          user,
          role: user?.role ?? s.role,
          personaByRole: user
            ? { ...s.personaByRole, [user.role]: user.id }
            : s.personaByRole,
        })),

      setSite: (siteId) => set({ siteId }),

      select: (patch) => set((s) => ({ selection: { ...s.selection, ...patch } })),
      clearSelection: () => set({ selection: EMPTY_SELECTION }),

      setMapView: (view) => set((s) => ({ mapView: { ...s.mapView, ...view } })),
      flyTo: (center, zoom) =>
        set((s) => ({
          mapView: {
            ...s.mapView,
            longitude: center[0],
            latitude: center[1],
            zoom: zoom ?? Math.max(s.mapView.zoom, 14.5),
          },
        })),
      resetView: () => set({ mapView: DEFAULT_VIEW }),

      setMeasure: (measure) => set({ measure }),
      setMetric: (metric) => set({ metric }),
      setStatWindow: (statWindow) => set({ statWindow }),

      setTimeCursor: (iso) => set((s) => ({ time: { ...s.time, cursor: iso } })),
      stepTime: (hours) =>
        set((s) => {
          const base = s.time.cursor ? new Date(s.time.cursor) : new Date()
          const next = new Date(base.getTime() + hours * 3_600_000)
          const now = Date.now()
          // Never scrub into the future — "now" is the right edge of the demo.
          return {
            time: { ...s.time, cursor: next.getTime() >= now ? null : next.toISOString() },
          }
        }),
      goLive: () => set((s) => ({ time: { ...s.time, cursor: null, playing: false } })),
      setPlaying: (playing) => set((s) => ({ time: { ...s.time, playing } })),
      togglePlaying: () => set((s) => ({ time: { ...s.time, playing: !s.time.playing } })),
      setSpeed: (speed) => set((s) => ({ time: { ...s.time, speed: clamp(speed, 1, 3600) } })),
      setWindowHours: (hours) =>
        set((s) => ({ time: { ...s.time, windowHours: clamp(hours, 1, 24 * 90) } })),

      setSwitcherOpen: (switcherOpen) => set({ switcherOpen }),
      toggleSwitcher: () => set((s) => ({ switcherOpen: !s.switcherOpen })),
      setTransitioningTo: (transitioningTo) => set({ transitioningTo }),

      reset: () => set({ ...INITIAL, role: get().role }),
    }),
    {
      name: 'air.session.v1',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // Transient chrome state is never persisted.
      partialize: (s) => ({
        role: s.role,
        personaByRole: s.personaByRole,
        user: s.user,
        siteId: s.siteId,
        mapView: s.mapView,
        measure: s.measure,
        metric: s.metric,
        statWindow: s.statWindow,
        time: { ...s.time, playing: false },
      }),
    },
  ),
)

// ───────────────────────────────────────────────────────────────── helpers
// Narrow selectors — components should subscribe to the smallest slice they
// need so a map pan doesn't re-render the whole feed.

export const useRole = (): Role | null => useSession((s) => s.role)
export const usePersona = (): User | null => useSession((s) => s.user)
export const useSelection = (): Selection => useSession((s) => s.selection)
export const useMapView = (): MapView => useSession((s) => s.mapView)
export const useTime = (): TimeState => useSession((s) => s.time)
export const useMeasureCode = (): MeasureCode => useSession((s) => s.measure)
export const useMetric = (): SegmentMetric => useSession((s) => s.metric)
export const useStatWindow = (): StatWindow => useSession((s) => s.statWindow)
export const useSiteId = (): string | null => useSession((s) => s.siteId)

/**
 * The session's effective "now" as an ISO string, or `undefined` when live.
 * Pass straight into `?at=` / `?to=` params — `undefined` means "server, you
 * decide", which is what live should do.
 */
export function timeParam(time: TimeState): string | undefined {
  return time.cursor ?? undefined
}

/** The effective "now" as a Date, always defined. */
export function resolveNow(time: TimeState): Date {
  return time.cursor ? new Date(time.cursor) : new Date()
}

/** Live windows snap to this grid so the pair is stable between renders. */
const LIVE_QUANTUM_MS = 5 * 60_000

/**
 * `[from, to]` ISO pair for the trailing analysis window.
 *
 * When live, `to` is quantised to a 5-minute grid. Returning a raw `new Date()`
 * here means a different pair on every render, which makes a different TanStack
 * Query key on every render, which refetches forever — the page never reaches
 * network idle and headless screenshots hang. Any hook that defaults its window
 * (`useWind`, `useWindField`, `useMobileWind`, `useMonitorReadings`, `useFleet`,
 * `useDispersion`) depends on this being stable. A scrubbed cursor is already
 * stable and is passed through untouched.
 */
export function timeRange(time: TimeState): { from: string; to: string } {
  const raw = resolveNow(time)
  const to = time.cursor
    ? raw
    : new Date(Math.floor(raw.getTime() / LIVE_QUANTUM_MS) * LIVE_QUANTUM_MS)
  const from = new Date(to.getTime() - time.windowHours * 3_600_000)
  return { from: from.toISOString(), to: to.toISOString() }
}

/** Hook form of the above, for series queries. */
export function useTimeRange(): { from: string; to: string; at: string | undefined } {
  const time = useTime()
  const { from, to } = timeRange(time)
  return { from, to, at: timeParam(time) }
}

/** Community fleet positions are delayed ≥3 h (CONTRACT §9.5). */
export function fleetDelayFor(role: Role | null, configured?: number): number {
  if (role === 'community') return Math.max(180, configured ?? 180)
  return 0
}

/** Where a role should land. */
export function landingFor(role: Role | null): string {
  return role ? ROLES[role].landing : '/'
}
