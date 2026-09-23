# The plume narrative — model vs. measured reality

**Status: designed and sequenced. Implementation not started.**
10 phases, 2 database rebuilds, nothing interface-specific before phase 4.
Started 2026-09-04. This file is the resume point.

---

## The brief

Verbatim from the product owner, after conversations with Aclima's data scientists and
engineers. This is the specification — everything below serves it.

> The most important narrative is: industry emission sources emit a plume. There is the
> modeled plume. The direction of this plume depends on the wind and weather. But in general,
> the modeled plume will never be exactly real. Where it eventually lands and disperses is
> never going to match reality.
>
> Aclima's mobile sensing can be used to determine the actual impact of a plume on human
> health. Where is that blast radius where that plume touches down and disperses hyperlocally.
> It's not easy, but if we have these measured concentrations and indicators, we can determine,
> within our monitoring area, we see this "plume touchdown shaped thing" that we can compare to
> the modeled plume. The real worth of this is displayed and used differently in the different
> interfaces.

### Community

> Human health impact is number one. But it's at a community level. And yes, they are
> interested in attribution even if we don't **say** it. I'm going to relax the restriction on
> the community a bit. Community should show the community reports but also simulated plumes
> from known emission areas. While we aren't going to assert "You are definitely being affected
> by X company" we are going to say "you might be affected by plume X on the map". The look and
> feel stays soft and light.

### Industry

> This is already present to some degree, but I think our current modeled plume looks like a
> tiny blob when in reality, atmospheric conditions can carry pollutants quite far. And the key
> indication is the diff in TIME and SPACE. Are there community reports, aclima monitoring, and
> stationary regulatory monitoring sounding alarm in the right place and right time happening
> where our plume is expected to be given current weather conditions. Also, there is an
> additional model tier. We may allow them to input some basic plume model but an "aclima
> modeled plume" would use the latest and greatest in something like Nvidia's Earth-2 to provide
> hyperlocal modeling + aclima hyperlocal monitoring. The core visual narrative here is the diff
> between basic model, aclima model, and the backtrack from what is monitored by community
> reports, mobile monitoring, and stationary monitoring. The "aclima model" might be withheld as
> a premium feature behind a paywall. The focus of the industry user is then, creating and
> tuning models, looking at what is forecasted by models, comparing to monitored reality. They
> can tune their industry site configuration, add / remove stacks, generators, turbines. It
> should feel supportive to them, like they can build their site, try out models, compare to
> reality, upgrade / tune models further to get ahead of the community concerns and regulator
> traps.

### Regulator

> The regulator is going to ask — do I have enough sensors in the right places. And we want to
> nudge that aclima can cover the places they aren't. Mobile monitoring should look and feel
> like an extension of their reference stationary monitors — and this is real — we calibrate off
> of them, we bring mobile nodes near stationary sensors to calibrate and then those nodes go
> forth and help calibrate other mobile nodes. It's an aclima core unique process. As for
> modeling, yes, the modeled plume should be visible, both the basic and the aclima enhanced
> model by default. The regulator will be more interested in their coverage of the community
> over time. So showing the average plume locations over time and how effective their stationary
> network is at capturing it should be there in metrics and a visual — easy to see, is the plume
> covering their towers.

### Aclima / admin

> While yes, the same model vs monitoring motif should be there — the most important change is
> dynamic drive plans. The idea is that we will use something like Earth-2 predictions several
> days out to determine where the plume will touch cross and touch down to focus our driving in
> the locations to reduce costs and increase coverage where it matters. The planning theme
> strengthens, but it needs a "Mission Brief" tab or reusage of a tab to do this. Every morning,
> the leaders and drivers will check in to see what the driving plans are, which will change day
> by day if wind changes.
>
> One final note from my data science team: when doing targeted driving plans you must **also**
> drive in some small amount on the other side of the plume. Because that's the only way you
> know if there is a plume being generated at that site, or if it just a plume blowing overhead
> from somewhere else.

**That last paragraph is the sharpest requirement in the brief** and the easiest to lose in
implementation. A targeted drive plan that only samples where the plume is predicted cannot
distinguish a source from a pass-over. The control sample is what makes the measurement mean
anything.

---

## Ground truth: what exists today

Surveyed against the repo on 2026-09-04, before any design work. Cited so the design can be
checked rather than believed.

### Three plume representations exist, and none of them is the one the brief wants

| # | what | where | rendered? |
|---|---|---|---|
| 1 | **Truth** — a real Briggs open-country Gaussian plume per point source: Pasquill-dependent σ_y/σ_z, buoyant plume rise, ground reflection | `src/air/datagen/field.py::_plume` | **Never.** It generates the `segment_pass` concentrations and is otherwise invisible. |
| 2 | **The consultant's study** — static contour polygons from a rose-weighted field using a *deliberately wrong* assumed wind rose | `src/air/datagen/mobilewind.py::dispersion_models` → `dispersion_model` + `dispersion_model_contour` | Industry, as `permitFootprintLayer`. Exists for **bc, no2, pm25 only** — 3 rows total. |
| 3 | **The live cone** — one tapered cone per active emission point, three bands, computed per request | `GET /wind/dispersion`, `src/air/server/routers/wind.py` | Industry MFD, `DispersionLayer`. |

**The measured touchdown — the primitive the entire brief hinges on — does not exist.** Not in
the schema, not in datagen, not in the API, not in any interface.

### The "tiny blob" is measurable

`base_reach = (700 + 240 · speed_ms) · stability_mult`, times 0.75–1.25 for stack height.

⚠️ **Corrected.** My first pass at this quoted a hypothetical table computed by plugging
speeds into the formula, including a "physics bug" at Pasquill F / 6 m/s. Measured properly
against all 2,160 real wind rows × 21 active emission points, the actual drawn reach is:

| | measured reach |
|---|---|
| overall | **504 m – 3,415 m, median 1,472 m** |
| class B | 640 – 1,483 m |
| class C | 1,351 – 2,906 m |
| class D | 1,360 – 2,864 m |
| class E | 1,276 – 2,299 m |
| class F | 1,480 – 2,547 m |

So the blob is **smaller** than I first said, and the complaint is understated rather than
overstated. Against a campaign ~10.5 km across, a median 1.5 km cone barely leaves the
fenceline.

**And the F-at-6-m/s "bug" is not real in this data.** `weather.py::_pasquill` already gates
class against speed correctly: across all 2,160 hours, F spans 0.51–2.98 m/s and E spans
0.75–3.69 m/s. No F hour exceeds 3 m/s. The 4.28 km figure I quoted was the formula evaluated
on input that never occurs. A `coerce_class` guard at the API boundary is still worth having —
forecasts and user-tunable site config will genuinely produce incoherent pairs — but it is a
guard, not a fix, and it must never be presented as answering the tiny-blob complaint. That is
decision 21.

### The truth itself is clipped, and that caps everything

`field.py:326` hard-codes the plume evaluation window to **4,200 m downwind × 1,450 m
cross-wind**. Measured: **1,007 of 1,307 road segments (77.0%) lie beyond that clip from
Ridgeline.** The simulation's own ground truth is therefore absent from three quarters of the
monitored network, which caps what any measured-touchdown estimator could ever find out there.

Two related defects in the same function:

- **Boundary-layer trapping (`field.py:349`) is dead code.** Checked across all 2,160 hours: in
  none of them can σ_z exceed 0.8·`pbl_m` anywhere inside the 4.2 km window. For classes A/B it
  would fire at 6.3–9.8 km — just outside. The module docstring claims trapping is modelled. It
  is not.
- **The isotropic near-field term (`field.py:358`) is half-clipped.** Its axis-aligned bounding
  box has *zero* upwind extent when transport is cardinal (0/90/180/270°) and 1,450 m when it is
  diagonal. The comment says the term exists "so an upwind fenceline node is not blind" — on a
  due-north wind it is exactly blind, and how much upwind near-field a monitor sees depends on
  the wind's compass direction as a pure artefact.

### What else is missing

- **No model tiers.** One consultant study plus one live cone. Nothing represents "basic" vs
  "Aclima-enhanced", and nothing represents a model the operator authored or tuned.
- **No forecast.** `wind` holds 2,160 *historical* hours (`speed_ms`, `dir_deg`, `gust_ms`,
  `temp_c`, `rh`, `pbl_m`, `stability`). Nothing is forward-looking, so "Earth-2 predictions
  several days out" has no substrate at all.
- **No calibration lineage.** `monitor.last_calibrated` is a bare date string. Nothing models
  a mobile node calibrated against a reference monitor, nor peer-to-peer transfer onward. The
  owner says this process is real and uniquely Aclima's — it needs inventing from scratch.
- **The drive planner is plume-blind.** `src/air/datagen/driveplan.py` is a genuine
  Chinese-Postman route-inspection solver — seeded k-means partition → largest connected
  sub-graph → greedy nearest-pair odd-node matching → Hierholzer Eulerian circuit → shift walk
  under a class-dependent speed model. It optimises a **uniform per-segment pass deficit** and
  has no notion of a forecast, a plume, or a priority weight.

### What the new narrative can stand on

- **`GET /sites/{id}/model-verification`** already computes assumed-rose vs observed-rose
  disagreement, understated bearings, affected districts and a verdict — with an
  `insufficient_data` guard rather than a confident wrong answer. This is the seed of the
  whole narrative and the pattern the rest should follow.
- **`mobile_wind_obs`** — 28,427 rows of real fleet anemometry with a `quality` flag
  (`good` / `suspect` / `rejected`). Observed wind from the moving platform already exists.
- **`emission_point`** already carries `kind` / `height_m` / `active`, so site configuration
  has a data model to build on.
- **`field.py`'s Gaussian machinery** is real physics, not a fake. A better reach model is a
  parameter change, not a rewrite.

### Routes today, for reference

| app | routes |
|---|---|
| community | `/`, `report`, `map`, `dashboard`, `status`, `outreach`, `c/$concernId` |
| regulator | `/`, `map`, `alerts`, `thresholds`, `analysis` |
| industry | `/`, `scope`, `alerts`, `alerts/$alertId`, `community`, `outreach`, `site` |
| admin | `/`, `campaign`, `driveplan`, `fleet`, `data`, `oversight`, `director` |

---

---

## The design

Produced by workflow `wf_6d1e8121-924` — seven territory designs, three critique lenses,
one synthesis. 11 agents, 2.0M tokens, no failures. Raw payloads in the session scratchpad
(`plume-territories.json`, `plume-critiques.json`, `plume-plan.json`) and in that run's
`journal.jsonl`.

### Thesis

The brief is buildable and the physics half of it is right, cheap, and already half-written in the repo. The measurement half is not yet a settled quantity, and four of the seven proposed territories build screens on it. Independently re-derived this session: the same-hour paired estimator for Ridgeline's stable-air touchdown at 1.5-4 km returns -3.85 ppb, +1.45, +3.69 or +3.98 depending only on the control pool's inner radius and whether road classes are matched, across 14-17 paired hours. The sign is a parameter, not a finding. Meanwhile field.py clips every plume to a 4,200 m window and 77% of road segments (1,007 of 1,307) lie beyond it from Ridgeline, so the truth itself is absent from three quarters of the network and no far-field measurement can be anything but an artefact. So the plan splits the narrative into two things that are separately true. REACH is a physics fact and gets fixed first, everywhere at once, from one shared kernel - that alone answers the owner's "tiny blob" complaint in about two days with no rebuild and no schema change. CLAIM is an evidence question and is quarantined until an estimator survives a rotation placebo and a published parameter sweep. Draw the plume as far as the physics says; compute a verdict only inside the driven-coverage mask and inside a per-class detection envelope; render everything beyond it in a labelled model-only register. That one split reconciles the four territories that were arguing about whether the plume reaches 1.4 km or 15 km - they were arguing about different objects. What ships is not one big change but ten, each leaving the demo working, with exactly two database rebuilds in the whole programme.

### The spine

Four phases, in order, before any interface work. (0) Reproducibility and three live defects: pin --now in the build command, fix the model-verification window that currently switches off the flagship industry claim by a default parameter, union the 39 overlapping cones Ridgeline draws today, and write the never-say list plus the model-vs-ink rendering rule into docs/CONTRACT.md as a new section 10. (1) One module, src/air/dispersion.py, at package root, importing neither air.datagen nor air.server, holding the Pasquill constants, sigma_y/sigma_z, stack_wind, h_eff, ground_axis, reach(), coerce_class(), plume_reach(), point_in_cone() and the per-class detection envelope - field.py, server/geo.py, /wind/dispersion, the estimator and any future planner all call it, so the drawn cone, the truth field, the interception metric and the sector gate cannot drift apart. (2) The estimator built as a throwaway probe script with a published parameter sweep and a mandatory rotation placebo, frozen as a committed fixture, with no endpoint and no screen. (3) The field.py window fix plus the sampling_mode columns in a single rebuild. (4) One endpoint, GET /sites/{id}/touchdown, returning per-segment LineString evidence rows plus a coverage mask, with one five-state enum that all four interfaces consume. Nothing interface-specific starts before phase 4 lands. Four territories independently designed five incompatible touchdown objects - five URL shapes, four geometry types, verdict enums of two, three, four and six states, and four different minimum-sample constants (5, 12, 150) for the same decision. Whichever shipped first, three interfaces would have been rebuilt. The substrate is the whole cost of avoiding that.


---

## Phases

Ten phases. Each leaves the demo working. **Exactly two require a database rebuild.**
Nothing interface-specific starts before phase 4.

| # | phase | rebuild | what becomes demoable |
|---|---|---|---|
| 0 | Reproducibility, three live defects, and the constraints in writing | no | Ridgeline draws three clean plume bands instead of 39 overlapping slivers, and the industry model-verification panel returns `understates` with real u… |
| 1 | One dispersion kernel - the keystone | no | The plume finally behaves like weather in all four interfaces at once: small and tight under unstable daytime air, reaching across the monitored area … |
| 2 | The estimator probe - a script, a sweep and a placebo, with no endpoint and no screen | no | Nothing new on screen; the demo is unchanged and still works. What ships is a committed sweep table, a placebo gate, a multi-seed check and a frozen f… |
| 3 | The truth window, the near field, and sampling_mode - the one rebuild before the endpoint | **yes** | Nothing visibly changes in layout, but the numbers underneath are now honest across the whole monitored area rather than only within 4.2 km of each so… |
| 4 | One touchdown endpoint, one enum, four consumers | no | Every interface can ask one question - where did the fleet actually find this site's plume, and where do we simply not know - and get the same answer,… |
| 5 | Industry - the model studio and the three-way diff | no | An operator sees their filed study, an Aclima model driven by observed wind, and the streets we actually measured, in one frame with the disagreement … |
| 6 | Community - climatology first, the soft cloud second | no | A resident opens the map and reads a calm, stable sentence: over the last three months the wind carried from Ridgeline over Boxtown about one hour in … |
| 7 | Regulator - coverage, siting, and the calibration limit stated honestly | no | A regulator sees in one header that their four towers stand inside a modelled plume in a minority of hours and that two of the four never do; a rose w… |
| 8 | Forecast substrate and the verification ledger - shipped together, never apart | **yes** | The product has forward-looking weather for the first time, in two usable tiers plus climatology, with a scored history alongside it computed from the… |
| 9 | Admin - the Mission Brief, read-only over the existing plan | no | A fleet lead opens one screen at 07:00 and reads the day's call in a sentence, sees where the plume is forecast to cross, sees today's routes coloured… |


### Phase 0 — Reproducibility, three live defects, and the constraints in writing

**Goal.** Make every measurement in this programme reproducible, fix three things that are broken on screen today, and put the honesty rules somewhere a caption change cannot remove them. Nothing here needs a rebuild, a schema change or a deploy, and each item is under an hour.

- [x] **P0-A** — Pin the build command as `python3 -m air.datagen.build build --seed 20260827 --now 2026-08-28T13:54:00`. Add a line noting the Dockerfile deliberately omits --now (line 76) so the deployed demo re-anchors to container build time and its data ends 'today' - correct for the demo, and it means prod and local are not comparable.
  - *where:* `CLAUDE.md (Verification commands block); a note beside Dockerfile:76`
  - *why:* setting('datagen.now') is 2026-08-28T13:54:00 in the checked-in DB and build.py:644 accepts --now, but the documented command omits it, so every rebuild re-anchors the campaign to wall clock. Every number in the seven territory reports and the three critiques - and the sweep in phase 2 - is unreproducible without this, and they will be re-derived many times.
- [x] **P0-B** — Pass an explicit window to useModelVerification at all three call sites, covering the campaign or at minimum the Aug 1-7 wind-shift episode (hours 1512-1656 from 2026-05-31).
  - *where:* `web/src/apps/industry/Scope.tsx:66, SiteConfig.tsx:22, ContactDetail.tsx:426`
  - *why:* domain.data_now returns max(latest_data, wall_clock) at domain.py:117-119. Local data ends 2026-08-28; today is 2026-09-10; the hook's 30-day default therefore asks 2026-08-11 to 2026-09-10 and misses the scripted episode entirely, returning `consistent`. The flagship industry claim is switched off by a default parameter, and it gets strictly worse daily - past 2026-09-28 the window contains zero observations.
- [x] **P0-C** — Union the per-band polygons inside /wind/dispersion so each (site, band) returns one polygon rather than one per emission point.
  - *where:* `src/air/server/routers/wind.py:79-110`
  - *why:* Ridgeline has 13 active emission points x 3 bands = 39 overlapping polygons inside a ~500 m cluster. That is literally the shape the owner is calling a tiny blob, and it is the cheapest visual improvement available.
- [x] **P0-D** — Add section 10 to docs/CONTRACT.md: the never-say list; the encoding rule (models are drawn as outlines, measurement is the only filled or inked thing, anything past the detection envelope is dashed with no fill plus a 'beyond measurement range - model only' legend line); and the ground-truth containment rule stated as data-flow rather than as an import ban.
  - *where:* `docs/CONTRACT.md (new section 10, alongside the existing non-negotiables)`
  - *why:* This codebase's honesty is currently enforced by the data and the API - industry gets a 403 on `resolved`, unattributable concerns are NULL, insufficient_data outranks the interesting verdict. Constraints that land only as captions get edited away in two sprints. Parallel interface agents inherit section 10 the way they already inherit 'industry cannot close a concern'. The containment rule must be data-flow because phase 1 puts the Briggs physics in a module the server can import: no value derived from evaluating a dispersion kernel at a receptor may be labelled measured, served under a touchdown path, or drawn in the measured register, whichever package computed it.

**Demoable after:** Ridgeline draws three clean plume bands instead of 39 overlapping slivers, and the industry model-verification panel returns `understates` with real understated bearings and affected districts instead of a flat `consistent`. The flagship 'verify your consultant' claim is switched back on.

**DONE — 2026-09-10.** Verification is `cd web && npx tsc -b --force` (exit 0) and
`npx oxlint src` (no new warnings); no rebuild, no schema change, no deploy.

*What the four items actually turned out to be:*

- **P0-A.** `CLAUDE.md` now pins `--now 2026-08-28T13:54:00`, and the Dockerfile
  carries the counterpart note beside its deliberately unpinned build. The
  divergence is stated as a rule with teeth: **prod numbers and local numbers
  are different worlds and must never be compared.**
- **P0-B.** *Worse than the plan estimated.* All three sites — not just
  Ridgeline — returned `consistent` on the default window: 6,346 of 28,324
  fleet wind observations. On the campaign window all three return
  `understates`, +5.8 points on the SW bearing, over Boxtown and White Chapel.
  Fixed with `useCampaignWindow()` in `apps/industry/lib.tsx`, anchored to
  `campaign.start_date`/`end_date` from bootstrap rather than to literal dates,
  so a rebuild under a different `--now` still asks the right question. Wired
  into all three call sites with `enabled` gated on the window resolving.
- **P0-C.** 39 features -> 9, one per (site, band), via the new
  `geo.plume_union_polygon`. Exact union in the downwind frame: rotate, merge
  crosswind intervals per station, rebuild. Two defects found while verifying
  it, both real rather than cosmetic:
  - stations placed only on an even sweep cut the corner at every kink where a
    cone starts or stops contributing, and *more* sampling does not fix it
    because the error is at a discontinuity. Removing the kink stations takes
    worst under-coverage from 2.9 m to **72.1 m**. Fixed by forcing paired
    stations either side of each kink.
  - those paired stations were 10 cm apart, which rounds away at the 5-decimal
    output precision, leaving zero-length edges — degenerate input to deck.gl's
    tessellator. Without de-duplication **90 of 96 rings carry one**; with
    de-duplication but the 10 cm nudge, **3 of 96 are still self-intersecting**.
    Both fixes are load-bearing. Fixed by widening the nudge to 2 m and
    de-duplicating consecutive vertices.
  Swept over 8 bearings x 4 stability classes x 3 bands, on all three real
  sites and a wider synthetic cluster: every ring simple, worst under-coverage
  **2.9 m** — the width of the nudge.

  *Correction to an earlier figure.* This entry first recorded 106 m and 126 m.
  Both were measured as distance to the nearest ring **vertex**, which is the
  obvious thing to write and badly wrong: where the rail steps across a kink
  the neighbouring stations are 4 m apart in x but up to 500 m apart in y, so a
  point 3 m outside the *edge* reports 234 m from the nearest *vertex*. The
  correct metric is point-to-segment distance, and it is now what the test
  uses. The two bugs are real; only my measurement of them was 40x off.
- **P0-D.** `docs/CONTRACT.md` section 10, in four parts: 10a the never-say
  list (6 rules), 10b the encoding table (models are outlines, measurement is
  the only inked thing, past-envelope is dashed with a legend line, outside the
  coverage mask is dimmed and excluded from every metric), 10c the placebo
  gate with the +32.99-vs--12.27 evidence, 10d containment stated as data flow.

*Carried forward:* `level` is now the emission-weighted **mean** across a
site's points rather than per point — a relative contour label, not a
concentration, so summing would make a site's brightness a function of how
finely its permit itemises the same campus. `emission_point_id` /
`emission_point` are gone from the payload; nothing on the web read them (they
were never in the `DispersionPlume` type). New properties: `n_sources`,
`reach_m`. P1-C replaces this endpoint wholesale, but
`geo.plume_union_polygon` survives it.


### Phase 1 — One dispersion kernel - the keystone

**Goal.** Make the drawn cone, the truth field, the reach metric and every future sector gate the same arithmetic, and fix reach so it depends on stability and source strength the way physics does. This phase answers the owner's headline complaint and needs no rebuild and no schema change.

- [x] **P1-A** — Create src/air/dispersion.py at package root. Move in unchanged _SIGY, _WIND_EXP, SIGMA_X0, RISE, the sigma_y/sigma_z bodies from _sigmas, and the stack-wind and h_eff expressions. Add ground_axis(), reach(height_m, kind, strength, u10, cls, pbl_m, measure, floor) returning {x_touchdown, x_peak, x_reach, lofted, truncated}, coerce_class(cls, u10) returning (class, note), plume_reach(), point_in_cone(), and DETECTION_ENVELOPE (about 4 km under E/F, about 1.5 km otherwise - provisional until the phase-2 sweep sets it). The module must import neither air.datagen nor air.server.
  - *where:* `src/air/dispersion.py (new); constants currently at src/air/datagen/field.py:59-76 and 294-308`
  - *why:* Four territories proposed four homes for the same constants: air/plume_kernel.py, air/dispersion.py, an extraction into server/geo.py, and 'just reuse field.py'. Four names means four implementations and guaranteed drift; the last option is the one the containment rule exists to prevent. One module at package root is the only arrangement where the truth field and the drawn cone cannot disagree.
- [x] **P1-B** — Rewrite field.py::_plume to call the kernel. Behaviour must be bit-identical: verify by rebuilding with --now pinned and diffing SELECT SUM(no2) FROM segment_pass against the pre-change value.
  - *where:* `src/air/datagen/field.py:294-359`
  - *why:* A refactor that silently changed the truth field would invalidate every downstream calibrated number with nobody noticing. The window fix is deliberately held to phase 3 so this step is provably a no-op.
- [x] **P1-C** — Rewrite GET /wind/dispersion against the kernel. Replace base_reach = (700 + 240*speed) * reach_mult with the kernel's sigma_z-based reach; scale by source strength as well as stack height; replace the radial BANDS split with profile-driven band levels sampled from ground_axis; add per-feature x_touchdown_m, x_peak_m, x_reach_m, lofted, truncated and stability_coerced_from.
  - *where:* `src/air/server/routers/wind.py:22 (BANDS), :82-110; src/air/server/geo.py:63-89 (STABILITY, plume_polygon, tighten)`
  - *why:* Three defects in one formula. Reach ignores source strength entirely, so Ridgeline's substation (strength {}) draws the same cone as six 14.6 MW turbine banks. The radial band split puts the brightest band at the stack, which is backwards for a lofted source - ground-level concentration at the stack is near zero and the maximum is 1-5 km out. And geo.STABILITY encodes a 3x spread across Pasquill classes where the physics is closer to 15x, which is the actual cause of the tiny blob: the honest fix is not 'make everything bigger', it is 'make reach depend on stability'.
- [x] **P1-D** — Add coerce_class at the API boundary and surface the coercion as stability_coerced_from in feature properties with a one-line UI note. Do NOT present this as fixing the tiny blob.
  - *where:* `src/air/dispersion.py, src/air/server/routers/wind.py`
  - *why:* The orchestrator brief and three territories treat 'F at 6 m/s' as a measured finding. It is not: verified across all 2,160 wind rows, F maxes at 2.98 m/s and E at 3.69. The state never occurs, so the widely quoted 4.3 km reach is the formula evaluated on fabricated input. The guard is still worth having because forecasts (phase 8) and user-tunable site config will genuinely produce it - but it must be struck from every narrative.
- [x] **P1-E** — Apply the phase-0 encoding rule at every DispersionLayer call site: bands inside the detection envelope render normally, bands beyond it render dashed with no fill plus the legend line. Add the import-closure test asserting air.dispersion imports neither air.datagen nor air.server.
  - *where:* `web/src/apps/*/lib.tsx dispersion layer construction; tests/`
  - *why:* This is where the reach-versus-claim split becomes visible rather than asserted. A 10 km cone from Ridgeline covers 96.7% of the road grid; without a visible register change, the enlarged plume turns every model-versus-measurement diff into a picture of the campaign boundary.

**Demoable after:** The plume finally behaves like weather in all four interfaces at once: small and tight under unstable daytime air, reaching across the monitored area on stable nights, with a visible aloft segment near the stack where a lofted plume has no ground-level impact and a bright touchdown band 1-5 km out. Everything past the detection envelope is visibly drawn as model-only. The owner's headline complaint, answered from one module, with no rebuild.

**DONE — 2026-09-10.** `uv run pytest` 139 passed / 1 xfailed, `npx tsc -b
--force` exit 0, `npx oxlint src` no new warnings. There WAS a rebuild, for the
reason in the last bullet.

**Measured reach, all 2,160 real wind rows, per site:**

| site | sources | p10 | median | p90 | at the 8 km cap |
| --- | --- | --- | --- | --- | --- |
| Ridgeline | 13 | 1,620 m | **2,920 m** | 8,000 m | 43% of hours |
| Delta Forge | 4 | 800 m | **1,400 m** | 8,000 m | 32% |
| Riverport | 4 | 840 m | **1,500 m** | 8,000 m | 33% |

The old formula gave every site the same reach within 3x across all weather.
Now a summer afternoon is under a kilometre, a still night is capped at the
domain edge, and Ridgeline's plume is twice Delta Forge's because it emits
twice as much.

*What each item turned out to be:*

- **P1-A.** `src/air/dispersion.py`. Constants moved verbatim. Added
  `Source`, `profile`, `ground_axis`, `half_width`, `reach`, `bands`,
  `coerce_class`, `point_in_cone`, `DETECTION_ENVELOPE`. Two deviations,
  recorded in the module rather than hidden: `plume_reach()` was folded into
  `reach()` (they were one function under two names — the exact failure this
  module exists to prevent), and `reach`/`bands` take a LIST of sources,
  because a site is a cluster and one polygon per site needs one profile per
  site.
- **P1-B.** Bit-identical, proved two ways. `tests/test_plume_kernel_parity.py`
  snapshots `_plume` over ten cases (lofted stack, trapped, off-grid, each
  stability class) and asserts `np.array_equal` — not `allclose`, because the
  claim is that the arithmetic is the same arithmetic. Then the rebuild the
  plan asked for: `segment_pass` sums for no2, pm25, bc, o3, co and co2
  identical to the last digit, `monitor_reading` identical, 31 alerts either
  side. **ch4 was not** — see the last bullet.
- **P1-C.** Bands are contours of the site's combined ground-level profile,
  not radial slices. Reach comes from an ABSOLUTE concentration floor, which
  is what makes it depend on how much is emitted; a relative floor would draw
  a substation exactly as far as six turbine banks. `geo.plume_union_polygon`
  gained a `half_width` hook so the cone edge is the kernel's sigma_y — a
  shallow curve rather than a straight-sided cone — with the old behaviour as
  the default so nothing else moved.
- **P1-D.** `coerce_class` is in, and the bounds are **read off
  `weather._pasquill`'s own lookup table, not off a textbook**. That is not
  pedantry: the generator does not coerce, so any bound tighter than its table
  makes the drawn cone disagree with the simulated truth on real weather. The
  textbook figures (A<2, B<5, C<8) silently rewrote the stability of six real
  campaign hours at the UNSTABLE end — A at 2.96 m/s, B at 5.32, C at 8.58 to
  9.83. A test asserts coercion never fires on this campaign's own wind.
- **P1-E.** `DispersionLayer` splits the register: inside the envelope a
  filled contour, past it a dashed unfilled outline
  (`@deck.gl/extensions` `PathStyleExtension`, pinned `~9.3.10` to match the
  rest of the deck.gl tree). `BEYOND_ENVELOPE_NOTE` and `hasBeyondEnvelope`
  are exported so all four interfaces print one sentence instead of four
  paraphrases. The industry scope prints a live reading under the map — class,
  speed, reach, and "N sources aloft, touching down X out". Import closure is
  asserted statically (AST) and dynamically (fresh interpreter, check
  `sys.modules`).

**Three findings that were not on the task list.**

1. **The generator did not reproduce itself.** Two builds at the same `--seed`
   and the same `--now` gave SUM(ch4) of 109821.0891 and 109802.3856, with
   2,777 differing `segment_stat` rows — every one of them ch4 or
   methane_leak, every other measure identical to the last digit. Cause:
   `field.py` derived each leak's duty offset from `abs(hash(leak_id))`, and
   Python randomises `hash()` on str per process. Leaks were the only thing
   that hashed an id, which is why it stayed invisible. **This invalidated
   P0-A's premise** — pinning the seed and the clock did not make the build
   reproducible — and P2's whole method is "freeze the seed, sweep one
   parameter, compare". Fixed with `zlib.crc32`; `tests/test_datagen_determinism.py`
   pins the spreader, re-runs it under three `PYTHONHASHSEED` values in fresh
   interpreters, and AST-scans the package for any other `hash()` on a
   non-numeric value. Two consecutive rebuilds now match exactly. The one
   lasting effect is that ch4 and methane_leak values moved; nothing else did.
2. **Touchdown is a property of the elevated sources, not of the site.** A
   site's combined ground profile peaks at the fence whenever it has any
   ground-level release — Ridgeline's 3 m traffic gate is 98% of the ground
   concentration at 100 m under F — so asking a whole site "are you lofted"
   always answers no. The endpoint asks the elevated sources separately, and
   `elevated` is decided by the kernel (is this source's own plume aloft at
   its base) rather than a height cut-off. Related: `lofted` had to be made
   **scale-free** — a ratio to the plume's own peak, not a distance measured
   against `DRAW_FLOOR`, which made Delta Forge's two 34 m stacks come back
   aloft in daytime B purely because the floor is calibrated for whole sites.
3. **Boundary-layer trapping steps the profile UP.** `np.maximum(vert,
   trapped)` is discontinuous where sigma_z outgrows the mixed layer, so a
   band labelled by the MEAN concentration inside it came out brighter than
   the band inside it (D at 0.6 m/s, 90 m boundary layer). Bands are labelled
   by their contour instead. The step is faithful to the truth field's
   trapping model and P3 revisits it.


### Phase 2 — The estimator probe - a script, a sweep and a placebo, with no endpoint and no screen

**Goal.** Decide whether a measured touchdown can be claimed at all, and on what parameters, before any interface is designed against it. This is the phase every territory skipped and the one where the schedule will otherwise break.

- [x] **P2-A** — Write the estimator as a standalone probe script and run an explicit parameter sweep: control pool inner radius (300/1000/1500/2000 m), wedge half-angle (fixed vs sigma_y-scaled), road-class matching on/off, baseline definition (segment-own-median vs hourly background), co-located-source exclusion on/off, and minimum-n. Run across all three sites and at least NO2 and PM2.5. Publish the sweep table as the design record in docs/PLAN-plume.md.
  - *where:* `scripts/probe_touchdown.py (new, throwaway); docs/PLAN-plume.md`
  - *why:* Reproduced this session: Ridgeline stable-air downwind excess at 1.5-4 km returns -3.85 ppb (control from 300 m, unmatched classes), +1.45 (300 m, matched), +3.69 (1000 m, matched) and +3.98 (1500 m, matched), on 14-17 paired hours. The mechanism is field.py:73's NEAR_SIGMA_M = 640 m isotropic near-field term: control passes drawn from 0.3-1 km carry it and invert the contrast. Three territories published three different headline numbers (+4.60, +6.0, +38.2) and a fourth published +0.1 for the same quantity. No number from any of them may schedule UI work, write copy or set a demo beat until one estimator is chosen and its sweep is on paper.
- [x] **P2-B** — Make a rotation placebo a mandatory acceptance criterion: re-run the estimator with the transport bearing rotated +90/+180/+270 degrees. Any stratum whose placebo magnitude is within 2x of its true-bearing magnitude is not reportable and must return insufficient_data.
  - *where:* `scripts/probe_touchdown.py; acceptance criteria recorded in docs/PLAN-plume.md`
  - *why:* Not one of the seven territories ran a null test. The one placebo that was run returned +32.99 ppb at a fabricated bearing against -12.27 at the true bearing in the same stratum. An estimator producing multi-ppb detections with tight confidence intervals for wind directions that never occurred is measuring road-class composition and diurnal amplitude, not a plume.
- [x] **P2-C** — Re-run the frozen configuration across at least three seeds. Record which findings survive and which are seed artefacts.
  - *where:* `scripts/probe_touchdown.py, with --seed sweeps`
  - *why:* The Boxtown result is the load-bearing narrative beat in three interfaces. If it does not survive a reseed, all copy must be generated from the numbers at runtime rather than written, and the demo cannot depend on it.
- [x] **P2-D** — Freeze the chosen configuration as a committed regression fixture with the sweep table attached, and record the three rejected variants as failing tests so nobody re-derives them. Set MIN_DOWNWIND / MIN_CONTROL / detect_floor from the measured joint distribution, and write down explicitly whether the touchdown is a per-segment or a site-level pooled claim.
  - *where:* `tests/fixtures/touchdown_*.json; tests/test_touchdown_estimator.py`
  - *why:* Three territories proposed three minimum-sample constants (5, 12, 150) for the same decision, chosen by intuition. Measured with segment-as-own-control under E/F, zero of 1,307 segments clear 12 conditioned passes on both sides and only 38 clear 5 - so one territory's honesty floors would make every screen permanently empty, and neither noticed because each validated against its own aggregation. That sample-size number is also the strongest argument in the brief for targeted driving, and it belongs on the Mission Brief.

**Demoable after:** Nothing new on screen; the demo is unchanged and still works. What ships is a committed sweep table, a placebo gate, a multi-seed check and a frozen fixture - the artefact that decides whether phases 4 through 9 are building on evidence or on an artefact. Skipping this phase costs a week of simultaneous rework in four interfaces.

**DONE — 2026-09-10.** `uv run pytest` 148 passed / 1 xfailed. Nothing on
screen changed. `scripts/probe_touchdown.py` is the probe;
`tests/fixtures/touchdown_frozen.json` and `tests/test_touchdown_estimator.py`
are the frozen decision.

### The answer

**One finding is dependable: Ridgeline NO2 is elevated downwind in stable air,
and the downwind ground is Boxtown.** Everything else fails a gate.

| site / measure | excess | 95% CI | paired hours | placebo ratio | state |
| --- | --- | --- | --- | --- | --- |
| Ridgeline / NO2 | **+5.08 ppb** | +3.62 … +6.54 | 14 | 0.00 | `elevated_downwind` |
| Ridgeline / PM2.5 | +0.96 | +0.07 … +1.85 | 13 | 1.03 | `no_detection` |
| Delta Forge / NO2 | +0.08 | −0.47 … +0.63 | 9 | 12.8 | `no_detection` |
| Delta Forge / PM2.5 | +0.58 | −0.87 … +2.03 | 9 | 1.10 | `no_detection` |
| Riverport / NO2 | +4.05 | +1.34 … +6.75 | 16 | 0.35 | `elevated_downwind` |
| Riverport / PM2.5 | +0.97 | −0.10 … +2.04 | 16 | 0.54 | `no_detection` |

### P2-A — the sweep (64 configurations x 3 sites x 2 measures, each with 3 placebos)

Run: `uv run python scripts/probe_touchdown.py sweep`. Ridgeline NO2, stable
air, downwind 1.5–4 km:

| configs estimating | range | sign | passed the placebo |
| --- | --- | --- | --- |
| 64 / 64 | **−10.27 to +5.49 ppb** | 54 positive, 10 negative | 21 |

**Which knob moves it, alone, averaged over the other five:**

| knob | spread | values |
| --- | --- | --- |
| `control_inner_m` | **5.43 ppb** | 300 = −1.64, 1000 = +3.09, 1500 = +3.47, 2000 = +3.79 |
| `wedge` | **4.42 ppb** | fixed = −0.03, sigma = +4.39 |
| `match_road_class` | 1.58 | on = +2.97, off = +1.39 |
| `baseline` | 1.47 | raw = +0.28, segment-own-median = +1.75 |
| `exclude_colocated` | 1.43 | on = +1.74, off = +0.30 |

The two knobs that dominate both have a named mechanism, which is what makes
this a finding rather than a fit. A control pool starting at 300 m carries
`field.py`'s isotropic near field (NEAR_SIGMA_M = 640 m) and INVERTS the
contrast — the same site, hours and measure reads −10.27 ppb. A fixed
30-degree wedge is about four times too wide under stable air, where the
kernel's own sigma_y is roughly 8 degrees at 2 km.

With `wedge=sigma` and `control_inner >= 1000`, all 24 cells land between
**+4.8 and +5.5 ppb** on 16 paired hours. That plateau is the finding; the
±16 ppb range across all 64 is what happens without a reason for the knobs.

### P2-B — the placebo gate, and why it is not enough

Rotating the transport bearing by +90/+180/+270 and refusing any stratum whose
placebo comes within 2x of the true bearing is in, and it does work. It is
**not sufficient**, and the counter-example is decisive:

> In the band **4,400–6,500 m**, where `field.py` clips the truth field to zero
> and there is therefore nothing to detect, Ridgeline PM2.5 returned **+1.26
> [+0.52, +2.01]** with a placebo ratio of 0.49. It passed. Extending the null
> to 14 fabricated bearings gave z = 2.4 — it passed that too.

No rotation test can be trusted where the truth is identically zero, because
the rotated comparison is noise against noise. So acceptance is **three gates
plus a structural refusal**:

1. placebo ratio < 0.5 (P2-B);
2. `|excess| >= DETECT_FLOOR` — measured, not chosen: twice the worst site's
   95th percentile of `|excess|` over 14 fabricated bearings, giving **2.36 ppb
   NO2** and **3.40 µg/m³ PM2.5**;
3. enough conditioned data — `min_downwind_per_hour = 3`, `min_control_per_hour
   = 8`, `min_hours = 8`;
4. and `probe.check_window()`: **nothing past 4,200 m is reportable until P3-A
   lands and the database is rebuilt**, whatever the statistics say.

Under the tightened minimums the far-field band returns `insufficient_data` on
its own — three downwind passes in one hour at 4–6 km is rare — so gate 3 also
kills that false positive. Belt and braces, deliberately.

### P2-C — three extra seeds

Built with `--seed 20260828 / 20260829 / 20260830`, same pinned `--now`:

| site / measure | seed 20260827 | 20260828 | 20260829 | 20260830 | gate |
| --- | --- | --- | --- | --- | --- |
| Ridgeline / NO2 | +5.08 | +5.33 | +4.68 | +2.92 | **4 / 4** |
| Riverport / NO2 | +4.05 | +1.51 | +2.79 | — | 2 / 4 |
| Delta Forge / NO2 | +0.08 | +1.87 | — | −1.69 | 0 / 4 — sign flips |
| all PM2.5 | | | | | 0 / 4 |

And the narrative beat, separately, because it is the part the demo leans on:

| database | downwind passes | circular-mean bearing | mean distance | districts |
| --- | --- | --- | --- | --- |
| seed 20260827 | 277 | 15° | 3,438 m | **Boxtown 94%**, White Chapel 6% |
| seed 20260828 | 293 | 26° | 3,349 m | **Boxtown 89%**, White Chapel 11% |
| seed 20260829 | 161 | 21° | 3,619 m | **Boxtown 90%**, White Chapel 5% |
| seed 20260830 | 294 | 39° | 3,360 m | **Boxtown 77%**, White Chapel 18% |

**So: the place survives a reseed, the number does not.** Boxtown takes 77–94%
of Ridgeline's stable-air downwind passes in every world, at 3.3–3.6 km on a
bearing of 15–39°, which matches the geometry — Boxtown's road segments average
3.02 km at bearing 18° from the emission-weighted source, and stable-regime
transport is N / NNE / NNW / NE. The magnitude moves between +2.92 and +5.33
ppb, a factor of 1.8.

**Consequences, which are binding on phases 4 through 9:**

- The Boxtown beat may be depended on. **The number may not be written down** —
  every figure must be generated from the payload at runtime.
- **Riverport's detection may not carry a demo beat** (2 of 4 seeds).
- Delta Forge is a genuine `no_detection`, and that is worth keeping rather than
  hiding: one site with evidence next to one without is the honest picture, and
  it is a better demo than three sites that all light up.

### P2-D — the frozen configuration

`scripts/probe_touchdown.py::FROZEN`, pinned by
`tests/fixtures/touchdown_frozen.json`. Chosen by mechanism, not by best
number — notably **not** `control_inner = 2000`, which scores a better placebo
ratio (0.10 vs 0.40); picking the cell with the prettiest null test is fitting
to the null test. 1,500 m is 2.3x NEAR_SIGMA_M, which is a reason that does not
mention the result.

The three rejected variants are committed as tests so nobody re-derives them:
control-from-300 m (sign inversion), the fixed wedge (which also collapses its
own control pool — 743 control passes over 14 hours become 253 over 8, so the
placebos cannot even be computed), and the beyond-window band.

**Per-segment or site-level pooled?** Site-level pooled, and not by preference.
Measured under the frozen configuration: 94 of 1,307 segments are ever downwind
of Ridgeline in stable air, and **zero** accumulate 12 conditioned passes on
both sides; only 7 reach 5. Per-segment geometry is **evidence display only**
(P4-C's LineStrings) and must never carry a verdict. That number is also the
strongest argument in the brief for targeted driving, and it belongs on the
Mission Brief.

### One thing this phase did not settle

The estimator's `baseline='segment'` subtracts each street's own campaign
median, which includes the hours the plume was over it. That biases the
estimate toward zero — it is conservative, so the detection survives it, but a
proper version would build the baseline from upwind hours only. Left alone
deliberately: changing it now would invalidate the sweep, and the direction of
the bias is the safe one.


### Phase 3 — The truth window, the near field, and sampling_mode - the one rebuild before the endpoint  ⚠️ **rebuild**

**Goal.** Unclip the truth so a measured touchdown has something to find, fix the near-field artefact, and record why each drive happened. One rebuild, one re-tune, everything that needs a rebuild before phase 4 done together.

- [x] **P3-A** — Replace the hard-coded evaluation window L, Wd = 4200.0, 1450.0 with a per-hour window sized from that hour's own kernel x_reach, clipped to the raster. Benchmark first: full-raster evaluation is the simple alternative at roughly 1.26 ms per 256x256 call.
  - *where:* `src/air/datagen/field.py:326`
  - *why:* Verified: 1,007 of 1,307 road segments (77.0%) lie beyond 4,200 m from Ridgeline, so the truth field is identically zero across three quarters of the monitored network. Every far-field measured number published by any territory - the +1.8 ppb at 4-6 km, the +3.2 at 6-8 km - sits where ground truth does not exist and is a provable false positive. Nothing beyond the current window may be reported until this lands and is rebuilt.
- [x] **P3-B** — Compute the isotropic near-field term on its own symmetric box of half-width 3 * NEAR_SIGMA_M (1,920 m) centred on the source, added separately from the downwind cone.
  - *where:* `src/air/datagen/field.py:357-359`
  - *why:* The near-field term currently inherits the cone's axis-aligned bounding box, which has zero upwind extent when transport is cardinal (0/90/180/270) and 1,450 m when it is diagonal. The comment says the term exists 'so an upwind fenceline node is not blind'; on a due-north wind it is exactly blind, and how much a monitor sees depends on the wind's compass direction as an artefact. This is also the term that inverts the estimator's sign in phase 2, so fixing it changes the sweep.
- [x] **P3-C** — Add sampling_mode TEXT NOT NULL DEFAULT 'uniform' CHECK (sampling_mode IN ('uniform','targeted','control')) to drive, inherited onto segment_pass. Community-facing and cross-street-comparison segment_stat is computed from uniform passes only.
  - *where:* `src/air/db/schema.sql; src/air/datagen/simulate.py::segment_passes; src/air/datagen/stats.py`
  - *why:* Targeted driving biases per-segment medians upward by up to +57%, and 2.66x on the worst near-source case from four passes. Those medians feed the community headline risk score and the regulator's street ranking, so without the column the product's headline becomes a function of the dispatcher. One territory refused it on the grounds that stratum is geometry computed at analysis time - true, and a different fact. Why a car was sent somewhere is a property of the drive, recorded once; which stratum a pass falls in stays computed. Note the claim that this is irreversible is wrong: build.py wipes and rewrites every physical table, so a rebuild un-mixes it. Add it now because it is free while a rebuild is already happening, not because it is a one-way door.
- [x] **P3-D** — Rebuild, then re-run the phase-2 sweep against the new database and diff it. Re-tune what moved: exceedance counts, the aclima_sense distribution, alert counts, and any demo beat depending on a specific number.
  - *where:* `python3 -m air.datagen.build build --seed 20260827 --now 2026-08-28T13:54:00; docs/PLAN-sense.md for the sense composite`
  - *why:* One territory called this 'a re-tuning exercise, not a patch'; the sequencing critique checked and found it overstated - action_level is 11 rows anchored to real EPA NAAQS and DRAQA screening values rather than fitted to the data, and there are 31 alerts total. What genuinely moves is exceedance counts (14 today) and the sense distribution. Budget a day, not a week - but budget it, and re-run the sweep so the re-tune is measured rather than assumed.

**Demoable after:** Nothing visibly changes in layout, but the numbers underneath are now honest across the whole monitored area rather than only within 4.2 km of each source, and the fenceline monitors stop seeing a near-field that depends on the compass. The updated sweep table is the input to phase 4's constants.

**DONE — 2026-09-10.** `uv run pytest` 163 passed / 1 xfailed, `npx tsc -b
--force` exit 0. Rebuilt three times from scratch; all three byte-identical.
Build time **113 s -> 177 s**.

### The headline: the re-tune the plan budgeted a day for is not needed

Every number that could have moved, before and after:

| | before | after | |
| --- | --- | --- | --- |
| NO2, total over all passes | 748,633 | 760,800 | **+1.6%** |
| PM2.5 | 680,488 | 682,542 | +0.3% |
| O3 | 1,481,404 | 1,471,459 | −0.7% (more NO2 to titrate) |
| monitor readings, total | 1,355,895 | 1,476,710 | **+8.9%** |
| street median NO2, p50 | 11.16 | 11.34 | +1.6% |
| street median NO2, **p90** | 16.57 | 17.70 | **+6.8%** |
| street median NO2, **max** | 33.40 | 37.80 | **+13.2%** |
| `aclima_sense` p50 / max | 27.40 / 43.82 | 27.47 / 44.49 | +0.3% / +1.5% |
| alerts | 31 | 31 | one moved `integrated_exposure` -> `exceedance` |
| action-level exceedances | 0,0,0,3,0,0,0,0,0,0,0 | identical | **no threshold crossed** |
| concerns / advisories | 204 / 5 | 204 / 5 | unchanged |

The shape of that is exactly what the fixes predict: the median barely moves,
the far tail moves a lot, and the fixed monitors — which sit at fencelines,
where the near-field artefact lived — move most. **Nothing needed re-tuning.**
The sequencing critique was right that "a re-tuning exercise, not a patch" was
overstated: `action_level` is 11 rows anchored to real EPA and DRAQA values
rather than fitted, and none of them came close to moving.

### P3-A — the window is gone, not resized

The plan asked for a per-hour window sized from the kernel's `x_reach`. Built
it, measured it, deleted it. At a floor honest enough for a TRUTH field —
`TRUTH_FLOOR = 1e-7`, about 0.02 ppb of NO2 once `K_PT_NO2` is applied, two
orders of magnitude below `DRAW_FLOOR` — the window is the whole raster in
every stability class:

| floor | ppb NO2 | B 2.5 | C 4.5 | D 3.5 | E 2.0 | F 1.5 |
| --- | --- | --- | --- | --- | --- | --- |
| 1e-5 (`DRAW_FLOOR`) | 1.95 | 400 | 550 | 1,050 | 0 | 0 |
| 1e-6 | 0.19 | 1,850 | 2,600 | 6,800 | 16,000 | 16,000 |
| **1e-7 (`TRUTH_FLOOR`)** | **0.02** | **6,850** | **12,100** | **16,000** | **16,000** | **16,000** |

The raster is 11.8 km across. So there is no window to size, and full-raster
evaluation — 1.24 ms per call against 0.23 ms windowed — retires the entire
class of bug instead of re-parameterising it. Effect on the golden fixture:
non-zero cells roughly **triple** (10,340 -> 35,065 on a typical case), and the
lofted stack nearly doubles in total mass (x1.95) because a lofted plume's mass
is far downwind, exactly where the window was cutting it.

### P3-B — the near field stopped depending on the compass

The isotropic campus term inherited the cone's rotated bounding box, which has
**zero upwind extent on a cardinal wind** and 1,450 m on a diagonal one. The
comment said the term exists "so an upwind fenceline node is not blind"; on a
due-north wind it was exactly blind. It now has its own symmetric box of
3 x NEAR_SIGMA_M. Measured 400 m upwind across eight transport bearings:
4.05e-5 to 4.24e-5, a 1.05x spread that is grid quantisation. Previously
cardinal winds gave exactly zero.

### P3-C — `sampling_mode`, installed inert

On `drive`, inherited onto `segment_pass`, CHECK-constrained to
`uniform|targeted|control`. `stats.uniform_only()` filters
`build_segment_stats`, `campaign_summary` and `district_rollup`, and a test
asserts all three call it. Everything is `uniform` today and will be until the
Mission Brief dispatches (phase 9) — the guard exists before the thing it
guards against, which was the point of doing it while a rebuild was happening.

### P3-D — the phase-2 sweep, re-run

**The phase-2 conclusions survive.**

| site / measure | before rebuild | after | state |
| --- | --- | --- | --- |
| Ridgeline / NO2 | +5.08 | **+5.09** | `elevated_downwind` (z 7.6) |
| Riverport / NO2 | +4.05 | **+4.01** | `elevated_downwind` (z 4.0) |
| Delta Forge / NO2 | +0.08 | +1.81 | `no_detection` — still inside its null |
| all PM2.5 | | | `no_detection` |

`DETECT_FLOOR` was re-calibrated, because it is defined against the database it
protects: unclipping the truth put real structure in the far field, so the
estimator's noise at fabricated bearings rose with it (worst-site null p95
1.18 -> 1.65 NO2). The floor went 2.36/3.40 to **3.30/3.46**. Both detections
clear the higher bar and no verdict changed.

**Two things changed shape, and both are recorded as tests.**

1. **The 4,200 m structural refusal is retired, and something weaker replaces
   it.** There is ground truth in the far field now — 989 of 1,307 segments lie
   beyond 4,200 m from Ridgeline and carry 21,618 passes averaging 13.4 ppb.
   Re-measured at 4.4–6.5 km, Ridgeline NO2 is +3.43 [+2.29, +4.56] on 11
   paired hours. It is still not reportable, but for a new reason: **every
   rotated placebo comes back empty**, and an estimate that cannot be falsified
   is not reportable however tight its interval. That rule is now explicit in
   `Estimate.clears_placebo` rather than an accident of `nan` comparisons.

2. **A rejected variant now PASSES every gate.** With the far field populated,
   the `control_inner = 300 m` cell reads **−19.23 ppb [−27.56, −10.91]** —
   wrong-signed by 24 ppb — with a placebo ratio of **0.44** and a magnitude
   far over the floor. A rotation test cannot see it, because the near-field
   artefact is isotropic and looks identical at every bearing. The knob
   sensitivities sharpened with it: `control_inner_m` moves Ridgeline NO2 by
   **9.29 ppb** (was 5.43) and `wedge` by **7.17** (was 4.42).

   This is the argument for the whole shape of P2-D, and it is now the
   docstring of `test_a_control_pool_from_300m_inverts_the_sign`: the frozen
   configuration is chosen **by mechanism and pinned to a fixture**. It is not
   "whichever cell passes the gates", because this cell does.

### Cost and one operational trap

Build time 113 s -> 177 s clean (passes 18 s, segment_stat 9 s,
monitor_reading 73 s, narrative 73 s). Earlier runs of 1,071 s and 1,369 s were
this session's own test runs competing for CPU, not the build — worth knowing
before anyone "optimises" it.

Adding a column to `schema.sql` does **nothing** to an existing database: every
statement there is `CREATE TABLE IF NOT EXISTS`, so SQLite skips the table and
the build dies much later with `table drive has no column named
sampling_mode`, which reads like a code bug. `db.apply_schema` now diffs the
declared columns against the live ones and fails immediately with the `rm`
command to run. There are no migrations here on purpose.


### Phase 4 — One touchdown endpoint, one enum, four consumers

**Goal.** Ship the measured touchdown as a single object all four interfaces read, with the coverage mask that bounds every claim made from it. This is the last substrate phase; interface work starts after it and not before.

- [x] **P4-A** — Promote the frozen probe into src/air/server/touchdown.py: pure functions, numpy, reading only segment_pass, mobile_wind_obs, wind, monitor_reading and concern. Source point is the emission-weighted centroid of the site's active emission points, so toggling a stack moves it. Road-class matching and segment-as-own-control are built in, not optional. The placebo gate from P2-B runs inside the estimate and downgrades any stratum that fails it.
  - *where:* `src/air/server/touchdown.py (new); tests/test_touchdown_estimator.py from P2-D`
  - *why:* The 10.2 ppb road-class spread (motorway 22.05 to residential 11.86, n=56,492) is larger than any plume enhancement anywhere in this dataset, so class matching is a property of the statistic rather than a downstream refinement. Making the centroid emission-weighted gives the industry 'tune your site and watch the answer move' story without inventing a `source` key the schema does not have.
- [x] **P4-B** — Add GET /campaigns/{id}/coverage?cell_m=150 returning the driven-coverage mask as GeoJSON, computed from segment_pass midpoints. Every interface drawing a model plume dims or hatches it outside the mask, and no agreement metric is computed outside it.
  - *where:* `src/air/server/routers/coverage.py (new)`
  - *why:* About 69% of the campaign bbox is more than ~150 m from any driven segment midpoint. Without a served mask, every model polygon over the campaign is indistinguishable from a measurement and every agreement score is computed partly over ground nobody has visited. This one layer does more honesty work than any sentence in the product, and it is the same number the regulator needs for 'are my towers where the plume is' and the planner eventually optimises.
- [x] **P4-C** — Ship GET /sites/{id}/touchdown?measure=&from=&to=&regime= returning a FeatureCollection of LineString features on the road grid - never a Polygon - with per-feature {n_downwind, n_control, control_kind, excess, ci_lo, ci_hi, exclusive_share, placebo_ratio, state}, plus a site-level roll-up carrying n_supported_segments, n_distinct_roads, coverage_pct and its own verdict. Five states: elevated_downwind, contested, no_detection, insufficient_passes, not_measured.
  - *where:* `src/air/server/routers/touchdown.py (new); src/air/server/shapes.py`
  - *why:* Four territories designed four incompatible geometries and four verdict vocabularies. LineStrings win on evidence, not taste: within 1 km of Ridgeline there are 9 road segments and they are all one road (Paul R Lowry), and within 2 km, 23 segments on 4 road names. A polygon there is a 2-D shape extrapolated from a line, and it converts unmeasured ground into apparent measurement. CONTRACT section 9 non-negotiable 2 already made the road grid the hero visual. `attributed` is cut rather than role-gated: the placebo evidence says the strongest supportable verdict is 'elevated when the wind blows from here', a state in the payload eventually renders, and role gating is honest-by-convention anyway - role arrives as a query param or the X-Air-Role header with no auth (concerns.py:216-223).
- [x] **P4-D** — Add Touchdown, TouchdownSegment, TouchdownState and CoverageMask to core/types.ts and useTouchdown / useCoverage to core/queries.ts, with query keys and SSE invalidation.
  - *where:* `web/src/core/types.ts, api.ts, queries.ts (shell-owned - requested, not written by app agents)`
  - *why:* CONTRACT section 7 forbids apps/* editing core/. One request now, before four interface agents each need it, avoids four conflicting hook designs.
- [x] **P4-E** — Add the polar-bin roll-up (12 sectors x 4 rings) as a derived field on the same response, with n on both sides of every bin and a distinct no_control state - never smoothed into a hull.
  - *where:* `src/air/server/touchdown.py`
  - *why:* The industry diff strip and concordance tape need polar bins and the regulator needs district roll-ups. Making them derived views over the one payload is what stops them becoming three separate statistics that drift apart and print facts about Boxtown that differ in sign.

**Demoable after:** Every interface can ask one question - where did the fleet actually find this site's plume, and where do we simply not know - and get the same answer, drawn as coloured road segments with a pass count on each and an explicit not-measured state. The coverage mask is available to bound any claim drawn on top of it. Four interface tracks can now start in parallel.

**DONE — 2026-09-11.** `uv run pytest` 180 passed / 1 xfailed, `npx tsc -b
--force` exit 0, `npx oxlint src` unchanged at 137 warnings. No rebuild.

### What a screen gets

`GET /sites/site-ridgeline/touchdown` — 131 KB, 0.18 s cold, cached after:

| | |
| --- | --- |
| verdict | **`elevated_downwind`**, +5.04 ppb [+3.74, +6.54] over 14 paired hours |
| placebo | −0.04, ratio **0.01** |
| evidence | 244 road LineStrings: 7 `no_detection`, 87 `insufficient_passes`, **150 `not_measured`** |
| supported | 7 segments on 4 distinct roads, 38.5% of the band driven |
| districts | **Boxtown 93.8%**, White Chapel 6.2% |
| polar | 48 bins, 5 with downwind passes, 43 `not_measured` |

`GET /campaigns/current/coverage` — 20.8% of the bbox at `cell_m=150`.

### The defect this phase found

**The phase-2 probe silently dropped 13% of the road network.** Its per-segment
baseline used `np.median`, and a single QC dropout makes that return NaN for
the whole street — poisoning its baseline and removing every pass on it: **167
of 1,307 segments and 8,196 of 56,673 NO2 passes**. Found because the server
implementation, which drops NULLs at load, disagreed with the probe by 0.05
ppb and I went looking for the 0.05 rather than rounding it away.

Fixed with `nanmedian`, fixture regenerated, and the conclusions re-checked:

| site / measure | before | after | state |
| --- | --- | --- | --- |
| Ridgeline / NO2 | +5.09 | **+5.04** | `elevated_downwind` (z 10.2) |
| Riverport / NO2 | +4.01 | **+3.75** | `elevated_downwind` (z 3.7) |
| Delta Forge / NO2 | +1.81 | +1.78 | `no_detection` |
| all PM2.5 | | | `no_detection` |

Nothing changed sign or state. `DETECT_FLOOR` re-calibrated 3.30/3.46 →
**3.28/3.60**. Worth noting: **Riverport's margin is now thin** — +3.75 against
a floor of 3.28 — and it was already ruled out as a demo beat by the multi-seed
check (2 of 4 seeds), so nothing should lean on it.

**The probe now imports its constants from `air.server.touchdown`** instead of
restating them. Two copies of a number that must agree is exactly how this
codebase keeps ending up with two answers, and a test asserts the two
implementations return the same estimate for all six site-measure pairs.

### The decisions, and where they are enforced

- **P4-A.** `src/air/server/touchdown.py`. Road-class matching and
  segment-as-own-control are built in rather than optional; the placebo runs
  INSIDE `estimate()`, so there is no code path that serves a number which has
  not been null-tested. Source point is the emission-weighted centroid of the
  ACTIVE emission points, so toggling a stack in site config moves what the
  estimator is aimed at without inventing a `source` column.
- **P4-B.** `/campaigns/{id}/coverage`. Built from whole polylines, not segment
  midpoints — a midpoint mask understates coverage (16.6% against 20.8% at
  `cell_m=150`), which is the wrong direction to be wrong in for a layer whose
  job is to say what we do not know. `cell_m` is the cell SIDE; the spec's
  "69% is more than 150 m from a driven midpoint" is a 150 m RADIUS, which is
  `cell_m=300` and returns 32.5%. The numbers agree; the questions differ.
- **P4-C.** LineStrings, never Polygons, and a test that says so. **`not_measured`
  is served, not implied**: every segment in the band that was never driven
  downwind comes back explicitly, because without them the payload only ever
  describes roads that happen to have been driven, which reads as coverage
  rather than as a sample. `attributed` stays cut — role gating would not have
  helped, since role arrives as a query param with no auth behind it.
- **P4-D.** `Touchdown`, `TouchdownSegment`, `TouchdownSite`,
  `TouchdownState`, `TouchdownPolarBin`, `CoverageMask` in `core/types.ts`;
  `useTouchdown` / `useCoverage` in `core/queries.ts` with query keys, stale
  times and SSE invalidation on `everything`.
- **P4-E.** Polar bins are a DERIVED view of the same masks, and a test asserts
  their downwind counts sum to the features' — three roll-ups that drift apart
  is how two screens end up printing facts about Boxtown that differ in sign.
  `no_control` is its own state: a bin with downwind passes and nothing to
  compare them against is not a zero.

### Two containment tests worth knowing about

`test_the_estimator_reads_only_measurements` parses the module's SQL with the
AST and asserts every `FROM`/`JOIN` target is in the allowed set — and that
`segment_stat` is not, because those are aggregates with their own rules and
reading them would make the measurement depend on a statistic.

`test_only_geometry_comes_from_the_kernel` asserts the module touches nothing
from `air.dispersion` except `half_width`, `STRENGTH` and `NEAR_SIGMA_M` — a
width, an emission weighting and a radius. None is a concentration, so nothing
in the measured payload is kernel-derived (CONTRACT section 10d).


### Phase 5 — Industry - the operating envelope  ⚠️ **re-planned 2026-09-11**

**Owner steering, verbatim:** *"The core message of the industry tier still
needs to be maximize performance within responsible environmental constraints.
The verify consultant was brainstorming for how the plume vs reality visual
would look but is not the main driver."*

So the spine is the ENVELOPE, and the model-versus-measurement work from phases
1-4 becomes the evidence panel underneath it rather than the pitch. The old
plan for this phase (model studio, three-way diff, concordance tape, tier flag)
is preserved below under "what was cut and what moved", because several pieces
of it survive in a smaller role.

**Goal.** Give the operator an instrument that answers "how hard can I run
right now, and what does that cost the people next door" — measured, not
modelled, and moving with the weather.

### The finding this phase is built on

Measured 2026-09-11 on the shipped database. Paul R Lowry Road is the road
along Ridgeline's fenceline. Compared against 2,713 passes on the **same road
class more than 2 km away**, same instrument, same hours:

| | fenceline road | comparable roads | over the 60 ppb line |
| --- | --- | --- | --- |
| **stable night (E/F)** | p50 **43.5**, p90 **84.8**, max 112.7 | p50 13.9, p90 26.5 | **35.2%** vs 0.1% |
| daylight (B/C) | p50 15.4, p90 29.3, max 44.0 | p50 11.4, p90 19.6 | 0% vs 0% |

**On a normal afternoon the site's fenceline is +4 ppb over comparable roads
and unremarkable. On a still night it is +29.6 ppb at the median and crosses
the DRAQA watch line on more than a third of passes.** Same road, same class,
same instrument; the only thing that changed is the weather.

That is the envelope, and three properties make it the right spine:

1. **It binds.** 134 of 56,492 passes cross the 60 ppb watch line; 113 of them
   are on this one road. Nothing else in the campaign comes close.
2. **It is actionable.** It closes on stable nights and opens by morning, so an
   operator can move load, stagger generator tests, or pre-cool ahead of it.
   A permit number cannot be managed; this can.
3. **It is honest about scope.** This is the site's WHOLE footprint —
   generators, on-site traffic, fugitives — not its stacks alone. That is also
   what an operator actually controls.

The far-field plume over Boxtown (+5.04 ppb at 1.5-4 km, phase 4) is a
different constraint with a different character: it never crosses a line, but
it lands over homes. Both belong on the screen; only the first one binds today.

**What the plume work is for now.** The near-field envelope answers "how hard
can I run". The far-field touchdown answers "and who is downwind while I do".
The model-versus-measurement diff is the evidence that the second answer is
measured rather than asserted — which is what makes the first one credible.

### Tasks

- [x] **P5-A** — Measure the envelope per site and per regime as a server
  computation, not a stored constant. `industry_site.headroom_pct` is currently
  a hardcoded 79/61/44 in `world.py` and means nothing. Replace it with
  `GET /sites/{id}/envelope?measure=&at=` returning, per stability regime: the
  fenceline excess over class-matched distant roads, the share of passes over
  each `action_level`, the hours-of-day it closes, and what is left to the line.
  - *where:* `src/air/server/envelope.py (new); routers/sites.py`
  - *why:* A number an operator is asked to manage has to be measured and has
    to move. The static `headroom_pct` cannot be checked, cannot be improved,
    and is not connected to anything on the screen.
- [x] **P5-B** — Seed-robustness check before any copy is written. Re-run the
  fenceline comparison across the three phase-2 seeds. The effect is 350x, so
  it will almost certainly hold — but phase 2's rule stands: the beat may be
  depended on, the number may not, and every figure is generated at runtime.
  - *where:* `scripts/probe_envelope.py (new); tests/test_envelope.py`
  - *why:* The multi-seed check is what separated the Boxtown beat (survived)
    from Riverport's detection (2 of 4 seeds). Do it before, not after.
- [x] **P5-C** — The envelope instrument on `/industry`: where the envelope is
  now, when it next closes, and what it costs in MW. Reuse `envelopeOf` and the
  existing headroom readout rather than inventing a new panel; replace its
  input with the measured value and add the forward view.
  - *where:* `web/src/apps/industry/lib.tsx (envelopeOf); Scope.tsx`
  - *why:* The screen already promises "run at the top of your safe envelope"
    in its own docstring and then shows a constant. Closing that gap is most of
    the work.
- [x] **P5-D** — The evidence panel: the fenceline road against its comparison
  set, drawn as road segments with the class-match stated, plus the far-field
  touchdown from phase 4 with its district roll-up. This is where the
  model-versus-measurement diff lives, in the supporting role the owner
  described.
  - *where:* `web/src/apps/industry/Evidence.tsx (new)`
  - *why:* An operator asked to change how they run at night will ask "says
    who". The answer is 321 passes against 2,713 class-matched controls, and it
    should be one click away rather than a footnote.
- [x] **P5-E** — Keep from the old plan: `model_tier` on `dispersion_model`
  (`permit` | `aclima`) and the permit-versus-measured overlay, now inside the
  evidence panel rather than as its own studio. Cut: the concordance tape, the
  standalone `/industry/model` route, and the tier/entitlement flag — none of
  them serve the envelope, and the paywall in particular was never the ask.
  - *where:* `src/air/db/schema.sql; routers/sites.py; Evidence.tsx`
  - *why:* The filed study pointing one way while the air goes another is a
    good 20 seconds of a demo and a bad organising principle for a tier.

**Demoable after:** An operator opens the scope and sees how hard they can run
right now, when that changes, and what it costs in megawatts — with one click
to the 321 measured passes that say so, and one more to the district that is
downwind while it happens.

**P5-A, P5-B, P5-C DONE — 2026-09-11.** `uv run pytest` 194 passed / 1 xfailed,
`npx tsc -b --force` exit 0, one pre-existing lint error (`WindRose.tsx`,
untouched) and two new benign `only-export-components` warnings. No rebuild.

### The instrument

`GET /sites/{id}/envelope` — Ridgeline, running **268 MW**:

| regime | excess over comparable roads | fenceline p50 | over the 60 ppb line | envelope | state |
| --- | --- | --- | --- | --- | --- |
| unstable A/B | +13.2 ppb | 24.9 | 0.0% | 978 MW | `elevated` |
| neutral C/D | +10.6 ppb | 16.1 | 0.0% | 1,382 MW | `elevated` |
| **stable E/F** | **+55.7 ppb** | **72.1** | **75.8%** | **210 MW** | **`binding`** |

**On a typical stable night the air has room for 210 MW and the site is running
268.** That is the sentence the tier exists to say, and it is measured.

The load-agnostic form is `cut_pct` — how much of the site's OWN contribution
has to go — because Delta Forge is a metals works and Riverport a logistics
terminal and neither carries a megawatt rating. Ridgeline: **−21.7% on a
typical stable night, −62.7% on a bad one.**

### P5-B — the seed check, run before any copy was written

| | seed 20260827 | 20260828 | 20260829 | 20260830 |
| --- | --- | --- | --- | --- |
| Ridgeline, day / night | +13.2 / **+55.7** | +10.0 / **+55.2** | +7.7 / **+63.7** | +14.8 / **—** |
| state | `binding` | `binding` | `binding` | **`insufficient`** |
| Delta Forge, night | +13.3 | +11.5 | +18.2 | +22.2 |
| Riverport, night | +8.6 | +5.2 | +4.6 | +10.0 |
| decoy null p95 | 4.18 | 3.69 | 5.51 | 7.81 |

Three conclusions, all of which changed the build:

1. **The magnitude is dependable.** +55.2 to +63.7, a factor of 1.15 — far
   steadier than the touchdown's 1.8. The `binding` state holds in every seed
   where it computes.
2. **Computability is NOT.** One seed in four cannot form three paired
   episodes: the fleet drove the fenceline on five nights and covered enough
   comparison roads on only two of them. So **`insufficient` is a first-class
   UI state**, not an error — `envelopeRead` renders it as "Not enough passes"
   with the episode count, because saying so is the argument for targeted
   driving and hiding it behind a dash is not. That requirement would have been
   missed entirely without this check.
3. **Riverport flips `elevated` <-> `indistinct`** across seeds and may not
   carry a beat — the same conclusion its touchdown reached.

`DECOY_FLOOR = 8.4` sits above the worst seed's null p95 (7.81), so the floor
is conservative across all four worlds.

### The defect this check found

The first run came back **byte-identical across all four seeds** — "x1.00", every
number the same. That is what a seed sweep looks like when it is not working.
`touchdown.load()` cached the projected passes on `(campaign_id, measure,
cache_version)`, and all four databases carry the same `campaign_id`, so the
first database's passes were served for all four. The database path is part of
the key now. The server only ever opens one database, which is exactly why this
would have sat there indefinitely.

### What else moved

- **The advisor stopped quoting a constant.** `advisor_rules.py` and the LLM
  prompt in `routers/advisor.py` both stated "headroom on this site is 79% of
  its community-safe envelope" — a number baked into `world.py`. Quoting it to
  an operator, or to a model that quotes it back, is how a made-up figure
  acquires authority. Both now carry the measured envelope, or say nothing:
  *"In neutral air your fenceline runs +11 ppb over comparable roads, measured
  over 7 episodes."*
- `envelopeOf(site)` is gone, replaced by `envelopeRead(envelope, regime)`.
  The scope banner reports the regime the air is in **right now**; the Margin
  gauge reports the cut needed **in stable air**, because those differ and the
  difference is the product.
- The megawatt figure is labelled modelled wherever it appears —
  `Envelope.headroom_is_modelled` carries one sentence for all four interfaces.
  The excess and the levels are measured; converting them to MW assumes the
  site's contribution scales with load, which the kernel and the duty curve
  imply and the fleet did not observe.

### P5-D and P5-E — DONE 2026-09-11

`uv run pytest` 197 passed / 1 xfailed, `npx tsc -b --force` exit 0, lint 138
warnings with the one pre-existing `WindRose.tsx` error. One rebuild, for the
schema column.

**P5-D — `/industry/evidence`, "Says who".** The scope tells an operator to run
58 MW under what they are running on about a third of nights; the first thing
anyone sensible asks is who says so, and the answer is now one click away.

Three things on it, in descending order of how strongly the data supports them:

1. **Two distributions on one scale.** Stable air: fenceline p50 **72.07 ppb**
   against class-matched comparable roads at **13.17**, with the action level
   drawn as a tick on both tracks. The comparison side had to be added to the
   payload (`comparison_p50/p90/max`, class-matched to the fenceline's own road
   mix) — a panel that shows only the difference asks to be believed; one that
   shows both sides can be checked.
2. **The roads it rests on**, inked. The fenceline is the only thick line, the
   comparison set is faint, and everything else is left alone — a road that is
   neither is not evidence either way and colouring it would imply it was.
   `fenceline_segment_ids` and `comparison_segment_ids` are served for this.
3. **The null**, in words: 120 arbitrary road clusters run through the
   identical computation, averaging +0.2 ppb with a worst case of 5.6, against
   this site's +55.7.

Then, in a **separate panel**, the far-field touchdown — who is downwind while
it happens — with its district roll-up. Deliberately not folded in with the
rest: the fenceline result is 32 standard deviations off its null, the
touchdown is a few ppb over 14 paired hours and crosses no threshold. One panel
would lend the second the first one's authority.

**P5-E — `model_tier`.** `permit` | `aclima` on `dispersion_model`, CHECK
constrained, every seeded study `permit`, served through `shapes.py` and typed
in `core/types.ts`. The comment on the column says what the constraint is for:
the bare word "tier" meant four different things across the design work — model
provenance, forecast horizon, entitlement, confidence — and two of them were
drafted as conflicting CHECK constraints on this one table. A forecast horizon
gets its own column when phase 8 needs one.

**Cut as re-planned:** the concordance tape, the standalone `/industry/model`
studio, and the entitlement flag.

**What was cut and what moved.** The old phase 5 is in git history at
`docs/PLAN-plume.md` before 2026-09-11. P5-A (model_tier) survives inside
P5-E. P5-B (the three-way diff) survives as the evidence panel, minus the
standalone route. P5-C (concordance tape) is cut — it is a lovely instrument
for a question the tier is not selling. P5-D (Build.tsx toggles) is deferred to
phase 7 with the rest of the site-config work. P5-E (entitlement flag) is cut
outright.

### Phase 6 — Community - climatology first, the soft cloud second

**Goal.** Deliver the owner's relaxation - reports and plumes on the same map - with the calm, stable statement as the front door and the live cone one tap behind it. The copy is the deliverable in this phase, not the renderer.

- [x] **P6-A** — Ship GET /wind/climatology?site_id=&days=&campaign_id= returning rose bins and per-district transport frequency, bearing and distance, derived from the same kernel geometry as everything else. This endpoint also serves the regulator's residency view in phase 7.
  - *where:* `src/air/server/routers/wind.py; reuses windfield.rose() and windfield.downwind_districts_fn() (windfield.py:509-545)`
  - *why:* Two territories independently expressed 'how often is this neighbourhood downwind' and would have produced two numbers a viewer could compare - one reach-independent wind frequency, one cone-intersection count that moves by an order of magnitude when the kernel lands. One endpoint, both quantities from the same geometry, labelled with their tier, so they move together.
- [x] **P6-B** — Snap concern lon/lat to the nearest road-segment midpoint before serialisation for community-facing responses.
  - *where:* `src/air/server/shapes.py::concern (raw floats today at :190-191)`
  - *why:* Coordinates are house-precision and is_anonymous hides only the author name. Overlaying any named-emitter shape on house-precision pins turns the map into a record of which households accused which company - a compound de-anonymisation and defamation surface. The road segment is the product's own atom, so nothing analytically useful is lost. About ten lines, and it is the one place the community design is genuinely exposed.
- [x] **P6-C** — Request SoftPlumeLayer in web/src/components/map/layers/ (a HeatmapLayer cloud plus a very-low-alpha uncertainty wedge, site-tinted, no outline, discarding the `level` property at the layer boundary) and pointInRing in web/src/components/lib/geo.ts. Zoom-dependent radius or a minimum-zoom cutoff, checked in a screenshot at z11 and z14. Draw order: under everything, below SegmentLayer.
  - *where:* `web/src/components/map/layers/SoftPlumeLayer.ts, web/src/components/lib/geo.ts (mapviz-owned - requested)`
  - *why:* A blur has no inside and no outside, which is the whole epistemic point and the real defence against a resident screenshotting a boundary into a house listing. The `level` discard needs a comment saying why: it is a fabricated model number and putting it on a resident's screen would claim a measured concentration. HeatmapLayer radiusPixels grows in world terms as you zoom out, so at campaign zoom three sites can smear into one 'everywhere is affected' wash - that needs eyes, not reasoning.
- [x] **P6-D** — New Plume.tsx rail card with the three-mode Segmented (Usually / Right now / When neighbours reported), Usually as the default. All model copy lives in one exported PLUME_COPY object in lib.ts. New EpistemicKey in parts.tsx naming the three states once. A fifth `plume` branch in Picked with a non-dismissible 'What this does not say' block, and two new paragraph blocks in the concern branch - one for when suspected_site_id is set, one for when it is NULL.
  - *where:* `web/src/apps/community/Plume.tsx (new), lib.ts, parts.tsx, Picked.tsx, MapScreen.tsx`
  - *why:* Usually is stable - open the map at 8am and 6pm and see the same thing - and it is reach-independent, so it delivers the whole narrative without the cone needing to touch anyone. That drops reach as a blocking dependency. Keeping every model sentence in one object is the same trick statusPlain already uses to keep 'industry can never close a report' in exactly one place, and it makes the never-say list reviewable in one screen rather than by grepping JSX. The NULL branch matters most: 137 of 204 concerns are unattributed, and an app willing to say 'we could not connect this to any of the industrial places on the map' is one you believe when it says the opposite.
- [x] **P6-E** — The 'what we measured under the cloud' counter degrades explicitly to 'we have not driven enough of your streets at this hour to say' rather than to a small number. Memoise the point-in-ring computation on (dispersion.ts, segments.window) and test against the outer band only.
  - *where:* `web/src/apps/community/Plume.tsx`
  - *why:* Hour-window segment coverage is thin - 90 to 407 of 1,307 segments per hour - so the counter can be computed from a handful of streets and stated with unearned confidence. And recomputing point-in-polygon over ~1,300 midpoints on every time-cursor tick will drop frames on the map.

**Demoable after:** A resident opens the map and reads a calm, stable sentence: over the last three months the wind carried from Ridgeline over Boxtown about one hour in two, from Riverport about one in forty, from Delta Forge about one in fifty - alongside the coloured streets showing what was actually measured. One tap gets the live cloud with its non-dismissible limits; another freezes it on the hour a cluster of neighbours reported. The owner's relaxation delivered without a sentence the data contradicts.

**DONE — 2026-09-14.** Owner's call: *"Climatology first it is."* `uv run
pytest` 210 passed / 1 xfailed, `npx tsc -b --force` exit 0, lint 138 warnings
(unchanged, with the one pre-existing `WindRose.tsx` error). No rebuild.

### The front-door sentence, measured

For a resident in Boxtown, generated at runtime from 2,160 hours of weather
record:

> the wind blew from **Ridgeline South Campus** toward Boxtown **about one hour
> in three** (33.5%)
> the wind blew from **Riverport Intermodal Terminal** toward Boxtown **hardly
> ever** (1.9%)
> the wind blew from **Delta Forge Channel Avenue Works** toward Boxtown
> **hardly ever** (1.4%)

The plan guessed one in two / one in forty / one in fifty. The shape is right
and the numbers are not, which is why P6-D put every one of them behind
`PLUME_COPY.usually.often(share)` rather than in a sentence. The full picture:

| district | Ridgeline | Delta Forge | Riverport |
| --- | --- | --- | --- |
| **Boxtown** | **33.5%** | 1.4% | 1.9% |
| President's Island | 28.9% | **33.5%** | **17.7%** |
| White Chapel | 20.4% | 0.7% | 0.1% |
| Pisgah Heights | 10.8% | 2.0% | 1.9% |
| Westwood | 3.4% | 0.5% | 0.7% |
| Goodman | 2.6% | 0.5% | 0.7% |
| Darwin | 1.8% | 0.8% | 1.8% |

Every district gets an answer including a boring one — a front door that lists
only the affected places is an accusation with the denominator removed, and
there is a test for it.

### P6-A — reach-independence is the load-bearing property

`src/air/server/climatology.py` + `GET /wind/climatology`. The sector comes
from the dispersion kernel's own sigma_y at the district's distance under that
hour's stability, clamped to 8-30 degrees — a WIDTH, so the geometry stays
consistent with the touchdown estimator without the answer depending on how
far anything travels.

There is a test that multiplies the kernel's reach by five and drops its draw
floor by two orders of magnitude and asserts **every share is byte-identical**.
That is what makes this the front door: the kernel's reach moved by a factor
of five in phase 1, and a number a resident might screenshot must not depend on
which sprint they screenshotted it in.

**The P0-B trap was here too.** A `days=90` default anchored to
`domain.data_now` gave 1,759 of 2,160 hours and a window starting 2026-06-16 —
shrinking by a day every day. Defaulted to the campaign's own start and end.
A climatology that quietly shrinks is worse than one that is out of date,
because the number moves and nothing says so.

### P6-B — the one genuinely exposed surface, closed

Community-facing reports are now snapped to the nearest road-segment midpoint
at serialisation. Measured over all 204: **204/204 land on the road grid,
median displacement 57 m, p90 360 m, worst 806 m.** Raw coordinates stay in the
database for the regulator's own tooling; there is no API path that serves one,
and `location_precision: "road_segment"` says so in the payload.

Audited the neighbours: no `alert` and no `concern_cluster` coordinate
coincides with a raw report coordinate, and clusters carry at least five
members. The concern serialiser was the only exposure. All three facts are
tests.

### P6-C, P6-D, P6-E — the cloud, one tap behind

- `SoftPlumeLayer` — a `HeatmapLayer` cloud plus a very-low-alpha wash of the
  outermost band. **No outline, ever**, because a contour has an inside and an
  outside and the outside is a line somebody can screenshot into a house
  listing. `level` is discarded inside `toHeat` rather than at the screen,
  because a screen can be rewritten by someone who has not read CONTRACT §10a;
  weight comes from the band index alone. Below zoom 11.5 nothing is drawn, so
  three sites cannot smear into one "everywhere is affected" wash.
- `pointInRing` in `components/lib/geo.ts`, with the boundary case documented
  as unspecified — a caller that cares whether a street is just inside or just
  outside a modelled plume edge is asking a question the plume cannot answer.
- `PLUME_COPY` in `apps/community/lib.ts`: **every sentence this app says about
  the wind or the plume, in one object.** Three rules stated at the top — the
  wind is the subject and never the company; no units, acronyms or chemistry;
  every number generated from the payload. The never-say list is reviewable in
  one screen rather than by grepping JSX.
- `Plume.tsx` — the three-mode card, `Usually` the default. The live cloud's
  limits are **not dismissible and sit above** the measured count: if they can
  be closed, the cloud outlives them on somebody's screen. `useDispersion` is
  gated on the mode, so a resident who never taps never requests a modelled
  shape.
- The two paragraphs in `Picked`'s report branch. **137 of 204 reports have no
  site attached**, and the unattributed sentence is the one that matters:
  *"We could not connect this to any of the industrial places on the map."*
  An app willing to say that is one you believe when it says the opposite. The
  attributed branch says the wind came from somewhere, never that somewhere did
  something.
- P6-E — the "what we measured under the cloud" counter degrades to *"we have
  not driven enough of your streets at this hour to say"* below eight streets,
  memoised on `(dispersion, segments)` and tested against the outer band only
  (the bands nest, so testing all three counts the same street three times).

**The z11/z14 check P6-C asks for — DONE 2026-09-22**, in the browser, via the
integrated-browser MCP the owner connected. It found four things, and **none
of them was findable from the code or the tests.**

### 1. The cloud was drawing its own outline

The first `SoftPlumeLayer` fed `HeatmapLayer` one point per ring VERTEX plus
the ring's centroid. That draws the OUTLINE, not the shape: the owner saw "a
fat marker drew an acute angle, just the edges and vertex, the middle empty
except one dot." Exactly right, in all three sources, because it was the
sampling and not the data.

`HeatmapLayer` is a density estimator over point samples and the payload is
polygons. Replaced with plain `PolygonLayer` fills — one per band, alpha
stepping down from the source, plus three halo rings past the last band to
feather the boundary. 18 polygons, no aggregation.

**And it was eating the CPU**, for a related reason: `usePhase` calls
`setPhase` inside a `requestAnimationFrame` loop, so any screen with a pulsing
layer re-renders at 60 fps and rebuilds its whole layer list each frame — and
deck diffs `data` BY REFERENCE, so the heatmap re-aggregated a thousand points
sixty times a second for a shape that changes once an hour. The shells are
memoised in a `WeakMap` on the payload now, in the layer rather than at the
call site, because every consumer has the same problem and one will forget.

Two assumptions I had to throw away while fixing it, both caught by probing the
live endpoint rather than trusting the code:

- **The bands do not nest.** I expected overlapping fills to build the gradient
  for free. `dispersion.bands` returns DISJOINT downwind ranges that tile the
  plume end to end, so an interior point is covered by exactly one band. Each
  band carries its own alpha; the gradient is the sequence.
- **The haloes feathered the wrong way.** Scaled about the innermost band's
  centroid — the natural-looking origin — they pushed downwind past the plume's
  end and left its flanks as hard as they started. Scaled about the outer
  band's own centroid instead: 0 of 87 outer vertices now fall outside the
  first halo.

### 2. The "everywhere is affected" wash happens ABOVE the cutoff

`minZoom: 11.5` works — at zoom 11.10 the cloud is correctly gone. But at zoom
12.4, well above it, **the three sites merged into one continuous mass covering
half the map**. Each site contributes six shells, so where three plumes overlap
the alpha compounds as 1-(1-a)^n and 0.18 per shell became ~0.45.

The per-shell peak is **0.075** now, chosen for what three overlapping plumes
look like rather than one. The zoom cutoff stays as the second guard.

### 3. "When neighbours reported" was showing right now

The card said *"where the air was going when your neighbours reported"* over a
map drawing the CURRENT plume — `useDispersion` was never pinned to the
cluster's hour. **A label asserting something the map was not showing** is the
one kind of bug this interface cannot afford, and no test caught it because
both modes were fetching a valid payload.

`latestClusterOf` is exported from `Plume.tsx` so `MapScreen` pins the fetch to
the same cluster the card names. Verified: the request now carries
`at=2026-08-27T06:19:20` and the drawn shape visibly differs from `Now`.

### 4. Two tab labels were clipped

"Right now" and "When neighbours reported" each wrapped to two lines inside a
26 px button in a 322 px rail (`scrollHeight` 31 vs `clientHeight` 26). Now
"Usually / Now / When reported", all one line, with the full sentence in the
card title where it reads better anyway.

### What the front door actually looks like

Confirmed in the browser: three plain sentences, **no shape drawn over anyone**.

> the wind blew from **Ridgeline South Campus** toward Boxtown **about one hour
> in three** · from **Riverport Intermodal Terminal** **hardly ever** · from
> **Delta Forge Channel Avenue Works** **hardly ever**
> *This is about the wind, not about what anyone put into it...*
> From 2,160 hours of weather records across the whole three months.

### Backlog — not this programme

**`_haversine` and `_bearing` are duplicated across four server modules**
(`touchdown`, `coverage`, `climatology` via `geo`, and `envelope` by import).
The 360-vs-0 bearing bug found in phase 8 existed in two of those copies
independently, which is the cost of the duplication made concrete. They belong
in one place. Not urgent — the copies agree today and the bug was latent — but
it is the same drift this programme has now paid for four separate times.


**The community map is overwhelmingly busy.** 200 report pins with +N badges
overlap heavily and largely hide the road grid, which non-negotiable 2 makes
the hero visual in every interface that shows a map. Seen in the browser
2026-09-22; owner's call is that it is a separate sprint, not part of the plume
work. It is the first thing a viewer sees, so it should be the first thing that
sprint fixes — clustering, zoom-dependent thinning, or filtering to the
resident's own district by default.

### Two things still worth eyes

- **The map is very busy** — 200 report pins with +N badges overlap heavily and
  largely hide the road grid, which is supposed to be the hero visual
  (non-negotiable 2). Pre-existing, not phase 6, but it is the first thing a
  viewer sees.
- **A `getProjection` error in the console** from an earlier session — a Google
  Maps call on a null map instance, a basemap init race. Not from the plume
  work. Unreproduced so far.


### Phase 7 — Regulator - coverage, siting, and the calibration limit stated honestly

**Goal.** Answer 'do I have enough sensors in the right places' with arithmetic from this campaign's record, concede the axis where the fleet loses, and say the true and uncomfortable thing about which channels can be anchored at all.

- [x] **P7-A** — Add src/air/server/coverage.py with interception(), residency() and siting_candidates(), all built on the kernel's point_in_cone. Run interception live behind the existing cache.put; do NOT precompute the 1,307-segment surface into a table.
  - *where:* `src/air/server/coverage.py (new); src/air/server/routers/coverage.py`
  - *why:* The four-tower interception is about 181k point-in-cone tests and measured around a second - cacheable and live, which is what makes a tier selector feel instant. The full 1,307 x 2,160 x 21 surface is roughly 59M tests and is the panel to defer, not the headline. Two tables and a new datagen module avoided. Note every interception figure must be recomputed after phase 1 - the widely quoted 20.1% was derived from the deleted base_reach formula, so the screen would otherwise ship pre-invalidated.
- [x] **P7-B** — New route /regulator/coverage (COVERAGE). Verdict header with the interception rate and its model tier always named; per-instrument bars including the operator's fenceline ring under a divider; the residency map painting unobserved plume-hours on the road grid; the residency rose using WindRose's existing rose+compare props; the ranked siting candidates with ghost-tower click-to-recompute.
  - *where:* `web/src/apps/regulator/Coverage.tsx (new), routes.tsx, lib.tsx, regulator.module.css`
  - *why:* The white space between the filled residency petals and the dashed intercepted overlay is the answer to 'is the plume covering my towers' in one glance, and WindRose already takes both in exactly the shape windfield.rose() returns - no new component. Two of the four DRAQA towers never stand in a plume across the whole record, which is the finding. `unobserved` rather than raw residency is the right encoding, because raw residency is hottest on President's Island where Riverport Road does catch it.
- [x] **P7-C** — Panel E, the concession: 4 points versus 1,307; 8,598 continuous records versus 56,673 passes; in-plume share of own record - towers ~5.7%, fleet ~1.4%. Caption: an always-on instrument beats a moving one on duty cycle, and does here; what four points cannot do is tell you where the fifth should go. Frame every siting row as 'these streets carry the most unobserved plume-hours in this record', never 'put your tower here'.
  - *where:* `web/src/apps/regulator/Coverage.tsx`
  - *why:* The fleet's losing number is the most credible thing on the screen and must ship in the same payload so it is structurally impossible to omit - you cannot print only the comparison you win. And recommending where a public agency sites an instrument is the closest this product comes to regulatory advice; siting involves land access, power, security and network-design rules the product knows nothing about.
- [x] **P7-D** — Ship per-channel calibration state derived from the existing monitor.measures_json plus colocation events computed from segment_pass x monitor within 250 m. One per-channel label with age-since-anchor and the sentence 'no reference anchor exists in this campaign' where none does. No DAG, no hop counts, no residual histogram, no new tables.
  - *where:* `src/air/server/routers/monitors.py; web/src/apps/regulator/lib.tsx (gradeOf); Thresholds.tsx:305-315 blindBanner`
  - *why:* Verified from data/air.db: the reference monitors carry o3 (x3), no2 (x3), pm25 (x3) and co (x1) and nothing else. bc, ch4, co2, methane_leak, diesel, nondiesel and aclima_sense have no reference anchor anywhere in the campaign - 7 of 11 measures, including the two the leapfrog argument rests on. The species we can anchor to their towers are precisely the species they already have, and the species we uniquely provide are the ones nobody can anchor. A single green 'calibrated' badge is false for most of what a node measures. That finding needs no graph to state and is stronger than the graph would be.

**Demoable after:** A regulator sees in one header that their four towers stand inside a modelled plume in a minority of hours and that two of the four never do; a rose whose white space is the gap; a ranked list of streets carrying the most unobserved plume-hours; and next to it the honest concession that their towers beat our fleet on duty cycle. Each channel carries its own anchoring state, including the ones nothing in the region can anchor.

**DONE — 2026-09-22.** `uv run pytest` 223 passed / 1 xfailed, `npx tsc -b
--force` exit 0, lint unchanged at 139. No rebuild. Seen in the browser at
`/regulator/coverage`.

### Three numbers the plan asserted that the data does not support

Every figure on this screen was recomputed on the current kernel, and **three
of the plan's own headline numbers were wrong.** Each survives as a finding;
none survives as a number.

| the plan said | measured | verdict |
| --- | --- | --- |
| interception ~20.1% | **30.1%** of hours a reference tower is in a plume | the old figure came from the `base_reach` formula phase 1 deleted |
| "two of the four towers **never** stand in a plume" | two stand in one in **1.2%** and **0.8%** of hours — 25 and 18 hours of 2,160 | "almost never", not "never". Phase 1's bigger stable-air plumes do occasionally reach them, and a screen saying "never" would be false |
| concession "8,598 records vs 56,673; 5.7% vs 1.4%" | **21,500 vs 56,673; 8.4% vs 4.8%** | the finding holds — an always-on instrument does beat a moving one on duty cycle — but the margin is **1.75x, not 4x** |

The third is the one worth dwelling on. I had those numbers hardcoded in the
JSX, copied from this plan. They are computed and served now, in the same
payload as everything the fleet wins on, which is what P7-C asked for and is
what makes it structurally impossible to print only the comparison we win.

### What the screen says

| | |
| --- | --- |
| verdict | **2 of your 4 reference instruments are almost never in a plume** |
| best / worst placed | Riverport Road **19.0%** · West Shelby Drive **0.8%** |
| plume-hours nothing watched | **51%** |
| top unobserved street | Channel Avenue, 1,177 of 1,355 plume-hours |
| channels anchorable | **4 of 11** |

And the contrast that makes the point without a caption: **the operator's own
fenceline sensor stands in a plume 44.8% of hours — more than twice the
agency's best-placed tower.**

### P7-A — one geometry, not two

`src/air/server/coverage.py`, live behind the cache, no table and no datagen
module. The tower surface is 0.58 s and the 1,307-segment residency 0.28 s.

`point_in_cone` was scalar and the residency surface is 1,307 x 2,160 x 3, so
the kernel gained `cone_mask` as the vectorised form and `point_in_cone` now
calls straight into it — one implementation rather than two that drift, with a
test asserting they agree.

### The residency definition had two bugs, both found by looking at the output

1. **Unobserved was too loose.** "A plume-hour in an hour when no instrument
   ANYWHERE was in a plume" flatters the network: an hour where Riverport Road
   stands in Riverport's plume counted as observed for a street under
   Ridgeline's plume across the campaign. Attributed per site, the unobserved
   share goes from **12.1% to 51.1%** — that difference is what the loose
   version was hiding.
2. **Then the accounting mismatched.** Numerator per (hour, site), denominator
   per hour, giving segments an unobserved share of **104%**. Both are per
   (hour, site) now.

### P7-C and P7-D

The siting panel renders the server's own `framing` string —  *"an observation
about this record, not advice about where to put an instrument"* — so the
disclaimer cannot be dropped by editing the screen. Siting a regulatory
instrument involves land access, power, security and network rules this product
knows nothing about.

The calibration panel states the uncomfortable thing plainly: **7 of 11
channels have no reference anchor anywhere in this campaign**, including `bc`
and `ch4`, the two the leapfrog argument rests on. The channels the agency's
towers can anchor are exactly the channels those towers already carry.

### One layout lesson

The first render collapsed because I used the INDUSTRY app's class vocabulary
(`banner`, `bannerHead`, `bannerSub`) in the regulator skin, which has its own
(`verdict`, `verdictLines`, `verdictHead`, `sub`). Every class resolved to
`undefined`, so the verdict ran into its basis as "...in a
plumemodelled — air.dispersion". `tsc` cannot catch this: CSS-module keys are
typed as a loose record. Worth knowing before building the next screen in a
skin you have not worked in.


### Phase 8 — A forecast that is derived, not invented  ⚠️ **re-planned 2026-09-22**

**Owner's call:** the derived forecast, over the three-tier version in the
original plan. The original is preserved in git history before 2026-09-22.

**Why it was re-planned.** P8-B invented three forecast tiers
(`climatology` / `regional` / `aclima`) whose relative skill is **a noise scale
someone picks**, and P8-C's ledger then reports that choice back as though it
were a finding. The tier split existed largely to feed a paywall narrative, and
**the paywall was already cut in the phase 5 re-plan.** What was left was a
circular claim with a warning label on it.

**The alternative, measured rather than asserted.** Persistence and climatology
are both computable from data already shipped. Blending them, on this
campaign's own record:

| lead | persistence | climatology | blend | weight on persistence | gain over the better baseline |
| --- | --- | --- | --- | --- | --- |
| 6 h | 4.8° | 32.7° | **4.8°** | 1.00 | — |
| 12 h | 9.3° | 32.7° | 9.2° | 0.95 | 0.1° |
| 24 h | 16.9° | 32.7° | 16.5° | 0.85 | 0.4° |
| 48 h | 28.5° | 33.1° | **25.4°** | 0.45 | **3.2°** |
| 72 h | 37.5° | 33.3° | **29.4°** | 0.40 | **3.9°** |
| 96 h | 44.4° | 33.4° | 32.2° | 0.30 | 1.2° |
| 120 h | 48.5° | 33.4° | 33.4° | 0.10 | — |

Three honest properties fall straight out. At six hours the forecast simply IS
persistence — nothing beats "the wind is still doing what it is doing". At two
to three days the blend genuinely beats both baselines. At five days it
collapses to the rose, which is the honest answer and is the same rose the
community app already shows as its front door.

**The crossover is the product.** Persistence and climatology cross at about
60 hours. So the five-day strip is not a hedge, it is a measured boundary:
days 0–2 the forecast, days 3–5 the climatology, because that is where the
lines cross.

### Tasks

- [x] **P8-A** — `src/air/server/forecast.py`: `issue(conn, campaign_id, at, leads)`
  returning one row per lead with direction, speed, a spread, and DERIVED
  stability and boundary-layer depth. Direction and speed are the
  persistence→climatology blend; stability is blended on hour-of-day
  climatology and then passed through `dispersion.coerce_class` against the
  forecast speed; PBL follows from stability, solar and speed by the same
  formula `weather.build_wind` uses, with a parity test.
  - *why:* `weather._solar` is pure solar geometry and is knowable exactly in
    advance, so only direction, speed and stability are genuinely uncertain.
    Deriving the rest is the same discipline as `coerce_class`: never emit F at
    6 m/s, and never emit a stable class with a 1,500 m mixed layer.
- [x] **P8-B** — **No `wind_forecast` table and no rebuild.** The forecast is
  computed at request time from the wind record: persistence needs only the
  last observed hour and climatology is a fixed rose, so a forward view at the
  demo's own "now" is computable with no extra truth.
  - *why:* The original needed `days + 7` of unobservable truth solely so
    invented forecasts could be scored near the end of the record. A derived
    forecast is scored by replaying the same function over the record, which
    needs no truth that does not already exist.
- [x] **P8-C** — `GET /wind/forecast` and `GET /wind/forecast/skill`. The
  ledger is computed by replaying `issue()` across the record and scoring it
  against what actually happened: direction MAE and the share beyond 90° per
  lead bin, against BOTH baselines. Label it a simulated world, not a
  simulated skill — the error here is measured, so the sentence changes from
  "its error is a chosen parameter" to "this is one simulated campaign; the
  numbers are its own, not the atmosphere's".
  - *why:* There is no tier-versus-tier comparison left to forbid. What remains
    is a real verification record over a fictional world, which is honest as
    long as the fiction is named.
- [x] **P8-D** — Route the forecast through the kernel's `reach()` to produce a
  corridor per lead, widened by the MEASURED direction spread at that lead —
  never a single centreline.
  - *why:* Unchanged and still the point. A 37.5° error at 72 h displaces the
    centreline about 2.1 km at 4 km range in a campaign 10.5 km across. The
    envelope is the product.

**Demoable after:** The product has forward-looking weather whose error is
measured rather than chosen. A forecast plume renders as a corridor that
visibly widens with lead and loses its shape by day three, and the five-day
strip hands over from forecast to climatology at the hour the two lines
actually cross.

**Cut from the original:** the `wind_forecast` table, the three-tier
vocabulary, the `days + 7` truth extension, the rebuild, and the
"illustrative — its error is a chosen parameter" label, which has nothing left
to disclaim.

**DONE — 2026-09-22.** `uv run pytest` 238 passed / 1 xfailed. **No rebuild, no
new table.** `src/air/server/forecast.py`, `GET /wind/forecast`,
`GET /wind/forecast/skill`.

### The ledger, computed by replaying the forecast over the record

| lead | blend | persistence | climatology | gain | wrong half |
| --- | --- | --- | --- | --- | --- |
| 6 h | **4.8°** | 4.8° | 32.7° | — | 0% |
| 12 h | 9.2° | 9.3° | 32.7° | +0.1° | 0% |
| 24 h | 16.5° | 16.9° | 32.8° | +0.4° | 1% |
| 48 h | **25.4°** | 28.5° | 33.1° | **+3.2°** | 5% |
| 72 h | **29.4°** | 37.5° | 33.3° | **+3.9°** | 7% |
| 96 h | 32.2° | 44.4° | 33.4° | +1.2° | 8% |
| 120 h | 33.4° | 48.5° | 33.4° | — | 9% |

n is 2,040–2,154 per bin. Both baselines ship beside every number, because a
skill figure without the thing it beat is a marketing claim.

### The corridor loses its shape, visibly

| lead | half-angle | |
| --- | --- | --- |
| 0 h | 11.9° | |
| 24 h | 49.7° | |
| 72 h | 71.0° | beyond crossover |
| 120 h | **79.5°** | beyond crossover — a 159° sector |

Widened by the blend's OWN measured error spread at that lead, not by an
assumed cone-of-uncertainty constant. At five days the drawing is a sector
covering nearly half the compass, which is "we do not know" rendered honestly.

### Two bugs found while testing

1. **Bearings came back as 360.0, not 0.0.** `arctan2` returns a tiny negative
   for due north and `x % 360` turns that into 360.0 — a bearing that fails
   every downstream `0 <= b < 360` check and sorts to the wrong end of a rose.
   Fixed in `_norm_bearing`.
2. **The same bug was latent in two more modules.** `touchdown` and `coverage`
   use `(x + 360) % 360`, which survives the 1e-16 case and still returns
   360.0 at 1e-12. Harmless there today — those bearings only feed wrap-safe
   angular differences — but fixed, and the underlying duplication of
   `_haversine`/`_bearing` across four modules is logged as backlog. The bug
   arose independently in two copies, which is that duplication's cost made
   concrete.

### What the discipline bought

`weather._solar` is pure geometry, so only direction, speed and stability are
genuinely uncertain; stability is blended and then passed through
`dispersion.coerce_class` against the forecast speed, and the mixed layer is
derived from the same formula the generator uses. Tests assert the forecast
**never emits an impossible stability** and **never pairs a stable class with a
deep mixed layer** — a forecast is exactly where those states would otherwise
appear, because nothing stops a blend pairing a persisted class with a
climatological speed.

A parity test pins `_pbl` and `_solar` against `weather.build_wind`, since they
are replicated (`air.server` does not import `air.datagen`) and replication
without a parity test is how two copies of a formula drift.


### Phase 9 — Admin - the Mission Brief, read-only over the existing plan

**Goal.** Give a fleet lead at 07:00 the day's call, the map, the assignments, yesterday's debrief and the five-day watch list - without touching the Chinese-Postman solver.

- [x] **P9-A** — Ship GET /admin/brief?date=&forecast_tier= returning the whole screen in one request, cached the way /wind/field is: the day's forecast call, the hour-banded forecast footprint swath, today's existing routes tagged with which stratum each leg falls in (computed at analysis time from geometry, not stored), yesterday's paired comparison, and the five-day outlook.
  - *where:* `src/air/server/routers/admin.py; src/air/server/plumeframe.py (new)`
  - *why:* A single-screen read at 07:00 should be one request. Stratum is a property of geometry and wind computed from (pass ts, segment midpoint, site, that day's forecast) - denormalising it would freeze one bearing assumption into 200k rows and create a second source of truth. This is the one place the territory that refused a segment_pass column was right, and it coexists fine with sampling_mode, which records dispatch intent rather than geometry.
- [x] **P9-B** — New route /admin/brief appended as sheet 08 and placed third in the nav order, with a one-line note. Do NOT renumber the other six sheets.
  - *where:* `web/src/apps/admin/Brief.tsx (new), routes.tsx, lib.tsx:29 SHEET, web/src/core/roles.ts:143`
  - *why:* The reading-order argument for renumbering is correct and it can wait. Spending six docstring headers and three files of churn during the largest change this app has seen is the wrong trade. Renumber later when nothing else is in flight.
- [x] **P9-C** — The six blocks: the call (one sentence ending in a bearing and a district, with issue stamp and confidence chip); the three-layer map (forecast swath, today's routes coloured by stratum, yesterday's measured touchdown faint underneath); assignments with an imperative control-leg line; yesterday's debrief with three bars and n and CI on each; the five-day strip where days 0-1 are `assigned` and days 2-5 are `watch` with no map preview; and the cost/coverage ledger showing all three numbers together.
  - *where:* `web/src/apps/admin/Brief.tsx`
  - *why:* The debrief needs four verdicts and the fourth is the point: `advected` - the site is not detectably contributing above background today - is only obtainable because you drove upwind, and it is the finding that protects the operator from a false accusation. The control leg is the first thing a driver drops when running late and the only leg that makes the day's downwind data interpretable, so its line is imperative. Days 2-5 are a watch list because at 96 h both forecast tiers reach roughly zero skill against persistence and are at or worse than climatology beyond three days; presenting a five-day targeted plan as a schedule rather than a decaying bet is the overclaim this screen is most likely to make.
- [x] **P9-D** — Put the sample-size number on the brief as the standing argument for targeted driving, alongside the paired-hour rate: how many hours the fleet sampled both sides of a source concurrently, and how many wind sectors those hours covered.
  - *where:* `web/src/apps/admin/Brief.tsx`
  - *why:* Measured: inside 2 km of Ridgeline under stable air the fleet has on the order of dozens of downwind passes across 9 segments on one road in 90 days, and paired downwind-plus-upwind hours are roughly 10% of driven hours covering 4 of 16 wind sectors. That is the data scientist's warning made numeric, it is the strongest argument in the entire brief for targeted driving, and it currently appears nowhere. It is also the metric the planner should eventually optimise.
- [x] **P9-E** — Declare the brief read-only over the datagen-built plan, and delete the Rural-Postman provenance claim from sheet 03's duality panel, which describes routes the button does not produce.
  - *where:* `web/src/apps/admin/DrivePlan.tsx; src/air/server/routers/admin.py:84-85`
  - *why:* There are two plan generators: routers/admin.py:85 is an explicitly-documented boustrophedon stand-in, and build.py:512 regenerate_drive_plan is the real Chinese-Postman solver. A Mission Brief whose routes came from a serpentine placeholder is nonsense, and the panel currently claims provenance for the wrong one. Fixing the claim costs nothing; reconciling the generators is deferred.

**Demoable after:** A fleet lead opens one screen at 07:00 and reads the day's call in a sentence, sees where the plume is forecast to cross, sees today's routes coloured by which question each leg answers, and sees yesterday's paired result including the days it says 'we cannot distinguish local from advected because the control was not sampled'. The five-day strip visibly redraws when the demo cursor moves back a day - the plan changing because the forecast changed.


### DONE 2026-09-23 — what shipped, and where the spec moved

`GET /api/v1/admin/brief?date=&site_id=` (`src/air/server/brief.py`, geometry in
`src/air/server/plumeframe.py`), sheet 08 at `/admin/brief`, third in the nav.
0.2 s cold, one request, cached per (db, date, site). 256 tests pass
(`tests/test_brief.py`, 19 new).

**Deviations, each for a named reason:**

- **No `forecast_tier`.** Phase 8 replaced the tiers with one derived forecast;
  there is nothing to select.
- **The plan is found through `drive.plan_id`, not `status='active'`.** Sheet 03's
  lever writes a new active plan from the serpentine stand-in. A brief that
  followed the flag would switch to routes that drove nothing the first time
  anyone pulled it. There is a test.
- **Five verdicts, not four.** `contested` exists because CONTRACT 10c requires a
  placebo on any "worse downwind of this site" claim; it serves no interval and
  no n (10a.4).
- **`unpaired` also covers "both sides driven, never in the same hour".** The first
  cut called one such day `local` "+6.3 ppb over 0 paired hours" — found on
  screen, not by a test. Across hours the comparison carries the diurnal cycle,
  which is bigger than any plume here.
- **Intervals count hours, not passes** (`1.96·sd/√hours`). Counted as passes, an
  eight-pass upwind leg in one hour looked decisive.

**The defect this phase found in phase 8.** The stability forecast persisted the
class AT ISSUE while the direction blend leaned on persistence (to ~46 h), so a
07:00 class B was forecast for 23:00 — the brief's first call read "Tonight,
well-mixed air". Right **11%** of the time at 12 h, worse than guessing. Now: the
class at issue for 1 h, the same hour on the last observed day to 48 h (78%, then
71%), hour-of-day climatology after (≈66%) — crossing over near 60 h, like the
direction blend. `forecast.stability_raw`, three regression tests.

**The number that is the brief's argument.** Over all 59 driven days x 3 sites =
177 site-days, the one-day debrief returns:

| verdict | site-days |
| --- | --- |
| unpaired — neither side driven | 87 |
| unpaired — plume not crossed | 27 |
| unpaired — both sides, never the same hour | 16 |
| unpaired — upwind not driven | 11 |
| no_detection | 30 |
| contested | 5 |
| local | 1 |
| advected | **0** |

**80% of site-days cannot be read at all**, and `advected` — the verdict that
protects an operator — never occurs, because the uniform plan almost never
drives upwind in the same hour it drives downwind. Campaign-wide for Ridgeline:
21 of 455 driven hours (4.6%) were paired, covering 4 of 16 wind directions;
within 2 km in stable air, 26 downwind passes on 7 segments across 2 roads. The
plan's "~10% of driven hours" was high by half; the 4-of-16 held. All of it is
computed on the payload, never quoted in copy.

**The call is almost always "Tonight, stable air … Boxtown."** That is physics,
not a bug: stable nights put the plume on the ground furthest, so they carry the
most corridor road-km. Meanwhile most of the plan's shifts are daytime, and on
2026-08-28 only one of four routes crosses the corridor at all. The brief says
so without having to argue it.

**P9-E.** Panel 03-E now reads "datagen route builder", and it states that the
regenerate lever is a serpentine stand-in whose routes produced none of the data.
The "Rural Postman" claim is gone from the screen. `routers/admin.py`'s docstring
says the same thing.

**Still open.** Reconciling the two plan generators is open question 5, which
the product owner has to decide. The eight-sheet renumber is decision 20. A
brief that *proposes* a control leg ("Add X, 1.2 km S of the site") cannot
write it: nothing here dispatches.

---

## Decisions — do not re-litigate

Each of these resolves a genuine conflict between territory designs or between the brief
and the measured data. The rejected alternative is recorded so the argument does not
restart.


**1. Separate REACH from CLAIM. Draw the plume as far as the kernel physics says; compute every verdict, agreement metric and evidence statement only inside the driven-coverage mask and inside a per-class detection envelope (~4 km under E/F, ~1.5 km otherwise); render everything beyond it dashed, unfilled and labelled 'beyond measurement range - model only'.**

- *Rejected:* Picking one number: the 15 km physics reach, the 2,000 m global detection cap, 'never exceed 1.5 km because that is what we measured', or 'it must reach 2.75 km or community cannot ship'.
- *Because:* All four positions were correct about different objects and the argument was unresolvable as stated. A 10 km cone from Ridgeline covers 96.7% of the road grid, so an unbounded diff is a picture of the campaign boundary; but under the 34% of hours that are E/F the plume genuinely does cross the monitored area and today's cone stops at 1.5-2.5 km. One style rule applied identically in four skins satisfies every constraint at once.

**2. One module, src/air/dispersion.py, at package root, importing neither air.datagen nor air.server.**

- *Rejected:* air/plume_kernel.py, air/dispersion.py, extracting plume_reach into src/air/server/geo.py, and 'just reuse the Pasquill machinery in field.py' - four proposals for the same constants.
- *Because:* The entire point of extracting a kernel is that the drawn cone, the truth field, the interception metric and the sector gate cannot drift. Four names guarantee four implementations, and the fourth option is the one the ground-truth containment rule exists to prevent.

**3. Build the estimator as a throwaway probe script with a published parameter sweep, a mandatory rotation placebo and a multi-seed check, frozen as a committed fixture, before it becomes an endpoint or informs a single line of UI copy.**

- *Rejected:* Promoting any of the four published headline numbers (+4.60, +6.0, +38.2, +0.1 ppb for the same Ridgeline quantity) straight into an endpoint and scheduling interface work against it.
- *Because:* Reproduced this session: the same claim returns -3.85, +1.45, +3.69 or +3.98 ppb on two parameters alone, across 14-17 paired hours. Not one of the seven territories ran a null test; the one placebo that was run returned +32.99 ppb at a fabricated bearing. Four interfaces designing screens against a statistic whose sign is a parameter is a week of simultaneous rework.

**4. The measured touchdown is served as LineString features on the road grid with per-segment n, from one endpoint, GET /sites/{id}/touchdown. No Polygon geometry from that endpoint, in any interface.**

- *Rejected:* Filled polygon bands; a concave hull clipped to a coverage mask; polar annulus-sector polygons as the primary object.
- *Because:* Within 1 km of Ridgeline there are 9 road segments and they are all one road; within 2 km, 23 segments on 4 names; and about 69% of the campaign bbox is more than 150 m from any driven midpoint. A polygon there is a 2-D shape extrapolated from a line, and it converts unmeasured ground into apparent measurement. CONTRACT section 9 non-negotiable 2 already made the road grid the hero visual. Polar bins survive as a derived roll-up on the same payload.

**5. Key the endpoint on /sites/{id}, and make the estimator's source point the emission-weighted centroid of the site's active emission points, recomputed when the operator toggles one.**

- *Rejected:* A /sources/{source_id}/ route keyed on a new source concept.
- *Because:* There is no source entity in the schema and inventing one to address emission points is scope nobody needs. The two proposals were held to be irreconcilable because one key moves with config and one does not - but the centroid can be a parameter of a stable URL, which gives the industry tuning story without a new key.

**6. Five touchdown states: elevated_downwind, contested, no_detection, insufficient_passes, not_measured. `attributed` is cut, not role-gated.**

- *Rejected:* A six-state enum with `attributed` gated server-side by role.
- *Because:* Given the placebo evidence, the strongest verdict the estimator can support is 'elevated when the wind blows from here'. A state that exists in the payload eventually renders. And the gate would not be a gate: role arrives as a query param or the X-Air-Role header with no auth (concerns.py:216-223), so server-side role enforcement here is honest-by-convention and must never be described as hard.

**7. Split the word `tier` into model_tier IN ('permit','aclima') and forecast_tier IN ('climatology','regional','aclima') before any CHECK constraint is written. The bare word appears nowhere in schema, API or types.**

- *Rejected:* Keeping `tier` with basic/aclima, and the third value 'operator'.
- *Because:* Four incompatible meanings were in play, two already drafted as conflicting SQL CHECK constraints. A client reading `tier` off a forecast row and passing it to a plume-model endpoint gets a silent wrong answer. 'permit' rather than 'basic' because the filed study is a legal object and the two axes must not share a value name. An operator-authored model is a separate question, deferred rather than smuggled in as a tier value.

**8. Fix the field.py evaluation window and near-field box, but in phase 3 - after the estimator probe, before the endpoint - together with sampling_mode in a single rebuild.**

- *Rejected:* Cutting the window fix from the first pass entirely, or doing it first before anything is measured.
- *Because:* Verified: 1,007 of 1,307 segments (77.0%) lie beyond the 4,200 m clip from Ridgeline, so the truth is absent from three quarters of the network and caps what any estimator can find. But doing it first means re-tuning against nothing. Doing it after the probe means the re-tune is measured. Combining it with sampling_mode means one rebuild instead of two.

**9. Add drive.sampling_mode and inherited segment_pass.sampling_mode, and compute community-facing segment_stat from uniform passes only.**

- *Rejected:* Computing stratum at analysis time only and adding no column to segment_pass.
- *Because:* Targeted driving shifts per-segment medians by up to +57%, and 2.66x on the worst near-source case from four passes, and those medians feed the community headline risk score and the regulator's street ranking. You cannot filter a build-time aggregate by a runtime-derived stratum. The objection is answered rather than overruled: why a car was sent somewhere is a fact about the drive, recorded once; which stratum a pass falls in stays geometry, computed at analysis time. Note the claim that this is irreversible is wrong - build.py wipes and rewrites every physical table - so it is added now because it is free during a rebuild already happening, not because it is a one-way door.

**10. Build the community per-site soft cloud the owner asked for, with `Usually` (wind climatology) as the default mode rather than the live cone, plus three hard rails: no touchdown annulus or lofted-annulus in the community skin at all, concern coordinates snapped to segment midpoints, and every model sentence in one reviewable PLUME_COPY object.**

- *Rejected:* One neutral merged transport band with no brand colour and no per-company shape.
- *Because:* The owner's decision here is explicit and it is a values call he already made, not a matter of fact - where the critiques found facts I followed the facts, and this is not one. But the honesty objection is real, so it is answered structurally: the front door is a reach-independent frequency statement that needs no cone and cannot be read as a targeted accusation, the coordinate snapping removes the de-anonymisation surface, and the annulus - a model shape that would put a bright company-coloured band directly over Boxtown at 2.75 km where the measurement is indistinguishable from a placebo - never enters this skin. Flagged for the owner regardless.

**11. Drop 'the plume must reach Boxtown or the community feature cannot ship' as a blocking dependency.**

- *Rejected:* Holding the community work until the reach fix makes the cone touch residents.
- *Because:* It inverts the dependency and makes the atmospheric model hostage to a desired narrative. If the honest cone does not reach a resident in most hours, the correct response is to say so. The `Usually` mode delivers the whole narrative - the wind carried from Ridgeline over Boxtown in about half of all hours - without the cone touching anyone, and the measured street layer carries the health information anyway.

**12. Ship the forecast verification ledger, computed from the database and labelled 'illustrative - simulated forecast, error is a chosen parameter'. Forbid it as the paywall's justification. Locate the premium tier's honest pitch in spatial fidelity (channelling and the 34-degree wake veer already in mobilewind.py), not in longer-range skill.**

- *Rejected:* Serving a forecast skill table as the honest sales number; and separately, shipping no skill artefact at all.
- *Because:* Computing it from the database does not make it honest - the Aclima tier beats the regional tier because we chose the noise scale, so selling on it is circular reasoning wearing the costume of a verification statistic. But shipping a forecast with no published miss rate converts every miss into a credibility loss instead of an expectation that was met. Ship the ledger, forbid the sales frame.

**13. Entitlement resolves per app skin. The regulator skin ignores it unconditionally, with a test asserting the regulator payload is byte-identical across flag states, and a second test pinning the free cone's geometry as not a function of any flag.**

- *Rejected:* One global flags.industry_tier with a session override that a demo-giver toggles live across all four skins.
- *Because:* A lock inside a compliance tool reads as a vendor monetising public health and discredits every honest thing on the same screen. And the durable hazard is not this design - it is the growth experiment two sprints out that nerfs the free tier to sell premium. Only a regression test prevents that.

**14. Leave narrative._suspect's 4,000 m / 30-degree attribution gate alone and fix the community NULL copy instead, so it says 'we could not connect this to any of the industrial places on the map' rather than 'the wind was not coming from any of the industrial places nearby'.**

- *Rejected:* Deriving the attribution gate from the kernel reach and rebuilding.
- *Because:* A conservative attribution gate is a feature, not a bug - the problem was never the gate, it was a copy line asserting something the drawn geometry may contradict. Deriving it from the kernel would move 137 NULL attributions and several scripted demo beats for no honesty gain. Fixing one sentence costs nothing and is strictly more true.

**15. Restate the ground-truth containment rule as data-flow rather than as an import ban, and keep the import-closure test as necessary-but-insufficient.**

- *Rejected:* Relying on 'src/air/server/touchdown.py must not import air.datagen' as the guarantee.
- *Because:* Once the Briggs physics lives in air.dispersion, importable by the server, 'the server cannot import air.datagen' no longer means the server cannot reproduce the truth field - it can, from the same constants. The rule that actually holds: no value derived from evaluating a dispersion kernel at a receptor may be labelled measured, served under a touchdown path, or drawn in the measured register, regardless of which package computed it.

**16. Defer all driveplan.py surgery. The Mission Brief ships read-only over the datagen-built plan, as a proposal with a debrief.**

- *Rejected:* Priority-weighted dispatch, the two-leg split shift budget, and _walk returning end_node in the first pass.
- *Because:* _walk consumes the shared rng per segment, so splitting a shift into two calls changes the draw count and therefore every downstream speed, ping and pass across all 90 days including untargeted days - the change is not reviewable as a diff and it invalidates every fixed-count expectation. And the payoff does not need it: the compelling content is 'here is where tomorrow's plume goes, here is how few passes we have there, here is the plan we would run', which ships without touching the solver and keeps the demo stable.

**17. Ship per-channel calibration state derived from existing monitor.measures_json plus colocation events computed from segment_pass x monitor. No DAG, no hop counts, no residual histogram, no new tables.**

- *Rejected:* A four-kind calibration event model with a peer-transfer hop DAG, an SVG lineage ribbon, and per-channel residual distributions.
- *Because:* The valuable half is nearly free and needs no graph: verified from the database, the reference monitors carry only o3, no2, pm25 and co, so 7 of 11 measures - including bc and ch4, the two the leapfrog argument rests on - have no reference anchor anywhere in the campaign. The residual histogram is the problem: it is entirely invented, it will look exactly like a real QA artefact, and a simulated falsifiability check is a picture of falsifiability rather than the thing.

**18. Cut site scenarios and emission-point write endpoints. 'Tune your site' is an ON/OFF toggle and a height stepper re-running the model against the existing endpoint.**

- *Rejected:* emission_point.scenario_id, a site_scenario table, four write endpoints with activity logging and SSE.
- *Because:* It is the only write path in the entire combined design and needs its own honesty rails, and the model-versus-measurement diff works fine on as-built. The toggle delivers the narrative with no schema and no writes. Defer behind the touchdown and the model tiers.

**19. Cut the plume_residency and plume_interception_hour precompute tables, the touchdown_run and touchdown_segment persisted tables, the datagen-precomputed default touchdown in `setting`, and any admin-facing truth-versus-estimator correlation row.**

- *Rejected:* Materialising each of these at build time for speed or for a self-check.
- *Because:* The four-tower interception is about a second and cacheable; the expensive 59M-test surface is the panel to defer, not the headline. Nothing needs the persisted runs until a regulator over-time view exists. The precomputed default touchdown is generated on the wrong side of the containment wall and is what two maps would paint on first load. And a displayed 'our estimator correlates 0.8 with the truth' readout implies a validation capability Aclima does not have in the field - it belongs in a build-time test assertion, never in a served row.

**20. Cut the deletion of Community.tsx and Contacts.tsx (~346 lines) and the six-sheet admin renumber from this programme.**

- *Rejected:* Bundling both cleanups with the plume work as the territories proposed.
- *Because:* Both are probably correct and both are unrelated to the narrative. Bundling them makes the riskiest change in the repo unreviewable as a diff. The Mission Brief can be sheet 08 placed third in the nav with a one-line note.

**21. Add coerce_class to the kernel but strike the F-at-6-m/s bug from every narrative, and never present it as addressing the tiny-blob complaint.**

- *Rejected:* Treating it as a measured finding and quoting the 4.3 km reach it produces.
- *Because:* Verified across all 2,160 wind rows: F maxes at 2.98 m/s, E at 3.69. The state never occurs in this data, so the widely quoted figure is the formula evaluated on fabricated input. The guard is still worth having - forecasts and user-tunable config will genuinely produce it - but it is a guard, not a fix.

**22. Cut the five-day map preview. Days 0-1 are assignments; days 2-5 are a watch list with no targeted allocation applied.**

- *Rejected:* A five-day targeted drive plan presented as a schedule, per the brief's 'several days out'.
- *Because:* At 96 h both forecast tiers reach roughly zero skill against persistence and are at or worse than climatology beyond three days; a 37.5-degree error at 4 km range is a plus-or-minus 3 km arc against a campaign about 10.5 km across. The honest reframing is also the better pitch: the plan is rewritten every single morning because the wind moved, which is what makes the Mission Brief a daily ritual rather than a monthly document.

---

## Never say

The product-wide list. Section 10 of `docs/CONTRACT.md` is where this becomes binding
(task **P0-D**) so that a caption change cannot quietly remove it.

- This plume is affecting you / your street / your home.
- Company X is responsible for the air on your street, or caused this - in any interface, including industry's own.
- The plume was here - as a bare statement without a pass count. Any touchdown statement carries n or it does not ship.
- No plume detected here - where the true statement is 'we have N conditioned passes on this street', and N is often zero.
- Measured - applied to anything interpolated between streets, or to any point outside the driven-coverage mask.
- Verified / confirmed / proven, about any model-versus-measurement comparison. The honest verbs are the three the codebase already uses: consistent with, diverges from, insufficient data.
- Real-time - for anything derived from segment_stat, which is a 90-day aggregate, or for anything at all in the community skin, where positions are delayed at least 180 minutes.
- Aclima's model is correct, or accurate. It is a model.
- Any claim beyond the detection envelope phrased as measurement rather than as model.
- The actual impact on human health - of any touchdown number. What the estimator produces is a difference of medians in ambient concentration, conditional on wind sector, at road level, over a 90-day campaign. It is not exposure, not dose, and not health.
- You may be being poisoned or harmed by X. (community)
- It is safe to go outside, or the air is safe today. No interface may issue an all-clear about health; all_clear is a scenario name and must never become UI copy.
- Your report proves, or your report confirms, anything. (community)
- The plume will be over your home on Thursday - no forecast reaches the community skin at any lead time. (community)
- Any boundary word on a resident's screen: affected area, impact zone, blast radius, footprint, inside or outside the plume. (community)
- Any number attached to the community cloud - no concentration, no percentage, no chance. /wind/dispersion's level property is discarded at the layer boundary. (community)
- Any company name inside the community map canvas itself, as opposed to inside a tapped detail rail with its limiting paragraph attached. (community)
- Your plume is within limits, or compliant, or cleared, or no exceedance - as the output of any model tier. (industry)
- Upgrade to avoid enforcement, or to stay ahead of the regulator. Sell planning; never evasion. (industry)
- This community concern is unfounded, or not attributable to us - the mirror of the rule that industry cannot close a concern. (industry)
- The measured data confirms your model. At best: consistent with, over the N streets where we have M or more conditioned passes. (industry)
- Your network has full coverage, or is adequate. We are selling the gap; we do not grade the agency's homework. (regulator)
- This monitor is miscalibrated. We calibrate off them; a disagreement with a reference monitor is a jointly-owned disagreement, not a finding against them. (regulator)
- Aclima replaces stationary monitoring. Concede the duty-cycle case explicitly and the spatial claim becomes credible. (regulator)
- The plume missed your towers X% of the time - without stating the fraction of hours that had enough passes to judge. (regulator)
- Optimal drive plan. It is optimal against an objective we chose, under a forecast that misses at long lead. (admin)
- Coverage complete. Complete against a target pass count, never against the ground: about 69% of the bbox is unroaded or undriven. (admin)
- Targeted driving reduces cost. The fleet drives the same shifts; targeting reallocates them. The defensible claim is reaching a given plume-hour capture with fewer vehicle-days.
- NVIDIA Earth-2, presented as an integration. The label is 'Aclima model tier (illustrative)'.
- Any forecast accuracy figure presented as evidence of model quality rather than as a demo property of a simulated forecast whose error is a chosen parameter.
- Traceable to any named real standards body. Use 'traceable to a national standard' or a fictional one, consistent with the fictional-actors rule.
- Uncalibrated, for a channel no reference instrument in the region carries. The honest phrase is 'no reference anchor exists in this campaign' - a statement about the network, not about our sensor or the agency's diligence.

---

## Open questions — these need the product owner

The design cannot settle these; they are values calls or product calls.


**1.** Community per-site clouds versus one neutral merged transport band. The plan builds the per-site version because the owner's instruction is explicit and this is a values call rather than a factual one - but the honesty lens dissents strongly, and the specific residual risk is that a site-tinted cloud over a residential district is per-company attribution rendering whatever the caption says. Decide explicitly before phase 6 copy is written, because forty lines of finished copy hang on it either way.

**2.** What is actually being sold in the industry tier. The plan holds the free tier to: the full measured touchdown, the operator's own filed study, the diff strip, the concordance tape, and the Aclima model as a single axis and reach number - so the free tier can reach 'your study points ~40 degrees off from where the air actually goes' unaided. That leaves the paid tier selling forward time and finer space. Is that enough of a product? If not, the honest options are to sell something else (scenario runs, tuning services, forecast corridors) rather than to move the measurement behind the lock.

**3.** Does the deployed demo stay wall-clock-anchored? The Dockerfile omits --now (line 76), so every deploy re-anchors the campaign to container build time and the data always ends 'today' - right for a live demo, and it means no measured number in this plan is reproducible against production. Accept the divergence and treat prod as unmeasurable, or pin the deploy build and accept data that visibly ages?

**4.** If the rotation placebo in phase 2 fails for every stratum beyond about 2 km - a real possibility - is the industry studio still worth building on the rotation-only story (the roughly 40-degree axis disagreement between the filed study and the observed rose, which is true, defensible, and defends the operator) rather than on a far-field touchdown shape? This changes the studio's headline and should be decided the day the sweep lands, not discovered during phase 5.

**5.** Whether the Mission Brief may ever drive the real Chinese-Postman solver, or stays a read-only proposal permanently. The plan defers the solver surgery on risk grounds; reconciling the two plan generators (the boustrophedon stand-in at routers/admin.py:85 versus build.regenerate_drive_plan at build.py:512) is a separate decision with its own cost, and regenerate_drive_plan's partial-rebuild path is the right hook whenever it happens.

**6.** Whether the Boxtown narrative beat may be depended on at all. Phase 2 checks it across three seeds. If it does not survive, every piece of copy mentioning a district or a magnitude must be generated from the numbers at runtime rather than written, which changes how phases 5-7 are authored. Worth deciding the policy in advance: generate-from-numbers everywhere by default, or accept seed-pinning for the demo?


---

## What the critiques caught


### Lens: Cross-interface coherence — does the combined design produce four views of one dataset, or four products? I checked the touchdown contract, the meaning of "tier", the shared kernel, and whether the same measured fact survives the trip between skins. Where territories disagreed about a number I re-derived it from `data/air.db` (56,492 NO2 passes, 1,307 segments, 2,160 wind hours, Ridgeline at -90.1479/35.0350).

Four products. The vocabulary is shared and almost nothing else is. The measured touchdown — the primitive the whole brief hinges on — arrives as five incompatible objects: five URL shapes, two different keys (`/sites/{id}` vs `/sources/{id}`, and the source key is emission-weighted and config-dependent so the two cannot be reconciled by aliasing), four geometry types (polygon bands, segments+hull, polar annulus sectors, LineStrings-with-Polygon-forbidden), three verdict vocabularies of 2/3/6 states, and four mutually exclusive control definitions. That last one is not a style difference: I measured it. Downwind-minus-crosswind NO2 at 2–3 km from Ridgeline is +1.30 ppb unconditioned, +4.33 under E/F, and **−4.26** when you restrict to Boxtown segments under E/F — and my reconstruction of T1's own same-hour paired estimator returns **−5.52 ± 4.57** where T1 reports +4.60 ± 0.56. Four interfaces each running "the touchdown" as specified will print facts about Boxtown that differ in sign. Worse, the number T2's whole regime-stratification argument rests on is an artefact: at 3–4 km under E/F, the downwind pool is Boxtown (583 passes) + White Chapel (97) and the crosswind pool is Westwood (388) + Darwin (91) — a fixed source and a 72%-southerly rose mean geography, not meteorology, selects the sample, and the road-class mix differs 39% vs 16% non-residential against a 10.80→12.32 ppb class spread. Only T3 caught this, and T3 filed it as a planner requirement rather than a property of the shared statistic. Meanwhile the estimator that *is* defensible — segment as its own control, conditioned on stability — clears T7's `MIN_CONDITIONED_PASSES=12` on **0 of 1,307 segments** (38 clear a lenient 5), so T7's constants would make every one of the four screens return `insufficient_data` forever. The design is salvageable and the pieces are individually excellent, but it needs one estimator in one module with one payload and one enum before any interface work starts; right now each territory has quietly invented its own and validated it against a different aggregation.

**Contradictions resolved:**

- **T1 (measured-touchdown), T2 (primitive), T4 (industry), T5 (regulator), T7 (audit)** — Five incompatible measured-touchdown objects. URLs: /sites/{id}/measured-touchdown, /sources/{source_id}/touchdown, /sites/{id}/touchdown (polar), /sites/{id}/touchdown (LineString-only). Keys: site centroid vs emission-weighted source centroid that MOVES when the operator toggles a stack — these cannot be aliased. Geometry: polygon bands / segments+hull+mask / annulus sectors / road lines / LineStrings with Polygon explicitly forbidden. Verdict enums of 2, 3, 4 and 6 states with no shared member. T2's `attributed` is role-gated server-side; T7 forbids the concept outright; T4's `resolved` carries no attribution semantics at all.
  → *One endpoint, `GET /sources/{source_id}/touchdown`, keyed on the source centroid (T2 is right that this is what makes site tuning real). Payload = T2's segment rows + evidence tuple + coverage mask, with the hull derived and always paired with the mask. One 6-state enum, T2's. T4's polar bins, T5's road lines and T1's district rollup all become *renderings computed client-side or server-side from that one payload* — additional response fields at most, never separate statistics. Role gating on `attributed` server-side per T2. Write the payload shape into docs/CONTRACT.md before any interface starts.*
- **T2 and T4 headline tables vs T3's road-class finding vs the data** — T2's ring table (+6.0 ppb at 2.5–4 km under E/F, n=678) and T4's polar table are unmatched downwind-vs-control contrasts. I verified they are confounded: at 3–4 km under E/F the downwind pool is Boxtown 583 + White Chapel 97, the crosswind pool is Westwood 388 + Darwin 91. Ridgeline is a fixed point and the rose is 72% southerly, so 'downwind at 3–4 km' is permanently one set of neighbourhoods and 'crosswind at 3–4 km' is permanently another. Campaign-wide district medians already differ (Boxtown 11.35, Westwood 11.27, Darwin 9.34) and the road-class mix differs 39% vs 16% non-residential against a 10.80 (residential) → 12.32 (secondary) → 21.12 (motorway) spread. T2's risk section says these numbers 'are the thing that makes the narrative true'; they are the thing that makes it look true.
  → *Road-class matching and segment-as-own-control are properties of the shared estimator, not of the drive planner. Re-derive every published table with segment-as-own-control before a single line of UI copy quotes a number. My run of that estimator under E/F: +4.71 at 2–3 km (6 segments), +6.90 at 3–4 km (8 segments), +0.57 at 4–6 km (7 segments) — the signal survives, but it rests on 21 segments campaign-wide and every headline must carry that n.*
- **T7's constants vs T2's regime stratification** — T7 sets MIN_CONDITIONED_PASSES=12, MIN_SUPPORTED_SEGMENTS=6, MIN_DISTINCT_ROADS=2 as the honesty floor. T2 makes stability stratification mandatory because pooling destroys the signal. Measured: with segment-as-own-control under E/F, ZERO of 1,307 segments have >=12 passes on both sides, and only 38 have >=5. Applying both territories' rules simultaneously makes the industry studio, the regulator's evidence layer and the community 'what we measured under it' counter permanently empty. Neither territory noticed, because each validated against its own aggregation.
  → *Decide explicitly, in the plan, that at these sample sizes the touchdown is a SITE-LEVEL pooled claim over many segments, not a per-segment one; set the floors from the measured joint distribution rather than from intuition, and keep per-segment state only as `not_measured`/`insufficient_passes` colour on the map. Then put '0 of 1,307 segments clear 12 conditioned passes on both sides under stable air' on the Mission Brief as the justification for targeted driving — it is the strongest argument in T3's territory and it is currently nowhere.*
- **T5 (regulator) vs T4 (industry) and T7 (audit)** — T5 renders the measured touchdown as 'T2', the third of three map tiers, alongside 'T0 permit model' and 'T1 Aclima model'. T4's rule (a) is that models are drawn as lines and measurement is drawn as ink, precisely so measurement is never read as a third model. T7 forbids any model-measurement comparison outside the coverage mask for the same reason. A regulator and an operator would leave with opposite mental models of what the measurement is.
  → *Adopt T4's encoding rule verbatim in all four skins and write it into CONTRACT alongside the existing non-negotiables. T5 keeps its layer but renames: 'permit model' and 'Aclima model' are tiers; the measurement is a separately-labelled evidence layer with its own legend line, never numbered into the tier sequence.*
- **T1, T3, T4, T5, T7 — the word 'tier'** — Four incompatible meanings, two of them already baked into SQL CHECK constraints with different value sets. T1: forecast tiers ('climatology','regional','aclima'). T3: `wind_forecast.tier CHECK IN ('basic','aclima')`. T4: model tiers basic|aclima on /sites/{id}/plume-model. T7: `dispersion_model.tier CHECK IN ('basic','aclima','operator')`. T5: T0/T1/T2 map layers including the measurement. A client that reads `tier` off a forecast row and passes it to a plume-model endpoint gets a silent wrong answer, and the two CHECK constraints cannot both be right.
  → *Two distinct words, decided now, before any migration: `model_tier IN ('permit','aclima')` and `forecast_tier IN ('climatology','regional','aclima')`. The bare word `tier` appears nowhere in schema, API or types. T7's third value 'operator' is a separate question (an operator-authored model) and should be deferred rather than smuggled in as a tier value.*
- **T1, T2, T5, T7 — the shared kernel** — Four proposed homes for the same Pasquill constants: `src/air/plume_kernel.py` (T1), `src/air/dispersion.py` (T2), extract `geo.plume_reach` into src/air/server/geo.py (T5), and 'reuse the Pasquill machinery already in field.py' (T7). The whole point of extracting a kernel is that the drawn cone, the interception metric, the sector gate and the truth field cannot drift. Four kernels drift by construction, and T7's option is the one the import ban exists to prevent.
  → *One module, `src/air/dispersion.py`, at package root, importing neither `air.datagen` nor `air.server`. `field.py`, `server/geo.py`, the estimator and the planner's `plume_frame` all import it. T5's `plume_reach` and `point_in_cone` live there, not in server/geo.py, so the interception metric and the rendered cone are the same arithmetic. Ship T1's `coerce_class` in it too. The import-closure test T2 and T7 both ask for asserts the estimator's closure excludes `air.datagen`.*


### Lens: Honesty and overclaim — where a viewer would form a false belief, where a visual implies precision or causation the data cannot carry, and whether the simulation's ground truth can leak into a "measured" product.

The combined design is more honest in its prose than in what it would actually render, and one of its two load-bearing new objects does not survive contact with the data. I reimplemented the measured-touchdown estimator exactly as the plume-physics territory specifies it (per-segment median baseline, same-hour paired downwind wedge <35° against a crosswind control pooled over 0.3–6 km, stable hours) and got **Boxtown −13.42 ppb over 15 paired hours / 621 passes**, not the claimed +4.60 ± 0.56. Then I ran a rotation placebo — the same estimator with the transport bearing rotated to a direction the wind was never blowing. Under E/F at 0.5–2.5 km it returns **+32.99 ppb at rot+270°** against −12.27 at the true bearing; under A/B/C at 4–8 km it returns **+2.54 at rot+0° and +2.63 at rot+270°**. The estimator produces multi-ppb "detections", with tight CIs, for fabricated wind directions. It is measuring road-class composition and diurnal amplitude, not a plume. Worse, `field.py:326` clips every plume to a 4,200 m × ±1,450 m window, so the ground truth from Ridgeline is *identically zero* beyond 4.2 km along-wind — yet the touchdown territory reports +1.8 ppb at 4–6 km and +3.2 ppb at 6–8 km under E/F and proposes freezing those numbers as a regression fixture. That would pin an artifact as the definition of correctness. Three territories computed the same quantity three ways and got +4.60, +6.0, and −13.4; not one of them ran a null test. Everything else here is fixable by discipline, and much of it is genuinely excellent — the aloft/touchdown physics, the per-channel calibration limit, the never-say list, the coverage mask, the sampling_mode contamination catch. But no measured-touchdown number, polygon, hull, annulus or verdict may ship until it passes a rotation placebo and a build-time correlation against `field.py`'s truth. Ship the physics fix and the honesty scaffolding first; the measurement object is not ready, and shipping it as-is would be the most confident falsehood this codebase has ever produced.

**Contradictions resolved:**

- **Plume-physics territory (+4.60 ± 0.56 ppb Boxtown), measured-touchdown territory (+6.0 at 2.5–4 km E/F, +38.2 at 0.5–1.5 km), industry territory (2.23× at 0.5 km, no signal past 2 km), overclaim audit (+0.1 ppb at 2–3 km)** — Four territories computed the same quantity — Ridgeline NO2 downwind excess — and got four incompatible answers, three of which are presented as measured fact with confidence intervals and one of which is proposed as a regression fixture. I reproduced the most fully specified variant (same-hour paired, crosswind control pooled 0.3–6 km, per-segment median baseline, stable hours) and got Boxtown −13.42 ppb over 15 hours / 621 passes. A rotation placebo then returns +32.99 ppb at a fabricated bearing (E/F, 0.5–2.5 km, rot+270°) versus −12.27 at the true bearing, and +2.5 to +2.6 ppb at 4–8 km under A/B/C at BOTH the true and a fabricated bearing. The estimator detects road-class composition and diurnal amplitude, not the plume. Additionally, field.py:326 clips the truth plume to 4,200 m along-wind, so every far-field cell in the touchdown table (4–6 km, 6–8 km) sits where ground truth is identically zero — those are provable false positives.
  → *Freeze the measured-touchdown object. Before any of it ships: (1) a rotation placebo (transport ±90/180/270°) is a mandatory acceptance test — any stratum whose placebo magnitude is within 2× of its true-bearing magnitude is not reportable and must return insufficient_data, not a number; (2) a build-time correlation against field.py's truth footprint runs as a TEST that fails the build, not as an admin UI metric; (3) no cell beyond the truth window (currently 4.2 km) may be reported at all until the window fix lands and is rebuilt; (4) road-class matching between strata is mandatory, not a refinement — within-bucket my results swing from +0.6 (residential) to −18 (mid-class) in the same ring and hour. Adopt one estimator, in one module, with the three rejected variants documented as failing tests. The +38.2 ppb / n=20 near-field cell and the +4.60 Boxtown headline must not appear in any UI copy until they survive this.*
- **Plume-physics territory (15 km reach under E/F; annulus with ground max at 3.2 km) and industry territory ("measured max reach 1.41 km; any copy framing basic-vs-Aclima as small-vs-large is wrong on the data") and overclaim audit (DETECTION_RANGE_M = 2000)** — The owner's "tiny blob" complaint is being answered with a 15 km model at exactly the moment the measurement is being asked to adjudicate it. A 10 km cone from Ridgeline covers 97.2% of the road grid; the measurement cannot resolve past ~2 km. A "model vs measurement diff" computed over that region is a picture of the campaign boundary, and it will read to every audience as "the model overstates" — which we cannot support and did not test.
  → *The overclaim audit is right and its rule is the reconciliation: fix the physics (adopt the shared plume_kernel — the σ_z-based reach and the aloft/touchdown distinction are correct and are the best idea in the brief), but every band beyond DETECTION_RANGE_M renders in a distinct, labelled register — dashed outline, no fill, legend line "beyond measurement range · model only" — identically in all four interfaces, and no agreement metric is ever computed outside the coverage mask. The honest headline is the industry territory's: the disagreement is a ~40° ROTATION, not a reach. Lead with that.*
- **Community territory ("this feature must NOT ship" unless the reach fix makes the cone touch Boxtown) and the physics/measurement evidence** — This inverts the dependency: it makes the atmospheric model a hostage to the desired narrative. If the honest cone does not reach a resident most hours, the correct response is to say so, not to widen the cone until it does. The territory's own default mode ('Usually', wind frequency: Ridgeline→Boxtown 50.0% of hours) delivers the entire narrative without the cone touching anyone, and its own measurements show ~background at 2.75 km.
  → *Drop reach as a blocking dependency for community. Ship 'Usually' (wind climatology) first and make it the front door, exactly as the territory itself recommends. A cone that stops short is not an all-clear if the screen never claims coverage — and the measured street layer, which is the contract's hero visual, is what carries the health information anyway.*
- **Community territory (site-brand-tinted HeatmapLayer cloud, one per site) and overclaim audit (single unnamed merged transport band, no brand_color, no per-company cone) — and the plume-physics territory's lofted annulus** — A soft cloud tinted with a company's brand colour, sitting over a residential district, IS per-company attribution rendering. The tint is an identity channel; the territory's own argument that it cannot be read as severity is correct and beside the point — it can be read as "that company's air is over my house". The physics territory then compounds it: under stable air the honest model puts a bright ground-level annulus at 3.2 km — directly over Boxtown at 2.75 km — with nothing at the fence. That is a model drawing a targeted, company-coloured accusation over houses, at a distance where my own measurement is +0.93 ppb (E/F residential) and indistinguishable from a placebo. The physics territory flags this in its own risks and is right to.
  → *The overclaim audit wins. One neutral merged transport band for community; no brand_color, no per-site cloud, no touchdown annulus, no lofted-annulus rendering in the community skin at all. Company names appear only in the tapped rail, only alongside the wind-frequency number and the standing paragraph already at Picked.tsx:220-236. Keep the community territory's copy work wholesale — the never-list, the 'what this does not say' block travelling with the object, the 137-of-204 'not them, this time' case — it is the best writing in the combined design. Just do not let it render per-company shapes.*
- **Plume-physics territory (GET /wind/forecast/skill "computed from the database, never hard-coded — that is the paywall's honest sales pitch") and drive-plan territory ("reporting our own noise parameter back to us and must not ship")** — Computing the skill table from the database does not make it honest. Tier 3 beats tier 2 because we chose k_tier = 1.90 × (0.62 + 0.30·min(1, L/120)). Serving that back as a verified MAE/skill/sector-hit table, and using it to justify a price, is circular reasoning wearing the costume of a verification statistic. It is the single most sellable-looking dishonest object in the design.
  → *The drive-plan territory is right. The skill table may exist as a demo artifact labelled 'illustrative — this is a simulated forecast and its error is a chosen parameter', and it may never be the paywall's justification. The overclaim audit's verification ledger is the honest version and must ship in the same PR as the forecast, never after. Never present NVIDIA Earth-2 as an integration; 'Aclima model tier (illustrative)' is the label.*
- **Overclaim audit (segment_pass gains sampling_mode; community-facing segment_stat computed from uniform passes only) and drive-plan territory ("NO new column on segment_pass")** — Directly incompatible, and the audit is right on a measured, irreversible risk: targeted driving shifts downwind-only medians by up to +57%, and 2.66× on Paul R Lowry Road at 768 m from 4 passes. That number feeds the community headline risk score and the regulator's street ranking. Once targeted and uniform history are mixed with no field recording why the car was there, it cannot be unmixed. The drive-plan territory's stated reason for refusing the column — that it would freeze a bearing assumption into 200k rows — does not apply: sampling_mode is a fact about dispatch intent, not a geometric derivation.
  → *Add sampling_mode to drive and segment_pass, and land it BEFORE the first targeted plan. Make MIN_CONTROL_SHARE = 0.20 a publish-blocking validation on the Mission Brief, not a gauge. Non-negotiable ordering.*


### Lens: Sequencing and risk — what is the minimum spine, what order avoids rework, what is underestimated, and what genuinely costs a rebuild, a schema change or a deploy.

The combined design holds together as a narrative and collapses as a plan. Three things are true at once. (a) The physics keystone is right and cheap: one shared dispersion module plus a stability-conditioned reach fixes the owner's "tiny blob" complaint in about two days with no rebuild and no schema change. (b) The measured-touchdown primitive that four of the seven territories build on is NOT a settled quantity — I can flip its sign with one parameter. Class-matched, E/F, Boxtown swings from -2.50 ± 1.68 to +2.12 ± 1.15 ppb on the control pool's inner radius alone (300 m vs 1000 m), n=101 either way, and Territory 1's explicit instruction to "pool the control across all ranges 0.3–6 km" is precisely the setting that produces the wrong sign, because crosswind passes at 0.3–1 km carry field.py:358's 640 m isotropic near-field term (+41 ppb under E/F). (c) The seven reports collectively propose roughly 16 new tables, 12 new columns and 20 endpoints against a 15k-line server — about a doubling of the data model — and no single report can see that, because each sees only its own. The good news nobody exploited: a rebuild is 115 s and byte-reproducible (I verified: segment_pass NO2 sum 748632.87 identical) because build.py wipes and rewrites every physical table and the Dockerfile regenerates the world in-image. There is no migration burden in this repo — schema changes are nearly free. What is expensive is estimator churn and four-layer map integration, and both are unbudgeted everywhere. The correct order is therefore: fix three live defects today; land the shared kernel; build the estimator as a throwaway parameter-sweep script and freeze it as a committed fixture BEFORE it becomes an endpoint; then the field.py window; then one endpoint all four apps consume. Everything else — forecast, planner surgery, calibration lineage, coverage precompute, scenarios — is optional relative to four-interface coherence and should be sequenced by demo value, not by report length.

**Contradictions resolved:**

- **Territory 1 (15 km domain-limited reach under E/F) vs Territory 7 (DETECTION_RANGE_M = 2000, do not enlarge) vs Territory 4 ('the disagreement is a rotation, not a reach; both models overstate distance') vs Territory 6 ('the plume must reach residents or this must not ship')** — Four incompatible answers to the owner's most concrete complaint. Territory 7's 2 km constant is measured on pooled data and is the wrong SHAPE — the excess is ~0 past 1.5 km unconditioned but survives to ~4 km under E/F, which is 34% of hours (698 F + 39 E of 2160). Territory 1's 15 km is right physics and wrong evidence: field.py:326 clips the truth field at 4,200 m and I confirmed 77% of segments lie beyond it, so nothing past 4.2 km is even simulated as plume. Territory 4's 'rotation not reach' is correct for A/B/C hours and wrong as a general claim.
  → *Reach is a function of stability, not a constant and not a global enlargement. Draw the model to the kernel's honest per-class distance, but define a per-class DETECTION ENVELOPE — about 4 km under E/F, 1.5 km otherwise — and render everything beyond it in an explicitly labelled model-only register (dashed outline, no fill, 'beyond measurement range'). This satisfies Territory 6 (under E/F, when residents actually complain, the plume reaches Boxtown at 2.75 km), Territory 7 (no agreement metric is ever computed outside the envelope), Territory 1 (the physics is unmodified) and Territory 4 (under A/B/C the rotation story stands and the cone stays small). One rule, four interfaces, one line of legend copy.*
- **Territory 2 ('+6.0 ppb at 2.5–4 km and +3.2 at 6–8 km under E/F — the owner's instinct that plumes travel far is correct and the data supports it') vs Territory 7 ('+0.1 ppb at 2–3 km; the measurement cannot see past 2 km') vs Territory 3 ('road-class matching is mandatory; the 10 ppb class spread is larger than any plume enhancement')** — I reproduced all three and Territory 3 wins. Ridgeline NO2 downwind minus crosswind, E/F hours, road-class matched: +3.81 @1.5–2.5 km, +2.67 @2.5–4, +1.22 @4–6 (inconsistent across classes: residential +0.67 vs tertiary +2.72), +0.22 @6–8 (residential -0.79, trunk -3.87). Territory 2's far-field numbers do not survive class matching. Worse: excluding segments also within 4.2 km of Delta Forge or Riverport, the 4–8 km signal goes NEGATIVE (-1.01 and -1.76). Territory 2's far-field touchdown is the other two sites' plumes aligned by chance with Ridgeline's downwind sector. And at 1.5–4 km there are ZERO segments outside both other sites' windows — the three plume envelopes tile the monitored area.
  → *The defensible Ridgeline touchdown is 0.3–4 km under stable air, source-exclusive only inside about 1.5 km. Territory 2's exclusive_share is therefore mandatory infrastructure, not a refinement, and its measured value beyond 1.5 km will be near zero for most segments. Drop every claim past 4 km. The honest headline is not a shape: inside 2 km, under E/F, downwind, Ridgeline has 60 passes across 9 segments (one road name) in 90 days. That sample-size sentence IS the product, and it is a far stronger argument for Territory 3's targeted driving than any far-field polygon.*
- **Territory 1's recommended estimator ('pool the control across all ranges 0.3–6 km within the hour — the data does not support the tighter pairing') vs its own reported result (Boxtown +4.60 ± 0.56 ppb)** — The recommendation and the result are incompatible. I implemented the same-hour paired estimator and swept the control pool's inner radius with road class matched and downwind restricted to ≥1.5 km: control ≥300 m gives Boxtown -2.50 ± 1.68; ≥1000 m gives +2.12 ± 1.15; ≥1500 m gives +1.71 ± 1.40. Same n=101 downwind passes throughout. The cause is mechanical: field.py:358 adds an isotropic near-field term with NEAR_SIGMA_M = 640 m, and crosswind passes at 0.3–1 km carry +41 ppb of it under E/F, inflating the control and inverting the sign. Territory 1 documented a wrong-signed v2 (-4.83) and then recommended the parameter that reproduces it. Territory 2's +38.2 ppb at 0.5–1.5 km (n=20) and Territory 4's 2.23x at 0.5–1.0 km (n_down=23) are the same family of numbers computed three more ways.
  → *No number from any of these three territories may be used to schedule UI work, write copy, or set a demo beat. Build touchdown.py first as a standalone probe with an explicit parameter sweep over (control inner radius, wedge half-angle, class matching on/off, baseline definition, min-n), publish the sweep, and freeze the choice as a committed regression fixture with the sweep table attached. Only then promote it to an endpoint. This is one to two days and it is the highest-leverage step in the plan; skipping it costs a week of rework in four apps simultaneously.*
- **Territory 1 (touchdown polygon bands) vs Territory 2 (weighted segment set + concave hull + coverage mask) vs Territory 4 (polar annulus-sector polygons, 12 sectors x 4 rings) vs Territory 7 ('no Polygon geometry is served by this endpoint' — LineStrings only)** — Four incompatible output geometries for the same primitive, and all four interface territories have already designed screens against their own. Whichever ships, three interfaces get rebuilt. Territory 7's argument is empirically decisive and I confirmed it: 9 segments on ONE road name within 1 km of Ridgeline, 23 segments on 4 road names within 2 km, and 77% of the campaign bbox unroaded or undriven. A polygon there is a 2-D shape extrapolated from a line.
  → *One primitive, decided before anyone writes a screen: Territory 2/7's per-segment evidence rows plus Territory 2's coverage mask are the object; Territory 4's polar bins are a DERIVED view over the same rows (cheap, and it is what the industry diff strip and concordance tape need); Territory 1's polygon and Territory 2's hull ship last, optional, and only ever hatched UNDER the segment lines labelled 'interpolated between measured streets'. Route naming: /sites/{id}/touchdown, not Territory 2's /sources/{source_id}/ — there is no source concept in the schema and inventing one to address emission points is scope nobody needs.*
- **Territory 1's wind_forecast (tier climatology/regional/aclima, 6-hourly issues, leads 0–120, dir_sd_deg) vs Territory 3's wind_forecast (tier basic/aclima, 05:00 daily issues for the last 14 days, dir_sd_deg + speed_sd_ms) vs Territory 7's forecast_run + forecast_verification (a different decomposition entirely)** — Three incompatible schemas for the same table, and Territory 4 conditionally proposes a fourth. Territory 3 explicitly warns 'so wind_forecast.tier is not invented twice' and then invents it a second time. Whichever lands, the other two territories' endpoints and screens are wrong on arrival.
  → *One table, decided on paper before any datagen code: Territory 3's tier vocabulary (basic/aclima — it matches the industry paywall and the regulator T0/T1 naming), Territory 1's issue cadence and lead range (6-hourly, 0–120 h; daily 05:00 issues cannot demonstrate 'the plan changed overnight' within one issue cycle), Territory 1's measured error-model constants (the only ones prototyped and scored against this world's own persistence baseline), and Territory 7's verification ledger as a second table shipping in the SAME commit as the forecast, never after.*
- **Territory 1's forecast_skill table and GET /wind/forecast/skill ('that is the paywall's honest sales pitch') vs Territory 3 ('any forecast-accuracy tile, Brier score or bearing-MAE readout is reporting our own noise parameter back to us and must not ship') vs Territory 7 ('a verification ledger, published, on the same screen as the forecast — the single most important honesty mechanism in the whole brief')** — Territory 3 forbids exactly the artefact Territories 1 and 7 make mandatory. Both sides are half right: the skill number IS our own noise scale, AND shipping a forecast without a published miss rate is the failure Territory 7 correctly identifies.
  → *Ship the ledger; forbid the sales pitch. The verification table is computed from the database (never hard-coded) and rendered as a demo property — 'in this simulated record, forecasts at this lead contained the measured plume N% of the time' — with the SIMULATED marker doing its usual work. What must not ship is Territory 1's framing of it as the paywall's evidence: the Aclima tier beating the basic tier is a design decision encoded in a noise scale. The premium tier's honest pitch is Territory 1's own better answer, buried in its risks: SPATIAL fidelity — the street-canyon channelling and 34-degree wake veer already in mobilewind.py — not longer-range skill.*

---

## The honesty problem, stated up front

This codebase's defining quality is that it refuses to assert what its data cannot support:
industry can never close a community concern; a concern is attributed to a site only when wind
transport lines up within 30° and 4 km; the `aclima_sense` composite ships with a paragraph
about what it does not claim.

This narrative puts pressure on exactly that, in four places, and the design must answer each:

1. **"Mobile sensing can determine the actual impact of a plume."** A fleet drives a street a
   few dozen times over 90 days at whatever hours it happened to pass (`n_passes` p10/p50/p90 =
   25/46/68 at `window='all'`). What a measured touchdown can honestly claim from that is a
   much narrower thing than the sentence implies.
2. **Plumes on the community map.** Hedged wording does not undo a picture. A cone drawn from a
   named company across someone's house *is* an accusation, whatever the caption says.
3. **A premium model tier.** Selling a better plume model means the free tier is knowingly
   worse. There is a line below which the free tier must not fall.
4. **The simulation knows the truth.** `field.py` generates the real plume. A "measured"
   touchdown that quietly reads from that would be the deepest possible lie this product could
   tell — it would demo perfectly and mean nothing.
