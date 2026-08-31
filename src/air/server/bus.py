"""In-process pub/sub backing GET /events/stream.

Writes happen in sync endpoint handlers (FastAPI runs `def` handlers in a
threadpool), so `publish()` must be callable from any thread. It hands the
event to the main event loop via `call_soon_threadsafe`, which then fans out
into one `asyncio.Queue` per SSE subscriber.
"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

MAX_QUEUE = 256
RECENT_MAX = 200

_loop: asyncio.AbstractEventLoop | None = None
_lock = threading.RLock()
_subscribers: set[asyncio.Queue] = set()
_recent: list[dict[str, Any]] = []
_seq = 0


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def subscriber_count() -> int:
    with _lock:
        return len(_subscribers)


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=MAX_QUEUE)
    with _lock:
        _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    with _lock:
        _subscribers.discard(q)


def recent(after_seq: int = 0) -> list[dict[str, Any]]:
    with _lock:
        return [e for e in _recent if e["seq"] > after_seq]


def publish(event: str, data: dict[str, Any]) -> dict[str, Any]:
    """Fan `data` out to every SSE subscriber as `event: <event>`.

    Safe from any thread. Returns the enveloped event.
    """
    global _seq
    with _lock:
        _seq += 1
        env = {"seq": _seq, "event": event, "data": data}
        _recent.append(env)
        if len(_recent) > RECENT_MAX:
            del _recent[: len(_recent) - RECENT_MAX]
        queues = list(_subscribers)

    if not queues:
        return env
    loop = _loop
    if loop is None or loop.is_closed():
        return env
    try:
        loop.call_soon_threadsafe(_fanout, env, queues)
    except RuntimeError:  # loop shutting down
        pass
    return env


def _fanout(env: dict[str, Any], queues: list[asyncio.Queue]) -> None:
    for q in queues:
        try:
            q.put_nowait(env)
        except asyncio.QueueFull:
            # Slow client: drop the oldest and keep the newest — a demo would
            # rather show the latest event than stall the stream.
            try:
                q.get_nowait()
                q.put_nowait(env)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass


def frame(env: dict[str, Any]) -> str:
    """Correct SSE framing: id / event / data / blank line."""
    payload = json.dumps(env["data"], separators=(",", ":"), default=str)
    return f"id: {env['seq']}\nevent: {env['event']}\ndata: {payload}\n\n"


def heartbeat() -> str:
    return ": ping\n\n"
