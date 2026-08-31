"""Small, dependency-light geometry toolkit for the `air` simulation.

Everything works in WGS84 lon/lat on the outside and in a local equirectangular
metre frame on the inside.  Over a 12 km campaign the distortion is < 0.1 %, which
is far below the fidelity of anything else in this simulation.

Contains the concave-hull machinery used to draw the campaign boundary: rasterise
the road network, morphologically close it, keep the largest blob, fill holes,
trace the outline, simplify, then round the corners.  The result is a
non-rectangular polygon that follows the streets -- it reads as if a human drew it.
"""

from __future__ import annotations

import math
from collections import deque

import numpy as np

Coord = tuple[float, float]  # (lon, lat)

EARTH_LAT_M = 110540.0
EARTH_LON_M = 111320.0


class Projector:
    """Local equirectangular projection anchored on the campaign centre."""

    __slots__ = ("lon0", "lat0", "kx", "ky")

    def __init__(self, lon0: float, lat0: float):
        self.lon0 = lon0
        self.lat0 = lat0
        self.kx = EARTH_LON_M * math.cos(math.radians(lat0))
        self.ky = EARTH_LAT_M

    def xy(self, lon, lat):
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky

    def xy_arr(self, lon, lat):
        return (np.asarray(lon) - self.lon0) * self.kx, (np.asarray(lat) - self.lat0) * self.ky

    def lonlat(self, x, y):
        return self.lon0 + x / self.kx, self.lat0 + y / self.ky

    def lonlat_arr(self, x, y):
        return self.lon0 + np.asarray(x) / self.kx, self.lat0 + np.asarray(y) / self.ky


def dist_m(a: Coord, b: Coord, proj: Projector) -> float:
    ax, ay = proj.xy(*a)
    bx, by = proj.xy(*b)
    return math.hypot(bx - ax, by - ay)


def polyline_length_m(coords: list[Coord], proj: Projector) -> float:
    return sum(dist_m(coords[i], coords[i + 1], proj) for i in range(len(coords) - 1))


def bearing_deg(a: Coord, b: Coord, proj: Projector) -> float:
    ax, ay = proj.xy(*a)
    bx, by = proj.xy(*b)
    return math.degrees(math.atan2(bx - ax, by - ay)) % 360.0


def cumulative_m(coords: list[Coord], proj: Projector) -> list[float]:
    out = [0.0]
    for i in range(len(coords) - 1):
        out.append(out[-1] + dist_m(coords[i], coords[i + 1], proj))
    return out


def point_at_distance(coords: list[Coord], cum: list[float], d: float) -> Coord:
    """Linear interpolation along a polyline at arc-length `d` metres."""
    if d <= 0:
        return coords[0]
    if d >= cum[-1]:
        return coords[-1]
    lo, hi = 0, len(cum) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if cum[mid] <= d:
            lo = mid
        else:
            hi = mid
    span = cum[lo + 1] - cum[lo]
    t = 0.0 if span <= 0 else (d - cum[lo]) / span
    a, b = coords[lo], coords[lo + 1]
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def slice_polyline(coords: list[Coord], cum: list[float], d0: float, d1: float) -> list[Coord]:
    """The piece of `coords` between arc-lengths d0..d1, with clean end points."""
    pts = [point_at_distance(coords, cum, d0)]
    for i, c in enumerate(cum):
        if d0 < c < d1:
            pts.append(coords[i])
    pts.append(point_at_distance(coords, cum, d1))
    out = [pts[0]]
    for p in pts[1:]:
        if abs(p[0] - out[-1][0]) > 1e-9 or abs(p[1] - out[-1][1]) > 1e-9:
            out.append(p)
    return out if len(out) >= 2 else pts[:2]


def densify(coords: list[Coord], proj: Projector, step_m: float = 30.0) -> list[Coord]:
    cum = cumulative_m(coords, proj)
    total = cum[-1]
    if total <= step_m:
        return list(coords)
    n = max(2, int(total / step_m) + 1)
    return [point_at_distance(coords, cum, total * i / (n - 1)) for i in range(n)]


# ---------------------------------------------------------------- polygons


def ring_contains(ring: np.ndarray, lon, lat) -> np.ndarray:
    """Vectorised even-odd point-in-polygon.  `ring` is (N,2) lon/lat, closed or not."""
    lon = np.atleast_1d(np.asarray(lon, dtype=float))
    lat = np.atleast_1d(np.asarray(lat, dtype=float))
    x = ring[:, 0]
    y = ring[:, 1]
    n = len(ring)
    inside = np.zeros(lon.shape, dtype=bool)
    j = n - 1
    for i in range(n):
        xi, yi, xj, yj = x[i], y[i], x[j], y[j]
        cond = ((yi > lat) != (yj > lat)) & (
            lon < (xj - xi) * (lat - yi) / np.where(yj - yi == 0, 1e-12, yj - yi) + xi
        )
        inside ^= cond
        j = i
    return inside


def douglas_peucker(pts: list[Coord], eps_deg: float) -> list[Coord]:
    if len(pts) < 3:
        return list(pts)
    a, b = pts[0], pts[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    den = math.hypot(dx, dy)
    best_i, best_d = 0, -1.0
    for i in range(1, len(pts) - 1):
        p = pts[i]
        if den < 1e-15:
            d = math.hypot(p[0] - a[0], p[1] - a[1])
        else:
            d = abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / den
        if d > best_d:
            best_i, best_d = i, d
    if best_d <= eps_deg:
        return [a, b]
    left = douglas_peucker(pts[: best_i + 1], eps_deg)
    right = douglas_peucker(pts[best_i:], eps_deg)
    return left[:-1] + right


def chaikin(ring: list[Coord], iterations: int = 2) -> list[Coord]:
    """Corner-cutting smoothing of a closed ring."""
    pts = list(ring)
    for _ in range(iterations):
        out: list[Coord] = []
        n = len(pts)
        for i in range(n):
            p, q = pts[i], pts[(i + 1) % n]
            out.append((0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]))
            out.append((0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]))
        pts = out
    return pts


def ring_area_m2(ring: list[Coord], proj: Projector) -> float:
    a = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = proj.xy(*ring[i])
        x2, y2 = proj.xy(*ring[(i + 1) % n])
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


# ---------------------------------------------------------------- raster morphology


def _disk_offsets(r: int) -> list[tuple[int, int]]:
    return [
        (dy, dx)
        for dy in range(-r, r + 1)
        for dx in range(-r, r + 1)
        if dx * dx + dy * dy <= r * r + r * 0.5
    ]


def _shift_or(mask: np.ndarray, offsets) -> np.ndarray:
    h, w = mask.shape
    out = np.zeros_like(mask)
    for dy, dx in offsets:
        ys0, ys1 = max(0, dy), min(h, h + dy)
        xs0, xs1 = max(0, dx), min(w, w + dx)
        yd0, yd1 = max(0, -dy), min(h, h - dy)
        xd0, xd1 = max(0, -dx), min(w, w - dx)
        out[ys0:ys1, xs0:xs1] |= mask[yd0:yd1, xd0:xd1]
    return out


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    return _shift_or(mask, _disk_offsets(r)) if r > 0 else mask


def erode(mask: np.ndarray, r: int) -> np.ndarray:
    return ~dilate(~mask, r) if r > 0 else mask


def largest_component(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    seen = np.zeros_like(mask)
    best = np.zeros_like(mask)
    best_n = 0
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            comp = []
            q = deque([(sy, sx)])
            seen[sy, sx] = True
            while q:
                y, x = q.popleft()
                comp.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(comp) > best_n:
                best_n = len(comp)
                best = np.zeros_like(mask)
                for y, x in comp:
                    best[y, x] = True
    return best


def fill_holes(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    outside = np.zeros_like(mask)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not mask[y, x] and not outside[y, x]:
                outside[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if not mask[y, x] and not outside[y, x]:
                outside[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not mask[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                q.append((ny, nx))
    return mask | ~outside


_MOORE = [(-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1)]


def trace_outline(mask: np.ndarray) -> list[tuple[int, int]]:
    """Moore-neighbour boundary trace of a single filled blob -> ordered (row, col)."""
    m = np.zeros((mask.shape[0] + 2, mask.shape[1] + 2), dtype=bool)
    m[1:-1, 1:-1] = mask
    hits = np.argwhere(m)
    if len(hits) == 0:
        return []
    start = (int(hits[0][0]), int(hits[0][1]))
    p = start
    b = (start[0], start[1] - 1)  # topmost-leftmost => west neighbour is background
    ring = [p]
    states: set[tuple[int, int, int, int]] = set()
    while True:
        key = (p[0], p[1], b[0], b[1])
        if key in states:
            break
        states.add(key)
        i = _MOORE.index((b[0] - p[0], b[1] - p[1]))
        nxt = None
        for k in range(1, 9):
            c = _MOORE[(i + k) % 8]
            q = (p[0] + c[0], p[1] + c[1])
            if m[q]:
                prev = _MOORE[(i + k - 1) % 8]
                nxt = (q, (p[0] + prev[0], p[1] + prev[1]))
                break
        if nxt is None:
            break
        p, b = nxt
        ring.append(p)
        if len(ring) > 4 * m.size:
            break
    return [(r - 1, c - 1) for (r, c) in ring]


def concave_hull(
    points: list[Coord],
    proj: Projector,
    *,
    cell_m: float = 70.0,
    dilate_m: float = 420.0,
    erode_m: float = 260.0,
    simplify_m: float = 90.0,
    smooth: int = 2,
    pad_cells: int = 6,
) -> list[Coord]:
    """Organic, concave boundary around a point cloud (the road network).

    `dilate_m` sets how far the boundary reaches past the outermost street;
    `erode_m` pulls it back in, and the difference is the morphological closing
    that bridges gaps between streets.  Larger `dilate_m` = rounder, blobbier.
    """
    xs = np.array([p[0] for p in points])
    ys = np.array([p[1] for p in points])
    mx, my = proj.xy_arr(xs, ys)
    x0, x1 = mx.min(), mx.max()
    y0, y1 = my.min(), my.max()
    pad = pad_cells * cell_m + dilate_m
    x0 -= pad
    y0 -= pad
    x1 += pad
    y1 += pad
    w = int(math.ceil((x1 - x0) / cell_m)) + 1
    h = int(math.ceil((y1 - y0) / cell_m)) + 1
    mask = np.zeros((h, w), dtype=bool)
    ci = np.clip(((mx - x0) / cell_m).astype(int), 0, w - 1)
    ri = np.clip(((my - y0) / cell_m).astype(int), 0, h - 1)
    mask[ri, ci] = True

    rd = max(1, int(round(dilate_m / cell_m)))
    re = max(0, int(round(erode_m / cell_m)))
    mask = dilate(mask, rd)
    mask = largest_component(mask)
    mask = erode(mask, re)
    mask = largest_component(mask)
    mask = fill_holes(mask)

    outline = trace_outline(mask)
    if len(outline) < 4:
        raise RuntimeError("concave_hull: could not trace an outline")
    ring_m = [(x0 + (c + 0.5) * cell_m, y0 + (r + 0.5) * cell_m) for (r, c) in outline]
    ring_ll = [proj.lonlat(x, y) for (x, y) in ring_m]
    eps_deg = simplify_m / EARTH_LAT_M
    ring_ll = douglas_peucker(ring_ll, eps_deg)
    if ring_ll[0] == ring_ll[-1]:
        ring_ll = ring_ll[:-1]
    ring_ll = chaikin(ring_ll, smooth)
    return ring_ll


def polygon_geojson(ring: list[Coord], props: dict | None = None) -> dict:
    closed = list(ring)
    if closed[0] != closed[-1]:
        closed.append(closed[0])
    return {
        "type": "Feature",
        "properties": props or {},
        "geometry": {"type": "Polygon", "coordinates": [[[round(x, 6), round(y, 6)] for x, y in closed]]},
    }
