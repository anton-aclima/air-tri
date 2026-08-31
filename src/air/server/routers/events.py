"""GET /events/stream — Server-Sent Events over the activity log.

One asyncio.Queue per subscriber, a heartbeat comment every 15 s so proxies and
browsers keep the connection open, and correct framing (`id:`, `event:`,
`data:`, blank line). Event names: activity | alert | concern | post | advisory |
fleet. Every write publishes both its specific name and a generic `activity`
event, so a client can subscribe narrowly or watch everything.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from air.server import bus, config

router = APIRouter(tags=["events"])

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


async def _events(request: Request, last_id: int) -> AsyncIterator[str]:
    q = bus.subscribe()
    try:
        yield ": air event stream open\n\n"
        yield "event: hello\ndata: {\"ok\":true}\n\n"
        for env in bus.recent(last_id):  # replay anything missed on reconnect
            yield bus.frame(env)
        while True:
            if await request.is_disconnected():
                return
            try:
                env = await asyncio.wait_for(q.get(), timeout=config.SSE_HEARTBEAT_S)
            except TimeoutError:
                yield bus.heartbeat()
                continue
            yield bus.frame(env)
    finally:
        bus.unsubscribe(q)


@router.get("/events/stream")
async def stream(
    request: Request,
    since: int = Query(0, description="last seen event id; replays anything newer"),
) -> StreamingResponse:
    header_id = request.headers.get("last-event-id")
    last_id = since
    if header_id and header_id.isdigit():
        last_id = max(last_id, int(header_id))
    return StreamingResponse(
        _events(request, last_id), media_type="text/event-stream", headers=SSE_HEADERS
    )


@router.get("/events/status")
def status() -> dict:
    return {"subscribers": bus.subscriber_count(), "buffered": len(bus.recent(0))}
