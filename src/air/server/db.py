"""sqlite3 access. Read connections are per-request and query_only; writes go
through a single serialized connection guarded by a lock."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator, Sequence
from typing import Any

from fastapi import HTTPException

from air.server import config

_write_lock = threading.RLock()
_write_conn: sqlite3.Connection | None = None
_ensured = False


def ensure_db() -> None:
    """Create data/air.db from schema.sql if it does not exist yet.

    datagen owns the real seed; this only guarantees the server can boot and
    return empty collections instead of 500s while datagen is still running.
    """
    global _ensured
    if _ensured:
        return
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not config.DB_PATH.exists():
        conn = sqlite3.connect(config.DB_PATH)
        try:
            conn.executescript(config.SCHEMA_PATH.read_text())
            conn.commit()
        finally:
            conn.close()
    _ensured = True


def _tune(conn: sqlite3.Connection) -> None:
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA cache_size = -32000")
    conn.execute("PRAGMA temp_store = MEMORY")


def read_conn() -> sqlite3.Connection:
    """A fresh read-only connection. One per request."""
    ensure_db()
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    _tune(conn)
    conn.execute("PRAGMA query_only = 1")
    return conn


def get_db() -> Iterator[sqlite3.Connection]:
    """FastAPI dependency: connection-per-request, always closed."""
    conn = read_conn()
    try:
        yield conn
    finally:
        conn.close()


def write_conn() -> sqlite3.Connection:
    global _write_conn
    ensure_db()
    if _write_conn is None:
        _write_conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _tune(_write_conn)
        _write_conn.execute("PRAGMA foreign_keys = ON")
    return _write_conn


class Writer:
    """`with writer() as w:` — serialized write transaction."""

    def __enter__(self) -> sqlite3.Connection:
        _write_lock.acquire()
        self.conn = write_conn()
        return self.conn

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self.conn.commit()
            else:
                self.conn.rollback()
        finally:
            _write_lock.release()


def writer() -> Writer:
    return Writer()


# ── query helpers ─────────────────────────────────────────────────────────────

def rows(conn: sqlite3.Connection, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
    return conn.execute(sql, tuple(params)).fetchall()


def one(conn: sqlite3.Connection, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
    return conn.execute(sql, tuple(params)).fetchone()


def scalar(conn: sqlite3.Connection, sql: str, params: Sequence[Any] = (), default: Any = None) -> Any:
    r = conn.execute(sql, tuple(params)).fetchone()
    if r is None or r[0] is None:
        return default
    return r[0]


def jload(text: str | None, default: Any = None) -> Any:
    """Parse a `..._json` TEXT column into real Python data."""
    if text is None or text == "":
        return default
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return default


def boolean(v: Any) -> bool:
    return bool(v)


def resolve_campaign(conn: sqlite3.Connection, campaign_id: str | None = None) -> str:
    """Default every list endpoint to the single active campaign."""
    if campaign_id:
        row = one(conn, "SELECT id FROM campaign WHERE id = ?", (campaign_id,))
        if row is None:
            raise HTTPException(404, f"unknown campaign {campaign_id}")
        return campaign_id
    row = one(
        conn,
        "SELECT id FROM campaign ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1",
    )
    if row is None:
        raise HTTPException(503, "no campaign in the database — run `uv run air-datagen build`")
    return row["id"]
