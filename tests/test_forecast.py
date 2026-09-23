"""P8 — a forecast that is derived, not invented.

The original design invented three forecast tiers whose relative skill was a
noise scale someone picked, then shipped a ledger reporting that choice back as
a finding. This replaces it with a blend of persistence and the campaign's own
hour-of-day climatology, whose error is MEASURED.

What that buys, and what these tests protect: at six hours the forecast IS
persistence, at two to three days the blend beats both baselines, and at five
days it collapses to the rose. There is no tier comparison left to disclaim.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from air import dispersion
from air.server import forecast as fc

pytestmark = pytest.mark.needs_db

CID = "cmp-swmem-2026"


@pytest.fixture(scope="module")
def bins(db):
    return fc.skill(db, CID)


@pytest.fixture(scope="module")
def issued(db):
    return fc.issue(db, CID)


# ── the forecast is honest about what it is ──────────────────────────────────

def test_at_short_lead_the_forecast_is_just_persistence(bins) -> None:
    """Nothing beats "the wind is still doing what it is doing" at six hours,
    and a forecast claiming otherwise would be claiming skill it invented."""
    six = next(b for b in bins if b.lead_h == 6)
    assert six.blend_mae_deg == pytest.approx(six.persistence_mae_deg, abs=0.2)
    assert fc.blend_weight(6) == 1.0


def test_at_five_days_the_forecast_is_just_climatology(bins) -> None:
    """The honest answer at 120 h is the rose — the same rose the community
    app already shows as its front door."""
    far = next(b for b in bins if b.lead_h == 120)
    assert far.blend_mae_deg == pytest.approx(far.climatology_mae_deg, abs=0.5)
    assert fc.blend_weight(120) <= 0.15


def test_the_blend_genuinely_beats_both_baselines_in_the_middle(bins) -> None:
    """The only place a forecast can honestly add anything here. If this stops
    holding, there is no reason to ship a forecast at all."""
    mid = [b for b in bins if 24 < b.lead_h <= 96]
    assert mid
    assert all(b.gain_deg >= 0 for b in bins), [(b.lead_h, b.gain_deg) for b in bins]
    assert max(b.gain_deg for b in mid) >= 3.0, [(b.lead_h, b.gain_deg) for b in mid]


def test_the_ledger_always_shows_what_it_beat(client, api, json_ok) -> None:
    """A skill number without the thing it beat is a marketing claim."""
    j = json_ok(client.get(f"{api}/wind/forecast/skill"))
    assert j["bins"]
    for b in j["bins"]:
        assert "persistence_mae_deg" in b and "climatology_mae_deg" in b
    assert "not the atmosphere" in j["note"]
    assert "measured from this record rather than" in j["note"]


def test_the_crossover_is_where_the_lines_actually_cross(bins) -> None:
    """`CROSSOVER_H` is a measured boundary, not a hedge: past it climatology
    beats persistence, so days 3-5 are the rose rather than a forecast."""
    before = [b for b in bins if b.lead_h < fc.CROSSOVER_H]
    after = [b for b in bins if b.lead_h > fc.CROSSOVER_H]
    assert all(b.persistence_mae_deg < b.climatology_mae_deg for b in before)
    assert all(b.persistence_mae_deg > b.climatology_mae_deg for b in after)


# ── what is derived stays derived ────────────────────────────────────────────

def test_the_boundary_layer_matches_the_generator(db) -> None:
    """`_pbl` is replicated from `weather.build_wind` because `air.server` does
    not import `air.datagen`. Replication without a parity test is how two
    copies of a formula drift."""
    from air.datagen import weather

    for cls in "ABCDEF":
        for solar in (0.0, 0.4, 0.9):
            for u in (0.6, 3.0, 8.0):
                mine = fc._pbl(cls, solar, u)
                if cls in "AB":
                    theirs = 1050.0 + 700.0 * solar + 42.0 * u
                elif cls == "C":
                    theirs = 780.0 + 470.0 * solar + 45.0 * u
                elif cls == "D":
                    theirs = 380.0 + 300.0 * solar + 70.0 * u
                elif cls == "E":
                    theirs = 205.0 + 55.0 * u
                else:
                    theirs = 128.0 + 42.0 * u
                assert mine == pytest.approx(min(1900.0, theirs))
    # And the solar proxy itself, which is pure geometry.
    for hod in (0, 6, 12, 18):
        for doy in (1, 180, 300):
            assert fc._solar(hod, doy) == pytest.approx(weather._solar(hod, doy))


def test_the_forecast_never_emits_an_impossible_stability(db) -> None:
    """The same discipline as `coerce_class`: never F at 6 m/s. A forecast is
    exactly where that state would otherwise appear, because nothing stops the
    blend pairing a persisted class with a climatological speed."""
    for at in (None, "2026-06-15T12:00:00", "2026-07-20T03:00:00"):
        f = fc.issue(db, CID, at)
        for h in f.hours:
            got, note = dispersion.coerce_class(h.stability, h.speed_ms)
            assert note is None, (at, h.lead_h, h.stability, h.speed_ms)
            assert got == h.stability


def test_a_stable_forecast_never_carries_a_deep_mixed_layer(issued) -> None:
    for h in issued.hours:
        if h.stability in "EF":
            assert h.pbl_m < 600.0, (h.lead_h, h.stability, h.pbl_m)


# ── the corridor, never a centreline ─────────────────────────────────────────

def test_the_corridor_widens_with_lead(db) -> None:
    """A single cone at +72 h is a fabrication with a timestamp on it. The
    measured direction error there displaces the centreline about 2.1 km at
    4 km range, in a campaign barely 10 km across."""
    c = fc.corridor(db, CID, "site-ridgeline")
    angles = [x["half_angle_deg"] for x in c["leads"]]
    assert len(angles) >= 6
    assert angles == sorted(angles), angles
    assert angles[0] < 20.0 and angles[-1] > 60.0, (angles[0], angles[-1])


def test_the_spread_that_widens_it_is_measured(db, issued) -> None:
    """Not an assumed cone-of-uncertainty constant: it is the blend's own
    historical error spread at that lead."""
    spread = fc._spread_by_lead(db, CID)
    assert spread[6] < spread[48] < spread[120]
    for h in issued.hours:
        assert h.dir_sd_deg >= 0.0
    assert issued.hours[0].dir_sd_deg == 0.0, "lead zero is now, and now has no spread"


def test_beyond_the_crossover_is_flagged_in_the_payload(issued) -> None:
    """So a screen cannot draw a confident cone at day five without opting in."""
    assert any(h.beyond_crossover for h in issued.hours)
    for h in issued.hours:
        assert h.beyond_crossover == (h.lead_h > fc.CROSSOVER_H)


# ── what was deliberately NOT built ──────────────────────────────────────────

def test_there_is_no_forecast_table(db) -> None:
    """No `wind_forecast`, no stored tiers, no rebuild. The forecast is a
    function of the record, so storing it would create a second source of
    truth that can fall out of step with the thing it was derived from."""
    names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "wind_forecast" not in names
    assert "forecast_verification" not in names


def test_there_is_no_tier_vocabulary() -> None:
    """The three invented tiers are gone, and with them the circular claim that
    one of them beats another by a margin somebody chose."""
    import pathlib

    src = pathlib.Path(fc.__file__).read_text()
    body = src.split('"""', 2)[2] if src.count('"""') >= 2 else src
    for word in ("'regional'", '"regional"', "forecast_tier"):
        assert word not in body, f"{word} came back"


def test_the_basis_says_which_world_this_is(client, api, json_ok) -> None:
    j = json_ok(client.get(f"{api}/wind/forecast"))
    assert "measured, not chosen" in j["basis"]
    assert "one simulated campaign" in j["basis"]


def test_blending_bearings_wraps_correctly() -> None:
    """Averaging 350 and 10 must give 0, not 180. The bug that makes a forecast
    point at the wrong half of the map."""
    assert float(fc._circ_blend(350.0, 10.0, 0.5)) == pytest.approx(0.0, abs=0.01)
    assert float(fc._circ_blend(10.0, 350.0, 1.0)) == pytest.approx(10.0, abs=0.01)
    assert float(fc._circ_mean([355.0, 5.0])) == pytest.approx(0.0, abs=0.01)


_ = (math, np)
