# air — UI agent brief

**Read this instead of CONTRACT.md, server/README.md and datagen/README.md.** It carries
everything shared that a UI agent needs. The only other thing to read is the ONE section
of `docs/design.md` for your role, plus `web/src/core/README.md` (the hooks) and
`web/src/components/README.md` (the components). That's three files, not six.

---

## The product in one paragraph

`air` is one React app with four interfaces onto one shared dataset — community,
regulator, industry, and Aclima admin. Aclima measures air quality from a fleet of cars
that drive every street repeatedly; the atom of the product is a **~200 m road segment**
with a number attached. The pitch is that Aclima sits between three parties who want
different things from the same air and is the arbitrator of what it's actually doing.
**The demo succeeds if a viewer can feel that tension.** Judge every feature by whether
it strengthens or dilutes it.

Correctness is not the goal. Look, feel and narrative are. All data is simulated.

## Setting — real geography, fictional actors

Southwest Memphis: Boxtown, Westwood, White Chapel, Riverport. Real streets, real
neighbourhood names, **entirely fictional companies, agencies and people.**

| | |
|---|---|
| **Ridgeline Compute** | `Ridgeline South Campus` — 350 MW AI datacenter, gas turbines + diesel backup. Sits **SW** of the community, so the prevailing SW wind carries its plume over Boxtown. Community is at bearing **~055° (NE)** from the campus. |
| **Delta Forge Metals** | Manufacturing, **north** of Boxtown. |
| **Riverport Logistics** | Intermodal/drayage, **north-east**. Diesel truck traffic. |
| **DRAQA** | Delta Regional Air Quality Authority — the regulator, 4 reference monitors. |
| **Boxtown Air Watch** | Resident CBO. `app_user` holds 18 personas in total — 8 community, 4 regulator, 4 industry, 2 Aclima. |

**Attribution is deliberately ambiguous** — three emitters on three sides. Never let the
UI imply certainty about who is to blame. The honest version is more persuasive, and
ambiguity is *why* an arbitrator of measurement has value.

## The data you're rendering (`data/air.db`, 90 MB)

- **1,307 road segments**, 195.9 km, 7 real districts. 56,889 passes, 95.56 % at ≥25 passes.
- 90 days ending today. 5 vehicles; right now AC-04/AC-05 mid-route, AC-01 charging, AC-03 maintenance.
- 7 modalities (`no2 pm25 bc o3 co co2 ch4`) + 3 indicators (`methane_leak diesel nondiesel`).
- 4 DRAQA reference monitors + 7 Ridgeline fenceline + 2 community porch sensors (13 total). 2,160 h of wind. 28.5k mobile wind observations.
- **Real exceedances exist**: NO2 1-h watch 17 h / NAAQS 5 h (max 120.6 ppb, Riverport Road);
  O3 8-h NAAQS 2 h; PM2.5 24-h NAAQS 21 h during regional smoke episodes.
- **Physics is real**: NO2 near Ridgeline's generators is 2.31× the campaign median overall
  and **3.86× at 03:00**; O3 drops to **0.54×** at night (plume trapped under a 180 m
  boundary layer). Decays to background by 1.5 km — a tight hotspot, not a smear.
- **No reference monitor measures BC, diesel or CH4.** Those action levels are unreachable
  by the regulator's own network. This is the leapfrog argument, and it's a property of
  the data rather than a claim.
- The consultant's dispersion study is **wrong and provably so**: north-half wind assumed
  2.35 % vs measured 6.45 %; inside the wind-shift episode 48.4 %. Boxtown 0.3 % assumed
  vs 23.6 % measured.

## The three cross-role loops — the spine of the demo

1. Community files concerns → ≥3 within 600 m / 24 h form a cluster → alert appears on the
   **industry** radar and in the **regulator** queue.
2. Regulator edits an action level → backend re-evaluates **immediately** → exceedance
   alerts appear or vanish, including in the industry UI. Dragging a threshold is one of
   the best moments in the demo.
3. Industry posts a mitigation → surfaces under the community's concern. **Industry can
   never close a concern** — status only reaches `mitigation_proposed`; `updateConcernStatus`
   rejects `resolved` client-side and the backend returns 403. Reflect the asymmetry
   honestly; don't blur it.

Everything is live over SSE — `core/live.ts` invalidates the right query keys, so an
action in one interface updates another with no refresh.

## Design rules (non-negotiable)

- **Never write a raw hex value.** Semantic tokens only, from `web/src/design/tokens.css`:
  `--bg --surface --surface-2 --ink --ink-2 --ink-3 --line --accent --accent-2 --sev-* --actor-*`.
  The shell sets `data-role` and the whole skin follows.
- **Two measurement ramps, never mixed.** `--ramp-aqi-*` is the public-health ramp (community,
  any "risk" framing). `--ramp-intensity-*` is analytical magnitude (regulator / industry /
  admin). `--ramp-map-*` is the per-role alias the road grid uses.
- All numerals `--font-mono` + `font-variant-numeric: tabular-nums`.
- Uppercase micro-labels at `--text-3xs` / `--tracking-caps`.
- Never colour alone for severity — pair with shape, position or text.
- **`SIMULATED DATA` marker stays visible.** The shell handles it; don't cover it.
- **The road grid is the hero visual** in every interface with a map. Segments coloured by
  magnitude and/or persistence. Not hexbins, not points.
- Community language has **no units and no acronyms** — `measure_def.plain_name` and
  unitless 0–100 risk scores exist for exactly this.

## Ownership

You own `web/src/apps/<your-role>/**` and nothing else. Replace the 27-line placeholder
`routes.tsx` wholesale; export one route object parented to `rootRoute` (pattern in
`web/src/core/README.md`).

Do NOT touch `core/`, `components/`, `app/`, `design/`, `package.json`, other `apps/*`,
`docs/`, or any Python. Need something in shared code, a new component, or a dependency?
**Report it — don't reach across the line.**

## Environment

- `source dev/env.sh` before ANY command (nvm doesn't load in non-interactive shells).
- Backend: `uv run air-server` on :8000. Frontend: `cd web && npm run dev` on :5173.
- **Basemap is MapLibre, not Google** — even though a Google key exists. That key's Cloud
  project forces vector rendering, and vector maps ignore the `styles` array, so every
  role got a stock light basemap. The four skins matter more than the vendor. Just use
  `<BaseMap>`; it resolves the backend for you.
- `npx tsc --noEmit -p tsconfig.app.json` must be clean. **`strict` is ON** and
  `web/src/core/types.ts` is full of `| null` — handle them.
- Unit scales that are easy to get wrong: `freq`/`assumed_freq`/`observed_freq` are
  **percentages 0–100**, `delta` is in **percentage points**, `disagreement` is a
  **0–1 fraction**. The type comments say so; don't mix them.

## Screenshot recipe — use exactly this

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --virtual-time-budget=8000 \
  --screenshot=<path> --window-size=1800,1100 "<url>?live=0"
```

- **`?live=0` is mandatory.** An open SSE stream never reaches network idle and the shot
  hangs forever.
- **Never pass `--disable-gpu`** — that disables WebGL and the map renders blank. WebGL
  works here (ANGLE Metal, M1 Pro).
- **deck.gl DOES capture in headless screenshots.** Verified: 1,307 road segments render
  cleanly. An earlier report claiming otherwise was wrong. A blank map means your data or
  camera is wrong, not the renderer — debug those, don't work around deck.gl.
- **Basemap tiles DO paint — if the dep optimizer is kept off MapLibre.** For most of this
  build the basemap rendered nothing and it was written off as a headless limitation. It was
  not: Vite's dep optimizer dropped `maplibre-gl-worker.mjs`, so the tile-parsing worker never
  started. Style, sprite and tile index all returned 200 and no request failed, while not one
  vector tile was ever parsed — and deck.gl kept drawing on its own overlay canvas, which made
  it look like "the data works, the map is just dark". `optimizeDeps.exclude: ['maplibre-gl']`
  in `web/vite.config.ts` fixes it. If a basemap is ever blank under a working deck.gl overlay,
  grep vite's log for `maplibre-gl-worker.mjs` before blaming the renderer or headless mode.
- **`/gallery.html?role=<role>&backend=maplibre|google`** is a bare map probe — basemap +
  road grid, no router, no SSE. Use it to isolate map problems from your own screens.
- `CVDisplayLinkCreateWithCGDisplay failed` on stderr is harmless noise.
- **Look at your own screenshots and iterate.** Budget is tight — aim for two or three
  focused iterations on the screens that matter, not ten on everything.

Save to `/private/tmp/claude-502/-Users-antonvattay-Workspace-air/78038d1d-015f-47b3-8943-1a31c58fa607/scratchpad/shots/<your-role>/`.
