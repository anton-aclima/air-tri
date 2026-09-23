"""The operating envelope — how hard a site can run, measured.

THE INDUSTRY TIER'S SPINE. The promise on that screen is "run at the top of
your safe envelope", and until now the envelope was `industry_site.headroom_pct`
— a constant (79 / 61 / 44) hardcoded in `world.py`, connected to nothing, that
an operator could neither check nor improve.

This replaces it with a number that is measured, that moves with the weather,
and that an operator can act on.

WHAT BINDS, AND WHY IT IS NOT THE PERMIT LINE
---------------------------------------------
Against the regulatory line alone, Ridgeline could run about five times
nameplate before its own contribution to the ground reached 60 ppb. "You have
infinite headroom" is not an instrument.

What actually binds is the fenceline at night. Measured on the shipped
database: Paul R Lowry Road runs along Ridgeline's boundary, and against 2,713
passes on the SAME ROAD CLASS more than 2 km from any site —

    stable night (E/F)   p50 43.5   p90 84.8   35.2% of passes over 60 ppb
    daylight   (B/C)     p50 15.4   p90 29.3    0.0%

Same road, same class, same instrument. The only thing that changed is the
weather. That is the envelope: it closes when the air stops moving and the
campus's own emissions pile up on the road beside it, and it opens by morning
— which is precisely what makes it manageable. Load can move, generator tests
can stagger, cooling can run ahead of it.

SCOPE, STATED
-------------
This is the site's WHOLE footprint — generators, on-site traffic, fugitives —
not its stacks alone. That is deliberate: it is also what an operator
controls. It is a different question from `air.server.touchdown`, which asks
where the plume lands one to four kilometres downwind and over whom. Both
belong on the screen; only this one binds today.

THE STATISTIC
-------------
Paired by NIGHT rather than by clock hour. Within one stable episode the
background, the traffic regime and the crew are shared, and the fleet covers
both the fenceline and the comparison roads. Hour-pairing is stricter and was
tried first; it discards half the episodes, because Ridgeline's fenceline is
entirely `tertiary` and in half the hours no tertiary comparison road was
driven. Where both are computable they agree: +61.7 ± 14.3 hour-paired against
+55.7 ± 5.0 night-paired.

THE NULL
--------
Not a bearing rotation — there is no bearing in this statistic. The null is
DECOY FENCELINES: run the identical computation around 40 randomly chosen road
clusters at least 2.5 km from every site. Measured: mean +0.55 ppb, sd 1.72,
worst |excess| 5.57. Ridgeline's fenceline is +55.70, **z = 32**. A site whose
excess does not clear `DECOY_FLOOR` has not been distinguished from an
arbitrary patch of road.
"""

from __future__ import annotations

import datetime as dt
import math
import sqlite3
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from air.server import cache
from air.server.touchdown import _Passes, _haversine, load as load_passes

# ── the configuration ────────────────────────────────────────────────────────

#: Metres from the nearest ACTIVE emission point for a segment to be fenceline.
#: Measured: 800 m captures each site's own road — Paul R Lowry, Channel
#: Avenue + Pier Street, Riverport Road — and stops before bleeding into the
#: wider network, where Riverport jumps from 13 segments to 51 by 1,200 m.
FENCELINE_M = 800.0

#: A comparison segment must be at least this far from EVERY site, not just
#: this one. Three sites inside a 12 km box otherwise compare against each
#: other's fencelines.
COMPARISON_MIN_M = 2000.0

#: Per stable episode, on each side. An "episode mean" from one pass is not a
#: mean; the comparison side is generous because the network supplies it freely.
MIN_FENCE_PER_NIGHT = 2
MIN_COMPARISON_PER_NIGHT = 8
MIN_EPISODES = 3

#: Smallest excess distinguishable from an arbitrary patch of road, per
#: measure, in that measure's unit. Twice the 95th percentile of |excess| over
#: 120 decoy fencelines, taken in the STABLE regime because that is where the
#: null is widest:
#:
#:     no2   stable    mean +0.16  sd 1.57  |max| 5.63  p95 4.18  -> 8.4
#:     no2   unstable  mean +0.12  sd 0.95  |max| 2.35  p95 1.93  -> 3.9
#:     pm25  stable    mean -0.03  sd 0.52  |max| 1.15  p95 1.05  -> 2.1
#:
#: One number per measure rather than one per regime: the stable value is the
#: conservative one, and a floor that loosens at night is a floor that relaxes
#: exactly when the claim is being made.
DECOY_FLOOR = {"no2": 8.4, "pm25": 2.1}

#: How many decoys the served null is built from.
DECOY_N = 120

#: Episodes are keyed by a day that STARTS AT 06:00, so everything from 06:00
#: to 05:59 the next morning shares a key and one stable night is one episode
#: rather than two either side of midnight. Daytime hours land in the same key,
#: which is harmless: the regime mask has already removed them before pairing.
NIGHT_START_HOUR = 6

REGIMES = {"unstable": "AB", "neutral": "CD", "stable": "EF"}

STATES = (
    "binding",        # the fenceline crosses an action level on some passes
    "elevated",       # clearly above comparable roads, no line crossed
    "indistinct",     # not separable from an arbitrary patch of road
    "insufficient",   # not enough conditioned episodes to say
)


@dataclass(frozen=True)
class Threshold:
    action_level_id: str
    label: str
    threshold: float
    unit: str
    severity: str
    source: str
    share_over: float
    #: How much of THIS SITE's own contribution would have to go to hold the
    #: line, as a percentage of that contribution. Works for every site,
    #: including the two with no megawatt rating, and is the number an operator
    #: can actually act on. 0 means the line is already clear.
    cut_pct_typical: float | None
    cut_pct_bad_night: float | None
    #: The same thing in megawatts. Only for a site with a load rating, and a
    #: MODELLED extrapolation from a measured slope — see `_headroom_mw`.
    headroom_mw_typical: float | None
    headroom_mw_bad_night: float | None


@dataclass(frozen=True)
class RegimeEnvelope:
    regime: str
    classes: str
    n_episodes: int
    n_fenceline: int
    n_comparison: int
    excess: float | None
    ci_lo: float | None
    ci_hi: float | None
    level_p50: float | None
    level_p90: float | None
    level_max: float | None
    #: The SAME statistics for the comparison set, so the panel can show both
    #: distributions rather than a difference the reader has to take on trust.
    #: Class-matched to the fenceline's own mix, or the two are not comparable.
    comparison_p50: float | None
    comparison_p90: float | None
    comparison_max: float | None
    share_of_hours: float
    hours_of_day: list[int]
    state: str
    thresholds: list[Threshold] = field(default_factory=list)


@dataclass(frozen=True)
class Envelope:
    site_id: str
    measure: str
    unit: str
    load_mw: float | None
    decoy_floor: float | None
    fenceline_m: float
    n_fenceline_segments: int
    fenceline_roads: list[str]
    #: So a map can ink the actual roads the claim rests on. CONTRACT
    #: non-negotiable 2 — the road grid is the hero visual, not a summary card.
    fenceline_segment_ids: list[str]
    comparison_segment_ids: list[str]
    regimes: list[RegimeEnvelope] = field(default_factory=list)


# ── the statistic ────────────────────────────────────────────────────────────


def _night_keys(ts_list: list[str]) -> np.ndarray:
    out = []
    for t in ts_list:
        d = dt.datetime.fromisoformat(t) - dt.timedelta(hours=NIGHT_START_HOUR)
        out.append(d.date().isoformat())
    return np.array(out)


def _distance_to_nearest(p: _Passes, points: list[tuple[float, float]]) -> np.ndarray:
    best = np.full(len(p.seg_lon), np.inf)
    for lon, lat in points:
        best = np.minimum(best, _haversine(lon, lat, p.seg_lon, p.seg_lat))
    return best


def _paired_excess(
    p: _Passes, nights: np.ndarray, fence_seg: np.ndarray, far_seg: np.ndarray, classes: str
) -> tuple[np.ndarray, int, int]:
    """Night-paired, road-class-matched difference. The estimator itself."""
    ok = np.isin(p.hour_class[p.pass_hour], list(classes))
    fence = fence_seg[p.pass_seg] & ok
    comp = far_seg[p.pass_seg] & ok & ~fence
    deltas: list[float] = []
    n_f = n_c = 0
    for key in np.unique(nights[fence]):
        fm = fence & (nights == key)
        cm = comp & (nights == key)
        if fm.sum() < MIN_FENCE_PER_NIGHT or cm.sum() < MIN_COMPARISON_PER_NIGHT:
            continue
        num = den = 0.0
        for cl in np.unique(p.seg_class[p.pass_seg[fm]]):
            fk = fm & (p.seg_class[p.pass_seg] == cl)
            ck = cm & (p.seg_class[p.pass_seg] == cl)
            if not fk.any() or not ck.any():
                continue
            num += fk.sum() * (p.value[fk].mean() - p.value[ck].mean())
            den += fk.sum()
        if den == 0:
            continue
        deltas.append(num / den)
        n_f += int(den)
        n_c += int(cm.sum())
    return np.array(deltas), n_f, n_c


def decoy_null(p: _Passes, measure: str, classes: str, *, n: int = DECOY_N, seed: int = 11) -> np.ndarray:
    """The same statistic around road clusters that are not next to anything.

    This is the gate. A fenceline excess that a random patch of road also
    produces is not a finding about the site, and unlike the touchdown's
    bearing rotation there is nothing here to rotate — so the null has to come
    from somewhere else being treated as if it were a fenceline.
    """
    nights = _night_keys(p.pass_ts)
    anyone = _distance_to_nearest(p, [pt for pts in p.site_points.values() for pt in pts])
    far = anyone >= COMPARISON_MIN_M
    rng = np.random.default_rng(seed)
    pool = np.flatnonzero(anyone >= COMPARISON_MIN_M + 500.0)
    out: list[float] = []
    for _ in range(n):
        if not pool.size:
            break
        i = int(rng.choice(pool))
        d = _haversine(p.seg_lon[i], p.seg_lat[i], p.seg_lon, p.seg_lat)
        decoy = (d <= FENCELINE_M) & far
        if decoy.sum() < 3:
            continue
        deltas, _nf, _nc = _paired_excess(p, nights, decoy, far, classes)
        if deltas.size >= MIN_EPISODES:
            out.append(float(deltas.mean()))
    return np.array(out)


def _cut_pct(line: float, level: float, excess: float) -> float | None:
    """Share of this site's own contribution that would have to go, 0-100.

    The load-agnostic form of the envelope, and the one that works for every
    site: Delta Forge is a metals works and Riverport a logistics terminal, so
    neither carries a megawatt rating, but both can be told how much of their
    own contribution the air has room for.
    """
    if excess <= 0.0:
        return None
    room = line - (level - excess)
    if room >= excess:
        return 0.0
    return round(100.0 * max(0.0, (excess - room)) / excess, 1)


def _headroom_mw(load_mw: float | None, line: float, level: float, excess: float) -> float | None:
    """Load at which the fenceline would reach `line`, in MW.

    A MODELLED extrapolation from a MEASURED slope, and it must be labelled as
    one wherever it is shown. The measurement is `excess` — how much of the
    fenceline level this site is responsible for right now. The model is the
    assumption that the site's contribution scales linearly with load, which is
    what the dispersion kernel does and what the generators' duty curve implies,
    but is not something the fleet observed.

        level(L') = (level - excess) + excess * L'/L

    Everything in `level` that is not `excess` — background, through traffic —
    is held fixed, because the site does not control it.
    """
    if load_mw is None or excess <= 0.0:
        return None
    fixed = level - excess
    room = line - fixed
    if room <= 0.0:
        return 0.0
    return round(load_mw * room / excess, 1)


def estimate(
    conn: sqlite3.Connection, p: _Passes, site_id: str, measure: str, unit: str,
    load_mw: float | None, action_levels: list[dict[str, Any]],
) -> Envelope:
    if site_id not in p.site_points:
        raise KeyError(site_id)
    nights = _night_keys(p.pass_ts)
    mine = _distance_to_nearest(p, p.site_points[site_id])
    anyone = _distance_to_nearest(p, [pt for pts in p.site_points.values() for pt in pts])
    fence_seg = mine <= FENCELINE_M
    far_seg = anyone >= COMPARISON_MIN_M
    floor = DECOY_FLOOR.get(measure)

    roads = sorted({p.seg_name[i] for i in np.flatnonzero(fence_seg) if p.seg_name[i]})
    hod = np.array([int(t[11:13]) for t in p.pass_ts])
    total_hours = len(p.hours) or 1

    out: list[RegimeEnvelope] = []
    for name, classes in REGIMES.items():
        deltas, n_f, n_c = _paired_excess(p, nights, fence_seg, far_seg, classes)
        in_regime = np.isin(p.hour_class[p.pass_hour], list(classes))
        on_fence = fence_seg[p.pass_seg] & in_regime
        levels = p.value[on_fence]
        share_hours = float(np.isin(p.hour_class, list(classes)).mean())
        hours = sorted({int(h) for h in hod[on_fence]})

        # Class-matched to the fenceline's own road-class mix. Comparing a
        # tertiary fenceline against a comparison pool that is mostly motorway
        # would show a deficit rather than an excess.
        fence_classes = set(np.unique(p.seg_class[p.pass_seg[on_fence]]).tolist())
        matched = (
            far_seg[p.pass_seg]
            & in_regime
            & ~fence_seg[p.pass_seg]
            & np.isin(p.seg_class[p.pass_seg], list(fence_classes))
        )
        comp_levels = p.value[matched]

        if deltas.size < MIN_EPISODES or levels.size == 0:
            out.append(RegimeEnvelope(
                regime=name, classes=classes, n_episodes=int(deltas.size),
                n_fenceline=n_f, n_comparison=n_c, excess=None, ci_lo=None, ci_hi=None,
                level_p50=None, level_p90=None, level_max=None,
                comparison_p50=None, comparison_p90=None, comparison_max=None,
                share_of_hours=round(share_hours, 4), hours_of_day=hours,
                state="insufficient",
            ))
            continue

        mean = float(deltas.mean())
        half = 1.96 * float(deltas.std(ddof=1)) / math.sqrt(deltas.size) if deltas.size > 1 else float("nan")
        p50, p90, pmax = (float(np.percentile(levels, q)) for q in (50, 90, 100))

        thresholds: list[Threshold] = []
        binding = False
        for al in action_levels:
            share = float((levels >= al["threshold"]).mean())
            thresholds.append(Threshold(
                action_level_id=al["id"], label=al["label"], threshold=al["threshold"],
                unit=al["unit"], severity=al["severity"], source=al["source"],
                share_over=round(share, 4),
                cut_pct_typical=_cut_pct(al["threshold"], p50, mean),
                cut_pct_bad_night=_cut_pct(al["threshold"], p90, mean),
                headroom_mw_typical=_headroom_mw(load_mw, al["threshold"], p50, mean),
                headroom_mw_bad_night=_headroom_mw(load_mw, al["threshold"], p90, mean),
            ))
            # Binding means the TYPICAL episode already needs a cut, not that a
            # single pass once crossed a line. Delta Forge clears 0.8% of its
            # stable passes over the watch level and still sits 34 ppb under it
            # at the median; calling that "binding" would put every site in the
            # same state and make the word useless.
            binding = binding or bool(thresholds[-1].cut_pct_typical)

        if floor is not None and abs(mean) < floor:
            state = "indistinct"
        elif binding:
            state = "binding"
        else:
            state = "elevated"

        out.append(RegimeEnvelope(
            regime=name, classes=classes, n_episodes=int(deltas.size),
            n_fenceline=n_f, n_comparison=n_c,
            excess=round(mean, 3),
            ci_lo=None if not math.isfinite(half) else round(mean - half, 3),
            ci_hi=None if not math.isfinite(half) else round(mean + half, 3),
            level_p50=round(p50, 2), level_p90=round(p90, 2), level_max=round(pmax, 2),
            comparison_p50=None if comp_levels.size == 0 else round(float(np.percentile(comp_levels, 50)), 2),
            comparison_p90=None if comp_levels.size == 0 else round(float(np.percentile(comp_levels, 90)), 2),
            comparison_max=None if comp_levels.size == 0 else round(float(comp_levels.max()), 2),
            share_of_hours=round(share_hours, 4), hours_of_day=hours,
            state=state, thresholds=thresholds,
        ))
    _ = total_hours
    return Envelope(
        site_id=site_id, measure=measure, unit=unit, load_mw=load_mw, decoy_floor=floor,
        fenceline_m=FENCELINE_M, n_fenceline_segments=int(fence_seg.sum()),
        fenceline_roads=roads,
        fenceline_segment_ids=[p.seg_ids[i] for i in np.flatnonzero(fence_seg)],
        comparison_segment_ids=[p.seg_ids[i] for i in np.flatnonzero(far_seg)],
        regimes=out,
    )


def load(conn: sqlite3.Connection, campaign_id: str, measure: str) -> _Passes:
    """Shares the touchdown loader — one projection of the passes, not two."""
    return load_passes(conn, campaign_id, measure)


def cached_null(conn: sqlite3.Connection, campaign_id: str, measure: str, classes: str) -> dict[str, float]:
    from air.server.touchdown import _db_path

    key = ("envelope_null", _db_path(conn), campaign_id, measure, classes, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    nulls = decoy_null(load(conn, campaign_id, measure), measure, classes)
    if nulls.size == 0:
        return cache.put(key, {"n": 0})
    return cache.put(key, {
        "n": int(nulls.size),
        "mean": round(float(nulls.mean()), 3),
        "sd": round(float(nulls.std(ddof=1)), 3) if nulls.size > 1 else None,
        "abs_max": round(float(np.abs(nulls).max()), 3),
        "p95_abs": round(float(np.percentile(np.abs(nulls), 95)), 3),
    })
