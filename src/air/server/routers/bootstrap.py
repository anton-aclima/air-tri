"""/bootstrap, /campaigns, /activity — everything an interface needs on load."""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from air.server import cache, config, domain, loaders, shapes, timeutil
from air.server.db import get_db, jload, one, resolve_campaign, rows

router = APIRouter(tags=["core"])


def _generated_at(conn: sqlite3.Connection) -> str | None:
    row = one(conn, "SELECT value FROM setting WHERE key = 'datagen.now'", ())
    return row["value"] if row else None


@router.get("/bootstrap")
def bootstrap(
    campaign_id: str | None = None, conn: sqlite3.Connection = Depends(get_db)
) -> dict[str, Any]:
    cid = resolve_campaign(conn, campaign_id)
    key = ("bootstrap", cid)
    hit = cache.get(key)
    if hit is not None:
        return {**hit, "flags": {**hit["flags"], "now": timeutil.now_iso()}}

    camp = one(conn, "SELECT * FROM campaign WHERE id = ?", (cid,))
    payload = {
        "campaign": shapes.campaign(camp),
        "measures": list(domain.measures(conn).values()),
        "orgs": [shapes.org(r) for r in rows(conn, "SELECT * FROM org ORDER BY kind, name")],
        "users": [shapes.user(r) for r in rows(conn, "SELECT * FROM app_user ORDER BY role, name")],
        "action_levels": [
            shapes.action_level(r)
            for r in rows(
                conn,
                "SELECT * FROM action_level WHERE campaign_id=? ORDER BY measure, threshold",
                (cid,),
            )
        ],
        "sites": loaders.load_sites(conn, cid),
        "flags": {
            "advisor_mode": config.advisor_mode(),
            "basemap": config.basemap(),
            "community_fleet_delay_min": config.COMMUNITY_FLEET_DELAY_MIN,
            "simulated": True,
            "now": timeutil.now_iso(),
            # The instant the dataset was generated. Everything in the database
            # stops here, so a client whose wall clock has run past it is asking
            # for a window with nothing in it -- which looks like broken queries
            # rather than the end of the data. The simulation panel uses this to
            # say so out loud and to offer to pin "now" back to it.
            "generated_at": _generated_at(conn),
        },
    }
    cache.put(key, payload)
    return payload


@router.get("/campaigns")
def list_campaigns(conn: sqlite3.Connection = Depends(get_db)) -> list[dict[str, Any]]:
    return [
        shapes.campaign(r)
        for r in rows(conn, "SELECT * FROM campaign ORDER BY (status='active') DESC, created_at DESC")
    ]


@router.get("/campaigns/{cid}")
def get_campaign(cid: str, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    r = one(conn, "SELECT * FROM campaign WHERE id = ?", (cid,))
    if r is None:
        raise HTTPException(404, f"unknown campaign {cid}")
    return shapes.campaign(r)


@router.get("/campaigns/{cid}/boundary")
def campaign_boundary(cid: str, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    r = one(conn, "SELECT boundary_geojson FROM campaign WHERE id = ?", (cid,))
    if r is None:
        raise HTTPException(404, f"unknown campaign {cid}")
    g = jload(r["boundary_geojson"], None)
    if g is None:
        raise HTTPException(500, "campaign boundary is not valid GeoJSON")
    t = g.get("type")
    if t == "FeatureCollection":
        return g
    if t == "Feature":
        return {"type": "FeatureCollection", "features": [g]}
    return {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "geometry": g, "properties": {"campaign_id": cid}}],
    }


@router.get("/activity")
def list_activity(
    since: str | None = None,
    after_id: int | None = None,
    verb: str | None = None,
    limit: int = 200,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    sql = ["SELECT * FROM activity WHERE (campaign_id = ? OR campaign_id IS NULL)"]
    params: list[Any] = [cid]
    if since:
        sql.append("AND ts >= ?")
        params.append(since)
    if after_id:
        sql.append("AND id > ?")
        params.append(after_id)
    if verb:
        sql.append("AND verb LIKE ?")
        params.append(verb.replace("*", "%"))
    sql.append("ORDER BY id DESC LIMIT ?")
    params.append(max(1, min(limit, 2000)))
    return [shapes.activity_item(r) for r in rows(conn, " ".join(sql), params)]


@router.get("/health")
def health(conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    from air.server import bus

    campaigns = rows(conn, "SELECT id, name, status FROM campaign")
    return {
        "ok": True,
        "db": str(config.DB_PATH),
        "campaigns": [dict(r) for r in campaigns],
        "segments": one(conn, "SELECT COUNT(*) AS n FROM road_segment")["n"],
        "advisor_mode": config.advisor_mode(),
        "cache": {**cache.stats, "version": cache.version()},
        "sse_subscribers": bus.subscriber_count(),
        "now": timeutil.now_iso(),
    }
