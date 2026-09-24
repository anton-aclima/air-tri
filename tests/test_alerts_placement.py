"""Which alerts an operator's list holds, and what they say to that operator.

`loaders.alert_geometry` used to include or drop alerts by the generator's
`alert.site_id` — a wind-only guess that PLAN-refocus §8 says must not be used
for attribution — so DRAQA's Riverport Road monitor reached Ridgeline's list
only when the generator had not tagged it Riverport. Placement is geometry
now: within the radius, whatever the tag. And what the list SAYS to an operator
is addressed to them: no site named on the wind alone, no regulator advice on
a delivered fleet detection (D13), no datacentre equipment for a terminal.
"""

from __future__ import annotations

import pytest

from air.server import geo
from air.server.routers import alerts as alerts_router

pytestmark = pytest.mark.needs_db

SITES = ("site-ridgeline", "site-deltaforge", "site-riverport")


def _list(client, api, json_ok, sid: str, **extra) -> list[dict]:
    return json_ok(client.get(f"{api}/alerts", params={"role": "industry", "site_id": sid, **extra}))


def _centroid(db, sid: str) -> tuple[float, float]:
    r = db.execute("SELECT centroid_lon, centroid_lat FROM industry_site WHERE id=?", (sid,)).fetchone()
    return r[0], r[1]


def test_a_reference_monitor_alert_reaches_every_site_within_range_whatever_its_tag(
    client, api, db, json_ok
) -> None:
    """The review's case: the 10 Riverport Road alerts tagged `site-riverport`
    (the two 1-hour-standard Warnings among them) never reached Ridgeline or
    Delta Forge, and the 5 untagged ones did."""
    ref = db.execute(
        "SELECT a.id, a.lon, a.lat, a.site_id FROM alert a JOIN monitor m ON m.id = a.source_id "
        "WHERE m.owner_type='regulator' AND 'industry' IN (SELECT value FROM json_each(a.audience_json))"
    ).fetchall()
    assert ref
    tagged = 0
    for sid in SITES:
        ids = {a["id"] for a in _list(client, api, json_ok, sid)}
        clon, clat = _centroid(db, sid)
        for r in ref:
            near = geo.haversine_m(clon, clat, r["lon"], r["lat"]) <= alerts_router.INDUSTRY_RADIUS_M
            assert (r["id"] in ids) == near, (sid, r["id"], r["site_id"])
            tagged += near and r["site_id"] not in (None, sid)
    assert tagged, "no alert tagged with another site lies in range — the case this guards has gone"


def test_the_list_is_bounded_by_distance_alone(client, api, db, json_ok) -> None:
    for sid in SITES:
        for a in _list(client, api, json_ok, sid):
            assert a["distance_m"] is not None, a["id"]
            assert a["distance_m"] <= alerts_router.INDUSTRY_RADIUS_M, (sid, a["id"], a["distance_m"])


def test_an_explicit_radius_still_wins(client, api, json_ok) -> None:
    got = _list(client, api, json_ok, "site-ridgeline", radius_m=2000)
    assert got and all(a["distance_m"] <= 2000 for a in got)


def test_a_site_wide_alert_stays_with_its_own_site(client, api, db, json_ok) -> None:
    """Stored ON a site's centroid, an alert has no place; at 5.7 km from
    Delta Forge, Ridgeline's study alert would read as an alert 5.7 km WSW of
    Delta Forge. The study comparison is about Ridgeline's own filed study."""
    centred = []
    for r in db.execute("SELECT id, lon, lat FROM alert WHERE lon IS NOT NULL"):
        for sid in SITES:
            clon, clat = _centroid(db, sid)
            if geo.haversine_m(clon, clat, r["lon"], r["lat"]) < 1.0:
                centred.append((r["id"], sid))
    assert centred, "no alert sits on a centroid — the case this guards has gone"
    for aid, owner in centred:
        for sid in SITES:
            ids = {a["id"] for a in _list(client, api, json_ok, sid)}
            audience = db.execute("SELECT audience_json FROM alert WHERE id=?", (aid,)).fetchone()[0]
            if "industry" not in audience:
                continue
            assert (aid in ids) == (sid == owner), (aid, sid, owner)


def test_no_recommendation_names_a_site_on_the_wind_alone(client, api, json_ok) -> None:
    """ "Wind at the time carried from Riverport Intermodal Terminal; expect
    to be asked about it" — F7 names a site only when the placebo-checked
    downwind test agrees, in every room."""
    lists = [json_ok(client.get(f"{api}/alerts", params={"role": r})) for r in ("regulator", "admin", "industry")]
    lists += [_list(client, api, json_ok, sid) for sid in SITES]
    for got in lists:
        for a in got:
            assert "Wind at the time carried from" not in (a.get("recommendation") or ""), a["id"]


def test_a_delivered_fleet_detection_speaks_to_the_operator(client, api, json_ok) -> None:
    """D13 rows keep their stored audience (regulator, admin) and carry an
    industry-addressed sentence — a measurement on a street, never a source —
    instead of "Site a temporary monitor here, or accept mobile evidence"."""
    seen = 0
    for sid in SITES:
        for a in _list(client, api, json_ok, sid):
            if "industry" in a["audience"]:
                continue
            assert a["source_type"] == "mobile", a["id"]
            assert a["recommendation"] == alerts_router.FLEET_AT_FENCE, a["id"]
            assert a["delivered_as"] == "fleet_at_fence"
            detail = json_ok(client.get(f"{api}/alerts/{a['id']}", params={"site_id": sid}))
            assert detail["recommendation"] == alerts_router.FLEET_AT_FENCE
            seen += 1
    assert seen, "no fleet detection reached any site's fence"
    regulator = json_ok(client.get(f"{api}/alerts", params={"role": "regulator"}))
    assert all(a.get("delivered_as") is None for a in regulator)


def test_the_combustion_line_names_the_sites_own_equipment(client, api, json_ok) -> None:
    for sid, absent in (("site-riverport", "turbine"), ("site-deltaforge", "turbine")):
        for a in _list(client, api, json_ok, sid):
            assert absent not in (a.get("recommendation") or "").lower(), (sid, a["id"], a["recommendation"])


def test_the_study_summary_does_not_pair_understates_with_zero(client, api, campaign, json_ok) -> None:
    """/industry/site printed "UNDERSTATES" beside "0% of observed hours fall
    outside where the modelled contour actually reaches". The frequency pair
    is the evidence; the hours-outside share is quoted only when it is not 0."""
    window = {"from": f"{campaign['start_date']}T00:00:00", "to": f"{campaign['end_date']}T23:59:59"}
    for sid in SITES:
        v = json_ok(client.get(f"{api}/sites/{sid}/model-verification", params=window))
        if v["verdict"] != "understates":
            continue
        if not v["disagreement"]:
            assert "fall outside" not in v["summary"], v["summary"]
        assert "°" not in v["summary"], v["summary"]
