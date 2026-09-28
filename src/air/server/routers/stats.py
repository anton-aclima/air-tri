"""/stats/community and /stats/campaign.

`/stats/community` is deliberately unitless: 0-100 risk scores built from
`measure_def.scale` breakpoints, labelled in plain words, named by
`measure_def.plain_name`. No units, no acronyms — non-negotiable #3.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends

from air.server import cache, domain, loaders, timeutil
from air.server.db import get_db, one, resolve_campaign, rows, scalar

router = APIRouter(tags=["stats"])

TOP_N = 6


def _weighted(pairs: list[tuple[float | None, float]]) -> float | None:
    num = sum(v * w for v, w in pairs if v is not None)
    den = sum(w for v, w in pairs if v is not None)
    return None if den <= 0 else num / den


def _daily_risk(conn: sqlite3.Connection, cid: str) -> dict[str, Any]:
    """Every `date:` window's risk as (sum, count) per measure, plus the windows
    newest-first. The 7-day trend is an AVG over seven of these; pooling the
    integer sums gives exactly the AVG SQLite returned, and it means the trend
    can follow the clock without 22 AVG queries (~140 ms cold) per moment."""
    key = ("stats_daily_risk", cid)
    hit = cache.get(key)
    if hit is not None:
        return hit
    sums: dict[str, dict[str, tuple[int, int]]] = {}
    windows: set[str] = set()
    for r in rows(
        conn,
        """SELECT measure, window, SUM(risk) AS s, COUNT(risk) AS n FROM segment_stat
            WHERE campaign_id=? AND window LIKE 'date:%' GROUP BY measure, window""",
        (cid,),
    ):
        windows.add(r["window"])
        if r["n"]:
            sums.setdefault(r["measure"], {})[r["window"]] = (r["s"], r["n"])
    return cache.put(key, {"windows": sorted(windows, reverse=True), "sums": sums})


def _mean_risk(daily: dict[str, Any], measure: str, windows: list[str]) -> float | None:
    per = daily["sums"].get(measure, {})
    got = [per[w] for w in windows if w in per]
    n = sum(c for _, c in got)
    return sum(v for v, _ in got) / n if n else None


def _community_streets(conn: sqlite3.Connection, cid: str, window: str) -> dict[str, Any]:
    """The street picture for `window`: risk and persistence per measure, the
    composite, the worst and best streets, km and passes. None of it follows
    the clock — street colours stay whole-campaign (docs/PLAN-refocus.md D2) —
    so it is cached once per window, not once per moment."""
    key = ("stats_community_streets", cid, window)
    hit = cache.get(key)
    if hit is not None:
        return hit

    mdefs = domain.measures(conn)

    # Length-weighted mean risk + persistence per measure for the requested window.
    agg = rows(
        conn,
        """SELECT s.measure,
                  SUM(COALESCE(s.risk,0) * r.length_m) AS risk_num,
                  SUM(CASE WHEN s.risk IS NULL THEN 0 ELSE r.length_m END) AS risk_den,
                  SUM(COALESCE(s.persistence,0) * r.length_m) AS pers_num,
                  SUM(CASE WHEN s.persistence IS NULL THEN 0 ELSE r.length_m END) AS pers_den,
                  AVG(s.median) AS median
             FROM segment_stat s JOIN road_segment r ON r.id = s.segment_id
            WHERE s.campaign_id=? AND s.window=?
            GROUP BY s.measure""",
        (cid, window),
    )

    by_measure: list[dict[str, Any]] = []
    composite: dict[str, Any] | None = None
    for r in agg:
        code = r["measure"]
        md = mdefs.get(code, {})
        if md.get("family") == "indicator" and code not in ("methane_leak",):
            continue
        # The composite is the headline, not a peer. Left in `by_measure` it wins
        # the max below *by construction* -- it is built from three of the rows it
        # would be competing against -- and then becomes `worst_measure`, which
        # silently reroutes worst_streets, best_streets and the passes fallback
        # onto a derived index that names no pollutant.
        if md.get("family") == "composite":
            risk = (r["risk_num"] / r["risk_den"]) if r["risk_den"] else None
            composite = {"measure": code, "risk": round(risk) if risk is not None else 0}
            continue
        risk = (r["risk_num"] / r["risk_den"]) if r["risk_den"] else None
        if risk is None:
            risk = domain.risk_from_scale(md.get("scale"), r["median"])
        persistence = (r["pers_num"] / r["pers_den"]) if r["pers_den"] else None
        by_measure.append(
            {
                "measure": code,
                "plain_name": md.get("plain_name") or md.get("label") or code,
                "risk": round(risk) if risk is not None else 0,
                "label": domain.risk_label(risk),
                "persistence": round(persistence, 3) if persistence is not None else 0.0,
            }
        )
    by_measure.sort(key=lambda m: m["risk"], reverse=True)

    worst_measure = by_measure[0]["measure"] if by_measure else "no2"
    streets = rows(
        conn,
        """SELECT s.segment_id, r.name, s.risk, r.district FROM segment_stat s
             JOIN road_segment r ON r.id = s.segment_id
            WHERE s.campaign_id=? AND s.measure=? AND s.window=? AND s.risk IS NOT NULL
              AND r.name IS NOT NULL
            ORDER BY s.risk DESC""",
        (cid, worst_measure, window),
    )
    seen: set[str] = set()
    ranked: list[dict[str, Any]] = []
    for r in streets:
        if r["name"] in seen:
            continue
        seen.add(r["name"])
        ranked.append(
            {"segment_id": r["segment_id"], "name": r["name"], "risk": r["risk"], "district": r["district"]}
        )

    return cache.put(key, {
        "by_measure": by_measure,
        "composite": composite,
        "worst_streets": ranked[:TOP_N],
        "best_streets": list(reversed(ranked[-TOP_N:])) if len(ranked) > TOP_N else [],
        "monitored_km": round(
            (scalar(conn, "SELECT SUM(length_m) FROM road_segment WHERE campaign_id=?", (cid,), 0) or 0) / 1000.0, 1
        ),
        "passes_total": scalar(
            conn, "SELECT COUNT(*) FROM segment_pass WHERE campaign_id=?", (cid,), 0
        ) or scalar(
            conn,
            """SELECT SUM(n_passes) FROM segment_stat
                WHERE campaign_id=? AND window='all' AND measure=?""",
            (cid, worst_measure), 0,
        ),
    })


@router.get("/stats/community")
def community_stats(
    window: str = "all",
    at: str | None = None,
    campaign_id: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """`at` is the stat's now (replay rewinds events, D2). What follows it is
    what a resident reads as the present: reports this week, advisories in
    force, and the trend (the 7 newest days by then vs the 7 before). The day
    that contains `at` counts whole, as the last day does at the end of the
    data, whose drives already run past the build instant. The street picture
    is the whole `window` either way (`_community_streets`)."""
    cid = resolve_campaign(conn, campaign_id)
    now = domain.as_of(conn, cid, at)
    base = _community_streets(conn, cid, window)
    daily = _daily_risk(conn, cid)

    # Trend: last 7 days of 'date:' windows by `now` vs the 7 before that.
    dates = [w for w in daily["windows"] if w <= f"date:{now[:10]}"][:14]
    recent, prior = dates[:7], dates[7:14]

    def trend(measure: str) -> float:
        a, b = _mean_risk(daily, measure, recent), _mean_risk(daily, measure, prior)
        return round(100.0 * (a - b) / b, 1) if (a is not None and b) else 0.0

    by_measure = [
        {
            "measure": m["measure"],
            "plain_name": m["plain_name"],
            "risk": m["risk"],
            "label": m["label"],
            "trend_pct": trend(m["measure"]),
            "persistence": m["persistence"],
        }
        for m in base["by_measure"]
    ]

    # The headline is the composite when there is one. The old behaviour -- a max
    # over every measure's risk -- was an undefended max over ladders that are not
    # calibrated against each other (CO returns 92 at its NAAQS where PM2.5
    # returns 25 at its annual one), so it reported whichever measure happened to
    # have the steepest curve. Falling back to it is still better than reporting
    # nothing, but only as a fallback.
    composite = base["composite"]
    if composite is not None:
        overall = composite["risk"]
        overall_trend = trend(composite["measure"])
    else:
        overall = max((m["risk"] for m in by_measure), default=0)
        overall_trend = round(
            sum(m["trend_pct"] for m in by_measure) / len(by_measure), 1
        ) if by_measure else 0.0

    return {
        "window": window,
        "overall_risk": overall,
        "overall_label": domain.risk_label(overall),
        "trend_pct": overall_trend,
        "by_measure": by_measure,
        "worst_streets": base["worst_streets"],
        "best_streets": base["best_streets"],
        # "Reports this week": filed in the 7 days up to `now`, not after it.
        "concern_count_7d": scalar(
            conn,
            "SELECT COUNT(*) FROM concern WHERE campaign_id=? AND created_at >= ? AND created_at <= ?",
            (cid, timeutil.shift(now, days=-7) or timeutil.ago(days=7), now),
            0,
        ),
        # In force: issued by `now` and expiring AFTER it. `>=` counted a notice
        # expiring at `now` — which is how sim.py expires them ("all clear"
        # sets expires_at to now) — so with a frozen now it never left the
        # count. Same test as `inForce` in web/src/apps/community/lib.ts.
        "advisory_count_active": scalar(
            conn,
            """SELECT COUNT(*) FROM advisory WHERE campaign_id=? AND created_at <= ?
                AND (expires_at IS NULL OR expires_at > ?)""",
            (cid, now, now), 0,
        ),
        "monitored_km": base["monitored_km"],
        "passes_total": base["passes_total"],
        # Passes driven by `now`. `passes_total` is the whole record, which the
        # street colours are built from (D2) — the right number beside them,
        # the wrong one for "so far" at a replayed moment: at Aug 12 it
        # already counted the 16 days of driving still to come. Outside the
        # cached street block because it follows the clock; a covering-index
        # range count on ix_pass_time, 1.6 ms over all 56,673 passes.
        "passes_to_date": scalar(
            conn, "SELECT COUNT(*) FROM segment_pass WHERE campaign_id=? AND ts<=?", (cid, now), 0
        ),
    }


@router.get("/stats/campaign")
def campaign_stats(
    campaign_id: str | None = None,
    at: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
) -> dict[str, Any]:
    """The admin KPIs. Everything about the fleet and the network is the whole
    campaign, whatever the clock says. The three workflow counts follow `at`
    (phase 6, PLAN-refocus): `concerns_total` is the reports filed by then,
    `concerns_open` those not 'resolved'/'closed' AS THEY STOOD then, and
    `alerts_active` the alerts that had entered the record and read 'active'
    then (statusat.py, through the same loaders every other at-bounded read
    uses). Unbounded, a replayed status bar counted every report closed after
    the moment as closed, and every report filed after it. No `at` is the end
    of the data, where they are the stored counts."""
    cid = resolve_campaign(conn, campaign_id)
    moment = domain.as_of(conn, cid, at)
    return {**_campaign_block(conn, cid), **_workflow_counts(conn, cid, moment)}


def _workflow_counts(conn: sqlite3.Connection, cid: str, moment: str) -> dict[str, int]:
    """`/stats/campaign`'s counts that follow the clock (its docstring)."""
    concerns = loaders.load_concerns(conn, cid, until=moment, limit=5000, with_responses=False)
    alerts = loaders.load_alerts(conn, cid, until=moment, limit=3000)
    return {
        "concerns_total": len(concerns),
        "concerns_open": sum(1 for c in concerns if c["status"] not in ("resolved", "closed")),
        "alerts_active": sum(1 for a in alerts if a["status"] == "active"),
    }


def _campaign_block(conn: sqlite3.Connection, cid: str) -> dict[str, Any]:
    """`/stats/campaign`'s whole-campaign figures, cached per campaign."""
    key = ("stats_campaign", cid)
    hit = cache.get(key)
    if hit is not None:
        return hit

    camp = one(conn, "SELECT * FROM campaign WHERE id=?", (cid,))
    target = camp["target_passes"] if camp else 25
    now = domain.data_now(conn, cid)

    passes = {
        r["segment_id"]: r["n"]
        for r in rows(
            conn,
            "SELECT segment_id, COUNT(*) AS n FROM segment_pass WHERE campaign_id=? GROUP BY segment_id",
            (cid,),
        )
    }
    if not passes:
        passes = {
            r["segment_id"]: r["n"]
            for r in rows(
                conn,
                """SELECT segment_id, MAX(n_passes) AS n FROM segment_stat
                    WHERE campaign_id=? AND window='all' GROUP BY segment_id""",
                (cid,),
            )
        }
    segments = scalar(conn, "SELECT COUNT(*) FROM road_segment WHERE campaign_id=?", (cid,), 0)
    counts = list(passes.values())

    by_day = [
        {
            "date": r["d"],
            "passes": r["passes"],
            "km": round((r["km"] or 0) / 1000.0, 1),
            "concerns": 0,
        }
        for r in rows(
            conn,
            """SELECT substr(p.ts,1,10) AS d, COUNT(*) AS passes, SUM(r.length_m) AS km
                 FROM segment_pass p JOIN road_segment r ON r.id = p.segment_id
                WHERE p.campaign_id=? GROUP BY substr(p.ts,1,10) ORDER BY d""",
            (cid,),
        )
    ]
    day_index = {d["date"]: d for d in by_day}
    for r in rows(
        conn,
        "SELECT substr(created_at,1,10) AS d, COUNT(*) AS n FROM concern WHERE campaign_id=? GROUP BY d",
        (cid,),
    ):
        if r["d"] in day_index:
            day_index[r["d"]]["concerns"] = r["n"]
        else:
            by_day.append({"date": r["d"], "passes": 0, "km": 0.0, "concerns": r["n"]})
    by_day.sort(key=lambda d: d["date"])

    latest_ts = scalar(
        conn,
        "SELECT MAX(r.ts) FROM monitor_reading r JOIN monitor m ON m.id=r.monitor_id WHERE m.campaign_id=?",
        (cid,),
    ) or now
    freshness = 0.0
    a, b = timeutil.parse(latest_ts), timeutil.parse(timeutil.now_iso())
    if a and b:
        freshness = round(max(0.0, (b - a).total_seconds() / 60.0), 1)

    payload = {
        "segments": segments,
        "segments_at_target": sum(1 for c in counts if c >= target),
        "mean_passes": round(sum(counts) / len(counts), 1) if counts else 0.0,
        "passes_total": sum(counts),
        "km_driven": round(
            (scalar(conn, "SELECT SUM(distance_m) FROM drive WHERE campaign_id=?", (cid,), 0) or 0) / 1000.0, 1
        ),
        "vehicles_active": scalar(
            conn, "SELECT COUNT(*) FROM vehicle WHERE campaign_id=? AND status IN ('driving','idle')", (cid,), 0
        ),
        "sites": scalar(conn, "SELECT COUNT(*) FROM industry_site WHERE campaign_id=?", (cid,), 0),
        "monitors_online": scalar(
            conn, "SELECT COUNT(*) FROM monitor WHERE campaign_id=? AND status='online'", (cid,), 0
        ),
        "monitors_total": scalar(conn, "SELECT COUNT(*) FROM monitor WHERE campaign_id=?", (cid,), 0),
        "data_freshness_min": freshness,
        "by_day": by_day,
    }
    return cache.put(key, payload)
