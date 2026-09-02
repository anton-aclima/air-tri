/**
 * air — shared wire types.
 *
 * Mirrors `src/air/db/schema.sql` and the API contract in `docs/CONTRACT.md` §5.
 * Owned by the orchestrator. Every frontend agent imports from here; nobody
 * redefines these locally. If a field is missing, report it — don't fork.
 */

// ───────────────────────────────────────────────────────────── enums

export type Role = 'community' | 'regulator' | 'industry' | 'admin';

export type ModalityCode = 'no2' | 'pm25' | 'bc' | 'o3' | 'co' | 'co2' | 'ch4';
export type IndicatorCode = 'methane_leak' | 'diesel' | 'nondiesel';
/**
 * A derived index — computed from other measures, carried by no instrument.
 * Kept as its own alternative rather than folded into `ModalityCode` so that
 * every `family` check has to name it explicitly: a composite is not a species,
 * cannot be a monitor channel, cannot carry an action level, and must never be
 * painted on an auto-stretched colour domain.
 */
export type CompositeCode = 'aclima_sense';
export type MeasureCode = ModalityCode | IndicatorCode | CompositeCode;

export type Severity = 'info' | 'watch' | 'warning' | 'critical';
export type MonitorGrade = 'reference' | 'fem' | 'lowcost';
export type MonitorStatus = 'online' | 'degraded' | 'offline' | 'maintenance';
export type OwnerType = 'regulator' | 'industry' | 'community' | 'aclima';

export type ConcernKind =
  | 'smell' | 'noise' | 'smoke' | 'dust'
  | 'health' | 'light' | 'traffic' | 'vibration' | 'other';

export type ConcernStatus =
  | 'new' | 'corroborated' | 'under_review'
  | 'mitigation_proposed' | 'resolved' | 'closed';

export type AlertKind =
  | 'exceedance' | 'integrated_exposure' | 'concern_cluster'
  | 'mobile_detection' | 'fleet_anomaly' | 'regulatory_notice' | 'wind_shift';

export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'expired';
export type AlertSourceType = 'monitor' | 'mobile' | 'community' | 'regulator' | 'model';

export type SiteKind = 'datacenter' | 'logistics' | 'manufacturing' | 'power' | 'other';
export type SiteStatus = 'operating' | 'construction' | 'permitting' | 'proposed';

export type EmissionPointKind =
  | 'generator' | 'cooling_tower' | 'backup' | 'stack' | 'traffic_gate' | 'substation';

export type VehicleStatus = 'driving' | 'idle' | 'charging' | 'maintenance' | 'offline';
export type ActionLevelKind = 'spike' | 'integrated';

/** `segment_stat.window` — 'all' | 'date:YYYY-MM-DD' | 'hour:HH' | 'week:YYYY-Www' */
export type StatWindow = string;

/** Which number the road grid is painted by. */
export type SegmentMetric = 'median' | 'p90' | 'max' | 'persistence' | 'risk';

// ───────────────────────────────────────────────────────────── geo

export type Lon = number;
export type Lat = number;
export type Position = [Lon, Lat];
export type BBox = [number, number, number, number]; // w, s, e, n

export interface Feature<G = GeoGeometry, P = Record<string, unknown>> {
  type: 'Feature';
  id?: string | number;
  geometry: G;
  properties: P;
}
export interface FeatureCollection<G = GeoGeometry, P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: Feature<G, P>[];
}
export type GeoGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

// ───────────────────────────────────────────────────────────── identity

export interface Org {
  id: string;
  name: string;
  short_name: string | null;
  kind: 'agency' | 'company' | 'cbo' | 'aclima';
  brand_color: string | null;
  logo_emoji: string | null;
  blurb: string | null;
  website: string | null;
}

export interface User {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  org_id: string | null;
  title: string | null;
  avatar_emoji: string | null;
  avatar_color: string | null;
  neighborhood: string | null;
  joined_at: string | null;
}

/** Everything the UI needs to render a number: label, unit, ramp, breakpoints. */
export interface MeasureDef {
  code: MeasureCode;
  label: string;
  short_label: string;
  unit: string;
  family: 'modality' | 'indicator' | 'composite';
  ref_level: number | null;
  healthy_max: number | null;
  /** [[concentration, risk0_100], ...] — piecewise-linear, community risk scores. */
  scale: [number, number][];
  ramp: string[];
  decimals: number;
  sort_order: number;
  description: string | null;
  /** Community-facing plain language, e.g. "traffic exhaust". Never show `label` to residents. */
  plain_name: string | null;
}

// ───────────────────────────────────────────────────────────── campaign & segments

export interface Campaign {
  id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  region: string | null;
  state: string | null;
  center: Position;
  default_zoom: number;
  bbox: BBox;
  start_date: string;
  end_date: string;
  status: 'draft' | 'planning' | 'active' | 'complete';
  fleet_size: number;
  target_passes: number;
  timezone: string;
  created_at: string;
}

/** Properties on each LineString feature from `GET /segments`. */
export interface SegmentProps {
  id: string;
  name: string | null;
  road_class: string;
  district: string | null;
  /** The requested `metric`, already resolved. This is what you colour by. */
  value: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
  persistence: number | null;
  risk: number | null;
  n_passes: number;
  length_m: number;
}
export type SegmentCollection = FeatureCollection<
  { type: 'LineString'; coordinates: Position[] },
  SegmentProps
>;

export interface SeriesPoint { t: string; v: number | null }

export interface SegmentDetail {
  id: string;
  name: string | null;
  road_class: string;
  district: string | null;
  geometry: Position[];
  length_m: number;
  mid: Position;
  n_passes: number;
  first_pass: string | null;
  last_pass: string | null;
  stats: Record<MeasureCode, {
    median: number; p10: number; p90: number; max: number;
    persistence: number; risk: number; n_passes: number;
  }>;
  /** window='date:*' */
  daily: Record<MeasureCode, SeriesPoint[]>;
  /** window='hour:HH' — the diurnal fingerprint, 24 points. */
  diurnal: Record<MeasureCode, SeriesPoint[]>;
  /** Percentile of this segment vs the whole campaign, per measure. 0–100. */
  rank_pct: Record<MeasureCode, number>;
  nearest_site: { id: string; name: string; distance_m: number; bearing_deg: number } | null;
}

// ───────────────────────────────────────────────────────────── stationary network

export interface Monitor {
  id: string;
  name: string;
  code: string | null;
  owner_type: OwnerType;
  org_id: string | null;
  site_id: string | null;
  lon: Lon; lat: Lat;
  grade: MonitorGrade;
  status: MonitorStatus;
  measures: MeasureCode[];
  radius_m: number | null;
  install_date: string | null;
  last_calibrated: string | null;
  blurb: string | null;
  /** Most recent value per measure, for map labels without a second request. */
  latest: Partial<Record<MeasureCode, { value: number; ts: string; exceeds: boolean }>>;
}

export interface MonitorReadings {
  monitor_id: string;
  measure: MeasureCode;
  unit: string;
  interval: 'hour' | 'day';
  points: SeriesPoint[];
  action_levels: { id: string; label: string; threshold: number; severity: Severity }[];
}

// ───────────────────────────────────────────────────────────── regulator

export interface ActionLevel {
  id: string;
  measure: MeasureCode;
  label: string;
  kind: ActionLevelKind;
  threshold: number;
  unit: string;
  averaging_hours: number;
  severity: Severity;
  enabled: boolean;
  source: string | null;
  notify_community: boolean;
  notify_industry: boolean;
  updated_at: string | null;
}

export interface Advisory {
  id: string;
  org_id: string | null;
  author_id: string | null;
  kind: 'advisory' | 'warning' | 'notice' | 'all_clear' | 'update';
  severity: Severity;
  title: string;
  body: string;
  measure: MeasureCode | null;
  alert_id: string | null;
  audience: Role[];
  created_at: string;
  expires_at: string | null;
  pinned: boolean;
}

export interface EnforcementAction {
  id: string;
  site_id: string | null;
  org_id: string | null;
  kind: 'inquiry' | 'request_for_info' | 'notice_of_violation' | 'stipulation' | 'site_visit';
  status: 'open' | 'responded' | 'closed' | 'escalated';
  title: string;
  body: string | null;
  alert_id: string | null;
  created_at: string;
  due_at: string | null;
  closed_at: string | null;
}

// ───────────────────────────────────────────────────────────── community

export interface Concern {
  id: string;
  author: Pick<User, 'id' | 'name' | 'avatar_emoji' | 'avatar_color' | 'neighborhood'> | null;
  kind: ConcernKind;
  severity: 1 | 2 | 3 | 4 | 5;
  title: string;
  body: string | null;
  lon: Lon; lat: Lat;
  address_hint: string | null;
  district: string | null;
  occurred_at: string;
  created_at: string;
  status: ConcernStatus;
  cluster_id: string | null;
  corroborations: number;
  is_anonymous: boolean;
  photo_emoji: string | null;
  suspected_site_id: string | null;
  responses: ConcernResponse[];
}

export interface ConcernResponse {
  id: string;
  concern_id: string;
  author_id: string | null;
  org_id: string | null;
  org_name: string | null;
  role: Role;
  kind: 'acknowledge' | 'mitigation' | 'finding' | 'advisory' | 'comment';
  body: string;
  created_at: string;
}

export interface ConcernCluster {
  id: string;
  label: string | null;
  centroid: Position;
  radius_m: number;
  count: number;
  kinds: ConcernKind[];
  first_at: string;
  last_at: string;
  status: string;
  site_id: string | null;
}

// ───────────────────────────────────────────────────────────── industry

export interface IndustrySite {
  id: string;
  org_id: string | null;
  name: string;
  kind: SiteKind;
  footprint: GeoGeometry;
  centroid: Position;
  claimed_by_user_id: string | null;
  claimed_at: string | null;
  status: SiteStatus;
  capacity_mw: number | null;
  it_load_mw: number | null;
  generator_count: number | null;
  generator_fuel: string | null;
  operating_since: string | null;
  blurb: string | null;
  brand_color: string | null;
  logo_emoji: string | null;
  website: string | null;
  /** 0–100: how much of this site's "community & regulatory safe" envelope is used. */
  headroom_pct: number | null;
  emission_points: EmissionPoint[];
}

export interface EmissionPoint {
  id: string;
  site_id: string;
  name: string;
  kind: EmissionPointKind;
  lon: Lon; lat: Lat;
  height_m: number | null;
  active: boolean;
  measures: MeasureCode[];
}

export interface SitePost {
  id: string;
  site_id: string | null;
  org_id: string | null;
  org_name: string | null;
  brand_color: string | null;
  logo_emoji: string | null;
  author_id: string | null;
  kind: 'update' | 'mitigation' | 'event' | 'response' | 'intro';
  title: string;
  body: string;
  concern_id: string | null;
  media_emoji: string | null;
  pinned: boolean;
  created_at: string;
}

export interface Mitigation {
  id: string;
  site_id: string;
  concern_id: string | null;
  cluster_id: string | null;
  alert_id: string | null;
  title: string;
  body: string | null;
  status: 'proposed' | 'in_progress' | 'completed' | 'withdrawn';
  measure: MeasureCode | null;
  expected_reduction_pct: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

// ───────────────────────────────────────────────────────────── shared alert bus

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: Severity;
  measure: MeasureCode | null;
  value: number | null;
  threshold: number | null;
  unit: string | null;
  source_type: AlertSourceType;
  source_id: string | null;
  lon: Lon | null; lat: Lat | null;
  site_id: string | null;
  action_level_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: AlertStatus;
  title: string;
  body: string | null;
  recommendation: string | null;
  audience: Role[];
  created_at: string;
  /** Populated only when the request supplied `site_id` — this is the RWR geometry. */
  bearing_deg?: number;
  distance_m?: number;
  /** Populated by GET /alerts/{id}. */
  samples?: SeriesPoint[];
  concerns?: Concern[];
  mitigations?: Mitigation[];
  acknowledged_by?: { user_id: string; name: string; note: string | null; created_at: string }[];
}

// ───────────────────────────────────────────────────────────── fleet

export interface Vehicle {
  id: string;
  label: string;
  call_sign: string | null;
  model: string | null;
  powertrain: 'ev' | 'phev' | 'hybrid' | null;
  status: VehicleStatus;
  operator_name: string | null;
  measures: MeasureCode[];
}

export interface FleetPosition {
  vehicle_id: string;
  label: string;
  call_sign: string | null;
  status: VehicleStatus;
  lon: Lon; lat: Lat;
  heading_deg: number | null;
  speed_kph: number | null;
  segment_id: string | null;
  ts: string;
  /** Minutes of deliberate lag applied for this audience (community ≥180). */
  delay_min: number;
  /** Recent breadcrumb trail, newest last. */
  trail: Position[];
}

export interface DrivePlan {
  id: string;
  campaign_id: string;
  name: string;
  fleet_size: number;
  target_passes: number;
  status: 'draft' | 'active' | 'archived';
  params: Record<string, number | string>;
  stats: {
    total_segments: number;
    total_km: number;
    days_to_target: number;
    km_per_vehicle_day: number;
    coverage_pct: number;
    mean_passes: number;
    segments_below_target: number;
  };
  created_at: string;
  routes: DriveRoute[];
}

export interface DriveRoute {
  id: string;
  vehicle_id: string | null;
  day_index: number;
  date: string | null;
  shift: 'morning' | 'midday' | 'evening' | 'night' | null;
  segment_ids: string[];
  geometry: Position[];
  distance_m: number;
  duration_min: number;
  est_passes: number;
}

export interface CoverageCell {
  segment_id: string;
  passes: number;
  target: number;
  pct: number;
}

// ───────────────────────────────────────────────────────────── environment

export interface WindPoint {
  ts: string;
  speed_ms: number;
  /** Meteorological convention: the direction the wind blows FROM. */
  dir_deg: number;
  gust_ms: number | null;
  temp_c: number | null;
  rh: number | null;
  pbl_m: number | null;
  stability: string | null;
}

/**
 * Wind measured by the fleet's anemometers — observed, not modelled. Aclima's
 * vehicles measure wind, which is what makes the industry "verify your consultant's
 * dispersion model" story possible.
 */
export interface MobileWindObs {
  id: number;
  ts: string;
  lon: Lon; lat: Lat;
  segment_id: string | null;
  vehicle_id: string | null;
  speed_ms: number;
  /** Meteorological convention: the direction the wind blows FROM. */
  dir_deg: number;
  gust_ms: number | null;
  vehicle_speed_kph: number | null;
  quality: 'good' | 'suspect' | 'rejected';
}

/** Binned observed wind field for the RWR overlay — one cell per grid square. */
export interface WindFieldCell {
  lon: Lon; lat: Lat;
  speed_ms: number;
  dir_deg: number;
  /** Number of mobile observations behind this cell. Low n = don't over-claim. */
  n: number;
  /** Circular standard deviation of direction, degrees. High = unsteady. */
  dir_sd: number;
}

export interface WindField {
  cells: WindFieldCell[];
  cell_size_m: number;
  from: string;
  to: string;
  n_obs: number;
  source: 'mobile' | 'model' | 'blended';
}

/** A consultant's dispersion deliverable, as issued. */
export interface DispersionModel {
  id: string;
  site_id: string;
  name: string;
  vendor: string | null;
  method: string | null;
  measure: MeasureCode;
  averaging_hours: number;
  issued_at: string | null;
  /** The rose the consultant assumed. `freq` is a PERCENTAGE, 0-100. */
  assumed_wind: { dir_deg: number; freq: number; mean_speed_ms: number }[];
  notes: string | null;
  contours: { band: number; level: number; geometry: GeoGeometry }[];
}

/**
 * The payoff: what the consultant assumed vs. what our fleet actually measured.
 * This is the industry interface's single most valuable screen.
 */
export interface ModelVerification {
  site_id: string;
  model: DispersionModel;
  /**
   * Observed wind rose from mobile anemometers over the comparison window.
   * `freq` is a PERCENTAGE, 0-100 — same scale as `DispersionModel.assumed_wind.freq`.
   */
  observed_wind: { dir_deg: number; freq: number; mean_speed_ms: number }[];
  /**
   * Per-direction disagreement. `assumed_freq`/`observed_freq` are percentages (0-100)
   * and `delta` is their difference in PERCENTAGE POINTS — not a fraction.
   * Note `disagreement` below is on a 0-1 scale instead; don't mix them.
   */
  bearing_bias: { dir_deg: number; assumed_freq: number; observed_freq: number; delta: number }[];
  /** Bearings where the model materially understates transport toward receptors. */
  understated_bearings: number[];
  /**
   * Share of observed hours the model's contour would have mispredicted. 0-1 FRACTION
   * (multiply by 100 to display) — deliberately a different scale from the `freq`
   * percentages above, because it answers a different question.
   */
  disagreement: number;
  /** Populated receptors (neighbourhoods) the model under-weights. Percentages, 0-100. */
  affected_districts: { district: string; assumed_freq: number; observed_freq: number }[];
  verdict: 'consistent' | 'understates' | 'overstates' | 'insufficient_data';
  summary: string;
  n_obs: number;
}

export type DispersionPlume = FeatureCollection<
  { type: 'Polygon'; coordinates: Position[][] },
  { site_id: string; measure: MeasureCode; level: number; band: number; ts: string }
>;

// ───────────────────────────────────────────────────────────── aggregates

export interface CommunityStats {
  window: StatWindow;
  /** 0–100 headline. Never show a unit next to this. */
  overall_risk: number;
  overall_label: string;
  trend_pct: number;
  by_measure: {
    measure: MeasureCode;
    plain_name: string;
    risk: number;
    label: string;
    trend_pct: number;
    /** Share of the community's road-km above the reference level. */
    persistence: number;
  }[];
  worst_streets: { segment_id: string; name: string; risk: number; district: string | null }[];
  best_streets: { segment_id: string; name: string; risk: number; district: string | null }[];
  concern_count_7d: number;
  advisory_count_active: number;
  monitored_km: number;
  passes_total: number;
}

export interface CampaignStats {
  segments: number;
  segments_at_target: number;
  mean_passes: number;
  passes_total: number;
  km_driven: number;
  vehicles_active: number;
  concerns_total: number;
  concerns_open: number;
  alerts_active: number;
  sites: number;
  monitors_online: number;
  monitors_total: number;
  data_freshness_min: number;
  by_day: { date: string; passes: number; km: number; concerns: number }[];
}

// ───────────────────────────────────────────────────────────── feed & activity

export type FeedItem =
  | { type: 'concern';   at: string; concern: Concern }
  | { type: 'advisory';  at: string; advisory: Advisory }
  | { type: 'post';      at: string; post: SitePost }
  | { type: 'mitigation';at: string; mitigation: Mitigation; site: IndustrySite | null }
  | { type: 'reading';   at: string; monitor: Monitor; measure: MeasureCode; value: number; exceeds: boolean };

export interface ActivityItem {
  id: number;
  ts: string;
  actor_role: Role | null;
  actor_id: string | null;
  verb: string;
  object_type: string | null;
  object_id: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
}

// ───────────────────────────────────────────────────────────── advisor (industry)

export interface AdvisorReply {
  recommendation: string;
  actions: { label: string; detail: string; impact: string | null }[];
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
  source: 'rules' | 'llm';
}

// ───────────────────────────────────────────────────────────── bootstrap

export interface Bootstrap {
  campaign: Campaign;
  measures: MeasureDef[];
  orgs: Org[];
  users: User[];
  action_levels: ActionLevel[];
  sites: IndustrySite[];
  flags: {
    advisor_mode: 'rules' | 'llm';
    basemap: 'google' | 'maplibre';
    community_fleet_delay_min: number;
    simulated: true;
    now: string;
    /** When the dataset was generated — the instant all of its data stops. */
    generated_at: string | null;
  };
}

export type SimScenario =
  | 'generator_test' | 'concern_wave' | 'wind_shift' | 'methane_leak' | 'all_clear';
