"""D13: industry receives Aclima's mobile detections at its own fence.

The generator addresses every `mobile_detection` to regulator and admin only,
so the industry deck never saw the fleet's finding closest to Ridgeline — the
diesel detection on Paul R Lowry Road, its own fenceline road — while another
operator's monitor headlined it. The owner decided (2026-09-23) to send them.

The rule is the envelope's own fenceline: within `envelope.FENCELINE_M` of one
of the site's active emission points. So the list and the deck's fenceline
highlight (`/sites/{id}/envelope` -> `fenceline_segment_ids`) agree about
which road is the site's, and a detection at another operator's fence does not
reach a competitor first.
"""

from __future__ import annotations

import pytest

from air.server import envelope, geo

pytestmark = pytest.mark.needs_db


def _sites(db) -> list[str]:
    return [r[0] for r in db.execute("SELECT id FROM industry_site ORDER BY id")]


def _nearest_point_m(db, site_id: str, lon: float, lat: float) -> float:
    pts = db.execute(
        "SELECT lon, lat FROM emission_point WHERE site_id=? AND active=1", (site_id,)
    ).fetchall()
    return min(geo.haversine_m(p[0], p[1], lon, lat) for p in pts)


def test_industry_gets_exactly_the_detections_at_its_own_fence(client, api, db, json_ok) -> None:
    mobile = db.execute(
        "SELECT id, lon, lat, audience_json FROM alert WHERE source_type='mobile' AND lon IS NOT NULL"
    ).fetchall()
    assert mobile, "no located mobile alerts in the database"
    delivered = 0
    for sid in _sites(db):
        got = json_ok(client.get(f"{api}/alerts", params={"role": "industry", "site_id": sid}))
        ids = {a["id"] for a in got}
        for m in mobile:
            if "industry" in m["audience_json"]:
                continue  # already industry's, by the generator
            near = _nearest_point_m(db, sid, m["lon"], m["lat"]) <= envelope.FENCELINE_M
            assert (m["id"] in ids) == near, (sid, m["id"], near)
            delivered += near
    assert delivered, "no mobile detection lies at any site's fence — the case this guards has gone"


def test_the_fenceline_detection_is_on_the_envelopes_fenceline_road(client, api, db, json_ok) -> None:
    """The deck matches `alert.source_id` (the road segment) against the
    envelope's `fenceline_segment_ids`; the two rules must pick the same road."""
    checked = 0
    for sid in _sites(db):
        got = json_ok(client.get(f"{api}/alerts", params={"role": "industry", "site_id": sid}))
        fence = [a for a in got if a["source_type"] == "mobile" and a["kind"] == "mobile_detection"]
        if not fence:
            continue
        env = json_ok(client.get(f"{api}/sites/{sid}/envelope"))
        for a in fence:
            assert a["source_id"] in env["fenceline_segment_ids"], (sid, a["id"], a["source_id"])
            assert a["distance_m"] is not None
            checked += 1
    assert checked


def test_nothing_else_changes(client, api, json_ok) -> None:
    """Only industry-with-a-site is widened. Without a site there is no fence
    to be near, and every other role reads the stored audience as before."""
    no_site = json_ok(client.get(f"{api}/alerts", params={"role": "industry"}))
    assert all("industry" in a["audience"] for a in no_site)
    for role in ("regulator", "admin", "community"):
        got = json_ok(client.get(f"{api}/alerts", params={"role": role, "site_id": "site-ridgeline"}))
        assert all(role in a["audience"] for a in got), role


def test_ridgeline_sees_the_paul_r_lowry_diesel_finding(client, api, json_ok, pinned_build) -> None:
    """The case the owner named. Pinned: another build may place it elsewhere."""
    if not pinned_build:
        pytest.skip("specific to the pinned build")
    got = json_ok(client.get(f"{api}/alerts", params={"role": "industry", "site_id": "site-ridgeline"}))
    diesel = [a for a in got if a["id"] == "al-mobile-diesel-00"]
    assert diesel and "Paul R Lowry Road" in diesel[0]["title"]
    assert diesel[0]["distance_m"] < envelope.FENCELINE_M
    # Delta Forge's black-carbon finding sits 5.8 km from Ridgeline and 115 m
    # from Delta Forge's stacks. A radius rule would have sent it here.
    assert "al-mobile-bc-00" not in {a["id"] for a in got}
