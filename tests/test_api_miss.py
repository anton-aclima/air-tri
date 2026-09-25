"""A miss under /api is a JSON 404, never the SPA shell.

The catch-all used to answer `/api/v1/<typo>` with index.html: a 200 whose
HTML body a client parsed as data, and which a browser could cache as the
answer. Only a path with no `/api` at all belongs to the client-side router.
"""

from __future__ import annotations

import pytest

from air.server import config as air_config


@pytest.mark.parametrize("path", ["/api/v1/no-such-route", "/api/v1/regulator/nope", "/api/sites", "/api"])
def test_a_miss_under_api_is_a_json_404(client, path) -> None:
    r = client.get(path)
    assert r.status_code == 404, (r.status_code, r.text[:120])
    assert "json" in r.headers.get("content-type", "")


def test_a_client_route_still_reaches_the_shell(client) -> None:
    if not (air_config.WEB_DIST / "index.html").is_file():
        pytest.skip("web/dist not built: there is no shell to reach")
    r = client.get("/regulator/alerts")
    assert r.status_code == 200 and "html" in r.headers.get("content-type", "")
