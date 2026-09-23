"""P4 — one touchdown object, one enum, four consumers.

The shipped estimator (`air.server.touchdown`) is the promotion of the frozen
probe. These tests pin the three things that make it safe to build four
interfaces on top of: it agrees with the probe that justified it, it obeys the
containment rule, and it never serves a number that has not been null-tested.
"""

from __future__ import annotations

import ast
import json
import pathlib
from collections import Counter

import numpy as np
import pytest

import probe_touchdown as probe
from air.server import touchdown as td

pytestmark = pytest.mark.needs_db

SITES = ("site-ridgeline", "site-deltaforge", "site-riverport")
MODULE = pathlib.Path(td.__file__)


@pytest.fixture(scope="module")
def passes(db):
    return td._Passes(db, "cmp-swmem-2026", "no2")


@pytest.fixture(scope="module")
def payload(client, api, json_ok):
    return json_ok(client.get(f"{api}/sites/site-ridgeline/touchdown"))


# ── the shipped estimator IS the frozen one ──────────────────────────────────

def test_the_server_agrees_with_the_probe_that_justified_it(db) -> None:
    """Two implementations of one decision is how this repo has repeatedly
    ended up with two answers. They are checked against each other rather than
    merged, because the probe's job is to re-measure the constants the server
    uses — and it imports them from the server so they cannot drift."""
    world = probe.World(pathlib.Path(str(db.execute("PRAGMA database_list").fetchone()[2])))
    for measure in ("no2", "pm25"):
        p = td._Passes(db, "cmp-swmem-2026", measure)
        for site in SITES:
            mine = td.estimate(p, site, measure)
            theirs = probe.estimate(world, site, measure, probe.FROZEN)
            assert mine.n_hours == theirs.n_hours, (site, measure)
            if mine.excess is None:
                assert not np.isfinite(theirs.excess), (site, measure)
            else:
                assert mine.excess == pytest.approx(theirs.excess, abs=1e-6), (site, measure)
            assert mine.state == theirs.state, (site, measure, mine.state, theirs.state)


def test_the_constants_are_not_restated_in_the_probe() -> None:
    assert probe.DETECT_FLOOR is td.DETECT_FLOOR
    assert probe.FROZEN.control_inner_m == td.CONTROL_INNER_M
    assert probe.FROZEN.min_downwind_per_hour == td.MIN_DOWNWIND_PER_HOUR


# ── containment (CONTRACT §10d) ──────────────────────────────────────────────

def test_the_estimator_reads_only_measurements() -> None:
    """Data flow, not an import ban. The measured payload must not be built out
    of anything a dispersion kernel produced, and must not be built out of
    `segment_stat` either — those are aggregates with their own rules, and
    reading them would make the estimate depend on a statistic rather than on
    measurements."""
    allowed = {"segment_pass", "mobile_wind_obs", "wind", "monitor_reading", "concern",
               "road_segment", "emission_point", "industry_site", "campaign"}
    # Parsed, not grepped: the module's own docstring explains why it does not
    # read `segment_stat`, and a text search finds that sentence.
    tree = ast.parse(MODULE.read_text(), filename=str(MODULE))
    read: set[str] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
            continue
        sql = node.value
        if "SELECT" not in sql.upper():
            continue
        parts = sql.replace("\n", " ").split()
        for i, tok in enumerate(parts):
            if tok.upper() in ("FROM", "JOIN") and i + 1 < len(parts):
                read.add(parts[i + 1].strip('(),"'))
    assert read, "no SQL found — did the module stop querying?"
    assert read <= allowed, f"reads unexpected tables: {sorted(read - allowed)}"
    assert "segment_stat" not in read


def test_only_geometry_comes_from_the_kernel() -> None:
    """`air.dispersion` is used for sigma_y — a width — and for STRENGTH, an
    emission weighting on the source POINT. Neither is a concentration, so
    nothing measured here is kernel-derived."""
    tree = ast.parse(MODULE.read_text(), filename=str(MODULE))
    used = {
        node.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "dispersion"
    }
    assert used <= {"half_width", "STRENGTH", "NEAR_SIGMA_M"}, (
        f"the measured estimator is calling {used - {'half_width', 'STRENGTH', 'NEAR_SIGMA_M'}} "
        "— see CONTRACT §10d"
    )


# ── the payload (P4-C) ───────────────────────────────────────────────────────

def test_every_feature_is_a_linestring(payload) -> None:
    """Never a Polygon. Within 1 km of Ridgeline there are 9 segments and they
    are all one road; a polygon there is a 2-D shape extrapolated from a line."""
    assert payload["features"]
    for f in payload["features"]:
        assert f["geometry"]["type"] == "LineString"
        assert len(f["geometry"]["coordinates"]) >= 2


def test_the_verdict_lives_on_the_roll_up_not_the_segments(payload) -> None:
    """Phase 2: zero of 1,307 segments reach 12 conditioned passes on both
    sides. A per-segment `elevated_downwind` would be a claim the data cannot
    carry."""
    states = Counter(f["properties"]["state"] for f in payload["features"])
    assert "elevated_downwind" not in states, states
    assert payload["site"]["state"] in td.STATES


def test_not_measured_is_actually_served(payload) -> None:
    """The honest half of the answer. Without these the payload only describes
    roads that happen to have been driven, which reads as coverage."""
    states = Counter(f["properties"]["state"] for f in payload["features"])
    assert states["not_measured"] > 0
    assert states["insufficient_passes"] > 0
    for f in payload["features"]:
        p = f["properties"]
        if p["state"] == "not_measured":
            assert p["n_downwind"] == 0 and p["excess"] is None


def test_the_roll_up_carries_what_bounds_it(payload) -> None:
    s = payload["site"]
    for k in ("n_supported_segments", "n_distinct_roads", "coverage_pct",
              "placebo_max", "placebo_ratio", "detect_floor", "n_hours"):
        assert k in s, k
    assert 0.0 <= s["coverage_pct"] <= 100.0
    assert s["n_distinct_roads"] <= s["n_supported_segments"] or s["n_supported_segments"] == 0


def test_a_detection_has_survived_both_gates(payload) -> None:
    s = payload["site"]
    if s["state"] != "elevated_downwind":
        pytest.skip(f"Ridgeline NO2 is {s['state']} on this build")
    assert s["excess"] >= s["detect_floor"], (s["excess"], s["detect_floor"])
    assert s["placebo_ratio"] is not None and s["placebo_ratio"] < td.PLACEBO_MAX_RATIO
    assert s["n_hours"] >= td.MIN_HOURS


def test_the_downwind_ground_is_boxtown(payload) -> None:
    """The narrative beat, measured rather than asserted. Phase 2 found this
    holds across four seeds at 77-94%; the number is generated, never written."""
    top = payload["districts"][0]
    assert top["district"] == "Boxtown", payload["districts"]
    assert top["share"] > 0.6


def test_an_uncalibrated_measure_is_refused(client, api) -> None:
    r = client.get(f"{api}/sites/site-ridgeline/touchdown", params={"measure": "co2"})
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "measure_not_calibrated"


def test_unknown_site_is_404(client, api) -> None:
    assert client.get(f"{api}/sites/nope/touchdown").status_code == 404


# ── polar roll-up (P4-E) ─────────────────────────────────────────────────────

def test_polar_bins_report_n_on_both_sides_and_never_smooth(payload) -> None:
    bins = payload["polar"]
    assert len(bins) == td.POLAR_SECTORS * (len(td.POLAR_RINGS) - 1)
    for b in bins:
        assert "n_downwind" in b and "n_control" in b
        if b["n_downwind"] > 0 and b["n_control"] == 0:
            assert b["state"] == "no_control", b
            assert b["excess"] is None, "a bin with nothing to compare against is not a zero"
        if b["n_downwind"] == 0:
            assert b["excess"] is None


def test_the_polar_bins_are_a_view_of_the_same_passes(payload) -> None:
    """Derived, not a second statistic. Three separate roll-ups that drift
    apart is how two screens end up printing facts about Boxtown that differ
    in sign."""
    from_polar = sum(b["n_downwind"] for b in payload["polar"])
    from_features = sum(f["properties"]["n_downwind"] for f in payload["features"])
    assert from_polar == from_features


# ── coverage (P4-B) ──────────────────────────────────────────────────────────

def test_coverage_is_a_grid_of_driven_cells(client, api, json_ok) -> None:
    j = json_ok(client.get(f"{api}/campaigns/current/coverage"))
    assert j["n_cells"] > 0
    assert j["n_cells"] < j["n_cells_total"], "everything is covered — the mask says nothing"
    assert 0.0 < j["covered_pct"] < 100.0
    for f in j["features"][:20]:
        assert f["geometry"]["type"] == "Polygon"
        assert len(f["geometry"]["coordinates"][0]) == 5


def test_a_bigger_cell_covers_more_of_the_bbox(client, api, json_ok) -> None:
    small = json_ok(client.get(f"{api}/campaigns/current/coverage", params={"cell_m": 100}))
    big = json_ok(client.get(f"{api}/campaigns/current/coverage", params={"cell_m": 300}))
    assert big["covered_pct"] > small["covered_pct"]


def test_coverage_uses_whole_polylines_not_midpoints(client, api, db, json_ok) -> None:
    """A mask built from segment midpoints understates coverage, which is the
    wrong direction to be wrong in for a layer whose job is to say what we do
    and do not know."""
    j = json_ok(client.get(f"{api}/campaigns/current/coverage", params={"cell_m": 150}))
    driven_segments = db.execute(
        "SELECT COUNT(DISTINCT segment_id) FROM segment_pass"
    ).fetchone()[0]
    assert j["n_cells"] > driven_segments * 0.7, (
        f"{j['n_cells']} cells for {driven_segments} driven segments looks like midpoints"
    )
