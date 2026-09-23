"""Shared fixtures.

Two things worth knowing before writing a test here.

**The database is gitignored.** `data/air.db` is ~100 MB and is generated, not
committed, so every DB-backed test carries `@pytest.mark.needs_db` and skips
with a message naming the build command rather than failing on a fresh clone.

**The API lives under a prefix.** `app` mounts every router at
`air_config.API_PREFIX` (`/api/v1`) and then serves the built SPA from a
`/{path:path}` catch-all. A request to `/sites/...` therefore returns **200
with an HTML page**, not a 404 — which is a genuinely nasty way to lose an
afternoon. Use the `api` fixture, never a bare path, and `json_ok` if you want
the content type checked for you.
"""

from __future__ import annotations

import sqlite3
from typing import Any

import pytest

from air.server import config as air_config

pytest_plugins: list[str] = []


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    if air_config.DB_PATH.exists():
        return
    skip = pytest.mark.skip(
        reason=(
            f"no database at {air_config.DB_PATH} — build it with "
            "`python3 -m air.datagen.build build --seed 20260827 --now 2026-08-28T13:54:00`"
        )
    )
    for item in items:
        if "needs_db" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from air.server.app import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def api() -> str:
    """The API prefix. See the module docstring for why this matters."""
    return air_config.API_PREFIX


@pytest.fixture(scope="session")
def db():
    conn = sqlite3.connect(f"file:{air_config.DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture(scope="session")
def campaign(db: sqlite3.Connection) -> dict[str, Any]:
    row = db.execute("SELECT id, start_date, end_date FROM campaign LIMIT 1").fetchone()
    assert row is not None, "no campaign in the database"
    return dict(row)


@pytest.fixture(scope="session")
def campaign_window(campaign: dict[str, Any]) -> dict[str, str]:
    """The whole campaign — what `useCampaignWindow()` sends. See P0-B."""
    return {"from": f"{campaign['start_date']}T00:00:00Z", "to": f"{campaign['end_date']}T23:59:59Z"}


@pytest.fixture(scope="session")
def pinned_build(db: sqlite3.Connection) -> bool:
    """True when this DB was built with the `--now` CLAUDE.md pins.

    Tests that assert a *specific* number rather than a property use this to
    skip on a wall-clock-anchored rebuild, which is a different world (see the
    note beside the Dockerfile's build step).
    """
    row = db.execute("SELECT value FROM setting WHERE key='datagen.now'").fetchone()
    return bool(row) and row[0] == "2026-08-28T13:54:00"


@pytest.fixture(scope="session")
def json_ok():
    """`json_ok(resp)` — assert a real JSON 200, not the SPA catch-all wearing one."""

    def check(resp) -> Any:
        assert resp.status_code == 200, f"{resp.status_code}: {resp.text[:200]}"
        ctype = resp.headers.get("content-type", "")
        assert "json" in ctype, (
            f"expected JSON, got {ctype!r} — wrong path? Every route is under {air_config.API_PREFIX}, "
            "and anything else falls through to the SPA and returns 200 HTML."
        )
        return resp.json()

    return check
