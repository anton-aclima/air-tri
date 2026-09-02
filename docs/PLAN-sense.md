# Measure selection & Aclima Sense — working plan

**Status: Goal 1 code complete. Goal 2 shipping end-to-end — the composite is built,
served, typed, painted and legended in all four apps. Remaining work is honesty copy and
a handful of secondary surfaces (see the boxes).**
Last updated: 2026-09-01

> ### What the build measured, and where it contradicted the design
>
> Four of the locked design's claims were inherited from the proposal agents and turned out
> to be **wrong when measured against the real data**. Each is corrected in place below and
> flagged with ⚠️. The largest: *the index does not commute with the median* — the claim that
> justified computing it per pass. It still should be computed per pass, but for a different
> reason, and the number it produces is ~7 points higher than the design predicted.

This file is the resume point. If a session dies, read this and continue from the first
unchecked box. Update the boxes *as you go*, not at the end.

---

## The two goals

1. **Industry can choose a measure on the map.** The MFD road grid, the reference/fenceline
   instruments and the readout panel all filter to whatever the operator picked. Every other
   app already has this; industry was the one that shipped without it.
2. **`aclima_sense` — a composite pseudo-measure, in all four apps.** One 0–100 number that
   says how bad the air is for a human, built from the measures that actually have a health
   pathway.

Goal 1 is self-contained and ships first. Goal 2 depends on nothing in Goal 1 except that the
industry picker exists to display it in.

---

## Design decision (locked — do not re-litigate)

A 13-agent workflow surveyed the codebase (6 agents), then three independent designers
proposed a composite from different priors. The judge and plan phases died on a session
limit; the verdict below is mine, taken from the three proposals and the domain survey. All
of that raw material is preserved — see *Provenance* at the bottom.

### The formula

```
ER    = expm1(0.000871 · NO2[ppb]) + expm1(0.000537 · O3[ppb]) + expm1(0.000487 · PM2.5[µg/m³])
sense = clip(961.538 · ER, 0, 100)          # 961.538 = 10 × (1000/10.4)
```

Computed **per pass**, then aggregated by the existing `emit()` machinery. `100` = Health
Canada AQHI 10.

This is Canada's AQHI (Stieb et al. 2008), rescaled ×10 onto this product's 0–100 domain.

### Why this and not the obvious alternatives

**Why only NO2 + PM2.5 + O3.** All three designers converged here independently. The other
seven measures are excluded for reasons that are arithmetic, not editorial:

| measure | why weight 0 |
|---|---|
| `methane_leak` | `field.py:529` makes it `max(0, ch4 − 1.928)`. Measured r with `ch4` = **1.000**. Including both counts one variable twice. |
| `nondiesel` | `field.py:528` makes it `max(0.25, pm25 − diesel)`, so `diesel + nondiesel` reconstructs `pm25` exactly (mean abs error 0.22 µg/m³, from the clamp alone). |
| `diesel` | `field.py:525` derives it from `bc` and `no2` (r = 0.93, 0.91). Carries no information those two don't. |
| `bc` | A mass component of PM2.5 (4.4% of mass at the median here). WHO's 2012 black carbon report **explicitly declined to set a guideline**; no NAAQS, no AQI sub-index. Its ladder is unanchored. |
| `co` | Segment medians 0.204/0.237/0.313 ppm = 2–3% of the 9 ppm NAAQS. EPA's own CO ISA finds no ambient effects. r(co, no2) = 0.85 — it restates NO2. |
| `co2` | No ambient health pathway at 419–560 ppm. `measures.py:127` already says so verbatim: *"Not a local health pollutant."* |
| `ch4` | 2 ppm is 0.004% of the lower explosive limit. Its relevance is climate, co-emitted VOCs, and explosion at percent levels — none of them street-level exposure. |

Under a naive max over all seven modalities, `co2` and `ch4` are each the *dominant*
pollutant on ~1% of segments. Those residents would be told their air is unhealthy because
of gases that are not harming them. That is the outcome this exclusion list exists to
prevent.

**Why additive and not max-of-sub-indices** (which is what EPA AQI, EU CAQI/EAQI and UK DAQI
all do):

- This repo's `SCALES` ladders are **not mutually calibrated.** At real regulatory anchors,
  `risk_from_scale` returns CO **92** at its NAAQS, O3 **59** at its NAAQS, PM2.5 **25** at
  the annual NAAQS. A max over those is decided by ladder steepness, not by air quality.
  EPA's max is legal only because every sub-index is defined so 100 = that pollutant's
  short-term standard. We don't have that property.
- **A max composite is a restatement of PM2.5 and adds nothing.** Measured: max over five
  health modalities gives p10–p90 = 21–33 with **r(pm25) = 0.90**; `pm25` alone gives 21–32.
  The AQHI form gives **r(pm25) = 0.36** — it actually exploits the street-level NO2
  gradient, which is the one thing a mobile fleet resolves better than any fixed network.
  That gradient is this product's entire premise.
- Max inflates with input count for free (measured: peak 52 → 58 going from 3 inputs to 5),
  so it isn't comparable to any other index or to a future version of itself.
- Additive **decomposes exactly**, so "what's driving this street" is a contribution share
  across all three terms. A max can only name one winner and discards the rest.

The one honest thing max has going for it — a published table a regulator can recompute by
hand — the AQHI also has, with a citation.

**Why per-pass and not aggregate-then-combine.**

> ⚠️ **CORRECTED — the original justification was false.** The design claimed the additive
> form "commutes with the median to within ~1 index point". **It does not.** The build-time
> assert caught it immediately: measured across all 1,307 segments, the median of the
> per-pass index is **27.4** while the index evaluated at each pollutant's median is **20.4**
> — a systematic 7-point gap, up to **17.6** on the worst street.
>
> The reason is not the curvature of `expm1` (that really is under 1% here, as claimed). It
> is that **a median is not additive**. NO2 and O3 are anti-correlated at the curb
> (r = −0.62, from `O3_TITRATION`), so a pass with high NO2 has low O3 and vice versa — most
> passes are elevated in *something*, while each pollutant's own median is mid. The sum of
> the medians is a combination no drive-by ever exhibited. This is the same objection the
> design already raised against computing p90 from marginal p90s; it applies to the median
> too, just less violently.
>
> The proposals almost certainly computed the index-of-medians and reported it as the
> per-pass figure — which is why their predicted distribution (18–25) is exactly the
> index-of-medians distribution measured here.

Per-pass is still right, but on its own merits rather than on a commutation argument:

- It is the honest median of a quantity that actually existed on each pass. The
  index-of-medians is one honest number plus three fictional ones — `p10`, `p90` and `max`
  of a combination that never occurred — and **no `persistence` at all**, which is the
  channel this design leans on for street-to-street contrast.
- There is no selection bias to worry about. That was a *max*-specific problem: the max of N
  noisy draws is pulled upward on every pass. A sum is just a sum.

The cost, which must be stated wherever the number appears: **this is not the AQHI of this
street.** The coefficients were fitted on 3-hour averages; this applies them to instantaneous
curbside air, which reads higher.

> ⚠️ The build-time assert (**D6**) was replaced accordingly. It no longer checks commutation
> — that would now fail correctly-built data. It checks that each term stays **near-linear**
> at the campaign's p99 concentrations, which is the property that would actually break if
> someone swapped in a max or a convex transform and reintroduced selection bias.

**Why we do NOT compute p90 from the inputs' p90s.** NO2's p90 pass and O3's p90 pass are
different passes, and here they are anti-correlated (`O3_TITRATION = 1.90`, r = −0.62), so
they never co-occur. Evaluating the formula at each input's marginal p10/p50/p90 gives
11.8/20.7/33.3 against the true joint 18/20/25 — roughly **triples** the apparent
street-to-street spread out of nothing.

### The `measure_def` row

| field | value | why it's load-bearing |
|---|---|---|
| `code` | `aclima_sense` | |
| `label` | `Aclima Sense` | |
| `short_label` | `Sense` | 12-char codes overrun the RWR chips and a deck.gl TextLayer CSS can't rescue |
| `plain_name` | `the overall health score` | |
| `unit` | `''` (empty, NOT NULL) | Unit suppression is decided by **role** and **metric**, never by measure. Eight sites concatenate `def.unit` unconditionally. `'index'` would print "20 index" in three skins. |
| `family` | `composite` | requires widening the CHECK — see D2 |
| `scale_json` | `[[0,0],[100,100]]` | **identity, load-bearing.** `formatValue` forces `asRisk` for community and re-runs `riskFromValue`; `domain.py:142` re-derives risk when `segment_stat.risk` is NULL. Identity makes all of them no-ops and keeps `risk == median`. |
| `decimals` | `0` | `formatValue` falls back to `?? 1` and would print "20.4" everywhere |
| `ref_level` | **`30`** ⚠️ *was 20* | index points, **not** a concentration. 20 was read off the index-of-medians distribution, which is not what ships — against the per-pass distribution nearly every pass exceeds 20 and the width channel goes flat. 30 = AQHI 3 = top of Health Canada's **Low** band, the one externally anchored boundary on this scale, and it happens to split this campaign near the middle: measured `persistence` p10/p50/p90 = **0.33 / 0.42 / 0.55**. |
| `healthy_max` | `30` | AQHI Low/Moderate boundary — externally anchored. Same number as `ref_level`; they mean different things and land on the same published line. |
| `sort_order` | `0` | leads every picker |
| `ramp_json` | `RAMP_AQI` | documentation only; nothing in the frontend reads `MeasureDef.ramp` |

### Render rules

- **Ramp `'map'`, continuous mode, never quantized.** `'map'` aliases to `--ramp-aqi-*` under
  `[data-role='community']` and `--ramp-intensity-*` under the other three. That skin split is
  the house rule every other measure gets: residents read colour as public health, analysts
  read it as magnitude. Quantized is banned because aqi has 7 stops and map has 8 — a
  quantized composite lands one band off in three of the four skins.
- **Domain pinned `[0,100]` at every call site, for every metric.** Never `segmentDomain()`,
  never `robustDomain()`. The index's p10–p90 on this data is 18–25; a p2–p98 auto-stretch
  would repaint a 7-point spread as full-scale red. That is the single most dishonest thing
  this codebase could do with this number.
- **No action level in v1.** Every `_ACTION_LEVELS` entry cites a real authority ("EPA NAAQS
  1-hr"). There is none for this index. Consequences, all correct: no alerts, no advisories,
  no `exceeds` flag, and the composite can never drive industry's worst-vs-limit gauge.

### Deliberate non-decisions

- **Cold-start measure stays `no2`.** Sense sorts first in every picker, but it is not the
  landing lens. ⚠️ *Measured, not predicted:* segment medians run **p10/p50/p90 = 24.6 / 27.4
  / 32.0, min 21.3, max 43.8** — so the whole city still sits inside AQHI "Low"/"Moderate" and
  a pinned-domain Sense map is nearly monochrome, as the design expected, just 7 points higher
  than it predicted. That is the *correct* rendering of flat air, but a poor first frame for a
  demo whose flagship visual is a coloured road grid. Sense is offered as a lens, its flatness
  is stated in the legend, and contrast is carried by `persistence` (width) and by `p90`.
- ⚠️ **The NO2-gradient advantage is smaller than the design claimed.** `r(sense, pm25)` is
  **0.575** for the per-pass index that ships — not the 0.36 the proposals quoted, which is
  again the index-of-medians figure. Per-pass Sense is meaningfully more PM2.5-like. It still
  beats a max composite (r = 0.90) by a wide margin, so the argument for the additive form
  holds; it is just not as decisive as written.
- ⚠️ **Per-pass contribution shares are NO2 37% / O3 45% / PM2.5 19%** — ozone leads, because
  it spikes on exactly the passes where NO2 does not. The design quoted 48/31/20, which is the
  share computed on segment medians. This *strengthens* the ozone caveat (**H7**): the largest
  single term in the index is the pollutant a mobile platform measures worst.
- **The plume does not follow the picker.** `dispersion_model` rows exist for **bc, no2, pm25
  only** (verified against `data/air.db`). Blindly passing the session measure would blank the
  plume for o3/co/co2/ch4 and the three indicators. The plume stays pinned and the MFD legend
  names its species. See I5.

---

## Task list

Status key: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked/deferred

### Goal 1 — Industry measure picker

- [x] **I1** `Scope.tsx` — mount state. Added `useMeasures()`, `useSession(x => x.setMeasure)`,
      `makeColorScale`, `shortName`/`unitFor`, `MeasureCode`.
      **Changed from plan: `useMeasures()` with no family filter, not `useMeasures('modality')`.**
      The other three apps show modalities only. Industry gets all ten, because the indicators
      are derived source apportionment — diesel vs non-diesel combustion, methane excess over
      background — and an operator who runs trucks and a gas line is the one reader for whom
      those are the interesting lenses rather than analyst furniture.
- [x] **I2** `Scope.tsx` — the control. A second `<label className={s.sourcePick}>` reading
      `CHANNEL`, beside `SLEW TO`, wrapped in a new `.mfdPicks` flex row
      (`industry.module.css`) that wraps rather than overflows — measure names are long enough
      to push `SLEW TO` off a narrow MFD, and the map underneath is worth more than one line.
      Native `<select>` with `s.sourceSelect`, not the shared `MeasurePicker`: `MeasurePicker`
      renders `furniture.module.css`'s `.select`, which does not carry the MFD's phosphor.
- [x] **I3** `Scope.tsx` — the road grid. `useSegments` inherits the session measure, so the
      picker drives it for free. **Reversed from plan: the metric stays `'median'`, i.e.
      concentrations, not `'risk'`.** The user asked for "road segment concentrations… filtered
      for that modality", and the industry skin paints `--ramp-intensity-*`, which the token
      file calls *analytical magnitude*. Risk is the resident's framing. Left alone.
- [x] **I4** `Scope.tsx` — the paint. `SegmentLayer` now receives `measure` and a `scale`.
      The scale is the default auto-domain for concentrations (right: ppb, µg/m³ and ppm share
      no scale) and a pinned `[0,100]` + ramp `'map'` when the measure is an index.
      **The index test is `measureDef?.unit === ''`, not `family === 'composite'`** — it is
      true of exactly the same rows, needs no type change to land, and reads as what it means.
- [x] **I5** `Scope.tsx` — the instruments. Both `MonitorLayer` calls now take `measure`, so
      the dots alarm on the picked channel only. For an index they take `undefined`: no
      instrument carries one, so `latest[code]` is undefined on every monitor and every dot
      would drop silently to un-alarmed. `undefined` restores the any-channel fallback.
- [x] **I6** `Selected.tsx` — the readout. The segment branch follows the active measure for
      free. The monitor branch now marks the active channel (`NO2 ◂`) and states plainly when
      an instrument has no such channel — *"Nothing here confirms or denies what the streets
      are showing you."* A tower that cannot see the channel and a tower that sees it and is
      quiet looked identical before.
- [x] **I7** `Scope.tsx` — the legend. `mapKey` gains a `streets — <measure>` line naming the
      channel and whether colour is stretched-to-view or a fixed 0–100. The plume line names
      its species when it differs from the picked channel: an unlabelled cone beside a channel
      selector reads as the selector's output.
- [x] **I-extra** `SegmentLayer.ts` — added a `measure` prop, drawn from for nothing except the
      `updateTriggers` join. Two measures can share a domain, a ramp and a metric (any two
      unitless 0-100 scores do), and without the code in the join deck keeps the previous
      measure's cached colours. This was task **W6**, pulled forward because it would otherwise
      present as "the picker does nothing".
- [~] **I8** Verify. `tsc --noEmit` clean; every Python module imports; all eleven measures
      return real data from `GET /api/v1/segments`. **Not verified in a browser.** Two
      headless attempts failed for environmental reasons (see the note below) and I did not
      get a rendered DOM. Both servers are up — API on :8000, vite on :5173 — so the picker,
      the legend line and the composite's paint still need a human eye on
      <http://127.0.0.1:5173/industry>.

### Goal 2 — datagen (`aclima_sense` exists in the data)

- [x] **D1** `measures.py` — add a module-level `_COMPOSITES` tuple and fold it into
      `measure_rows()` **first** (sort_order 0). **Do not append to `_MEASURES`**:
      `MODALITIES`/`INDICATORS` filter that list by family and `simulate.py:54` splices both
      into the `segment_pass` column tuple — the build dies at `simulate.py:80` on
      `MOBILE_NOISE[m]`.
- [x] **D2** `measures.py:~229` — fold `_COMPOSITES` into the `SCALES`/`REF_LEVELS`/`UNITS`/
      `DECIMALS` comprehensions. `stats.py:90` and `:120` index these with no fallback.
- [x] **D3** `measures.py:~215` — `ramp_json` branches on `family == 'modality'`; add
      `composite → RAMP_AQI`.
- [x] **D4** `schema.sql:42` — widen `CHECK (family IN ('modality','indicator'))` to admit
      `'composite'`. This is the only schema change and it is the cheapest correct one: it keeps
      the code out of `MODALITIES`/`INDICATORS` automatically and gives all four interfaces one
      field to branch on.
- [x] **D5** `stats.py` — five edits, no new grouping pass:
      - `:26` add `SENSE`, `SENSE_BETA`, `SENSE_K = 961.538…`, `STAT_ORDER = ORDER + [SENSE]`.
        **Keep `ORDER` at 10** — it is the `segment_pass` column contract.
      - `:70` widen the matrix to `np.full((n, len(ORDER)+1), np.nan)`. `vcols` at `:73` still
        iterates `ORDER`, so the fill loop at `:74–88` is untouched.
      - `:89` after the fill loop, before `ref`: three `np.expm1` over three columns, sum,
        scale, clip; NaN wherever any of the three is NaN; write `vals[:, -1]`.
      - `:90` `ref = np.array([REF_LEVELS[m] for m in STAT_ORDER])`.
      - `:110` `enumerate(STAT_ORDER)`. Nothing else in `emit()` changes — counts / nanmean /
        nanpercentile / nanmax / persistence at `:102–108` are already columnwise.
      - `:152` **`campaign_summary` must keep iterating `ORDER`** — `col = ci[m]` is a
        `segment_pass` lookup and would KeyError.
- [x] **D6** `stats.py` — build-time asserts. **(a) ⚠️ changed:** the commutation assert was
      written, fired at 13.5 index points on the first build, and was then *replaced* — the
      invariant it encoded is false (see the corrected section above). What ships is
      `_assert_sense_near_linear`: each term must stay within 15% of linear at the campaign's
      p99 concentration, which is the property that actually guards against reintroducing
      max-style selection bias. **(b) done as written:** units asserted at import time —
      the coefficients are per-ppb and per-µg/m³, so a future unit edit would otherwise change
      the index by orders of magnitude with no error.
- [x] **D7** Missing-component rule: if any of the three is NULL on a pass, `sense = NaN` and
      the pass drops. **Do not renormalise** — each term is an absolute excess risk, not a
      share. `MEASURE_DROP_RATE = 0.0035` costs `1 − 0.9965³` = 1.05% of passes.
- [x] **D8** ⚠️ **Reversed after measuring.** Stricter floors (8/4/6) were implemented, then
      removed. The inheritance they guarded against is worth ~**1%** — `MEASURE_DROP_RATE`
      invalidates each channel independently, so 98.95% of passes carry all three — while the
      floors cost **53%**: only 618 of 1,307 segments kept any `date:` row, against 1,307 for
      every real measure, so the daily series on segment detail was empty on more than half the
      streets. With the shared floors the composite has parity: **17,956 `date:` rows vs no2's
      18,138**, exactly the predicted 1% gap, and 1,256 of 1,307 segments carry a daily series.
- [x] **D9** `_smoketest_seed.py:144` — the second, independent measure registry. Without the
      row the smoketest DB has never heard of the code.
- [x] **D10** `datagen/README.md:222` — the "Extending" section says a new measure costs "a row
      in measures.py, a term in field._compose, a column in simulate.MOBILE_NOISE, and the
      schema column". A composite is the first measure that does **none** of those four.
- [x] **D11** Rebuild and verify. `PRAGMA foreign_keys = OFF` during builds (`db.py:84`), so a
      typo'd code inserts cleanly, orphans, and surfaces only as a blank map with no error.
      **Check `SELECT count(*) FROM segment_stat WHERE measure='aclima_sense'` — expect 1307 at
      `window='all'`.** Do not trust the map.

### Goal 2 — backend

- [x] **B1** `routers/stats.py:84` — skip `family == 'composite'` in the `by_measure` loop.
      Without this the composite lands in `by_measure`, wins the `max()` at `:104` **by
      construction**, becomes `worst_measure` at `:109`, and silently reroutes `worst_streets`,
      `best_streets` and the `passes_total` fallback onto itself.
- [x] **B2** `routers/stats.py:104` — set `overall_risk` from the composite's length-weighted
      risk. `/stats/community` already types the field for exactly this (`types.ts:599`:
      *"0-100 headline. Never show a unit next to this"*) and `RiskDial` already renders it on
      the aqi ramp. Today's value is an undefended max over incommensurable ladders — this
      fixes an existing defect. `worst_measure` stays over the seven modalities (that's the AQI
      convention of naming the responsible pollutant, and it's right).
- [x] **B3** `sim.py:85` — add an `aclima_sense` entry to `MEASURE_FALLBACK`. It is subscripted
      directly at `:152` and `:344` — an unlisted code raises KeyError.
- [x] **B4** `advisor_rules.py:15` — add a `MEASURE_LEVERS` entry, or the rules engine falls
      back to the generic "this is a combustion tracer" (degraded, not broken).
- [ ] **B5** `routers/regulator.py:84`/`:125` — reject a composite measure on action-level
      writes with 422 rather than letting the FK IntegrityError become a 500 at `app.py:91`.

> **Headless verification note.** `chrome --headless=new --disable-gpu --dump-dom` renders the
> industry route as the error boundary: *"Cannot read properties of undefined (reading
> 'getProjection')"*. That is MapLibre failing to get a WebGL context under `--disable-gpu`,
> not a regression — nothing in this diff is on a path that reaches `getProjection`. Retry
> without `--disable-gpu`. Note also that `--dump-dom` only writes when the virtual-time budget
> expires, and the app holds an SSE stream open, so the process can outlive the budget; let it
> run and read the file rather than killing it early.

### Goal 2 — web core & components

- [x] **W1** `types.ts:13` — add `export type CompositeCode = 'aclima_sense'` and widen
      `MeasureCode`. Widen `MeasureDef.family` (`:107`) to include `'composite'`.
      **The resulting cascade is the point** — it makes `measuresOf` (`measures.ts:404`),
      `useMeasures` (`queries.ts:249`) and the five `useMeasures('modality')` call sites
      compile-error, forcing an explicit per-interface decision instead of silently admitting
      the composite everywhere.
- [ ] **W2** `types.ts:176–185` — `SegmentDetail.stats`/`daily`/`diurnal`/`rank_pct` are total
      `Record<MeasureCode, …>`. If the backend doesn't emit the key for every segment these must
      become `Partial<>`, or `regulator/Analysis.tsx:229` hands `undefined` to a chart while
      TypeScript says it can't happen.
- [ ] **W3** `measures.ts:388` — add a measure-level `measureIsUnitless(def)` companion to
      `metricIsUnitless(metric)`; consume it in `unitFor` (`:309`), `formatValue` (`:330–346`),
      `formatMetric` (`:375–385`) and `MapLegend.tsx:61`.
- [x] **W4** `tokens.css:129` — add `--mod-aclima_sense` after `--mod-ch4`, **and** register
      `'mod-aclima_sense'` in the hardcoded `TOKENS` allowlist at `theme.ts:33`. Both, or
      `modalityVar()` works in inline styles while `theme.css()` silently returns `''` — two
      independent token readers, two different failure modes.
      ⚠️ `--actor-aclima #00D3A7` is the house colour and the obvious pick, but it sits near
      `--mod-o3 #7ED957` under deuteranopia — and the composite's most natural chart plots it
      against its own three constituents. Give it an explicit `color` and a heavier stroke on
      TimeSeries; never rely on hue alone.
- [x] **W5** Added `measureDomain(measure, data)` to `SegmentLayer.ts` (exported from
      `@/components`): pinned `[0,100]` when the measure has no unit, the robust p2–p98 stretch
      otherwise. Concentrations *should* stretch — ppb, µg/m³ and ppm share no scale — and an
      index must not.
      ⚠️ **The survey's "seven call sites" was wrong.** Five of the seven
      (`admin/Fleet`, `admin/Campaign` ×2, `admin/Oversight`, `admin/DrivePlan`) paint
      `metric: 'persistence'`, whose value is a 0–1 share independent of which measure is
      selected — the composite changes nothing there. The real surface is three:
      `admin/Overview` (paints the session metric), `industry/Scope` (done in Goal 1), and
      `regulator/MapScreen`, which rolls its own `robustDomain` and now short-circuits to
      `[0,100]` for a composite. `community/MapScreen` already pinned.
- [x] **W6** `SegmentLayer.ts` — measure code added to the `updateTriggers` join. Done early
      as part of Goal 1; see **I-extra**.
- [x] **W-extra** `measuresOf` / `useMeasures` now accept a **list** of families, and
      `PICKABLE = ['composite','modality']` names the distinction that did not exist before:
      *"lenses a reader may choose"* versus *"species an instrument can carry"*. Those looked
      identical until the composite existed. ⚠️ **The predicted type cascade did not happen** —
      widening `MeasureDef.family` compiles silently, because `m.family === 'modality'` is
      still a legal comparison. So nothing forced a decision; each of the five
      `useMeasures('modality')` call sites had to be visited by hand. Community and regulator
      map pickers now pass `PICKABLE`; `community/Status.tsx` deliberately keeps `'modality'`
      and carries a comment saying why.
- [x] **W7** `MapLegend.tsx:57` — `fixedDomain` special-cases `persistence` and `risk` only. Add
      the composite for **all** metrics, or the legend prints "19 to 23" on a scale defined 0–100.
      `:61` add it to the `unitless` test. `:71` `decimals = 0` already routes `fmt` to whole
      numbers with no edit.
- [ ] **W8** `queries.ts:413` — `useMonitorReadings` defaults `measure` to the session measure.
      Guard it (`enabled: false`, or fall back to the monitor's first channel) so selecting the
      composite doesn't fire per-monitor requests for a channel no instrument carries.
- [ ] **W9** `Pickers.tsx:56` — pre-existing bug worth fixing here:
      `modalityVar(...).replace('--','')` strips only the first `--`, yielding a non-key, so the
      `showHue` dot has been invisible for **every** measure since it was written. Fix to
      `theme.css('mod-' + m.code)`.
- [x] **W10** `fixtures/index.ts:61` — add an `aclima_sense` entry to the Gallery `MEASURES`
      array so picker/legend/segment layer can be eyeballed without a backend.

### Goal 2 — honesty surfaces (this is not polish; it is the product)

The composite is an editorial act. No external body publishes `aclima_sense`. These are the
places where the UI would otherwise assert something false.

- [x] **H1** Done. `regulator/MapScreen.tsx` now carries a `derived` flag
      (`measure?.family === 'composite'`) that suppresses `blind` and rewrites both surfaces:
      the banner says *"Sense is a derived index, not a species — no instrument anywhere
      carries it"*, and each `TowerRow` says *"Sense is computed, not measured"* instead of
      *"no ACLIMA_SENSE channel"*. `TowerRow` also takes `measureLabel` now, so the 12-character
      code never reaches mono furniture. Original note: *"No reference instrument carries an
      ACLIMA_SENSE channel."* —
      `regulator/MapScreen.tsx:138–142` (blind-verdict banner) and `:526–531` (all four
      TowerRows) would render a permanent accusation against the agency.
      `regulator/Analysis.tsx:57` (`carriers`) the same. The honest sentence is **"this is a
      derived index, not a species anyone instruments"** — the agency is not failing to measure it.
- [x] **H2** Already correct by construction — `Status.tsx` asks `useMeasures('modality')`,
      which excludes the composite. Left as-is and **commented**, because the next person to
      "fix" the inconsistency by switching it to `PICKABLE` would reintroduce exactly the bug:
      this screen asks what the agency's instruments cover, and a derived index belongs in
      neither the covered nor the uncovered list.
- [ ] **H3** `community/Dashboard.tsx:71–73` says *"Seven different things, each scored on the
      same 0-100 scale"* over `stats.by_measure`. With B1/B2 the composite becomes the headline
      dial above that list, so add a line: **"Sense is built from three of these bars, not a
      new one."**
- [~] **H4** *Data side done, UI side open.* `measure_def.description` now carries the full
      recipe — the formula, the three coefficients, the citation, the scale anchor, the
      measured 27-vs-20 gap and why the per-pass version is published, the "not the AQHI of
      this street" line, what it does not cover, and the provenance string *"Aclima construct,
      after Stieb et al. 2008"*. It ships to all four interfaces via `/bootstrap`. **Still
      open:** a "how this is built" affordance that actually surfaces that text where the
      number is shown. Original note: `measure_def.description` carries the recipe — the three coefficients, the
      citation (Stieb et al. 2008, Health Canada AQHI), the scale anchor (100 = AQHI 10) and the
      version string. It is the only field that ships to all four interfaces via `/bootstrap`
      and it renders in the admin spec sheet. **An index whose weights aren't published is
      unfalsifiable.** There is nowhere else in `measure_def` to store the weight vector.
- [ ] **H5** `admin/Data.tsx:120–143` — the identity scale draws as a bare diagonal with two
      ticks and will read as an unfinished placeholder. Render the three-term breakdown for
      `family === 'composite'` instead of the risk curve. That row's scale/ref_level/healthy_max
      must be **read-only** in admin — editing them changes what the index *means* without
      changing how it was *computed*.
- [ ] **H6** The averaging-basis line, wherever the number appears at size: *"median of N
      drive-bys, \<date range\>"*. Every index this borrows from (AQI 24-hr, DAQI 24-hr, AQHI
      3-hr rolling) is defined on a fixed-site time average. This is not that, and presenting a
      drive-by median as an AQI-like number without saying so is the most common way
      street-level products mislead — and the first thing a regulator will attack.
- [ ] **H7** The ozone caveat, on the regulator screen: *"Ozone is the one pollutant a fixed
      monitor measures better than we do."* Curbside O3 medians run 3.4/12.1/20.8 ppb against a
      real urban 30–60, because the platform drives the NOx-rich canyons where titration
      destroys it (`field.py:118`, 1.90 ppb O3 per ppb NO2 excess). This is the one place the
      product concedes the fixed network wins — and conceding it is what makes the NO2 claim
      credible.
- [ ] **H8** *"Sense does not see methane."* A `methane_leak` scenario (`sim.py:482`) provably
      does not move Sense — that is the design working, and the best available demo of what the
      index does not cover. A gas leak scoring zero in the health index is not a safe leak.
- [ ] **H9** Contribution split in the segment inspector — NO2 x% / O3 y% / PM2.5 z%. The
      additive form decomposes exactly, and `GET /segments/{id}` already returns all measures'
      medians in one object, so this needs **no new API field**. Label it *"share of the score
      at this street's typical levels"* — a share computed from medians is not the median of
      per-pass shares, and neither is a share of emissions. It is not attribution of blame.
- [ ] **H10** Never print "AQI" near it. US AQI "Good" runs 0–50; here 30 is already the top of
      Low. A resident carrying AQI intuition reads 50 as safe when this scale calls it Moderate.
- [ ] **H11** Short-term, not lifetime. The coefficients are daily-mortality coefficients.
      Under a long-term burden construct (GBD/BenMAP) PM2.5 would carry 0.75–0.85 instead of
      0.21 and the street ranking would change. Both are legitimate epidemiology and they
      disagree. Standing copy: *"the risk of being outside on a bad day here, not the risk of
      living here for twenty years."*
- [ ] **H12** Band tables disagree and one must win. `measures.ts:202–210` has seven bands
      (Good <20, Fair 20, Moderate 40, …); `domain.py:124` has five (Clean 20, Fair 40, …). The
      web table matches this scale's anchors — its Moderate boundary at 40 is AQHI 4 and its
      High at 70 is AQHI 7. Align the server table to it, or one index gets two different band
      words from two endpoints.

### Found during implementation — not in the original list

- [ ] **A1** `regulator/Analysis.tsx` — its picker asks `useMeasures('modality')`, so the
      composite is absent, but the **session measure is global**: pick Sense on the regulator
      map, walk to Analysis, and the picker shows a value it does not offer while `carriers`
      (`towersFor(towers, 'aclima_sense')`) is empty — a dead tower select, an empty reference
      clock, and null `towerValue`/`spread`. Either offer it and branch the
      reference-instrument half, or reconcile the session measure on mount. Not a crash;
      a screen that quietly reads as broken.
- [ ] **A2** The regulator's default metric is `p90`, and the composite's p90 is near the
      100 clamp on the worst streets (measured 99.6 / 99.0 / 95.5 on the top three). The clamp
      itself is negligible and faithful to AQHI's own "10+" convention — it bites on **12 of
      56,088 passes (0.02%)** — but a p90 view of Sense still reads as a citywide emergency
      where the median view reads Low/Moderate. Consider defaulting a composite to `median`.
- [ ] **A3** Decide whether the industry MFD's plume should offer to follow the picker for the
      three measures that *do* have a `dispersion_model` (bc, no2, pm25) rather than staying
      pinned for all ten. Currently pinned, and the legend names the species.

### Done outside the original list

- [x] **Server graceful shutdown.** `uvicorn.run(..., timeout_graceful_shutdown=5)` in
      `src/air/server/__main__.py`. Without it a reload never completes while a browser tab
      holds `/events/stream` open — uvicorn logs *"Waiting for connections to close"* and
      blocks forever on an SSE response that by design never ends. The process then looks
      alive to `pgrep` while refusing every connection. This is the *"API occasionally refuses
      connections behind accumulated SSE streams"* item in `STATUS.md`; it bit twice during
      this session before being fixed.
- [x] **`sim.py` refuses to drive a composite.** `MEASURE_FALLBACK[measure]` (two sites) became
      `_fallback(measure)`, which raises a message naming the reason rather than a bare
      KeyError. Deliberately **no** fallback entry for `aclima_sense`: a scenario works by
      writing monitor readings, and letting a demo inject a composite reading that no
      instrument could produce is exactly the kind of quiet fiction this simulation may not tell.

### Known traps (read before touching anything)

1. **A half-registered composite is a blank map with no error.** `PRAGMA foreign_keys = OFF`
   during builds (`db.py:84`, contradicting `build.py:51`'s docstring) means a typo'd code
   inserts cleanly and orphans. Every read path returns HTTP 200 with an empty
   FeatureCollection for an unknown measure (`segments.py:107`). No toast, no console warning.
   **Share the code literal between `measures.py` and `stats.py`; never retype it.**
2. **`campaign_summary` iterates `ORDER`, not `STAT_ORDER`.** `col = ci[m]` is a `segment_pass`
   column lookup — KeyError on the composite.
3. **The measure slice is global across roles** (`session.ts:88`, persisted as
   `air.session.v1` with no `migrate`). An industry operator picking Sense changes what a
   resident sees on their next role switch. If the default ever changes, bump the persist
   version and add a migrate that drops any stored measure absent from `/bootstrap`.
4. **Hardcoded `'no2'` fallbacks** at `community/MapScreen.tsx:168`, `admin/Data.tsx:34`,
   `regulator/Watchfloor.tsx:152`.
5. **+10% on the database** — ~24.8k `segment_stat` rows on 247,872 existing, on a 94.6 MB DB
   that `stats.py:9–11` says was already trimmed from 300 MB.

---

## Provenance

Workflow `wf_19b4a676-e70` — Survey (6 agents) and Propose (3 agents) completed; Judge (×3)
and Plan died on a session limit. Raw payloads recovered from
`~/.claude/projects/-Users-antonvattay-Workspace-air/78038d1d-.../subagents/workflows/wf_19b4a676-e70/journal.jsonl`
and extracted to the session scratchpad as `survey-*.json`, `proposal-{1,2,3}.json`,
`proposals.md`, `insertion-points.md`.

The three designers converged independently on NO2 + PM2.5 + O3, and split 2–1 on form:
proposals 1 and 3 chose the AQHI additive construction, proposal 2 chose EPA-style
max-with-published-driver over three re-anchored breakpoint tables. Proposal 2's own strongest
recorded tradeoff concedes the AQHI form is *"the better PRODUCT and the worse CLAIM"* — the
claim objection being that its coefficients would have to be invented. They don't: AQHI is
published, cited, and adopted wholesale here with its citation and its band edges intact.
That is what breaks the tie.

Ideas grafted from proposal 2 into the winner: publishing the driver/contribution with every
value, the pinned-domain discipline, and the `[0,100]` band-anchor conversion line.

**Measurements quoted throughout this document were taken by the survey agents against the
built `data/air.db` (1,307 segments, `window='all'`), not estimated.**
