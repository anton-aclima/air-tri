"""Cross-role business logic: the activity log, the three loops, risk framing.

This is where the product actually lives. Everything here takes a *write*
connection inside an open transaction (see db.writer()).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from fastapi import HTTPException

from air.server import cache, config, geo, shapes, timeutil
from air.server.db import one, rows, scalar

# Which SSE event name each activity verb maps to.
VERB_EVENT = {
    "concern": "concern",
    "concern_response": "concern",
    "concern_cluster": "concern",
    "alert": "alert",
    "alert_ack": "alert",
    "site_post": "post",
    "mitigation": "post",
    "advisory": "advisory",
    "action_level": "alert",
    "vehicle_ping": "fleet",
    "drive": "fleet",
}


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


# ── activity log + pub/sub ────────────────────────────────────────────────────

def log(
    conn: sqlite3.Connection,
    verb: str,
    *,
    campaign_id: str | None = None,
    actor_role: str | None = None,
    actor_id: str | None = None,
    object_type: str | None = None,
    object_id: str | None = None,
    summary: str | None = None,
    payload: dict[str, Any] | None = None,
    obj: Any = None,
    event: str | None = None,
) -> dict[str, Any]:
    """Append to `activity` and publish to the SSE bus. Every write calls this."""
    from air.server import bus  # local import: bus binds the running loop

    ts = timeutil.now_iso()
    cur = conn.execute(
        """INSERT INTO activity
             (campaign_id, ts, actor_role, actor_id, verb, object_type, object_id, summary, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            campaign_id, ts, actor_role, actor_id, verb, object_type, object_id, summary,
            json.dumps(payload, default=str) if payload else None,
        ),
    )
    item = {
        "id": cur.lastrowid,
        "ts": ts,
        "actor_role": actor_role,
        "actor_id": actor_id,
        "verb": verb,
        "object_type": object_type,
        "object_id": object_id,
        "summary": summary,
        "payload": payload,
    }
    cache.invalidate()

    envelope = dict(item)
    if obj is not None:
        envelope["object"] = obj
    name = event or VERB_EVENT.get(object_type or "", "activity")
    if name != "activity":
        bus.publish(name, envelope)
    bus.publish("activity", envelope)
    return item


# ── reference data ────────────────────────────────────────────────────────────

def measures(conn: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    key = ("measures",)
    hit = cache.get(key)
    if hit is not None:
        return hit
    out = {r["code"]: shapes.measure_def(r) for r in rows(conn, "SELECT * FROM measure_def ORDER BY sort_order, code")}
    return cache.put(key, out)


def data_now(conn: sqlite3.Connection, campaign_id: str) -> str:
    """The demo's "now": the instant the data was built, frozen.

    It is `timeutil.now()` — `setting('datagen.now')` — and NOT the latest
    timestamp in the data. The data runs past the build instant on purpose:
    wind is generated to the end of the day and in-progress drives store the
    pings of their remaining shift. A max() over the tables therefore landed at
    23:59 and let the community's three-hour fleet delay show the same pings the
    regulator sees (non-negotiable 5). It also used to fall back to the wall
    clock whenever that was later, which is how every live window came back
    empty once the demo was a day old.

    Unconditionally `timeutil.now()`, including on a database with no build
    stamp: timeutil owns that fallback (the newest reading or pass), so what
    writes are stamped with and what reads are bounded by is one clock. It was
    two, and a report filed on such a database was stamped four weeks after
    the read bound and never listed. `conn` and `campaign_id` stay in the
    signature for the ~20 callers.
    """
    return timeutil.now_iso()


def as_of(conn: sqlite3.Connection, campaign_id: str, at: str | None) -> str:
    """The moment an event read is served as of: the client's `at`, or the end.

    Replay rewinds events too (docs/PLAN-refocus.md D2), so `/feed`,
    `/concerns`, `/clusters`, `/stats/community` and `/alerts` take `at` and
    apply it as an upper bound IN SQL, before the LIMIT. A browser filter
    after the LIMIT cannot do it: at Aug 12 all 40 items of the community feed
    are in the future, so filtering them leaves an empty feed.

    No `at` means the end of the data, which is `data_now` — so the default
    and an explicit `at=<now>` return the same thing. A `Z` or an offset is
    dropped rather than converted (`timeutil.parse`), and a moment past the
    end is the end: time is constrained to the simulation (D1).
    """
    end = data_now(conn, campaign_id)
    if not at:
        return end
    dt = timeutil.parse(at)
    if dt is None:
        raise HTTPException(422, f"not a campaign time (YYYY-MM-DDTHH:MM:SS, no Z): {at!r}")
    return min(timeutil.iso(dt), end)


# ── risk framing (community: unitless 0-100, no units, no acronyms) ───────────

RISK_BANDS = (
    (20, "Clean"),
    (40, "Fair"),
    (60, "Elevated"),
    (80, "High"),
    (101, "Very high"),
)


def risk_label(risk: float | None) -> str:
    if risk is None:
        return "No data"
    for top, label in RISK_BANDS:
        if risk < top:
            return label
    return "Very high"


def risk_from_scale(scale: list[list[float]] | None, value: float | None) -> float | None:
    """Piecewise-linear interpolation over measure_def.scale breakpoints."""
    if value is None or not scale:
        return None
    pts = sorted((float(c), float(r)) for c, r in scale if c is not None and r is not None)
    if not pts:
        return None
    if value <= pts[0][0]:
        return pts[0][1]
    for (c0, r0), (c1, r1) in zip(pts, pts[1:]):
        if value <= c1:
            span = c1 - c0
            f = 0.0 if span <= 0 else (value - c0) / span
            return r0 + f * (r1 - r0)
    return pts[-1][1]


# ── geometry helpers against the DB ───────────────────────────────────────────

def nearest_site(conn: sqlite3.Connection, campaign_id: str, lon: float, lat: float) -> dict[str, Any] | None:
    best = None
    for s in rows(
        conn,
        "SELECT id, name, centroid_lon, centroid_lat FROM industry_site WHERE campaign_id=?",
        (campaign_id,),
    ):
        d = geo.haversine_m(lon, lat, s["centroid_lon"], s["centroid_lat"])
        if best is None or d < best["distance_m"]:
            best = {
                "id": s["id"],
                "name": s["name"],
                "distance_m": round(d, 1),
                "bearing_deg": round(geo.bearing_deg(s["centroid_lon"], s["centroid_lat"], lon, lat), 1),
            }
    return best


def current_wind(conn: sqlite3.Connection, campaign_id: str, at: str | None = None) -> dict[str, Any] | None:
    """The wind as of `at`, through `as_of` like every event read: a moment past
    the end is the end, and a garbage one is a 422. It used to take `at` raw,
    so `at=garbage` compared `ts <= 'garbage'` (true for every row) and served
    the 23:00 wind, nine hours past the build — the wind is generated to the
    end of the day. `12:00` without seconds sorted before `12:00:00` and got
    the 11:00 row; `as_of` normalises it.

    Before the first row there is no wind yet; the fallback is the FIRST row,
    the nearest one, not the newest, which would put August's wind on June 1."""
    at = as_of(conn, campaign_id, at)
    r = one(
        conn,
        "SELECT * FROM wind WHERE campaign_id=? AND ts<=? ORDER BY ts DESC LIMIT 1",
        (campaign_id, at),
    )
    if r is None:
        r = one(conn, "SELECT * FROM wind WHERE campaign_id=? ORDER BY ts LIMIT 1", (campaign_id,))
    return shapes.wind_point(r) if r else None


# ── alert creation ────────────────────────────────────────────────────────────

DEFAULT_AUDIENCE = ["regulator", "industry", "admin"]


def create_alert(
    conn: sqlite3.Connection,
    campaign_id: str,
    *,
    kind: str,
    severity: str,
    title: str,
    source_type: str,
    body: str | None = None,
    measure: str | None = None,
    value: float | None = None,
    threshold: float | None = None,
    unit: str | None = None,
    source_id: str | None = None,
    lon: float | None = None,
    lat: float | None = None,
    site_id: str | None = None,
    action_level_id: str | None = None,
    recommendation: str | None = None,
    audience: list[str] | None = None,
    started_at: str | None = None,
    samples: list[tuple[str, float]] | None = None,
    actor_role: str | None = None,
    actor_id: str | None = None,
) -> dict[str, Any]:
    aid = new_id("al")
    now = timeutil.now_iso()
    started = started_at or now
    if site_id is None and lon is not None and lat is not None:
        near = nearest_site(conn, campaign_id, lon, lat)
        site_id = near["id"] if near else None
    aud = audience or DEFAULT_AUDIENCE
    conn.execute(
        """INSERT INTO alert (id, campaign_id, kind, severity, measure, value, threshold, unit,
                              source_type, source_id, lon, lat, site_id, action_level_id,
                              started_at, ended_at, status, title, body, recommendation,
                              audience_json, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'active',?,?,?,?,?)""",
        (aid, campaign_id, kind, severity, measure, value, threshold, unit,
         source_type, source_id, lon, lat, site_id, action_level_id,
         started, title, body, recommendation, json.dumps(aud), now),
    )
    for ts, v in (samples or []):
        conn.execute(
            "INSERT OR REPLACE INTO alert_sample (alert_id, ts, value) VALUES (?,?,?)",
            (aid, ts, v),
        )
    row = one(conn, "SELECT * FROM alert WHERE id=?", (aid,))
    wire = shapes.alert(row)
    log(
        conn, "alert.created",
        campaign_id=campaign_id, actor_role=actor_role, actor_id=actor_id,
        object_type="alert", object_id=aid, summary=title,
        payload={"kind": kind, "severity": severity, "measure": measure, "site_id": site_id},
        obj=wire,
    )
    return wire


def resolve_alert(conn: sqlite3.Connection, campaign_id: str, alert_id: str, reason: str,
                  actor_role: str | None = None) -> dict[str, Any] | None:
    row = one(conn, "SELECT * FROM alert WHERE id=?", (alert_id,))
    if row is None or row["status"] in ("resolved", "expired"):
        return None
    now = timeutil.now_iso()
    conn.execute("UPDATE alert SET status='resolved', ended_at=? WHERE id=?", (now, alert_id))
    row = one(conn, "SELECT * FROM alert WHERE id=?", (alert_id,))
    wire = shapes.alert(row)
    log(
        conn, "alert.resolved",
        campaign_id=campaign_id, actor_role=actor_role,
        object_type="alert", object_id=alert_id, summary=f"{row['title']} — {reason}",
        payload={"reason": reason}, obj=wire,
    )
    return wire


# ── LOOP 1: community concern -> cluster -> industry/regulator alert ──────────

CLUSTER_SEVERITY = ((7, "critical"), (5, "warning"), (3, "watch"))


def _cluster_severity(count: int) -> str:
    for n, sev in CLUSTER_SEVERITY:
        if count >= n:
            return sev
    return "info"


def detect_cluster(conn: sqlite3.Connection, campaign_id: str, concern_id: str) -> dict[str, Any] | None:
    """>=3 concerns within CLUSTER_RADIUS_M and CLUSTER_WINDOW_H form a cluster.

    Returns {cluster, formed, grew, alert} when a cluster forms or grows, else None.
    """
    seed = one(conn, "SELECT * FROM concern WHERE id=?", (concern_id,))
    if seed is None:
        return None
    since = timeutil.shift(seed["occurred_at"], hours=-config.CLUSTER_WINDOW_H) or timeutil.ago(
        hours=config.CLUSTER_WINDOW_H
    )
    until = timeutil.shift(seed["occurred_at"], hours=config.CLUSTER_WINDOW_H)
    candidates = rows(
        conn,
        """SELECT * FROM concern
            WHERE campaign_id=? AND occurred_at>=? AND occurred_at<=?
              AND status NOT IN ('resolved','closed')""",
        (campaign_id, since, until),
    )
    members = [
        c for c in candidates
        if geo.haversine_m(seed["lon"], seed["lat"], c["lon"], c["lat"]) <= config.CLUSTER_RADIUS_M
    ]
    if len(members) < config.CLUSTER_MIN_COUNT:
        return None

    pts = [(m["lon"], m["lat"]) for m in members]
    clon, clat = geo.centroid(pts)
    radius = max((geo.haversine_m(clon, clat, lo, la) for lo, la in pts), default=0.0)
    radius = max(radius, 120.0)
    kinds = sorted({m["kind"] for m in members})
    first_at = min(m["occurred_at"] for m in members)
    last_at = max(m["occurred_at"] for m in members)
    count = len(members)

    existing_id = next((m["cluster_id"] for m in members if m["cluster_id"]), None)
    formed = existing_id is None
    prev_count = 0
    if existing_id:
        prev = one(conn, "SELECT count FROM concern_cluster WHERE id=?", (existing_id,))
        prev_count = prev["count"] if prev else 0
    cluster_id = existing_id or new_id("cl")
    label = f"{count} reports · {members[0]['district'] or 'community'}"

    if formed:
        conn.execute(
            """INSERT INTO concern_cluster
                 (id, campaign_id, label, centroid_lon, centroid_lat, radius_m, count,
                  kinds_json, first_at, last_at, status, site_id)
               VALUES (?,?,?,?,?,?,?,?,?,?, 'active', NULL)""",
            (cluster_id, campaign_id, label, clon, clat, radius, count,
             json.dumps(kinds), first_at, last_at),
        )
    else:
        conn.execute(
            """UPDATE concern_cluster
                  SET label=?, centroid_lon=?, centroid_lat=?, radius_m=?, count=?,
                      kinds_json=?, first_at=?, last_at=?, status='active'
                WHERE id=?""",
            (label, clon, clat, radius, count, json.dumps(kinds), first_at, last_at, cluster_id),
        )
    grew = (not formed) and count > prev_count
    if not (formed or grew):
        # Re-stamp membership anyway so no concern is left orphaned.
        _attach(conn, cluster_id, members)
        return None

    near = nearest_site(conn, campaign_id, clon, clat)
    site_id = near["id"] if near else None
    conn.execute("UPDATE concern_cluster SET site_id=? WHERE id=?", (site_id, cluster_id))
    _attach(conn, cluster_id, members)

    cluster = shapes.concern_cluster(one(conn, "SELECT * FROM concern_cluster WHERE id=?", (cluster_id,)))
    log(
        conn, "concern_cluster.formed" if formed else "concern_cluster.grew",
        campaign_id=campaign_id, actor_role="community",
        object_type="concern_cluster", object_id=cluster_id,
        summary=f"{count} community reports clustered within {int(radius)} m",
        payload={"count": count, "kinds": kinds, "site_id": site_id}, obj=cluster,
    )

    severity = _cluster_severity(count)
    bearing = near["bearing_deg"] if near else None
    where = f"{geo.compass(bearing)} of {near['name']}" if near and bearing is not None else "in the community"
    body = (
        f"{count} community reports ({', '.join(kinds)}) within {int(radius)} m over "
        f"{int(config.CLUSTER_WINDOW_H)} h, {where}."
    )
    existing_alert = one(
        conn,
        """SELECT * FROM alert
            WHERE campaign_id=? AND kind='concern_cluster' AND source_id=?
              AND status IN ('active','acknowledged') ORDER BY started_at DESC LIMIT 1""",
        (campaign_id, cluster_id),
    )
    if existing_alert is not None:
        conn.execute(
            "UPDATE alert SET severity=?, value=?, title=?, body=?, status='active', lon=?, lat=? WHERE id=?",
            (severity, float(count), f"Community concern cluster · {count} reports", body,
             clon, clat, existing_alert["id"]),
        )
        row = one(conn, "SELECT * FROM alert WHERE id=?", (existing_alert["id"],))
        alert_wire = shapes.alert(row)
        conn.execute(
            "INSERT OR REPLACE INTO alert_sample (alert_id, ts, value) VALUES (?,?,?)",
            (existing_alert["id"], last_at, float(count)),
        )
        log(
            conn, "alert.escalated", campaign_id=campaign_id, actor_role="community",
            object_type="alert", object_id=existing_alert["id"],
            summary=f"Concern cluster grew to {count} reports",
            payload={"count": count}, obj=alert_wire,
        )
    else:
        alert_wire = create_alert(
            conn, campaign_id,
            kind="concern_cluster", severity=severity, source_type="community",
            source_id=cluster_id, lon=clon, lat=clat, site_id=site_id,
            title=f"Community concern cluster · {count} reports",
            body=body,
            value=float(count), threshold=float(config.CLUSTER_MIN_COUNT), unit="reports",
            recommendation=(
                "Check generator and cooling-tower logs for the reported window, then post an "
                "acknowledgement to the community feed."
            ),
            audience=["industry", "regulator", "admin"],
            started_at=first_at,
            samples=[(m["occurred_at"], float(i + 1)) for i, m in enumerate(sorted(members, key=lambda m: m["occurred_at"]))],
            actor_role="community",
        )

    # Cluster membership corroborates the individual reports.
    for m in members:
        if m["status"] == "new":
            conn.execute("UPDATE concern SET status='corroborated' WHERE id=?", (m["id"],))

    return {"cluster": cluster, "formed": formed, "grew": grew, "alert": alert_wire}


def _attach(conn: sqlite3.Connection, cluster_id: str, members: list[sqlite3.Row]) -> None:
    for m in members:
        if m["cluster_id"] != cluster_id:
            conn.execute("UPDATE concern SET cluster_id=? WHERE id=?", (cluster_id, m["id"]))


# ── LOOP 2: regulator action level -> exceedance alert -> community advisory ──

def _al_audience(al: sqlite3.Row) -> list[str]:
    aud = ["regulator", "admin"]
    if al["notify_industry"]:
        aud.append("industry")
    if al["notify_community"]:
        aud.append("community")
    return aud


def evaluate_action_level(
    conn: sqlite3.Connection,
    campaign_id: str,
    action_level_id: str,
    *,
    lookback_h: float = 72.0,
    actor_role: str = "regulator",
    actor_id: str | None = None,
    emit_advisory: bool = True,
) -> dict[str, Any]:
    """Re-run one action level against recent readings; create/resolve alerts.

    Moving a threshold slider in the regulator UI lands here, and the alerts it
    creates are what the industry deck lists. Both directions work: raising a
    threshold resolves the alerts it no longer justifies.
    """
    al = one(conn, "SELECT * FROM action_level WHERE id=?", (action_level_id,))
    if al is None:
        return {"created": [], "resolved": [], "advisories": []}

    created: list[dict[str, Any]] = []
    resolved: list[str] = []
    advisories: list[dict[str, Any]] = []

    if not al["enabled"]:
        for a in rows(
            conn,
            "SELECT id FROM alert WHERE campaign_id=? AND action_level_id=? AND status IN ('active','acknowledged')",
            (campaign_id, action_level_id),
        ):
            if resolve_alert(conn, campaign_id, a["id"], "action level disabled", actor_role):
                resolved.append(a["id"])
        return {"created": created, "resolved": resolved, "advisories": advisories}

    measure = al["measure"]
    threshold = float(al["threshold"])
    now = data_now(conn, campaign_id)
    since = timeutil.shift(now, hours=-lookback_h) or timeutil.ago(hours=lookback_h)
    mdef = measures(conn).get(measure, {})
    plain = mdef.get("plain_name") or mdef.get("label") or measure

    if al["kind"] == "integrated":
        hours = max(1.0, float(al["averaging_hours"] or 1))
        win_from = timeutil.shift(now, hours=-hours) or since
        agg = rows(
            conn,
            """SELECT r.monitor_id, AVG(r.value) AS v, MAX(r.ts) AS ts, COUNT(*) AS n
                 FROM monitor_reading r JOIN monitor m ON m.id = r.monitor_id
                WHERE m.campaign_id=? AND r.measure=? AND r.ts>=? AND r.qc='valid'
                GROUP BY r.monitor_id""",
            (campaign_id, measure, win_from),
        )
        exceed = {r["monitor_id"]: (r["v"], r["ts"]) for r in agg if r["v"] is not None and r["v"] > threshold}
        alert_kind = "integrated_exposure"
    else:
        peaks = rows(
            conn,
            """SELECT r.monitor_id, MAX(r.value) AS v,
                      (SELECT r2.ts FROM monitor_reading r2
                        WHERE r2.monitor_id=r.monitor_id AND r2.measure=r.measure AND r2.ts>=?
                        ORDER BY r2.value DESC LIMIT 1) AS ts
                 FROM monitor_reading r JOIN monitor m ON m.id = r.monitor_id
                WHERE m.campaign_id=? AND r.measure=? AND r.ts>=? AND r.qc='valid'
                GROUP BY r.monitor_id""",
            (since, campaign_id, measure, since),
        )
        exceed = {r["monitor_id"]: (r["v"], r["ts"]) for r in peaks if r["v"] is not None and r["v"] > threshold}
        alert_kind = "exceedance"

    open_alerts = rows(
        conn,
        """SELECT * FROM alert
            WHERE campaign_id=? AND action_level_id=? AND status IN ('active','acknowledged')""",
        (campaign_id, action_level_id),
    )
    open_by_source = {a["source_id"]: a for a in open_alerts}

    # 1. Stand up an alert for every monitor now over the line.
    for monitor_id, (value, ts) in exceed.items():
        mon = one(conn, "SELECT * FROM monitor WHERE id=?", (monitor_id,))
        if mon is None:
            continue
        if monitor_id in open_by_source:
            a = open_by_source[monitor_id]
            conn.execute(
                "UPDATE alert SET value=?, threshold=?, severity=?, status='active' WHERE id=?",
                (value, threshold, al["severity"], a["id"]),
            )
            continue
        samples = [
            (r["ts"], r["value"])
            for r in rows(
                conn,
                """SELECT ts, value FROM monitor_reading
                    WHERE monitor_id=? AND measure=? AND ts>=? ORDER BY ts""",
                (monitor_id, measure, since),
            )
        ][-48:]
        near = nearest_site(conn, campaign_id, mon["lon"], mon["lat"])
        brg = geo.compass(near["bearing_deg"]) if near else ""
        wind = current_wind(conn, campaign_id)
        wind_txt = (
            f" Wind is from {geo.compass(wind['dir_deg'])} at {wind['speed_ms']:.1f} m/s."
            if wind else ""
        )
        created.append(
            create_alert(
                conn, campaign_id,
                kind=alert_kind, severity=al["severity"], measure=measure,
                value=round(float(value), 3), threshold=threshold, unit=al["unit"],
                source_type="monitor", source_id=monitor_id,
                lon=mon["lon"], lat=mon["lat"],
                site_id=mon["site_id"] or (near["id"] if near else None),
                action_level_id=action_level_id,
                title=f"{mdef.get('short_label', measure)} over {al['label']} at {mon['name']}",
                body=(
                    f"{mdef.get('short_label', measure)} reached {value:.1f} {al['unit']} against a "
                    f"{threshold:g} {al['unit']} {al['kind']} action level"
                    + (f", {int(near['distance_m'])} m {brg} of {near['name']}." if near else ".")
                    + wind_txt
                ),
                # Agency-facing, like narrative.py's: the industry room swaps
                # it for its site's lever (routers/alerts.py `_GENERIC_NO2`).
                recommendation=(
                    "Read it against the wind, the fleet's street passes and the fenceline ring "
                    "before the next hourly average closes."
                ),
                audience=_al_audience(al),
                samples=samples,
                actor_role=actor_role, actor_id=actor_id,
            )
        )

    # 2. Mobile monitoring finds what the stationary network cannot — the leapfrog.
    worst = one(
        conn,
        """SELECT s.segment_id, s.max, s.median, s.persistence, r.name, r.mid_lon, r.mid_lat, r.district
             FROM segment_stat s JOIN road_segment r ON r.id = s.segment_id
            WHERE s.campaign_id=? AND s.measure=? AND s.window='all' AND s.max > ?
            ORDER BY s.max DESC LIMIT 1""",
        (campaign_id, measure, threshold),
    )
    mobile_key = f"mobile:{action_level_id}"
    if worst is not None and mobile_key not in open_by_source:
        near = nearest_site(conn, campaign_id, worst["mid_lon"], worst["mid_lat"])
        created.append(
            create_alert(
                conn, campaign_id,
                kind="mobile_detection", severity=al["severity"], measure=measure,
                value=round(float(worst["max"]), 3), threshold=threshold, unit=al["unit"],
                source_type="mobile", source_id=mobile_key,
                lon=worst["mid_lon"], lat=worst["mid_lat"],
                site_id=near["id"] if near else None,
                action_level_id=action_level_id,
                title=f"Mobile monitoring peak on {worst['name'] or 'unnamed street'}",
                body=(
                    f"Mobile passes recorded {worst['max']:.1f} {al['unit']} on "
                    f"{worst['name'] or 'an unnamed street'}"
                    + (f" in {worst['district']}" if worst["district"] else "")
                    + f", above the {threshold:g} {al['unit']} action level. No stationary monitor covers this street."
                ),
                recommendation="Compare against the nearest reference monitor before acting; this is a street-level signal the tower network cannot see.",
                audience=_al_audience(al),
                actor_role=actor_role, actor_id=actor_id,
            )
        )
    elif worst is None and mobile_key in open_by_source:
        if resolve_alert(conn, campaign_id, open_by_source[mobile_key]["id"], "threshold raised above mobile peak", actor_role):
            resolved.append(open_by_source[mobile_key]["id"])

    # 3. Resolve alerts the new threshold no longer justifies.
    for source_id, a in open_by_source.items():
        if source_id == mobile_key or source_id in exceed:
            continue
        if resolve_alert(conn, campaign_id, a["id"], "no longer over the action level", actor_role):
            resolved.append(a["id"])

    # 4. Anything serious that notifies the community becomes a plain-language advisory.
    if emit_advisory and al["notify_community"]:
        worst_alert = next(
            (a for a in created if a["severity"] in ("warning", "critical")),
            None,
        )
        if worst_alert is not None:
            advisories.append(
                create_advisory(
                    conn, campaign_id,
                    kind="warning" if worst_alert["severity"] == "critical" else "advisory",
                    severity=worst_alert["severity"],
                    title=f"Air quality notice · {plain}",
                    body=(
                        f"Monitors picked up higher than usual {plain} near "
                        f"{worst_alert['title'].split(' at ')[-1]}. If you are sensitive to air quality, "
                        "consider keeping windows closed and limiting time outdoors until levels fall back. "
                        "We are following up with the operator."
                    ),
                    measure=measure, alert_id=worst_alert["id"],
                    audience=["community"], actor_role=actor_role, actor_id=actor_id,
                )
            )

    return {"created": created, "resolved": resolved, "advisories": advisories}


def create_advisory(
    conn: sqlite3.Connection,
    campaign_id: str,
    *,
    kind: str,
    severity: str,
    title: str,
    body: str,
    measure: str | None = None,
    alert_id: str | None = None,
    audience: list[str] | None = None,
    org_id: str | None = None,
    author_id: str | None = None,
    expires_at: str | None = None,
    pinned: bool = False,
    actor_role: str = "regulator",
    actor_id: str | None = None,
) -> dict[str, Any]:
    adv_id = new_id("ad")
    now = timeutil.now_iso()
    # Stored naive like every other stamp, so `expires_at >= now` compares
    # digits with digits. A client-sent `Z` is dropped, not converted.
    parsed = timeutil.parse(expires_at)
    expires_at = timeutil.iso(parsed) if parsed else expires_at
    if org_id is None:
        org_id = scalar(conn, "SELECT id FROM org WHERE kind='agency' ORDER BY id LIMIT 1")
    conn.execute(
        """INSERT INTO advisory (id, campaign_id, org_id, author_id, kind, severity, title, body,
                                 measure, alert_id, audience_json, created_at, expires_at, pinned)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (adv_id, campaign_id, org_id, author_id, kind, severity, title, body, measure, alert_id,
         json.dumps(audience or ["community"]), now, expires_at, 1 if pinned else 0),
    )
    wire = shapes.advisory(one(conn, "SELECT * FROM advisory WHERE id=?", (adv_id,)))
    log(
        conn, "advisory.created", campaign_id=campaign_id, actor_role=actor_role, actor_id=actor_id,
        object_type="advisory", object_id=adv_id, summary=title,
        payload={"kind": kind, "severity": severity, "measure": measure}, obj=wire,
    )
    return wire


def reevaluate_all(conn: sqlite3.Connection, campaign_id: str, *, emit_advisory: bool = True) -> dict[str, Any]:
    out = {"created": [], "resolved": [], "advisories": []}
    for al in rows(conn, "SELECT id FROM action_level WHERE campaign_id=?", (campaign_id,)):
        r = evaluate_action_level(conn, campaign_id, al["id"], emit_advisory=emit_advisory)
        out["created"] += r["created"]
        out["resolved"] += r["resolved"]
        out["advisories"] += r["advisories"]
    return out


# ── LOOP 3: industry mitigation -> community feed ─────────────────────────────

INDUSTRY_FORBIDDEN_STATUS = {"resolved", "closed"}


def attach_mitigation_response(
    conn: sqlite3.Connection,
    concern_id: str,
    *,
    body: str,
    org_id: str | None,
    author_id: str | None = None,
    campaign_id: str | None = None,
) -> dict[str, Any] | None:
    """Industry action becomes a concern_response(kind='mitigation') so it shows
    up under the resident's own report in the community feed.

    Industry can move a concern to `mitigation_proposed` and no further.
    """
    c = one(conn, "SELECT * FROM concern WHERE id=?", (concern_id,))
    if c is None:
        return None
    rid = new_id("cr")
    now = timeutil.now_iso()
    conn.execute(
        """INSERT INTO concern_response (id, concern_id, author_id, org_id, role, kind, body, created_at)
           VALUES (?,?,?,?, 'industry', 'mitigation', ?, ?)""",
        (rid, concern_id, author_id, org_id, body, now),
    )
    if c["status"] not in INDUSTRY_FORBIDDEN_STATUS:
        conn.execute("UPDATE concern SET status='mitigation_proposed' WHERE id=?", (concern_id,))
    row = one(conn, "SELECT * FROM concern_response WHERE id=?", (rid,))
    org_name = scalar(conn, "SELECT name FROM org WHERE id=?", (org_id,)) if org_id else None
    wire = shapes.concern_response(row, org_name)
    log(
        conn, "concern.mitigation_proposed",
        campaign_id=campaign_id or c["campaign_id"], actor_role="industry", actor_id=author_id,
        object_type="concern_response", object_id=rid,
        summary=f"Mitigation proposed on “{c['title']}”",
        payload={"concern_id": concern_id, "org_id": org_id}, obj=wire,
    )
    return wire
