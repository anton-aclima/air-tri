"""`GET /wind/dispersion?outline=1` — CONTRACT 10b's register for Aclima's model.

10b says the Aclima model is a solid hairline outline plus a centreline axis
with a reach tick, never filled, and dashed past the detection envelope. The
bands this endpoint served could only be drawn as three stacked fills or as
three stroked rings whose shared edges read as boundaries; neither is the
rule. `outline=1` adds the outer edge (split at the envelope) and the axis as
their own features and leaves the bands alone.

The default response must not move at all: the gallery and every other
caller read it, and a silent change of default is how the filled-band rule
reached all four interfaces in the first place (the industry review's
critique of P1-E). So the default is held against sha256 hashes of the raw
response bytes, captured from the router before `outline` existed.
"""

from __future__ import annotations

import hashlib
import json
import math
import pathlib

import pytest

from air.server import geo

pytestmark = pytest.mark.needs_db

GOLDEN = pathlib.Path(__file__).parent / "fixtures" / "dispersion_default_sha256.json"


def _kinds(j: dict) -> list[dict]:
    return [f for f in j["features"] if "kind" in f["properties"]]


def _bands(j: dict) -> list[dict]:
    return [f for f in j["features"] if "kind" not in f["properties"]]


def _hours(db, classes: str = "ABCDEF") -> list[str]:
    """Two hours per class, one of them the slowest — the 8 km clip lives there."""
    out: list[str] = []
    for cls in classes:
        for sql in (
            "SELECT ts FROM wind WHERE stability=? ORDER BY ts LIMIT 1",
            "SELECT ts FROM wind WHERE stability=? ORDER BY speed_ms, ts LIMIT 1",
        ):
            r = db.execute(sql, (cls,)).fetchone()
            if r and r[0] not in out:
                out.append(r[0])
    return out


# ── the default does not move ────────────────────────────────────────────────


def test_default_response_is_byte_identical_to_before_outline_existed(client, api, pinned_build) -> None:
    """The fixture was taken from the pre-`outline` code on the pinned build.

    A different build is a different world (see `pinned_build`), so this
    skips there rather than failing. Do NOT regenerate the fixture to make
    this pass: a mismatch means the default payload changed.
    """
    if not pinned_build:
        pytest.skip("hashes are of the pinned build (--now 2026-08-28T13:54:00)")
    golden = json.loads(GOLDEN.read_text())
    assert golden["cases"], "empty fixture"
    for case in golden["cases"]:
        r = client.get(f"{api}/wind/dispersion", params=case["params"])
        assert r.status_code == 200, r.text[:200]
        assert "json" in r.headers["content-type"]
        got = hashlib.sha256(r.content).hexdigest()
        assert got == case["sha256"], f"default response changed for {case['params']}"


def test_outline_absent_or_false_is_the_same_bytes(client, api, db) -> None:
    for at in _hours(db, "BF")[:2]:
        base = client.get(f"{api}/wind/dispersion", params={"at": at})
        for off in ("0", "false"):
            r = client.get(f"{api}/wind/dispersion", params={"at": at, "outline": off})
            assert r.content == base.content, (at, off)
        assert not _kinds(base.json()), "the default grew outline features"


def test_outline_leaves_the_band_features_exactly_as_they_were(client, api, db, json_ok) -> None:
    """Same bands, same order, same indices — the kind features come after."""
    for at in _hours(db):
        base = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at}))
        full = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at, "outline": 1}))
        n = len(base["features"])
        assert full["features"][:n] == base["features"], at
        assert all("kind" in f["properties"] for f in full["features"][n:]), at


# ── what outline=1 adds ──────────────────────────────────────────────────────


def test_every_site_gets_an_axis_and_an_outline(client, api, db, json_ok) -> None:
    for at in _hours(db):
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at, "outline": 1}))
        sites = {f["properties"]["site_id"] for f in _bands(j)}
        assert sites, at
        for sid in sites:
            mine = [f["properties"] for f in _kinds(j) if f["properties"]["site_id"] == sid]
            axes = [p for p in mine if p["kind"] == "axis"]
            parts = sorted(p["part"] for p in mine if p["kind"] == "outline")
            assert len(axes) == 1, (at, sid, mine)
            assert parts in (["inside"], ["beyond", "inside"], ["beyond"]), (at, sid, parts)
            for p in mine:
                for key in ("site_id", "measure", "ts", "wind_dir_deg", "stability",
                            "detection_envelope_m", "x_reach_m", "truncated"):
                    assert key in p, (key, p)


def test_beyond_is_present_exactly_when_reach_passes_the_envelope(client, api, db, json_ok) -> None:
    seen = {"with": 0, "without": 0}
    for at in _hours(db):
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at, "outline": 1}))
        for f in _kinds(j):
            p = f["properties"]
            if p["kind"] != "axis":
                continue
            parts = {
                g["properties"]["part"]
                for g in _kinds(j)
                if g["properties"]["site_id"] == p["site_id"] and g["properties"]["kind"] == "outline"
            }
            if p["x_reach_m"] > p["detection_envelope_m"]:
                assert "beyond" in parts, (at, p)
                seen["with"] += 1
            else:
                assert "beyond" not in parts, (at, p)
                seen["without"] += 1
    # Both branches must actually have run, or the test proves nothing:
    # Delta Forge in daytime B stays inside 1.5 km; everything clips under F.
    assert seen["with"] and seen["without"], seen


def test_outline_parts_split_at_the_envelope(client, api, db, json_ok) -> None:
    """`r0_m`/`r1_m` are where each ring starts and stops along the axis. The
    envelope is where inside stops and beyond starts; the reach is where the
    outline stops. Inside starts at or before the onset: every source's cone
    starts at its own onset, and the upwind-most source is behind the axis
    origin."""
    for at in _hours(db):
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at, "outline": 1}))
        for f in _kinds(j):
            p = f["properties"]
            if p["kind"] != "outline":
                continue
            env, reach = p["detection_envelope_m"], p["x_reach_m"]
            if p["part"] == "inside":
                assert p["r0_m"] <= p["x_onset_m"] + 1.0, p
                assert p["r1_m"] == pytest.approx(min(reach, env), abs=2.0), p
            else:
                assert p["r0_m"] >= min(env, p["x_onset_m"]) - 2.0, p
                assert p["r1_m"] == pytest.approx(reach, abs=2.0), p
            ring = f["geometry"]["coordinates"][0]
            assert f["geometry"]["type"] == "Polygon"
            assert ring[0] == ring[-1] and len(ring) >= 4
            dupes = [i for i in range(len(ring) - 1) if ring[i] == ring[i + 1]]
            assert not dupes, f"zero-length edges at {dupes}"


def _project(origin: list[float], toward: float, pt: list[float]) -> tuple[float, float]:
    """(along-axis, crosswind) metres of `pt` from `origin`."""
    d = geo.haversine_m(origin[0], origin[1], pt[0], pt[1])
    th = math.radians(geo.bearing_deg(origin[0], origin[1], pt[0], pt[1]) - toward)
    return d * math.cos(th), d * math.sin(th)


def _extent(features: list[dict], origin: list[float], toward: float) -> tuple[float, float, float, float]:
    """(min along, max along, min across, max across) of every ring vertex."""
    pts = [_project(origin, toward, v) for f in features for v in f["geometry"]["coordinates"][0]]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), max(xs), min(ys), max(ys)


def _site_parts(j: dict, sid: str) -> tuple[dict, dict[str, dict]]:
    axis = next(
        f for f in _kinds(j) if f["properties"]["site_id"] == sid and f["properties"]["kind"] == "axis"
    )
    parts = {
        f["properties"]["part"]: f
        for f in _kinds(j)
        if f["properties"]["site_id"] == sid and f["properties"]["kind"] == "outline"
    }
    return axis, parts


def test_the_outline_starts_with_the_bands_and_ends_on_the_axis(client, api, db, json_ok) -> None:
    """The outline starts where the bands start (the upwind-most source's
    onset) and ends where the axis ends: its nose is ON the axis at the reach,
    so the reach tick and "truncated" mark the drawn end. It stays inside the
    bands' crosswind extent — the rounded nose only takes away.

    A containment test by point-in-polygon would be the obvious spelling, and
    it is flaky here: band vertices lie ON the outline, so rounding to five
    decimals (~1 m) puts half of them a hair outside. Extents along and across
    the axis are what a reader sees.
    """
    for at in _hours(db):
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at, "outline": 1}))
        for sid in {f["properties"]["site_id"] for f in _bands(j)}:
            axis, parts = _site_parts(j, sid)
            origin = axis["geometry"]["coordinates"][0]
            end = axis["geometry"]["coordinates"][-1]
            toward = (float(axis["properties"]["wind_dir_deg"]) + 180.0) % 360.0
            bands = [f for f in _bands(j) if f["properties"]["site_id"] == sid]
            g_lo, g_hi, g_left, g_right = _extent(list(parts.values()), origin, toward)
            w_lo, _w_hi, w_left, w_right = _extent(bands, origin, toward)
            assert g_lo == pytest.approx(w_lo, abs=5.0), (at, sid, g_lo, w_lo)
            axis_len = geo.haversine_m(origin[0], origin[1], end[0], end[1])
            assert g_hi == pytest.approx(axis_len, abs=3.0), (at, sid, g_hi, axis_len)
            assert g_left >= w_left - 5.0 and g_right <= w_right + 5.0, (at, sid)
            # Not a sliver either: the nose rounds the end, it does not
            # replace the plume.
            assert g_right - g_left >= 0.6 * (w_right - w_left), (at, sid)
            # The tip is on the axis.
            tip = max(
                (_project(origin, toward, v) for f in parts.values() for v in f["geometry"]["coordinates"][0]),
                key=lambda xy: xy[0],
            )
            assert abs(tip[1]) <= 3.0, (at, sid, tip)


def test_inside_and_beyond_share_one_cut_at_the_envelope(client, api, db, json_ok) -> None:
    """One ring cut once (phase 3 review): the parts carry the SAME two cut
    vertices, on the envelope line across the axis, and neither part crosses
    it. Built per part from per-source spans they overlapped by a few hundred
    metres and met in a 3-23 px jog with crosswise bars."""
    seen = 0
    for at in _hours(db):
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at, "outline": 1}))
        for sid in {f["properties"]["site_id"] for f in _bands(j)}:
            axis, parts = _site_parts(j, sid)
            if not {"inside", "beyond"} <= set(parts):
                continue
            origin = axis["geometry"]["coordinates"][0]
            toward = (float(axis["properties"]["wind_dir_deg"]) + 180.0) % 360.0
            env = axis["properties"]["envelope_m"]
            a = parts["inside"]["geometry"]["coordinates"][0][:-1]
            b = parts["beyond"]["geometry"]["coordinates"][0][:-1]
            shared = [v for v in a if v in b]
            assert len(shared) == 2, (at, sid, shared)
            ys = []
            for v in shared:
                x, y = _project(origin, toward, v)
                assert x == pytest.approx(env, abs=2.0), (at, sid, x)
                ys.append(y)
            assert min(ys) < 0.0 < max(ys), "the cut must cross the axis"
            assert max(_project(origin, toward, v)[0] for v in a) <= env + 2.0, (at, sid)
            assert min(_project(origin, toward, v)[0] for v in b) >= env - 2.0, (at, sid)
            seen += 1
    assert seen, "no hour has both parts — the case this guards has gone"


def test_the_far_end_has_no_notches(client, api, db, json_ok) -> None:
    """No corner anywhere in the far half of the plume except where the
    envelope cuts it. The per-source union ended in a staircase of 170-260 m
    steps (two right-angle turns each), which read on screen as a house-shaped
    roof; the nose that replaced it is one smooth curve, so its chords turn a
    few degrees at a time — including at the tip, where both sides arrive
    crosswind."""
    for at in _hours(db):
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at, "outline": 1}))
        for sid in {f["properties"]["site_id"] for f in _bands(j)}:
            axis, parts = _site_parts(j, sid)
            origin = axis["geometry"]["coordinates"][0]
            toward = (float(axis["properties"]["wind_dir_deg"]) + 180.0) % 360.0
            env = axis["properties"]["envelope_m"]
            reach = axis["properties"]["reach_m"]
            for part, f in parts.items():
                pts = [_project(origin, toward, v) for v in f["geometry"]["coordinates"][0][:-1]]
                n = len(pts)
                for i in range(n):
                    (x0, y0), (x1, y1), (x2, y2) = pts[i - 1], pts[i], pts[(i + 1) % n]
                    if x1 < reach / 2.0 or abs(x1 - env) <= 2.0:
                        continue
                    a = math.atan2(y1 - y0, x1 - x0)
                    b = math.atan2(y2 - y1, x2 - x1)
                    turn = abs(math.degrees((b - a + math.pi) % (2 * math.pi) - math.pi))
                    assert turn <= 30.0, (at, sid, part, round(x1), round(y1), round(turn))


def test_axis_runs_along_the_transport_direction_to_the_reach(client, api, db, json_ok) -> None:
    for at in _hours(db):
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at, "outline": 1}))
        for f in _kinds(j):
            p = f["properties"]
            if p["kind"] != "axis":
                continue
            line = f["geometry"]["coordinates"]
            assert f["geometry"]["type"] == "LineString"
            a, b = line[0], line[-1]
            toward = (float(p["wind_dir_deg"]) + 180.0) % 360.0
            off = abs(((geo.bearing_deg(a[0], a[1], b[0], b[1]) - toward + 180.0) % 360.0) - 180.0)
            assert off < 0.2, (at, p["site_id"], off)
            # Five-decimal coordinates are ~1 m; the reach is to 0.1 m.
            assert geo.haversine_m(a[0], a[1], b[0], b[1]) == pytest.approx(p["x_reach_m"], abs=3.0)
            assert p["reach_m"] == p["x_reach_m"]
            assert p["envelope_m"] == p["detection_envelope_m"]
            # The envelope is its own vertex when it falls short of the reach,
            # so the renderer splits solid from dashed at index 1.
            if p["envelope_m"] < p["reach_m"]:
                assert len(line) == 3
                e = line[1]
                assert geo.haversine_m(a[0], a[1], e[0], e[1]) == pytest.approx(p["envelope_m"], abs=3.0)
            else:
                assert len(line) == 2
            # The last vertex is the outline's nose, so the reach tick and
            # "truncated" sit on the drawn end.
            ring_pts = [
                v
                for g in _kinds(j)
                if g["properties"]["site_id"] == p["site_id"] and g["properties"]["kind"] == "outline"
                for v in g["geometry"]["coordinates"][0]
            ]
            nearest = min(geo.haversine_m(b[0], b[1], v[0], v[1]) for v in ring_pts)
            assert nearest <= 3.0, (at, p["site_id"], nearest)


def test_truncated_is_the_8km_clip_and_says_so(client, api, db, json_ok) -> None:
    from air import dispersion as plume

    seen = {True: 0, False: 0}
    for at in _hours(db):
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at, "outline": 1}))
        for f in _kinds(j):
            p = f["properties"]
            if p["kind"] != "axis":
                continue
            seen[p["truncated"]] += 1
            if p["truncated"]:
                assert p["reach_m"] == plume.MAX_REACH_M, p
            else:
                assert p["reach_m"] < plume.MAX_REACH_M, p
            band_flag = {
                g["properties"]["truncated"]
                for g in _bands(j)
                if g["properties"]["site_id"] == p["site_id"]
            }
            assert band_flag == {p["truncated"]}, "the axis and the bands disagree about the clip"
    assert seen[True] and seen[False], seen


def test_outline_features_are_never_filled_bands(client, api, db, json_ok) -> None:
    """No `level` or `band` on a kind feature: nothing downstream may colour
    an outline by concentration, which is what makes a fill."""
    for at in _hours(db, "DF"):
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"at": at, "outline": 1}))
        for f in _kinds(j):
            assert "level" not in f["properties"]
            assert "band" not in f["properties"]
