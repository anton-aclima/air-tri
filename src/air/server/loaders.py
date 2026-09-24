"""Shared read paths. Several routers (bootstrap, feed, advisor, admin) need the
same fully-shaped objects; assemble them once here."""

from __future__ import annotations

import sqlite3
from typing import Any

from air.server import cache, config, geo, shapes
from air.server.db import one, rows


def spike_thresholds(conn: sqlite3.Connection, campaign_id: str) -> dict[str, float]:
    """Lowest enabled spike threshold per measure — drives `exceeds` flags."""
    key = ("thresholds", campaign_id)
    hit = cache.get(key)
    if hit is not None:
        return hit
    out: dict[str, float] = {}
    for r in rows(
        conn,
        """SELECT measure, MIN(threshold) AS t FROM action_level
            WHERE campaign_id=? AND enabled=1 GROUP BY measure""",
        (campaign_id,),
    ):
        if r["t"] is not None:
            out[r["measure"]] = float(r["t"])
    return cache.put(key, out)


def latest_readings(
    conn: sqlite3.Connection, campaign_id: str, *, at: str | None = None
) -> dict[str, dict[str, Any]]:
    """{monitor_id: {measure: {value, ts, exceeds}}} — one query, window function.

    `at` makes it the latest reading AS OF that moment. Without it this is the
    newest row in the table, which is the end of the data whatever the screen
    is showing."""
    thresholds = spike_thresholds(conn, campaign_id)
    out: dict[str, dict[str, Any]] = {}
    bound = "AND r.ts <= ?" if at else ""
    for r in rows(
        conn,
        f"""SELECT monitor_id, measure, value, ts FROM (
               SELECT r.monitor_id, r.measure, r.value, r.ts,
                      ROW_NUMBER() OVER (PARTITION BY r.monitor_id, r.measure ORDER BY r.ts DESC) rn
                 FROM monitor_reading r JOIN monitor m ON m.id = r.monitor_id
                WHERE m.campaign_id = ? AND r.qc = 'valid' {bound}
             ) WHERE rn = 1""",
        (campaign_id, at) if at else (campaign_id,),
    ):
        t = thresholds.get(r["measure"])
        out.setdefault(r["monitor_id"], {})[r["measure"]] = {
            "value": r["value"],
            "ts": r["ts"],
            "exceeds": bool(t is not None and r["value"] is not None and r["value"] > t),
        }
    return out


def load_monitors(
    conn: sqlite3.Connection,
    campaign_id: str,
    *,
    monitor_id: str | None = None,
    owner_type: str | None = None,
    grade: str | None = None,
    site_id: str | None = None,
    at: str | None = None,
) -> list[dict[str, Any]]:
    sql = ["SELECT * FROM monitor WHERE campaign_id = ?"]
    params: list[Any] = [campaign_id]
    if monitor_id:
        sql.append("AND id = ?")
        params.append(monitor_id)
    if owner_type:
        sql.append("AND owner_type = ?")
        params.append(owner_type)
    if grade:
        sql.append("AND grade = ?")
        params.append(grade)
    if site_id:
        sql.append("AND site_id = ?")
        params.append(site_id)
    sql.append("ORDER BY owner_type, name")
    latest = latest_readings(conn, campaign_id, at=at)
    return [shapes.monitor(r, latest.get(r["id"], {})) for r in rows(conn, " ".join(sql), params)]


def load_sites(
    conn: sqlite3.Connection, campaign_id: str, *, site_id: str | None = None
) -> list[dict[str, Any]]:
    sql = ["SELECT * FROM industry_site WHERE campaign_id = ?"]
    params: list[Any] = [campaign_id]
    if site_id:
        sql.append("AND id = ?")
        params.append(site_id)
    sql.append("ORDER BY name")
    sites = rows(conn, " ".join(sql), params)
    if not sites:
        return []
    ids = {s["id"] for s in sites}
    points: dict[str, list] = {}
    marks = ",".join("?" * len(ids))
    for p in rows(
        conn, f"SELECT * FROM emission_point WHERE site_id IN ({marks}) ORDER BY kind, name", tuple(ids)
    ):
        points.setdefault(p["site_id"], []).append(shapes.emission_point(p))
    return [shapes.industry_site(s, points.get(s["id"], [])) for s in sites]


def cluster_members(conn: sqlite3.Connection, cluster_ids: list[str]) -> dict[str, list[sqlite3.Row]]:
    """{cluster_id: [member rows]} — the stamps a cluster is recounted from."""
    if not cluster_ids:
        return {}
    marks = ",".join("?" * len(cluster_ids))
    out: dict[str, list[sqlite3.Row]] = {}
    for m in rows(
        conn,
        f"SELECT cluster_id, created_at, occurred_at, kind FROM concern WHERE cluster_id IN ({marks})",
        tuple(cluster_ids),
    ):
        out.setdefault(m["cluster_id"], []).append(m)
    return out


def cluster_as_of(
    stored_count: int, members: list[sqlite3.Row], until: str
) -> tuple[int, list[sqlite3.Row]] | None:
    """A cluster as it stood at `until`: (count, members posted by then), or
    None when it had not formed yet.

    THE one recount rule — /clusters and the `cluster_id` on every report
    served with `until` both come through here, so a report is never labelled
    part of a group that /clusters says did not exist. The stored row is the
    cluster's final shape; members posted after `until` come off its count, and
    below CLUSTER_MIN_COUNT it had not formed. With every member posted the row
    stands as stored. `clusterAsOf` in web/src/apps/community/lib.ts is the same
    rule, so a bounded row passes through it unchanged."""
    posted = [m for m in members if m["created_at"] <= until]
    if len(posted) == len(members):
        return stored_count, posted
    count = stored_count - (len(members) - len(posted))
    if count < config.CLUSTER_MIN_COUNT or not posted:
        return None
    return count, posted


def load_concerns(
    conn: sqlite3.Connection,
    campaign_id: str,
    *,
    concern_id: str | None = None,
    status: str | None = None,
    kind: str | None = None,
    since: str | None = None,
    until: str | None = None,
    cluster_id: str | None = None,
    near: tuple[float, float, float] | None = None,
    limit: int = 500,
    with_responses: bool = True,
) -> list[dict[str, Any]]:
    """`until` is an upper bound on `created_at` — "filed by then" — applied
    before the LIMIT, so a replayed moment gets its own newest N, not the end
    of the data's newest N filtered down to nothing (docs/PLAN-refocus.md F2).

    With `until`, everything that rides on a report is served as it stood then
    too, not only the report list:

    - `cluster_id` is null while the cluster had not formed (`cluster_as_of`).
      At Jun 17 08:30 two of cl-01's reports were posted and /clusters did not
      list it, yet both came back with cluster_id='cl-01-2026', and the feed
      card said "Part of a group of nearby reports" over a group of two. With
      the `cluster_id` filter, a cluster that had not formed has no members.
    - `responses` are the ones filed by then. At Jun 17 09:00 cn-0100-0009
      carried a Jun 18 mitigation reply and a Jul 11 regulator finding.

    `status` is the final one: only it is stored, so it cannot be rebuilt."""
    sql = ["SELECT * FROM concern WHERE campaign_id = ?"]
    params: list[Any] = [campaign_id]
    if concern_id:
        sql.append("AND id = ?")
        params.append(concern_id)
    if status:
        sql.append("AND status IN (%s)" % ",".join("?" * len(status.split(","))))
        params += status.split(",")
    if kind:
        sql.append("AND kind IN (%s)" % ",".join("?" * len(kind.split(","))))
        params += kind.split(",")
    if since:
        sql.append("AND created_at >= ?")
        params.append(since)
    if until:
        sql.append("AND created_at <= ?")
        params.append(until)
    if cluster_id:
        sql.append("AND cluster_id = ?")
        params.append(cluster_id)
    sql.append("ORDER BY created_at DESC LIMIT ?")
    params.append(max(1, min(limit, 5000)))

    found = rows(conn, " ".join(sql), params)
    if near is not None:
        lon, lat, radius = near
        found = [c for c in found if geo.haversine_m(lon, lat, c["lon"], c["lat"]) <= radius]
    if not found:
        return []

    ids = [c["id"] for c in found]
    marks = ",".join("?" * len(ids))
    responses: dict[str, list] = {}
    if with_responses:
        filed = "AND cr.created_at <= ?" if until else ""
        for r in rows(
            conn,
            f"""SELECT cr.*, o.name AS org_name FROM concern_response cr
                  LEFT JOIN org o ON o.id = cr.org_id
                 WHERE cr.concern_id IN ({marks}) {filed} ORDER BY cr.created_at""",
            (*ids, until) if until else tuple(ids),
        ):
            responses.setdefault(r["concern_id"], []).append(shapes.concern_response(r))

    author_ids = {c["author_id"] for c in found if c["author_id"] and not c["is_anonymous"]}
    authors: dict[str, dict] = {}
    if author_ids:
        amarks = ",".join("?" * len(author_ids))
        for u in rows(conn, f"SELECT * FROM app_user WHERE id IN ({amarks})", tuple(author_ids)):
            authors[u["id"]] = shapes.author_stub(u)

    # `conn` is passed so the serialiser can snap coordinates to the road grid.
    # Every reader of the API comes through here, which is the point: there is
    # no path that serves a house-precision report coordinate.
    out = [
        shapes.concern(c, authors.get(c["author_id"]), responses.get(c["id"], []), conn=conn)
        for c in found
    ]
    if until:
        clusters = sorted({c["cluster_id"] for c in out if c["cluster_id"]})
        if clusters:
            cmarks = ",".join("?" * len(clusters))
            stored = {
                r["id"]: r["count"]
                for r in rows(
                    conn, f"SELECT id, count FROM concern_cluster WHERE id IN ({cmarks})", tuple(clusters)
                )
            }
            members = cluster_members(conn, clusters)
            formed = {
                k for k in clusters
                if cluster_as_of(stored.get(k, len(members.get(k, []))), members.get(k, []), until)
            }
            for c in out:
                if c["cluster_id"] and c["cluster_id"] not in formed:
                    c["cluster_id"] = None
            if cluster_id:
                out = [c for c in out if c["cluster_id"] == cluster_id]
    return out


def load_posts(
    conn: sqlite3.Connection,
    campaign_id: str,
    *,
    post_id: str | None = None,
    site_id: str | None = None,
    kind: str | None = None,
    concern_id: str | None = None,
    until: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    sql = [
        """SELECT p.*, o.name AS org_name, o.brand_color, o.logo_emoji
             FROM site_post p LEFT JOIN org o ON o.id = p.org_id
            WHERE p.campaign_id = ?"""
    ]
    params: list[Any] = [campaign_id]
    if post_id:
        sql.append("AND p.id = ?")
        params.append(post_id)
    if site_id:
        sql.append("AND p.site_id = ?")
        params.append(site_id)
    if kind:
        sql.append("AND p.kind IN (%s)" % ",".join("?" * len(kind.split(","))))
        params += kind.split(",")
    if concern_id:
        sql.append("AND p.concern_id = ?")
        params.append(concern_id)
    if until:
        sql.append("AND p.created_at <= ?")
        params.append(until)
    sql.append("ORDER BY p.pinned DESC, p.created_at DESC LIMIT ?")
    params.append(max(1, min(limit, 2000)))
    return [shapes.site_post(r) for r in rows(conn, " ".join(sql), params)]


def load_advisories(
    conn: sqlite3.Connection,
    campaign_id: str,
    *,
    audience: str | None = None,
    active_only: bool = False,
    now: str | None = None,
    until: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    sql = ["SELECT * FROM advisory WHERE campaign_id = ?"]
    params: list[Any] = [campaign_id]
    if active_only and now:
        # `>`: sim.py expires a notice by setting expires_at to now.
        sql.append("AND (expires_at IS NULL OR expires_at > ?)")
        params.append(now)
    if until:
        sql.append("AND created_at <= ?")
        params.append(until)
    sql.append("ORDER BY pinned DESC, created_at DESC LIMIT ?")
    params.append(max(1, min(limit, 2000)))
    out = [shapes.advisory(r) for r in rows(conn, " ".join(sql), params)]
    if audience:
        out = [a for a in out if audience in a["audience"]]
    return out


def load_alerts(
    conn: sqlite3.Connection,
    campaign_id: str,
    *,
    alert_id: str | None = None,
    role: str | None = None,
    status: str | None = None,
    severity: str | None = None,
    kind: str | None = None,
    site_id: str | None = None,
    since: str | None = None,
    until: str | None = None,
    limit: int = 300,
) -> list[dict[str, Any]]:
    """`until` bounds the moment each alert entered the record
    (`shapes.ALERT_BEGUN_SQL`: `started_at`, or `created_at` for a concern
    cluster) before the LIMIT, and is also the moment each alert's `ongoing`
    is judged at, so the flag and the list agree."""
    sql = ["SELECT * FROM alert WHERE campaign_id = ?"]
    params: list[Any] = [campaign_id]
    if alert_id:
        sql.append("AND id = ?")
        params.append(alert_id)
    if status:
        sql.append("AND status IN (%s)" % ",".join("?" * len(status.split(","))))
        params += status.split(",")
    if severity:
        sql.append("AND severity IN (%s)" % ",".join("?" * len(severity.split(","))))
        params += severity.split(",")
    if kind:
        sql.append("AND kind IN (%s)" % ",".join("?" * len(kind.split(","))))
        params += kind.split(",")
    if since:
        sql.append("AND started_at >= ?")
        params.append(since)
    if until:
        sql.append(f"AND {shapes.ALERT_BEGUN_SQL} <= ?")
        params.append(until)
    sql.append("ORDER BY started_at DESC LIMIT ?")
    params.append(max(1, min(limit, 3000)))
    out = [shapes.alert(r, until) for r in rows(conn, " ".join(sql), params)]
    if role:
        out = [a for a in out if role in a["audience"]]
    return out


def alert_geometry(
    conn: sqlite3.Connection, alerts: list[dict[str, Any]], site_id: str, radius_m: float | None = None
) -> list[dict[str, Any]]:
    """Derived RWR geometry: true bearing + range from the site centroid.

    This is what the industry radar scope renders, so it is computed server-side
    against the site's own centroid rather than left to the client.
    """
    site = one(conn, "SELECT id, name, centroid_lon, centroid_lat FROM industry_site WHERE id=?", (site_id,))
    if site is None:
        return []
    slon, slat = site["centroid_lon"], site["centroid_lat"]
    out = []
    for a in alerts:
        if a["site_id"] not in (None, site_id):
            continue
        if a["lon"] is None or a["lat"] is None:
            if a["site_id"] == site_id:
                out.append(a)  # site-addressed but not located: no scope geometry
            continue
        dist = geo.haversine_m(slon, slat, a["lon"], a["lat"])
        if radius_m is not None and dist > radius_m and a["site_id"] != site_id:
            continue
        a = dict(a)
        a["bearing_deg"] = round(geo.bearing_deg(slon, slat, a["lon"], a["lat"]), 1)
        a["distance_m"] = round(dist, 1)
        out.append(a)
    out.sort(key=lambda a: (a.get("distance_m") is None, a.get("distance_m") or 0))
    return out


def load_mitigations(
    conn: sqlite3.Connection,
    campaign_id: str,
    *,
    site_id: str | None = None,
    concern_id: str | None = None,
    alert_id: str | None = None,
    until: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    sql = [
        """SELECT m.* FROM mitigation m JOIN industry_site s ON s.id = m.site_id
            WHERE s.campaign_id = ?"""
    ]
    params: list[Any] = [campaign_id]
    if site_id:
        sql.append("AND m.site_id = ?")
        params.append(site_id)
    if concern_id:
        sql.append("AND m.concern_id = ?")
        params.append(concern_id)
    if alert_id:
        sql.append("AND m.alert_id = ?")
        params.append(alert_id)
    if until:
        sql.append("AND m.created_at <= ?")
        params.append(until)
    sql.append("ORDER BY m.created_at DESC LIMIT ?")
    params.append(max(1, min(limit, 2000)))
    # `until` is also the moment the status is told at: completed after it
    # means still in progress then (shapes.mitigation).
    return [shapes.mitigation(r, until) for r in rows(conn, " ".join(sql), params)]


# ── mobile wind + dispersion models (CONTRACT §8b) ────────────────────────────

def load_mobile_wind(
    conn: sqlite3.Connection,
    campaign_id: str,
    *,
    from_: str | None = None,
    to: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
    quality: str | None = None,
    limit: int = 20000,
) -> list[dict[str, Any]]:
    """Fleet anemometry. `quality` is comma-separated; default excludes only
    'rejected' — the UI must be able to filter 'suspect' in, not have it hidden."""
    sql = ["SELECT * FROM mobile_wind_obs WHERE campaign_id = ?"]
    params: list[Any] = [campaign_id]
    if from_:
        sql.append("AND ts >= ?")
        params.append(from_)
    if to:
        sql.append("AND ts <= ?")
        params.append(to)
    if quality:
        wanted = [q.strip() for q in quality.split(",") if q.strip()]
        sql.append("AND quality IN (%s)" % ",".join("?" * len(wanted)))
        params += wanted
    else:
        sql.append("AND quality != 'rejected'")
    if bbox:
        sql.append("AND lon >= ? AND lon <= ? AND lat >= ? AND lat <= ?")
        params += [bbox[0], bbox[2], bbox[1], bbox[3]]
    sql.append("ORDER BY ts LIMIT ?")
    params.append(max(1, min(limit, 200000)))
    return [shapes.mobile_wind_obs(r) for r in rows(conn, " ".join(sql), params)]


def load_dispersion_models(
    conn: sqlite3.Connection,
    *,
    site_id: str | None = None,
    model_id: str | None = None,
    campaign_id: str | None = None,
) -> list[dict[str, Any]]:
    sql = ["SELECT * FROM dispersion_model WHERE 1=1"]
    params: list[Any] = []
    if site_id:
        sql.append("AND site_id = ?")
        params.append(site_id)
    if model_id:
        sql.append("AND id = ?")
        params.append(model_id)
    if campaign_id:
        sql.append("AND campaign_id = ?")
        params.append(campaign_id)
    sql.append("ORDER BY COALESCE(issued_at,'') DESC, id")
    found = rows(conn, " ".join(sql), params)
    if not found:
        return []
    ids = [m["id"] for m in found]
    marks = ",".join("?" * len(ids))
    contours: dict[str, list] = {}
    for c in rows(
        conn,
        f"SELECT * FROM dispersion_model_contour WHERE model_id IN ({marks}) ORDER BY band",
        tuple(ids),
    ):
        contours.setdefault(c["model_id"], []).append(shapes.dispersion_contour(c))
    return [shapes.dispersion_model(m, contours.get(m["id"], [])) for m in found]
