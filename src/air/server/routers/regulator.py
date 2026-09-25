"""/regulator/network, /action-levels, /advisories, /enforcement — the regulator side, and LOOP 2.

`PUT /action-levels/{id}` re-evaluates recent readings against the new threshold
*immediately* and creates or resolves `alert(kind='exceedance')` rows. Moving a
slider in the regulator UI makes contacts appear on the industry radar and, when
the level notifies the community, drops a plain-language advisory in the feed.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from air.server import domain, loaders, network, shapes, timeutil
from air.server.db import get_db, one, resolve_campaign, rows, writer
from air.server.models import ActionLevelIn, AdvisoryIn

router = APIRouter(tags=["regulator"])


@router.get("/regulator/network")
def regulator_network(
    at: str | None = None,
    measure: str = "no2",
    streets: str = network.STREETS_DEFAULT,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """The Network screen in one payload: what the reference monitors report,
    where the modelled plumes go and what the fleet measured under them in
    the streets window, and the residents' clusters — plus one generated
    headline. `network.py` says what is measured and what is modelled, field
    by field.

    `at` is a naive campaign time (`domain.as_of`: none is the end of the
    data, past the end is the end, garbage is a 422). `streets` is `24h`,
    `7d` (default) or `todate`, a window ENDING at `at`: every street figure
    counts the set `/segments` draws for it (`streets_window` names it).
    Cached per moment, pollutant and window, like `/admin/brief`."""
    cid = resolve_campaign(conn, campaign_id)
    return network.build(conn, cid, at=at, measure=measure, streets=streets)


@router.get("/action-levels")
def list_action_levels(
    measure: str | None = None,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    sql = ["SELECT * FROM action_level WHERE campaign_id = ?"]
    params: list[Any] = [cid]
    if measure:
        sql.append("AND measure = ?")
        params.append(measure)
    sql.append("ORDER BY measure, threshold")
    return [shapes.action_level(r) for r in rows(conn, " ".join(sql), params)]


@router.get("/advisories")
def list_advisories(
    audience: str | None = None,
    active_only: bool = False,
    limit: int = 200,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    return loaders.load_advisories(
        conn, cid, audience=audience, active_only=active_only,
        now=domain.data_now(conn, cid), limit=limit,
    )


@router.get("/enforcement")
def list_enforcement(
    campaign_id: str | None = None, conn: sqlite3.Connection = Depends(get_db)
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    return [
        shapes.enforcement_action(r)
        for r in rows(
            conn, "SELECT * FROM enforcement_action WHERE campaign_id=? ORDER BY created_at DESC", (cid,)
        )
    ]


# ── writes ────────────────────────────────────────────────────────────────────

def _resolve_unit(conn: sqlite3.Connection, measure: str, unit: str | None) -> str:
    if unit:
        return unit
    return (domain.measures(conn).get(measure) or {}).get("unit", "")


@router.put("/action-levels/{action_level_id}")
def put_action_level(
    action_level_id: str, payload: ActionLevelIn, conn: sqlite3.Connection = Depends(get_db)
) -> dict[str, Any]:
    """Full-row replace, then immediate re-evaluation. This is LOOP 2's trigger."""
    row = one(conn, "SELECT * FROM action_level WHERE id=?", (action_level_id,))
    if row is None:
        raise HTTPException(404, f"unknown action level {action_level_id}")
    cid = payload.campaign_id or row["campaign_id"]
    unit = _resolve_unit(conn, payload.measure, payload.unit)
    now = timeutil.now_iso()

    with writer() as w:
        w.execute(
            """UPDATE action_level
                  SET campaign_id=?, measure=?, label=?, kind=?, threshold=?, unit=?,
                      averaging_hours=?, severity=?, enabled=?, source=?,
                      notify_community=?, notify_industry=?, updated_at=?
                WHERE id=?""",
            (cid, payload.measure, payload.label, payload.kind, payload.threshold, unit,
             payload.averaging_hours, payload.severity, 1 if payload.enabled else 0, payload.source,
             1 if payload.notify_community else 0, 1 if payload.notify_industry else 0, now,
             action_level_id),
        )
        wire = shapes.action_level(one(w, "SELECT * FROM action_level WHERE id=?", (action_level_id,)))
        domain.log(
            w, "action_level.updated", campaign_id=cid, actor_role="regulator",
            object_type="action_level", object_id=action_level_id,
            summary=f"{payload.label} → {payload.threshold:g} {unit}",
            payload={"from": row["threshold"], "to": payload.threshold, "measure": payload.measure},
            obj=wire,
        )
        result = domain.evaluate_action_level(w, cid, action_level_id, actor_role="regulator")

    return {
        **wire,
        "evaluation": {
            "alerts_created": [a["id"] for a in result["created"]],
            "alerts_resolved": result["resolved"],
            "advisories_created": [a["id"] for a in result["advisories"]],
        },
        "alerts": result["created"],
        "advisories": result["advisories"],
    }


@router.post("/action-levels", status_code=201)
def post_action_level(payload: ActionLevelIn, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    cid = resolve_campaign(conn, payload.campaign_id)
    al_id = payload.id or domain.new_id("al")
    unit = _resolve_unit(conn, payload.measure, payload.unit)
    now = timeutil.now_iso()
    with writer() as w:
        if one(w, "SELECT 1 FROM action_level WHERE id=?", (al_id,)):
            raise HTTPException(409, f"action level {al_id} already exists")
        w.execute(
            """INSERT INTO action_level (id, campaign_id, measure, label, kind, threshold, unit,
                                         averaging_hours, severity, enabled, source,
                                         notify_community, notify_industry, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (al_id, cid, payload.measure, payload.label, payload.kind, payload.threshold, unit,
             payload.averaging_hours, payload.severity, 1 if payload.enabled else 0, payload.source,
             1 if payload.notify_community else 0, 1 if payload.notify_industry else 0, now),
        )
        wire = shapes.action_level(one(w, "SELECT * FROM action_level WHERE id=?", (al_id,)))
        domain.log(
            w, "action_level.created", campaign_id=cid, actor_role="regulator",
            object_type="action_level", object_id=al_id,
            summary=f"{payload.label} at {payload.threshold:g} {unit}",
            payload={"measure": payload.measure, "threshold": payload.threshold}, obj=wire,
        )
        result = domain.evaluate_action_level(w, cid, al_id, actor_role="regulator")
    return {
        **wire,
        "evaluation": {
            "alerts_created": [a["id"] for a in result["created"]],
            "alerts_resolved": result["resolved"],
            "advisories_created": [a["id"] for a in result["advisories"]],
        },
        "alerts": result["created"],
        "advisories": result["advisories"],
    }


@router.post("/advisories", status_code=201)
def post_advisory(payload: AdvisoryIn, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    cid = resolve_campaign(conn, payload.campaign_id)
    with writer() as w:
        wire = domain.create_advisory(
            w, cid, kind=payload.kind, severity=payload.severity, title=payload.title,
            body=payload.body, measure=payload.measure, alert_id=payload.alert_id,
            audience=list(payload.audience), org_id=payload.org_id, author_id=payload.author_id,
            expires_at=payload.expires_at, pinned=payload.pinned,
        )
    return wire
