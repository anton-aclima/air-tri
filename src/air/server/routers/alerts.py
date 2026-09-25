"""/alerts — the shared bus, and each alert's place relative to a site.

`GET /alerts?site_id=X` is the industry deck's list. Every located alert comes
back with `bearing_deg` (0-360 true bearing from the site centroid to the alert
location) and `distance_m`, which the deck prints as "6.3 km NE". (It used to
paint them on a radar dial; that dial is retired, PLAN-refocus D8.)

`role=industry&site_id=X` also carries the fleet's own detections at that
site's fence (D13, owner decision 2026-09-23) — see `_fenceline_detections` —
and is bounded at `INDUSTRY_RADIUS_M` from the site, by geometry alone
(`loaders.alert_geometry` no longer reads the generator's `alert.site_id`).
Every alert with a `site_id` comes back addressed to that operator
(`_for_operator`): a D13 row carries a fleet-measurement sentence instead of
the recommendation the generator wrote for the regulator, and the stored
combustion line names the site's own kind of equipment.

`at` serves the list as it stood at a moment (D2): only alerts that had entered
the record by then, each with `ongoing` judged at it. No `at` is the end of the
data. "Entered the record" is `started_at`, except for a concern cluster, whose
`started_at` is when the episode was first noticed, hours before any report was
posted; it counts from `created_at`, when it was raised (shapes.ALERT_BEGUN_SQL).
The 31 seeded alerts fit under the LIMIT, so a browser filter would work today;
the bound is in SQL anyway so it keeps working when they do not (the feed and
the reports already do not), and so `ongoing` and the list are judged at one
moment.

`GET /alerts/{id}?at` is the detail as it stood then — samples, acknowledgements,
reports and mitigations filed by `at`. An alert that had not begun by `at` is
still served, with `not_started: true` and `ongoing: false`, not a 404: a link
or a selection can outlive a scrub backwards, and a 404 reads as "no such
alert", which is false. The list never contains one.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from air.server import domain, envelope, geo, loaders, shapes, timeutil
from air.server.db import get_db, one, resolve_campaign, rows, scalar, writer
from air.server.models import AckIn

router = APIRouter(tags=["alerts"])

#: How far from its site an industry list reaches, when the caller gives no
#: `radius_m`. The deck's own `NEAR_M` (industry/Scope.tsx): DRAQA's Riverport
#: Road monitor is 6.27 km from Ridgeline, and the deck files it under
#: "Elsewhere". The server used to bound the list by the generator's site tag
#: instead, so without a radius here every campaign alert would reach every
#: site's one alert count (F3) once that tag stopped deciding.
INDUSTRY_RADIUS_M = 7000.0

#: What a D13 row says to the operator it is delivered to. The generator
#: wrote these for the regulator ("Site a temporary monitor here, or accept
#: mobile evidence"), and industry was printing that as its own advice. A
#: measurement on a street, said as one — never a source (F7).
FLEET_AT_FENCE = (
    "Aclima's vehicles measured this on a public street beside your fence, over repeated passes. "
    "It says what the street carried, not where it came from. Compare it with your own fenceline "
    "sensors for the same hours."
)

#: The generator's line for a reference monitor's NO2 alert, which the
#: industry room words for its own site. In order: the agency-facing one
#: narrative.py writes now (phase 5 — the regulator reads this alert first, so
#: it points at the evidence, not at an operator), the runtime scenario's
#: (domain.evaluate_action_level), and two older builds' — one named a datacentre's
#: equipment whatever the site was.
_GENERIC_NO2 = (
    "Read it against the wind and the fleet's street passes for these hours before tying it to a source.",
    "Read it against the wind, the fleet's street passes and the fenceline ring before the next hourly average closes.",
    "Check generator and turbine load for this window.",
    "Check what was burning on site in this window.",
)


@router.get("/alerts")
def list_alerts(
    role: str | None = None,
    status: str | None = None,
    severity: str | None = None,
    kind: str | None = None,
    site_id: str | None = None,
    radius_m: float | None = None,
    since: str | None = None,
    at: str | None = None,
    limit: int = 300,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    # The role filter runs after the LIMIT inside `load_alerts` either way, so
    # loading unfiltered and filtering here selects exactly the same rows.
    widen = role == "industry" and bool(site_id)
    found = loaders.load_alerts(
        conn, cid, role=None if widen else role, status=status, severity=severity, kind=kind,
        since=since, until=domain.as_of(conn, cid, at), limit=limit,
    )
    if widen:
        found = _fenceline_detections(conn, found, str(site_id))
        if radius_m is None:
            radius_m = INDUSTRY_RADIUS_M
    if site_id:
        found = _for_operator(conn, loaders.alert_geometry(conn, found, site_id, radius_m), site_id)
    return found


def _for_operator(conn: sqlite3.Connection, alerts: list[dict[str, Any]], site_id: str) -> list[dict[str, Any]]:
    """The alert as addressed to this site's operator. Copies; never writes."""
    from air.server import advisor_rules

    site = one(conn, "SELECT id, kind FROM industry_site WHERE id=?", (site_id,))
    out = []
    for a in alerts:
        a = dict(a)
        rec = a.get("recommendation") or ""
        if a.get("source_type") == "mobile" and "industry" not in (a.get("audience") or []):
            # A D13 row (see `_fenceline_detections`): delivered, not addressed.
            a["recommendation"] = FLEET_AT_FENCE
            a["delivered_as"] = "fleet_at_fence"
        elif site is not None and (generic := next((g for g in _GENERIC_NO2 if rec.startswith(g)), None)):
            lever, _why = advisor_rules.lever_for(dict(site), a.get("measure") or "no2")
            a["recommendation"] = f"Check {lever} for this window." + rec[len(generic):]
        out.append(a)
    return out


def _fenceline_detections(
    conn: sqlite3.Connection, alerts: list[dict[str, Any]], site_id: str
) -> list[dict[str, Any]]:
    """Industry's list, plus the fleet's detections at this site's own fence.

    D13 (owner, 2026-09-23): send Aclima's mobile detections to industry. The
    generator addresses every `mobile_detection` to regulator and admin only
    (narrative.py), so the deck never saw the fleet's finding closest to
    Ridgeline — "Highest diesel-attributable particulate on the network: Paul
    R Lowry Road", 470 m from its centroid on its own fenceline road — while
    another operator's monitor headlined it.

    WHICH ONES, AND WHY NOT A RADIUS. A detection reaches a site's operator
    when it lies within `envelope.FENCELINE_M` (800 m) of one of the site's
    active emission points: the envelope's own definition of "this site's
    fenceline road", so the deck's fenceline highlight and this list cannot
    disagree about which road is the site's. A plain radius from the centroid
    was the alternative and it fails on this data: at the deck's 6 km it
    hands Ridgeline the black-carbon detection on Channel Avenue (5.8 km),
    which sits 115 m from Delta Forge's stacks — another operator's fence,
    learned about by a competitor before the operator it concerns.

    `alert.site_id` is NOT used. On mobile rows it is the generator's bearing
    guess (`_suspect`), and it names Riverport for a methane crossing 2.7 km
    from Riverport and 1.3 km from Delta Forge (PLAN-refocus §8: the field
    must not be used for attribution). Placement is by distance alone, and
    the copy on the deck describes a measurement on a street, never a source.
    """
    pts = [
        (float(r["lon"]), float(r["lat"]))
        for r in rows(
            conn, "SELECT lon, lat FROM emission_point WHERE site_id=? AND active=1", (site_id,)
        )
    ]

    def at_fence(a: dict[str, Any]) -> bool:
        if a["source_type"] != "mobile" or a["lon"] is None or a["lat"] is None or not pts:
            return False
        near = min(geo.haversine_m(lon, lat, a["lon"], a["lat"]) for lon, lat in pts)
        return near <= envelope.FENCELINE_M

    return [a for a in alerts if "industry" in a["audience"] or at_fence(a)]


@router.get("/alerts/{alert_id}")
def get_alert(
    alert_id: str,
    site_id: str | None = None,
    at: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """`at` as on the list, so a detail opened in replay agrees with the row it
    was opened from: `ongoing` judged then, and only the samples,
    acknowledgements, reports and mitigations that existed by then. Unbounded,
    al-no2-0034-003 at Jul 19 06:00 carried a 09:20 acknowledgement and
    samples through 08:00. `status` is the final one (only it is stored);
    `ongoing` is what says whether it was live then.

    `not_started` is true when the alert had not entered the record by `at`
    (see the module docstring for why that is a flag, not a 404)."""
    row = one(conn, "SELECT * FROM alert WHERE id=?", (alert_id,))
    if row is None:
        raise HTTPException(404, f"unknown alert {alert_id}")
    cid = row["campaign_id"]
    now = domain.as_of(conn, cid, at)
    a = shapes.alert(row, now)
    begun = shapes.alert_begun_at(row)
    a["not_started"] = not begun or begun > now

    a["samples"] = [
        {"t": r["ts"], "v": r["value"]}
        for r in rows(
            conn, "SELECT ts, value FROM alert_sample WHERE alert_id=? AND ts<=? ORDER BY ts", (alert_id, now)
        )
    ]

    # Related concerns: the cluster this alert came from, or anything nearby.
    concerns: list[dict[str, Any]] = []
    if row["kind"] == "concern_cluster" and row["source_id"]:
        concerns = loaders.load_concerns(conn, cid, cluster_id=row["source_id"], until=now)
    elif row["lon"] is not None and row["lat"] is not None:
        concerns = loaders.load_concerns(
            conn, cid, since=timeutil.shift(row["started_at"], hours=-48), until=now,
            near=(row["lon"], row["lat"], 900.0), limit=40,
        )
    a["concerns"] = concerns
    a["mitigations"] = loaders.load_mitigations(conn, cid, alert_id=alert_id, until=now)
    a["acknowledged_by"] = [
        {"user_id": r["user_id"], "name": r["name"], "note": r["note"], "created_at": r["created_at"]}
        for r in rows(
            conn,
            """SELECT k.user_id, k.note, k.created_at, u.name FROM alert_ack k
                 LEFT JOIN app_user u ON u.id = k.user_id
                WHERE k.alert_id=? AND k.created_at<=? ORDER BY k.created_at""",
            (alert_id, now),
        )
    ]
    if site_id:
        geom = loaders.alert_geometry(conn, [a], site_id)
        a = _for_operator(conn, geom or [a], site_id)[0]
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
