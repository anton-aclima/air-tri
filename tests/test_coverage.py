"""P7 — does the regulator's fixed network stand where the plume goes?

Everything here is MODELLED. "In a plume" means inside a cone from
`air.dispersion` driven by this campaign's wind record; nobody measured the air
at these instruments and compared it to anything. The tests assert that the
payloads say so, because the honesty of this screen is carried by one word in
a field rather than by a caption someone can edit.

The headline, recomputed on the current kernel: **a reference tower stands
inside a modelled plume in 30.1% of hours, and two of the four do so in under
2%.** An earlier design quoted 20.1%, derived from the `base_reach` formula
phase 1 deleted; if you find that number written anywhere it is stale.
"""

from __future__ import annotations

import numpy as np
import pytest

from air import dispersion
from air.server import coverage as cv

pytestmark = pytest.mark.needs_db

CID = "cmp-swmem-2026"


@pytest.fixture(scope="module")
def world(db):
    return cv.load(db, CID)


@pytest.fixture(scope="module")
def intercept(db):
    return cv.interception(db, CID)


@pytest.fixture(scope="module")
def resid(db):
    return cv.residency(db, CID)


# ── the finding ──────────────────────────────────────────────────────────────

def test_the_reference_network_is_in_a_plume_a_minority_of_hours(intercept) -> None:
    ref = intercept.reference
    assert len(ref) == 4, [i.name for i in ref]
    assert all(0.0 <= i.share < 0.5 for i in ref), {i.name: i.share for i in ref}


def test_two_of_the_four_towers_are_effectively_never_in_a_plume(intercept) -> None:
    """The plan said "never". On the current kernel it is "almost never" — the
    bigger stable-air plumes of phase 1 do occasionally reach them, 25 and 18
    hours out of 2,160. The finding survives; the word does not, and a screen
    that said "never" would be wrong."""
    rarely = [i for i in intercept.reference if i.share < 0.02]
    assert len(rarely) == 2, {i.name: i.share for i in intercept.reference}
    for i in rarely:
        assert i.hours_in_plume > 0, f"{i.name} really never — update the copy"


def test_the_basis_travels_with_the_numbers(intercept) -> None:
    """CONTRACT §10a rule 1. The word `modelled` is in the payload so a screen
    cannot print the rate without it."""
    assert "modelled" in intercept.basis
    assert "Nobody measured" in intercept.basis


# ── residency, and the two accounting bugs it had ────────────────────────────

def test_unobserved_never_exceeds_plume_hours(resid) -> None:
    """Counting the numerator per (hour, site) and the denominator per hour
    gave segments an unobserved share of 104%."""
    bad = [r for r in resid if r.unobserved_hours > r.plume_hours]
    assert not bad, [(r.segment_id, r.plume_hours, r.unobserved_hours) for r in bad[:3]]
    assert all(0.0 <= r.unobserved_share <= 1.0 for r in resid)


def test_unobserved_is_attributed_to_the_site_that_caused_it(db, resid) -> None:
    """The loose definition — "an hour when no instrument anywhere was in a
    plume" — flatters the network: an hour where Riverport Road stands in
    Riverport's plume would count as observed for a street under RIDGELINE's
    plume across the campaign. Per-site attribution roughly quadruples the
    unobserved share, which is the measure of how much the loose version hid.
    """
    total = sum(r.plume_hours for r in resid)
    unobs = sum(r.unobserved_hours for r in resid)
    assert total > 0
    share = unobs / total
    assert 0.3 < share < 0.8, f"unobserved share {share:.1%} — re-read the attribution"


def test_every_street_sees_a_plume_sometimes(resid) -> None:
    """Plumes reach 8 km in stable air and the campaign is under 12 km across,
    so "never downwind of anything" is not a category here. If this ever fails,
    the kernel's reach has shrunk and every figure on the screen moved."""
    assert all(r.plume_hours > 0 for r in resid)


# ── siting is an observation, never advice ───────────────────────────────────

def test_siting_candidates_are_ranked_by_unobserved_not_by_residency(db) -> None:
    """Raw residency is hottest where the plume goes most often — which here is
    President's Island, where Riverport Road already stands. A raw map ranks
    the streets that are already covered."""
    rows = cv.siting_candidates(db, CID, 10)
    assert rows
    got = [r.unobserved_hours for r in rows]
    assert got == sorted(got, reverse=True)
    assert all(r.plume_hours >= cv.MIN_PLUME_HOURS for r in rows)


def test_siting_does_not_return_ten_segments_of_one_road(db) -> None:
    rows = cv.siting_candidates(db, CID, 10)
    names = [r.name or r.segment_id for r in rows]
    assert len(set(names)) == len(names), names


def test_the_siting_payload_carries_its_own_framing(client, api, json_ok) -> None:
    """Recommending where a public agency sites an instrument is the closest
    this product comes to regulatory advice. The disclaimer ships in the
    payload so a screen cannot quietly promote the rows into advice."""
    j = json_ok(client.get(f"{api}/coverage/siting"))
    assert "not advice" in j["framing"]
    assert "observation about this record" in j["framing"]


# ── P7-D: what can be anchored at all ────────────────────────────────────────

def test_most_channels_have_no_reference_anchor(client, api, json_ok) -> None:
    """The uncomfortable finding, and the strongest thing on the screen.

    The species that can be anchored to the agency's towers are exactly the
    species those towers already carry. The species this product uniquely
    provides — black carbon, methane and everything derived from them — are
    precisely the ones nothing in the region can anchor. A single green
    "calibrated" badge on a node is false for most of what that node measures.
    """
    j = json_ok(client.get(f"{api}/coverage/calibration"))
    assert j["n_measures"] == 11
    assert j["n_anchored"] == 4
    unanchored = {c["code"] for c in j["channels"] if not c["anchored"]}
    assert {"bc", "ch4"} <= unanchored, "the leapfrog argument's own channels are anchored now"
    for c in j["channels"]:
        if not c["anchored"]:
            assert "No reference anchor exists in this campaign" in c["note"]
        else:
            assert c["n_reference_anchors"] >= 1 and c["note"] is None


# ── the geometry is the same geometry ────────────────────────────────────────

def test_the_scalar_and_vector_cone_tests_agree(world) -> None:
    """`point_in_cone` calls straight into `cone_mask`, so this asserts the one
    implementation stayed one implementation."""
    rng = np.random.default_rng(5)
    dx = rng.uniform(-6000, 6000, 200)
    dy = rng.uniform(-6000, 6000, 200)
    kw = dict(x_min=200.0, x_max=4000.0, cls="E", u10=2.0)
    vec = dispersion.cone_mask(dx, dy, 19.0, **kw)
    for i in range(0, 200, 7):
        assert bool(vec[i]) == dispersion.point_in_cone(float(dx[i]), float(dy[i]), 19.0, **kw)


def test_a_receptor_behind_the_source_is_never_in_the_cone() -> None:
    kw = dict(x_min=0.0, x_max=8000.0, cls="F", u10=1.5)
    # Transport due north; 3 km SOUTH of the source is upwind.
    assert not dispersion.point_in_cone(0.0, -3000.0, 0.0, **kw)
    assert dispersion.point_in_cone(0.0, 3000.0, 0.0, **kw)


def test_interception_is_live_not_precomputed(db) -> None:
    """No table, no datagen module. If this ever needs one, the 1,307-segment
    surface is the thing to defer — not the four-tower headline."""
    names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "interception" not in names and "coverage_cell" not in names
