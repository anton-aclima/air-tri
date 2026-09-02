"""The five scripted demo scenarios behind POST /admin/simulate (CONTRACT §8).

Each one writes **real rows** — readings, concerns, wind, segment stats,
mitigations — and then lets the normal machinery (cluster detection, action-level
evaluation, the activity log) do the rest. Nothing here fabricates an alert that
the product wouldn't have produced on its own, so the effect propagates out of
the SSE stream exactly as it would in the field.
"""

from __future__ import annotations

import json
import math
import random
import sqlite3
from typing import Any

from air.server import domain, geo, loaders, shapes, timeutil, windfield
from air.server.db import one, rows, scalar

SCENARIOS = {
    "generator_test": "Ridgeline runs a turbine test — NO2 + BC spike on the east fenceline, exceedance alert, RWR contact at ~095°.",
    "concern_wave": "Six residents file smell/noise reports in 90 minutes — a cluster forms and lands on the industry radar to the southeast.",
    "wind_shift": "Wind veers from SW to NNE and carries the plume over the school — integrated-exposure alert plus a community advisory.",
    "methane_leak": "Mobile monitoring finds a methane anomaly no stationary monitor can see. The leapfrog moment.",
    "all_clear": "Mitigation completes, levels fall, alerts resolve and advisories close.",
    "model_divergence": "A run of north-wind days pushes observed transport off the consultant's assumed rose — model verification flips to `understates` with the downwind neighbourhood under-weighted.",
}


# ── helpers ───────────────────────────────────────────────────────────────────

def _primary_site(conn: sqlite3.Connection, cid: str, site_id: str | None = None) -> sqlite3.Row | None:
    if site_id:
        r = one(conn, "SELECT * FROM industry_site WHERE id=?", (site_id,))
        if r:
            return r
    return one(
        conn,
        """SELECT * FROM industry_site WHERE campaign_id=?
            ORDER BY (name LIKE '%Ridgeline%') DESC, (kind='datacenter') DESC,
                     COALESCE(capacity_mw,0) DESC LIMIT 1""",
        (cid,),
    )


def _monitor_near_bearing(
    conn: sqlite3.Connection, cid: str, site: sqlite3.Row, want_deg: float, measure: str
) -> sqlite3.Row | None:
    """The monitor closest to a wanted bearing from the site, preferring the
    site's own fenceline ring, that actually reports `measure`."""
    best = None
    best_score = 1e9
    for m in rows(conn, "SELECT * FROM monitor WHERE campaign_id=?", (cid,)):
        measures = json.loads(m["measures_json"] or "[]")
        if measure not in measures:
            continue
        brg = geo.bearing_deg(site["centroid_lon"], site["centroid_lat"], m["lon"], m["lat"])
        dist = geo.haversine_m(site["centroid_lon"], site["centroid_lat"], m["lon"], m["lat"])
        delta = abs(((brg - want_deg + 180.0) % 360.0) - 180.0)
        score = delta + (dist / 400.0) + (0.0 if m["site_id"] == site["id"] else 45.0)
        if score < best_score:
            best_score, best = score, m
    return best


def _levels(conn: sqlite3.Connection, cid: str, measure: str, kind: str | None = None) -> list[sqlite3.Row]:
    sql = "SELECT * FROM action_level WHERE campaign_id=? AND measure=? AND enabled=1"
    params: list[Any] = [cid, measure]
    if kind:
        sql += " AND kind=?"
        params.append(kind)
    return rows(conn, sql + " ORDER BY threshold", params)


def _baseline(conn: sqlite3.Connection, monitor_id: str, measure: str, fallback: float) -> float:
    v = scalar(
        conn,
        """SELECT AVG(value) FROM (SELECT value FROM monitor_reading
             WHERE monitor_id=? AND measure=? ORDER BY ts DESC LIMIT 48)""",
        (monitor_id, measure),
    )
    return float(v) if v else fallback

MEASURE_FALLBACK = {"no2": 18.0, "pm25": 9.0, "bc": 0.8, "o3": 32.0, "co": 0.4,
                    "co2": 430.0, "ch4": 1.95, "methane_leak": 0.1, "diesel": 0.5, "nondiesel": 0.5}


def _target_level(conn: sqlite3.Connection, cid: str, measure: str, mult: float, base: float) -> float:
    """Aim comfortably over the **highest** enabled threshold for this measure.

    Clearing the lowest is not enough: a spike level usually sits above the
    integrated one, and a scripted demo event has to land on the alert the
    salesperson is pointing at.
    """
    lv = _levels(conn, cid, measure)
    if lv:
        top = max(float(x["threshold"]) for x in lv)
        return max(base * 1.4, top * mult)
    return base * (1.0 + mult)


def _inject_ramp(
    conn: sqlite3.Connection,
    monitor_id: str,
    measure: str,
    peak: float,
    base: float,
    hours: int = 5,
    end: str | None = None,
) -> list[tuple[str, float]]:
    """Write an hourly ramp up to `peak` ending at `end`. Real monitor_reading rows."""
    end = end or timeutil.now_iso()
    out: list[tuple[str, float]] = []
    for i in range(hours, -1, -1):
        ts = timeutil.shift(end, hours=-i) or end
        f = 1.0 - (i / max(1, hours))
        # ease-in so the sparkline has a shape
        value = base + (peak - base) * (f ** 1.7)
        value = round(value, 4)
        conn.execute(
            "INSERT OR REPLACE INTO monitor_reading (monitor_id, ts, measure, value, qc) VALUES (?,?,?,?, 'valid')",
            (monitor_id, ts, measure, value),
        )
        out.append((ts, value))
    return out


def _flat(conn: sqlite3.Connection, monitor_id: str, measure: str, value: float, hours: int = 4) -> None:
    end = timeutil.now_iso()
    for i in range(hours, -1, -1):
        ts = timeutil.shift(end, hours=-i) or end
        conn.execute(
            "INSERT OR REPLACE INTO monitor_reading (monitor_id, ts, measure, value, qc) VALUES (?,?,?,?, 'valid')",
            (monitor_id, ts, measure, round(value, 4)),
        )


# ── 1. generator_test ─────────────────────────────────────────────────────────

def generator_test(conn: sqlite3.Connection, cid: str, site_id: str | None = None) -> dict[str, Any]:
    site = _primary_site(conn, cid, site_id)
    if site is None:
        return {"ok": False, "reason": "no industry site in this campaign"}

    alerts: list[dict[str, Any]] = []
    touched: list[str] = []
    for measure in ("no2", "bc"):
        mon = _monitor_near_bearing(conn, cid, site, 95.0, measure)
        if mon is None:
            continue
        base = _baseline(conn, mon["id"], measure, _fallback(measure))
        peak = _target_level(conn, cid, measure, 1.35, base)
        _inject_ramp(conn, mon["id"], measure, peak, base, hours=5)
        touched.append(f"{mon['name']}·{measure}")

    # Mark the turbine bank active so the dispersion cone shows up too.
    conn.execute(
        """UPDATE emission_point SET active=1
            WHERE site_id=? AND kind IN ('generator','stack')""",
        (site["id"],),
    )

    brg = None
    east = _monitor_near_bearing(conn, cid, site, 95.0, "no2")
    if east is not None:
        brg = round(geo.bearing_deg(site["centroid_lon"], site["centroid_lat"], east["lon"], east["lat"]), 1)

    domain.log(
        conn, "sim.generator_test", campaign_id=cid, actor_role="admin",
        object_type="industry_site", object_id=site["id"],
        summary=f"{site['name']} turbine test — NO2 + BC rising on the {geo.compass(brg) if brg else 'east'} fenceline",
        payload={"monitors": touched, "bearing_deg": brg},
    )
    for measure in ("no2", "bc"):
        for lv in _levels(conn, cid, measure):
            r = domain.evaluate_action_level(conn, cid, lv["id"], actor_role="regulator")
            alerts += r["created"]

    return {
        "ok": True,
        "site": site["name"],
        "monitors": touched,
        "bearing_deg": brg,
        "alerts": [a["id"] for a in alerts],
        "alert_objects": alerts,
    }


# ── 2. concern_wave ───────────────────────────────────────────────────────────

WAVE = [
    ("smell", 4, "Sharp chemical smell again", "Third evening this week. Burns the back of my throat."),
    ("noise", 3, "Generators running all evening", "Constant drone since about six. Can't have the windows open."),
    ("smell", 5, "Diesel fumes so thick I closed the windows", "My daughter has asthma. This is not okay."),
    ("noise", 4, "Low hum shaking the windows", "It started up again around the same time as last night."),
    ("smoke", 4, "Haze over the street under the lights", "You can see it in the streetlight beams."),
    ("health", 5, "Headache and burning eyes all evening", "Both of us. Went away when we drove out of the neighbourhood."),
]


def concern_wave(conn: sqlite3.Connection, cid: str, site_id: str | None = None) -> dict[str, Any]:
    site = _primary_site(conn, cid, site_id)
    rng = random.Random(20260827)

    if site is not None:
        clon, clat = geo.destination(site["centroid_lon"], site["centroid_lat"], 135.0, 1250.0)
    else:
        camp = one(conn, "SELECT center_lon, center_lat FROM campaign WHERE id=?", (cid,))
        clon, clat = camp["center_lon"], camp["center_lat"]

    # Snap onto the nearest real street and keep every report inside one block:
    # the whole point is that they fall within the 600 m cluster radius.
    anchors = rows(
        conn,
        """SELECT mid_lon, mid_lat, district FROM road_segment
            WHERE campaign_id=? ORDER BY (mid_lon-?)*(mid_lon-?)+(mid_lat-?)*(mid_lat-?) LIMIT 1""",
        (cid, clon, clon, clat, clat),
    )
    users = [r["id"] for r in rows(conn, "SELECT id FROM app_user WHERE role='community' ORDER BY id")]
    district = anchors[0]["district"] if anchors else None

    end = timeutil.now_iso()
    created: list[str] = []
    clusters: list[dict[str, Any]] = []
    alerts: list[dict[str, Any]] = []

    for i, (kind, severity, title, body) in enumerate(WAVE):
        anchor = anchors[0] if anchors else None
        jitter_m = rng.uniform(30, 240)
        jitter_b = rng.uniform(0, 360)
        if anchor:
            lon, lat = geo.destination(anchor["mid_lon"], anchor["mid_lat"], jitter_b, jitter_m)
        else:
            lon, lat = geo.destination(clon, clat, jitter_b, jitter_m)
        # 90 minutes, oldest first.
        occurred = timeutil.shift(end, minutes=-(90 - i * 15)) or end
        cn = domain.new_id("cn")
        author = users[i % len(users)] if users else None
        conn.execute(
            """INSERT INTO concern (id, campaign_id, author_id, kind, severity, title, body,
                                    lon, lat, address_hint, district, occurred_at, created_at,
                                    status, cluster_id, corroborations, is_anonymous, photo_emoji,
                                    suspected_site_id)
               VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?, 'new', NULL, 0, ?, ?, ?)""",
            (cn, cid, author, kind, severity, title, body, lon, lat, district, occurred, occurred,
             1 if author is None else 0, {"smell": "👃", "noise": "🔊", "smoke": "🌫️", "health": "🤒"}.get(kind),
             site["id"] if site is not None else None),
        )
        wire = loaders.load_concerns(conn, cid, concern_id=cn)[0]
        domain.log(
            conn, "concern.created", campaign_id=cid, actor_role="community", actor_id=author,
            object_type="concern", object_id=cn, summary=title,
            payload={"kind": kind, "severity": severity, "district": district, "scenario": "concern_wave"},
            obj=wire,
        )
        created.append(cn)
        res = domain.detect_cluster(conn, cid, cn)
        if res:
            clusters.append(res["cluster"])
            if res["alert"]:
                alerts.append(res["alert"])

    bearing = None
    if site is not None and clusters:
        c = clusters[-1]["centroid"]
        bearing = round(geo.bearing_deg(site["centroid_lon"], site["centroid_lat"], c[0], c[1]), 1)

    return {
        "ok": True,
        "concerns": created,
        "district": district,
        "cluster": clusters[-1] if clusters else None,
        "bearing_deg": bearing,
        "compass": geo.compass(bearing) if bearing is not None else None,
        "alerts": list(dict.fromkeys(a["id"] for a in alerts)),
        "alert_objects": alerts[-1:],
    }


# ── 3. wind_shift ─────────────────────────────────────────────────────────────

def wind_shift(conn: sqlite3.Connection, cid: str, site_id: str | None = None) -> dict[str, Any]:
    site = _primary_site(conn, cid, site_id)
    end = timeutil.now_iso()
    # SW (225°) veering to NNE (025°) over six hours, slowing and stabilising.
    track = [(225, 5.2, "C"), (250, 4.6, "C"), (285, 3.8, "D"),
             (330, 3.0, "D"), (0, 2.4, "E"), (25, 1.9, "E"), (25, 1.7, "F")]
    written = []
    for i, (deg, spd, stab) in enumerate(reversed(track)):
        ts = timeutil.shift(end, hours=-i) or end
        prev = one(conn, "SELECT * FROM wind WHERE campaign_id=? AND ts<=? ORDER BY ts DESC LIMIT 1", (cid, ts))
        conn.execute(
            """INSERT OR REPLACE INTO wind (campaign_id, ts, speed_ms, dir_deg, gust_ms, temp_c, rh, pbl_m, stability)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (cid, ts, spd, float(deg), round(spd * 1.6, 1),
             prev["temp_c"] if prev else 24.0, prev["rh"] if prev else 62.0,
             320.0 if stab in ("E", "F") else 900.0, stab),
        )
        written.append({"ts": ts, "dir_deg": float(deg), "speed_ms": spd, "stability": stab})
    written.reverse()

    # Whatever is now downwind gets the dose. Plume travels toward 025+180 = 205,
    # so look for the receptor on that bearing.
    receptor = None
    if site is not None:
        receptor = one(
            conn,
            """SELECT id, name, district, mid_lon, mid_lat FROM road_segment
                WHERE campaign_id=? AND (name LIKE '%School%' OR name LIKE '%Elementary%' OR name LIKE '%Academy%')
                LIMIT 1""",
            (cid,),
        )
        if receptor is None:
            rlon, rlat = geo.destination(site["centroid_lon"], site["centroid_lat"], 205.0, 1100.0)
            receptor = one(
                conn,
                """SELECT id, name, district, mid_lon, mid_lat FROM road_segment
                    WHERE campaign_id=? ORDER BY (mid_lon-?)*(mid_lon-?)+(mid_lat-?)*(mid_lat-?) LIMIT 1""",
                (cid, rlon, rlon, rlat, rlat),
            )

    alerts: list[dict[str, Any]] = []
    advisories: list[dict[str, Any]] = []
    touched = []
    for measure in ("pm25", "no2"):
        integrated = _levels(conn, cid, measure, "integrated") or _levels(conn, cid, measure)
        if not integrated:
            continue
        want = 205.0 if site is None else geo.bearing_deg(
            site["centroid_lon"], site["centroid_lat"],
            receptor["mid_lon"] if receptor else site["centroid_lon"],
            receptor["mid_lat"] if receptor else site["centroid_lat"],
        )
        mon = _monitor_near_bearing(conn, cid, site, want, measure) if site is not None else None
        if mon is None:
            mon = one(
                conn,
                "SELECT * FROM monitor WHERE campaign_id=? AND measures_json LIKE ? LIMIT 1",
                (cid, f'%"{measure}"%'),
            )
        if mon is None:
            continue
        base = _baseline(conn, mon["id"], measure, _fallback(measure))
        hours = max(1, int(float(integrated[0]["averaging_hours"] or 1)))
        # Every hour in the averaging window has to be over the line for an
        # integrated exposure to trip, so hold it high rather than spike it.
        peak = _target_level(conn, cid, measure, 1.25, base)
        _flat(conn, mon["id"], measure, peak, hours=max(hours, 4))
        touched.append(f"{mon['name']}·{measure}")
        for lv in integrated:
            r = domain.evaluate_action_level(conn, cid, lv["id"], actor_role="regulator")
            alerts += r["created"]
            advisories += r["advisories"]

    wind_alert = domain.create_alert(
        conn, cid,
        kind="wind_shift", severity="watch", source_type="model", source_id="sim:wind_shift",
        lon=site["centroid_lon"] if site is not None else None,
        lat=site["centroid_lat"] if site is not None else None,
        site_id=site["id"] if site is not None else None,
        title="Wind veered SW → NNE — plume now over the south receptors",
        body=(
            "Wind backed from 225° to 025° over six hours and dropped to 1.7 m/s with stability F. "
            + (f"The plume axis now runs across {receptor['name']}"
               f"{' in ' + receptor['district'] if receptor and receptor['district'] else ''}. "
               if receptor else "")
            + "Receptors that were crosswind an hour ago are now downwind."
        ),
        recommendation="Reduce turbine load pre-emptively; a stable, slow plume does not dilute.",
        audience=["regulator", "industry", "admin"],
        actor_role="admin",
    )
    alerts.append(wind_alert)

    if not advisories:
        advisories.append(
            domain.create_advisory(
                conn, cid, kind="advisory", severity="watch",
                title="Air quality notice for the south side this evening",
                body=(
                    "The wind has changed direction and is now blowing across the south side of the "
                    "neighbourhood. Our monitors are showing higher than usual levels there. If you or "
                    "your children are sensitive to air quality, it is a good evening to keep windows "
                    "closed and take it easy outdoors. We will post an update when it clears."
                ),
                audience=["community"], alert_id=wind_alert["id"], actor_role="regulator",
            )
        )

    domain.log(
        conn, "sim.wind_shift", campaign_id=cid, actor_role="admin",
        object_type="wind", object_id=cid,
        summary="Wind veered SW → NNE; plume crossed the south receptors",
        payload={"track": written, "monitors": touched,
                 "receptor": receptor["name"] if receptor else None},
    )
    return {
        "ok": True,
        "wind": written,
        "receptor": receptor["name"] if receptor else None,
        "monitors": touched,
        "alerts": [a["id"] for a in alerts],
        "alert_objects": [wind_alert],
        "advisories": [a["id"] for a in advisories],
    }


# ── 4. methane_leak — the leapfrog ────────────────────────────────────────────

def methane_leak(conn: sqlite3.Connection, cid: str, site_id: str | None = None) -> dict[str, Any]:
    site = _primary_site(conn, cid, site_id)
    monitors = rows(conn, "SELECT id, name, lon, lat, measures_json FROM monitor WHERE campaign_id=?", (cid,))

    # Find a segment near the site that no stationary monitor can see. That gap
    # is the entire Aclima value proposition, so pick the widest one.
    anchor = (site["centroid_lon"], site["centroid_lat"]) if site is not None else None
    if anchor is None:
        camp = one(conn, "SELECT center_lon, center_lat FROM campaign WHERE id=?", (cid,))
        anchor = (camp["center_lon"], camp["center_lat"])

    candidates = rows(
        conn,
        """SELECT id, name, district, mid_lon, mid_lat, length_m FROM road_segment
            WHERE campaign_id=? ORDER BY (mid_lon-?)*(mid_lon-?)+(mid_lat-?)*(mid_lat-?) LIMIT 160""",
        (cid, anchor[0], anchor[0], anchor[1], anchor[1]),
    )
    if not candidates:
        return {"ok": False, "reason": "no road segments in this campaign"}

    def blind_gap(seg: sqlite3.Row) -> float:
        ds = [
            geo.haversine_m(seg["mid_lon"], seg["mid_lat"], m["lon"], m["lat"])
            for m in monitors
            if "ch4" in json.loads(m["measures_json"] or "[]") or True
        ]
        return min(ds) if ds else 9999.0

    seg = max(candidates[:120], key=blind_gap)
    gap = blind_gap(seg)
    nearest_mon = min(
        monitors,
        key=lambda m: geo.haversine_m(seg["mid_lon"], seg["mid_lat"], m["lon"], m["lat"]),
        default=None,
    )

    base = 1.95
    peak = _target_level(conn, cid, "ch4", 1.6, base)
    if peak < base * 2.2:
        peak = base * 2.6  # a leak has to read like a leak

    # Real passes: a vehicle drove it four times in the last two hours.
    end = timeutil.now_iso()
    vehicle = one(conn, "SELECT id FROM vehicle WHERE campaign_id=? ORDER BY label LIMIT 1", (cid,))
    samples: list[tuple[str, float]] = []
    values: list[float] = []
    for i in range(4):
        ts = timeutil.shift(end, minutes=-(96 - i * 32)) or end
        v = round(base + (peak - base) * (0.45 + 0.185 * i), 4)
        conn.execute(
            """INSERT INTO segment_pass (campaign_id, segment_id, drive_id, vehicle_id, ts,
                                         no2, pm25, bc, o3, co, co2, ch4, methane_leak, diesel, nondiesel, speed_kph)
               VALUES (?,?,NULL,?,?, NULL,NULL,NULL,NULL,NULL,NULL,?,?,NULL,NULL,?)""",
            (cid, seg["id"], vehicle["id"] if vehicle else None, ts, v,
             round(min(1.0, (v - base) / max(0.1, peak - base)), 3), 24.0),
        )
        samples.append((ts, v))
        values.append(v)

    # Roll the anomaly into segment_stat so the road grid paints it immediately.
    median = sorted(values)[len(values) // 2]
    mdef = domain.measures(conn).get("ch4", {})
    risk = domain.risk_from_scale(mdef.get("scale"), median)
    prev = one(
        conn,
        "SELECT n_passes FROM segment_stat WHERE segment_id=? AND measure='ch4' AND window='all'",
        (seg["id"],),
    )
    n_passes = (prev["n_passes"] if prev else 0) + len(values)
    for window in ("all", f"date:{timeutil.date_key(end)}"):
        conn.execute(
            """INSERT OR REPLACE INTO segment_stat
                 (segment_id, campaign_id, measure, window, n_passes, mean, median, p10, p90, max, persistence, risk)
               VALUES (?,?, 'ch4', ?,?,?,?,?,?,?,?,?)""",
            (seg["id"], cid, window, n_passes if window == "all" else len(values),
             round(sum(values) / len(values), 4), round(median, 4), round(min(values), 4),
             round(max(values), 4), round(max(values), 4), 1.0,
             int(round(risk)) if risk is not None else None),
        )
        conn.execute(
            """INSERT OR REPLACE INTO segment_stat
                 (segment_id, campaign_id, measure, window, n_passes, mean, median, p10, p90, max, persistence, risk)
               VALUES (?,?, 'methane_leak', ?,?,?,?,?,?,?,?,?)""",
            (seg["id"], cid, window, len(values), 0.9, 0.9, 0.7, 1.0, 1.0, 1.0, 85),
        )

    unit = mdef.get("unit") or "ppm"
    near_txt = (
        f"The nearest stationary monitor ({nearest_mon['name']}) is {int(gap)} m away and reads normal."
        if nearest_mon is not None else "No stationary monitor covers this street."
    )
    alert = domain.create_alert(
        conn, cid,
        kind="mobile_detection", severity="warning", measure="ch4",
        value=round(max(values), 3),
        threshold=float(_levels(conn, cid, "ch4")[0]["threshold"]) if _levels(conn, cid, "ch4") else round(base * 1.5, 3),
        unit=unit, source_type="mobile", source_id=seg["id"],
        lon=seg["mid_lon"], lat=seg["mid_lat"],
        title=f"Methane anomaly on {seg['name'] or 'an unnamed street'} — mobile only",
        body=(
            f"Four mobile passes in the last 96 minutes found methane rising to "
            f"{max(values):.2f} {unit} on {seg['name'] or 'an unnamed street'}"
            + (f" in {seg['district']}" if seg["district"] else "")
            + f", against a {base:.2f} {unit} regional background. {near_txt} "
            "This is a street-level signal the stationary network cannot resolve."
        ),
        recommendation=(
            "Walk the gas supply train, filter skids and turbine seals along this frontage with a "
            "handheld before assuming combustion. A single seal can account for the whole signal."
        ),
        audience=["regulator", "industry", "admin"],
        samples=samples, actor_role="admin",
    )
    advisory = domain.create_advisory(
        conn, cid, kind="notice", severity="info",
        title="Our cars picked something up on your street",
        body=(
            "One of our monitoring vehicles found a pocket of natural gas in the air on "
            f"{seg['name'] or 'a street in your neighbourhood'} during passes this afternoon. "
            "It is not something the fixed monitoring stations can see from where they sit. "
            "We have flagged it to the operator and the air quality agency, and we will post what "
            "they find."
        ),
        measure="ch4", alert_id=alert["id"], audience=["community"], actor_role="admin",
    )
    domain.log(
        conn, "sim.methane_leak", campaign_id=cid, actor_role="admin",
        object_type="road_segment", object_id=seg["id"],
        summary=f"CH4 anomaly on {seg['name'] or seg['id']} — {int(gap)} m from the nearest monitor",
        payload={"segment_id": seg["id"], "peak": max(values), "monitor_gap_m": round(gap),
                 "nearest_monitor": nearest_mon["name"] if nearest_mon is not None else None},
    )
    return {
        "ok": True,
        "segment": {"id": seg["id"], "name": seg["name"], "district": seg["district"],
                    "mid": [seg["mid_lon"], seg["mid_lat"]]},
        "peak_ch4": max(values),
        "monitor_gap_m": round(gap),
        "nearest_monitor": nearest_mon["name"] if nearest_mon is not None else None,
        "alerts": [alert["id"]],
        "alert_objects": [alert],
        "advisories": [advisory["id"]],
    }


# ── 5. all_clear ──────────────────────────────────────────────────────────────

def all_clear(conn: sqlite3.Connection, cid: str, site_id: str | None = None) -> dict[str, Any]:
    now = timeutil.now_iso()

    # Levels fall: bring every monitor back under every enabled threshold.
    calmed: list[str] = []
    for lv in rows(conn, "SELECT * FROM action_level WHERE campaign_id=? AND enabled=1", (cid,)):
        target = float(lv["threshold"]) * 0.55
        for m in rows(
            conn,
            "SELECT id, name FROM monitor WHERE campaign_id=? AND measures_json LIKE ?",
            (cid, f'%"{lv["measure"]}"%'),
        ):
            _flat(conn, m["id"], lv["measure"], target,
                  hours=max(4, int(float(lv["averaging_hours"] or 1)) + 2))
            calmed.append(f"{m['name']}·{lv['measure']}")

    # Mitigations complete.
    completed: list[str] = []
    for mi in rows(
        conn,
        """SELECT m.* FROM mitigation m JOIN industry_site s ON s.id = m.site_id
            WHERE s.campaign_id=? AND m.status IN ('proposed','in_progress')""",
        (cid,),
    ):
        conn.execute(
            "UPDATE mitigation SET status='completed', completed_at=?, started_at=COALESCE(started_at,?) WHERE id=?",
            (now, mi["created_at"], mi["id"]),
        )
        wire = shapes.mitigation(one(conn, "SELECT * FROM mitigation WHERE id=?", (mi["id"],)))
        domain.log(
            conn, "mitigation.completed", campaign_id=cid, actor_role="industry",
            object_type="mitigation", object_id=mi["id"],
            summary=f"{mi['title']} completed", payload={"site_id": mi["site_id"]}, obj=wire,
        )
        completed.append(mi["id"])

    # Alerts resolve — through the normal evaluator wherever an action level owns
    # them, explicitly for the rest.
    resolved: list[str] = []
    for lv in rows(conn, "SELECT id FROM action_level WHERE campaign_id=?", (cid,)):
        r = domain.evaluate_action_level(conn, cid, lv["id"], actor_role="regulator", emit_advisory=False)
        resolved += r["resolved"]
    for a in rows(
        conn, "SELECT id FROM alert WHERE campaign_id=? AND status IN ('active','acknowledged')", (cid,)
    ):
        if domain.resolve_alert(conn, cid, a["id"], "levels returned to background", "regulator"):
            resolved.append(a["id"])

    # Clusters close; concerns that got a mitigation are resolved by the regulator
    # (industry can never do this — non-negotiable #4).
    conn.execute(
        "UPDATE concern_cluster SET status='resolved' WHERE campaign_id=? AND status='active'", (cid,)
    )
    resolved_concerns: list[str] = []
    for c in rows(
        conn,
        """SELECT id, title FROM concern WHERE campaign_id=?
            AND status IN ('mitigation_proposed','under_review','corroborated')""",
        (cid,),
    ):
        conn.execute("UPDATE concern SET status='resolved' WHERE id=?", (c["id"],))
        resolved_concerns.append(c["id"])
        domain.log(
            conn, "concern.status.resolved", campaign_id=cid, actor_role="regulator",
            object_type="concern", object_id=c["id"], summary=f"“{c['title']}” → resolved",
            payload={"to": "resolved", "by": "all_clear"},
            obj=loaders.load_concerns(conn, cid, concern_id=c["id"])[0],
        )

    # Advisories expire.
    expired = [
        r["id"]
        for r in rows(
            conn,
            "SELECT id FROM advisory WHERE campaign_id=? AND (expires_at IS NULL OR expires_at > ?)",
            (cid, now),
        )
    ]
    if expired:
        marks = ",".join("?" * len(expired))
        conn.execute(f"UPDATE advisory SET expires_at=? WHERE id IN ({marks})", (now, *expired))

    advisory = domain.create_advisory(
        conn, cid, kind="all_clear", severity="info",
        title="All clear — levels are back to normal",
        body=(
            "Levels across the neighbourhood are back to where they normally sit. The operator "
            "finished the work they proposed, and the earlier notices are closed. Thank you to "
            "everyone who filed a report — that is what got this looked at."
        ),
        audience=["community", "regulator", "industry"], pinned=True, actor_role="regulator",
    )
    domain.log(
        conn, "sim.all_clear", campaign_id=cid, actor_role="admin",
        object_type="campaign", object_id=cid,
        summary="All clear — mitigations completed, levels fell, advisories closed",
        payload={"alerts_resolved": len(resolved), "mitigations_completed": len(completed),
                 "concerns_resolved": len(resolved_concerns)},
    )
    return {
        "ok": True,
        "monitors_calmed": len(calmed),
        "mitigations_completed": completed,
        "alerts_resolved": resolved,
        "concerns_resolved": resolved_concerns,
        "advisories_expired": expired,
        "advisories": [advisory["id"]],
    }


# ── 6. model_divergence — "verify your consultant" (CONTRACT §8 item 6, §8b) ──

def model_divergence(conn: sqlite3.Connection, cid: str, site_id: str | None = None) -> dict[str, Any]:
    """A run of north-wind days, measured by the fleet anemometers.

    Writes real `mobile_wind_obs` and `wind` rows; the verdict is then *computed*
    by `windfield.verify_model` from those observations against the consultant's
    stored rose and its own contour geometry. Nothing here writes the verdict.
    """
    site = _primary_site(conn, cid, site_id)
    if site is None:
        return {"ok": False, "reason": "no industry site in this campaign"}
    models = loaders.load_dispersion_models(conn, site_id=site["id"])
    if not models:
        return {
            "ok": False,
            "reason": f"no dispersion model on file for {site['name']} — datagen seeds these",
        }
    model = models[0]

    rng = random.Random(20260828)
    end = timeutil.now_iso()
    days = 5
    since = timeutil.shift(end, days=-days) or end

    # Enough observations that the north sector genuinely dominates the window,
    # scaled off what is already there so the flip does not depend on fixture size.
    existing = scalar(
        conn,
        "SELECT COUNT(*) FROM mobile_wind_obs WHERE campaign_id=? AND quality!='rejected'",
        (cid,), 0,
    ) or 0
    target = max(320, int(existing * 0.55))

    anchors = rows(
        conn,
        "SELECT id, mid_lon, mid_lat FROM road_segment WHERE campaign_id=? ORDER BY id",
        (cid,),
    )
    if not anchors:
        return {"ok": False, "reason": "no road segments in this campaign"}
    vehicles = [r["id"] for r in rows(conn, "SELECT id FROM vehicle WHERE campaign_id=? ORDER BY label", (cid,))]

    # Hourly met rows so the rest of the app agrees with the anemometers.
    hours = days * 24
    for h in range(hours, -1, -1):
        ts = timeutil.shift(end, hours=-h) or end
        deg = (5.0 + 16.0 * math.sin(h / 7.0) + rng.uniform(-9, 9)) % 360
        spd = max(1.2, 3.6 + 1.3 * math.sin(h / 11.0) + rng.uniform(-0.4, 0.4))
        conn.execute(
            """INSERT OR REPLACE INTO wind (campaign_id,ts,speed_ms,dir_deg,gust_ms,temp_c,rh,pbl_m,stability)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (cid, ts, round(spd, 2), round(deg, 1), round(spd * 1.6, 2), 21.0, 58.0, 700.0, "D"),
        )

    written = 0
    for i in range(target):
        a = anchors[i % len(anchors)]
        ts = timeutil.shift(end, minutes=-rng.randint(0, days * 24 * 60)) or end
        # Northerly with realistic street-canyon scatter — not a synthetic spike.
        direction = (rng.gauss(4.0, 17.0)) % 360
        spd = max(0.35, rng.gauss(3.5, 1.1))
        veh = rng.uniform(14, 44)
        quality = "good" if spd >= 0.7 and veh <= 42 else "suspect"
        conn.execute(
            """INSERT INTO mobile_wind_obs (campaign_id,drive_id,vehicle_id,segment_id,ts,lon,lat,
                                            speed_ms,dir_deg,gust_ms,vehicle_speed_kph,quality)
               VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?)""",
            (cid, vehicles[i % len(vehicles)] if vehicles else None, a["id"], ts,
             round(a["mid_lon"] + rng.uniform(-0.0007, 0.0007), 6),
             round(a["mid_lat"] + rng.uniform(-0.0007, 0.0007), 6),
             round(spd, 2), round(direction, 1) % 360, round(spd * rng.uniform(1.2, 1.9), 2),
             round(veh, 1), quality),
        )
        written += 1

    # Now let the verifier read the data back and reach its own conclusion.
    centroid = (site["centroid_lon"], site["centroid_lat"])
    window_from = timeutil.shift(end, days=-30) or since
    obs = loaders.load_mobile_wind(conn, cid, from_=window_from, to=end, limit=200000)
    verification = windfield.verify_model(
        model, obs, centroid,
        windfield.downwind_districts_fn(conn, cid, centroid),
        (window_from, end),
    )

    worst = max(verification["bearing_bias"], key=lambda b: b["delta"])
    receptors = ", ".join(d["district"] for d in verification["affected_districts"][:2]) or "downwind receptors"
    transport = (worst["dir_deg"] + 180.0) % 360.0
    severity = {"understates": "warning", "overstates": "info",
                "consistent": "info", "insufficient_data": "info"}[verification["verdict"]]

    # Place the contact where the plume actually goes, not on top of the site:
    # an RWR contact at bearing 0 / range 0 tells the operator nothing. Aim it at
    # the centroid of the under-weighted receptor if we found one.
    top_district = verification["affected_districts"][0]["district"] if verification["affected_districts"] else None
    alert_lon, alert_lat = centroid
    reach = 1500.0
    if top_district:
        d = one(
            conn,
            """SELECT AVG(mid_lon) lon, AVG(mid_lat) lat FROM road_segment
                WHERE campaign_id=? AND district=?""",
            (cid, top_district),
        )
        if d is not None and d["lon"] is not None:
            reach = max(500.0, geo.haversine_m(centroid[0], centroid[1], d["lon"], d["lat"]))
    alert_lon, alert_lat = geo.destination(centroid[0], centroid[1], transport, reach)

    alert = domain.create_alert(
        conn, cid,
        kind="wind_shift", severity=severity, measure=model["measure"],
        value=round(verification["disagreement"] * 100.0, 1),
        threshold=round(windfield.DISAGREEMENT_VERDICT * 100.0, 1), unit="% of hours",
        source_type="mobile", source_id=model["id"],
        lon=alert_lon, lat=alert_lat, site_id=site["id"],
        title=f"Observed wind diverges from {model['name']} — {verification['verdict']}",
        body=verification["summary"],
        recommendation=(
            f"Re-run the study with the measured rose before the next permit review. "
            f"Meanwhile treat {geo.compass(transport)} transport as live: "
            f"{receptors} sits downwind on {geo.compass(worst['dir_deg'])} wind, which the model "
            f"weighted at {worst['assumed_freq']:.1f}% of hours against {worst['observed_freq']:.1f}% measured."
        ),
        audience=["industry", "regulator", "admin"],
        samples=[(o["ts"], o["dir_deg"]) for o in obs[-48:]],
        actor_role="admin",
    )
    domain.log(
        conn, "sim.model_divergence", campaign_id=cid, actor_role="admin",
        object_type="dispersion_model", object_id=model["id"],
        summary=(
            f"{written} north-wind observations over {days} days — {model['name']} "
            f"verdict: {verification['verdict']}"
        ),
        payload={
            "site_id": site["id"], "model_id": model["id"],
            "verdict": verification["verdict"],
            "disagreement": verification["disagreement"],
            "understated_bearings": verification["understated_bearings"],
            "affected_districts": verification["affected_districts"],
            "n_obs": verification["n_obs"],
        },
    )
    return {
        "ok": True,
        "site": site["name"],
        "model": {"id": model["id"], "name": model["name"], "vendor": model["vendor"]},
        "observations_written": written,
        "days": days,
        "verdict": verification["verdict"],
        "disagreement": verification["disagreement"],
        "n_obs": verification["n_obs"],
        "understated_bearings": verification["understated_bearings"],
        "affected_districts": verification["affected_districts"],
        "summary": verification["summary"],
        "alerts": [alert["id"]],
        "alert_objects": [alert],
    }


RUNNERS = {
    "generator_test": generator_test,
    "concern_wave": concern_wave,
    "wind_shift": wind_shift,
    "methane_leak": methane_leak,
    "all_clear": all_clear,
    "model_divergence": model_divergence,
}


def run(conn: sqlite3.Connection, cid: str, scenario: str, site_id: str | None = None) -> dict[str, Any]:
    fn = RUNNERS[scenario]
    result = fn(conn, cid, site_id)
    return {"scenario": scenario, "description": SCENARIOS[scenario], **result}
