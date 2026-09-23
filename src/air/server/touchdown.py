"""Where the fleet actually found a site's plume — and where we simply do not know.

This is the MEASURED answer. `/wind/dispersion` is the modelled one. Per
CONTRACT section 10b they are drawn in different registers and must never be
confused; per 10d, no value in this module may come from evaluating a
dispersion kernel at a receptor, and none does — the only thing borrowed from
`air.dispersion` is the crosswind half-width that defines the transport sector,
which is geometry, not concentration.

WHAT THIS IS AND IS NOT
-----------------------
**The touchdown is a SITE-LEVEL POOLED claim.** That is not a preference, it is
what the data supports. Measured under this configuration: 94 of 1,307 segments
are ever downwind of Ridgeline in stable air, and ZERO accumulate 12
conditioned passes on both sides; only 7 reach 5. So per-segment geometry is
**evidence display** — here is the road the plume crossed, here is how many
times we drove it — and never a verdict. The verdict lives on the roll-up.

THE ESTIMATOR
-------------
Same-hour paired difference. For each hour with both kinds of pass,

    delta_h = mean(downwind anomaly) - mean(control anomaly)

computed per road class and recombined weighted by downwind count; the reported
excess is the unweighted mean of `delta_h` over hours with a t interval on
those hourly values. Anomaly means the pass minus its own segment's campaign
median, so a street is compared against itself.

None of that is configurable. Every constant below was chosen in phase 2 from a
64-cell sweep, by naming the mechanism that makes the alternatives wrong, and
is pinned by `tests/fixtures/touchdown_frozen.json`. The sweep table is in
`docs/PLAN-plume.md`. Read it before changing a number here: the same site,
hours and measure reads +5.09 ppb or -19.23 ppb depending only on where the
control pool starts, and the -19.23 passes the placebo gate.
"""

from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from air import dispersion
from air.server import cache

R_EARTH = 6371008.8

# ── the frozen configuration (phase 2, P2-D) ─────────────────────────────────

#: Metres. Control passes must be at least this far from the source. It is
#: 2.3x `dispersion.NEAR_SIGMA_M`, the radius of the isotropic campus near
#: field, so a control pass carries less than e^-2.7 of it. Controls drawn from
#: 300 m carry that term and INVERT the contrast.
CONTROL_INNER_M = 1500.0

#: Multiples of sigma_y for the transport sector, and how many sector widths
#: off-axis a control pass has to be. A fixed 30-degree wedge is about four
#: times too wide under stable air and also eats its own control pool.
N_SIGMA = 2.0
CONTROL_EXCLUDE_MULT = 2.0

#: Metres. A segment this close to ANOTHER site's emission points is dropped:
#: three sites inside one 12 km box otherwise contaminate each other.
COLOCATED_M = 800.0

#: Conditioned sample minima. Measured sensitivity across 1/2/3/5 downwind and
#: 3/5/8 control: Ridgeline moves +5.41 -> +4.96, so the finding is not resting
#: on thin hours. The control minimum changes nothing at any value tried.
MIN_DOWNWIND_PER_HOUR = 3
MIN_CONTROL_PER_HOUR = 8
MIN_HOURS = 8

#: Smallest |excess| callable a detection, per measure, in that measure's unit.
#: Twice the worst site's 95th percentile of |excess| over 14 fabricated
#: transport bearings. Re-calibrated after the P3 rebuild.
DETECT_FLOOR = {"no2": 3.28, "pm25": 3.60}

#: A stratum whose fabricated-bearing placebo comes within this fraction of its
#: true-bearing magnitude is not a detection.
PLACEBO_MAX_RATIO = 0.5

#: Rotations used for the placebo. Three, as the acceptance criterion says.
PLACEBO_DEG = (90.0, 180.0, 270.0)

#: Default stability classes. The touchdown is a stable-air phenomenon; under
#: unstable daytime air the plume mixes to the ground at the fence and there is
#: no downwind contrast to find.
DEFAULT_REGIME = "EF"
DEFAULT_R_LO_M = 1500.0
DEFAULT_R_HI_M = 4000.0

#: Per-segment evidence needs both sides. Five clear passes is the level at
#: which any segment at any site reaches double figures; twelve is reachable by
#: none of them.
SEG_MIN_PASSES = 5

STATES = (
    "elevated_downwind",   # excess above the floor, placebo cleared
    "contested",           # an estimate exists but a fabricated bearing matches it
    "no_detection",        # measured, and inside the noise
    "insufficient_passes",  # driven, but not enough conditioned passes to say
    "not_measured",        # never driven downwind of this site in this regime
)


# ── shapes ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SegmentEvidence:
    """One road segment's contribution. EVIDENCE, never a verdict."""

    segment_id: str
    n_downwind: int
    n_control: int
    #: 'self' when the segment supplied its own control passes, 'class' when
    #: they came from same-class roads elsewhere, None when there are none.
    control_kind: str | None
    excess: float | None
    ci_lo: float | None
    ci_hi: float | None
    #: Share of this segment's downwind passes on which it was downwind of THIS
    #: site and no other. Attribution qualifier: a segment downwind of two
    #: sites at once cannot separate them.
    exclusive_share: float
    placebo_ratio: float | None
    state: str
    distance_m: float
    bearing_deg: float


@dataclass(frozen=True)
class PolarBin:
    """One (sector, ring) cell of the roll-up. Never smoothed into a hull."""

    sector_deg: float
    ring_lo_m: float
    ring_hi_m: float
    n_downwind: int
    n_control: int
    excess: float | None
    state: str


@dataclass(frozen=True)
class Touchdown:
    """The site-level pooled result — the only thing here that is a verdict."""

    site_id: str
    measure: str
    regime: str
    excess: float | None
    ci_lo: float | None
    ci_hi: float | None
    n_hours: int
    n_downwind: int
    n_control: int
    placebo_max: float | None
    placebo_ratio: float | None
    detect_floor: float | None
    state: str
    n_supported_segments: int
    n_distinct_roads: int
    coverage_pct: float
    source_lon: float
    source_lat: float
    r_lo_m: float
    r_hi_m: float
    segments: list[SegmentEvidence] = field(default_factory=list)
    polar: list[PolarBin] = field(default_factory=list)
    districts: list[dict[str, Any]] = field(default_factory=list)


# ── loading ──────────────────────────────────────────────────────────────────


def _haversine(lon1, lat1, lon2, lat2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dphi, dlam = p2 - p1, np.radians(lon2 - lon1)
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlam / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.minimum(1.0, np.sqrt(a)))


def _bearing(lon1, lat1, lon2, lat2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dlam = np.radians(lon2 - lon1)
    y = np.sin(dlam) * np.cos(p2)
    x = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dlam)
    # Normalised so due north is 0, never 360: arctan2 returns a tiny
    # NEGATIVE for a northward bearing, and both `x % 360` and
    # `(x + 360) % 360` return 360.0 for one. Latent here — these feed
    # wrap-safe angular differences — but it is the same landmine that
    # `forecast._norm_bearing` exists for.
    out = np.mod(np.degrees(np.arctan2(y, x)), 360.0)
    return np.where(out >= 360.0 - 1e-9, 0.0, out)


class _Passes:
    """Every pass, projected once, so a request is numpy masking.

    Reads `road_segment`, `segment_pass`, `wind` and `emission_point`. It does
    NOT read `segment_stat` — those are aggregates computed from uniform passes
    with their own rules, and mixing the two would make the estimator depend on
    a statistic rather than on measurements.
    """

    def __init__(self, conn: sqlite3.Connection, campaign_id: str, measure: str):
        segs = conn.execute(
            "SELECT id, name, road_class, district, length_m, mid_lon, mid_lat "
            "FROM road_segment WHERE campaign_id=? ORDER BY id",
            (campaign_id,),
        ).fetchall()
        self.seg_ids = [r[0] for r in segs]
        self.seg_name = [r[1] for r in segs]
        self.seg_district = [r[3] for r in segs]
        self.seg_len = np.array([r[4] or 0.0 for r in segs])
        self.seg_lon = np.array([r[5] for r in segs])
        self.seg_lat = np.array([r[6] for r in segs])
        index = {sid: i for i, sid in enumerate(self.seg_ids)}
        classes = sorted({(r[2] or "unknown") for r in segs})
        cidx = {c: i for i, c in enumerate(classes)}
        self.seg_class = np.array([cidx[r[2] or "unknown"] for r in segs])

        # Emission-weighted centroid per site, so toggling a stack in site
        # config moves the thing the estimator is aimed at.
        acc: dict[str, list[float]] = {}
        self.site_points: dict[str, list[tuple[float, float]]] = {}
        for sid, kind, lon, lat in conn.execute(
            "SELECT e.site_id, e.kind, e.lon, e.lat FROM emission_point e "
            "JOIN industry_site s ON s.id = e.site_id "
            "WHERE e.active = 1 AND s.campaign_id = ?",
            (campaign_id,),
        ):
            w = dispersion.STRENGTH.get(kind, 0.6)
            self.site_points.setdefault(sid, []).append((lon, lat))
            a = acc.setdefault(sid, [0.0, 0.0, 0.0])
            a[0] += w * lon
            a[1] += w * lat
            a[2] += w
        self.sites = {k: (v[0] / v[2], v[1] / v[2]) for k, v in acc.items() if v[2] > 0}

        wind = conn.execute(
            "SELECT ts, speed_ms, dir_deg, stability FROM wind WHERE campaign_id=?",
            (campaign_id,),
        ).fetchall()
        by_hour = {r[0][:13]: r for r in wind}

        raw = conn.execute(
            f"SELECT segment_id, ts, {measure} FROM segment_pass "  # noqa: S608 - column is validated by the caller
            "WHERE campaign_id=? ORDER BY ts",
            (campaign_id,),
        ).fetchall()
        keep = [r for r in raw if r[2] is not None and r[0] in index and r[1][:13] in by_hour]

        self.n = len(keep)
        self.pass_seg = np.array([index[r[0]] for r in keep], dtype=np.int32)
        self.pass_ts = [r[1] for r in keep]
        self.value = np.array([r[2] for r in keep], dtype=float)
        hours = sorted({r[1][:13] for r in keep})
        hidx = {h: i for i, h in enumerate(hours)}
        self.hours = hours
        self.pass_hour = np.array([hidx[r[1][:13]] for r in keep], dtype=np.int32)
        self.hour_speed = np.array([by_hour[h][1] for h in hours])
        self.hour_transport = np.array([(by_hour[h][2] + 180.0) % 360.0 for h in hours])
        self.hour_class = np.array([by_hour[h][3] for h in hours])

        # Anomaly: each pass against its own segment's campaign median, so a
        # street is compared against itself and composition drops out.
        med = np.full(len(segs), np.nan)
        order = np.argsort(self.pass_seg, kind="stable")
        s_sorted, v_sorted = self.pass_seg[order], self.value[order]
        bounds = np.searchsorted(s_sorted, np.arange(len(segs) + 1))
        for i in range(len(segs)):
            chunk = v_sorted[bounds[i]:bounds[i + 1]]
            if chunk.size:
                med[i] = np.median(chunk)
        self.seg_median = med
        self.anomaly = self.value - med[self.pass_seg]

        self.dist = {s: _haversine(lo, la, self.seg_lon, self.seg_lat) for s, (lo, la) in self.sites.items()}
        self.brg = {s: _bearing(lo, la, self.seg_lon, self.seg_lat) for s, (lo, la) in self.sites.items()}
        self.near_other = {}
        for sid in self.sites:
            best = np.full(len(segs), np.inf)
            for other, pts in self.site_points.items():
                if other == sid:
                    continue
                for lon, lat in pts:
                    best = np.minimum(best, _haversine(lon, lat, self.seg_lon, self.seg_lat))
            self.near_other[sid] = best


def load(conn: sqlite3.Connection, campaign_id: str, measure: str) -> _Passes:
    """Cached per (database, campaign, measure, cache version).

    The database path is part of the key, and it has to be. The server only
    ever has one, but the multi-seed checks open four in a row and they all
    carry the same `campaign_id` — so a key without the path returned the first
    database's passes for all four, and the seed sweep came back byte-identical
    with "x1.00 across four seeds", which is exactly what a seed sweep that is
    not working looks like.
    """
    key = ("touchdown_passes", _db_path(conn), campaign_id, measure, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, _Passes(conn, campaign_id, measure))


def _db_path(conn: sqlite3.Connection) -> str:
    row = conn.execute("PRAGMA database_list").fetchone()
    return str(row[2]) if row else ""


# ── the estimator ────────────────────────────────────────────────────────────


def _sector_half_deg(p: _Passes, d: np.ndarray) -> np.ndarray:
    """Half-angle of the transport sector, per pass, from the kernel's sigma_y.

    Geometry only — a width, never a concentration — so this does not put the
    kernel on the measured side of CONTRACT section 10d.
    """
    d = np.maximum(d, 1.0)
    cls = p.hour_class[p.pass_hour]
    u10 = p.hour_speed[p.pass_hour]
    out = np.empty(d.shape)
    for c in np.unique(cls):
        m = cls == c
        w = np.asarray(dispersion.half_width(d[m], str(c), float(np.median(u10[m])), N_SIGMA))
        out[m] = np.degrees(np.arctan2(w, d[m]))
    return out


def _masks(p: _Passes, site: str, *, r_lo: float, r_hi: float, regime: str,
           from_: str | None, to: str | None, rotate_deg: float = 0.0):
    d = p.dist[site][p.pass_seg]
    b = p.brg[site][p.pass_seg]
    ok = np.isin(p.hour_class[p.pass_hour], list(regime))
    ok &= p.near_other[site][p.pass_seg] >= COLOCATED_M
    ok &= np.isfinite(p.anomaly)
    if from_ or to:
        ts = np.array(p.pass_ts)
        if from_:
            ok &= ts >= from_
        if to:
            ok &= ts <= to
    axis = (p.hour_transport[p.pass_hour] + rotate_deg) % 360.0
    off = np.abs((b - axis + 180.0) % 360.0 - 180.0)
    half = _sector_half_deg(p, d)
    downwind = ok & (d >= r_lo) & (d <= r_hi) & (off <= half)
    control = ok & (d >= CONTROL_INNER_M) & (off > half * CONTROL_EXCLUDE_MULT)
    return downwind, control, d, b


def _paired(p: _Passes, downwind: np.ndarray, control: np.ndarray) -> tuple[np.ndarray, int, int]:
    """Hourly paired differences, road-class matched. The estimator itself."""
    deltas: list[float] = []
    n_d = n_c = 0
    for h in np.unique(p.pass_hour[downwind]):
        dm = downwind & (p.pass_hour == h)
        cm = control & (p.pass_hour == h)
        if dm.sum() < MIN_DOWNWIND_PER_HOUR or cm.sum() < MIN_CONTROL_PER_HOUR:
            continue
        num = den = 0.0
        for k in np.unique(p.seg_class[p.pass_seg[dm]]):
            dk = dm & (p.seg_class[p.pass_seg] == k)
            ck = cm & (p.seg_class[p.pass_seg] == k)
            if not dk.any() or not ck.any():
                continue
            num += dk.sum() * (p.anomaly[dk].mean() - p.anomaly[ck].mean())
            den += dk.sum()
        if den == 0:
            continue
        deltas.append(num / den)
        n_d += int(den)
        n_c += int(cm.sum())
    return np.array(deltas), n_d, n_c


def _mean_ci(deltas: np.ndarray) -> tuple[float, float, float]:
    mean = float(deltas.mean())
    if deltas.size < 2:
        return mean, float("nan"), float("nan")
    half = 1.96 * float(deltas.std(ddof=1)) / math.sqrt(deltas.size)
    return mean, mean - half, mean + half


def estimate(
    p: _Passes,
    site: str,
    measure: str,
    *,
    r_lo: float = DEFAULT_R_LO_M,
    r_hi: float = DEFAULT_R_HI_M,
    regime: str = DEFAULT_REGIME,
    from_: str | None = None,
    to: str | None = None,
) -> Touchdown:
    """The site-level pooled result, with the placebo gate applied inside it."""
    lon, lat = p.sites[site]
    downwind, control, dist, brg = _masks(
        p, site, r_lo=r_lo, r_hi=r_hi, regime=regime, from_=from_, to=to
    )
    deltas, n_d, n_c = _paired(p, downwind, control)

    floor = DETECT_FLOOR.get(measure)
    base = dict(
        site_id=site, measure=measure, regime=regime, detect_floor=floor,
        source_lon=lon, source_lat=lat, r_lo_m=r_lo, r_hi_m=r_hi,
    )
    if deltas.size < MIN_HOURS:
        return Touchdown(
            excess=None, ci_lo=None, ci_hi=None, n_hours=int(deltas.size),
            n_downwind=n_d, n_control=n_c, placebo_max=None, placebo_ratio=None,
            state="insufficient_passes" if downwind.any() else "not_measured",
            n_supported_segments=0, n_distinct_roads=0, coverage_pct=0.0, **base,
        )

    mean, lo, hi = _mean_ci(deltas)

    # The placebo runs INSIDE the estimate, not as a downstream check, so there
    # is no way to serve a number that has not been null-tested.
    placebos: list[float] = []
    for rot in PLACEBO_DEG:
        rd, rc, _d, _b = _masks(
            p, site, r_lo=r_lo, r_hi=r_hi, regime=regime, from_=from_, to=to, rotate_deg=rot
        )
        rdel, _nd, _nc = _paired(p, rd, rc)
        if rdel.size >= MIN_HOURS:
            placebos.append(float(rdel.mean()))
    p_max = max(placebos, key=abs) if placebos else None
    ratio = (abs(p_max) / abs(mean)) if (p_max is not None and abs(mean) > 1e-12) else None

    # An estimate whose placebos could not be computed has not been falsified,
    # and an estimate that cannot be falsified is not reportable however tight
    # its interval. That rule replaced phase 2's structural far-field refusal.
    if p_max is None or ratio is None:
        state = "contested"
    elif floor is not None and abs(mean) < floor:
        state = "no_detection"
    elif ratio >= PLACEBO_MAX_RATIO:
        state = "contested"
    else:
        state = "elevated_downwind" if mean > 0 else "no_detection"

    segs = segment_evidence(p, site, downwind, control, dist, brg, regime=regime)
    supported = [s for s in segs if s.state not in ("not_measured", "insufficient_passes")]
    roads = {p.seg_name[p.seg_ids.index(s.segment_id)] for s in supported}
    roads.discard(None)
    touched = {s.segment_id for s in segs if s.n_downwind > 0}
    band = (p.dist[site] >= r_lo) & (p.dist[site] <= r_hi)
    coverage = (len(touched) / int(band.sum())) if band.any() else 0.0

    return Touchdown(
        excess=mean, ci_lo=lo, ci_hi=hi, n_hours=int(deltas.size),
        n_downwind=n_d, n_control=n_c, placebo_max=p_max, placebo_ratio=ratio,
        state=state, n_supported_segments=len(supported), n_distinct_roads=len(roads),
        coverage_pct=round(100.0 * coverage, 1), segments=segs,
        polar=polar_bins(p, site, downwind, control, dist, brg),
        districts=_districts(p, segs), **base,
    )


def segment_evidence(
    p: _Passes, site: str, downwind: np.ndarray, control: np.ndarray,
    dist: np.ndarray, brg: np.ndarray, *, regime: str,
) -> list[SegmentEvidence]:
    """Per-segment evidence. Never a verdict — see the module docstring.

    A segment that was driven downwind but cannot reach `SEG_MIN_PASSES` on
    both sides comes back `insufficient_passes` WITH its pass count, because
    "we drove this road four times and that is not enough" is the honest thing
    to show and is the argument for targeted driving.
    """
    n_seg = len(p.seg_ids)
    out: list[SegmentEvidence] = []
    n_down = np.bincount(p.pass_seg[downwind], minlength=n_seg)
    n_ctrl = np.bincount(p.pass_seg[control], minlength=n_seg)

    # Downwind of more than one site at the same moment? Then this segment
    # cannot separate them, and the payload has to say so.
    others = [s for s in p.sites if s != site]
    multi = np.zeros(p.n, dtype=bool)
    for other in others:
        od, _oc, _d, _b = _masks(
            p, other, r_lo=DEFAULT_R_LO_M, r_hi=DEFAULT_R_HI_M, regime=regime,
            from_=None, to=None,
        )
        multi |= od

    # Segments inside the band that were NEVER driven downwind of this site in
    # this regime. They are the honest half of the answer — the question could
    # have been asked there and was not — and without them the payload only
    # ever describes roads that happen to have been driven, which reads as
    # coverage rather than as a sample.
    band = np.flatnonzero(
        (p.dist[site] >= DEFAULT_R_LO_M) & (p.dist[site] <= DEFAULT_R_HI_M) & (n_down == 0)
    )
    for i in band:
        out.append(SegmentEvidence(
            segment_id=p.seg_ids[i], n_downwind=0, n_control=int(n_ctrl[i]),
            control_kind=None, excess=None, ci_lo=None, ci_hi=None,
            exclusive_share=0.0, placebo_ratio=None, state="not_measured",
            distance_m=round(float(p.dist[site][i]), 1),
            bearing_deg=round(float(p.brg[site][i]), 1),
        ))

    for i in np.flatnonzero(n_down):
        dm = downwind & (p.pass_seg == i)
        cm = control & (p.pass_seg == i)
        nd, nc = int(dm.sum()), int(cm.sum())
        exclusive = float((dm & ~multi).sum()) / max(1, nd)
        if nc >= SEG_MIN_PASSES and nd >= SEG_MIN_PASSES:
            kind = "self"
            diff = p.anomaly[dm].mean() - p.anomaly[cm].mean()
            pool = np.concatenate([p.anomaly[dm], p.anomaly[cm]])
            se = float(pool.std(ddof=1)) * math.sqrt(1 / nd + 1 / nc) if pool.size > 2 else float("nan")
            lo, hi = (diff - 1.96 * se, diff + 1.96 * se) if math.isfinite(se) else (None, None)
            state = "no_detection"
        else:
            kind = None
            diff = lo = hi = None
            state = "insufficient_passes"
        out.append(SegmentEvidence(
            segment_id=p.seg_ids[i], n_downwind=nd, n_control=nc, control_kind=kind,
            excess=None if diff is None else round(float(diff), 3),
            ci_lo=None if lo is None else round(float(lo), 3),
            ci_hi=None if hi is None else round(float(hi), 3),
            exclusive_share=round(exclusive, 3), placebo_ratio=None, state=state,
            distance_m=round(float(p.dist[site][i]), 1),
            bearing_deg=round(float(p.brg[site][i]), 1),
        ))
    return out


POLAR_SECTORS = 12
POLAR_RINGS = (0.0, 1500.0, 3000.0, 5000.0, 8000.0)


def polar_bins(p: _Passes, site: str, downwind: np.ndarray, control: np.ndarray,
               dist: np.ndarray, brg: np.ndarray) -> list[PolarBin]:
    """12 sectors x 4 rings, with n on BOTH sides of every bin.

    Never smoothed into a hull. A hull over these bins would interpolate across
    sectors nobody has driven and turn "we have not been there" into a shape
    that looks like a finding. `no_control` is its own state for the same
    reason: a bin with downwind passes and no comparison is not a zero.
    """
    width = 360.0 / POLAR_SECTORS
    sector = np.floor((brg % 360.0) / width).astype(int)
    ring = np.searchsorted(np.array(POLAR_RINGS[1:]), dist, side="right")
    out: list[PolarBin] = []
    for s in range(POLAR_SECTORS):
        for r in range(len(POLAR_RINGS) - 1):
            cell = (sector == s) & (ring == r)
            dm = downwind & cell
            cm = control & cell
            nd, nc = int(dm.sum()), int(cm.sum())
            if nd == 0 and nc == 0:
                state, val = "not_measured", None
            elif nd == 0:
                state, val = "not_measured", None
            elif nc == 0:
                state, val = "no_control", None
            else:
                state = "no_detection"
                val = round(float(p.anomaly[dm].mean() - p.anomaly[cm].mean()), 3)
            out.append(PolarBin(
                sector_deg=round(s * width, 1), ring_lo_m=POLAR_RINGS[r],
                ring_hi_m=POLAR_RINGS[r + 1], n_downwind=nd, n_control=nc,
                excess=val, state=state,
            ))
    return out


def _districts(p: _Passes, segs: list[SegmentEvidence]) -> list[dict[str, Any]]:
    """Which named places the downwind passes actually fell in."""
    index = {sid: i for i, sid in enumerate(p.seg_ids)}
    tally: dict[str, int] = {}
    for s in segs:
        d = p.seg_district[index[s.segment_id]]
        if d:
            tally[d] = tally.get(d, 0) + s.n_downwind
    total = sum(tally.values()) or 1
    return [
        {"district": k, "n_downwind": v, "share": round(v / total, 3)}
        for k, v in sorted(tally.items(), key=lambda kv: -kv[1])
    ]


# ── driven-coverage mask (P4-B) ──────────────────────────────────────────────


def coverage_cells(conn: sqlite3.Connection, campaign_id: str, cell_m: float) -> dict[str, Any]:
    """Where a car has actually been, as a grid of driven cells.

    About 69% of the campaign bbox is more than ~150 m from any driven segment
    midpoint. Without this served as a layer, every model polygon drawn over
    the campaign is indistinguishable from a measurement and every agreement
    score is computed partly over ground nobody has visited.
    """
    rows = conn.execute(
        "SELECT DISTINCT s.geometry_json FROM road_segment s "
        "JOIN segment_pass p ON p.segment_id = s.id WHERE s.campaign_id = ?",
        (campaign_id,),
    ).fetchall()
    bbox = conn.execute(
        "SELECT bbox_w, bbox_s, bbox_e, bbox_n FROM campaign WHERE id = ?", (campaign_id,)
    ).fetchone()
    if not rows or not bbox:
        return {"type": "FeatureCollection", "features": [], "cell_m": cell_m, "covered_pct": 0.0}

    w, s, e, n = bbox
    lat0 = math.radians((s + n) / 2)
    dx = cell_m / (111320.0 * math.cos(lat0))
    dy = cell_m / 110540.0
    nx = max(1, int(math.ceil((e - w) / dx)))
    ny = max(1, int(math.ceil((n - s) / dy)))

    # The whole POLYLINE, not its midpoint. A 150 m street crosses more than
    # one 150 m cell, and a mask built from midpoints understates coverage —
    # which is the wrong direction to be wrong in for a layer whose job is to
    # say what we do and do not know. Vertices plus interpolation at half a
    # cell, so a long straight run does not skip cells between its ends.
    import json as _json

    driven: set[tuple[int, int]] = set()
    step = min(dx, dy) * 0.5
    for (raw,) in rows:
        pts = _json.loads(raw) if raw else []
        for a, b in zip(pts, pts[1:], strict=False):
            span = max(abs(b[0] - a[0]) / dx, abs(b[1] - a[1]) / dy)
            n_steps = max(1, int(math.ceil(span * 2)))
            for k in range(n_steps + 1):
                t = k / n_steps
                lon = a[0] + (b[0] - a[0]) * t
                lat = a[1] + (b[1] - a[1]) * t
                driven.add((int((lon - w) / dx), int((lat - s) / dy)))
        if len(pts) == 1:
            driven.add((int((pts[0][0] - w) / dx), int((pts[0][1] - s) / dy)))
    _ = step

    features = []
    for ix, iy in sorted(driven):
        x0, y0 = w + ix * dx, s + iy * dy
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [[
                [round(x0, 6), round(y0, 6)], [round(x0 + dx, 6), round(y0, 6)],
                [round(x0 + dx, 6), round(y0 + dy, 6)], [round(x0, 6), round(y0 + dy, 6)],
                [round(x0, 6), round(y0, 6)],
            ]]},
            "properties": {"ix": ix, "iy": iy},
        })
    return {
        "type": "FeatureCollection",
        "features": features,
        "cell_m": cell_m,
        "n_cells": len(features),
        "n_cells_total": nx * ny,
        "covered_pct": round(100.0 * len(features) / max(1, nx * ny), 1),
        "bbox": [w, s, e, n],
    }
