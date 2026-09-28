---
name: air
description: One calibrated measurement language rendered in four irreconcilable rooms — community, regulator, industry, and Aclima admin — over the same contested ground.
colors:
  # ── The Ember Ramp — analytical magnitude. The flagship road grid. ──
  ember-0: "#10182F"
  ember-1: "#24356F"
  ember-2: "#4B3D9B"
  ember-3: "#823C93"
  ember-4: "#C0417F"
  ember-5: "#E6614F"
  ember-6: "#F79B3D"
  ember-7: "#FFD84D"
  # ── The Ember Ramp, luminance-inverted for the light community basemap ──
  ember-light-0: "#BFE6DE"
  ember-light-1: "#79C9C4"
  ember-light-2: "#4FA8C2"
  ember-light-3: "#6E82C4"
  ember-light-4: "#A264B4"
  ember-light-5: "#CE4F86"
  ember-light-6: "#E2543F"
  ember-light-7: "#A8211F"
  # ── The public-health ramp. Community and any "risk" framing. ──
  aqi-good: "#3FBF8F"
  aqi-fair: "#9ED45C"
  aqi-moderate: "#F2C744"
  aqi-sensitive: "#F08A3C"
  aqi-unhealthy: "#E2544F"
  aqi-very-unhealthy: "#9B4FA8"
  aqi-hazardous: "#7A2438"
  # ── Severity. Shared by every alert chip in every room. ──
  sev-ok: "#3FBF8F"
  sev-info: "#4FA8E0"
  sev-watch: "#F2C744"
  sev-warning: "#F0803C"
  sev-critical: "#FF3B4E"
  # ── Actors. Who is speaking. Identical in all four rooms. ──
  actor-community: "#F2A65A"
  actor-regulator: "#4FD1E0"
  actor-industry: "#B58CFF"
  actor-aclima: "#00D3A7"
  # ── Modality identity. Legend chips and multi-series charts only. ──
  mod-no2: "#4FD1E0"
  mod-pm25: "#F2A65A"
  mod-bc: "#B58CFF"
  mod-o3: "#7ED957"
  mod-co: "#FF8FA3"
  mod-co2: "#8FA3B8"
  mod-ch4: "#FFD84D"
  mod-aclima-sense: "#E8E0D0"
  # ── Role accents ──
  civic-green: "#0E7C66"
  civic-alarm: "#C4442F"
  sensor-cyan: "#4FD1E0"
  sensor-threat: "#FF6B4A"
  sensor-tower: "#5EE6A8"
  sensor-fleet: "#FFD84D"
  scope-phosphor: "#39FF9E"
  scope-caution: "#FFB020"
  scope-threat: "#FF3B30"
  aclima-teal: "#00D3A7"
  blueprint-blue: "#7CA9FF"
  # ── Grounds and ink, one set per room ──
  community-paper: "#F6F3ED"
  community-surface: "#FFFFFF"
  community-ink: "#191C1F"
  community-line: "#E2DCD2"
  regulator-ground: "#090E14"
  regulator-surface: "#111A23"
  regulator-ink: "#DEE9F1"
  regulator-line: "#1F2C39"
  industry-ground: "#05070A"
  industry-surface: "#0C1114"
  industry-ink: "#D9E8E0"
  industry-line: "#1A262A"
  admin-ground: "#0C1017"
  admin-surface: "#141A23"
  admin-ink: "#E6EDF3"
  admin-line: "#232E3C"
  landing-ground: "#06080B"
typography:
  display:
    fontFamily: "Instrument Sans Variable, Instrument Sans, Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3.25rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Instrument Sans Variable, Instrument Sans, Inter Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.09em"
  numeral:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "normal"
    fontFeature: "tnum 1"
rounded:
  xs: "3px"
  sm: "6px"
  md: "10px"
  lg: "16px"
  xl: "24px"
  pill: "999px"
spacing:
  s-1: "0.25rem"
  s-2: "0.5rem"
  s-3: "0.75rem"
  s-4: "1rem"
  s-5: "1.5rem"
  s-6: "2rem"
  s-7: "3rem"
  s-8: "4rem"
  s-9: "6rem"
components:
  button-primary:
    backgroundColor: "{colors.sensor-cyan}"
    textColor: "{colors.regulator-ground}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 1rem"
    height: "36px"
  button-primary-community:
    backgroundColor: "{colors.civic-green}"
    textColor: "{colors.community-surface}"
    rounded: "{rounded.pill}"
    padding: "0 1.5rem"
    height: "40px"
  button-primary-industry:
    backgroundColor: "{colors.scope-phosphor}"
    textColor: "{colors.industry-ground}"
    rounded: "{rounded.xs}"
    padding: "0 1rem"
    height: "36px"
  button-cta:
    backgroundColor: "{colors.civic-alarm}"
    textColor: "{colors.community-surface}"
    rounded: "{rounded.pill}"
    padding: "0 1.5rem"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.regulator-surface}"
    textColor: "{colors.regulator-ink}"
    rounded: "{rounded.sm}"
    padding: "0 1rem"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.regulator-ink}"
    rounded: "{rounded.sm}"
    padding: "0 1rem"
    height: "36px"
  button-danger:
    backgroundColor: "{colors.sev-critical}"
    textColor: "{colors.regulator-ground}"
    rounded: "{rounded.sm}"
    padding: "0 1rem"
    height: "36px"
  chip:
    backgroundColor: "{colors.regulator-surface}"
    textColor: "{colors.regulator-ink}"
    rounded: "{rounded.pill}"
    padding: "0 0.75rem"
    height: "26px"
  chip-active:
    backgroundColor: "#0F2D34"
    textColor: "{colors.sensor-cyan}"
    rounded: "{rounded.pill}"
    padding: "0 0.75rem"
    height: "26px"
  badge-critical:
    backgroundColor: "transparent"
    textColor: "{colors.sev-critical}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "0 0.5rem"
    height: "18px"
  card:
    backgroundColor: "{colors.regulator-surface}"
    textColor: "{colors.regulator-ink}"
    rounded: "{rounded.sm}"
    padding: "1rem"
  card-community:
    backgroundColor: "{colors.community-surface}"
    textColor: "{colors.community-ink}"
    rounded: "{rounded.lg}"
    padding: "1rem"
  panel-header:
    backgroundColor: "{colors.regulator-surface}"
    textColor: "{colors.regulator-ink}"
    typography: "{typography.label}"
    padding: "0.5rem 0.75rem"
    height: "34px"
  input:
    backgroundColor: "#06090D"
    textColor: "{colors.regulator-ink}"
    rounded: "{rounded.sm}"
    padding: "0 0.75rem"
    height: "36px"
  input-community:
    backgroundColor: "{colors.community-surface}"
    textColor: "{colors.community-ink}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "44px"
  stat-value:
    textColor: "{colors.regulator-ink}"
    typography: "{typography.numeral}"
  avatar:
    backgroundColor: "{colors.regulator-surface}"
    textColor: "{colors.regulator-ink}"
    rounded: "{rounded.pill}"
    size: "32px"
---

# Design System: air

## Overview

**Creative North Star: "Contested Ground"**

Southwest Memphis is the ground, and three parties are arguing over what the air above it
is doing. `air` does not resolve that argument — it renders it. Every interface in this
product is a *claim* on the same 1,307 road segments, and the design's entire job is to
make each claim feel native to whoever is making it while the evidence underneath stays
identical. A resident opens warm paper and reads a coloured street. An agency analyst opens
a dark watchfloor and reads the same street as an exact concentration. An operator opens a
near-black map of their own site and reads it as a bearing and a distance. Nobody is shown a different number.

That produces the system's central and deliberately uncomfortable property: **one
measurement language, four rooms that do not want to look like each other.** The
measurement language — the two ramps, the severity scale, the actor hues, the mono tabular
numerals, the uppercase micro-labels — is a single calibrated instrument that is never
re-tuned per audience. Everything else is. The same `<Button>` is a soft pill on warm paper
in community, an uppercase phosphor block with a green bloom in industry, and a
wide-tracked slab in regulator and admin. That is not inconsistency to be cleaned up later;
it is the product thesis expressed in CSS. If a component looks identical in all four
rooms, it has failed to pick a side.

Density follows the room, not the brand. Community is generous — 40px pill buttons, 44px
inputs, 16px card radii, a page that scrolls. The three dark rooms are instrument-dense —
26px chips, 18px badges, 34px panel headers, hairline `1px` rules, panes that scroll
independently under a shell that never does. The palettes never meet: community is the only
light skin in the product and the only one that paints its road grid on the public-health
ramp. Confirmed anti-references, each pinned to its room: community must not read as a
dashboard, a science tool, or a government site; regulator must not read as a consumer app;
industry must not read as an analytics product; admin must not read as polished marketing.

**Key Characteristics:**

- One measurement language, four irreconcilable skins, switched by a single `data-role`
  attribute on the shell — no component branches on role in JavaScript.
- A coloured road grid, never hexbins and never points, is the hero of every map.
- Two measurement ramps that never mix: public-health for residents, analytical for experts.
- Numerals are always monospace and tabular; micro-labels are always uppercase and tracked.
- Depth is tonal first — a four-step surface ladder — with shadow reserved as a response.
- Severity is never carried by colour alone.
- Nothing decorative: motion exists only where a real state changed.

## Colors

The palette is two systems stacked. Underneath sits a role-independent **measurement
language** — the ramps, severity, actors, modality hues — that is identical in all four
interfaces. On top sit four **room palettes** that share nothing but their token names.

### Primary

- **Civic Green** (`#0E7C66`): the community accent. A deep, unsaturated forest green with
  enough weight to sit on warm paper without shouting — chosen so that the room's *only*
  loud colour can be the one button that matters.
- **Sensor Cyan** (`#4FD1E0`): the regulator accent, and simultaneously the actor hue for
  the agency. The regulator's room is literally coloured by their own instruments.
- **Scope Phosphor** (`#39FF9E`): the industry accent. Aggressively bright, borrowed from a
  radar warning receiver, and the only colour in the product allowed to emit rather than
  reflect. It carries `--glow-accent` (`0 0 12px #39FF9E66`).
- **Aclima Teal** (`#00D3A7`): the admin accent and Aclima's own actor hue. The house
  colour, used where Aclima itself is the operator.

### Secondary

Each room carries exactly one counter-accent, and each one means "act" or "beware" rather
than "brand":

- **Civic Alarm** (`#C4442F`): a warm brick red reserved for community's *Report a concern*
  call to action. It is the loudest thing in the warm room and appears at most once per view.
- **Sensor Threat** (`#FF6B4A`): the regulator's suspected-emitter colour, also bound to
  `--invader`. Paired with **Sensor Tower** (`#5EE6A8`) for friendly assets and **Sensor
  Fleet** (`#FFD84D`) for Aclima vehicles — the three-colour vocabulary of the tower-defense
  narrative.
- **Scope Caution** (`#FFB020`) and **Scope Threat** (`#FF3B30`): the industry amber and red,
  the latter carrying `--glow-threat` (`0 0 16px #FF3B3088`).
- **Blueprint Blue** (`#7CA9FF`): admin's drafting counter-accent, and the hue of its grid
  overlay at 8% opacity.

### Tertiary

- **Actor hues** — Community `#F2A65A`, Regulator `#4FD1E0`, Industry `#B58CFF`, Aclima
  `#00D3A7`. These answer "who is speaking" and are constant across all four interfaces so a
  viewer learns the code once and carries it between rooms.
- **Modality identity hues** — NO2 `#4FD1E0`, PM2.5 `#F2A65A`, BC `#B58CFF`, O3 `#7ED957`,
  CO `#FF8FA3`, CO2 `#8FA3B8`, CH4 `#FFD84D`, plus the composite `aclima_sense` at `#E8E0D0`.
  Chosen for separation under deuteranopia. These identify a *series*; they never encode a
  magnitude. The composite is deliberately **not** Aclima Teal: an index claiming to describe
  your air must not read as a vendor badge.

### Neutral

Four grounds, four inks, no overlap. Every room builds depth from the same four-step ladder
(`--bg` → `--surface` → `--surface-2` → `--surface-raised`) and a two-step rule
(`--line` → `--line-strong`), so a component written against the ladder lands correctly in
all four without knowing which room it is in.

- **Community Paper** (`#F6F3ED` ground, `#FFFFFF` surface, `#191C1F` ink, `#E2DCD2` line):
  the only light skin in the product. Warm, slightly yellow, deliberately not white.
- **Regulator Ground** (`#090E14` ground, `#111A23` surface, `#DEE9F1` ink, `#1F2C39` line):
  a cold blue-black watchfloor.
- **Industry Ground** (`#05070A` ground, `#0C1114` surface, `#D9E8E0` ink, `#1A262A` line):
  the darkest ground in the product and the only ink with a green cast.
- **Admin Ground** (`#0C1017` ground, `#141A23` surface, `#E6EDF3` ink, `#232E3C` line): a
  neutral technical slate, one step lighter and bluer than the regulator's.
- **Landing Ground** (`#06080B`): the persona picker's neutral, Aclima's own colour sitting
  between the three parties.

### Named Rules

**The Two Ramps Rule.** `--ramp-aqi-*` is public-health language and belongs to residents
and to any score framed as "risk". `--ramp-intensity-*` — *The Ember Ramp* — is analytical
magnitude and belongs to the regulator, industry, and admin. Never mix them in one view, and
never resolve a measurement colour from a role accent. `--ramp-map-*` is the per-role alias
the road grid reads, and it is the only correct way to reach a ramp from a map layer.

**The Ember Ramp.** Eight stops from `#10182F` midnight through violet, magenta, and coral
to `#FFD84D` gold. Its luminance is monotonic by construction so that a 1px segment at the
low end recedes into a dark basemap and the high end burns through it. `--ramp-intensity-light-*`
is the same ramp inverted in luminance for the one light basemap. Never reorder its stops,
never sample a subset, and never substitute a generic sequential scale.

**The Learned Code Rule.** `--actor-*` means the same speaker in every interface. Never
re-bind an actor hue per room, and never use one to encode a magnitude or a severity.

**The Never Colour Alone Rule.** Severity is carried by at least two channels — colour plus
shape, size, position, or a glyph. The AlertTimeline encodes it three ways at once (colour,
the severity glyph in or beside each bar, and the severity word in its tooltip and table
twin), and the map's alert tooltip pairs the same glyph with the word, so both survive a
colourblind reader at a glance.

## Typography

**Display Font:** Instrument Sans Variable (with Inter, `ui-sans-serif`, `system-ui`)
**Body Font:** Inter Variable (with Inter, `ui-sans-serif`, `system-ui`)
**Label/Mono Font:** JetBrains Mono Variable (with `ui-monospace`, SF Mono, Menlo)

**Character:** Three neutral, high-legibility workhorses, chosen so that the *room* carries
the personality and the type never does. Instrument Sans appears only where a display voice
is wanted — community headings and the landing page. Industry is the exception that proves
the system: it binds **both** `--font-body` and `--font-heading` to JetBrains Mono, so the
entire room is monospace and reads as machine output rather than prose.

### Hierarchy

- **Display** (600, `3.25rem` / `--text-4xl`, 1.15, `-0.02em`): hero readouts and the landing
  page only. One per screen at most.
- **Headline** (600, `1.875rem` / `--text-2xl`, 1.15, `-0.02em`): screen titles and large
  stat values in community.
- **Title** (600, `1.0625rem` / `--text-lg`, 1.15, `-0.02em`): modal titles, card titles.
- **Body** (400, `0.9375rem` / `--text-md`, 1.5): default. Dense console body drops to
  `0.8125rem` (`--text-sm`); reading measures cap at ~42ch in empty states.
- **Label** (600, `0.625rem` / `--text-3xs`, `0.09em`, uppercase): panel titles, table
  headers, stat labels, axis ticks, map-legend micro-labels. Labels and buttons only —
  never a sentence or a paragraph in capitals (the industry map's all-caps key read as
  shouting and was cut). The single most characteristic type
  object in the product.
- **Numeral** (600, `--font-mono`, `tabular-nums`): every number, everywhere.

The scale runs `--text-3xs` 10px · `--text-2xs` 11px · `--text-xs` 12px · `--text-sm` 13px ·
`--text-md` 15px · `--text-lg` 17px · `--text-xl` 22px · `--text-2xl` 30px · `--text-3xl` 40px ·
`--text-4xl` 52px. It is not a fixed ratio — the bottom four steps are packed 1px apart
because dense instrument UI needs that resolution, and the top steps open up for display.

### Named Rules

**The Tabular Rule.** Every numeral is `--font-mono` with `font-variant-numeric: tabular-nums`.
No exceptions, including inside prose. `.num` and `[data-num]` are global for exactly this
reason, so no component needs to import anything to comply. A number that shifts width as it
ticks is a bug.

**The Caps Are Labels Rule.** Uppercase with `--tracking-caps` (`0.09em`) is reserved for
micro-labels at `--text-3xs`. Never set a sentence in caps. Industry is the deliberate
exception for *controls only*: its buttons, chips, segmented items, and field labels go
uppercase at `--text-2xs`/`--text-3xs`. Sentences, captions, legends and explanations stay
sentence case in industry too — the deck's all-caps map key and disclaimer paragraphs were
the "too busy" the owner saw (2026-09-23).

**The Community Plain-Speech Rule.** Community overrides strip the caps treatment wherever it
appears — panel titles become sentence case at `--text-sm`, stat labels become sentence case
at `--text-xs`. Residents get labels, not readouts.

## Layout

The shell is a CSS grid with a role-switch rail and a header, laid out as three areas
(`rail head` / `rail main` / `rail foot`) at `100dvh`, and **it is not one layout recoloured
four times.** Each room restructures it:

- **Community** drops the rail entirely (`grid-template-columns: minmax(0, 1fr)`) and takes a
  taller 64px header. The page scrolls like a feed.
- **Industry** keeps the shared 68px rail, labelled in short words (Map · Alerts · Reports ·
  Outreach · Evidence · Site), and a 44px header — a near-empty phosphor frame with corner
  brackets around the map.
- **Regulator** keeps the 68px rail with a 48px header. Neither industry nor regulator has a
  header status strip any more (2026-09-23): the page carries the status, so the header
  cannot contradict it.
- **Admin** keeps the rail with a 52px header and a numeric status bar.

The shell paints its room's texture from `--grid-overlay` on a `::before` at 90% opacity:
regulator gets a 28px watchfloor graticule, admin a 32px blueprint grid in Blueprint Blue at
8%, industry a 3px phosphor scanline, community nothing at all.

**Spacing** runs a 9-step scale from `0.25rem` to `6rem` (`--s-1` … `--s-9`), roughly
doubling above `--s-4`. Instrument chrome lives at `--s-2`/`--s-3`; content padding at
`--s-4`; section rhythm at `--s-5`/`--s-6`.

**Panels** are fixed at `--panel-w: 380px`. The z-scale is explicit and ordered: map 1,
overlay 10, panel 20, header 30, popover 40, modal 50, toast 60.

**Responsive behaviour is desktop-first and deliberately partial.** This is a demo driven on
a large screen, and the breakpoints reflect that honestly: the dark rooms collapse
multi-column bodies to single-column between `1400px` and `1000px` and stop there. Only
community carries genuine small-screen breakpoints (`820px`, `620px`) — it is the only
interface a resident would plausibly open on a phone. There is no shared breakpoint token;
each module declares its own `max-width` query.

### Named Rules

**The Shell Owns Scroll Rule.** `body` is `overflow: hidden` and every pane scrolls itself
with `overscroll-behavior: contain`. Never introduce a document-level scroll; a page that
scrolls as a whole belongs only to community's feed, and even that scrolls inside `main`.

## Elevation & Depth

**Depth is tonal first, lit by state.** The primary depth mechanism in all four rooms is the
four-step surface ladder — `--bg` → `--surface` → `--surface-2` → `--surface-raised` — plus a
`1px` border stepping `--line` → `--line-strong`. A surface reads as raised because it is a
step lighter and outlined, not because it casts. Shadow is the secondary channel and is
bound to state and to room.

That said, `--shadow-card` is one token name over three genuinely different physics, and the
indirection is what lets a component be written once:

- **Community casts.** `0 1px 2px rgba(24,22,18,.05), 0 8px 24px -12px rgba(24,22,18,.18)` —
  a real paper drop shadow with a warm-black tint, the only room that behaves like physical
  material. Its interactive cards also lift `translateY(-2px)` on hover.
- **Regulator and admin bevel.** `0 1px 0 rgba(255,255,255,.03) inset, 0 12px 32px -20px #000`
  — an inset top highlight over a deep, tight drop. Machined metal, not paper.
- **Industry emits.** `0 0 0 1px #1A262A, 0 0 24px -12px #39FF9E33` — a hairline ring plus a
  green bloom. There is no light source; the surface glows.

### Shadow Vocabulary

- **`--shadow-card`** — resting elevation for cards, panels, and raised segmented items.
- **`--shadow-pop`** — modals, sheets, and popovers. Roughly triple the blur of `--shadow-card`
  in every room (community `0 8px 40px -12px rgba(24,22,18,.32)`; the dark rooms
  `0 24px 60px -20px #000C`).
- **`--glow-accent`** (`0 0 12px #39FF9E66`) and **`--glow-threat`** (`0 0 16px #FF3B3088`) —
  industry only. Applied to primary and danger buttons respectively.

### Named Rules

**The Tonal First Rule.** Reach for the surface ladder before reaching for a shadow. If two
surfaces need to be distinguished, step the tone and the border. A shadow is what you add
when something has *moved* — opened, floated, or been picked up — not what you add to make
a box visible.

**The Room's Physics Rule.** A new surface adopts the depth physics of the room it is in, via
`--shadow-card` / `--shadow-pop`. Never hard-code a shadow value, and never import one room's
treatment into another: a paper drop shadow on the industry scope, or a phosphor glow on
community paper, breaks the fiction immediately.

## Shapes

Corner radius is the fastest way to tell which room you are standing in, and the scale is
used at full width:

- **Community** — `--r-pill` (999px) on every button, icon button, chip, and segmented
  control; `--r-lg` (16px) on cards; `--r-md` (10px) on inputs and selects. Nothing has a
  sharp corner. Soft, touchable, social.
- **Regulator** and **admin** — `--r-sm` (6px) on cards and controls. Neutral, technical,
  unremarkable by design.
- **Industry** — `--r-xs` (3px) on cards, buttons, chips, and even avatars. Nearly square.
  Machined.

Borders are hairline everywhere: `1px solid var(--line)`, stepping to `--line-strong` on hover
and for modal and sheet edges. Containers use `overflow: clip` rather than `hidden`, so a
child cannot escape a rounded corner.

Round geometry is reserved for meaning, not decoration: severity dots, avatars, monitor
coverage rings, and the diurnal clock are circular *because the data is
radial*. A rounded rectangle is chrome; a circle is a reading.

### Named Rules

**The Radius Tells You Where You Are Rule.** Pill means community, 6px means an analyst,
3px means a scope. A designer who wants a rounder industry button is asking for the wrong
room.

## Components

Every primitive follows one philosophy: **instrument-grade, refinished per room.** The
chassis underneath is identical — hairline border, tokenised height, `--dur-fast` (120ms)
transitions on `--ease-out`, semantic tokens only. What each room changes is the finish:
radius, case, tracking, height, and whether it glows. Role deltas are expressed entirely in
CSS with `:global([data-role='…'])` prefixes; no component branches on role in JavaScript.

### Buttons

- **Shape:** rounded rectangle at `--r-sm` (6px) by default; pill in community, `--r-xs`
  (3px) in industry.
- **Sizes:** `sm` 28px · `md` 36px · `lg` 46px. Community scales the whole family up
  (32 / 40 / 52px) and bumps the base size to `--text-md`.
- **Primary:** `--accent` ground, `--accent-ink` text, `--weight-semi`. Hover is
  `filter: brightness(1.08)` — never a separate hover colour token.
- **CTA:** `--accent-2` ground. Reserved for community's *Report a concern*. One per view.
- **Secondary:** `--surface-2` with a `--line-strong` border. **Ghost:** transparent,
  `--ink-2`, no border. **Quiet:** transparent with a `--line` border. **Danger:**
  `--sev-critical`.
- **Active:** `translateY(0.5px) scale(0.995)` — a press, not a bounce. **Disabled:** 45%
  opacity, `cursor: not-allowed`.
- **Room deltas:** community adds `--shadow-card` to primary and CTA; industry uppercases at
  `--text-2xs` with `--tracking-caps` and adds `--glow-accent` to primary, `--glow-threat` to
  danger; regulator and admin add `--tracking-wide`.

### Chips

- **Style:** 26px tall, `--r-pill`, `--surface-2` ground, `--line` border, `--ink-2` text at
  `--text-xs`. `chipSm` drops to 20px / `--text-3xs`. An optional 6px `currentColor` dot leads.
- **State:** active is `--accent-soft` ground, `--accent` border and text — the same
  three-token pattern used by active tabs and active icon buttons.
- **Room delta:** industry squares them to `--r-xs` and uppercases at `--text-3xs`.

### Segmented Control

The measure / metric / window picker. A 2px-inset track on `--bg-sunk` with a `--line`
border; the active item lifts onto `--surface-raised` with `--shadow-card` and full `--ink`.
Inactive items sit at `--ink-3`. Community rounds the whole assembly to pill; industry
uppercases the items.

### Badges

18px tall, `--r-xs`, uppercase `--text-3xs` at `--weight-bold` with `--tracking-caps`. The
outline variant is the default and is unusually economical: `border: 1px solid currentColor`
with `background: color-mix(in srgb, currentColor 12%, transparent)`, so setting one severity
colour drives text, border, and fill together. `badgeSolid` inverts to a filled chip with
`--ink-inv` text.

### Severity Dot

An 8px `currentColor` circle (6px / 11px variants) that pairs with a badge or label so
severity is never colour-alone. `sevDotPulse` adds an expanding `currentColor` ring
(`scale(0.7)` → `scale(2.1)`, 1800ms) for live, unacknowledged states only.

### Cards and Panels

- **Card:** `--surface` on a `--line` border at `--radius-card`, with `--shadow-card` and
  `overflow: clip`. Header is `--s-3`/`--s-4` padded with a bottom rule; body is `--s-4`.
  Interactive cards shift to `--line-strong` on hover, and lift 2px in community only.
- **Panel:** the instrument variant. A flex column with a fixed 34px header on `--surface-2`
  carrying an uppercase `--text-3xs` title, a scrolling body, and an optional footer.
  `panelFlush` strips border, radius, and background for panels that sit inside a frame.
- **Room delta:** community re-skins the panel header to `--surface` and sets its title in
  sentence case at `--text-sm` in full `--ink` — it stops reading as instrument chrome.

### Inputs and Fields

- **Style:** 36px tall on `--bg-sunk` — inputs are *sunk below* the surface, not raised onto
  it — with a `--line` border at `--r-sm`. Textareas are the same, min 92px, vertically
  resizable.
- **Focus:** `--accent` border with `outline-offset: 1px`. Hover pre-signals with
  `--line-strong`. Invalid takes `--sev-critical`.
- **Numeric:** `.inputNum` switches to mono tabular, per The Tabular Rule.
- **Field:** label at `--text-xs`/`--ink-2`, optional hint at `--ink-3`, error at
  `--sev-critical`. A required marker uses `--accent-2`.
- **Room deltas:** community grows inputs to 44px at `--text-md` on `--surface` with `--r-md`,
  and sets labels at `--text-md` in full `--ink` semibold. Industry uppercases field labels.

### Select, Slider, Toggle

Select mirrors the input exactly with a non-interactive `--ink-3` chevron at `--s-3` from the
right. The slider draws a 4px `--line` track with an `--accent` progress fill and a
`--surface-raised` thumb that scales `1.15` on hover, with a mono tabular value readout
right-aligned at `3.5ch`. The toggle is a 36×20 pill that fills `--accent` when on and
translates a `--accent-ink` knob 16px.

### Tabs

Underline tabs by default: a `--line` bottom rule, inactive at `--ink-3`, active taking full
`--ink`, `--weight-semi`, and a `--accent` bottom border. `tabsPill` swaps to
`--accent-soft` / `--accent` pills. An optional count sits inline.

### Data Display

- **Stat:** uppercase `--text-3xs` label over a mono tabular `--text-xl` value with a smaller
  `--ink-3` unit on the baseline. `statLg` goes to `--text-3xl`. Trend arrows read
  `--sev-warning` up, `--sev-ok` down, `--ink-3` flat — the only place in the product where up
  is bad, and correct, because these are pollutants.
- **Table:** sticky uppercase `--text-3xs` headers on `--surface-2`; `--ink-2` body cells that
  brighten to `--ink` on row hover; `.numCell` is mono, tabular, and right-aligned. The active
  row takes `--accent-soft`.
- **Skeleton, Spinner, Empty:** a `--surface-2` block with an 8%-`--ink` shimmer sweep; a 16px
  `currentColor` ring; a centred `--ink-3` empty state capped at 42ch.

### Overlays

Modals are `min(560px, 100%)` (`modalWide`: 880px) capped at `84dvh`, on `--surface` with a
`--line-strong` border and `--shadow-pop`, entering with an 8px rise and `scale(0.985)` over
`--dur-med`. Sheets are `--panel-w` wide, anchored right by default, with left and bottom
variants — the bottom sheet is the one small-screen affordance in the system and rounds its
top corners to `--r-lg`.

### The Road Grid (signature)

**The flagship visualisation of the entire product.** A deck.gl `PathLayer` painting ~200m
road segments, composed bottom-to-top as casing → glow → grid. It carries two variables at
once:

- **Hue = how much.** `value` resolved through the room's `--ramp-map-*` — the AQI ramp in
  community, The Ember Ramp everywhere else. Concentrations use a robust p2–p98 domain.
- **Weight = how often.** Persistence modulates line width (and optionally opacity) through a
  6-step ladder (`--persist-0` 0.18 → `--persist-5` 1.0).

So a thick saturated street is bad all the time; a thin saturated street spiked once; a thick
pale street is chronically a little dirty. Three stories in one glance. A basemap-coloured
casing keeps a 2px line crisp over any tile. Segments below the minimum pass count draw as
"not enough data" rather than as a value.

### The Radar Scope (retired from the industry deck, 2026-09-23)

> **Retired (owner decision D8).** The deck is now map-led: the map carries the site, the
> measured streets, the fenceline road, the wind particles and today's plume outline, and
> the dial was a second geometry repeating the map's bearings. `RadarScope.tsx` was
> deleted in phase 6 of the refocus, with its gallery section. The description below is
> kept as the record of what it was; do not rebuild it.

Industry's plan-position indicator, readable from three metres without interpretation.
Position encodes bearing and range from the site; shape encodes who is reporting; colour,
mark size, and a glyph all encode severity; a ring means new and unacknowledged.

**The reference is a modern compass instrument, not a CRT.** Hairline rings, small ticks, one
accent, and a great deal of negative space. There is deliberately no sweep, no phosphor decay,
and no idle animation — a contact is simply *there*. Motion on this dial is reserved for real
state changes, so when something moves it means something.

Pass a wind field and observed street-level wind advects inside the scope as nullschool-style
particles; pass the consultant's dispersion contours and they draw underneath as a dashed
reference outline. The divergence between the two is the product's core argument rendered as
a *shape* rather than a paragraph.

### The Coverage Ring (signature)

The regulator's visual signature (a look, never a word on screen — CONTRACT §10a.7). Reference monitors draw two concentric rings — outer at
`radius_m`, inner at 55% — in `--tower` green, sweeping slowly while the instrument is online.
The sweep is the regulator's alone. It exists on their towers and on the landing page's hub
(`--dur-sweep`, 3200ms linear) and nowhere else.

### Named Rules

**The Same Component Must Not Look The Same Rule.** A primitive that renders identically in
all four rooms has failed. Before shipping one, check it under every `data-role` and confirm
it picked a side. Consistency in this product lives in the measurement language, not in the
chrome.

**The Semantic-Only Rule.** A component references `--bg`, `--surface`, `--ink`, `--line`,
`--accent`, `--sev-*`, `--ramp-map-*`. It never references a raw hex and never reaches past a
semantic token to a ramp primitive. That indirection is the entire mechanism by which one
component survives four skins.

## Do's and Don'ts

### Do:

- **Do** resolve every colour from a semantic token in `web/src/design/tokens.css`. The
  `data-role` attribute on the shell does the rest.
- **Do** set every numeral in `--font-mono` with `font-variant-numeric: tabular-nums` — reach
  for the global `.num` or `[data-num]` rather than re-declaring it.
- **Do** pick the ramp from the audience, not the component: `--ramp-aqi-*` for residents and
  any "risk" framing, The Ember Ramp (`--ramp-intensity-*`) for analysts and operators, always
  via the `--ramp-map-*` alias.
- **Do** pair severity colour with a second channel — a `sevDot`, a badge glyph, a mark size,
  or a position.
- **Do** build depth from the surface ladder first (`--bg` → `--surface` → `--surface-2` →
  `--surface-raised`) and add `--shadow-card` only when something is genuinely raised.
- **Do** let the road grid be the hero of every map, coloured by magnitude and weighted by
  persistence.
- **Do** keep the `SIMULATED DATA` marker visible; the shell owns it, so don't cover it.
- **Do** write community copy with no units and no acronyms — `plain_name` and unitless 0–100
  risk scores exist for exactly that.
- **Do** express role differences in CSS via `:global([data-role='…'])`, never by branching on
  role in a component.
- **Do** state uncertainty when the data is thin (low `n_obs`, high `dir_sd`). Trustworthy
  measurement is the brand; fake confidence is off-brand.

### Don't:

- **Don't** write a raw hex value in a component, and don't reach past a semantic token to a
  `--ramp-*` or `--c-*` primitive.
- **Don't** mix the two measurement ramps in one view, and don't colour a measurement from a
  role accent.
- **Don't** re-bind `--actor-*` per room or use an actor hue to encode magnitude. A viewer
  learns that code once.
- **Don't** use a modality hue (`--mod-*`) for magnitude — those identify a series only.
- **Don't** substitute `--actor-aclima` for `--mod-aclima_sense`. An index describing someone's
  air must not read as a vendor badge.
- **Don't** carry one room's finish into another: no pill buttons in the industry room, no phosphor
  glow on community paper, no paper drop shadow in a dark room.
- **Don't** set a sentence in uppercase. Caps plus `--tracking-caps` means micro-label —
  except in industry, where uppercase is the room's whole voice.
- **Don't** add a sweep, a scanline, or an idle animation anywhere but the regulator's
  coverage rings (`--dur-sweep`, theirs alone). The industry deck is a map, not a CRT, and
  its stillness is what makes real motion mean something.
- **Don't** render the map data as hexbins or points. The ~200m segment is the atom of this
  product and the grid is what makes it look like nothing else.
- **Don't** introduce a document-level scroll. The shell owns layout; each pane scrolls itself.
- **Don't** hard-code a shadow, a radius, or a breakpoint — and note that there is no shared
  breakpoint token yet, so a new responsive rule should follow the existing per-module
  `max-width` pattern rather than inventing a scale.
