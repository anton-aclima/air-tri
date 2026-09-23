-- air — shared schema for the Aclima industry / community / regulator prototype.
-- One SQLite database backs all four interfaces. Cross-interface tension lives in
-- the concern / alert / mitigation / advisory tables: a write from one role shows
-- up as a read in another.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- meta / identity

CREATE TABLE IF NOT EXISTS org (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  short_name   TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('agency','company','cbo','aclima')),
  brand_color  TEXT,
  logo_emoji   TEXT,
  blurb        TEXT,
  website      TEXT
);

CREATE TABLE IF NOT EXISTS app_user (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('community','regulator','industry','admin')),
  org_id        TEXT REFERENCES org(id),
  title         TEXT,
  avatar_emoji  TEXT,
  avatar_color  TEXT,
  neighborhood  TEXT,
  joined_at     TEXT,
  is_demo_persona INTEGER NOT NULL DEFAULT 1
);

-- Definition of every measurable quantity: 7 measured modalities + derived indicators.
CREATE TABLE IF NOT EXISTS measure_def (
  code         TEXT PRIMARY KEY,          -- 'no2','pm25','bc','o3','co','co2','ch4','methane_leak',...
  label        TEXT NOT NULL,             -- 'Nitrogen Dioxide'
  short_label  TEXT NOT NULL,             -- 'NO2'
  unit         TEXT NOT NULL,             -- 'ppb'
  -- 'composite' is a derived index with no per-pass column and no instrument
  -- behind it. Keeping it a distinct family is what lets datagen exclude it from
  -- the physical pipeline automatically and gives all four interfaces one field
  -- to branch on, rather than hardcoding the code string in a dozen places.
  family       TEXT NOT NULL CHECK (family IN ('modality','indicator','composite')),
  ref_level    REAL,                      -- level used to compute persistence (share of passes above)
  healthy_max  REAL,                      -- top of the "clean" band, for risk scaling
  scale_json   TEXT,                      -- [[concentration, risk0_100], ...] breakpoints
  ramp_json    TEXT,                      -- ordered hex stops for the road-segment color ramp
  decimals     INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  description  TEXT,
  plain_name   TEXT                       -- community-facing plain language, e.g. 'traffic exhaust'
);

-- ---------------------------------------------------------------- campaign & geography

CREATE TABLE IF NOT EXISTS campaign (
  id               TEXT PRIMARY KEY,
  slug             TEXT UNIQUE NOT NULL,
  name             TEXT NOT NULL,
  subtitle         TEXT,
  description      TEXT,
  region           TEXT,
  state            TEXT,
  center_lon       REAL NOT NULL,
  center_lat       REAL NOT NULL,
  default_zoom     REAL NOT NULL DEFAULT 13,
  bbox_w           REAL, bbox_s REAL, bbox_e REAL, bbox_n REAL,
  boundary_geojson TEXT NOT NULL,           -- Feature/FeatureCollection of the community polyline(s)
  start_date       TEXT NOT NULL,
  end_date         TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('draft','planning','active','complete')),
  fleet_size       INTEGER NOT NULL DEFAULT 5,
  target_passes    INTEGER NOT NULL DEFAULT 25,
  timezone         TEXT NOT NULL DEFAULT 'America/Chicago',
  created_at       TEXT NOT NULL
);

-- The atom of the flagship visualization: a ~200 m piece of a real OSM road.
CREATE TABLE IF NOT EXISTS road_segment (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaign(id),
  osm_way_id    INTEGER,
  name          TEXT,
  road_class    TEXT,                      -- residential | secondary | tertiary | service | ...
  district      TEXT,                      -- neighborhood label, for community grouping
  geometry_json TEXT NOT NULL,             -- [[lon,lat],...] LineString
  length_m      REAL NOT NULL,
  mid_lon       REAL NOT NULL,
  mid_lat       REAL NOT NULL,
  bearing_deg   REAL
);
CREATE INDEX IF NOT EXISTS ix_segment_campaign ON road_segment(campaign_id);

-- One row per (segment, measure, window). window is 'all', 'date:YYYY-MM-DD',
-- 'hour:HH' (diurnal, 00-23), or 'week:YYYY-Www'.
CREATE TABLE IF NOT EXISTS segment_stat (
  segment_id   TEXT NOT NULL REFERENCES road_segment(id),
  campaign_id  TEXT NOT NULL,
  measure      TEXT NOT NULL REFERENCES measure_def(code),
  window       TEXT NOT NULL,
  n_passes     INTEGER NOT NULL,
  mean         REAL, median REAL, p10 REAL, p90 REAL, max REAL,
  persistence  REAL,                       -- 0..1 share of passes above measure ref_level
  risk         INTEGER,                    -- 0..100 unitless community-facing score
  PRIMARY KEY (segment_id, measure, window)
);
CREATE INDEX IF NOT EXISTS ix_stat_lookup ON segment_stat(campaign_id, measure, window);

-- Raw mobile-monitoring passes. One row = one vehicle traverse of one segment.
CREATE TABLE IF NOT EXISTS segment_pass (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL,
  segment_id  TEXT NOT NULL REFERENCES road_segment(id),
  drive_id    TEXT,
  vehicle_id  TEXT,
  ts          TEXT NOT NULL,
  no2 REAL, pm25 REAL, bc REAL, o3 REAL, co REAL, co2 REAL, ch4 REAL,
  methane_leak REAL, diesel REAL, nondiesel REAL,
  speed_kph   REAL,
  -- WHY THE CAR WAS HERE. Inherited from `drive.sampling_mode`; see there.
  sampling_mode TEXT NOT NULL DEFAULT 'uniform'
    CHECK (sampling_mode IN ('uniform','targeted','control'))
);
CREATE INDEX IF NOT EXISTS ix_pass_segment ON segment_pass(segment_id, ts);
CREATE INDEX IF NOT EXISTS ix_pass_time    ON segment_pass(campaign_id, ts);

-- ---------------------------------------------------------------- stationary network

CREATE TABLE IF NOT EXISTS monitor (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaign(id),
  name          TEXT NOT NULL,
  code          TEXT,                      -- AQS-style site code
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('regulator','industry','community','aclima')),
  org_id        TEXT REFERENCES org(id),
  site_id       TEXT,                      -- set when owned by an industry site
  lon REAL NOT NULL, lat REAL NOT NULL,
  elevation_m   REAL,
  grade         TEXT NOT NULL CHECK (grade IN ('reference','fem','lowcost')),
  status        TEXT NOT NULL CHECK (status IN ('online','degraded','offline','maintenance')),
  measures_json TEXT NOT NULL,             -- ["no2","o3","pm25"]
  radius_m      REAL,                      -- nominal representativeness radius ("tower range")
  install_date  TEXT,
  last_calibrated TEXT,
  blurb         TEXT
);

CREATE TABLE IF NOT EXISTS monitor_reading (
  monitor_id TEXT NOT NULL REFERENCES monitor(id),
  ts         TEXT NOT NULL,
  measure    TEXT NOT NULL,
  value      REAL NOT NULL,
  qc         TEXT NOT NULL DEFAULT 'valid',
  PRIMARY KEY (monitor_id, ts, measure)
);
CREATE INDEX IF NOT EXISTS ix_reading_time ON monitor_reading(measure, ts);

-- ---------------------------------------------------------------- regulator

CREATE TABLE IF NOT EXISTS action_level (
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT NOT NULL REFERENCES campaign(id),
  measure        TEXT NOT NULL REFERENCES measure_def(code),
  label          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('spike','integrated')),
  threshold      REAL NOT NULL,
  unit           TEXT NOT NULL,
  averaging_hours REAL NOT NULL DEFAULT 1,
  severity       TEXT NOT NULL CHECK (severity IN ('info','watch','warning','critical')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  source         TEXT,                     -- 'EPA NAAQS 1-hr', 'IL EPA', 'local'
  notify_community INTEGER NOT NULL DEFAULT 1,
  notify_industry  INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT
);

CREATE TABLE IF NOT EXISTS advisory (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  org_id      TEXT REFERENCES org(id),
  author_id   TEXT REFERENCES app_user(id),
  kind        TEXT NOT NULL CHECK (kind IN ('advisory','warning','notice','all_clear','update')),
  severity    TEXT NOT NULL CHECK (severity IN ('info','watch','warning','critical')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  measure     TEXT,
  alert_id    TEXT,
  audience_json TEXT NOT NULL DEFAULT '["community"]',
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS enforcement_action (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  site_id     TEXT REFERENCES industry_site(id),
  org_id      TEXT REFERENCES org(id),
  kind        TEXT NOT NULL CHECK (kind IN ('inquiry','request_for_info','notice_of_violation','stipulation','site_visit')),
  status      TEXT NOT NULL CHECK (status IN ('open','responded','closed','escalated')),
  title       TEXT NOT NULL,
  body        TEXT,
  alert_id    TEXT,
  created_at  TEXT NOT NULL,
  due_at      TEXT,
  closed_at   TEXT
);

-- ---------------------------------------------------------------- community

CREATE TABLE IF NOT EXISTS concern (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaign(id),
  author_id    TEXT REFERENCES app_user(id),
  kind         TEXT NOT NULL CHECK (kind IN ('smell','noise','smoke','dust','health','light','traffic','vibration','other')),
  severity     INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  title        TEXT NOT NULL,
  body         TEXT,
  lon REAL NOT NULL, lat REAL NOT NULL,
  address_hint TEXT,
  district     TEXT,
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('new','corroborated','under_review','mitigation_proposed','resolved','closed')),
  cluster_id   TEXT,
  corroborations INTEGER NOT NULL DEFAULT 0,
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  photo_emoji  TEXT,
  suspected_site_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_concern_campaign ON concern(campaign_id, created_at);

CREATE TABLE IF NOT EXISTS concern_response (
  id         TEXT PRIMARY KEY,
  concern_id TEXT NOT NULL REFERENCES concern(id),
  author_id  TEXT REFERENCES app_user(id),
  org_id     TEXT REFERENCES org(id),
  role       TEXT NOT NULL CHECK (role IN ('community','regulator','industry','admin')),
  kind       TEXT NOT NULL CHECK (kind IN ('acknowledge','mitigation','finding','advisory','comment')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS concern_corroboration (
  concern_id TEXT NOT NULL REFERENCES concern(id),
  user_id    TEXT NOT NULL REFERENCES app_user(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (concern_id, user_id)
);

-- A spatial+temporal grouping of concerns. Industry sees clusters as radar contacts.
CREATE TABLE IF NOT EXISTS concern_cluster (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  label       TEXT,
  centroid_lon REAL NOT NULL, centroid_lat REAL NOT NULL,
  radius_m    REAL NOT NULL,
  count       INTEGER NOT NULL,
  kinds_json  TEXT NOT NULL,
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  site_id     TEXT
);

-- ---------------------------------------------------------------- industry

CREATE TABLE IF NOT EXISTS industry_site (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaign(id),
  org_id          TEXT REFERENCES org(id),
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('datacenter','logistics','manufacturing','power','other')),
  footprint_geojson TEXT NOT NULL,          -- Polygon
  centroid_lon REAL NOT NULL, centroid_lat REAL NOT NULL,
  claimed_by_user_id TEXT REFERENCES app_user(id),
  claimed_at      TEXT,
  status          TEXT NOT NULL CHECK (status IN ('operating','construction','permitting','proposed')),
  capacity_mw     REAL,
  it_load_mw      REAL,
  generator_count INTEGER,
  generator_fuel  TEXT,
  operating_since TEXT,
  blurb           TEXT,
  brand_color     TEXT,
  logo_emoji      TEXT,
  website         TEXT,
  headroom_pct    REAL                      -- how much of its "community-safe" envelope is used
);

CREATE TABLE IF NOT EXISTS emission_point (
  id       TEXT PRIMARY KEY,
  site_id  TEXT NOT NULL REFERENCES industry_site(id),
  name     TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('generator','cooling_tower','backup','stack','traffic_gate','substation')),
  lon REAL NOT NULL, lat REAL NOT NULL,
  height_m REAL,
  active   INTEGER NOT NULL DEFAULT 1,
  measures_json TEXT
);

CREATE TABLE IF NOT EXISTS site_post (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  site_id     TEXT REFERENCES industry_site(id),
  org_id      TEXT REFERENCES org(id),
  author_id   TEXT REFERENCES app_user(id),
  kind        TEXT NOT NULL CHECK (kind IN ('update','mitigation','event','response','intro')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  concern_id  TEXT REFERENCES concern(id),
  media_emoji TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mitigation (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES industry_site(id),
  concern_id  TEXT REFERENCES concern(id),
  cluster_id  TEXT,
  alert_id    TEXT,
  title       TEXT NOT NULL,
  body        TEXT,
  status      TEXT NOT NULL CHECK (status IN ('proposed','in_progress','completed','withdrawn')),
  measure     TEXT,
  expected_reduction_pct REAL,
  started_at  TEXT,
  completed_at TEXT,
  created_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------- shared alert stream

CREATE TABLE IF NOT EXISTS alert (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaign(id),
  kind         TEXT NOT NULL CHECK (kind IN ('exceedance','integrated_exposure','concern_cluster','mobile_detection','fleet_anomaly','regulatory_notice','wind_shift')),
  severity     TEXT NOT NULL CHECK (severity IN ('info','watch','warning','critical')),
  measure      TEXT,
  value        REAL, threshold REAL, unit TEXT,
  source_type  TEXT NOT NULL CHECK (source_type IN ('monitor','mobile','community','regulator','model')),
  source_id    TEXT,
  lon REAL, lat REAL,
  site_id      TEXT REFERENCES industry_site(id),
  action_level_id TEXT REFERENCES action_level(id),
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  status       TEXT NOT NULL CHECK (status IN ('active','acknowledged','resolved','expired')),
  title        TEXT NOT NULL,
  body         TEXT,
  recommendation TEXT,
  audience_json TEXT NOT NULL DEFAULT '["regulator","industry","admin"]',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_alert_campaign ON alert(campaign_id, started_at);

CREATE TABLE IF NOT EXISTS alert_sample (
  alert_id TEXT NOT NULL REFERENCES alert(id),
  ts       TEXT NOT NULL,
  value    REAL NOT NULL,
  PRIMARY KEY (alert_id, ts)
);

CREATE TABLE IF NOT EXISTS alert_ack (
  alert_id  TEXT NOT NULL REFERENCES alert(id),
  user_id   TEXT NOT NULL REFERENCES app_user(id),
  note      TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (alert_id, user_id)
);

-- ---------------------------------------------------------------- fleet & drive plan

CREATE TABLE IF NOT EXISTS vehicle (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  label       TEXT NOT NULL,               -- 'AC-04'
  call_sign   TEXT,                        -- 'Bluebird'
  model       TEXT,
  powertrain  TEXT CHECK (powertrain IN ('ev','phev','hybrid')),
  status      TEXT NOT NULL CHECK (status IN ('driving','idle','charging','maintenance','offline')),
  operator_name TEXT,
  home_base_lon REAL, home_base_lat REAL,
  measures_json TEXT
);

CREATE TABLE IF NOT EXISTS drive_plan (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  name        TEXT NOT NULL,
  fleet_size  INTEGER NOT NULL,
  target_passes INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('draft','active','archived')),
  params_json TEXT,                        -- generator knobs (shift length, speed, seed...)
  stats_json  TEXT,                        -- coverage, total km, days to target, per-day km
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drive_route (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES drive_plan(id),
  campaign_id  TEXT NOT NULL,
  vehicle_id   TEXT REFERENCES vehicle(id),
  day_index    INTEGER NOT NULL,
  date         TEXT,
  shift        TEXT CHECK (shift IN ('morning','midday','evening','night')),
  segment_ids_json TEXT NOT NULL,
  geometry_json TEXT NOT NULL,             -- [[lon,lat],...] full route polyline
  distance_m   REAL, duration_min REAL, est_passes INTEGER
);

CREATE TABLE IF NOT EXISTS drive (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  plan_id     TEXT, route_id TEXT,
  vehicle_id  TEXT REFERENCES vehicle(id),
  date        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  status      TEXT NOT NULL CHECK (status IN ('planned','in_progress','complete','aborted')),
  distance_m  REAL,
  segments_covered INTEGER,
  geometry_json TEXT,
  -- WHY THIS DRIVE HAPPENED, recorded once, at dispatch.
  --
  --   uniform   routine coverage: the planner's own route, no thumb on it
  --   targeted  sent because something was expected there
  --   control   sent to be a comparison for a targeted run
  --
  -- Without this column the product's headline becomes a function of the
  -- dispatcher. Targeted driving biases per-segment medians upward by up to
  -- +57%, and 2.66x on the worst near-source case from four passes, and those
  -- medians feed the community risk score and the regulator's street ranking.
  -- Community-facing and cross-street statistics are computed from `uniform`
  -- passes only (see `datagen/stats.py`).
  --
  -- This is a property of the DRIVE, not of the pass: which stratum a pass
  -- falls into is geometry and stays computed at analysis time. Why a car was
  -- sent somewhere is a fact about the dispatch, known once, and not
  -- recoverable afterwards.
  sampling_mode TEXT NOT NULL DEFAULT 'uniform'
    CHECK (sampling_mode IN ('uniform','targeted','control'))
);

-- Sampled GPS track used for fleet playback / "live" vehicle dots.
CREATE TABLE IF NOT EXISTS vehicle_ping (
  drive_id   TEXT NOT NULL REFERENCES drive(id),
  ts         TEXT NOT NULL,
  lon REAL NOT NULL, lat REAL NOT NULL,
  speed_kph  REAL, heading_deg REAL,
  segment_id TEXT,
  PRIMARY KEY (drive_id, ts)
);

-- ---------------------------------------------------------------- environment

CREATE TABLE IF NOT EXISTS wind (
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  ts          TEXT NOT NULL,
  speed_ms    REAL NOT NULL,
  dir_deg     REAL NOT NULL,               -- meteorological: direction wind comes FROM
  gust_ms     REAL,
  temp_c      REAL, rh REAL,
  pbl_m       REAL,                        -- planetary boundary layer height
  stability   TEXT,                        -- Pasquill class A-F
  PRIMARY KEY (campaign_id, ts)
);

-- ---------------------------------------------------------------- app plumbing

CREATE TABLE IF NOT EXISTS notification (
  id         TEXT PRIMARY KEY,
  campaign_id TEXT,
  user_id    TEXT REFERENCES app_user(id),
  role       TEXT,
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  created_at TEXT NOT NULL,
  read_at    TEXT
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Append-only log of every mutation, so the demo can show cross-role causality.
CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT,
  ts          TEXT NOT NULL,
  actor_role  TEXT,
  actor_id    TEXT,
  verb        TEXT NOT NULL,               -- 'concern.created', 'alert.acknowledged', ...
  object_type TEXT, object_id TEXT,
  summary     TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_activity_ts ON activity(ts);

-- ---------------------------------------------------------------- mobile wind (added)
-- Aclima's vehicles carry anemometers, so we hold *observed* street-level wind, not
-- just a model. This is the basis of the industry "verify your consultant" story:
-- a dispersion model is only as good as the wind rose it assumed.

CREATE TABLE IF NOT EXISTS mobile_wind_obs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  TEXT NOT NULL REFERENCES campaign(id),
  drive_id     TEXT REFERENCES drive(id),
  vehicle_id   TEXT REFERENCES vehicle(id),
  segment_id   TEXT REFERENCES road_segment(id),
  ts           TEXT NOT NULL,
  lon REAL NOT NULL, lat REAL NOT NULL,
  -- Ground-relative, already corrected for vehicle motion.
  speed_ms     REAL NOT NULL,
  dir_deg      REAL NOT NULL,        -- meteorological: direction wind comes FROM
  gust_ms      REAL,
  vehicle_speed_kph REAL,
  -- Anemometry from a moving platform is noisy. 'suspect' when the vehicle was fast
  -- or the wind was calm; the UI must be able to filter these out honestly.
  quality      TEXT NOT NULL DEFAULT 'good' CHECK (quality IN ('good','suspect','rejected'))
);
CREATE INDEX IF NOT EXISTS ix_mwo_time ON mobile_wind_obs(campaign_id, ts);
CREATE INDEX IF NOT EXISTS ix_mwo_seg  ON mobile_wind_obs(segment_id);

-- A consultant's point-source dispersion deliverable for an industry site. Seeded
-- DELIBERATELY IMPERFECT — it assumes an idealised wind rose that under-weights the
-- north-wind days that actually carry the plume over Boxtown. `air` is what lets the
-- operator discover that.
CREATE TABLE IF NOT EXISTS dispersion_model (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES industry_site(id),
  campaign_id  TEXT NOT NULL REFERENCES campaign(id),
  name         TEXT NOT NULL,
  vendor       TEXT,
  method       TEXT,                 -- 'AERMOD' | 'CALPUFF' | 'screening'
  measure      TEXT NOT NULL REFERENCES measure_def(code),
  averaging_hours REAL NOT NULL DEFAULT 1,
  issued_at    TEXT,
  -- The wind rose the consultant assumed: [{dir_deg, freq, mean_speed_ms}, ...]
  assumed_wind_json TEXT NOT NULL,
  notes        TEXT,
  -- WHOSE MODEL THIS IS.
  --
  --   permit   the study the operator filed. A legal object: it says what the
  --            site was permitted on, not what the air did.
  --   aclima   the same kernel driven by the wind our fleet actually measured.
  --
  -- One axis, and only this one. The word "tier" was used for four different
  -- things across the design work — model provenance, forecast horizon,
  -- entitlement, and confidence — and two of them were drafted as conflicting
  -- CHECK constraints on this table. `forecast_tier` is a SEPARATE column when
  -- phase 8 needs it; these two must never share a value name.
  model_tier   TEXT NOT NULL DEFAULT 'permit'
    CHECK (model_tier IN ('permit','aclima'))
);

CREATE TABLE IF NOT EXISTS dispersion_model_contour (
  model_id      TEXT NOT NULL REFERENCES dispersion_model(id),
  band          INTEGER NOT NULL,    -- 0 = highest concentration
  level         REAL NOT NULL,
  geometry_json TEXT NOT NULL,       -- Polygon
  PRIMARY KEY (model_id, band)
);
