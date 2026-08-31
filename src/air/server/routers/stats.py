"""/stats/community and /stats/campaign.

`/stats/community` is deliberately unitless: 0-100 risk scores built from
`measure_def.scale` breakpoints, labelled in plain words, named by
`measure_def.plain_name`. No units, no acronyms — non-negotiable #3.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends

from air.server import cache, domain, timeutil
from air.server.db import get_db, one, resolve_campaign, rows, scalar

router = APIRouter(tags=["stats"])

TOP_N = 6


def _weighted(pairs: list[tuple[float | None, float]]) -> float | None:
    num = sum(v * w for v, w in pairs if v is not None)
    den = sum(w for v, w in pairs if v is not None)
    return None if den <= 0 else num / den


@router.get("/stats/community")
def community_stats(
    window: str = "all", campaign_id: str | None = None, conn: sqlite3.Connection = Depends(get_db)
) -> dict[str, Any]:
    cid = resolve_campaign(conn, campaign_id)
    key = ("stats_community", cid, window)
    hit = cache.get(key)
    if hit is not None:
        return hit

    mdefs = domain.measures(conn)
    now = domain.data_now(conn, cid)

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

    # Trend: last 7 days of 'date:' windows vs the 7 before that.
    dates = [
        r["window"]
        for r in rows(
            conn,
            """SELECT DISTINCT window FROM segment_stat
                WHERE campaign_id=? AND window LIKE 'date:%' ORDER BY window DESC LIMIT 14""",
            (cid,),
        )
    ]
    recent, prior = dates[:7], dates[7:14]

    def mean_risk(measure: str, windows: list[str]) -> float | None:
        if not windows:
            return None
        marks = ",".join("?" * len(windows))
        return scalar(
            conn,
            f"""SELECT AVG(risk) FROM segment_stat
                 WHERE campaign_id=? AND measure=? AND window IN ({marks}) AND risk IS NOT NULL""",
            (cid, measure, *windows),
        )

    by_measure: list[dict[str, Any]] = []
    for r in agg:
        code = r["measure"]
        md = mdefs.get(code, {})
        if md.get("family") == "indicator" and code not in ("methane_leak",):
            continue
        risk = (r["risk_num"] / r["risk_den"]) if r["risk_den"] else None
        if risk is None:
            risk = domain.risk_from_scale(md.get("scale"), r["median"])
        persistence = (r["pers_num"] / r["pers_den"]) if r["pers_den"] else None
        a, b = mean_risk(code, recent), mean_risk(code, prior)
        trend = round(100.0 * (a - b) / b, 1) if (a is not None and b) else 0.0
        by_measure.append(
            {
                "measure": code,
                "plain_name": md.get("plain_name") or md.get("label") or code,
                "risk": round(risk) if risk is not None else 0,
                "label": domain.risk_label(risk),
                "trend_pct": trend,
                "persistence": round(persistence, 3) if persistence is not None else 0.0,
            }
        )
    by_measure.sort(key=lambda m: m["risk"], reverse=True)

    overall = max((m["risk"] for m in by_measure), default=0)
    overall_trend = round(
        sum(m["trend_pct"] for m in by_measure) / len(by_measure), 1
    ) if by_measure else 0.0

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

    payload = {
        "window": window,
        "overall_risk": overall,
        "overall_label": domain.risk_label(overall),
        "trend_pct": overall_trend,
        "by_measure": by_measure,
        "worst_streets": ranked[:TOP_N],
        "best_streets": list(reversed(ranked[-TOP_N:])) if len(ranked) > TOP_N else [],
        "concern_count_7d": scalar(
            conn,
            "SELECT COUNT(*) FROM concern WHERE campaign_id=? AND created_at >= ?",
            (cid, timeutil.shift(now, days=-7) or timeutil.ago(days=7)),
            0,
        ),
        "advisory_count_active": scalar(
            conn,
            """SELECT COUNT(*) FROM advisory WHERE campaign_id=?
                AND (expires_at IS NULL OR expires_at >= ?)""",
            (cid, now), 0,
        ),
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
    }
    return cache.put(key, payload)


@router.get("/stats/campaign")
def campaign_stats(
    campaign_id: str | None = None, conn: sqlite3.Connection = Depends(get_db)
) -> dict[str, Any]:
    cid = resolve_campaign(conn, campaign_id)
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
        "concerns_total": scalar(conn, "SELECT COUNT(*) FROM concern WHERE campaign_id=?", (cid,), 0),
        "concerns_open": scalar(
            conn,
            "SELECT COUNT(*) FROM concern WHERE campaign_id=? AND status NOT IN ('resolved','closed')",
            (cid,), 0,
        ),
        "alerts_active": scalar(
            conn, "SELECT COUNT(*) FROM alert WHERE campaign_id=? AND status='active'", (cid,), 0
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
