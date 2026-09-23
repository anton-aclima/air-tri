"""CONTRACT section 9 — the rules that make the demo honest rather than pretty.

These are the invariants a reviewer would check by hand and a refactor would
quietly break. All of them are read-only or 4xx paths: nothing here mutates the
database.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.needs_db


# ── #4: industry cannot close a community concern ─────────────────────────────

@pytest.fixture(scope="module")
def open_concern(db) -> str:
    row = db.execute(
        "SELECT id FROM concern WHERE status NOT IN ('resolved','closed') LIMIT 1"
    ).fetchone()
    if row is None:
        pytest.skip("no open concern in the database")
    return row[0]


@pytest.mark.parametrize("status", ["resolved", "closed"])
def test_industry_cannot_close_a_concern(client, api, open_concern, status) -> None:
    r = client.patch(
        f"{api}/concerns/{open_concern}", json={"status": status, "role": "industry"}
    )
    assert r.status_code == 403, f"industry set a concern to {status!r} and got {r.status_code}"
    body = r.json()["detail"]
    assert body["error"] == "forbidden_status_transition"
    assert set(body["allowed"]) == {"under_review", "mitigation_proposed"}


def test_industry_may_propose_a_mitigation_in_principle(client, api, open_concern) -> None:
    """The permitted half of #4, checked without mutating: a bad status 403s
    with `mitigation_proposed` named as allowed, which is the same code path."""
    r = client.patch(
        f"{api}/concerns/{open_concern}", json={"status": "invented", "role": "industry"}
    )
    assert r.status_code in (403, 422)
    if r.status_code == 403:
        assert "mitigation_proposed" in r.json()["detail"]["allowed"]


def test_the_role_header_is_honoured_as_well_as_the_body(client, api, open_concern) -> None:
    r = client.patch(
        f"{api}/concerns/{open_concern}",
        json={"status": "closed"},
        headers={"X-Air-Role": "industry"},
    )
    assert r.status_code == 403, "X-Air-Role must gate the same transition the body role does"


def test_an_unspecified_role_defaults_to_regulator(client, api, open_concern) -> None:
    """Documenting a sharp edge rather than endorsing it.

    `patch_concern` resolves `payload.role or x_air_role or "regulator"`, so a
    request that names no role is treated as the *most* privileged non-admin
    caller. There is no auth here — role arrives as a field or a header — so
    this is honest-by-convention, and anything that starts depending on it
    should trip this test first. Asserted as "not 403" rather than by mutating.
    """
    r = client.patch(f"{api}/concerns/{open_concern}", json={"status": "under_review"})
    assert r.status_code != 403


# ── #5: community fleet positions are delayed >= 3 h ──────────────────────────

def test_community_fleet_is_delayed(client, api, json_ok) -> None:
    from air.server import config

    live = json_ok(client.get(f"{api}/fleet", params={"role": "regulator"}))
    delayed = json_ok(client.get(f"{api}/fleet", params={"role": "community"}))
    assert live and delayed, "no vehicles to check"
    assert all(v["delay_min"] >= config.COMMUNITY_FLEET_DELAY_MIN for v in delayed)
    assert all(v["delay_min"] == 0 for v in live)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "KNOWN DEFECT, found by this test 2026-09-10. Non-negotiable #5 is applied to the "
        "LABEL but not to the data. fleet.py:39 subtracts the delay from `domain.data_now`, "
        "and `data_now` returns max(latest_row, wall_clock) (domain.py:117-119). Once the "
        "clock runs past the end of the generated data — which it does from the day after "
        "the build — the community cutoff lands days AFTER the newest ping, so both roles "
        "get the identical freshest position while the payload still says delay_min=180. "
        "Measured: data_now 2026-09-10T21:13Z, community cutoff 2026-09-10T18:13Z, newest "
        "ping 2026-08-28T18:06 — 13 days of slack. Same root cause as P0-B. The fix is to "
        "anchor the delay to the newest ping rather than to data_now; it is a behaviour "
        "change to a contract rule, so it is the owner's call, not a drive-by. Remove this "
        "marker when it lands — strict=True means a fix reports as a failure here."
    ),
)
def test_community_fleet_positions_are_actually_stale(client, api, json_ok) -> None:
    """#5 is about what the community can SEE, not what the payload claims."""
    live = json_ok(client.get(f"{api}/fleet", params={"role": "regulator"}))
    delayed = json_ok(client.get(f"{api}/fleet", params={"role": "community"}))
    assert live and delayed, "no vehicles to check"
    assert max(v["ts"] for v in delayed) < max(v["ts"] for v in live), (
        "community saw a position as fresh as the regulator's"
    )


def test_community_cannot_ask_for_a_shorter_delay(client, api, json_ok) -> None:
    from air.server import config

    vehicles = json_ok(client.get(f"{api}/fleet", params={"role": "community", "delay_min": 0}))
    assert vehicles, "no vehicles to check"
    assert all(v["delay_min"] >= config.COMMUNITY_FLEET_DELAY_MIN for v in vehicles), (
        "a community caller talked the delay down — #5 is a floor, not a default"
    )


# ── #3: community language carries no units and no acronyms ───────────────────

def test_community_stats_never_print_a_unit(client, api, json_ok) -> None:
    j = json_ok(client.get(f"{api}/stats/community"))
    for m in j["by_measure"]:
        assert "unit" not in m, f"{m['measure']} leaked a unit into the community payload"
        assert m["plain_name"], f"{m['measure']} has no plain_name to show instead"
