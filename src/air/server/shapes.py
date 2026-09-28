"""sqlite3.Row -> wire dict. One function per interface in web/src/core/types.ts.

Rules enforced here (quality bar):
  * `..._json` TEXT columns are parsed into real arrays/objects
  * lon/lat column pairs become `[lon, lat]` Position tuples
  * 0/1 INTEGER columns become real booleans
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from air.server import timeutil
from air.server.db import jload

Row = sqlite3.Row


# ── identity ──────────────────────────────────────────────────────────────────

def org(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "name": r["name"],
        "short_name": r["short_name"],
        "kind": r["kind"],
        "brand_color": r["brand_color"],
        "logo_emoji": r["logo_emoji"],
        "blurb": r["blurb"],
        "website": r["website"],
    }


def user(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "name": r["name"],
        "email": r["email"],
        "role": r["role"],
        "org_id": r["org_id"],
        "title": r["title"],
        "avatar_emoji": r["avatar_emoji"],
        "avatar_color": r["avatar_color"],
        "neighborhood": r["neighborhood"],
        "joined_at": r["joined_at"],
    }


def author_stub(r: Row | None) -> dict[str, Any] | None:
    """Concern.author — Pick<User, 'id'|'name'|'avatar_emoji'|'avatar_color'|'neighborhood'>"""
    if r is None:
        return None
    return {
        "id": r["id"],
        "name": r["name"],
        "avatar_emoji": r["avatar_emoji"],
        "avatar_color": r["avatar_color"],
        "neighborhood": r["neighborhood"],
    }


def measure_def(r: Row) -> dict[str, Any]:
    return {
        "code": r["code"],
        "label": r["label"],
        "short_label": r["short_label"],
        "unit": r["unit"],
        "family": r["family"],
        "ref_level": r["ref_level"],
        "healthy_max": r["healthy_max"],
        "scale": jload(r["scale_json"], []) or [],
        "ramp": jload(r["ramp_json"], []) or [],
        "decimals": r["decimals"],
        "sort_order": r["sort_order"],
        "description": r["description"],
        "plain_name": r["plain_name"],
    }


# ── campaign ──────────────────────────────────────────────────────────────────

def campaign(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "slug": r["slug"],
        "name": r["name"],
        "subtitle": r["subtitle"],
        "description": r["description"],
        "region": r["region"],
        "state": r["state"],
        "center": [r["center_lon"], r["center_lat"]],
        "default_zoom": r["default_zoom"],
        "bbox": [r["bbox_w"], r["bbox_s"], r["bbox_e"], r["bbox_n"]],
        "start_date": r["start_date"],
        "end_date": r["end_date"],
        "status": r["status"],
        "fleet_size": r["fleet_size"],
        "target_passes": r["target_passes"],
        "timezone": r["timezone"],
        "created_at": r["created_at"],
    }


# ── stationary network ────────────────────────────────────────────────────────

def monitor(r: Row, latest: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": r["id"],
        "name": r["name"],
        "code": r["code"],
        "owner_type": r["owner_type"],
        "org_id": r["org_id"],
        "site_id": r["site_id"],
        "lon": r["lon"],
        "lat": r["lat"],
        "grade": r["grade"],
        "status": r["status"],
        "measures": jload(r["measures_json"], []) or [],
        "radius_m": r["radius_m"],
        "install_date": r["install_date"],
        "last_calibrated": r["last_calibrated"],
        "blurb": r["blurb"],
        "latest": latest or {},
    }


# ── regulator ─────────────────────────────────────────────────────────────────

def action_level(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "measure": r["measure"],
        "label": r["label"],
        "kind": r["kind"],
        "threshold": r["threshold"],
        "unit": r["unit"],
        "averaging_hours": r["averaging_hours"],
        "severity": r["severity"],
        "enabled": bool(r["enabled"]),
        "source": r["source"],
        "notify_community": bool(r["notify_community"]),
        "notify_industry": bool(r["notify_industry"]),
        "updated_at": r["updated_at"],
    }


def advisory(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "org_id": r["org_id"],
        "author_id": r["author_id"],
        "kind": r["kind"],
        "severity": r["severity"],
        "title": r["title"],
        "body": r["body"],
        "measure": r["measure"],
        "alert_id": r["alert_id"],
        "audience": jload(r["audience_json"], ["community"]) or ["community"],
        "created_at": r["created_at"],
        "expires_at": r["expires_at"],
        "pinned": bool(r["pinned"]),
    }


def enforcement_action(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "site_id": r["site_id"],
        "org_id": r["org_id"],
        "kind": r["kind"],
        "status": r["status"],
        "title": r["title"],
        "body": r["body"],
        "alert_id": r["alert_id"],
        "created_at": r["created_at"],
        "due_at": r["due_at"],
        "closed_at": r["closed_at"],
    }


# ── community ─────────────────────────────────────────────────────────────────

# Cached per campaign: (lon, lat) for every road-segment midpoint, and a flat
# array to snap against. Geometry never changes within a build.
_SNAP_CACHE: dict[str, tuple[list[float], list[float]]] = {}


def _snap_to_road(conn, campaign_id: str | None, lon: float | None, lat: float | None):
    """Move a report to the nearest road-segment midpoint.

    WHY: `concern.lon/lat` are house-precision, and `is_anonymous` hides only
    the author's NAME. Draw any named-emitter shape over house-precision pins —
    which is exactly what phase 6 puts on the community map — and the map
    becomes a record of which households accused which company. That is a
    compound de-anonymisation and a defamation surface in one layer, and it
    does not need anyone to act in bad faith: a screenshot is enough.

    The road segment is this product's own atom — every measurement, every
    statistic and the hero visual are already per-segment — so snapping loses
    nothing analytically. It is about ten lines and it is the one place the
    community design was genuinely exposed.

    Applied at SERIALISATION, not at write: the raw coordinate stays in the
    database for the regulator's own tooling, and every reader of the community
    API gets the snapped one.
    """
    if lon is None or lat is None or campaign_id is None:
        return lon, lat
    cached = _SNAP_CACHE.get(campaign_id)
    if cached is None:
        pts = conn.execute(
            "SELECT mid_lon, mid_lat FROM road_segment WHERE campaign_id = ?", (campaign_id,)
        ).fetchall()
        if not pts:
            return lon, lat
        cached = ([p[0] for p in pts], [p[1] for p in pts])
        _SNAP_CACHE[campaign_id] = cached
    lons, lats = cached
    # Equirectangular is ample: we are picking a nearest neighbour a few
    # hundred metres away, not measuring one.
    import math as _math

    kx = _math.cos(_math.radians(lat))
    best_i, best_d = 0, float("inf")
    for i, (x, y) in enumerate(zip(lons, lats, strict=True)):
        dx = (x - lon) * kx
        dy = y - lat
        d = dx * dx + dy * dy
        if d < best_d:
            best_i, best_d = i, d
    return round(lons[best_i], 5), round(lats[best_i], 5)


def concern(
    r: Row,
    author: dict | None = None,
    responses: list | None = None,
    conn=None,
) -> dict[str, Any]:
    anon = bool(r["is_anonymous"])
    lon, lat = r["lon"], r["lat"]
    if conn is not None:
        lon, lat = _snap_to_road(
            conn, r["campaign_id"] if "campaign_id" in r.keys() else None, lon, lat
        )
    return {
        "id": r["id"],
        "author": None if anon else author,
        "kind": r["kind"],
        "severity": r["severity"],
        "title": r["title"],
        "body": r["body"],
        "lon": lon,
        "lat": lat,
        # Snapped to the nearest road-segment midpoint when the serialiser was
        # given a connection. House-precision coordinates never leave the
        # database — see `_snap_to_road`.
        "location_precision": "road_segment" if conn is not None else "raw",
        "address_hint": r["address_hint"],
        "district": r["district"],
        "occurred_at": r["occurred_at"],
        "created_at": r["created_at"],
        "status": r["status"],
        "cluster_id": r["cluster_id"],
        "corroborations": r["corroborations"],
        "is_anonymous": anon,
        "photo_emoji": r["photo_emoji"],
        "suspected_site_id": r["suspected_site_id"],
        "responses": responses or [],
    }


def concern_response(r: Row, org_name: str | None = None) -> dict[str, Any]:
    keys = r.keys()
    return {
        "id": r["id"],
        "concern_id": r["concern_id"],
        "author_id": r["author_id"],
        "org_id": r["org_id"],
        "org_name": org_name if org_name is not None else (r["org_name"] if "org_name" in keys else None),
        "role": r["role"],
        "kind": r["kind"],
        "body": r["body"],
        "created_at": r["created_at"],
    }


def concern_cluster(r: Row, last_posted_at: str | None = None) -> dict[str, Any]:
    """`first_at`/`last_at` are when reports were NOTICED (`occurred_at`);
    `last_posted_at` is when the last counted one was POSTED (`created_at`),
    which is the moment the cluster is whole on every list bounded by `at`.
    Posting runs hours behind noticing: at cl-00's `last_at` (Jun 5 04:56)
    2 of its 9 reports were posted and /clusters did not list it at all; its
    last report was posted at 08:48. The table does not store it, so the
    caller passes it in from the members it counted."""
    return {
        "id": r["id"],
        "label": r["label"],
        "centroid": [r["centroid_lon"], r["centroid_lat"]],
        "radius_m": r["radius_m"],
        "count": r["count"],
        "kinds": jload(r["kinds_json"], []) or [],
        "first_at": r["first_at"],
        "last_at": r["last_at"],
        "last_posted_at": last_posted_at,
        "status": r["status"],
        "site_id": r["site_id"],
    }


# ── industry ──────────────────────────────────────────────────────────────────

def _geometry(raw: Any) -> dict[str, Any]:
    """Accept a bare geometry, a Feature or a FeatureCollection; return geometry."""
    g = jload(raw, None) if isinstance(raw, str) else raw
    if not isinstance(g, dict):
        return {"type": "Polygon", "coordinates": []}
    t = g.get("type")
    if t == "Feature":
        return _geometry(g.get("geometry"))
    if t == "FeatureCollection":
        feats = g.get("features") or []
        return _geometry(feats[0]) if feats else {"type": "Polygon", "coordinates": []}
    return g


def industry_site(r: Row, emission_points: list | None = None) -> dict[str, Any]:
    return {
        "id": r["id"],
        "org_id": r["org_id"],
        "name": r["name"],
        "kind": r["kind"],
        "footprint": _geometry(r["footprint_geojson"]),
        "centroid": [r["centroid_lon"], r["centroid_lat"]],
        "claimed_by_user_id": r["claimed_by_user_id"],
        "claimed_at": r["claimed_at"],
        "status": r["status"],
        "capacity_mw": r["capacity_mw"],
        "it_load_mw": r["it_load_mw"],
        "generator_count": r["generator_count"],
        "generator_fuel": r["generator_fuel"],
        "operating_since": r["operating_since"],
        "blurb": r["blurb"],
        "brand_color": r["brand_color"],
        "logo_emoji": r["logo_emoji"],
        "website": r["website"],
        "headroom_pct": r["headroom_pct"],
        "emission_points": emission_points or [],
    }


def emission_point(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "site_id": r["site_id"],
        "name": r["name"],
        "kind": r["kind"],
        "lon": r["lon"],
        "lat": r["lat"],
        "height_m": r["height_m"],
        "active": bool(r["active"]),
        "measures": jload(r["measures_json"], []) or [],
    }


def site_post(r: Row) -> dict[str, Any]:
    keys = r.keys()
    return {
        "id": r["id"],
        "site_id": r["site_id"],
        "org_id": r["org_id"],
        "org_name": r["org_name"] if "org_name" in keys else None,
        "brand_color": r["brand_color"] if "brand_color" in keys else None,
        "logo_emoji": r["logo_emoji"] if "logo_emoji" in keys else None,
        "author_id": r["author_id"],
        "kind": r["kind"],
        "title": r["title"],
        "body": r["body"],
        "concern_id": r["concern_id"],
        "media_emoji": r["media_emoji"],
        "pinned": bool(r["pinned"]),
        "created_at": r["created_at"],
    }


def mitigation(r: Row, now: str | None = None) -> dict[str, Any]:
    """With `now`, the status as it stood then, rebuilt from the stamps: a
    mitigation completed after `now` was still in progress, with no
    `completed_at` yet. Without it, at Aug 12 the community feed said the
    operator "has finished" mt-003, which completes on Aug 18. Only a
    downgrade: `proposed` and `withdrawn` carry no stamp to rebuild from."""
    status, started, completed = r["status"], r["started_at"], r["completed_at"]
    if now is not None:
        if completed and completed > now:
            completed = None
            if status == "completed":
                status = "in_progress"
        if started and started > now:
            started = None
            if status == "in_progress":
                status = "proposed"
    return {
        "id": r["id"],
        "site_id": r["site_id"],
        "concern_id": r["concern_id"],
        "cluster_id": r["cluster_id"],
        "alert_id": r["alert_id"],
        "title": r["title"],
        "body": r["body"],
        "status": status,
        "measure": r["measure"],
        "expected_reduction_pct": r["expected_reduction_pct"],
        "started_at": started,
        "completed_at": completed,
        "created_at": r["created_at"],
    }


# ── shared alert bus ──────────────────────────────────────────────────────────

# When an alert enters the record — the moment every read bounded by `at` shows
# it from. `started_at` for everything but a concern cluster, whose
# `started_at` is when the episode was first NOTICED, hours before a single
# report was posted: al-cluster-01 "started" Jun 17 05:58, its first report was
# posted 07:38, the cluster formed (third report) at 08:51, and the alert was
# raised at 10:58 (datagen raises every cluster alert 5 h after the episode).
# Bounded on `started_at`, /alerts served that 7-report alert at 07:00 while
# /clusters, correctly, said nothing had formed. `created_at` is never before
# the CLUSTER_MIN_COUNT-th member was posted — live, `detect_cluster` raises
# the alert in the same write as that report — so an alert shown is always one
# whose cluster /clusters shows too. An exceedance's `started_at` is the
# reading that crossed, which existed at that moment, so it stays.
ALERT_BEGUN_SQL = "(CASE WHEN kind = 'concern_cluster' THEN created_at ELSE started_at END)"


def alert_begun_at(r: Row) -> str | None:
    """`ALERT_BEGUN_SQL`, for a row already in hand."""
    return r["created_at"] if r["kind"] == "concern_cluster" else r["started_at"]


# The generator's recommendation for a Warning or worse named a site on the wind
# alone: "Wind at the time carried from Riverport Intermodal Terminal; expect
# to be asked about it." That is attribution by wind without the placebo-checked
# downwind test (F7 / D7 — "a site is named only when the wind at the time and
# the downwind test agree", in every room), and once the industry list stopped
# filtering by the generator's site tag it reached the other two operators as
# well. narrative.py no longer writes it; this removes it from databases built
# before that.
_WIND_NAMES_A_SITE = r"\s*Wind at the time carried from [^;.]+; expect to be asked about it\."


def unname(text: str | None) -> str | None:
    if not text:
        return text
    return re.sub(_WIND_NAMES_A_SITE, "", text).strip() or None


def alert(r: Row, now: str | None = None) -> dict[str, Any]:
    """`ongoing` is begun and not yet ended at `now` — the served moment, or the
    demo's now. It is what "live" means, the same test as `isOngoing` in
    web/src/core/events.ts, and it is NOT `status == 'active'`: on the pinned
    build seven 'active' alerts ended one to four days before the end of the
    data, and a status field cannot say when. "Begun" is `alert_begun_at`,
    which for a concern cluster is later than `started_at`. Plain string
    comparison, like the SQL bounds: every stamp is naive
    `YYYY-MM-DDTHH:MM:SS` (timeutil)."""
    now = now or timeutil.now_iso()
    return {
        "id": r["id"],
        "kind": r["kind"],
        "severity": r["severity"],
        "measure": r["measure"],
        "value": r["value"],
        "threshold": r["threshold"],
        "unit": r["unit"],
        "source_type": r["source_type"],
        "source_id": r["source_id"],
        "lon": r["lon"],
        "lat": r["lat"],
        "site_id": r["site_id"],
        "action_level_id": r["action_level_id"],
        "started_at": r["started_at"],
        "ended_at": r["ended_at"],
        "status": r["status"],
        "title": r["title"],
        "body": r["body"],
        "recommendation": unname(r["recommendation"]),
        "audience": jload(r["audience_json"], ["regulator", "industry", "admin"])
        or ["regulator", "industry", "admin"],
        "created_at": r["created_at"],
        "ongoing": alert_ongoing(r, now),
    }


def alert_ongoing(r: Row, now: str) -> bool:
    """Begun (`alert_begun_at`) by `now` and not ended by it (`alert`'s doc)."""
    begun, ended = alert_begun_at(r), r["ended_at"]
    return bool(begun) and begun <= now and (ended is None or ended > now)


# ── fleet ─────────────────────────────────────────────────────────────────────

def vehicle(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "label": r["label"],
        "call_sign": r["call_sign"],
        "model": r["model"],
        "powertrain": r["powertrain"],
        "status": r["status"],
        "operator_name": r["operator_name"],
        "measures": jload(r["measures_json"], []) or [],
    }


def drive_route(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "vehicle_id": r["vehicle_id"],
        "day_index": r["day_index"],
        "date": r["date"],
        "shift": r["shift"],
        "segment_ids": jload(r["segment_ids_json"], []) or [],
        "geometry": jload(r["geometry_json"], []) or [],
        "distance_m": r["distance_m"],
        "duration_min": r["duration_min"],
        "est_passes": r["est_passes"],
    }


DRIVE_PLAN_STAT_KEYS = (
    "total_segments", "total_km", "days_to_target", "km_per_vehicle_day",
    "coverage_pct", "mean_passes", "segments_below_target",
)


def drive_plan(r: Row, routes: list | None = None) -> dict[str, Any]:
    stats = jload(r["stats_json"], {}) or {}
    return {
        "id": r["id"],
        "campaign_id": r["campaign_id"],
        "name": r["name"],
        "fleet_size": r["fleet_size"],
        "target_passes": r["target_passes"],
        "status": r["status"],
        "params": jload(r["params_json"], {}) or {},
        "stats": {k: stats.get(k, 0) for k in DRIVE_PLAN_STAT_KEYS},
        "created_at": r["created_at"],
        "routes": routes or [],
    }


# ── environment ───────────────────────────────────────────────────────────────

def wind_point(r: Row) -> dict[str, Any]:
    return {
        "ts": r["ts"],
        "speed_ms": r["speed_ms"],
        "dir_deg": r["dir_deg"],
        "gust_ms": r["gust_ms"],
        "temp_c": r["temp_c"],
        "rh": r["rh"],
        "pbl_m": r["pbl_m"],
        "stability": r["stability"],
    }


# ── activity ──────────────────────────────────────────────────────────────────

def activity_item(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "ts": r["ts"],
        "actor_role": r["actor_role"],
        "actor_id": r["actor_id"],
        "verb": r["verb"],
        "object_type": r["object_type"],
        "object_id": r["object_id"],
        "summary": r["summary"],
        "payload": jload(r["payload_json"], None),
    }


# ── mobile wind + dispersion models (CONTRACT §8b) ────────────────────────────

def mobile_wind_obs(r: Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "ts": r["ts"],
        "lon": r["lon"],
        "lat": r["lat"],
        "segment_id": r["segment_id"],
        "vehicle_id": r["vehicle_id"],
        "speed_ms": r["speed_ms"],
        # Normalised to [0, 360): rounding 359.97 to one decimal yields 360.0,
        # which is outside the range the wire type declares.
        "dir_deg": round(float(r["dir_deg"]) % 360.0, 1) % 360.0,
        "gust_ms": r["gust_ms"],
        "vehicle_speed_kph": r["vehicle_speed_kph"],
        "quality": r["quality"],
    }


def dispersion_model(r: Row, contours: list | None = None) -> dict[str, Any]:
    from air.server import windfield

    return {
        "id": r["id"],
        "site_id": r["site_id"],
        "name": r["name"],
        "vendor": r["vendor"],
        "method": r["method"],
        "measure": r["measure"],
        "averaging_hours": r["averaging_hours"],
        "issued_at": r["issued_at"],
        # Re-binned onto the canonical 16-point rose as percentages, so the
        # consultant's arbitrary binning lines up with our observed rose.
        "assumed_wind": windfield.normalise_rose(jload(r["assumed_wind_json"], [])),
        "notes": r["notes"],
        # 'permit' = the study the operator filed, a legal object. 'aclima' =
        # the same kernel driven by the wind our fleet measured. Drawn in
        # different registers per CONTRACT §10b — a filed contour is a model
        # and gets an outline, never a fill.
        "model_tier": (r["model_tier"] if "model_tier" in r.keys() else "permit"),
        "contours": contours or [],
    }


def dispersion_contour(r: Row) -> dict[str, Any]:
    return {
        "band": r["band"],
        "level": r["level"],
        "geometry": _geometry(r["geometry_json"]),
    }
