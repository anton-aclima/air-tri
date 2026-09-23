"""How often the wind carries from a site over a neighbourhood.

THE COMMUNITY APP'S FRONT DOOR. A resident opens the map and reads a calm,
stable sentence — over the last three months the wind carried from Ridgeline
over Boxtown about one hour in two — beside the coloured streets showing what
was actually measured. The live plume cloud is one tap behind it.

WHY THIS IS THE FRONT DOOR AND NOT THE CLOUD
--------------------------------------------
Three reasons, in order of how much they matter.

1. **It is stable.** Open the map at 8am and at 6pm and it says the same thing.
   A live cone changes every hour, so a resident who checks twice gets two
   different stories and trusts neither.
2. **It is reach-independent.** This asks only whether the wind POINTED at a
   neighbourhood, never whether a plume got there. So it does not move when the
   dispersion kernel changes — and the kernel's reach moved by a factor of five
   in phase 1. A number a resident might screenshot should not depend on which
   sprint they screenshotted it in.
3. **No cone touches anyone.** The whole narrative lands without drawing a
   shape over a named neighbourhood, which is the one place this product could
   put a boundary into a house listing.

WHAT IS AND IS NOT CLAIMED
--------------------------
"The wind carried from here toward there" — a fact about the wind. NOT "their
air is worse", which is `air.server.touchdown`'s question and has a much weaker
answer. Nothing here is evidence that anything was emitted, and the copy layer
(`PLUME_COPY`) carries that sentence so it cannot drift.

THE SECTOR
----------
Per hour, from the dispersion kernel's own sigma_y at that district's distance
under that hour's stability and wind speed. Not a flat 22.5 degrees: a plume is
narrow on a still night and wide on a gusty afternoon, and a fixed sector would
call the same hour downwind in both. This is a WIDTH, not a reach — using it
keeps the geometry consistent with everything else without making the answer
depend on how far anything travels.
"""

from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from air import dispersion
from air.server import cache, geo

#: Multiples of sigma_y for the "is this district downwind" sector. Matches the
#: touchdown estimator's `N_SIGMA`, so the two never disagree about what
#: downwind means.
N_SIGMA = 2.0

#: Never narrower than this. Under very stable air sigma_y at 3 km is a couple
#: of degrees, which would make the answer a function of rounding in the wind
#: record rather than of the weather.
MIN_HALF_DEG = 8.0

#: Nor wider. A sector this wide already covers a sixth of the compass.
MAX_HALF_DEG = 30.0

#: A district needs this much road inside the campaign to be reported at all.
MIN_ROAD_M = 800.0

STABLE_CLASSES = "EF"


@dataclass(frozen=True)
class DistrictWind:
    district: str
    #: From the site's emission-weighted centroid to the district's
    #: road-length-weighted centroid.
    bearing_deg: float
    distance_m: float
    road_km: float
    n_hours: int
    hours_downwind: int
    #: Reach-independent: the share of hours the wind POINTED here. 0-1.
    share: float
    #: The same thing restricted to stable air, when a plume stays together.
    hours_stable: int
    hours_downwind_stable: int
    share_stable: float


@dataclass(frozen=True)
class Climatology:
    site_id: str
    campaign_id: str
    from_: str
    to: str
    n_hours: int
    #: Where the wind BLOWS FROM, 16 bins, `freq` as a percentage.
    rose: list[dict[str, Any]]
    #: The met record for the campaign, not our fleet's anemometry. Stated
    #: because the two differ and the difference is a different product story.
    source: str
    districts: list[DistrictWind] = field(default_factory=list)


def _district_centroids(
    conn: sqlite3.Connection, campaign_id: str
) -> dict[str, tuple[float, float, float]]:
    """(lon, lat, road_m) per district, weighted by road length."""
    acc: dict[str, list[float]] = {}
    for district, lon, lat, length in conn.execute(
        "SELECT district, mid_lon, mid_lat, length_m FROM road_segment "
        "WHERE campaign_id = ? AND district IS NOT NULL",
        (campaign_id,),
    ):
        w = float(length or 200.0)
        a = acc.setdefault(district, [0.0, 0.0, 0.0])
        a[0] += w * lon
        a[1] += w * lat
        a[2] += w
    return {
        d: (v[0] / v[2], v[1] / v[2], v[2])
        for d, v in acc.items()
        if v[2] >= MIN_ROAD_M
    }


def _site_origin(conn: sqlite3.Connection, site_id: str) -> tuple[float, float]:
    """Emission-weighted centroid of the ACTIVE points, as everywhere else."""
    lon = lat = tot = 0.0
    for kind, x, y in conn.execute(
        "SELECT kind, lon, lat FROM emission_point WHERE site_id = ? AND active = 1",
        (site_id,),
    ):
        w = dispersion.STRENGTH.get(kind, 0.6)
        lon += w * x
        lat += w * y
        tot += w
    if tot == 0.0:
        row = conn.execute(
            "SELECT centroid_lon, centroid_lat FROM industry_site WHERE id = ?", (site_id,)
        ).fetchone()
        if row is None:
            raise KeyError(site_id)
        return (float(row[0]), float(row[1]))
    return (lon / tot, lat / tot)


def _half_angle(distance_m: float, cls: str, u10: float) -> float:
    w = float(dispersion.half_width(max(distance_m, 1.0), cls, u10, N_SIGMA))
    deg = math.degrees(math.atan2(w, max(distance_m, 1.0)))
    return min(MAX_HALF_DEG, max(MIN_HALF_DEG, deg))


def estimate(
    conn: sqlite3.Connection, campaign_id: str, site_id: str, from_: str, to: str
) -> Climatology:
    origin = _site_origin(conn, site_id)
    hours = conn.execute(
        "SELECT ts, speed_ms, dir_deg, stability FROM wind "
        "WHERE campaign_id = ? AND ts >= ? AND ts <= ? ORDER BY ts",
        (campaign_id, from_, to),
    ).fetchall()
    rose_bins = _rose([(float(h[2]), float(h[1] or 0.0)) for h in hours])

    dirs = np.array([float(h[2]) for h in hours])
    speeds = np.array([max(0.4, float(h[1] or 1.0)) for h in hours])
    classes = np.array([(h[3] or "D").upper() for h in hours])
    transport = (dirs + 180.0) % 360.0
    stable = np.isin(classes, list(STABLE_CLASSES))

    out: list[DistrictWind] = []
    for district, (lon, lat, road_m) in sorted(_district_centroids(conn, campaign_id).items()):
        d = geo.haversine_m(origin[0], origin[1], lon, lat)
        b = geo.bearing_deg(origin[0], origin[1], lon, lat)
        if d < 200.0:
            continue
        # One half-angle per (class, rounded speed) rather than per hour: the
        # sector depends on the class and, through the meander term, weakly on
        # the speed. Bucketing keeps this a couple of kernel calls instead of
        # thousands without moving the answer.
        half = np.empty(len(hours))
        for cls in np.unique(classes):
            m = classes == cls
            half[m] = _half_angle(d, str(cls), float(np.median(speeds[m])))
        off = np.abs((b - transport + 180.0) % 360.0 - 180.0)
        downwind = off <= half
        n_stable = int(stable.sum())
        out.append(DistrictWind(
            district=district,
            bearing_deg=round(b, 1),
            distance_m=round(d, 1),
            road_km=round(road_m / 1000.0, 2),
            n_hours=len(hours),
            hours_downwind=int(downwind.sum()),
            share=round(float(downwind.mean()), 4) if len(hours) else 0.0,
            hours_stable=n_stable,
            hours_downwind_stable=int((downwind & stable).sum()),
            share_stable=round(float((downwind & stable).sum() / n_stable), 4) if n_stable else 0.0,
        ))

    out.sort(key=lambda x: -x.share)
    return Climatology(
        site_id=site_id, campaign_id=campaign_id, from_=from_, to=to,
        n_hours=len(hours), rose=rose_bins, source="met_record", districts=out,
    )


def _rose(obs: list[tuple[float, float]]) -> list[dict[str, Any]]:
    from air.server import windfield

    return windfield.rose(obs)


def cached(
    conn: sqlite3.Connection, campaign_id: str, site_id: str, from_: str, to: str
) -> Climatology:
    key = ("climatology", campaign_id, site_id, from_, to, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, estimate(conn, campaign_id, site_id, from_, to))
