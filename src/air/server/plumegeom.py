"""The ONE modelled-plume geometry: the outline the map draws, and every
"inside the modelled plume" the product states.

WHY THIS MODULE EXISTS (R0, docs/PLAN-refocus.md section 3.3)
------------------------------------------------------------
Two of the product's own plume computations disagreed about DRAQA's Riverport
Road monitor. Point-in-polygon against `GET /wind/dispersion` put it inside
Riverport Intermodal's plume in 7 of the 9 live alert hours; the coverage
model's hourly masks (`coverage._hourly_masks`, behind `/coverage/interception`)
put it inside in 1 of 5 standard-level hours and 3 of 17 watch-level hours.

Same wind row, same hour, same sources, same kernel reach — measured, the hour
key and the time zone are not it. The cause was the SHAPE. Coverage tested one
sigma_y wedge from the site's emission-weighted centroid. The map draws the
union of every release point's wedge (`geo.plume_outline`), each offset by the
point's own crosswind position. Riverport's four points spread about 300 m
across the wind; at 424 m from the site the 2-sigma wedge is ~84 m wide, and
on Aug 25 06:00 (class F, toward 337 deg) the monitor sits 134 m crosswind of
the centroid's axis but directly downwind of the 4 m stack 289 m away on
bearing 337. The single wedge said outside; the drawn outline, correctly, said
inside. A single-origin cone is a far-field approximation, and the monitor that
carries the regulator's headline is in the near field.

So the outline wins — it is what users see, and it is the better physics near
a spread-out site — and everything that says "inside" now asks it:

    /wind/dispersion?outline=1   draws `SitePlume.rings()`
    /coverage/interception       counts `SitePlume.locate_polar()` per hour
    /coverage/residency          the same, per road segment
    /regulator/network           `in_plume` at the moment shown

`site_plume` takes exactly the inputs the router does — the class coerced by
`air.dispersion.coerce_class`, the exact 10 m wind and mixing height (coverage
used to round them to 0.1 m/s and 10 m for its cache), the router's "no band
spans, no plume" rule — and the same emission-weighted origin, rounded to the
five decimals the axis is served at.

`locate_polar` does not re-derive a polygon: it inverts the polar projection the
ring is built with and interpolates the frame's own rails (`geo.OutlineFrame`),
so it disagrees with a point-in-polygon on the served ring only within the
~1 m of the five-decimal rounding (tests/test_regulator_network.py measures it).

PARTS. `inside` is the outline up to the detection envelope, `beyond` the rest
(CONTRACT 10b: nothing is judged from the beyond part). The split is the same
straight cut across the axis at the envelope that the map dashes.
"""

from __future__ import annotations

import math
import sqlite3
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from air import dispersion as plume
from air.server import geo

R_EARTH = geo.R_EARTH

#: `locate` codes.
OUTSIDE, INSIDE, BEYOND = 0, 1, 2
PART_NAME = {INSIDE: "inside", BEYOND: "beyond"}

#: Below this plume length the kernel's `bands` may drop every band (each is
#: dropped under one 20 m step), and the router then draws nothing. At or above
#: three steps one band is always kept, so `bands` need not be evaluated.
_BAND_STEP_M = 20.0


@dataclass(frozen=True)
class Weather:
    """One hour's inputs to the plume, exactly as `/wind/dispersion` reads them."""

    ts: str
    dir_deg: float  # meteorological: the direction the wind blows FROM
    u10: float
    cls: str  # after `coerce_class`
    reported: str
    note: str | None
    pbl_m: float

    @property
    def toward_deg(self) -> float:
        return (self.dir_deg + 180.0) % 360.0


def weather(row: Mapping[str, Any]) -> Weather:
    """`row` is a wind row or `shapes.wind_point` dict."""
    u10 = max(0.4, float(row["speed_ms"] or 1.0))
    reported = (row["stability"] or "D").upper()
    cls, note = plume.coerce_class(reported, u10)
    pbl = row["pbl_m"] if "pbl_m" in row.keys() else None  # noqa: SIM118 - sqlite3.Row has no `in`
    return Weather(
        ts=row["ts"], dir_deg=float(row["dir_deg"]), u10=u10, cls=cls, reported=reported,
        note=note, pbl_m=float(pbl or 500.0),
    )


#: (lon, lat, height_m, kind) — one active release point.
Point = tuple[float, float, float, str]


def points_of(rows: Sequence[Mapping[str, Any]]) -> list[Point]:
    """Release points as the kernel sees them, in a total order.

    Sorted so the emission-weighted origin is the same float sum whichever
    query produced the rows (the router filters by site, coverage does not)."""
    pts = [
        (float(r["lon"]), float(r["lat"]), float(r["height_m"] or 12.0), str(r["kind"]))
        for r in rows
    ]
    return sorted(pts, key=lambda p: (p[3], p[0], p[1], p[2]))


def load_points(conn: sqlite3.Connection, campaign_id: str) -> dict[str, list[Point]]:
    """{site_id: points} for every site with an active release point."""
    by_site: dict[str, list[Any]] = {}
    for r in conn.execute(
        "SELECT e.site_id, e.lon, e.lat, e.height_m, e.kind FROM emission_point e "
        "JOIN industry_site s ON s.id = e.site_id WHERE s.campaign_id = ? AND e.active = 1",
        (campaign_id,),
    ):
        by_site.setdefault(r[0], []).append({"lon": r[1], "lat": r[2], "height_m": r[3], "kind": r[4]})
    return {sid: points_of(rows) for sid, rows in by_site.items()}


def origin_of(pts: Sequence[Point]) -> tuple[float, float]:
    """The axis's first vertex: the EMISSION-weighted source, with the kernel's
    own weights (`Source.emission`), rounded to the five decimals it is served
    at BEFORE anything is placed from it. See `routers/wind._outline_features`."""
    weights = [plume.Source(h, k).emission() for _lon, _lat, h, k in pts]
    if sum(weights) <= 0.0:
        weights = [1.0] * len(weights)
    total = sum(weights)
    lon = round(sum(w * p[0] for w, p in zip(weights, pts, strict=True)) / total, 5)
    lat = round(sum(w * p[1] for w, p in zip(weights, pts, strict=True)) / total, 5)
    return (lon, lat)


@dataclass(frozen=True)
class SitePlume:
    """One site's modelled plume in one hour: the outline the map draws."""

    site_id: str
    weather: Weather
    reach: plume.Reach
    origin: tuple[float, float]
    envelope_m: float
    frame: geo.OutlineFrame | None
    # The frame's rails as arrays, for `locate_polar`.
    _lx: np.ndarray
    _ly: np.ndarray
    _rx: np.ndarray
    _ry: np.ndarray

    @property
    def toward_deg(self) -> float:
        return self.weather.toward_deg

    def rings(self) -> dict[str, list[list[float]]]:
        """{'inside': ring, 'beyond': ring}, whichever exist — the served outline."""
        return {} if self.frame is None else geo.outline_rings(self.frame)

    def locate_polar(self, dist_m: np.ndarray, bearing_deg: np.ndarray) -> np.ndarray:
        """OUTSIDE / INSIDE / BEYOND for receptors given as distance and true
        bearing FROM `origin`. The inverse of the ring's own projection (one
        geodesic hop on `axis + atan2(y, x)`), so no second shape is built."""
        d = np.asarray(dist_m, dtype=float)
        out = np.zeros(d.shape, dtype=np.int8)
        f = self.frame
        if f is None:
            return out
        th = np.radians(np.asarray(bearing_deg, dtype=float) - f.axis_deg)
        x = d * np.cos(th)
        y = d * np.sin(th)
        span = (x >= f.x_start) & (x <= f.x_end)
        if not span.any():
            return out
        lo = np.interp(x, self._lx, self._ly)
        hi = np.interp(x, self._rx, self._ry)
        hit = span & (y >= lo) & (y <= hi)
        if f.split_at is None:
            out[hit] = INSIDE
            return out
        # The map's cut: one straight line across the axis at the envelope.
        # An envelope short of the ring's start makes the whole ring `beyond`,
        # as `geo.outline_rings` labels it.
        far = x > float(f.split_at)
        out[hit & ~far] = INSIDE
        out[hit & far] = BEYOND
        return out

    def locate(self, lons: Any, lats: Any) -> np.ndarray:
        lons = np.atleast_1d(np.asarray(lons, dtype=float))
        lats = np.atleast_1d(np.asarray(lats, dtype=float))
        return self.locate_polar(*polar_from(self.origin, lons, lats))


def polar_from(origin: tuple[float, float], lons: np.ndarray, lats: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(distance m, true bearing deg) of each point FROM `origin` — the same
    haversine and forward azimuth `geo` projects the ring with."""
    lon0, lat0 = origin
    p1, p2 = math.radians(lat0), np.radians(lats)
    dphi, dlam = p2 - p1, np.radians(lons - lon0)
    a = np.sin(dphi / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(dlam / 2) ** 2
    d = 2 * R_EARTH * np.arcsin(np.minimum(1.0, np.sqrt(a)))
    y = np.sin(dlam) * np.cos(p2)
    x = math.cos(p1) * np.sin(p2) - math.sin(p1) * np.cos(p2) * np.cos(dlam)
    b = np.mod(np.degrees(np.arctan2(y, x)) + 360.0, 360.0)
    return d, b


def _drawn(r: plume.Reach, srcs: list[plume.Source], w: Weather) -> bool:
    """The router's rule: a site whose profile yields no band draws nothing."""
    if r.faint or r.x_reach <= r.x_onset:
        return False
    if r.x_reach - r.x_onset >= 3 * _BAND_STEP_M:
        return True
    return bool(plume.bands(r, srcs, u10=w.u10, cls=w.cls, pbl_m=w.pbl_m))


def site_plume(site_id: str, pts: Sequence[Point], w: Weather) -> SitePlume | None:
    """The site's outline under `w`, or None when the map draws no plume for it."""
    if not pts:
        return None
    srcs = [plume.Source(h, k) for _lon, _lat, h, k in pts]
    r = plume.reach(srcs, u10=w.u10, cls=w.cls, pbl_m=w.pbl_m)
    if not _drawn(r, srcs, w):
        return None
    origin = origin_of(pts)
    envelope = plume.DETECTION_ENVELOPE.get(w.cls, 1500.0)
    cls, u10 = w.cls, w.u10

    def width(x: Any) -> Any:
        return plume.half_width(x, cls, u10)

    frame = geo.plume_outline_frame(
        origin, w.dir_deg, [(p[0], p[1]) for p in pts], r.x_onset, r.x_reach, envelope, width
    )
    if frame is None:
        empty = np.zeros(0)
        return SitePlume(site_id, w, r, origin, envelope, None, empty, empty, empty, empty)
    lx = np.array([p[0] for p in frame.left])
    ly = np.array([p[1] for p in frame.left])
    rx = np.array([p[0] for p in frame.right])
    ry = np.array([p[1] for p in frame.right])
    return SitePlume(site_id, w, r, origin, envelope, frame, lx, ly, rx, ry)


def plumes_at(
    points: Mapping[str, Sequence[Point]], w: Weather
) -> dict[str, SitePlume]:
    """Every site's drawn plume under one hour's weather."""
    out: dict[str, SitePlume] = {}
    for sid, pts in points.items():
        sp = site_plume(sid, pts, w)
        if sp is not None:
            out[sid] = sp
    return out
