# Community room — critique and contrast (2026-10-08)

The resume point for the community-room work that followed the refocus
(docs/PLAN-refocus.md). The owner asked for a critique of the community page
before saying their own view; the critique below was agreed in full ("Yes to
your observations and ideas"), and the owner added the contrast feature.

## Owner decisions

| # | Decision | Owner's words |
|---|---|---|
| C1 | The community map shows **real concentrations** (ppb, µg/m³), not the 0–100 score. Plain names stay ("traffic and engine fumes"). | "Concentrations on map + key" |
| C2 | **EPA and WHO are named** on the key. A narrow, recorded exception to the fictional-actors rule: published reference values quoted as numbers. Every advisory, alert and finding is still issued by the invented agency (DRAQA). | "Name EPA and WHO" |
| C3 | **Annual limits only**: a street's colour is a median over weeks of passes, a long-term average. Pollutants with no annual limit (ozone, CO, black carbon, the index) get no line, and the key says so. | "Annual only" |
| C4 | **Stretch to view is on by default**, community map first; the regulator and industry maps follow later. | "On by default, community first" |

## The contrast feature (built)

The owner: "Aclima's data is subtle concentrations … a normalization option that
normalizes the data in the current map viewport to the color ramp … supported
with a large vertical color ramp key that actively shows the current range of
concentrations shown, EPA, WHO limits marked as waterlines on it."

- `components/lib/viewRange.ts` — the streets IN VIEW (a vertex inside the
  camera's bounds, ≥ 8 passes) give the domain: 2nd–98th percentile, so one
  hot block cannot compress the rest. **Guard:** never narrower than a quarter
  of the whole area's range. Zoomed onto one block, 21 streets read
  8.1–9.4 µg/m³ and the whole ramp was spent on 1.3 µg/m³; the range now
  widens evenly around its middle, and the key prints the widened ends.
- `--ramp-contrast-*` (tokens.css) — teal → blue → violet → plum. No green
  ("clean") and no red ("danger"): a stretched colour is "high for this view",
  never a health level. The waterlines carry the health meaning.
- `components/lib/limits.ts` — WHO 2021 guidelines and EPA NAAQS, annual:
  NO2 5.3 ppb (10 µg/m³) and 53 ppb; PM2.5 5 and 9 µg/m³.
- `components/map/furniture/RampKey.tsx` — the tall key. Its ends are the
  current range in real units and re-label on every pan and zoom; a limit
  inside the range is a line across the bar; a limit outside it is listed
  above (↑ "above every street shown") or below (↓ "every street shown is
  above it") — never dropped, because stretching a clean area is exactly when
  the reader most needs to see the guideline is far away. **Slim** (owner:
  "the text in the concentration key makes it much wider than it should be"):
  on the map only the switch, the bar, its ends and short line labels
  ("EPA 9.0", "↓ WHO 5.0") — ~150 px; everything explanatory (what stretched
  colours mean, how many streets are in view, each limit's full name and
  source) is behind an ⓘ popover portalled to `<body>`.
- Community map: `metric: 'median'`, the contrast ramp, the key in place of
  the score legend, the switch "Stretch colours to what's in view". The street
  card shows the street's typical reading in its unit and where it sits
  against the limits, worded as a comparison (a median of daytime passes is
  not the annual mean the limits are written for). On a phone the pollutant
  picker moves above the map so the key fits in its corner.

Measured: NO2 over the whole area 8.5–23.4 ppb (EPA 53 above, WHO 5.3 below);
PM2.5 7.5–16.8 µg/m³ with the EPA 9.0 line inside the bar.

## The critique — agreed, to do

In order of what to do first:

1. **Cut the hedging to one place.** "Only the agency can close a report" is in
   ~10 places (4 on one report page); every operator card carries three
   disclaimers; "Simulated data" appears three times per page. Keep one short
   "how this works" link and one quiet status line per report.
2. **The map as the hero.** Full height, opening on her neighbourhood (not the
   river), the pin filters stripped back. Phone layout (the key is done).
3. **Identity.** Her own reports read as "you", not "Yolanda Bridges · 3.0 mi
   away"; the header persona matches the greeting; "Closest to you" is not
   2–3 weeks old.
4. **Dashboard:** merge into the Feed, or give it a real trend over time (it is
   titled "trending" and has none); remove the repeats (score dial, "what we
   measure", "highest-scoring streets").
5. **One time frame per card**, and say which. "Highest-scoring streets right
   now" are three-month scores; Status lists an older "in force" notice above
   newer "earlier" ones.
6. **Leftovers:** "Above the agency's line"; a reference monitor shown as a
   0–100 score; kilometres beside miles; the report form preselects Smell +
   Strong, and its two worst severities have the palest bars.
7. **Visual bugs:** score-dial labels run into the arc; the phone header
   (badge over the Report button; Dashboard and persona off-screen); Outreach
   blank for ~4 s with no loading state; Status/Outreach/report pages light
   "Feed" in the nav.
8. **Purpose:** noise/vibration/light reports (39 of 204) never connect to air
   data; the car call-sign rail gives a resident little.
