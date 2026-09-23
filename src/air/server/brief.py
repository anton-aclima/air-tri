"""The Mission Brief — what a fleet lead reads at 07:00.

One request, one screen. Everything here is READ-ONLY over the datagen-built
drive plan: the routes are the ones that produced this campaign's data, tagged
by which question each leg answers under this morning's forecast. The solver
is not touched (PLAN-plume decision 16), so what this screen offers is a
proposal with a debrief, never a dispatch.

WHICH PLAN
----------
The plan is found through `drive.plan_id`, not `drive_plan.status = 'active'`.
Sheet 03's regenerate lever writes a new active plan from a serpentine
stand-in (`routers/admin.py`) whose routes produced no data at all; a brief
that followed the status flag would silently switch to them the first time
anyone pulled the lever.

WHAT IS MODELLED AND WHAT IS MEASURED
-------------------------------------
    the call, the swath, the strata,     modelled — the derived forecast
    the outlook, the ledger              (`forecast.py`) through the shared
                                         kernel, drawn as outlines
    the debrief, the sample size         measured — `segment_pass` against the
                                         wind that actually blew, with no
                                         kernel evaluated at any receptor

THE DEBRIEF, AND WHY `advected` IS THE POINT
--------------------------------------------
Yesterday's passes are split three ways by the wind that actually blew:
downwind of the site, upwind of it (the mirror wedge, same distances), and
crosswind background. The verdict compares them:

    local         downwind exceeds upwind by more than the detection floor,
                  its interval clears zero, and a rotated bearing does not
                  reproduce it
    advected      the air was already elevated upwind and the site is not
                  detectably adding to it. Only obtainable because the fleet
                  drove upwind — and it is the finding that protects an
                  operator from a false accusation
    no_detection  both sides driven, nothing separable from the noise
    contested     a local-looking difference that a rotated bearing also
                  produces. CONTRACT 10c: no interval or sample size is served
    unpaired      one side was not driven, or both were but never in the same
                  hour. "We cannot distinguish local from advected because the
                  control was not sampled."

The plan asked for four verdicts; `contested` is the fifth because CONTRACT
10c requires a placebo on any "worse downwind of this site" claim, and a single
day often has too few passes to run one.

Intervals count HOURS, not passes. Passes within one hour share their weather,
so a 60-pass hour is closer to one observation than to sixty; treating them as
independent made an eight-pass upwind leg look decisive. The interval is
`1.96 * sd / sqrt(hours)` — deliberately conservative.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import sqlite3
from collections import Counter, defaultdict
from typing import Any

import numpy as np

from air.server import cache, forecast, geo, plumeframe, touchdown

#: The detection floor the debrief measures against — the touchdown
#: estimator's, so "above the floor" means one thing across the product.
DETECT_FLOOR = touchdown.DETECT_FLOOR["no2"]
MEASURE = "no2"

#: A side of the comparison counts as driven at this many passes.
MIN_SIDE_PASSES = 5

#: The measured wedges. Mirror images at the same distances, so downwind and
#: upwind are compared like for like.
MEASURED_LO_M = 500.0
MEASURED_HI_M = 4000.0
MEASURED_MIN_HALF_DEG = plumeframe.UPWIND_MIN_HALF_DEG
BACKGROUND_MIN_M = touchdown.CONTROL_INNER_M

#: Rotations for the debrief's placebo. 180 is excluded: it swaps downwind and
#: upwind and returns exactly minus the true difference, which tests nothing.
PLACEBO_DEG = (90.0, 270.0)
PLACEBO_MAX_RATIO = touchdown.PLACEBO_MAX_RATIO

#: The brief is read at 07:00 and the forecast is issued then.
ISSUE_HOUR = 7

#: Days 0-1 carry assignments; days 2-5 are a watch list. At 48 h the blend
#: has already lost half its weight on persistence and by 60 h climatology
#: beats it outright — a targeted plan past that is a schedule for a guess.
ASSIGNED_DAYS = 2
OUTLOOK_DAYS = 6
MAX_LEAD_H = 120

#: A route leg shorter than this is noise in the stratum test, not a leg.
MIN_LEG_KM = 0.3

#: The critique's publish-blocking floor on control share. The brief cannot
#: block anything — it is read-only — so it reports the check instead.
MIN_CONTROL_SHARE = 0.20

#: When no drive row gives a start time.
SHIFT_START_H = {"morning": 7.5, "midday": 11.0, "evening": 15.5, "night": 21.0}
SHIFT_HOURS = 5.0

BANDS = (("night_early", 0, 5), ("morning", 5, 11), ("midday", 11, 15),
         ("evening", 15, 21), ("night", 21, 24))
BAND_PHRASE = {"morning": "This morning", "midday": "At midday",
               "evening": "This evening", "night": "Tonight", "night_early": "Before dawn"}

SECTORS = 16

BASIS = (
    "Forecast: derived — a measured blend of persistence and this campaign's own "
    "wind climatology, drawn through the shared dispersion kernel as outlines. "
    "Debrief: measured passes against the wind that blew. Routes: the datagen-"
    "built plan, read-only; strata are computed here from geometry and the "
    "forecast, never stored."
)


class BadDate(ValueError):
    """The caller's `date` or `at` does not start with YYYY-MM-DD."""


# ── helpers ──────────────────────────────────────────────────────────────────


def _band(hour: int) -> str:
    for name, lo, hi in BANDS:
        if lo <= hour < hi:
            return "night" if name == "night_early" else name
    return "night"


def _circ_mean(deg: list[float], weights: list[float] | None = None) -> float | None:
    if not deg:
        return None
    r = np.radians(np.asarray(deg, float))
    w = np.ones_like(r) if weights is None else np.asarray(weights, float)
    if w.sum() <= 0:
        w = np.ones_like(r)
    m = math.degrees(math.atan2(float((w * np.sin(r)).sum()), float((w * np.cos(r)).sum())))
    m %= 360.0
    return 0.0 if m >= 360.0 - 1e-9 else round(m, 1)


def _short(name: str | None) -> str:
    """'Ridgeline Compute' -> 'Ridgeline'; 'Delta Forge Metals' -> 'Delta Forge'."""
    if not name:
        return "the site"
    parts = name.split()
    return " ".join(parts[:-1]) if len(parts) > 1 else name


def _stability_phrase(cls: str) -> str:
    if cls in "EF":
        return "stable air"
    if cls == "D":
        return "neutral air"
    return "well-mixed air"


def _hours_between(a: str, b: str) -> float:
    return (dt.datetime.fromisoformat(b[:19]) - dt.datetime.fromisoformat(a[:19])).total_seconds() / 3600.0


def _stat(values: np.ndarray, hours: np.ndarray) -> dict[str, Any]:
    """Mean anomaly with an hour-counted interval. See the module docstring."""
    n = int(values.size)
    k = int(np.unique(hours).size) if n else 0
    if n == 0:
        return {"n": 0, "hours": 0, "mean": None, "ci_lo": None, "ci_hi": None, "se": None}
    mean = float(values.mean())
    sd = float(values.std(ddof=1)) if n > 1 else float("nan")
    se = sd / math.sqrt(k) if (k and math.isfinite(sd)) else float("nan")
    ok = math.isfinite(se)
    return {
        "n": n, "hours": k, "mean": round(mean, 2),
        "ci_lo": round(mean - 1.96 * se, 2) if ok else None,
        "ci_hi": round(mean + 1.96 * se, 2) if ok else None,
        "se": se if ok else None,
    }


def _diff(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any] | None:
    if a["mean"] is None or b["mean"] is None or a["se"] is None or b["se"] is None:
        return None
    m = a["mean"] - b["mean"]
    se = math.hypot(a["se"], b["se"])
    return {"mean": round(m, 2), "ci_lo": round(m - 1.96 * se, 2), "ci_hi": round(m + 1.96 * se, 2)}


def _public(s: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in s.items() if k != "se"}


# ── the world, loaded once per database ─────────────────────────────────────


class _World:
    def __init__(self, conn: sqlite3.Connection, cid: str):
        self.passes = touchdown.load(conn, cid, MEASURE)
        p = self.passes
        segs = conn.execute(
            "SELECT id, name, district, length_m, geometry_json FROM road_segment "
            "WHERE campaign_id=? ORDER BY id", (cid,),
        ).fetchall()
        # Same ORDER BY as touchdown._Passes, so indices line up with it.
        assert [r[0] for r in segs] == p.seg_ids
        self.seg_name = [r[1] for r in segs]
        self.seg_district = [r[2] for r in segs]
        self.seg_km = np.array([(r[3] or 0.0) / 1000.0 for r in segs])
        self.seg_path = [
            [[round(float(c[0]), 5), round(float(c[1]), 5)] for c in json.loads(r[4] or "[]")]
            for r in segs
        ]
        self.seg_index = {sid: i for i, sid in enumerate(p.seg_ids)}
        self.network_km = float(self.seg_km.sum())

        self.sites: dict[str, dict[str, Any]] = {}
        for sid, name, org in conn.execute(
            "SELECT s.id, s.name, o.name FROM industry_site s LEFT JOIN org o ON o.id = s.org_id "
            "WHERE s.campaign_id=? ORDER BY s.id", (cid,),
        ):
            if sid not in p.sites:
                continue
            self.sites[sid] = {
                "site_id": sid, "name": name, "short": _short(org or name),
                "origin": p.sites[sid], "sources": forecast._site_sources(conn, sid),
            }

        self.vehicles = {
            r[0]: {"vehicle_id": r[0], "label": r[1], "call_sign": r[2], "operator": r[3]}
            for r in conn.execute(
                "SELECT id, label, call_sign, operator_name FROM vehicle WHERE campaign_id=?", (cid,),
            )
        }
        row = conn.execute(
            "SELECT plan_id FROM drive WHERE campaign_id=? AND plan_id IS NOT NULL "
            "GROUP BY plan_id ORDER BY COUNT(*) DESC LIMIT 1", (cid,),
        ).fetchone()
        self.plan_id = row[0] if row else None
        first, last = conn.execute(
            "SELECT MIN(ts), MAX(ts) FROM segment_pass WHERE campaign_id=?", (cid,),
        ).fetchone()
        self.first_date = (first or "")[:10]
        self.last_date = (last or "")[:10]
        self.pass_date = np.array([t[:10] for t in p.pass_ts])
        # Per-pass half-angle from the kernel's sigma_y at the pass's own
        # distance, the touchdown estimator's definition.
        self.half = {s: np.maximum(touchdown._sector_half_deg(p, p.dist[s][p.pass_seg]),
                                   MEASURED_MIN_HALF_DEG) for s in self.sites}


def _world(conn: sqlite3.Connection, cid: str) -> _World:
    key = ("brief_world", touchdown._db_path(conn), cid, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, _World(conn, cid))


# ── measured strata ──────────────────────────────────────────────────────────


def _measured_masks(w: _World, site: str, rotate_deg: float = 0.0):
    """Per-pass (downwind, upwind, background) under the wind that blew."""
    p = w.passes
    d = p.dist[site][p.pass_seg]
    b = p.brg[site][p.pass_seg]
    axis = (p.hour_transport[p.pass_hour] + rotate_deg) % 360.0
    off = np.abs((b - axis + 180.0) % 360.0 - 180.0)
    half = w.half[site]
    ok = np.isfinite(p.anomaly) & (p.near_other[site][p.pass_seg] >= touchdown.COLOCATED_M)
    ring = (d >= MEASURED_LO_M) & (d <= MEASURED_HI_M)
    down = ok & ring & (off <= half)
    up = ok & ring & (off >= 180.0 - half)
    bg = ok & (d >= BACKGROUND_MIN_M) & (off > 2 * half) & (off < 180.0 - 2 * half)
    return down, up, bg


def debrief(w: _World, site: str, date: str) -> dict[str, Any]:
    p = w.passes
    day = w.pass_date == date
    down, up, bg = (m & day for m in _measured_masks(w, site))
    s_down = _stat(p.anomaly[down], p.pass_hour[down])
    s_up = _stat(p.anomaly[up], p.pass_hour[up])
    s_bg = _stat(p.anomaly[bg], p.pass_hour[bg])
    paired_hours = len(set(p.pass_hour[down].tolist()) & set(p.pass_hour[up].tolist()))

    missing = [name for name, s in (("downwind", s_down), ("upwind", s_up))
               if s["n"] < MIN_SIDE_PASSES]
    d_up = _diff(s_down, s_up)
    d_bg = _diff(s_down, s_bg)
    u_bg = _diff(s_up, s_bg)

    placebo: float | None = None
    ratio: float | None = None
    # Both sides driven but never in the same hour is still unpaired: across
    # hours the comparison carries the day's traffic and mixing cycle, which
    # is larger than any plume here. The first cut called that `local`.
    concurrent = paired_hours > 0
    if missing or not concurrent:
        verdict = "unpaired"
    elif d_up and d_up["mean"] >= DETECT_FLOOR and d_up["ci_lo"] > 0:
        rot: list[float] = []
        for deg in PLACEBO_DEG:
            rd, ru, _rb = (m & day for m in _measured_masks(w, site, deg))
            if rd.sum() >= MIN_SIDE_PASSES and ru.sum() >= MIN_SIDE_PASSES:
                rot.append(float(p.anomaly[rd].mean() - p.anomaly[ru].mean()))
        if len(rot) == len(PLACEBO_DEG):
            placebo = max(rot, key=abs)
            ratio = abs(placebo) / abs(d_up["mean"])
        verdict = "local" if (ratio is not None and ratio < PLACEBO_MAX_RATIO) else "contested"
    elif (d_bg and u_bg and d_up and d_bg["ci_lo"] > 0 and u_bg["ci_lo"] > 0
          and d_up["ci_hi"] < DETECT_FLOOR):
        verdict = "advected"
    else:
        verdict = "no_detection"

    served = verdict != "contested"
    return {
        "site_id": site,
        "date": date,
        "verdict": verdict,
        "missing": missing,
        "concurrent": concurrent,
        # CONTRACT 10a.4: nothing that failed the placebo carries an interval
        # or a sample size.
        "bars": {
            "downwind": _public(s_down), "upwind": _public(s_up), "background": _public(s_bg),
        } if served else None,
        "downwind_minus_upwind": d_up if served else None,
        "downwind_minus_background": d_bg if served else None,
        "upwind_minus_background": u_bg if served else None,
        "paired_hours": paired_hours if served else None,
        "placebo_ratio": round(ratio, 2) if (ratio is not None and served) else None,
        "detect_floor": DETECT_FLOOR,
        "measure": MEASURE,
    }


def _touchdown_layer(w: _World, site: str, date: str) -> list[dict[str, Any]]:
    """Yesterday's downwind passes by segment — measured, drawn faint."""
    p = w.passes
    down, _up, _bg = _measured_masks(w, site)
    m = down & (w.pass_date == date)
    out = []
    for i in np.unique(p.pass_seg[m]):
        k = m & (p.pass_seg == i)
        out.append({"segment_id": p.seg_ids[i], "path": w.seg_path[i],
                    "n": int(k.sum()), "anomaly": round(float(p.anomaly[k].mean()), 2)})
    return out


def sample_size(w: _World, site: str) -> dict[str, Any]:
    """P9-D — the data scientist's warning, as a number.

    How often the uniform plan happened to put a car on BOTH sides of the site
    in the same hour, and how much of the compass those hours saw. This is the
    standing argument for targeted driving, and the quantity a planner should
    eventually optimise.
    """
    p = w.passes
    down, up, _bg = _measured_masks(w, site)
    driven = np.unique(p.pass_hour)
    hd = set(p.pass_hour[down].tolist())
    hu = set(p.pass_hour[up].tolist())
    paired = sorted(hd & hu)
    sectors = {int(((p.hour_transport[h] + 11.25) % 360.0) // 22.5) for h in paired}

    stable = np.isin(p.hour_class[p.pass_hour], list("EF"))
    near = down & stable & (p.dist[site][p.pass_seg] <= 2000.0)
    near_segs = np.unique(p.pass_seg[near])
    roads = {w.seg_name[i] for i in near_segs if w.seg_name[i]}
    return {
        "driven_hours": int(driven.size),
        "downwind_hours": len(hd),
        "upwind_hours": len(hu),
        "paired_hours": len(paired),
        "paired_rate": round(len(paired) / driven.size, 4) if driven.size else 0.0,
        "sectors_covered": len(sectors),
        "sectors_total": SECTORS,
        "stable_near": {
            "radius_m": 2000, "passes": int(near.sum()),
            "segments": int(near_segs.size), "roads": len(roads),
        },
    }


# ── forecast frames ──────────────────────────────────────────────────────────


def _issue_at(conn: sqlite3.Connection, cid: str, date: str) -> str | None:
    """The record hour the brief is issued at: 07:00 on `date`, or the latest
    hour before it. Never an hour after the brief would have been read."""
    r = forecast.load(conn, cid)
    want = f"{date}T{ISSUE_HOUR:02d}"
    if want in r.index:
        return r.ts[r.index[want]]
    earlier = [t for t in r.ts if t[:13] <= want]
    return earlier[-1] if earlier else (r.ts[0] if r.ts else None)


class _Frames:
    """Frames for every site at every lead, plus per-lead strata."""

    def __init__(self, conn: sqlite3.Connection, cid: str, w: _World, issued: str):
        self.fc = forecast.issue(conn, cid, issued, leads=tuple(range(0, MAX_LEAD_H + 1)))
        self.by_site: dict[str, list[plumeframe.Frame]] = {}
        self.strata: dict[str, list[np.ndarray]] = {}
        for sid, s in w.sites.items():
            frames = [plumeframe.frame(sid, s["origin"], s["sources"], h) for h in self.fc.hours]
            self.by_site[sid] = frames
            self.strata[sid] = [
                plumeframe.strata(f, w.passes.dist[sid], w.passes.brg[sid]) for f in frames
            ]

    def at_lead(self, lead: float) -> int:
        return int(max(0, min(MAX_LEAD_H, round(lead))))


def _downwind_km(w: _World, st: np.ndarray) -> float:
    return float(w.seg_km[st == 0].sum())


def _top_district(w: _World, sts: list[np.ndarray]) -> str | None:
    acc: Counter[str] = Counter()
    for st in sts:
        for i in np.flatnonzero(st == 0):
            if w.seg_district[i]:
                acc[w.seg_district[i]] += float(w.seg_km[i])
    return acc.most_common(1)[0][0] if acc else None


# ── routes ───────────────────────────────────────────────────────────────────


def _routes(conn: sqlite3.Connection, w: _World, dates: list[str]) -> list[dict[str, Any]]:
    if not w.plan_id:
        return []
    marks = ",".join("?" for _ in dates)
    out = []
    for r in conn.execute(
        f"""SELECT r.id, r.vehicle_id, r.date, r.shift, r.segment_ids_json,
                   d.started_at, d.ended_at, d.status, d.sampling_mode
              FROM drive_route r LEFT JOIN drive d ON d.route_id = r.id
             WHERE r.plan_id = ? AND r.date IN ({marks})
             ORDER BY r.date, COALESCE(d.started_at, r.shift), r.vehicle_id""",  # noqa: S608 - placeholders only
        (w.plan_id, *dates),
    ):
        seq = [w.seg_index[s] for s in json.loads(r[4] or "[]") if s in w.seg_index]
        if not seq:
            continue
        start = r[5] or f"{r[2]}T{int(SHIFT_START_H.get(r[3], 9.0)):02d}:" \
                        f"{int(round((SHIFT_START_H.get(r[3], 9.0) % 1) * 60)):02d}:00"
        out.append({"route_id": r[0], "vehicle_id": r[1], "date": r[2], "shift": r[3],
                    "start": start[:19], "end": (r[6] or "")[:19] or None,
                    "status": r[7] or "planned", "sampling_mode": r[8] or "uniform", "seq": seq})
    return out


def _tag_route(w: _World, frames: _Frames, site: str, issued: str, route: dict[str, Any]):
    """Stratum per segment of the sequence, at the hour the car is forecast to
    reach it (cumulative distance through a five-hour shift)."""
    seq = np.array(route["seq"])
    km = w.seg_km[seq]
    cum = np.cumsum(km) - km / 2
    frac = cum / max(float(km.sum()), 1e-6)
    t0 = _hours_between(issued, route["start"])
    leads = np.clip(np.round(t0 + frac * SHIFT_HOURS), 0, MAX_LEAD_H).astype(int)
    st = np.empty(seq.size, dtype=np.int8)
    for lead in np.unique(leads):
        m = leads == lead
        st[m] = frames.strata[site][int(lead)][seq[m]]
    return st, leads, km


def _legs(w: _World, seq: np.ndarray, st: np.ndarray, km: np.ndarray, stratum: int):
    """Road names on one stratum, longest first."""
    acc: dict[str, float] = defaultdict(float)
    for i, k in zip(seq[st == stratum], km[st == stratum], strict=True):
        acc[w.seg_name[i] or "unnamed road"] += float(k)
    return [{"road": n, "km": round(k, 2)} for n, k in sorted(acc.items(), key=lambda x: -x[1])]


def _nearest_upwind(w: _World, frames: _Frames, site: str, lead: int) -> dict[str, Any] | None:
    st = frames.strata[site][lead]
    idx = np.flatnonzero(st == 1)
    if not idx.size:
        return None
    d = w.passes.dist[site][idx]
    i = int(idx[np.argmin(d)])
    return {"road": w.seg_name[i] or "unnamed road", "distance_km": round(float(d.min()) / 1000, 1),
            "compass": geo.compass(float(w.passes.brg[site][i])), "district": w.seg_district[i]}


def _control_line(site_short: str, down_km: float, up_km: float, up_roads, nearest) -> str:
    """The imperative. The control leg is the first thing a driver drops when
    running late and the only leg that makes the day's downwind data readable."""
    if down_km < MIN_LEG_KM:
        return "No plume crossing forecast on this shift. Drive the route as planned."
    if up_km >= MIN_LEG_KM:
        road = up_roads[0]["road"] if up_roads else "the upwind leg"
        return (f"Drive the upwind leg on {road} ({up_km:.1f} km) in full. If you run late, "
                f"cut anything else — without it the downwind passes cannot tell {site_short} "
                "apart from air arriving from elsewhere.")
    if nearest:
        return (f"This route crosses the plume but never goes upwind of {site_short}. "
                f"Add {nearest['road']}, {nearest['distance_km']:.1f} km {nearest['compass']} of the site. "
                "Without it today's downwind passes cannot be read.")
    return (f"This route crosses the plume and no road lies upwind of {site_short} inside "
            "4 km. The downwind passes will be unpaired.")


# ── the brief ────────────────────────────────────────────────────────────────


def _resolve_date(w: _World, at: str | None, date: str | None) -> str:
    """The brief's day, clamped into the record. A live clock past the end of
    the data reads the last day there is, not an empty one."""
    d = (date or at or w.last_date or "")[:10]
    try:
        dt.date.fromisoformat(d)
    except ValueError:
        raise BadDate(f"not a date: {d!r}") from None
    if w.last_date:
        d = max(min(d, w.last_date), w.first_date)
    return d


def build(conn: sqlite3.Connection, cid: str, *, at: str | None = None,
          date: str | None = None, site: str | None = None) -> dict[str, Any]:
    w = _world(conn, cid)
    day0 = _resolve_date(w, at, date)
    key = ("brief", touchdown._db_path(conn), cid, day0, site or "", cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit

    issued = _issue_at(conn, cid, day0)
    if issued is None or not w.sites:
        return {"campaign_id": cid, "date": day0, "issued_at": None, "call": None, "basis": BASIS}
    frames = _Frames(conn, cid, w, issued)
    base = dt.date.fromisoformat(day0)
    dates = [(base + dt.timedelta(days=k)).isoformat() for k in range(OUTLOOK_DAYS)]
    yesterday = (base - dt.timedelta(days=1)).isoformat()

    # Today's hours: from issue to midnight tomorrow, the span a day-0 route
    # can occupy (the night shift runs past midnight).
    today_leads = [f.lead_h for f in frames.by_site[next(iter(w.sites))]
                   if f.valid_at[:10] == day0 or (f.valid_at[:10] == dates[1] and int(f.valid_at[11:13]) < 5)]

    # The target is the site whose forecast plume crosses the most road over
    # today's hours. `site=` overrides it.
    score = {sid: sum(_downwind_km(w, frames.strata[sid][lead]) for lead in today_leads)
             for sid in w.sites}
    target = site if site in w.sites else max(score, key=score.get)
    tsite = w.sites[target]

    # ── the call ──
    by_band: dict[str, list[int]] = defaultdict(list)
    for lead in today_leads:
        f = frames.by_site[target][lead]
        by_band[_band(int(f.valid_at[11:13]))].append(lead)
    band_km = {b: sum(_downwind_km(w, frames.strata[target][lead]) for lead in ls)
               for b, ls in by_band.items()}
    best = max(band_km, key=band_km.get) if band_km else None
    call: dict[str, Any] | None = None
    if best and band_km[best] > 0:
        leads = [lead for lead in by_band[best] if not frames.by_site[target][lead].faint]
        fs = [frames.by_site[target][lead] for lead in leads]
        axis = _circ_mean([f.axis_deg for f in fs],
                          [_downwind_km(w, frames.strata[target][lead]) for lead in leads])
        cls = Counter(f.stability for f in fs).most_common(1)[0][0]
        district = _top_district(w, [frames.strata[target][lead] for lead in leads])
        mid = fs[len(fs) // 2]
        sentence = (f"{BAND_PHRASE[best]}, {_stability_phrase(cls)} is forecast to carry "
                    f"{tsite['short']}'s plume toward {axis:.0f}° {geo.compass(axis)} — "
                    f"{district or 'open ground'}.")
        call = {
            "sentence": sentence, "band": best, "site_id": target, "site": tsite["short"],
            "axis_deg": axis, "compass": geo.compass(axis), "district": district,
            "stability": cls, "hours": len(fs),
            "from": fs[0].valid_at, "to": fs[-1].valid_at,
            "confidence": {
                "lead_h": mid.lead_h, "dir_sd_deg": mid.dir_sd_deg,
                "spread_deg": round(2 * mid.dir_sd_deg, 1),
                "tier": ("persistence" if mid.lead_h <= 12 else
                         "blend" if mid.lead_h <= forecast.CROSSOVER_H else "climatology"),
            },
        }
    else:
        call = {
            "sentence": (f"No forecast hour today puts {tsite['short']}'s plume on the ground "
                         "inside the network. A uniform day."),
            "band": None, "site_id": target, "site": tsite["short"], "axis_deg": None,
            "compass": None, "district": None, "stability": None, "hours": 0,
            "from": None, "to": None, "confidence": None,
        }

    # ── the swath: today's hours, target site, outlines only ──
    swath = []
    for lead in today_leads:
        f = frames.by_site[target][lead]
        if f.faint:
            continue
        shape = plumeframe.frame_shape(f)
        shape["band"] = _band(int(f.valid_at[11:13]))
        swath.append(shape)

    # ── routes and assignments, days 0-1 ──
    routes = _routes(conn, w, dates[:ASSIGNED_DAYS])
    route_out, assignments = [], []
    totals = {"vehicle_hours": 0.0, "km": 0.0, "down_km": 0.0, "up_km": 0.0,
              "segments": set(), "routes": 0}
    for r in routes:
        st, leads, km = _tag_route(w, frames, target, issued, r)
        seq = np.array(r["seq"])
        down_km = float(km[st == 0].sum())
        up_km = float(km[st == 1].sum())
        up_roads = _legs(w, seq, st, km, 1)
        mid_lead = int(np.median(leads))
        nearest = _nearest_upwind(w, frames, target, mid_lead) if (down_km >= MIN_LEG_KM and up_km < MIN_LEG_KM) else None
        v = w.vehicles.get(r["vehicle_id"] or "", {})
        paths: dict[str, list[list[list[float]]]] = {s: [] for s in plumeframe.STRATA}
        seen: set[tuple[int, int]] = set()
        for i, s in zip(seq.tolist(), st.tolist(), strict=True):
            if (i, s) in seen:
                continue
            seen.add((i, s))
            paths[plumeframe.STRATA[s]].append(w.seg_path[i])
        day_index = dates.index(r["date"])
        route_out.append({"route_id": r["route_id"], "vehicle_id": r["vehicle_id"],
                          "day": day_index, "shift": r["shift"], "paths": paths})
        assignments.append({
            "route_id": r["route_id"], "day": day_index, "date": r["date"],
            "vehicle": v.get("label"), "call_sign": v.get("call_sign"), "operator": v.get("operator"),
            "shift": r["shift"], "start": r["start"], "status": r["status"],
            "km": round(float(km.sum()), 1), "downwind_km": round(down_km, 1),
            "upwind_km": round(up_km, 1),
            "background_km": round(float(km[st == 2].sum()), 1),
            "downwind_roads": _legs(w, seq, st, km, 0)[:3], "upwind_roads": up_roads[:3],
            "control_line": _control_line(tsite["short"], down_km, up_km, up_roads, nearest),
            "control_ok": down_km < MIN_LEG_KM or up_km >= MIN_LEG_KM,
        })
        if day_index == 0:
            totals["vehicle_hours"] += SHIFT_HOURS
            totals["km"] += float(km.sum())
            totals["down_km"] += down_km
            totals["up_km"] += up_km
            totals["segments"].update(seq.tolist())
            totals["routes"] += 1

    # ── the ledger: cost, coverage and capture, never one without the others ──
    seg_km_driven = float(w.seg_km[list(totals["segments"])].sum()) if totals["segments"] else 0.0
    targeted = totals["down_km"] + totals["up_km"]
    control_share = (totals["up_km"] / targeted) if targeted > 0 else None
    corridor_km = sum(_downwind_km(w, frames.strata[target][lead]) for lead in today_leads)
    ledger = {
        "vehicles": totals["routes"],
        "vehicle_hours": round(totals["vehicle_hours"], 1),
        "km_driven": round(totals["km"], 1),
        "network_km": round(w.network_km, 1),
        "network_pct": round(100 * seg_km_driven / w.network_km, 1) if w.network_km else 0.0,
        "downwind_km": round(totals["down_km"], 1),
        "upwind_km": round(totals["up_km"], 1),
        "corridor_road_km_hours": round(corridor_km, 1),
        "control_share": round(control_share, 3) if control_share is not None else None,
        "min_control_share": MIN_CONTROL_SHARE,
        "control_check": (None if control_share is None else
                          "pass" if control_share >= MIN_CONTROL_SHARE else "fail"),
    }

    # ── the outlook, days 0-5 ──
    outlook = []
    for k, d in enumerate(dates):
        fs = [f for f in frames.by_site[target] if f.valid_at[:10] == d]
        live = [f for f in fs if not f.faint]
        km_h = [_downwind_km(w, frames.strata[target][f.lead_h]) for f in live]
        axis = _circ_mean([f.axis_deg for f in live], km_h) if live else None
        leads = [f.lead_h for f in fs]
        mid = fs[len(fs) // 2] if fs else None
        outlook.append({
            "day": k, "date": d,
            "status": "assigned" if k < ASSIGNED_DAYS else "watch",
            "hours": len(fs), "lead_from_h": min(leads) if leads else None,
            "lead_to_h": max(leads) if leads else None,
            "axis_deg": axis, "compass": geo.compass(axis) if axis is not None else None,
            "dir_sd_deg": mid.dir_sd_deg if mid else None,
            "persistence_weight": forecast.blend_weight(mid.lead_h) if mid else None,
            "beyond_crossover": bool(mid and mid.lead_h > forecast.CROSSOVER_H),
            "stable_hours": sum(1 for f in fs if f.stability in "EF"),
            "corridor_road_km_hours": round(sum(km_h), 1),
            "district": _top_district(w, [frames.strata[target][f.lead_h] for f in live]),
            "ticks": [{"lead_h": f.lead_h, "axis_deg": None if f.faint else round(f.axis_deg, 0)}
                      for f in fs],
        })

    payload = {
        "campaign_id": cid,
        "date": day0,
        "issued_at": issued,
        "plan_id": w.plan_id,
        "read_only": True,
        "site_id": target,
        "site": {"site_id": target, "name": tsite["name"], "short": tsite["short"],
                 "lon": tsite["origin"][0], "lat": tsite["origin"][1]},
        "sites_ranked": sorted(
            ({"site_id": s, "short": w.sites[s]["short"], "corridor_road_km_hours": round(v, 1)}
             for s, v in score.items()), key=lambda x: -x["corridor_road_km_hours"]),
        "call": call,
        "swath": swath,
        "routes": route_out,
        "assignments": assignments,
        "debrief": {"date": yesterday,
                    "sites": [debrief(w, s, yesterday) for s in
                              [target] + [s for s in w.sites if s != target]],
                    "touchdown": _touchdown_layer(w, target, yesterday)},
        "outlook": outlook,
        "ledger": ledger,
        "sample_size": sample_size(w, target),
        "crossover_h": forecast.CROSSOVER_H,
        "basis": BASIS,
    }
    return cache.put(key, payload)

