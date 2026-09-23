"""P9 — the Mission Brief, read-only over the datagen-built plan.

What these protect, in order of how easily each would be lost:

- The brief reads the plan that PRODUCED the data, never whichever plan the
  regenerate lever last marked active.
- Strata are geometry. Downwind, upwind and background are mirror-image
  wedges tested at analysis time; nothing is stored.
- Days 2-5 are a watch list. Nothing is assigned past day 1.
- Debrief intervals count hours, not passes, and a verdict that failed the
  placebo carries no interval and no sample size (CONTRACT 10a.4).
- The stability forecast follows the sun. The first version persisted the
  07:00 class into the night and was right 11% of the time at 12 hours.
"""

from __future__ import annotations

import math
import re

import numpy as np
import pytest

from air.server import brief, forecast, plumeframe

CID = "cmp-swmem-2026"

VERDICTS = {"local", "advected", "no_detection", "contested", "unpaired"}


def _frame(axis=0.0, half=20.0, onset=0.0, reach=3000.0, faint=False) -> plumeframe.Frame:
    return plumeframe.Frame(
        site_id="s", origin=(0.0, 0.0), lead_h=0, valid_at="2026-01-01T00:00:00",
        axis_deg=axis, half_angle_deg=half, plume_half_deg=half, x_onset_m=onset,
        x_reach_m=reach, stability="E", dir_sd_deg=0.0, beyond_crossover=False, faint=faint,
    )


# ── geometry, no database ────────────────────────────────────────────────────

def test_the_three_strata_are_mirror_wedges() -> None:
    d = np.array([1000.0, 1000.0, 1000.0, 200.0, 5000.0, 1000.0])
    b = np.array([0.0, 180.0, 90.0, 0.0, 180.0, 359.0])
    got = [plumeframe.STRATA[i] for i in plumeframe.strata(_frame(), d, b)]
    assert got == ["downwind", "upwind", "background",
                   # inside the fence is the operator's own ground, not downwind
                   "background",
                   # past 4 km "upwind of the site" is upwind of somewhere else
                   "background",
                   # 359 is one degree off north, not 359 — wrap-safe
                   "downwind"]


def test_a_faint_frame_puts_every_street_in_background() -> None:
    d = np.array([1000.0, 1000.0])
    b = np.array([0.0, 180.0])
    assert (plumeframe.strata(_frame(faint=True), d, b) == 2).all()


def test_the_upwind_wedge_neither_vanishes_nor_swallows_the_map() -> None:
    """A stable plume at lead 0 is a few degrees wide; at five days the
    corridor is a 159-degree sector. Neither is a leg a driver can be sent to."""
    assert plumeframe.upwind_half(_frame(half=3.0)) == plumeframe.UPWIND_MIN_HALF_DEG
    assert plumeframe.upwind_half(_frame(half=80.0)) == plumeframe.UPWIND_MAX_HALF_DEG


def test_a_sector_ring_is_closed() -> None:
    ring = plumeframe.sector_ring((-90.0, 35.0), 10.0, 15.0, 300.0, 3000.0)
    assert ring[0] == ring[-1]
    assert len(ring) > 10


def test_intervals_count_hours_not_passes() -> None:
    """Sixty passes in one hour are closer to one observation than to sixty.
    Counting them as sixty made an eight-pass upwind leg look decisive."""
    rng = np.random.default_rng(0)
    v = rng.normal(0.0, 5.0, 60)
    one_hour = brief._stat(v, np.zeros(60))
    many = brief._stat(v, np.arange(60))
    w1 = one_hour["ci_hi"] - one_hour["ci_lo"]
    w60 = many["ci_hi"] - many["ci_lo"]
    assert w1 / w60 == pytest.approx(math.sqrt(60), rel=1e-3)


# ── the database ─────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def payload(client, api, json_ok):
    return json_ok(client.get(f"{api}/admin/brief"))


@pytest.mark.needs_db
def test_the_brief_reads_the_plan_that_produced_the_data(payload, db) -> None:
    """Sheet 03's lever writes a new ACTIVE plan from a serpentine stand-in
    whose routes drove nothing. The brief must not follow the flag."""
    produced = db.execute(
        "SELECT plan_id FROM drive WHERE plan_id IS NOT NULL "
        "GROUP BY plan_id ORDER BY COUNT(*) DESC LIMIT 1"
    ).fetchone()[0]
    assert payload["plan_id"] == produced
    assert payload["read_only"] is True
    # Every assignment is one of that plan's routes.
    ids = {r[0] for r in db.execute("SELECT id FROM drive_route WHERE plan_id=?", (produced,))}
    assert payload["assignments"]
    assert {a["route_id"] for a in payload["assignments"]} <= ids


@pytest.mark.needs_db
def test_nothing_is_assigned_past_day_one(payload) -> None:
    """At 96 h the forecast has no skill over persistence. A five-day targeted
    plan presented as a schedule is the overclaim this screen is built to avoid."""
    days = payload["outlook"]
    assert [d["status"] for d in days] == ["assigned"] * 2 + ["watch"] * 4
    assert {a["day"] for a in payload["assignments"]} <= {0, 1}
    assert {r["day"] for r in payload["routes"]} <= {0, 1}
    assert all(d["beyond_crossover"] for d in days[3:])


@pytest.mark.needs_db
def test_the_call_ends_in_a_bearing_and_a_district_and_says_forecast(payload) -> None:
    call = payload["call"]
    s = call["sentence"]
    if call["axis_deg"] is None:
        pytest.skip("no plume crossing forecast on this day")
    assert re.search(r"toward \d+° [NSEW]{1,3} — [^.]+\.$", s), s
    # CONTRACT 10a.1: a model is predicted, never measured.
    assert "forecast" in s
    assert call["confidence"]["tier"] in {"persistence", "blend", "climatology"}


@pytest.mark.needs_db
def test_the_brief_never_says_what_it_must_not(payload) -> None:
    text = " ".join([payload["call"]["sentence"]]
                    + [a["control_line"] for a in payload["assignments"]]).lower()
    for phrase in ("measured", "detected", "observed", "optimal", "reduces cost",
                   "coverage complete", "earth-2"):
        assert phrase not in text, phrase


@pytest.mark.needs_db
def test_the_ledger_shows_cost_coverage_and_capture_together(payload) -> None:
    """Targeting reallocates the same shifts. Showing capture without cost,
    or cost without coverage, is how 'targeting reduces cost' gets said."""
    led = payload["ledger"]
    for k in ("vehicle_hours", "network_pct", "downwind_km", "upwind_km"):
        assert led[k] is not None, k
    if led["control_share"] is not None:
        assert led["control_check"] == ("pass" if led["control_share"] >= brief.MIN_CONTROL_SHARE else "fail")


@pytest.mark.needs_db
def test_the_sample_size_argument_is_computed_not_quoted(payload) -> None:
    s = payload["sample_size"]
    assert s["paired_hours"] <= min(s["downwind_hours"], s["upwind_hours"])
    assert 0 < s["sectors_covered"] <= s["sectors_total"] == 16
    # The argument for targeted driving: the uniform plan rarely puts a car on
    # both sides of a source in the same hour. If this ever fails the brief's
    # standing argument has changed and its copy must too.
    assert s["paired_rate"] < 0.20


@pytest.fixture(scope="module")
def sweep(db):
    dates = [r[0] for r in db.execute(
        "SELECT DISTINCT date FROM drive ORDER BY date DESC LIMIT 12")]
    return [brief.build(db, CID, date=d) for d in dates]


@pytest.mark.needs_db
def test_every_debrief_verdict_obeys_the_contract(sweep) -> None:
    seen = set()
    for b in sweep:
        for d in b["debrief"]["sites"]:
            seen.add(d["verdict"])
            assert d["verdict"] in VERDICTS
            if d["verdict"] == "contested":
                # 10a.4: no interval, no sample size.
                assert d["bars"] is None and d["downwind_minus_upwind"] is None
                assert d["paired_hours"] is None
            if d["verdict"] == "unpaired":
                assert d["missing"] or not d["concurrent"]
            if d["verdict"] in ("local", "advected"):
                # A comparison across different hours carries the diurnal
                # cycle, not the plume.
                assert d["paired_hours"] >= 1
            if d["verdict"] == "local":
                assert d["placebo_ratio"] is not None
                assert d["placebo_ratio"] < brief.PLACEBO_MAX_RATIO
                assert d["downwind_minus_upwind"]["ci_lo"] > 0
    # The screen's whole argument: some days cannot be read at all.
    assert "unpaired" in seen


@pytest.mark.needs_db
def test_moving_the_cursor_back_a_day_redraws_the_outlook(sweep) -> None:
    """The plan changes because the forecast changed. If two consecutive days
    had identical outlooks, the brief would be a monthly document."""
    a, b = sweep[0]["outlook"], sweep[1]["outlook"]
    assert [d["axis_deg"] for d in a] != [d["axis_deg"] for d in b]


@pytest.mark.needs_db
def test_the_corridor_and_the_brief_use_one_half_angle(db) -> None:
    """`forecast.corridor` and the brief's route test draw the same corridor."""
    fc = forecast.issue(db, CID, None, leads=(0, 24))
    cor = forecast.corridor(db, CID, "site-ridgeline")
    by_lead = {c["lead_h"]: c for c in cor["leads"]}
    sources = forecast._site_sources(db, "site-ridgeline")
    for h in fc.hours:
        f = plumeframe.frame("site-ridgeline", (0.0, 0.0), sources, h)
        if f.faint or h.lead_h not in by_lead:
            continue
        assert by_lead[h.lead_h]["half_angle_deg"] == pytest.approx(f.half_angle_deg, abs=0.2)


@pytest.mark.needs_db
def test_a_bad_date_is_a_422_not_a_500(client, api) -> None:
    assert client.get(f"{api}/admin/brief", params={"date": "yesterday"}).status_code == 422


# ── the stability forecast follows the sun ──────────────────────────────────


@pytest.mark.needs_db
@pytest.mark.parametrize("lead", [3, 12, 36])
def test_stability_beats_climatology_where_it_claims_to(db, lead) -> None:
    """Regression: persisting the class AT ISSUE was right 11% of the time at
    12 h — a 07:00 class B forecast for 23:00. The same hour on the last
    observed day is right about 78% of the time; climatology about 65%."""
    r = forecast.load(db, CID)
    idx = np.arange(48, len(r.ts) - lead)
    got = np.array([forecast.stability_raw(r, int(i), lead, int(r.hod[i + lead])) for i in idx])
    truth = r.cls[idx + lead]
    clim = np.array([r.clim_cls_hod[h] for h in r.hod[idx + lead]])
    assert (got == truth).mean() >= (clim == truth).mean()
