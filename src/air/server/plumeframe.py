"""One hour's forecast plume, as geometry a route can be tested against.

The Mission Brief needs to answer one question per road segment per hour:
**which side of the source is this street on, if the forecast is right?** That
is a property of geometry and wind, so it is computed here at analysis time
and never stored. A `segment_pass.stratum` column would freeze one bearing
assumption into 200k rows and become a second source of truth the moment the
forecast is re-issued — and the brief is re-issued every morning.

Three strata, each named for the question that leg of a route answers:

    downwind    inside the forecast corridor, onset to reach.
                "Is the site's plume here?"
    upwind      the mirror sector on the far side of the source, 0.5-4 km.
                "What is the air bringing in before it reaches the site?"
                The data science team's requirement, and the only leg that
                lets a downwind reading mean anything: without it a source and
                a pass-over are indistinguishable.
    background  everything else. Coverage, and the crosswind pool.

EVERYTHING HERE IS MODELLED
---------------------------
A frame is a forecast plume from `air.dispersion` widened by the forecast's
MEASURED direction error. It is drawn as an outline (CONTRACT section 10b) and
nothing in this module is a concentration: `reach` supplies distances and
`half_width` supplies an angle, which is geometry, not a value at a receptor
(section 10d).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

import numpy as np

from air import dispersion
from air.server import geo

#: The upwind leg is sought close in. Beyond four kilometres "upwind of the
#: site" is mostly "upwind of somewhere else", and the comparison stops being
#: about this source.
UPWIND_LO_M = 500.0
UPWIND_HI_M = 4000.0

#: The upwind sector never narrows below this. At lead 0 the forecast has no
#: error spread and a stable plume is a few degrees wide, which would leave the
#: control leg a sliver no driver could be dispatched to.
UPWIND_MIN_HALF_DEG = 20.0

#: Nor does it widen past this. At five days the corridor is a 159-degree
#: sector; its mirror would cover half the map and "upwind" would mean nothing.
UPWIND_MAX_HALF_DEG = 45.0

#: Nothing inside this counts as downwind. A site's combined profile peaks at
#: the fence (the traffic gate beats the stacks at zero range — see
#: `dispersion.reach`), and the fence line is the operator's own ground.
DOWNWIND_MIN_M = 300.0

STRATA = ("downwind", "upwind", "background")


class _HourLike(Protocol):
    lead_h: int
    valid_at: str
    dir_deg: float
    dir_sd_deg: float
    speed_ms: float
    stability: str
    pbl_m: float
    beyond_crossover: bool


@dataclass(frozen=True)
class Frame:
    """The forecast plume from one site for one hour."""

    site_id: str
    origin: tuple[float, float]
    lead_h: int
    valid_at: str
    #: Direction the plume travels TOWARD, degrees true. The wind's `dir_deg`
    #: is where it comes FROM; every screen that has confused the two drew the
    #: plume on the wrong side of the site.
    axis_deg: float
    #: Two sigma of the forecast's measured direction error plus the plume's
    #: own half-width at reach. What a route is tested against.
    half_angle_deg: float
    #: The plume's own half-width alone, without forecast error.
    plume_half_deg: float
    x_onset_m: float
    x_reach_m: float
    stability: str
    dir_sd_deg: float
    beyond_crossover: bool
    #: Nothing clears the draw floor this hour — a lofted or dispersed plume.
    #: A faint frame puts every segment in `background`.
    faint: bool


@lru_cache(maxsize=4096)
def _extent(sources: tuple, u10: float, cls: str, pbl_m: float) -> tuple[float, float, bool]:
    srcs = [dispersion.Source(h, k) for h, k in sources]
    r = dispersion.reach(srcs, u10=u10, cls=cls, pbl_m=pbl_m)
    return (r.x_onset, r.x_reach, bool(r.faint))


def half_angle(x_reach: float, cls: str, u10: float, dir_sd_deg: float) -> tuple[float, float]:
    """(corridor half-angle, plume half-angle), degrees.

    The one formula for how wide a forecast plume is drawn. `forecast.corridor`
    calls this too, so the corridor on the forecast endpoint and the corridor a
    route is tested against cannot drift apart.
    """
    x = max(float(x_reach), 1.0)
    plume = math.degrees(math.atan2(float(dispersion.half_width(x, cls, u10)), x))
    return 2.0 * dir_sd_deg + plume, plume


def frame(site_id: str, origin: tuple[float, float], sources: list[dispersion.Source],
          h: _HourLike) -> Frame:
    key = tuple((round(s.height_m, 1), s.kind) for s in sources)
    onset, reach, faint = _extent(key, round(h.speed_ms, 1), h.stability, round(h.pbl_m, -1))
    faint = faint or not sources
    full, plume = half_angle(reach, h.stability, h.speed_ms, h.dir_sd_deg)
    return Frame(
        site_id=site_id, origin=origin, lead_h=int(h.lead_h), valid_at=h.valid_at,
        axis_deg=(h.dir_deg + 180.0) % 360.0,
        half_angle_deg=round(min(full, 89.0), 1), plume_half_deg=round(plume, 1),
        x_onset_m=round(onset, 1), x_reach_m=round(reach, 1),
        stability=h.stability, dir_sd_deg=h.dir_sd_deg,
        beyond_crossover=bool(h.beyond_crossover), faint=faint,
    )


def _off(bearing: np.ndarray, axis: float) -> np.ndarray:
    """Unsigned angular distance, wrap-safe."""
    return np.abs((bearing - axis + 180.0) % 360.0 - 180.0)


def upwind_half(f: Frame) -> float:
    return float(min(UPWIND_MAX_HALF_DEG, max(UPWIND_MIN_HALF_DEG, f.half_angle_deg)))


def strata(f: Frame, dist_m: np.ndarray, bearing_deg: np.ndarray) -> np.ndarray:
    """Stratum per segment, as an int array indexing `STRATA`.

    `dist_m` and `bearing_deg` are from the frame's origin to each segment's
    midpoint.
    """
    out = np.full(dist_m.shape, 2, dtype=np.int8)
    if f.faint:
        return out
    off = _off(bearing_deg, f.axis_deg)
    lo = max(DOWNWIND_MIN_M, f.x_onset_m)
    down = (dist_m >= lo) & (dist_m <= f.x_reach_m) & (off <= f.half_angle_deg)
    up = ((dist_m >= UPWIND_LO_M) & (dist_m <= UPWIND_HI_M)
          & (off >= 180.0 - upwind_half(f)) & ~down)
    out[down] = 0
    out[up] = 1
    return out


def sector_ring(origin: tuple[float, float], axis_deg: float, half_deg: float,
                r0: float, r1: float, steps: int = 16) -> list[list[float]]:
    """A closed annular-sector ring, [[lon, lat], ...]. For drawing only."""
    lon, lat = origin
    arc = [axis_deg - half_deg + 2 * half_deg * i / steps for i in range(steps + 1)]
    outer = [geo.destination(lon, lat, b, r1) for b in arc]
    inner = [geo.destination(lon, lat, b, max(r0, 1.0)) for b in reversed(arc)]
    ring = [[round(x, 5), round(y, 5)] for x, y in outer + inner]
    return ring + [ring[0]]


def frame_shape(f: Frame) -> dict[str, Any]:
    """A frame as the wire carries it: the numbers plus its outline."""
    return {
        "lead_h": f.lead_h,
        "valid_at": f.valid_at,
        "axis_deg": round(f.axis_deg, 1),
        "half_angle_deg": f.half_angle_deg,
        "x_onset_m": f.x_onset_m,
        "x_reach_m": f.x_reach_m,
        "stability": f.stability,
        "dir_sd_deg": f.dir_sd_deg,
        "beyond_crossover": f.beyond_crossover,
        "ring": None if f.faint else sector_ring(
            f.origin, f.axis_deg, f.half_angle_deg,
            max(DOWNWIND_MIN_M, f.x_onset_m), f.x_reach_m,
        ),
    }
