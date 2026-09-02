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
 *   · Hooks that are time-aware default to the session time cursor.
 *   · Nothing throws on a missing backend: queries just sit in `isError` and
 *     screens render their empty state.
 */

import {
  QueryClient,
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
  DrivePlan,
  FeedItem,
  FleetPosition,
  IndustrySite,
  MeasureCode,
  MeasureDef,
  Mitigation,
  MobileWindObs,
  ModelVerification,
  Monitor,
  MonitorReadings,
  Org,
  Role,
  SegmentCollection,
  SegmentDetail,
  SimScenario,
  SitePost,
  StatWindow,
  User,
  Vehicle,
  WindField,
  WindPoint,
} from '@/core/types'
import { fleetDelayFor, timeParam, timeRange, useSession } from '@/core/session'
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
    detail: (id: string) => ['monitors', 'detail', id] as const,
    readings: (id: string, params: api.MonitorReadingsParams) =>
      ['monitors', 'readings', id, params] as const,
  },

  concerns: {
    all: ['concerns'] as const,
    list: (params: api.ConcernsParams) => ['concerns', 'list', params] as const,
    detail: (id: string) => ['concerns', 'detail', id] as const,
  },

  clusters: { all: ['clusters'] as const },

  sites: {
    all: ['sites'] as const,
    detail: (id: string) => ['sites', 'detail', id] as const,
    models: (id: string) => ['sites', id, 'dispersion-models'] as const,
    verification: (id: string, params: api.ModelVerificationParams) =>
      ['sites', id, 'model-verification', params] as const,
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
    detail: (id: string, siteId?: string) => ['alerts', 'detail', id, siteId ?? null] as const,
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
    community: (params: { window?: StatWindow }) => ['stats', 'community', params] as const,
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

/** Options every hook accepts. Spread last — callers always win. */
export type QueryOpts<T> = Partial<Omit<UseQueryOptions<T, Error, T>, 'queryKey' | 'queryFn'>>

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

export function useMonitors(
  params: api.MonitorsParams = {},
  opts?: QueryOpts<Monitor[]>,
): UseQueryResult<Monitor[], Error> {
  return useApiQuery(
    qk.monitors.list(params),
    (signal) => api.listMonitors(params, signal),
    STALE.monitors,
    opts,
  )
}

export function useMonitor(id: string | null | undefined, opts?: QueryOpts<Monitor>) {
  return useApiQuery(
    qk.monitors.detail(id ?? ''),
    (signal) => api.getMonitor(id as string, signal),
    STALE.monitors,
    { enabled: !!id, ...opts },
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
    { enabled: !!id, ...opts },
  )
}

// ══════════════════════════════════════════════════════════════════ concerns

export function useConcerns(
  params: api.ConcernsParams = {},
  opts?: QueryOpts<Concern[]>,
): UseQueryResult<Concern[], Error> {
  return useApiQuery(
    qk.concerns.list(params),
    (signal) => api.listConcerns(params, signal),
    STALE.concerns,
    opts,
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

/** Auto-formed clusters (≥3 concerns / 600 m / 24 h) — loop #1. */
export function useConcernClusters(
  campaignId?: string,
  opts?: QueryOpts<ConcernCluster[]>,
): UseQueryResult<ConcernCluster[], Error> {
  return useApiQuery(
    qk.clusters.all,
    (signal) => api.listClusters(campaignId, signal),
    STALE.clusters,
    opts,
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
 * Alerts. Defaults `role` to the active persona's role. Pass `site_id` to get
 * `bearing_deg` + `distance_m` — that is the RWR geometry the scope draws.
 */
export function useAlerts(
  params: api.AlertsParams = {},
  opts?: QueryOpts<Alert[]>,
): UseQueryResult<Alert[], Error> {
  const role = useSession((s) => s.role)
  const merged: api.AlertsParams = { role: params.role ?? role ?? undefined, ...params }
  return useApiQuery(
    qk.alerts.list(merged),
    (signal) => api.listAlerts(merged, signal),
    STALE.alerts,
    opts,
  )
}

export function useAlert(
  id: string | null | undefined,
  siteId?: string,
  opts?: QueryOpts<Alert>,
): UseQueryResult<Alert, Error> {
  return useApiQuery(
    qk.alerts.detail(id ?? '', siteId),
    (signal) => api.getAlert(id as string, siteId, signal),
    STALE.alerts,
    { enabled: !!id, ...opts },
  )
}

/** The regulator's editable tripwires. */
export function useActionLevels(opts?: QueryOpts<ActionLevel[]>): UseQueryResult<ActionLevel[], Error> {
  return useApiQuery(qk.actionLevels.all, api.listActionLevels, STALE.actionLevels, opts)
}

// ══════════════════════════════════════════════════════════════════════ feed

/** Merged social feed. Defaults `role` to the active persona's role. */
export function useFeed(
  params: api.FeedParams = {},
  opts?: QueryOpts<FeedItem[]>,
): UseQueryResult<FeedItem[], Error> {
  const role = useSession((s) => s.role)
  const merged: api.FeedParams = { role: params.role ?? role ?? undefined, ...params }
  return useApiQuery(qk.feed.list(merged), (signal) => api.getFeed(merged, signal), STALE.feed, opts)
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
  const configured = useFlags()?.community_fleet_delay_min
  const merged: api.FleetParams = {
    at: params.at ?? timeParam(time),
    delay_min: params.delay_min ?? fleetDelayFor(role, configured),
    ...(params.campaign_id ? { campaign_id: params.campaign_id } : {}),
  }
  return useApiQuery(qk.fleet.list(merged), (signal) => api.getFleet(merged, signal), STALE.fleet, {
    refetchInterval: time.cursor ? false : 5_000,
    ...opts,
  })
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
  const range = timeRange(time)
  const merged: api.WindParams = {
    from: params.from ?? range.from,
    to: params.to ?? range.to,
    ...(params.campaign_id ? { campaign_id: params.campaign_id } : {}),
  }
  return useApiQuery(qk.wind.list(merged), (signal) => api.getWind(merged, signal), STALE.wind, opts)
}

/** The most recent wind observation at or before the time cursor. */
export function useCurrentWind(): WindPoint | undefined {
  const { data } = useWind()
  if (!data?.length) return undefined
  return data[data.length - 1]
}

/** Plume cone(s) for a site at a moment. Defaults `at` to the time cursor. */
export function useDispersion(
  params: api.DispersionParams = {},
  opts?: QueryOpts<DispersionPlume>,
): UseQueryResult<DispersionPlume, Error> {
  const time = useSession((s) => s.time)
  const merged: api.DispersionParams = { at: params.at ?? timeParam(time), ...params }
  return useApiQuery(
    qk.wind.dispersion(merged),
    (signal) => api.getDispersion(merged, signal),
    STALE.dispersion,
    { enabled: !!merged.site_id, ...opts },
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
    opts,
  )
}

/** Binned observed wind field — the particle overlay on the scope and the map. */
export function useWindField(
  params: api.WindFieldParams = {},
  opts?: QueryOpts<WindField>,
): UseQueryResult<WindField, Error> {
  const time = useSession((s) => s.time)
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
    opts,
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

// ═════════════════════════════════════════════════════════════════════ stats

/** Headline risk scores, trend, worst/best streets. Community-facing. */
export function useCommunityStats(
  params: { window?: StatWindow } = {},
  opts?: QueryOpts<CommunityStats>,
): UseQueryResult<CommunityStats, Error> {
  const statWindow = useSession((s) => s.statWindow)
  const merged = { window: params.window ?? statWindow }
  return useApiQuery(
    qk.stats.community(merged),
    (signal) => api.getCommunityStats(merged, signal),
    STALE.stats,
    opts,
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
