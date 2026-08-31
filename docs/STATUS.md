# air — build status  (paused 2026-08-27)

Paused mid-Wave-1 for quota. Everything below is on disk. `npx tsc --noEmit` is
**clean**; the backend has been run and curled; the frontend shell renders.

Read `docs/CONTRACT.md` first — it is still the authoritative spec and has not drifted.

---

## Toolchain (this was a bare laptop — nothing was installed)

- **Node 22.23.2** via nvm (`~/.nvm`). **Python 3.13.15** via uv (`~/.local/bin`).
- Homebrew was rejected as an option: this account is **not in the admin group** on an
  MDM-managed Mac, so `sudo` is unavailable and a `/opt/homebrew` install cannot work.
  uv gives a standalone CPython with no sudo. Don't retry brew.
- **`source dev/env.sh` before any command** — nvm does not load in non-interactive shells.
- Headless Chrome **does** render WebGL here (ANGLE Metal, M1 Pro). Do **not** pass
  `--disable-gpu` — that is what disables it. Use:
  `--headless=new --no-sandbox --virtual-time-budget=8000 --screenshot=<p> --window-size=1600,1000 <url>`

## Decisions made with the user

| Decision | Choice |
|---|---|
| Setting | **Memphis / Boxtown** — real OSM geometry + real neighbourhood names, **fictional actors** (Ridgeline Compute, Delta Forge Metals, Riverport Logistics, DRAQA, Boxtown Air Watch) |
| Basemap | **Google Maps** primary (user supplies key). One `<BaseMap>` adapter, MapLibre backend auto-selected when `VITE_GOOGLE_MAPS_API_KEY` is absent, so it renders today |
| Industry advisor | **Real Claude call**, degrading to `advisor_rules.py` when `ANTHROPIC_API_KEY` is missing or the call fails |

---

## Done

**Orchestrator-owned (frozen — agents must not edit):**
`src/air/db/schema.sql` (32 tables) · `web/src/design/tokens.css` (4 role themes, 2
measurement ramps) · `web/src/core/types.ts` (599 lines of wire types) ·
`docs/CONTRACT.md` · `README.md` · `.env.example` + `web/.env.example` · `.gitignore` ·
`pyproject.toml` console scripts · `dev/env.sh`

**datagen** — `world.py` (861 lines: orgs, 18 personas, 3 sites with emission points
ray-cast onto real `landuse=industrial` parcels, monitors, vehicles, campaign boundary),
`osm.py` + caches in `data/cache/` (roads, industrial, places), `network.py`,
`field.py`, `driveplan.py`, `simulate.py`, `stats.py`, `weather.py`, `noise.py`,
`geo.py`, `measures.py`, `db.py`.

**backend** — complete and self-verified: `app.py`, `__main__.py`, `domain.py`,
`loaders.py`, `shapes.py`, `sim.py` (5 scenarios), `advisor_rules.py`, `bus.py` (SSE),
`cache.py`, and all 14 routers (bootstrap, segments, monitors, concerns, sites, alerts,
fleet, regulator, stats, feed, wind, events, advisor, admin). `_smoketest_seed.py`
produces `data/air_smoketest.db` (1.5 MB) and the agent curled the endpoints against it.

**shell / core** — `main.tsx`, `router.tsx`, `vite.config.ts`, `index.html`,
`design/base.css`, `design/primitives.module.css`, full `core/` (api, queries, live,
measures, format, roles, session, util), `app/` (AppShell, Landing, RoleSwitcher,
SimulatedBadge, TimeCursor, Toasts, route-root, NotFound, ui/*), and four minimal
`apps/*/routes.tsx` placeholders. Screenshots in the scratchpad `shots/`.

**map / viz** — `BaseMap.tsx` + both backends (Google, MapLibre) + `MapContext`,
all 8 deck.gl layers (Segment, Monitor, Site, Concern, Fleet, Wind, Boundary, DrivePlan),
furniture (MapLegend, Pickers, LayerToggles, MapScale, NorthCompass, MapTooltip),
`mapStyles.ts` (4 skins), and 7 charts (TimeSeries, DiurnalClock, RadarScope, RiskDial,
Gauge, Sparkline, Distribution, SeasonalStrip) + fixtures.

---

## Remaining — resume here

Updated after the fourth quota interruption. `npx tsc --noEmit` is **clean**.
Agent transcripts have survived every resume **within this session** via `SendMessage`;
across a session boundary, spawn fresh agents from this list. CONTRACT.md §7 ownership
still applies and still prevents collisions.

### DONE and verified

**`data/air.db` — 90 MB, real.** 1,307 segments (195.9 km, 7 real districts), 56,889
passes, **95.56 %** of segments at >=25 passes, mean 45 (min 23, max 153), 88 drives /
59 drive days, 97.8 km per vehicle-day. Built in 69 s by `uv run air-datagen build --fresh`.
- Physics verified: NO2 near Ridgeline's generators **2.31x** campaign median overall,
  **3.86x** at 03:00; O3 **0.54x** at night (trapped under a 180 m boundary layer) vs
  0.85x mid-afternoon. Decays to background by 1.5 km.
- Model divergence is **derivable, not asserted**: north-half wind assumed 2.35 % vs
  measured 6.45 %; inside the wind-shift episode, 48.4 % (~20x assumed). Boxtown 0.3 %
  assumed vs 23.6 % measured. Observation decimation is uniform in time on purpose --
  episode-weighting would have manufactured the result.
- **No reference monitor measures BC, diesel or CH4** -- those action levels are
  unreachable by the stationary network. The leapfrog argument is a property of the data.

**Backend -- complete, 49 routes.** All of CONTRACT §5 + §8b, three cross-role loops, SSE
(310 frames verified, replay via `?since=`/`Last-Event-ID`), six scenarios. Verified
field-by-field against `types.ts` for 33 interfaces. `/segments` at 1,400 segments:
**46 ms cold / 4.2 ms warm**, p95 33 ms at 12-way concurrency. Circular wind mean
verified (`[350,10] -> 0.00°`, not 180°). `claude-api` skill was invoked; advisor
degrades to rules in 55 ms with no key, 157 ms on an unreachable host.
Six real bugs found and fixed -- see `src/air/server/README.md`.

**Shell + core -- complete.** Landing, four distinct role chromes, RoleSwitcher (Cmd-K),
TimeCursor, Toasts, LivePulse, 20+ primitives, full typed API client + query hooks +
SSE invalidation. Contract rules enforced once in core (community fleet delay >=180 min;
industry cannot resolve a concern).

### IN FLIGHT -- resume these  (paused at 98% quota)

**Resume order is set: Industry -> Community -> Regulator -> Admin.** User chose this so
that if budget runs out after two, the pivot story still demos end-to-end (operator +
residents). Run **two agents at a time**, not four.

**Cost control already applied -- keep using it:**
- `docs/UI-BRIEF.md` (125 lines) replaces CONTRACT.md + server/README + datagen/README for
  UI agents. Point every UI agent at it. They were previously reading ~5 sprawling docs
  before writing a line, and were killed inside that window twice, producing nothing.
- Screenshot iteration is capped: 2-3 focused passes on the hero screen, not 10 everywhere.
- `CalendarHeat`, `MapPopover`, `Gallery` + `gallery.html` are **explicitly dropped**.

**1. Components agent (killed mid-task).** Was building, in this order: `components/README.md`
FIRST (it gates the UI agents), then the particle `WindLayer`, then `ModelVerificationPanel`.
Its last line before being stopped: **"Bug confirmed -- districts render as 1353%. Let me
check other sites and fix."** That is almost certainly the percent/fraction scale collision
in `ModelVerification` -- `freq` fields are percentages 0-100, `delta` is in points, but
`disagreement` is a 0-1 fraction. Something is multiplying a percentage by 100 again.
**Fix that first on resume; it is a real bug with a known cause.**

Carry forward this finding from the previous components agent (its transcript is gone):
**wind particle alpha must be skin-aware** -- a nullschool field is designed for a dark
ground, and the alpha that reads as elegant on the regulator's near-black shell reads as
noise on the community's light warm-paper basemap.

**2. Industry interface -- still the 27-line placeholder.** Agent was killed immediately
after starting to read docs. Nothing produced. Re-spawn first; it is first in priority order.

**3. Community, Regulator, Admin interfaces -- still 27-line placeholders.** Not started.

**4. `narrative.py` -- NOT CREATED.** 150-250 concerns, clusters, alerts, advisories, posts,
mitigations, activity. `ctx` contract is documented in the `build.py` module docstring and
validated end-to-end. Use `sample_field(...)` so copy agrees with the map, and evaluate
against the 11 already-seeded `action_levels`.

**5. Backend follow-up.** Advisor latency: a real Opus 5 call takes ~16 s, which is dead air
in a "glanceable" interface. Plan agreed: return the rules answer instantly (~50 ms) and
upgrade with the streamed LLM answer. Agent was measuring model tiers with real data when
stopped. Also re-verify heavy endpoints against the real 90 MB DB (only the 22-segment
fixture was used).

**6. Known defect.** Industry shell header locks onto "Delta Forge Metals Works" while the
persona is Ridgeline Compute. Active site should follow the persona's org.

### Deliberate deviations from the original spec
- CONTRACT §8 `concern_wave` said the community contact appears to the **southeast**;
  corrected to **~055° (NE)**, because Ridgeline must sit SW of Boxtown for the
  prevailing-SW-wind plume story. Bearings are computed from geometry, never hardcoded.
- Fleet modelled as shared across communities (1-3 cars/day, Sundays off, one week in four
  off-campaign). 5 cars on 196 km would otherwise hit 25 passes in 11 days.
- `anthropic` SDK deliberately NOT added; the advisor uses raw `httpx`, verified working.

### Agent resumption
Transcripts survive `SendMessage` resume **within a session**, but one has already been lost
("No transcript found"). Assume they are gone across a session boundary and spawn fresh
agents from this list.

## Hard-won environment facts — do not rediscover these

1. **`source dev/env.sh` before any command.** nvm does not load in non-interactive shells.
2. **Homebrew is a dead end here** — not an admin account on an MDM-managed Mac, no sudo.
   uv and nvm are the answer. Don't retry brew.
3. **Headless Chrome renders WebGL** (ANGLE Metal, M1 Pro) — but only if you do **not**
   pass `--disable-gpu`. That flag is what disables it.
4. **Append `?live=0` to every screenshot URL.** An open SSE stream never reaches network
   idle, so `--virtual-time-budget` hangs forever. The shell added the escape hatch.
5. **`strict` is ON** in `tsconfig.app.json` (I enabled it; it produced zero errors).
   `types.ts` is full of `| null` — without it those unions silently collapse.
6. Working screenshot invocation:
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox --virtual-time-budget=8000 --screenshot=<p> --window-size=1600,1000 "<url>?live=0"`

## 2026-08-28 — map stack verified, basemap switched

**deck.gl renders in headless screenshots.** An earlier report claimed the road grid,
boundary and site markers all captured blank and blamed `preserveDrawingBuffer`. That was
wrong. Verified with an isolated probe at `/gallery.html` (basemap + road grid, no router,
no SSE, no app shell): 1,307 segments capture cleanly, intensity ramp correct, real Boxtown
geometry. UI agents can and must verify their own map work visually.

**The basemap now defaults to MapLibre even though a Google key is present.**
`web/.env.local` has both `VITE_GOOGLE_MAPS_API_KEY` and `VITE_GOOGLE_MAPS_MAP_ID`, so
`auto` was correctly resolving to Google — and Google returned its stock light basemap
under every role skin. Chased it down:

- Not auth or billing — the console shows no Maps API error at all.
- A cloud Map ID carries exactly one style, and Google drops `styles` whenever a mapId is
  present. Removed the mapId. Still light.
- Forced `renderingType: 'RASTER'` (a project with a *default* Map ID makes the JS API
  choose vector rendering, and vector maps ignore `styles`). Still light.

The key's Cloud project appears to enforce vector rendering, which no client-side change
can override. A stock light basemap under the regulator's dark tower-defense board is a
worse outcome than losing the vendor, so `resolveBackend` now returns `maplibre` by
default. `VITE_BASEMAP=google` still forces Google. **To restore Google properly the user
needs either raster styling enabled on that project, or four published cloud styles (one
per skin) passed as per-role Map IDs.** The rationale is in the `resolveBackend` docstring.

Also fixed in `GoogleBackend.tsx`: `setOptions` is process-global and warns/no-ops on any
call after the first, which StrictMode's double-invoke guaranteed. Now guarded.

**Corrected in `ModelVerificationPanel`:** `affected_districts` percentages were multiplied
by 100 a second time — Boxtown rendered as 1353%. Also `disagreement` is `0.0` for all
three sites, so the hero stat read "Hours mispredicted 0%" beside "Model understates
transport"; it now falls back to the largest per-bearing gap.

**Direction change from the user:** the industry radar was too skeuomorphic. The sweep
effect is out. Reference is the modern iOS Compass — flat, hairline rings, negative space,
one accent colour — not the 2010 brass-and-gloss original. No idle animation; motion only
on real state changes.

**Probe harness:** `/gallery.html?role=<role>&backend=maplibre|google` (the dead component
gallery, repurposed). Isolates map behaviour from any app screen.

## 2026-08-28 (later) — industry landed; three cross-cutting bugs fixed

**Industry interface is done and visually verified.** `/industry` scope, `/industry/alerts`,
`/industry/alerts/$alertId` (kind-aware: exceedance → triangulation, community cluster →
proxy check, wind shift → `ModelVerificationPanel`), `/industry/outreach`, `/industry/site`.
The de-skeuomorphising pass landed: sweep, phosphor tail, radial glow, spokes, scanlines,
corner brackets, text-shadow glows and every idle animation are gone. Rings are hairlines
with their own range labels; the worst bearing is a compass arc. The only motion left is
the wind particles, which are data.

### Fixed by me (all reported by the industry agent, none were its own files)

1. **`timeRange()` in `core/session.ts` refetched forever.** It returned a raw
   millisecond `new Date()`, so every hook that defaults its window got a new query key on
   every render. That is why the wind field showed "NO FIELD" and why pages never reached
   network idle. Live windows now quantise to a 5-minute grid; a scrubbed cursor passes
   through untouched.
2. **`GET /segments` applied `LIMIT` before the bbox filter.** The bbox was a Python
   post-filter, so a local bbox at a normal limit got the campaign's global top-N and then
   discarded all of it — a silently empty map. Pushed into SQL via a join on
   `road_segment.mid_lon/mid_lat`. Verified: bbox + `limit=200` returned 0 features before,
   returns 11 now; the unbounded query still returns 200.
3. **`headroom_pct` was inverted in the shell.** The schema defines it as the share of the
   safe envelope *used* (Ridgeline 79), but `AppShell` printed `HEADROOM 79%` and flagged
   `<25` as threat — reading it as *remaining*. The shell and the industry panel contradicted
   each other on the same screen. Shell now shows `100 - headroom_pct`.

### Still open (reported, not fixed — quota)

- `useActiveSite()` falls back to `sites[0]` (Delta Forge) instead of the persona's own org.
  The industry app works around it locally with `useSiteLock()`; the shared hook should
  prefer `roleMeta(role).org`.
- `AdvisorReply` in `core/types.ts` is missing the `upgrade` block the endpoint returns, so
  the industry app polls `GET /advisor/{id}` with a raw `fetch`. A `useAdvisorUpgrade(requestId)`
  in `core/queries.ts` would remove the only raw fetch in that app.
- **Three defects visible in `scope-final-8500.png`** that the agent did not flag:
  the wind particle field leaks outside the dial into a rectangular block on the east side
  (clip regression — the components agent had fixed exactly this); seven exceedance contacts
  at ~430 m pile up on top of each other near the centre with overlapping `EXCD` labels,
  because the range scale is linear over a 3 km scope; and the contact-history ribbon
  crams every bar into the last 8% of the timeline.

### Data state

The `alert` table was empty, so the industry agent ran three Demo Director scenarios
against the live API for `site-ridgeline` (`generator_test`, `concern_wave`,
`model_divergence`). That is what populates the 15 contacts, the 6-report Darwin cluster
and the `understates` verdict. **Reversible with the `all_clear` scenario.**

### Screenshot caveat worth promoting into UI-BRIEF

`--virtual-time-budget` never completes on a page with a continuous rAF canvas (the wind
field) — the process hangs. Any pending external fetch also stalls virtual time, so
`--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"` helps elsewhere. The industry
agent wrote a CDP screenshotter at `scratchpad/shot.mjs` (node built-in WebSocket, no deps)
that takes real wall-clock frames at given offsets. Worth adopting.

---

## 2026-08-28 (later still) — community landed

**Community interface is done and visually verified.** `/community` feed, `/community/map`,
`/community/report` (5 steps), `/community/dashboard`, `/community/status`,
`/community/outreach`, `/community/concerns/$id`. Typecheck clean.

The feed is the strongest screen in the build. Warm paper, two columns, a greeting by name,
a risk dial reading `25 · Fair` with one sentence of advice and no unit anywhere near it.
The rail names pollutants in plain words — "smoke and dust you breathe in", "invisible
exhaust gas" — each with a 0–100 score and the line *"Every number is a score out of 100.
Lower is better. No units, on purpose."* That single line does the whole community-language
rule in eight words.

**The asymmetry is legible without reading body copy.** Operator cards carry a purple rule,
an `OPERATOR` pill, an `A reply to neighbours` tag, and a pill that says
**"Still open — only the agency can close a report."** The report success screen says it
again in advance: *"An operator may reply saying they tried something. That reply will never
close your report."* Loop 3 of the spine is now visible from the resident's side.

**The cluster is framed as a social fact, not a query result** — a green banner reading
*"6 neighbours have reported the same thing within a few blocks … When reports pile up like
this they stop being one person's word: the air agency and the operator both see them."*
That is loop 1, explained to the person who triggers it.

### Changed outside its subtree

- **`web/src/design/tokens.css`** (authorised): `[data-role='community']` now aliases
  `--ramp-map-*` → `--ramp-aqi-*`, so the road grid uses the public-health ramp instead of
  the analytical one. Correct per the two-ramps rule. Arity mismatch is documented in-file —
  `aqi` has 7 stops and `map` has 8, so `--ramp-map-7` repeats `--ramp-aqi-6`.
- **Shared demo data (API writes, not code).** The dataset had zero site posts and zero
  mitigations, so the feed could not show the three-way tension at all. The agent created one
  mitigation and one post from Ridgeline Compute on concern `cn_9b064559f1`, moving it to
  `mitigation_proposed`. Industry and regulator see this too.

### Reported, not fixed

- **MapLibre basemap tiles never paint in headless Chrome.** Verified by the agent against
  the bare probe `/gallery.html?role=community&backend=maplibre`: the CARTO attribution
  renders, the tiles do not, on a page with no router and no app code. deck.gl renders fine —
  this is the tile layer, not the renderer, and does **not** contradict the deck.gl finding
  above. Unknown whether it also happens in a real browser; check there first.
- **`GET /feed` returns the same operator claim twice.** Creating a mitigation mirrors it into
  a `SitePost` with an identical title, so both a `mitigation` and a `post` item come back.
  Worked around by deduping on lowercased title in `Feed.tsx`; belongs server-side.
- **`RiskDial`'s in-dial `label` overlaps the arc** past ~6 characters at size 148–168.
- **`FleetLayer` call-sign labels are near-illegible on the community light skin** — pale
  yellow on warm paper.
- **`core/roles.ts` gives community only four nav items**, so `/community/status` and
  `/community/outreach` are reachable only through in-page links.
- **`+2% VS LAST WEEK` on the risk dial collides with the ring** at bottom-left (my note, not
  the agent's — visible in `feed-final.png`).

### Deliberate omissions

No `<TimeCursor />` on any community screen — a resident scrubbing history is the wrong
affordance — though every screen still honours a cursor set elsewhere via `resolveNow`.
Corroboration is fire-and-forget with no optimistic count bump.

Screenshots: `scratchpad/shots/community/` — `feed-final.png`, `map-final.png`, `report-3.png`,
`dashboard-3.png`, `status-3.png`, `outreach-3.png`, `concern-3.png`.

### Remaining build order

Regulator (tower defense) and admin (drafting table) are still 27-line placeholders.
`src/air/datagen/narrative.py` was never written — the narrative rows the agents needed have
been created ad hoc through the API instead, which is why demo state now depends on scenario
runs rather than a reproducible seed.

---

## 2026-08-28 (morning) — regulator + admin building; `narrative.py` written

Regulator and admin agents launched in parallel — disjoint subtrees, and both are
resumable if the window runs short. While they work I filled the gap neither of them
could: **`src/air/datagen/narrative.py` now exists** (~950 lines, pure Python, no
collision with either agent's files).

### What it does

`build.py` already had a documented seam — `narrative.seed(conn, ctx)` — and a full `ctx`
contract. The module is its other half. It is built around **episodes** rather than rows:
one turbine test at 03:00 produces a monitor exceedance, a cluster of "low hum" reports
downwind of it, an alert on the industry radar, a mitigation post that closes nothing, and
a regulator finding that does. Eight such episodes carry the whole story, so all four
interfaces are projections of the *same* events instead of four unrelated datasets.

Verified against a scratch build (`scratchpad/air-test.db`, 94 MB, offline — OSM is cached):

| | before | after |
|---|---|---|
| concern | 6 | **204** |
| concern_corroboration | 0 | **166** |
| concern_response | 2 | **34** |
| concern_cluster | 1 | **8** |
| alert | 22 (scenario runs) | **30** |
| advisory | 1 | **5** |
| enforcement_action | 0 | **6** |
| mitigation / site_post | 1 / 2 | **7 / 12** |
| notification | 0 | **102** |
| activity | 44 | **281** |

### The honesty rules are enforced in the data, and checked

- **Industry can never close a concern.** 28 concerns reach `resolved`; **all 28 carry a
  regulator `finding` response**, one per report rather than one per cluster, so a resident
  opening their own report sees who closed it. Zero industry responses of kind `finding`.
- **Attribution stays ambiguous.** A concern gets `suspected_site_id` only when the wind at
  that hour actually carried from that site to that point (within 30° and 4 km). Result:
  **126 of 204 unattributed**, and the remaining 78 split roughly evenly across all three
  emitters. Nobody is the obvious villain.
- **Every number agrees with the map.** Alert values come from `sample_field` or are read
  back out of `segment_stat` — never invented. First cut sampled the *core* of a methane
  plume and produced a 57 ppm alert against a 5 ppm level, on a road no car drives; now it
  quotes the worst pass actually recorded on the segment (5.53 ppm on Fields Road).
- **`max` for spike levels, `p90` for integrated levels.** Quoting the wrong statistic is
  how an honest dataset starts telling a dishonest story.
- Nothing is dated after `now`; verified 0 future rows across 10 tables.

### The leapfrog is now a query, not a claim

Three action levels — `bc`, `ch4`, `diesel` — are for measures **no reference monitor
carries**, so DRAQA's own network can never trip them. The fleet trips all three:

```
ch4      5.53 / 5 ppm     Methane plume crossed on Fields Road
bc       7.56 / 5 ug/m3   Highest black carbon on the network: Channel Avenue
diesel   6.77 / 3 ug/m3   Highest diesel-attributable particulate: Paul R Lowry Road
```

`SELECT DISTINCT measure FROM action_level` minus the union of reference-monitor
`measures_json` returns exactly `['bc','ch4','diesel']`. That is the argument, checkable in
one line.

### Also fixed

- **`build.py`'s ctx contract said `foreign_keys = OFF`. They are ON.** Cost one build
  cycle. Docstring corrected, with the insert-order consequence spelled out.
- **`docs/UI-BRIEF.md` said DRAQA has 3 reference monitors. It has 4** (Weaver Road,
  Riverport Road, West Shelby Drive, Harbor Avenue). Also corrected the persona line: 18
  users *in total*, of which 8 are community, not 18 community personas. The regulator
  agent was told mid-flight, since tower count is load-bearing for its screen.
- Alert `status` is now workflow state, not physics: the value dropping sets `ended_at`,
  but the alert stays on the regulator's board until someone works it. Previously every
  exceedance self-resolved and the watchfloor opened empty for a region with a real problem.

### Not yet applied to `data/air.db`

The real build is deliberately **not** run yet — it wipes and rewrites everything and would
move the ground under two live agents. Run `uv run air-datagen build --fresh` once they land.
That replaces the ad-hoc scenario writes with a reproducible seed, and moves `now` to the
current time. Expect ~105 s.

### Pause point — 2026-08-28, 89% quota

Both interface agents were **still running** when work paused. Their files are all on disk
and `npx tsc --noEmit -p tsconfig.app.json` **exits 0 on the mid-build state**, so the repo
is coherent — nothing is half-typed. Neither has reported yet, so neither has been reviewed
or screenshot-verified by me.

On disk at pause:
- `apps/regulator/` — `routes.tsx`, `Watchfloor.tsx`, `MapScreen.tsx`, `Thresholds.tsx`,
  `Push.tsx`, `lib.tsx`, `regulator.module.css`
- `apps/admin/` — `routes.tsx`, `Overview.tsx`, `Campaign.tsx`, `DrivePlan.tsx`, `Fleet.tsx`,
  `Data.tsx`, `Oversight.tsx`, `Director.tsx`, `lib.tsx`, `admin.module.css`

Both agents are resumable by message; a fresh agent would start cold.

**First thing on resume:** run `uv run air-datagen build --fresh` (~105 s) to swap the ad-hoc
scenario writes for the reproducible narrative seed. It has been verified end to end against
`scratchpad/air-test.db` but has **not** been applied to `data/air.db`.

---

## 2026-08-28 (midday) — admin landed

All seven admin routes built, typecheck clean, agent-verified by screenshot (not yet
reviewed by me — quota pause). Screens in `scratchpad/shots/admin/`.

The drafting-table narrative is carried by a single device: every route is a **sheet in one
drawing set**, with a title block, a sheet number (01–07), and numbered sub-sheets with code
chips on blueprint paper. Highlights:

- **Sheet 02 Campaign** is a real drawing surface — click to place vertices, edges labelled
  with their length, segments inside the draft drawn bright while everything outside dims,
  and a live bill of quantities in the margin. Verified end to end: four clicks → 24.70 km
  perimeter, 37.98 km², 389 of 1,307 segments enclosed, 4 districts.
- **Sheet 03 Drive plan** states the duality the spec asked for explicitly: boundary + fleet
  → `Rural Postman circuit` → *Output A: 88 routes* and *Output B: 57k passes*, side by side.
  The estimator uses the backend's own constants.
- **Sheet 06 Oversight is the payoff.** Three lanes — COMMUNITY *filed it* / INDUSTRY
  *answered it* / REGULATOR *ruled on it* — in `--actor-*` colours over one shared clock
  strip, under an asymmetry callout that ends *"The party being complained about does not get
  to decide when the complaint is over."* During its last screenshot the log was showing the
  regulator agent's threshold edits arriving live from another session.

### New shared-code bugs (reported, worked around locally, NOT fixed)

1. **`useTheme()` never recovers if a component mounts before its data.** It bails on
   `!ref.current` and its single rAF retry fires before the query resolves, so any chart with
   an early `if (!points.length) return <EmptyPlot/>` keeps the NEUTRAL theme forever —
   `theme.ramp` empty, `makeColorScale` returns `[0,0,0,0]`, **transparent cells and a blank
   ScaleKey** while CSS-driven axis labels render fine. Silently blanked two charts. This is
   cross-cutting and worth fixing properly (ResizeObserver or retry-until-mounted).
2. **`BaseMap.initialView` with `undefined` lon/lat crashes MapLibre** and trips the whole-app
   error boundary — `initialView={{ longitude: campaign?.center[0] }}` blows up on first
   render before bootstrap resolves. Should be guarded inside `BaseMap`.
3. **`getDrivePlan()` is typed `DrivePlan` but `GET /drive-plan` returns a list**, and never
   includes routes; `useDrivePlan().data.routes` throws. No api.ts function exists for
   `?include_routes=true`.
4. **`SimScenario` in `core/types.ts` is missing `'model_divergence'`** — backend has six, the
   type lists five.

### Data and process notes

- Fired **`methane_leak` once** through the Director UI (1 alert + 1 advisory, additive).
  Did **not** fire `all_clear`.
- Deliberately did **not** press "Generate drive plan" — it archives the seeded plan
  permanently and replaces the route-inspection circuit with the backend's cheap
  boustrophedon fallback. Control is wired; **someone should decide whether that trade is
  acceptable before it is used in a live demo.**
- The agent killed a Chrome on `--remote-debugging-port=9333` after its CDP script attached
  to a browser it did not own (one screenshot came back showing the regulator's screen). It
  moved to port 9444. **The regulator agent may have lost a headless browser around 12:05.**
- Draft boundary is session-local zustand — there is no boundary-write endpoint, and sheet 02
  says so on screen rather than pretending otherwise.
- Sheets 05 and 06 right-hand columns clip below the fold at 1800×1100.

---

## 2026-08-28 (midday) — regulator landed. **All four interfaces are built.**

Five routes, typecheck clean, agent-verified across three screenshot passes (not reviewed by
me — quota pause). Screens in `scratchpad/shots/regulator/`.

Tower defence is carried without ever printing the words. The watchfloor opens on a red
verdict bar — **OVER THE LINE**, `NO2 192.2 ppb · 1.92× the action level` — and the 11
tripwires are drawn with **their threshold ticks pinned at the same x**, so the eye compares
overshoot rather than units. The map is monitor-centric: four coverage discs with AQS site
codes, the road grid burning through them, and a header reading **"294 BEYOND RINGS"**.

**The leapfrog is stated as coverage, everywhere, derived from `monitor.measures` rather than
hardcoded.** Tripwires no tower can trip carry an amber `FLEET ONLY · 0 TOWERS` chip against
the green `3 OF 4 TOWERS` on the rest. West Shelby's card carries a dashed `BLIND TO NO2`
footer and its roster row reads *"the 354 streets inside this ring are measured only by the
fleet"*. The alerts queue puts it as a count: *"2 of these were seen by a DRAQA reference
instrument. 5 were seen only by the mobile fleet."* The Reach block quantifies the offer —
*"1,013 street segments inside a 2.5 km radius · 294 beyond every ring, 48 km of road no
stationary instrument stands for"*, with a per-tower multiplier (tower 23.8 → streets
12.1–36.2 · **1.5×**).

### The threshold-drag loop works end to end — verified

Dragging BC from 5.0 → 2.0 µg/m³ took live alerts **20 → 23 in the same frame**, showed
`+2 −0 · "2 raised, 0 cleared the moment you let go"`, moved the campaign histogram from
**51 over (3.9%)** to **128 over (9.8%)**, grew the standing ledger from 3 rows to 5, and
updated the shell header and nav badge. `shots/regulator/thresholds-drag.png`. This is the
demo's best moment and it is real.

### Shared state — verified restored

All 11 action levels are **byte-identical to seed** (thresholds, flags, enabled) — checked
independently after the fact, not just claimed. No scenario run by this agent. Four BC
exceedance rows created by its threshold tests remain in `alert` with `status='resolved'`;
they are filtered out of every screen. Current DB: 25 alerts, 21 active.

### New shared-code bugs (reported, worked around, NOT fixed)

1. **`SegmentDetail.diurnal` labels points `'02'`, not `'hour:HH'`.** `DiurnalClock.toValues()`
   documents `'hour:HH'` and silently falls back to **array index**, so a 03:00 peak renders
   wherever it happens to sit in the list. Wrong-by-default and silent — the agent's first
   Analysis screenshot had the peak in the wrong place.
2. **`GET /alerts?status=active` ignores the filter** and returns resolved rows.
3. **`useCurrentWind()` calls `useWind()` with no window** — re-keys every render and refetches
   forever. Same class as the `timeRange()` bug already fixed; this is the one that got missed.
4. `PUT /action-levels/{id}` returns an `evaluation` block (`alerts_created`,
   `alerts_resolved`, `advisories_created`) that is **not on `ActionLevel` in `core/types.ts`**.
   It is the best feedback signal in the demo and deserves a wire type.
5. `useStableWindow` is now duplicated verbatim in `apps/industry/lib.tsx` and
   `apps/regulator/lib.tsx`. Belongs in `core/session.ts`.
6. `robustDomain()` defaults `floorAtZero: true`, which flattens ambient-concentration road
   grids into the hot half of the ramp. A bad default for concentrations.

### Deliberately left undone

No `monitors/$monitorId` route (nothing linked to it; tower detail lives inline). No time
cursor — the reach maths is a 90-day `window: 'all'` query, so scrubbing would only have
moved the fleet dots. Repeated street names down the ranking table ("Paul R Lowry Road" ×8)
are eight consecutive 200 m segments of the same road — the hotspot — left honest rather
than deduped.

---

## Where the build stands

**All four interfaces are complete and the whole app typechecks clean** (`tsc --noEmit`
exit 0, zero diagnostics). Community, industry, regulator, admin — each with its own
narrative, all reading one shared dataset, all live over SSE.

**Top of the list on resume**, in order:
1. `uv run air-datagen build --fresh` (~105 s) — applies the verified narrative seed. Written
   and tested; never yet run against `data/air.db`.
2. `useTheme()` never recovering when a component mounts before its data — silent, blanks
   charts in any interface.
3. The `DiurnalClock` `'hour:HH'` fallback-to-index — silent, renders peaks at the wrong hour.
4. `useCurrentWind()` infinite refetch.
5. The smaller wire-type gaps: `ActionLevel.evaluation`, `AdvisorReply.upgrade`,
   `SimScenario.model_divergence`, `getDrivePlan()` returning a list.

Nobody has yet reviewed all four interfaces side by side against the tension thesis. That is
the one piece of judgement still owed.

---

## 2026-08-28 (afternoon) — narrative seed applied; nine bugs fixed; all four reviewed

**`data/air.db` now carries the generated narrative.** 204 concerns, 8 clusters, 31 alerts,
286 activity rows. Invariants re-checked on the live DB: 0 concerns resolved without a
regulator finding; 137 of 204 unattributed. Backup of the pre-reseed DB at
`scratchpad/air.db.prereseed`.

Getting there surfaced **two latent bugs in the build pipeline itself**, both of which had
been silently wrong for a long time and only showed up once the narrative tables held real
cross-referenced rows:

1. **`db.NARRATIVE_TABLES` deleted `concern` before `site_post` and `mitigation`**, which
   reference it. `--fresh` simply stopped working the moment the API had written one operator
   reply against one concern. Reordered children-before-parents, and `wipe()` now sets
   `PRAGMA defer_foreign_keys` so ordering is no longer the only thing holding it up.
2. **`mobile_wind_obs`, `dispersion_model` and `dispersion_model_contour` were in *neither*
   wipe list.** Every rebuild left the previous run's rows behind — 28k orphaned wind
   observations pointing at drive ids that no longer existed, plus duplicate dispersion
   studies. Nothing complained, because SQLite only checks a foreign key when the row is
   written. Silent and cumulative. Added to `PHYSICAL_TABLES`.

### Bugs found and fixed by reviewing the running app

3. **`useTheme()` could never recover.** Worse than reported: its one rAF retry set `tick`
   0→1 with `t === 0 ? 1 : t`, so it could never fire again, and its deps `[ref, tick]` were
   then frozen for the component's life. Any chart that renders a placeholder while its query
   is in flight kept NEUTRAL forever — empty `ramp`, transparent colour scale, an invisible
   chart with perfectly good axis labels. Now re-checks after every render, keyed on element
   identity.
4. **`GET /feed` crashed outright** under the new volume: `hot.sort(reverse=True)` on
   `(ts, monitor_dict, …)` tuples fell through to comparing dicts as soon as two monitors
   exceeded in the same hour — which is the normal case, not a rare one.
5. **`DiurnalClock` put peaks at the wrong hour.** The API sends `t: "03"`; the parser
   accepted `"hour:03"` and ISO, then **fell back to array index**. The `diurnal` payload is
   sparse (four populated hours out of twenty-four is normal), so an 18:00 value rendered at
   03:00 — on a chart whose only job is saying *when*. Now parses the bare-hour form, and
   drops unparseable points instead of guessing. A gap is honest; a wrong position is not.
6. **`BaseMap` crashed the whole app** on `initialView={{ longitude: campaign?.center[0] }}`
   before bootstrap resolved. Added `mergeView`, which ignores non-finite values.
7. **`AlertTimeline` printed "Aug 24" four times in a row** — `x.ticks()` chose a 6-hour
   interval but the label was picked from the span alone. Now the date appears on the first
   tick of each day and the ticks between it show their time.
8. **`tinyCode()` derived the ribbon code from the first word of the title**, so new alert
   copy produced `BC HIGHES`, `CH4 METHAN`, `MEASUR` and a code that was literally `6`. Now
   derived from the alert's *kind*, keeping the place only when the title actually names an
   instrument. Reads `CH4 MOBILE · DIESEL MOBILE · BC MOBILE · MODEL · CLUSTER · FLEET`.
9. **Three admin screens counted a limited fetch.** `useConcerns({ limit: 100 })` with 204
   concerns made the oversight headline read "CONCERNS FILED 100" against a footer saying
   `176/204`, and drew half the map pins. Fixed in `Oversight`, `Director`, and `Overview`
   (which now prefers the campaign's own `concerns_total`).

### Narrative tuning after seeing it rendered

- **Duplicate report copy.** Sampling the template pool with replacement put the identical
  headline at positions 1 and 4 of "Closest to you". Each kind now gets a shuffled deck dealt
  without replacement. Adjacent duplicates: 2 in 200, down from many.
- **`/feed` reading cap is now per-audience** (community 1, everyone else 5). Readings all
  carry the same latest-hour timestamp, so a pure time sort floated every one of them above
  every human post — a wall of identical "a regional air agency monitor" cards at the top of
  a resident's feed. The docstring already said "per audience"; now it is.
- **Operator post and mitigation said the same words**, appearing as two identical cards on
  the oversight screen. They now speak to different readers, and the post uses plain language
  (`traffic and engine fumes`, not `no2`) because it lands in a resident's feed.

### Reported bugs that did NOT reproduce

- `GET /alerts?status=active` **does** honour the filter — checked across `status` and `role`
  combinations. The regulator app's client-side `liveAlerts()` workaround is harmless.
- `useCurrentWind()` re-keying every render was **already fixed** by the earlier `timeRange`
  quantisation; that report predates it.
- The industry wind field is **not** leaking outside the dial. That rectangle is the campaign
  bbox, which genuinely sits north-east of the Ridgeline site. My earlier "clip regression"
  call was wrong.

### Reviewed side by side

Community, industry, regulator and admin oversight all render correctly against the new data,
and the cross-role spine is visible end to end: a community cluster near Paul R Lowry Road
appears on the industry radar as a contact at 347° / 1.2 km, in the regulator's queue, and in
the admin oversight log — the same event, three ways. `tsc --noEmit` exits 0 with zero
diagnostics.

### Still open

- `useStableWindow` is duplicated in `apps/industry/lib.tsx` and `apps/regulator/lib.tsx`;
  belongs in `core/session.ts`.
- Wire-type gaps: `ActionLevel.evaluation`, `AdvisorReply.upgrade`,
  `SimScenario.model_divergence`, `getDrivePlan()` returning a list.
- `robustDomain()` defaults `floorAtZero: true`, a poor default for ambient concentrations.
- MapLibre basemap tiles still do not paint in headless Chrome (deck.gl layers do).
- Admin sheets 05 and 06 clip their right-hand column below the fold at 1800×1100.

---

## 2026-08-28 (late) — industry rebuilt as RWR + MFD

Feedback: the RWR narrative was too restrictive. You could see that something was 6.3 km to
the north-east and nothing whatsoever about what it was over — no buildings, no point
sources, no streets, no zoom, no way to designate a stack. Decision taken: **stay 80s, but
invert which instrument is the hero.** On a real aircraft the RWR was a *small* dedicated
scope precisely because it answers one question; the big display was the MFD.

### What changed

- **The MFD is now the main surface.** `<BaseMap>` with the road grid, the site footprint
  (Ridgeline's campus is genuinely 1.5 × 3 km — that is why it reads so large), all 13
  emission points, the fenceline sensors, the observed wind field, and the consultant's
  modelled plume behind a toggle. Zoom and pan work.
- **The RWR keeps its job at its real size** — a 186 px instrument at the top of the rail:
  bearing, range, how long, the assumed plume as a dashed outline. Nothing else.
- **`radarOverlay()` puts the scope's geometry on the map** — range rings centred on you, a
  bearing line to every contact — so the two instruments read as one system rather than two
  unrelated pictures of the same air.
- **`SLEW TO ▾`** designates any emission point; the camera follows it. **`LOCK`** is a mode,
  not a button press: while lit the camera tracks the focus, and any real pan drops it.
- **Alerts are filtered to the site** and the road grid to a 4.2 km box around it. The
  regulator wants the whole campaign; an operator wants the blocks their plume crosses.

### Busyness, addressed where it was cheap

Your wider critique drove four of these decisions:

- **The modelled plume is off by default on the MFD.** At `maxOpacity: 0.3` it was a huge
  orange wedge swallowing the map. It stays permanently on the *RWR* as a dashed outline,
  which is the 80s split done properly: the scope carries what was assumed, the map carries
  what is there.
- **Twelve stack chips in five rows became one compact `SLEW TO` control.** The picker was a
  block of furniture sitting on top of the thing it was meant to help you read.
- **Only the designated contact is labelled on the map.** Nine fenceline sensors sit within a
  few hundred metres of each other; labelling all of them stacked six unreadable chips on one
  pixel. The rail already lists every contact by name.
- **`RadarScope` gained `rangeCurve="sqrt"`** (opt-in; `linear` stays the default). With
  fenceline contacts at ~430 m and a regulator monitor at 6 km, a linear PPI collapsed every
  near contact onto the origin as an unreadable knot. Rings stay evenly spaced in radius and
  carry whatever distance that radius means, so their labels remain literally true.
- `.strip` now wraps instead of clipping — the consultant line was colliding with its own
  trailing observation count on the narrower rail.

### Not done

- Multi-*site* selection. `useSiteLock` still resolves one site per org, and Ridgeline has
  one; the `SLEW TO` control covers the multiple-point-source case, which is the real one in
  this dataset. If an org ever owns two campuses, that control is where the site picker goes.
- The contact-history ribbon still crams its bars into the right-hand edge when one old alert
  stretches the domain across five days.

### The reference network, added to the MFD

Feedback: the MFD has to zoom out far enough to show the *regulator's* instruments and the
wind, because that is what industry actually fears — the fenceline exists precisely so those
never trip. That is the correct model of the business, and the display was missing it.

The four DRAQA instruments sit **3.7–6.25 km** from Ridgeline, at bearings **16°–114°** — and
the prevailing wind (S 27.5%, SSW 23.6%, SW 21.1%) transports straight at Harbor Avenue and
Riverport Road. The fear is real in the data, so the display now shows it:

- **All four reference monitors on the MFD, with their 2.5 km representativeness rings.** The
  ring is the question: is my plume crossing the ground this instrument speaks for? Fenceline
  sensors stay ringless and smaller — they are the operator's own early warning, not the
  thing being managed against.
- **Default view opens at the network scale** (zoom 11.9, min 10, segment bbox widened 4.2 →
  9 km) so all four are in frame before anyone touches a control.
- **Range rings run 1 · 2 · 4 · 6 km**, out to where the regulator's instruments actually are.
  A scope that stopped at 3 km could not show what the operator manages against.
- **A dashed plume track** from the site along the observed transport bearing. Dashed because
  it is derived from measured wind, not measured along it.
- **`downwindOf()` names who is in that track**, with a red-ruled strip in the rail:
  *DOWNWIND · HARBOR AVENUE · 6.0 km · NNE 016° · 16° off the plume track*, and the named
  instrument highlighted on the map. When nothing is in the corridor it says so. The
  half-angle is a generous 35° on purpose — the operator is not deciding whether they are
  *definitely* being measured, they are deciding whether today is a day to hold the load.

Also fixed: the contact list was being squeezed to a single header row once the rail carried
four panels (`.stackGrow` now has a floor and the rail scrolls), and the scope came down to
160 px to pay for it.
