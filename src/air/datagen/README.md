# `air.datagen` — the physical data simulation

Generates `data/air.db`: a deterministic, believable 90-day hyperlocal air-quality
campaign over **real Southwest Memphis road geometry**.

```bash
source dev/env.sh
uv run air-datagen build            # or: python -m air.datagen.build build
uv run air-datagen build --fresh --seed 7
uv run air-datagen drive-plan --fleet-size 4 --target-passes 30
```

Full build: **~68 s**, **~95 MB**. Idempotent — every physical table is dropped and
rewritten. `--fresh` also drops the narrative tables.

---

## The model in one paragraph

Nothing assigns a value to a road segment. A **continuous spatio-temporal field** is
built per hour over the whole campaign, and the drive samples it. That is why the map
shows plumes, corridors and gradients instead of confetti: two segments 80 m apart
read the same field, not two independent random numbers. Terrain-generation logic,
applied to atmospheric chemistry.

```
osm.py ──► world.py ──► network.py ──► driveplan.py ──┐
   (cache)   (sites,      (1307 x ~200 m   (Chinese     │
             monitors,     segments,        Postman)    │
             boundary)     drive graph)                 ▼
weather.py ──► field.py ──────────────────────────► simulate.py ──► stats.py
 (hourly wind,  (5-layer concentration field)      (passes +        (segment_stat)
  Pasquill,      sampled at segment midpoints       monitor
  PBL)           and monitor locations)             readings)
                                                          │
                            mobilewind.py ◄────────────────┘
                        (street-level anemometry +
                         the consultant's wrong study)
                                     │
                                 build.py  ──► narrative.seed(conn, ctx)
```

---

## Module map

| Module | Does |
|---|---|
| `osm.py` | Overpass download + parse. **Caches to `data/cache/`; never re-fetches.** Rejects stale mirror responses (`min_elements`). |
| `geo.py` | Local metre projection, polyline slicing, point-in-polygon, raster morphology, Moore boundary tracing, Douglas–Peucker, Chaikin. Builds the concave hull. |
| `noise.py` | Deterministic value noise / fBm / ridged fBm on numpy grids, box blur, bilinear sampling. Pure functions of (coords, seed) — no global RNG. |
| `world.py` | Campaign, boundary, orgs, personas, 3 industry sites on real parcels, 21 emission points, 13 monitors, 5 vehicles, 5 methane leaks. |
| `measures.py` | `measure_def` (10 measures) and default `action_level` rows. |
| `network.py` | Way splitting at intersections → ~200 m segments → boundary clip → district labels → drive graph + virtual connectors. |
| `weather.py` | 2160 hourly wind rows: prevailing S/SW, synoptic regimes, calm nights, Pasquill A–F, PBL, and the scripted `wind_shift` episode. |
| `field.py` | **The concentration field.** Five layers, seven modalities, three indicators. |
| `driveplan.py` | Route inspection (Rural Postman): balanced k-means → component join → odd-node matching → Hierholzer → shift-truncated walk. |
| `simulate.py` | `segment_pass`, `monitor_reading`, `drive`, `drive_route`, `vehicle_ping`, vehicle status. |
| `stats.py` | `segment_stat` for `all` / `date:*` / `hour:HH`; the reference `risk_from_scale`. |
| `mobilewind.py` | `mobile_wind_obs` + `dispersion_model` / `_contour`. |
| `build.py` | Orchestration, CLI, summary table, and the **narrative seam** (its docstring is the `ctx` contract). |

---

## The five field layers (`field.py`)

1. **Regional background** — low-frequency fBm in (x, y, day), evaluated at 64² and
   upsampled because it is smooth by design. Noise coordinates are offset by a
   *cumulative advection distance*, so the airmass physically drifts with the wind.
2. **Point-source plumes** — a Briggs open-country Gaussian plume per
   `emission_point`: Pasquill-dependent σy/σz, buoyant rise, ground reflection,
   boundary-layer trapping, low-wind meander, a virtual-source offset (`SIGMA_X0`)
   for initial spread, and an isotropic campus-scale near field (`NEAR_Q`,
   `NEAR_SIGMA_M`) because a 1.1 km² site is an *area* source, not a point.
   Evaluated on a downwind sub-window, not the whole raster — that is the speed win.
3. **Line sources** — traffic splatted from the real network weighted by OSM class,
   with a rush-hour double peak, a separate heavy-duty raster for BC, and a
   tight/wide blur blend driven by wind speed and stability.
4. **Micro-scale noise** — static high-frequency fBm (local geometry does not move)
   with a slow seasonal wobble.
5. **Chemistry** — see below.

### Measure-specific behaviour

| Measure | Behaviour |
|---|---|
| `no2` | Combustion + traffic, twin diurnal peaks, suppressed on sunny afternoons (`NO2_PHOTOLYSIS`), amplified under a collapsed nocturnal PBL. |
| `o3` | Regional, peaks mid-afternoon, near zero at night, **destroyed by local NOx** (`O3_TITRATION`). Episode amplitude is tied to temperature and insolation, so exceedances land on hot stagnant days. |
| `pm25` | Regional haze floor × nocturnal trapping + local combustion + fugitive industry, plus scripted regional smoke episodes (`HAZE_EPISODES`). |
| `bc` | Diesel only: heavy-duty line source with the tightest blur + diesel point sources. Sharpest gradients in the dataset. |
| `co` / `co2` | Combustion tracers; CO2 has a clear ~419 ppm floor plus night biogenic respiration. |
| `ch4` | Flat ~1.93 ppm background punctuated by five **discrete, tight leak hotspots**. The Boxtown distribution main grows 2.3× across the campaign and no reference monitor measures CH4 — that is the leapfrog story. |
| `diesel` | `2.25·√(BC_excess · NO2_excess / 12)` — high only where both are elevated together. |
| `nondiesel` | `pm25 − diesel`. |
| `methane_leak` | `ch4 − 1.928`. |

Indicators are derived **after** sampling, from the *noisy* modalities, exactly as a
real pipeline derives them from calibrated measurements.

### Evolution across the 90 days

The field is never reused. It changes hourly through the wind, daily through the
background fBm and synoptic weather, and across months through `LOAD_RAMP`
(Ridgeline 0.74 → 1.00 as Phase-2 turbines come online) and leak growth.

---

## Tunable knobs

### `field.py`
| Knob | Default | Effect |
|---|---|---|
| `GRID_N` | 256 | Raster cells per side (~46 m/cell). Cost scales as N². |
| `PAD_M` | 1500 | Padding around the bbox so plumes do not clip. |
| `BG_NOX_PPB` / `BG_O3_PPB` / `BG_HAZE` / `BG_CH4_PPM` | — | `(floor, span)` of each regional background. |
| `CO2_FLOOR_PPM` | 419 | Global CO2 baseline. |
| `HAZE_EPISODES` | 2 episodes | `(centre_day, sigma_days, multiplier)` regional smoke. Drives PM2.5 24-h exceedances. |
| `K_PT_*` | — | Point-source coupling per measure. Raise for hotter sites. |
| `K_TR_*` | — | Traffic line-source coupling per measure. |
| `NEAR_Q`, `NEAR_SIGMA_M` | 1.0e-4, 640 m | Campus-scale near field. **The main lever on how big the hotspot around a site is.** |
| `SIGMA_X0` | 115 m | Virtual-source offset. Larger = fatter near-field lobe. |
| `MICRO` | per measure | Micro-scale noise amplitude. |
| `O3_TITRATION` | 1.90 | ppb O3 destroyed per ppb NO2 excess. >1 because the titrating agent is NO. |
| `NO2_PHOTOLYSIS` | 0.26 | Afternoon NO2 suppression at peak sun. |
| `NIGHT_TRAP_REF_M` | 620 | PBL height at which nocturnal trapping = 1.0. |
| `LOAD_RAMP` | (0.74, 1.00) | Ridgeline load across the campaign. |

### `weather.py`
`PREVAILING_DEG` 208 · `DIR_SPREAD_DEG` 74 · `SHIFT_START_DAY_FROM_END` 27 ·
`SHIFT_DAYS` 4 · `SHIFT_FROM_DEG` 205 · `SHIFT_TO_DEG` 380 (unwrapped → 020).

### `driveplan.py`
| Knob | Default | Effect |
|---|---|---|
| `SHIFT_HOURS` | 5.0 | Productive time budget per vehicle-shift. |
| `STOP_FACTOR` | 0.72 | Fraction of the class speed limit actually achieved. |
| `PHASE1_VEHICLES` / `PHASE1_DOUBLE_EVERY` | 1 / 3 | Cars per drive day before target is met. |
| `PHASE2_VEHICLES` / `PHASE2_EVERY` | 1 / 3 | Maintenance sampling after target. |
| `SPRINT_DAYS` / `SPRINT_VEHICLES` | 6 / 3 | End-of-campaign gap-fill push. |
| `TODAY_VEHICLES` | 4 | Cars out on the final (partial) day. |
| `COVERAGE_GOAL` | 0.90 | Share of segments that must reach `target_passes`. |
| `OFF_WEEK_MODULO` / `_INDEX` | 4 / 3 | One week in four the fleet is on another community. |
| `SHIFT_CYCLE` | 8 entries | Rotates each car through morning/midday/evening/night. |
| `PING_*` | 10 s / 40 s / 5 d | GPS cadence stored recent vs old. |

**Why so few cars per day.** The campaign holds 196 km of drivable public road. Five
cars at ~100 km/day would hit 25 passes/segment in eleven days, which is not what a
90-day campaign looks like. A real Aclima fleet is shared across communities, so this
one gets 1–3 cars on a given drive day. Raise `PHASE1_VEHICLES` for a denser dataset
— it costs roughly 2 MB of database per extra pass/segment.

### `stats.py`
`MIN_PASSES_DATE` 2 · `MIN_PASSES_HOUR` 4 — a per-day or per-hour statistic from one
or two passes is degenerate (median == p10 == p90 == max) and was ~30 % of
`segment_stat`. The `all` window is always written, so no segment is ever missing
from the map.

### `mobilewind.py`
`CANYON` (per road class) · `CANYON_DRAG` 0.34 · `WAKE_RADIUS_M` 450 ·
`SCATTER_CALM_DEG` 34 · `CALM_SUSPECT_MS` 1.3 · `FAST_SUSPECT_KPH` 52 ·
`DECIMATE` 2 · `ASSUMED_ROTATE_DEG` −24 · `NORTH_SUPPRESS` 0.34.

---

## Geography and why the sites sit where they do

Real OSM: 521 drivable ways, 222 km, 127 `landuse=industrial` parcels, 8 real place
nodes (Boxtown, Westwood, White Chapel, Darwin, Pisgah Heights, Goodman, Wyanoke,
President's Island). Companies are fictional; the land they occupy is real.

With the prevailing wind from the S/SW, transport is toward the NNE, so
**Ridgeline South Campus** sits on the riverfront industrial parcel *south-west* of
Boxtown: on a typical day its plume lands on the community. As the wind backs through
W and NW the plume sweeps clockwise — Boxtown (055°) → White Chapel (060°) →
Westwood (096°) → Darwin (120°) → Goodman (118°). **Delta Forge Metals** is due north
of Boxtown and **Riverport Logistics** north-east, so on north-wind days the community
is hit by a *different* source. That ambiguity is the attribution story.

The nearest reference monitor is **3.7 km** from the Ridgeline fence. That sparseness
is the argument for mobile monitoring.

The campaign **boundary** is a concave hull: rasterise the road network + the three
industrial parcels, morphologically close, keep the largest blob, fill holes, trace
the outline, simplify, round the corners. 300 vertices, 51.9 km² inside a 110 km²
bbox — non-rectangular, and it follows the streets.

---

## Verify-your-consultant (CONTRACT §8b)

`mobile_wind_obs` is **observed street-level** wind, not a copy of the regional row:
flow turns toward the street axis and slows (canyon), is braked and veered near large
industrial parcels (building wake), and scatters as ~1/u when calm. `quality` is
honest — `suspect` when calm or when the vehicle was fast.

`dispersion_model` is seeded deliberately wrong in a specific, defensible way: the
assumed rose is the true rose **rotated −24°**, with the northern half multiplied by
`NORTH_SUPPRESS = 0.34`, then smoothed (a single-winter-quarter off-site record).
Contours are then computed **from that assumed rose** using the same plume physics as
`field.py`, so the polygons genuinely follow the assumed wind and genuinely disagree
with what the fleet measured. Nothing is hardcoded — recompute the observed rose from
`mobile_wind_obs` and the mismatch is in the numbers.

The decimation of `mobile_wind_obs` is deliberately **uniform in time**: an
episode-weighted sample would inflate the observed northerly frequency and the
divergence has to come from the study's distortion, not from how rows were stored.

---

## Determinism

Everything is a pure function of `(seed, now)`. `--now ISO` pins the build for
reproducible output. Noise is positional (hash of lattice coordinates), so any hour
can be evaluated without generating the hours before it. `now` is recorded in
`setting('datagen.now')`; today's shifts are anchored to it so the fleet layer is
alive the moment the database is built.

---

## Extending

Adding a **measured** thing means: a row in `_MEASURES` in `measures.py`, a term in
`field._compose`, a column in `simulate.MOBILE_NOISE`, and the schema column — which
datagen does not own, so ask the orchestrator first.

Adding a **derived** thing costs none of those four. `aclima_sense` is the first one:
a row in `_COMPOSITES` (`family='composite'`, so `MODALITIES`/`INDICATORS` exclude it
and `simulate` never looks for a column that isn't there), plus a column appended to
the stats matrix in `stats.py`. Nothing drives it, no instrument reads it, and it has
no `segment_pass` column — it is computed from three columns that do.

Two things to know before writing another one. It must be computed inside
`build_segment_stats`, not in `build.py`: both write sites — `build_world` and
`regenerate_drive_plan`, which backs `POST /admin/campaigns/{id}/drive-plan` — blind-insert
whatever that function returns, so anything added in `build.py` is silently missing
after a drive-plan regeneration. And builds run with `PRAGMA foreign_keys = OFF`
(`db.py`), so a typo'd measure code inserts cleanly, orphans, and shows up only as a
blank map layer with no error — share the code literal, never retype it, and count the
rows after the build rather than trusting the map.

The narrative layer hooks in at `air.datagen.narrative.seed(conn, ctx)`. The `ctx`
contract is documented in full in the `build.py` module docstring. It is the
authority; read it there.
