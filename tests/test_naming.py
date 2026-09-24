"""F7 on the server (`air.server.naming`): when may a site be tied to an alert?

Both halves or nothing: the wind at the alert's START carried from the site to
it, inside the detection envelope for that hour, AND the site's placebo-checked
downwind test for that pollutant is `elevated_downwind`. The advisor acts on
this (a cut is the response only when it holds), so a wrong answer here is an
operator told to throttle for another operator's monitor.
"""

from __future__ import annotations

import pytest

from air.server import naming

pytestmark = pytest.mark.needs_db


@pytest.fixture(scope="module")
def conn():
    from air.server.db import read_conn

    c = read_conn()
    try:
        yield c
    finally:
        c.close()


def _site(conn, sid):
    from air.server import loaders

    cid = conn.execute("SELECT campaign_id FROM industry_site WHERE id=?", (sid,)).fetchone()[0]
    return cid, loaders.load_sites(conn, cid, site_id=sid)[0]


def _alert(conn, aid):
    from air.server import shapes

    return shapes.alert(conn.execute("SELECT * FROM alert WHERE id=?", (aid,)).fetchone())


def test_the_wind_is_read_at_the_alerts_start(conn) -> None:
    """Not the latest 24 h: that is how an alert that began on a south-easterly
    was advised as if today's south-westerly had carried the site's air to it."""
    from air.server import timeutil

    cid, site = _site(conn, "site-ridgeline")
    seen = 0
    for (aid,) in conn.execute("SELECT id FROM alert WHERE lon IS NOT NULL ORDER BY id"):
        a = _alert(conn, aid)
        link = naming.alert_link(conn, cid, a, site)
        w = link["wind_at_start"]
        if w is None:
            continue
        start, ts = timeutil.parse(a["started_at"]), timeutil.parse(w["ts"])
        assert ts <= start and (start - ts).total_seconds() <= naming.WIND_MAX_AGE_H * 3600, (aid, w["ts"])
        seen += 1
    assert seen > 10


def test_another_operators_monitor_is_never_this_sites(conn) -> None:
    """DRAQA's Riverport Road monitor is 6.3 km from Ridgeline — past every
    detection envelope, and CONTRACT 10b judges nothing from there."""
    cid, site = _site(conn, "site-ridgeline")
    rows = conn.execute("SELECT id FROM alert WHERE source_id='mon-ref-0034'").fetchall()
    assert rows
    for (aid,) in rows:
        link = naming.alert_link(conn, cid, _alert(conn, aid), site)
        assert not link["linked"], (aid, link)
        assert link["reason"] in ("not_downwind", "beyond_envelope", "no_wind"), (aid, link["reason"])


def test_a_site_whose_test_is_inside_the_noise_is_never_named(conn) -> None:
    """Delta Forge's NO2 test is `no_detection` (1.78 ppb under a 3.28 floor)
    and PM2.5 is too; whatever the wind did, nothing links to it."""
    cid, site = _site(conn, "site-deltaforge")
    assert naming.touchdown_state(conn, cid, "site-deltaforge", "no2") != "elevated_downwind"
    for (aid,) in conn.execute("SELECT id FROM alert ORDER BY id"):
        a = _alert(conn, aid)
        members = []
        if a["kind"] == "concern_cluster":
            members = [dict(r) for r in conn.execute("SELECT * FROM concern WHERE cluster_id=?", (a["source_id"],))]
        assert not naming.alert_link(conn, cid, a, site, members)["linked"], aid


def test_an_uncalibrated_pollutant_has_no_test_to_pass(conn) -> None:
    """Diesel, black carbon and methane have no calibrated detection floor, so
    a fleet detection of them is never linked — however close to the fence."""
    for sid in ("site-ridgeline", "site-deltaforge", "site-riverport"):
        cid, site = _site(conn, sid)
        for (aid,) in conn.execute("SELECT id FROM alert WHERE source_type='mobile' AND lon IS NOT NULL"):
            link = naming.alert_link(conn, cid, _alert(conn, aid), site)
            assert not link["linked"], (sid, aid, link)


def test_noise_reports_are_never_linked_by_an_air_test(conn) -> None:
    cid, site = _site(conn, "site-ridgeline")
    a = _alert(conn, "al-cluster-07")
    noise = [{"kind": k, "suspected_site_id": "site-ridgeline"} for k in ("noise", "vibration", "light")]
    link = naming.alert_link(conn, cid, a, site, noise)
    assert not link["linked"] and link["reason"] == "not_an_air_report"


def test_both_halves_can_hold(conn, pinned_build) -> None:
    """Otherwise the rule is only ever "no". On the pinned build Ridgeline's
    Aug 27 cluster was reported while the wind carried Ridgeline's air to it,
    and Ridgeline's NO2 test passed the rotation check."""
    if not pinned_build:
        pytest.skip("specific to the pinned build")
    cid, site = _site(conn, "site-ridgeline")
    a = _alert(conn, "al-cluster-07")
    members = [dict(r) for r in conn.execute("SELECT * FROM concern WHERE cluster_id=?", (a["source_id"],))]
    link = naming.alert_link(conn, cid, a, site, members)
    assert link["linked"], link
    assert link["touchdown_state"] == "elevated_downwind"
