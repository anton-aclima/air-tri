"""Spherical geometry helpers. Everything is (lon, lat) degrees, metres out."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

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


# ── the model's outline: one ring, one cut, one nose ─────────────────────────

# Segments per side of the rounded far end. The nose is a cubic, so 16 chords
# put the worst chord error well under a pixel at any zoom the deck uses.
_NOSE_STEPS = 16
# How long the nose is, as a share of the plume's own length at most. The rest
# of the time it is one half-width, which is what makes it read as a rounded
# end rather than as a point.
_NOSE_MAX_SHARE = 0.4
# Stations closer than this to the envelope cut are dropped, so the only
# vertex near the cut is the cut itself. A kink station 2 m short of it would
# otherwise sit inside the client's 1.5 m "on the cut" tolerance and leave a
# 2 m gap in the rail where the client drops the cut edge.
_CUT_CLEARANCE_M = 3.0


@dataclass(frozen=True)
class OutlineFrame:
    """A site's modelled outline in the axis's own frame, before projection.

    `x` is metres along the transport axis from `origin`, `y` metres to its
    right (clockwise), polar on the sphere: a vertex at (x, y) is projected as
    one geodesic hop of `hypot(x, y)` on bearing `axis_deg + atan2(y, x)`, so a
    point's (x, y) is read back exactly by the inverse (`plumegeom`).

    `left` and `right` both run near -> far and both END on the tip — the
    point on the axis at the reach — so each rail is a function of `x`. That is
    what lets `plumegeom` answer "is this point inside the outline the map
    draws" with one interpolation per rail against the very vertices the ring
    is projected from, rather than with a second shape (R0,
    docs/PLAN-refocus.md section 3.3).
    """

    origin: tuple[float, float]
    axis_deg: float
    left: tuple[tuple[float, float], ...]
    right: tuple[tuple[float, float], ...]
    x_start: float
    x_end: float
    #: The envelope as asked for, and the cut actually made (None when the
    #: envelope falls outside the ring's span: the whole ring is one part).
    split_at: float | None
    cut: float | None


def plume_outline(
    origin: tuple[float, float],
    wind_from_deg: float,
    sources: list[tuple[float, float]],
    x_onset: float,
    x_reach: float,
    split_at: float | None,
    half_width: Callable[[Any], Any],
    steps: int = 28,
) -> dict[str, list[list[float]]]:
    """A site's modelled plume as ONE outline, split once at the envelope.

    CONTRACT 10b draws Aclima's model as an outline, solid up to the detection
    envelope and dashed past it, with an axis whose tick sits at the envelope.
    This used to be two `plume_union_polygon` calls, one per part, each with
    per-source spans measured from each source. Sources sit 100-230 m apart
    along the axis, so the two parts overlapped by a few hundred metres and
    each ended in a staircase of per-source steps: a 3-23 px jog and a set of
    crosswise bars at the envelope on the deck (phase 3 review), and a far end
    notched like a house roof. Here there is one ring and one cut:

    * **Frame.** `origin` is the axis's own first vertex — the emission-
      weighted source, already rounded to the five decimals it is served at —
      so a vertex `x` metres along this frame reads back as `x` metres from
      the axis origin in any client that measures from it (polar, one
      geodesic hop, the same sphere).
    * **Rails.** Each source's cone starts at its own onset (`u + x_onset`),
      so the outline encloses every release point, and all of them run to the
      SAME far station `x_reach` in this frame. `x_reach` is the site's reach
      (`air.dispersion.reach` treats the site's points as co-located), so
      measuring it from the site's emission-weighted origin is the reading
      the axis and the reach tick already use; measuring it from each source
      is what put the outline 145-190 m past the tick.
    * **Nose.** The far end is one smooth cubic from each rail to a point on
      the axis at `x_reach`, leaving the rail on its own tangent and arriving
      crosswind. No per-source notches, and the axis ends where the outline
      does, so the tick and "truncated" mark the drawn end.
    * **Cut.** `split_at` (the envelope) is a straight line across the axis.
      Both parts carry the SAME two cut vertices, so they share an edge
      exactly and a client clip at that line is a no-op.

    `half_width` must accept an array (`air.dispersion.half_width` does): the
    rails are evaluated for every station and source at once, because the
    regulator's coverage surfaces now build this outline for all 2,160 hours
    (R0) and the scalar loop cost ~6 ms per Ridgeline hour. Elementwise the
    arithmetic is the same IEEE operations, so the ring is unchanged.

    Returns `{"inside": ring, "beyond": ring}` with whichever parts exist
    (closed GeoJSON rings, five decimals). `split_at` None or outside the
    ring's span returns the whole ring under the part it lies in.
    """
    frame = plume_outline_frame(
        origin, wind_from_deg, sources, x_onset, x_reach, split_at, half_width, steps
    )
    return {} if frame is None else outline_rings(frame)


def plume_outline_frame(
    origin: tuple[float, float],
    wind_from_deg: float,
    sources: list[tuple[float, float]],
    x_onset: float,
    x_reach: float,
    split_at: float | None,
    half_width: Callable[[Any], Any],
    steps: int = 28,
) -> OutlineFrame | None:
    """`plume_outline`'s ring in the axis frame, unprojected. None when there
    is no ring to draw. See `plume_outline` for how it is built."""
    o_lon, o_lat = origin
    axis = (wind_from_deg + 180.0) % 360.0
    local: list[tuple[float, float]] = []
    for lon, lat in sources:
        d = haversine_m(o_lon, o_lat, lon, lat)
        th = math.radians(bearing_deg(o_lon, o_lat, lon, lat) - axis) if d > 0 else 0.0
        local.append((d * math.cos(th), d * math.sin(th)))
    if not local:
        return None

    x_end = float(x_reach)
    starts = [u + x_onset for u, _v in local]
    x_start = min(starts)
    if x_end - x_start < 1.0:
        return None

    src_u = np.array([u for u, _v in local], dtype=float)
    src_v = np.array([v for _u, v in local], dtype=float)
    src_s = np.array(starts, dtype=float)

    def rails_many(xs: list[float]) -> tuple[np.ndarray, np.ndarray]:
        """(lo, hi) at each station: the union of the started sources' cones.
        lo > hi (inf > -inf) where no source has started."""
        x = np.asarray(xs, dtype=float)[:, None]
        started = ~(x < src_s[None, :] - 1e-9)
        w = np.asarray(half_width(np.maximum(x - src_u[None, :], 0.0)), dtype=float)
        lo = np.where(started, src_v[None, :] - w, np.inf).min(axis=1)
        hi = np.where(started, src_v[None, :] + w, -np.inf).max(axis=1)
        return lo, hi

    def rails(x: float) -> tuple[float, float] | None:
        lo, hi = rails_many([x])
        return None if lo[0] > hi[0] else (float(lo[0]), float(hi[0]))

    # The nose: one half-width long, never more than a share of the plume.
    end = rails(x_end)
    if end is None:
        return None
    nose = min(0.5 * (end[1] - end[0]), _NOSE_MAX_SHARE * (x_end - x_start))
    x_c = x_end - nose

    cut = split_at if split_at is not None and x_start < split_at < x_end else None

    xs = {x_start + (x_c - x_start) * (i / steps) for i in range(steps + 1)}
    for s in starts:
        # Where a source joins: a kink in the rail, stepped across as in
        # `plume_union_polygon` (see `_KINK_NUDGE_M`).
        for x in (s - _KINK_NUDGE_M, s + _KINK_NUDGE_M):
            if x_start < x < x_c:
                xs.add(x)
    if cut is not None and cut < x_c:
        xs = {x for x in xs if abs(x - cut) >= _CUT_CLEARANCE_M}
        xs.add(cut)
    stations = sorted(xs)

    left: list[tuple[float, float]] = []
    right: list[tuple[float, float]] = []
    los, his = rails_many(stations)
    for x, lo, hi in zip(stations, los, his, strict=True):
        if lo > hi:
            continue
        left.append((x, float(lo)))
        right.append((x, float(hi)))
    if len(left) < 2:
        return None

    # Each side of the nose leaves its rail on the rail's own heading (so
    # there is no corner where it starts) and arrives at the axis crosswind
    # (so the two sides meet in one smooth curve). Control arms of 0.55 of
    # the span are the quarter-circle constant; the slope is clamped so a
    # steep near-field rail cannot throw the arm outside the plume.
    back = max(1.0, min(nose * 0.05, 25.0))
    lo_b, hi_b = rails(x_c - back) or (left[-1][1], right[-1][1])
    lo_c, hi_c = left[-1][1], right[-1][1]
    y_tip = min(max(0.0, lo_c + 1.0), hi_c - 1.0)

    def arc(y_c: float, slope: float) -> list[tuple[float, float]]:
        slope = max(-1.0, min(1.0, slope))
        k = 0.55
        p0 = (x_c, y_c)
        p1 = (x_c + k * nose, y_c + k * nose * slope)
        p3 = (x_end, y_tip)
        p2 = (x_end, y_tip + k * (y_c - y_tip))
        pts = []
        for i in range(1, _NOSE_STEPS + 1):
            t = i / _NOSE_STEPS
            a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
            pts.append((
                a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
            ))
        return pts

    # Both arcs end on the same tip (at t = 1 the cubic is exactly p3), so
    # each rail carries it and each is a function of x out to the reach.
    left += arc(lo_c, (lo_c - lo_b) / back)
    right += arc(hi_c, (hi_c - hi_b) / back)
    return OutlineFrame(
        origin=(o_lon, o_lat), axis_deg=axis, left=tuple(left), right=tuple(right),
        x_start=x_start, x_end=x_end, split_at=split_at, cut=cut,
    )


def outline_rings(frame: OutlineFrame) -> dict[str, list[list[float]]]:
    """Project a frame to GeoJSON rings, cut once at the envelope."""
    o_lon, o_lat = frame.origin
    axis = frame.axis_deg
    cut, split_at, x_start = frame.cut, frame.split_at, frame.x_start
    # `right` keeps the tip so the ring has it once.
    left = list(frame.left[:-1])
    right = list(frame.right)

    def to_lonlat(x: float, y: float) -> list[float]:
        br = (axis + math.degrees(math.atan2(y, x))) % 360.0
        p = destination(o_lon, o_lat, br, math.hypot(x, y))
        return [round(p[0], 5), round(p[1], 5)]

    def ring_of(pts: list[tuple[float, float]]) -> list[list[float]]:
        out: list[list[float]] = []
        for x, y in pts:
            q = to_lonlat(x, y)
            if not out or q != out[-1]:
                out.append(q)
        if len(out) < 3:
            return []
        if out[0] != out[-1]:
            out.append(out[0])
        return out

    def crossing(side: list[tuple[float, float]], x: float) -> tuple[int, tuple[float, float]]:
        """Index of the first vertex past `x`, and the point on the side at `x`."""
        for i in range(1, len(side)):
            (xa, ya), (xb, yb) = side[i - 1], side[i]
            if xb >= x:
                if abs(xa - x) < 1e-9:
                    return i, (x, ya)
                t = (x - xa) / (xb - xa) if xb > xa else 1.0
                return i, (x, ya + (yb - ya) * t)
        return len(side), side[-1]

    # `right` runs near -> far like `left`; the ring walks out one side and
    # back the other.
    whole_tip = right[-1]
    if cut is None:
        ring = ring_of(left + [whole_tip] + list(reversed(right[:-1])))
        part = "beyond" if split_at is not None and x_start >= split_at else "inside"
        return {part: ring} if ring else {}

    li, lcut = crossing(left + [whole_tip], cut)
    ri, rcut = crossing(right, cut)
    near_l = [p for p in left[:li] if p[0] < cut - 1e-9]
    near_r = [p for p in right[:ri] if p[0] < cut - 1e-9]
    far_l = [p for p in (left + [whole_tip])[li:] if p[0] > cut + 1e-9]
    far_r = [p for p in right[ri:] if p[0] > cut + 1e-9]
    # The tip belongs to both far lists when the cut is short of it; keep one.
    if far_l and far_r and far_l[-1] == far_r[-1]:
        far_l = far_l[:-1]
    inside = ring_of(near_l + [lcut, rcut] + list(reversed(near_r)))
    beyond = ring_of([lcut] + far_l + list(reversed(far_r)) + [rcut])
    out: dict[str, list[list[float]]] = {}
    if inside:
        out["inside"] = inside
    if beyond:
        out["beyond"] = beyond
    return out
