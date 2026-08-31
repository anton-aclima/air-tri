"""/concerns, /clusters — the community side, and LOOP 1.

POST /concerns runs cluster detection inline: >=3 concerns within 600 m and 24 h
form a `concern_cluster`, which emits an alert addressed to industry + regulator
at the cluster centroid with `site_id` set to the nearest industry site.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query

from air.server import domain, loaders, shapes, timeutil
from air.server.db import get_db, one, resolve_campaign, rows, scalar, writer
from air.server.models import ConcernIn, ConcernPatch, ConcernResponseIn, CorroborateIn

router = APIRouter(tags=["concerns"])


def _parse_near(near: str | None) -> tuple[float, float, float] | None:
    if not near:
        return None
    try:
        lon, lat, radius = (float(x) for x in near.split(","))
    except ValueError:
        raise HTTPException(422, "near must be lon,lat,radius_m") from None
    return (lon, lat, radius)


@router.get("/concerns")
def list_concerns(
    status: str | None = None,
    kind: str | None = None,
    since: str | None = None,
    near: str | None = Query(None, description="lon,lat,radius_m"),
    cluster_id: str | None = None,
    limit: int = 500,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    return loaders.load_concerns(
        conn, cid, status=status, kind=kind, since=since,
        cluster_id=cluster_id, near=_parse_near(near), limit=limit,
    )


@router.get("/concerns/{concern_id}")
def get_concern(concern_id: str, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    r = one(conn, "SELECT campaign_id FROM concern WHERE id=?", (concern_id,))
    if r is None:
        raise HTTPException(404, f"unknown concern {concern_id}")
    found = loaders.load_concerns(conn, r["campaign_id"], concern_id=concern_id)
    return found[0]


@router.get("/clusters")
def list_clusters(
    status: str | None = None,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    sql = ["SELECT * FROM concern_cluster WHERE campaign_id = ?"]
    params: list[Any] = [cid]
    if status:
        sql.append("AND status = ?")
        params.append(status)
    sql.append("ORDER BY last_at DESC")
    return [shapes.concern_cluster(r) for r in rows(conn, " ".join(sql), params)]


# ── writes ────────────────────────────────────────────────────────────────────

@router.post("/concerns", status_code=201)
def create_concern(payload: ConcernIn, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    cid = resolve_campaign(conn, payload.campaign_id)
    now = timeutil.now_iso()
    occurred = payload.occurred_at or now
    concern_id = domain.new_id("cn")

    author_id = payload.author_id
    district = payload.district

    with writer() as w:
        if author_id is None and not payload.is_anonymous:
            author_id = scalar(
                w, "SELECT id FROM app_user WHERE role='community' ORDER BY id LIMIT 1"
            )
        if district is None:
            district = scalar(
                w,
                """SELECT district FROM road_segment WHERE campaign_id=? AND district IS NOT NULL
                    ORDER BY (mid_lon-?)*(mid_lon-?) + (mid_lat-?)*(mid_lat-?) LIMIT 1""",
                (cid, payload.lon, payload.lon, payload.lat, payload.lat),
            )
        near_site = domain.nearest_site(w, cid, payload.lon, payload.lat)
        w.execute(
            """INSERT INTO concern (id, campaign_id, author_id, kind, severity, title, body,
                                    lon, lat, address_hint, district, occurred_at, created_at,
                                    status, cluster_id, corroborations, is_anonymous, photo_emoji,
                                    suspected_site_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'new', NULL, 0, ?, ?, ?)""",
            (concern_id, cid, author_id, payload.kind, payload.severity, payload.title, payload.body,
             payload.lon, payload.lat, payload.address_hint, district, occurred, now,
             1 if payload.is_anonymous else 0, payload.photo_emoji,
             payload.suspected_site_id or (near_site["id"] if near_site else None)),
        )
        wire = loaders.load_concerns(w, cid, concern_id=concern_id)[0]
        domain.log(
            w, "concern.created", campaign_id=cid, actor_role="community", actor_id=author_id,
            object_type="concern", object_id=concern_id, summary=payload.title,
            payload={"kind": payload.kind, "severity": payload.severity, "district": district},
            obj=wire,
        )
        # LOOP 1
        clustered = domain.detect_cluster(w, cid, concern_id)
        wire = loaders.load_concerns(w, cid, concern_id=concern_id)[0]

    return {**wire, "cluster": clustered["cluster"] if clustered else None,
            "cluster_alert": clustered["alert"] if clustered else None}


@router.post("/concerns/{concern_id}/corroborate")
def corroborate(
    concern_id: str,
    payload: CorroborateIn = Body(default_factory=CorroborateIn),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    row = one(conn, "SELECT * FROM concern WHERE id=?", (concern_id,))
    if row is None:
        raise HTTPException(404, f"unknown concern {concern_id}")
    cid = row["campaign_id"]
    with writer() as w:
        user_id = payload.user_id or scalar(
            w,
            """SELECT id FROM app_user WHERE role='community'
                AND id NOT IN (SELECT user_id FROM concern_corroboration WHERE concern_id=?)
                AND id IS NOT ? ORDER BY id LIMIT 1""",
            (concern_id, row["author_id"]),
        )
        if user_id is None:
            raise HTTPException(409, "no community user left to corroborate")
        exists = one(
            w, "SELECT 1 FROM concern_corroboration WHERE concern_id=? AND user_id=?",
            (concern_id, user_id),
        )
        if exists:
            raise HTTPException(409, "already corroborated by that user")
        w.execute(
            "INSERT INTO concern_corroboration (concern_id, user_id, created_at) VALUES (?,?,?)",
            (concern_id, user_id, timeutil.now_iso()),
        )
        w.execute(
            "UPDATE concern SET corroborations = corroborations + 1 WHERE id=?", (concern_id,)
        )
        if row["status"] == "new":
            w.execute("UPDATE concern SET status='corroborated' WHERE id=?", (concern_id,))
        wire = loaders.load_concerns(w, cid, concern_id=concern_id)[0]
        domain.log(
            w, "concern.corroborated", campaign_id=cid, actor_role="community", actor_id=user_id,
            object_type="concern", object_id=concern_id,
            summary=f"“{row['title']}” corroborated ({wire['corroborations']})",
            payload={"corroborations": wire["corroborations"]}, obj=wire,
        )
    return wire


@router.post("/concerns/{concern_id}/responses", status_code=201)
def add_response(
    concern_id: str, payload: ConcernResponseIn, conn: sqlite3.Connection = Depends(get_db)
) -> dict[str, Any]:
    row = one(conn, "SELECT * FROM concern WHERE id=?", (concern_id,))
    if row is None:
        raise HTTPException(404, f"unknown concern {concern_id}")
    cid = row["campaign_id"]
    rid = domain.new_id("cr")
    now = timeutil.now_iso()
    with writer() as w:
        org_id = payload.org_id
        if org_id is None and payload.author_id:
            org_id = scalar(w, "SELECT org_id FROM app_user WHERE id=?", (payload.author_id,))
        w.execute(
            """INSERT INTO concern_response (id, concern_id, author_id, org_id, role, kind, body, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (rid, concern_id, payload.author_id, org_id, payload.role, payload.kind, payload.body, now),
        )
        # A mitigation response is exactly as far as industry may move a concern.
        if payload.kind == "mitigation" and row["status"] not in domain.INDUSTRY_FORBIDDEN_STATUS:
            w.execute("UPDATE concern SET status='mitigation_proposed' WHERE id=?", (concern_id,))
        elif payload.role == "regulator" and payload.kind in ("acknowledge", "finding") \
                and row["status"] in ("new", "corroborated"):
            w.execute("UPDATE concern SET status='under_review' WHERE id=?", (concern_id,))
        r = one(
            w,
            """SELECT cr.*, o.name AS org_name FROM concern_response cr
                 LEFT JOIN org o ON o.id = cr.org_id WHERE cr.id=?""",
            (rid,),
        )
        wire = shapes.concern_response(r)
        domain.log(
            w, f"concern.{payload.kind}", campaign_id=cid, actor_role=payload.role,
            actor_id=payload.author_id, object_type="concern_response", object_id=rid,
            summary=f"{payload.role} responded to “{row['title']}”",
            payload={"concern_id": concern_id, "kind": payload.kind}, obj=wire,
        )
    return wire


@router.patch("/concerns/{concern_id}")
def patch_concern(
    concern_id: str,
    payload: ConcernPatch,
    x_air_role: str | None = Header(None, alias="X-Air-Role"),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Status transitions. Non-negotiable #4: industry can never close a concern."""
    row = one(conn, "SELECT * FROM concern WHERE id=?", (concern_id,))
    if row is None:
        raise HTTPException(404, f"unknown concern {concern_id}")
    role = payload.role or x_air_role or "regulator"

    if payload.status in domain.INDUSTRY_FORBIDDEN_STATUS and role not in ("regulator", "admin"):
        raise HTTPException(
            403,
            detail={
                "error": "forbidden_status_transition",
                "message": (
                    f"role '{role}' may not set a community concern to '{payload.status}'. "
                    "Only the regulator or an Aclima admin can resolve or close a concern; "
                    "industry may propose a mitigation ('mitigation_proposed')."
                ),
                "allowed": ["under_review", "mitigation_proposed"] if role == "industry" else [],
            },
        )
    if role == "industry" and payload.status not in ("under_review", "mitigation_proposed"):
        raise HTTPException(
            403,
            detail={
                "error": "forbidden_status_transition",
                "message": f"industry may only set 'mitigation_proposed' or 'under_review', not '{payload.status}'",
                "allowed": ["under_review", "mitigation_proposed"],
            },
        )

    cid = row["campaign_id"]
    with writer() as w:
        w.execute("UPDATE concern SET status=? WHERE id=?", (payload.status, concern_id))
        wire = loaders.load_concerns(w, cid, concern_id=concern_id)[0]
        domain.log(
            w, f"concern.status.{payload.status}", campaign_id=cid, actor_role=role,
            actor_id=payload.actor_id, object_type="concern", object_id=concern_id,
            summary=f"“{row['title']}” → {payload.status}",
            payload={"from": row["status"], "to": payload.status}, obj=wire,
        )
    return wire
