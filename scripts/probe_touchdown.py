#!/usr/bin/env python3
"""P2 — does a MEASURED plume touchdown survive contact with this data?

Throwaway by design: this script exists to answer one question before any
endpoint or screen is built against it, and to leave a sweep table behind as
the design record. Nothing imports it. When phase 4 promotes the frozen
configuration into `air.server.touchdown`, this stays as the thing that chose
the constants.

WHY IT EXISTS
-------------
Seven design territories each computed "Ridgeline's downwind excess" and
published +4.60, +6.0, +38.2 and +0.1 ppb for the same quantity. Reproduced
here, the same-hour paired estimator returns -3.85, +1.45, +3.69 or +3.98
depending only on where the control pool starts and whether road classes are
matched. **The sign is a parameter, not a finding** — so no number from any of
them may schedule UI work until one estimator is chosen and its sweep is on
paper.

THE ESTIMATOR
-------------
Same-hour paired difference. For each hour with both kinds of pass:

    delta_h = mean(downwind passes) - mean(control passes)

optionally computed per road class and recombined weighted by downwind count,
and the reported excess is the unweighted mean of `delta_h` over hours, with a
t-based interval on those hourly values. Pairing within the hour is what
removes the diurnal cycle and the day-to-day background; road-class matching is
what removes the fact that a motorway is a different world from a residential
street (10.2 ppb apart in this dataset, larger than any plume enhancement in
it).

Downwind means: inside [r_lo, r_hi] of the source AND within the transport
wedge. Control means: at least `control_inner` from the source and outside a
widened wedge, in the same hour.

THE PLACEBO
-----------
Every estimate is re-run with the transport bearing rotated +90, +180 and +270
degrees. A real plume vanishes when you point the estimator at a direction the
wind was not blowing. If it does not, the estimator is measuring road
composition and traffic timing. Not one of the seven territories ran this;
the one null test that was run returned +32.99 ppb at a fabricated bearing.

    uv run python scripts/probe_touchdown.py sweep
    uv run python scripts/probe_touchdown.py frozen --db data/air.db
    uv run python scripts/probe_touchdown.py seeds
"""

from __future__ import annotations

import argparse
import math
import warnings
import sqlite3
import sys
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from air import dispersion  # noqa: E402
from air.server import touchdown as shipped  # noqa: E402

R_EARTH = 6371008.8

# RETIRED BY P3-A, kept as a comment because the reasoning still matters.
#
# The truth field used to be evaluated on a fixed 4,200 m downwind window, and
# 989 of 1,307 segments lie beyond that from Ridgeline — so out there the
# simulation's own plume was identically zero and every "excess" was a false
# positive by construction. That is why phase 2 refused the far field
# structurally rather than trusting any statistic: measured in the band
# 4,400-6,500 m, Ridgeline PM2.5 returned +1.26 [+0.52, +2.01] and passed BOTH
# rotation tests on a plume that did not exist.
#
# `field.py` now evaluates the whole raster, so there is ground truth
# everywhere a car has driven and the refusal no longer applies. What replaces
# it is weaker but still binding: an estimate whose ROTATED versions cannot be
# computed has not been null-tested, and an estimate that has not been
# null-tested is not reportable however tight its interval. Re-measured at
# 4.4-6.5 km after the rebuild, Ridgeline NO2 reads +3.43 [+2.29, +4.56] on 11
# paired hours — and every placebo comes back empty, so it stays `contested`.
TRUTH_WINDOW_M = None

# Smallest |excess| that may be called a detection, per measure, in that
# measure's own unit. NOT chosen — measured, as twice the 95th percentile of
# |excess| over 14 fabricated transport bearings at the worst of the three
# sites (`probe_touchdown.py null`). A floor set AT the noise level admits the
# noise half the time.
#
# IMPORTED from the shipped estimator rather than restated here. This file is
# the thing that measures the constant; `air.server.touchdown` is the thing
# that uses it, and two copies of a number that must agree is how this codebase
# has repeatedly ended up with two answers.
DETECT_FLOOR = shipped.DETECT_FLOOR


# ── configuration ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Config:
    """One point in the sweep. Every knob the territories disagreed about."""

    control_inner_m: float = 1000.0
    #: 'fixed' = a constant half-angle; 'sigma' = the kernel's own sigma_y.
    wedge: str = "sigma"
    fixed_half_deg: float = 30.0
    n_sigma: float = 2.0
    #: Control passes must be at least this many wedge-widths off the axis.
    control_exclude_mult: float = 2.0
    match_road_class: bool = True
    #: 'raw' = compare concentrations; 'segment' = subtract each segment's own
    #: campaign median first, so a street is compared against itself.
    baseline: str = "segment"
    exclude_colocated: bool = True
    colocated_m: float = 800.0
    min_downwind_per_hour: int = 1
    min_control_per_hour: int = 3
    min_hours: int = 5
    r_lo_m: float = 1500.0
    r_hi_m: float = 4000.0
    regime: str = "EF"

    def label(self) -> str:
        return (
            f"ctl>={self.control_inner_m:.0f} {self.wedge} "
            f"class={'Y' if self.match_road_class else 'N'} "
            f"base={self.baseline} coloc={'Y' if self.exclude_colocated else 'N'}"
        )


@dataclass(frozen=True)
class Estimate:
    site: str
    measure: str
    excess: float
    ci_lo: float
    ci_hi: float
    n_hours: int
    n_downwind: int
    n_control: int
    #: Largest |excess| over the three rotated-bearing placebos.
    placebo_max: float
    #: Every placebo estimate, for the record.
    placebos: tuple[float, ...]

    @property
    def placebo_ratio(self) -> float:
        """|placebo| / |true|. Under 0.5 is a pass; the gate is at 0.5."""
        if abs(self.excess) < 1e-12:
            return math.inf
        return abs(self.placebo_max) / abs(self.excess)

    @property
    def clears_placebo(self) -> bool:
        """P2-B: within 2x of a fabricated bearing is not a detection.

        An estimate whose placebos could not be COMPUTED — too few paired hours
        at the rotated bearings — fails this too, and that is the point rather
        than a side effect of `nan` comparisons. It is the rule that replaced
        phase 2's structural 4,200 m refusal once P3-A gave the far field real
        ground truth: an estimate that cannot be falsified is not reportable,
        however tight its confidence interval. Measured at 4.4-6.5 km after the
        rebuild, Ridgeline NO2 is +3.43 [+2.29, +4.56] on 11 paired hours with
        no computable placebo, and stays `contested`.
        """
        if self.n_hours == 0 or not math.isfinite(self.placebo_max):
            return False
        return self.placebo_ratio < 0.5

    @property
    def clears_floor(self) -> bool:
        """Bigger than the noise this estimator invents on fabricated bearings."""
        floor = DETECT_FLOOR.get(self.measure)
        return floor is None or abs(self.excess) >= floor

    @property
    def reportable(self) -> bool:
        """All three gates. Any one alone lets a false positive through.

        Measured, in the band 4,400-6,500 m where `field.py` clips the truth
        field to zero and there is therefore NOTHING to detect: Ridgeline PM2.5
        returns +1.26 [+0.52, +2.01] with a placebo ratio of 0.49 — it passes
        P2-B — and a 14-bearing null z of 2.4, so it passes that too. Only the
        absolute floor rejects it (1.26 < 2.14).

        Which is the real lesson, and it is structural rather than statistical:
        no rotation test can be trusted in a region where the truth is
        identically zero, because the rotated comparison is noise against
        noise. Until P3-A lands, `r_hi` must stay inside the truth window —
        see `check_window`.
        """
        return self.clears_placebo and self.clears_floor

    @property
    def state(self) -> str:
        if self.n_hours == 0 or not math.isfinite(self.excess):
            return "insufficient_data"
        if not self.clears_floor:
            return "no_detection"
        if not self.clears_placebo:
            return "contested"
        return "elevated_downwind" if self.excess > 0 else "no_detection"


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
    return (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0


class World:
    """Everything the estimator needs, projected once.

    Loading is the slow part and the masking is the fast part, so all the
    per-pass geometry is computed here and every sweep cell is then pure numpy
    over the same arrays. 64 configurations x 3 sites x 2 measures x 4 bearings
    is 1,536 estimates; this makes that seconds rather than an afternoon.
    """

    def __init__(self, db: Path, measures: tuple[str, ...] = ("no2", "pm25")):
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row

        segs = [dict(r) for r in conn.execute("SELECT * FROM road_segment ORDER BY id")]
        self.seg_index = {s["id"]: i for i, s in enumerate(segs)}
        self.seg_lon = np.array([s["mid_lon"] for s in segs])
        self.seg_lat = np.array([s["mid_lat"] for s in segs])
        klass = [s["road_class"] or "unknown" for s in segs]
        self.class_names = sorted(set(klass))
        cidx = {c: i for i, c in enumerate(self.class_names)}
        self.seg_class = np.array([cidx[c] for c in klass])
        self.seg_district = [s["district"] for s in segs]
        self.seg_name = [s["name"] for s in segs]

        # Emission-weighted centroid per site, so toggling a stack moves it.
        # Source point = emission-weighted centroid of the active points, so
        # toggling a stack in site config moves the thing the estimator is
        # aimed at without inventing a `source` column the schema lacks.
        self.site_points: dict[str, list[tuple[float, float]]] = {}
        acc: dict[str, list[float]] = {}
        for r in conn.execute("SELECT site_id, kind, lon, lat FROM emission_point WHERE active=1"):
            self.site_points.setdefault(r["site_id"], []).append((r["lon"], r["lat"]))
            wt = dispersion.STRENGTH.get(r["kind"], 0.6)
            a = acc.setdefault(r["site_id"], [0.0, 0.0, 0.0])
            a[0] += wt * r["lon"]
            a[1] += wt * r["lat"]
            a[2] += wt
        self.sites = {k: (v[0] / v[2], v[1] / v[2]) for k, v in acc.items()}

        wind = [dict(r) for r in conn.execute("SELECT ts, speed_ms, dir_deg, stability, pbl_m FROM wind")]
        self.wind_by_hour = {w["ts"][:13]: w for w in wind}

        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT segment_id, ts, " + ", ".join(measures) + " FROM segment_pass ORDER BY ts"
            )
        ]
        conn.close()

        keep = [r for r in rows if r["segment_id"] in self.seg_index and r["ts"][:13] in self.wind_by_hour]
        self.n = len(keep)
        self.pass_seg = np.array([self.seg_index[r["segment_id"]] for r in keep])
        hours = sorted({r["ts"][:13] for r in keep})
        hidx = {h: i for i, h in enumerate(hours)}
        self.hours = hours
        self.pass_hour = np.array([hidx[r["ts"][:13]] for r in keep])
        self.values = {m: np.array([r[m] for r in keep], dtype=float) for m in measures}

        w_speed = np.array([self.wind_by_hour[h]["speed_ms"] for h in hours])
        w_dir = np.array([self.wind_by_hour[h]["dir_deg"] for h in hours])
        self.hour_speed = w_speed
        self.hour_transport = (w_dir + 180.0) % 360.0
        self.hour_class = np.array([self.wind_by_hour[h]["stability"] for h in hours])

        # Per-site, per-segment geometry.
        self.dist: dict[str, np.ndarray] = {}
        self.brg: dict[str, np.ndarray] = {}
        for sid, (lon, lat) in self.sites.items():
            self.dist[sid] = _haversine(lon, lat, self.seg_lon, self.seg_lat)
            self.brg[sid] = _bearing(lon, lat, self.seg_lon, self.seg_lat)

        # Distance from every segment to the NEAREST emission point of any
        # OTHER site — for the co-located-source exclusion.
        self.near_other: dict[str, np.ndarray] = {}
        for sid in self.sites:
            best = np.full(len(segs), np.inf)
            for other, pts in self.site_points.items():
                if other == sid:
                    continue
                for lon, lat in pts:
                    best = np.minimum(best, _haversine(lon, lat, self.seg_lon, self.seg_lat))
            self.near_other[sid] = best

        # Per-segment campaign median, for the `segment` baseline.
        self.seg_median: dict[str, np.ndarray] = {}
        for m, v in self.values.items():
            med = np.zeros(len(segs))
            order = np.argsort(self.pass_seg, kind="stable")
            s_sorted, v_sorted = self.pass_seg[order], v[order]
            bounds = np.searchsorted(s_sorted, np.arange(len(segs) + 1))
            for i in range(len(segs)):
                chunk = v_sorted[bounds[i]:bounds[i + 1]]
                # nanmedian, not median. A single QC dropout on a street makes
                # `np.median` return NaN for the whole street, which poisons
                # its baseline and silently removes every pass on it: 167 of
                # 1,307 segments and 8,196 of 56,673 NO2 passes. Found when the
                # server implementation (which drops NULLs at load) disagreed
                # with this one by 0.05 ppb.
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", RuntimeWarning)
                    med[i] = np.nanmedian(chunk) if chunk.size else np.nan
            self.seg_median[m] = med


# ── the estimator ────────────────────────────────────────────────────────────


def _wedge_half_deg(cfg: Config, w: World, d: np.ndarray) -> np.ndarray:
    """Half-angle of the transport wedge, per pass.

    `sigma` uses the dispersion kernel's own sigma_y at that distance under
    THAT HOUR's stability and wind speed, so the sector narrows on a still
    night exactly as the drawn cone does. A first version passed a single
    hard-coded class and the median speed for every pass, which quietly turned
    a stability-aware gate back into a fixed one.
    """
    d = np.maximum(d, 1.0)
    if cfg.wedge == "fixed":
        return np.full(d.shape, cfg.fixed_half_deg)
    cls = w.hour_class[w.pass_hour]
    u10 = w.hour_speed[w.pass_hour]
    out = np.empty(d.shape)
    for c in np.unique(cls):
        m = cls == c
        # half_width is linear in the meander factor, which is the only place
        # u10 enters, so one call per (class, speed bucket) is exact enough at
        # the 0.1 m/s resolution the wind table carries.
        out[m] = np.degrees(
            np.arctan2(
                np.asarray(dispersion.half_width(d[m], str(c), np.median(u10[m]), cfg.n_sigma)),
                d[m],
            )
        )
    return out


def estimate(w: World, site: str, measure: str, cfg: Config, rotate_deg: float = 0.0) -> Estimate:
    d = w.dist[site][w.pass_seg]
    b = w.brg[site][w.pass_seg]
    v = w.values[measure].copy()
    if cfg.baseline == "segment":
        v = v - w.seg_median[measure][w.pass_seg]

    in_regime = np.isin(w.hour_class[w.pass_hour], list(cfg.regime))
    ok = in_regime & np.isfinite(v)
    if cfg.exclude_colocated:
        ok &= w.near_other[site][w.pass_seg] >= cfg.colocated_m

    axis = (w.hour_transport[w.pass_hour] + rotate_deg) % 360.0
    off = np.abs((b - axis + 180.0) % 360.0 - 180.0)
    half = _wedge_half_deg(cfg, w, d)

    downwind = ok & (d >= cfg.r_lo_m) & (d <= cfg.r_hi_m) & (off <= half)
    control = ok & (d >= cfg.control_inner_m) & (off > half * cfg.control_exclude_mult)

    hours = w.pass_hour
    deltas: list[float] = []
    n_d = n_c = 0
    for h in np.unique(hours[downwind]):
        dm = downwind & (hours == h)
        cm = control & (hours == h)
        if dm.sum() < cfg.min_downwind_per_hour or cm.sum() < cfg.min_control_per_hour:
            continue
        if cfg.match_road_class:
            num = den = 0.0
            for k in np.unique(w.seg_class[w.pass_seg[dm]]):
                dk = dm & (w.seg_class[w.pass_seg] == k)
                ck = cm & (w.seg_class[w.pass_seg] == k)
                if not dk.any() or not ck.any():
                    continue
                num += dk.sum() * (v[dk].mean() - v[ck].mean())
                den += dk.sum()
            if den == 0:
                continue
            delta = num / den
            used_d, used_c = int(den), int(cm.sum())
        else:
            delta = float(v[dm].mean() - v[cm].mean())
            used_d, used_c = int(dm.sum()), int(cm.sum())
        deltas.append(float(delta))
        n_d += used_d
        n_c += used_c

    arr = np.array(deltas)
    if arr.size < cfg.min_hours:
        return Estimate(site, measure, float("nan"), float("nan"), float("nan"),
                        arr.size, n_d, n_c, float("nan"), ())

    mean = float(arr.mean())
    half_ci = 1.96 * float(arr.std(ddof=1)) / math.sqrt(arr.size) if arr.size > 1 else float("nan")

    placebos: tuple[float, ...] = ()
    if rotate_deg == 0.0:
        vals = []
        for rot in (90.0, 180.0, 270.0):
            p = estimate(w, site, measure, cfg, rotate_deg=rot)
            vals.append(p.excess)
        placebos = tuple(vals)
    finite = [p for p in placebos if np.isfinite(p)]
    pmax = max(finite, key=abs) if finite else float("nan")
    return Estimate(site, measure, mean, mean - half_ci, mean + half_ci,
                    arr.size, n_d, n_c, pmax, placebos)


# ── the sweep ────────────────────────────────────────────────────────────────

SWEEP = {
    "control_inner_m": [300.0, 1000.0, 1500.0, 2000.0],
    "wedge": ["fixed", "sigma"],
    "match_road_class": [True, False],
    "baseline": ["raw", "segment"],
    "exclude_colocated": [True, False],
}

SITES = ("site-ridgeline", "site-deltaforge", "site-riverport")
MEASURES = ("no2", "pm25")


def _configs(base: Config):
    from itertools import product

    keys = list(SWEEP)
    for combo in product(*(SWEEP[k] for k in keys)):
        yield replace(base, **dict(zip(keys, combo, strict=True)))


def cmd_sweep(args) -> int:
    w = World(args.db)
    base = Config(r_lo_m=args.r_lo, r_hi_m=args.r_hi, regime=args.regime)
    rows: list[tuple[Config, Estimate]] = []
    for cfg in _configs(base):
        for site in SITES:
            for m in MEASURES:
                rows.append((cfg, estimate(w, site, m, cfg)))

    print(f"# Touchdown sweep — {args.db}")
    print(f"# regime {base.regime}, downwind {base.r_lo_m:.0f}-{base.r_hi_m:.0f} m, "
          f"{len(list(_configs(base)))} configurations x {len(SITES)} sites x {len(MEASURES)} measures")
    refusal = check_window(base)
    if refusal:
        print(f"# WARNING: {refusal}")
    print()

    for site in SITES:
        for m in MEASURES:
            sub = [(c, e) for c, e in rows if e.site == site and e.measure == m]
            fin = [(c, e) for c, e in sub if np.isfinite(e.excess)]
            print(f"## {site} / {m}")
            if not fin:
                print("   no configuration produced an estimate\n")
                continue
            vals = np.array([e.excess for _c, e in fin])
            pos = int((vals > 0).sum())
            rep = [(c, e) for c, e in fin if e.reportable]
            print(f"   {len(fin)}/{len(sub)} configs estimated | "
                  f"excess {vals.min():+.2f} to {vals.max():+.2f} ppb-or-ug | "
                  f"sign: {pos} positive, {len(fin) - pos} negative | "
                  f"placebo gate passed by {len(rep)}")
            worst = min(fin, key=lambda ce: ce[1].excess)
            best = max(fin, key=lambda ce: ce[1].excess)
            for tag, (c, e) in (("min", worst), ("max", best)):
                print(f"     {tag:3} {e.excess:+7.2f} [{e.ci_lo:+6.2f},{e.ci_hi:+6.2f}] "
                      f"h={e.n_hours:3} nD={e.n_downwind:5} placebo {e.placebo_max:+7.2f} "
                      f"ratio {e.placebo_ratio:5.2f}  {c.label()}")
            print()

    # Which knob moves the answer most? The point of the exercise.
    print("## Sensitivity — how much each knob alone moves the estimate")
    print(f"   {'knob':22}{'site/measure':26}{'spread (max-min)':>18}   values")
    for knob, options in SWEEP.items():
        worst_line = None
        worst_spread = -1.0
        for site in SITES:
            for m in MEASURES:
                sub = [(c, e) for c, e in rows
                       if e.site == site and e.measure == m and np.isfinite(e.excess)]
                by = {}
                for c, e in sub:
                    by.setdefault(getattr(c, knob), []).append(e.excess)
                if len(by) < 2:
                    continue
                means = {k: float(np.mean(v)) for k, v in by.items()}
                spread = max(means.values()) - min(means.values())
                if spread > worst_spread:
                    worst_spread = spread
                    worst_line = (f"{site.replace('site-', '')}/{m}", means)
        if worst_line:
            vals = ", ".join(f"{k}={v:+.2f}" for k, v in worst_line[1].items())
            print(f"   {knob:22}{worst_line[0]:26}{worst_spread:>18.2f}   {vals}")
    return 0


def cmd_frozen(args) -> int:
    w = World(args.db)
    cfg = replace(FROZEN, r_lo_m=args.r_lo, r_hi_m=args.r_hi, regime=args.regime)
    refusal = check_window(cfg)
    if refusal:
        print(f"# REFUSED: {refusal}\n")
    print(f"# Frozen configuration — {args.db}")
    print(f"# {cfg}\n")

    print(f"   {'site':17}{'measure':8}{'excess':>9}{'95% CI':>18}{'hours':>7}{'nD':>6}{'nC':>7}"
          f"{'placebo':>9}{'ratio':>7}  state")
    for site in SITES:
        for m in MEASURES:
            e = estimate(w, site, m, cfg)
            ci = f"[{e.ci_lo:+.2f},{e.ci_hi:+.2f}]" if np.isfinite(e.ci_lo) else "—"
            print(f"   {site.replace('site-', ''):17}{m:8}{e.excess:>+9.2f}{ci:>18}"
                  f"{e.n_hours:>7}{e.n_downwind:>6}{e.n_control:>7}"
                  f"{e.placebo_max:>+9.2f}{e.placebo_ratio:>7.2f}  {e.state}")
    return 0


def cmd_samples(args) -> int:
    """P2-D — the joint distribution the minimum-n constants must come from."""
    w = World(args.db)
    cfg = FROZEN
    print(f"# Conditioned sample sizes — {args.db}, regime {cfg.regime}, "
          f"downwind {cfg.r_lo_m:.0f}-{cfg.r_hi_m:.0f} m\n")
    for site in SITES:
        d = w.dist[site][w.pass_seg]
        b = w.brg[site][w.pass_seg]
        in_regime = np.isin(w.hour_class[w.pass_hour], list(cfg.regime))
        axis = w.hour_transport[w.pass_hour]
        off = np.abs((b - axis + 180.0) % 360.0 - 180.0)
        half = _wedge_half_deg(cfg, w, d)
        dn = in_regime & (d >= cfg.r_lo_m) & (d <= cfg.r_hi_m) & (off <= half)
        ct = in_regime & (d >= cfg.control_inner_m) & (off > half * cfg.control_exclude_mult)

        per_hour = []
        for h in np.unique(w.pass_hour[dn]):
            per_hour.append((int((dn & (w.pass_hour == h)).sum()),
                             int((ct & (w.pass_hour == h)).sum())))
        seg_d = np.bincount(w.pass_seg[dn], minlength=len(w.seg_lon))
        seg_c = np.bincount(w.pass_seg[ct], minlength=len(w.seg_lon))
        both = (seg_d > 0) & (seg_c > 0)
        print(f"## {site}")
        print(f"   hours with any downwind pass: {len(per_hour)}")
        if per_hour:
            a = np.array(per_hour)
            for k in (1, 3, 5, 12):
                print(f"     hours with >={k} downwind AND >={k} control: "
                      f"{int(((a[:, 0] >= k) & (a[:, 1] >= k)).sum())}")
        print(f"   segments ever downwind: {int((seg_d > 0).sum())} of {len(seg_d)}")
        for k in (1, 5, 12):
            print(f"     segments with >={k} downwind and >={k} control passes: "
                  f"{int(((seg_d >= k) & (seg_c >= k)).sum())}")
        print(f"   segments with both sides at all: {int(both.sum())}\n")
    return 0


# ── the frozen configuration (P2-D) ──────────────────────────────────────────
#
# Chosen from the sweep by MECHANISM, not by best number. Every failing region
# fails for a reason that can be named, and every knob below is set to the
# value that reason implies:
#
#   wedge='sigma'        A fixed 30-degree wedge is roughly four times too wide
#                        under stable air, where the kernel's own half-angle at
#                        2 km is about 8 degrees, so it dilutes the downwind set
#                        with off-axis passes. Every `fixed` cell in the sweep
#                        either fails the placebo or lands near zero; the sign
#                        of the whole estimate flips with this knob alone
#                        (fixed -0.03 vs sigma +4.39 averaged over Ridgeline).
#
#   control_inner=1500   NOT tuned. It is 2.3x NEAR_SIGMA_M (640 m), the radius
#                        of the isotropic campus near field, so a control pass
#                        carries less than e^-2.7 of it. Controls drawn from
#                        300 m carry that term and INVERT the contrast: the
#                        same site, same hours, same measure reads -10.27 ppb.
#                        That is the single largest sensitivity in the sweep
#                        (5.43 ppb from this knob alone) and it is the
#                        mechanism the plan predicted.
#
#   match_road_class     The motorway-to-residential spread is 10.2 ppb over
#                        56,492 passes — larger than any plume enhancement
#                        anywhere in this dataset. Matching is a property of
#                        the statistic, not a refinement.
#
#   baseline='segment'   Compare a street against its own campaign median, so
#                        composition that class matching cannot reach (a
#                        particular junction, a bus route) drops out too.
#
#   exclude_colocated    Three sites inside one 12 km box; without it, Delta
#                        Forge's and Riverport's plumes sit in Ridgeline's
#                        control pool.
#
# Deliberately NOT control_inner=2000, which scores a better placebo ratio
# (0.10 vs 0.40). Picking the cell with the prettiest null test is fitting to
# the null test. 1500 m is the middle of the stable plateau and has a physical
# justification that does not mention the result.
#   min_downwind=3       An "hourly mean" from one pass is not a mean. Measured
#   min_control=8        sensitivity across 1/2/3/5 downwind and 3/5/8 control:
#   min_hours=8          Ridgeline moves +5.41 -> +5.31 -> +5.08 -> +4.96 and
#                        Riverport +4.05 -> +4.05 -> +4.05 -> +3.42, so the
#                        finding is not resting on a couple of thin hours. The
#                        control minimum changes NOTHING at any value tried —
#                        control pools here run to hundreds of passes an hour —
#                        so setting it high is free insurance. `min_hours=8` sits
#                        below the 14 and 16 paired hours the two detections
#                        have and above the 10 Delta Forge scrapes together.
FROZEN = Config(
    control_inner_m=shipped.CONTROL_INNER_M,
    wedge="sigma",
    n_sigma=shipped.N_SIGMA,
    control_exclude_mult=shipped.CONTROL_EXCLUDE_MULT,
    match_road_class=True,
    baseline="segment",
    exclude_colocated=True,
    colocated_m=shipped.COLOCATED_M,
    min_downwind_per_hour=shipped.MIN_DOWNWIND_PER_HOUR,
    min_control_per_hour=shipped.MIN_CONTROL_PER_HOUR,
    min_hours=shipped.MIN_HOURS,
    r_lo_m=shipped.DEFAULT_R_LO_M,
    r_hi_m=shipped.DEFAULT_R_HI_M,
    regime=shipped.DEFAULT_REGIME,
)


def check_window(cfg: Config, db: Path | None = None) -> str | None:
    """Is there ground truth where this configuration is looking? A refusal, or None.

    Before P3-A this refused anything past 4,200 m, because the truth field
    stopped there and the estimator was comparing noise against noise. That is
    fixed — `field.py` evaluates the whole raster — so the check now asks the
    question it was always standing in for: does the simulation have a plume
    where you are measuring one?

    The raster is the campaign bbox plus `field.PAD_M`, so a receptor outside
    it has no field at all. Every road segment is inside it by construction,
    which is why this now returns None for any band a road can be in.
    """
    if TRUTH_WINDOW_M is not None and cfg.r_hi_m > TRUTH_WINDOW_M:
        return (
            f"downwind band reaches {cfg.r_hi_m:.0f} m, past the {TRUTH_WINDOW_M:.0f} m "
            "truth window"
        )
    return None

def cmd_null(args) -> int:
    """Calibrate a detection floor from the estimator's own null distribution.

    Three rotations (P2-B) tell you whether ONE estimate survives a fabricated
    bearing. They do not tell you how big an excess this estimator invents on
    average, which is the number a detection floor has to clear. So: rotate the
    transport bearing through the whole circle in 15-degree steps, drop the
    ones near the true axis and its mirror, and read the spread.

    Everything this returns is noise by construction. If the true-bearing
    estimate is not clearly outside it, there is nothing to report.
    """
    w = World(args.db)
    cfg = replace(FROZEN, r_lo_m=args.r_lo, r_hi_m=args.r_hi, regime=args.regime)
    rots = [r for r in range(15, 360, 15) if not (r <= 30 or r >= 330 or 150 <= r <= 210)]
    print(f"# Null distribution — {args.db}, {len(rots)} fabricated bearings per cell")
    print(f"# downwind {cfg.r_lo_m:.0f}-{cfg.r_hi_m:.0f} m, regime {cfg.regime}\n")
    print(f"   {'site':17}{'measure':8}{'true':>8}{'null |max|':>12}{'null p95':>10}"
          f"{'null sd':>9}{'z':>7}  verdict")
    floors: dict[str, float] = {}
    for site in SITES:
        for m in MEASURES:
            true = estimate(w, site, m, cfg)
            null = np.array([
                e for e in (estimate(w, site, m, cfg, rotate_deg=float(r)).excess for r in rots)
                if np.isfinite(e)
            ])
            if null.size < 4 or not np.isfinite(true.excess):
                print(f"   {site.replace('site-', ''):17}{m:8}{'—':>8}{'—':>12}"
                      f"{'—':>10}{'—':>9}{'—':>7}  insufficient_data")
                continue
            p95 = float(np.percentile(np.abs(null), 95))
            sd = float(null.std(ddof=1))
            z = (abs(true.excess) - float(np.abs(null).mean())) / sd if sd > 0 else float("inf")
            floors.setdefault(m, 0.0)
            floors[m] = max(floors[m], p95)
            ok = abs(true.excess) > p95 and z >= 2.0
            print(f"   {site.replace('site-', ''):17}{m:8}{true.excess:>+8.2f}"
                  f"{np.abs(null).max():>12.2f}{p95:>10.2f}{sd:>9.2f}{z:>7.1f}  "
                  f"{'clears the null' if ok else 'INSIDE THE NULL'}")
    print()
    for m, f in sorted(floors.items()):
        print(f"   suggested detect_floor[{m}] = {f:.2f}  (worst site's 95th percentile "
              f"of |fabricated-bearing excess|)")
    return 0


def cmd_seeds(args) -> int:
    """P2-C — does the finding survive a reseed, or is it this world's accident?

    The Boxtown beat is load-bearing in three interfaces. If it moves with the
    seed, every sentence about it has to be generated from the numbers at
    runtime rather than written, and no demo script may depend on it.

    Databases are built separately (they take about two minutes each):

        for S in 20260828 20260829 20260830; do
          uv run python -m air.datagen.build build --seed $S \
            --now 2026-08-28T13:54:00 --quiet --db /tmp/seed_$S.db
        done
    """
    dbs = [args.db, *args.also]
    print(f"# Multi-seed check — frozen configuration, {len(dbs)} databases\n")
    per: dict[tuple[str, str], list[Estimate]] = {}
    for db in dbs:
        if not Path(db).exists():
            print(f"   (missing {db} — skipped)")
            continue
        try:
            w = World(Path(db))
        except (sqlite3.OperationalError, KeyError, ZeroDivisionError) as exc:
            print(f"   (unreadable {db}: {exc} — still building?)")
            continue
        if not all(s in w.sites for s in SITES):
            print(f"   (incomplete {db} — still building?)")
            continue
        for site in SITES:
            for m in MEASURES:
                per.setdefault((site, m), []).append(estimate(w, site, m, FROZEN))
        print(f"   loaded {db}")
    print()
    print(f"   {'site':17}{'measure':8}{'estimates across seeds':>34}{'sign':>8}{'gate':>10}")
    for (site, m), es in sorted(per.items()):
        vals = [e.excess for e in es]
        shown = " ".join(f"{v:+6.2f}" if np.isfinite(v) else "   n/a" for v in vals)
        signs = {np.sign(v) for v in vals if np.isfinite(v)}
        gates = sum(1 for e in es if e.reportable)
        print(f"   {site.replace('site-', ''):17}{m:8}{shown:>34}"
              f"{('stable' if len(signs) <= 1 else 'FLIPS'):>8}{f'{gates}/{len(es)}':>10}")
    return 0




def cmd_fixture(args) -> int:
    """Write tests/fixtures/touchdown_frozen.json — the committed regression."""
    import json
    from dataclasses import asdict

    w = World(args.db)
    out = {
        "_why": (
            "P2-D. The frozen estimator configuration and what it returns on the "
            "pinned build. Regenerating this to make a failing test pass defeats "
            "the point: the sweep that chose these values is in docs/PLAN-plume.md."
        ),
        "config": asdict(FROZEN),
        "detect_floor": DETECT_FLOOR,
        "truth_window_m": TRUTH_WINDOW_M,
        "estimates": {},
    }
    for site in SITES:
        for m in MEASURES:
            e = estimate(w, site, m, FROZEN)
            out["estimates"][f"{site}/{m}"] = {
                "excess": round(e.excess, 4) if np.isfinite(e.excess) else None,
                "ci_lo": round(e.ci_lo, 4) if np.isfinite(e.ci_lo) else None,
                "ci_hi": round(e.ci_hi, 4) if np.isfinite(e.ci_hi) else None,
                "n_hours": e.n_hours,
                "n_downwind": e.n_downwind,
                "n_control": e.n_control,
                "placebo_max": round(e.placebo_max, 4) if np.isfinite(e.placebo_max) else None,
                "state": e.state,
            }
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {path}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=["sweep", "frozen", "samples", "null", "seeds", "fixture"])
    ap.add_argument("--db", type=Path, default=Path("data/air.db"))
    ap.add_argument("--also", nargs="*", default=[], help="extra databases for `seeds`")
    ap.add_argument("--r-lo", type=float, default=1500.0)
    ap.add_argument("--r-hi", type=float, default=4000.0)
    ap.add_argument("--regime", default="EF")
    ap.add_argument("--out", default="tests/fixtures/touchdown_frozen.json")
    args = ap.parse_args(argv)
    return {
        "sweep": cmd_sweep,
        "frozen": cmd_frozen,
        "samples": cmd_samples,
        "null": cmd_null,
        "seeds": cmd_seeds,
        "fixture": cmd_fixture,
    }[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
