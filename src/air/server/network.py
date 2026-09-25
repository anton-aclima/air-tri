"""GET /regulator/network — the regulator's one screen, as one payload.

The owner's three questions, in the order the screen answers them
(docs/PLAN-refocus.md section 3.3):

  1. what the reference monitors report at the moment shown   -> `monitors`
  2. where the modelled plumes go, and what the fleet measured
     under them in the streets window                          -> `plumes`
  3. how that overlays with residents' reports                 -> `residents`

plus one generated `headline` and the three header `numbers`.

WHAT IS MODELLED AND WHAT IS MEASURED
-------------------------------------
    readings, exceedance hours, streets measured   measured
    `in_plume`, `plume_share`, `touches`, bearing  modelled — `plumegeom`, the
      and reach                                    outline the map draws (R0)
    `touchdown_state`                              measured, placebo-checked
    `named`, `named_site_id`                       F7: `naming.py`, and only
                                                   from the `inside` part

`touches` and `named` read ONLY the part of the outline inside the detection
envelope. CONTRACT 10b: nothing is judged from the dashed part. `in_plume` and
`plume_share` carry the part so a screen can show the beyond hours in the
model-only register instead of dropping them.

WHICH LEVEL A READING IS REPORTED AGAINST
-----------------------------------------
Only 1-hour levels: an hourly reading is a 1-hour average (R3). One reading
can meet two of them — NO2 has the 60 ppb 1-hour watch and the 100 ppb 1-hour
standard — so the payload says which level serves which figure:

    monitors[].level             the HIGHEST enabled 1-hour level the reading
                                 shown strictly exceeds, else the tightest
                                 (owner, 2026-09-24, D15: "Ratio seems like a
                                 better report"); `ratio` is the reading over
                                 its threshold. On the pinned build Riverport
                                 Road's 120.68 ppb at Aug 25 06:00 is 1.21× the
                                 standard, not 2.01× the watch. The headline
                                 names this same level (`_ratio_level`), so the
                                 sentence and the panel cannot name two.
    monitors[].over              the reading is over the TIGHTEST 1-hour level:
                                 "over a level", the mark and the pulse
    monitors[].exceedance_level  the tightest 1-hour level, the one
                                 `exceedance_hours_7d` counts against; null
                                 with no channel or no 1-hour level

THE CLOCK
---------
`at` goes through `domain.as_of` (no `at` is the end of the data, a moment past
it is the end, garbage is a 422), and every read below is bounded by it: the
reading is the latest at or before it, the clusters are as they stood
(`loaders.load_clusters`), and the alert count is `useLiveAlerts('regulator')`'s
rule on the server.

THE STREETS ARE ONE WINDOW, AND IT ENDS AT `at`. `streets=24h|7d|todate`
(default 7d) names it; `streets_window` serves it ({kind, hours, from, to,
last_pass_at}, passes with `from < ts <= to`); and `numbers.street_km`, every
plume's `touches.streets_driven`, `driven_share` and `below_coverage_floor`
count exactly the set `/segments?window=trailing:<hours>h|todate&at=<to>`
draws for the same pollutant (`passwindow.measured`), so the map and every
count beside it are the same streets. `last_pass_at` is the latest pass at or
before `to` that measured the pollutant: at or before `from` (or null) exactly
when the window is empty, for "no driving in the 7 days to ...". A plume's
`streets_inside` is NOT in that set: it counts the streets inside the solid
part whether or not they were driven, so a floor the geometry cannot clear
(fewer than `COVERAGE_FLOOR_STREETS` streets under it at all) reads apart from
one the driving did not.

Two things cannot be rewound and are served as the record has them:
`plume_share` is the whole record's modelled share (a climatology of the wind,
not an event), and the touchdown verdict is the campaign's pooled test, as
`/sites/{id}/touchdown` serves it and `naming.py` reads it.

THE HEADLINE
------------
One sentence of two short clauses (`HEADLINE_MAX_WORDS`), built from the
fields below and nothing else — no number is written into the copy, so it reads
correctly on another seed or at any moment (the Riverport beat is not
seed-pinned; the Boxtown one's magnitude is not either). `headline_words` in tests/test_regulator_network.py holds it against
the regulator never-say list and the metaphor words (CONTRACT 10a.7).
"""

from __future__ import annotations

import sqlite3
import threading
from collections import OrderedDict
from datetime import timedelta
from typing import Any

import numpy as np

from air import dispersion as plume
from air.server import (
    cache,
    coverage,
    domain,
    geo,
    loaders,
    naming,
    passwindow,
    plumegeom,
    shapes,
    timeutil,
)
from air.server import touchdown as td
from air.server.db import jload, rows

#: How old a reading may be and still be "the reading at the moment shown".
#: The same two hours `naming.WIND_MAX_AGE_H` allows the wind.
READING_MAX_AGE_H = 2.0

#: Hourly readings are 1-hour averages, so a level is compared with them only
#: when it is a 1-hour level (R3: "O3 ▲" beside "Ozone 8-hour CLEAR" was an
#: hourly value judged against an 8-hour rule).
READING_AVERAGING_H = 1.0

#: The resident report window, as `REPORT_WINDOW_DAYS` in
#: web/src/components/lib/reports.ts, so the panel and the map list the same
#: clusters.
REPORT_WINDOW_DAYS = 14

#: P6-E's floor: below this many streets driven inside the solid part of a
#: plume in the streets window, "not enough of this area was driven to say".
#: That copy is only right when the streets exist and were not driven. When
#: fewer than this many streets lie inside the solid part AT ALL, no amount of
#: driving clears the floor — the cause is where the plume lies, not the fleet
#: (at the end of the data with 7d every one of the 1,307 streets is driven and
#: Ridgeline's plume is still below it). So every plume row also serves
#: `streets_inside`, the streets inside the solid part whatever was driven, and
#: the UI says which: `streets_inside < COVERAGE_FLOOR_STREETS` is "too few
#: streets under the plume to say", otherwise "not enough of it was driven".
COVERAGE_FLOOR_STREETS = 8

#: `streets=` -> the `/segments` window it is, ending at `at`. 7 days is the
#: default. Measured on the pinned build, NO2, every hour Jun 8 - Aug 28
#: (1,958): a trailing week holds a median of 1,202 of 1,307 streets and is
#: empty in 115 hours (the tail of the Aug 16-23 off-week); a trailing day
#: holds a median of 257 and is empty in 692; to-date never drops below 963.
#: The calendar day the map used to draw held a median of 367 on the 61
#: days with driving, and 29 days held none.
STREETS_WINDOWS: dict[str, str] = {"24h": "trailing:24h", "7d": "trailing:168h", "todate": passwindow.TODATE}
STREETS_DEFAULT = "7d"

#: "No reference monitor within 4 km": the widest detection envelope (stable
#: air), past which nothing is judged (CONTRACT 10b; CLAUDE.md's 4,200 m rule).
#: The envelope, not a round number.
NEAR_M = max(plume.DETECTION_ENVELOPE.values())

#: How the headline names a pollutant. Anything unlisted uses its label.
SHORT = {"no2": "NO2", "pm25": "PM2.5", "o3": "ozone", "co": "CO", "bc": "black carbon",
         "ch4": "methane", "co2": "CO2"}

BASIS = (
    "Monitor readings and street passes are measured; the plume outlines are "
    "modelled from the hourly wind, and only their solid part, inside measurement "
    "range, is used to say what a plume reaches."
)


def build(
    conn: sqlite3.Connection, cid: str, *, at: str | None, measure: str, streets: str = STREETS_DEFAULT
) -> dict[str, Any]:
    from fastapi import HTTPException

    now = domain.as_of(conn, cid, at)
    mdefs = domain.measures(conn)
    if measure not in mdefs:
        raise HTTPException(422, f"unknown measure {measure!r}")
    if streets not in STREETS_WINDOWS:
        raise HTTPException(422, f"streets must be one of {tuple(STREETS_WINDOWS)}: {streets!r}")
    key = (cache.version(), td._db_path(conn), cid, now, measure, streets)
    with _LOCK:
        hit = _PAYLOADS.get(key)
        if hit is not None:
            _PAYLOADS.move_to_end(key)
            return hit
    out = _build(conn, cid, now, measure, mdefs[measure], streets)
    with _LOCK:
        _PAYLOADS[key] = out
        while len(_PAYLOADS) > _PAYLOADS_MAX:
            _PAYLOADS.popitem(last=False)
    return out


#: Payloads per (version, moment, pollutant, streets window), in their OWN
#: bounded LRU. Keyed on `cache.version()` like /admin/brief, so a write still invalidates them,
#: but not stored in `cache`: playback asks for up to four new moments a
#: second, and 192 of those in the shared store would evict every other
#: endpoint's warm entry (the segment grid's bytes among them) inside a minute.
_PAYLOADS: OrderedDict[tuple, dict[str, Any]] = OrderedDict()
_PAYLOADS_MAX = 96
_LOCK = threading.Lock()


# ── pieces ───────────────────────────────────────────────────────────────────


def _interception(conn: sqlite3.Connection, cid: str) -> coverage.Interception:
    key = ("network_interception", td._db_path(conn), cid, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, coverage.interception(conn, cid))


def _touchdown_state(conn: sqlite3.Connection, cid: str, site_id: str, measure: str) -> str:
    """The site's pooled verdict for `measure`; `no_test` when the measure has
    no calibrated detection floor, so there is nothing to pass."""
    key = ("network_touchdown", td._db_path(conn), cid, site_id, measure, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, naming.touchdown_state(conn, cid, site_id, measure) or "no_test")


def _hours_before(now: str, hours: float) -> str:
    dt = timeutil.parse(now)
    assert dt is not None  # `now` came through `as_of`
    return timeutil.iso(dt - timedelta(hours=hours))


def _live_alerts(conn: sqlite3.Connection, cid: str, now: str) -> tuple[int, list[dict[str, Any]]]:
    """`useLiveAlerts('regulator')` (web/src/core/alerts.ts) on the server:
    the regulator's alerts, begun and not ended at `now`, `info` dropped
    (rule 5: an info row is not an alert now, in any room), folded one per
    source and pollutant with the highest level winning. Returns (count, the
    ongoing rows before the filter and the fold — `_linked_monitors` reads
    those)."""
    found = loaders.load_alerts(conn, cid, role="regulator", until=now)
    ongoing = [a for a in found if a.get("ongoing")]
    rank = {"watch": 1, "warning": 2, "critical": 3}
    folded: dict[str, dict[str, Any]] = {}
    for a in ongoing:
        if a.get("severity") == "info":
            continue
        k = f"{a['source_type']}|{a.get('source_id') or a['id']}|{a.get('measure') or a['kind']}"
        prev = folded.get(k)
        if (
            prev is None
            or rank.get(a["severity"], 0) > rank.get(prev["severity"], 0)
            or (a["severity"] == prev["severity"] and a["started_at"] < prev["started_at"])
        ):
            folded[k] = a
    return len(folded), ongoing


def _levels(conn: sqlite3.Connection, cid: str, measure: str) -> list[dict[str, Any]]:
    """Enabled 1-hour levels for `measure`, tightest first."""
    return [
        shapes.action_level(r)
        for r in rows(
            conn,
            "SELECT * FROM action_level WHERE campaign_id=? AND measure=? AND enabled=1 "
            "AND averaging_hours=? ORDER BY threshold",
            (cid, measure, READING_AVERAGING_H),
        )
    ]


def _ratio_level(value: float, levels: list[dict[str, Any]]) -> dict[str, Any]:
    """The level a reading's ratio is reported against (D15): the highest of
    `levels` (tightest first, not empty) that `value` strictly exceeds, else
    the tightest. `monitors[].level` is this choice and the headline names
    `level.name`, so there is exactly one place it is made."""
    passed = [lv for lv in levels if value > float(lv["threshold"])]
    return passed[-1] if passed else levels[0]


def _latest(conn: sqlite3.Connection, mid: str, measure: str, now: str) -> tuple[str, float] | None:
    r = conn.execute(
        "SELECT ts, value FROM monitor_reading WHERE monitor_id=? AND measure=? AND qc='valid' "
        "AND ts <= ? ORDER BY ts DESC LIMIT 1",
        (mid, measure, now),
    ).fetchone()
    if r is None or r[0] < _hours_before(now, READING_MAX_AGE_H):
        return None
    return (r[0], float(r[1]))


def _reporting(conn: sqlite3.Connection, mid: str, now: str) -> bool:
    """A valid reading on any channel in the two hours up to `now`. Harbor
    Avenue is `degraded` and flags some hours `suspect`, so this moves."""
    return conn.execute(
        "SELECT 1 FROM monitor_reading WHERE monitor_id=? AND qc='valid' AND ts <= ? AND ts > ? LIMIT 1",
        (mid, now, _hours_before(now, READING_MAX_AGE_H)),
    ).fetchone() is not None


def _count_over(conn: sqlite3.Connection, mid: str, measure: str, threshold: float, lo: str, now: str) -> int:
    return int(conn.execute(
        "SELECT COUNT(*) FROM monitor_reading WHERE monitor_id=? AND measure=? AND qc='valid' "
        "AND ts > ? AND ts <= ? AND value > ?",
        (mid, measure, lo, now, threshold),
    ).fetchone()[0])


def streets_window(
    conn: sqlite3.Connection, cid: str, now: str, measure: str, streets: str
) -> tuple[passwindow.Window, dict[str, Any]]:
    """The streets window ending at `now`, and its wire form."""
    w = passwindow.resolve(conn, cid, STREETS_WINDOWS[streets], now)
    return w, {
        "kind": streets,
        "hours": w.hours,
        "from": w.lo,
        "to": w.hi,
        "last_pass_at": passwindow.last_pass_at(conn, cid, measure, w.hi),
    }


def _members(conn: sqlite3.Connection, cluster_id: str, now: str) -> list[dict[str, Any]]:
    return [
        {"kind": r[0], "suspected_site_id": r[1]}
        for r in conn.execute(
            "SELECT kind, suspected_site_id FROM concern WHERE cluster_id=? AND created_at <= ?",
            (cluster_id, now),
        )
    ]


def _cluster_site(
    conn: sqlite3.Connection, cid: str, cl: dict[str, Any], sites: dict[str, dict[str, Any]], now: str
) -> tuple[str | None, str | None]:
    """F7 for a resident cluster, exactly as `naming.alert_link` rules on a
    cluster alert: most of its air reports were carried from the site by the
    wind at the time, and the site's downwind test passed. Returns (site,
    the pollutant whose test linked it — `naming.REPORT_MEASURE` of the
    reports, e.g. a smell reads against NO2), or (None, None)."""
    members = _members(conn, cl["id"], now)
    if not members:
        return None, None
    pseudo = {
        "kind": "concern_cluster", "started_at": cl["first_at"],
        "lon": cl["centroid"][0], "lat": cl["centroid"][1],
    }
    for sid, site in sites.items():
        link = naming.alert_link(conn, cid, pseudo, site, members)
        if link["linked"]:
            return sid, link["measure"]
    return None, None


# ── the one geometry, at one moment ──────────────────────────────────────────


def plumes_now(conn: sqlite3.Connection, cid: str, now: str) -> dict[str, plumegeom.SitePlume]:
    """Every site's drawn plume at `now`: the wind row `/wind/dispersion?at=now`
    draws (`domain.current_wind`), through `plumegeom` — so the in-plume test
    below and the outline on the map are one shape."""
    wrow = domain.current_wind(conn, cid, now)
    if wrow is None:
        return {}
    return plumegeom.plumes_at(coverage.load(conn, cid).points, plumegeom.weather(wrow))


def reference_codes(
    world: coverage._World, plumes: dict[str, plumegeom.SitePlume]
) -> dict[str, np.ndarray]:
    """{site_id: part code per REFERENCE monitor, in `world.monitors` order}.
    The same `locate_polar` on the same receptor polars `coverage` counts
    with, which is what makes `in_plume` and `/coverage/interception` agree
    hour by hour (tests/test_regulator_network.py)."""
    ref_ix = [i for i, m in enumerate(world.monitors) if m["grade"] == "reference"]
    return {
        sid: sp.locate_polar(world.mon_polar[sid][0][ref_ix], world.mon_polar[sid][1][ref_ix])
        for sid, sp in plumes.items()
    }


# ── the payload ──────────────────────────────────────────────────────────────


def _build(
    conn: sqlite3.Connection, cid: str, now: str, measure: str, mdef: dict[str, Any], streets: str
) -> dict[str, Any]:
    world = coverage.load(conn, cid)
    unit = mdef.get("unit") or ""
    sites = {s["id"]: s for s in loaders.load_sites(conn, cid)}

    plumes = plumes_now(conn, cid, now)
    ref = [(i, m) for i, m in enumerate(world.monitors) if m["grade"] == "reference"]
    codes = reference_codes(world, plumes)

    alerts_now, ongoing = _live_alerts(conn, cid, now)
    levels = _levels(conn, cid, measure)
    tight = levels[0] if levels else None
    shares = {i.monitor_id: i for i in _interception(conn, cid).instruments}
    n_hours = max(1, _interception(conn, cid).n_hours)
    week_ago = _hours_before(now, 24 * 7)
    meta = {
        r[0]: (r[1], r[2])
        for r in conn.execute("SELECT id, code, radius_m FROM monitor WHERE campaign_id=?", (cid,))
    }

    monitors: list[dict[str, Any]] = []
    for k, (_i, m) in enumerate(ref):
        channels = jload(m["measures_json"], []) or []
        has = measure in channels
        latest = _latest(conn, m["id"], measure, now) if has else None
        shown = None if latest is None else round(latest[1], 2)
        reading = None if latest is None else {"value": shown, "unit": unit, "ts": latest[0]}
        level = None
        over = False
        if tight is not None and latest is not None and shown is not None:
            # The reading shown, and nothing else (up to READING_MAX_AGE_H
            # old), judged on ONE number: its raw value, the one
            # `_count_over` and the generator's alert rule compare. The level,
            # its ratio and `over` all read it, so near a threshold the mark,
            # the ratio and the headline (which reads the same `level`) cannot
            # disagree. (`reading.value` is that number rounded to 2 dp for
            # print; the ratio is the raw value over the threshold, 2 dp.) The
            # level is the highest 1-hour level exceeded (D15), else the
            # tightest, so a quiet hour's ratio is still against the watch.
            raw = latest[1]
            basis = _ratio_level(raw, levels)
            level = {
                "name": basis["label"],
                "threshold": basis["threshold"],
                "averaging_hours": basis["averaging_hours"],
                "ratio": round(raw / float(basis["threshold"]), 2) if basis["threshold"] else None,
            }
            # "Over a level" keeps its meaning whichever level the ratio is
            # against: over the TIGHTEST 1-hour level. It drives the mark,
            # the pulse and `_linked_monitors`.
            over = raw > float(tight["threshold"])
        share = shares.get(m["id"])
        by_in = share.by_site_inside if share else {}
        by_out = share.by_site_beyond if share else {}
        monitors.append({
            "id": m["id"], "name": m["name"], "code": meta.get(m["id"], (None, None))[0],
            "lon": m["lon"], "lat": m["lat"], "status": m["status"],
            "radius_m": meta.get(m["id"], (None, None))[1],
            "has_measure": has,
            "reading": reading,
            "level": level,
            "over": over,
            "in_plume": [
                {"site_id": sid, "part": plumegeom.PART_NAME[int(c[k])]}
                for sid, c in codes.items() if c[k] != plumegeom.OUTSIDE
            ],
            "plume_share": [
                {
                    "site_id": sid,
                    "inside_pct": round(100.0 * by_in.get(sid, 0) / n_hours, 1),
                    "beyond_pct": round(100.0 * by_out.get(sid, 0) / n_hours, 1),
                }
                for sid in sorted(set(by_in) | set(by_out))
            ],
            # Counted against the TIGHTEST 1-hour level, not `level`: a week's
            # hours over "a level" is one count whatever this hour's reading
            # is, and `exceedance_level` names it so no screen labels the
            # count with `level` (which moves with the reading).
            "exceedance_hours_7d": (
                _count_over(conn, m["id"], measure, float(tight["threshold"]), week_ago, now)
                if tight is not None and has else 0
            ),
            "exceedance_level": (
                {"name": tight["label"], "threshold": tight["threshold"]}
                if tight is not None and has else None
            ),
        })

    # Residents: clusters as they stood, in the report window. The map's rule
    # (`windowReports` in web/src/components/lib/reports.ts): a cluster stays
    # when any part of its life overlaps the window.
    since = _hours_before(now, 24 * REPORT_WINDOW_DAYS)
    residents: list[dict[str, Any]] = []
    for cl in loaders.load_clusters(conn, cid, now):
        if not ((cl.get("first_at") or "") <= now and (cl.get("last_at") or "") >= since):
            continue
        named_sid, link_measure = _cluster_site(conn, cid, cl, sites, now)
        residents.append({
            "cluster_id": cl["id"], "label": cl["label"], "count": cl["count"],
            "last_posted_at": cl.get("last_posted_at"),
            "named_site_id": named_sid,
            "kinds": cl["kinds"],
            "_centroid": cl["centroid"],
            "_link_measure": link_measure,
        })

    # The streets `/segments` draws for this window and pollutant — the map's
    # set, so every street figure below is a count of what is on the map.
    window, window_wire = streets_window(conn, cid, now, measure, streets)
    driven = passwindow.measured(conn, cid, measure, window)
    seg_index = {s: i for i, s in enumerate(world.seg_ids)}
    driven_ix = np.array(sorted(seg_index[s] for s in driven if s in seg_index), dtype=int)
    is_driven = np.zeros(len(world.seg_ids), dtype=bool)
    is_driven[driven_ix] = True
    street_km = float(world.seg_len[is_driven].sum()) / 1000.0

    plume_rows: list[dict[str, Any]] = []
    #: (monitor id, site id) pairs F7 links at `now` — for the headline, which
    #: may name a site beside a monitor only for the monitor that linked it.
    linked_pairs: set[tuple[str, str]] = set()
    for sid, sp in plumes.items():
        site = sites.get(sid, {"id": sid, "name": sid})
        inside_mon = [
            monitors[k]["id"] for k in range(len(ref)) if codes[sid][k] == plumegeom.INSIDE
        ]
        seg_codes = sp.locate_polar(*world.seg_polar[sid])
        seg_in = seg_codes == plumegeom.INSIDE
        n_in = int(seg_in.sum())
        n_driven = int((seg_in & is_driven).sum())
        cl_in = []
        for r in residents:
            c = sp.locate(r["_centroid"][0], r["_centroid"][1])
            if int(c[0]) == plumegeom.INSIDE:
                cl_in.append(r["cluster_id"])
        state = _touchdown_state(conn, cid, sid, measure)
        mon_linked = _linked_monitors(conn, cid, site, inside_mon, monitors, ongoing, measure)
        linked_pairs.update((mid, sid) for mid in mon_linked)
        # F7 for THIS pollutant: a cluster counts only when its link was made
        # on the measure served (a smell links on NO2, never on PM2.5), and
        # nothing is named unless the site's own test for it passed.
        cl_linked = [
            r for r in residents
            if r["cluster_id"] in cl_in and r["named_site_id"] == sid and r["_link_measure"] == measure
        ]
        plume_rows.append({
            "site_id": sid,
            "name": site.get("name"),
            "bearing_deg": round(sp.toward_deg, 1),
            "reach_m": round(sp.reach.x_reach, 1),
            "envelope_m": sp.envelope_m,
            "stability": sp.weather.cls,
            "touches": {
                "monitor_ids": inside_mon,
                "streets_driven": n_driven,
                "open_cluster_ids": cl_in,
            },
            "streets_inside": n_in,
            "driven_share": round(n_driven / n_in, 3) if n_in else 0.0,
            "below_coverage_floor": n_driven < COVERAGE_FLOOR_STREETS,
            "touchdown_state": state,
            "named": state == "elevated_downwind" and bool(mon_linked or cl_linked),
        })

    for r in residents:
        del r["_centroid"], r["_link_measure"]

    # Sites whose own downwind test passed with no reference monitor carrying
    # this pollutant inside the widest envelope. Every site with release
    # points, not only those drawn this hour: the gap is a fact about where
    # the monitors stand, not about this hour's wind.
    carrying = [m for m in monitors if m["has_measure"]]
    gaps = [
        sid for sid, origin in world.sites.items()
        if _touchdown_state(conn, cid, sid, measure) == "elevated_downwind"
        and not any(geo.haversine_m(origin[0], origin[1], m["lon"], m["lat"]) <= NEAR_M for m in carrying)
    ]

    numbers = {
        "alerts_now": alerts_now,
        "monitors_reporting": sum(1 for _i, m in ref if _reporting(conn, m["id"], now)),
        "monitors_total": len(ref),
        "street_km": round(street_km, 1),
    }
    payload = {
        "at": now,
        "measure": measure,
        "basis": BASIS,
        "numbers": numbers,
        "streets_window": window_wire,
        "monitors": monitors,
        "plumes": plume_rows,
        "residents": residents,
    }
    payload["headline"] = headline(payload, mdef, sites, levels, linked_pairs, gaps)
    # Key order for readers of the raw payload: the sentence first.
    return {"at": now, "measure": measure, "basis": BASIS, "headline": payload["headline"],
            **{k: v for k, v in payload.items() if k not in ("at", "measure", "basis", "headline")}}


def _linked_monitors(
    conn: sqlite3.Connection,
    cid: str,
    site: dict[str, Any],
    inside_mon: list[str],
    monitors: list[dict[str, Any]],
    ongoing: list[dict[str, Any]],
    measure: str,
) -> list[str]:
    """The reference monitors F7 links to this site now.

    A monitor qualifies only from inside the SOLID part of the site's outline
    at `now` (the map's geometry), and only when there is something to link:
    its alert for this pollutant is ongoing, or the reading shown is over a
    level. `naming.alert_link` then rules, at the alert's start (the
    reading's hour when there is no alert row): the wind carried from the site
    AND the site's downwind test passed. Inside the outline is necessary and
    never sufficient."""
    by_id = {m["id"]: m for m in monitors}
    out: list[str] = []
    for mid in inside_mon:
        m = by_id[mid]
        mine = [
            a for a in ongoing
            if a.get("source_type") == "monitor" and a.get("source_id") == mid and a.get("measure") == measure
        ]
        if not mine and m["over"] and m["reading"]:
            mine = [{
                "kind": "exceedance", "measure": measure, "lon": m["lon"], "lat": m["lat"],
                "started_at": m["reading"]["ts"],
            }]
        if any(naming.alert_link(conn, cid, a, site)["linked"] for a in mine):
            out.append(mid)
    return out


# ── the sentence ─────────────────────────────────────────────────────────────


def _short(measure: str, mdef: dict[str, Any]) -> str:
    return SHORT.get(measure) or mdef.get("label") or measure


def _join(names: list[str]) -> str:
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def _hours(n: int) -> str:
    return f"{n} hour" if n == 1 else f"{n} hours"


def _district(label: str | None) -> str | None:
    """'Boxtown · Paul R Lowry Road' -> 'Boxtown'."""
    if not label:
        return None
    return label.split("·")[0].strip() or None


def _level_phrase(label: str) -> str:
    """'NO2 1-hour standard' reads as it is; 'NO2 1-hour watch' gains 'level'."""
    return label if label.lower().endswith(("standard", "level")) else f"{label} level"


def headline(
    p: dict[str, Any],
    mdef: dict[str, Any],
    sites: dict[str, Any],
    levels: list[dict[str, Any]],
    linked_pairs: set[tuple[str, str]],
    gaps: list[str],
) -> str:
    """ONE sentence from the payload's own fields, two short clauses at most:
    what the reference monitors report, then the one thing the fleet or the
    residents add. Every figure comes from the payload; nothing is written in.
    `HEADLINE_MAX_WORDS` bounds it (R9: the page's words are budgeted, and at
    43-51 words the sentence alone was a third of them): the richest version
    that fits is served, dropping first the residents' tail of the gap clause,
    then the second clause.

    Branches, so it degrades on another seed or at another moment rather than
    asserting the pinned build's story:

    * a monitor is over a 1-hour level -> the one with the highest reading,
      named alone, with its `level` (the highest it is over, D15: the one its
      ratio in the panel is against), and then exactly one of: inside a
      site's modelled plume with F7 holding for THAT monitor (the site is
      named); inside a modelled plume that F7 does not tie to a site (none is
      named); no modelled plume over it
    * none is over -> said as such, of 1-hour levels (the only ones an hourly
      reading is judged against)
    * no reference monitor carries the pollutant, or none of its levels is a
      1-hour level -> said as such
    * then ONE of, in this order: how many more reference monitors are over a
      1-hour level; a site whose downwind test passed with no reference
      monitor carrying the pollutant inside the widest envelope (per channel,
      not per monitor), with its residents only when F7 names that site for
      their cluster; the monitor with the most exceedance hours in the last
      7 days, when none is over now; the residents' reports in the window,
      naming no site
    """
    measure = p["measure"]
    M = _short(measure, mdef)
    carrying = [m for m in p["monitors"] if m["has_measure"]]
    name = {sid: (s.get("name") or sid) for sid, s in sites.items()}
    recent: str | None = None
    others: str | None = None

    if not carrying:
        # Reference monitors only: Ridgeline's fenceline sensors are low-cost
        # instruments, and some of them carry channels no reference one does.
        first = f"No reference monitor here measures {M}"
        # Every site is a gap on a channel nobody carries: saying so again is noise.
        gaps = []
    elif not levels:
        first = f"No {M} action level is a 1-hour level, so no hourly reading is judged"
    else:
        # `over` is judged on the reading shown, so every monitor over has one.
        over = sorted(
            (m for m in carrying if m["over"] and m["reading"]),
            key=lambda m: -float(m["reading"]["value"]),
        )
        if over:
            lead = over[0]
            # The lead's own `level` — `_ratio_level`, the highest it is over
            # (D15) — so the sentence names the level the panel prints its
            # ratio against, and never a second one.
            lvl = _level_phrase(lead["level"]["name"])
            first = f"{lead['name']} is over the {lvl}"
            solid = [x["site_id"] for x in lead["in_plume"] if x["part"] == "inside"]
            named = [s for s in solid if (lead["id"], s) in linked_pairs]
            if named:
                first += f" inside {name.get(named[0], named[0])}'s modelled plume"
            elif solid:
                first += " inside a modelled plume no downwind test ties to a site"
            else:
                first += " with no modelled plume over it"
            k = len(over) - 1
            if k:
                others = (
                    f"{k} more reference monitor{'' if k == 1 else 's'} "
                    f"{'is' if k == 1 else 'are'} over a 1-hour {M} level"
                )
        else:
            first = f"No reference monitor is over a 1-hour {M} level"
            ranked = sorted(
                (m for m in carrying if m["exceedance_hours_7d"] > 0),
                key=lambda m: -m["exceedance_hours_7d"],
            )
            if ranked:
                r0 = ranked[0]
                recent = f"{r0['name']} was over one for {_hours(r0['exceedance_hours_7d'])} in the last 7 days"

    gap = _gap_clause(p, M, gaps, name)
    if others:
        rich = plain = others
    elif gap:
        rich, plain = gap[0] + gap[1], gap[0]
    else:
        rich = plain = recent or _residents_clause(p)

    candidates = [first + "; " + x for x in (rich, plain) if x] + [first]
    for c in candidates:
        if len((c + ".").split()) <= HEADLINE_MAX_WORDS:
            return c + "."
    return candidates[-1] + "."


#: R9's bound on the sentence, held by tests/test_regulator_network.py.
HEADLINE_MAX_WORDS = 34


def _gap_clause(p: dict[str, Any], M: str, gaps: list[str], name: dict[str, str]) -> tuple[str, str] | None:
    """(the clause, its residents' tail or ""). REFERENCE monitors only are
    counted, so the clause says so: Ridgeline's low-cost fenceline sensors
    carry NO2 a few hundred metres from its release points."""
    if not gaps:
        return None
    sid = gaps[0]
    # "the campaign": the verdict is the pooled test over the whole record (as
    # `/sites/{id}/touchdown` and naming.py serve it), so in replay it is said
    # as what it is rather than as something measured by the moment shown.
    clause = (
        f"{name.get(sid, sid)} has no reference {M} monitor within {NEAR_M / 1000:g} km, "
        "yet the campaign measures a downwind excess"
    )
    tail = ""
    linked = [r for r in p["residents"] if r["named_site_id"] == sid]
    if linked:
        where = _district(linked[0]["label"])
        tail = f" and {where + ' ' if where else ''}residents report"
    return clause, tail


def _residents_clause(p: dict[str, Any]) -> str | None:
    rs = p["residents"]
    if not rs:
        return None
    n = sum(r["count"] for r in rs)
    places: list[str] = []
    for r in rs:
        d = _district(r["label"])
        if d and d not in places:
            places.append(d)
    # Cluster counts, so "grouped": a report outside every cluster is not in
    # this number, and saying "residents filed N reports" would undercount.
    where = f" in {_join(places)}" if places else ""
    return (
        f"residents{where} filed {n} grouped report{'s' if n != 1 else ''} "
        f"in the last {REPORT_WINDOW_DAYS} days"
    )
