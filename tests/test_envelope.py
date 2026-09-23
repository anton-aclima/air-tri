"""P5 — the operating envelope, the industry tier's spine.

The claim this file protects: a site's fenceline is measurably worse than
comparable roads, by an amount that depends on the weather, and that difference
is what limits how hard the site can run.

Measured on the shipped database, Ridgeline's fenceline against class-matched
roads at least 2 km from every site, paired by night:

    unstable (A/B)   +13.2 ppb    0.0% of passes over the 60 ppb watch line
    neutral  (C/D)   +10.6 ppb    0.0%
    stable   (E/F)   +55.7 ppb   75.8%

The site runs at 268 MW. On a typical stable night its envelope is 210 MW.
"""

from __future__ import annotations

import numpy as np
import pytest

from air.server import envelope as env

pytestmark = pytest.mark.needs_db

SITES = ("site-ridgeline", "site-deltaforge", "site-riverport")


@pytest.fixture(scope="module")
def levels(db):
    return [
        dict(r)
        for r in db.execute(
            "SELECT id,label,measure,threshold,unit,severity,source FROM action_level "
            "WHERE measure='no2' AND enabled=1 ORDER BY threshold"
        )
    ]


@pytest.fixture(scope="module")
def passes(db):
    return env.load(db, "cmp-swmem-2026", "no2")


@pytest.fixture(scope="module")
def ridgeline(db, passes, levels):
    return env.estimate(db, passes, "site-ridgeline", "no2", "ppb", 268.0, levels)


def _regime(e, name):
    return next(r for r in e.regimes if r.regime == name)


# ── the finding ──────────────────────────────────────────────────────────────

def test_the_envelope_closes_at_night_and_opens_by_morning(ridgeline) -> None:
    """The whole product. If this ever stops holding, the tier has no spine."""
    day = _regime(ridgeline, "unstable")
    night = _regime(ridgeline, "stable")
    assert day.excess is not None and night.excess is not None
    assert night.excess > day.excess * 2.5, (day.excess, night.excess)
    assert night.state == "binding"
    assert day.state != "binding", "the envelope binds in daylight too — re-read P5"


def test_the_fenceline_is_the_site_s_own_road(ridgeline) -> None:
    assert ridgeline.fenceline_roads == ["Paul R Lowry Road"]
    assert 0 < ridgeline.n_fenceline_segments < 20


def test_only_the_stable_regime_crosses_a_line(ridgeline) -> None:
    for r in ridgeline.regimes:
        over = max((t.share_over for t in r.thresholds), default=0.0)
        if r.regime == "stable":
            assert over > 0.25, f"the watch line is crossed on only {over:.1%} of stable passes"
        else:
            assert over == 0.0, f"{r.regime} crosses a line at {over:.1%}"


def test_the_headroom_is_below_what_the_site_actually_runs(ridgeline) -> None:
    """The sentence the tier exists to say: on a typical stable night this site
    is running above what the air has room for."""
    night = _regime(ridgeline, "stable")
    watch = min(night.thresholds, key=lambda t: t.threshold)
    assert watch.headroom_mw_typical is not None
    assert watch.headroom_mw_typical < ridgeline.load_mw
    assert 0 < watch.cut_pct_typical < 100
    assert watch.cut_pct_bad_night > watch.cut_pct_typical


# ── the gate ─────────────────────────────────────────────────────────────────

def test_an_arbitrary_patch_of_road_produces_nothing(passes) -> None:
    """The null this statistic needs. There is no bearing to rotate here, so
    the null comes from treating somewhere else as if it were a fenceline."""
    nulls = env.decoy_null(passes, "no2", env.REGIMES["stable"], n=60, seed=3)
    assert nulls.size >= 30, "not enough decoys to calibrate against"
    assert abs(float(nulls.mean())) < 2.0, f"the decoys are not centred on zero: {nulls.mean():+.2f}"
    assert float(np.percentile(np.abs(nulls), 95)) < env.DECOY_FLOOR["no2"], (
        "the detection floor is inside its own null"
    )


def test_the_floor_rejects_a_site_that_is_not_distinguishable(db, passes, levels) -> None:
    """`indistinct` is a real outcome and must be reachable, or the state is
    decoration. Both smaller sites land there in daylight."""
    states = set()
    for site in SITES:
        e = env.estimate(db, passes, site, "no2", "ppb", None, levels)
        states |= {r.state for r in e.regimes}
    assert "indistinct" in states
    assert "binding" in states


def test_ridgeline_clears_the_floor_by_a_wide_margin(ridgeline, passes) -> None:
    night = _regime(ridgeline, "stable")
    nulls = env.decoy_null(passes, "no2", env.REGIMES["stable"], n=60, seed=3)
    z = (night.excess - float(nulls.mean())) / float(nulls.std(ddof=1))
    assert z > 10, f"z = {z:.1f}"


# ── honesty about what is measured and what is modelled ──────────────────────

def test_the_megawatt_figure_is_labelled_modelled(client, api, json_ok) -> None:
    j = json_ok(client.get(f"{api}/sites/site-ridgeline/envelope"))
    note = j["headroom_is_modelled"]
    assert "measured" in note and "scales with its load" in note


def test_a_site_without_a_load_rating_still_gets_an_envelope(client, api, json_ok) -> None:
    """Delta Forge is a metals works and Riverport a logistics terminal; neither
    carries megawatts. The percentage form is what makes the instrument work
    for every site."""
    j = json_ok(client.get(f"{api}/sites/site-deltaforge/envelope"))
    assert j["load_mw"] is None
    night = next(r for r in j["regimes"] if r["regime"] == "stable")
    assert night["excess"] is not None
    for t in night["thresholds"]:
        assert t["headroom_mw_typical"] is None
        assert t["cut_pct_typical"] is not None


def test_binding_means_the_typical_episode_needs_a_cut(client, api, json_ok) -> None:
    """Not "one pass once crossed a line". Delta Forge clears 0.8% of its
    stable passes over the watch level and still sits well under it at the
    median; calling that binding would put every site in one state."""
    for sid, want in (("site-ridgeline", "binding"), ("site-deltaforge", "elevated")):
        j = json_ok(client.get(f"{api}/sites/{sid}/envelope"))
        night = next(r for r in j["regimes"] if r["regime"] == "stable")
        assert night["state"] == want, (sid, night["state"], night["thresholds"])


def test_an_uncalibrated_measure_is_refused(client, api) -> None:
    r = client.get(f"{api}/sites/site-ridgeline/envelope", params={"measure": "co2"})
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "measure_not_calibrated"


def test_unknown_site_is_404(client, api) -> None:
    assert client.get(f"{api}/sites/nope/envelope").status_code == 404


# ── the statistic's own shape ────────────────────────────────────────────────

def test_pairing_is_by_night_not_by_clock_hour(passes) -> None:
    """Hour-pairing is stricter and was tried first. It discards half the
    episodes: Ridgeline's fenceline is entirely `tertiary`, and in half the
    hours no tertiary comparison road was driven at all. Where both are
    computable they agree."""
    keys = env._night_keys(passes.pass_ts)
    assert len(set(keys)) < len(passes.hours), "episode keys are not coarser than hours"
    # The key is a day starting at 06:00, so an evening and the small hours that
    # follow it are ONE episode rather than two either side of midnight. That is
    # the whole point: a stable night must not be split down the middle.
    assert env._night_keys(["2026-08-11T23:30:00"])[0] == env._night_keys(["2026-08-12T03:30:00"])[0]
    assert env._night_keys(["2026-08-11T23:30:00"])[0] != env._night_keys(["2026-08-11T05:30:00"])[0]


def test_comparison_roads_are_far_from_every_site_not_just_this_one(passes) -> None:
    """Three sites in a 12 km box otherwise compare against each other's
    fencelines, which would shrink every excess toward zero."""
    everyone = env._distance_to_nearest(
        passes, [pt for pts in passes.site_points.values() for pt in pts]
    )
    mine = env._distance_to_nearest(passes, passes.site_points["site-ridgeline"])
    far = everyone >= env.COMPARISON_MIN_M
    assert far.sum() > 100
    assert not (far & (mine <= env.FENCELINE_M)).any()
    for other in ("site-deltaforge", "site-riverport"):
        d = env._distance_to_nearest(passes, passes.site_points[other])
        assert not (far & (d <= env.FENCELINE_M)).any(), f"{other}'s fenceline is in the comparison set"


# ── P5-E: model provenance ───────────────────────────────────────────────────

def test_a_filed_study_is_labelled_as_one(db) -> None:
    """`model_tier` exists and every seeded study is `permit`.

    The word "tier" was used for four different things across the design work —
    model provenance, forecast horizon, entitlement, confidence — and two of
    them were drafted as conflicting CHECK constraints on this one table. This
    column carries provenance and nothing else; a forecast horizon gets its own
    column when phase 8 needs one.
    """
    cols = {r[1] for r in db.execute("PRAGMA table_info(dispersion_model)")}
    assert "model_tier" in cols
    seen = {r[0] for r in db.execute("SELECT DISTINCT model_tier FROM dispersion_model")}
    assert seen == {"permit"}, seen


def test_the_check_constraint_rejects_an_invented_tier() -> None:
    import sqlite3

    from air.server import config as air_config

    conn = sqlite3.connect(":memory:")
    conn.executescript(air_config.SCHEMA_PATH.read_text())
    conn.execute("PRAGMA foreign_keys = OFF")
    base = ("m1", "s", "c", "n", "no2", "[]")
    conn.execute(
        "INSERT INTO dispersion_model (id,site_id,campaign_id,name,measure,assumed_wind_json,"
        "model_tier) VALUES (?,?,?,?,?,?,'aclima')", base,
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO dispersion_model (id,site_id,campaign_id,name,measure,assumed_wind_json,"
            "model_tier) VALUES ('m2',?,?,?,?,?,'premium')", base[1:],
        )


def test_the_api_serves_the_tier(client, api, json_ok) -> None:
    models = json_ok(client.get(f"{api}/sites/site-ridgeline/dispersion-models"))
    assert models
    for m in models:
        assert m["model_tier"] == "permit"
