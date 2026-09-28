# air

Aclima's prototype **industry · community · regulator** flagship UI.

One React application, four interfaces, one shared dataset. The product thesis is that
Aclima sits in the middle of a three-way standoff over what the air is actually doing —
and this demo exists to make that tension visible.

> **Everything here is simulated.** Real Memphis street geometry, entirely fictional
> companies, agencies, people, and measurements.

## Setting

Southwest Memphis — the Boxtown / Westwood / Riverport corridor. ~1,000 real 200 m road
segments pulled from OpenStreetMap. Three fictional emitters (a datacenter, a metals
plant, a logistics yard), a fictional state air authority, and a fictional resident
group.

## The four interfaces

| Route | Audience | Narrative |
|---|---|---|
| `/community` | Residents | A social feed. Report a concern, see your neighbours', hear from the agency and the operator. No units, no acronyms. |
| `/regulator` | Agency staff | Tower defense. Their reference monitors are towers with coverage rings, our fleet extends their reach, suspected emitters are contacts. Exact concentrations, editable action levels. |
| `/industry` | Datacenter operator | Their own site on a map: the measured streets, the fenceline road, the wind and today's plume outline, and each alert's bearing, distance, severity and duration — with one recommended action. Glanceable, no analysis required. |
| `/admin` | Aclima | The drafting table. Draw the campaign, generate the drive plan, watch every role at once, fire scripted demo scenarios. |

## Setup

This repo assumes nothing is installed. Node and Python are both managed per-user, no sudo.

```bash
# Node 22 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22

# Python 3.13 via uv
curl -LsSf https://astral.sh/uv/install.sh | sh
uv python install 3.13
```

Then:

```bash
source dev/env.sh          # puts nvm-node and uv on PATH for non-interactive shells
uv sync                    # backend deps
cd web && npm install      # frontend deps
```

Optional keys — the demo runs fully without either:

```bash
cp .env.example .env               # ANTHROPIC_API_KEY → real Claude advisor (else: rules engine)
cp web/.env.example web/.env.local # VITE_GOOGLE_MAPS_API_KEY → Google basemap (else: MapLibre)
```

## Run

```bash
source dev/env.sh
uv run air-datagen build     # generate the simulated campaign into data/air.db (slow, once)
uv run air-server            # API on :8000
cd web && npm run dev        # UI on :5173
```

## Docs

- `docs/CONTRACT.md` — the build contract: data model, API surface, design system, ownership
- `docs/ORIGIN_PROMPT.md` — the original design brief
- `docs/aclima.md` — company and domain background
- `src/air/db/schema.sql` — the shared schema
- `web/src/design/tokens.css` — the design tokens and the four role themes
