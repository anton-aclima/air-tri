"""/wind, /wind/dispersion — hourly met data and the plume cones.

Dispersion is a deliberate approximation: a tapered cone per active emission
point, widened by Pasquill stability class and tightened by wind speed, split
into three concentration bands. It has to *look* like dispersion, not be a
regulatory model.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from air.server import cache, domain, geo, loaders, shapes, timeutil, windfield
from air.server.db import get_db, one, resolve_campaign, rows

router = APIRouter(tags=["wind"])

# (band index, r0 factor, r1 factor, relative level)
BANDS = ((0, 0.04, 0.34, 1.00), (1, 0.34, 0.66, 0.45), (2, 0.66, 1.00, 0.18))


@router.get("/wind")
def list_wind(
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    limit: int = 2000,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    now = domain.data_now(conn, cid)
    to = to or now
    from_ = from_ or (timeutil.shift(to, days=-3) or timeutil.ago(days=3))
    return [
        shapes.wind_point(r)
        for r in rows(
            conn,
            "SELECT * FROM wind WHERE campaign_id=? AND ts>=? AND ts<=? ORDER BY ts LIMIT ?",
            (cid, from_, to, max(1, min(limit, 20000))),
        )
    ]


@router.get("/wind/current")
def wind_current(
    at: str | None = None, campaign_id: str | None = None, conn: sqlite3.Connection = Depends(get_db)
) -> dict[str, Any] | None:
    cid = resolve_campaign(conn, campaign_id)
    return domain.current_wind(conn, cid, at)


@router.get("/wind/dispersion")
def dispersion(
    site_id: str | None = None,
    at: str | None = None,
    measure: str = "no2",
    reach_m: float | None = None,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    cid = resolve_campaign(conn, campaign_id)
    wind = domain.current_wind(conn, cid, at)
    if wind is None:
        raise HTTPException(503, "no wind data for this campaign")

    sql = ["SELECT e.* FROM emission_point e JOIN industry_site s ON s.id = e.site_id WHERE s.campaign_id = ?"]
    params: list[Any] = [cid]
    if site_id:
        sql.append("AND e.site_id = ?")
        params.append(site_id)
    sql.append("AND e.active = 1 ORDER BY e.site_id, e.kind")
    points = rows(conn, " ".join(sql), params)
    if site_id and not points:
        if one(conn, "SELECT 1 FROM industry_site WHERE id=?", (site_id,)) is None:
            raise HTTPException(404, f"unknown site {site_id}")

    speed = max(0.4, float(wind["speed_ms"] or 1.0))
    stability = (wind["stability"] or "D").upper()
    _, reach_mult = geo.STABILITY.get(stability, geo.STABILITY["D"])
    # Faster wind and taller stacks carry further; stable air carries furthest.
    base_reach = reach_m or (700.0 + 240.0 * speed) * reach_mult

    features: list[dict[str, Any]] = []
    for p in points:
        height = float(p["height_m"] or 12.0)
        reach = base_reach * (0.75 + min(1.0, height / 40.0) * 0.5)
        # A generator emits more than a traffic gate.
        strength = {"generator": 1.0, "stack": 0.9, "backup": 0.8,
                    "cooling_tower": 0.5, "traffic_gate": 0.45, "substation": 0.2}.get(p["kind"], 0.6)
        for band, f0, f1, rel in BANDS:
            ring = geo.plume_polygon(
                p["lon"], p["lat"], float(wind["dir_deg"]), speed, stability,
                reach * f0, reach * f1,
            )
            level = round(strength * rel * 40.0 / speed, 3)
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                    "properties": {
                        "site_id": p["site_id"],
                        "measure": measure,
                        "level": level,
                        "band": band,
                        "ts": wind["ts"],
                        "emission_point_id": p["id"],
                        "emission_point": p["name"],
                        "wind_dir_deg": wind["dir_deg"],
                        "wind_speed_ms": wind["speed_ms"],
                        "stability": stability,
                    },
                }
            )
    return {"type": "FeatureCollection", "features": features}


# ── observed wind from the fleet anemometers (CONTRACT §8b) ───────────────────

DEFAULT_CELL_M = 400.0


def _window(conn: sqlite3.Connection, cid: str, from_: str | None, to: str | None,
            default_days: float) -> tuple[str, str]:
    now = domain.data_now(conn, cid)
    to = to or now
    from_ = from_ or (timeutil.shift(to, days=-default_days) or timeutil.ago(days=default_days))
    return (from_, to)


def _bbox(conn: sqlite3.Connection, cid: str, raw: str | None) -> tuple[float, float, float, float]:
    if raw:
        try:
            w, s, e, n = (float(x) for x in raw.split(","))
        except ValueError:
            raise HTTPException(422, "bbox must be w,s,e,n") from None
        if e <= w or n <= s:
            raise HTTPException(422, "bbox must be w,s,e,n with e>w and n>s")
        return (w, s, e, n)
    c = one(conn, "SELECT bbox_w, bbox_s, bbox_e, bbox_n, center_lon, center_lat FROM campaign WHERE id=?", (cid,))
    if c and None not in (c["bbox_w"], c["bbox_s"], c["bbox_e"], c["bbox_n"]):
        return (c["bbox_w"], c["bbox_s"], c["bbox_e"], c["bbox_n"])
    ext = one(
        conn,
        "SELECT MIN(mid_lon) w, MIN(mid_lat) s, MAX(mid_lon) e, MAX(mid_lat) n FROM road_segment WHERE campaign_id=?",
        (cid,),
    )
    if ext and ext["w"] is not None:
        return (ext["w"] - 0.004, ext["s"] - 0.004, ext["e"] + 0.004, ext["n"] + 0.004)
    if c:
        return (c["center_lon"] - 0.06, c["center_lat"] - 0.05, c["center_lon"] + 0.06, c["center_lat"] + 0.05)
    raise HTTPException(503, "campaign has no bbox and no segments")


@router.get("/wind/mobile")
def mobile_wind(
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    bbox: str | None = Query(None, description="w,s,e,n"),
    quality: str | None = Query(None, description="comma-separated; default excludes only 'rejected'"),
    limit: int = 20000,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Raw fleet anemometry. Anemometry from a moving platform is noisy, so the
    `quality` flag is exposed rather than applied silently."""
    cid = resolve_campaign(conn, campaign_id)
    f, t = _window(conn, cid, from_, to, 2.0)
    box = _bbox(conn, cid, bbox) if bbox else None
    return loaders.load_mobile_wind(conn, cid, from_=f, to=t, bbox=box, quality=quality, limit=limit)


@router.get("/wind/field")
def wind_field(
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    cell_m: float = Query(DEFAULT_CELL_M, gt=25.0, le=20000.0),
    bbox: str | None = Query(None, description="w,s,e,n; defaults to the campaign bbox"),
    quality: str | None = None,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Observed wind binned onto a grid — the source for the particle overlay.

    Direction is averaged **circularly** (mean of unit vectors); a numeric mean
    of 350° and 10° would give 180°, which is exactly backwards. Every cell
    carries `n` and `dir_sd` so thin or unsteady coverage can be drawn honestly.
    The lattice is anchored on the bbox origin and gap-filled, so it tiles
    cleanly for bilinear sampling.
    """
    cid = resolve_campaign(conn, campaign_id)
    f, t = _window(conn, cid, from_, to, 2.0)
    box = _bbox(conn, cid, bbox)

    key = ("wind_field", cid, f, t, round(cell_m, 1), box, quality or "")
    hit = cache.get(key)
    if hit is not None:
        return hit

    obs = loaders.load_mobile_wind(
        conn, cid, from_=f, to=t, bbox=box, quality=quality, limit=200000
    )
    regional = domain.current_wind(conn, cid, t)
    field = windfield.build_field(obs, box, cell_m, regional)
    payload = {
        "cells": field["cells"],
        "cell_size_m": field["cell_size_m"],
        "from": f,
        "to": t,
        "n_obs": field["n_obs"],
        "source": field["source"],
        # Superset of WindField in types.ts: the lattice spec, so the particle
        # overlay can index cells directly rather than infer the grid.
        "grid": field["grid"],
    }
    return cache.put(key, payload)
