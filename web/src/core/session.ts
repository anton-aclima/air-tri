/**
 * air — UI state. One small zustand store, persisted to localStorage.
 *
 * Everything here is *what the operator is looking at*: which role, which
 * persona, which site, what is selected, where the map is, and — the one the
 * whole demo hangs off — the **global time cursor**.
 *
 * Server state never lives here. That is TanStack Query's job (`core/queries`).
 */

import { useMemo } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

import type { MeasureCode, Position, Role, SegmentMetric, StatWindow, User } from '@/core/types'
import { ROLES } from '@/core/roles'
import { clamp } from '@/core/util'
import {
  addHours, campaignMs, clampTime, floorTo, naive, parseCampaign, toCampaign,
} from '@/core/clock'
import type { CampaignTime } from '@/core/clock'

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
   * The demo's "now", as naive campaign time (`core/clock`).
   *
   * `null` means AT THE END OF THE DATA, paused — never the wall clock. The
   * owner's rule (docs/PLAN-refocus.md D1): time is always constrained to the
   * simulation, and when it reaches the end it pauses there. The server's own
   * "now" is that same instant (`setting('datagen.now')`), so a `null` cursor
   * can be sent as "no `at`" and the two sides agree.
   */
  cursor: CampaignTime | null
  /** Playing back through time. Stops, and pauses, at the end of the data. */
  playing: boolean
  /** Playback rate in simulated minutes per real second. */
  speed: number
  /** Trailing analysis window, hours. Drives `from`/`to` on series queries. */
  windowHours: number
  /**
   * The simulation's limits, set once from the bootstrap. Not persisted.
   * `start` is the campaign's first instant, `end` the build instant.
   */
  bounds: { start: CampaignTime; end: CampaignTime } | null
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

/**
 * Simulated minutes per real second: an hour, six hours, a day. At 6 h/s the
 * whole campaign plays in about six minutes; at 1 d/s in ninety seconds.
 */
export const PLAYBACK_SPEEDS = [60, 360, 1440] as const
export const DEFAULT_SPEED = 360

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
  /** Slew the camera. `durationMs` 0 jumps; default is a followable ~900 ms. */
  flyTo: (center: Position, zoom?: number, opts?: { durationMs?: number }) => void
  resetView: () => void
  setMeasure: (measure: MeasureCode) => void
  setMetric: (metric: SegmentMetric) => void
  setStatWindow: (window: StatWindow) => void
  /** Clamped to the bounds; a time at or past the end becomes `null`. */
  setTimeCursor: (iso: string | null) => void
  stepTime: (hours: number) => void
  /** Pause at the end of the data. (Was "go live" — there is no live.) */
  goToEnd: () => void
  /** @deprecated use `goToEnd`. Kept so old callers still compile. */
  goLive: () => void
  setTimeBounds: (start: CampaignTime, end: CampaignTime) => void
  setPlaying: (playing: boolean) => void
  togglePlaying: () => void
  setSpeed: (speed: number) => void
  setWindowHours: (hours: number) => void
  setSwitcherOpen: (open: boolean) => void
  toggleSwitcher: () => void
  setTransitioningTo: (role: Role | null) => void
  reset: () => void
}

/**
 * The in-flight camera animation, if any. Module-level because there is exactly
 * one camera: starting a new flight must cancel the old one, or two rAF loops
 * write alternating frames and the map shudders between two destinations.
 */
let cancelFlight: (() => void) | null = null

const INITIAL = {
  role: null as Role | null,
  personaByRole: {} as Partial<Record<Role, string>>,
  user: null as User | null,
  siteId: null as string | null,
  selection: EMPTY_SELECTION,
  mapView: DEFAULT_VIEW,
  time: { cursor: null, playing: false, speed: DEFAULT_SPEED, windowHours: 24, bounds: null } as TimeState,
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

      /**
       * Move the camera over time instead of teleporting it.
       *
       * `<Map longitude latitude zoom>` is a CONTROLLED camera, so react-map-gl
       * applies a state change as `jumpTo` — the view cuts, and a cut costs the
       * reader every bit of spatial context they had. You look up somewhere
       * else and have to rebuild where you are from scratch. Interpolating the
       * store instead makes the same state change a slew, which the eye can
       * follow, and it works for both backends because both are driven off this
       * one value.
       *
       * Longitude is interpolated on the short way round so a flight never
       * crosses the antimeridian the long way. Zoom is interpolated
       * logarithmically — it already is a log scale, so a linear ramp reads as
       * a lurch at the end.
       */
      flyTo: (center, zoom, opts) => {
        const from = get().mapView
        const to = {
          ...from,
          longitude: center[0],
          latitude: center[1],
          zoom: zoom ?? Math.max(from.zoom, 14.5),
        }
        const ms = opts?.durationMs ?? 900

        if (cancelFlight) cancelFlight()
        if (ms <= 0 || typeof requestAnimationFrame === 'undefined') {
          set({ mapView: to })
          return
        }

        // Short way round, so a flight never takes the scenic route.
        let dLon = to.longitude - from.longitude
        if (dLon > 180) dLon -= 360
        if (dLon < -180) dLon += 360

        const t0 = performance.now()
        let raf = 0
        let live = true
        cancelFlight = () => { live = false; cancelAnimationFrame(raf) }

        const step = (t: number) => {
          if (!live) return
          const k = Math.min(1, (t - t0) / ms)
          // easeInOutCubic — leaves and arrives slowly, moves in the middle.
          const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
          set({
            mapView: {
              ...get().mapView,
              longitude: from.longitude + dLon * e,
              latitude: from.latitude + (to.latitude - from.latitude) * e,
              zoom: Math.log2(
                Math.pow(2, from.zoom) * Math.pow(Math.pow(2, to.zoom - from.zoom), e),
              ),
            },
          })
          if (k < 1) raf = requestAnimationFrame(step)
          else { live = false; cancelFlight = null }
        }
        raf = requestAnimationFrame(step)
      },
      resetView: () => set({ mapView: DEFAULT_VIEW }),

      setMeasure: (measure) => set({ measure }),
      setMetric: (metric) => set({ metric }),
      setStatWindow: (statWindow) => set({ statWindow }),

      // Reaching the end pauses there (D1), however it was reached. Left
      // playing, a seek or a step onto the end during playback was undone: the
      // playback loop cannot tell a `null` it did not write from one it did,
      // so it wrote its own next step back within 250 ms and kept going.
      setTimeCursor: (iso) => set((s) => ({ time: atCursor(s.time, constrain(iso, s.time.bounds)) })),
      stepTime: (hours) =>
        set((s) => {
          const end = s.time.bounds?.end
          const base = s.time.cursor ?? end
          if (!base) return {}
          return { time: atCursor(s.time, constrain(addHours(base, hours), s.time.bounds)) }
        }),
      goToEnd: () => set((s) => ({ time: { ...s.time, cursor: null, playing: false } })),
      goLive: () => set((s) => ({ time: { ...s.time, cursor: null, playing: false } })),
      setTimeBounds: (start, end) =>
        set((s) => {
          const bounds = { start: naive(start), end: naive(end) }
          const same = s.time.bounds?.start === bounds.start && s.time.bounds?.end === bounds.end
          return same ? {} : { time: { ...s.time, bounds, cursor: constrain(s.time.cursor, bounds) } }
        }),
      setPlaying: (playing) => set((s) => ({ time: { ...s.time, playing } })),
      togglePlaying: () => set((s) => ({ time: { ...s.time, playing: !s.time.playing } })),
      setSpeed: (speed) => set((s) => ({ time: { ...s.time, speed: clamp(speed, 1, 1440) } })),
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
      // v2: the time cursor is no longer persisted. A cursor saved on Aug 12
      // silently reopened every screen on Aug 12 the next day, with nothing on
      // screen saying the demo was not at its latest data. The migration drops
      // any cursor a v1 session saved (those are UTC strings, too — see
      // docs/PLAN-refocus.md F1).
      // v3: speeds are 1 h / 6 h / 1 day per second, and the clock carries its
      // bounds (never persisted — they come from the bootstrap).
      version: 3,
      migrate: (persisted, version) => {
        const st = (persisted ?? {}) as Partial<SessionState>
        if (version < 3 && st.time) {
          const speed = (PLAYBACK_SPEEDS as readonly number[]).includes(st.time.speed)
            ? st.time.speed : DEFAULT_SPEED
          st.time = { ...st.time, cursor: null, playing: false, bounds: null, speed }
        }
        return st as SessionState
      },
      // Transient chrome state is never persisted, and neither is the moment
      // the demo is looking at: a reload always opens at the latest data.
      partialize: (s) => ({
        role: s.role,
        personaByRole: s.personaByRole,
        user: s.user,
        siteId: s.siteId,
        mapView: s.mapView,
        measure: s.measure,
        metric: s.metric,
        statWindow: s.statWindow,
        time: { ...s.time, playing: false, cursor: null, bounds: null },
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
 * The session's effective "now" for an `?at=` / `?to=` param, or `undefined`
 * at the end of the data. `undefined` means "server, your now" — and the
 * server's now IS the end of the data (`timeutil.now`), so they agree without
 * a second fetch waiting on the bootstrap.
 */
export function timeParam(time: TimeState): string | undefined {
  return time.cursor ?? undefined
}

/**
 * The demo's now as naive campaign time: the cursor, else the end of the data.
 * Before the bootstrap has loaded there are no bounds yet, and the wall clock
 * is the placeholder for those renders. It must never reach the server: it
 * did, as `/wind?to=2026-09-23T19:00` on a campaign ending Aug 28, so every
 * query keyed on the clock now waits for the bounds (core/queries `timed`).
 */
export function nowCampaign(time: TimeState): CampaignTime {
  return time.cursor ?? time.bounds?.end ?? toCampaign(new Date())
}

/** The effective "now" as a Date, always defined. See `nowCampaign`. */
export function resolveNow(time: TimeState): Date {
  return parseCampaign(nowCampaign(time))
}

/** The clock moved to `cursor`; at the end (`null`) it is also paused. */
function atCursor(time: TimeState, cursor: CampaignTime | null): TimeState {
  return { ...time, cursor, playing: cursor === null ? false : time.playing }
}

/** `null` when at or past the end (paused at the end); otherwise clamped. */
function constrain(
  t: string | null,
  bounds: TimeState['bounds'],
): CampaignTime | null {
  if (!t) return null
  const v = naive(t)
  if (!bounds) return v
  if (campaignMs(v) >= campaignMs(bounds.end)) return null
  return clampTime(v, bounds.start, bounds.end)
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
  const now = nowCampaign(time)
  const to = time.cursor ? now : floorTo(now, LIVE_QUANTUM_MS / 60_000)
  return { from: addHours(to, -time.windowHours), to }
}

/**
 * The demo's clock, as a value that ticks.
 *
 * Anything that renders an age — "up 2 d 21 h", a timeline's right edge, a
 * "3 min ago" — has to measure from the *demo's* now, not the viewer's. Three
 * apps each had their own `useNowTick` reading `new Date()`, so pinning the
 * simulation clock moved every query and none of the durations: the panel said
 * one thing and the page said another.
 *
 * A pinned cursor is the answer and nothing needs to tick. Only a live clock
 * sets an interval, which also means a scrubbed demo stops re-rendering on a
 * timer for no reason.
 */
export function useDemoClock(_ms = 1000): Date {
  // Nothing ticks: at the end of the data the clock is paused (D1), and while
  // playing the cursor itself moves. `_ms` is kept so callers still compile.
  const cursor = useSession((s) => s.time.cursor)
  const end = useSession((s) => s.time.bounds?.end ?? null)
  return useMemo(
    () => parseCampaign(cursor ?? end ?? toCampaign(new Date())),
    [cursor, end],
  )
}

/** The demo's now as naive campaign time, reactive. */
export function useNowCampaign(): CampaignTime {
  const cursor = useSession((s) => s.time.cursor)
  const end = useSession((s) => s.time.bounds?.end ?? null)
  return cursor ?? end ?? toCampaign(new Date())
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
