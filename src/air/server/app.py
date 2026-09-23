"""FastAPI app assembly: routers under /api/v1, CORS for the Vite dev server,
and the built frontend served at / when web/dist exists (so a demo can run as a
single process)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from air.server import bus, config, db
from air.server.routers import (
    admin,
    advisor,
    alerts,
    bootstrap,
    concerns,
    coverage,
    events,
    feed,
    fleet,
    monitors,
    regulator,
    segments,
    sites,
    stats,
    touchdown,
    wind,
)

log = logging.getLogger("air.server")

ROUTERS = (
    bootstrap.router,
    segments.router,
    monitors.router,
    concerns.router,
    sites.router,
    alerts.router,
    regulator.router,
    feed.router,
    fleet.router,
    wind.router,
    stats.router,
    touchdown.router,
    coverage.router,
    advisor.router,
    admin.router,
    events.router,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # The SSE bus needs the running loop so sync write handlers (which FastAPI
    # runs in a threadpool) can publish via call_soon_threadsafe.
    bus.bind_loop(asyncio.get_running_loop())
    db.ensure_db()
    log.info("air.server ready · db=%s · advisor=%s", config.DB_PATH, config.advisor_mode())
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        lifespan=lifespan,
        title="air",
        version="0.1.0",
        description=(
            "Aclima `air` — one dataset, four interfaces. All data is SIMULATED. "
            "See docs/CONTRACT.md §5."
        ),
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.CORS_ORIGINS,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["x-air-cache"],
    )

    for r in ROUTERS:
        app.include_router(r, prefix=config.API_PREFIX)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "message": str(exc), "path": request.url.path},
        )

    # ── the built frontend, if it has been built ──────────────────────────────
    dist = config.WEB_DIST
    if dist.is_dir() and (dist / "index.html").is_file():
        assets = dist / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        index = dist / "index.html"

        @app.get("/", include_in_schema=False)
        async def _index() -> FileResponse:
            return FileResponse(index)

        @app.get("/{path:path}", include_in_schema=False)
        async def _spa(path: str) -> FileResponse:
            # Serve real files; everything else falls through to the SPA shell
            # so TanStack Router's client-side routes deep-link.
            candidate = (dist / path).resolve()
            if candidate.is_file() and str(candidate).startswith(str(dist.resolve())):
                return FileResponse(candidate)
            return FileResponse(index)

        log.info("serving %s at /", dist)
    else:
        @app.get("/", include_in_schema=False)
        async def _no_dist() -> JSONResponse:
            return JSONResponse(
                {
                    "service": "air",
                    "api": config.API_PREFIX,
                    "docs": "/api/docs",
                    "note": "web/dist not built — run `cd web && npm run build`, or use the Vite dev server on :5173",
                }
            )

    return app


app = create_app()
