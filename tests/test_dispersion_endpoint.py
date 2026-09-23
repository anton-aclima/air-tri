"""`GET /wind/dispersion` — one plume per site, not one per emission point.

P0-C. Before this, Ridgeline's 13 active emission points x 3 bands produced 39
overlapping polygons inside a ~500 m cluster; stacked 13 deep the alpha piled
up into one opaque smudge the size of the campus with no legible bands. That
smudge is the thing the owner kept calling a "tiny blob".
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.needs_db


def test_one_feature_per_site_and_band(client, api, db, json_ok) -> None:
    j = json_ok(client.get(f"{api}/wind/dispersion"))
    keys = [(f["properties"]["site_id"], f["properties"]["band"]) for f in j["features"]]
    assert len(keys) == len(set(keys)), "duplicate (site, band) — the union regressed"

    n_sites = db.execute(
        "SELECT COUNT(DISTINCT site_id) FROM emission_point WHERE active = 1"
    ).fetchone()[0]
    assert len(j["features"]) == n_sites * 3, "expected exactly three bands per active site"


def test_a_multi_point_site_still_returns_three_polygons(client, api, db, json_ok) -> None:
    """The regression case: many emission points must not mean many polygons."""
    site_id, n_points = db.execute(
        "SELECT site_id, COUNT(*) c FROM emission_point WHERE active = 1 "
        "GROUP BY site_id ORDER BY c DESC LIMIT 1"
    ).fetchone()
    assert n_points > 3, "fixture assumption: some site has several emission points"

    j = json_ok(client.get(f"{api}/wind/dispersion", params={"site_id": site_id}))
    assert len(j["features"]) == 3, f"{site_id} has {n_points} points and drew {len(j['features'])} polygons"
    for f in j["features"]:
        assert f["properties"]["n_sources"] == n_points


def test_bands_are_ordered_and_fall_off(client, api, json_ok) -> None:
    j = json_ok(client.get(f"{api}/wind/dispersion"))
    by_site: dict[str, dict[int, float]] = {}
    for f in j["features"]:
        p = f["properties"]
        by_site.setdefault(p["site_id"], {})[p["band"]] = p["level"]
    for site_id, bands in by_site.items():
        assert sorted(bands) == [0, 1, 2], site_id
        assert bands[0] > bands[1] > bands[2], f"{site_id}: concentration must fall outward"


def test_payload_carries_no_per_point_identity(client, api, json_ok) -> None:
    """A unioned polygon is not attributable to one stack; the fields are gone.

    Nothing on the web ever read these — they were never in the
    `DispersionPlume` type — so this is a guard against them creeping back in
    as a per-point label on a shape that is no longer per-point.
    """
    j = json_ok(client.get(f"{api}/wind/dispersion"))
    for f in j["features"]:
        assert "emission_point_id" not in f["properties"]
        assert "emission_point" not in f["properties"]


def test_geometry_is_a_closed_simple_ring(client, api, json_ok) -> None:
    j = json_ok(client.get(f"{api}/wind/dispersion"))
    for f in j["features"]:
        ring = f["geometry"]["coordinates"][0]
        assert f["geometry"]["type"] == "Polygon"
        assert ring[0] == ring[-1], "unclosed ring"
        assert len(ring) >= 4
        dupes = [i for i in range(len(ring) - 1) if ring[i] == ring[i + 1]]
        assert not dupes, f"zero-length edges at {dupes} — deck.gl cannot tessellate these"


def test_unknown_site_is_404_not_an_empty_collection(client, api) -> None:
    r = client.get(f"{api}/wind/dispersion", params={"site_id": "site-does-not-exist"})
    assert r.status_code == 404


# ── P1-C: the shape now comes from the kernel ────────────────────────────────

def test_reach_moves_with_the_weather(client, api, db, json_ok) -> None:
    """The headline fix. The old formula spanned 3x from A to F; if this
    collapses, the endpoint has stopped asking the kernel."""
    reaches = {}
    for cls in ("B", "C", "D", "F"):
        row = db.execute(
            "SELECT ts FROM wind WHERE stability=? ORDER BY ABS(speed_ms - 2.5) LIMIT 1", (cls,)
        ).fetchone()
        if row is None:
            continue
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"site_id": "site-ridgeline", "at": row[0]}))
        reaches[cls] = j["features"][0]["properties"]["x_reach_m"]
    assert reaches["B"] < reaches["D"], f"stable air must carry further: {reaches}"
    assert max(reaches.values()) / min(reaches.values()) > 2.5, reaches


def test_a_bigger_site_gets_a_bigger_plume(client, api, json_ok) -> None:
    """Reach scales with how much is emitted. Under the old formula a
    substation drew the same cone as six 14.6 MW turbine banks."""
    got = {}
    for sid in ("site-ridgeline", "site-deltaforge"):
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"site_id": sid}))
        got[sid] = j["features"][0]["properties"]["x_reach_m"]
    assert got["site-ridgeline"] > got["site-deltaforge"], got


def test_the_payload_reports_its_own_uncertainty(client, api, json_ok) -> None:
    j = json_ok(client.get(f"{api}/wind/dispersion"))
    for f in j["features"]:
        p = f["properties"]
        assert isinstance(p["beyond_envelope"], bool)
        assert p["detection_envelope_m"] > 0
        assert isinstance(p["truncated"], bool)
        assert 0.0 < p["level"] <= 1.0, "level is a contour fraction of the site peak"
        # A lofted plume must say where it comes down; a grounded one must not
        # invent a touchdown.
        if p["n_elevated"] == 0:
            assert p["lofted"] is False and p["elevated_touchdown_m"] is None


def test_the_outermost_band_is_the_one_that_leaves_the_envelope(client, api, db, json_ok) -> None:
    """Register switching has to be monotone: an inner band cannot be
    model-only while the band outside it is drawn as measurable."""
    row = db.execute(
        "SELECT ts FROM wind WHERE stability='F' ORDER BY speed_ms LIMIT 1"
    ).fetchone()
    j = json_ok(client.get(f"{api}/wind/dispersion", params={"at": row[0]}))
    by_site: dict[str, list[tuple[int, bool]]] = {}
    for f in j["features"]:
        p = f["properties"]
        by_site.setdefault(p["site_id"], []).append((p["band"], p["beyond_envelope"]))
    assert by_site
    for sid, bands in by_site.items():
        flags = [beyond for _b, beyond in sorted(bands)]
        assert flags == sorted(flags), f"{sid}: envelope flag is not monotone outward: {flags}"


def test_stability_is_not_coerced_on_real_weather(client, api, db, json_ok) -> None:
    """P1-D. The guard exists for forecasts and hand-set sliders; if it starts
    firing on the campaign's own wind, the drawn cone has begun to disagree
    with the truth field, which does not coerce."""
    for ts in [r[0] for r in db.execute("SELECT ts FROM wind ORDER BY ts LIMIT 400")]:
        j = json_ok(client.get(f"{api}/wind/dispersion", params={"site_id": "site-ridgeline", "at": ts}))
        for f in j["features"]:
            assert "stability_coerced_from" not in f["properties"], (ts, f["properties"])
