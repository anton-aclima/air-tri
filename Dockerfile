# syntax=docker/dockerfile:1
#
# One image, one process, one URL.
#
# `app.py` already serves `web/dist` at `/` with an SPA fallback, so there is no
# frontend/backend split to deploy — the same container answers `/api/v1/...`
# and hands the React bundle to everything else.
#
# THE LAYOUT IS LOAD-BEARING. `config.REPO_ROOT` is `parents[3]` of
# `src/air/server/config.py`, and `AIR_DB`, `SCHEMA_PATH` and `WEB_DIST` all
# hang off it. So the container keeps the repo's shape under /app and runs from
# PYTHONPATH rather than pip-installing the package — installed into
# site-packages, REPO_ROOT would resolve to site-packages and the server would
# look for the database and the web bundle inside it.

# ── 1. the frontend ──────────────────────────────────────────────────────────
FROM node:22-slim AS web
WORKDIR /web
# Lockfile first: this layer only rebuilds when dependencies actually change.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ── 2. python dependencies ───────────────────────────────────────────────────
FROM python:3.13-slim AS deps
# Pinned to match the uv that wrote uv.lock (0.12.6 -> `version = 1,
# revision = 3`). An older uv cannot read a newer lock revision, and `--frozen`
# then fails rather than silently resolving something else.
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
# --no-install-project: we want the six dependencies, not the package. The
# source tree is copied in below and reached via PYTHONPATH, for the REPO_ROOT
# reason above.
RUN uv sync --frozen --no-install-project --no-dev

# ── 3. runtime ───────────────────────────────────────────────────────────────
FROM python:3.13-slim
WORKDIR /app

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AIR_HOST=0.0.0.0 \
    AIR_RELOAD=0

COPY --from=deps /app/.venv /app/.venv
COPY src/ ./src/
COPY --from=web /web/dist ./web/dist

# The OpenStreetMap extract the world is built from. 748 KB of cached Overpass
# responses, and NOT optional: `osm.py` never re-fetches a cached file, but with
# no cache present it falls through to a live Overpass call. That is what broke
# the first Cloud Build — a mirror returned `0 elements` and the build died
# after ten minutes of work.
#
# Copying it also pins the deployed road network to the same one the demo was
# developed against, rather than whatever Overpass happens to serve on build day.
COPY data/cache/ ./data/cache/

# Generate the demo world at BUILD time, not at boot.
#
# `data/air.db` is gitignored and regenerated here instead of copied, so no
# 100 MB blob travels through the build context. Given the seed and the OSM
# cache above, the generator is deterministic. Costs ~177 s of build time
# natively, roughly 600 s under Docker Desktop's VM on macOS. It was ~110 s
# until P3-A stopped evaluating the plume on a sub-window: the truth field now
# covers the whole raster, which is 1.6x the work and the reason three quarters
# of the road network stopped reading identically zero.
#
# `--now` is deliberately left to default to build time. The generator anchors
# the last shift to it, so the fleet layer is alive the moment the image is
# built. The cost is that the demo clock drifts: a container running a month
# after its build has a "now" past the end of its own data. The app detects
# this (`flags.generated_at`) and offers "Pin to end of data" in the SIMULATED
# DATA panel — but the real fix is to redeploy, which is cheap. See docs/DEPLOY.md.
#
# The other cost, and the reason CLAUDE.md pins `--now` for local rebuilds:
# a deployed container's numbers are anchored to ITS build date and a laptop's
# to `--now`, so the two databases are different worlds. Never compare a
# measurement taken here against one taken there.
RUN python -m air.datagen.build build --seed 20260827 --quiet

# The server writes: acking an alert, filing a concern, editing a threshold.
# SQLite needs write access to the DIRECTORY too, not just the file — WAL mode
# creates `-wal` and `-shm` siblings.
RUN useradd --create-home --uid 10001 air && chown -R air:air /app/data
USER air

EXPOSE 8080

# Cloud Run injects PORT; everything else here reads AIR_PORT.
CMD ["sh", "-c", "AIR_PORT=${PORT:-8080} exec python -m air.server"]
