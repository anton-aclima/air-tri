"""`python -m air.server` and the `air-server` console script."""

from __future__ import annotations

import logging

import uvicorn

from air.server import config


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s · %(message)s"
    )
    uvicorn.run(
        "air.server.app:app",
        host=config.HOST,
        port=config.PORT,
        reload=config.RELOAD,
        reload_dirs=[str(config.REPO_ROOT / "src")] if config.RELOAD else None,
        log_level="info",
        # Without this, a reload never completes while a browser tab is holding
        # `/events/stream` open: uvicorn logs "Waiting for connections to close"
        # and blocks forever on an SSE response that by design never ends. The
        # server then looks alive to `pgrep` and refuses every connection, which
        # is a genuinely confusing failure to debug from the outside. Five
        # seconds is long enough for a real request to finish and short enough
        # that an editor save is not a hang.
        timeout_graceful_shutdown=5,
    )


if __name__ == "__main__":
    main()
