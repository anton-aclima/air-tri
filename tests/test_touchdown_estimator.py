"""P2-D — the frozen touchdown estimator, and the variants that are wrong.

`scripts/probe_touchdown.py` is throwaway analysis, but the configuration it
settled on is a decision, and three plausible alternatives to it are wrong for
reasons that cost a day each to rediscover. So the decision is pinned to a
committed fixture and the wrong turns are pinned as tests.

The sweep that chose these values is in `docs/PLAN-plume.md`. If a test here
fails, read that before touching the fixture: regenerating
`tests/fixtures/touchdown_frozen.json` to make a red test green throws away the
only record of why the estimator looks like this.
"""

from __future__ import annotations

import json
import pathlib
from dataclasses import asdict, replace

import numpy as np
import pytest

import probe_touchdown as probe

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "touchdown_frozen.json"

pytestmark = pytest.mark.needs_db


@pytest.fixture(scope="module")
def world():
    from air.server import config as air_config

    return probe.World(air_config.DB_PATH)


@pytest.fixture(scope="module")
def golden():
    if not FIXTURE.exists():
        pytest.skip(f"no fixture at {FIXTURE} — `uv run python scripts/probe_touchdown.py fixture`")
    return json.loads(FIXTURE.read_text())


# ── the decision ─────────────────────────────────────────────────────────────

def test_the_frozen_config_is_the_one_in_the_fixture(golden) -> None:
    assert asdict(probe.FROZEN) == golden["config"], (
        "the estimator moved without the fixture moving with it"
    )
    assert probe.DETECT_FLOOR == golden["detect_floor"]


def test_the_frozen_estimator_reproduces_the_fixture(world, golden, pinned_build) -> None:
    if not pinned_build:
        pytest.skip("database was not built with the --now pinned in CLAUDE.md")
    for key, want in golden["estimates"].items():
        site, measure = key.split("/")
        got = probe.estimate(world, site, measure, probe.FROZEN)
        assert got.state == want["state"], f"{key}: {got.state} != {want['state']}"
        assert got.n_hours == want["n_hours"], key
        if want["excess"] is None:
            assert not np.isfinite(got.excess), key
        else:
            assert got.excess == pytest.approx(want["excess"], abs=1e-3), key


def test_exactly_one_finding_is_dependable(world, golden) -> None:
    """The multi-seed check (P2-C) left one result standing across four worlds:
    Ridgeline NO2. Riverport passed in 2 of 4 seeds and Delta Forge's sign
    flipped, so neither may carry a demo beat. This asserts the shape of that
    conclusion, not the numbers."""
    detected = [k for k, v in golden["estimates"].items() if v["state"] == "elevated_downwind"]
    assert "site-ridgeline/no2" in detected
    assert all(k.endswith("/no2") for k in detected), (
        "a PM2.5 detection appeared; every one measured was inside its own null"
    )


# ── the variants that are wrong ──────────────────────────────────────────────

def test_a_control_pool_from_300m_inverts_the_sign(world) -> None:
    """REJECTED VARIANT 1, and the one the gates DO NOT CATCH.

    `field.py` adds an isotropic near field of radius NEAR_SIGMA_M = 640 m, so
    control passes drawn from 0.3-1 km of the source carry the plume they are
    supposed to be a control FOR. The contrast inverts: Ridgeline NO2 reads
    about -19 ppb, a large, confident, WRONG-SIGNED result.

    And it passes every gate. Its placebo ratio is under 0.5 and it clears the
    detection floor several times over, because the artefact is real structure
    in the data rather than noise — a rotation test cannot see it, because the
    near field is isotropic and looks the same at every bearing.

    Which is the argument for the whole shape of P2-D. The frozen configuration
    is chosen by mechanism and pinned to a fixture; it is NOT "whichever cell
    passes the gates", because this cell does.
    """
    near = replace(probe.FROZEN, control_inner_m=300.0, wedge="fixed", match_road_class=False,
                   baseline="raw", min_downwind_per_hour=1, min_control_per_hour=3, min_hours=5)
    got = probe.estimate(world, "site-ridgeline", "no2", near)
    assert got.excess < -5.0, (
        f"the near-field inversion has gone away ({got.excess:+.2f}) — if `field.py`'s "
        "near-field term changed, re-run the sweep before trusting anything"
    )
    assert probe.FROZEN.control_inner_m >= 2.0 * 640.0, (
        "control_inner_m dropped inside the near field; that is what this test is about"
    )


def test_a_fixed_wedge_eats_its_own_control_pool(world) -> None:
    """REJECTED VARIANT 2.

    A 30-degree half-angle is about four times too wide under stable air, where
    the kernel's own sigma_y gives roughly 8 degrees at 2 km, so most of the
    "downwind" set is not downwind of anything — Ridgeline NO2 falls from
    +5.08 to +3.57.

    The bigger problem is the one that is easy to miss. Control passes have to
    sit outside twice the wedge, so widening the wedge to 30 degrees excludes
    everything within 60 degrees of the axis and the control pool collapses
    with it: 743 control passes over 14 paired hours become 253 over 8. The
    rotated-bearing placebos then have too little data to compute AT ALL, so
    the variant cannot even be null-tested. An estimator that cannot be
    falsified is not reportable regardless of what it returns.
    """
    wide = replace(probe.FROZEN, wedge="fixed")
    got = probe.estimate(world, "site-ridgeline", "no2", wide)
    sharp = probe.estimate(world, "site-ridgeline", "no2", probe.FROZEN)
    assert abs(got.excess) < abs(sharp.excess), (got.excess, sharp.excess)
    assert got.n_hours < sharp.n_hours and got.n_control < sharp.n_control / 2
    assert not got.reportable


def test_the_far_field_now_has_truth_but_still_cannot_be_falsified(world) -> None:
    """REJECTED VARIANT 3, retired and replaced (P3-A).

    Before the rebuild this band was a provable false positive: `field.py`
    clipped the truth field at 4,200 m, 989 of 1,307 segments lie beyond that
    from Ridgeline, and Ridgeline PM2.5 at 4.4-6.5 km still returned +1.26
    [+0.52, +2.01] through BOTH rotation tests. The refusal had to be
    structural because no statistic could see it.

    P3-A removed the window, so there is ground truth out there now and the
    structural refusal is gone. What protects the far field instead is weaker
    and honest: there is so little conditioned data at that range that the
    ROTATED estimates cannot be computed at all, and an estimate that cannot be
    falsified is not reportable however tight its interval.
    """
    far = replace(probe.FROZEN, r_lo_m=4400.0, r_hi_m=6500.0)
    assert probe.check_window(far) is None, "the 4,200 m refusal should be retired"

    got = probe.estimate(world, "site-ridgeline", "no2", far)
    assert np.isfinite(got.excess) and got.excess > 0, "expected a far-field estimate to exist now"
    assert not np.isfinite(got.placebo_max), "a placebo became computable — re-read this test"
    assert not got.reportable and got.state == "contested"


# ── the gates ────────────────────────────────────────────────────────────────

def test_a_fabricated_bearing_is_never_reportable(world) -> None:
    """P2-B. Rotate the transport direction off the wind and the finding must go."""
    for rot in (90.0, 180.0, 270.0):
        got = probe.estimate(world, "site-ridgeline", "no2", probe.FROZEN, rotate_deg=rot)
        assert not (np.isfinite(got.excess) and abs(got.excess) >= probe.DETECT_FLOOR["no2"]), (
            f"rotating {rot:.0f} degrees still produced {got.excess:+.2f} ppb"
        )


def test_the_detection_floor_is_above_the_estimator_s_own_noise(world) -> None:
    """The floor is measured, not chosen: twice the worst site's 95th
    percentile of |excess| over fabricated bearings."""
    rots = [float(r) for r in range(15, 360, 15) if not (r <= 30 or r >= 330 or 150 <= r <= 210)]
    for measure, floor in probe.DETECT_FLOOR.items():
        null = np.array([
            e for e in (
                probe.estimate(world, s, measure, probe.FROZEN, rotate_deg=r).excess
                for s in probe.SITES for r in rots
            ) if np.isfinite(e)
        ])
        assert null.size > 20
        assert floor > float(np.percentile(np.abs(null), 95)), (
            f"{measure}: floor {floor} is inside its own null "
            f"(p95 {np.percentile(np.abs(null), 95):.2f})"
        )


# ── what the claim may be ────────────────────────────────────────────────────

def test_the_touchdown_is_a_site_level_claim_not_a_per_segment_one(world) -> None:
    """The answer to the question three territories guessed at.

    Measured under the frozen configuration: 94 of 1,307 segments are ever
    downwind of Ridgeline in stable air, and ZERO of them accumulate 12
    conditioned passes on both sides. A per-segment claim is not available in
    this dataset at any honesty threshold worth having — the touchdown is a
    site-level pooled result, and per-segment geometry is evidence display
    only (P4-C's LineStrings), never a verdict.
    """
    cfg = probe.FROZEN
    site = "site-ridgeline"
    d = world.dist[site][world.pass_seg]
    b = world.brg[site][world.pass_seg]
    in_regime = np.isin(world.hour_class[world.pass_hour], list(cfg.regime))
    off = np.abs((b - world.hour_transport[world.pass_hour] + 180.0) % 360.0 - 180.0)
    half = probe._wedge_half_deg(cfg, world, d)
    downwind = in_regime & (d >= cfg.r_lo_m) & (d <= cfg.r_hi_m) & (off <= half)
    control = in_regime & (d >= cfg.control_inner_m) & (off > half * cfg.control_exclude_mult)

    n_seg = len(world.seg_lon)
    per_seg_d = np.bincount(world.pass_seg[downwind], minlength=n_seg)
    per_seg_c = np.bincount(world.pass_seg[control], minlength=n_seg)
    assert int((per_seg_d > 0).sum()) < n_seg / 5, "more segments are downwind than expected"
    assert int(((per_seg_d >= 12) & (per_seg_c >= 12)).sum()) == 0, (
        "a per-segment claim may now be supportable — re-read P2-D before building one"
    )
