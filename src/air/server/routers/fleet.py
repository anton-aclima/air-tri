"""/fleet, /drive-plan — vehicle positions and the drive plan.

Non-negotiable #5: community fleet positions are delayed >=3 h. Pass
`role=community` (or an explicit `delay_min`) and positions come back from
`now - delay`, not now.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from air.server import config, domain, shapes, timeutil
from air.server.db import get_db, one, resolve_campaign, rows

router = APIRouter(tags=["fleet"])

TRAIL_POINTS = 40


@router.get("/fleet")
def fleet(
    at: str | None = None,
    delay_min: int | None = None,
    role: str | None = None,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    delay = delay_min if delay_min is not None else (
        config.COMMUNITY_FLEET_DELAY_MIN if role == "community" else 0
    )
    if role == "community":
        delay = max(delay, config.COMMUNITY_FLEET_DELAY_MIN)
    delay = max(0, delay)

    reference = at or domain.data_now(conn, cid)
    effective = timeutil.shift(reference, minutes=-delay) or reference

    out: list[dict[str, Any]] = []
    for v in rows(conn, "SELECT * FROM vehicle WHERE campaign_id=? ORDER BY label", (cid,)):
        trail_rows = rows(
            conn,
            """SELECT p.ts, p.lon, p.lat, p.speed_kph, p.heading_deg, p.segment_id
                 FROM vehicle_ping p JOIN drive d ON d.id = p.drive_id
                WHERE d.vehicle_id = ? AND d.campaign_id = ? AND p.ts <= ?
                ORDER BY p.ts DESC LIMIT ?""",
            (v["id"], cid, effective, TRAIL_POINTS),
        )
        if not trail_rows:
            continue
        head = trail_rows[0]
        trail = [[round(r["lon"], 5), round(r["lat"], 5)] for r in reversed(trail_rows)]
        out.append(
            {
                "vehicle_id": v["id"],
                "label": v["label"],
                "call_sign": v["call_sign"],
                "status": v["status"],
                "lon": head["lon"],
                "lat": head["lat"],
                "heading_deg": head["heading_deg"],
                "speed_kph": head["speed_kph"],
                "segment_id": head["segment_id"],
                "ts": head["ts"],
                "delay_min": delay,
                "trail": trail,
            }
        )
    return out


@router.get("/vehicles")
def list_vehicles(
    campaign_id: str | None = None, conn: sqlite3.Connection = Depends(get_db)
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    return [shapes.vehicle(r) for r in rows(conn, "SELECT * FROM vehicle WHERE campaign_id=? ORDER BY label", (cid,))]


@router.get("/drive-plan")
def list_drive_plans(
    include_routes: bool = False,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    out = []
    for p in rows(
        conn,
        "SELECT * FROM drive_plan WHERE campaign_id=? ORDER BY (status='active') DESC, created_at DESC",
        (cid,),
    ):
        out.append(shapes.drive_plan(p, _routes(conn, p["id"]) if include_routes else []))
    return out


@router.get("/drive-plan/{plan_id}")
def get_drive_plan(
    plan_id: str, include_routes: bool = True, conn: sqlite3.Connection = Depends(get_db)
) -> dict[str, Any]:
    p = one(conn, "SELECT * FROM drive_plan WHERE id=?", (plan_id,))
    if p is None:
        raise HTTPException(404, f"unknown drive plan {plan_id}")
    return shapes.drive_plan(p, _routes(conn, plan_id) if include_routes else [])


def _routes(conn: sqlite3.Connection, plan_id: str) -> list[dict[str, Any]]:
    return [
        shapes.drive_route(r)
        for r in rows(
            conn, "SELECT * FROM drive_route WHERE plan_id=? ORDER BY day_index, vehicle_id", (plan_id,)
        )
    ]


@router.get("/drive-plan/{plan_id}/coverage")
def plan_coverage(plan_id: str, conn: sqlite3.Connection = Depends(get_db)) -> list[dict[str, Any]]:
    p = one(conn, "SELECT * FROM drive_plan WHERE id=?", (plan_id,))
    if p is None:
        raise HTTPException(404, f"unknown drive plan {plan_id}")
    target = p["target_passes"]
    cid = p["campaign_id"]
    # Prefer observed passes; fall back to the primary measure's n_passes.
    counted = {
        r["segment_id"]: r["n"]
        for r in rows(
            conn,
            "SELECT segment_id, COUNT(*) AS n FROM segment_pass WHERE campaign_id=? GROUP BY segment_id",
            (cid,),
        )
    }
    if not counted:
        counted = {
            r["segment_id"]: r["n_passes"]
            for r in rows(
                conn,
                """SELECT segment_id, MAX(n_passes) AS n_passes FROM segment_stat
                    WHERE campaign_id=? AND window='all' GROUP BY segment_id""",
                (cid,),
            )
        }
    out = []
    for r in rows(conn, "SELECT id FROM road_segment WHERE campaign_id=?", (cid,)):
        passes = counted.get(r["id"], 0)
        out.append(
            {
                "segment_id": r["id"],
                "passes": passes,
                "target": target,
                "pct": round(min(100.0, 100.0 * passes / target), 1) if target else 0.0,
            }
        )
    out.sort(key=lambda c: c["pct"])
    return out
