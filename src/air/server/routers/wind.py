"""/wind, /wind/dispersion — hourly met data and the plume cones.

The cone is a MODEL. Nothing served from `/wind/dispersion` has been observed,
and per CONTRACT section 10b it is drawn as an outline, never as the filled
thing on the map. `/sites/{id}/touchdown` (phase 4) is the measured answer.

The shape comes from `air.dispersion` — the same kernel that writes the
simulation's ground truth in `air.datagen.field`. It did not used to. This
endpoint had its own formula,

    base_reach = (700 + 240 * speed) * STABILITY[cls][1]

which ignored source strength entirely, spanned only 3x across Pasquill A to F
where the physics spans about 40x, and split reach into three fixed radial
slices with the brightest at the stack. That last one is backwards for a
lofted source: ground-level concentration at a 21 m generator under stable air
is near zero, and the maximum is three kilometres downwind. Between them those
three defects are why the drawn plume looked like a tiny blob whatever the
weather.
"""

from __future__ import annotations

import sqlite3
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

# Aliased: the endpoint function below is also called `dispersion`, and the
# bare import shadowed it into an AttributeError at request time.
from air import dispersion as plume
from air.server import (
    cache, climatology, domain, forecast, geo, loaders, shapes, timeutil, windfield,
)
from air.server.db import get_db, one, resolve_campaign, rows

router = APIRouter(tags=["wind"])


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
    # `reach_m` used to override the cone length. Reach is physics now — a
    # caller cannot assert one without contradicting the kernel — and nothing
    # ever sent it. Removed rather than left as a lever that lies.
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
    reported = (wind["stability"] or "D").upper()
    # P1-D. A Pasquill class outside its own wind-speed range is fabricated
    # input, not weather, and the kernel steps it toward neutral rather than
    # evaluating the formula on it. Never happens on this campaign's own wind
    # (F maxes at 2.98 m/s here) — it exists for forecasts and for an operator
    # dragging a slider. It is a guard, NOT an explanation of plume size.
    stability, coercion_note = plume.coerce_class(reported, speed)
    pbl_m = float(wind["pbl_m"] or 500.0) if "pbl_m" in wind.keys() else 500.0

    # One plume per SITE, not per emission point. Ridgeline has 13 active
    # points inside a ~500 m cluster; drawn separately that is 39 translucent
    # polygons stacked 13 deep, which renders as one opaque smudge the size of
    # the campus and hides the band structure entirely. Same physics, one
    # polygon per (site, band) — see geo.plume_union_polygon.
    by_site: dict[str, list[dict[str, Any]]] = {}
    for p in points:
        by_site.setdefault(p["site_id"], []).append(p)

    # Crosswind half-width from the kernel's sigma_y, shared by every source at
    # this site so the union stays exact. A shallow curve, not a straight edge.
    def width(r: float) -> float:
        return float(plume.half_width(r, stability, speed))

    envelope = plume.DETECTION_ENVELOPE.get(stability, 1500.0)
    features: list[dict[str, Any]] = []

    for sid, pts in by_site.items():
        srcs = [plume.Source(float(p["height_m"] or 12.0), p["kind"]) for p in pts]

        # The DRAWN shape is the site's combined ground-level profile. Sources
        # add, and one polygon per site needs one profile per site.
        site = plume.reach(srcs, u10=speed, cls=stability, pbl_m=pbl_m)
        band_spans = plume.bands(site, srcs, u10=speed, cls=stability, pbl_m=pbl_m)
        if not band_spans:
            continue

        # TOUCHDOWN is a separate question and belongs to the elevated sources
        # alone. A site's combined profile always peaks at the fence when the
        # site has any ground-level release — Ridgeline's 3 m traffic gate is
        # 98% of the ground concentration at 100 m under F — so asking the
        # whole site "are you lofted" always answers no and buries the story.
        # A source counts as elevated when its OWN plume is lofted or never
        # touches down, which is the kernel's judgement rather than a height
        # cut-off pulled out of the air.
        elevated = [
            src
            for src in srcs
            if plume.reach([src], u10=speed, cls=stability, pbl_m=pbl_m).lofted
        ]
        el = plume.reach(elevated, u10=speed, cls=stability, pbl_m=pbl_m) if elevated else None

        for band, a, b, level in band_spans:
            ring = geo.plume_union_polygon(
                [(float(p["lon"]), float(p["lat"]), a, b) for p in pts],
                float(wind["dir_deg"]),
                speed,
                stability,
                half_width=width,
            )
            if not ring:
                continue
            props: dict[str, Any] = {
                "site_id": sid,
                "measure": measure,
                "level": level,
                "band": band,
                "ts": wind["ts"],
                "n_sources": len(pts),
                # Metres downwind of the site, along the transport axis.
                "x_onset_m": round(site.x_onset, 1),
                "x_peak_m": round(site.x_peak, 1),
                "x_reach_m": round(site.x_reach, 1),
                "reach_m": round(site.x_reach, 1),
                "truncated": site.truncated,
                # The elevated-source story, kept separate from the site
                # numbers above because it answers a different question. Zero
                # elevated sources is the ordinary daytime answer — the plume
                # mixes to the ground at the fence — not a missing value.
                "n_elevated": len(elevated),
                "lofted": bool(elevated),
                "elevated_touchdown_m": (
                    None if el is None or el.x_touchdown is None else round(el.x_touchdown, 1)
                ),
                "elevated_peak_m": None if el is None else round(el.x_peak, 1),
                # CONTRACT 10b: past here the model is still drawn, but dashed
                # and unfilled, with "beyond measurement range - model only".
                "beyond_envelope": bool(b > envelope),
                "detection_envelope_m": envelope,
                "wind_dir_deg": wind["dir_deg"],
                "wind_speed_ms": wind["speed_ms"],
                "stability": stability,
            }
            if coercion_note:
                props["stability_coerced_from"] = reported
                props["stability_note"] = coercion_note
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                    "properties": props,
                }
            )
    return {"type": "FeatureCollection", "features": features}


# ── forecast: derived, not invented ───────────────────────────────────────────


@router.get("/wind/forecast")
def wind_forecast(
    at: str | None = None,
    site_id: str | None = None,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Forward-looking weather whose error is MEASURED rather than chosen.

    A blend of persistence and this campaign's own hour-of-day climatology,
    with the weight at each lead read off a sweep of the record. At six hours
    it simply IS persistence; by five days it is the rose. `beyond_crossover`
    marks the leads past about 60 hours, where climatology beats persistence
    and the honest answer stops being a forecast.

    With `site_id`, also returns the plume as a WIDENING CORRIDOR per lead —
    never a centreline. A single cone at +72 h is a fabrication with a
    timestamp on it.
    """
    cid = resolve_campaign(conn, campaign_id)
    key = ("forecast", cid, at or "", site_id or "", cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    f = forecast.issue(conn, cid, at)
    payload: dict[str, Any] = {
        "campaign_id": cid,
        "issued_at": f.issued_at,
        "crossover_h": f.crossover_h,
        "basis": f.basis,
        "hours": [asdict(h) for h in f.hours],
    }
    if site_id:
        if one(conn, "SELECT 1 FROM industry_site WHERE id=?", (site_id,)) is None:
            raise HTTPException(404, f"unknown site {site_id}")
        payload["corridor"] = forecast.corridor(conn, cid, site_id, at)
    return cache.put(key, payload)


@router.get("/wind/forecast/skill")
def wind_forecast_skill(
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """The verification ledger, computed by replaying the forecast.

    No stored forecasts and no separate truth: the forecast is a function of
    the record, so scoring it is a second pass over the same rows. Both
    baselines are reported beside it, because a skill number without the thing
    it beat is a marketing claim.
    """
    cid = resolve_campaign(conn, campaign_id)
    key = ("forecast_skill", cid, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    bins = forecast.skill(conn, cid)
    return cache.put(key, {
        "campaign_id": cid,
        "basis": forecast.BASIS,
        "crossover_h": forecast.CROSSOVER_H,
        "note": (
            "One simulated campaign. These numbers are its own, not the "
            "atmosphere's — but they are measured from this record rather than "
            "chosen, which is why both baselines are shown beside them."
        ),
        "bins": [asdict(b) for b in bins],
    })


# ── climatology: how often the wind carries from here to there ────────────────


@router.get("/wind/climatology")
def wind_climatology(
    site_id: str | None = None,
    days: float = 90.0,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """The community app's front door, and the regulator's residency view.

    Answers "how often does the wind carry from this site over that
    neighbourhood" and NOTHING else. It is not evidence that anything was
    emitted, and it is not a statement about anyone's air — that question is
    `/sites/{id}/touchdown`, and it has a much weaker answer.

    Deliberately **reach-independent**: it asks only whether the wind pointed
    at a district, never whether a plume got there. So it does not move when
    the dispersion kernel changes, and the kernel's reach moved by a factor of
    five in phase 1. A resident who screenshots this number should not find it
    depends on which sprint they screenshotted it in.

    Omit `site_id` and every site with active sources comes back, which is what
    a resident needs: their own neighbourhood, and each of the places on the
    map, in one answer.
    """
    cid = resolve_campaign(conn, campaign_id)
    # The CAMPAIGN, not "the last 90 days". `domain.data_now` used to return
    # max(latest_row, wall_clock), so a wall-clock-anchored default window
    # slid off the end of the record a day at a time — which is exactly how
    # `/sites/{id}/model-verification` came to answer `consistent` for all
    # three sites (P0-B). A climatology that quietly shrinks is worse than one
    # that is simply out of date: the number moves and nothing says so.
    span = one(conn, "SELECT start_date, end_date FROM campaign WHERE id=?", (cid,))
    if span is not None and from_ is None and to is None:
        from_, to = f"{span['start_date']}T00:00:00", f"{span['end_date']}T23:59:59"
    else:
        to = to or domain.data_now(conn, cid)
        from_ = from_ or (timeutil.shift(to, days=-days) or timeutil.ago(days=days))

    sites = rows(
        conn,
        "SELECT DISTINCT s.id, s.name FROM industry_site s "
        "JOIN emission_point e ON e.site_id = s.id AND e.active = 1 "
        "WHERE s.campaign_id = ? " + ("AND s.id = ? " if site_id else "") + "ORDER BY s.name",
        (cid, site_id) if site_id else (cid,),
    )
    if site_id and not sites:
        if one(conn, "SELECT 1 FROM industry_site WHERE id=?", (site_id,)) is None:
            raise HTTPException(404, f"unknown site {site_id}")
        raise HTTPException(
            404,
            detail={
                "error": "no_active_sources",
                "message": f"site {site_id} has no active emission points",
            },
        )

    out: list[dict[str, Any]] = []
    rose: list[dict[str, Any]] = []
    n_hours = 0
    for srow in sites:
        c = climatology.cached(conn, cid, srow["id"], from_, to)
        rose = rose or c.rose
        n_hours = c.n_hours
        out.append({
            "site_id": srow["id"],
            "name": srow["name"],
            "districts": [asdict(d) for d in c.districts],
        })
    return {
        "campaign_id": cid,
        "from": from_,
        "to": to,
        "n_hours": n_hours,
        # The campaign's hourly met record, not our fleet's anemometry. Said out
        # loud because the two differ, and the difference is the industry tier's
        # story rather than this one.
        "source": "met_record",
        "rose": rose,
        "sites": out,
        "sector": {
            "n_sigma": climatology.N_SIGMA,
            "min_half_deg": climatology.MIN_HALF_DEG,
            "max_half_deg": climatology.MAX_HALF_DEG,
        },
    }


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
