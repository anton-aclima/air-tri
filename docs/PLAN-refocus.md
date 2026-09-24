# air: redesign plan — the zoom-out (2026-09-23)

> **Status: decisions made 2026-09-23 (§6a); phase 1 in progress.** Produced by a five-surface review (one auditor and one adversarial critic per surface), then ten of its load-bearing claims were independently re-checked. §8 records what that re-check changed; the corrections are also applied inline, marked **[verified]** or **[corrected]**.

This plan merges five surface reviews into one. A critic challenged each review, and I applied every critic correction I agreed with. Section 7 lists the few I did not take, with the reason for each. Admin and the Aclima view are out of scope. Web paths are relative to `web/src/`. Server paths start with `src/air/`.

**The short version.** Four changes answer nearly everything you raised:
1. **One clock.** Give the demo a single clock that stops at the end of the data, and put it in a timeline popup.
2. **Map plus one panel.** Build every regulator and industry screen as a map plus one side panel, so nothing collapses at 1080.
3. **Metaphors as look, not words.** Take the metaphor words out of the copy. Keep the metaphors as look and feel.
4. **Contract rules on every map.** Draw model and measurement by the contract's rules on every map. That includes the regulator map, which draws no plume at all today.

## 1. What we heard

| You said | Where it's answered |
|---|---|
| Lost track of the scope; let's zoom out | This page: four moves, six phases (§5), 13 decisions (§6) |
| Too literal. Industry refers to "Tower Defense" literally | §2.1 and F5. The industry code itself contains no tower-defence words. An industry viewer meets them in two places: the "TOWER DEFENCE" chip on the Landing door and in the ⌘K switcher, and the regulator's double coverage rings drawn on the industry map. Both go. |
| Too busy, for example the Industry alert header | §3.4 I2, F3 |
| Sim control opens on a time picker, with no idea when the campaign starts or ends; you scroll to find the limits | §3.1 S1 |
| A "Start at beginning" button and a visual timeline in one popup | §3.1 S1–S2, F1–F2 |
| Community is pretty good | §3.2 keeps its structure; the changes mostly remove things |
| Plumes disappearing when zoomed out is weird | §3.2 C1 (phase 1) |
| Why does "Usually" never show anything? | §3.2 C3. It was built to draw nothing on purpose. It now gets a wind rose. |
| Regulator: no plumes? | §3.3 R2, F6 |
| Regulator focus 1: what the reference "towers" report | §3.3 R3, R5 |
| Regulator focus 2: how the mobile network adds spatial detail, and whether expected plumes reach the towers or the mobile measurements | §3.3 R4, R5 |
| Regulator focus 3: how this overlays with community concerns | §3.3 R5 (Residents block), F7 |
| Regulator is extremely busy; at 1080 text collides and everything is clipped | F4, §3.3 R1, R9 |
| The industry deck lost the map; the RWR may not be needed if the map tells the story | §3.4 I1, I3, I5 |
| Aclima later | Out of scope. D13 is deferred to that review. |

## 2. What is actually wrong

Five causes produce nearly every symptom.

1. **The metaphors became vocabulary and panels, not just direction.**
   - The internal field `RoleMeta.narrative` is printed as user-facing copy: "TOWER DEFENCE" and "FLIGHT DECK" at Landing.tsx:153 and RoleSwitcher.tsx:59.
   - CONTRACT §6 describes each room using words (tripwires, contacts, suspected emitters, scope), and those words then ended up in the UI.
   - The LLM advisor is told the UI "is a radar warning receiver" (advisor.py:90).
   - Each instrument got its own panel, so the industry deck prints one alert's bearing, "044°", five times.
2. **The layouts were designed at 1680 wide. Narrower, they collapse instead of reflowing.** Two rules cause this: `<main>` is not allowed to scroll, and everything stacks into one column below 1180. At 1080:
   - the industry map row gets 0px (the map panel measures 1000x2);
   - the regulator Reach panel is 2px tall;
   - the regulator's big status word prints 131px over its own headline;
   - the regulator header strip shows 153 of its 294px;
   - community's "Report a concern" button is about one-third visible.
3. **Nothing owns "now".** The data ends 2026-08-28 13:54; the wall clock says 2026-09-23.
   - "Live" means the wall clock, so the default view is empty: "0 reports from neighbours this week", data freshness 26 days. Eight separate local patches work around this.
   - Alerts, reports and the feed ignore the cursor, so going back in time shows the future: 50 "in 2 d" stamps at Aug 12.
   - The client writes UTC times and the server reads them as local campaign time, so in a Pacific-time browser the server's view is 7 hours off.
   - A saved Aug 12 cursor silently opened every screen on Aug 12.
4. **Status has no single source.**
   - One industry screen shows four alert counts (9, 4, 3 and 5), ADVISORY next to CAUTION, and "21% headroom" (from the retired `headroom_pct`) next to "22% cut needed".
   - The regulator shows 13 active next to 15.
   - `status: active` does not mean ongoing: several "active" alerts ended days earlier.
5. **Model and measurement drift from CONTRACT §10.**
   - The regulator map draws no plume at all.
   - On industry, today's plume is filled and off by default, while the filed study is solid, filled and on. The supporting visual outshouts the main one.
   - Community's cloud is filled out to 8 km, past the 4 km detection envelope, and is darkest at the far end.
   - Sites are tied to alerts through whatever field was handy: "Riverport Intermodal · 7 contacts" in threat red; touchdown figures printed for Delta Forge even though its result is `no_detection` (1.78 ppb, under the 3.28 floor, placebo ratio 0.73) — **[corrected]** on the industry Evidence page (Evidence.tsx:198-224), not the regulator panels, next to an unsupported "but it is over homes" (100% of its downwind passes are on President's Island); "On the geometry, this is yours".

## 3. Surfaces

### 3.1 Simulation / time control

**The experience.**
- **The chip is the clock.** The SIMULATED DATA chip opens the time control. At the end of the data ("Latest", the default) it reads just SIMULATED DATA. While replaying it adds the date ("· Aug 12 13:01") in neutral ink.
- **The popup is mostly one timeline.** Clicking the chip opens a small popup with no dimmed backdrop. May 31 sits at the left, "Aug 28 · end of data" at the right, and a faint strip of driven days runs underneath, so days without driving show as gaps. Event ticks from the data sit above the track.
- **One row of controls:** Start · ◀ event · Play/Pause · event ▶ · Latest · speed.
- **Start is useful.** It lands on the morning of the first driven day, not on an empty May 31.
- **The map stays visible.** While playing, the popup shrinks to a 56px bar.
- **A reload always opens at Latest.**

| # | Change | What | Files | Effort |
|---|---|---|---|---|
| S1 | Timeline popup replaces the modal | A ~560px popover anchored to the chip, with no dimmed backdrop. It closes on Esc or an outside click, stays open while playing (collapsed to track plus pause, ~56px), and expands again on pause or hover. TimeCursor is rebuilt as its body, spanning `campaign.start_date` to the end of data. The drive strip comes from `by_day`, with the 7 missing days filled as zeros. One footer line of dataset facts (all fictional), and one line saying what the street colours on this map cover. Keyboard: ←/→ moves 1 h, shift moves 1 day, Home/End jump to Start/Latest; `,` `.` `L` are kept, with hints in tooltips only. Adds a Popover to app/ui. | app/SimControl.tsx, app/TimeCursor.tsx (+ .module.css), app/ui/surfaces.tsx, app/useRoleSwitch.ts | M |
| S2 | Event ticks from the data, per role | Community sees report clusters only, with hovers like "Boxtown · Paul R Lowry Road — 9 reports", never an alert title. Regulator and industry see alerts through the hooks' existing role default; clusters come from one source, not two. Ticks within ~12px merge into one tick with a count. Ticks from model-sourced alerts (`source_type='model'`) are hollow. Previous/next event is the main way to move; clicking a tick is secondary. Start = the first `by_day` row with passes > 0. Nothing hard-coded. | app/TimeCursor.tsx, core/queries.ts | M |
| S3 | Chip becomes the clock; LIVE chip deleted | The chip keeps its exact words, set so they never clip; only the date may drop. The date shows only while replaying, in `--ink-2` or an outline, not the watch-alert colour. Delete LivePulse and its unseen counter, which only grows because nothing ever marks events seen. Show a "No stream" pill only while disconnected. The header gets ~84px lighter at Latest. The Landing badge is unchanged. | app/SimulatedBadge.tsx (+ css), app/AppShell.tsx | S |
| S4 | Playback that works | Play at Latest restarts from Start, and playback stops at the end of the data. Keep two cursors: the display cursor updates every frame; the cursor that drives queries snaps to the data's resolution (1 h for wind, readings and dispersion; 10 min for fleet) and updates at most 4 times a second. Keep previous data on screen while new data loads (`placeholderData: keepPreviousData`). Speeds 1 h/s, 6 h/s (default) and 1 day/s play the whole campaign in 6 minutes or 90 seconds. | app/useTimePlayback.ts, core/session.ts, core/queries.ts | S |
| S5 | Dead controls and old names out | Remove the analysis-window select (no screen reads `windowHours`), the datetime field, the six step buttons, Running/Paused, the drift banner, and the "Advisor" and "fleet delay" rows. Two states, three words: Latest / Replaying <date> / Playing. | app/SimControl.tsx, core/session.ts, core/README.md | S |

These depend on F1 and F2 (the clock and events that follow it).

**Cut:**
- The datetime field (which accepts any year) and its Set button.
- The six ±h step buttons and the analysis-window select.
- The 1x and 15x speeds.
- The drift banner and the engineer-only facts.
- The LIVE chip and its counter.
- "Follow the clock", "Pinned" and "Go live".
- The blurred full-screen backdrop.
- ComingSoon.tsx: dead code, and the only place the scrubber was ever mounted.

### 3.2 Community map

**The experience.** The same page with less on it.
- **The cloud stays at every zoom.** It fills only out to measurement range (4 km in stable air, 1.5 km otherwise) and fades to nothing there. Beyond that, the community map draws nothing.
- **"Usually" finally shows something:** one small, outline-only wind rose next to the scale, captioned "Where the wind came from, last three months". It is tied to no company.
- **Company names leave the map.** Tapping a site shows its line, for example "the wind blew from here toward Boxtown about one hour in three".
- **The side card only describes what is drawn.** It carries one caveat line instead of three bullets, and the report list shows 8 rows with "Show all".

**What the clip costs the story (D4).** Boxtown is 2.6 km from Ridgeline, so the cloud reaches it only in stable hours (stability classes E/F, about a third of hours). The "when reported" moment survives: the latest Boxtown cluster (Aug 27 06:19) sits 1.2 km from Ridgeline in a stable hour.

| # | Change | What | Files | Effort |
|---|---|---|---|---|
| C1 | Delete the zoom cutoff | Remove `minZoom = 11.5` and the `zoom` prop, on their own — including the `zoom:` argument at MapScreen.tsx:275, or `tsc -b` fails. **[verified]** The cutoff was kept deliberately in phase 6 as a second guard, but polygons drawn in metres cover *less* of the frame zoomed out (~4% at z10.8 vs ~40% at z12.4), so it never guarded anything; the 0.075 alpha is the real guard. The cutoff is left over from an old heatmap layer. The current layer is drawn in map distances, so zooming out makes the cloud smaller rather than washing over the map. Check at z10.8, 12.1 and 14, at 2026-08-12T20:00 (stable) and 11:00 (neutral). | components/map/layers/SoftPlumeLayer.ts, apps/community/MapScreen.tsx | S |
| C2 | Fill stops at measurement range | In the browser, cut each band and halo off at `detection_envelope_m` along the wind direction, measured from the site centre. **[corrected]** The envelope is 4 km only in stable air (E/F); in every other hour it is **1.5 km**, so on a typical neutral hour Ridgeline's filled cloud runs to ~8 km against a 1.5 km envelope — worse than first stated. The payload carries no site centre, so pass it in (MapScreen has `sites`). Rebuild the halos from the clipped ring rather than clipping them (clipped halos still stack over the band). Fix the overlapping band seams at ~1–1.5 km (currently the darkest spots, alpha 0.148, contradicting the layer's own "bands do not overlap" comment). Clip the measured-streets count the same way, or it keeps counting streets under a cloud no longer drawn. Replace the stacked halos with 3–4 slices of the last band, each fainter, so the fade reaches zero at the envelope. Nothing is drawn past it. No server change. | components/map/layers/SoftPlumeLayer.ts | M |
| C3 | "Usually" draws one wind rose | Reuse components/charts/WindRose (frequency mode, 16 sectors, ~64px, outline only, no numbers) as map furniture next to the scale and compass. It uses `climatology.rose`, which the card already fetches. Caption from a new `PLUME_COPY.usually.mapKey`. Delete the "usually draws nothing" comments so they don't argue the next person out of this. | apps/community/MapScreen.tsx, Plume.tsx, lib.ts, src/air/server/climatology.py (comment) | S |
| C4 | The card describes only what is drawn | Three states: while loading, show the title and lead only; with no data, show one sentence saying so; with data, show the normal copy. Delete the "we measured N streets under this shape in the last hour" counter, and put nothing in its place. It actually counts the 90-day street grid, including the model-only far band. Retitle Now "Where the wind was carrying air · <time>" (this drops "right now" and "this hour"). Replace the three bullets with one line that uses no boundary words: "A guess from the wind, not a measurement. It has no edge, and it does not mean anything was released." This saves about 120px. | apps/community/MapScreen.tsx, Plume.tsx, lib.ts | S |
| C5 | Company names off the map | Turn site labels off (`labels:false`); the footprint and logo badge stay, with no names on hover. The tapped site card gains its "usually" line plus `PLUME_COPY.usually.caveat`. In the Usually card, the logo moves beside the name instead of above it. | apps/community/MapScreen.tsx, Picked.tsx, community.module.css | S |
| C6 | A shorter side panel | Cap the report list at about 8 rows plus "Show all N". The list is 7,703px of the panel's 9,408px. Move the pin-colour key into the compact map legend or under the Filter card. | apps/community/* | S |
| C7 | Cloud colour off the health scale | Use a warm neutral from the community ink tokens (for example `--ink-3`, or a new warm grey), added to the TOKENS array in theme.ts. Today the cloud uses the analysis intensity colour (≈#B74082), close to the resident's "very unhealthy" purple. Not slate grey either: along the river it reads as water. | design/tokens.css, components/lib/theme.ts, SoftPlumeLayer.ts | S |
| C8 | Main button never clipped | Move "Report a concern" out of the sideways-scrolling nav pills into its own button that never shrinks. Hide the pill icons below 1200px. | app/AppShell.tsx, app/AppShell.module.css | S |

**Cut:**
- The zoom cutoff.
- The fill past the measurement range, and the halos stacked on the far band.
- The measured-streets counter and its fallback.
- Company labels on the map.
- The three bullets.
- The "usually draws nothing" rule.

**Not doing:** a wind fan at each site (D3), a dashed centreline past the envelope, a new server parameter for the split, or a slate `--model-soft` colour.

### 3.3 Regulator

**The experience.** One map-led screen, **Network**, replaces Watchfloor and Map, and answers your three questions in one frame.
- **What the monitors report.** The four reference monitors are labelled by name with their reading at the moment shown, for example "Riverport Rd 10.6". The ratio to the action level appears only when it is 0.5× or more.
- **What the mobile network adds, and where plumes go.**
  - The day's measured streets are the only filled ink; the legend reads "measured Aug 25".
  - Each site's modelled plume is a hairline outline: solid out to measurement range, dashed beyond it with "beyond measurement range — model only". Ridgeline's filed study is a dashed outline.
  - Clicking a monitor highlights the streets inside its ring and compares like with like.
- **The community overlay.** Report bubbles sit on top, and the side panel has a Residents block.

**Header, panel and nav.**
- The header is one generated sentence plus three numbers: alerts now, monitors reporting (3/4), and street-km measured (the number that shows the fleet extending the monitors).
- One 320px side panel reads Monitors → Plumes → Residents, one line per item, with figures only on click.
- Nav: Network · Alerts · Levels. Everything follows the timeline.

**The story the data already supports.** It is generated from status fields, with no numbers written into the copy, and worded to degrade gracefully on other seeds:
- **Riverport [contested — settle before writing copy]:** two of the product's own model surfaces disagree about this monitor. Point-in-polygon against `GET /wind/dispersion` at each alert's start puts it inside Riverport's plume in **7 of 9** alert hours (the regulator auditor); the coverage model's hourly cone masks (`coverage._hourly_masks`, what `/coverage/interception` uses) put it inside in **1 of 5** standard-level hours and 3 of 17 watch-level hours (the verifier). Phase 7 said the regulator surfaces use one geometry; this says they do not quite. **R0 (new, first task of phase 5):** reconcile the two — same hour key, same sources, same cone test — and write the headline only from the reconciled answer. If the low figure stands, the story becomes the one below; if the high one does, the original stands. So the honest story is the better one for this persona: *the monitor saw it, the monitor cannot say where it came from, and the model mostly does not put Riverport's plume over it at those hours* — which is exactly what the mobile network is for. Riverport's own downwind test is `elevated_downwind` but only just (3.75 vs a 3.28 floor), so the copy branches on state rather than assuming it.
  - **Trap:** `alert.site_id` gives a flattering majority (7 of 11) but it is the data generator's 30°/4 km bearing rule, not the modelled plume. Never print it as "inside the modelled plume". The "N of M exceedance hours inside the plume" figure needs a new server computation (readings over threshold joined to the coverage plume masks).
- **Ridgeline [corrected]:** no **NO2** reference monitor within 4 km (West Shelby Drive is 3.7 km away but carries no NO2; compute per channel, not per monitor). The fleet's downwind excess is elevated, and residents in Boxtown are reporting.

| # | Change | What | Files | Effort |
|---|---|---|---|---|
| R1 | The Network screen | Built from MapScreen's base map at full content height, plus one 320px side panel (F4). `/regulator` and `/regulator/map` show it. `/regulator/coverage` and `/regulator/analysis` redirect, and their content moves into the monitor detail (D6). Delete Watchfloor's status strip, the tripwire table, the tower board, the Reach panel, Suspected emitters, the duplicate timeline and the wind-stats panel. | apps/regulator/Network.tsx (new), Watchfloor.tsx, MapScreen.tsx, Coverage.tsx, Analysis.tsx, routes.tsx, core/roles.ts | L |
| R2 | Plumes on the map | The F6 outline layer, for all sites, for the pollutant in view, at the moment shown. A site gets an axis and label only when its outline touches a monitor, a street driven that day or an open cluster; the others are muted. The filed study is dashed and on by default, because the original brief asks for both models. Dim the ground the fleet never drove. | apps/regulator/Network.tsx | M |
| R3 | Monitors show their reading | MonitorLayer gets label-by-name and reading options; they are shared with industry, so the defaults stay as they are. Readings come from `/monitors/{id}/readings?to=<moment shown>`, because `/monitors` "latest" is always the end of the data. The alarm pulse fires only when a reading in the last hour exceeds a level with the same averaging period. That fixes "O3 ▲" appearing beside "Ozone 8-hour CLEAR". A missing channel reads "no NO2 channel" in muted ink. Monitor and site labels hide each other instead of overlapping. | components/map/layers/MonitorLayer.ts, apps/regulator/lib.tsx, src/air/server/loaders.py (optional) | M |
| R4 | The day's streets under the hour's plume | Network's street grid shows the day being viewed (781 streets on Aug 25), not 90 days. Streets with only 1–2 passes still show, drawn thin or hatched. The 90-day grid becomes a legend toggle. Otherwise a 90-day hotspot under an hourly plume reads as confirmation. | apps/regulator/Network.tsx, lib.tsx | M |
| R5 | Side panel and monitor detail | **Monitors:** name, reading, ratio, status. **Plumes:** only sites that touch something, with bearing, reach, which monitors sit inside (labelled "modelled"), and how many streets were driven inside that day. Below the coverage floor it reads "not enough of this area was driven to say". **Residents:** clusters in the report window; a site is named only under F7. Touchdown figures appear only when the result is `elevated_downwind`; otherwise show a sentence per state — `no_detection` "measured, inside the noise"; `contested` "a rotated bearing matched it"; `insufficient_passes`/`not_measured` "not enough to say". The same gate applies on industry Evidence (Evidence.tsx:198, where Delta Forge's 1.8 ppb is printed today), including its district bars and the hard-coded "but it is over homes". **Monitor detail:** the streets in its ring are highlighted. Its daily median is shown against the street range on the same day; this replaces "latest hour vs 90-day street p90", which read as grading DRAQA's instrument. Add the calibration anchor from `/coverage/calibration`. Add how often the monitor sits in a modelled plume, as a model-ink line split by site and by inside/beyond measurement range, printed with the payload's `basis` sentence. Add the monitor-vs-street 24-hour shape from Analysis. | apps/regulator/Network.tsx, lib.tsx | M |
| R6 | Alerts as episodes | Group alerts by source, pollutant and consecutive hours; the highest level tripped wins. A row reads like "5 episodes Aug 24–27 · peak 121.4 ppb", and ended alerts say "ended 3 d ago", not "up for 29d". Filtered to the moment shown (F2). The detail and the push composer open in a side sheet. The single duration timeline lives here only. | apps/regulator/Alerts.tsx, Push.tsx, lib.tsx | M |
| R7 | Action levels fit at 1080 | Rows are at most 64px: label, slider, number, state. The averaging slider shows only on the selected row. The auto-advise/notify toggles and "was X · revert" go behind a row disclosure. The consequence pane stays pinned on the right. The "fleet only · 0 towers" chip on every row becomes one legend line. | apps/regulator/Thresholds.tsx, regulator.module.css | M |
| R8 | Plain agency language | Per F5, these go: OVER THE LINE, "The line right now", Tripwires, armed, "Standing on this line", Suspected emitters, contacts, "blind to", Cars rolling, Tower-seen, the TOWER tag, "their scope". The threat-red "invader" tag becomes a neutral "site" tag. The tagline "who is doing it?" becomes something like "What my monitors report, and what the streets around them add." | apps/regulator/*, core/roles.ts | S |
| R9 | A density budget you can check | Written into the header comment of regulator.module.css. At 1680: at most ~120 visible words, counting labels drawn on the map; at most 16 all-caps labels; at most 8 chips; at most 2 overlays open (a ~240x90 legend, and one top-left bar holding the pollutant picker and Layers); one scrolling area. At 1080: the map is at least 640px wide, and no text overlaps or cuts off. Other sensors and fleet trails are off by default. | apps/regulator/regulator.module.css | S |

**Cut:**
- Watchfloor as a separate screen.
- The giant status words on every page.
- Both Suspected emitters panels and the "N contacts" tags.
- The alert timeline on the landing screen.
- Header-strip numbers that disagree with the page.
- The wind-model stats panel.
- The "fleet only" chip on every row.
- Always-visible notify toggles.
- The "Now | 90 days" mode and its plume-hour contours: a second model surface, and a risk of drawing model output as if it were measured.
- Coverage and Analysis as separate pages.

### 3.4 Industry deck

**The experience.** The deck is a map, one line of status, and a narrow side panel.
- **The line leads with the envelope,** which is the core message: *"Stable air · hold near 210 MW (modelled), running 268 · Says who →"*. Every figure comes from the data at runtime.
- **The map tells the story on its own:**
  - measured streets, the only filled ink;
  - Paul R Lowry Road, highlighted as the road the margin is measured on;
  - the moving wind particles, on by default because they visibly carry the plume;
  - today's plume as a hairline outline with its axis, dashed past measurement range;
  - the stacks;
  - the four DRAQA monitors by name with no rings, lit only when downwind.
- **The panel holds two things:**
  - a 24-hour envelope band: full load in well-mixed and neutral hours, ~210 MW in stable hours, "typical, from N measured stable nights";
  - one Downwind list.
- **Selection:** click anything on the map and the panel becomes its detail.
- **The avionics survive as finish only:** mono numerals, the phosphor-green accent, square corners.
- **At 1080** the map is about 660x700 beside a 340px panel.

| # | Change | What | Files | Effort |
|---|---|---|---|---|
| I1 | Map-led two-pane layout | Map plus a panel of about 340px (`minmax(0,1fr) clamp(280px,24vw,340px)`). Delete the rule that stacks into one column below 1180. The panel becomes a drawer only below ~960px (F4). Only the deck's own layout rules change, not the other industry pages. **[verified]** Simulated live at 1080x900: map 650x411 (from 0) beside the panel. The panel must scroll (its content is ~1,080px in a 565px column) and needs natural-height rows, not the flex tapes; `instruments` and `stack` need one wrapper. The same collapse exists in `.detailBody` (industry.module.css:228) and regulator.module.css:63. | apps/industry/industry.module.css, Scope.tsx | M |
| I2 | One calm envelope line | Replaces the 118px banner. MW only, with "(modelled)" inline; "Says who →" goes to /industry/site, which is where the study verdict actually lives. The state comes from the envelope, not from the worst alert. Never "Clear", "within limits" or "compliant". The bearing, range and alert-count readouts and the worst-alert line go. | apps/industry/Scope.tsx, lib.tsx | M |
| I3 | Retire the RWR and the radar geometry | Delete the RWR panel, the range rings and their labels, the dashed plume-track line, the bearing lines, the alert-history strip, the "Nothing picked" panel, the "Worst vs limit" gauge and the MODEL UNDERSTATES strip. Alert markers stay, labelled on hover or selection. Keep the RadarScope file for now. CONTRACT §6 and §8b and DESIGN.md's "Radar Scope" section change in the same commit (F5), so nobody rebuilds the dial. | apps/industry/Scope.tsx, lib.tsx, routes.tsx, docs/CONTRACT.md, DESIGN.md | S |
| I4 | Panel: envelope band and Downwind list | The band is built from each stability regime's hours of day, typical headroom and number of measured nights. It is a climatology, not a forecast. The Downwind list uses two-line rows, for example "NO2 over the 1-hour standard at DRAQA's Riverport Road monitor · 6.3 km NE · 24 Aug, 1 h". Alerts that were downwind of the site when they started come first; the rest fold under "Elsewhere within 6 km (n)". That rule is what stops another operator's monitor from headlining this deck. Uses the F2 "still ongoing" test. The wind-shift alert is excluded: it has no location, which is why it shows "000° / 0 m". The selection detail keeps "Only the air agency or Aclima can close a resident's report" and the Answer path. | apps/industry/Scope.tsx, Selected.tsx, industry.module.css | M |
| I5 | Today's plume is the story layer | On by default, drawn by the shared plume layer in its new F6 style (only industry uses that layer today), with the "beyond measurement range — model only" note when needed. The plume's axis replaces the separate plume-track line. The wind particles stay on (no more than 700 particles at 0.42 opacity), with the legend entry "fleet-measured wind, last 72 h". | apps/industry/Scope.tsx | S |
| I6 | The fenceline road as the anchor | Highlight Ridgeline's fenceline road (`env.fenceline_segment_ids`) with a label. Clicking it opens the envelope band and links to Evidence. | apps/industry/Scope.tsx | S |
| I7 | Filed study as an opt-in comparison | Off by default, behind "Compare with filed study". It becomes a dashed outline of the outer band with no fill. When it is on, one neutral legend line compares it with the fleet, built at runtime from the verification data with its sample size. | apps/industry/lib.tsx, Scope.tsx | S |
| I8 | Monitors named, rings gone | Turn off the monitor rings on the industry map, which removes the regulator's double ring and the faint disc. Label monitors by name. Emphasise only the ones downwind. Resident-cluster rings are off below zoom 14. | components/map/layers/MonitorLayer.ts, apps/industry/Scope.tsx | S |
| I9 | Honest report fill | Fill a report only when F7 links it to this site; draw the rest hollow. No "N downwind now" count. Rewrite all three downwind wordings in ContactDetail ("this is yours", "unlikely to be your plume", and the third) to describe the wind at the time, without attribution. | apps/industry/lib.tsx, ContactDetail.tsx | S |
| I10 | A legend chip, not a paragraph in caps | Swatches for: measured street, fenceline road, wind, today's plume (model), and the filed study (only when on), plus the beyond-range note when it applies. Longer explanations go in a sentence-case popover. The six toggle buttons become one Layers menu, plus a Re-centre button that appears after you pan. | apps/industry/Scope.tsx, industry.module.css | S |
| I11 | Cockpit words out | Per F5, these go: MFD, SLEW TO, LOCK, CHANNEL, CAUTION/WARNING/ADVISORY/NORMAL, PROXIMITY, CONTACTS, EXCD, BRG, SRC, UP FOR, "Acquiring contact…" and "No contacts". The advisor's templates and prompt change too. | apps/industry/Scope.tsx, Contacts.tsx, ContactDetail.tsx, components/lib/vizmeta.ts, src/air/server/advisor_rules.py, src/air/server/routers/advisor.py | S |

**Cut:**
- The RWR panel.
- The range rings, bearing lines and plume-track line.
- The banner readouts and the worst-alert line.
- HEADROOM and STATUS in the header strip.
- The Worst-vs-limit gauge.
- The alert-history strip.
- The "Nothing picked" panel.
- The MODEL UNDERSTATES strip and the wind-shift row.
- The double coverage rings.
- The all-caps map key and disclaimer.
- The SLEW TO dropdown.

## 4. Shared foundations

These land before, or alongside, the surfaces that need them.

| # | Foundation | What | Used by | Effort |
|---|---|---|---|---|
| F1 | **One clock** **[verified — with traps]** | **Definition:** the server's "now" is `setting('datagen.now')` (= `flags.generated_at`), the build instant — **not** the latest timestamp in the data. Wind runs to 23:00, in-progress drives store pings to 18:06 and the campaign ends 23:59:59, so a max()-based "end of data" leaves non-negotiable 5 broken. **Client:** "now" is the cursor, or the end of the data (`flags.generated_at`) when no cursor is set, and every data request sends it explicitly. One shared helper replaces the eight local "now" patches, including the report-window anchor, so the report window and the row ages use the same instant ("Last 14 d" stops listing "last 27d"). Stepping, playback and the scrubber stop at the end of the data. Remove the wall-clock default from the relative-time formatters, so the typecheck finds every caller that relied on it. Every cursor and window is written in local campaign time, not UTC — **confirmed bug:** the cursor is written with `toISOString()` (UTC, `Z`) and the server reads the digits as America/Chicago, so the server serves an hour 7 h away from the one on screen in a Pacific browser (5 h in Chicago itself). Write **naive** strings (no `Z`, no offset — `timeutil.parse` would convert an offset back to UTC). Replace every `toISOString()` window builder, not just the cursor (session.ts stepTime/timeRange, TimeCursor, useTimePlayback, SimControl, TimeSeries brush, components/lib/reports.ts, the regulator/industry/admin window helpers) through one shared helper; do hour arithmetic on the naive digits so a DST change cannot skip an hour. Saved sessions move to a new version and no longer store the time. **Server:** "now" is the end of the data, used both for "latest" and for stamping every write (new reports, acknowledgements, mitigations, regulator actions, scenario events). **Side effect (D1):** non-negotiable 5 (community fleet delay) then actually holds, so the strict expected-failure test at tests/test_non_negotiables.py:83 starts passing and fails the suite as designed. Remove its marker in the same commit. Rebuild data/air.db with the pinned `--now` to clear the 11 rows already stamped with the wall clock. | everything | M |
| F2 | **Events follow the clock** | Shared tests for an alert: has it started, is it still ongoing (started, and not ended by the moment shown), is it an open case, is it recent. Alerts are filtered in the browser (all 31 fit in one request; ongoing = started ≤ moment and not ended by it). **[corrected]** Reports and the feed cannot be: the server cuts them to the newest N *before* the browser sees them, so at Aug 12 the community feed's 40 items are all in the future and a browser filter leaves it empty. `/feed`, `/concerns` and `/stats/community` get an upper time bound applied before the LIMIT, and the feed's reading items are built as of that moment. Status as it was at the moment (acknowledged, resolved) cannot be rebuilt — only the final status is stored — so replay shows today's status on past events, and says so. A new relative-time formatter that refuses future times — and `relativeShort`, which drops the sign with `Math.abs` and turns a future start into "UP FOR 16d". Every map legend names its street window ("whole campaign" or "measured Aug 25"). | S1–S2, R5–R6, I4 | M |
| F3 | **One status per room** | Delete the regulator and industry header strips; the page carries the status. One alert count, shared by the page, the nav badge (on industry, scoped to the site) and the alert pages, so 9/4/3/5 becomes one number — **[verified]** through one hook (`useLiveAlerts(role)`) that counts active **and acknowledged** alerts. The rail badge has its own query today (AppShell.tsx:259-267, active only, no site filter), so deleting the header strips alone still leaves "9" beside "3". One severity vocabulary everywhere: Critical / Warning / Watch. The CAUTION/ADVISORY translation at Scope.tsx:142–146 goes. The retired headroom percentage leaves the UI. | I2, R1 | S |
| F4 | **Two panes, and a header that fits** | Every regulator and industry page is the main area (the map, where there is one) plus one side panel of 320–340px, with no third column. Pages stack only below ~960px. That value is written once in DESIGN.md as a literal number, because a CSS variable cannot be used inside a media query. At 960px and above, the page itself never scrolls. Side-panel content is rows that fit in 340px. A status band appears only on the overview; other pages get a one-line title. **Header:** the persona chip shows only the avatar below 1280, and loses its organisation line and ⌘K hint at every width; the regulator campaign name goes. SIMULATED DATA always shows its full words and never uses its compact variant. The industry nav rail widens from 56 to 68px and shows short words instead of codes: regulator Network · Alerts · Levels; industry Map · Alerts · Reports · Outreach · Evidence · Site. | I1, R1, R7, R9 | M |
| F5 | **Words out, look kept** | Stop printing `meta.narrative` (Landing.tsx:153, RoleSwitcher.tsx:59). Rewrite the role blurbs, the landing intro and Gallery.tsx:60, and delete ComingSoon.tsx. In CONTRACT §6, each room's metaphor becomes visual direction plus a "never in copy" list: tower defence, tripwire, armed, invader, suspected emitter, contact, scope, radar, RWR, MFD, slew, lock-on, flight deck, watchfloor, drafting table. The same words join the contract's never-say list, so generated text is covered too. §8b records that the RWR is retired and that its wind particles and permit contour move to the industry map. DESIGN.md's rule allowing sentences in capitals on industry narrows to labels and buttons. Rewrite the advisor's rules and prompt, then recheck its output against the never-say list. Glyphs, rings, palette and colour tokens stay. | R8, I3, I11 | S |
| F6 | **Plume outline style (CONTRACT §10b)** | Change the shared plume layer's default to: one outline around the whole plume, from where it starts to its reach; solid hairline up to the detection envelope, dashed beyond; the axis solid then dashed; the reach tick at the envelope, with "truncated" instead of a tick at 8,000 m; never filled. The server gains `GET /wind/dispersion?outline=1`, returning for each site the part inside the envelope, the part beyond it, and the axis. The default response stays byte-identical, with a test to prove it. The filed-study layer becomes dashed with no fill. This applies to regulator and industry only. **[verified — two gaps]** (1) The centreline axis with a reach tick that 10b requires exists nowhere yet; the payload has `wind_dir_deg` and `x_reach_m`, so it is buildable. (2) Both the filed study and "beyond measurement range" are dashed-no-fill under 10b, so with the filed study on they would differ only by colour. Give them different dash patterns plus a legend line. The layer (`DispersionLayer`, in `components/map/layers/WindLayer.ts`) is also used by the gallery, so the outline style is a prop, not a silent change of default. Community keeps its soft cloud, with no outline and no boundary words. | R2, I5, I7 | M |
| F7 | **One rule for naming a site** | A report, cluster or alert is linked to a named site only when **both** hold. (a) The wind at the time carried from the site to it: the report's `suspected_site_id`, or the point sat inside the site's modelled outline when the alert started. (b) The site's measured downwind test (`/touchdown`) for that pollutant is `elevated_downwind`, which means it passed the placebo check. Copy reads like "inside Riverport Intermodal's modelled plume · downwind excess passed the rotation check". Never "from", "caused by", "contacts" or "yours". Touchdown figures are printed only when elevated. | R5, I9 | S |

## 5. Order of work

Each phase ends with `cd web && npx tsc -b --force`, `npx oxlint src` and `uv run pytest` passing. You get before-and-after screenshots at 1080x900 and 1680x1050 to review, not a list of findings.

| Phase | Contents | What you'll see | Size |
|---|---|---|---|
| **1. Quick fixes** | C1 (zoom cutoff) · the narrative-chip removal from F5, plus deleting ComingSoon · C8 (main community button) · stop saving the cursor between sessions · regulator status word no longer overlaps (headline wraps instead) and the Analysis grid fix, both one-line stopgaps on pages rebuilt in phase 5 · alerts with no location show "site-wide" instead of 000° / 0 m, and leave the deck list | Plumes stay when zoomed out; no "TOWER DEFENCE"; the community button is whole; regulator headlines stop colliding; a reload opens at the end of the data | about a day, all S |
| **2. The clock** | F1, F2, S1–S5 | Start / Latest / Play in one popup; every screen shows the same moment; going back hides future alerts; nothing reads "in 26 d" | M + M + M |
| **3. Industry deck** | F3, F4 (industry and the header), F6, F7, I1–I11, and the F5 contract edits | The map is back and leads at 1080; one envelope line; no RWR; one alert count | about a week |
| **4. Community pass** | C2–C7, which can run alongside phase 3 | "Usually" shows the wind; the cloud stops where the claim stops; a shorter card and panel | mostly S |
| **5. Regulator Network** | R1–R9, built on F4, F6 and F7 | One map answering monitors → mobile → residents, plumes included; three nav items | L |
| **6. Backlog** | One line each: raise the smallest text size from 10 to 11px for regulator and industry, only after the label cuts · fix the persona-switcher cards clipped 5px at 1080 · delete RadarScope if admin and the gallery don't use it · time-filter acknowledgements and responses · per-day street windows on community and industry · move the remaining relative-time callers to the new formatter · if Analysis stays as a page (D6), make its "only" wording depend on which ratio is larger | none | S each |

## 6. Decisions for you

| # | Decision | Recommended default | If you choose otherwise |
|---|---|---|---|
| D1 | What "now" is once the data has ended | **Frozen at the end of the data.** Reports filed live are stamped at that instant and read "just now" on every screen. Accept that this makes non-negotiable 5 actually hold, so its expected-failure test is removed. | Letting "now" tick forward from the end of the data breaks #5 again after about 7 hours of server uptime, and empties the wind windows after about 9 hours |
| D2 | Does replay also rewind events? | **Yes.** Alerts, reports, the feed and community stats show only what had happened by the moment shown. Street colours stay whole-campaign everywhere except the regulator map. | Replay moves only wind, fleet and plumes, and pressing Start shows August's alerts on June 1 |
| D3 | What "Usually" draws on the community map | **One wind rose beside the scale, tied to no company** | A rose at the resident's home ("where your air comes from"); or a fan at each site, which reopens PLAN-plume Decision 10, because the default view would then point a shape from Ridgeline at Boxtown |
| D4 | The community cloud stops at measurement range | **Yes**, as CONTRACT §10b and the 4,200 m rule require. It reaches Boxtown only in stable hours; the "when reported" moment survives. | Keep the far field, which then needs a dashed outline and the contract's legend line on the resident's map |
| D5 | Community caveat copy | **One always-visible line** replaces the three bullets. This also fixes two never-say breaches: boundary words and "right now". | Keep the Phase 6 wording as it is |
| D6 | Regulator structure | **One Network screen.** Coverage and Analysis move into the monitor detail; nav is Network · Alerts · Levels. | Keep Analysis as its own page for the data-scientist persona |
| D7 | When a site may be named beside an alert or report | **Only when the wind at the time and the placebo-checked downwind test agree.** Otherwise no site is named, and "Suspected emitters" goes. | Allow model-only "inside the modelled plume" links, which break the contract's attribution rule (§10a.3) |
| D8 | The industry RWR | **Retire it**, and rewrite CONTRACT §6 and §8b in the same change | Keep a small compass in the detail panel: a second geometry that has to agree with the map |
| D9 | The filed study on the industry deck | **Off by default**, behind "Compare with filed study"; the verdict lives on /industry/site. The regulator map shows it by default, as the brief asks. | Show it on the Evidence and Site pages only |
| D10 | "Towers" as a word users see | **"Reference monitors"** in copy; the tower glyph stays on the map | Keep "towers" in copy |
| D11 | Days without driving on the timeline | **Show the real driven-day strip.** Three of the eight report clusters (Jun 27, Jul 21, Aug 17) fall on days with no driving, and that will be visible. | Hide the strip and show events only |
| D12 | The Landing hub label "Aclima · arbitrator" | **"Shared measurement"** | Keep "arbitrator", which implies Aclima rules on disputes |
| D13 | Should industry receive Aclima's mobile detections, such as the diesel finding on Ridgeline's own fenceline road? | **Defer to the Aclima review**, because it changes who learns what first | Send it now: it strengthens the mobile-network story on the deck |

## 6a. Owner decisions — 2026-09-23

| # | Decision | Effect |
|---|---|---|
| D1 | **Time is always constrained to the simulation's limits.** It freezes at the end and **pauses** — "Live" becomes **"Paused"**. | S3/S5 states become *Paused · end of data* / *Paused · <date>* / *Playing*. Playback stops and pauses at the end; nothing steps past it. Server "now" = `datagen.now` (F1). |
| D2 | Replay rewinds events too. | F2 as written, with the server-side upper bound. |
| D3 | One wind rose beside the scale, tied to no company. | C3 as written. |
| D4 | The community cloud stops at measurement range. | C2 as written. |
| D5 | One always-visible caveat line. | C4 as written. |
| D6 | One Network screen. | R1: Coverage and Analysis fold into the monitor detail. |
| D7 | A site is named only when the wind at the time and the placebo-checked downwind test agree. | F7 as written. |
| D8 | Retire the RWR. | I3, plus the CONTRACT §6/§8b and DESIGN.md edits in the same commit. |
| D9 | Filed study off by default on the industry deck. | I7 as written. |
| D10 | "Reference monitors" is the copy. | F5/R8: "towers" leaves every visible string; the glyph stays. |
| D11 | Show the real driven-day strip. Owner's note: real Aclima campaigns drive nearly 24/7. | S1 as written. **Backlog:** the generator's off-weeks (`OFF_WEEK_MODULO`/`OFF_WEEK_INDEX` in datagen/driveplan.py) and 1–4 cars/day leave gaps a real campaign would not have — a datagen change, and a rebuild, so not in this programme. |
| D12 | The Landing hub label is "Shared measurement". | Phase 1. |
| D13 | **Send Aclima's mobile detections to industry now.** | New **I12**: the deck's Downwind panel gains a "Found by Aclima's fleet" group — mobile-sourced alerts on or next to the site's own fenceline roads (e.g. the diesel finding on Paul R Lowry Road), worded as a measurement on a street, never as attribution (F7 still governs naming). Server: the industry alert list includes `source_type='mobile'` alerts within the site radius. |

## 7. Where this plan departs from the critics

- **Always-on header clock ("Aug 28 13:54 · day 90 of 90", cross-cutting critic):** not taken. At Latest the time never changes, and the 1080 header has no room. The date shows while replaying, and the campaign span is one click away.
- **Status line in the header (cross-cutting critic):** not taken. The header already clips at 1080, and the envelope line belongs on the deck it explains.
- **Industry header "limited by NO2 at Riverport Road, NE 6.3 km", with an alert-level word (cross-cutting critic):** not taken. The envelope is measured on Ridgeline's own fenceline road. Naming another operator's monitor as Ridgeline's limit is the attribution problem the industry review found. The shared severity vocabulary is taken (F3).
- **Filed study on by default in the §8b rewrite, plus a permanent "Study assumes…" line in the panel (cross-cutting critic):** not taken. You called "verify your consultant" a supporting visual, so it stays an opt-in comparison, as the industry critic proposed.
- **Network header printing "Jun 1 – Aug 28 · showing Aug 25 06:00" (regulator critic):** not taken. The chip and the popup show both on every screen, and a second clock on one screen is the kind of duplication this plan removes.
- **Fill reports when `suspected_site_id` matches (industry critic):** taken with a change. That field comes from the wind alone, so F7 adds the placebo-checked downwind test that the regulator critic requires, giving one linking rule in every room.
- **"Road colours: all 90 days" in the popup (simulation-control critic):** moved to each map's legend title, because the regulator map switches to the day's streets.
- **Per-day street windows only as a later option (simulation-control critic):** overruled for the regulator map only, following the regulator critic. There, an hourly plume drawn over a 90-day street grid reads as confirmation.

## Phase 2 contract — the one clock (as built, 2026-09-23)

The core is in place; everything else in phase 2 builds on these rules.

**Time is naive campaign time.** `YYYY-MM-DDTHH:MM:SS`, no `Z`, no offset,
America/Chicago digits, exactly what datagen writes. The browser parses a naive
string as local and prints it with local getters, so digits round-trip in any
zone ("floating" time).
- Client: build with `toCampaign(date)` / `addHours(t, h)` / `floorTo(t, min)`,
  read with `parseCampaign(t)`, compare with `campaignMs(t)`
  (`web/src/core/clock.ts`). **Never** `toISOString()` for a campaign time.
- Server: `timeutil.iso()` writes naive; `timeutil.parse()` drops a `Z`/offset
  instead of converting it.

**"Now" is the build instant, frozen.** Server: `timeutil.now()` =
`setting('datagen.now')`, and `domain.data_now()` returns it. Client: the
session's `time.cursor` is a naive time, or `null` meaning **paused at the end
of the data** (D1). `nowCampaign(time)` / `useNowCampaign()` / `resolveNow` /
`useDemoClock` read cursor ?? `time.bounds.end`. Never `Date.now()` / `new
Date()` for "now". Sending no `at` means "the end", and the server agrees.

**Bounds.** `time.bounds = { start: campaign.start_date T00:00, end:
flags.generated_at }`, loaded once by the shell (`useClockBounds`). The cursor
is clamped into them; at or past the end it becomes `null`. Playback runs 1 h,
6 h or 1 day per real second (`PLAYBACK_SPEEDS`), writes the cursor at most 4×/s
on a 10-min grid, restarts from the start when played from the end, and stops
and pauses at the end.

**Events follow the clock (D2).** `web/src/core/events.ts`:
`hasStarted(e, now)`, `isOngoing(e, now)` (the definition of "live" — begun
and not ended), `isOpenCase`, `isRecent`, `happenedBy(list, now)`. The
server filters `/feed`, `/concerns`, `/clusters`, `/stats/community`
and `/alerts` by `at` **before** its LIMIT (a browser filter after the LIMIT
empties the list).

**Formatters.** `relativeTime(t, now)`, `relativeShort(t, now)` and
`fmtElapsed(since, until)` require their `now`. A future time is never printed
as "in 2 d" or as a past duration.

**Queries keyed on the clock** keep the previous data on screen while the next
step loads (`TIMED` in core/queries.ts) — only those, not globally.

Fixed on the way: non-negotiable 5 now holds, and its strict xfail is removed.

## 8. What the re-check changed

Ten claims that decide what gets built were each handed to an agent told to refute them, with code, API or database evidence required.

| Claim | Verdict | Effect on the plan |
|---|---|---|
| Time cursor written as UTC, read as Chicago time | **confirmed** | F1 now specifies naive strings, every window builder, DST-safe arithmetic, and a session-version bump (saved cursors already hold `Z` values) |
| Industry map gets no area at 1080 | **confirmed** (map panel 1000x2, Margin card painted over it) | I1 gains the scrolling panel and the wrapper; the same bug is flagged in two other grids |
| Community cloud filled past the envelope | **confirmed, worse** (1.5 km envelope outside stable hours) | C2 rewritten |
| Removing the zoom cutoff is safe | **confirmed** | C1 gains the MapScreen.tsx:275 trap |
| Delta Forge figures printed despite failing | **confirmed, different place** (industry Evidence, not regulator) | R5/Evidence gating is per state; "over homes" goes |
| Riverport "7 of 9 hours inside the plume" | **contested** — 7 of 9 by `/wind/dispersion` polygons, 1 of 5 by the coverage cone masks | Not a wording fix: the product's two plume computations disagree about one monitor. New R0 reconciles them before any regulator headline is written. `alert.site_id` (a generator bearing rule) must not be used as either |
| Frozen "now" fixes non-negotiable 5 | **partly** — only if "now" = the build instant | F1 definition fixed; otherwise removing the xfail turns the suite red |
| Replay shows future events | **confirmed** (50 future stamps on the feed at Aug 12) | F2 moves reports/feed filtering to the server, before the LIMIT |
| Inconsistent alert counts | **confirmed, exactly** (9/4/3/5; 13 vs 15) | F3 names the rail badge's separate query and one shared hook |
| Industry plume/permit registers | **confirmed** (permit fill is faint, 0.05) | F6 gains the axis + reach tick and a second channel to tell the filed study from "beyond range" |

One note that applies everywhere: **the deployed demo is built without `--now`**, so its numbers — and Riverport's borderline `elevated_downwind` state — can differ from local. Every sentence above that depends on a number is generated at runtime and branches on state.
