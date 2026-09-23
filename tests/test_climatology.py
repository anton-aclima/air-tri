"""P6-A and P6-B — the community app's front door, and its one exposed surface.

The front door is climatology: how often the wind carried from a site over a
neighbourhood. It is the front door rather than the live plume for three
reasons, and two of them are testable here — it is stable across the campaign,
and it is reach-independent, so it does not move when the dispersion kernel
does. (The third, that it draws no shape over anyone, is a rendering fact.)
"""

from __future__ import annotations

import math

import pytest

from air.server import climatology as cl

pytestmark = pytest.mark.needs_db

CID = "cmp-swmem-2026"
WHOLE = ("2026-05-31T00:00:00", "2026-08-28T23:59:59")


@pytest.fixture(scope="module")
def ridgeline(db):
    return cl.estimate(db, CID, "site-ridgeline", *WHOLE)


# ── the claim ────────────────────────────────────────────────────────────────

def test_the_wind_carries_from_ridgeline_over_boxtown(ridgeline) -> None:
    """The narrative beat, measured. Phase 2 found the geometry holds across
    four seeds; the SHARE is generated at runtime and never written down."""
    top = ridgeline.districts[0]
    assert top.district == "Boxtown", [d.district for d in ridgeline.districts[:3]]
    assert 0.15 < top.share < 0.75, top.share
    # 18 degrees and about 2.6 km — the geometry, which does not move.
    assert 0 <= top.bearing_deg <= 40
    assert 2000 < top.distance_m < 4000


def test_every_district_gets_an_answer_including_a_boring_one(ridgeline) -> None:
    """A front door that only lists the affected places is an accusation with
    the denominator removed."""
    shares = {d.district: d.share for d in ridgeline.districts}
    assert len(shares) >= 5
    assert min(shares.values()) < 0.05, "no district is rarely downwind — check the sector"
    assert max(shares.values()) > 0.2


def test_shares_are_ordered_worst_first(ridgeline) -> None:
    got = [d.share for d in ridgeline.districts]
    assert got == sorted(got, reverse=True)


# ── reach-independence, which is why this is the front door ──────────────────

def test_the_answer_does_not_depend_on_how_far_the_plume_reaches(db, monkeypatch) -> None:
    """The load-bearing property.

    `dispersion` reach moved by a factor of five in phase 1. A number a
    resident might screenshot must not depend on which sprint they
    screenshotted it in — so this asks only whether the wind POINTED at a
    district, never whether anything arrived.
    """
    from air import dispersion

    before = cl.estimate(db, CID, "site-ridgeline", *WHOLE)
    monkeypatch.setattr(dispersion, "MAX_REACH_M", dispersion.MAX_REACH_M * 5)
    monkeypatch.setattr(dispersion, "DRAW_FLOOR", dispersion.DRAW_FLOOR / 100)
    after = cl.estimate(db, CID, "site-ridgeline", *WHOLE)
    assert [d.share for d in before.districts] == [d.share for d in after.districts]


def test_the_sector_is_a_width_not_a_reach(db) -> None:
    """It comes from the kernel's sigma_y, so it narrows in stable air — but it
    is clamped, because sigma_y at 3 km under F is a couple of degrees and the
    answer would become a function of rounding in the wind record."""
    near = cl._half_angle(500.0, "F", 1.5)
    far = cl._half_angle(6000.0, "F", 1.5)
    assert cl.MIN_HALF_DEG <= far <= near <= cl.MAX_HALF_DEG
    assert cl._half_angle(3000.0, "B", 3.0) > cl._half_angle(3000.0, "F", 3.0)


def test_stable_air_is_reported_separately(ridgeline) -> None:
    """The still nights are when a plume stays together, and they are a
    different question from "ever"."""
    for d in ridgeline.districts:
        assert 0.0 <= d.share_stable <= 1.0
        assert d.hours_downwind_stable <= d.hours_stable <= d.n_hours


# ── the endpoint ─────────────────────────────────────────────────────────────

def test_the_window_is_the_campaign_not_the_last_ninety_days(client, api, db, json_ok) -> None:
    """P0-B's lesson, applied here. `domain.data_now` returns max(latest_row,
    wall_clock), so a wall-clock default window slides off the record a day at
    a time — and a climatology that quietly shrinks is worse than one that is
    out of date, because the number moves and nothing says so."""
    j = json_ok(client.get(f"{api}/wind/climatology"))
    total = db.execute("SELECT COUNT(*) FROM wind").fetchone()[0]
    assert j["n_hours"] == total, (j["n_hours"], total)
    span = db.execute("SELECT start_date, end_date FROM campaign LIMIT 1").fetchone()
    assert j["from"].startswith(span[0]) and j["to"].startswith(span[1])


def test_every_site_comes_back_when_none_is_named(client, api, json_ok) -> None:
    """What a resident needs: their own district, and every place on the map,
    in one answer."""
    j = json_ok(client.get(f"{api}/wind/climatology"))
    assert {s["site_id"] for s in j["sites"]} == {
        "site-ridgeline", "site-deltaforge", "site-riverport"
    }
    assert j["source"] == "met_record", "the met record, not our fleet's anemometry"


def test_a_resident_can_compare_places(client, api, json_ok) -> None:
    """The front-door sentence: for MY district, how often from each place."""
    j = json_ok(client.get(f"{api}/wind/climatology"))
    mine = {
        s["name"]: next((d["share"] for d in s["districts"] if d["district"] == "Boxtown"), None)
        for s in j["sites"]
    }
    assert all(v is not None for v in mine.values())
    ridge = next(v for k, v in mine.items() if k.startswith("Ridgeline"))
    assert ridge == max(mine.values())
    assert ridge > 5 * min(mine.values()), mine


def test_unknown_site_is_404(client, api) -> None:
    assert client.get(f"{api}/wind/climatology", params={"site_id": "nope"}).status_code == 404


# ── P6-B: no house-precision coordinate leaves the API ───────────────────────

def test_every_served_report_sits_on_the_road_grid(client, api, db, json_ok) -> None:
    """The one place the community design was genuinely exposed.

    Coordinates are house-precision and `is_anonymous` hides only the author's
    NAME. Draw any named-emitter shape over house-precision pins — which is
    what this phase puts on the map — and the map becomes a record of which
    households accused which company. It does not take bad faith; a screenshot
    is enough.
    """
    served = json_ok(client.get(f"{api}/concerns", params={"limit": 500}))
    items = served if isinstance(served, list) else served.get("items", served)
    assert len(items) > 50
    grid = {
        (round(r[0], 5), round(r[1], 5))
        for r in db.execute("SELECT mid_lon, mid_lat FROM road_segment")
    }
    off = [c["id"] for c in items if (c["lon"], c["lat"]) not in grid]
    assert not off, f"{len(off)} reports served at house precision, e.g. {off[:3]}"
    assert {c["location_precision"] for c in items} == {"road_segment"}


def test_the_snap_moves_reports_a_short_way(client, api, db, json_ok) -> None:
    """Far enough to stop being an address, near enough to stay useful. The
    road segment is this product's own atom, so nothing analytically useful is
    lost — but a report that moved a kilometre would be a different claim."""
    served = json_ok(client.get(f"{api}/concerns", params={"limit": 500}))
    items = served if isinstance(served, list) else served.get("items", served)
    raw = {r[0]: (r[1], r[2]) for r in db.execute("SELECT id, lon, lat FROM concern")}
    moved = []
    for c in items:
        o = raw.get(c["id"])
        if not o:
            continue
        kx = math.cos(math.radians(o[1]))
        moved.append(math.hypot((c["lon"] - o[0]) * kx, c["lat"] - o[1]) * 111_320)
    assert moved
    moved.sort()
    assert moved[len(moved) // 2] < 250, f"median displacement {moved[len(moved) // 2]:.0f} m"
    assert moved[-1] < 1500, f"worst displacement {moved[-1]:.0f} m"


def test_no_other_payload_leaks_a_report_coordinate(db) -> None:
    """Alerts and clusters carry coordinates too. A cluster is at least three
    reports so its centroid is already coarse, and an alert is placed at a
    receptor — but if either ever coincided exactly with a report, the snap
    would be pointless."""
    raw = {
        (round(r[0], 6), round(r[1], 6))
        for r in db.execute("SELECT lon, lat FROM concern")
    }
    for table, cols in (("alert", "lon, lat"), ("concern_cluster", "centroid_lon, centroid_lat")):
        hits = [
            r for r in db.execute(f"SELECT {cols} FROM {table}")  # noqa: S608 - fixed literals
            if r[0] is not None and (round(r[0], 6), round(r[1], 6)) in raw
        ]
        assert not hits, f"{table} exposes {len(hits)} exact report coordinates"
