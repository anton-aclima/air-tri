"""Street statistics over a window that ENDS AT THE MOMENT SHOWN.

The stored windows in `segment_stat` are calendar families — the whole
campaign, one day, one hour of the day — and none of them has an end that can
be put at the time cursor. `date:<day>` in replay holds the whole day, passes
after the moment shown included (at Aug 24 06:00 it drew 511 streets; nothing
had been driven since Aug 15 20:30), and a day is one shift at most: the fleet
drives Mon-Sat with an off-week (`driveplan.is_drive_day`), so 29 of the ~90
days have nothing on them and the median driven day is 367 of 1,307 streets.
That is why the regulator's map was mostly dark.

Two windows computed here instead, both bounded by `at` (`domain.as_of`):

    trailing:<N>h   passes with  at - N h  <  ts  <=  at
    todate          passes with                ts  <=  at

THE STATISTICS ARE THE STORED ONES
----------------------------------
`air.datagen.stats.build_segment_stats` is the reference, and this module is
held to it by tests/test_passwindow.py: `todate` at the end of the data is the
stored `'all'` window, field by field, on every street and every measure.
What makes that exact rather than close:

* uniform passes only (`stats.uniform_only`), as every stored row;
* `aclima_sense` per pass, from `stats._sense` itself, NaN when any of its
  three inputs is missing, then aggregated like any other column;
* p10/p50/p90 through `np.percentile` on each street's values — the same
  `linear` method `np.nanpercentile` runs per column in the builder. Streets
  are grouped by pass count so each call is one vectorised matrix, and a row
  of an (k, n) matrix goes through numpy's `_quantile` with the same n, so the
  interpolation is bitwise the one the builder did;
* `persistence` = valid passes above `measure_def.ref_level` / valid passes;
  `risk` = `stats.risk_from_scale(median, measure_def.scale)` on the
  unrounded median; everything else rounded to 4 dp, as stored.

`ref_level` and `scale` are read from this database's `measure_def` (the
builder wrote them from the same constants it aggregated with), falling back
to `air.datagen.measures` for a database without them. Nothing here needs
campaign context beyond that, so no field is ever null that the stored row
would carry. `n_passes` is per measure — the valid values of THAT column — as
stored; a pass whose NO2 was dropped is not an NO2 pass.

Every street with at least one valid pass in the window is served. The stored
day floor (`MIN_PASSES_DATE = 2`) exists because a published per-day
statistic from one pass is degenerate; here the window is the moment's
record, and a street driven once is measured once — the caller's
`min_passes` still applies, and `/segments` defaults it to 1.

ONE STREET, AS OF A MOMENT
--------------------------
`street()` is the same thing for `GET /segments/{id}?at=`: the stored
families that street's detail draws — `'all'`, the `date:` series and the
`hour:` profile — recomputed from its passes with `ts <= at`, with the
builder's floors, so at the end of the data it is the stored rows exactly.

THE PASSES
----------
Held once per database as sorted numpy columns (56,673 rows on the pinned
build, ~5 MB), keyed on a signature of `segment_pass` rather than on
`cache.version()`: a report or an acknowledgement bumps the version and does
not touch a pass, whereas `sim.methane_leak` does insert passes and changes the
signature. A window is then two `searchsorted`s and one sort.
"""

from __future__ import annotations

import re
import sqlite3
import threading
import warnings
from dataclasses import dataclass
from datetime import timedelta

import numpy as np
from fastapi import HTTPException

from air.datagen import stats as dstats
from air.datagen.measures import REF_LEVELS, SCALES, SENSE
from air.server import domain, timeutil

TODATE = "todate"
_TRAILING = re.compile(r"trailing:([1-9][0-9]{0,4})h")

#: A trailing window longer than this is a typo, not a request: the campaign is
#: ~90 days, so anything past a year is `todate` spelt wrongly.
MAX_TRAILING_H = 24 * 366

#: The stored families `/segments` looks up in `segment_stat` as before.
STORED_FAMILIES = ("date:", "hour:", "week:")


@dataclass(frozen=True)
class Window:
    """A computed window: passes with `lo < ts <= hi` (`lo` None = the start)."""

    name: str
    hours: int | None
    lo: str | None
    hi: str


def is_computed(window: str) -> bool:
    return window == TODATE or window.startswith("trailing:")


def check_stored(window: str) -> None:
    """422 for a window that is neither computed nor a stored family. A stored
    key with no rows (a day nobody drove) is still a 200 with no features."""
    if window == "all" or any(window.startswith(f) and len(window) > len(f) for f in STORED_FAMILIES):
        return
    raise HTTPException(
        422,
        "window must be 'all', 'date:YYYY-MM-DD', 'hour:HH', 'trailing:<N>h' or 'todate'",
    )


def resolve(conn: sqlite3.Connection, cid: str, window: str, at: str | None) -> Window:
    """`window` + `at` -> the bounds. `at` through `domain.as_of`: none is the
    end of the data, past the end is the end, garbage is a 422."""
    hi = domain.as_of(conn, cid, at)
    if window == TODATE:
        return Window(TODATE, None, None, hi)
    m = _TRAILING.fullmatch(window)
    if m is None or int(m.group(1)) > MAX_TRAILING_H:
        raise HTTPException(
            422, f"window must be 'trailing:<N>h' with 1 <= N <= {MAX_TRAILING_H}, or 'todate': {window!r}"
        )
    hours = int(m.group(1))
    dt = timeutil.parse(hi)
    assert dt is not None  # `hi` came through `as_of`
    return Window(f"trailing:{hours}h", hours, timeutil.iso(dt - timedelta(hours=hours)), hi)


# ── the passes ───────────────────────────────────────────────────────────────


class _Passes:
    """Uniform passes of one campaign, sorted by (ts, id), as columns."""

    def __init__(self, conn: sqlite3.Connection, cid: str):
        have = {r[1] for r in conn.execute("PRAGMA table_info(segment_pass)")}
        cols = [c for c in dstats.ORDER if c in have]
        where = "campaign_id = ?" + (" AND sampling_mode = 'uniform'" if "sampling_mode" in have else "")
        got = conn.execute(
            f"SELECT segment_id, ts, {', '.join(cols)} FROM segment_pass "  # noqa: S608 - columns from dstats.ORDER
            f"WHERE {where} ORDER BY ts, id",
            (cid,),
        ).fetchall()
        known = [r[0] for r in conn.execute("SELECT id FROM road_segment WHERE campaign_id=? ORDER BY id", (cid,))]
        index = {s: i for i, s in enumerate(known)}
        for r in got:
            if r[0] not in index:
                index[r[0]] = len(known)
                known.append(r[0])
        self.seg_ids: list[str] = known
        self.index: dict[str, int] = index
        n = len(got)
        self.seg = np.fromiter((index[r[0]] for r in got), dtype=np.int32, count=n)
        self.ts = np.array([r[1] for r in got], dtype=str) if n else np.array([], dtype="<U19")
        self.vals: dict[str, np.ndarray] = {}
        for k, c in enumerate(cols):
            self.vals[c] = np.fromiter(
                (np.nan if r[2 + k] is None else r[2 + k] for r in got), dtype=np.float64, count=n
            )
        if all(m in self.vals for m in ("no2", "o3", "pm25")):
            # The builder's own composite, per pass (`stats._sense`).
            self.vals[SENSE] = dstats._sense(self.vals["no2"], self.vals["o3"], self.vals["pm25"])

    def span(self, w: Window) -> tuple[int, int]:
        lo = 0 if w.lo is None else int(np.searchsorted(self.ts, w.lo, side="right"))
        hi = int(np.searchsorted(self.ts, w.hi, side="right"))
        return lo, max(lo, hi)


_LOCK = threading.Lock()
_PASSES: dict[tuple, _Passes] = {}


def _signature(conn: sqlite3.Connection, cid: str) -> tuple:
    """Everything that changes the passes, read without a scan: the rowid
    ceiling (AUTOINCREMENT, so an insert always raises it and a delete-and-
    reinsert never reuses it), the campaign's newest pass (ix_pass_time), the
    build instant and the file. A COUNT(*) here was 5 ms of every request."""
    db = conn.execute("PRAGMA database_list").fetchone()
    top, last = conn.execute(
        "SELECT (SELECT MAX(id) FROM segment_pass), "
        "(SELECT MAX(ts) FROM segment_pass WHERE campaign_id = ?)",
        (cid,),
    ).fetchone()
    return (str(db[2]) if db else "", cid, timeutil.now_iso(), top, last)


def passes(conn: sqlite3.Connection, cid: str) -> _Passes:
    sig = _signature(conn, cid)
    with _LOCK:
        hit = _PASSES.get(sig)
    if hit is not None:
        return hit
    p = _Passes(conn, cid)
    with _LOCK:
        # One database, one campaign at a time; a test run touches two at most.
        while len(_PASSES) >= 2:
            _PASSES.pop(next(iter(_PASSES)))
        _PASSES[sig] = p
    return p


def _mdef(conn: sqlite3.Connection, measure: str) -> tuple[float, list]:
    """(ref_level, scale) as this database's `measure_def` holds them."""
    d = domain.measures(conn).get(measure) or {}
    ref = d.get("ref_level")
    scale = d.get("scale")
    return (
        float(ref) if ref is not None else float(REF_LEVELS.get(measure, np.inf)),
        scale or SCALES.get(measure) or [[0, 0], [1, 100]],
    )


# ── the answers ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Stat:
    segment_id: str
    n_passes: int
    median: float
    p10: float
    p90: float
    max: float
    persistence: float
    risk: int


def stats(conn: sqlite3.Connection, cid: str, measure: str, w: Window) -> list[Stat]:
    """One row per street with at least one valid `measure` pass in `w`, as
    `build_segment_stats` would have written it for that set of passes.
    Unordered. A measure the cars do not carry has no rows."""
    p = passes(conn, cid)
    col = p.vals.get(measure)
    if col is None:
        return []
    lo, hi = p.span(w)
    v = col[lo:hi]
    s = p.seg[lo:hi]
    ok = ~np.isnan(v)
    v, s = v[ok], s[ok]
    if not len(v):
        return []
    ref, scale = _mdef(conn, measure)
    return [Stat(p.seg_ids[g[0]], *g[1:]) for g in _aggregate(v, s, ref, scale)]


def _aggregate(v: np.ndarray, s: np.ndarray, ref: float, scale: list) -> list[tuple]:
    """Valid values `v` grouped by the integer key `s` -> one tuple per group,
    ascending by key: (key, n_passes, median, p10, p90, max, persistence,
    risk), each exactly as `build_segment_stats` emits it for that group."""
    order = np.lexsort((v, s))
    v, s = v[order], s[order]
    starts = np.r_[0, np.flatnonzero(np.diff(s)) + 1]
    ends = np.r_[starts[1:], len(s)]
    counts = ends - starts
    above = np.add.reduceat((v > ref).astype(np.int64), starts)
    pers = above / np.maximum(1, counts)
    mx = v[ends - 1]
    q = np.empty((3, len(starts)), dtype=np.float64)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for n in np.unique(counts):
            gi = np.flatnonzero(counts == n)
            mat = v[starts[gi][:, None] + np.arange(n)[None, :]]
            q[:, gi] = np.percentile(mat, [10, 50, 90], axis=1)
    out: list[tuple] = []
    for g in range(len(starts)):
        med = float(q[1, g])
        out.append((
            int(s[starts[g]]),
            int(counts[g]),
            round(med, 4),
            round(float(q[0, g]), 4),
            round(float(q[2, g]), 4),
            round(float(mx[g]), 4),
            round(float(pers[g]), 4),
            dstats.risk_from_scale(med, scale),
        ))
    return out


# ── one street, as of a moment ───────────────────────────────────────────────


@dataclass(frozen=True)
class Street:
    """One street's stored families recomputed from its passes with
    `ts <= at`, in the shapes `GET /segments/{id}` serves them."""

    stats: dict[str, dict]
    daily: dict[str, list[dict]]
    diurnal: dict[str, list[dict]]


def street(conn: sqlite3.Connection, cid: str, segment_id: str, at: str) -> Street:
    """`'all'`, `date:<day>` and `hour:<HH>` for one street, from its uniform
    passes at or before `at` — what `build_segment_stats` would have written
    had the campaign ended at `at`. Same floors (a day needs
    `MIN_PASSES_DATE` valid passes of the measure, an hour of the day
    `MIN_PASSES_HOUR`, `'all'` one), same statistics (`_aggregate`), so at
    the end of the data this is the stored rows, value for value
    (tests/test_passwindow.py). Before it, no later pass contributes: the
    stored `hour:` profile of a ring street at Jul 4 19:00 is ~75 % passes
    from after that moment."""
    p = passes(conn, cid)
    hi = int(np.searchsorted(p.ts, at, side="right"))
    k = p.index.get(segment_id)
    idx = np.flatnonzero(p.seg[:hi] == k) if k is not None else np.array([], dtype=np.int64)
    ts = p.ts[idx].tolist()
    days, day_key = np.unique(np.array([t[:10] for t in ts], dtype="<U10"), return_inverse=True)
    hour_key = np.array([int(t[11:13]) for t in ts], dtype=np.int64)
    stats_: dict[str, dict] = {}
    daily: dict[str, list[dict]] = {}
    diurnal: dict[str, list[dict]] = {}
    for m, col in p.vals.items():
        v = col[idx]
        ok = ~np.isnan(v)
        if not ok.any():
            continue
        v = v[ok]
        ref, scale = _mdef(conn, m)
        (_, n, med, p10, p90, mx, pers, risk), = _aggregate(v, np.zeros(len(v), dtype=np.int64), ref, scale)
        stats_[m] = {
            "median": med, "p10": p10, "p90": p90, "max": mx,
            "persistence": pers, "risk": risk, "n_passes": n,
        }
        d = [
            {"t": str(days[g[0]]), "v": g[2]}
            for g in _aggregate(v, day_key[ok].astype(np.int64), ref, scale)
            if g[1] >= dstats.MIN_PASSES_DATE
        ]
        if d:
            daily[m] = d
        h = [
            {"t": f"{g[0]:02d}", "v": g[2]}
            for g in _aggregate(v, hour_key[ok], ref, scale)
            if g[1] >= dstats.MIN_PASSES_HOUR
        ]
        if h:
            diurnal[m] = h
    return Street(stats_, daily, diurnal)


_MEDIANS: dict[tuple, np.ndarray] = {}


def medians(conn: sqlite3.Connection, cid: str, measure: str, w: Window) -> np.ndarray:
    """Every street's `measure` median over `w` (`stats`), sorted — what a
    street's `rank_pct` is counted against. Held per window: the next click
    at the same moment asks for the same array, and the eleven measures cost
    ~160 ms to compute."""
    key = (_signature(conn, cid), measure, w.lo, w.hi)
    with _LOCK:
        hit = _MEDIANS.get(key)
    if hit is not None:
        return hit
    arr = np.sort(np.array([st.median for st in stats(conn, cid, measure, w)], dtype=np.float64))
    with _LOCK:
        while len(_MEDIANS) >= 64:
            _MEDIANS.pop(next(iter(_MEDIANS)))
        _MEDIANS[key] = arr
    return arr


def measured(conn: sqlite3.Connection, cid: str, measure: str, w: Window) -> set[str]:
    """The streets `/segments?window=<w>` serves for `measure` (at the default
    `min_passes`): at least one valid pass of that measure in the window."""
    p = passes(conn, cid)
    col = p.vals.get(measure)
    if col is None:
        return set()
    lo, hi = p.span(w)
    s = p.seg[lo:hi][~np.isnan(col[lo:hi])]
    return {p.seg_ids[int(i)] for i in np.unique(s)}


def last_pass_at(conn: sqlite3.Connection, cid: str, measure: str, at: str) -> str | None:
    """The latest pass at or before `at` that measured `measure` — the pass
    the map could show last, so "no passes in the window" and this being at
    or before the window's start are the same statement."""
    p = passes(conn, cid)
    col = p.vals.get(measure)
    if col is None:
        return None
    hi = int(np.searchsorted(p.ts, at, side="right"))
    ok = np.flatnonzero(~np.isnan(col[:hi]))
    return str(p.ts[ok[-1]]) if len(ok) else None
