# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

`air` has two layers of user, and they must not be collapsed into one.

**The person the artifact has to succeed in front of** is an **Aclima salesperson driving
the demo live** for a prospect — a datacenter operator, a state or regional air agency, or
a community-based organization. They are on a call or in a room, narrating, clicking on
cue, with no ability to stop and debug. Success is that the three-way tension lands, the
prospect asks for a pilot, and nothing breaks under a driver who is talking while
clicking. When demo legibility and product depth conflict, the live demo wins.

**The four in-fiction audiences the interfaces are designed for**, one route each:

- **Community residents** (`/community`) — people who live next to emitters and want to
  report a smell, a sound, or a generator running all night; see what their neighbours
  reported; and hear from the agency and the operator. They do not know what PM2.5 is.
  This is not a data-science product for them.
- **Regulator / agency staff** (`/regulator`) — they run a handful of gold-standard
  reference monitors and have data scientists. Their job is compliance: is a reading over
  a national limit, and do they now have to warn the community or press an emitter. They
  want exact concentrations, magnitude, persistence, and editable action levels.
- **Industry operators** (`/industry`) — datacenter builders and operators trying to
  maximize compute without getting blocked or penalized. Most of them do not want to think
  about air quality at all. They want to know what the problem is, where it is, how long
  it has been up, and one recommended action.
- **Aclima admin** (`/admin`) — internal. Draws the campaign, generates the drive plan and
  simulated data, sees every role at once, and fires scripted demo scenarios.

## Product Purpose

Aclima measures air quality from a fleet of cars that drive every street in a campaign area
repeatedly. `air` is the flagship prototype UI over that data: **one React application,
four interfaces, one shared dataset.**

The thesis is that Aclima sits in the middle of a three-way standoff — community,
regulator, industry — over what the air is actually doing, and is the arbitrator of the
truth. **The demo succeeds when a viewer can feel that tension**: an action taken in one
interface visibly lands in another. Every feature is judged by whether it strengthens or
dilutes that.

Correctness is explicitly not the goal. Look, feel, and narrative are. All data is
simulated; thresholds, units, and health breakpoints are plausible guesses that must stay
tweakable rather than accurate.

## Positioning

- **The atom of the product is a ~200 m road segment**, not a point and not a hexbin.
  Measurements are snapped to real road geometry, and a segment is only trusted after
  ~25+ passes. No competitor working from stationary sensors or satellite has this shape
  of data.
- **Leapfrogging.** Aclima's mobile fleet is calibrated against the regulator's own
  reference monitors, so agencies trust its *precision* within distance-bounded limits.
  That converts a handful of fixed towers into street-level coverage. In this dataset the
  argument is a property of the data, not a claim: **no reference monitor measures BC,
  diesel, or CH4**, so those action levels are unreachable by the regulator's own network.
- **Observed wind, not assumed wind.** The vehicles carry anemometers, so Aclima holds
  street-level measured wind. Industry buys expensive AERMOD/CALPUFF dispersion studies
  that are only as good as the wind rose they assumed. Letting an operator check their
  consultant's assumption against measurement is the strongest single reason for industry
  to pay. The seeded study is deliberately and provably wrong.
- **Attribution stays honest.** Three emitters sit on three sides of the community. The UI
  must never imply certainty about who is to blame. The ambiguity is *why* an arbitrator of
  measurement has value, and the honest version is the more persuasive one.

## Operating Context

**How Aclima actually works.** A campaign is a geographically and temporally bounded area.
A drive plan is a repeated sequence of road segments; a fleet of electric or hybrid cars
executes it until every segment has enough passes. Data reaches the analysis pipeline
within minutes. Calibration happens before, during, and after a campaign.

**The setting for this build.** Southwest Memphis — Boxtown, Westwood, White Chapel,
Riverport. Real OpenStreetMap street geometry and real neighbourhood names; **entirely
fictional companies, agencies, and people.**

| Actor | Role |
|---|---|
| **Ridgeline Compute** | `Ridgeline South Campus`, 350 MW AI datacenter, gas turbines + diesel backup. Sits **SW** of the community, so prevailing SW wind carries its plume over Boxtown. |
| **Delta Forge Metals** | Manufacturing, **north** of Boxtown. |
| **Riverport Logistics** | Intermodal/drayage, **north-east**. Diesel truck traffic. |
| **DRAQA** | Delta Regional Air Quality Authority — the regulator, 4 reference monitors. |
| **Boxtown Air Watch** | Resident CBO. 18 personas total: 8 community, 4 regulator, 4 industry, 2 Aclima. |

**The three cross-role loops are the spine of the demo.** They are the mechanism by which
the tension becomes visible, and they are load-bearing product truth:

1. Community files concerns → ≥3 within 600 m / 24 h auto-form a cluster → the cluster
   appears as a contact in the industry interface and in the regulator's review queue.
2. Regulator edits an action level → the backend re-evaluates immediately → exceedance
   alerts appear or vanish across roles, including in industry. Dragging a threshold is one
   of the best moments in the demo.
3. Industry posts a mitigation → it surfaces under the community's concern. **Industry can
   never close a concern.** Status only reaches `mitigation_proposed`; the client rejects
   `resolved` and the backend returns 403. The asymmetry is reflected honestly, never
   blurred.

Everything is live over SSE, so an action in one interface updates another with no refresh.

**Scripted demo scenarios** exist so a salesperson can produce the tension on cue:
`generator_test`, `concern_wave`, `wind_shift`, `methane_leak` (the leapfrog moment),
`all_clear`, `model_divergence`.

## Capabilities and Constraints

**Non-negotiables** (from `docs/CONTRACT.md` §9 — these are product rules, not styling):

1. A `SIMULATED DATA` marker stays visible in every interface.
2. The **road grid is the hero visual** in every interface with a map — segments coloured by
   magnitude and/or persistence. Not hexbins, not points.
3. **Community language carries no units and no acronyms.** `measure_def.plain_name` and
   unitless 0–100 risk scores exist for exactly this.
4. Industry cannot close a community concern — only propose mitigation.
5. Community sees fleet positions delayed ≥3 h (curiosity without stalking). Regulator and
   admin see live.
6. Anything a demo-giver might want to tweak — thresholds, ramps, fleet size, passes, delay,
   risk breakpoints — is editable in the admin interface or in `measure_def`.

**Terminology.** *Segment* (~200 m of road, the data atom) · *pass* (one vehicle traversal)
· *campaign* (bounded area + time window) · *drive plan* (repeating segment sequence) ·
*modality* (measured species: NO2, PM2.5, BC, O3, CO, CO2, CH4) · *indicator* (derived:
methane leak, diesel, non-diesel) · *action level* (regulator-defined threshold) ·
*magnitude* vs *persistence* (how high vs how often) · *aclima_sense* (composite 0–100
human-impact score across measures with a real health pathway).

**Technical constraints.**

- React 19 + TanStack Router/Query + deck.gl + Zustand on the front end; Python FastAPI +
  SQLite (`data/air.db`) on the back end. Data is procedurally generated by
  `src/air/datagen`, not fetched live.
- **Basemap is MapLibre, not Google**, despite a Google key existing: that key's Cloud
  project forces vector rendering, and vector maps ignore the `styles` array, so all four
  role skins collapsed to a stock light basemap. The skins matter more than the vendor.
- TypeScript `strict` is on; wire types are full of `| null`.
- The industry advisor calls Claude for real, degrading to a local rules engine when
  `ANTHROPIC_API_KEY` is absent or the call fails. The demo must run fully without any key.
- Unit scales that are easy to mix up: `freq`/`assumed_freq`/`observed_freq` are percentages
  0–100, `delta` is percentage points, `disagreement` is a 0–1 fraction.

**Deliberately undecided / demo-grade.** EPA limits, health breakpoints, unit conventions,
and user preferences are plausible guesses meant to be corrected later, which is why they
are all tweakable. This is a prototype; it is not expected to be a complete working system.

## Brand Commitments

- **Name and voice are binding.** Aclima, and the way Aclima talks about its own
  measurement: precise, plainspoken, never overclaiming. Where `n_obs` is low or `dir_sd` is
  high, the UI says so. Fake confidence is off-brand, because the entire premise is that
  Aclima is the trustworthy measurement.
- **The "aclimator" — Aclima's rounded-triangle mark — is binding as a form.** Its **colour
  is not**; the user is willing to bend it to fit the surface it sits on.
- **No aclimator asset is currently in the repo.** `web/public/favicon.svg` is a stand-in: a
  sharp diamond with three orbiting dots, not the aclimator. The real mark must be supplied
  by the user before any surface can carry it correctly. Do not redraw it from memory.
- Nothing else from aclima.earth is binding. The visual identity in
  `web/src/design/tokens.css` is this project's own and is free to evolve on its own logic.
- The four fictional actors above are established canon within the demo and are reused
  across roles; do not rename or re-invent them.

## Evidence on Hand

**Real, in the repo:**

- `data/air.db` — 90 MB of generated campaign data. 1,307 segments over 195.9 km and 7 real
  districts, 56,889 passes, 95.56 % of segments at ≥25 passes (mean 45). 90 days, 5
  vehicles, 13 stationary monitors, 2,160 h of wind, 28.5k mobile wind observations.
- **The physics is generated, not asserted.** NO2 near Ridgeline's generators runs 2.31×
  the campaign median overall and 3.86× at 03:00; O3 falls to 0.54× at night under a 180 m
  boundary layer; the hotspot decays to background by 1.5 km. Real exceedances exist in the
  data (NO2 1-h NAAQS 5 h, max 120.6 ppb on Riverport Road; O3 8-h NAAQS 2 h; PM2.5 24-h
  NAAQS 21 h during smoke episodes).
- **The consultant's dispersion study diverges measurably**, by construction: north-half
  wind assumed at 2.35 % vs 6.45 % measured (48.4 % inside the wind-shift episode); Boxtown
  weighted at 0.3 % assumed vs 23.6 % measured.
- Real OSM street geometry, industrial parcels, and neighbourhood names for SW Memphis.

**Explicitly absent — never fabricate:**

- No real customer names, testimonials, case studies, press, logos, or pricing. Aclima's
  real largest client was CARB (2025–26 California SMMI campaign, 62 underserved
  communities), which is background context, **not** a claim to put on a surface.
- No real measurements. Every number in the UI is simulated and must be marked as such.
- No aclimator logo file (see Brand Commitments).

**Optional, external, not required to run:** a CARTO subscription and BigQuery access to
Aclima's real hyperlocal data (`bq-aclima-lab`, key in `.env`) — the organization is a
ten-year sprawl and the generated data was chosen over it deliberately. A Google Maps key
exists but is not used for the basemap.

## Product Principles

1. **Judge every feature by the tension.** If it does not make the three-way standoff more
   legible, it is decoration. Cross-role consequence is the product.
2. **The segment is the hero.** Road-segment geometry coloured by magnitude and persistence
   is what makes this look like nothing else. Never fall back to hexbins or points.
3. **Honesty is the differentiator.** Ambiguous attribution, visible uncertainty, unreachable
   action levels, the asymmetry that industry cannot close a concern — every one of these is
   less flattering and more persuasive. Simulated data is always labelled as simulated.
4. **Each audience gets its own literacy, not a shared one.** Community gets unitless risk
   with no acronyms; regulator gets exact concentrations; industry gets bearing, distance,
   severity, and one action. The same dataset, four vocabularies. Never leak one into another.
5. **Everything a demo-giver might want to change is changeable.** Thresholds, ramps, delays,
   fleet size, breakpoints. A guess that can be tuned on the call beats a guess that is right.

## Accessibility & Inclusion

No formal conformance target was set. The real requirements come from the data
visualization and are already load-bearing in the code:

- Modality colours are chosen for separation under **deuteranopia**.
- **Never colour alone for severity** — pair it with shape, position, or text.
- `prefers-reduced-motion` is honoured; the wind particle field degrades to a static
  streamline field.
