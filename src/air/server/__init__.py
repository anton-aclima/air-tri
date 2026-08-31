"""air.server — FastAPI backend for the Aclima `air` prototype.

A read-heavy JSON API on :8000 under /api/v1, backed by plain sqlite3. See
docs/CONTRACT.md §5 for the endpoint surface and src/air/server/README.md for
implementation notes and deviations.
"""

__all__ = ["create_app"]


def create_app():  # lazy so `import air.server` stays cheap
    from air.server.app import create_app as _create

    return _create()
