"""/feed — one merged, time-sorted stream per audience.

FeedItem is a discriminated union in types.ts: concern | advisory | post |
mitigation | reading. Everything is merged and sorted newest-first.

`at` serves the feed as it stood at a moment (replay rewinds events, D2): every
source is bounded by it in SQL before its LIMIT, and the reading items are the
latest readings at or before it. Without `at` the moment is the end of the data.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends

from air.server import domain, loaders
from air.server.db import get_db, resolve_campaign

router = APIRouter(tags=["feed"])

# How many monitor readings may ride in the stream, per audience.
#
# Readings all carry the same latest-hour timestamp, so a pure time sort floats
# every one of them above every human post. For a regulator that is correct --
# instruments are the job. For a resident it buries the neighbours under a wall
# of identical "a regional air agency monitor" cards, which is the opposite of
# what this feed is for. Hence "one merged stream *per audience*".
MAX_READINGS = 5
MAX_READINGS_COMMUNITY = 1


@router.get("/feed")
def feed(
    role: str = "community",
    since: str | None = None,
    at: str | None = None,
    limit: int = 80,
    include_readings: bool = True,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    now = domain.as_of(conn, cid, at)
    items: list[dict[str, Any]] = []

    for c in loaders.load_concerns(conn, cid, since=since, until=now, limit=limit * 2):
        items.append({"type": "concern", "at": c["created_at"], "concern": c})

    for a in loaders.load_advisories(
        conn, cid, audience=role if role != "admin" else None, until=now, limit=limit
    ):
        if since and a["created_at"] < since:
            continue
        items.append({"type": "advisory", "at": a["created_at"], "advisory": a})

    for p in loaders.load_posts(conn, cid, until=now, limit=limit):
        if since and p["created_at"] < since:
            continue
        items.append({"type": "post", "at": p["created_at"], "post": p})

    sites = {s["id"]: s for s in loaders.load_sites(conn, cid)}
    for m in loaders.load_mitigations(conn, cid, until=now, limit=limit):
        if since and m["created_at"] < since:
            continue
        items.append(
            {"type": "mitigation", "at": m["created_at"], "mitigation": m,
             "site": sites.get(m["site_id"])}
        )

    if include_readings:
        thresholds = loaders.spike_thresholds(conn, cid)
        # As of `now`, and the monitor object with it: its `latest` block rides
        # in the item, so building it at the end of the data would put August's
        # reading on a June card.
        monitors = {m["id"]: m for m in loaders.load_monitors(conn, cid, at=now)}
        latest = loaders.latest_readings(conn, cid, at=now)
        hot: list[tuple[str, dict, str, float]] = []
        for mid, per_measure in latest.items():
            for measure, v in per_measure.items():
                if v["exceeds"] and mid in monitors:
                    hot.append((v["ts"], monitors[mid], measure, v["value"]))
        # Sort on the timestamp and the measure only. A bare `sort(reverse=True)`
        # compares tuples element by element, so two monitors exceeding in the
        # same hour -- which is the normal case, not a rare one, since readings
        # are hourly and there are thirteen instruments -- fall through to
        # comparing the monitor dicts and raise TypeError.
        hot.sort(key=lambda h: (h[0], h[2]), reverse=True)
        cap = MAX_READINGS_COMMUNITY if role == "community" else MAX_READINGS
        for ts, mon, measure, value in hot[:cap]:
            if since and ts < since:
                continue
            t = thresholds.get(measure)
            items.append(
                {"type": "reading", "at": ts, "monitor": mon, "measure": measure,
                 "value": value, "exceeds": bool(t is not None and value > t)}
            )

    items.sort(key=lambda i: i["at"] or "", reverse=True)
    return items[:limit]
