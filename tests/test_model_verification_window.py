"""`GET /sites/{id}/model-verification` — the default window is a trap.

P0-B, and the reason the flagship industry claim was silently switched off.

`domain.data_now` returns `max(latest_row, wall_clock)`. The endpoint defaults
`from` to 30 days before that. So the moment the machine's clock runs past the
end of the generated data — which it does, every day, from the day the data was
built — the default window slides off the record and the verdict decays toward
`consistent` on a shrinking sample. Measured 2026-09-10 against data ending
2026-08-28: the default window saw 6,346 of 28,324 fleet wind observations, and
ALL THREE sites returned `consistent`. Over the campaign, all three return
`understates`.

The fix is client-side (`useCampaignWindow()` in `apps/industry/lib.tsx`), so
these tests guard the property the client depends on rather than a default this
codebase deliberately leaves alone.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.needs_db

SITES = ["site-ridgeline", "site-deltaforge", "site-riverport"]


@pytest.fixture(scope="module")
def sites(db) -> list[str]:
    return [r[0] for r in db.execute("SELECT id FROM industry_site ORDER BY id")]


def test_the_campaign_window_sees_more_than_the_default(client, api, sites, campaign_window, json_ok) -> None:
    """The regression itself, stated as a property so a reseed cannot mask it."""
    thin = 0
    for sid in sites:
        default = json_ok(client.get(f"{api}/sites/{sid}/model-verification"))
        full = json_ok(client.get(f"{api}/sites/{sid}/model-verification", params=campaign_window))
        assert full["n_obs"] >= default["n_obs"]
        if default["n_obs"] < full["n_obs"]:
            thin += 1
    assert thin == len(sites), (
        "the wall-clock default window no longer truncates the record — if the data was "
        "just rebuilt this is expected, but the client must keep sending an explicit window"
    )


def test_the_campaign_window_has_something_to_say(client, api, sites, campaign_window, json_ok) -> None:
    for sid in sites:
        v = json_ok(client.get(f"{api}/sites/{sid}/model-verification", params=campaign_window))
        assert v["verdict"] != "insufficient_data", f"{sid} has no verdict over its own campaign"
        assert v["n_obs"] > 0


def test_the_pinned_build_says_understates(client, api, sites, campaign_window, pinned_build, json_ok) -> None:
    """The demo beat. Skips on a wall-clock-anchored rebuild — a different world."""
    if not pinned_build:
        pytest.skip("database was not built with the --now pinned in CLAUDE.md")
    for sid in sites:
        v = json_ok(client.get(f"{api}/sites/{sid}/model-verification", params=campaign_window))
        assert v["verdict"] == "understates", f"{sid}: {v['verdict']}"
        assert v["understated_bearings"], f"{sid} understates but names no bearing"
        assert v["affected_districts"], f"{sid} understates but names no district"


def test_an_understated_bearing_names_a_real_district(client, api, campaign_window, pinned_build, json_ok) -> None:
    """CONTRACT s10a rule 3: the payoff line must point somewhere that exists."""
    if not pinned_build:
        pytest.skip("database was not built with the --now pinned in CLAUDE.md")
    v = json_ok(client.get(f"{api}/sites/site-ridgeline/model-verification", params=campaign_window))
    names = {d["district"] for d in v["affected_districts"]}
    assert "Boxtown" in names, f"expected the Boxtown beat, got {sorted(names)}"
    for d in v["affected_districts"]:
        assert d["observed_freq"] > d["assumed_freq"], "an 'affected' district must be under-weighted"


def test_unknown_site_is_404(client, api) -> None:
    assert client.get(f"{api}/sites/nope/model-verification").status_code == 404
