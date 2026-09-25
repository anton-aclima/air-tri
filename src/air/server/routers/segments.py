"""GET /segments — the flagship endpoint.

The coloured road grid is the hero visual in every interface, so this has to be
fast. Three things buy that:

  1. Geometry is parsed from `geometry_json` and rounded to 5 decimals **once**
     per campaign into a module-level dict. Geometry never changes.
  2. The stat join is a single prepared query against ix_stat_lookup.
  3. The finished FeatureCollection is serialized once and the *bytes* are held
     in the LRU, keyed on the query params. A warm hit is a memcpy.

Writes bump `cache.version()`, which invalidates every cached body.

TWO KINDS OF WINDOW
-------------------
`all`, `date:YYYY-MM-DD`, `hour:HH` (and `week:`) are STORED: one indexed
lookup in `segment_stat`, `at` ignored, exactly as before — the community,
industry and admin maps use them. `trailing:<N>h` and `todate` are COMPUTED
from `segment_pass` and bounded by `at` (`domain.as_of`): passes with
`at - N h < ts <= at`, or `ts <= at`. Same statistics as the stored rows
(`passwindow.py` says how that is held exact), same GeoJSON, so a layer reads
either unchanged. A computed collection also carries one foreign member,
`window: {name, from, to, last_pass_at}` — GeoJSON allows it, and the empty
window's copy ("no passes in the 7 days to ...") needs the bounds and the last
pass without a second request. Anything else is a 422.

Computed bodies go in their own bounded LRU, keyed on the stored path's params
plus `at`: playback asks for a new moment several times a second, and those
~500 KB bodies in the shared store would evict every other endpoint's warm
entry (the reason `network.py` keeps its own).

`GET /segments/{id}` takes the same `at`, optionally. Without it the detail
reads the stored `'all'`, `date:` and `hour:` rows as before — every pass in
the campaign. With it, every window-derived field is recomputed from passes
with `ts <= at` (`passwindow.street`), same shape, so the regulator's monitor
detail never draws an hour-of-day profile out of passes after the moment
shown. Those bodies get their own small LRU for the same reason.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections import OrderedDict
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Response

from air.server import cache, config, domain, passwindow
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


def _bbox(bbox: str | None) -> tuple[float, float, float, float] | None:
    if not bbox:
        return None
    try:
        w, s, e, n = (float(x) for x in bbox.split(","))
    except ValueError:
        raise HTTPException(422, "bbox must be w,s,e,n") from None
    return (w, s, e, n)


def _feature(sid: str, m: tuple, coords: list, stat: dict[str, Any], metric: str) -> dict[str, Any]:
    return {
        "type": "Feature",
        "id": sid,
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {
            "id": sid,
            "name": m[0],
            "road_class": m[1],
            "district": m[2],
            "value": stat[metric],
            "median": stat["median"],
            "p90": stat["p90"],
            "max": stat["max"],
            "persistence": stat["persistence"],
            "risk": stat["risk"],
            "n_passes": stat["n_passes"],
            "length_m": m[3],
        },
    }


def _body(doc: dict[str, Any]) -> bytes:
    return json.dumps(doc, separators=(",", ":"), allow_nan=False).encode()


#: Computed-window bodies (see the module docstring for why not `cache`).
_COMPUTED: OrderedDict[tuple, bytes] = OrderedDict()
_COMPUTED_MAX = 48
_computed_lock = threading.Lock()


@router.get("/segments")
def list_segments(
    response: Response,
    measure: str = "no2",
    metric: str = "median",
    window: str = "all",
    at: str | None = Query(
        None, description="naive campaign time; bounds `trailing:<N>h` and `todate`, ignored by stored windows"
    ),
    bbox: str | None = Query(None, description="w,s,e,n"),
    min_passes: int | None = Query(None, description="default 0 on a stored window, 1 on a computed one"),
    limit: int = config.SEGMENT_DEFAULT_LIMIT,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> Response:
    if metric not in METRICS:
        raise HTTPException(422, f"metric must be one of {METRICS}")
    cid = resolve_campaign(conn, campaign_id)
    if passwindow.is_computed(window):
        return _computed(conn, cid, measure, metric, window, at, bbox, min_passes, limit)
    passwindow.check_stored(window)
    min_passes = 0 if min_passes is None else min_passes

    key = ("segments", cid, measure, metric, window, bbox or "", min_passes, limit)
    hit = cache.get(key)
    if hit is not None:
        return Response(content=hit, media_type="application/json", headers={"x-air-cache": "hit"})

    box = _bbox(bbox)
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
        features.append(_feature(sid, m, coords, r, metric))

    body = _body({"type": "FeatureCollection", "features": features})
    cache.put(key, body)
    return Response(content=body, media_type="application/json", headers={"x-air-cache": "miss"})


def _computed(
    conn: sqlite3.Connection,
    cid: str,
    measure: str,
    metric: str,
    window: str,
    at: str | None,
    bbox: str | None,
    min_passes: int | None,
    limit: int,
) -> Response:
    """`trailing:<N>h` / `todate`, bounded by `at`: the stored path's filters,
    order and limit over `passwindow.stats`."""
    w = passwindow.resolve(conn, cid, window, at)
    floor = 1 if min_passes is None else max(1, min_passes)
    key = (cache.version(), "segments", cid, measure, metric, w.name, w.hi, bbox or "", floor, limit)
    with _computed_lock:
        hit = _COMPUTED.get(key)
        if hit is not None:
            _COMPUTED.move_to_end(key)
    if hit is not None:
        return Response(content=hit, media_type="application/json", headers={"x-air-cache": "hit"})

    box = _bbox(bbox)
    geoms, meta = _load_campaign_geometry(conn, cid)
    found = []
    for st in passwindow.stats(conn, cid, measure, w):
        if st.n_passes < floor:
            continue
        m = meta.get(st.segment_id)
        if m is None:
            continue
        if box is not None and not (box[0] <= m[4] <= box[2] and box[1] <= m[5] <= box[3]):
            continue
        found.append(st)
    # The stored path's `ORDER BY <metric> IS NULL, <metric> DESC LIMIT`, with
    # the id as a tiebreak so a body is the same bytes on every run.
    found.sort(key=lambda st: (-getattr(st, metric), st.segment_id))
    features: list[dict[str, Any]] = []
    for st in found[: max(1, min(limit, 60000))]:
        coords = geoms.get(st.segment_id) or []
        if len(coords) < 2:
            continue
        features.append(_feature(st.segment_id, meta[st.segment_id], coords, st.__dict__, metric))

    body = _body({
        "type": "FeatureCollection",
        "features": features,
        "window": {
            "name": w.name,
            "from": w.lo,
            "to": w.hi,
            "last_pass_at": passwindow.last_pass_at(conn, cid, measure, w.hi),
        },
    })
    with _computed_lock:
        _COMPUTED[key] = body
        while len(_COMPUTED) > _COMPUTED_MAX:
            _COMPUTED.popitem(last=False)
    return Response(content=body, media_type="application/json", headers={"x-air-cache": "miss"})


#: `/segments/{id}?at=` bodies, keyed on the moment (see the module docstring
#: for why not `cache`).
_DETAIL: OrderedDict[tuple, dict[str, Any]] = OrderedDict()
_DETAIL_MAX = 64


@router.get("/segments/{segment_id}")
def segment_detail(
    segment_id: str,
    at: str | None = Query(
        None,
        description="naive campaign time; when given, every window-derived field is computed from passes "
        "with ts <= at (no at = the stored windows, every pass in the campaign)",
    ),
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """One street. With no `at`, the stored windows — built from every pass in
    the campaign, as the community, industry and admin rooms want them. With
    `at` (through `domain.as_of`), the same body computed from passes with
    `ts <= at` (`passwindow.street`): `stats`, `daily`, `diurnal`,
    `n_passes`, `first_pass`/`last_pass` and `rank_pct`, which is counted
    against every street's `todate` median at that moment. A replayed moment
    then never plots a pass that had not happened; at the end of the data the
    two bodies are equal (tests/test_passwindow.py)."""
    seg = one(conn, "SELECT * FROM road_segment WHERE id = ?", (segment_id,))
    if seg is None:
        raise HTTPException(404, f"unknown segment {segment_id}")
    cid = seg["campaign_id"]
    if at is not None:
        return _detail_at(conn, seg, domain.as_of(conn, cid, at))

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
    return cache.put(key, _detail_body(conn, seg, stats, daily, diurnal, rank_pct, pr))


def _detail_at(conn: sqlite3.Connection, seg: Any, hi: str) -> dict[str, Any]:
    """The detail as of `hi` (already through `as_of`), same shape."""
    cid = seg["campaign_id"]
    key = (cache.version(), seg["id"], hi)
    with _computed_lock:
        hit = _DETAIL.get(key)
        if hit is not None:
            _DETAIL.move_to_end(key)
            return hit
    st = passwindow.street(conn, cid, seg["id"], hi)
    todate = passwindow.resolve(conn, cid, passwindow.TODATE, hi)
    rank_pct: dict[str, float] = {}
    for measure, s in st.stats.items():
        # The stored query's `median <= x` over every street's 'all' row,
        # here over every street's `todate` row at the same moment.
        arr = passwindow.medians(conn, cid, measure, todate)
        below = int(np.searchsorted(arr, s["median"], side="right"))
        rank_pct[measure] = round(100.0 * below / len(arr), 1) if len(arr) else 0.0
    pr = one(
        conn,
        "SELECT MIN(ts) AS first_pass, MAX(ts) AS last_pass, COUNT(*) AS n FROM segment_pass "
        "WHERE segment_id=? AND ts <= ?",
        (seg["id"], hi),
    )
    detail = _detail_body(conn, seg, st.stats, st.daily, st.diurnal, rank_pct, pr)
    with _computed_lock:
        _DETAIL[key] = detail
        while len(_DETAIL) > _DETAIL_MAX:
            _DETAIL.popitem(last=False)
    return detail


def _detail_body(
    conn: sqlite3.Connection,
    seg: Any,
    stats: dict[str, Any],
    daily: dict[str, list],
    diurnal: dict[str, list],
    rank_pct: dict[str, float],
    pr: Any,
) -> dict[str, Any]:
    n_passes = max(
        (s["n_passes"] or 0 for s in stats.values()),
        default=(pr["n"] if pr else 0) or 0,
    )
    coords = jload(seg["geometry_json"], []) or []
    return {
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
        "nearest_site": domain.nearest_site(conn, seg["campaign_id"], seg["mid_lon"], seg["mid_lat"]),
    }
