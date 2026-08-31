"""GET /segments — the flagship endpoint.

The coloured road grid is the hero visual in every interface, so this has to be
fast. Three things buy that:

  1. Geometry is parsed from `geometry_json` and rounded to 5 decimals **once**
     per campaign into a module-level dict. Geometry never changes.
  2. The stat join is a single prepared query against ix_stat_lookup.
  3. The finished FeatureCollection is serialized once and the *bytes* are held
     in the LRU, keyed on the query params. A warm hit is a memcpy.

Writes bump `cache.version()`, which invalidates every cached body.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from air.server import cache, config, domain
from air.server.db import get_db, jload, one, resolve_campaign, rows

router = APIRouter(tags=["segments"])

METRICS = ("median", "p90", "max", "persistence", "risk")

_geom_lock = threading.RLock()
_geom_cache: dict[str, dict[str, list[list[float]]]] = {}
_meta_cache: dict[str, dict[str, tuple]] = {}

D = config.SEGMENT_COORD_DECIMALS


def _load_campaign_geometry(conn: sqlite3.Connection, campaign_id: str) -> tuple[dict, dict]:
    """Parse + round every segment geometry once. Keyed by cache version so a
    reseed picks up new geometry."""
    ver = cache.version()
    key = f"{campaign_id}@{ver}"
    with _geom_lock:
        if key in _geom_cache:
            return _geom_cache[key], _meta_cache[key]
    geoms: dict[str, list[list[float]]] = {}
    meta: dict[str, tuple] = {}
    for r in conn.execute(
        """SELECT id, name, road_class, district, geometry_json, length_m, mid_lon, mid_lat
             FROM road_segment WHERE campaign_id = ?""",
        (campaign_id,),
    ):
        coords = jload(r["geometry_json"], []) or []
        geoms[r["id"]] = [[round(float(c[0]), D), round(float(c[1]), D)] for c in coords if c]
        meta[r["id"]] = (r["name"], r["road_class"], r["district"], r["length_m"], r["mid_lon"], r["mid_lat"])
    with _geom_lock:
        _geom_cache.clear()
        _meta_cache.clear()
        _geom_cache[key] = geoms
        _meta_cache[key] = meta
    return geoms, meta


@router.get("/segments")
def list_segments(
    response: Response,
    measure: str = "no2",
    metric: str = "median",
    window: str = "all",
    bbox: str | None = Query(None, description="w,s,e,n"),
    min_passes: int = 0,
    limit: int = config.SEGMENT_DEFAULT_LIMIT,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> Response:
    if metric not in METRICS:
        raise HTTPException(422, f"metric must be one of {METRICS}")
    cid = resolve_campaign(conn, campaign_id)

    key = ("segments", cid, measure, metric, window, bbox or "", min_passes, limit)
    hit = cache.get(key)
    if hit is not None:
        return Response(content=hit, media_type="application/json", headers={"x-air-cache": "hit"})

    box = None
    if bbox:
        try:
            w, s, e, n = (float(x) for x in bbox.split(","))
            box = (w, s, e, n)
        except ValueError:
            raise HTTPException(422, "bbox must be w,s,e,n") from None

    geoms, meta = _load_campaign_geometry(conn, cid)

    # The bbox has to be part of the WHERE clause, not a post-filter. LIMIT is
    # applied by SQLite before Python ever sees a row, so filtering afterwards
    # means a local bbox gets the campaign's global top-N and then discards all
    # of it — a silently empty map at any normal limit.
    sql = [
        """SELECT st.segment_id, st.n_passes, st.median, st.p10, st.p90,
                  st.max, st.persistence, st.risk
             FROM segment_stat st"""
    ]
    params: list[Any] = []
    if box is not None:
        sql.append("JOIN road_segment rs ON rs.id = st.segment_id")
    sql.append("WHERE st.campaign_id = ? AND st.measure = ? AND st.window = ?")
    params += [cid, measure, window]
    if box is not None:
        sql.append("AND rs.mid_lon BETWEEN ? AND ? AND rs.mid_lat BETWEEN ? AND ?")
        params += [box[0], box[2], box[1], box[3]]
    if min_passes:
        sql.append("AND st.n_passes >= ?")
        params.append(min_passes)
    sql.append(f"ORDER BY st.{metric} IS NULL, st.{metric} DESC LIMIT ?")
    params.append(max(1, min(limit, 60000)))

    features: list[dict[str, Any]] = []
    for r in conn.execute(" ".join(sql), tuple(params)):
        sid = r["segment_id"]
        m = meta.get(sid)
        if m is None:
            continue
        coords = geoms.get(sid) or []
        if len(coords) < 2:
            continue
        features.append(
            {
                "type": "Feature",
                "id": sid,
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "id": sid,
                    "name": m[0],
                    "road_class": m[1],
                    "district": m[2],
                    "value": r[metric],
                    "median": r["median"],
                    "p90": r["p90"],
                    "max": r["max"],
                    "persistence": r["persistence"],
                    "risk": r["risk"],
                    "n_passes": r["n_passes"],
                    "length_m": m[3],
                },
            }
        )

    body = json.dumps(
        {"type": "FeatureCollection", "features": features},
        separators=(",", ":"),
        allow_nan=False,
    ).encode()
    cache.put(key, body)
    return Response(content=body, media_type="application/json", headers={"x-air-cache": "miss"})


@router.get("/segments/{segment_id}")
def segment_detail(
    segment_id: str,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    seg = one(conn, "SELECT * FROM road_segment WHERE id = ?", (segment_id,))
    if seg is None:
        raise HTTPException(404, f"unknown segment {segment_id}")
    cid = seg["campaign_id"]

    key = ("segment_detail", segment_id)
    hit = cache.get(key)
    if hit is not None:
        return hit

    stats: dict[str, Any] = {}
    for r in rows(
        conn,
        """SELECT measure, median, p10, p90, max, persistence, risk, n_passes
             FROM segment_stat WHERE segment_id=? AND window='all'""",
        (segment_id,),
    ):
        stats[r["measure"]] = {
            "median": r["median"], "p10": r["p10"], "p90": r["p90"], "max": r["max"],
            "persistence": r["persistence"], "risk": r["risk"], "n_passes": r["n_passes"],
        }

    daily: dict[str, list] = {}
    for r in rows(
        conn,
        """SELECT measure, window, median FROM segment_stat
            WHERE segment_id=? AND window LIKE 'date:%' ORDER BY window""",
        (segment_id,),
    ):
        daily.setdefault(r["measure"], []).append({"t": r["window"][5:], "v": r["median"]})

    diurnal: dict[str, list] = {}
    for r in rows(
        conn,
        """SELECT measure, window, median FROM segment_stat
            WHERE segment_id=? AND window LIKE 'hour:%' ORDER BY window""",
        (segment_id,),
    ):
        diurnal.setdefault(r["measure"], []).append({"t": r["window"][5:], "v": r["median"]})

    rank_pct: dict[str, float] = {}
    for measure, s in stats.items():
        if s["median"] is None:
            rank_pct[measure] = 0.0
            continue
        below = conn.execute(
            """SELECT COUNT(*) FROM segment_stat
                WHERE campaign_id=? AND measure=? AND window='all' AND median <= ?""",
            (cid, measure, s["median"]),
        ).fetchone()[0]
        total = conn.execute(
            "SELECT COUNT(*) FROM segment_stat WHERE campaign_id=? AND measure=? AND window='all'",
            (cid, measure),
        ).fetchone()[0]
        rank_pct[measure] = round(100.0 * below / total, 1) if total else 0.0

    pr = one(
        conn,
        "SELECT MIN(ts) AS first_pass, MAX(ts) AS last_pass, COUNT(*) AS n FROM segment_pass WHERE segment_id=?",
        (segment_id,),
    )
    n_passes = max(
        (s["n_passes"] or 0 for s in stats.values()),
        default=(pr["n"] if pr else 0) or 0,
    )

    coords = jload(seg["geometry_json"], []) or []
    detail = {
        "id": seg["id"],
        "name": seg["name"],
        "road_class": seg["road_class"],
        "district": seg["district"],
        "geometry": [[round(float(c[0]), D), round(float(c[1]), D)] for c in coords if c],
        "length_m": seg["length_m"],
        "mid": [seg["mid_lon"], seg["mid_lat"]],
        "n_passes": n_passes,
        "first_pass": pr["first_pass"] if pr else None,
        "last_pass": pr["last_pass"] if pr else None,
        "stats": stats,
        "daily": daily,
        "diurnal": diurnal,
        "rank_pct": rank_pct,
        "nearest_site": domain.nearest_site(conn, cid, seg["mid_lon"], seg["mid_lat"]),
    }
    return cache.put(key, detail)
