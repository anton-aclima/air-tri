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

/**
 * `GET /segments?window=`. STORED windows are `segment_stat` rows — 'all' |
 * 'date:YYYY-MM-DD' | 'hour:HH' | 'week:YYYY-Www' — and ignore `at`. COMPUTED
 * windows are built from `segment_pass` and are bounded by `at`:
 * 'trailing:<N>h' (passes with at − N h < ts ≤ at) and 'todate' (ts ≤ at).
 */
export type StatWindow = string;

/**
 * The regulator Network's street window (F2): the last 24 hours, the last 7
 * days, or the whole record — each ENDING at the moment shown. The map's
 * coloured streets and every street figure on the screen use this one window.
 */
export type StreetsWindow = '24h' | '7d' | 'todate';

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
/**
 * `window` on a COMPUTED `/segments` body (`window=trailing:<N>h|todate&at=`):
 * the set these streets were cut from, as the server applied it. The one
 * moment a map built on this grid names — its legend, its tooltips, its empty
 * line — so the words can never describe a different window than the colours.
 */
export interface SegmentWindow {
  /** The window asked for, as sent: `trailing:168h`, `todate`. */
  name: string;
  /** Passes AFTER this count (to − hours); null for `todate`. Naive campaign time. */
  from: string | null;
  /** The moment the window ends at — `at`, or the end of the data. */
  to: string;
  /** The latest pass at or before `to` with this pollutant valid; null before the first. */
  last_pass_at: string | null;
}

export type SegmentCollection = FeatureCollection<
  { type: 'LineString'; coordinates: Position[] },
  SegmentProps
> & {
  /** Present on a computed window only; a stored window's body has none. */
  window?: SegmentWindow;
};

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
  /**
   * What the end of the data will show, on a report served with an `at`
   * before the end (server/loaders.py load_concerns); absent at the end,
   * where `status` already is it. Replay reads it to know whether "go to the
   * end" to mark the report leads anywhere.
   */
  status_at_end?: ConcernStatus;
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
  /** When the last member was NOTICED (occurred_at) — hours before it was posted. */
  last_at: string;
  /**
   * When the last member was POSTED (max created_at). The moment the cluster,
   * as counted here, existed on the server — what a timeline jump must land on.
   */
  last_posted_at?: string | null;
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
  /**
   * The status as it stood at the request's `at` (server/statusat.py), walked
   * back from the stored one; exactly the stored one at the end of the data.
   * What cannot be rebuilt (when an alert resolved or expired) is listed there.
   */
  status: AlertStatus;
  title: string;
  body: string | null;
  recommendation: string | null;
  audience: Role[];
  created_at: string;
  /**
   * Begun and not ended at the request's `at` (the end of the data when none
   * was sent), computed by the server. The same test as `isOngoing` in
   * core/events, which is the one to use when the moment on screen may have
   * moved since the fetch. `status` cannot answer this: it says where the
   * workflow stood, not whether the event was still running.
   */
  ongoing?: boolean;
  /**
   * The stored status at the end of the data, sent beside `status` only on an
   * alert served with an `at` before the end. ABSENT when paused at the end
   * (there `status` is the stored one). For "how it turned out", never for
   * anything counted at the moment shown.
   */
  status_at_end?: AlertStatus;
  /** `ongoing` at the end of the data; present and absent exactly as `status_at_end`. */
  ongoing_at_end?: boolean;
  /** Populated only when the request supplied `site_id` — this is the RWR geometry. */
  bearing_deg?: number;
  distance_m?: number;
  /** Populated by GET /alerts/{id}. */
  samples?: SeriesPoint[];
  concerns?: Concern[];
  mitigations?: Mitigation[];
  acknowledged_by?: { user_id: string; name: string; note: string | null; created_at: string }[];
  /**
   * Detail only (`GET /alerts/{id}?at`): the alert had not begun by the moment
   * asked about. Served 200 with this flag rather than 404, so a page opened in
   * replay can say "not raised yet" instead of "not found".
   */
  not_started?: boolean
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
  /**
   * Whose model this is. `permit` is the study the operator filed — a legal
   * object that says what the site was permitted on, not what the air did.
   * `aclima` is the same kernel driven by the wind our fleet measured.
   *
   * One axis, and only this one: the word "tier" was used for four different
   * things during design (model provenance, forecast horizon, entitlement,
   * confidence). A forecast horizon gets its own column when phase 8 needs it.
   */
  model_tier: 'permit' | 'aclima';
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

/**
 * `GET /wind/dispersion` — the MODELLED plume, one polygon per (site, band).
 *
 * Everything here is a model. Nothing here has been observed, and per CONTRACT
 * §10b it is drawn as an outline, never as the filled thing on the map.
 * `beyond_envelope` is the register switch: past the detection envelope the
 * band renders dashed with no fill and the legend says so.
 */
export interface DispersionProps {
  site_id: string;
  measure: MeasureCode;
  /** Contour value as a fraction of this site's peak ground concentration, 0–1. */
  level: number;
  /** 0 = brightest. Bands are contours of the profile, not radial slices. */
  band: number;
  ts: string;
  n_sources: number;

  /** Metres downwind of the site, along the transport axis. */
  x_onset_m: number;
  x_peak_m: number;
  x_reach_m: number;
  /** Alias of `x_reach_m`, kept because callers ask "how far does it go". */
  reach_m: number;
  /** `x_reach_m` is a clip at the kernel's maximum, not a real crossing. */
  truncated: boolean;

  /**
   * The elevated-source story, separate from the site numbers above because it
   * answers a different question. A site's combined profile peaks at the fence
   * whenever it has any ground-level release, so "where does the stack's plume
   * come down" has to be asked of the stacks alone.
   *
   * `lofted: false` with `n_elevated: 0` is the ordinary daytime answer — the
   * plume mixes to the ground at the fence — not a missing value.
   */
  lofted: boolean;
  n_elevated: number;
  elevated_touchdown_m: number | null;
  elevated_peak_m: number | null;

  /** Past here nothing has been measured: dash it, do not fill it. */
  beyond_envelope: boolean;
  detection_envelope_m: number;

  wind_dir_deg: number;
  wind_speed_ms: number;
  stability: string;
  /**
   * Present only when the reported Pasquill class was outside its own
   * wind-speed range and the kernel stepped it toward neutral. Never happens
   * on this campaign's own weather — it is a guard for forecasts and for a
   * hand-set slider. NOT an explanation of how big the plume is.
   */
  stability_coerced_from?: string;
  stability_note?: string;

  /**
   * Bands carry no `kind`; the `?outline=1` features do. Declared so a check
   * on `properties.kind` narrows a `DispersionFeature` without a cast.
   */
  kind?: never;
}

/**
 * `GET /wind/dispersion` without `outline` — bands only, exactly as before the
 * outline style existed (the server has a test that this stays byte-identical).
 */
export type DispersionPlume = FeatureCollection<
  { type: 'Polygon'; coordinates: Position[][] },
  DispersionProps
>;

/**
 * What every `?outline=1` feature carries, band or not: enough to draw and
 * label it without looking up the band it came from.
 */
export interface DispersionOutlineBase {
  site_id: string;
  measure: MeasureCode;
  ts: string;
  wind_dir_deg: number;
  stability: string;
  /** Past this distance along the axis nothing has been measured. */
  detection_envelope_m: number;
  x_reach_m: number;
  /** `x_reach_m` hit the kernel's 8,000 m limit: a clip, not a real reach. */
  truncated: boolean;
}

/**
 * The plume's OUTER edge (the union of every band), split at the detection
 * envelope. CONTRACT §10b: `inside` is the Aclima model — a solid hairline,
 * no fill; `beyond` is past the measurement range — dashed, no fill, with the
 * legend line "beyond measurement range — model only". Neither is ever filled:
 * measurement is the only filled thing on the map.
 *
 *   inside — from the plume's onset out to min(x_reach_m, detection_envelope_m)
 *   beyond — from detection_envelope_m out to x_reach_m; ABSENT when the plume
 *            ends inside the envelope (x_reach_m <= detection_envelope_m)
 */
export interface DispersionOutlineProps extends DispersionOutlineBase {
  kind: 'outline';
  part: 'inside' | 'beyond';
}

/**
 * The centreline: from the emission-weighted source along the transport
 * direction (`wind_dir_deg + 180`) out to `reach_m`. Solid to `envelope_m`,
 * dashed after it, with a reach tick where it crosses the envelope — and the
 * word "truncated" at the far end instead when `truncated`.
 */
export interface DispersionAxisProps extends DispersionOutlineBase {
  kind: 'axis';
  /** = `detection_envelope_m`, named for the tick it places. */
  envelope_m: number;
  /** = `x_reach_m`. */
  reach_m: number;
}

export type DispersionBandFeature = Feature<{ type: 'Polygon'; coordinates: Position[][] }, DispersionProps>;
export type DispersionOutlineFeature = Feature<{ type: 'Polygon'; coordinates: Position[][] }, DispersionOutlineProps>;
export type DispersionAxisFeature = Feature<{ type: 'LineString'; coordinates: Position[] }, DispersionAxisProps>;
export type DispersionFeature = DispersionBandFeature | DispersionOutlineFeature | DispersionAxisFeature;

/**
 * `GET /wind/dispersion?outline=1` — the same bands PLUS, per site, the
 * outline parts and the axis. A `DispersionPlume` is assignable to it (bands
 * are one member of the union), so a layer typed for this accepts either.
 * Narrow with `isBandFeature` / `isOutlineFeature` / `isAxisFeature`
 * (core/api), which narrow the geometry along with the properties.
 */
export interface DispersionPlumeOutlined {
  type: 'FeatureCollection';
  features: DispersionFeature[];
}

// ───────────────────────────────────────────────────────────── coverage

/**
 * `GET /coverage/*` — **the regulator's question**: does the fixed network
 * stand where the plume goes?
 *
 * Everything under these types is MODELLED. "In a plume" means inside a cone
 * from the dispersion kernel driven by the campaign's wind record; nobody
 * measured the air at these instruments and compared it to anything. `basis`
 * carries that sentence so a screen cannot print the rate without it.
 *
 * The measured counterpart is `CoverageMask` — where a car has actually been.
 * Do not draw them in the same register.
 */
export interface InstrumentCoverage {
  monitor_id: string;
  name: string;
  owner_type: string;
  grade: string | null;
  status: string;
  lon: number;
  lat: number;
  measures: MeasureCode[];
  n_hours: number;
  hours_in_plume: number;
  /** Share of all campaign hours, 0–1. */
  share: number;
  hours_in_plume_stable: number;
  share_stable: number;
  /** site_id → hours this site's plume reached it. */
  by_site: Record<string, number>;
}

/**
 * What four fixed points do well, and what they cannot do. The fleet's LOSING
 * number, in the same payload as everything it wins on, so a screen cannot
 * print only the comparison we win.
 *
 * Every field is computed. An earlier draft of the screen carried "8,598
 * records" and "5.7% vs 1.4%" copied from a design document; measured, the
 * records are 21,500 and the shares are 8.4% and 4.8%. The finding survived,
 * the margin did not.
 */
export interface Concession {
  n_reference_instruments: number;
  n_segments: number;
  n_reference_readings: number;
  n_fleet_passes: number;
  reference_in_plume: number;
  fleet_in_plume: number;
  /** Share of its own record each took while a plume was overhead, 0–1. */
  reference_share: number;
  fleet_share: number;
}

export interface Interception {
  campaign_id: string;
  n_hours: number;
  basis: string;
  concession: Concession;
  instruments: InstrumentCoverage[];
  reference_summary: {
    n: number;
    n_ever_in_plume: number;
    /** Towers in a plume under 2% of hours. */
    n_rarely: number;
    best_share: number;
    worst_share: number;
  };
}

export interface SegmentResidency {
  segment_id: string;
  name: string | null;
  district: string | null;
  lon: number;
  lat: number;
  length_m: number;
  /** Counted per (hour, site) — two sites crossing in one hour is two. */
  plume_hours: number;
  /** Of those, the ones with no instrument standing in the SAME site's plume. */
  unobserved_hours: number;
  unobserved_share: number;
}

export interface Residency {
  campaign_id: string;
  basis: string;
  plume_hours: number;
  unobserved_hours: number;
  unobserved_share: number;
  segments: SegmentResidency[];
}

export interface Siting {
  campaign_id: string;
  basis: string;
  /**
   * Ships in the payload on purpose. Recommending where a public agency sites
   * an instrument is the closest this product comes to regulatory advice, so
   * the disclaimer travels with the rows rather than living in a caption a
   * screen can drop.
   */
  framing: string;
  min_plume_hours: number;
  candidates: SegmentResidency[];
}

/** Per-CHANNEL anchoring state. A single "calibrated" badge on a node is false
 *  for most of what that node measures. */
export interface CalibrationChannel {
  code: MeasureCode;
  plain_name: string;
  family: string;
  anchored: boolean;
  n_reference_anchors: number;
  anchors: { monitor_id: string; name: string; grade: string; last_calibrated: string | null }[];
  last_anchored_at: string | null;
  age_days: number | null;
  /** Set only when nothing in the region can anchor this channel. */
  note: string | null;
}

export interface Calibration {
  campaign_id: string;
  as_of: string | null;
  n_measures: number;
  n_anchored: number;
  channels: CalibrationChannel[];
}

// ─────────────────────────────────────────────────── the regulator network

/**
 * `GET /regulator/network` — the Network screen's status, as of `at`, for one
 * measure (docs/PLAN-refocus.md R1–R5).
 *
 * Every sentence and every "inside the plume" on that screen comes from here,
 * not from the browser: the regulator review found the page's own counts, the
 * header strip and the nav badge disagreeing (13 vs 15), and two model
 * geometries disagreeing about one monitor (R0 — 7 of 9 hours inside by the
 * dispersion polygons, 1 of 5 by the coverage cones). `in_plume`,
 * `plume_share` and `touches` are all computed from the SAME outline geometry
 * `GET /wind/dispersion?outline=1` returns for the map, so what is drawn and
 * what is said cannot disagree.
 */
export interface RegulatorNetworkMonitor {
  id: string;
  name: string;
  code: string | null;
  lon: Lon; lat: Lat;
  status: MonitorStatus;
  radius_m: number | null;
  /** False: the instrument carries no channel for this measure — "no NO2 channel", muted. */
  has_measure: boolean;
  /** The latest reading at or before `at`, within 2 h; else null. */
  reading: { value: number; unit: string; ts: string } | null;
  /**
   * The level the reading's ratio is reported against: the HIGHEST enabled
   * action level with the SAME averaging period as the reading (R3) that the
   * reading exceeds, else the tightest (owner, D15). `ratio` is the raw
   * reading ÷ threshold, 2 dp: Riverport Road's 120.7 ppb at Aug 25 06:00 is
   * 1.21× the NO2 1-hour standard, not 2.0× the watch. The level, the ratio
   * and `over` are judged on one number. The headline names this same level.
   * Null with no reading, or when the measure has no 1-hour level (ozone, CO).
   */
  level: { name: string; threshold: number; averaging_hours: number; ratio: number | null } | null;
  /**
   * The reading shown (the latest within 2 h) is over the TIGHTEST level with
   * the same averaging period, whichever level `level` is. Drives the mark
   * and the pulse.
   */
  over: boolean;
  /** Modelled at `at`, from the outline the map draws. `beyond` = past the detection envelope. */
  in_plume: { site_id: string; part: 'inside' | 'beyond' }[];
  /**
   * Whole record: the share of hours this monitor sat inside each site's
   * modelled outline, split at the envelope. PERCENT, 0–100 — modelled, never
   * measured, and printed beside `basis`.
   */
  plume_share: { site_id: string; inside_pct: number; beyond_pct: number }[];
  /** Hours in the 7 days to `at` over `exceedance_level`. */
  exceedance_hours_7d: number;
  /**
   * The level `exceedance_hours_7d` counts against: the tightest 1-hour
   * level. Label the count with this, never with `level`, which moves with
   * the reading. Null with no channel for the measure or no 1-hour level.
   */
  exceedance_level: { name: string; threshold: number } | null;
}

export interface RegulatorNetworkPlume {
  site_id: string;
  name: string;
  /** Where the plume is carried TOWARD, degrees clockwise from north. */
  bearing_deg: number;
  reach_m: number;
  /** The detection envelope for this hour's stability class. */
  envelope_m: number;
  stability: string;
  touches: {
    /** Inside the SOLID part only — nothing is judged from the part past the envelope. */
    monitor_ids: string[];
    /** Streets inside the solid part with a pass in `streets_window`. */
    streets_driven: number;
    open_cluster_ids: string[];
  };
  /**
   * Every street inside the solid part, driven or not. Below the coverage
   * floor the outline itself is too small to judge, whatever was driven.
   */
  streets_inside: number;
  /** Share (0–1) of the streets inside the solid part driven in `streets_window`. */
  driven_share: number;
  /**
   * Fewer than the coverage floor (P6-E, 8) streets driven inside the solid
   * part in `streets_window`: "not enough of this area was driven to say".
   */
  below_coverage_floor: boolean;
  /** The site's measured downwind test for this measure (`/sites/{id}/touchdown`). */
  touchdown_state: TouchdownState | string;
  /** F7 holds for this site now: wind at the time AND the placebo-checked test. */
  named: boolean;
}

export interface RegulatorNetworkResident {
  cluster_id: string;
  label: string | null;
  count: number;
  last_posted_at: string | null;
  /** Set only when F7 links the cluster to a site. Never proximity. */
  named_site_id: string | null;
  kinds: string[];
}

/**
 * `streets_window` on `GET /regulator/network` (F2). The map draws the same
 * window from `GET /segments?window=trailing:<hours>h|todate&at=<to>`, so the
 * streets on the map and the counts in the panel are one set.
 */
export interface RegulatorStreetsWindow {
  /** The `streets` asked for. */
  kind: StreetsWindow;
  /** Trailing length in hours (24, 168); null for `todate`. */
  hours: number | null;
  /** Passes AFTER this count (at − hours); null for `todate`. */
  from: string | null;
  /** The moment shown — `at`. */
  to: string;
  /** The latest pass at or before `to`, on any street; null before the first. */
  last_pass_at: string | null;
}

export interface RegulatorNetwork {
  at: string;
  measure: MeasureCode;
  /** One sentence naming what is modelled and what is measured. */
  basis: string;
  /** One generated sentence from the status fields — never a written-down number. */
  headline: string;
  numbers: {
    alerts_now: number;
    monitors_reporting: number;
    monitors_total: number;
    /** Kilometres of street with a pass in `streets_window`. */
    street_km: number;
  };
  /** The ONE window every street figure in this payload uses, ending at `at`. */
  streets_window: RegulatorStreetsWindow;
  monitors: RegulatorNetworkMonitor[];
  plumes: RegulatorNetworkPlume[];
  residents: RegulatorNetworkResident[];
}

// ──────────────────────────────────────────────────────────── climatology

/**
 * `GET /wind/climatology` — how often the wind carries from a site over a
 * neighbourhood. **The community app's front door.**
 *
 * Answers that and nothing else. It is NOT evidence that anything was emitted,
 * and it is not a statement about anyone's air — that is `Touchdown`, and it
 * has a much weaker answer. The sentence that says so lives in `PLUME_COPY`.
 *
 * Deliberately reach-independent: it asks only whether the wind POINTED at a
 * district, never whether a plume got there, so it does not move when the
 * dispersion kernel does. That is why it is the front door and the live cloud
 * is one tap behind — a resident who checks at 8am and 6pm sees the same thing.
 */
export interface DistrictWind {
  district: string;
  /** From the site's emission-weighted centroid to the district's road centroid. */
  bearing_deg: number;
  distance_m: number;
  road_km: number;
  n_hours: number;
  hours_downwind: number;
  /** Share of hours the wind pointed here, 0–1. Reach-independent. */
  share: number;
  hours_stable: number;
  hours_downwind_stable: number;
  /** The same, restricted to the still nights when a plume stays together. */
  share_stable: number;
}

export interface WindClimatology {
  campaign_id: string;
  from: string;
  to: string;
  n_hours: number;
  /** The campaign's hourly met record — NOT our fleet's anemometry. */
  source: 'met_record';
  rose: { dir_deg: number; freq: number; mean_speed_ms: number }[];
  sites: { site_id: string; name: string; districts: DistrictWind[] }[];
  sector: { n_sigma: number; min_half_deg: number; max_half_deg: number };
}

// ─────────────────────────────────────────────────────────────── envelope

/**
 * `GET /sites/{id}/envelope` — **the industry tier's spine**: how hard this
 * site can run, measured, per stability regime.
 *
 * Replaces `IndustrySite.headroom_pct`, which is a constant (79 / 61 / 44)
 * hardcoded in the generator, connected to nothing, and impossible for an
 * operator to check or improve.
 *
 * What binds is not the permit number — against that alone Ridgeline could run
 * about five times nameplate. What binds is its own fenceline on stable
 * nights, measured against class-matched roads at least 2 km from every site.
 * And it opens again by morning, which is what makes it manageable.
 */
export type EnvelopeState =
  /** The typical stable episode already needs a cut to hold the line. */
  | 'binding'
  /** Clearly above comparable roads, no line crossed at the typical episode. */
  | 'elevated'
  /** Not separable from an arbitrary patch of road — see `decoy_null`. */
  | 'indistinct'
  /** Not enough conditioned episodes to say. */
  | 'insufficient';

export interface EnvelopeThreshold {
  action_level_id: string;
  label: string;
  threshold: number;
  unit: string;
  severity: Severity;
  source: string;
  /** Share of fenceline passes in this regime at or over the line, 0–1. */
  share_over: number;
  /**
   * How much of THIS SITE's own contribution would have to go to hold the
   * line, as a percentage of that contribution. The number an operator acts
   * on, and the only form that works for a site with no megawatt rating.
   */
  cut_pct_typical: number | null;
  cut_pct_bad_night: number | null;
  /**
   * The same thing in megawatts. **Modelled**, not measured: the excess and
   * the levels are measurements, but converting them to MW assumes this site's
   * contribution scales with its load. Label it wherever it is shown —
   * `Envelope.headroom_is_modelled` carries the sentence.
   */
  headroom_mw_typical: number | null;
  headroom_mw_bad_night: number | null;
}

export interface EnvelopeRegime {
  regime: 'unstable' | 'neutral' | 'stable';
  /** Pasquill classes this regime pools. */
  classes: string;
  n_episodes: number;
  n_fenceline: number;
  n_comparison: number;
  /** Fenceline minus class-matched comparison roads, paired by night. */
  excess: number | null;
  ci_lo: number | null;
  ci_hi: number | null;
  level_p50: number | null;
  level_p90: number | null;
  level_max: number | null;
  /**
   * The same statistics for the comparison set, class-matched to the
   * fenceline's own road-class mix. Both sides are served so a panel can show
   * two distributions rather than a difference the reader has to take on trust.
   */
  comparison_p50: number | null;
  comparison_p90: number | null;
  comparison_max: number | null;
  /** Share of all campaign hours in this regime, 0–1. */
  share_of_hours: number;
  hours_of_day: number[];
  state: EnvelopeState;
  thresholds: EnvelopeThreshold[];
}

export interface Envelope {
  site_id: string;
  measure: MeasureCode;
  unit: string;
  load_mw: number | null;
  decoy_floor: number | null;
  fenceline_m: number;
  n_fenceline_segments: number;
  fenceline_roads: string[];
  /** So a map can ink the roads the claim rests on, per non-negotiable 2. */
  fenceline_segment_ids: string[];
  comparison_segment_ids: string[];
  regimes: EnvelopeRegime[];
  /**
   * The gate, served with the answer. 120 arbitrary road clusters at least
   * 2.5 km from any site, run through the identical computation. An excess
   * inside this is not a finding about the site.
   */
  decoy_null: { n: number; mean?: number; sd?: number | null; abs_max?: number; p95_abs?: number };
  states: EnvelopeState[];
  headroom_is_modelled: string;
}

// ────────────────────────────────────────────────────────────── touchdown

/**
 * `GET /sites/{id}/touchdown` — the MEASURED answer to "where did the fleet
 * find this site's plume, and where do we simply not know".
 *
 * The counterpart to `DispersionPlume`, which is the MODEL. CONTRACT §10b: the
 * measurement is the only filled or inked thing on the map; the model is an
 * outline. Do not draw these in the same register.
 */
export type TouchdownState =
  /** Excess above the calibrated floor, and a fabricated bearing does not match it. */
  | 'elevated_downwind'
  /** An estimate exists, but a fabricated bearing matches it — or could not be computed. */
  | 'contested'
  /** Measured, and inside the noise this estimator makes on wind that never blew. */
  | 'no_detection'
  /** Driven, but not enough conditioned passes on both sides to say anything. */
  | 'insufficient_passes'
  /** In range, never driven downwind of this site in this regime. */
  | 'not_measured';

/**
 * One road segment's contribution. **Evidence, never a verdict.**
 *
 * Measured in phase 2: zero of 1,307 segments accumulate 12 conditioned passes
 * on both sides, and only 7 reach 5. So a per-segment `state` says how much we
 * know about that road — not what happened. The verdict is `Touchdown['site']`.
 */
export interface TouchdownSegment {
  segment_id: string;
  name: string | null;
  district: string | null;
  n_downwind: number;
  n_control: number;
  /** `self` = the segment supplied its own controls; null = it has none. */
  control_kind: 'self' | 'class' | null;
  excess: number | null;
  ci_lo: number | null;
  ci_hi: number | null;
  /**
   * Share of this segment's downwind passes on which it was downwind of THIS
   * site and no other. Below 1 means the segment cannot separate two sites,
   * and any sentence naming one of them has to say so.
   */
  exclusive_share: number;
  placebo_ratio: number | null;
  state: TouchdownState;
  distance_m: number;
  bearing_deg: number;
}

/** The site-level pooled result — the only thing here that is a verdict. */
export interface TouchdownSite {
  site_id: string;
  measure: MeasureCode;
  regime: string;
  excess: number | null;
  ci_lo: number | null;
  ci_hi: number | null;
  n_hours: number;
  n_downwind: number;
  n_control: number;
  /** Largest excess over the three rotated-bearing placebos. */
  placebo_max: number | null;
  /** |placebo| / |excess|. At or above 0.5 the stratum is `contested`. */
  placebo_ratio: number | null;
  /** Measured noise floor for this measure. Null means it has none — see `state`. */
  detect_floor: number | null;
  state: TouchdownState;
  n_supported_segments: number;
  n_distinct_roads: number;
  coverage_pct: number;
  source_lon: number;
  source_lat: number;
  r_lo_m: number;
  r_hi_m: number;
}

/**
 * One (sector, ring) cell. **Never smooth these into a hull** — interpolating
 * across sectors nobody drove turns "we have not been there" into a shape that
 * looks like a finding. `no_control` is its own state for the same reason: a
 * bin with downwind passes and nothing to compare them against is not a zero.
 */
export interface TouchdownPolarBin {
  sector_deg: number;
  ring_lo_m: number;
  ring_hi_m: number;
  n_downwind: number;
  n_control: number;
  excess: number | null;
  state: TouchdownState | 'no_control';
}

export interface Touchdown {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    /** LineString, never Polygon. A polygon here would convert unmeasured ground into apparent measurement. */
    geometry: { type: 'LineString'; coordinates: Position[] };
    properties: TouchdownSegment;
  }[];
  site: TouchdownSite;
  polar: TouchdownPolarBin[];
  districts: { district: string; n_downwind: number; share: number }[];
  states: TouchdownState[];
}

/**
 * `GET /campaigns/{id}/coverage` — where a car has actually been.
 *
 * The bound on every claim drawn over it. Any interface drawing a model plume
 * dims or hatches it outside this mask, and no agreement metric is computed
 * outside it. `cell_m` is the cell's SIDE, not a radius.
 */
export interface CoverageMask {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'Polygon'; coordinates: Position[][] };
    properties: { ix: number; iy: number };
  }[];
  cell_m: number;
  n_cells: number;
  n_cells_total: number;
  covered_pct: number;
  bbox: [number, number, number, number];
}

// ───────────────────────────────────────────────────────────── aggregates

export interface CommunityStats {
  window: StatWindow;
  /** Passes driven up to the moment asked about (`at`), not the whole campaign. */
  passes_to_date?: number;
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

// ═══════════════════════════════════════════════════════ the mission brief

/**
 * `GET /admin/brief` — the whole 07:00 screen in one request. Read-only over
 * the datagen-built plan. The call, swath, strata, outlook and ledger are
 * MODELLED (the derived forecast, drawn as outlines); the debrief and the
 * sample size are MEASURED. See `src/air/server/brief.py`.
 */
export type BriefStratum = 'downwind' | 'upwind' | 'background'

export type BriefVerdict = 'local' | 'advected' | 'no_detection' | 'contested' | 'unpaired'

export interface BriefCall {
  sentence: string
  band: 'morning' | 'midday' | 'evening' | 'night' | null
  site_id: string
  site: string
  axis_deg: number | null
  compass: string | null
  district: string | null
  stability: string | null
  hours: number
  from: string | null
  to: string | null
  confidence: {
    lead_h: number
    dir_sd_deg: number
    spread_deg: number
    tier: 'persistence' | 'blend' | 'climatology'
  } | null
}

export interface BriefFrame {
  lead_h: number
  valid_at: string
  axis_deg: number
  half_angle_deg: number
  x_onset_m: number
  x_reach_m: number
  stability: string
  dir_sd_deg: number
  beyond_crossover: boolean
  ring: Position[] | null
  band: string
}

export interface BriefRoute {
  route_id: string
  vehicle_id: string | null
  day: number
  shift: string
  paths: Record<BriefStratum, Position[][]>
}

export interface BriefRoad { road: string; km: number }

export interface BriefAssignment {
  route_id: string
  day: number
  date: string
  vehicle: string | null
  call_sign: string | null
  operator: string | null
  shift: string
  start: string
  status: string
  km: number
  downwind_km: number
  upwind_km: number
  background_km: number
  downwind_roads: BriefRoad[]
  upwind_roads: BriefRoad[]
  /** Imperative. The control leg is the first thing dropped when running late. */
  control_line: string
  control_ok: boolean
}

export interface BriefStat {
  n: number
  hours: number
  mean: number | null
  ci_lo: number | null
  ci_hi: number | null
}

export interface BriefDiff { mean: number; ci_lo: number; ci_hi: number }

export interface BriefDebrief {
  site_id: string
  date: string
  verdict: BriefVerdict
  missing: ('downwind' | 'upwind')[]
  /** Both sides driven in at least one common hour. */
  concurrent: boolean
  /** Null when `contested` — CONTRACT 10a.4 serves no interval or n then. */
  bars: Record<BriefStratum, BriefStat> | null
  downwind_minus_upwind: BriefDiff | null
  downwind_minus_background: BriefDiff | null
  upwind_minus_background: BriefDiff | null
  paired_hours: number | null
  placebo_ratio: number | null
  detect_floor: number
  measure: string
}

export interface BriefOutlookDay {
  day: number
  date: string
  status: 'assigned' | 'watch'
  hours: number
  lead_from_h: number | null
  lead_to_h: number | null
  axis_deg: number | null
  compass: string | null
  dir_sd_deg: number | null
  persistence_weight: number | null
  beyond_crossover: boolean
  stable_hours: number
  corridor_road_km_hours: number
  district: string | null
  ticks: { lead_h: number; axis_deg: number | null }[]
}

export interface BriefLedger {
  vehicles: number
  vehicle_hours: number
  km_driven: number
  network_km: number
  network_pct: number
  downwind_km: number
  upwind_km: number
  corridor_road_km_hours: number
  control_share: number | null
  min_control_share: number
  control_check: 'pass' | 'fail' | null
}

export interface BriefSampleSize {
  driven_hours: number
  downwind_hours: number
  upwind_hours: number
  paired_hours: number
  paired_rate: number
  sectors_covered: number
  sectors_total: number
  stable_near: { radius_m: number; passes: number; segments: number; roads: number }
}

export interface MissionBrief {
  campaign_id: string
  date: string
  issued_at: string | null
  plan_id: string | null
  read_only: true
  site_id: string
  site: { site_id: string; name: string; short: string; lon: number; lat: number }
  sites_ranked: { site_id: string; short: string; corridor_road_km_hours: number }[]
  call: BriefCall | null
  swath: BriefFrame[]
  routes: BriefRoute[]
  assignments: BriefAssignment[]
  debrief: {
    date: string
    sites: BriefDebrief[]
    touchdown: { segment_id: string; path: Position[]; n: number; anomaly: number }[]
  }
  outlook: BriefOutlookDay[]
  ledger: BriefLedger
  sample_size: BriefSampleSize
  crossover_h: number
  basis: string
}
