"""`geo.plume_union_polygon` — the P0-C union, and the two bugs it hid.

No database: the sources are synthetic, so this runs on a fresh clone.

The union replaced one cone per emission point with one polygon per (site,
band). Ridgeline has 13 active points inside a ~500 m cluster, so the map was
getting 39 translucent slivers stacked 13 deep. Two defects surfaced only under
the sweep below, and both are regressions worth catching:

1. Sampling the rails on an even sweep cuts the corner at every kink where a
   cone starts or stops contributing. More sampling does not fix it; the error
   is at a discontinuity. Removing the kink stations takes the worst
   under-coverage from 2.9 m to 72.1 m over the sweep below.
2. The paired stations that fix (1) were 10 cm apart, which rounds away at the
   5-decimal output precision, leaving zero-length edges — degenerate input to
   deck.gl's tessellator. Without the de-duplication, 90 of these 96 rings
   carry one; with de-duplication but a 10 cm nudge, 3 of 96 still come out
   self-intersecting. Both fixes are load-bearing.
"""

from __future__ import annotations

import math

import pytest

from air.server import geo

# A synthetic 13-point campus, roughly Ridgeline's footprint: a ~500 m cluster.
LON0, LAT0 = -90.05, 35.05
SOURCES: list[tuple[float, float]] = [
    geo.destination(LON0, LAT0, b, d)
    for b, d in [
        (0, 0), (20, 120), (75, 260), (130, 190), (168, 310), (205, 95),
        (240, 240), (280, 175), (310, 330), (350, 60), (45, 400), (215, 480),
        (95, 150),
    ]
]

BANDS = ((0.04, 0.34), (0.34, 0.66), (0.66, 1.00))
CASES = [
    (wind, speed, cls)
    for wind in (0.0, 45.0, 90.0, 135.0, 180.0, 208.0, 270.0, 315.0)
    for speed, cls in ((1.5, "F"), (3.0, "E"), (6.0, "D"), (4.0, "B"))
]

# The union may fall short of the strict union of the cones it replaces, by the
# rail's step across a kink plus the frame mismatch documented in
# `plume_union_polygon`. Measured worst case over this sweep and over all three
# real sites: 2.9 m. This is a bound with headroom, not the expectation.
MAX_UNDERCOVER_M = 10.0


def _reaches(base: float) -> list[float]:
    """Per-source reach, varied the way stack height varies it in the router."""
    return [base * (0.75 + ((i % 5) / 4.0) * 0.5) for i in range(len(SOURCES))]


def _band_sources(base: float, f0: float, f1: float) -> list[tuple[float, float, float, float]]:
    return [(lon, lat, r * f0, r * f1) for (lon, lat), r in zip(SOURCES, _reaches(base), strict=True)]


def _point_in_ring(ring: list[list[float]], pt: list[float]) -> bool:
    x, y = pt
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _dist_to_ring_m(ring: list[list[float]], p: list[float]) -> float:
    """Metres from `p` to the ring's nearest EDGE.

    Distance to the nearest *vertex* is the obvious thing to write and it is
    badly wrong here: where the rail steps across a kink, the stations either
    side are 4 m apart in x but can be 500 m apart in y, so a point 3 m outside
    the edge reports 234 m from the nearest vertex. That artefact is what made
    the union look 40x worse than it is. Equirectangular is plenty at this
    scale.
    """
    lat0 = math.radians(p[1])
    kx, ky = 111320.0 * math.cos(lat0), 110540.0
    px, py = p[0] * kx, p[1] * ky
    best = math.inf
    for i in range(len(ring) - 1):
        ax, ay = ring[i][0] * kx, ring[i][1] * ky
        bx, by = ring[i + 1][0] * kx, ring[i + 1][1] * ky
        dx, dy = bx - ax, by - ay
        span = dx * dx + dy * dy
        t = 0.0 if span == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / span))
        best = min(best, math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    return best


def _orient(p, q, r) -> int:
    v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1])
    return 0 if abs(v) < 1e-16 else (1 if v > 0 else -1)


def _is_simple(ring: list[list[float]]) -> bool:
    """No two non-adjacent edges cross. Ring is closed, so ring[-1] == ring[0]."""
    n = len(ring) - 1
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue  # first and last edges share a vertex
            a, b, c, d = ring[i], ring[i + 1], ring[j], ring[j + 1]
            if _orient(a, b, c) != _orient(a, b, d) and _orient(c, d, a) != _orient(c, d, b):
                return False
    return True


@pytest.mark.parametrize(("wind", "speed", "cls"), CASES)
def test_union_ring_is_well_formed(wind: float, speed: float, cls: str) -> None:
    base = (700.0 + 240.0 * speed) * geo.STABILITY[cls][1]
    for f0, f1 in BANDS:
        ring = geo.plume_union_polygon(_band_sources(base, f0, f1), wind, speed, cls)
        assert len(ring) >= 4, "degenerate ring"
        assert ring[0] == ring[-1], "ring is not closed"
        dupes = [i for i in range(len(ring) - 1) if ring[i] == ring[i + 1]]
        assert not dupes, f"zero-length edges at {dupes} — deck.gl cannot tessellate these"
        assert _is_simple(ring), f"self-intersecting ring, wind {wind} {speed} m/s class {cls}"


@pytest.mark.parametrize(("wind", "speed", "cls"), CASES)
def test_union_covers_the_cones_it_replaces(wind: float, speed: float, cls: str) -> None:
    base = (700.0 + 240.0 * speed) * geo.STABILITY[cls][1]
    for f0, f1 in BANDS:
        sources = _band_sources(base, f0, f1)
        ring = geo.plume_union_polygon(sources, wind, speed, cls)
        for lon, lat, r0, r1 in sources:
            cone = geo.plume_polygon(lon, lat, wind, speed, cls, r0, r1)
            for v in cone[:-1]:
                if _point_in_ring(ring, v):
                    continue
                gap = _dist_to_ring_m(ring, v)
                assert gap <= MAX_UNDERCOVER_M, (
                    f"union falls {gap:.0f} m short of a cone vertex "
                    f"(wind {wind}, {speed} m/s, class {cls}, band {f0}-{f1})"
                )


def test_single_source_is_the_plain_cone() -> None:
    """One emission point must not take a different code path to the same shape."""
    args = (180.0, 3.0, "D")
    one = geo.plume_union_polygon([(LON0, LAT0, 100.0, 900.0)], *args)
    assert one == geo.plume_polygon(LON0, LAT0, *args, 100.0, 900.0)


def test_no_sources_is_empty_not_a_crash() -> None:
    assert geo.plume_union_polygon([], 180.0, 3.0, "D") == []


def test_union_points_downwind() -> None:
    """Meteorological convention: wind FROM 180 travels toward 0 (north)."""
    ring = geo.plume_union_polygon(_band_sources(2000.0, 0.66, 1.0), 180.0, 3.0, "E")
    o_lon, o_lat = geo.centroid(SOURCES)
    far = max(ring, key=lambda p: geo.haversine_m(o_lon, o_lat, p[0], p[1]))
    bearing = geo.bearing_deg(o_lon, o_lat, far[0], far[1])
    assert min(abs(bearing), abs(bearing - 360.0)) < 45.0, f"plume went {bearing:.0f}°, not north"


def test_bands_nest_outward() -> None:
    """Band 2 must reach further than band 0, or the contour is inside out."""
    o_lon, o_lat = geo.centroid(SOURCES)
    reach = []
    for f0, f1 in BANDS:
        ring = geo.plume_union_polygon(_band_sources(2000.0, f0, f1), 208.0, 3.0, "E")
        reach.append(max(geo.haversine_m(o_lon, o_lat, p[0], p[1]) for p in ring))
    assert reach[0] < reach[1] < reach[2], f"bands do not nest: {[round(r) for r in reach]}"
