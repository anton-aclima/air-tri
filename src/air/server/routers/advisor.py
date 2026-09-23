"""POST /advisor — "what do I do about this alert".

A real Claude API call (Messages API, `claude-opus-5`) with structured output, and
graceful degradation to a deterministic rules engine. The demo must never break
because ANTHROPIC_API_KEY is missing or the network hiccups, so *every* failure
path returns a well-formed AdvisorReply with `source: 'rules'`.

The `anthropic` SDK is not a dependency of this project (pyproject is owned by
the orchestrator), so the call goes over raw HTTP with httpx — which is already a
dependency. See src/air/server/README.md.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from air.server import (
    advisor_jobs,
    advisor_rules,
    config,
    domain,
    envelope,
    geo,
    loaders,
    timeutil,
    windfield,
)
from air.server.db import get_db, one, resolve_campaign, rows
from air.server.models import AdvisorIn

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

log = logging.getLogger("air.advisor")
router = APIRouter(tags=["advisor"])

# "Current" wind for the operator: the most recent window that still has a
# usable sample, near the site if possible.
LOCAL_RADIUS_M = 1500.0
LOCAL_WINDOWS_H = (6.0, 24.0, 72.0, 168.0)
LOCAL_MIN_OBS = 12

REPLY_SCHEMA = {
    "type": "object",
    "properties": {
        "recommendation": {
            "type": "string",
            "description": "2-4 sentences. Terse, operational, glanceable at 3 m. Name the equipment, the percentage, and the duration.",
        },
        "actions": {
            # No minItems/maxItems: the API rejects array bounds other than 0/1
            # in output_config schemas, so the count lives in the description.
            "type": "array",
            "description": "Two to four actions, most important first.",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "description": "Imperative, under 60 characters."},
                    "detail": {"type": "string", "description": "One or two sentences of how."},
                    "impact": {
                        "type": "string",
                        "description": "Expected fenceline effect, e.g. '≈30% lower NO2 at the east ring within one hour'. Empty string if genuinely unknown.",
                    },
                },
                "required": ["label", "detail", "impact"],
                "additionalProperties": False,
            },
        },
        "rationale": {"type": "string", "description": "Why this works, 2-3 sentences, referencing the wind and the geometry."},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["recommendation", "actions", "rationale", "confidence"],
    "additionalProperties": False,
}

SYSTEM = """You are the operations advisor inside Aclima `air`, an air-quality
platform. Your user is the operations engineer at an industrial site (usually an
AI datacenter with on-site gas turbines and diesel backup). Their interface is a
radar warning receiver: bearing, distance, severity, and ONE recommended action.
They do not want analysis. They want to know which equipment to touch, by how
much, for how long, and what it will buy them.

Rules:
- Be concrete and operational. "Throttle generators G-3 and G-4 by 30% for 4
  hours" — never "consider reviewing emissions".
- Quantify the expected fenceline reduction. An approximate percentage is better
  than a hedge.
- Only reference equipment, monitors and concerns that appear in the context.
  Never invent an emission point, a reading, or a regulation.
- All data in this system is SIMULATED. Do not caveat that; just advise.
- Industry cannot close a community concern. If you suggest engaging residents,
  frame it as proposing a mitigation, never as resolving or closing.
- No units in anything you address to residents; be precise in anything you
  address to the operator.
- Wind measured by our vehicle anemometers beats wind assumed by a consultant's
  study. If the two disagree, advise on the measurement and tell the operator the
  study needs re-running. If the comparison says `insufficient_data`, do not claim
  the study is wrong.
"""


def build_context(conn: sqlite3.Connection, payload: AdvisorIn) -> dict[str, Any]:
    """Everything the model (or the rules engine) needs, in one dict."""
    cid = resolve_campaign(conn, payload.campaign_id)
    alert: dict[str, Any] | None = None
    site_id = payload.site_id

    if payload.alert_id:
        row = one(conn, "SELECT * FROM alert WHERE id=?", (payload.alert_id,))
        if row is not None:
            from air.server import shapes

            alert = shapes.alert(row)
            site_id = site_id or alert["site_id"]

    site = None
    if site_id:
        found = loaders.load_sites(conn, cid, site_id=site_id)
        site = found[0] if found else None
    if site is None:
        found = loaders.load_sites(conn, cid)
        site = found[0] if found else None
    if site and alert and alert.get("lon") is not None:
        c = site["centroid"]
        alert["bearing_deg"] = round(geo.bearing_deg(c[0], c[1], alert["lon"], alert["lat"]), 1)
        alert["distance_m"] = round(geo.haversine_m(c[0], c[1], alert["lon"], alert["lat"]), 1)

    measure = (alert or {}).get("measure") or "no2"
    mdefs = domain.measures(conn)
    now = domain.data_now(conn, cid)

    concerns = []
    if site:
        c = site["centroid"]
        concerns = loaders.load_concerns(
            conn, cid,
            since=timeutil.shift(now, days=-7),
            near=(c[0], c[1], 2500.0), limit=25, with_responses=False,
        )

    readings: list[dict[str, Any]] = []
    for m in loaders.load_monitors(conn, cid):
        if measure not in m["measures"]:
            continue
        series = rows(
            conn,
            """SELECT ts, value FROM monitor_reading
                WHERE monitor_id=? AND measure=? AND qc='valid' ORDER BY ts DESC LIMIT 12""",
            (m["id"], measure),
        )
        if not series:
            continue
        brg = None
        dist = None
        if site:
            c = site["centroid"]
            brg = round(geo.bearing_deg(c[0], c[1], m["lon"], m["lat"]), 1)
            dist = round(geo.haversine_m(c[0], c[1], m["lon"], m["lat"]))
        readings.append(
            {
                "monitor": m["name"],
                "owner_type": m["owner_type"],
                "grade": m["grade"],
                "bearing_from_site_deg": brg,
                "compass_from_site": geo.compass(brg) if brg is not None else None,
                "distance_from_site_m": dist,
                "recent": [{"t": r["ts"], "v": round(r["value"], 2)} for r in reversed(series)],
            }
        )

    action_levels = [
        {
            "id": r["id"], "label": r["label"], "kind": r["kind"], "threshold": r["threshold"],
            "unit": r["unit"], "averaging_hours": r["averaging_hours"], "severity": r["severity"],
        }
        for r in rows(
            conn,
            """SELECT * FROM action_level WHERE campaign_id=? AND measure=? AND enabled=1
                ORDER BY threshold""",
            (cid, measure),
        )
    ]

    if site:
        c = site["centroid"]
        for p in site["emission_points"]:
            p["bearing_from_centroid_deg"] = round(geo.bearing_deg(c[0], c[1], p["lon"], p["lat"]), 1)
            p["compass_from_centroid"] = geo.compass(p["bearing_from_centroid_deg"])
            p["distance_from_centroid_m"] = round(geo.haversine_m(c[0], c[1], p["lon"], p["lat"]))

    # Observed wind from the fleet anemometers — what the wind is actually doing,
    # as distinct from what the consultant's study assumed. This is the part an
    # operator is paying us for, so the advisor has to see it.
    observed_rose: list[dict[str, Any]] = []
    measured_local: dict[str, Any] | None = None
    verification: dict[str, Any] | None = None
    if site is not None:
        c = site["centroid"]
        since_30 = timeutil.shift(now, days=-30) or timeutil.ago(days=30)
        obs = loaders.load_mobile_wind(conn, cid, from_=since_30, to=now, limit=200000)
        if obs:
            # The 30-day rose is the climatology. "What is the wind doing now"
            # is a different question: averaging a month that contains two
            # regimes reports a direction that never actually blew. Take the
            # most recent hours that still have a usable sample, and say which
            # window that was.
            near = [o for o in obs if geo.haversine_m(c[0], c[1], o["lon"], o["lat"]) <= LOCAL_RADIUS_M]
            observed_rose = windfield.rose([(o["dir_deg"], o["speed_ms"]) for o in obs])
            pool: list[dict[str, Any]] = []
            used_h: float | None = None
            radius: int | None = LOCAL_RADIUS_M
            for hours in LOCAL_WINDOWS_H:
                cutoff = timeutil.shift(now, hours=-hours) or ""
                pool = [o for o in near if o["ts"] >= cutoff]
                if len(pool) >= LOCAL_MIN_OBS:
                    used_h = hours
                    break
            if len(pool) < LOCAL_MIN_OBS:
                # Nothing near the site recently — widen to the campaign before
                # widening in time, since direction is the thing we care about.
                for hours in LOCAL_WINDOWS_H:
                    cutoff = timeutil.shift(now, hours=-hours) or ""
                    pool = [o for o in obs if o["ts"] >= cutoff]
                    if len(pool) >= LOCAL_MIN_OBS:
                        used_h, radius = hours, None
                        break
            if len(pool) < LOCAL_MIN_OBS:
                pool, used_h, radius = obs[-400:], None, None
            mean, r = windfield.circular_mean([o["dir_deg"] for o in pool])
            measured_local = {
                "dir_deg": round(mean, 1),
                "compass": geo.compass(mean),
                "speed_ms": round(sum(o["speed_ms"] for o in pool) / len(pool), 2),
                "dir_sd": round(windfield.circular_sd(r), 1),
                "n": len(pool),
                "within_m": radius,
                "window_h": used_h,
            }
        models = loaders.load_dispersion_models(conn, site_id=site["id"])
        if models and obs:
            verification = windfield.verify_model(
                models[0], obs, (c[0], c[1]),
                windfield.downwind_districts_fn(conn, cid, (c[0], c[1])),
                (since_30, now),
            )
            verification["model_name"] = models[0]["name"]
            verification["model_vendor"] = models[0]["vendor"]
            verification["model_method"] = models[0]["method"]

    # The MEASURED operating envelope, for the regime the air is in right now.
    # This is the industry tier's spine and it replaced `site.headroom_pct`, a
    # constant in the generator that the advisor used to quote as if it were a
    # finding. Best-effort: the advisor must answer even if the envelope cannot
    # be estimated for this site, and saying nothing is the honest fallback.
    envelope_ctx: dict[str, Any] | None = None
    if site:
        try:
            wind_now = domain.current_wind(conn, cid) or {}
            cls = (wind_now.get("stability") or "D").upper()
            regime = next(
                (name for name, classes in envelope.REGIMES.items() if cls in classes), "neutral"
            )
            levels = [
                dict(r)
                for r in rows(
                    conn,
                    "SELECT id,label,measure,threshold,unit,severity,source FROM action_level "
                    "WHERE measure=? AND enabled=1 ORDER BY threshold",
                    (measure,),
                )
            ]
            if levels and measure in envelope.DECOY_FLOOR:
                env = envelope.estimate(
                    conn, envelope.load(conn, cid, measure), site["id"], measure,
                    levels[0]["unit"], site.get("it_load_mw"), levels,
                )
                r = next((x for x in env.regimes if x.regime == regime), None)
                if r and r.excess is not None and r.thresholds:
                    watch = min(r.thresholds, key=lambda t: t.threshold)
                    envelope_ctx = {
                        "regime": regime, "excess": r.excess, "unit": env.unit,
                        "episodes": r.n_episodes, "state": r.state,
                        "threshold": watch.threshold, "cut_pct": watch.cut_pct_typical,
                    }
        except (KeyError, sqlite3.Error):
            envelope_ctx = None

    return {
        "campaign_id": cid,
        "question": payload.question,
        "alert": alert,
        "site": site,
        "envelope": envelope_ctx,
        "wind": domain.current_wind(conn, cid),
        "observed_rose": observed_rose,
        "measured_local_wind": measured_local,
        "model_verification": verification,
        "concerns": concerns,
        "monitor_readings": readings,
        "action_levels": action_levels,
        "measure_def": mdefs.get(measure, {}),
        "now": now,
    }


def _prompt(ctx: dict[str, Any]) -> str:
    alert = ctx.get("alert")
    site = ctx.get("site") or {}
    wind = ctx.get("wind") or {}
    md = ctx.get("measure_def") or {}

    lines: list[str] = []
    lines.append("# The contact")
    if alert:
        lines.append(
            f"- {alert['kind']} / {alert['severity']} · {alert['title']}\n"
            f"- measure: {md.get('short_label', alert.get('measure'))} ({md.get('label')}), "
            f"value {alert.get('value')} {alert.get('unit') or md.get('unit')}, "
            f"threshold {alert.get('threshold')}\n"
            f"- source: {alert['source_type']} ({alert.get('source_id')})\n"
            f"- started {alert['started_at']}, status {alert['status']}\n"
            f"- bearing from our site centroid: {alert.get('bearing_deg')}° "
            f"({geo.compass(alert['bearing_deg']) if alert.get('bearing_deg') is not None else '—'}) "
            f"at {alert.get('distance_m')} m\n"
            f"- body: {alert.get('body')}"
        )
    else:
        lines.append("- No specific alert; the operator asked a direct question.")
    if ctx.get("question"):
        lines.append(f"\n# The operator's question\n{ctx['question']}")

    lines.append("\n# Our site")
    if site:
        lines.append(
            f"- {site['name']} ({site['kind']}, {site['status']}), "
            f"{site.get('capacity_mw')} MW capacity / {site.get('it_load_mw')} MW IT load, "
            f"{site.get('generator_count')}× {site.get('generator_fuel')}"
        )
        # The operating envelope, MEASURED. This replaced `site.headroom_pct`,
        # which was a constant in the generator: quoting it to a model that then
        # quotes it back to the operator is how a made-up number acquires
        # authority. If the envelope could not be estimated, nothing is said.
        env = ctx.get("envelope")
        if env:
            lines.append(
                f"- operating envelope, measured on our own fenceline against class-matched "
                f"roads >2 km from any site: {env['excess']:+.1f} {env['unit']} in "
                f"{env['regime']} air over {env['episodes']} episodes"
                + (
                    f"; holding the {env['threshold']} {env['unit']} level would need about "
                    f"{env['cut_pct']:.0f}% of our own contribution to go"
                    if env.get("cut_pct")
                    else "; no action level crossed"
                )
            )
        lines.append("- emission points (bearing/range from our centroid):")
        for p in site.get("emission_points", []):
            lines.append(
                f"  · {p['name']} — {p['kind']}, {p.get('height_m')} m stack, "
                f"{'ACTIVE' if p['active'] else 'idle'}, "
                f"{p.get('compass_from_centroid')} {p.get('bearing_from_centroid_deg')}° "
                f"at {p.get('distance_from_centroid_m')} m"
            )

    lines.append("\n# Current wind")
    if wind:
        blows_to = (float(wind["dir_deg"]) + 180.0) % 360.0
        lines.append(
            f"- from {wind['dir_deg']}° ({geo.compass(wind['dir_deg'])}) at {wind['speed_ms']} m/s, "
            f"gusting {wind.get('gust_ms')} — plume travels toward {blows_to:.0f}° "
            f"({geo.compass(blows_to)})\n"
            f"- stability class {wind.get('stability')}, boundary layer {wind.get('pbl_m')} m, "
            f"{wind.get('temp_c')} °C, {wind.get('rh')}% RH, at {wind['ts']}"
        )

    obs_local = ctx.get("measured_local_wind")
    rose = ctx.get("observed_rose") or []
    if obs_local or rose:
        lines.append("\n# Observed wind — measured by anemometers on our vehicles")
        if obs_local:
            near = f" within {obs_local['within_m']:.0f} m of the site" if obs_local.get("within_m") else " campaign-wide"
            win = f" over the last {obs_local['window_h']:.0f} h" if obs_local.get("window_h") else " (most recent sample available)"
            lines.append(
                f"- CURRENT measured wind{near}{win}: from {obs_local['dir_deg']}° "
                f"({obs_local['compass']}) at {obs_local['speed_ms']} m/s, circular spread "
                f"{obs_local['dir_sd']}° over {obs_local['n']} observations. Advise on THIS, "
                f"not on the 30-day rose below — the rose is climatology."
            )
        if rose:
            top = sorted(rose, key=lambda b: -b["freq"])[:5]
            lines.append("- observed 30-day rose, most frequent sectors (wind FROM):")
            for b in top:
                if b["freq"] <= 0:
                    continue
                to_deg = (b["dir_deg"] + 180.0) % 360.0
                lines.append(
                    f"  · {geo.compass(b['dir_deg'])} {b['dir_deg']:.0f}° — {b['freq']:.1f}% of "
                    f"observations, mean {b['mean_speed_ms']} m/s, carries the plume toward "
                    f"{geo.compass(to_deg)}"
                )

    ver = ctx.get("model_verification")
    if ver:
        lines.append("\n# The consultant's dispersion study vs. what we measure")
        lines.append(
            f"- {ver.get('model_name')} ({ver.get('model_vendor')}, {ver.get('model_method')}) — "
            f"verdict from our data: **{ver['verdict']}** across {ver['n_obs']} observations"
        )
        lines.append(f"- {ver['summary']}")
        if ver["verdict"] == "insufficient_data":
            lines.append(
                "- NOTE: this sample is too thin to judge the study. Do not tell the operator "
                "their study is wrong; say the comparison needs more passes."
            )
        if ver["understated_bearings"]:
            lines.append(
                "- bearings the study understates (wind FROM): "
                + ", ".join(f"{b:.0f}°" for b in ver["understated_bearings"])
            )
        for d in ver["affected_districts"][:3]:
            lines.append(
                f"  · {d['district']} — study weighted {d['assumed_freq']:.1f}% of hours, "
                f"we measured {d['observed_freq']:.1f}%"
            )
        lines.append(
            f"- share of observed hours falling outside the modelled contour: "
            f"{ver['disagreement'] * 100:.0f}%"
        )

    lines.append("\n# Action levels in force for this measure")
    for lv in ctx.get("action_levels", []):
        lines.append(
            f"- {lv['label']}: {lv['threshold']}{lv['unit']} ({lv['kind']}, "
            f"{lv['averaging_hours']} h averaging, severity {lv['severity']})"
        )
    if not ctx.get("action_levels"):
        lines.append("- none currently enabled")

    lines.append("\n# Recent monitor readings for this measure")
    for r in ctx.get("monitor_readings", [])[:6]:
        vals = ", ".join(f"{p['v']}" for p in r["recent"])
        lines.append(
            f"- {r['monitor']} ({r['owner_type']}/{r['grade']}, {r.get('compass_from_site')} "
            f"{r.get('bearing_from_site_deg')}° at {r.get('distance_from_site_m')} m): {vals} "
            f"(oldest→newest, {md.get('unit')})"
        )

    lines.append("\n# Community concerns within 2.5 km in the last 7 days")
    for c in ctx.get("concerns", [])[:12]:
        lines.append(
            f"- {c['occurred_at']} · {c['kind']} (severity {c['severity']}) "
            f"in {c.get('district') or 'the community'}: “{c['title']}” "
            f"[{c['status']}, {c['corroborations']} corroborations]"
        )
    if not ctx.get("concerns"):
        lines.append("- none")

    lines.append(
        "\n# What we need\nGive the operator ONE recommendation plus 2-4 concrete actions. "
        "Say which emission points to throttle, by what percentage, for how long, and the "
        "expected fenceline reduction. Reference the **measured** wind direction and the "
        "bearing to the contact explicitly. Where our measured rose disagrees with the "
        "consultant's study, say so and base the advice on the measurement, not the study — "
        "but only if the verdict above is not `insufficient_data`."
    )
    return "\n".join(lines)


@router.post("/advisor")
async def advise(payload: AdvisorIn, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    """Answer instantly, then upgrade.

    Returns the rules-engine recommendation immediately — a complete, actionable
    answer — and, when a key is configured, starts a streaming model call behind
    it. The `upgrade` block tells the client whether a better answer is coming
    and where to watch for it. The operator never sees a spinner.
    """
    ctx = build_context(conn, payload)
    rules = advisor_rules.build(ctx)

    if not (config.ANTHROPIC_API_KEY and config.ADVISOR_UPGRADE):
        reason = "no_api_key" if not config.ANTHROPIC_API_KEY else "upgrade_disabled"
        if reason == "no_api_key":
            log.info("advisor: ANTHROPIC_API_KEY not set — rules answer only")
        return {**rules, "upgrade": {"pending": False, "reason": reason}}

    job = advisor_jobs.create(rules)
    # Fire and forget: the response goes out now, the model streams behind it.
    asyncio.create_task(
        advisor_jobs.run(job, _prompt(ctx), SYSTEM, REPLY_SCHEMA)
    )
    return {
        **rules,
        "upgrade": {
            "pending": True,
            "request_id": job.id,
            "stream_url": f"{config.API_PREFIX}/advisor/{job.id}/stream",
            "result_url": f"{config.API_PREFIX}/advisor/{job.id}",
            "model": config.ANTHROPIC_MODEL,
        },
    }


@router.get("/advisor/{request_id}")
def advisor_result(request_id: str) -> dict[str, Any]:
    """Poll the upgrade. For clients that cannot hold an SSE connection, and for
    reconnects. `reply` is always the best answer available right now — the
    model's if it landed, the rules engine's if it did not."""
    job = advisor_jobs.get(request_id)
    if job is None:
        raise HTTPException(404, f"unknown advisor request {request_id}")
    return job.snapshot()


@router.get("/advisor/{request_id}/stream")
async def advisor_stream(request_id: str, request: Request) -> StreamingResponse:
    """SSE for one advisor upgrade.

    `event: start` -> `event: delta` (the recommendation typing itself) ->
    `event: done` with the full AdvisorReply, or `event: error` carrying
    `keep: "rules"` — meaning: leave the answer you already have on screen.
    Buffered events are replayed on connect, so a client that attaches a beat
    after POST does not miss the opening tokens.
    """
    job = advisor_jobs.get(request_id)
    if job is None:
        raise HTTPException(404, f"unknown advisor request {request_id}")

    async def gen() -> AsyncIterator[str]:
        q, backlog = job.subscribe()
        try:
            yield ": advisor stream open\n\n"
            for env in backlog:
                yield _frame(env)
            if job.status in ("complete", "failed"):
                return
            while True:
                if await request.is_disconnected():
                    return
                try:
                    env = await asyncio.wait_for(q.get(), timeout=config.SSE_HEARTBEAT_S)
                except TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield _frame(env)
                if env["event"] in ("done", "error"):
                    return
        finally:
            job.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


def _frame(env: dict[str, Any]) -> str:
    payload = json.dumps(env["data"], separators=(",", ":"), default=str)
    return f"event: {env['event']}\ndata: {payload}\n\n"
