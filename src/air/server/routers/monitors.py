"""/monitors — the regulator's towers and industry's fenceline rings."""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from air.server import domain, loaders, timeutil
from air.server.db import get_db, one, resolve_campaign, rows

router = APIRouter(tags=["monitors"])


@router.get("/monitors")
def list_monitors(
    owner_type: str | None = None,
    grade: str | None = None,
    site_id: str | None = None,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    return loaders.load_monitors(conn, cid, owner_type=owner_type, grade=grade, site_id=site_id)


@router.get("/monitors/{monitor_id}")
def get_monitor(monitor_id: str, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    r = one(conn, "SELECT campaign_id FROM monitor WHERE id=?", (monitor_id,))
    if r is None:
        raise HTTPException(404, f"unknown monitor {monitor_id}")
    found = loaders.load_monitors(conn, r["campaign_id"], monitor_id=monitor_id)
    return found[0]


@router.get("/monitors/{monitor_id}/readings")
def readings(
    monitor_id: str,
    measure: str = "no2",
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    interval: str = "hour",
    limit: int = 2000,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    mon = one(conn, "SELECT * FROM monitor WHERE id=?", (monitor_id,))
    if mon is None:
        raise HTTPException(404, f"unknown monitor {monitor_id}")
    if interval not in ("hour", "day"):
        raise HTTPException(422, "interval must be hour or day")
    cid = mon["campaign_id"]
    now = domain.data_now(conn, cid)
    to = to or now
    from_ = from_ or (timeutil.shift(to, days=-7) or timeutil.ago(days=7))

    if interval == "day":
        sql = """SELECT substr(ts,1,10) AS t, AVG(value) AS v FROM monitor_reading
                  WHERE monitor_id=? AND measure=? AND ts>=? AND ts<=? AND qc='valid'
                  GROUP BY substr(ts,1,10) ORDER BY t LIMIT ?"""
    else:
        sql = """SELECT ts AS t, value AS v FROM monitor_reading
                  WHERE monitor_id=? AND measure=? AND ts>=? AND ts<=? AND qc='valid'
                  ORDER BY ts LIMIT ?"""
    pts = [
        {"t": r["t"], "v": round(r["v"], 4) if r["v"] is not None else None}
        for r in rows(conn, sql, (monitor_id, measure, from_, to, max(1, min(limit, 20000))))
    ]
    mdef = domain.measures(conn).get(measure, {})
    als = [
        {"id": r["id"], "label": r["label"], "threshold": r["threshold"], "severity": r["severity"]}
        for r in rows(
            conn,
            """SELECT id, label, threshold, severity FROM action_level
                WHERE campaign_id=? AND measure=? AND enabled=1 ORDER BY threshold""",
            (cid, measure),
        )
    ]
    return {
        "monitor_id": monitor_id,
        "measure": measure,
        "unit": mdef.get("unit", ""),
        "interval": interval,
        "points": pts,
        "action_levels": als,
    }
