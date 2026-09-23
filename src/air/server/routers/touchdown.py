"""/sites/{id}/touchdown and /campaigns/{id}/coverage — the MEASURED answer.

One question, one object, four interfaces: **where did the fleet actually find
this site's plume, and where do we simply not know**. Before this there were
four incompatible designs for it, with four verdict vocabularies and four
geometries, so it is served once and read four times.

WHY LINESTRINGS AND NEVER A POLYGON
-----------------------------------
Evidence, not taste. Within 1 km of Ridgeline there are 9 road segments and
they are all the same road; within 2 km, 23 segments on 4 road names. A polygon
drawn there is a two-dimensional shape extrapolated from a line, and it
converts ground nobody has driven into apparent measurement. CONTRACT section 9
non-negotiable 2 already makes the road grid the hero visual in every interface
that shows a map; this is the same rule with teeth.

WHY THERE IS NO `attributed` STATE
----------------------------------
It was cut rather than role-gated. The placebo evidence says the strongest
supportable claim is "elevated when the wind blows from here", which is what
`elevated_downwind` says. Role gating would not have helped anyway: role
arrives as a query parameter or an `X-Air-Role` header with no authentication
behind it, so "only the regulator sees the attribution" is honest by
convention, and a state in the payload eventually renders.
"""

from __future__ import annotations

import sqlite3
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from air.server import cache, domain, touchdown as td
from air.server.db import get_db, one, resolve_campaign

router = APIRouter(tags=["touchdown"])

#: Measures the estimator has a calibrated detection floor for. Anything else
#: would be served without a null calibration, which is the one thing phase 2
#: says never to do.
SUPPORTED = tuple(td.DETECT_FLOOR)


@router.get("/sites/{site_id}/touchdown")
def site_touchdown(
    site_id: str,
    measure: str = "no2",
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    regime: str = td.DEFAULT_REGIME,
    r_lo_m: float = td.DEFAULT_R_LO_M,
    r_hi_m: float = td.DEFAULT_R_HI_M,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    site = one(conn, "SELECT * FROM industry_site WHERE id=?", (site_id,))
    if site is None:
        raise HTTPException(404, f"unknown site {site_id}")
    if measure not in SUPPORTED:
        raise HTTPException(
            400,
            detail={
                "error": "measure_not_calibrated",
                "message": (
                    f"{measure!r} has no calibrated detection floor, so an excess computed "
                    "for it could not be told apart from this estimator's own noise."
                ),
                "supported": list(SUPPORTED),
            },
        )
    regime = "".join(sorted({c for c in regime.upper() if c in "ABCDEF"})) or td.DEFAULT_REGIME

    key = ("touchdown", site_id, measure, from_ or "", to or "", regime, r_lo_m, r_hi_m, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit

    passes = td.load(conn, site["campaign_id"], measure)
    if site_id not in passes.sites:
        raise HTTPException(
            404,
            detail={
                "error": "no_active_sources",
                "message": f"site {site_id} has no active emission points to measure downwind of",
            },
        )
    result = td.estimate(
        passes, site_id, measure,
        r_lo=r_lo_m, r_hi=r_hi_m, regime=regime, from_=from_, to=to,
    )
    return cache.put(key, _shape(conn, passes, result))


def _shape(conn: sqlite3.Connection, passes, t: td.Touchdown) -> dict[str, Any]:
    """A FeatureCollection of road segments, plus the roll-up that is the verdict."""
    geoms = {
        r[0]: r[1]
        for r in conn.execute(
            "SELECT id, geometry_json FROM road_segment WHERE campaign_id=(SELECT campaign_id "
            "FROM industry_site WHERE id=?)",
            (t.site_id,),
        )
    }
    index = {sid: i for i, sid in enumerate(passes.seg_ids)}
    import json

    features = []
    for ev in t.segments:
        raw = geoms.get(ev.segment_id)
        if not raw:
            continue
        i = index[ev.segment_id]
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": json.loads(raw)},
            "properties": {
                **asdict(ev),
                "name": passes.seg_name[i],
                "district": passes.seg_district[i],
            },
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        # THE VERDICT. Phase 2 measured that zero of 1,307 segments accumulate
        # 12 conditioned passes on both sides, so the claim is pooled over the
        # site and the features above are evidence for it, never verdicts of
        # their own.
        "site": {
            k: v for k, v in asdict(t).items() if k not in ("segments", "polar", "districts")
        },
        "polar": [asdict(b) for b in t.polar],
        "districts": t.districts,
        "states": list(td.STATES),
    }


# `/campaigns/{id}/coverage` moved to `routers/coverage.py`, where it sits
# beside the three modelled coverage answers it is the measured counterpart to.
