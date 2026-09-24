"""One timestamp format, parsed permissively — and one clock.

THE FORMAT
----------
Everything is naive campaign-local time, `YYYY-MM-DDTHH:MM:SS`, no `Z`, no
offset. That is what datagen writes (build.py: "naive local campaign time,
America/Chicago"), so it is what every row in the database already holds.

This module used to write `...Z` (UTC) while the data it read was naive, and the
server compared the two as strings. The browser then read the naive rows as
local time and the `Z` rows as UTC, so anything the server stamped — a new
report, an acknowledgement, `flags.now` — drifted by the viewer's UTC offset.
The digits are the truth; nothing here converts them. `parse` still accepts a
`Z` or an offset, and deliberately ignores it rather than converting, so a
client that sends one gets the hour it wrote, not a shifted one.

THE CLOCK
---------
`now()` is the DEMO's now: the instant the data was built
(`setting('datagen.now')`), frozen. It is not the wall clock. The data ends
there, so a server whose "now" kept ticking read an empty world within hours —
no wind in the window, a dead plume, every "up for" duration inflating — and
the community fleet delay (non-negotiable 5) failed once the wall clock passed
the newest ping. The owner's decision (docs/PLAN-refocus.md D1): time is always
constrained to the simulation, and at the end it is paused, not live.

A database with no build stamp (the smoke-test fixture, a half-built one) gets
ONE fallback, here, for writes and reads alike: the newest reading or pass in
the data. It used to be split — writes fell back to the wall clock (in UTC
digits, labelled as Chicago time) while `domain.data_now` bounded reads by the
newest row — so on data/air_smoketest.db a new report was stamped Sep 24 02:23
against a read bound of Aug 27 23:10, and never appeared on any list it was
filed to. Only an empty database falls through to the wall clock, read in the
campaign's zone.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

FMT = "%Y-%m-%dT%H:%M:%S"

_demo: tuple[int, datetime | None] | None = None


CAMPAIGN_TZ = "America/Chicago"


def _wall() -> datetime:
    """The wall clock in campaign digits — the last resort, for an empty
    database. Not UTC: every stored stamp is Chicago time, and UTC digits sort
    five or six hours after the same instant written the way the data is."""
    try:
        zone = ZoneInfo(CAMPAIGN_TZ)
    except ZoneInfoNotFoundError:  # a slim image without tzdata
        return datetime.now().replace(microsecond=0)
    return datetime.now(zone).replace(microsecond=0, tzinfo=None)


def _scalar(conn: sqlite3.Connection, sql: str) -> str | None:
    try:
        row = conn.execute(sql).fetchone()
    except sqlite3.Error:  # a table that is not there yet
        return None
    return row[0] if row and row[0] else None


def _build_stamp() -> datetime | None:
    """The demo's now from the live database: `setting('datagen.now')`, else
    the newest monitor reading or segment pass (see THE CLOCK), else None.

    Each MAX(ts) is a covering-index scan (ix_reading_time, ix_pass_time),
    about 3 ms on the 90-day build, and this runs once per cache version, not
    per request. Over the whole database rather than per campaign: the write
    clock has no campaign to ask about, and one campaign is all datagen makes."""
    from air.server import config

    try:
        conn = sqlite3.connect(f"file:{config.DB_PATH}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        stamp = _scalar(conn, "SELECT value FROM setting WHERE key='datagen.now'")
        if stamp is None:
            newest = [
                _naive(_scalar(conn, "SELECT MAX(ts) FROM monitor_reading")),
                _naive(_scalar(conn, "SELECT MAX(ts) FROM segment_pass")),
            ]
            return max((t for t in newest if t is not None), default=None)
    finally:
        conn.close()
    return _naive(stamp)


def now() -> datetime:
    """The demo's now: the build instant, frozen. Cached per cache version, so
    a reseed (which bumps the version) picks up the new build stamp. This is
    the server's only "now": `domain.data_now` returns it."""
    global _demo
    from air.server import cache

    version = cache.version()
    if _demo is None or _demo[0] != version:
        _demo = (version, _build_stamp())
    return _demo[1] or _wall()


def iso(dt: datetime) -> str:
    return dt.replace(tzinfo=None).strftime(FMT)


def now_iso() -> str:
    return iso(now())


def _naive(text: str | None) -> datetime | None:
    if not text:
        return None
    t = text.strip()
    # Drop a trailing Z or offset: the digits are campaign time (see above).
    if t.endswith("Z"):
        t = t[:-1]
    elif len(t) > 19 and t[19] in "+-":
        t = t[:19]
    elif len(t) > 19 and t[19] == ".":
        t = t[:19]
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(t, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(t).replace(tzinfo=None)
    except ValueError:
        return None


def parse(text: str | None) -> datetime | None:
    """Naive campaign time. Kept tz-aware (UTC) for arithmetic with the callers
    that already expect an aware datetime; the digits are never shifted."""
    dt = _naive(text)
    return None if dt is None else dt.replace(tzinfo=UTC)


def shift(text: str | None, **delta) -> str | None:
    dt = parse(text)
    return None if dt is None else iso(dt + timedelta(**delta))


def ago(**delta) -> str:
    return iso(now() - timedelta(**delta))


def hour_key(text: str | None) -> str | None:
    dt = parse(text)
    return None if dt is None else dt.strftime("hour:%H")


def date_key(text: str | None) -> str | None:
    dt = parse(text)
    return None if dt is None else dt.strftime("%Y-%m-%d")
