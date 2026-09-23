"""Step 5b -- aggregate `segment_pass` into `segment_stat`.

Three window families, all computed in one pass over the raw values:

* `'all'`               the whole campaign -- what the map shows by default
* `'date:YYYY-MM-DD'`   one calendar day -- the daily series on segment detail
* `'hour:HH'`           the diurnal composite, 00-23, pooled across all days

Only (segment, window) combinations that actually contain a pass are written, which
is both honest and the difference between a 45 MB database and a 300 MB one.

`persistence` is the share of valid passes above `measure_def.ref_level`: not a
health standard, but "how often is this street elevated".  `risk` is the 0-100
community-facing score from `measure_def.scale_json`, computed from the median.
"""

from __future__ import annotations

import warnings
from collections import defaultdict

import numpy as np

from .measures import (
    INDICATORS, MODALITIES, REF_LEVELS, SCALES, SENSE, SENSE_BETA, SENSE_K, UNITS,
)

# The `segment_pass` column contract. Must stay at ten: `vcols` below reads one
# physical column per entry, and `campaign_summary` does the same.
ORDER = list(MODALITIES) + list(INDICATORS)

# What actually gets a `segment_stat` row. The composite is derived from three
# of the columns above, so it rides along in the same matrix as an eleventh
# column without ever being read from a pass row.
STAT_ORDER = ORDER + [SENSE]

# The AQHI coefficients are per-ppb for the gases and per-ug/m3 for PM2.5. That
# is what `measures.UNITS` stores today, and nothing converts -- so a future edit
# to any of those three unit strings would silently change the index by orders of
# magnitude with no error anywhere. Fail the build instead.
_SENSE_UNITS = {"no2": "ppb", "o3": "ppb", "pm25": "ug/m3"}
for _m, _u in _SENSE_UNITS.items():
    if UNITS[_m] != _u:
        raise AssertionError(
            f"aclima_sense expects {_m} in {_u!r}, measure_def says {UNITS[_m]!r}. "
            "The AQHI coefficients are unit-specific; fix the unit or the coefficient."
        )

# The per-pass path is sound only while each term stays close to linear in its
# concentration. Curvature is what would reintroduce a selection bias -- the
# thing that makes a max composite read high. Measured at this campaign's p99
# concentrations the worst term is ~6 % above linear; fail well before that
# becomes the reason the number moved.
SENSE_CURVATURE_TOL = 0.15

# A per-day or per-hour statistic computed from one or two passes is degenerate --
# median == p10 == p90 == max, and persistence is 0 or 1. Real Aclima does not
# publish those, and they were 26 % of `segment_stat`. The 'all' window is always
# written, whatever its pass count, so no segment is ever missing from the map.
MIN_PASSES_DATE = 2
MIN_PASSES_HOUR = 4

# The composite deliberately rides the SAME floors as everything else.
#
# An earlier version gave it stricter ones (8/4/6), reasoning that a three-input
# index inherits the weakest of its inputs' pass counts. Measured, that inheritance
# is worth about 1 % -- MEASURE_DROP_RATE invalidates each channel independently, so
# 98.95 % of passes carry all three -- while the stricter floors cost far more than
# they bought: only 618 of 1,307 segments kept any `date:` row, against 1,307 for
# every real measure, so the daily series on segment detail was empty on more than
# half the streets in the campaign. A 1 % thinner sample does not justify a 53 %
# hole, and the degeneracy the floors exist to prevent (median == p10 == p90 on two
# passes) is not worse here than for any other measure.


def uniform_only(pass_cols, pass_rows):
    """Drop passes that were driven BECAUSE something was expected there.

    Every statistic in this module is either community-facing (the headline
    risk score) or a comparison between streets (the regulator's ranking, the
    worst/best lists). Both are only meaningful over passes chosen without
    reference to what they would find. Targeted driving biases a per-segment
    median upward by up to +57%, and by 2.66x on the worst near-source case
    from four passes — so without this filter the product's headline becomes a
    function of the dispatcher rather than of the air.

    **Currently inert**: the planner emits nothing but `uniform`, and will keep
    doing so until the Mission Brief (phase 9) starts dispatching. It is
    installed now because the guard has to exist before the thing it guards
    against, and because a rebuild was already happening.

    Tolerates a `pass_cols` without the column, so an older database still
    aggregates.
    """
    if "sampling_mode" not in pass_cols:
        return pass_rows
    k = list(pass_cols).index("sampling_mode")
    return [r for r in pass_rows if r[k] == "uniform"]


def risk_from_scale(value: float, scale) -> int:
    """Piecewise-linear concentration -> 0..100 risk. The reference implementation.

    The frontend must reproduce this exactly, so keep it dead simple: clamp at both
    ends, linear interpolation between breakpoints.
    """
    if value is None or not np.isfinite(value):
        return 0
    if value <= scale[0][0]:
        return int(round(scale[0][1]))
    for (x0, y0), (x1, y1) in zip(scale, scale[1:]):
        if value <= x1:
            t = 0.0 if x1 == x0 else (value - x0) / (x1 - x0)
            return int(round(y0 + (y1 - y0) * t))
    return int(round(scale[-1][1]))


def _risk_vec(vals: np.ndarray, scale) -> np.ndarray:
    xs = np.array([p[0] for p in scale], dtype=float)
    ys = np.array([p[1] for p in scale], dtype=float)
    return np.rint(np.interp(vals, xs, ys)).astype(int)


def _sense(no2: np.ndarray, o3: np.ndarray, pm25: np.ndarray) -> np.ndarray:
    """Aclima Sense, per pass. NaN wherever any of the three is missing.

    Additive excess-relative-risk, not a max and not a weighted mean of the
    `risk` ladders. Two reasons, both load-bearing:

    * The ladders in `SCALES` are not mutually calibrated -- `risk_from_scale`
      returns 92 for CO at its NAAQS, 59 for O3 at its NAAQS and 25 for PM2.5 at
      the annual NAAQS -- so a max or a mean across them is decided by ladder
      steepness rather than by air quality. Working from physical concentrations
      with jointly-estimated coefficients makes that whole class of error
      unreachable.
    * Computing per pass is what buys honest p10/p90/max and a `persistence`
      that has a definition at all. There is no selection bias to worry about,
      unlike a max: the max of N noisy draws is pulled upward on every single
      pass, whereas a sum is just a sum.

    IT DOES NOT COMMUTE WITH THE MEDIAN, and an earlier version of this design
    claimed it did. Measured on this campaign: the median of the per-pass index
    is 27.4 across segments, while the index evaluated at each pollutant's median
    is 20.4 -- a systematic 7-point gap, up to 17.6 on the worst street. The
    reason is not the curvature of expm1 (that is under 1 % here); it is that a
    median is not additive. NO2 and O3 are anti-correlated on this data
    (r = -0.62, from the titration term in `field`), so a pass with high NO2 has
    low O3 and vice versa -- most passes are elevated in *something*, while each
    pollutant's own median is mid. The sum of the medians is therefore a
    combination that no drive-by ever exhibited.

    Both numbers are defensible and they answer different questions. This one
    answers "what was in the air on a typical pass down this street", which is
    the only version for which p10, p90 and persistence mean anything. The
    consequence is that this index is NOT the AQHI of this street -- it is the
    AQHI arithmetic evaluated on instantaneous curbside air, which runs higher
    than the 3-hour averages the coefficients were fitted on. That has to be
    said wherever the number is shown; it is not a footnote.

    If this is ever changed to a max, or to anything strongly convex, the
    per-pass path silently acquires exactly the upward selection bias it does not
    have today. `_assert_sense_near_linear` is what catches that.

    A missing component drops the whole pass rather than renormalising over the
    survivors: each term is an absolute excess risk, not a share, so rescaling
    would invent risk. At MEASURE_DROP_RATE this costs ~1 % of passes.
    """
    ex = (
        np.expm1(SENSE_BETA["no2"] * no2)
        + np.expm1(SENSE_BETA["o3"] * o3)
        + np.expm1(SENSE_BETA["pm25"] * pm25)
    )
    return np.clip(SENSE_K * ex, 0.0, 100.0)


def _assert_sense_near_linear(vals: np.ndarray, si: dict):
    """Fail the build if the composite stops being near-linear in its inputs.

    Per-pass is safe because a sum has no selection bias. Curvature is what would
    change that: a strongly convex transform weights the spiky pass more than the
    quiet one, which is a max in slow motion. So measure the curvature at the
    concentrations this campaign actually produced, and refuse to build if the
    form has drifted far enough for that to be the reason the number moved.

    This deliberately does NOT check that the index commutes with the median --
    it does not, by 7 index points, and that is a property of medians rather than
    a defect. See `_sense`.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for m, beta in SENSE_BETA.items():
            x = float(np.nanpercentile(vals[:, si[m]], 99))
            if not np.isfinite(x) or x <= 0:
                continue
            lin = beta * x
            off = abs(float(np.expm1(lin)) - lin) / lin
            if off > SENSE_CURVATURE_TOL:
                raise AssertionError(
                    f"aclima_sense is no longer near-linear in {m}: {off:.1%} above linear "
                    f"at the p99 concentration ({x:.1f}), tolerance {SENSE_CURVATURE_TOL:.0%}. "
                    "A convex composite reintroduces the upward selection bias that per-pass "
                    "aggregation only avoids for additive forms."
                )


def build_segment_stats(segments, pass_cols, pass_rows, campaign_id: str):
    """Returns (columns, rows) for `segment_stat`. Uniform passes only."""
    pass_rows = uniform_only(pass_cols, pass_rows)
    if not pass_rows:
        return (), []
    ci = {c: i for i, c in enumerate(pass_cols)}
    seg_pos = {s.id: k for k, s in enumerate(segments)}

    n = len(pass_rows)
    seg = np.empty(n, dtype=np.int32)
    dates = np.empty(n, dtype=np.int32)
    hours = np.empty(n, dtype=np.int8)
    vals = np.full((n, len(STAT_ORDER)), np.nan, dtype=np.float64)
    date_list: list[str] = []
    date_ix: dict[str, int] = {}
    vcols = [ci[m] for m in ORDER]
    for i, r in enumerate(pass_rows):
        seg[i] = seg_pos[r[ci["segment_id"]]]
        ts = r[ci["ts"]]
        d = ts[:10]
        di = date_ix.get(d)
        if di is None:
            di = len(date_list)
            date_ix[d] = di
            date_list.append(d)
        dates[i] = di
        hours[i] = int(ts[11:13])
        for k, c in enumerate(vcols):
            v = r[c]
            if v is not None:
                vals[i, k] = v

    # The composite is an eleventh column computed from three of the ten, not an
    # eleventh thing the cars measured. `vcols` above still iterates ORDER, so
    # nothing in the fill loop knows about it.
    _si = {m: k for k, m in enumerate(ORDER)}
    vals[:, -1] = _sense(vals[:, _si["no2"]], vals[:, _si["o3"]], vals[:, _si["pm25"]])

    _assert_sense_near_linear(vals, _si)

    ref = np.array([REF_LEVELS[m] for m in STAT_ORDER], dtype=float)
    cols = (
        "segment_id", "campaign_id", "measure", "window",
        "n_passes", "mean", "median", "p10", "p90", "max", "persistence", "risk",
    )
    out: list[tuple] = []

    def emit(rows_idx: np.ndarray, seg_k: int, window: str, min_passes: int = 1):
        if min_passes > 1 and len(rows_idx) < min_passes:
            return
        block = vals[rows_idx]
        valid = ~np.isnan(block)
        counts = valid.sum(axis=0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(block, axis=0)
            q = np.nanpercentile(block, [10, 50, 90], axis=0)
            mx = np.nanmax(block, axis=0)
            pers = np.nansum(block > ref[None, :], axis=0) / np.maximum(1, counts)
        sid = segments[seg_k].id
        for k, m in enumerate(STAT_ORDER):
            if counts[k] < min_passes:
                continue
            med = float(q[1, k])
            out.append(
                (
                    sid, campaign_id, m, window, int(counts[k]),
                    round(float(mean[k]), 4), round(med, 4),
                    round(float(q[0, k]), 4), round(float(q[2, k]), 4),
                    round(float(mx[k]), 4), round(float(pers[k]), 4),
                    risk_from_scale(med, SCALES[m]),
                )
            )

    order_all = np.argsort(seg, kind="stable")
    _for_groups(order_all, seg, lambda idx, key: emit(idx, key, "all"))

    key_date = seg.astype(np.int64) * 10000 + dates
    order_d = np.lexsort((dates, seg))
    _for_groups(order_d, key_date, lambda idx, key: emit(
        idx, int(key // 10000), f"date:{date_list[int(key % 10000)]}", MIN_PASSES_DATE))

    key_hour = seg.astype(np.int64) * 100 + hours
    order_h = np.lexsort((hours, seg))
    _for_groups(order_h, key_hour, lambda idx, key: emit(
        idx, int(key // 100), f"hour:{int(key % 100):02d}", MIN_PASSES_HOUR))

    return cols, out


def _for_groups(order: np.ndarray, key: np.ndarray, fn):
    k = key[order]
    if len(k) == 0:
        return
    bounds = np.flatnonzero(np.diff(k)) + 1
    for chunk in np.split(order, bounds):
        fn(chunk, key[chunk[0]])


def campaign_summary(pass_cols, pass_rows) -> dict:
    """Campaign-wide distribution per measure. Uniform passes only."""
    pass_rows = uniform_only(pass_cols, pass_rows)
    ci = {c: i for i, c in enumerate(pass_cols)}
    out: dict[str, dict] = {}
    for m in ORDER:
        col = ci[m]
        v = np.array([r[col] for r in pass_rows if r[col] is not None], dtype=float)
        if not len(v):
            continue
        out[m] = {
            "n": int(len(v)),
            "p05": round(float(np.percentile(v, 5)), 3),
            "p50": round(float(np.percentile(v, 50)), 3),
            "p90": round(float(np.percentile(v, 90)), 3),
            "p99": round(float(np.percentile(v, 99)), 3),
            "max": round(float(v.max()), 3),
        }
    return out


def district_rollup(segments, pass_cols, pass_rows) -> dict:
    """Median NO2 per district — a comparison BETWEEN places, so uniform only."""
    pass_rows = uniform_only(pass_cols, pass_rows)
    ci = {c: i for i, c in enumerate(pass_cols)}
    by = defaultdict(list)
    dist = {s.id: s.district for s in segments}
    col = ci["no2"]
    for r in pass_rows:
        if r[col] is not None:
            by[dist.get(r[ci["segment_id"]])].append(r[col])
    return {
        k: round(float(np.median(v)), 2)
        for k, v in sorted(by.items(), key=lambda kv: -np.median(kv[1]))
    }
