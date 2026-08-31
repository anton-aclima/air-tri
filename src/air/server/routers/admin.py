"""/admin — the drafting table: drive-plan regeneration, reseed, Demo Director."""

from __future__ import annotations

import json
import math
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from air.server import cache, domain, geo, sim, timeutil
from air.server.db import get_db, one, resolve_campaign, rows, writer
from air.server.models import DrivePlanIn, ReseedIn, SimulateIn

router = APIRouter(tags=["admin"])

# A vehicle covers roughly this much road per hour of shift, allowing for
# turnarounds and repeat traverses.
KM_PER_SHIFT_HOUR = 18.0


@router.get("/admin/scenarios")
def scenarios() -> list[dict[str, str]]:
    return [{"scenario": k, "description": v} for k, v in sim.SCENARIOS.items()]


@router.post("/admin/simulate")
def simulate(payload: SimulateIn, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    """Fire a scripted demo event. Writes real rows; the effect propagates through
    the normal machinery and out of the SSE stream."""
    cid = resolve_campaign(conn, payload.campaign_id)
    with writer() as w:
        result = sim.run(w, cid, payload.scenario, payload.site_id)
    return {"campaign_id": cid, "at": timeutil.now_iso(), **result}


@router.post("/admin/reseed")
def reseed(
    payload: ReseedIn = ReseedIn(), conn: sqlite3.Connection = Depends(get_db)
) -> dict[str, Any]:
    """Hand off to datagen, which owns generation. Falls back to reporting how to
    run it — the server never fabricates a campaign."""
    cache.invalidate()
    try:
        from air import datagen  # type: ignore
    except ImportError:
        raise HTTPException(
            503,
            detail={
                "error": "datagen_unavailable",
                "message": "src/air/datagen is not importable yet. Run `uv run air-datagen build`.",
            },
        ) from None

    entry = next(
        (getattr(datagen, name) for name in ("reseed", "build", "main", "run") if callable(getattr(datagen, name, None))),
        None,
    )
    if entry is None:
        raise HTTPException(
            503,
            detail={
                "error": "datagen_no_entrypoint",
                "message": (
                    "air.datagen exposes no reseed()/build()/main() callable. "
                    "Run `uv run air-datagen build` from the CLI instead."
                ),
            },
        )
    try:
        out = entry(seed=payload.seed) if payload.seed is not None else entry()
    except TypeError:
        out = entry()
    cache.invalidate()
    with writer() as w:
        domain.log(
            w, "campaign.reseeded", actor_role="admin", object_type="campaign",
            summary=f"datagen reseed (seed={payload.seed})", payload={"seed": payload.seed},
        )
    return {"ok": True, "seed": payload.seed, "datagen": str(out) if out is not None else None}


@router.post("/admin/campaigns/{cid}/drive-plan")
def regenerate_drive_plan(
    cid: str, payload: DrivePlanIn, conn: sqlite3.Connection = Depends(get_db)
) -> dict[str, Any]:
    """Regenerate a drive plan over the campaign's real segments.

    A boustrophedon sweep (serpentine north-to-south, alternating east/west) is a
    cheap stand-in for the Chinese-postman routing datagen does: it keeps each
    day's route spatially coherent, which is what the admin map needs to look
    right, and it is deterministic given `seed`.
    """
    camp = one(conn, "SELECT * FROM campaign WHERE id=?", (cid,))
    if camp is None:
        raise HTTPException(404, f"unknown campaign {cid}")

    segs = rows(
        conn,
        """SELECT id, name, length_m, mid_lon, mid_lat, geometry_json
             FROM road_segment WHERE campaign_id=?""",
        (cid,),
    )
    if not segs:
        raise HTTPException(409, "campaign has no road segments — run datagen first")

    # Serpentine order: band by latitude, alternate direction per band.
    lats = [s["mid_lat"] for s in segs]
    lo, hi = min(lats), max(lats)
    bands = max(4, int(math.sqrt(len(segs))))
    span = (hi - lo) or 1e-6

    def order_key(s: sqlite3.Row) -> tuple[int, float]:
        band = min(bands - 1, int((hi - s["mid_lat"]) / span * bands))
        return (band, s["mid_lon"] if band % 2 == 0 else -s["mid_lon"])

    ordered = sorted(segs, key=order_key)

    total_m = sum(s["length_m"] or 0 for s in ordered)
    fleet = payload.fleet_size
    km_per_shift = KM_PER_SHIFT_HOUR * payload.shift_hours
    routes_per_day = fleet
    chunk = max(1, math.ceil(len(ordered) / routes_per_day))
    # Each vehicle owns one chunk and re-drives it as many times as its shift
    # allows; that lap count is how fast passes accumulate.
    chunk_km = max(0.05, (total_m / 1000.0) / routes_per_day * 1.35)
    laps_per_shift = max(1, int(km_per_shift // chunk_km))
    days = max(1, math.ceil(payload.target_passes / laps_per_shift))
    shifts = ("morning", "midday", "evening", "night")

    vehicles = [r["id"] for r in rows(conn, "SELECT id FROM vehicle WHERE campaign_id=? ORDER BY label", (cid,))]
    plan_id = domain.new_id("dp")
    now = timeutil.now_iso()
    start = timeutil.parse(camp["start_date"] + "T06:00:00Z")

    with writer() as w:
        w.execute("UPDATE drive_plan SET status='archived' WHERE campaign_id=? AND status='active'", (cid,))
        w.execute(
            """INSERT INTO drive_plan (id, campaign_id, name, fleet_size, target_passes, status,
                                       params_json, stats_json, created_at)
               VALUES (?,?,?,?,?, 'active', ?,?,?)""",
            (plan_id, cid, payload.name or f"Plan {now[:10]} · {fleet} vehicles",
             fleet, payload.target_passes,
             json.dumps({"fleet_size": fleet, "target_passes": payload.target_passes,
                         "shift_hours": payload.shift_hours, "seed": payload.seed,
                         "km_per_shift_hour": KM_PER_SHIFT_HOUR}),
             json.dumps({}), now),
        )
        route_count = 0
        for day in range(days):
            date = timeutil.iso(start)[:10] if start else None
            if start is not None:
                from datetime import timedelta

                start = start + timedelta(days=1)
            for v in range(routes_per_day):
                block = ordered[v * chunk:(v + 1) * chunk]
                if not block:
                    continue
                # Rotate the block per day so coverage is not identical each day.
                shift_by = (day * 7) % len(block)
                block = block[shift_by:] + block[:shift_by]
                coords: list[list[float]] = []
                for s in block:
                    g = json.loads(s["geometry_json"] or "[]")
                    coords += [[round(float(c[0]), 5), round(float(c[1]), 5)] for c in g if c]
                dist = sum(s["length_m"] or 0 for s in block)
                for a, b in zip(block, block[1:]):
                    dist += geo.haversine_m(a["mid_lon"], a["mid_lat"], b["mid_lon"], b["mid_lat"]) * 0.35
                w.execute(
                    """INSERT INTO drive_route (id, plan_id, campaign_id, vehicle_id, day_index, date,
                                                shift, segment_ids_json, geometry_json, distance_m,
                                                duration_min, est_passes)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (domain.new_id("dr"), plan_id, cid,
                     vehicles[v % len(vehicles)] if vehicles else None,
                     day, date, shifts[(day + v) % len(shifts)],
                     json.dumps([s["id"] for s in block]), json.dumps(coords),
                     round(dist * laps_per_shift, 1),
                     round(dist * laps_per_shift / 1000.0 / 24.0 * 60.0, 1), laps_per_shift),
                )
                route_count += 1

        achieved = min(float(payload.target_passes), days * laps_per_shift)
        assigned = min(len(ordered), routes_per_day * chunk)
        stats = {
            "total_segments": len(ordered),
            "total_km": round(total_m / 1000.0, 1),
            "days_to_target": days,
            "km_per_vehicle_day": round(km_per_shift, 1),
            "coverage_pct": round(100.0 * assigned / len(ordered), 1),
            "mean_passes": round(achieved, 1),
            "segments_below_target": len(ordered) - assigned if achieved >= payload.target_passes else len(ordered),
            "laps_per_shift": laps_per_shift,
        }
        w.execute("UPDATE drive_plan SET stats_json=? WHERE id=?", (json.dumps(stats), plan_id))
        w.execute(
            "UPDATE campaign SET fleet_size=?, target_passes=? WHERE id=?",
            (fleet, payload.target_passes, cid),
        )
        plan_row = one(w, "SELECT * FROM drive_plan WHERE id=?", (plan_id,))
        from air.server import shapes

        wire = shapes.drive_plan(plan_row, [])
        domain.log(
            w, "drive_plan.regenerated", campaign_id=cid, actor_role="admin",
            object_type="drive_plan", object_id=plan_id,
            summary=f"{fleet} vehicles · {payload.target_passes} passes · {days} days · {route_count} routes",
            payload={"stats": stats, "params": wire["params"], "routes": route_count},
            obj=wire, event="fleet",
        )
    # `wire["stats"]` is filtered to exactly the DrivePlan.stats keys in
    # types.ts; laps_per_shift is an extra readout for the admin panel.
    return {**wire, "routes_created": route_count, "laps_per_shift": stats["laps_per_shift"]}
