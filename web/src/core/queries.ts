/**
 * air — TanStack Query hooks.
 *
 * One hook per endpoint, every query key in `qk`, sensible `staleTime`s, and
 * mutations that invalidate the *other* side's caches so a write in one
 * interface lands in another (`core/live.ts` does the same over SSE).
 *
 * Conventions
 *   · Hooks accept `(params?, opts?)`. `opts` is spread last, so a caller can
 *     always override `enabled`, `staleTime`, `refetchInterval`, `select`.
 *   · Hooks that are time-aware default to the session's clock: series take
 *     `from`/`to` from `timeRange`, and the event lists (concerns, clusters,
 *     alerts, feed, community stats) send `at: timeParam(time)` so the server
 *     cuts at the moment on screen before its LIMIT (D2). Include the key
 *     `at` yourself to override; `{ at: undefined }` asks for the whole record
 *     up to the end of the data — the timeline's event ticks need that.
 *   · Every hook keyed on the clock waits for the clock's bounds (`timed`).
 *     Before the bootstrap lands there is no "now" to ask about, and asking
 *     anyway sent the wall clock: `/wind?to=2026-09-23T19:00` on a campaign
 *     that ends Aug 28, whose empty answer then sat on screen as the
 *     placeholder for the real one.
 *   · Nothing throws on a missing backend: queries just sit in `isError` and
 *     screens render their empty state.
 */

import {
  QueryClient,
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'

import * as api from '@/core/api'
import { isBackendDown } from '@/core/api'
import type {
  ActionLevel,
  ActivityItem,
  Advisory,
  AdvisorReply,
  Alert,
  Bootstrap,
  Campaign,
  CampaignStats,
  CommunityStats,
  Concern,
  ConcernCluster,
  ConcernResponse,
  ConcernStatus,
  CoverageCell,
  DispersionModel,
  DispersionPlume,
  DispersionPlumeOutlined,
  DrivePlan,
  FeedItem,
  FleetPosition,
  IndustrySite,
  MeasureCode,
  MeasureDef,
  Mitigation,
  MissionBrief,
  MobileWindObs,
  ModelVerification,
  Calibration,
  Interception,
  Residency,
  Siting,
  CoverageMask,
  Envelope,
  Touchdown,
  Monitor,
  MonitorReadings,
  Org,
  Role,
  SegmentCollection,
  SegmentDetail,
  SimScenario,
  SitePost,
  User,
  Vehicle,
  WindField,
  WindClimatology,
  WindPoint,
} from '@/core/types'
import { fleetDelayFor, timeParam, timeRange, useSession } from '@/core/session'
import type { TimeState } from '@/core/session'
import { addHours } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import { findMeasure, measuresOf } from '@/core/measures'
import type { MeasureFamily } from '@/core/measures'

// ───────────────────────────────────────────────────────────── stale times

/** Milliseconds. Tuned for a live demo: cheap things refresh, heavy things don't. */
export const STALE = {
  bootstrap: 10 * 60_000,
  segments: 5 * 60_000,
  segmentDetail: 5 * 60_000,
  monitors: 60_000,
  readings: 60_000,
  concerns: 20_000,
  clusters: 30_000,
  sites: 5 * 60_000,
  posts: 20_000,
  advisories: 20_000,
  alerts: 10_000,
  actionLevels: 60_000,
  feed: 10_000,
  fleet: 4_000,
  drivePlan: 5 * 60_000,
  wind: 5 * 60_000,
  dispersion: 60_000,
  // The touchdown estimator reads every pass in the campaign and pairs them by
  // hour; it only moves when a rebuild does. The mask moves even less.
  // Climatology is the whole campaign's met record. It moves on a rebuild.
  // Modelled surfaces over the whole record. They move on a rebuild.
  coverageAnalysis: 30 * 60_000,
  climatology: 30 * 60_000,
  // One day's brief. It changes when the demo cursor crosses 07:00, the issue
  // hour, and the query key carries the day, so nothing goes stale in between.
  brief: 30 * 60_000,
  envelope: 10 * 60_000,
  touchdown: 10 * 60_000,
  coverage: 30 * 60_000,
  mobileWind: 2 * 60_000,
  windField: 2 * 60_000,
  dispersionModels: 10 * 60_000,
  verification: 5 * 60_000,
  stats: 30_000,
  activity: 10_000,
} as const

// ──────────────────────────────────────────────────────────────── query keys

/**
 * Every key in one place. Invalidate with a prefix:
 *   `queryClient.invalidateQueries({ queryKey: qk.alerts.all })`
 */
export const qk = {
  bootstrap: ['bootstrap'] as const,

  campaigns: {
    all: ['campaigns'] as const,
    detail: (id: string) => ['campaigns', id] as const,
    boundary: (id: string) => ['campaigns', id, 'boundary'] as const,
  },

  segments: {
    all: ['segments'] as const,
    list: (params: api.SegmentsParams) => ['segments', 'list', params] as const,
    detail: (id: string) => ['segments', 'detail', id] as const,
  },

  monitors: {
    all: ['monitors'] as const,
    list: (params: api.MonitorsParams) => ['monitors', 'list', params] as const,
    detail: (id: string, at?: string) => ['monitors', 'detail', id, at ?? null] as const,
    readings: (id: string, params: api.MonitorReadingsParams) =>
      ['monitors', 'readings', id, params] as const,
  },

  concerns: {
    all: ['concerns'] as const,
    list: (params: api.ConcernsParams) => ['concerns', 'list', params] as const,
    detail: (id: string) => ['concerns', 'detail', id] as const,
  },

  clusters: {
    all: ['clusters'] as const,
    list: (params: api.ClustersParams) => ['clusters', 'list', params] as const,
  },

  sites: {
    all: ['sites'] as const,
    detail: (id: string) => ['sites', 'detail', id] as const,
    models: (id: string) => ['sites', id, 'dispersion-models'] as const,
    verification: (id: string, params: api.ModelVerificationParams) =>
      ['sites', id, 'model-verification', params] as const,
  },

  coverageAnalysis: {
    all: ['coverage-analysis'] as const,
    interception: ['coverage-analysis', 'interception'] as const,
    residency: ['coverage-analysis', 'residency'] as const,
    siting: (n: number) => ['coverage-analysis', 'siting', n] as const,
    calibration: (at?: string) => ['coverage-analysis', 'calibration', at ?? null] as const,
  },

  brief: {
    all: ['brief'] as const,
    of: (date: string | null, siteId: string | null) => ['brief', date, siteId] as const,
  },

  climatology: {
    all: ['climatology'] as const,
    of: (siteId: string | null) => ['climatology', siteId] as const,
  },

  envelope: {
    all: ['envelope'] as const,
    site: (id: string, measure: string) => ['envelope', id, measure] as const,
  },

  touchdown: {
    all: ['touchdown'] as const,
    site: (id: string, params: api.TouchdownParams) => ['touchdown', id, params] as const,
  },

  coverage: {
    all: ['coverage'] as const,
    mask: (campaignId: string, cellM: number) => ['coverage', campaignId, cellM] as const,
  },

  posts: {
    all: ['posts'] as const,
    list: (params: api.PostsParams) => ['posts', 'list', params] as const,
  },

  advisories: {
    all: ['advisories'] as const,
    list: (params: api.AdvisoriesParams) => ['advisories', 'list', params] as const,
  },

  alerts: {
    all: ['alerts'] as const,
    list: (params: api.AlertsParams) => ['alerts', 'list', params] as const,
    detail: (id: string, siteId?: string, at?: string) =>
      ['alerts', 'detail', id, siteId ?? null, at ?? null] as const,
  },

  actionLevels: { all: ['action-levels'] as const },

  feed: {
    all: ['feed'] as const,
    list: (params: api.FeedParams) => ['feed', 'list', params] as const,
  },

  fleet: {
    all: ['fleet'] as const,
    list: (params: api.FleetParams) => ['fleet', 'list', params] as const,
    vehicles: ['fleet', 'vehicles'] as const,
  },

  drivePlan: {
    all: ['drive-plan'] as const,
    detail: (campaignId?: string) => ['drive-plan', campaignId ?? 'active'] as const,
    coverage: (id: string) => ['drive-plan', id, 'coverage'] as const,
  },

  wind: {
    all: ['wind'] as const,
    list: (params: api.WindParams) => ['wind', 'list', params] as const,
    dispersion: (params: api.DispersionParams) => ['wind', 'dispersion', params] as const,
    mobile: (params: api.MobileWindParams) => ['wind', 'mobile', params] as const,
    field: (params: api.WindFieldParams) => ['wind', 'field', params] as const,
  },

  stats: {
    all: ['stats'] as const,
    community: (params: api.CommunityStatsParams) => ['stats', 'community', params] as const,
    campaign: ['stats', 'campaign'] as const,
  },

  activity: {
    all: ['activity'] as const,
    list: (params: { since?: string; limit?: number; role?: Role }) =>
      ['activity', 'list', params] as const,
  },

  advisor: { all: ['advisor'] as const },
} as const

// ───────────────────────────────────────────────────────────── query client

/**
 * The app's QueryClient. Retries once for real network blips but gives up
 * instantly when the backend simply isn't running.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => !isBackendDown(error) && count < 1,
        retryDelay: (count) => Math.min(2000 * 2 ** count, 8000),
      },
      mutations: { retry: 0 },
    },
  })
}

/**
 * For hooks keyed on the demo clock. While the cursor plays or is scrubbed,
 * every step is a new key; without this the layer blanks between steps and the
 * map flickers. Not a global default: on an entity change (one alert's page to
 * another's) showing the previous entity's data would be wrong, not smooth.
 */
const TIMED = { placeholderData: keepPreviousData } as const

/**
 * The `at` an event-list hook sends: the caller's when they included the key
 * (even as `undefined`, which means the whole record), else the session's.
 * `params.at ?? …` could not tell "no opinion" from "no bound".
 */
function atFor(params: { at?: string }, time: TimeState): string | undefined {
  return 'at' in params ? params.at : timeParam(time)
}

/** Options every hook accepts. Spread last — callers always win. */
export type QueryOpts<T> = Partial<Omit<UseQueryOptions<T, Error, T>, 'queryKey' | 'queryFn'>>

/** The clock has its limits: the bootstrap has landed and set `time.bounds`. */
const useClockReady = (): boolean => useSession((s) => s.time.bounds != null)

/**
 * Options for a hook keyed on the clock: `TIMED`, the hook's own defaults, the
 * caller's options — and never enabled before the clock has its bounds,
 * whatever the caller says. Until then `nowCampaign` has only the wall clock
 * to offer; measured on a fresh /industry load, that fired
 * `/wind/field?to=2026-09-23T19:00` and `/wind?to=…` a month past the data
 * before the right pair, and the empty answers were kept on screen as the
 * placeholder for the real ones. The caller's `enabled` still applies — this
 * only ever narrows it.
 */
function timed<T>(ready: boolean, own: QueryOpts<T> = {}, opts?: QueryOpts<T>): QueryOpts<T> {
  const theirs = opts?.enabled !== undefined ? opts.enabled : own.enabled
  return { ...TIMED, ...own, ...opts, enabled: ready ? (theirs ?? true) : false }
}

function useApiQuery<T>(
  queryKey: readonly unknown[],
  queryFn: (signal: AbortSignal) => Promise<T>,
  staleTime: number,
  opts?: QueryOpts<T>,
): UseQueryResult<T, Error> {
  return useQuery<T, Error, T>({
    queryKey,
    queryFn: ({ signal }) => queryFn(signal),
    staleTime,
    ...opts,
  })
}

// ═════════════════════════════════════════════════════════════════ bootstrap

/** Campaign, measures, orgs, users, action levels, sites, flags. Fetch once. */
export function useBootstrap(opts?: QueryOpts<Bootstrap>): UseQueryResult<Bootstrap, Error> {
  return useApiQuery(qk.bootstrap, api.getBootstrap, STALE.bootstrap, opts)
}

/** `measure_def` rows, sorted. `family` filters; pass `PICKABLE` for map lenses. */
export function useMeasures(
  family?: MeasureFamily | readonly MeasureFamily[],
): MeasureDef[] {
  const { data } = useBootstrap()
  return measuresOf(data?.measures, family)
}

/** One `MeasureDef` — pass everything through `core/measures` helpers. */
export function useMeasure(code?: MeasureCode | null): MeasureDef | undefined {
  const { data } = useBootstrap()
  return findMeasure(data?.measures, code)
}

/** The measure currently selected in the session store, resolved. */
export function useActiveMeasure(): MeasureDef | undefined {
  const code = useSession((s) => s.measure)
  return useMeasure(code)
}

export function useCampaignInfo(): Campaign | undefined {
  return useBootstrap().data?.campaign
}

export function useOrgs(): Org[] {
  return useBootstrap().data?.orgs ?? []
}

export function useUsers(role?: Role): User[] {
  const users = useBootstrap().data?.users ?? []
  return role ? users.filter((u) => u.role === role) : users
}

export function useFlags(): Bootstrap['flags'] | undefined {
  return useBootstrap().data?.flags
}

/** Sites from the bootstrap payload — no extra request. */
export function useBootstrapSites(): IndustrySite[] {
  return useBootstrap().data?.sites ?? []
}

/**
 * The site the industry persona is operating: the session's `siteId` if set,
 * else the site belonging to the persona's own org, else the first one.
 */
export function useActiveSite(): IndustrySite | undefined {
  const siteId = useSession((s) => s.siteId)
  const orgId = useSession((s) => s.user?.org_id ?? null)
  const sites = useBootstrapSites()
  return (
    sites.find((s) => s.id === siteId) ??
    (orgId ? sites.find((s) => s.org_id === orgId) : undefined) ??
    sites[0]
  )
}

// ═════════════════════════════════════════════════════════════════ campaigns

export function useCampaigns(opts?: QueryOpts<Campaign[]>): UseQueryResult<Campaign[], Error> {
  return useApiQuery(qk.campaigns.all, api.listCampaigns, STALE.bootstrap, opts)
}

export function useCampaign(id: string | undefined, opts?: QueryOpts<Campaign>) {
  return useApiQuery(
    qk.campaigns.detail(id ?? ''),
    (signal) => api.getCampaign(id as string, signal),
    STALE.bootstrap,
    { enabled: !!id, ...opts },
  )
}

/** The non-rectangular campaign boundary polygon, as GeoJSON. */
export function useCampaignBoundary(
  id: string | undefined,
  opts?: QueryOpts<api.BoundaryCollection>,
) {
  return useApiQuery(
    qk.campaigns.boundary(id ?? ''),
    (signal) => api.getCampaignBoundary(id as string, signal),
    STALE.bootstrap,
    { enabled: !!id, ...opts },
  )
}

// ══════════════════════════════════════════════════════════════════ segments

/**
 * The hero visual. Defaults `measure`/`metric`/`window` to the session so
 * every map in the app paints the same thing unless told otherwise.
 */
export function useSegments(
  params: api.SegmentsParams = {},
  opts?: QueryOpts<SegmentCollection>,
): UseQueryResult<SegmentCollection, Error> {
  const measure = useSession((s) => s.measure)
  const metric = useSession((s) => s.metric)
  const statWindow = useSession((s) => s.statWindow)
  const merged: api.SegmentsParams = {
    measure: params.measure ?? measure,
    metric: params.metric ?? metric,
    window: params.window ?? statWindow,
    ...(params.bbox ? { bbox: params.bbox } : {}),
    ...(params.min_passes != null ? { min_passes: params.min_passes } : {}),
    ...(params.limit != null ? { limit: params.limit } : {}),
    ...(params.campaign_id ? { campaign_id: params.campaign_id } : {}),
  }
  return useApiQuery(
    qk.segments.list(merged),
    (signal) => api.getSegments(merged, signal),
    STALE.segments,
    opts,
  )
}

/** Detail + daily series + 24 h diurnal + per-measure stats for one segment. */
export function useSegmentDetail(
  id: string | null | undefined,
  opts?: QueryOpts<SegmentDetail>,
): UseQueryResult<SegmentDetail, Error> {
  return useApiQuery(
    qk.segments.detail(id ?? ''),
    (signal) => api.getSegmentDetail(id as string, signal),
    STALE.segmentDetail,
    { enabled: !!id, ...opts },
  )
}

/** The segment currently selected in the session store. */
export function useSelectedSegment(opts?: QueryOpts<SegmentDetail>) {
  const id = useSession((s) => s.selection.segmentId)
  return useSegmentDetail(id, opts)
}

// ══════════════════════════════════════════════════════════════════ monitors

/**
 * Monitors with their `latest` reading as of the moment on screen. `at`
 * defaults to the clock: without it, paused at Aug 12, every tower, fenceline
 * and "over the line" badge read its Aug 28 13:00 value, and the community
 * status page disagreed with the feed about one instrument at one moment.
 */
export function useMonitors(
  params: api.MonitorsParams = {},
  opts?: QueryOpts<Monitor[]>,
): UseQueryResult<Monitor[], Error> {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const merged: api.MonitorsParams = { ...params, at: atFor(params, time) }
  return useApiQuery(
    qk.monitors.list(merged),
    (signal) => api.listMonitors(merged, signal),
    STALE.monitors,
    timed(ready, {}, opts),
  )
}

export function useMonitor(id: string | null | undefined, opts?: QueryOpts<Monitor>) {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const at = timeParam(time)
  return useApiQuery(
    qk.monitors.detail(id ?? '', at),
    (signal) => api.getMonitor(id as string, at, signal),
    STALE.monitors,
    timed(ready, { enabled: !!id }, opts),
  )
}

/**
 * Time series for one monitor. `from`/`to` default to the session's trailing
 * window so scrubbing the time cursor moves every chart at once.
 */
export function useMonitorReadings(
  id: string | null | undefined,
  params: Partial<api.MonitorReadingsParams> = {},
  opts?: QueryOpts<MonitorReadings>,
): UseQueryResult<MonitorReadings, Error> {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const sessionMeasure = useSession((s) => s.measure)
  const range = timeRange(time)
  const merged: api.MonitorReadingsParams = {
    measure: params.measure ?? sessionMeasure,
    from: params.from ?? range.from,
    to: params.to ?? range.to,
    interval: params.interval ?? 'hour',
  }
  return useApiQuery(
    qk.monitors.readings(id ?? '', merged),
    (signal) => api.getMonitorReadings(id as string, merged, signal),
    STALE.readings,
    timed(ready, { enabled: !!id }, opts),
  )
}

// ══════════════════════════════════════════════════════════════════ concerns

/** Reports filed by the moment on screen. `at` defaults to the clock. */
export function useConcerns(
  params: api.ConcernsParams = {},
  opts?: QueryOpts<Concern[]>,
): UseQueryResult<Concern[], Error> {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const merged: api.ConcernsParams = { ...params, at: atFor(params, time) }
  return useApiQuery(
    qk.concerns.list(merged),
    (signal) => api.listConcerns(merged, signal),
    STALE.concerns,
    timed(ready, {}, opts),
  )
}

export function useConcern(id: string | null | undefined, opts?: QueryOpts<Concern>) {
  return useApiQuery(
    qk.concerns.detail(id ?? ''),
    (signal) => api.getConcern(id as string, signal),
    STALE.concerns,
    { enabled: !!id, ...opts },
  )
}

/**
 * Auto-formed clusters (≥3 concerns / 600 m / 24 h) — loop #1 — that had
 * formed by the moment on screen. A string is the campaign id, as before.
 */
export function useConcernClusters(
  params: api.ClustersParams | string = {},
  opts?: QueryOpts<ConcernCluster[]>,
): UseQueryResult<ConcernCluster[], Error> {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const given: api.ClustersParams = typeof params === 'string' ? { campaign_id: params } : params
  const merged: api.ClustersParams = { ...given, at: atFor(given, time) }
  return useApiQuery(
    qk.clusters.list(merged),
    (signal) => api.listClusters(merged, signal),
    STALE.clusters,
    timed(ready, {}, opts),
  )
}

/** Alias — the four apps reach for both names. */
export const useClusters = useConcernClusters

// ═════════════════════════════════════════════════════════════════════ sites

export function useSites(
  campaignId?: string,
  opts?: QueryOpts<IndustrySite[]>,
): UseQueryResult<IndustrySite[], Error> {
  return useApiQuery(qk.sites.all, (signal) => api.listSites(campaignId, signal), STALE.sites, opts)
}

export function useSite(id: string | null | undefined, opts?: QueryOpts<IndustrySite>) {
  return useApiQuery(
    qk.sites.detail(id ?? ''),
    (signal) => api.getSite(id as string, signal),
    STALE.sites,
    { enabled: !!id, ...opts },
  )
}

export function usePosts(
  params: api.PostsParams = {},
  opts?: QueryOpts<SitePost[]>,
): UseQueryResult<SitePost[], Error> {
  return useApiQuery(qk.posts.list(params), (signal) => api.listPosts(params, signal), STALE.posts, opts)
}

// ════════════════════════════════════════════════════════════════ advisories

export function useAdvisories(
  params: api.AdvisoriesParams = {},
  opts?: QueryOpts<Advisory[]>,
): UseQueryResult<Advisory[], Error> {
  return useApiQuery(
    qk.advisories.list(params),
    (signal) => api.listAdvisories(params, signal),
    STALE.advisories,
    opts,
  )
}

// ════════════════════════════════════════════════════════════ the alert bus

/**
 * Alerts that had begun by the moment on screen. Defaults `role` to the active
 * persona's role and `at` to the clock. Pass `site_id` to get `bearing_deg` +
 * `distance_m`. "Live" is `isOngoing(alert, now)` (core/events), not
 * `status === 'active'`: the status is the final one and cannot say when an
 * alert ended.
 */
export function useAlerts(
  params: api.AlertsParams = {},
  opts?: QueryOpts<Alert[]>,
): UseQueryResult<Alert[], Error> {
  const role = useSession((s) => s.role)
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const merged: api.AlertsParams = {
    role: params.role ?? role ?? undefined, ...params, at: atFor(params, time),
  }
  return useApiQuery(
    qk.alerts.list(merged),
    (signal) => api.listAlerts(merged, signal),
    STALE.alerts,
    timed(ready, {}, opts),
  )
}

/**
 * One alert as of the moment on screen, so a detail opened in replay agrees
 * with the row it was opened from. Without `at` the server picked the related
 * reports as of the end of the data; at Aug 12 both it returned for
 * al-no2-0034-006 were filed Aug 17, the browser's `happenedBy` dropped them,
 * and the one report that did exist then was never shown.
 */
export function useAlert(
  id: string | null | undefined,
  siteId?: string,
  opts?: QueryOpts<Alert>,
): UseQueryResult<Alert, Error> {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const at = timeParam(time)
  return useApiQuery(
    qk.alerts.detail(id ?? '', siteId, at),
    (signal) => api.getAlert(id as string, siteId, at, signal),
    STALE.alerts,
    timed(ready, { enabled: !!id }, opts),
  )
}

/** The regulator's editable tripwires. */
export function useActionLevels(opts?: QueryOpts<ActionLevel[]>): UseQueryResult<ActionLevel[], Error> {
  return useApiQuery(qk.actionLevels.all, api.listActionLevels, STALE.actionLevels, opts)
}

// ══════════════════════════════════════════════════════════════════════ feed

/**
 * Merged social feed as of the moment on screen. Defaults `role` to the active
 * persona's role and `at` to the clock.
 */
export function useFeed(
  params: api.FeedParams = {},
  opts?: QueryOpts<FeedItem[]>,
): UseQueryResult<FeedItem[], Error> {
  const role = useSession((s) => s.role)
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const merged: api.FeedParams = {
    role: params.role ?? role ?? undefined, ...params, at: atFor(params, time),
  }
  return useApiQuery(
    qk.feed.list(merged),
    (signal) => api.getFeed(merged, signal),
    STALE.feed,
    timed(ready, {}, opts),
  )
}

// ═════════════════════════════════════════════════════════════════════ fleet

/**
 * Live-ish vehicle positions. `at` defaults to the session time cursor and
 * `delay_min` is forced to ≥180 for community (CONTRACT §9.5) — the one place
 * that rule is implemented.
 */
export function useFleet(
  params: api.FleetParams = {},
  opts?: QueryOpts<FleetPosition[]>,
): UseQueryResult<FleetPosition[], Error> {
  const role = useSession((s) => s.role)
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const configured = useFlags()?.community_fleet_delay_min
  const merged: api.FleetParams = {
    at: params.at ?? timeParam(time),
    delay_min: params.delay_min ?? fleetDelayFor(role, configured),
    ...(params.campaign_id ? { campaign_id: params.campaign_id } : {}),
  }
  // At the end of the data the clock is paused (D1): nothing to poll for.
  return useApiQuery(qk.fleet.list(merged), (signal) => api.getFleet(merged, signal), STALE.fleet,
    timed(ready, {}, opts))
}

export function useVehicles(opts?: QueryOpts<Vehicle[]>): UseQueryResult<Vehicle[], Error> {
  return useApiQuery(qk.fleet.vehicles, api.listVehicles, STALE.drivePlan, opts)
}

export function useDrivePlan(
  campaignId?: string,
  opts?: QueryOpts<DrivePlan>,
): UseQueryResult<DrivePlan, Error> {
  return useApiQuery(
    qk.drivePlan.detail(campaignId),
    (signal) => api.getDrivePlan(campaignId, signal),
    STALE.drivePlan,
    opts,
  )
}

export function useDrivePlanCoverage(
  id: string | null | undefined,
  opts?: QueryOpts<CoverageCell[]>,
): UseQueryResult<CoverageCell[], Error> {
  return useApiQuery(
    qk.drivePlan.coverage(id ?? ''),
    (signal) => api.getDrivePlanCoverage(id as string, signal),
    STALE.drivePlan,
    { enabled: !!id, ...opts },
  )
}

// ══════════════════════════════════════════════════════════════════════ wind

/** Hourly wind. Defaults to the session's trailing window. */
export function useWind(
  params: api.WindParams = {},
  opts?: QueryOpts<WindPoint[]>,
): UseQueryResult<WindPoint[], Error> {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const range = timeRange(time)
  const merged: api.WindParams = {
    from: params.from ?? range.from,
    to: params.to ?? range.to,
    ...(params.campaign_id ? { campaign_id: params.campaign_id } : {}),
  }
  return useApiQuery(qk.wind.list(merged), (signal) => api.getWind(merged, signal), STALE.wind,
    timed(ready, {}, opts))
}

/** The most recent wind observation at or before the time cursor. */
export function useCurrentWind(): WindPoint | undefined {
  const { data } = useWind()
  if (!data?.length) return undefined
  return data[data.length - 1]
}

/**
 * Plume cone(s) for a site at a moment. Defaults `at` to the time cursor.
 * `outline: true` adds the outline parts and axis (`DispersionPlumeOutlined`)
 * for the hairline style; the default leaves the request as it always was.
 */
export function useDispersion(
  params: api.DispersionParams & { outline: true },
  opts?: QueryOpts<DispersionPlumeOutlined>,
): UseQueryResult<DispersionPlumeOutlined, Error>
export function useDispersion(
  params?: api.DispersionParams,
  opts?: QueryOpts<DispersionPlume>,
): UseQueryResult<DispersionPlume, Error>
export function useDispersion(
  params: api.DispersionParams = {},
  opts?: QueryOpts<DispersionPlume> | QueryOpts<DispersionPlumeOutlined>,
): UseQueryResult<DispersionPlume | DispersionPlumeOutlined, Error> {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  // `outline` joins the key only when on, so every existing caller keeps its
  // cache entry, and `outline: false` is the same entry as leaving it out.
  const { outline, ...rest } = params
  const merged: api.DispersionParams = {
    at: rest.at ?? timeParam(time), ...rest, ...(outline ? { outline: true } : {}),
  }
  return useApiQuery<DispersionPlume | DispersionPlumeOutlined>(
    qk.wind.dispersion(merged),
    (signal) => api.getDispersion(merged, signal),
    STALE.dispersion,
    timed(ready, { enabled: !!merged.site_id }, opts as QueryOpts<DispersionPlume | DispersionPlumeOutlined>),
  )
}

// ═══════════════════════════════════════════════ observed wind & model check

/**
 * Fleet anemometry. Defaults to the session's trailing window and to
 * `quality: 'good'` — pass `quality: undefined` explicitly to see everything,
 * and surface the flag in the UI rather than hiding suspect points.
 */
export function useMobileWind(
  params: api.MobileWindParams = {},
  opts?: QueryOpts<MobileWindObs[]>,
): UseQueryResult<MobileWindObs[], Error> {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const range = timeRange(time)
  const merged: api.MobileWindParams = {
    from: params.from ?? range.from,
    to: params.to ?? range.to,
    quality: 'quality' in params ? params.quality : 'good',
    ...(params.bbox ? { bbox: params.bbox } : {}),
    ...(params.limit != null ? { limit: params.limit } : {}),
    ...(params.campaign_id ? { campaign_id: params.campaign_id } : {}),
  }
  return useApiQuery(
    qk.wind.mobile(merged),
    (signal) => api.getMobileWind(merged, signal),
    STALE.mobileWind,
    timed(ready, {}, opts),
  )
}

/** Binned observed wind field — the particle overlay on the scope and the map. */
export function useWindField(
  params: api.WindFieldParams = {},
  opts?: QueryOpts<WindField>,
): UseQueryResult<WindField, Error> {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const range = timeRange(time)
  const merged: api.WindFieldParams = {
    from: params.from ?? range.from,
    to: params.to ?? range.to,
    cell_m: params.cell_m ?? 400,
    ...(params.campaign_id ? { campaign_id: params.campaign_id } : {}),
  }
  return useApiQuery(
    qk.wind.field(merged),
    (signal) => api.getWindField(merged, signal),
    STALE.windField,
    timed(ready, {}, opts),
  )
}

/** The consultant's dispersion deliverables for a site. */
export function useDispersionModels(
  siteId: string | null | undefined,
  opts?: QueryOpts<DispersionModel[]>,
): UseQueryResult<DispersionModel[], Error> {
  return useApiQuery(
    qk.sites.models(siteId ?? ''),
    (signal) => api.listDispersionModels(siteId as string, signal),
    STALE.dispersionModels,
    { enabled: !!siteId, ...opts },
  )
}

/**
 * Assumed wind rose vs. what our fleet measured: per-bearing bias, understated
 * bearings, under-weighted districts, verdict. The industry payoff screen.
 */
export function useModelVerification(
  siteId: string | null | undefined,
  params: api.ModelVerificationParams = {},
  opts?: QueryOpts<ModelVerification>,
): UseQueryResult<ModelVerification, Error> {
  return useApiQuery(
    qk.sites.verification(siteId ?? '', params),
    (signal) => api.getModelVerification(siteId as string, params, signal),
    STALE.verification,
    { enabled: !!siteId, ...opts },
  )
}

// ══════════════════════════════════════════════════════════════ coverage

/**
 * **The regulator's question.** Where the fixed network stands relative to the
 * modelled plume — and, in `useResidency`, the plume-hours nothing was
 * standing in.
 *
 * Read `data.basis` before printing any of these numbers: they are modelled,
 * not measured, and the sentence that says so ships in the payload.
 */
export function useInterception(opts?: QueryOpts<Interception>) {
  return useApiQuery(qk.coverageAnalysis.interception, api.getInterception, STALE.coverageAnalysis, opts)
}

export function useResidency(opts?: QueryOpts<Residency>) {
  return useApiQuery(qk.coverageAnalysis.residency, api.getResidency, STALE.coverageAnalysis, opts)
}

/** NOT a recommendation — render `data.framing` alongside the rows. */
export function useSiting(limit = 10, opts?: QueryOpts<Siting>) {
  return useApiQuery(
    qk.coverageAnalysis.siting(limit),
    (signal) => api.getSiting(limit, signal),
    STALE.coverageAnalysis,
    opts,
  )
}

/**
 * Anchor ages as of the moment on screen. Measured from the end of the data,
 * a June cursor printed "anchored 11 d" for a calibration done Aug 18.
 */
export function useCalibration(opts?: QueryOpts<Calibration>) {
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const at = timeParam(time)
  return useApiQuery(
    qk.coverageAnalysis.calibration(at),
    (signal) => api.getCalibration(at, signal),
    STALE.coverageAnalysis,
    timed(ready, {}, opts),
  )
}

// ═════════════════════════════════════════════════════════ mission brief

/** The hour the brief is issued (`brief.ISSUE_HOUR` on the server). */
const BRIEF_ISSUE_HOUR = 7

/**
 * The day whose brief was the latest one out at `t`: its own date from 07:00,
 * the day before until then. Paused at Aug 12 03:00, the date alone opened
 * "Issued 2026-08-12 07:00" — a brief four hours in the future — and planned
 * the day from it.
 */
function briefDay(t: CampaignTime): string {
  const day = t.slice(0, 10)
  const hour = Number(t.slice(11, 13))
  return hour < BRIEF_ISSUE_HOUR ? addHours(`${day}T00:00:00`, -24).slice(0, 10) : day
}

/**
 * **The fleet lead's 07:00 read.** Keyed on the brief's DAY, not the cursor's
 * instant — a playing cursor ticks four times a second, and the brief only
 * changes when a new one is issued. Moving the cursor back a day re-issues the
 * forecast, so the five-day strip visibly redraws: the plan changed because
 * the wind did.
 */
export function useMissionBrief(
  siteId?: string | null,
  opts?: QueryOpts<MissionBrief>,
): UseQueryResult<MissionBrief, Error> {
  const cursor = useSession((s) => s.time.cursor)
  const end = useSession((s) => s.time.bounds?.end ?? null)
  // At the end of the data the day is the end's own brief day — one key for
  // "Aug 28" whether you stepped onto it or paused there — and the request
  // sends no date, so the server picks its default day, unless the data ends
  // before that day's 07:00 issue. Waits for the bounds, so the first render
  // does not fetch once under null and again under the date.
  const at = cursor ?? end
  const date = at ? briefDay(at) : null
  const send = date !== null && (cursor !== null || date !== end?.slice(0, 10))
  return useApiQuery(
    qk.brief.of(date, siteId ?? null),
    (signal) => api.getMissionBrief({
      ...(send && date ? { date } : {}), ...(siteId ? { site_id: siteId } : {}),
    }, signal),
    STALE.brief,
    { enabled: date !== null, ...opts },
  )
}

// ════════════════════════════════════════════════════════════ climatology

/**
 * **The community app's front door.** How often the wind carried from each
 * site over each neighbourhood, over the whole campaign.
 *
 * Stable — open the map at 8am and 6pm and it says the same thing — and
 * reach-independent, so it does not move when the dispersion kernel does.
 * Every sentence built from it belongs in `PLUME_COPY`, including the one
 * about what it does not say.
 */
export function useClimatology(
  siteId?: string | null,
  opts?: QueryOpts<WindClimatology>,
): UseQueryResult<WindClimatology, Error> {
  return useApiQuery(
    qk.climatology.of(siteId ?? null),
    (signal) => api.getClimatology(siteId ? { site_id: siteId } : {}, signal),
    STALE.climatology,
    opts,
  )
}

// ═══════════════════════════════════════════════════════════════ envelope

/**
 * **The industry tier's spine.** How hard this site can run, measured, per
 * stability regime — not `site.headroom_pct`, which is a constant.
 *
 * Read the `stable` regime for the number that binds: it is the one that
 * closes at night and opens by morning. `state: 'indistinct'` means the site's
 * fenceline is not separable from an arbitrary patch of road, which is a
 * finding and should be shown as one.
 */
export function useEnvelope(
  siteId: string | null | undefined,
  measure: MeasureCode = 'no2',
  opts?: QueryOpts<Envelope>,
): UseQueryResult<Envelope, Error> {
  return useApiQuery(
    qk.envelope.site(siteId ?? '', measure),
    (signal) => api.getEnvelope(siteId as string, { measure }, signal),
    STALE.envelope,
    { enabled: !!siteId, ...opts },
  )
}

// ══════════════════════════════════════════════════════════════ touchdown

/**
 * The MEASURED plume for one site — the counterpart to `useDispersion`, which
 * is the model. CONTRACT §10b: these two are drawn in different registers and
 * the measurement is the only inked thing.
 *
 * Read `data.site.state` for the verdict. The per-feature `state` on each road
 * segment is EVIDENCE — how much we know about that road — and never a finding
 * of its own; zero of 1,307 segments carry enough conditioned passes to be one.
 */
export function useTouchdown(
  siteId: string | null | undefined,
  params: api.TouchdownParams = {},
  opts?: QueryOpts<Touchdown>,
): UseQueryResult<Touchdown, Error> {
  return useApiQuery(
    qk.touchdown.site(siteId ?? '', params),
    (signal) => api.getTouchdown(siteId as string, params, signal),
    STALE.touchdown,
    { enabled: !!siteId, ...opts },
  )
}

/**
 * Where a car has actually been. Dim or hatch any modelled shape outside it,
 * and compute no agreement metric outside it. `cell_m` is the cell SIDE.
 */
export function useCoverage(
  campaignId = 'current',
  cellM = 150,
  opts?: QueryOpts<CoverageMask>,
): UseQueryResult<CoverageMask, Error> {
  return useApiQuery(
    qk.coverage.mask(campaignId, cellM),
    (signal) => api.getCoverage(campaignId, { cell_m: cellM }, signal),
    STALE.coverage,
    opts,
  )
}

// ═════════════════════════════════════════════════════════════════════ stats

/**
 * Headline risk scores, trend, worst/best streets. Community-facing. The
 * report counts ("N reports from neighbours this week") are as of `at`, which
 * defaults to the clock — measured from the wall clock they read 0.
 */
export function useCommunityStats(
  params: api.CommunityStatsParams = {},
  opts?: QueryOpts<CommunityStats>,
): UseQueryResult<CommunityStats, Error> {
  const statWindow = useSession((s) => s.statWindow)
  const time = useSession((s) => s.time)
  const ready = useClockReady()
  const merged: api.CommunityStatsParams = {
    ...params, window: params.window ?? statWindow, at: atFor(params, time),
  }
  return useApiQuery(
    qk.stats.community(merged),
    (signal) => api.getCommunityStats(merged, signal),
    STALE.stats,
    timed(ready, {}, opts),
  )
}

/** Admin KPIs. */
export function useCampaignStats(
  campaignId?: string,
  opts?: QueryOpts<CampaignStats>,
): UseQueryResult<CampaignStats, Error> {
  return useApiQuery(
    qk.stats.campaign,
    (signal) => api.getCampaignStats(campaignId, signal),
    STALE.stats,
    opts,
  )
}

/** The append-only mutation log — admin oversight. */
export function useActivity(
  params: { since?: string; limit?: number; role?: Role } = {},
  opts?: QueryOpts<ActivityItem[]>,
): UseQueryResult<ActivityItem[], Error> {
  return useApiQuery(
    qk.activity.list(params),
    (signal) => api.getActivity(params, signal),
    STALE.activity,
    opts,
  )
}

// ═══════════════════════════════════════════════════════════════ mutations
// Each mutation invalidates the caches the *other* interfaces read from. That
// is loop #1, #2 and #3 in CONTRACT §1 — do not trim these lists.

/** Broad invalidation groups, reused by mutations and by `core/live.ts`. */
export const INVALIDATE = {
  concern: [qk.concerns.all, qk.clusters.all, qk.feed.all, qk.alerts.all, qk.stats.all, qk.activity.all],
  alert: [qk.alerts.all, qk.feed.all, qk.stats.all, qk.activity.all],
  advisory: [qk.advisories.all, qk.feed.all, qk.stats.all, qk.activity.all],
  post: [qk.posts.all, qk.feed.all, qk.activity.all],
  mitigation: [qk.posts.all, qk.feed.all, qk.concerns.all, qk.alerts.all, qk.sites.all, qk.activity.all],
  actionLevel: [qk.actionLevels.all, qk.alerts.all, qk.advisories.all, qk.feed.all, qk.activity.all],
  fleet: [qk.fleet.all],
  everything: [
    qk.bootstrap, qk.segments.all, qk.monitors.all, qk.concerns.all, qk.clusters.all,
    qk.sites.all, qk.posts.all, qk.advisories.all, qk.alerts.all, qk.actionLevels.all,
    qk.feed.all, qk.fleet.all, qk.drivePlan.all, qk.wind.all, qk.stats.all, qk.activity.all,
    qk.touchdown.all, qk.coverage.all, qk.envelope.all, qk.climatology.all,
    qk.coverageAnalysis.all,
  ],
} as const

function useInvalidator(): (groups: readonly (readonly unknown[])[]) => void {
  const qc = useQueryClient()
  return (groups) => {
    for (const key of groups) void qc.invalidateQueries({ queryKey: key })
  }
}

/** Community files a concern → industry RWR + regulator queue (loop #1). */
export function useCreateConcern(): UseMutationResult<Concern, Error, api.CreateConcernBody> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: api.createConcern,
    onSuccess: () => invalidate(INVALIDATE.concern),
  })
}

/** "This happened to me too" — pushes a concern towards a cluster. */
export function useCorroborate(): UseMutationResult<Concern, Error, { id: string; userId?: string }> {
  const invalidate = useInvalidator()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, userId }) => api.corroborateConcern(id, userId),
    onSuccess: (concern, vars) => {
      qc.setQueryData(qk.concerns.detail(vars.id), concern)
      invalidate(INVALIDATE.concern)
    },
  })
}

export function useCreateConcernResponse(): UseMutationResult<
  ConcernResponse,
  Error,
  { concernId: string; body: api.CreateConcernResponseBody }
> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: ({ concernId, body }) => api.createConcernResponse(concernId, body),
    onSuccess: () => invalidate(INVALIDATE.concern),
  })
}

/**
 * Regulator / admin only. Industry may not close a concern — the client
 * rejects `resolved`/`closed` when `actorRole === 'industry'`.
 */
export function useUpdateConcernStatus(): UseMutationResult<
  Concern,
  Error,
  { id: string; status: ConcernStatus; actorRole?: Role }
> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: ({ id, status, actorRole }) => api.updateConcernStatus(id, status, actorRole),
    onSuccess: () => invalidate(INVALIDATE.concern),
  })
}

/** Industry posts to the community feed. */
export function useCreatePost(): UseMutationResult<SitePost, Error, api.CreatePostBody> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: api.createPost,
    onSuccess: () => invalidate(INVALIDATE.post),
  })
}

/** Industry proposes a mitigation → community feed + regulator alert (loop #3). */
export function useCreateMitigation(): UseMutationResult<Mitigation, Error, api.CreateMitigationBody> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: api.createMitigation,
    onSuccess: () => invalidate(INVALIDATE.mitigation),
  })
}

/** Regulator pushes an advisory to the community feed (loop #2). */
export function useCreateAdvisory(): UseMutationResult<Advisory, Error, api.CreateAdvisoryBody> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: api.createAdvisory,
    onSuccess: () => invalidate(INVALIDATE.advisory),
  })
}

export function useAcknowledgeAlert(): UseMutationResult<
  Alert,
  Error,
  { id: string; note?: string; userId?: string }
> {
  const invalidate = useInvalidator()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note, userId }) => api.acknowledgeAlert(id, note, userId),
    onSuccess: (alert, vars) => {
      qc.setQueryData(qk.alerts.detail(vars.id), alert)
      invalidate(INVALIDATE.alert)
    },
  })
}

/** Moving a tripwire re-evaluates alerts immediately. */
export function useUpdateActionLevel(): UseMutationResult<
  ActionLevel,
  Error,
  { id: string; body: api.ActionLevelBody }
> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: ({ id, body }) => api.updateActionLevel(id, body),
    onSuccess: () => invalidate(INVALIDATE.actionLevel),
  })
}

export function useCreateActionLevel(): UseMutationResult<ActionLevel, Error, api.ActionLevelBody> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: api.createActionLevel,
    onSuccess: () => invalidate(INVALIDATE.actionLevel),
  })
}

/** "What do I do about it" — the industry recommendation. */
export function useAskAdvisor(): UseMutationResult<AdvisorReply, Error, api.AdvisorBody> {
  return useMutation({ mutationFn: api.askAdvisor })
}

/** Fire a scripted demo scenario. Invalidates everything — it changes the world. */
export function useSimulate(): UseMutationResult<api.SimulateResult, Error, SimScenario> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: api.simulate,
    onSuccess: () => invalidate(INVALIDATE.everything),
  })
}

export function useRegenerateDrivePlan(): UseMutationResult<
  DrivePlan,
  Error,
  { campaignId: string; body: api.DrivePlanBody }
> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: ({ campaignId, body }) => api.regenerateDrivePlan(campaignId, body),
    onSuccess: () => invalidate([qk.drivePlan.all, qk.fleet.all, qk.stats.all, qk.activity.all]),
  })
}

export function useReseed(): UseMutationResult<api.ReseedResult, Error, number | undefined> {
  const invalidate = useInvalidator()
  return useMutation({
    mutationFn: (seed) => api.reseed(seed),
    onSuccess: () => invalidate(INVALIDATE.everything),
  })
}
