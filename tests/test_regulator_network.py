"""`GET /regulator/network` and R0 — one plume geometry for every "inside".

R0 (docs/PLAN-refocus.md section 3.3): point-in-polygon against the map's
plume put DRAQA's Riverport Road monitor inside Riverport Intermodal's plume
in 7 of 9 live alert hours, while the coverage model's cone masks put it
inside in 1 of 5 standard-level hours. Same wind row, same hour; the coverage
test was a single sigma_y wedge from the site's centroid, the map draws the
union of every release point's wedge, and the monitor sits 424 m from a site
whose points spread ~300 m across the wind. Everything now asks `plumegeom`,
and these tests hold the three surfaces to it:

* the network's `in_plume`, hour by hour, equals what `/coverage/interception`
  counts, for all four reference monitors;
* both equal a point-in-polygon on the ring `/wind/dispersion?outline=1`
  actually serves.

Then the contract shape, the as-of bounds, F7 (a site is named only when
`naming.py` links something the solid part of its outline reaches), and the
headline at three moments against the regulator never-say list.
"""

from __future__ import annotations

import re
from itertools import pairwise
from typing import Any

import numpy as np
import pytest

from air.server import coverage, naming, network, plumegeom

pytestmark = pytest.mark.needs_db

CID = "cmp-swmem-2026"
RIVERPORT_ROAD = "mon-ref-0034"

#: The three moments the task names: the end of the data, the Riverport Road
#: NO2 exceedance hour, and a quiet afternoon before any resident cluster.
END = None
EXCEEDANCE = "2026-08-25T06:00:00"
QUIET = "2026-06-02T14:00:00"
#: The episode the model puts under no plume (R0: 2 of the 9 alert hours).
UNPLUMED = "2026-08-24T06:00:00"


def _pip(pt: tuple[float, float], ring: list[list[float]]) -> bool:
    x, y = pt
    inside = False
    for (x1, y1), (x2, y2) in pairwise(ring):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


@pytest.fixture(scope="module")
def world(db) -> coverage._World:
    return coverage.load(db, CID)


@pytest.fixture(scope="module")
def per_hour(db, world) -> dict[str, dict[str, dict[str, int]]]:
    """{ts: {site: {monitor: part code}}} as `/coverage/interception` counts it."""
    ref = [i for i, m in enumerate(world.monitors) if m["grade"] == "reference"]
    out: dict[str, dict[str, dict[str, int]]] = {}
    for h, _merged, by_site in coverage._hourly_masks(world, world.mon_polar, len(world.monitors)):
        out[world.ts[h]] = {
            sid: {world.monitors[i]["id"]: int(codes[i]) for i in ref} for sid, codes in by_site.items()
        }
    return out


def _net(client, api, json_ok, at: str | None = None, **params: Any) -> dict[str, Any]:
    q = dict(params)
    if at is not None:
        q["at"] = at
    return json_ok(client.get(f"{api}/regulator/network", params=q))


# ── R0: one geometry ─────────────────────────────────────────────────────────


def test_network_in_plume_equals_interception_every_hour(db, world, per_hour) -> None:
    """Every hour of the record, all four reference monitors, all sites: the
    network's `in_plume` (`plumes_now` + `reference_codes`, what `_build`
    serves) is exactly what `/coverage/interception` counted. Summed back up
    it reproduces interception's inside/beyond hours per site to the hour."""
    ref = [m for m in world.monitors if m["grade"] == "reference"]
    assert len(ref) == 4
    got_in = {m["id"]: {} for m in ref}
    got_out = {m["id"]: {} for m in ref}
    n = 0
    for ts in world.ts:
        codes = network.reference_codes(world, network.plumes_now(db, CID, ts))
        for sid in set(codes) | set(per_hour[ts]):
            for k, m in enumerate(ref):
                mine = int(codes[sid][k]) if sid in codes else 0
                theirs = per_hour[ts].get(sid, {}).get(m["id"], 0)
                assert mine == theirs, (ts, sid, m["name"], mine, theirs)
                n += 1
                if mine == plumegeom.INSIDE:
                    got_in[m["id"]][sid] = got_in[m["id"]].get(sid, 0) + 1
                elif mine == plumegeom.BEYOND:
                    got_out[m["id"]][sid] = got_out[m["id"]].get(sid, 0) + 1
    assert n >= 2000 * 4
    counted = {i.monitor_id: i for i in coverage.interception(db, CID).reference}
    for m in ref:
        assert got_in[m["id"]] == counted[m["id"]].by_site_inside, m["name"]
        assert got_out[m["id"]] == counted[m["id"]].by_site_beyond, m["name"]


def test_the_endpoint_serves_that_in_plume(client, api, json_ok, per_hour) -> None:
    """The payload, not only the helper: at every 97th hour of the record plus
    the exceedance and the unplumed hour, `monitors[].in_plume` is the
    per-hour mask interception counted."""
    hours = sorted(per_hour)[::97] + [EXCEEDANCE, UNPLUMED]
    for ts in hours:
        j = _net(client, api, json_ok, ts)
        for m in j["monitors"]:
            served = {x["site_id"]: x["part"] for x in m["in_plume"]}
            want = {
                sid: plumegeom.PART_NAME[c[m["id"]]]
                for sid, c in per_hour[ts].items() if c.get(m["id"], 0)
            }
            assert served == want, (ts, m["name"])


def test_both_equal_the_ring_the_map_draws(client, api, json_ok, db, world, per_hour) -> None:
    """Point-in-polygon on the ring `/wind/dispersion?outline=1` SERVES. The
    frame test inverts the ring's own projection, so the only room for
    disagreement is the five-decimal rounding (~1 m); measured over all 2,150
    hours x 3 sites x 4 monitors on the pinned build it is none."""
    ref = [m for m in world.monitors if m["grade"] == "reference"]
    exceed = [
        r[0] for r in db.execute(
            "SELECT ts FROM monitor_reading WHERE monitor_id=? AND measure='no2' AND value>60 ORDER BY ts",
            (RIVERPORT_ROAD,),
        )
    ]
    hours = sorted(set(sorted(per_hour)[::41] + exceed))
    compared = 0
    for ts in hours:
        fc = json_ok(client.get(f"{api}/wind/dispersion", params={"at": ts, "outline": 1}))
        served: dict[tuple[str, str], int] = {}
        for f in fc["features"]:
            p = f["properties"]
            if p.get("kind") != "outline":
                continue
            for m in ref:
                if _pip((m["lon"], m["lat"]), f["geometry"]["coordinates"][0]):
                    served[(p["site_id"], m["id"])] = (
                        plumegeom.INSIDE if p["part"] == "inside" else plumegeom.BEYOND
                    )
        for sid in world.sites:
            for m in ref:
                assert served.get((sid, m["id"]), 0) == per_hour[ts].get(sid, {}).get(m["id"], 0), (
                    ts, sid, m["name"]
                )
                compared += 1
    assert compared > 500


def test_r0_the_riverport_road_record(db, per_hour, pinned_build) -> None:
    """The finding written into PLAN-refocus R0. The cone masks said 1 of 5
    standard-level hours and 3 of 17 watch-level hours; the drawn outline
    says 4 of 5 and 15 of 17, and the two it misses are Aug 24's episode,
    which no modelled plume is over. Pinned build only: another seed is
    another record, and the copy branches on state rather than on these."""
    if not pinned_build:
        pytest.skip("the R0 record is of the pinned build")

    def inside(level: float) -> tuple[int, int]:
        hs = [
            r[0] for r in db.execute(
                "SELECT ts FROM monitor_reading WHERE monitor_id=? AND measure='no2' AND value>? ORDER BY ts",
                (RIVERPORT_ROAD, level),
            )
        ]
        k = sum(per_hour[t].get("site-riverport", {}).get(RIVERPORT_ROAD) == plumegeom.INSIDE for t in hs)
        return k, len(hs)

    assert inside(100.0) == (4, 5)
    assert inside(60.0) == (15, 17)
    for t in ("2026-08-24T05:00:00", "2026-08-24T06:00:00"):
        assert all(RIVERPORT_ROAD not in {k for k, v in c.items() if v} for c in per_hour[t].values()), t


def test_interception_splits_inside_from_beyond(db) -> None:
    """CONTRACT 10b: nothing is judged from the beyond part. Ridgeline is 6 km
    from Riverport Road and Harbor Avenue, past every envelope, so all of its
    hours at those two are `beyond`; the split has to add back to `by_site`."""
    for i in coverage.interception(db, CID).reference:
        for sid, n in i.by_site.items():
            assert i.by_site_inside.get(sid, 0) + i.by_site_beyond.get(sid, 0) == n, (i.name, sid)
        assert i.hours_in_plume_inside <= i.hours_in_plume
        if i.monitor_id in (RIVERPORT_ROAD, "mon-ref-0058"):
            assert "site-ridgeline" not in i.by_site_inside, i.name


# ── contract ─────────────────────────────────────────────────────────────────


def test_contract_shape(client, api, json_ok) -> None:
    j = _net(client, api, json_ok)
    assert set(j) >= {
        "at", "measure", "basis", "headline", "numbers", "streets_window", "monitors", "plumes", "residents",
    }
    assert "streets_day" not in j, "the day grid is gone: the streets are one window ending at `at`"
    assert j["measure"] == "no2"
    assert isinstance(j["headline"], str) and j["headline"].endswith(".")
    assert "modelled" in j["basis"] and "measured" in j["basis"]
    assert set(j["numbers"]) == {"alerts_now", "monitors_reporting", "monitors_total", "street_km"}
    assert j["numbers"]["monitors_total"] == 4
    assert 0 <= j["numbers"]["monitors_reporting"] <= 4
    sw = j["streets_window"]
    assert set(sw) == {"kind", "hours", "from", "to", "last_pass_at"}
    assert sw["kind"] == network.STREETS_DEFAULT == "7d" and sw["hours"] == 168
    assert sw["to"] == j["at"]
    for t in (sw["from"], sw["to"], sw["last_pass_at"]):
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", t), t

    assert len(j["monitors"]) == 4
    for m in j["monitors"]:
        assert set(m) >= {
            "id", "name", "code", "lon", "lat", "status", "radius_m", "has_measure", "reading",
            "level", "over", "in_plume", "plume_share", "exceedance_hours_7d", "exceedance_level",
        }
        if m["reading"] is not None:
            assert set(m["reading"]) == {"value", "unit", "ts"}
        if m["level"] is not None:
            assert set(m["level"]) == {"name", "threshold", "averaging_hours", "ratio"}
            assert m["level"]["averaging_hours"] == 1.0
        if m["exceedance_level"] is not None:
            assert set(m["exceedance_level"]) == {"name", "threshold"}
        for x in m["in_plume"]:
            assert x["part"] in ("inside", "beyond")
        for x in m["plume_share"]:
            assert set(x) == {"site_id", "inside_pct", "beyond_pct"}
            assert 0.0 <= x["inside_pct"] <= 100.0 and 0.0 <= x["beyond_pct"] <= 100.0
        if not m["has_measure"]:
            assert m["reading"] is None and m["level"] is None and not m["over"]
            assert m["exceedance_level"] is None and m["exceedance_hours_7d"] == 0
        else:
            # NO2 has two 1-hour levels, so a channel always has one to count against.
            assert m["exceedance_level"] is not None

    for p in j["plumes"]:
        assert set(p) >= {
            "site_id", "name", "bearing_deg", "reach_m", "envelope_m", "stability", "touches",
            "streets_inside", "driven_share", "below_coverage_floor", "touchdown_state", "named",
        }
        assert set(p["touches"]) == {"monitor_ids", "streets_driven", "open_cluster_ids"}
        assert 0.0 <= p["driven_share"] <= 1.0
        assert p["below_coverage_floor"] == (p["touches"]["streets_driven"] < network.COVERAGE_FLOOR_STREETS)
        # The streets under the solid part whatever was driven: the driven
        # ones are a subset, and the share is of them.
        assert isinstance(p["streets_inside"], int) and p["streets_inside"] >= p["touches"]["streets_driven"]
        if p["streets_inside"]:
            assert p["driven_share"] == round(p["touches"]["streets_driven"] / p["streets_inside"], 3)
        else:
            assert p["driven_share"] == 0.0
    for r in j["residents"]:
        assert set(r) == {"cluster_id", "label", "count", "last_posted_at", "named_site_id", "kinds"}


def test_touches_read_only_the_solid_part(client, api, json_ok) -> None:
    """A monitor under the dashed part is in `in_plume` as `beyond` and never in
    `touches` (CONTRACT 10b)."""
    for at in (END, EXCEEDANCE, UNPLUMED, QUIET):
        j = _net(client, api, json_ok, at)
        for p in j["plumes"]:
            for m in j["monitors"]:
                parts = {x["site_id"]: x["part"] for x in m["in_plume"]}
                assert (m["id"] in p["touches"]["monitor_ids"]) == (parts.get(p["site_id"]) == "inside")


def test_a_monitor_without_the_channel_says_so(client, api, json_ok) -> None:
    """West Shelby Drive carries no NO2: `has_measure` false, never a zero."""
    j = _net(client, api, json_ok)
    west = next(m for m in j["monitors"] if m["name"] == "West Shelby Drive")
    assert west["has_measure"] is False and west["reading"] is None


def test_the_alarm_rule_uses_the_same_averaging_period(client, api, json_ok) -> None:
    """R3: hourly readings meet 1-hour levels only. Ozone's levels are 8-hour,
    so no ozone reading is ever `over` and no ozone level is attached. And
    `over` judges the reading shown against the tightest 1-hour level (the
    one `exceedance_level` names), nothing else; the ratio beside it is
    against `level`, which is over 1 exactly when the reading is over a
    level: the mark and the ratio can never disagree."""
    j = _net(client, api, json_ok, measure="o3")
    assert all(not m["over"] and m["level"] is None and m["exceedance_level"] is None for m in j["monitors"])
    for at in (END, EXCEEDANCE, UNPLUMED, QUIET):
        for m in _net(client, api, json_ok, at)["monitors"]:
            if m["reading"] is None or m["level"] is None:
                assert not m["over"], (at, m["name"])
                continue
            assert m["level"]["averaging_hours"] == network.READING_AVERAGING_H
            tight = m["exceedance_level"]["threshold"]
            v = m["reading"]["value"]
            # `over` is judged on the raw reading; `value` is it to 2 dp, so
            # only a reading within the rounding of the threshold can differ.
            if abs(v - tight) > 0.005:
                assert m["over"] == (v > tight), (at, m["name"])
            assert (m["level"]["ratio"] >= 1.0) if m["over"] else (m["level"]["ratio"] <= 1.0), (at, m["name"])


def test_the_ratio_is_against_the_highest_level_passed(client, api, json_ok, pinned_build) -> None:
    """D15 (owner, 2026-09-24: "Ratio seems like a better report"). At the
    exceedance hour Riverport Road's reading is over both NO2 1-hour levels,
    and its ratio is against the higher one, the standard the headline and
    the Alerts page name (1.21×), not the 60 ppb watch (2.0×). The week's
    count is still of the tightest level, and `exceedance_level` names it."""
    if not pinned_build:
        pytest.skip("pinned-build moment")
    j = _net(client, api, json_ok, EXCEEDANCE)
    rr = next(m for m in j["monitors"] if m["id"] == RIVERPORT_ROAD)
    assert rr["over"] and rr["reading"]["value"] > 100.0
    assert rr["level"]["name"] == "NO2 1-hour standard" and rr["level"]["threshold"] == 100.0
    assert rr["level"]["ratio"] == pytest.approx(1.21, abs=0.005)
    assert rr["exceedance_level"] == {"name": "NO2 1-hour watch", "threshold": 60.0}
    assert rr["exceedance_hours_7d"] > 0
    assert j["headline"].startswith(f"Riverport Road is over the {rr['level']['name']} ")


def test_the_ratio_level_through_the_last_week(db, pinned_build) -> None:
    """D15 at every 3rd hour of Aug 21-28, NO2 and PM2.5, not only at one
    moment — plus every hour in that week a reference monitor read over its
    tightest 1-hour level, since the 3-hour grid alone lands on none that is
    over the watch and under the standard. For every monitor with a reading:
    `level` is the highest enabled 1-hour level the reading exceeds, or the
    tightest when it exceeds none; `ratio` is the printed reading over that
    level's printed threshold; and `exceedance_level` is the tightest. When
    the headline names a level it is the `level` of the monitor it leads with
    — the sentence and the panel can never name two different levels."""
    from datetime import timedelta

    from air.server import timeutil

    t, stop = timeutil.parse("2026-08-21T00:00:00"), timeutil.parse("2026-08-29T00:00:00")
    assert t is not None and stop is not None
    grid: list[str] = []
    while t < stop:
        grid.append(timeutil.iso(t))
        t += timedelta(hours=3)
    levels = {
        measure: [
            (label, float(thr)) for label, thr in db.execute(
                "SELECT label, threshold FROM action_level WHERE campaign_id=? AND measure=? AND enabled=1 "
                "AND averaging_hours=? ORDER BY threshold",
                (CID, measure, network.READING_AVERAGING_H),
            )
        ]
        for measure in ("no2", "pm25")
    }
    assert all(levels.values()), levels
    def over_hours(measure: str, lo: str | None, hi: str | None) -> set[str]:
        """Every hour a reference monitor read over the tightest 1-hour level."""
        return {
            r[0] for r in db.execute(
                "SELECT DISTINCT r.ts FROM monitor_reading r JOIN monitor m ON m.id=r.monitor_id "
                "WHERE m.campaign_id=? AND m.grade='reference' AND r.measure=? AND r.qc='valid' "
                "AND r.value>? AND r.ts>=? AND r.ts<?",
                (CID, measure, levels[measure][0][1], lo or "", hi or "9999"),
            )
        }

    # NO2's over-level hours this week; PM2.5 has none this week, so its
    # over-level hours are taken from the whole record (early July) — without
    # them the sweep never reached PM2.5's single-level branch.
    moments = {
        "no2": sorted(set(grid) | over_hours("no2", grid[0], timeutil.iso(stop))),
        "pm25": sorted(set(grid) | over_hours("pm25", None, None)),
    }
    readings = led = 0
    passed_one = {"no2": 0, "pm25": 0}
    passed_top = {"no2": 0, "pm25": 0}
    for measure, lv in levels.items():
        for at in moments[measure]:
            j = network.build(db, CID, at=at, measure=measure)
            for m in j["monitors"]:
                if m["reading"] is None:
                    assert m["level"] is None, (at, measure, m["name"])
                    continue
                v, got = m["reading"]["value"], m["level"]
                assert (got["name"], got["threshold"]) in lv, (at, measure, m["name"], got)
                # The level is chosen on the raw reading; `v` is it to 2 dp. A
                # reading within that rounding of a threshold is not judged here.
                if any(abs(v - thr) <= 0.005 for _n, thr in lv):
                    continue
                exceeded = [x for x in lv if v > x[1]]
                if exceeded:
                    assert got["threshold"] < v, (at, measure, m["name"], v, got)
                    # The HIGHEST passed: no level sits between it and the reading.
                    assert not any(got["threshold"] < thr < v for _n, thr in lv), (at, measure, m["name"], v, got)
                    passed_one[measure] += 1
                    passed_top[measure] += got["threshold"] == lv[-1][1] and len(lv) > 1
                else:
                    assert (got["name"], got["threshold"]) == lv[0], (at, measure, m["name"], v, got)
                # Raw over threshold to 2 dp, against `v` to 2 dp: within 0.01.
                assert abs(got["ratio"] - v / got["threshold"]) <= 0.0101, (at, measure, m["name"], v, got)
                assert m["exceedance_level"] == {"name": lv[0][0], "threshold": lv[0][1]}, (at, measure)
                readings += 1
            h = j["headline"]
            over = [m for m in j["monitors"] if m["over"] and m["reading"]]
            named = [n for n, _thr in lv if n in h]
            if over:
                lead = max(over, key=lambda m: m["reading"]["value"])
                assert h.startswith(f"{lead['name']} is over the {network._level_phrase(lead['level']['name'])}"), h
                assert named == [lead["level"]["name"]], (at, measure, h)
                led += 1
            else:
                assert named == [], (at, measure, h)
    assert len(grid) == 8 * 8 and readings > 0
    if pinned_build:
        # Every branch happens, per pollutant: NO2 hours over the watch only
        # (Aug 26 19:00, 98.85 ppb, is 1.65× the watch) and over the standard
        # (Aug 25 06:00 among them); PM2.5 hours over its one 1-hour level.
        assert led > 0, led
        assert passed_top["no2"] > 0 and passed_one["no2"] > passed_top["no2"], (passed_one, passed_top)
        assert passed_one["pm25"] > 0, passed_one


# ── the clock ────────────────────────────────────────────────────────────────


def test_as_of_bounds(client, api, json_ok) -> None:
    end = _net(client, api, json_ok)
    assert _net(client, api, json_ok, end["at"]) == end, "no `at` must be the end"
    assert _net(client, api, json_ok, "2027-01-01T00:00:00")["at"] == end["at"], "past the end is the end"
    assert _net(client, api, json_ok, EXCEEDANCE + "Z")["at"] == EXCEEDANCE, "a Z is dropped, not converted"
    assert client.get(f"{api}/regulator/network", params={"at": "garbage"}).status_code == 422
    assert client.get(f"{api}/regulator/network", params={"measure": "nope"}).status_code == 422
    for bad in ("1d", "day", "168h", "trailing:168h", ""):
        assert client.get(f"{api}/regulator/network", params={"streets": bad}).status_code == 422, bad


def test_nothing_after_the_moment_shown(client, api, json_ok) -> None:
    for at in (EXCEEDANCE, UNPLUMED, QUIET):
        j = _net(client, api, json_ok, at)
        assert j["at"] == at and j["streets_window"]["to"] == at
        last = j["streets_window"]["last_pass_at"]
        assert last is None or last <= at
        for m in j["monitors"]:
            if m["reading"]:
                assert m["reading"]["ts"] <= at
        for r in j["residents"]:
            assert r["last_posted_at"] is None or r["last_posted_at"] <= at


#: Moments for the streets window: the end, the exceedance, the week of the
#: off-week (nothing driven since Aug 15), mid-off-week (7 d not empty, 24 h
#: empty), a mid-drive morning and Independence Day evening.
STREET_MOMENTS = (END, EXCEEDANCE, UNPLUMED, "2026-08-20T12:00:00", "2026-08-12T11:00:00", "2026-07-04T19:00:00")


@pytest.mark.parametrize("streets", ["24h", "7d", "todate"])
@pytest.mark.parametrize("measure", ["no2", "pm25"])
def test_the_street_figures_are_the_map_window(client, api, json_ok, db, world, streets, measure) -> None:
    """F2: one window for the whole screen. `numbers.street_km`, every
    plume's `touches.streets_driven`, `driven_share` and
    `below_coverage_floor` count exactly the streets
    `/segments?window=<streets_window>&at=<at>` draws for the same
    pollutant — recomputed here from the served GeoJSON, not from
    `passwindow` — and `streets_window` is that window's bounds."""
    hours = {"24h": 24, "7d": 168, "todate": None}[streets]
    lengths = dict(zip(world.seg_ids, world.seg_len.tolist(), strict=True))
    for at in STREET_MOMENTS:
        j = _net(client, api, json_ok, at, streets=streets, measure=measure)
        sw = j["streets_window"]
        now = j["at"]
        assert sw["kind"] == streets and sw["hours"] == hours and sw["to"] == now
        param = "todate" if hours is None else f"trailing:{hours}h"
        fc = json_ok(client.get(
            f"{api}/segments",
            params={"window": param, "at": now, "measure": measure, "limit": 60000},
        ))
        assert fc["window"]["from"] == sw["from"] and fc["window"]["to"] == sw["to"]
        assert fc["window"]["last_pass_at"] == sw["last_pass_at"]
        if hours is None:
            assert sw["from"] is None
        else:
            assert sw["from"] < sw["to"]
        drawn = {f["id"] for f in fc["features"]}
        assert j["numbers"]["street_km"] == round(sum(lengths[s] for s in drawn) / 1000.0, 1), (at, streets)
        is_drawn = np.array([s in drawn for s in world.seg_ids], dtype=bool)
        plumes = network.plumes_now(db, CID, now)
        assert {p["site_id"] for p in j["plumes"]} == set(plumes)
        for p in j["plumes"]:
            seg_in = plumes[p["site_id"]].locate_polar(*world.seg_polar[p["site_id"]]) == plumegeom.INSIDE
            n_in, n_drawn = int(seg_in.sum()), int((seg_in & is_drawn).sum())
            assert p["touches"]["streets_driven"] == n_drawn, (at, streets, p["site_id"])
            assert p["streets_inside"] == n_in, (at, streets, p["site_id"])
            assert p["driven_share"] == (round(n_drawn / n_in, 3) if n_in else 0.0)
            assert p["below_coverage_floor"] == (n_drawn < network.COVERAGE_FLOOR_STREETS)
        # Empty exactly when the last pass is at or before the window opens.
        empty = not drawn
        last = sw["last_pass_at"]
        assert empty == (last is None or (sw["from"] is not None and last <= sw["from"])), (at, streets, last)


def test_no_driving_in_the_week_to_aug_24(client, api, json_ok, pinned_build) -> None:
    """The off-week, as the screen has to say it: in the 7 days to Aug 24
    06:00 nothing was driven, the last pass was Aug 15 20:30:11, and every
    street figure is zero rather than a whole day's streets from after the
    moment shown (the `date:` grid drew 511 there)."""
    if not pinned_build:
        pytest.skip("pinned-build moment")
    j = _net(client, api, json_ok, UNPLUMED, streets="7d")
    assert j["streets_window"] == {
        "kind": "7d", "hours": 168, "from": "2026-08-17T06:00:00", "to": UNPLUMED,
        "last_pass_at": "2026-08-15T20:30:11",
    }
    assert j["numbers"]["street_km"] == 0.0
    for p in j["plumes"]:
        assert p["touches"]["streets_driven"] == 0 and p["driven_share"] == 0.0 and p["below_coverage_floor"]
    # To date, the same moment still has the whole record before it.
    assert _net(client, api, json_ok, UNPLUMED, streets="todate")["numbers"]["street_km"] > 0


def test_a_floor_the_geometry_cannot_clear(client, api, json_ok, db, pinned_build) -> None:
    """P6-E's "not enough of this area was driven" is wrong when the cause
    is where the plume lies. At the end of the data with 7d every street in
    the campaign is driven, and Ridgeline's plume is still below the floor —
    because fewer than `COVERAGE_FLOOR_STREETS` streets lie inside its solid
    part at all. `streets_inside` is what lets the screen say which."""
    if not pinned_build:
        pytest.skip("pinned-build moment")
    j = _net(client, api, json_ok, None, streets="7d")
    n_streets = db.execute("SELECT COUNT(*) FROM road_segment WHERE campaign_id=?", (CID,)).fetchone()[0]
    fc = json_ok(client.get(
        f"{api}/segments", params={"window": "trailing:168h", "at": j["at"], "limit": 60000}
    ))
    assert len(fc["features"]) == n_streets == 1307, "every street driven in the week"
    ridge = next(p for p in j["plumes"] if p["site_id"] == "site-ridgeline")
    assert ridge["below_coverage_floor"]
    assert ridge["streets_inside"] < network.COVERAGE_FLOOR_STREETS
    assert ridge["touches"]["streets_driven"] == ridge["streets_inside"], "all of what is there was driven"


def test_the_alert_count_is_the_live_rule(client, api, json_ok) -> None:
    """`alerts_now` is `useLiveAlerts('regulator')`: ongoing at the moment,
    `info` dropped (web/src/core/alerts.ts rule 5), one per source and
    pollutant. At the exceedance hour Riverport Road's watch and standard
    alerts are one problem."""
    at = EXCEEDANCE
    alerts = json_ok(client.get(f"{api}/alerts", params={"role": "regulator", "at": at}))
    live = [a for a in alerts if a["ongoing"] and a["severity"] != "info"]
    keys = {f"{a['source_type']}|{a.get('source_id') or a['id']}|{a.get('measure') or a['kind']}" for a in live}
    assert _net(client, api, json_ok, at)["numbers"]["alerts_now"] == len(keys)


# ── F7 ───────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("measure", ["no2", "pm25", "aclima_sense"])
def test_a_site_is_named_only_when_naming_py_says_so(client, api, json_ok, db, measure) -> None:
    """F7 per pollutant: a plume is `named` only when the site's own test for
    the SERVED measure passed and something linked on THAT measure — a
    cluster of smell reports links on NO2 (`naming.REPORT_MEASURE`), so it
    never names a site on the PM2.5 screen. `aclima_sense` has no calibrated
    floor, so there is no test to pass and nothing is ever named on it."""
    from air.server import loaders

    sites = {s["id"]: s for s in loaders.load_sites(db, CID)}
    for at in (END, EXCEEDANCE, UNPLUMED, QUIET):
        j = _net(client, api, json_ok, at, measure=measure)
        assert j["measure"] == measure
        now = j["at"]
        link_measure: dict[str, str | None] = {}
        for r in j["residents"]:
            if r["named_site_id"] is None:
                continue
            members = [
                {"kind": k, "suspected_site_id": s}
                for k, s in db.execute(
                    "SELECT kind, suspected_site_id FROM concern WHERE cluster_id=? AND created_at<=?",
                    (r["cluster_id"], now),
                )
            ]
            first = db.execute("SELECT first_at FROM concern_cluster WHERE id=?", (r["cluster_id"],)).fetchone()[0]
            link = naming.alert_link(
                db, CID, {"kind": "concern_cluster", "started_at": first}, sites[r["named_site_id"]], members
            )
            assert link["linked"], (at, r["cluster_id"])
            link_measure[r["cluster_id"]] = link["measure"]
        for p in j["plumes"]:
            if not p["named"]:
                continue
            assert p["touchdown_state"] == "elevated_downwind", (at, measure, p["site_id"])
            clusters = [
                r for r in j["residents"]
                if r["cluster_id"] in p["touches"]["open_cluster_ids"] and r["named_site_id"] == p["site_id"]
                and link_measure.get(r["cluster_id"]) == measure
            ]
            linked_mon = []
            for mid in p["touches"]["monitor_ids"]:
                m = next(x for x in j["monitors"] if x["id"] == mid)
                cand = [
                    a for a in json_ok(client.get(f"{api}/alerts", params={"role": "regulator", "at": now}))
                    if a["ongoing"] and a["source_id"] == mid and a["measure"] == measure
                ] or ([{
                    "kind": "exceedance", "measure": measure, "lon": m["lon"], "lat": m["lat"],
                    "started_at": m["reading"]["ts"],
                }] if m["over"] and m["reading"] else [])
                if any(naming.alert_link(db, CID, a, sites[p["site_id"]])["linked"] for a in cand):
                    linked_mon.append(mid)
            assert clusters or linked_mon, (at, measure, p["site_id"])
        if measure == "aclima_sense":
            assert not any(p["named"] for p in j["plumes"]), at


def test_riverport_is_named_at_the_exceedance_and_not_on_aug_24(client, api, json_ok, pinned_build) -> None:
    """The regulator's beat, from state: at Aug 25 06:00 Riverport Road is
    inside the solid part of Riverport's outline and Riverport's NO2 test is
    `elevated_downwind`; on Aug 24 06:00 no modelled plume is over it, so
    nothing is named whatever the test says."""
    if not pinned_build:
        pytest.skip("pinned-build moments")
    j = _net(client, api, json_ok, EXCEEDANCE)
    rp = next(p for p in j["plumes"] if p["site_id"] == "site-riverport")
    assert RIVERPORT_ROAD in rp["touches"]["monitor_ids"] and rp["named"]
    j = _net(client, api, json_ok, UNPLUMED)
    rr = next(m for m in j["monitors"] if m["id"] == RIVERPORT_ROAD)
    assert rr["over"] and rr["in_plume"] == []
    assert not any(RIVERPORT_ROAD in p["touches"]["monitor_ids"] for p in j["plumes"])


# ── the headline ─────────────────────────────────────────────────────────────

#: PLAN-plume "Never say" (regulator and product-wide), CONTRACT 10a, and the
#: metaphor words of 10a.7. Matched as whole words, case-insensitive.
NEVER = [
    r"full coverage", r"adequate", r"miscalibrat\w*", r"replace\w*", r"missed",
    r"tower\w*", r"tripwire\w*", r"armed", r"invader\w*", r"suspect\w*", r"emitter\w*",
    r"contacts?", r"watchfloor", r"scope", r"radar", r"rwr", r"mfd", r"slew", r"lock\w*",
    r"flight deck", r"drafting table", r"caution", r"normal", r"all.clear", r"safe",
    r"compliant", r"within limits", r"verified", r"confirm\w*", r"proven", r"detected",
    r"observed", r"recorded", r"caused", r"responsible", r"yours?", r"real.time",
    r"over the line", r"blind",
]


def headline_words(text: str) -> list[str]:
    return [w for w in NEVER if re.search(rf"\b{w}\b", text, re.IGNORECASE)]


def _numbers_in(text: str, j: dict[str, Any]) -> set[str]:
    """Integers in the sentence that are not part of a pollutant or level name."""
    names = {x["level"]["name"] for x in j["monitors"] if x["level"]}
    names |= {x["exceedance_level"]["name"] for x in j["monitors"] if x["exceedance_level"]}
    names |= {"NO2", "PM2.5", "CO2", "1-hour"}
    for n in names:
        text = text.replace(n, "")
    return set(re.findall(r"\d+(?:\.\d+)?", text))


@pytest.mark.parametrize("at", [END, EXCEEDANCE, QUIET, UNPLUMED])
def test_the_headline_never_says(client, api, json_ok, at) -> None:
    j = _net(client, api, json_ok, at)
    h = j["headline"]
    assert headline_words(h) == [], h
    assert h.count(".") == 1 and h.endswith("."), f"one sentence: {h}"
    # No number is written into the copy: every figure is one of the payload's.
    allowed = {str(m["exceedance_hours_7d"]) for m in j["monitors"]}
    allowed |= {str(sum(r["count"] for r in j["residents"]))}
    allowed |= {str(len([m for m in j["monitors"] if m["has_measure"]])),
                str(sum(1 for m in j["monitors"] if m["reading"]))}
    allowed |= {str(sum(1 for m in j["monitors"] if m["over"]) - 1)}
    allowed |= {f"{network.NEAR_M / 1000:g}", "7", str(network.REPORT_WINDOW_DAYS)}
    assert _numbers_in(h, j) <= allowed, (h, _numbers_in(h, j) - allowed)


def test_the_headline_branches_on_state(client, api, json_ok, pinned_build) -> None:
    if not pinned_build:
        pytest.skip("pinned-build moments")
    ex = _net(client, api, json_ok, EXCEEDANCE)["headline"]
    assert ex.startswith("Riverport Road is over the NO2 1-hour standard inside Riverport Intermodal Terminal's modelled plume")
    un = _net(client, api, json_ok, UNPLUMED)["headline"]
    assert "with no modelled plume over it" in un and "Riverport Intermodal" not in un
    quiet = _net(client, api, json_ok, QUIET)["headline"]
    assert quiet.startswith("No reference monitor is over a 1-hour NO2 level")
    end = _net(client, api, json_ok)["headline"]
    # Per channel, not per monitor: West Shelby Drive is inside 4 km of
    # Ridgeline and carries no NO2. And reference only: Ridgeline's low-cost
    # fenceline sensors do carry it.
    assert "Ridgeline South Campus has no reference NO2 monitor within 4 km" in end


@pytest.mark.parametrize("at", [END, EXCEEDANCE, QUIET, UNPLUMED])
def test_the_headline_is_short(client, api, json_ok, at) -> None:
    """R9: two short clauses. At 43-51 words it was a third of the page."""
    h = _net(client, api, json_ok, at)["headline"]
    assert len(h.split()) <= network.HEADLINE_MAX_WORDS, (len(h.split()), h)
    assert h.count(";") <= 1, h


def test_the_headline_is_short_through_the_last_week(db) -> None:
    """The bound at every 3rd hour of Aug 21-28, not only at four moments: the
    richest version that fits is served, so no moment's clauses outgrow it."""
    from datetime import timedelta

    from air.server import timeutil

    # Naive campaign time through the one clock's own helpers (CLAUDE.md).
    t, stop = timeutil.parse("2026-08-21T00:00:00"), timeutil.parse("2026-08-29T00:00:00")
    assert t is not None and stop is not None
    seen = 0
    while t < stop:
        for measure in ("no2", "pm25"):
            h = network.build(db, CID, at=timeutil.iso(t), measure=measure)["headline"]
            assert len(h.split()) <= network.HEADLINE_MAX_WORDS, (t, measure, len(h.split()), h)
            assert h.count(";") <= 1 and h.replace("PM2.5", "").count(".") == 1 and h.endswith("."), h
            assert headline_words(h) == [], h
            seen += 1
        t += timedelta(hours=3)
    assert seen == 2 * 8 * 8


def test_the_headline_degrades_on_a_channel_no_monitor_carries(client, api, json_ok) -> None:
    h = _net(client, api, json_ok, measure="bc")["headline"]
    assert h.startswith("No reference monitor here measures black carbon")
    assert "within 4 km" not in h, "a gap on a channel nobody carries is the first clause again"
    assert headline_words(h) == []


def test_locate_matches_the_ring_on_random_points(db, world) -> None:
    """The frame test against the served ring on points scattered through and
    around every site's outline, at a stable and a neutral hour. Allowed to
    differ only within 2 m of the ring's edge — the five-decimal rounding."""
    rng = np.random.default_rng(7)
    for ts in ("2026-08-25T06:00:00", "2026-08-12T11:00:00"):
        for sid, sp in network.plumes_now(db, CID, ts).items():
            rings = sp.rings()
            lon0, lat0 = sp.origin
            lons = lon0 + rng.uniform(-0.06, 0.06, 400)
            lats = lat0 + rng.uniform(-0.05, 0.05, 400)
            codes = sp.locate(lons, lats)
            for lon, lat, c in zip(lons, lats, codes, strict=True):
                ring_code = 0
                for part, ring in rings.items():
                    if _pip((lon, lat), ring):
                        ring_code = plumegeom.INSIDE if part == "inside" else plumegeom.BEYOND
                if ring_code != int(c):
                    d = min(
                        _edge_m(lon, lat, ring) for ring in rings.values()
                    )
                    assert d < 2.0, (ts, sid, lon, lat, ring_code, int(c), d)


def _edge_m(lon: float, lat: float, ring: list[list[float]]) -> float:
    """Distance in metres from a point to a ring's nearest edge (local flat)."""
    k = 111_320.0
    c = np.cos(np.radians(lat))
    best = np.inf
    px, py = lon * k * c, lat * k
    for (x1, y1), (x2, y2) in pairwise(ring):
        ax, ay, bx, by = x1 * k * c, y1 * k, x2 * k * c, y2 * k
        dx, dy = bx - ax, by - ay
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        best = min(best, float(np.hypot(px - (ax + t * dx), py - (ay + t * dy))))
    return best
