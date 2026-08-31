"""One timestamp format, parsed permissively.

Stored form is `YYYY-MM-DDTHH:MM:SSZ` (UTC, lexicographically sortable, and
unambiguous for `new Date()` on the frontend). Reads accept anything ISO-ish so
we interoperate with whatever datagen writes.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

FMT = "%Y-%m-%dT%H:%M:%SZ"


def now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).strftime(FMT)


def now_iso() -> str:
    return iso(now())


def parse(text: str | None) -> datetime | None:
    if not text:
        return None
    t = text.strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y-%m-%dT%H:%M"):
            try:
                dt = datetime.strptime(t, fmt)
                break
            except ValueError:
                continue
        else:
            return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


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
