"""P8 (phase 6 of PLAN-refocus): a stored recommendation the regulator reads
points at the evidence, never tells an operator what to do; the industry room
still gets its own site's lever, through routers/alerts.py `_for_operator`.

The concern-cluster line ("Check generator and cooling-tower logs ..., then
post an acknowledgement to the community feed"), the generator's cluster line
("Check operations for this window and reply to the cluster"), the runtime
wind-shift line ("Reduce turbine load pre-emptively") and the study line
("Re-run the dispersion study ... before the next permit filing") were all
addressed to an operator on alerts the regulator's queue carries.
"""

from __future__ import annotations

import re

import pytest

from air.server import advisor_rules, domain, sim
from air.server.routers import alerts as alerts_router

#: An instruction to an operator, at the start of a sentence.
OPERATOR_VOICE = re.compile(
    r"(^|\. )(Check operations|Check generator|Reduce |Re-run the (dispersion|study)|Consider reducing|Walk )"
    r"|reply to the (cluster|reports)|post an acknowledgement|permit (filing|review)|cooling-tower"
    r"|transport as live|turbine seals|handheld"
)


def test_the_runtime_lines_are_agency_neutral():
    for line in (domain.CLUSTER_RECOMMENDATION, sim.WIND_SHIFT_RECOMMENDATION,
                 sim.METHANE_RECOMMENDATION, sim.STUDY_DIVERGENCE_OPENING):
        assert not OPERATOR_VOICE.search(line), line


@pytest.mark.needs_db
def test_the_methane_scenario_line_is_worded_for_the_operator(db):
    """S2: the methane scenario stores an evidence line; each site's operator
    reads its own ch4 lever in its place, and the rest of the line is kept."""
    for stored, tail in (
        (sim.METHANE_RECOMMENDATION, ";" + sim.METHANE_RECOMMENDATION.split(";", 1)[1]),
        # A database built before phase 6 reads the same.
        ("Walk the gas supply train, filter skids and turbine seals along this frontage with a "
         "handheld before assuming combustion. A single seal can account for the whole signal.",
         ". A single seal can account for the whole signal."),
    ):
        for site in db.execute("SELECT id, kind FROM industry_site"):
            lever, _ = advisor_rules.lever_for(dict(site), "ch4")
            out = alerts_router._for_operator(
                db, [{"recommendation": stored, "source_type": "mobile", "measure": "ch4",
                      "audience": ["regulator", "industry", "admin"]}], site["id"])
            assert out[0]["recommendation"] == (
                f"Walk {lever} along this frontage with a handheld before assuming combustion{tail}"
            ), (site["id"], out[0]["recommendation"])


@pytest.mark.needs_db
def test_the_study_scenario_line_is_worded_for_the_operator(db):
    """S1: the model-divergence scenario stores an evidence line; industry
    reads the re-run line in its place, the measured evidence kept."""
    evidence = "; Boxtown sits downwind on NNE wind, which the model weighted at 2.0% of hours against 9.0% measured."
    out = alerts_router._for_operator(
        db, [{"recommendation": sim.STUDY_DIVERGENCE_OPENING + evidence, "source_type": "mobile",
              "measure": "no2", "audience": ["industry", "regulator", "admin"]}], "site-ridgeline")
    assert out[0]["recommendation"] == (
        "Re-run the study with the measured rose before the next permit review" + evidence
    )


@pytest.mark.needs_db
def test_the_regulator_reads_no_operator_instruction(client, api, json_ok):
    for a in json_ok(client.get(f"{api}/alerts", params={"role": "regulator"})):
        assert not OPERATOR_VOICE.search(a.get("recommendation") or ""), (a["id"], a["recommendation"])


@pytest.mark.needs_db
def test_industry_gets_its_sites_lever_on_a_cluster(client, api, json_ok, db):
    site = dict(db.execute("SELECT id, kind FROM industry_site WHERE id='site-ridgeline'").fetchone())
    lever, _ = advisor_rules.lever_for(site, "no2")
    found = json_ok(client.get(f"{api}/alerts", params={"role": "industry", "site_id": site["id"]}))
    clusters = [a for a in found if a["kind"] == "concern_cluster"]
    assert clusters, "no cluster alert reached Ridgeline's list"
    for a in clusters:
        assert a["recommendation"].startswith(f"Check {lever} for the reported window, then reply to the reports."), a
        assert a["recommendation"].endswith("An operator reply does not close a resident's report.")
    study = [a for a in found if a["kind"] == "wind_shift"]
    for a in study:
        assert a["recommendation"] == "Re-run the dispersion study against measured wind before the next permit filing."


@pytest.mark.needs_db
@pytest.mark.parametrize(
    "stored, opening",
    [
        (domain.CLUSTER_RECOMMENDATION, "Check {lever} for the reported window, then reply to the reports."),
        # A database built before phase 6 reads the same.
        ("Check generator and cooling-tower logs for the reported window, then post an acknowledgement "
         "to the community feed.", "Check {lever} for the reported window, then reply to the reports."),
        (sim.WIND_SHIFT_RECOMMENDATION, "Consider reducing {lever} ahead of the shift;"),
        ("Reduce turbine load pre-emptively; a stable, slow plume does not dilute.",
         "Consider reducing {lever} ahead of the shift;"),
    ],
)
def test_every_agency_line_is_worded_for_the_operator(db, stored, opening):
    for site in db.execute("SELECT id, kind FROM industry_site"):
        lever, _ = advisor_rules.lever_for(dict(site), "no2")
        out = alerts_router._for_operator(db, [{"recommendation": stored, "source_type": "model", "audience": ["industry"]}], site["id"])
        assert out[0]["recommendation"].startswith(opening.format(lever=lever)), (site["id"], out[0]["recommendation"])
