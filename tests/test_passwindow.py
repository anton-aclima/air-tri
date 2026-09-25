"""`/segments?window=trailing:<N>h|todate&at=` — street windows that end at the moment shown.

The regulator's map was mostly dark because it drew the calendar day's stored
aggregate: a day is one shift at most, 29 of the 90 days had no driving, and in
replay a `date:` window held passes from after the moment shown. The computed
windows (`passwindow.py`) replace it there. What these tests hold:

* the statistics ARE the stored ones — `todate` at the end of the data equals
  the stored `'all'` window on every street, every measure, every field;
* a computed window never contains a pass after `at` (checked against SQL,
  an independent count, at a moment in the middle of a drive);
* the off-week reads as it is: nothing in the 7 days to Aug 24 06:00, and the
  last pass is Aug 15 20:30:11;
* the stored path is unchanged, and garbage is a 422 rather than an empty map;
* `/segments/{id}?at=` is the same street detail from passes with `ts <= at`
  (SQL oracle on one street), and at the end of the data it is the stored one.
"""

from __future__ import annotations

import sqlite3
import statistics
from typing import Any

import pytest

from air.server import passwindow, timeutil

pytestmark = pytest.mark.needs_db

CID = "cmp-swmem-2026"
PROPS = ("median", "p90", "max", "persistence", "risk", "n_passes")


def _segs(client, api, json_ok, **params: Any) -> dict[str, Any]:
    params.setdefault("limit", 60000)
    return json_ok(client.get(f"{api}/segments", params=params))


def _by_id(fc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {f["id"]: f["properties"] for f in fc["features"]}


def _measures(db: sqlite3.Connection) -> list[str]:
    return [r[0] for r in db.execute("SELECT code FROM measure_def ORDER BY code")]


# ── the statistics are the stored ones ───────────────────────────────────────


def test_todate_at_the_end_is_the_stored_all_window(db) -> None:
    """Every street, every measure, every stored field, exactly: the 'all' row
    `build_segment_stats` wrote and the `todate` row computed now from the
    same passes. This is what licenses drawing the two with one ramp."""
    w = passwindow.resolve(db, CID, "todate", None)
    compared = 0
    for m in _measures(db):
        got = {s.segment_id: s for s in passwindow.stats(db, CID, m, w)}
        want = {
            r["segment_id"]: r
            for r in db.execute(
                "SELECT * FROM segment_stat WHERE campaign_id=? AND measure=? AND window='all'", (CID, m)
            )
        }
        assert set(got) == set(want), (m, len(got), len(want))
        for sid, r in want.items():
            g = got[sid]
            for f in ("n_passes", "median", "p10", "p90", "max", "persistence", "risk"):
                assert getattr(g, f) == r[f], (m, sid, f, getattr(g, f), r[f])
            compared += 1
    assert compared >= 1307 * 10


@pytest.mark.parametrize("measure", ["no2", "aclima_sense"])
def test_the_endpoint_serves_them(client, api, json_ok, measure) -> None:
    """The wire, not only the module: `window=todate` with no `at` and the
    stored `window=all` are the same features with the same properties."""
    todate = _segs(client, api, json_ok, window="todate", measure=measure)
    stored = _segs(client, api, json_ok, window="all", measure=measure)
    a, b = _by_id(todate), _by_id(stored)
    assert set(a) == set(b) and len(a) == 1307
    for sid in a:
        for k in (*PROPS, "value", "name", "road_class", "district", "length_m"):
            assert a[sid][k] == b[sid][k], (measure, sid, k)
    geo_a = {f["id"]: f["geometry"] for f in todate["features"]}
    assert all(geo_a[f["id"]] == f["geometry"] for f in stored["features"])
    assert "window" not in stored, "the stored path's body is unchanged"
    assert set(todate["window"]) == {"name", "from", "to", "last_pass_at"}


# ── bounded by `at` ──────────────────────────────────────────────────────────


def _mid_drive(db: sqlite3.Connection) -> str:
    """A moment inside a shift: the median pass. Passes follow it within
    minutes, so a window that leaked would show."""
    n = db.execute("SELECT COUNT(*) FROM segment_pass WHERE campaign_id=?", (CID,)).fetchone()[0]
    return db.execute(
        "SELECT ts FROM segment_pass WHERE campaign_id=? ORDER BY ts LIMIT 1 OFFSET ?", (CID, n // 2)
    ).fetchone()[0]


@pytest.mark.parametrize("window", ["trailing:1h", "trailing:24h", "trailing:168h", "todate"])
def test_a_computed_window_never_includes_a_pass_after_at(client, api, json_ok, db, window) -> None:
    """Per street, `n_passes` and `max` are the SQL count and max over
    `lo < ts <= at` — an oracle that shares no code with `passwindow` — at a
    moment in the middle of a drive, where the same day's stored `date:`
    window demonstrably holds passes after it."""
    at = _mid_drive(db)
    later = db.execute(
        "SELECT COUNT(*) FROM segment_pass WHERE campaign_id=? AND ts > ? AND substr(ts,1,10) = ?",
        (CID, at, at[:10]),
    ).fetchone()[0]
    assert later > 0, "the moment must have passes after it on the same day"
    fc = _segs(client, api, json_ok, window=window, at=at)
    assert fc["window"]["to"] == at
    lo = fc["window"]["from"] or ""
    oracle = {
        r[0]: (r[1], r[2])
        for r in db.execute(
            "SELECT segment_id, COUNT(no2), MAX(no2) FROM segment_pass "
            "WHERE campaign_id=? AND sampling_mode='uniform' AND ts > ? AND ts <= ? AND no2 IS NOT NULL "
            "GROUP BY segment_id",
            (CID, lo, at),
        )
    }
    got = _by_id(fc)
    assert set(got) == set(oracle), window
    for sid, p in got.items():
        assert p["n_passes"] == oracle[sid][0], (window, sid)
        assert p["max"] == round(oracle[sid][1], 4), (window, sid)
    last = fc["window"]["last_pass_at"]
    assert last is not None and last <= at


def test_trailing_week_at_aug_24_is_empty(client, api, json_ok, pinned_build) -> None:
    """The off-week: nothing driven Aug 16-23. The 7 days to Aug 24 06:00
    hold no pass — where the `date:2026-08-24` grid drew 511 streets from
    after the moment — and the last pass is Aug 15 20:30:11."""
    if not pinned_build:
        pytest.skip("pinned-build moment")
    fc = _segs(client, api, json_ok, window="trailing:168h", at="2026-08-24T06:00:00")
    assert fc["features"] == []
    assert fc["window"] == {
        "name": "trailing:168h", "from": "2026-08-17T06:00:00", "to": "2026-08-24T06:00:00",
        "last_pass_at": "2026-08-15T20:30:11",
    }
    # The same moment, to date, still has the record before it.
    assert len(_segs(client, api, json_ok, window="todate", at="2026-08-24T06:00:00")["features"]) > 1000


def test_at_goes_through_as_of(client, api, json_ok) -> None:
    """No `at` is the end, a moment past the end is the end, a `Z` is dropped."""
    end = _segs(client, api, json_ok, window="trailing:24h")
    assert end["window"]["to"] == timeutil.now_iso()
    assert _segs(client, api, json_ok, window="trailing:24h", at="2027-01-01T00:00:00") == end
    z = _segs(client, api, json_ok, window="trailing:24h", at="2026-08-25T06:00:00Z")
    assert z["window"]["to"] == "2026-08-25T06:00:00"


# ── the stored path's parameters, on a computed window ──────────────────────


def test_min_passes_bbox_and_limit(client, api, json_ok, db) -> None:
    """`min_passes` defaults to 1 (a street with no pass is not in any
    window) and filters as stored; `bbox` filters on the midpoint BEFORE the
    limit; `limit` keeps the highest values, as `ORDER BY value DESC`."""
    q = {"window": "trailing:168h", "at": "2026-08-12T11:00:00"}
    base = _by_id(_segs(client, api, json_ok, **q))
    assert base == _by_id(_segs(client, api, json_ok, **q, min_passes=1))
    assert base == _by_id(_segs(client, api, json_ok, **q, min_passes=0))
    three = _by_id(_segs(client, api, json_ok, **q, min_passes=3))
    assert set(three) == {s for s, p in base.items() if p["n_passes"] >= 3} and len(three) < len(base)

    mid = {r[0]: (r[1], r[2]) for r in db.execute("SELECT id, mid_lon, mid_lat FROM road_segment")}
    lons = sorted(v[0] for v in mid.values())
    lats = sorted(v[1] for v in mid.values())
    box = (lons[len(lons) // 4], lats[len(lats) // 4], lons[len(lons) // 2], lats[len(lats) // 2])
    boxed = _by_id(_segs(client, api, json_ok, **q, bbox=",".join(map(str, box)), limit=50))
    inside = {s for s in base if box[0] <= mid[s][0] <= box[2] and box[1] <= mid[s][1] <= box[3]}
    assert set(boxed) <= inside and len(boxed) == min(50, len(inside))

    top = _segs(client, api, json_ok, **q, limit=10)["features"]
    vals = [f["properties"]["value"] for f in top]
    assert len(top) == 10 and vals == sorted(vals, reverse=True)
    assert vals == sorted((p["median"] for p in base.values()), reverse=True)[:10]


def test_the_cache_is_keyed_on_the_moment_and_pollutant(client, api) -> None:
    """A repeat is a hit with the same bytes; another moment or another
    pollutant is a miss — a pollutant switch never gets the last one's streets."""
    q = {"window": "trailing:24h", "at": "2026-07-04T19:00:00", "measure": "no2"}
    a = client.get(f"{api}/segments", params=q)
    b = client.get(f"{api}/segments", params=q)
    assert b.headers["x-air-cache"] == "hit" and a.content == b.content
    c = client.get(f"{api}/segments", params={**q, "at": "2026-07-04T20:00:00"})
    d = client.get(f"{api}/segments", params={**q, "measure": "pm25"})
    assert c.headers["x-air-cache"] == "miss" and d.headers["x-air-cache"] == "miss"
    assert d.content != a.content


# ── 422 ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "params",
    [
        {"window": "garbage"},
        {"window": "trailing:"},
        {"window": "trailing:0h"},
        {"window": "trailing:-5h"},
        {"window": "trailing:1.5h"},
        {"window": "trailing:168"},
        {"window": "trailing:7d"},
        {"window": f"trailing:{passwindow.MAX_TRAILING_H + 1}h"},
        {"window": "date:"},
        {"window": "todate", "at": "garbage"},
        {"window": "trailing:24h", "at": "2026-13-45T99:00:00"},
    ],
)
def test_garbage_is_a_422(client, api, params) -> None:
    r = client.get(f"{api}/segments", params=params)
    assert r.status_code == 422, (params, r.status_code, r.text[:200])
    assert "json" in r.headers.get("content-type", "")


def test_a_stored_window_ignores_at(client, api, json_ok) -> None:
    """Stored windows are unchanged: `at` is not theirs to read, garbage or not."""
    plain = _segs(client, api, json_ok, window="date:2026-08-25")
    assert _segs(client, api, json_ok, window="date:2026-08-25", at="garbage") == plain
    assert _segs(client, api, json_ok, window="date:2026-08-25", at="2026-08-25T06:00:00") == plain


# ── one street's detail, as of `at` ──────────────────────────────────────────


def _busiest_mid_record(db: sqlite3.Connection) -> tuple[str, str]:
    """The street with the most uniform NO2 passes, and the moment of its
    median pass: half its record is after it, so a leak would show."""
    sid = db.execute(
        "SELECT segment_id FROM segment_pass WHERE campaign_id=? AND sampling_mode='uniform' "
        "AND no2 IS NOT NULL GROUP BY segment_id ORDER BY COUNT(*) DESC, segment_id LIMIT 1",
        (CID,),
    ).fetchone()[0]
    tss = [r[0] for r in db.execute(
        "SELECT ts FROM segment_pass WHERE segment_id=? AND sampling_mode='uniform' ORDER BY ts", (sid,)
    )]
    return sid, tss[len(tss) // 2]


def test_segment_detail_at_never_includes_a_later_pass(client, api, json_ok, db) -> None:
    """`/segments/{id}?at=`: the stats, the per-day series and the
    hour-of-day profile against SQL over `ts <= at` — an oracle that shares
    no code with `passwindow` — on a street whose stored body holds passes
    after the moment. The floors are the builder's (a day 2 valid passes, an
    hour 4)."""
    sid, at = _busiest_mid_record(db)
    stored = json_ok(client.get(f"{api}/segments/{sid}"))
    got = json_ok(client.get(f"{api}/segments/{sid}", params={"at": at}))
    assert set(got) == set(stored), "same shape"
    assert got["n_passes"] < stored["n_passes"], "the moment must have passes after it"

    for m in ("no2", "pm25", "co2"):
        n, mx = db.execute(
            f"SELECT COUNT({m}), MAX({m}) FROM segment_pass "  # noqa: S608 - fixed names
            "WHERE segment_id=? AND sampling_mode='uniform' AND ts <= ?",
            (sid, at),
        ).fetchone()
        assert got["stats"][m]["n_passes"] == n and got["stats"][m]["max"] == round(mx, 4), m

    def groups(expr: str, floor: int) -> dict[str, float]:
        vals: dict[str, list[float]] = {}
        for k, v in db.execute(
            f"SELECT {expr}, no2 FROM segment_pass WHERE segment_id=? AND sampling_mode='uniform' "  # noqa: S608
            "AND ts <= ? AND no2 IS NOT NULL",
            (sid, at),
        ):
            vals.setdefault(k, []).append(v)
        return {k: statistics.median(v) for k, v in vals.items() if len(v) >= floor}

    for field, expr, floor in (("daily", "substr(ts,1,10)", 2), ("diurnal", "substr(ts,12,2)", 4)):
        want = groups(expr, floor)
        have = {p["t"]: p["v"] for p in got[field]["no2"]}
        assert set(have) == set(want), field
        for k, v in want.items():
            assert abs(have[k] - v) < 1e-4, (field, k, have[k], v)
    assert max(p["t"] for p in got["daily"]["no2"]) <= at[:10]
    assert got["diurnal"]["no2"] != stored["diurnal"]["no2"], "the stored profile holds later passes"

    first, last = db.execute(
        "SELECT MIN(ts), MAX(ts) FROM segment_pass WHERE segment_id=? AND ts <= ?", (sid, at)
    ).fetchone()
    assert (got["first_pass"], got["last_pass"]) == (first, last) and last <= at
    assert got["n_passes"] == max(s["n_passes"] for s in got["stats"].values())

    # The rank is against every street's median to that moment — the set
    # `/segments?window=todate&at=` draws.
    meds = [p["median"] for p in _by_id(_segs(client, api, json_ok, window="todate", at=at)).values()]
    below = sum(1 for v in meds if v <= got["stats"]["no2"]["median"])
    assert got["rank_pct"]["no2"] == round(100.0 * below / len(meds), 1)


def test_segment_detail_at_the_end_is_the_stored_body(client, api, json_ok, db) -> None:
    """At the end of the data every window-derived field computed from the
    passes is the stored row, on a spread of streets (every 13th, ~100) and
    the busiest one. No `at` is untouched; past the end is the end."""
    ids = [r[0] for r in db.execute("SELECT id FROM road_segment WHERE campaign_id=? ORDER BY id", (CID,))]
    sample = [*ids[::13], _busiest_mid_record(db)[0]]
    end = timeutil.now_iso()
    for sid in sample:
        stored = json_ok(client.get(f"{api}/segments/{sid}"))
        assert json_ok(client.get(f"{api}/segments/{sid}", params={"at": end})) == stored, sid
    sid = sample[-1]
    assert json_ok(client.get(f"{api}/segments/{sid}", params={"at": "2027-01-01T00:00:00"})) == json_ok(
        client.get(f"{api}/segments/{sid}")
    )


@pytest.mark.parametrize("at", ["garbage", "2026-13-45T99:00:00"])
def test_segment_detail_garbage_at_is_a_422(client, api, db, at) -> None:
    sid = db.execute("SELECT id FROM road_segment WHERE campaign_id=? LIMIT 1", (CID,)).fetchone()[0]
    r = client.get(f"{api}/segments/{sid}", params={"at": at})
    assert r.status_code == 422, (at, r.status_code, r.text[:200])
    assert "json" in r.headers.get("content-type", "")
