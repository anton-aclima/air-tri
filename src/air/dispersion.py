"""The dispersion kernel — one copy of the plume arithmetic, at package root.

WHY THIS MODULE IS WHERE IT IS
------------------------------
The same Briggs open-country Gaussian plume is needed in two places that must
never disagree: the generator, which writes the simulated ground truth
(`air.datagen.field.FieldModel._plume`), and the server, which draws the cone
an operator sees (`GET /wind/dispersion`). Before this module they were two
implementations — the truth field used sigma_z and buoyant rise, the drawn cone
used `(700 + 240 * speed) * reach_mult` — and they disagreed about reach by a
factor of forty under stable air. That gap is what made the drawn plume look
like a tiny blob no matter the weather.

Four names for one thing were proposed while designing this (`plume_kernel`,
`dispersion`, an extraction into `server/geo`, and "just reuse `field.py`").
Four names guarantee four implementations and guaranteed drift; the last one is
what the containment rule below exists to prevent. Package root is the only
place both callers can reach without one importing the other.

**This module imports neither `air.datagen` nor `air.server`, and there is a
test that says so** (`tests/test_dispersion_kernel.py`). It is pure arithmetic:
numpy and the standard library, no database, no config, no I/O.

CONTAINMENT (CONTRACT section 10d)
----------------------------------
Sharing the kernel between the generator and the server is deliberate, and it
means an import ban would be the wrong control. The rule is about data flow
instead:

    No value derived from evaluating this kernel at a receptor may be labelled
    measured, served under a touchdown path, or drawn in the measured
    register — whichever package computed it.

Everything here is a MODEL. Nothing here has ever been observed.

UNITS
-----
Distances are metres, angles are degrees, speeds are m/s. Concentrations are
DIMENSIONLESS — the kernel returns a per-unit-emission dispersion factor, and
each caller multiplies by its own coupling constant (`K_PT_NO2` and friends in
`field.py`) to reach a measure's real unit. Two numbers from this module are
comparable to each other; neither is comparable to a ppb.

CONVENTIONS
-----------
`transport_deg` / `axis_deg` is the direction the plume TRAVELS, which is the
meteorological `wind_from + 180`. Getting this backwards points every plume at
the wrong half of the map, so the kernel never takes a "wind direction" — only
an axis.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

SQRT2PI = math.sqrt(2.0 * math.pi)

# ── Briggs open-country dispersion coefficients, keyed by Pasquill class ──────
# sigma_y = ay * x * (1 + 1e-4 x)^-0.5 ; sigma_z per the class-specific form in
# `sigmas`. Moved verbatim from field.py — do not re-derive them, the whole
# simulation is calibrated against these exact numbers.
SIGY = {"A": 0.22, "B": 0.16, "C": 0.11, "D": 0.08, "E": 0.06, "F": 0.04}
WIND_EXP = {"A": 0.07, "B": 0.07, "C": 0.10, "D": 0.15, "E": 0.35, "F": 0.55}

# Virtual-source offset (m). Real plumes do not start as points: stack
# diameter, exit momentum and building downwash give an initial spread, so
# sigma is evaluated at (x + SIGMA_X0). Without it the near-field lobe is a few
# tens of metres wide and no road segment ever intersects it.
SIGMA_X0 = 115.0

# Campus-scale near field. A 1.1 km2 industrial site is an *area* source: 24
# turbine exhausts, on-site traffic, fugitive losses and building-wake
# recirculation blend into one campus plume within the first kilometre, which
# is how AERMOD treats a large facility. NEAR_Q sets the amplitude,
# NEAR_SIGMA_M its radius.
#
# NOTE for phase 2: this term is isotropic, so control passes drawn from
# 0.3-1 km of a source carry it and can invert the sign of a downwind-excess
# estimator. It is the mechanism behind the parameter sensitivity recorded in
# PLAN-plume.md, and P3-B changes how it is applied.
NEAR_Q = 1.00e-4
NEAR_SIGMA_M = 640.0

# Buoyant plume rise coefficient by emission-point kind: dh ~= COEF / u_stack.
RISE = {
    "generator": 58.0,
    "stack": 74.0,
    "backup": 22.0,
    "cooling_tower": 36.0,
    "traffic_gate": 0.0,
    "substation": 0.0,
}

# Relative emission rate by kind. A generator emits more than a traffic gate.
# Lives here rather than in the router because it scales the kernel's output
# and therefore has to be the same number wherever a plume is evaluated.
STRENGTH = {
    "generator": 1.0,
    "stack": 0.9,
    "backup": 0.8,
    "cooling_tower": 0.5,
    "traffic_gate": 0.45,
    "substation": 0.2,
}

# ── Pasquill validity ────────────────────────────────────────────────────────
# Upper wind-speed bound (m/s at 10 m) for each class. Above it the class is
# not defined and `coerce_class` steps toward neutral.
#
# READ THIS BEFORE QUOTING A NUMBER FROM A COERCED CLASS. "F at 6 m/s" was
# treated as a measured finding in four separate design documents and it is
# not one: across all 2,160 wind rows in this campaign F maxes at 2.98 m/s and
# E at 3.69. The state never occurs, so any reach computed from it is the
# formula evaluated on fabricated input. The guard is still worth having,
# because forecasts (phase 8) and a user dragging a slider in site config will
# genuinely produce it — but it is a guard against bad input, NOT an
# explanation for how big a plume is.
#
# These bounds are READ OFF `air.datagen.weather._pasquill`'s own lookup
# table, not off a textbook. That matters: the generator does not coerce, so
# any bound tighter than its table would make the drawn cone disagree with the
# simulated truth on real weather — which is the one thing this module exists
# to prevent. A first pass used the textbook figures (A<2, B<5, C<8) and
# silently rewrote the stability of six real campaign hours at the UNSTABLE
# end: A at 2.96 m/s, B at 5.32, C at 8.58 to 9.83. Widening a guard to fit
# the data would normally be suspect; here the generator's table IS the
# contract, and anything outside it genuinely did not come from this
# simulation.
#
#   speed bins in that table: <2 | 2-3 | 3-4.5 | 4.5-6 | >=6
#   A only in bins 0-1  -> u < 3      D in every bin        -> unbounded
#   B up to bin 3       -> u < 6      E in bins 0 and 2     -> u < 4.5
#   C from bin 2 up     -> unbounded  F only in bins 0-1    -> u < 3
CLASS_MAX_U10 = {"A": 3.0, "B": 6.0, "C": None, "D": None, "E": 4.5, "F": 3.0}
_TOWARD_NEUTRAL = {"A": "B", "B": "C", "C": "D", "E": "D", "F": "E"}

# How far out a measured claim can be supported at all, by class, in metres.
# PROVISIONAL — the phase-2 parameter sweep sets these for real. They bound the
# *reporting* register, not the physics: beyond this the model is still drawn,
# but per CONTRACT section 10b it is drawn dashed with no fill and the legend
# says "beyond measurement range - model only".
DETECTION_ENVELOPE = {"A": 1500.0, "B": 1500.0, "C": 1500.0, "D": 1500.0, "E": 4000.0, "F": 4000.0}

# Hard stop on how far a modelled plume is drawn. Under stable trapped air the
# ground-level profile decays as ~1/x and has no natural end — a floor-crossing
# search runs past 15 km. A 10 km cone from Ridgeline covers 96.7% of the road
# grid, at which point the picture stops being a plume and becomes a picture of
# the campaign boundary. Anything clipped here reports `truncated=True`.
MAX_REACH_M = 8000.0

# Absolute ground-level concentration, in the kernel's dimensionless units,
# below which a plume is not drawn. Absolute rather than a fraction of the
# plume's own peak, because that is what makes reach depend on HOW MUCH IS
# EMITTED: under a relative floor Ridgeline's substation would draw exactly as
# far as its six generators, and a four-point site exactly as far as a
# thirteen-point one.
#
# Calibrated against the three real sites. Site reach, metres, at this value:
#
#            B 2.5   C 4.5   D 3.5   E 2.0   F 1.5
#   Ridgeline  1880    2620    6940   8000*   8000*      13 sources
#   DeltaForge  940    1260    2760    6040   8000*       4 sources
#   Riverport   980    1340    3220   8000*   8000*       4 sources
#                                             (* clipped at MAX_REACH_M)
#
# Two things to read off that. Daytime is tight and stable air reaches across
# the whole monitored area — the spread the old endpoint's 3x could not
# express. And Ridgeline's plume is twice Delta Forge's because it emits more,
# which the old endpoint could not express at all.
DRAW_FLOOR = 1.0e-5

# The floor for EVALUATING THE TRUTH FIELD, which is a different job from
# deciding what to draw and needs a very different number.
#
# `field.py` multiplies this kernel by a coupling constant to reach a real
# unit: K_PT_NO2 = 1.95e5, so a dispersion factor of 1e-5 is 1.95 ppb of NO2 —
# nowhere near negligible, and `DRAW_FLOOR` is exactly there. At 1e-7 it is
# 0.02 ppb, comfortably under the noise the micro-scale layer adds anyway.
#
# Using the draw floor to size the truth window would clip the simulation's own
# plume at the point where it stops being worth colouring, which is roughly two
# orders of magnitude too early.
TRUTH_FLOOR = 1.0e-7

# Measured at that floor, for a 21 m generator, downwind extent in metres:
#
#            B 2.5   C 4.5   D 3.5   E 2.0   F 1.5
#   1e-5       400     550    1050       0       0   <- DRAW_FLOOR
#   1e-6      1850    2600    6800   16000   16000
#   1e-7      6850   12100   16000   16000   16000   <- TRUTH_FLOOR
#
# The raster is 11.8 km across, so at the truth floor the plume is material
# over ALL of it in every regime. That is why `field.py` evaluates the whole
# raster rather than a sub-window: there is no window to size, and the class of
# bug that produced "77% of segments have no simulated plume" cannot recur.

# Ground-level concentration, as a fraction of the plume's own peak, at which
# the plume counts as having arrived at the ground. Within a factor of two of
# its own worst is a defensible reading of "touchdown" and is far less jumpy
# than a fainter threshold, which slides hundreds of metres on a small change
# in stability.
TOUCHDOWN_FRAC = 0.5

# A plume counts as lofted when the ground AT the source sees less than this
# fraction of the plume's own worst ground-level concentration.
#
# Deliberately scale-free — a ratio, not a distance and not a threshold on
# `DRAW_FLOOR`. The first attempt used "clears the draw floor more than 150 m
# out", which made loftedness depend on how bright the plume was: Delta
# Forge's two 34 m stacks came back aloft in daytime B purely because a floor
# calibrated for whole sites is above one stack's whole profile. Whether a
# plume is overhead at the fence is a property of its shape.
LOFT_RATIO = 0.10


def sigmas(x, cls: str):
    """(sigma_y, sigma_z) in metres at downwind distance `x`, already offset.

    Scalar or numpy array. Callers pass `x + SIGMA_X0`, not the raw distance.
    Verbatim from `FieldModel._sigmas` — the class-specific sigma_z forms are
    the calibration surface of the whole simulation.
    """
    x = np.asarray(x, dtype=float)
    sy = SIGY[cls] * x / np.sqrt(1.0 + 1e-4 * x)
    if cls == "A":
        sz = 0.20 * x
    elif cls == "B":
        sz = 0.12 * x
    elif cls == "C":
        sz = 0.08 * x / np.sqrt(1.0 + 2e-4 * x)
    elif cls == "D":
        sz = 0.06 * x / np.sqrt(1.0 + 1.5e-3 * x)
    elif cls == "E":
        sz = 0.03 * x / (1.0 + 3e-4 * x)
    else:
        sz = 0.016 * x / (1.0 + 3e-4 * x)
    return np.maximum(sy, 1.0), np.maximum(sz, 1.0)


def stack_wind(u10: float, height_m: float, cls: str) -> float:
    """Wind speed at release height, from the 10 m value by the power law."""
    return max(0.6, u10 * (max(height_m, 4.0) / 10.0) ** WIND_EXP[cls])


def effective_height(height_m: float, kind: str, u_stack: float) -> float:
    """Release height plus buoyant rise. The floor keeps ground sources sane."""
    return max(2.5, height_m + RISE.get(kind, 0.0) / u_stack)


def meander_factor(u10: float) -> float:
    """Extra lateral spread when the air is calm and the axis wanders."""
    return 1.0 + 1.7 / max(0.8, u10)


def coerce_class(cls: str, u10: float) -> tuple[str, str | None]:
    """Step an out-of-range Pasquill class toward neutral. Returns (class, note).

    `note` is None when nothing changed. When it is not None the caller MUST
    surface it — a silently substituted stability class turns a fabricated
    input into a confident-looking plume. Read `CLASS_MAX_U10` before using the
    result in any narrative.
    """
    cls = (cls or "D").upper()
    if cls not in SIGY:
        return "D", f"unknown stability class {cls!r}; used D"
    original = cls
    for _ in range(len(SIGY)):
        limit = CLASS_MAX_U10[cls]
        if limit is None or u10 <= limit:
            break
        nxt = _TOWARD_NEUTRAL.get(cls)
        if nxt is None:
            break
        cls = nxt
    if cls == original:
        return cls, None
    return cls, (
        f"Pasquill {original} is not defined above {CLASS_MAX_U10[original]:.0f} m/s; "
        f"at {u10:.1f} m/s the plume is drawn as {cls}"
    )


def ground_axis(
    x,
    *,
    height_m: float,
    kind: str,
    u10: float,
    cls: str,
    pbl_m: float,
    strength: float = 1.0,
):
    """Ground-level concentration on the plume centreline at downwind `x`.

    This is `FieldModel._plume`'s expression evaluated at cross-wind zero, so
    the drawn cone and the truth field are reading the same profile. It does
    NOT include the isotropic near-field term: that is a separate campus-scale
    source, not part of the cone, and adding it here would put a bright band
    at the stack of every lofted plume — the exact artefact P1-C removes.

    The shape is the point. A ground-level release peaks at the source and
    falls away. A lofted release is near zero at the stack, rises to a maximum
    one to five kilometres downwind as sigma_z grows to meet the effective
    height, then decays. `reach` reads those features off this curve.
    """
    x = np.asarray(x, dtype=float)
    u = stack_wind(u10, height_m, cls)
    h_eff = effective_height(height_m, kind, u)
    pos = np.maximum(x, 6.0) + SIGMA_X0
    sy, sz = sigmas(pos, cls)
    sy = sy * meander_factor(u10)
    vert = 2.0 * np.exp(-(h_eff**2) / (2.0 * sz**2)) / (SQRT2PI * sz)
    # Boundary-layer trapping: once sigma_z outgrows the mixed layer the plume
    # is uniform through it, which is the floor rather than the Gaussian tail.
    vert = np.maximum(vert, np.where(sz > 0.8 * pbl_m, 1.0 / pbl_m, 0.0))
    return strength * vert / (SQRT2PI * sy * u)


def half_width(x, cls: str, u10: float, n_sigma: float = 2.0):
    """Crosswind half-width of the visible plume at downwind distance `x`.

    `n_sigma` sigma_y, with the same meander widening and virtual-source offset
    the truth field uses. Slightly sub-linear in x, so the drawn edge is a
    shallow curve rather than a straight-sided cone — which is what a plume
    actually looks like.
    """
    x = np.asarray(x, dtype=float)
    sy, _sz = sigmas(np.maximum(x, 6.0) + SIGMA_X0, cls)
    return n_sigma * sy * meander_factor(u10)


@dataclass(frozen=True)
class Source:
    """One release point, as the kernel sees it. No position — the profile is
    along the transport axis and a site's points are co-located at this scale.
    """

    height_m: float
    kind: str
    strength: float | None = None

    def emission(self) -> float:
        return STRENGTH.get(self.kind, 0.6) if self.strength is None else self.strength


def profile(x, sources: Sequence[Source], *, u10: float, cls: str, pbl_m: float):
    """Combined ground-level centreline concentration for several sources.

    Sources add. A site is a cluster of releases a few hundred metres apart
    being read at one to eight kilometres, so treating them as co-located
    along the axis is the same approximation AERMOD makes for a large
    facility, and it is the only way the drawn contour is a contour OF
    ANYTHING — one polygon per site needs one profile per site.
    """
    x = np.asarray(x, dtype=float)
    total = np.zeros_like(x)
    for s in sources:
        total = total + ground_axis(
            x,
            height_m=s.height_m,
            kind=s.kind,
            u10=u10,
            cls=cls,
            pbl_m=pbl_m,
            strength=s.emission(),
        )
    return total


@dataclass(frozen=True)
class Reach:
    """Where a plume reaches the ground, and where it stops mattering.

    All distances are metres downwind of the source along the transport axis.

    x_onset      first distance at which ground-level concentration clears
                 `DRAW_FLOOR`. This is the DRAWN plume's inner edge; the gap
                 between the source and here is the aloft segment, where the
                 plume is overhead and the ground is clean.
    x_touchdown  first distance at which it reaches `TOUCHDOWN_FRAC` of its
                 peak — where the plume arrives, as opposed to where it first
                 registers. None when it never gets there inside `MAX_REACH_M`.
    x_peak       distance of maximum ground-level concentration.
    x_reach      distance at which it falls back below `DRAW_FLOOR`.
    peak         that maximum, in the kernel's dimensionless units.
    lofted       True when the ground AT the source sees less than
                 `LOFT_RATIO` of this plume's own peak — the plume is overhead
                 at the fence and comes down somewhere else. Scale-free, so it
                 does not move when `floor` does.
    truncated    True when the profile was still above the floor at
                 `MAX_REACH_M`, so `x_reach` is a clip, not a crossing.
    faint        True when the profile never clears `DRAW_FLOOR` at all — a
                 tall stack in very stable air whose plume never touches down
                 inside the domain. There is nothing dishonest to draw.
    """

    x_onset: float
    x_touchdown: float | None
    x_peak: float
    x_reach: float
    peak: float
    lofted: bool
    truncated: bool
    faint: bool


def reach(
    sources: Sequence[Source],
    *,
    u10: float,
    cls: str,
    pbl_m: float,
    floor: float = DRAW_FLOOR,
    max_m: float = MAX_REACH_M,
    step_m: float = 20.0,
) -> Reach:
    """Read the reach features off the combined ground-level profile.

    Pass one source for one stack, or a site's whole list for the site's
    plume. `Source.strength` defaults to `STRENGTH[kind]`; set it to model a
    source at part load, or to 1.0 for the per-unit-emission shape.

    A caveat that matters for what you do with the result: a site's combined
    profile PEAKS AT THE FENCE whenever the site has any ground-level release,
    because a traffic gate at 3 m beats a 21 m generator at zero distance by
    two orders of magnitude. So `x_peak` and `lofted` on a whole site describe
    the gate, not the story. For "where does the stack's plume touch down",
    pass only the elevated sources — `/wind/dispersion` does exactly that.

    Deviation from the plan, recorded rather than hidden: the design listed
    both `reach()` and `plume_reach()`. They were one function under two
    names, which is the exact failure mode this module exists to prevent, so
    there is only this one.
    """
    if not sources:
        return Reach(0.0, None, 0.0, 0.0, 0.0, lofted=False, truncated=False, faint=True)
    xs = np.arange(0.0, max_m + step_m, step_m)
    c = profile(xs, sources, u10=u10, cls=cls, pbl_m=pbl_m)
    i_peak = int(np.argmax(c))
    peak = float(c[i_peak])
    x_peak = float(xs[i_peak])

    above = np.flatnonzero(c >= floor)
    if above.size == 0:
        # Nothing clears the floor anywhere. A tall stack in very stable air:
        # sigma_z asymptotes below the effective height, so the plume never
        # touches down inside the domain at all. There is no honest cone here.
        lofted = bool(peak > 0.0 and c[0] < LOFT_RATIO * peak)
        return Reach(0.0, None, x_peak, 0.0, peak, lofted=lofted, truncated=False, faint=True)

    x_onset = float(xs[above[0]])
    x_reach = float(xs[above[-1]])
    truncated = bool(above[-1] == len(xs) - 1)

    # Touchdown is searched from the drawn edge outward, never before it. A
    # weak plume can cross half its own (small) peak while still below the
    # draw floor, which reported a touchdown 900 m INSIDE the onset.
    hi = np.flatnonzero((xs >= x_onset) & (c >= TOUCHDOWN_FRAC * peak))
    x_touchdown = float(xs[hi[0]]) if hi.size else None
    lofted = bool(peak > 0.0 and c[0] < LOFT_RATIO * peak)
    return Reach(x_onset, x_touchdown, x_peak, x_reach, peak, lofted, truncated, faint=False)


def bands(
    r: Reach,
    sources: Sequence[Source],
    *,
    u10: float,
    cls: str,
    pbl_m: float,
    step_m: float = 20.0,
) -> list[tuple[int, float, float, float]]:
    """Concentration contours as [(band, r0_m, r1_m, level), ...], brightest first.

    THE FIX THIS FUNCTION IS. The old endpoint split reach into three fixed
    radial slices, 4-34%, 34-66%, 66-100%, and put the brightest band at the
    stack. For a lofted source that is backwards: ground-level concentration at
    the stack is near zero and the maximum is one to five kilometres out. Here
    the bands are contours of the actual profile, so band 0 straddles the peak
    wherever the peak happens to be, and the unfilled gap between the source
    and `x_touchdown` IS the aloft segment — the plume is overhead there and
    the ground is clean, which is a fact worth being able to see.

    The drawn extent is exactly {x : c(x) >= DRAW_FLOOR}, so the bands cover
    everything worth drawing and nothing else. Their interior edges are the two
    geometric means between the peak and the concentration at the far edge —
    equal steps in log concentration, the ordinary choice for a contour set.
    Fixed fractions of the peak do not work here: under stable trapped air the
    profile decays as ~1/x and is still above half its peak at 8 km, so
    `(0.5, 0.2)` collapsed all three bands into one.

    `level` is the band's own contour value as a fraction of this plume's peak
    — the geometric mean of the two contours bounding it — so it is 0-1 and
    falls strictly outward. The absolute value lives on `Reach.peak`; a
    dimensionless dispersion factor is not a concentration and must not be
    printed as one.

    Labelling a band by the MEAN concentration inside it is the obvious
    alternative and it is not monotone: `np.maximum(vert, trapped)` in
    `ground_axis` steps the profile UP discontinuously where sigma_z outgrows
    the mixed layer, so under D at 0.6 m/s with a 90 m boundary layer band 1
    came out brighter than band 0. That step is faithful to the truth field's
    trapping model and P3 revisits it; a contour band should be labelled by its
    contour regardless.
    """
    if r.faint or r.x_reach <= r.x_onset or not sources:
        return []
    xs = np.arange(r.x_onset, r.x_reach + step_m, step_m)
    c = profile(xs, sources, u10=u10, cls=cls, pbl_m=pbl_m)
    peak = max(r.peak, 1e-300)
    tail = max(float(c[-1]), 1e-300)

    ratio = min(tail / peak, 1.0)
    edges = [r.x_onset]
    for k in (1, 2):
        level = peak * ratio ** (k / 3.0)
        # First crossing BELOW this level on the far side of the peak.
        beyond = np.flatnonzero((xs > r.x_peak) & (c < level))
        edges.append(float(xs[beyond[0]]) if beyond.size else r.x_reach)
    edges.append(r.x_reach)
    edges = [min(max(e, r.x_onset), r.x_reach) for e in edges]
    for i in range(1, len(edges)):
        edges[i] = max(edges[i], edges[i - 1])

    fracs = [ratio ** (k / 3.0) for k in range(4)]
    out: list[tuple[int, float, float, float]] = []
    for i in range(3):
        a, b = edges[i], edges[i + 1]
        if b - a < step_m:
            continue
        out.append((i, a, b, round(math.sqrt(fracs[i] * fracs[i + 1]), 4)))
    return out


def cone_mask(
    dx,
    dy,
    axis_deg: float,
    *,
    x_min: float,
    x_max: float,
    cls: str,
    u10: float,
    n_sigma: float = 2.0,
):
    """Which receptors are inside the plume sector? Vectorised.

    `dx`, `dy` are METRES east and north of the source — not lon/lat. Geodesy
    belongs to the caller: keeping it out is what lets this module stay free of
    `air.server.geo`, and the sector gate is the same arithmetic whether the
    caller projected with haversine or with a local grid.

    The half-width comes from sigma_y at that distance rather than a fixed
    angle, so the sector narrows with stability exactly as the drawn cone does.

    This is the vectorised form because the regulator's residency surface is
    1,307 segments x 2,160 hours x 3 sites and a scalar call per receptor is
    not a realistic way to compute it. `point_in_cone` below is the scalar
    convenience and calls straight into this, so there is one implementation
    rather than two that drift.
    """
    th = math.radians(axis_deg)
    ux, uy = math.sin(th), math.cos(th)
    dx = np.asarray(dx, dtype=float)
    dy = np.asarray(dy, dtype=float)
    along = dx * ux + dy * uy
    cross = -dx * uy + dy * ux
    inside = (along >= x_min) & (along <= x_max)
    # half_width is only meaningful for positive downwind distance; clamp so a
    # receptor behind the source cannot pass on a wide near-source sector.
    width = half_width(np.maximum(along, 1.0), cls, u10, n_sigma)
    return inside & (np.abs(cross) <= width)


def point_in_cone(
    dx: float,
    dy: float,
    axis_deg: float,
    *,
    x_min: float,
    x_max: float,
    cls: str,
    u10: float,
    n_sigma: float = 2.0,
) -> bool:
    """Is one receptor inside the plume sector? See `cone_mask`."""
    return bool(
        cone_mask(dx, dy, axis_deg, x_min=x_min, x_max=x_max, cls=cls, u10=u10, n_sigma=n_sigma)
    )
