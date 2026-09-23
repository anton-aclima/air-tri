"""Spherical geometry helpers. Everything is (lon, lat) degrees, metres out."""

from __future__ import annotations

import math
from collections.abc import Callable

R_EARTH = 6371008.8


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * R_EARTH * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """True (forward azimuth) bearing FROM point 1 TO point 2, 0-360, 0 = north."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlam = math.radians(lon2 - lon1)
    y = math.sin(dlam) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlam)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def destination(lon: float, lat: float, bearing: float, dist_m: float) -> tuple[float, float]:
    """Point `dist_m` from (lon, lat) along `bearing` degrees true."""
    d = dist_m / R_EARTH
    br = math.radians(bearing)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(br))
    l2 = l1 + math.atan2(
        math.sin(br) * math.sin(d) * math.cos(p1),
        math.cos(d) - math.sin(p1) * math.sin(p2),
    )
    l2 = (l2 + 3 * math.pi) % (2 * math.pi) - math.pi  # normalise to -pi..pi
    return (math.degrees(l2), math.degrees(p2))


def compass(bearing: float) -> str:
    pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return pts[int((bearing % 360) / 22.5 + 0.5) % 16]


def bbox_of(points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    return (min(lons), min(lats), max(lons), max(lats))


def centroid(points: list[tuple[float, float]]) -> tuple[float, float]:
    n = len(points)
    return (sum(p[0] for p in points) / n, sum(p[1] for p in points) / n)


# ── plume dispersion ──────────────────────────────────────────────────────────

# Pasquill class -> (lateral half-angle deg, downwind reach multiplier).
# Unstable air spreads wide and dilutes fast; stable air stays a narrow ribbon
# that travels a long way. Approximate on purpose — it has to *look* right.
STABILITY = {
    "A": (30.0, 0.60), "B": (25.0, 0.75), "C": (20.0, 0.95),
    "D": (14.0, 1.15), "E": (10.0, 1.45), "F": (7.0, 1.80),
}


def plume_polygon(
    lon: float,
    lat: float,
    wind_from_deg: float,
    speed_ms: float,
    stability: str | None,
    r0: float,
    r1: float,
    steps: int = 14,
) -> list[list[float]]:
    """A tapered cone from (lon, lat) reaching downwind between r0 and r1 metres.

    `wind_from_deg` is the meteorological convention (direction the wind blows
    FROM), so the plume travels toward wind_from_deg + 180.
    """
    half_angle, _ = STABILITY.get((stability or "D").upper(), STABILITY["D"])
    axis = (wind_from_deg + 180.0) % 360.0
    spread = math.tan(math.radians(half_angle))
    # Faster wind -> a tighter, more directional plume.
    tighten = 1.0 / (1.0 + max(0.0, speed_ms - 2.0) * 0.09)
    spread *= tighten

    left: list[list[float]] = []
    right: list[list[float]] = []
    for i in range(steps + 1):
        r = r0 + (r1 - r0) * (i / steps)
        w = spread * r
        off = math.degrees(math.atan2(w, max(r, 1.0)))
        left.append(list(destination(lon, lat, (axis - off) % 360.0, math.hypot(r, w))))
        right.append(list(destination(lon, lat, (axis + off) % 360.0, math.hypot(r, w))))
    ring = left + list(reversed(right))
    ring.append(ring[0])
    return [[round(p[0], 5), round(p[1], 5)] for p in ring]


# How far either side of a kink to place the paired stations. Must survive the
# 5-decimal output rounding (~1 m): at 10 cm both stations round to the same
# coordinate, the near-vertical step between them collapses to a zero-length
# edge, and 6 of 288 test rings came out self-intersecting. At 2 m: 0 of 288.
_KINK_NUDGE_M = 2.0


def plume_union_polygon(
    sources: list[tuple[float, float, float, float]],
    wind_from_deg: float,
    speed_ms: float,
    stability: str | None,
    steps: int = 28,
    half_width: Callable[[float], float] | None = None,
) -> list[list[float]]:
    """One ring covering the union of several same-axis cones.

    `sources` is [(lon, lat, r0, r1), …] — one entry per emission point, each
    with its own downwind reach. Every cone shares the wind axis and the same
    crosswind half-width function, which is what makes an exact union cheap:
    rotate into the downwind frame and the whole family becomes, at each
    downwind distance x, a set of crosswind intervals to merge.

    `half_width(r) -> metres` overrides the straight-sided cone with any
    profile — `/wind/dispersion` passes `air.dispersion.half_width`, which is
    n_sigma * sigma_y and therefore a shallow curve rather than a straight
    edge. The merge does not care which; it only needs the same function for
    every source.

    WHY THIS EXISTS. `/wind/dispersion` returned one polygon per emission point
    per band. Ridgeline has 13 active points inside a ~500 m cluster, so the
    map got 39 translucent slivers stacked on top of each other — the alpha
    piled up 13 deep and the result was an opaque blob roughly the size of the
    campus with no legible band structure. That blob is the thing the owner
    keeps calling "tiny". One polygon per (site, band) is the same physics,
    drawn once.

    Approximations, stated. The merge takes [min, max] of the covering
    intervals rather than tracking disjoint runs, so a site whose points were
    scattered far apart crosswind would get the gap between two cones filled
    in; real sites here cluster inside a few hundred metres and the cones
    overlap long before that matters. Where no cone covers a station at all the
    rails are interpolated from the neighbouring covered ones — the first and
    last are covered by construction, so every gap is bracketed.

    Measured against the individual cones it replaces, over 8 bearings x 4
    stability classes x 3 bands, on all three real sites and on a wider
    synthetic cluster: every ring is simple, and the union under-covers by at
    most 2.9 m of perpendicular distance — the width of the kink nudge. See
    tests/test_geo_plume_union.py, which also explains why the obvious way to
    measure that (distance to the nearest ring *vertex*) reports 234 m for the
    same 3 m gap.
    """
    if not sources:
        return []
    if len(sources) == 1 and half_width is None:
        lon, lat, r0, r1 = sources[0]
        return plume_polygon(lon, lat, wind_from_deg, speed_ms, stability, r0, r1)

    axis = (wind_from_deg + 180.0) % 360.0
    if half_width is None:
        # Legacy straight-sided cone: a fixed half-angle per stability class,
        # tightened by wind speed. `/wind/dispersion` passes the dispersion
        # kernel's sigma_y instead — see the `half_width` parameter.
        half_angle, _ = STABILITY.get((stability or "D").upper(), STABILITY["D"])
        spread = math.tan(math.radians(half_angle))
        spread *= 1.0 / (1.0 + max(0.0, speed_ms - 2.0) * 0.09)

        def half_width(r: float) -> float:  # noqa: F811
            return spread * max(r, 0.0)

    # Downwind frame: origin at the cluster centroid, +x along the axis,
    # +y to its right.
    o_lon, o_lat = centroid([(s[0], s[1]) for s in sources])
    local: list[tuple[float, float, float, float]] = []  # u, v, r0, r1
    for lon, lat, r0, r1 in sources:
        d = haversine_m(o_lon, o_lat, lon, lat)
        th = math.radians(bearing_deg(o_lon, o_lat, lon, lat) - axis)
        local.append((d * math.cos(th), d * math.sin(th), r0, r1))

    x_lo = min(u + r0 for u, _v, r0, _r1 in local)
    x_hi = max(u + r1 for u, _v, _r0, r1 in local)
    if x_hi <= x_lo:
        return []

    # Sample stations: an even sweep, PLUS the exact x where each cone starts
    # and stops contributing. Those are kinks in the rail, and a chord that
    # skips one cuts the corner — 106 m of it on a 2.7 km F-class plume, which
    # no amount of extra even sampling fixes because the error is at a
    # discontinuity, not in the smooth part. Doubled either side so the rail
    # can step across it — see `_KINK_NUDGE_M` for why the nudge is 2 m.
    xs = {x_lo + (x_hi - x_lo) * (i / steps) for i in range(steps + 1)}
    for u, _v, r0, r1 in local:
        for kink in (u + r0, u + r1):
            for x in (kink - _KINK_NUDGE_M, kink + _KINK_NUDGE_M):
                if x_lo < x < x_hi:
                    xs.add(x)
    stations = sorted(xs)

    rails: list[tuple[float, float, float] | None] = []
    for x in stations:
        lo, hi = math.inf, -math.inf
        for u, v, r0, r1 in local:
            r = x - u
            if r < r0 - 1e-9 or r > r1 + 1e-9:
                continue
            w = half_width(max(r, 0.0))
            lo, hi = min(lo, v - w), max(hi, v + w)
        rails.append(None if lo > hi else (x, lo, hi))

    # Fill uncovered stations by interpolating between their covered
    # neighbours. The first and last are covered by construction, so every gap
    # is bracketed.
    covered = [i for i, r in enumerate(rails) if r is not None]
    if len(covered) < 2:
        return []
    for i, r in enumerate(rails):
        if r is not None:
            continue
        a = max(c for c in covered if c < i)
        b = min(c for c in covered if c > i)
        xa, la, ha = rails[a]  # type: ignore[misc]
        xb, lb, hb = rails[b]  # type: ignore[misc]
        t = (stations[i] - xa) / (xb - xa) if xb > xa else 0.0
        rails[i] = (stations[i], la + (lb - la) * t, ha + (hb - ha) * t)

    def to_lonlat(x: float, y: float) -> list[float]:
        # One geodesic hop in polar form, matching how `plume_polygon` places
        # its own rail vertices. Two sequential hops (along-axis, then
        # crosswind) is the obvious spelling and is wrong by ~26 m at 1.5 km,
        # because the two do not commute on a sphere.
        br = (axis + math.degrees(math.atan2(y, x))) % 360.0
        p = destination(o_lon, o_lat, br, math.hypot(x, y))
        return [round(p[0], 5), round(p[1], 5)]

    left = [to_lonlat(x, lo) for x, lo, _hi in rails]  # type: ignore[misc]
    right = [to_lonlat(x, hi) for x, _lo, hi in rails]  # type: ignore[misc]
    ring = left + list(reversed(right))

    # Drop consecutive duplicates before closing. The kink stations sit 10 cm
    # apart and 10 cm rounds away at 5 decimals, so without this the ring
    # carries zero-length edges — which is not cosmetic: it is degenerate input
    # to deck.gl's tessellator, and it made every one of 288 test rings read as
    # self-intersecting.
    out: list[list[float]] = []
    for pt in ring:
        if not out or pt != out[-1]:
            out.append(pt)
    if len(out) < 3:
        return []
    if out[0] != out[-1]:
        out.append(out[0])
    return out
