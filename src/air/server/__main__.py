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
    )


if __name__ == "__main__":
    main()
