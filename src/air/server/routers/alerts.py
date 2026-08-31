"""/alerts — the shared bus, and the RWR geometry.

`GET /alerts?site_id=X` is the industry radar feed. Every alert comes back with
`bearing_deg` (0-360 true bearing from the site centroid to the alert location)
and `distance_m`. That derived geometry *is* the radar scope.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from air.server import domain, loaders, shapes, timeutil
from air.server.db import get_db, one, resolve_campaign, rows, scalar, writer
from air.server.models import AckIn

router = APIRouter(tags=["alerts"])


@router.get("/alerts")
def list_alerts(
    role: str | None = None,
    status: str | None = None,
    severity: str | None = None,
    kind: str | None = None,
    site_id: str | None = None,
    radius_m: float | None = None,
    since: str | None = None,
    limit: int = 300,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    found = loaders.load_alerts(
        conn, cid, role=role, status=status, severity=severity, kind=kind, since=since, limit=limit
    )
    if site_id:
        found = loaders.alert_geometry(conn, found, site_id, radius_m)
    return found


@router.get("/alerts/{alert_id}")
def get_alert(
    alert_id: str, site_id: str | None = None, conn: sqlite3.Connection = Depends(get_db)
) -> dict[str, Any]:
    row = one(conn, "SELECT * FROM alert WHERE id=?", (alert_id,))
    if row is None:
        raise HTTPException(404, f"unknown alert {alert_id}")
    cid = row["campaign_id"]
    a = shapes.alert(row)

    a["samples"] = [
        {"t": r["ts"], "v": r["value"]}
        for r in rows(conn, "SELECT ts, value FROM alert_sample WHERE alert_id=? ORDER BY ts", (alert_id,))
    ]

    # Related concerns: the cluster this alert came from, or anything nearby.
    concerns: list[dict[str, Any]] = []
    if row["kind"] == "concern_cluster" and row["source_id"]:
        concerns = loaders.load_concerns(conn, cid, cluster_id=row["source_id"])
    elif row["lon"] is not None and row["lat"] is not None:
        concerns = loaders.load_concerns(
            conn, cid, since=timeutil.shift(row["started_at"], hours=-48),
            near=(row["lon"], row["lat"], 900.0), limit=40,
        )
    a["concerns"] = concerns
    a["mitigations"] = loaders.load_mitigations(conn, cid, alert_id=alert_id)
    a["acknowledged_by"] = [
        {"user_id": r["user_id"], "name": r["name"], "note": r["note"], "created_at": r["created_at"]}
        for r in rows(
            conn,
            """SELECT k.user_id, k.note, k.created_at, u.name FROM alert_ack k
                 LEFT JOIN app_user u ON u.id = k.user_id
                WHERE k.alert_id=? ORDER BY k.created_at""",
            (alert_id,),
        )
    ]
    if site_id:
        geom = loaders.alert_geometry(conn, [a], site_id)
        if geom:
            a = geom[0]
    return a


@router.post("/alerts/{alert_id}/acknowledge")
def acknowledge(
    alert_id: str,
    payload: AckIn = Body(default_factory=AckIn),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    row = one(conn, "SELECT * FROM alert WHERE id=?", (alert_id,))
    if row is None:
        raise HTTPException(404, f"unknown alert {alert_id}")
    cid = row["campaign_id"]
    now = timeutil.now_iso()
    with writer() as w:
        user_id = payload.user_id or scalar(
            w, "SELECT id FROM app_user WHERE role='industry' ORDER BY id LIMIT 1"
        ) or scalar(w, "SELECT id FROM app_user ORDER BY id LIMIT 1")
        if user_id is None:
            raise HTTPException(409, "no user available to acknowledge")
        w.execute(
            "INSERT OR REPLACE INTO alert_ack (alert_id, user_id, note, created_at) VALUES (?,?,?,?)",
            (alert_id, user_id, payload.note, now),
        )
        if row["status"] == "active":
            w.execute("UPDATE alert SET status='acknowledged' WHERE id=?", (alert_id,))
        wire = shapes.alert(one(w, "SELECT * FROM alert WHERE id=?", (alert_id,)))
        role = scalar(w, "SELECT role FROM app_user WHERE id=?", (user_id,)) or "industry"
        domain.log(
            w, "alert.acknowledged", campaign_id=cid, actor_role=role, actor_id=user_id,
            object_type="alert_ack", object_id=alert_id,
            summary=f"{row['title']} acknowledged", payload={"note": payload.note},
            obj=wire, event="alert",
        )
    return wire
