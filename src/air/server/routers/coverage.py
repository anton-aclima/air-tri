"""/coverage — what the fixed network sees, and what passes it by.

Two different questions live here and they must not be confused:

  /campaigns/{id}/coverage   where a CAR has actually been (measurement)
  /coverage/interception     where a modelled PLUME crosses a fixed instrument
  /coverage/residency        modelled plume-hours per street, and how many of
                             them nothing was standing in
  /coverage/siting           the streets carrying the most unobserved ones

The first is a record of measurement. The other three are entirely MODELLED —
they answer "where does the model say the air went, and was anything there" —
and every payload says so in `basis` rather than leaving the screen to
remember. CONTRACT section 10a rule 1.
"""

from __future__ import annotations

import math
import sqlite3
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from air.server import cache, coverage, domain
from air.server import touchdown as td
from air.server.db import get_db, one, resolve_campaign

router = APIRouter(tags=["coverage"])


@router.get("/campaigns/{campaign_id}/coverage")
def campaign_coverage(
    campaign_id: str,
    cell_m: float = 150.0,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Where a car has actually been. The bound on every claim drawn over it.

    Any interface drawing a model plume dims or hatches it outside this mask,
    and no agreement metric is computed outside it — one layer that does more
    honesty work than any sentence in the product.

    `cell_m` is the cell's SIDE, not a radius, which matters when comparing
    against the figure this was specified from ("69% of the bbox is more than
    150 m from any driven segment midpoint", i.e. about 31% covered). A 150 m
    radius is `cell_m=300`, and that returns 32.5%. At `cell_m=150` — a ±75 m
    cell — it is 20.8%, because the question is stricter, not because the
    numbers disagree.
    """
    cid = resolve_campaign(conn, campaign_id if campaign_id != "current" else None)
    if one(conn, "SELECT 1 FROM campaign WHERE id=?", (cid,)) is None:
        raise HTTPException(404, f"unknown campaign {campaign_id}")
    cell_m = max(25.0, min(float(cell_m), 2000.0))
    key = ("coverage", cid, cell_m, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, td.coverage_cells(conn, cid, cell_m))


@router.get("/coverage/interception")
def coverage_interception(
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """How often each fixed instrument stands inside a modelled plume.

    Computed live behind the cache rather than precomputed into a table. The
    tower surface is 4 receptors x 2,160 hours x 3 sites and runs in about half
    a second, which is what lets a tier selector feel instant; the full
    1,307-segment surface is the panel to defer, not the headline.
    """
    cid = resolve_campaign(conn, campaign_id)
    key = ("interception", cid, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    r = coverage.interception(conn, cid)

    ref = r.reference
    any_ref = sum(1 for i in ref if i.hours_in_plume > 0)
    # The verdict sentence's own numbers, computed here so four interfaces
    # cannot each derive a different one.
    payload = {
        "campaign_id": cid,
        "n_hours": r.n_hours,
        "basis": r.basis,
        "instruments": [asdict(i) for i in r.instruments],
        "concession": asdict(coverage.concession(conn, cid)),
        "reference_summary": {
            "n": len(ref),
            "n_ever_in_plume": any_ref,
            "n_rarely": sum(1 for i in ref if i.share < 0.02),
            "best_share": max((i.share for i in ref), default=0.0),
            "worst_share": min((i.share for i in ref), default=0.0),
        },
    }
    return cache.put(key, payload)


@router.get("/coverage/residency")
def coverage_residency(
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Modelled plume-hours per street, and how many nothing was standing in."""
    cid = resolve_campaign(conn, campaign_id)
    key = ("residency", cid, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    rows = coverage.residency(conn, cid)
    total = sum(r.plume_hours for r in rows)
    unobs = sum(r.unobserved_hours for r in rows)
    payload = {
        "campaign_id": cid,
        "basis": coverage._BASIS,
        "plume_hours": total,
        "unobserved_hours": unobs,
        "unobserved_share": round(unobs / max(1, total), 4),
        "segments": [asdict(r) for r in rows],
    }
    return cache.put(key, payload)


@router.get("/coverage/siting")
def coverage_siting(
    campaign_id: str | None = None,
    limit: int = 10,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """The streets carrying the most unobserved plume-hours in this record.

    **Not a recommendation.** Siting a regulatory instrument involves land
    access, power, security and network-design rules this product knows nothing
    about, and recommending where a public agency puts one is the closest this
    system comes to giving regulatory advice. `framing` travels with the rows
    so a screen cannot quietly promote them into advice.
    """
    cid = resolve_campaign(conn, campaign_id)
    limit = max(1, min(int(limit), 50))
    key = ("siting", cid, limit, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    rows = coverage.siting_candidates(conn, cid, limit)
    payload = {
        "campaign_id": cid,
        "basis": coverage._BASIS,
        "framing": (
            "These streets carry the most modelled plume-hours that no instrument "
            "was standing in. That is an observation about this record, not advice "
            "about where to put an instrument."
        ),
        "min_plume_hours": coverage.MIN_PLUME_HOURS,
        "candidates": [asdict(r) for r in rows],
    }
    return cache.put(key, payload)


@router.get("/coverage/calibration")
def coverage_calibration(
    at: str | None = None,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Per-CHANNEL anchoring state. P7-D.

    A single green "calibrated" badge on a node is false for most of what that
    node measures. What can be anchored to a reference instrument is exactly
    what the reference instruments already carry — and the species this product
    uniquely provides are precisely the ones nothing in the region can anchor.

    No DAG, no hop counts, no residual histogram, no new tables: the finding is
    stronger stated than drawn, and it is read straight off `measures_json`
    plus colocation computed from `segment_pass` x `monitor`.

    `at` is the moment ages are measured from (`domain.as_of`: no `at` is the
    end, past the end is the end, garbage is a 422). It was `MAX(ts) FROM
    monitor_reading` — its own "now", 54 min before the server's — and the age
    was `abs()`, so at Aug 12 the NO2 row read "11 d" for Weaver Road's Aug 18
    calibration, six days in the future. Only the LAST calibration is stored,
    so an anchor calibrated after `at` has no known stamp then: its
    `last_calibrated` is null and it does not set the channel's age. A channel
    whose every anchor is like that has `age_days: None`, never a negative or
    mirrored age. Which channels are anchored does not move: the instruments
    were standing all campaign.
    """
    import json as _json

    cid = resolve_campaign(conn, campaign_id)
    now = domain.as_of(conn, cid, at)
    key = ("calibration", cid, cache.version())
    base = cache.get(key)
    if base is None:
        measures = [
            {"code": r[0], "plain_name": r[1], "family": r[2]}
            for r in conn.execute(
                "SELECT code, plain_name, family FROM measure_def ORDER BY sort_order, code"
            )
        ]
        anchors: dict[str, list[dict[str, Any]]] = {}
        for mid, name, grade, last_cal, mj in conn.execute(
            "SELECT id, name, grade, last_calibrated, measures_json FROM monitor "
            "WHERE campaign_id = ? AND grade = 'reference'",
            (cid,),
        ):
            for code in _json.loads(mj or "[]"):
                anchors.setdefault(code, []).append(
                    {"monitor_id": mid, "name": name, "grade": grade, "last_calibrated": last_cal}
                )
        base = cache.put(key, {"measures": measures, "anchors": anchors})

    out = []
    for m in base["measures"]:
        anch = [
            {**a, "last_calibrated": _by(a["last_calibrated"], now)}
            for a in base["anchors"].get(m["code"], [])
        ]
        newest = max((a["last_calibrated"] or "" for a in anch), default="")
        out.append({
            **m,
            "anchored": bool(anch),
            "n_reference_anchors": len(anch),
            "anchors": anch,
            "last_anchored_at": newest or None,
            "age_days": _age_days(newest, now),
            "note": (
                None if anch else
                "No reference anchor exists in this campaign. Nothing in the region "
                "can calibrate this channel."
            ),
        })
    return {
        "campaign_id": cid,
        "as_of": now,
        "n_measures": len(out),
        "n_anchored": sum(1 for m in out if m["anchored"]),
        "channels": out,
    }


def _by(stamp: str | None, now: str) -> str | None:
    """`stamp` if it had happened by `now`. `last_calibrated` is a bare date
    (`2026-08-18`), which sorts before any time on that day, so a calibration
    on the day `now` falls in counts from midnight."""
    return stamp if stamp and stamp[:19] <= now else None


def _age_days(stamp: str, now: str | None) -> float | None:
    """Days from `stamp` to `now`; None when either is missing or `stamp` is
    after `now` — a calibration that has not happened yet has no age."""
    if not stamp or not now:
        return None
    import datetime as dt

    try:
        a = dt.datetime.fromisoformat(stamp[:19])
        b = dt.datetime.fromisoformat(now[:19])
    except ValueError:
        return None
    seconds = (b - a).total_seconds()
    return None if seconds < 0 else round(seconds / 86400.0, 1)


_ = math
