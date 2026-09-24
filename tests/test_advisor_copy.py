"""The advisor's words, held against the rules — the rules engine's AND the model's.

The rules engine is what an operator reads whenever there is no API key or the
model call fails, which on the demo is most of the time. It used to talk like
the radar dial beside it ("the NO2 contact bears ENE (072°) at 6268 m", "while
the level clears") and broke the honesty rules in three places: a model
issuing an all-clear, selling evasion, and putting an unlocated alert "on the
fenceline". CONTRACT 10a.7 bans the metaphor in generated text.

Phase 3's review found the rest: the model's reply replaced the rules answer on
every alert detail and named the site as the source of another operator's
monitor, of a fleet street detection and of a reading at a site whose downwind
test is `no_detection`; the rules engine judged "downwind" on today's wind and
answered with a throttle, including for alerts that had ended; and every site
got datacentre advice. The checks now live in `air.server.advisor_copy`, run
on the model's reply before it is swapped in (`advisor_jobs.accept`), and are
held here against:

* every rules branch, for every alert in the database, from every site, plus
  the synthetic states the data does not reach;
* the replies actually recorded from the model and from the old rules engine
  during the review (tests/fixtures/advisor_recorded_replies.json).
"""

from __future__ import annotations

import copy
import json
import pathlib
import re
from collections.abc import Iterator
from typing import Any

import pytest

from air.server import advisor_copy

pytestmark = pytest.mark.needs_db

RECORDED = pathlib.Path(__file__).parent / "fixtures" / "advisor_recorded_replies.json"


@pytest.fixture(scope="module")
def conn():
    from air.server.db import read_conn

    c = read_conn()
    try:
        yield c
    finally:
        c.close()


@pytest.fixture(scope="module")
def contexts(conn) -> list[dict[str, Any]]:
    """Every alert in the database, as advised from every site, plus no alert."""
    from air.server.models import AdvisorIn
    from air.server.routers.advisor import build_context

    sites = [r[0] for r in conn.execute("SELECT id FROM industry_site ORDER BY id")]
    alerts = [r[0] for r in conn.execute("SELECT id FROM alert ORDER BY id")]
    out = []
    for sid in sites:
        for aid in [*alerts, None]:
            out.append(build_context(conn, AdvisorIn(alert_id=aid, site_id=sid)))
    return out


def _variants(ctx: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """States the pinned data does not reach on its own."""
    yield ctx
    for verdict in ("understates", "overstates", "insufficient_data", "consistent"):
        v = copy.deepcopy(ctx)
        base = v.get("model_verification") or {}
        v["model_verification"] = {
            "verdict": verdict,
            "model_name": base.get("model_name") or "The filed study",
            "n_obs": base.get("n_obs", 40),
            "understated_bearings": base.get("understated_bearings") or [225.0, 247.5],
            "affected_districts": base.get("affected_districts")
            or [{"district": "Boxtown", "assumed_freq": 4.1, "observed_freq": 9.9}],
            "disagreement": 0.31,
        }
        yield v
    v = copy.deepcopy(ctx)
    v["measured_local_wind"] = None
    yield v
    if not v.get("alert"):
        return
    v = copy.deepcopy(ctx)
    v["alert"].update(lon=None, lat=None, bearing_deg=None, distance_m=None)
    yield v
    # Ongoing and ended, linked and not, whatever the data happened to hold.
    for ongoing in (True, False):
        for linked in (True, False):
            v = copy.deepcopy(ctx)
            v["alert"]["ongoing"] = ongoing
            v["link"] = {**(v.get("link") or {}), "linked": linked, "reason": "linked" if linked else "no_detection"}
            yield v
    # Another operator's fenceline sensor.
    v = copy.deepcopy(ctx)
    v["alert"]["ongoing"] = True
    v["link"] = {**(v.get("link") or {}), "linked": True, "reason": "linked"}
    v["alert_monitor"] = {"id": "mon-x", "name": "Someone else's fence", "owner_type": "industry",
                          "site_id": "site-somewhere-else"}
    yield v


def _rules(v: dict[str, Any]) -> dict[str, Any]:
    from air.server import advisor_rules

    return advisor_rules.build(v)


# ── the rules engine passes its own screen ───────────────────────────────────


def test_the_rules_engine_passes_the_screen_it_falls_back_for(contexts) -> None:
    """The rules answer is what stays on screen when the model's reply fails
    the screen, so it must pass the same screen — words, attribution, actions,
    equipment — in every state."""
    bad: list[str] = []
    n = 0
    for ctx in contexts:
        for v in _variants(ctx):
            reply = _rules(v)
            n += 1
            bad += [f"{(v.get('alert') or {}).get('id')}@{(v.get('site') or {}).get('id')}: {b}"
                    for b in advisor_copy.screen(reply, v)]
    assert n > 500, f"only {n} replies checked — the fixture lost its alerts"
    assert not bad, "\n".join(bad[:20])


def test_every_branch_was_exercised(contexts) -> None:
    """Otherwise the tests above prove nothing about the branch that is missing."""
    kinds = {(c.get("alert") or {}).get("kind") for c in contexts}
    for k in ("exceedance", "integrated_exposure", "mobile_detection", "concern_cluster", "wind_shift", None):
        assert k in kinds, f"no {k!r} alert in the database to advise on"
    assert any((c.get("alert") or {}).get("about_study") for c in contexts), "no study-comparison alert"
    stances = {tuple(advisor_copy.stance(c).values()) for c in contexts if c.get("alert")}
    assert any(s[3] for s in stances), "no F7-linked alert anywhere — the cut branch never ran"
    assert any(s[1] for s in stances), "no ended alert — the review branch never ran"


def test_a_cut_answers_only_a_linked_ongoing_alert(contexts) -> None:
    """"Throttle ... by N%" is the response only when F7 holds, the alert is
    still going on and it is not another operator's sensor. Otherwise a
    reduction may be STAGED, never applied."""
    applied = staged = 0
    for ctx in contexts:
        for v in _variants(ctx):
            if not v.get("alert"):
                continue
            reply = _rules(v)
            labels = " ".join(a["label"] for a in reply["actions"])
            st = advisor_copy.stance(v)
            if st["may_cut"] and v["alert"]["kind"] in ("exceedance", "integrated_exposure", "mobile_detection"):
                assert reply["recommendation"].startswith("Throttle"), reply["recommendation"]
                applied += 1
            if not st["may_cut"]:
                assert "Throttle" not in reply["recommendation"], (v["alert"]["id"], reply["recommendation"])
                assert not labels.startswith("Throttle"), labels
                staged += "Stage a" in labels
            if st["ended"]:
                for _where, text in advisor_copy.texts(reply):
                    assert "for the next" not in text, text
    assert applied and staged, (applied, staged)


def test_advice_fits_the_kind_of_site(contexts) -> None:
    """Turbines and compute were advised to a truck terminal and a remelt
    works. The lever and the load-shifting come from the site's kind."""
    for ctx in contexts:
        kind = (ctx.get("site") or {}).get("kind")
        if kind == "datacenter":
            continue
        for v in _variants(ctx):
            text = " ".join(t for _w, t in advisor_copy.texts(_rules(v)))
            for word in (r"\bturbines?\b", r"\bcompute\b", r"\bracks?\b", r"\bworkloads?\b"):
                assert not re.search(word, text, re.IGNORECASE), (kind, (v.get("alert") or {}).get("id"), word)


def test_an_unlocated_alert_is_site_wide_not_due_north(contexts) -> None:
    """The generator stores unlocated alerts ON the site centroid; bearing 0
    at 0 m is the absence of a place. It printed "000° / 0 m" on the deck and
    "on the fenceline" here."""
    seen = 0
    for ctx in contexts:
        a = ctx.get("alert") or {}
        if a.get("distance_m") is not None and a["distance_m"] < 1.0:
            reply = _rules(ctx)
            assert "N of the site" not in reply["recommendation"], reply["recommendation"]
            assert "on the fenceline" not in reply["recommendation"]
            seen += 1
    assert seen, "no alert sits on its site centroid — the case this guards has gone"


def test_the_study_comparison_is_not_advised_as_a_wind_shift(contexts) -> None:
    """Both share the `wind_shift` kind in the generator; only one is weather."""
    for ctx in contexts:
        a = ctx.get("alert") or {}
        if a.get("about_study"):
            rec = _rules(ctx)["recommendation"]
            assert "veered" not in rec, rec
            assert "study" in rec, rec


def test_the_study_rides_only_where_it_is_the_question(contexts) -> None:
    """ "Verify your consultant" is a supporting point, not a line on every
    alert's advice — a vehicle out of service included."""
    with_study = without = 0
    for ctx in contexts:
        labels = [x["label"] for x in _rules(ctx)["actions"]]
        has = any("dispersion study" in label for label in labels)
        a = ctx.get("alert") or {}
        if a.get("about_study"):
            assert has, a.get("id")
        with_study += has
        without += not has
    assert with_study and without, (with_study, without)


def test_the_study_numbers_are_the_campaign_window(conn, contexts, client, api, campaign, json_ok) -> None:
    """One study verdict, one set of numbers: the advisor quotes the same
    verification /industry/site shows (the campaign window, sent naive as
    `useCampaignWindow` sends it), not its own 30-day one."""
    ctx = next(c for c in contexts if (c.get("site") or {}).get("id") == "site-ridgeline" and c.get("model_verification"))
    window = {"from": f"{campaign['start_date']}T00:00:00", "to": f"{campaign['end_date']}T23:59:59"}
    page = json_ok(client.get(f"{api}/sites/site-ridgeline/model-verification", params=window))
    assert ctx["model_verification"]["n_obs"] == page["n_obs"]
    assert ctx["model_verification"]["verdict"] == page["verdict"]


# ── the model's reply meets the same rules ───────────────────────────────────


def _recorded() -> list[dict[str, Any]]:
    return json.loads(RECORDED.read_text())["replies"]


def test_the_screen_refuses_what_the_review_caught(conn, pinned_build) -> None:
    """Replies recorded on the pinned build: the model named the site as the
    source of another operator's monitor 6.3 km away, of a fleet street
    detection and of a reading where the downwind test is `no_detection`, and
    advised cuts on alerts that had ended; the old rules engine gave a works
    and a terminal turbines and compute. Every one of those is refused. The
    one F7 allows — Ridgeline's cluster, downwind when reported and on a
    site whose NO2 test passed the rotation check — is let through, so the
    screen is not simply refusing everything."""
    if not pinned_build:
        pytest.skip("the recorded replies are about the pinned build's alerts")
    from air.server.models import AdvisorIn
    from air.server.routers.advisor import build_context

    allowed = {("llm", "al-cluster-07", "site-ridgeline"),
               ("rules_before_phase3", "al-cluster-07", "site-ridgeline"),
               ("rules_before_phase3", "al-windshift-00", "site-ridgeline")}
    for r in _recorded():
        ctx = build_context(conn, AdvisorIn(alert_id=r["alert_id"], site_id=r["site_id"]))
        problems = advisor_copy.screen(r["reply"], ctx)
        key = (r["source"], r["alert_id"], r["site_id"])
        if key in allowed:
            assert not problems, (key, problems)
        else:
            assert problems, f"{key} passed the screen"


def test_a_refused_reply_keeps_the_rules_answer() -> None:
    """`accept` is the only way a model reply becomes the job's reply; a
    refused one leaves the snapshot serving the rules answer, which is what
    the polling client reads."""
    from air.server import advisor_jobs

    rules = {"recommendation": "Check your fenceline sensors.", "actions": [], "rationale": "",
             "confidence": "medium", "source": "rules"}
    bad = {"recommendation": "Your plume is reaching the monitor; the site is the source.",
           "actions": [{"label": "Throttle turbines by 30%", "detail": "Now.", "impact": None}],
           "rationale": "", "confidence": "high", "source": "llm"}
    ctx = {"alert": {"id": "a", "ongoing": True, "title": ""}, "link": {"linked": False},
           "site": {"id": "s", "kind": "datacenter", "name": "Site", "emission_points": [{"name": "Turbine bank A", "kind": "generator"}]}}
    job = advisor_jobs.create(rules)
    assert not advisor_jobs.accept(job, bad, lambda reply: advisor_copy.screen(reply, ctx))
    assert job.status == "failed" and job.error == "screened"
    assert job.snapshot()["reply"] is rules
    assert job.events[-1]["event"] == "error" and job.events[-1]["data"]["keep"] == "rules"

    good = {**bad, "recommendation": "Check your fenceline sensors before changing anything.",
            "actions": [{"label": "Check your fenceline sensors", "detail": "Compare the hours.", "impact": None}]}
    job = advisor_jobs.create(rules)
    assert advisor_jobs.accept(job, good, lambda reply: advisor_copy.screen(reply, ctx))
    assert job.snapshot()["reply"] is good


def test_the_prompt_describes_the_real_screen(conn, contexts) -> None:
    from air.server.routers import advisor

    assert "radar" not in advisor.SYSTEM.split("Language")[0].lower(), (
        "the prompt still tells the model the operator's screen is a radar"
    )
    assert "usually an AI datacenter" not in advisor.SYSTEM
    for word in ("Critical", "Warning", "Watch"):
        assert word in advisor.SYSTEM
    for ctx in contexts[:40]:
        prompt = advisor._prompt(ctx)
        assert "# The contact" not in prompt
        assert "bearing to the contact" not in prompt
        a = ctx.get("alert") or {}
        if a:
            assert "# What the advice may do" in prompt
            assert ("linked: true" in prompt) == bool((ctx.get("link") or {}).get("linked"))
        if a.get("distance_m") is not None and a["distance_m"] < 1.0:
            assert "site-wide" in prompt
