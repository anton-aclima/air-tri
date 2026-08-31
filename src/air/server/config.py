"""Paths, environment and tunable knobs. No DB or FastAPI imports here."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# src/air/server/config.py -> src/air/server -> src/air -> src -> <repo root>
REPO_ROOT = Path(__file__).resolve().parents[3]

load_dotenv(REPO_ROOT / ".env", override=False)

DB_PATH = Path(os.environ.get("AIR_DB", REPO_ROOT / "data" / "air.db")).resolve()
SCHEMA_PATH = REPO_ROOT / "src" / "air" / "db" / "schema.sql"
WEB_DIST = REPO_ROOT / "web" / "dist"

API_PREFIX = "/api/v1"

HOST = os.environ.get("AIR_HOST", "127.0.0.1")
PORT = int(os.environ.get("AIR_PORT", "8000"))
RELOAD = os.environ.get("AIR_RELOAD", "1") not in ("0", "false", "False", "")

CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]

# ── demo knobs ────────────────────────────────────────────────────────────────
COMMUNITY_FLEET_DELAY_MIN = int(os.environ.get("AIR_COMMUNITY_DELAY_MIN", "180"))
CLUSTER_RADIUS_M = float(os.environ.get("AIR_CLUSTER_RADIUS_M", "600"))
CLUSTER_WINDOW_H = float(os.environ.get("AIR_CLUSTER_WINDOW_H", "24"))
CLUSTER_MIN_COUNT = int(os.environ.get("AIR_CLUSTER_MIN_COUNT", "3"))
SEGMENT_COORD_DECIMALS = 5
SEGMENT_DEFAULT_LIMIT = int(os.environ.get("AIR_SEGMENT_LIMIT", "4000"))
SSE_HEARTBEAT_S = 15.0

# ── advisor ───────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_MODEL = os.environ.get("AIR_ADVISOR_MODEL", "claude-opus-5")
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
ADVISOR_TIMEOUT_S = float(os.environ.get("AIR_ADVISOR_TIMEOUT_S", "45"))
ADVISOR_EFFORT = os.environ.get("AIR_ADVISOR_EFFORT", "low")
# `POST /advisor` always answers instantly from the rules engine; this controls
# whether it also starts the streaming model upgrade behind that answer.
ADVISOR_UPGRADE = os.environ.get("AIR_ADVISOR_UPGRADE", "1") not in ("0", "false", "False", "")
# Fast mode: research preview, Claude API only, Opus 5 / Opus 4.8 only. Same
# model at up to 2.5x output tokens/sec, at premium pricing ($10/$50 per MTok),
# drawing on a separate rate-limit pool. Opt-in — a demo should not silently
# cost double. Falls back to a standard request if the beta is not enabled.
ADVISOR_FAST = os.environ.get("AIR_ADVISOR_FAST", "0") not in ("0", "false", "False", "")

GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()


def advisor_mode() -> str:
    return "llm" if ANTHROPIC_API_KEY else "rules"


def basemap() -> str:
    return "google" if GOOGLE_MAPS_API_KEY else "maplibre"
