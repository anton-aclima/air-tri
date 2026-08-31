"""Instant answer, then upgrade — the industry advisor's latency contract.

The industry interface has to be glanceable at three metres for an operator who
does not want to dig in. Sixteen seconds of dead air after clicking "what do I
do" destroys that, so `POST /advisor` never waits for the model:

  1. It returns the rules-engine recommendation immediately (~50 ms). That answer
     is complete and actionable on its own — it is what every demo runs on when
     no key is set.
  2. It starts a background job that streams the model's answer.
  3. The client watches `GET /advisor/{request_id}/stream` and sees the richer
     recommendation type out, then swaps in the structured reply.

The guarantee: **there is never a spinner where an answer should be**, and a
missing key or a network hiccup costs the operator nothing — the rules answer is
already on screen and simply stays.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from typing import Any

import httpx

from air.server import config

log = logging.getLogger("air.advisor")

JOB_TTL_S = 900.0
MAX_JOBS = 128
QUEUE_MAX = 512

_jobs: dict[str, "Job"] = {}


class Job:
    """One advisor request: the instant answer, plus the upgrade in flight."""

    def __init__(self, request_id: str, rules: dict[str, Any]) -> None:
        self.id = request_id
        self.rules = rules
        self.status = "pending"          # pending | streaming | complete | failed
        self.reply: dict[str, Any] | None = None
        self.error: str | None = None
        self.text = ""                   # recommendation text streamed so far
        self.actions_sent = 0            # action cards already emitted
        self.events: list[dict[str, Any]] = []
        self.queues: set[asyncio.Queue] = set()
        self.created_at = time.time()
        self.finished = asyncio.Event()

    # ── fan-out ──────────────────────────────────────────────────────────────
    def emit(self, event: str, data: dict[str, Any]) -> None:
        env = {"event": event, "data": {"request_id": self.id, **data}}
        self.events.append(env)
        for q in list(self.queues):
            try:
                q.put_nowait(env)
            except asyncio.QueueFull:
                pass

    def subscribe(self) -> tuple[asyncio.Queue, list[dict[str, Any]]]:
        """Live queue plus everything already emitted, so a client that connects
        a beat after POST does not miss the opening tokens."""
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self.queues.add(q)
        return q, list(self.events)

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.queues.discard(q)

    def snapshot(self) -> dict[str, Any]:
        return {
            "request_id": self.id,
            "status": self.status,
            "reply": self.reply or self.rules,
            "rules": self.rules,
            "partial_recommendation": self.text or None,
            "error": self.error,
        }


def _reap() -> None:
    now = time.time()
    stale = [k for k, j in _jobs.items() if now - j.created_at > JOB_TTL_S and j.status in ("complete", "failed")]
    for k in stale:
        _jobs.pop(k, None)
    while len(_jobs) > MAX_JOBS:
        oldest = min(_jobs, key=lambda k: _jobs[k].created_at)
        _jobs.pop(oldest, None)


def create(rules: dict[str, Any]) -> Job:
    _reap()
    job = Job(f"adv_{uuid.uuid4().hex[:12]}", rules)
    _jobs[job.id] = job
    return job


def get(request_id: str) -> Job | None:
    return _jobs.get(request_id)


# ── incremental JSON field extraction ─────────────────────────────────────────

def partial_string(buf: str, key: str) -> str | None:
    """Best-effort value of a still-streaming JSON string field.

    The model streams `output_config.format` JSON, so raw deltas are JSON
    fragments — useless to render. `recommendation` is the first field in the
    schema, so pulling its partial value out gives the operator a sentence that
    types itself while the structured `actions` are still arriving.
    """
    m = re.search(r'"%s"\s*:\s*"' % re.escape(key), buf)
    if not m:
        return None
    i = m.end()
    out: list[str] = []
    escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/", "b": "", "f": ""}
    while i < len(buf):
        ch = buf[i]
        if ch == "\\":
            if i + 1 >= len(buf):
                break                       # escape split across chunks
            nxt = buf[i + 1]
            if nxt == "u":
                if i + 6 > len(buf):
                    break
                try:
                    out.append(chr(int(buf[i + 2:i + 6], 16)))
                except ValueError:
                    pass
                i += 6
                continue
            out.append(escapes.get(nxt, nxt))
            i += 2
            continue
        if ch == '"':
            break
        out.append(ch)
        i += 1
    return "".join(out)


def complete_objects(buf: str, key: str) -> list[dict[str, Any]]:
    """Fully-formed objects inside a still-streaming JSON array field.

    The recommendation sentence finishes early (it is first in the schema); the
    actions take the rest of the call. Emitting each action card the moment it
    closes keeps the panel filling in instead of stalling after one sentence.
    """
    m = re.search(r'"%s"\s*:\s*\[' % re.escape(key), buf)
    if not m:
        return []
    out: list[dict[str, Any]] = []
    i = m.end()
    depth = 0
    start = -1
    in_str = False
    esc = False
    while i < len(buf):
        ch = buf[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    out.append(json.loads(buf[start:i + 1]))
                except json.JSONDecodeError:
                    pass
                start = -1
        elif ch == "]" and depth == 0:
            break
        i += 1
    return out


def normalise(parsed: dict[str, Any], model: str | None, speed: str | None = None) -> dict[str, Any]:
    """Parsed model JSON -> AdvisorReply."""
    reply = {
        "recommendation": str(parsed.get("recommendation", "")).strip(),
        "actions": [
            {
                "label": str(a.get("label", "")).strip(),
                "detail": str(a.get("detail", "")).strip(),
                "impact": (str(a.get("impact")).strip() or None) if a.get("impact") else None,
            }
            for a in (parsed.get("actions") or [])
            if isinstance(a, dict)
        ],
        "rationale": str(parsed.get("rationale", "")).strip(),
        "confidence": parsed.get("confidence") if parsed.get("confidence") in ("low", "medium", "high") else "medium",
        "source": "llm",
        "model": model,
    }
    if speed:
        reply["speed"] = speed
    return reply


# ── the streaming call ────────────────────────────────────────────────────────

def build_request(prompt: str, system: str, schema: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": config.ANTHROPIC_MODEL,
        "max_tokens": 8000,
        "system": system,
        "stream": True,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": config.ADVISOR_EFFORT,
                          "format": {"type": "json_schema", "schema": schema}},
        "messages": [{"role": "user", "content": prompt}],
    }
    if config.ADVISOR_FAST:
        # Research preview, Claude API only, Opus 5 / 4.8 only. Same model, up to
        # 2.5x output tokens/sec, premium pricing. Opt-in; falls back below.
        body["speed"] = "fast"
    return body


def _headers(fast: bool, fallbacks: bool) -> dict[str, str]:
    betas: list[str] = []
    if fast:
        betas.append("fast-mode-2026-02-01")
    if fallbacks:
        betas.append("server-side-fallback-2026-07-01")
    h = {
        "content-type": "application/json",
        "x-api-key": config.ANTHROPIC_API_KEY,
        "anthropic-version": config.ANTHROPIC_VERSION,
        "accept": "text/event-stream",
    }
    if betas:
        h["anthropic-beta"] = ",".join(betas)
    return h


def _beta_rejected(text: str) -> bool:
    low = text.lower()
    return "fallback" in low or "beta" in low or "speed" in low or "fast" in low


async def run(job: Job, prompt: str, system: str, schema: dict[str, Any]) -> None:
    """Stream the model's answer into `job`. Never raises."""
    try:
        await _run(job, prompt, system, schema)
    except Exception as exc:  # the demo must survive anything that happens here
        log.warning("advisor %s: unexpected error (%r) — keeping the rules answer", job.id, exc)
        job.status = "failed"
        job.error = f"{type(exc).__name__}: {exc}"
        job.emit("error", {"error": job.error, "keep": "rules"})
    finally:
        job.finished.set()


async def _run(job: Job, prompt: str, system: str, schema: dict[str, Any]) -> None:
    base = build_request(prompt, system, schema)
    # (fast, server-side fallbacks) — degrade to the plain request on a 400 that
    # names a beta, so an org without either preview still gets the LLM answer.
    attempts = [
        (config.ADVISOR_FAST, True),
        (config.ADVISOR_FAST, False),
        (False, False),
    ]
    seen: set[tuple[bool, bool]] = set()

    async with httpx.AsyncClient(timeout=config.ADVISOR_TIMEOUT_S) as client:
        for fast, fallbacks in attempts:
            if (fast, fallbacks) in seen:
                continue
            seen.add((fast, fallbacks))
            body = dict(base)
            if not fast:
                body.pop("speed", None)
            if fallbacks:
                body["fallbacks"] = "default"

            buf = ""
            started = False
            try:
                async with client.stream(
                    "POST", config.ANTHROPIC_URL, json=body, headers=_headers(fast, fallbacks)
                ) as resp:
                    if resp.status_code != 200:
                        detail = (await resp.aread()).decode("utf-8", "replace")[:400]
                        if resp.status_code == 400 and _beta_rejected(detail):
                            log.info("advisor %s: beta rejected (fast=%s fallbacks=%s), retrying plainer",
                                     job.id, fast, fallbacks)
                            continue
                        if resp.status_code == 429 and fast:
                            # Fast mode draws on its own rate-limit pool, which an
                            # org may have none of. The standard pool usually has
                            # quota, so drop `speed` rather than lose the answer.
                            log.info("advisor %s: fast mode rate-limited, falling back to standard", job.id)
                            continue
                        log.warning("advisor %s: HTTP %s %s — keeping the rules answer",
                                    job.id, resp.status_code, detail)
                        job.status = "failed"
                        job.error = f"http_{resp.status_code}"
                        job.emit("error", {"error": job.error, "keep": "rules"})
                        return

                    job.status = "streaming"
                    job.emit("start", {"model": config.ANTHROPIC_MODEL,
                                       "speed": "fast" if fast else "standard"})
                    stop_reason = None
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if not raw:
                            continue
                        try:
                            ev = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        t = ev.get("type")
                        if t == "content_block_delta":
                            d = ev.get("delta") or {}
                            if d.get("type") != "text_delta":
                                continue        # thinking deltas are not the answer
                            buf += d.get("text") or ""
                            started = True
                            partial = partial_string(buf, "recommendation")
                            if partial and len(partial) > len(job.text):
                                chunk = partial[len(job.text):]
                                job.text = partial
                                job.emit("delta", {"field": "recommendation", "text": chunk})
                            done_actions = complete_objects(buf, "actions")
                            while len(done_actions) > job.actions_sent:
                                a = done_actions[job.actions_sent]
                                job.actions_sent += 1
                                job.emit("action", {
                                    "index": job.actions_sent - 1,
                                    "label": str(a.get("label", "")).strip(),
                                    "detail": str(a.get("detail", "")).strip(),
                                    "impact": (str(a.get("impact")).strip() or None) if a.get("impact") else None,
                                })
                        elif t == "message_delta":
                            stop_reason = ((ev.get("delta") or {}).get("stop_reason")) or stop_reason
                        elif t == "error":
                            err = (ev.get("error") or {}).get("message", "stream error")
                            log.warning("advisor %s: stream error %s", job.id, err)
                            job.status = "failed"
                            job.error = err
                            job.emit("error", {"error": err, "keep": "rules"})
                            return
            except httpx.HTTPError as exc:
                log.warning("advisor %s: transport error (%s) — keeping the rules answer", job.id, exc)
                job.status = "failed"
                job.error = f"transport: {exc}"
                job.emit("error", {"error": job.error, "keep": "rules"})
                return

            if stop_reason == "refusal":
                log.warning("advisor %s: model declined — keeping the rules answer", job.id)
                job.status = "failed"
                job.error = "refusal"
                job.emit("error", {"error": "refusal", "keep": "rules"})
                return
            if not started or not buf.strip():
                log.warning("advisor %s: empty stream — keeping the rules answer", job.id)
                job.status = "failed"
                job.error = "empty_response"
                job.emit("error", {"error": "empty_response", "keep": "rules"})
                return

            try:
                parsed = json.loads(buf)
            except json.JSONDecodeError:
                log.warning("advisor %s: response was not JSON — keeping the rules answer", job.id)
                job.status = "failed"
                job.error = "unparseable"
                job.emit("error", {"error": "unparseable", "keep": "rules"})
                return

            reply = normalise(parsed, config.ANTHROPIC_MODEL, "fast" if fast else None)
            if not reply["recommendation"] or not reply["actions"]:
                log.warning("advisor %s: reply was incomplete — keeping the rules answer", job.id)
                job.status = "failed"
                job.error = "incomplete"
                job.emit("error", {"error": "incomplete", "keep": "rules"})
                return

            job.reply = reply
            job.status = "complete"
            job.emit("done", {"reply": reply})
            return

    job.status = "failed"
    job.error = "no_attempt_succeeded"
    job.emit("error", {"error": job.error, "keep": "rules"})
