"""Spherical geometry helpers. Everything is (lon, lat) degrees, metres out."""

from __future__ import annotations

import math

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
