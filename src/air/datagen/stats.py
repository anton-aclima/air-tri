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

from .measures import INDICATORS, MODALITIES, REF_LEVELS, SCALES

ORDER = list(MODALITIES) + list(INDICATORS)

# A per-day or per-hour statistic computed from one or two passes is degenerate --
# median == p10 == p90 == max, and persistence is 0 or 1. Real Aclima does not
# publish those, and they were 26 % of `segment_stat`. The 'all' window is always
# written, whatever its pass count, so no segment is ever missing from the map.
MIN_PASSES_DATE = 2
MIN_PASSES_HOUR = 4


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


def build_segment_stats(segments, pass_cols, pass_rows, campaign_id: str):
    """Returns (columns, rows) for `segment_stat`."""
    if not pass_rows:
        return (), []
    ci = {c: i for i, c in enumerate(pass_cols)}
    seg_pos = {s.id: k for k, s in enumerate(segments)}

    n = len(pass_rows)
    seg = np.empty(n, dtype=np.int32)
    dates = np.empty(n, dtype=np.int32)
    hours = np.empty(n, dtype=np.int8)
    vals = np.full((n, len(ORDER)), np.nan, dtype=np.float64)
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

    ref = np.array([REF_LEVELS[m] for m in ORDER], dtype=float)
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
        for k, m in enumerate(ORDER):
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
