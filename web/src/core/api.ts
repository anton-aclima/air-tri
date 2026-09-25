/**
 * air — typed API client.
 *
 * One function per endpoint in CONTRACT §5. No `any`, no `axios`, no codegen.
 * Everything returns the wire types from `core/types.ts`.
 *
 * The backend is written in parallel and may be down or incomplete, so:
 *   · a non-2xx response throws `ApiError` (with `.status`), never silently `{}`
 *   · list endpoints tolerate both `[...]` and `{ items: [...] }` envelopes
 *   · requests time out rather than hanging the UI
 *
 * Prefer the hooks in `core/queries.ts` inside components; call these directly
 * only from loaders, event handlers that must await, or tests.
 */

import type {
  ActionLevel,
  ActionLevelKind,
  ActivityItem,
  Advisory,
  AdvisorReply,
  Alert,
  AlertKind,
  AlertStatus,
  BBox,
  Bootstrap,
  Campaign,
  CampaignStats,
  CommunityStats,
  Calibration,
  CoverageMask,
  Interception,
  Residency,
  Siting,
  Envelope as EnvelopeT,
  Touchdown,
  Concern,
  ConcernCluster,
  ConcernKind,
  ConcernResponse,
  ConcernStatus,
  CoverageCell,
  DispersionAxisFeature,
  DispersionBandFeature,
  DispersionFeature,
  DispersionModel,
  DispersionOutlineFeature,
  DispersionPlume,
  DispersionPlumeOutlined,
  DrivePlan,
  FeatureCollection,
  FeedItem,
  FleetPosition,
  GeoGeometry,
  IndustrySite,
  MeasureCode,
  Mitigation,
  MissionBrief,
  MobileWindObs,
  ModelVerification,
  Monitor,
  MonitorReadings,
  RegulatorNetwork,
  Role,
  SegmentCollection,
  SegmentDetail,
  SegmentMetric,
  Severity,
  SimScenario,
  SitePost,
  StatWindow,
  StreetsWindow,
  Vehicle,
  WindField,
  WindClimatology,
  WindPoint,
} from '@/core/types'

// ────────────────────────────────────────────────────────────────── config

/** Everything is proxied through Vite in dev (see `vite.config.ts`). */
export const API_BASE = '/api/v1'

/** Absolute-ish URL for a path under the API root. Used by `core/live.ts`. */
export function apiUrl(path: string, params?: QueryParams): string {
  return `${API_BASE}${path}${queryString(params)}`
}

/** Default request timeout, ms. Generous: `/segments` can be a big payload. */
const TIMEOUT_MS = 25_000

// ─────────────────────────────────────────────────────────────────── errors

export class ApiError extends Error {
  readonly status: number
  readonly url: string
  readonly detail: unknown

  /**
   * Our own `TIMEOUT_MS` gave up on it — status 0, but not "backend not
   * there": the request was waiting (a queue of connections in the browser, a
   * slow build) rather than refused, so it is worth asking again.
   */
  readonly timedOut: boolean

  constructor(message: string, status: number, url: string, detail: unknown = null, timedOut = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.url = url
    this.detail = detail
    this.timedOut = timedOut
  }

  /** The backend simply isn't up / the route isn't built yet. */
  get isMissing(): boolean {
    return this.status === 404 || this.status === 501 || this.status === 0
  }

  get isOffline(): boolean {
    return this.status === 0
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

/**
 * True when the failure means "backend not there", not "bad request". A
 * request that timed out on our side is not: it is retried like any blip.
 */
export function isBackendDown(e: unknown): boolean {
  return isApiError(e) && !e.timedOut
    && (e.isOffline || e.status === 502 || e.status === 503 || e.status === 504)
}

// ──────────────────────────────────────────────────────────── query strings

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[]
export type QueryParams = Record<string, QueryValue>

export function queryString(params?: QueryParams): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      sp.set(key, value.join(','))
    } else {
      sp.set(key, String(value))
    }
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

/** `bbox` goes on the wire as `w,s,e,n`. */
export function bboxParam(bbox?: BBox | null): string | undefined {
  return bbox ? bbox.join(',') : undefined
}

/** `near=lon,lat,radius_m` */
export function nearParam(lon?: number, lat?: number, radiusM?: number): string | undefined {
  if (lon == null || lat == null) return undefined
  return `${lon},${lat},${radiusM ?? 600}`
}

// ─────────────────────────────────────────────────────────────── transport

interface RequestOpts {
  params?: QueryParams
  signal?: AbortSignal
  body?: unknown
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  timeoutMs?: number
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { params, signal, body, method = 'GET', timeoutMs = TIMEOUT_MS } = opts
  const url = apiUrl(path, params)

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)

  let res: Response
  try {
    res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    if (signal?.aborted) throw err
    const msg = timedOut ? `no answer in ${timeoutMs / 1000} s` : err instanceof Error ? err.message : 'network error'
    throw new ApiError(`${method} ${url} failed: ${msg}`, 0, url, err, timedOut)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  if (!res.ok) {
    let detail: unknown = null
    let message = `${res.status} ${res.statusText}`
    try {
      const text = await res.text()
      if (text) {
        try {
          detail = JSON.parse(text) as unknown
          const d = detail as { detail?: unknown; message?: unknown }
          const m = d?.detail ?? d?.message
          if (typeof m === 'string') message = m
        } catch {
          detail = text
          message = text.slice(0, 200)
        }
      }
    } catch {
      /* body unreadable — keep the status line */
    }
    throw new ApiError(message, res.status, url, detail)
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new ApiError('response was not JSON', res.status, url, err)
  }
}

const LIST_KEYS = ['items', 'results', 'data', 'rows'] as const

/** Accept `[...]`, `{ items: [...] }`, `{ results: [...] }`, `{ data: [...] }`. */
function asList<T>(raw: unknown, ...extraKeys: string[]): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    for (const key of [...extraKeys, ...LIST_KEYS]) {
      const v = obj[key]
      if (Array.isArray(v)) return v as T[]
    }
  }
  return []
}

/** Never hand a broken FeatureCollection to deck.gl. */
function asFeatureCollection<C extends FeatureCollection<GeoGeometry, never>>(raw: unknown): C {
  if (raw && typeof raw === 'object') {
    const obj = raw as { type?: unknown; features?: unknown }
    if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) return raw as C
  }
  return { type: 'FeatureCollection', features: [] } as unknown as C
}

async function getList<T>(path: string, params?: QueryParams, signal?: AbortSignal, ...keys: string[]): Promise<T[]> {
  return asList<T>(await request<unknown>(path, { params, signal }), ...keys)
}

// ═══════════════════════════════════════════════════════════════════ READ
// ─────────────────────────────────────────────────────────── bootstrap

/** Everything the app needs before it can draw a single pixel of real data. */
export function getBootstrap(signal?: AbortSignal): Promise<Bootstrap> {
  return request<Bootstrap>('/bootstrap', { signal })
}

// ─────────────────────────────────────────────────────────── campaigns

export function listCampaigns(signal?: AbortSignal): Promise<Campaign[]> {
  return getList<Campaign>('/campaigns', undefined, signal, 'campaigns')
}

export function getCampaign(id: string, signal?: AbortSignal): Promise<Campaign> {
  return request<Campaign>(`/campaigns/${encodeURIComponent(id)}`, { signal })
}

export type BoundaryCollection = FeatureCollection<
  { type: 'Polygon'; coordinates: [number, number][][] } | { type: 'MultiPolygon'; coordinates: [number, number][][][] },
  { name?: string }
>

export async function getCampaignBoundary(id: string, signal?: AbortSignal): Promise<BoundaryCollection> {
  const raw = await request<unknown>(`/campaigns/${encodeURIComponent(id)}/boundary`, { signal })
  return asFeatureCollection<never>(raw) as unknown as BoundaryCollection
}

// ───────────────────────────────────────────────────────────── segments

export interface SegmentsParams {
  measure?: MeasureCode
  metric?: SegmentMetric
  window?: StatWindow
  /**
   * Naive campaign time. Read ONLY by the computed windows (`trailing:<N>h`,
   * `todate`), which end here; omitted is the end of the data. The stored
   * windows ignore it, and `useSegments` never sends it for them, so their
   * keys are unchanged.
   */
  at?: string
  bbox?: BBox | null
  /** Default 0 for a stored window, 1 for a computed one (on the server). */
  min_passes?: number
  campaign_id?: string
  /** Cap the payload while panning. */
  limit?: number
}

/** A window built from `segment_pass` and bounded by `at`, not a `segment_stat` row. */
export function isComputedWindow(w: StatWindow | undefined): boolean {
  return w === 'todate' || (w ?? '').startsWith('trailing:')
}

/** The trailing length of each Network street window, in hours; `todate` has none. */
export const STREETS_WINDOW_HOURS: Record<StreetsWindow, number | null> = {
  '24h': 24,
  '7d': 168,
  todate: null,
}

/**
 * The `/segments` window that draws a Network street window: `trailing:24h`,
 * `trailing:168h` or `todate`. The same window `GET /regulator/network`
 * counts with (`streets=`), so the map and the counts are one set.
 */
export function streetsSegmentWindow(kind: StreetsWindow): StatWindow {
  const hours = STREETS_WINDOW_HOURS[kind]
  return hours == null ? 'todate' : `trailing:${hours}h`
}

/** THE flagship endpoint: the coloured road grid. */
export async function getSegments(
  params: SegmentsParams = {},
  signal?: AbortSignal,
): Promise<SegmentCollection> {
  const raw = await request<unknown>('/segments', {
    signal,
    params: {
      measure: params.measure,
      metric: params.metric,
      window: params.window,
      at: params.at,
      bbox: bboxParam(params.bbox),
      min_passes: params.min_passes,
      campaign_id: params.campaign_id,
      limit: params.limit,
    },
  })
  return asFeatureCollection<never>(raw) as unknown as SegmentCollection
}

/**
 * One street's detail. `at` (naive campaign time) bounds its passes, series
 * and 24-hour shape by the moment shown, so a replayed clock never plots a
 * pass after it; omitted is the end of the data. Same body either way.
 */
export function getSegmentDetail(id: string, at?: string, signal?: AbortSignal): Promise<SegmentDetail> {
  return request<SegmentDetail>(`/segments/${encodeURIComponent(id)}`, { signal, params: { at } })
}

// ────────────────────────────────────────────────────────────── monitors

export interface MonitorsParams {
  owner_type?: 'regulator' | 'industry' | 'community' | 'aclima'
  grade?: 'reference' | 'fem' | 'lowcost'
  site_id?: string
  campaign_id?: string
  /**
   * Upper bound, naive campaign time: `latest` is the last reading at or
   * before it. Without it every tower read its Aug 28 value at a June cursor.
   */
  at?: string
}

export function listMonitors(params: MonitorsParams = {}, signal?: AbortSignal): Promise<Monitor[]> {
  return getList<Monitor>('/monitors', { ...params }, signal, 'monitors')
}

export function getMonitor(id: string, at?: string, signal?: AbortSignal): Promise<Monitor> {
  return request<Monitor>(`/monitors/${encodeURIComponent(id)}`, { signal, params: { at } })
}

export interface MonitorReadingsParams {
  measure: MeasureCode
  from?: string
  to?: string
  interval?: 'hour' | 'day'
  /**
   * Rows at most; the server's default is 2,000, and it keeps the EARLIEST
   * rows. Ninety days of hours is ~2,160, so a long window without this loses
   * its last days, the ones nearest the moment shown. Capped at 20,000.
   */
  limit?: number
}

export function getMonitorReadings(
  id: string,
  params: MonitorReadingsParams,
  signal?: AbortSignal,
): Promise<MonitorReadings> {
  return request<MonitorReadings>(`/monitors/${encodeURIComponent(id)}/readings`, {
    signal,
    params: { ...params },
  })
}

// ─────────────────────────────────────────────────────── the upper bound
// `at` on /concerns, /clusters, /alerts, /feed and /stats/community is the
// moment on screen, as naive campaign time (core/clock). The server cuts at it
// BEFORE its LIMIT: filtered in the browser instead, the newest-N rows at Aug 12
// were all in the future and the list came back empty (docs/PLAN-refocus.md F2).
// Omitted, it means the server's now — the end of the data — so a paused-at-
// the-end session sends nothing and the two sides still agree.

// ────────────────────────────────────────────────────────────── concerns

export interface ConcernsParams {
  status?: ConcernStatus
  kind?: ConcernKind
  since?: string
  /** Upper bound, naive campaign time. See "the upper bound" above. */
  at?: string
  /** `near=lon,lat,radius_m` */
  near?: { lon: number; lat: number; radius_m?: number }
  cluster_id?: string
  campaign_id?: string
  limit?: number
}

export function listConcerns(params: ConcernsParams = {}, signal?: AbortSignal): Promise<Concern[]> {
  return getList<Concern>(
    '/concerns',
    {
      status: params.status,
      kind: params.kind,
      since: params.since,
      at: params.at,
      near: nearParam(params.near?.lon, params.near?.lat, params.near?.radius_m),
      cluster_id: params.cluster_id,
      campaign_id: params.campaign_id,
      limit: params.limit,
    },
    signal,
    'concerns',
  )
}

export function getConcern(id: string, signal?: AbortSignal): Promise<Concern> {
  return request<Concern>(`/concerns/${encodeURIComponent(id)}`, { signal })
}

export interface ClustersParams {
  campaign_id?: string
  /** Upper bound, naive campaign time: clusters that had formed by then. */
  at?: string
}

export function listClusters(params: ClustersParams = {}, signal?: AbortSignal): Promise<ConcernCluster[]> {
  return getList<ConcernCluster>(
    '/clusters',
    { campaign_id: params.campaign_id, at: params.at },
    signal,
    'clusters',
  )
}

// ───────────────────────────────────────────────────────────────── sites

export function listSites(campaignId?: string, signal?: AbortSignal): Promise<IndustrySite[]> {
  return getList<IndustrySite>('/sites', { campaign_id: campaignId }, signal, 'sites')
}

export function getSite(id: string, signal?: AbortSignal): Promise<IndustrySite> {
  return request<IndustrySite>(`/sites/${encodeURIComponent(id)}`, { signal })
}

export interface PostsParams {
  site_id?: string
  kind?: SitePost['kind']
  concern_id?: string
  limit?: number
}

export function listPosts(params: PostsParams = {}, signal?: AbortSignal): Promise<SitePost[]> {
  return getList<SitePost>('/posts', { ...params }, signal, 'posts')
}

// ──────────────────────────────────────────────────────────── advisories

export interface AdvisoriesParams {
  audience?: Role
  active?: boolean
  limit?: number
}

export function listAdvisories(params: AdvisoriesParams = {}, signal?: AbortSignal): Promise<Advisory[]> {
  return getList<Advisory>('/advisories', { ...params }, signal, 'advisories')
}

// ───────────────────────────────────────────────────────── the alert bus

export interface AlertsParams {
  role?: Role
  status?: AlertStatus
  severity?: Severity
  kind?: AlertKind
  /** Supplying this makes the API add `bearing_deg` + `distance_m` — the RWR geometry. */
  site_id?: string
  since?: string
  /** Upper bound, naive campaign time. The server marks `ongoing` as of it. */
  at?: string
  limit?: number
}

export function listAlerts(params: AlertsParams = {}, signal?: AbortSignal): Promise<Alert[]> {
  return getList<Alert>('/alerts', { ...params }, signal, 'alerts')
}

/**
 * Detail: adds `samples[]` for the sparkline plus related concerns/mitigations.
 * `at` bounds those as the list does: the related reports come back already
 * cut at the moment, because the server takes the nearest 40 BEFORE the
 * browser could drop the future ones (at Aug 12 that left none of the one
 * that existed).
 */
export function getAlert(id: string, siteId?: string, at?: string, signal?: AbortSignal): Promise<Alert> {
  return request<Alert>(`/alerts/${encodeURIComponent(id)}`, { signal, params: { site_id: siteId, at } })
}

export function listActionLevels(signal?: AbortSignal): Promise<ActionLevel[]> {
  return getList<ActionLevel>('/action-levels', undefined, signal, 'action_levels')
}

// ────────────────────────────────────────────────────────────────── feed

export interface FeedParams {
  role?: Role
  since?: string
  /** Upper bound, naive campaign time; reading items are built as of it. */
  at?: string
  limit?: number
  campaign_id?: string
}

/** Merged, time-sorted: concerns + advisories + site posts + mitigations. */
export function getFeed(params: FeedParams = {}, signal?: AbortSignal): Promise<FeedItem[]> {
  return getList<FeedItem>('/feed', { ...params }, signal, 'feed')
}

// ───────────────────────────────────────────────────────────────── fleet

export interface FleetParams {
  /** Naive campaign time — the session's `timeParam(time)`. */
  at?: string
  /** Community MUST pass ≥ 180 (CONTRACT §9.5). */
  delay_min?: number
  campaign_id?: string
}

export function getFleet(params: FleetParams = {}, signal?: AbortSignal): Promise<FleetPosition[]> {
  return getList<FleetPosition>('/fleet', { ...params }, signal, 'positions', 'vehicles', 'fleet')
}

export function listVehicles(signal?: AbortSignal): Promise<Vehicle[]> {
  return getList<Vehicle>('/vehicles', undefined, signal, 'vehicles')
}

export function getDrivePlan(campaignId?: string, signal?: AbortSignal): Promise<DrivePlan> {
  return request<DrivePlan>('/drive-plan', { signal, params: { campaign_id: campaignId } })
}

export function getDrivePlanCoverage(id: string, signal?: AbortSignal): Promise<CoverageCell[]> {
  return getList<CoverageCell>(
    `/drive-plan/${encodeURIComponent(id)}/coverage`,
    undefined,
    signal,
    'cells',
    'coverage',
  )
}

// ─────────────────────────────────────────────────────────────────── wind

export interface WindParams {
  from?: string
  to?: string
  campaign_id?: string
}

export function getWind(params: WindParams = {}, signal?: AbortSignal): Promise<WindPoint[]> {
  return getList<WindPoint>('/wind', { ...params }, signal, 'wind', 'points')
}

export interface DispersionParams {
  site_id?: string
  at?: string
  measure?: MeasureCode
  /**
   * Also return each site's outline parts and axis (`DispersionPlumeOutlined`),
   * for the regulator and industry maps' hairline style (CONTRACT §10b, F6).
   * Off by default, and sent only when true: without it the request — and the
   * server's response, which a test holds byte-identical — is what it always
   * was, so community's soft cloud and the gallery are untouched.
   */
  outline?: boolean
}

export function getDispersion(
  params: DispersionParams & { outline: true },
  signal?: AbortSignal,
): Promise<DispersionPlumeOutlined>
export function getDispersion(params?: DispersionParams, signal?: AbortSignal): Promise<DispersionPlume>
export async function getDispersion(
  params: DispersionParams = {},
  signal?: AbortSignal,
): Promise<DispersionPlume | DispersionPlumeOutlined> {
  // `outline: false` must not reach the wire as "false": the query string
  // writes every non-empty value, and the server would then have to agree
  // that the string "false" means off. Absent is off.
  const { outline, ...rest } = params
  const raw = await request<unknown>('/wind/dispersion', {
    signal,
    params: outline ? { ...rest, outline: 1 } : { ...rest },
  })
  return asFeatureCollection<never>(raw) as unknown as DispersionPlumeOutlined
}

/** A modelled band (no `kind`) — what the default response is made of. */
export function isBandFeature(f: DispersionFeature): f is DispersionBandFeature {
  return f.properties.kind == null
}

/** A plume's outer edge, inside or beyond the detection envelope. */
export function isOutlineFeature(f: DispersionFeature): f is DispersionOutlineFeature {
  return f.properties.kind === 'outline'
}

/** A plume's centreline, source to reach. */
export function isAxisFeature(f: DispersionFeature): f is DispersionAxisFeature {
  return f.properties.kind === 'axis'
}

// ──────────────────────────────────────────── observed wind (fleet anemometry)
// Aclima's vehicles measure wind, which is what lets an operator check the wind
// rose their consultant assumed (CONTRACT §5, "mobile wind").

export interface MobileWindParams {
  from?: string
  to?: string
  bbox?: BBox | null
  /** Anemometry from a moving platform is noisy — filter, never hide. */
  quality?: MobileWindObs['quality']
  campaign_id?: string
  limit?: number
}

/** Per-observation fleet anemometry, `quality` flag included. */
export function getMobileWind(
  params: MobileWindParams = {},
  signal?: AbortSignal,
): Promise<MobileWindObs[]> {
  return getList<MobileWindObs>(
    '/wind/mobile',
    {
      from: params.from,
      to: params.to,
      bbox: bboxParam(params.bbox),
      quality: params.quality,
      campaign_id: params.campaign_id,
      limit: params.limit,
    },
    signal,
    'obs',
    'wind',
  )
}

export interface WindFieldParams {
  from?: string
  to?: string
  /** Grid cell size in metres. */
  cell_m?: number
  campaign_id?: string
}

/** Binned OBSERVED wind field — feeds the particle overlay. */
export function getWindField(
  params: WindFieldParams = {},
  signal?: AbortSignal,
): Promise<WindField> {
  return request<WindField>('/wind/field', { signal, params: { ...params } })
}

/** The consultant's dispersion deliverables for a site, as issued. */
export function listDispersionModels(
  siteId: string,
  signal?: AbortSignal,
): Promise<DispersionModel[]> {
  return getList<DispersionModel>(
    `/sites/${encodeURIComponent(siteId)}/dispersion-models`,
    undefined,
    signal,
    'models',
  )
}

export interface ModelVerificationParams {
  model_id?: string
  from?: string
  to?: string
}

/** Assumed rose vs. what the fleet actually measured. The payoff screen. */
export function getModelVerification(
  siteId: string,
  params: ModelVerificationParams = {},
  signal?: AbortSignal,
): Promise<ModelVerification> {
  return request<ModelVerification>(
    `/sites/${encodeURIComponent(siteId)}/model-verification`,
    { signal, params: { ...params } },
  )
}

// ───────────────────────────────────────────────────────────── coverage

/** Where the fixed network stands relative to the modelled plume. */
export function getInterception(signal?: AbortSignal): Promise<Interception> {
  return request<Interception>('/coverage/interception', { signal })
}

/** Modelled plume-hours per street, and how many nothing was standing in. */
export function getResidency(signal?: AbortSignal): Promise<Residency> {
  return request<Residency>('/coverage/residency', { signal })
}

/** Streets carrying the most unobserved plume-hours. NOT a recommendation. */
export function getSiting(limit = 10, signal?: AbortSignal): Promise<Siting> {
  return request<Siting>('/coverage/siting', { signal, params: { limit } })
}

/**
 * Per-channel anchoring state as of `at`: an anchor's age is measured from the
 * moment on screen, and a calibration that has not happened yet has no age.
 */
export function getCalibration(at?: string, signal?: AbortSignal): Promise<Calibration> {
  return request<Calibration>('/coverage/calibration', { signal, params: { at } })
}

// ─────────────────────────────────────────────────── the regulator network

export interface RegulatorNetworkParams {
  /** Naive campaign time; omitted means the end of the data (the server's now). */
  at?: string
  /** Default `no2` on the server. */
  measure?: MeasureCode
  /**
   * The window every street figure uses, ending at `at` (F2): street-km,
   * each plume's streets driven inside, its share and the coverage floor.
   * Default `7d` on the server.
   */
  streets?: StreetsWindow
  campaign_id?: string
}

/**
 * The regulator's Network screen in one request: the headline, the three
 * numbers, each reference monitor's reading and level as of `at`, each site's
 * modelled plume and what its outline touches, and the resident clusters —
 * every "inside" computed from the outline `/wind/dispersion?outline=1` draws.
 * Every street figure is over `streets_window`, which ends at `at` and names
 * the latest pass before it (`last_pass_at`) for the empty-window copy.
 */
export function getRegulatorNetwork(
  params: RegulatorNetworkParams = {},
  signal?: AbortSignal,
): Promise<RegulatorNetwork> {
  return request<RegulatorNetwork>('/regulator/network', { signal, params: { ...params } })
}

// ──────────────────────────────────────────────────────────── climatology

/**
 * How often the wind carries from each site over each neighbourhood, over the
 * whole campaign. Omit `site_id` for every site, which is what a resident
 * needs: their own district, and each of the places on the map, in one answer.
 */
export function getClimatology(
  params: { site_id?: string; from?: string; to?: string } = {},
  signal?: AbortSignal,
): Promise<WindClimatology> {
  return request<WindClimatology>('/wind/climatology', { signal, params: { ...params } })
}

// ─────────────────────────────────────────────────────────── mission brief

/**
 * The Mission Brief — the whole 07:00 screen in one request. `date` picks the
 * day; omit it for the last day with data. Read-only over the datagen plan.
 */
export function getMissionBrief(
  params: { date?: string; site_id?: string } = {},
  signal?: AbortSignal,
): Promise<MissionBrief> {
  return request<MissionBrief>('/admin/brief', { signal, params: { ...params } })
}

// ─────────────────────────────────────────────────────────────── envelope

/**
 * How hard this site can run, measured. The industry tier's spine.
 *
 * 400s with `measure_not_calibrated` for a measure with no decoy-null
 * calibration — an excess served without one could not be told apart from an
 * arbitrary patch of road.
 */
export function getEnvelope(
  siteId: string,
  params: { measure?: MeasureCode } = {},
  signal?: AbortSignal,
): Promise<EnvelopeT> {
  return request<EnvelopeT>(
    `/sites/${encodeURIComponent(siteId)}/envelope`,
    { signal, params: { ...params } },
  )
}

// ────────────────────────────────────────────────────────── touchdown (§10)

export interface TouchdownParams {
  measure?: MeasureCode
  from?: string
  to?: string
  /** Pasquill classes to condition on. Default 'EF' — stable air. */
  regime?: string
  r_lo_m?: number
  r_hi_m?: number
}

/**
 * The MEASURED plume. `getDispersion` is the model; never draw them alike.
 *
 * 400s with `measure_not_calibrated` for a measure with no detection floor —
 * an excess served without a null calibration could not be told from noise,
 * which is the one thing phase 2 says never to do.
 */
export function getTouchdown(
  siteId: string,
  params: TouchdownParams = {},
  signal?: AbortSignal,
): Promise<Touchdown> {
  return request<Touchdown>(
    `/sites/${encodeURIComponent(siteId)}/touchdown`,
    { signal, params: { ...params } },
  )
}

/** Where a car has actually been. `cell_m` is the cell SIDE, not a radius. */
export function getCoverage(
  campaignId = 'current',
  params: { cell_m?: number } = {},
  signal?: AbortSignal,
): Promise<CoverageMask> {
  return request<CoverageMask>(
    `/campaigns/${encodeURIComponent(campaignId)}/coverage`,
    { signal, params: { ...params } },
  )
}

// ────────────────────────────────────────────────────────────────── stats

export interface CommunityStatsParams {
  window?: StatWindow
  campaign_id?: string
  /** Upper bound, naive campaign time: report counts as of that moment. */
  at?: string
}

export function getCommunityStats(
  params: CommunityStatsParams = {},
  signal?: AbortSignal,
): Promise<CommunityStats> {
  return request<CommunityStats>('/stats/community', { signal, params: { ...params } })
}

export function getCampaignStats(campaignId?: string, signal?: AbortSignal): Promise<CampaignStats> {
  return request<CampaignStats>('/stats/campaign', { signal, params: { campaign_id: campaignId } })
}

export function getActivity(
  params: { since?: string; limit?: number; role?: Role } = {},
  signal?: AbortSignal,
): Promise<ActivityItem[]> {
  return getList<ActivityItem>('/activity', { ...params }, signal, 'activity')
}

// ══════════════════════════════════════════════════════════════════ WRITE
// Every write appends to `activity` and publishes on the SSE stream, which is
// how an action here becomes visible over there.

export interface CreateConcernBody {
  kind: ConcernKind
  severity: 1 | 2 | 3 | 4 | 5
  title: string
  body?: string
  lon: number
  lat: number
  occurred_at?: string
  is_anonymous?: boolean
  address_hint?: string
  photo_emoji?: string
  author_id?: string
  campaign_id?: string
}

export function createConcern(body: CreateConcernBody): Promise<Concern> {
  return request<Concern>('/concerns', { method: 'POST', body })
}

export function corroborateConcern(id: string, userId?: string): Promise<Concern> {
  return request<Concern>(`/concerns/${encodeURIComponent(id)}/corroborate`, {
    method: 'POST',
    body: { user_id: userId },
  })
}

export interface CreateConcernResponseBody {
  role: Role
  kind: ConcernResponse['kind']
  body: string
  author_id?: string
  org_id?: string
}

export function createConcernResponse(
  concernId: string,
  body: CreateConcernResponseBody,
): Promise<ConcernResponse> {
  return request<ConcernResponse>(`/concerns/${encodeURIComponent(concernId)}/responses`, {
    method: 'POST',
    body,
  })
}

/**
 * Regulator / admin only. Industry may NOT send `'resolved'` (CONTRACT §9.4) —
 * the client refuses before the request so the rule is visible in the UI.
 */
export function updateConcernStatus(
  id: string,
  status: ConcernStatus,
  actorRole?: Role,
): Promise<Concern> {
  if (actorRole === 'industry' && (status === 'resolved' || status === 'closed')) {
    return Promise.reject(
      new ApiError('Industry cannot close a community concern — propose a mitigation instead.', 403, `${API_BASE}/concerns/${id}`),
    )
  }
  return request<Concern>(`/concerns/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } })
}

export interface CreatePostBody {
  site_id: string
  kind: SitePost['kind']
  title: string
  body: string
  concern_id?: string
  media_emoji?: string
  author_id?: string
  pinned?: boolean
}

export function createPost(body: CreatePostBody): Promise<SitePost> {
  return request<SitePost>('/posts', { method: 'POST', body })
}

export interface CreateMitigationBody {
  site_id: string
  title: string
  body?: string
  concern_id?: string
  alert_id?: string
  cluster_id?: string
  measure?: MeasureCode
  expected_reduction_pct?: number
}

export function createMitigation(body: CreateMitigationBody): Promise<Mitigation> {
  return request<Mitigation>('/mitigations', { method: 'POST', body })
}

export interface CreateAdvisoryBody {
  kind: Advisory['kind']
  severity: Severity
  title: string
  body: string
  measure?: MeasureCode
  alert_id?: string
  audience: Role[]
  expires_at?: string
  author_id?: string
  pinned?: boolean
}

export function createAdvisory(body: CreateAdvisoryBody): Promise<Advisory> {
  return request<Advisory>('/advisories', { method: 'POST', body })
}

export function acknowledgeAlert(id: string, note?: string, userId?: string): Promise<Alert> {
  return request<Alert>(`/alerts/${encodeURIComponent(id)}/acknowledge`, {
    method: 'POST',
    body: { note: note ?? null, user_id: userId },
  })
}

export interface ActionLevelBody {
  measure: MeasureCode
  label: string
  kind: ActionLevelKind
  threshold: number
  unit: string
  averaging_hours: number
  severity: Severity
  enabled: boolean
  source?: string | null
  notify_community: boolean
  notify_industry: boolean
}

/** Full row. Re-evaluates alerts immediately — this is loop #2. */
export function updateActionLevel(id: string, body: ActionLevelBody): Promise<ActionLevel> {
  return request<ActionLevel>(`/action-levels/${encodeURIComponent(id)}`, { method: 'PUT', body })
}

export function createActionLevel(body: ActionLevelBody): Promise<ActionLevel> {
  return request<ActionLevel>('/action-levels', { method: 'POST', body })
}

export interface AdvisorBody {
  alert_id?: string
  question?: string
  site_id?: string
}

/** The industry "what do I do about it" recommendation. */
export function askAdvisor(body: AdvisorBody): Promise<AdvisorReply> {
  return request<AdvisorReply>('/advisor', { method: 'POST', body })
}

// ─────────────────────────────────────────────────────────────────── admin

export interface DrivePlanBody {
  fleet_size: number
  target_passes: number
  shift_hours: number
  seed?: number
}

export function regenerateDrivePlan(campaignId: string, body: DrivePlanBody): Promise<DrivePlan> {
  return request<DrivePlan>(`/admin/campaigns/${encodeURIComponent(campaignId)}/drive-plan`, {
    method: 'POST',
    body,
    timeoutMs: 120_000,
  })
}

export interface ReseedResult {
  ok: boolean
  seed?: number
  message?: string
}

export function reseed(seed?: number): Promise<ReseedResult> {
  return request<ReseedResult>('/admin/reseed', { method: 'POST', body: { seed }, timeoutMs: 300_000 })
}

export interface SimulateResult {
  ok: boolean
  scenario: SimScenario
  /** What the scenario produced, so the Director panel can narrate it. */
  alerts?: Alert[]
  concerns?: Concern[]
  advisories?: Advisory[]
  message?: string
}

/** Fire a scripted demo event (CONTRACT §8). The whole point of the Director. */
export function simulate(scenario: SimScenario): Promise<SimulateResult> {
  return request<SimulateResult>('/admin/simulate', { method: 'POST', body: { scenario }, timeoutMs: 60_000 })
}

/** Cheap liveness probe — used by the shell to show "backend offline". */
export async function ping(signal?: AbortSignal): Promise<boolean> {
  try {
    await request<unknown>('/bootstrap', { signal, timeoutMs: 4000 })
    return true
  } catch {
    return false
  }
}
