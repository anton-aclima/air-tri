# `components/` — the map + viz library

Everything here is **presentational**: it takes data as props and renders. No fetching, no
routing, no role logic. Import from the barrel:

```tsx
import { BaseMap, SegmentLayer, MapWindField, RadarScope } from '@/components';
```

Three rules the whole library already obeys, so you don't have to:

1. **No raw hex, anywhere.** Colour is read from `tokens.css` custom properties at runtime
   via `useTheme()`. Set `data-role` on the shell and deck.gl layers, SVG charts and canvas
   particles all re-skin together.
2. **Severity is never colour alone** — always paired with a glyph, position or text.
3. `prefers-reduced-motion` **freezes at a legible pose**, it never drops the information.

Conventions used below:

- Every chart takes `className` / `style`, and most take `title` / `subtitle` / `aside`
  (the `ChartFrame` header slots) plus `showTable` (a visually-hidden `<table>` twin for
  screen readers — leave it on).
- Every deck.gl **layer is a factory function, not a component.** Call it inside `layers={}`.
  All of them take `theme`, `visible`, `pickable`, `hoveredId` / `selectedId`,
  `onHover` / `onClick`.
- `Position` is `[lon, lat]`. `dir_deg` is meteorological — the direction wind blows **from**.

---

## The token bridge — read this before you style anything

```tsx
const ref = useRef<HTMLDivElement>(null);
const theme = useTheme(ref);          // resolves against the nearest data-role ancestor
theme.css('sev-critical')             // → 'rgb(…)' string for inline styles / SVG
theme.color('accent')                 // → RGBA tuple
theme.rampColor(0.7, 0.5, 'intensity')// → RGBA on a ramp, t 0–1, optional alpha
theme.dark                            // boolean — the current skin's polarity
theme.role                            // 'community' | 'regulator' | 'industry' | 'admin'
```

`useDocumentTheme()` is the same thing keyed off `<html>`, for anything outside the tree.
Helpers: `withAlpha`, `rgbaCss`, `mix`, `luminance`, `parseColor`.

---

## Map

### `BaseMap`

The deck.gl canvas plus a basemap backend, a role skin, and a furniture grid. **The road
grid is the hero visual** — this is its frame.

| prop | type | notes |
|---|---|---|
| `layers` | `LayersList \| (theme: Theme) => LayersList` | pass the **function** form so layers re-skin on role change |
| `initialView` / `view` + `onViewChange` | `Partial<MapView>` | uncontrolled / controlled camera |
| `backend` | `'auto' \| 'google' \| 'maplibre'` | `'auto'` = Google when a key exists, else MapLibre |
| `skin` | `'light' \| 'dark' \| 'night' \| 'blueprint'` | defaults to `--map-style` from the role |
| `fullBleed` | `ReactNode` | drawn above tiles + data, below furniture, pointer-events off. **`<MapWindField>` goes here.** |
| `children` | `ReactNode` | furniture — wrap each in `<MapOverlay place=…>` |
| `gridOverlay` `vignette` `attribution` | `boolean` | all default `true`; keep attribution on |
| `interactive` `minZoom` `maxZoom` `maxPitch` `cursor` `pickingRadius` | | camera limits |
| `getTooltip` `onHover` `onClick` | `(info: PickingInfo) => …` | deck.gl picking |
| `label` | `string` | accessible name for the map region |
| `onBackendChange` | `(b) => void` | fires once the backend resolves |

```tsx
<BaseMap layers={(t) => SegmentLayer({ data: segs, theme: t })} fullBleed={<MapWindField field={wind} />}>
  <MapOverlay place="bottom-left"><MapScale /></MapOverlay>
</BaseMap>
```

### `MapOverlay`

Places furniture on a 3×3 grid over the map. `place`: `top-left | top-center | top-right |
middle-left | middle-right | bottom-left | bottom-center | bottom-right`.

### `MapContext` / `useMapContext()`

`{ view, size, theme, backend, setView }`. Anything inside `BaseMap` can read the live
camera — that's how `MapWindField` works with zero props.

### Backends — `GoogleBackend`, `MapLibreBackend`

Internal to `BaseMap`; you should never mount them directly. `GoogleBackend` takes
`apiKey` + optional `mapId`; `MapLibreBackend` takes the shared `BackendProps`
(`skin`, `view`, `onViewChange`, `interactive`, …). Skins come from
`skinPalette(skin)` / `applyMapLibreSkin()` / `googleMapStyles()` in `map/styles/mapStyles`.

---

## Layers (9)

### `SegmentLayer` — **the hero**

~200 m road segments coloured by magnitude, with persistence as a second channel.

| prop | type | notes |
|---|---|---|
| `data` | `SegmentCollection` | GeoJSON from `GET /segments` |
| `scale` | `ColorScale` | omit → derived with a robust p2–p98 domain |
| `metric` | `'median' \| 'p90' \| 'max' \| 'persistence' \| 'risk'` | labels + unit handling |
| `dualEncode` | `'width' \| 'opacity' \| 'both' \| 'none'` | how persistence reads. Default `'width'` |
| `baseWidthM` `widthMinPixels` `widthMaxPixels` | `number` | keeps the grid visible zoomed out |
| `tone` | `'ramp' \| 'context'` | `'ramp'` (default) paints the value. `'context'` draws every street in `data` as one neutral hairline — `CONTEXT_STROKE`: `--ink-3` at 50%, 1.25 px at every zoom — with no value colour, no casing, no rings, never pickable. For "measured earlier, not in this window": build it as its own call **below** the coloured window's call. It is measurement, so a solid line, never the model's dash (§10b). Only `id`, `visible`, `opacity` apply in this tone |
| `casing` | `boolean` | basemap-coloured halo under every line. Default `true` — leave it. Not drawn under few-pass streets on a dark skin (see `fewPassesBelow`) |
| `minPasses` | `number` | below this, segments draw as "not enough data", not as a value |
| `fewPassesBelow` | `number` | streets with ≥ `minPasses` but fewer than this still draw their value, **thin** (40% width, 0.7× pixel floor) and without the persistence width — a short street window (a day, or the Network's 24 h / 7 d, R4). Light skins: 72% alpha, cased. Dark skins: 90% alpha, **no casing** — a `--bg` casing under a translucent stroke darkened the stroke itself (the old stop 0 composited to 1.07:1 against the regulator `--bg`). `fewPassAlpha(theme)` gives the alpha for a matching swatch. Never dashed or dotted: those are the model's strokes (§10b). Default 0 = off |
| `highlightIds` | `string[]` | ring these segments with the soft accent halo (the streets inside a selected monitor's ring). Default none |
| `opacity` | `number` | |

Companions: `SegmentHighlightLayer(…)` for the selected segment, `segmentDomain(data)`,
`segmentTooltipRows(props, { unit?, decimals?, metric? })`, `fewPassAlpha(theme)`,
`CONTEXT_STROKE` (both imported from `map/layers/SegmentLayer`; `MapLegend` draws its
swatches with them).

```tsx
layers={(t) => [...SegmentLayer({ data: segs, theme: t, metric: 'p90', dualEncode: 'both' })]}

// A window over a quiet context grid: to-date streets in grey, the window's in colour.
layers={(t) => [
  ...SegmentLayer({ id: 'streets-context', data: toDate, theme: t, tone: 'context' }),
  ...SegmentLayer({ id: 'streets', data: week, theme: t, scale, dualEncode: 'none', fewPassesBelow: 3 }),
]}
```

**The ramp on a dark skin.** Every dark skin (regulator, industry, admin, the landing)
binds `--ramp-map-*` to `--ramp-intensity-dark-*`, the analytical ramp lifted so its
lowest stop reads as a line on a dark ground; charts that name `'intensity'` keep
`--ramp-intensity-*`. Non-text contrast of each stop against the skin's `--bg`:

| stop | before `--ramp-intensity-*` | reg | ind | adm | after `--ramp-intensity-dark-*` | reg | ind | adm |
|---|---|---|---|---|---|---|---|---|
| 0 | `#10182F` | 1.10 | 1.15 | 1.08 | `#3769CA` | 3.72 | 3.88 | 3.66 |
| 1 | `#24356F` | 1.67 | 1.74 | 1.65 | `#636DE6` | 4.48 | 4.67 | 4.41 |
| 2 | `#4B3D9B` | 2.25 | 2.34 | 2.21 | `#9470C6` | 4.97 | 5.18 | 4.89 |
| 3 | `#823C93` | 2.78 | 2.90 | 2.74 | `#C374B5` | 5.98 | 6.23 | 5.88 |
| 4 | `#C0417F` | 3.97 | 4.13 | 3.91 | `#DB779C` | 6.58 | 6.85 | 6.47 |
| 5 | `#E6614F` | 5.71 | 5.94 | 5.61 | `#FE826B` | 7.95 | 8.28 | 7.82 |
| 6 | `#F79B3D` | 8.95 | 9.33 | 8.81 | `#F79B3D` | 8.95 | 9.33 | 8.81 |
| 7 | `#FFD84D` | 14.00 | 14.58 | 13.77 | `#FFD84D` | 14.00 | 14.58 | 13.77 |

Same hue order, same top two stops, luminance rising at every step for normal vision and
under simulated deuteranopia and protanopia. The community skin (AQI) and the light
`--ramp-intensity-light-*` are untouched.

### `MonitorLayer`

Reference monitors and fenceline sensors. `data: Monitor[]`, `rings` (draw `radius_m`
coverage, default true), `measure` (which `latest.exceeds` drives the alarm),
`pulse` (feed `usePulse()`), `labels`, `sizePx`, `hoveredId`, `selectedId`.

- `labelBy: 'code' | 'name'` — default `'code'` (`47-157-0058`); `'name'` prints the place
  (`Harbor Avenue`), the words every panel and alert uses for the same instrument.
- `emphasizeIds?: string[]` — those draw at full strength with their label; every other
  monitor is muted, labelled only while hovered or selected (pass `hoveredId`), and never
  pulses. Omitted = every monitor full strength (the old behaviour); `[]` mutes them all.

The regulator Network's options (R3). All optional; omitted, every existing map is unchanged.

| prop | type | notes |
|---|---|---|
| `labelFor` | `(m) => string` | the name part of the label, overriding `labelBy` ("Riverport Rd") |
| `labelCase` | `'upper' \| 'asis'` | default `'upper'`; `'asis'` keeps the caller's case |
| `readingFor` | `(m) => string \| null` | the reading **at the moment shown**, formatted, appended: "Riverport Rd 10.6". Not `m.latest`, which is always the end of the data |
| `ratioFor` | `(m) => number \| null` | reading ÷ action level; appended as "· 0.62×" only at `RATIO_LABEL_FROM` (0.5) or more |
| `overIds` | `string[]` | when given, alone drives the alarm pulse and the critical tint — the caller applies the same-averaging-period rule; the layer never infers "over" from `m.latest` |
| `mutedIds` + `mutedNote` | `string[]`, `string \| (m) => string` | no channel for the measure: muted, no pulse, no reading, always labelled "West Shelby Dr · no NO2 channel" in muted ink |
| `collision` | `LabelCollision` | take part in a shared label-collision pass (below) |
| `labelPlate` | `boolean` | the label on a `--bg` plate (80%, 3 px padding), so plume hairlines stop at the reading instead of running through it. Default false |

Helpers: `monitorExceeds(monitor, measure)`, `formatRatio(r, from?)` (the label's "0.62×", "1.03×" — two decimals below 1.1× so an over reading never prints "1.0×" —
null below the floor — use it in the panel too so the two cannot disagree), `RATIO_LABEL_FROM`.

### `SiteLayer`

Industry sites + emission points. `data: IndustrySite[]`, `emissionPoints`, `labels`,
`branding` (brand emoji), `pulse`, `footprint: 'fill' | 'outline'` (default `'fill'`;
`'outline'` drops the wash, keeps the edge and the click target — for maps where CONTRACT
§10b makes measurement the only filled thing), `labelCase: 'upper' | 'asis'` (default
`'upper'`), `collision` (below).

### Label collision — `labelCollision()` (in `layers/labelCollision.ts`)

A monitor's name and a site's name hide each other instead of overprinting; monitors win.
Create one collider per layer build and hand it to every layer that takes part — order in
the `layers` array does not matter, priority does (`LABEL_PRIORITY`: reference monitor >
low-cost sensor > site; selected / hovered / over lift within a tier, never across one). A
monitor's mast is an obstacle too. Placement runs against deck's own viewport each time it
changes, so no zoom has to be threaded through, and a hidden name returns once there is room.

```tsx
layers={(t) => {
  const collision = labelCollision();
  return [...SiteLayer({ …, collision }), ...MonitorLayer({ …, collision })];
}}
```

Give every participating layer a distinct `id` — the collider keys registrations by it.
Not deck's `CollisionFilterExtension`: that tests only each label's anchor point (both of
these labels are pixel-offset from theirs) and compares picking colours that repeat across
layers, so monitor #0 and site #0 never collide. See the file header.

### `CoverageMaskLayer`

Dims the ground the fleet never drove (§10b's "outside the driven-coverage mask", R2): a
world veil in `--bg`, cut away along a corridor around every driven street (deck's
`MaskExtension`, inverted). `data` — the driven streets, e.g. the week to the moment shown,
`GET /segments?window=trailing:168h&at=…` (a stored `date:…` day is still fine in a room
without a time cursor); `null` draws nothing, an empty collection dims everything.
`corridorM` (full width, default 120), `strength` (default 0.2 — very low; no stroke),
`minPasses` (default 1). Place it directly above the basemap / `BoundaryLayer`, below the
streets and every model layer.

### `ConcernLayer`

Resident concerns and the ≥3-in-600 m/24 h clusters. `data: Concern[]`,
`clusters: ConcernCluster[]`, `pulse` (forming clusters breathe), `labels` (corroboration
count in the halo), `onClusterClick`. Helper: `concernStatusToken(status)`.

### `FleetLayer`

The 5 vehicles. `data` takes raw `GET /fleet` rows **or** the output of `useFleetAnimation()`
for smooth interpolation. `trails` / `trailLength` (default 40), `labels` (call signs),
`pulse` (feed `usePulse(2200)`), `sizePx`.

### `BoundaryLayer`

Campaign edge. `data` accepts a FeatureCollection, a Feature or a bare geometry.
`mask` dims everything outside (default true, `maskStrength` 0.28), `glow`, `colorToken`
(default `accent`), `edgeWidthPx`.

### `DrivePlanLayer`

`mode: 'routes' | 'coverage'`. Routes mode takes `routes: DriveRoute[]` with `arrowEvery`
and `endpoints`; coverage mode takes `coverage: CoverageCell[]` + `segments` so coverage
draws on real streets. Filter with `vehicleIds` / `dayIndex` — **colour never changes when
filtered**. Helper: `vehicleColorIndex(routes)` → `Map<vehicleId, index>`, so a vehicle keeps its colour.

### `DispersionLayer` (in `layers/WindLayer.ts`)

The modelled plume, in one of two registers — `style`:

- **`'fill'`** (default — the gallery, and every caller before PLAN-refocus F6): banded
  filled contours inside the detection envelope, dashed unfilled outline past it.
  `bandCount`, `outline` (band edges, default true), `maxOpacity` (default 0.5).
- **`'outline'`** — CONTRACT §10b for Aclima's model, from `GET /wind/dispersion?outline=1`
  (`useDispersion({ …, outline: true })`). One hairline around the whole plume, solid to the
  envelope and dashed past it; the centreline axis, solid then dashed; a pixel-sized **reach
  tick** across the axis where it meets the envelope (at its end when the plume stops short);
  the word `truncated` at the far end when the reach hit the 8,000 m model limit. **Never
  filled.** Reads only the `kind` features and draws nothing without them — it never falls
  back to a fill. The two outline parts are clipped at the axis's own envelope line and the
  cut between them is dropped, so the register changes in one place, on the tick.
  `pickable` + `onHover` / `onClick` pick the solid outline and axis (`info.object.properties`);
  the dashed part never picks. `mutedSiteIds` draws those sites' plumes outline-only at
  `MUTED_PLUME` (0.4×) of the register's alpha, with no axis, tick or `truncated` — the
  Network's "axis only for a plume that touches something" (R2).

`hasBeyondEnvelope(data)` says whether to print `BEYOND_ENVELOPE_NOTE` (either shape).
`plumeOutlineGeometry(data)` returns the drawn runs, axis parts, ticks and truncated ends.

### `FiledStudyLayer` (in `layers/WindLayer.ts`)

The operator's filed permit study: `contours` (`DispersionModel.contours` verbatim),
`bands: 'outer' | 'all'` (default `'outer'`, found by area). Dotted, `accent-2`, **no fill** —
never the `beyond` dash, so with the comparison on the two outlines differ on two channels.

Strokes for all three registers come from `PLUME_STROKE` (`lib/vizmeta`), which the legend's
`PlumeSwatch` reads too.

### `SoftPlumeLayer` — the resident's cloud

`data` (**`GET /wind/dispersion?outline=1`** — `useDispersion({ …, outline: true })`), `theme`,
`visible`, `intensity` (multiplies every shell's alpha). Fills each site's `kind: 'outline'`,
`part: 'inside'` polygon with ten nested, rounded shells (none is the served ring) that fade from the source to nothing before the
detection envelope (1.5 km, or 4 km in stable air); **nothing past the envelope, no stroke, no
band `level`**. A bands-only payload draws nothing — it never falls back to the 8 km bands.
Colour is `--plume-soft`, a warm neutral off every ramp.

> **The wind visual is not a deck.gl layer.** Particle advection needs frame-to-frame canvas
> history. Use `MapWindField` — see below.

---

## Wind

### `MapWindField` — particles over the map

Drop into `<BaseMap fullBleed={…}>`. Reads the camera from `MapContext`, so it works
identically over both backends.

`field: WindField` (`GET /wind/field`) · `particles` (3–6k) · `keep` (fraction of alpha kept
per frame — the trail; 0.94 medium, 0.98 smear, 0.85 dots) · `speedDomain` · `speedScale` ·
`ramp: 'map' | 'intensity' | 'aqi'` · `colorMode: 'ramp' | 'neutral'` · `colorToken` ·
`opacity` · `lineWidth` · `minConfidence` · `running`.

`colorMode="neutral"` paints every particle in `--ink-2` with speed on alpha. Use it on a
map whose `--ramp-map-*` is the **measured** street ramp (industry: `--ramp-map-*` =
`--ramp-intensity-dark-*`, the same hue order and top stops as the wind's default
`--ramp-intensity-*`), so the wind never reads as measured ink over ground nobody drove
(CONTRACT §10b). The legend key is then a plain `--ink-2` line. Default `'ramp'` is unchanged.

A camera move re-projects the particles and a new `viewKey` wipes the trails, so a pan or a
fly-to never strokes the camera's own motion as streaks.

```tsx
<BaseMap fullBleed={<MapWindField field={wind} particles={4200} />} layers={…} />
```

### `WindFieldCanvas` — the engine

Only reach for this directly if you need a frame that is neither the map nor the scope.
Adds `projector: Projector` (build with `mapProjector(view, size)` or
`makeScopeProjector({ site, rangeM, size, headingUp })`), `theme`, `viewKey` (pass
`viewSignature(view)` — a camera move wipes the canvas rather than restarting the sim),
`maxAge`, `colorMode`, and `colorToken` (paint every particle one token with **speed carried by
brightness** — the radar-scope idiom).

Particle alpha is **skin-aware** and confidence **thins the draw rate, not the alpha**, so
low-`n` / high-`dir_sd` cells genuinely show fewer streaks. `windSpeedLegend(theme, domain,
ramp, colorToken, colorMode)` returns `{ stops, lo, hi, gradient }` so speed colour is never unexplained.

### `ModelVerificationPanel` — "verify your consultant"

The two roses superimposed, per-bearing bias, and the verdict, in that order.

`data: ModelVerification` (`GET /sites/{id}/model-verification`) · `roseSize` (default 210) ·
`showBias` · `showDistricts` · `title` (overrides the verdict headline).

**Units, and they are easy to get wrong:** `assumed_freq` / `observed_freq` / `delta` are
**percentages 0–100** (`delta` in percentage *points*); `disagreement` alone is a **0–1
fraction**. The panel handles this; if you render these fields yourself, don't mix them.

```tsx
<ModelVerificationPanel data={verification} />
```

---

## Map furniture

Each goes inside `<MapOverlay place=…>`.

| component | props |
|---|---|
| `MapLegend` | `scale` (pass the same `ColorScale` the layer got and domain/stops follow), `domain`, `measure`, `metric`, `dualEncode`, `plainLanguage`, `showNoData`, `compact`, `title`, `fewPassesNote` (a thin-stroke row for `SegmentLayer`'s `fewPassesBelow` streets), `contextNote` (a row with the `tone: 'context'` hairline, e.g. "grey: measured earlier, not in this window"; kept when `empty` is set), `empty` (the window has no streets: this one line replaces the ramp, ticks, key, few-pass and no-data rows, e.g. "No NO2 passes in the 7 days to Aug 24 06:00 · last one Aug 15 20:30"), `control` (a node placed under the title row, e.g. the street-window switch) |
| `MapScale` | `zoom` / `latitude` (override the context), `maxWidth` (110), `units: 'metric' \| 'imperial' \| 'both'` |
| `NorthCompass` | `bearing`, `pitch`, `onReset`, `size`, `alwaysVisible` (default false — hidden when north-up), `readout` |
| `MiniRose` | `rose` (`WindClimatology.rose` or any `{ dir_deg, freq }[]`; any unit — petals scale to the largest sector), `size` (64), `caption` (a short line beside it), `label` (accessible name; default names the most common direction in words), `className`, `style`. **Outline only, 16 sectors, no numbers** — the community map's "Usually" key, tied to no company. Renders nothing until the rose has data |
| `LayerToggles` | `items: { id, label, enabled, color?, keyShape?: 'line' \| 'dot', count?, disabled? }[]`, `onToggle(id, next)`, `title` |
| `MeasurePicker` | `measures`, `value`, `onChange`, `variant: 'segmented' \| 'chips' \| 'select'`, `plainLanguage`, `showUnit`, `showHue`, `disabled`, `label` |
| `MetricPicker` | `value`, `onChange`, `metrics` (community should pass `['risk']` only), `variant`, `longLabels`, `label` |
| `MapTooltip` | `x`, `y` (straight from `PickingInfo`), `title`, `subtitle`, `hero: { value, unit }`, `rows: TooltipRow[]`, `severity`, `visible`, `offset` |
| `MapPopover` | `x`, `y`, `title`, `subtitle`, `children`, `actions: { label, onClick, primary? }[]`, `onClose`, `offset` |
| `SegmentInspector` | `segment` (from picking), `detail` (`GET /segments/{id}` — unlocks the charts; pass `at=<naive campaign time>` wherever the screen has a time cursor, so `daily`, `diurnal`, `stats`, `n_passes` and `rank_pct` come only from passes at or before the moment shown — with no `at` they are the whole campaign's stored windows), `measure`, `measureCode`, `metric`, `plainLanguage`, `campaignValues` (for the percentile chart), `domain` (so the header swatch matches the map exactly), `onClose`, `children` |
| `PlumeSwatch` | `register: 'model' \| 'beyond' \| 'filed'`, `width` (22). An inline legend mark drawn from `PLUME_STROKE`, the same table the plume layers draw with — put it beside the words, e.g. `BEYOND_ENVELOPE_NOTE` |

```tsx
<MapOverlay place="top-right"><MapLegend scale={scale} measure={m} /></MapOverlay>
```

---

## Charts

All take `className` / `style`. Most take `title` / `subtitle` / `aside` / `showTable`.

### `TimeSeries`
Multi-series lines with thresholds and exceedance shading.
`series: { id, label, color?, points, band?, dashed? }[]` · `thresholds: { id, label, value,
severity?, shade? }[]` · `height` · `unit` · `decimals` · `yDomain` · `yZero` (default true) ·
`brushable` + `brush` + `onBrush(range)` (naive campaign times) · `exceedanceSeriesId` · `xFormat(d)` · `margin`.
```tsx
<TimeSeries series={[{ id: 'no2', label: 'NO₂', points }]} thresholds={[{ id: 'naaqs', label: 'NAAQS 1-h', value: 100 }]} unit="ppb" />
```

### `DiurnalClock`
24-hour radial. `points` (24 `SeriesPoint[]` or plain numbers) · `band: { lo, hi }[]` ·
`size` · `measure` · `domain` · `ramp` · `mode: 'area' | 'ring'` · `refLevel` ·
`plainLanguage` · `labelPeak` (default true) · `onHourClick(h)`.
This is the chart that shows NO₂ at 3.86× at 03:00.
```tsx
<DiurnalClock points={hours} measure={no2} refLevel={100} />
```

### `SeasonalStrip`
90-day ribbon, one cell per day. `points` · `domain` · `ramp` · `unit` · `decimals` ·
`markers: { t, label, color? }[]` (advisories, mitigations) · `onDayClick(t)` · `height` ·
`monthTicks` · `showScale`.
```tsx
<SeasonalStrip points={days} markers={[{ t: smokeStart, label: 'Smoke episode' }]} />
```

### `CalendarHeat`
Same props as `SeasonalStrip` plus `cell` (edge px, default 13) and `weekdayLabels`.

### `ScaleKey`
Bare gradient key: `{ stops, lo, hi, unit?, decimals? }`.

### `Sparkline`
`points` · `band` · `width` · `height` · `color` · `fill` · `threshold` · `showEndDot` ·
`domain` · **`ariaLabel` — always supply something meaningful.**

### `Distribution`
Campaign histogram with one segment marked. `values: number[]` · `marker` ·
`markerLabel` · `percentile` (0–100, supply to skip recomputing) · `bins` · `height` ·
`unit` · `decimals` · `ramp` · `colorByValue`.
```tsx
<Distribution values={campaign} marker={seg.value} markerLabel="This street" />
```

### `RiskDial`
Community-facing, **unitless 0–100**. `risk` · `size` · `label` · `bandLabel` ·
`trendPct` · `upIsBad` (default true) · `showBands` · `footer`.
Never put a unit next to this.

### `Gauge`
Analytical value against a limit. `value` · `domain` · `threshold` + `thresholdLabel` ·
`unit` · `decimals` · `label` · `valueLabel` (words instead of a number, for community) ·
`ramp` · `thickness` · `scaleLabels` · `footer`.

### `AlertTimeline`
Alert bars over a window. `alerts: { id, label, code?, severity, startedAt, endedAt?,
acknowledged? }[]` (`endedAt: null` = still up, drawn with a live edge) · `from` / `to` ·
`rowHeight` · `maxRows` (default 8, rest fold into "+N more") · `selectedId` +
`onSelect(id)` · `labels` (off gives a pure ribbon) · `margin`.
Helper: `timelineFromAlerts(alerts)` converts `Alert[]` from the API; rows are labelled by
the alert's title (the four-letter kind codes are retired copy, PLAN-refocus I11).
The gutter prints `code` when given, else the label. It widens to fit its longest label
(92px minimum, as before; 140px cap), and a `"what · where"` label keeps its `where` whole
and shortens only the `what`, so "Wind · site-wide" and "Reports · NNW" survive.

### `WindRose`
`points: WindPoint[]` (binned internally) **or** `rose: RoseBin[]` (pre-binned, wins) ·
**`compare: RoseBin[]` — a second rose as a dashed reference outline over the first** ·
`roseLabel` / `compareLabel` · `sectors: 8 | 16` · `speedBins` · `size` ·
`mode: 'speed' | 'freq'` (`'speed'` stacks by speed band, `'freq'` one petal per sector) ·
`nObs` (warns when the sample is thin).
`RoseBin` is `{ dir_deg, freq, mean_speed_ms }` — the shape `ModelVerification` already uses.
```tsx
<WindRose rose={observed} compare={assumed} mode="freq" nObs={n} />
```

### `CompassBearing`
Single-bearing readout. `bearing` · `distanceM` · `size` · `severity` · `label` ·
`cardinal` (show "ESE" as well as digits) · `vertical`.

### `RadarScope`
**Retired from the industry deck (PLAN-refocus D8/I3); kept for the gallery until the backlog
removes it. Its vocabulary is not product copy.**
Threats plotted by bearing from a site — **with the observed wind advecting inside the dial.**

| prop | type | notes |
|---|---|---|
| `contacts` | `RadarContact[]` | `{ id, bearing_deg, distance_m, severity, label?, code?, source? }` |
| `size` `rangeM` `rings` | `number` | `rangeM` auto-scales to the furthest contact |
| `headingUp` | `number` | rotate so this bearing points up. 0 = north up |
| `sweep` | `boolean` | the rotating trace. Honours reduced motion. Default true |
| `selectedId` + `onSelect` | | |
| `labels` | `'all' \| 'hover' \| 'none'` | default `'all'` |
| `ownLabel` `status` `title` | | centre site name, status line override |
| **`site`** | `Position` | required for the wind field and the model contours |
| **`windField`** | `WindField` | particles advect inside the scope |
| `windParticles` | `number` | default 1400 — lower than the map, it's a small frame |
| `windSpeedDomain` `windLegend` | | speed key under the dial |
| `modelContours` | `{ band, level, geometry }[]` | takes `DispersionModel.contours` verbatim; drawn as a **dashed reference outline** the particles visibly disagree with |
| `modelLabel` | `string` | |

Helper: `contactsFromAlerts(alerts)` — filters to alerts that carry `bearing_deg` + `distance_m`.

```tsx
<RadarScope contacts={contactsFromAlerts(alerts)} site={site} windField={wind} modelContours={model.contours} ownLabel="Ridgeline South" />
```

### `ChartFrame` and friends (`charts/primitives`)
`ChartFrame` (`title`, `subtitle`, `aside`, `legend`, `footer`, `children`) is the shared
header/plot/footer shell. Also `Legend` (`LegendSeries[]` — `shape: 'line' | 'rect' | 'dash'`),
`ChartTooltip`, `TableTwin` (the a11y table), `GridLines`, `AxisLeft`, `AxisBottom`,
`EmptyPlot`, and the hooks `useChart()` / `useCrosshair()`.

---

## `lib/` — helpers you'll want

- **`scales`** — `makeColorScale(theme, { domain, ramp?, mode?, gamma? })` (**theme is the
  first argument**), `robustDomain(values, { low?, high?, floorAtZero? })` (p2–p98 by default),
  `persistenceAlpha` / `persistenceWidth` / `persistenceRung`, `noDataColor(theme)`.
  Ramps: `'aqi'` for public-health / any risk framing, `'intensity'` for analytical
  magnitude, `'map'` for the per-role road-grid alias. **Never mix aqi and intensity.**
- **`geo`** — `haversine`, `bearingBetween`, `destination`, `circleRing`, `wedge`,
  `toPolygons`, `geometryPositions`, `alongPath`, `pathMetrics`, `splitPathAt`, `metersPerPixel`,
  `fitZoom`, `bboxOfPositions`, `bboxCenter`, `expandBBox`, `bboxRing`, `lerpPosition`.
- **`anim`** — `usePhase(ms)` (0→1 sawtooth), `usePulse(ms)` (triangle), `useNow()`
  (the demo's now as epoch ms, not the wall clock), `useReducedMotion()`,
  `useFleetAnimation(positions)`.
- **`reports`** — `useWindowedReports(concerns, clusters, days)`: the last
  `REPORT_WINDOW_DAYS` ending at the demo's now, the same instant row ages use.
- **`windField`** — `buildFieldIndex(field)` (bilinear sampler + confidence from `n` /
  `dir_sd`), `cellConfidence`, `mercatorProjector`, `scopeProjector`.
- **`vizmeta`** — `niceStep` / `niceCeil` / `niceTicks`, `SEVERITY_GLYPH`, `METRIC_HELP`,
  `CONCERN_LABEL`, `CONCERN_EMOJI`, `ALERT_KIND_LABEL`, `PLUME_STROKE`. (The four-letter
  cockpit codes, `ALERT_KIND_CODE`, are gone — PLAN-refocus I11.) Severity words are
  `SEVERITY_LABEL` in `@/core/measures` — Critical / Warning / Watch / Info — and nothing else.
- **`glyphs`** — `GLYPH`, `icon`, `monitorGlyph`, `emissionGlyph`, `concernGlyph`.
- **`useSize`** — `const [ref, size] = useSize<HTMLDivElement>()`. Returns the ref to attach
  **and** the observed `{ width, height }`; ResizeObserver-backed. Takes an optional fallback size.

## `fixtures/`

Static sample data (segments, boundary, footprints) for the gallery and for rendering
without a backend. Not for production screens.
