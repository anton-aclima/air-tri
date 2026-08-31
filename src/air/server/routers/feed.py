"""/feed — one merged, time-sorted stream per audience.

FeedItem is a discriminated union in types.ts: concern | advisory | post |
mitigation | reading. Everything is merged and sorted newest-first.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends

from air.server import loaders
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
    limit: int = 80,
    include_readings: bool = True,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    items: list[dict[str, Any]] = []

    for c in loaders.load_concerns(conn, cid, since=since, limit=limit * 2):
        items.append({"type": "concern", "at": c["created_at"], "concern": c})

    for a in loaders.load_advisories(conn, cid, audience=role if role != "admin" else None, limit=limit):
        if since and a["created_at"] < since:
            continue
        items.append({"type": "advisory", "at": a["created_at"], "advisory": a})

    for p in loaders.load_posts(conn, cid, limit=limit):
        if since and p["created_at"] < since:
            continue
        items.append({"type": "post", "at": p["created_at"], "post": p})

    sites = {s["id"]: s for s in loaders.load_sites(conn, cid)}
    for m in loaders.load_mitigations(conn, cid, limit=limit):
        if since and m["created_at"] < since:
            continue
        items.append(
            {"type": "mitigation", "at": m["created_at"], "mitigation": m,
             "site": sites.get(m["site_id"])}
        )

    if include_readings:
        thresholds = loaders.spike_thresholds(conn, cid)
        monitors = {m["id"]: m for m in loaders.load_monitors(conn, cid)}
        latest = loaders.latest_readings(conn, cid)
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
