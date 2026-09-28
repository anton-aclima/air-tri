"""/sites, /posts, /mitigations — the industry outreach portal, and LOOP 3.

Both POST /posts (with a concern_id) and POST /mitigations create a linked
`concern_response(kind='mitigation')` so the item surfaces under the resident's
own report in the community feed. Neither can resolve the concern.
"""

from __future__ import annotations

import sqlite3
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from air.server import cache, domain, envelope, loaders, shapes, timeutil, windfield
from air.server.db import get_db, one, resolve_campaign, rows, scalar, writer
from air.server.models import MitigationIn, PostIn

router = APIRouter(tags=["industry"])


@router.get("/sites")
def list_sites(
    campaign_id: str | None = None, conn: sqlite3.Connection = Depends(get_db)
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    return loaders.load_sites(conn, cid)


@router.get("/sites/{site_id}")
def get_site(site_id: str, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    r = one(conn, "SELECT campaign_id FROM industry_site WHERE id=?", (site_id,))
    if r is None:
        raise HTTPException(404, f"unknown site {site_id}")
    return loaders.load_sites(conn, r["campaign_id"], site_id=site_id)[0]


@router.get("/posts")
def list_posts(
    site_id: str | None = None,
    kind: str | None = None,
    concern_id: str | None = None,
    limit: int = 200,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    return loaders.load_posts(conn, cid, site_id=site_id, kind=kind, concern_id=concern_id, limit=limit)


@router.get("/mitigations")
def list_mitigations(
    site_id: str | None = None,
    concern_id: str | None = None,
    alert_id: str | None = None,
    limit: int = 200,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    cid = resolve_campaign(conn, campaign_id)
    return loaders.load_mitigations(
        conn, cid, site_id=site_id, concern_id=concern_id, alert_id=alert_id, limit=limit
    )


# ── writes ────────────────────────────────────────────────────────────────────

@router.post("/posts", status_code=201)
def create_post(payload: PostIn, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    site = one(conn, "SELECT * FROM industry_site WHERE id=?", (payload.site_id,))
    if site is None:
        raise HTTPException(404, f"unknown site {payload.site_id}")
    cid = payload.campaign_id or site["campaign_id"]
    post_id = domain.new_id("sp")
    now = timeutil.now_iso()

    with writer() as w:
        author_id = payload.author_id or site["claimed_by_user_id"] or scalar(
            w, "SELECT id FROM app_user WHERE role='industry' ORDER BY id LIMIT 1"
        )
        w.execute(
            """INSERT INTO site_post (id, campaign_id, site_id, org_id, author_id, kind, title, body,
                                      concern_id, media_emoji, pinned, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (post_id, cid, payload.site_id, site["org_id"], author_id, payload.kind, payload.title,
             payload.body, payload.concern_id, payload.media_emoji, 1 if payload.pinned else 0, now),
        )
        wire = loaders.load_posts(w, cid, post_id=post_id)[0]
        domain.log(
            w, "post.created", campaign_id=cid, actor_role="industry", actor_id=author_id,
            object_type="site_post", object_id=post_id, summary=payload.title,
            payload={"site_id": payload.site_id, "kind": payload.kind, "concern_id": payload.concern_id},
            obj=wire,
        )
        # LOOP 3: a post aimed at a concern becomes a mitigation response on it.
        response = None
        if payload.concern_id:
            response = domain.attach_mitigation_response(
                w, payload.concern_id,
                body=f"{site['name']}: {payload.title}\n\n{payload.body}",
                org_id=site["org_id"], author_id=author_id, campaign_id=cid,
            )
    return {**wire, "concern_response": response}


@router.post("/mitigations", status_code=201)
def create_mitigation(payload: MitigationIn, conn: sqlite3.Connection = Depends(get_db)) -> dict[str, Any]:
    site = one(conn, "SELECT * FROM industry_site WHERE id=?", (payload.site_id,))
    if site is None:
        raise HTTPException(404, f"unknown site {payload.site_id}")
    cid = payload.campaign_id or site["campaign_id"]
    mid = domain.new_id("mi")
    now = timeutil.now_iso()
    reduction = payload.expected_reduction_pct

    with writer() as w:
        author_id = payload.author_id or site["claimed_by_user_id"] or scalar(
            w, "SELECT id FROM app_user WHERE role='industry' ORDER BY id LIMIT 1"
        )
        cluster_id = payload.cluster_id
        if cluster_id is None and payload.concern_id:
            cluster_id = scalar(w, "SELECT cluster_id FROM concern WHERE id=?", (payload.concern_id,))
        w.execute(
            """INSERT INTO mitigation (id, site_id, concern_id, cluster_id, alert_id, title, body,
                                       status, measure, expected_reduction_pct, started_at,
                                       completed_at, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)""",
            (mid, payload.site_id, payload.concern_id, cluster_id, payload.alert_id, payload.title,
             payload.body, payload.status, payload.measure, reduction,
             now if payload.status == "in_progress" else None, now),
        )
        wire = shapes.mitigation(one(w, "SELECT * FROM mitigation WHERE id=?", (mid,)))

        # Surface it in the community feed as a post from the operator.
        post_id = domain.new_id("sp")
        pct = f" Expected reduction: {reduction:g}%." if reduction is not None else ""
        w.execute(
            """INSERT INTO site_post (id, campaign_id, site_id, org_id, author_id, kind, title, body,
                                      concern_id, media_emoji, pinned, created_at)
               VALUES (?,?,?,?,?, 'mitigation', ?,?,?, '🛠️', 0, ?)""",
            (post_id, cid, payload.site_id, site["org_id"], author_id, payload.title,
             (payload.body or "") + pct, payload.concern_id, now),
        )
        post_wire = loaders.load_posts(w, cid, post_id=post_id)[0]
        domain.log(
            w, "mitigation.created", campaign_id=cid, actor_role="industry", actor_id=author_id,
            object_type="mitigation", object_id=mid, summary=payload.title,
            payload={"site_id": payload.site_id, "concern_id": payload.concern_id,
                     "alert_id": payload.alert_id, "expected_reduction_pct": reduction,
                     "post_id": post_id},
            obj=wire,
        )
        domain.log(
            w, "post.created", campaign_id=cid, actor_role="industry", actor_id=author_id,
            object_type="site_post", object_id=post_id, summary=payload.title,
            payload={"site_id": payload.site_id, "kind": "mitigation", "mitigation_id": mid},
            obj=post_wire,
        )

        # LOOP 3
        response = None
        if payload.concern_id:
            response = domain.attach_mitigation_response(
                w, payload.concern_id,
                body=f"{site['name']} proposed a mitigation: {payload.title}. {payload.body or ''}{pct}".strip(),
                org_id=site["org_id"], author_id=author_id, campaign_id=cid,
            )

        # The mitigation reaches the alert it answers through `mitigation.alert_id`:
        # /alerts/{id} lists it under `mitigations`, bounded by `at` like every
        # other thing filed on the alert. It is NOT appended to the alert's
        # `recommendation` any more (phase 6): that column is served at every
        # `at`, so a mitigation filed at runtime showed inside replay, and the
        # agency-neutral line the regulator reads gained an operator's note.
        if payload.alert_id:
            al = one(w, "SELECT * FROM alert WHERE id=?", (payload.alert_id,))
            if al is not None:
                note = f"Operator mitigation: {payload.title}."
                domain.log(
                    w, "alert.mitigation_attached", campaign_id=cid, actor_role="industry",
                    actor_id=author_id, object_type="alert", object_id=payload.alert_id,
                    summary=note, payload={"mitigation_id": mid},
                    obj=shapes.alert(one(w, "SELECT * FROM alert WHERE id=?", (payload.alert_id,))),
                )

    return {**wire, "post": post_wire, "concern_response": response}


# ── verify your consultant (CONTRACT §8b) ─────────────────────────────────────

VERIFY_DEFAULT_DAYS = 30.0


@router.get("/sites/{site_id}/dispersion-models")
def site_dispersion_models(
    site_id: str, conn: sqlite3.Connection = Depends(get_db)
) -> list[dict[str, Any]]:
    """The consultant's deliverables for this site, contours included.

    `assumed_wind` is re-binned onto the canonical 16-point rose as percentages
    so it lines up with the observed rose from /model-verification.
    """
    if one(conn, "SELECT 1 FROM industry_site WHERE id=?", (site_id,)) is None:
        raise HTTPException(404, f"unknown site {site_id}")
    return loaders.load_dispersion_models(conn, site_id=site_id)


@router.get("/sites/{site_id}/envelope")
def site_envelope(
    site_id: str,
    measure: str = "no2",
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """How hard this site can run, measured — the industry tier's spine.

    Replaces `industry_site.headroom_pct`, which is a constant hardcoded in
    `world.py` (79 / 61 / 44), means nothing, and cannot be improved. What comes
    back instead is the site's own fenceline measured against class-matched
    roads at least 2 km from every site, per stability regime, with the share of
    passes over each action level and what it would cost in megawatts to hold
    the line.

    Read `air.server.envelope` for what binds and why it is not the permit
    number. The short version: against the regulatory line alone this site
    could run about five times nameplate; what actually binds is the fenceline
    on stable nights, and that opens again by morning.
    """
    site = one(conn, "SELECT * FROM industry_site WHERE id=?", (site_id,))
    if site is None:
        raise HTTPException(404, f"unknown site {site_id}")
    if measure not in envelope.DECOY_FLOOR:
        raise HTTPException(
            400,
            detail={
                "error": "measure_not_calibrated",
                "message": (
                    f"{measure!r} has no decoy-null calibration, so an excess computed for "
                    "it could not be told apart from an arbitrary patch of road."
                ),
                "supported": sorted(envelope.DECOY_FLOOR),
            },
        )
    key = ("envelope", site_id, measure, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit

    levels = [
        dict(r)
        for r in rows(
            conn,
            "SELECT id, label, measure, threshold, unit, severity, source FROM action_level "
            "WHERE measure=? AND enabled=1 ORDER BY threshold",
            (measure,),
        )
    ]
    unit = levels[0]["unit"] if levels else ""
    passes = envelope.load(conn, site["campaign_id"], measure)
    try:
        env = envelope.estimate(
            conn, passes, site_id, measure, unit, site["it_load_mw"], levels
        )
    except KeyError:
        raise HTTPException(
            404,
            detail={
                "error": "no_active_sources",
                "message": f"site {site_id} has no active emission points to measure around",
            },
        ) from None

    payload = asdict(env)
    # The gate, served alongside the answer rather than applied silently: a
    # fenceline excess that 40 arbitrary patches of road also produce is not a
    # finding about this site.
    payload["decoy_null"] = envelope.cached_null(
        conn, site["campaign_id"], measure, envelope.REGIMES["stable"]
    )
    payload["states"] = list(envelope.STATES)
    payload["headroom_is_modelled"] = (
        "The excess and the levels are measured. The megawatt figures extrapolate "
        "them on the assumption that this site's contribution scales with its load "
        "— which is what the dispersion kernel and the generator duty curve imply, "
        "and is not something the fleet observed."
    )
    return cache.put(key, payload)


@router.get("/sites/{site_id}/model-verification")
def site_model_verification(
    site_id: str,
    model_id: str | None = None,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    quality: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """What the consultant assumed vs. what our fleet actually measured.

    The verdict, the disagreement share, the understated bearings and the
    affected districts are all *computed* — from the observed rose, the model's
    own contour geometry, and the road grid's districts. Nothing is hardcoded to
    a site or an outcome, and a thin sample returns `insufficient_data` rather
    than a confident wrong answer.
    """
    site = one(conn, "SELECT * FROM industry_site WHERE id=?", (site_id,))
    if site is None:
        raise HTTPException(404, f"unknown site {site_id}")
    cid = site["campaign_id"]

    models = loaders.load_dispersion_models(conn, site_id=site_id, model_id=model_id)
    if not models:
        raise HTTPException(
            404,
            detail={
                "error": "no_dispersion_model",
                "message": (
                    f"no dispersion model on file for site {site_id}"
                    + (f" with id {model_id}" if model_id else "")
                ),
            },
        )
    model = models[0]

    now = domain.data_now(conn, cid)
    to = to or now
    from_ = from_ or (timeutil.shift(to, days=-VERIFY_DEFAULT_DAYS) or timeutil.ago(days=VERIFY_DEFAULT_DAYS))
    return verification(conn, site, model, from_, to, quality)


def verification(
    conn: sqlite3.Connection,
    site: Any,
    model: dict[str, Any],
    from_: str,
    to: str,
    quality: str | None = None,
) -> dict[str, Any]:
    """One study verdict, cached on its window. The advisor calls this with the
    same campaign window /industry/site sends (`useCampaignWindow`), so the two
    quote one set of numbers: the advisor used to compute its own over the last
    30 days and printed "assumed 4.1% ... across 11,281 observations" beside a
    page that said 9.5% across 28,324."""
    cid = site["campaign_id"]
    key = ("model_verification", site["id"], model["id"], from_, to, quality or "")
    hit = cache.get(key)
    if hit is not None:
        return hit

    obs = loaders.load_mobile_wind(conn, cid, from_=from_, to=to, quality=quality, limit=200000)
    centroid = (site["centroid_lon"], site["centroid_lat"])
    result = windfield.verify_model(
        model, obs, centroid,
        windfield.downwind_districts_fn(conn, cid, centroid),
        (from_, to),
    )
    payload = {"site_id": site["id"], "model": model, **result}
    return cache.put(key, payload)
