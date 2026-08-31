# `air.server` — FastAPI backend

Read-heavy JSON API on `:8000` under `/api/v1`, backed by plain `sqlite3` (stdlib,
no ORM). Implements every endpoint in `docs/CONTRACT.md` §5. All responses match
`web/src/core/types.ts` field for field.

```bash
source dev/env.sh
uv run air-server                        # or: uv run python -m air.server
# reads data/air.db by default; AIR_DB overrides
```

`pyproject.toml` needs (already added by the orchestrator):

```toml
[project.scripts]
air-server = "air.server.__main__:main"
```

## Layout

| File | Responsibility |
|---|---|
| `app.py` | app assembly, CORS, static `web/dist`, lifespan, error handler |
| `__main__.py` | `main()` — uvicorn on `:8000`, reload in dev |
| `config.py` | paths, `.env` via python-dotenv, demo knobs |
| `db.py` | connection-per-request reads (`query_only`), one serialized writer |
| `cache.py` | in-process LRU, global version bumped by every write |
| `bus.py` | SSE pub/sub — one `asyncio.Queue` per subscriber, thread-safe publish |
| `timeutil.py` | one stored timestamp format (`YYYY-MM-DDTHH:MM:SSZ`), permissive parse |
| `geo.py` | haversine, true bearing, destination, compass, plume cones |
| `shapes.py` | `sqlite3.Row` → wire dict, one function per `types.ts` interface |
| `loaders.py` | shared read paths (sites, concerns, monitors, alerts, posts…) |
| `domain.py` | the activity log and **the three cross-role loops** |
| `models.py` | pydantic request bodies |
| `windfield.py` | circular statistics, grid binning, wind roses, model verification (§8b) |
| `sim.py` | the six scripted demo scenarios (CONTRACT §8) |
| `advisor_rules.py` | deterministic fallback for `POST /advisor` |
| `routers/*.py` | one module per domain |
| `_smoketest_seed.py` | **backend testing only** — tiny fixture, writes `data/air_smoketest.db` |

## Endpoints

### Read

| Method | Path | Notes |
|---|---|---|
| GET | `/bootstrap` | `{campaign, measures[], orgs[], users[], action_levels[], sites[], flags}`; `flags.now` is always live |
| GET | `/campaigns` · `/campaigns/{id}` | |
| GET | `/campaigns/{id}/boundary` | always a `FeatureCollection`, whatever the column holds |
| GET | `/segments` | **flagship.** `measure` `metric` `window` `bbox=w,s,e,n` `min_passes` `limit`. GeoJSON LineStrings, coords at 5 dp, `x-air-cache: hit\|miss` |
| GET | `/segments/{id}` | detail + daily + 24 h diurnal + per-measure stats + `rank_pct` + `nearest_site` |
| GET | `/monitors` | `owner_type` `grade` `site_id`; each carries `latest` per measure with `exceeds` |
| GET | `/monitors/{id}` | |
| GET | `/monitors/{id}/readings` | `measure` `from` `to` `interval=hour\|day` + the action levels for that measure |
| GET | `/concerns` | `status` `kind` (both comma-separated), `since`, `near=lon,lat,radius_m`, `cluster_id` |
| GET | `/concerns/{id}` | |
| GET | `/clusters` | |
| GET | `/sites` · `/sites/{id}` | `emission_points[]` inlined |
| GET | `/posts` | `site_id` `kind` `concern_id`; org name/colour/emoji joined |
| GET | `/mitigations` † | `site_id` `concern_id` `alert_id` |
| GET | `/advisories` | `audience` `active_only` |
| GET | `/enforcement` † | `enforcement_action` rows |
| GET | `/alerts` | `role` `status` `severity` `kind` `site_id` `radius_m` `since`. **With `site_id`, every alert gains `bearing_deg` (0–360 true, from the site centroid) and `distance_m`, sorted nearest-first — this is the RWR scope.** |
| GET | `/alerts/{id}` | + `samples[]`, related `concerns[]`, `mitigations[]`, `acknowledged_by[]`. `?site_id=` adds RWR geometry |
| GET | `/action-levels` | `measure` |
| GET | `/feed` | `role` `since` `limit` `include_readings`. Merged concerns + advisories + posts + mitigations + exceeding readings, newest first |
| GET | `/fleet` | `at` `delay_min` `role`. **`role=community` clamps `delay_min` to ≥180**; positions come from `now − delay` |
| GET | `/vehicles` † | |
| GET | `/drive-plan` | `include_routes` (default **false** here — routes are heavy) |
| GET | `/drive-plan/{id}` † | `include_routes` (default true) |
| GET | `/drive-plan/{id}/coverage` | |
| GET | `/wind` | `from` `to` |
| GET | `/wind/current` † | the wind row in force at `at` |
| GET | `/wind/dispersion` | `site_id` `at` `measure` `reach_m` → 3 banded plume polygons per active emission point |
| GET | `/wind/mobile` | `from` `to` `bbox=w,s,e,n` `quality` `limit` → `MobileWindObs[]` from the fleet anemometers. `quality` is comma-separated; **the default excludes only `rejected`**, so `suspect` is visible and filterable rather than hidden |
| GET | `/wind/field` | `from` `to` `cell_m` `bbox` `quality` → `WindField`. Observed wind binned onto a clean lattice; **direction averaged circularly**. Feeds the particle overlay |
| GET | `/sites/{id}/dispersion-models` | `DispersionModel[]` with contours; `assumed_wind` re-binned onto the canonical 16-point rose |
| GET | `/sites/{id}/model-verification` | `model_id` `from` `to` `quality` → `ModelVerification`. Assumed vs. observed rose, per-bearing bias, understated bearings, under-weighted districts, verdict |
| GET | `/stats/community` | `window`. Unitless 0–100 risk, plain-language labels, `plain_name` — **no units, no acronyms** |
| GET | `/stats/campaign` | admin KPIs |
| GET | `/activity` | `since` `after_id` `verb` (`*` wildcard) `limit` |
| GET | `/health` † | db path, counts, cache stats, SSE subscriber count |

### Write — every one appends to `activity` and publishes to the SSE bus

| Method | Path | Notes |
|---|---|---|
| POST | `/concerns` | **runs cluster detection inline**; response is the `Concern` plus `cluster` and `cluster_alert` |
| POST | `/concerns/{id}/corroborate` | 409 on a duplicate user |
| POST | `/concerns/{id}/responses` | `kind='mitigation'` moves the concern to `mitigation_proposed`; a regulator `acknowledge`/`finding` moves `new`/`corroborated` → `under_review` |
| PATCH | `/concerns/{id}` | `{status, role?}`; role may also come from `X-Air-Role`. **403 unless regulator/admin for `resolved`/`closed`** |
| POST | `/posts` | with `concern_id`, also creates `concern_response(kind='mitigation')` |
| POST | `/mitigations` | also creates a `site_post(kind='mitigation')`, a `concern_response(kind='mitigation')`, and appends to the linked alert's recommendation |
| POST | `/advisories` | |
| POST | `/alerts/{id}/acknowledge` | sets `status='acknowledged'` |
| PUT | `/action-levels/{id}` | full row, then **immediate re-evaluation** |
| POST | `/action-levels` | same, for a new level |
| POST | `/advisor` | `{alert_id? , question?, site_id?}` → `AdvisorReply` |
| POST | `/admin/campaigns/{id}/drive-plan` | `{fleet_size, target_passes, shift_hours, seed}` → regenerates, archives the old plan |
| POST | `/admin/reseed` | delegates to `air.datagen`; 503 with an actionable message if unavailable |
| POST | `/admin/simulate` | `{scenario}` — the five CONTRACT §8 scenarios |
| GET | `/admin/scenarios` † | scenario ids + descriptions, for the Demo Director panel |

### Live

| Method | Path | Notes |
|---|---|---|
| GET | `/events/stream` | SSE. `?since=<id>` or `Last-Event-ID` replays the last 200 events |
| GET | `/events/status` † | subscriber and buffer counts |

† not in CONTRACT §5 — added; see *Deviations*.

## The three cross-role loops

**1. Community concern → cluster → industry + regulator alert.** `POST /concerns`
inserts, then `domain.detect_cluster` looks for ≥3 concerns within **600 m** and
**24 h** (`AIR_CLUSTER_*` env knobs). On form or growth it writes/updates a
`concern_cluster`, stamps `cluster_id` onto every member, promotes `new` members
to `corroborated`, sets `cluster.site_id` to the nearest industry site, and emits
`alert(kind='concern_cluster')` at the cluster centroid addressed to
`["industry","regulator","admin"]`. Severity ladders 3→`watch`, 5→`warning`,
7→`critical`. A cluster that grows **updates its existing alert** (verb
`alert.escalated`) rather than spawning a new one, so the radar shows one contact
getting worse instead of a stack of duplicates.

**2. Regulator action level → exceedance alert → community advisory.**
`PUT /action-levels/{id}` writes the row and immediately calls
`domain.evaluate_action_level`, which:
- looks back 72 h; `kind='spike'` compares the per-monitor peak, `kind='integrated'` compares the mean over `averaging_hours`;
- creates one `alert(kind='exceedance'|'integrated_exposure')` per monitor now over the line, with 48 samples for the sparkline, located at the monitor, `site_id` = the monitor's site or the nearest one, audience derived from `notify_community`/`notify_industry`;
- also creates **one** `alert(kind='mobile_detection')` for the worst `segment_stat.max` over the line — the mobile-monitoring leapfrog the tower network can't see;
- **resolves** alerts the new threshold no longer justifies (raising a threshold clears the scope), and resolves everything owned by a level that is disabled;
- when the level notifies the community and the new alert is `warning`/`critical`, writes an `advisory` in plain language (no units, no acronyms).

Verified in both directions: 60→24 ppb created 2 alerts + 1 advisory; 24→90 ppb
resolved 3; `enabled:false` resolved the rest.

**3. Industry mitigation → community feed.** `POST /mitigations` and `POST /posts`
(when `concern_id` is set) both call `domain.attach_mitigation_response`, which
writes a `concern_response(kind='mitigation')` and moves the concern to
`mitigation_proposed` — never further. `PATCH /concerns/{id}` returns **403** with
a structured `detail` for any non-regulator/admin role attempting `resolved` or
`closed`, and for industry attempting anything other than `under_review` or
`mitigation_proposed`.

## `GET /segments` performance

Three things buy the speed:

1. Geometry is parsed from `geometry_json` and rounded to 5 dp **once per campaign**
   into a module-level dict, keyed by cache version. Geometry never changes.
2. One prepared query against `ix_stat_lookup(campaign_id, measure, window)`.
3. The finished `FeatureCollection` is serialized once and the **bytes** are held in
   the LRU keyed on the query params. A warm hit is a memcpy.

Measured on a 1400-segment / 14 000-stat-row database (`data/air_perf.db`):

| | |
|---|---|
| cold, 1337 features, 598 KB | **46 ms** |
| warm (`x-air-cache: hit`) | **4.2 ms** |
| a different measure/metric (geometry cache warm) | 14–15 ms |
| 60 requests, 12 threads | p50 14 ms · p95 33 ms |

Any write calls `cache.invalidate()`, which bumps a global version so every cached
body is dropped at once — no dependency tracking to get wrong. Verified: `hit` →
POST → `miss` → `hit`.

## SSE

`GET /events/stream` returns `text/event-stream` with correct framing:

```
id: 27
event: alert
data: {"id":44,"ts":"…","verb":"alert.created","object_type":"alert","object_id":"al_…","summary":"…","payload":{…},"object":{…full Alert…}}

: ping
```

- One `asyncio.Queue` (max 256) per subscriber; a full queue drops its oldest event rather than stalling the stream.
- `: ping` comment every 15 s.
- **Every write publishes twice**: once under its domain name (`alert`, `concern`,
  `post`, `advisory`, `fleet`) and once under `activity`. So an interface can
  `addEventListener('alert', …)` while the admin oversight view watches
  `activity` and sees everything. All six CONTRACT names are exercised.
- The `data` payload is an `ActivityItem` **plus** an `object` key holding the full
  wire object, so a client rarely needs a follow-up fetch.
- Writes happen in sync handlers (threadpool); `bus.publish` hands off to the main
  loop with `call_soon_threadsafe`. The loop is bound in the lifespan handler.
- Reconnect replays the last 200 events via `?since=<id>` or `Last-Event-ID`.

## `POST /advisor`

Real Claude API call with graceful degradation. The `claude-api` skill was consulted
for model ids and request shape.

- Model `claude-opus-5`, Messages API, adaptive thinking, `output_config.effort:
  "low"` for latency, and `output_config.format` as a JSON schema matching
  `AdvisorReply`, so the reply needs no parsing heuristics.
- Server-side refusal fallbacks (`fallbacks: "default"` +
  `anthropic-beta: server-side-fallback-2026-07-01`) are attempted; on a 400 whose
  body mentions the beta, the request is retried once without them.
- **The `anthropic` SDK is not a project dependency** (`pyproject.toml` is the
  orchestrator's), so the call goes over raw HTTP with `httpx`, which is. Say the
  word and I'll switch to the SDK.
- Prompt context: the alert (with bearing/range from the site centroid), the site
  and every emission point (kind, stack height, bearing and range from the
  centroid), current wind (direction, speed, gust, stability, PBL), the enabled
  action levels for that measure, the last 12 readings from every monitor that
  reports it (with bearing/range from the site), and community concerns within
  2.5 km over 7 days.
- Fallback: `advisor_rules.py`, keyed on alert kind + measure + wind direction vs.
  the contact bearing + site geometry. Returns `source: 'rules'` and is
  deterministic. It knows industry cannot close a concern.
- Every failure path degrades: no key (55 ms), HTTP error, refusal, transport
  error (157 ms against an unresolvable host), malformed JSON, unexpected
  exception. **All verified.** `bootstrap.flags.advisor_mode` reports which mode
  is live.
- `ANTHROPIC_API_KEY` comes from `.env` via python-dotenv. `.env.example` carries
  an empty key.

## Demo scenarios (`POST /admin/simulate`)

Each writes **real rows** and lets the normal machinery produce the alerts, so the
effect propagates out of the SSE stream exactly as a field event would.

| Scenario | What it writes | What appears |
|---|---|---|
| `generator_test` | NO2 + BC hourly ramps on the fenceline monitor nearest bearing 095°, turbine bank set active, then re-evaluates those levels | exceedance + integrated + mobile_detection alerts; RWR contact at 095° |
| `concern_wave` | 6 concerns over 90 min jittered ≤240 m around one street SE of the site, `detect_cluster` after each | cluster forms at #3 and escalates to `warning`, RWR contact to the SE |
| `wind_shift` | 7 hourly `wind` rows veering 225°→025° and stabilising to class F, a held-high reading series on the now-downwind monitor, integrated levels re-evaluated | integrated_exposure alert, `wind_shift` alert, community advisory. Picks a `%School%` segment as the receptor when one exists |
| `methane_leak` | 4 `segment_pass` rows + `segment_stat` (`all` and today) on the segment with the **largest distance to any monitor** | `mobile_detection` CH4 alert stating the monitor gap, plain-language community notice. The leapfrog |
| `all_clear` | every monitor pushed under every threshold, mitigations → `completed`, clusters → `resolved`, concerns resolved **by the regulator**, advisories expired | all alerts resolved, pinned `all_clear` advisory |
| `model_divergence` | ~480 north-wind `mobile_wind_obs` over 5 days plus matching hourly `wind` rows, sized off the existing sample so the flip does not depend on fixture size | `/model-verification` flips `consistent` → `understates`, Boxtown surfaces as the under-weighted receptor (0.3 % assumed vs 23.6 % measured), and a `wind_shift` alert lands on the RWR at bearing 180° / 3.6 km — **placed at the receptor, not at the site**, because a contact at range 0 tells the operator nothing |

## Observed wind — "verify your consultant" (CONTRACT §8b)

Aclima's vehicles carry anemometers, so we hold *observed* street-level wind, not
just a model. That is the strongest argument for why industry should pay us: an
AERMOD study is only as good as the wind rose it assumed, and we can check it.

### Circular averaging — the thing that is silently, badly wrong if you get it wrong

A numeric mean of 350° and 10° is **180°**, the exact opposite of the truth.
Every direction average in `windfield.py` is the mean of unit vectors:

```
x̄ = mean(sin θ),  ȳ = mean(cos θ),  θ̄ = atan2(x̄, ȳ),  R = hypot(x̄, ȳ)
```

`R` (0–1) is the concentration, and `dir_sd = sqrt(-2 ln R)` in degrees (clamped
at 180°) is reported next to every averaged direction. Unit-tested: `[350, 10] →
0.00°`, `[358, 2, 6, 354] → 0.00°`, monotonic sd as spread widens, and bin edges
wrapping correctly at north (`348.8° → bin 0`, `348.7° → bin 15`).

**Convention:** `dir_deg` is meteorological everywhere — the direction the wind
comes **FROM**. Transport is `dir_deg + 180`. An understated rose bin at 000°
means the receptor to the **south** of the site is under-weighted. All wire
values are normalised to `[0, 360)` (rounding 359.97 to one decimal yields
360.0, which is out of range).

### `GET /wind/field` — the lattice

The particle overlay bilinearly samples this, so gaps and a drifting origin both
show as artefacts. Therefore:

- The lattice is **anchored on the bbox origin**, so cell centres are identical
  across requests and across time windows (verified).
- It is a **complete rectangle**: `len(cells) == nx * ny`, emitted **row-major**
  from the origin, so the client can index `cells[iy * nx + ix]` directly.
- Cells with observations carry `n > 0`. Empty cells are filled by
  inverse-distance weighting from the nearest observed cells (direction averaged
  circularly) and reported with **`n: 0`** — the UI is meant to fade those, not
  trust them. Where coverage is very thin the fill relaxes toward the regional
  hourly `wind` row and `source` becomes `blended`; with no observations at all
  it is `model`.
- Extra key **`grid`** (superset of `WindField`): `{origin_lon, origin_lat, dlon,
  dlat, nx, ny, order}`. Use this rather than differencing rounded cell centres.
- The lattice is capped at ~6000 cells by **coarsening** `cell_m`, never by
  truncating — a truncated lattice would tear.

### `GET /sites/{id}/model-verification` — the payoff

Everything is computed; nothing is hardcoded to a site, a model or an outcome.

| Output | How it is derived |
|---|---|
| `observed_wind` | 16-bin rose from `mobile_wind_obs` over the window. `freq` is a **percentage (0–100)**, the convention roses are labelled in, so `delta` is a straight difference in points |
| `model.assumed_wind` | the consultant's `assumed_wind_json`, re-binned onto the same 16 bins and rescaled to percent — it accepts any bin count and fractions or percentages |
| `bearing_bias` | per bin: `assumed_freq`, `observed_freq`, `delta = observed − assumed` |
| `understated_bearings` | bins where `delta ≥ 3.0` points **and** `observed ≥ 1.5 × assumed` **and** something populated is actually downwind |
| `affected_districts` | districts read off the road grid within ±22.5° of the transport bearing, out to 3.2 km, weighted by road length. Nothing about any neighbourhood is baked in |
| `disagreement` | share of observed hours in bins the rose under-weighted **and** the outer contour does not meaningfully reach (< 45 % of its own peak reach). Requiring **both** matters: a contour is only ever drawn where the assumed rose put the wind, so geometry alone would convict every well-built study of being narrow |
| `verdict` | `insufficient_data` if `n_obs < 150`; else `understates` if any understated bearing reaches a receptor; else `overstates` if the study spread probability over more sectors than the wind used (and materially so); else `consistent` |
| `summary` | generated from those numbers |

All four verdict paths are unit-tested against synthetic inputs, plus: zero
observations, a model with no contours on file, a narrow plume whose wind matches
it (must **not** be convicted — `disagreement == 0.0`), and divergence that
reaches nobody (stays `consistent`, and the summary says "in every direction that
has receptors downwind").

**We never overstate it.** A thin sample returns `insufficient_data` with the
count and the threshold in the summary, not a confident wrong answer.

### The advisor knows which way the wind is actually blowing

`POST /advisor` context now carries `observed_rose` (30-day climatology),
`measured_local_wind`, and `model_verification`. `measured_local_wind` is the
**most recent** window that still has a usable sample (6 h → 24 h → 72 h → 7 d,
minimum 12 observations, preferring within 1.5 km of the site) and reports
`window_h`, `n` and `dir_sd` — averaging a month that contains two wind regimes
reports a direction that never actually blew, which is a bug I hit and fixed. The
prompt tells the model to advise on the measurement and to say when the study
needs re-running, and explicitly not to claim the study is wrong when the verdict
is `insufficient_data`. The rules engine does the same thing deterministically.

## Deviations from CONTRACT §5

1. **Endpoints added** (marked † above): `GET /health`, `GET /mitigations`,
   `GET /enforcement`, `GET /vehicles`, `GET /wind/current`,
   `GET /drive-plan/{id}`, `GET /events/status`, `GET /admin/scenarios`. All
   additive reads the interfaces need; nothing in the contract changed.
2. **Router modules added** beyond the listed set: `bootstrap.py` (bootstrap,
   campaigns, boundary, activity, health), `wind.py`, `stats.py`. Jamming these
   into `admin.py`/`regulator.py` would have misfiled them.
3. **`GET /alerts?site_id=X`** returns alerts where `site_id = X` **or**
   `site_id IS NULL` and the alert has coordinates — not only alerts explicitly
   addressed to that site. An RWR that showed nothing but self-tagged alerts would
   be empty. Optional `radius_m` constrains the untagged ones.
4. **`GET /drive-plan`** defaults to `include_routes=false` (a 90-day × 5-vehicle
   plan is hundreds of full polylines). `GET /drive-plan/{id}` includes them.
5. **`POST /concerns` response** is the `Concern` plus `cluster` and
   `cluster_alert`, so the community UI can show "your report just formed a
   cluster" without a second fetch. Superset of `Concern`.
6. **`PUT`/`POST /action-levels` response** is the `ActionLevel` plus `evaluation`,
   `alerts` and `advisories`, so the regulator UI can show what the slider just
   caused. Superset of `ActionLevel`.
7. **`POST /mitigations` and `POST /posts`** return the object plus `post` /
   `concern_response`. Supersets.
8. **`POST /advisor`** adds `model` on the LLM path (`AdvisorReply` + one field).
9. **`PATCH /concerns/{id}`** takes the actor role from the body (`role`) or an
   `X-Air-Role` header. There is no auth in this prototype, so the role has to
   arrive somehow; both are honoured and both are enforced.
10. **`POST /admin/reseed`** does not generate data. `air.datagen` owns generation;
    this delegates to `datagen.reseed()`/`build()`/`main()` if importable and
    otherwise returns 503 with the CLI command to run. The server never fabricates
    a campaign.
11. **`POST /admin/campaigns/{id}/drive-plan`** uses a boustrophedon (serpentine)
    sweep, not the Chinese-postman routing datagen does. It is deterministic given
    `seed`, keeps each day's route spatially coherent, and is meant as the admin
    "regenerate with these knobs" control — not a replacement for datagen.
12. **`GET /feed`** includes the `reading` FeedItem variant (capped at the 5 most
    recent exceeding readings) in addition to the four the contract lists. Turn it
    off with `include_readings=false`.
13. **Timestamps** written by this server are `YYYY-MM-DDTHH:MM:SSZ` (UTC).
    Reads parse anything ISO-ish, so mismatched datagen output still works, but
    matching this format keeps lexicographic range queries exact.
14. **`GET /wind/field`** adds a `grid` key (lattice origin, step, `nx`/`ny`,
    ordering) beyond `WindField`. Superset; it saves the particle overlay from
    inferring the lattice from rounded coordinates.
15. **Rose `freq` is a percentage (0–100)**, not a 0–1 fraction, so
    `bearing_bias.delta` is "in points" exactly as `types.ts` documents. Both
    `observed_wind` and `assumed_wind` use the same scale. `disagreement` stays
    0–1 as its comment says.
16. **`GET /sites/{id}/model-verification`** returns 404 when the site has no
    dispersion model on file, with a structured `detail`. There is no meaningful
    empty verification.
17. **Two extra scenario helpers** are exposed for the Demo Director:
    `POST /admin/simulate` returns the computed verification inline for
    `model_divergence`, and `GET /admin/scenarios` now lists six scenarios.
18. **"Now"** for anything meaning *latest data* is `domain.data_now()` —
    `max(latest reading, latest pass, latest wind, campaign end, wall clock)` —
    because demo data is anchored to the campaign end date. Rows written by this
    server use wall clock.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `AIR_DB` | `data/air.db` | SQLite path; created from `schema.sql` if absent |
| `AIR_HOST` / `AIR_PORT` | `127.0.0.1` / `8000` | |
| `AIR_RELOAD` | `1` | uvicorn reload; `0` in production |
| `ANTHROPIC_API_KEY` | — | absent ⇒ advisor runs the rules engine |
| `AIR_ADVISOR_MODEL` | `claude-opus-5` | |
| `AIR_ADVISOR_TIMEOUT_S` | `45` | |
| `AIR_COMMUNITY_DELAY_MIN` | `180` | community fleet lag floor |
| `AIR_CLUSTER_RADIUS_M` / `_WINDOW_H` / `_MIN_COUNT` | `600` / `24` / `3` | cluster detection |
| `AIR_SEGMENT_LIMIT` | `4000` | default `/segments` cap |

Wind-verification thresholds live in `windfield.py` as module constants
(`MIN_OBS_FOR_VERDICT=150`, `MATERIAL_DELTA_PTS=3.0`, `MATERIAL_RATIO=1.5`,
`CONTOUR_SHORTFALL=0.45`) — every one of them is a plausible guess that should
stay tweakable, per CONTRACT §1.

CORS allows `localhost`/`127.0.0.1` on any port (covers Vite on 5173 and preview
on 4173). `web/dist` is served at `/` with an SPA fallback when it exists, so the
demo can run as a single process; when it doesn't, `/` returns a JSON pointer to
`/api/docs`.

## Testing fixture

`_smoketest_seed.py` writes **`data/air_smoketest.db`** — never `data/air.db`
(it refuses without `--force`), so it cannot clobber datagen's output.

```bash
uv run python -m air.server._smoketest_seed
AIR_DB=data/air_smoketest.db uv run air-server
```

1 campaign · 22 segments · 840 stat rows · 588 passes · 5 monitors · 5392 readings ·
3 sites · 7 emission points · 4 concerns · 1 cluster · 2 alerts · 7 action levels ·
337 wind rows · **882 mobile wind observations** · **1 dispersion model + 3 contours** ·
3 vehicles · 42 drives · 294 pings · 1 drive plan · 10 measures · 6 orgs · 9 users.

Two things the fixture does deliberately, because the demo depends on them:

- **Districts are latitude bands** — Boxtown south of the campus, Westwood level
  with it, Riverport north — so "downwind" means something geographically and a
  north wind really does carry Ridgeline's plume over Boxtown.
- **The consultant's assumed rose is derived from the fixture's own observed
  rose**, smoothed 85/15 toward flat and with the three north bins multiplied by
  0.18. So the study is broadly right and blind only to the north-wind days. The
  baseline verdict is therefore `consistent`, and `model_divergence` is what
  exposes it — rather than the fixture pre-loading the conclusion.

Its 22 segments sit on a coarse synthetic lattice (~1.7 km apart), so scenarios
that snap to "the nearest street" land further from their intended point than they
will against real OSM segments. That is a fixture limitation, not a server one.
