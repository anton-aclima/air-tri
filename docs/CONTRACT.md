# air — build contract

Every agent working on this repo reads this file first. It is the single source of
truth for the setting, the stack, the data model, the API surface, the design system,
and **who owns which files**. If you need to change something in here, say so in your
report — do not silently diverge.

---

## 1. What we are building

`air` is Aclima's flagship prototype: one React application with **four interfaces**
onto **one shared dataset**, one per audience. The product thesis is that Aclima sits
in the middle of a three-way standoff — **community**, **regulator**, **industry** —
and is the arbitrator of what the air is actually doing.

The demo succeeds if a viewer can **feel the tension**: an action taken in one
interface visibly lands in another. That is the point. Every feature should be judged
by whether it strengthens or dilutes that.

> **Correctness is not the goal. Look, feel, and narrative are.** All data is
> simulated. Thresholds, units, and health breakpoints are plausible guesses that
> must be *tweakable*, not accurate.

### The three cross-role loops (build these; they are the spine of the demo)

| # | Starts in | Travels to | Mechanism |
|---|-----------|-----------|-----------|
| 1 | **Community** files a concern | **Industry** RWR gets a new contact; **Regulator** gets it in the review queue | ≥3 concerns within 600 m / 24 h auto-form a `concern_cluster` → emits an `alert(kind='concern_cluster')` |
| 2 | **Regulator** trips an action level | **Industry** gets a threat bearing + recommendation; **Community** gets an advisory in the feed | `monitor_reading` or `segment_stat` crosses an `action_level` → `alert(kind='exceedance')` → `advisory` |
| 3 | **Industry** posts a mitigation | **Community** feed shows it under their concern; **Regulator** sees it attached to the alert | `mitigation` + `concern_response(kind='mitigation')` → community feed item. **Industry can never set a concern to `resolved`** — only `mitigation_proposed`. |

---

## 2. Setting

Real geography, **fictional actors**. Do not put invented words in a real
organization's mouth.

- **Place:** Southwest Memphis, Tennessee — the Boxtown / Westwood / Riverport corridor.
  Real OSM streets, real neighborhood names. Bbox `-90.190, 35.020 → -90.075, 35.115`;
  campaign boundary is a non-rectangular polygon inside it. Center ≈ `-90.132, 35.058`.
- **Campaign:** "Southwest Memphis Community Air Monitoring", active, 90 days of
  history, ends *today*. Fleet of 5 vehicles, target 25 passes/segment.
- **Actors (all fictional):**
  | Role | Org | Notes |
  |---|---|---|
  | industry | **Ridgeline Compute** — `Ridgeline South Campus` | AI datacenter, on-site gas turbines + diesel backup. The main emitter. |
  | industry | **Delta Forge Metals** | Secondary emitter, muddies attribution. |
  | industry | **Riverport Logistics** | Diesel truck traffic — the non-datacenter confounder. |
  | regulator | **Delta Regional Air Quality Authority (DRAQA)** | Operates the reference monitors. |
  | community | **Boxtown Air Watch** | Resident CBO. |
  | aclima | **Aclima** | Us. Real. |
- Every screen carries a persistent `SIMULATED DATA` marker. Non-negotiable.

---

## 3. Stack & layout

Node 22 (nvm) · Python 3.13 (uv). **`source dev/env.sh` before any command.**

```
air/
  dev/env.sh              PATH shim for non-interactive shells
  pyproject.toml          uv project: air.server + air.datagen
  data/air.db             the shared SQLite database (generated)
  data/cache/             OSM download cache (do not delete casually — it's slow)
  src/air/db/schema.sql   ← THE schema. Read it. Do not fork it.
  src/air/datagen/        simulation + seeding
  src/air/server/         FastAPI
  web/                    Vite + React 19 + TS
    src/design/tokens.css ← THE design tokens. Read them. Do not fork them.
    src/core/             api client, types, stores, formatting, scales
    src/components/       shared primitives + map + charts
    src/app/              shell, role rail, routing
    src/apps/{community,regulator,industry,admin}/
```

Frontend libs already installed: `@tanstack/react-query`, `@tanstack/react-router`,
`@tanstack/react-virtual`, `deck.gl` + `@deck.gl/{layers,react,mapbox,aggregation-layers}`,
`maplibre-gl`, `react-map-gl`, `d3-{scale,shape,array,interpolate,scale-chromatic,time-format,geo}`,
`zustand`, `clsx`, `date-fns`, fontsource Inter / JetBrains Mono / Instrument Sans.

**Styling:** CSS Modules (`*.module.css`) + tokens. No Tailwind, no CSS-in-JS.
**Routing:** code-based TanStack Router. Each app owns one `routes.tsx`; the root
assembles them. No file-based routing, no codegen.
**Server state:** TanStack Query only. **UI state:** one small zustand store.

### Running
```bash
source dev/env.sh
uv run air-datagen build      # generate + seed data/air.db  (slow, once)
uv run air-server             # FastAPI on :8000
cd web && npm run dev         # Vite on :5173, proxies /api → :8000
```

---

## 4. Data model

**`src/air/db/schema.sql` is authoritative.** Read it before writing any query.
Highlights:

- `road_segment` — a ~200 m piece of a real OSM way. **The atom of the product.**
- `segment_stat(segment_id, measure, window)` — `window` is `'all'`, `'date:YYYY-MM-DD'`,
  or `'hour:HH'` (diurnal). Carries `median/p10/p90/max`, `persistence` (0–1 share of
  passes over `measure_def.ref_level`), and `risk` (0–100, unitless, community-facing).
- `segment_pass` — raw per-traverse rows, modalities as columns.
- `measure_def` — the 7 modalities (`no2, pm25, bc, o3, co, co2, ch4`) plus indicators
  (`methane_leak, diesel, nondiesel`). Owns units, ref levels, risk breakpoints, ramps.
- `monitor` / `monitor_reading` — regulator "towers" (grade `reference`), industry
  fenceline rings (`lowcost`), hourly readings.
- `action_level` — regulator-editable thresholds. `kind='spike'` (instantaneous) or
  `'integrated'` (dose over `averaging_hours`).
- `concern` / `concern_response` / `concern_cluster` — community.
- `industry_site` / `emission_point` / `site_post` / `mitigation` — industry.
- `alert` (+ `alert_sample` for the sparkline, `alert_ack`) — **the shared bus.**
- `drive_plan` / `drive_route` / `drive` / `vehicle_ping` — fleet.
- `wind` — hourly speed/direction/stability, drives dispersion cones.
- `mobile_wind_obs` — wind measured by the fleet's anemometers (observed, not modelled).
- `dispersion_model` / `dispersion_model_contour` — a consultant's study, seeded wrong on
  purpose. See §8b.
- `activity` — append-only mutation log. Every write MUST append here; the SSE stream
  and the admin oversight view are built on it.

---

## 5. API contract  (`/api/v1`, FastAPI)

JSON, `snake_case` on the wire. Geo returns GeoJSON `FeatureCollection`.
All list endpoints accept `campaign_id` (defaults to the single active campaign).

### Read
```
GET  /bootstrap                     → { campaign, measures[], orgs[], users[], action_levels[], sites[], flags }
GET  /campaigns  /campaigns/{id}
GET  /campaigns/{id}/boundary       → GeoJSON

GET  /segments                      ← THE flagship endpoint
       ?measure=no2 &metric=median|p90|max|persistence|risk
       &window=all|date:YYYY-MM-DD|hour:HH  &bbox= &min_passes=
     → GeoJSON FeatureCollection, LineString features,
       properties: { id, name, road_class, value, persistence, risk, n_passes, length_m }
GET  /segments/{id}                 → detail + daily series + 24h diurnal + per-measure stats

GET  /monitors  /monitors/{id}
GET  /monitors/{id}/readings?measure=&from=&to=&interval=hour|day
GET  /concerns?status=&kind=&since=&near=lon,lat,radius_m  /concerns/{id}
GET  /clusters
GET  /sites  /sites/{id}
GET  /posts?site_id=&kind=
GET  /advisories
GET  /alerts?role=&status=&severity=&site_id=   (adds bearing_deg + distance_m when site_id given)
GET  /alerts/{id}                   → + samples[] + related concerns/mitigations
GET  /action-levels
GET  /feed?role=community           → merged, sorted: concerns + advisories + site_posts + mitigations
GET  /fleet?at=<iso>&delay_min=     → vehicle positions; community MUST pass delay_min≥180
GET  /drive-plan  /drive-plan/{id}/coverage
GET  /wind?from=&to=
GET  /wind/dispersion?site_id=&at=  → GeoJSON plume cone(s)
GET  /wind/mobile?from=&to=&bbox=&quality=  → MobileWindObs[]  (fleet anemometers)
GET  /wind/field?from=&to=&cell_m=          → WindField  (binned OBSERVED wind; feeds the particle overlay)
GET  /sites/{id}/dispersion-models           → DispersionModel[]
GET  /sites/{id}/model-verification?model_id=&from=&to=  → ModelVerification
GET  /stats/community?window=       → headline risk scores + trend + top streets
GET  /stats/campaign                → admin KPIs
GET  /activity?since=
```

### Write  (every one appends to `activity` and publishes to the SSE stream)
```
POST  /concerns                     { kind, severity, title, body, lon, lat, occurred_at, is_anonymous }
POST  /concerns/{id}/corroborate
POST  /concerns/{id}/responses      { role, kind, body }
PATCH /concerns/{id}                { status }        ← regulator/admin only; industry may NOT set 'resolved'
POST  /posts                        { site_id, kind, title, body, concern_id? }
POST  /mitigations                  { site_id, concern_id?, alert_id?, title, body, expected_reduction_pct }
POST  /advisories                   { kind, severity, title, body, measure?, alert_id?, audience[] }
POST  /alerts/{id}/acknowledge      { note }
PUT   /action-levels/{id}           full row; re-evaluates alerts immediately
POST  /action-levels
POST  /advisor                      { alert_id | question, site_id } → { recommendation, actions[], rationale, confidence }
POST  /admin/campaigns/{id}/drive-plan   { fleet_size, target_passes, shift_hours, seed } → regenerates
POST  /admin/reseed                 { seed? }
POST  /admin/simulate               { scenario } ← fires a scripted demo event (see §8)
```

### Live
```
GET  /events/stream                 Server-Sent Events over the `activity` log.
                                    event: activity | alert | concern | post | advisory | fleet
```
Every interface subscribes. This is how the tension becomes *visible* in a live demo.

---

## 6. Design system

**`web/src/design/tokens.css` is authoritative and already written.** Read it.

- Components reference **semantic** vars only (`--bg`, `--surface`, `--ink`, `--accent`,
  `--line`, `--sev-*`, `--ramp-map-*`). Never a raw hex. Never a `--c-*` primitive.
- The role skin is applied by the shell via `data-role` on a wrapper element. A
  component written correctly works in all four skins with zero changes.
- **Two measurement ramps, never mixed:** `--ramp-aqi-*` for public/health/risk framing,
  `--ramp-intensity-*` for analytical magnitude. `--ramp-map-*` is the per-role alias
  the road grid uses.
- All numerals: `font-family: var(--font-mono); font-variant-numeric: tabular-nums;`
- Uppercase micro-labels use `--text-3xs` / `--tracking-caps`.

### The four visual narratives — hold these lines

The narrative column is **visual direction for whoever styles the room, never copy.**
The owner's review (2026-09-23) found the metaphors printed on screen and built into
panels — "tower defence" on the Landing page, CAUTION / SLEW TO / CONTACTS on the
industry deck, a radar dial duplicating the map — and called it "too literal". A
metaphor is a feel: palette, type, corner radius, restraint. It is not vocabulary and
it is not a component list. See the "never in copy" rule in §10a.

| Role | Visual direction (never copy) | It must feel like | It must NOT feel like |
|---|---|---|---|
| **community** | social feed | Warm paper, big cards, faces, plain words, one obvious button: *Report a concern*. Unitless risk scores, never "µg/m³". | a dashboard, a science tool, government |
| **regulator** | tower defence | One map that answers three questions in order: what the **reference monitors** report, what the **fleet** adds on every street between them (with each site's modelled plume as an outline), and where **residents** are reporting. Dense, precise, exact concentrations. | a consumer app, or a game |
| **industry** | avionics (finish only) | A map that tells the operator's story on its own — measured streets, the site's own fenceline road, the wind, today's plume as an outline — beside one line saying how hard they can run. Mono numerals, a phosphor accent, square corners. Glanceable. | a cockpit to be operated; an analytics product |
| **admin** | drafting table | Blueprint grid, draw handles, numeric readouts, generation controls with visible parameters, everything-visible oversight. | polished marketing |

---

## 7. File ownership (parallel agents — do not cross these lines)

| Owner | Owns | May read |
|---|---|---|
| datagen | `src/air/datagen/**`, `data/**` | schema, contract |
| backend | `src/air/server/**` | schema, contract |
| shell | `web/src/app/**`, `web/src/core/**`, `web/src/main.tsx`, `web/index.html`, `web/vite.config.ts`, `web/src/design/*.css` (except tokens.css) | everything |
| mapviz | `web/src/components/**` | everything |
| community | `web/src/apps/community/**` | everything |
| regulator | `web/src/apps/regulator/**` | everything |
| industry | `web/src/apps/industry/**` | everything |
| admin | `web/src/apps/admin/**` | everything |

**Nobody but the orchestrator edits:** `web/package.json`, `pyproject.toml`,
`src/air/db/schema.sql`, `web/src/design/tokens.css`, `docs/**`.
Need a new dependency or a token? Say so in your report. Do not add it yourself.

---

## 8. Scripted demo scenarios (`POST /admin/simulate`)

The admin interface has a **Demo Director** panel that fires these. They exist so a
salesperson can produce the tension on cue.

1. `generator_test` — Ridgeline runs a turbine test. NO2 + BC spike on the east
   fenceline monitor → exceedance alert → industry RWR contact at bearing ~095°.
2. `concern_wave` — 6 residents file smell/noise concerns in Boxtown over 90 min →
   cluster forms → industry RWR gets a community contact to the **north-east (~055°)**.
   (Corrected: Ridgeline sits SW of Boxtown so the prevailing SW wind carries its plume
   over the community. That geometry puts the community NE of the campus, not SE as
   this spec originally said. **Compute every bearing from geometry — never hardcode
   one.** `generator_test`'s east fenceline at 095° is correct as written.)
3. `wind_shift` — wind veers from SW to NNE, carrying the plume over the school →
   regulator integrated-exposure alert, community advisory.
4. `methane_leak` — mobile monitoring finds a CH4 anomaly the stationary network
   cannot see. **This is the "leapfrog" moment** — the whole Aclima value prop.
5. `all_clear` — mitigation completes, levels fall, advisories close.
6. `model_divergence` — a run of north-wind days pushes observed transport away from the
   consultant's assumed rose, so `GET /sites/{id}/model-verification` flips to
   `understates` and Boxtown appears as an under-weighted receptor.

---

## 8b. Wind — the visual, and "verify your consultant"  (ORIGIN_PROMPT.md line 93)

### The visual reference: earth.nullschool.net

The user's favourite wind visualisation, and the target for ours. Its signature is
**particle advection**: thousands of tiny particles carried along the vector field,
each leaving a short fading trail, over a dark ground with a colour-mapped scalar
underneath. Implement it as a canvas overlay, not as deck.gl geometry:

- Seed N particles (start ~3–6k, tune for frame rate) at random positions in view.
- Each frame, bilinearly sample the wind field at each particle, step it by
  `v * dt`, and stroke a 1px line from its old position to its new one.
- Get trails by **not clearing the canvas** — instead fill it each frame with the
  background colour at low alpha (~0.92 keep). That decay *is* the trail.
- Re-seed particles that leave the view or exceed a max age, so density stays even.
- Colour particles by speed through the role ramp; keep them thin and numerous rather
  than thick and few. Restraint is what makes nullschool look good.
- Honour `prefers-reduced-motion`: render a static streamline field instead.

**Use it in two places:**
1. **Regulator map** — the campaign-wide field, so dispersion is legible as motion.
2. **Industry map** — particles flowing across the operator's own streets, on by default,
   so the wind visibly carries the site's plume toward whatever it reaches.

*Retired 2026-09-23 (owner decision D8):* the industry RWR — a radial scope beside the
map. It drew the same bearings the map already drew, as a second geometry that had to
agree with the first, and the owner judged the map could tell the story alone. Do not
rebuild the dial.

### Verify your consultant

Aclima's vehicles carry anemometers, so we hold **observed street-level wind**, not just
a model. Industry buys expensive AERMOD/CALPUFF studies, and those studies are only as
good as the wind rose they assumed. `air` lets an operator check that — and it is the
strongest single argument for why they should pay us.

- `mobile_wind_obs` — per-observation fleet anemometry with an honest `quality` flag
  (anemometry from a moving platform is noisy; the UI must let you filter, not hide).
- `dispersion_model` + `dispersion_model_contour` — the consultant's deliverable, seeded
  **deliberately imperfect**: it assumes an idealised rose that under-weights the
  north-wind days that actually carry Ridgeline's plume over Boxtown.
- `GET /sites/{id}/model-verification` returns assumed vs observed rose, per-bearing
  bias, understated bearings, under-weighted districts, and a `verdict`.

Draw the consultant's contour as a dotted reference outline **on the industry map**,
**off by default** behind "Compare with filed study" (owner decision D9: verify your
consultant is a supporting visual, not the headline), with the observed particle field
flowing over it, so the divergence is something you see rather than read. It must be
distinguishable from the model's "beyond measurement range" dashes before any label is
read (§10b).

Never overstate it. Where `n_obs` is low or `dir_sd` is high, say so — our whole premise
is that we are the trustworthy measurement, so fake confidence is off-brand.

---

## 9. Non-negotiables

1. `SIMULATED DATA` marker visible in every interface.
2. The road grid — segments coloured by magnitude and/or persistence — is the hero
   visual in every interface that shows a map. Not hexbins. Not points.
3. Community language contains **no units and no acronyms**. `measure_def.plain_name`
   exists for exactly this.
4. Industry cannot close a community concern. Only propose mitigation.
5. Community fleet positions are delayed ≥3 h. Regulator and admin see live.
6. Everything a demo-giver might want to tweak (thresholds, ramps, fleet size, passes,
   delay, risk breakpoints) is editable in the admin interface or `measure_def`.

---

## 10. Model vs. measurement — the honesty rules

The programme in `docs/PLAN-plume.md` puts a *modelled* plume next to a *measured*
one in all four interfaces. That is the product's best story and its sharpest
hazard: the modelled shape is bigger, smoother and more confident-looking than
the measurement, and a reader will assume the impressive layer is the real one.

Everything below is a hard rule, not a caption. **Captions get edited away in two
sprints.** These are enforced by the data flow, the encoding channel, and the
never-say list — in that order of reliability.

This section is inherited the way non-negotiable 4 is: an agent working on one
interface holds all of it, not the part that touches their screen.

### 10a. The never-say list

Never, in any interface, in any copy, in any generated summary:

1. Never call a modelled value **measured**, **observed**, **detected**, **found**,
   or **recorded**. A model is `modelled`, `assumed`, `predicted` or `filed`.
2. Never state a **touchdown**, an **excess** or an **exceedance** at a location the
   fleet has not driven. "We do not know" is a shippable answer; it is in fact
   the answer that sells the fleet.
3. Never attribute a concentration, a smell or a health effect **to a named site**
   on proximity alone. Attribution requires the wind to have carried from it,
   and it must survive the placebo gate (10c).
4. Never print a confidence interval, a p-value or a sample size for a stratum
   that failed the placebo gate. Return `insufficient_data` and say so.
5. Never present the Pasquill class coercion (`stability_coerced_from`) as an
   explanation for plume size. It is a guard against impossible *inputs*, and
   the states it guards against do not occur in this dataset.
6. Community language additionally drops every one of the above words that is
   an acronym, a unit or chemistry (non-negotiable 3 still applies on top).
7. **Never print a design metaphor as copy.** Not in labels, headings, captions,
   nav, tooltips, generated advisor text or alert copy: *tower defence, tripwire,
   armed, invader, suspected emitter, contact(s), scope, radar, RWR, MFD, slew,
   lock / lock-on, flight deck, watchfloor, drafting table, annunciator words*
   (CAUTION / ADVISORY / NORMAL as a status). Severity has one vocabulary in every
   room: **Critical / Warning / Watch**. The monitors are **reference monitors**;
   the tower glyph may stay on the map. (Owner review, 2026-09-23.)

### 10b. The encoding rule — epistemic status is a rendering channel

Three shapes end up on one map. They must be distinguishable **before any label
is read**, because a translucent blob over a translucent blob is mud and the
reader resolves mud in favour of whichever layer looks most authoritative.

| what it is | how it is drawn |
| --- | --- |
| filed / permit model | **dotted** outline (`[1.5, 3]`) in its own colour (`--accent-2`), **no fill** — never the same pattern as "beyond" |
| Aclima model | solid hairline outline + a fainter centreline axis with a reach tick at the envelope, **no fill** |
| measurement | the **only** filled or inked thing on the map — road segments, per non-negotiable 2. A report or alert mark is filled only when the site-naming rule (below) links it; otherwise hollow |
| anything beyond the detection envelope | **dashed** (`[6, 4]`), no fill, plus the legend line **"beyond measurement range — model only"**. Nothing is judged from this part: a monitor under it is not "downwind" |

The filed study and "beyond" used to share one dashed style, so on the industry map
the consultant's contour and the model's own far field differed only by colour
(2026-09-23 re-check). The stroke table lives in one place, `PLUME_STROKE` in
`web/src/components/lib/vizmeta.ts`, and the legend swatches read it.

**Naming a site** (owner decision D7): a report, cluster or alert is linked to a named
site only when the wind at the time carried from the site to it **and** the site's
placebo-checked downwind test for that pollutant is `elevated_downwind`. Noise,
vibration and light reports are never linked by an air test.
| anything outside the driven-coverage mask | dimmed or hatched, and excluded from every agreement metric |

A model plume from Ridgeline at 10 km covers 96.7% of the road grid. Without the
register change, enlarging the plume turns every model-vs-measurement picture
into a picture of the campaign boundary.

### 10c. The placebo gate

Any claim of the form "the air is worse downwind of this site" must be
re-computed with the transport bearing rotated +90°, +180° and +270°. If the
placebo magnitude comes within 2× of the true-bearing magnitude, **the stratum is
not reportable** and the API returns `insufficient_data`.

This is not paranoia. Measured in this dataset: a fabricated bearing returned
**+32.99 ppb** against **−12.27 ppb** at the true bearing, in the same stratum.
An estimator that produces tight, multi-ppb detections for wind directions that
never occurred is measuring road-class composition and diurnal traffic, not a
plume.

### 10d. Ground-truth containment, stated as data flow

The dispersion kernel (`air.dispersion`) is imported by both the generator and
the server. That is deliberate — one kernel is the only arrangement in which the
drawn cone and the simulated truth cannot drift apart — and it means an import
ban is the wrong control. State it as data flow instead:

> **No value derived from evaluating a dispersion kernel at a receptor may be
> labelled measured, served under a touchdown path, or drawn in the measured
> register — whichever package computed it.**

Corollaries: `air.dispersion` imports neither `air.datagen` nor `air.server`
(there is a test); `/sites/{id}/touchdown` reads only `segment_pass`,
`mobile_wind_obs`, `wind`, `monitor_reading` and `concern`; and a measured
payload never carries a field the kernel produced.
