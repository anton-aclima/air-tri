"""Step 8 -- build orchestration.

    source dev/env.sh
    uv run air-datagen build            # or: python -m air.datagen.build
    uv run air-datagen build --fresh --seed 7

Idempotent: every physical table is wiped and rewritten, so re-running is safe.
`--fresh` additionally drops the narrative tables (concerns, alerts, advisories,
posts, mitigations, activity), which is what you want when the campaign geometry
changes underneath them.

Timestamps
----------
Everything is stored as naive local **campaign** time (`America/Chicago`), format
`YYYY-MM-DDTHH:MM:SS`.  That is deliberate: `segment_stat` windows `date:YYYY-MM-DD`
and `hour:HH` are only meaningful in local time, and a diurnal chart in UTC would be
wrong by five hours.  `setting('datagen.now')` records the instant the database was
built, which is the "now" the fleet layer and the partially-driven final day are
anchored to.


================================================================================
THE NARRATIVE SEAM  --  `air.datagen.narrative.seed(conn, ctx)`
================================================================================

After the physical layer is seeded, `build.py` calls::

    import air.datagen.narrative as narrative      # guarded by try/except ImportError
    narrative.seed(conn, ctx)

If the module does not exist the build completes normally and says so.  The
narrative layer must not raise on a second run: `build.py` has already deleted the
narrative tables listed below before calling it.

Ownership split
---------------
The physical layer writes, and the narrative layer must NOT write:
    org, app_user, measure_def, action_level, campaign, road_segment,
    segment_pass, segment_stat, monitor, monitor_reading, industry_site,
    emission_point, vehicle, drive_plan, drive_route, drive, vehicle_ping,
    wind, mobile_wind_obs, dispersion_model, dispersion_model_contour, setting

The narrative layer owns, and the physical layer never touches:
    concern, concern_response, concern_corroboration, concern_cluster,
    site_post, mitigation, advisory, enforcement_action,
    alert, alert_sample, alert_ack, notification, activity

`conn` is an open `sqlite3.Connection` with `row_factory = sqlite3.Row`.  Do not
commit or close it; `build.py` commits once afterwards.

**Foreign keys are ENFORCED on this connection.**  (An earlier version of this
docstring said they were off.  They are not, and the narrative tables reference
each other heavily, so insert order is load-bearing: concerns before
corroborations and responses, alerts before samples and acks, clusters before
anything that points at them.)

ctx contract
------------
`ctx` is a plain `dict`.  Keys marked REQUIRED are guaranteed present and non-empty;
keys marked EXTRA are provided as a convenience and may be relied on, but say so in
your report if you do.

REQUIRED
~~~~~~~~
``campaign``   : dict -- the full `campaign` row as written, keys exactly matching
                 the schema columns.  `boundary_geojson` is a JSON **string**.
                 Useful members: ``id``, ``center_lon``, ``center_lat``,
                 ``start_date``, ``end_date``, ``fleet_size``, ``target_passes``,
                 ``timezone``.

``segments``   : list[dict], ~1300 items, ordered by ``id``.  Each::

                     {"id": "seg-12345678-0-1",   # stable across rebuilds
                      "name": "Boxtown Road" | None,
                      "road_class": "residential",
                      "district": "Boxtown",       # real OSM neighbourhood name
                      "mid_lon": -90.1234, "mid_lat": 35.0456,
                      "length_m": 198.4,
                      "bearing_deg": 12.5}

``sites``      : list[dict], 3 items, Ridgeline first.  Each::

                     {"id": "site-ridgeline",
                      "name": "Ridgeline South Campus",
                      "kind": "datacenter",
                      "org_id": "org-ridgeline",
                      "status": "operating",
                      "centroid": (lon, lat),
                      "footprint_geojson": "<json string, Feature/Polygon>",
                      "capacity_mw": 352.0,
                      "emission_points": [
                          {"id": "ep-rl-gt01", "name": "Turbine bank A (4 x 14.6 MW)",
                           "kind": "generator",      # generator|cooling_tower|backup|
                                                     # stack|traffic_gate|substation
                           "lon": .., "lat": .., "height_m": 21.0,
                           "duty": "continuous",     # continuous|daytime|night|
                                                     # intermittent|rare
                           "active": 1}, ...]}

``monitors``   : list[dict] -- the full `monitor` rows as written (schema columns).
                 `measures_json` is a JSON string.  4 reference (DRAQA), 7 Ridgeline
                 fenceline (lowcost), 2 community (lowcost).

``vehicles``   : list[dict] -- the full `vehicle` rows as written, including the
                 final ``status`` (``driving`` / ``idle`` / ``charging`` /
                 ``maintenance``) at ``now``.

``wind``       : list[dict] -- one per campaign hour, chronological, 2160 items.
                 Each::

                     {"ts": "2026-05-30T00:00:00",  # naive local campaign time
                      "hour_index": 0,              # hours since `start`
                      "speed_ms": 3.2, "dir_deg": 208.4,   # dir wind comes FROM
                      "gust_ms": 5.1, "temp_c": 24.6, "rh": 71.0,
                      "pbl_m": 240.0, "stability": "F",    # Pasquill A-F
                      "transport_deg": 28.4}        # direction the plume travels TO

``measures``   : list[dict] -- the full `measure_def` rows as written.  `scale_json`
                 and `ramp_json` are JSON strings.  Order = display order.

``rng_seed``   : int -- the build seed.  Derive your own generators from it
                 (e.g. ``np.random.default_rng(ctx["rng_seed"] + 12345)``) so the
                 narrative layer is reproducible too.

``now``        : datetime (naive, local campaign time) -- "now" for the whole
                 database.  Anything you create must not be after this.

``start``      : datetime -- 00:00 on the campaign's first day.
``end``        : datetime -- 00:00 on the day AFTER the campaign's last day, i.e.
                 an exclusive upper bound.  ``now`` lies inside the final day.

EXTRA
~~~~~
``users``            : list[dict] -- `app_user` rows.  Use these as authors; do not
                       invent new ones without adding the row yourself.
``orgs``             : list[dict] -- `org` rows.
``action_levels``    : list[dict] -- `action_level` rows already seeded (NAAQS-based
                       plus DRAQA local screening levels).  Evaluate alerts against
                       these rather than creating your own.
``districts``        : list[str] -- distinct `road_segment.district` values, ordered
                       by segment count descending.
``leaks``            : list[dict] -- the methane leak sources actually present in the
                       field: ``{"id", "lon", "lat", "sigma_m", "ppm_peak", "duty",
                       "label"}``.  ``leak-boxtown-main`` is the "leapfrog" story.
``drives``           : list[dict] -- `drive` rows as written (id, vehicle_id, date,
                       started_at, ended_at, status, distance_m).
``drive_plan``       : dict -- the `drive_plan` row, with ``stats_json`` parsed into
                       ``stats``.
``dispersion_models``: list[dict] -- `dispersion_model` rows, ``assumed_wind_json``
                       is a JSON string.
``observed_rose``    : list[dict] -- 16-sector rose computed from the good-quality
                       `mobile_wind_obs`: ``{"dir_deg", "label", "freq",
                       "mean_speed_ms", "n"}``.
``field``            : `air.datagen.field.FieldModel` -- the live field object.
``sample_field``     : callable ``(ts_or_hour_index, lon, lat) -> dict[measure, float]``
                       Sample the real concentration field at a point and time.  Use
                       this so an alert's `value`, an `alert_sample` sparkline or a
                       mobile detection agrees with what the map shows.  Accepts a
                       `datetime` or an int hour index; `lon`/`lat` may be scalars or
                       sequences (returns floats or numpy arrays respectively).
``segment_stat``     : callable ``(segment_id, measure, window="all") -> dict|None``
                       Read back an already-written `segment_stat` row.

Example
~~~~~~~
    def seed(conn, ctx):
        rng = np.random.default_rng(ctx["rng_seed"] + 555)
        boxtown = [s for s in ctx["segments"] if s["district"] == "Boxtown"]
        s = boxtown[int(rng.integers(len(boxtown)))]
        t = ctx["now"] - timedelta(hours=3)
        v = ctx["sample_field"](t, s["mid_lon"], s["mid_lat"])
        conn.execute("INSERT INTO alert (...) VALUES (...)", (..., v["no2"], ...))
================================================================================
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from . import db as dbm
from . import driveplan as dp
from . import measures as meas
from . import mobilewind as mw
from . import network as netmod
from . import simulate as sim
from . import stats as statmod
from . import weather as wx
from . import world as worldmod
from .field import FieldModel


# ---------------------------------------------------------------- helpers


def _log(msg: str, t0: float) -> None:
    print(f"  [{time.time() - t0:6.1f}s] {msg}", flush=True)


def _segment_ctx(segments):
    return [
        {
            "id": s.id,
            "name": s.name,
            "road_class": s.road_class,
            "district": s.district,
            "mid_lon": s.mid_lon,
            "mid_lat": s.mid_lat,
            "length_m": round(s.length_m, 1),
            "bearing_deg": round(s.bearing_deg, 1),
        }
        for s in segments
    ]


def _site_ctx(world):
    out = []
    for s in world.sites:
        out.append(
            {
                "id": s.id,
                "name": s.row["name"],
                "kind": s.row["kind"],
                "org_id": s.row["org_id"],
                "status": s.row["status"],
                "centroid": s.centroid,
                "footprint_geojson": s.row["footprint_geojson"],
                "capacity_mw": s.row["capacity_mw"],
                "emission_points": [
                    {
                        "id": p.id,
                        "name": p.name,
                        "kind": p.kind,
                        "lon": p.lon,
                        "lat": p.lat,
                        "height_m": p.height_m,
                        "duty": p.duty,
                        "active": p.active,
                    }
                    for p in s.points
                ],
            }
        )
    return out


# ---------------------------------------------------------------- the build


def build_world(conn: sqlite3.Connection, seed: int = 20260827, *, now: datetime | None = None,
                fresh: bool = False, fleet_size: int | None = None,
                target_passes: int | None = None,
                shift_hours: float = dp.SHIFT_HOURS,
                quiet: bool = False) -> dict:
    """Seed the entire physical world into `conn`.  Returns a summary dict.

    Reusable by the backend (`POST /admin/reseed`).  Commits nothing -- the caller
    owns the transaction.
    """
    t0 = time.time()
    log = (lambda m: None) if quiet else (lambda m: _log(m, t0))

    dbm.apply_schema(conn)
    if fresh:
        dbm.wipe(conn, dbm.NARRATIVE_TABLES)
    dbm.wipe(conn, dbm.PHYSICAL_TABLES)
    log("schema applied, physical tables cleared")

    world = worldmod.build_world(seed=seed, now=now)
    if fleet_size:
        world.campaign["fleet_size"] = fleet_size
    if target_passes:
        world.campaign["target_passes"] = target_passes
    cid = world.campaign["id"]
    log(f"world: boundary {len(world.boundary_ring)} pts, {len(world.sites)} sites, "
        f"{len(world.monitors)} monitors")

    segments, graph = netmod.build_network(world)
    net_stats = netmod.stats(segments)
    log(f"network: {net_stats['n_segments']} segments, {net_stats['total_km']} km, "
        f"mean {net_stats['mean_len_m']} m")

    n_days = (world.end.date() - world.start.date()).days
    wind = wx.build_wind(world.start, n_days, seed)
    log(f"wind: {len(wind)} hours, rose {wx.wind_rose(wind)}")

    field = FieldModel(world, segments, wind)

    drive_days, plan_stats, clusters = dp.build_drive_plan(
        world, segments, graph,
        fleet_size=world.campaign["fleet_size"],
        target_passes=world.campaign["target_passes"],
        shift_hours=shift_hours,
        seed=seed,
    )
    log(f"drive plan: {plan_stats['n_drives']} drives over {plan_stats['drive_days']} days, "
        f"{plan_stats['coverage_pct']}% at target, {plan_stats['km_per_vehicle_day_mean']} km/veh/day")

    # ---- reference tables
    dbm.insert_many(conn, "measure_def", meas.measure_rows())
    dbm.insert_many(conn, "org", world.orgs)
    dbm.insert_many(conn, "app_user", world.users)
    dbm.insert_many(conn, "campaign", [world.campaign])
    dbm.insert_many(conn, "action_level", meas.action_level_rows(cid, world.now.isoformat(timespec="seconds")))
    dbm.insert_many(conn, "industry_site", [s.row for s in world.sites])
    dbm.insert_many(conn, "emission_point", [p.row() for p in world.emission_points])
    dbm.insert_many(conn, "monitor", world.monitors)
    dbm.insert_many(conn, "road_segment", [s.row(cid) for s in segments])
    dbm.insert_tuples(conn, "wind",
                      ("campaign_id", "ts", "speed_ms", "dir_deg", "gust_ms",
                       "temp_c", "rh", "pbl_m", "stability"),
                      [tuple(w.row(cid).values()) for w in wind])
    log("reference tables written")

    # ---- fleet
    vstatus = sim.vehicle_status(world, drive_days)
    for v in world.vehicles:
        v["status"] = vstatus[v["id"]]
    dbm.insert_many(conn, "vehicle", world.vehicles)

    plan_id = f"plan-{cid}-01"
    plan_stats_json = json.dumps(plan_stats, default=str)
    dbm.insert_many(conn, "drive_plan", [{
        "id": plan_id,
        "campaign_id": cid,
        "name": f"Southwest Memphis coverage plan (seed {seed})",
        "fleet_size": world.campaign["fleet_size"],
        "target_passes": world.campaign["target_passes"],
        "status": "active",
        "params_json": json.dumps({
            "seed": seed,
            "shift_hours": shift_hours,
            "stop_factor": dp.STOP_FACTOR,
            "phase1_vehicles": dp.PHASE1_VEHICLES,
            "phase1_double_every": dp.PHASE1_DOUBLE_EVERY,
            "phase2_vehicles": dp.PHASE2_VEHICLES,
            "phase2_every": dp.PHASE2_EVERY,
            "sprint_days": dp.SPRINT_DAYS,
            "sprint_vehicles": dp.SPRINT_VEHICLES,
            "today_vehicles": dp.TODAY_VEHICLES,
            "coverage_goal": dp.COVERAGE_GOAL,
            "off_week_modulo": dp.OFF_WEEK_MODULO,
            "algorithm": "route-inspection (Rural Postman): length-balanced k-means "
                         "partition, component join + greedy odd-node matching, "
                         "Hierholzer circuit, shift-truncated with per-cluster cursor",
        }),
        "stats_json": plan_stats_json,
        "created_at": (world.start - timedelta(days=14)).isoformat(timespec="seconds"),
    }])
    dbm.insert_many(conn, "drive_route", sim.route_rows(world, drive_days, plan_id, cid, segments))
    drives, pings = sim.drive_rows(world, drive_days, plan_id, cid)
    dbm.insert_many(conn, "drive", drives)
    dbm.insert_tuples(conn, "vehicle_ping",
                      ("drive_id", "ts", "lon", "lat", "speed_kph", "heading_deg", "segment_id"),
                      [(d, t, lo, la, sp, hd, segments[si].id if si is not None else None)
                       for (d, t, lo, la, sp, hd, si) in pings])
    log(f"fleet: {len(drives)} drives, {len(pings)} pings")

    # ---- passes
    pcols, prows = sim.segment_passes(world, segments, field, drive_days, cid)
    dbm.insert_tuples(conn, "segment_pass", pcols, prows)
    log(f"passes: {len(prows)} rows")

    # ---- stats
    scols, srows = statmod.build_segment_stats(segments, pcols, prows, cid)
    dbm.insert_tuples(conn, "segment_stat", scols, srows)
    log(f"segment_stat: {len(srows)} rows")

    # ---- monitors
    mcols, mrows = sim.monitor_readings(world, field, cid)
    dbm.insert_tuples(conn, "monitor_reading", mcols, mrows)
    log(f"monitor_reading: {len(mrows)} rows")

    # ---- observed street-level wind + the consultant's study
    ocols, orows = mw.observations(world, segments, graph, wind, drive_days, cid)
    dbm.insert_tuples(conn, "mobile_wind_obs", ocols, orows)
    obs_rose = mw.observed_rose(orows, ocols)
    true_rose = mw.rose_from_dirs([w.dir_deg for w in wind], [w.speed_ms for w in wind])
    models, contours = mw.dispersion_models(world, field, true_rose, cid)
    dbm.insert_many(conn, "dispersion_model", models)
    dbm.insert_many(conn, "dispersion_model_contour", contours)
    assumed = json.loads(models[0]["assumed_wind_json"])
    verify = mw.verification_numbers(world, assumed, obs_rose, wind, orows, ocols)
    log(f"mobile_wind_obs: {len(orows)} rows; {len(models)} studies, {len(contours)} contours; "
        f"north half assumed {verify['north_half_assumed']:.3f} vs observed "
        f"{verify['north_half_observed']:.3f} (x{verify['north_ratio_observed_over_assumed']})")

    # ---- settings
    dbm.insert_many(conn, "setting", [
        {"key": "datagen.seed", "value": str(seed)},
        {"key": "datagen.now", "value": world.now.isoformat(timespec="seconds")},
        {"key": "datagen.built_at", "value": datetime.now().isoformat(timespec="seconds")},
        {"key": "datagen.timezone", "value": world.campaign["timezone"]},
        {"key": "datagen.active_campaign", "value": cid},
        {"key": "fleet.community_delay_min", "value": "180"},
        {"key": "datagen.network_stats", "value": json.dumps(net_stats)},
        {"key": "datagen.model_verification", "value": json.dumps(verify)},
    ])

    summary = {
        "seed": seed,
        "now": world.now.isoformat(timespec="seconds"),
        "campaign": f'{world.campaign["start_date"]} .. {world.campaign["end_date"]}',
        "network": net_stats,
        "plan": plan_stats,
        "wind_rose": wx.wind_rose(wind),
        "measures": statmod.campaign_summary(pcols, prows),
        "district_median_no2": statmod.district_rollup(segments, pcols, prows),
        "verification": verify,
        "counts": {
            "segment_pass": len(prows),
            "segment_stat": len(srows),
            "monitor_reading": len(mrows),
            "vehicle_ping": len(pings),
            "mobile_wind_obs": len(orows),
            "dispersion_model": len(models),
            "dispersion_model_contour": len(contours),
        },
    }

    ctx = _make_ctx(conn, world, segments, wind, field, drive_days, drives,
                    plan_id, plan_stats, models, obs_rose, net_stats)
    _run_narrative(conn, ctx, log)
    return summary


def _make_ctx(conn, world, segments, wind, field, drive_days, drives, plan_id,
              plan_stats, models, obs_rose, net_stats) -> dict:
    """Assemble the documented `ctx` handed to `narrative.seed`."""
    from collections import Counter

    dcount = Counter(s.district for s in segments if s.district)

    def sample_field(when, lon, lat):
        if isinstance(when, datetime):
            h = int((when - world.start).total_seconds() // 3600)
        else:
            h = int(when)
        h = max(0, min(field.n_hours - 1, h))
        scalar = np.isscalar(lon)
        v = field.sample(h, np.atleast_1d(lon), np.atleast_1d(lat))
        return {k: (float(a[0]) if scalar else a) for k, a in v.items()}

    def segment_stat(segment_id, measure, window="all"):
        r = conn.execute(
            "SELECT * FROM segment_stat WHERE segment_id=? AND measure=? AND window=?",
            (segment_id, measure, window),
        ).fetchone()
        return dict(r) if r else None

    return {
        # ---- REQUIRED
        "campaign": dict(world.campaign),
        "segments": _segment_ctx(segments),
        "sites": _site_ctx(world),
        "monitors": [dict(m) for m in world.monitors],
        "vehicles": [dict(v) for v in world.vehicles],
        "wind": [
            {**w.row(world.campaign["id"]), "hour_index": w.hour_index,
             "transport_deg": round(w.transport_deg, 1)}
            for w in wind
        ],
        "measures": meas.measure_rows(),
        "rng_seed": world.seed,
        "now": world.now,
        "start": world.start,
        "end": world.end,
        # ---- EXTRA
        "users": [dict(u) for u in world.users],
        "orgs": [dict(o) for o in world.orgs],
        "action_levels": meas.action_level_rows(
            world.campaign["id"], world.now.isoformat(timespec="seconds")
        ),
        "districts": [d for d, _ in dcount.most_common()],
        "leaks": [
            {"id": lk.id, "lon": lk.lon, "lat": lk.lat, "sigma_m": lk.sigma_m,
             "ppm_peak": lk.ppm_peak, "duty": lk.duty, "label": lk.label}
            for lk in world.leaks
        ],
        "drives": [dict(d) for d in drives],
        "drive_plan": {"id": plan_id, "stats": plan_stats},
        "dispersion_models": models,
        "observed_rose": obs_rose,
        "field": field,
        "sample_field": sample_field,
        "segment_stat": segment_stat,
        "network_stats": net_stats,
    }


def _run_narrative(conn, ctx, log) -> None:
    try:
        from . import narrative  # type: ignore
    except ImportError:
        log("narrative layer: not present (air.datagen.narrative) -- physical data only")
        return
    n0 = time.time()
    narrative.seed(conn, ctx)
    log(f"narrative layer: seeded in {time.time() - n0:.1f}s")


# ---------------------------------------------------------------- drive-plan only


def regenerate_drive_plan(conn: sqlite3.Connection, fleet_size: int = 5,
                          target_passes: int = 25,
                          shift_hours: float = dp.SHIFT_HOURS,
                          seed: int | None = None) -> dict:
    """Rebuild only the drive plan and everything derived from it.

    Backs `POST /admin/campaigns/{id}/drive-plan`.  The world, the boundary, the
    monitors, the wind and the concentration field are all left untouched, so the
    physics does not move under the narrative layer -- only who drove where, and
    therefore which passes and stats exist.

    Reads `setting('datagen.seed')` and `setting('datagen.now')` so the regenerated
    plan lands in the same world the rest of the database describes.
    """
    row = conn.execute("SELECT value FROM setting WHERE key='datagen.seed'").fetchone()
    base_seed = int(row[0]) if row else 20260827
    row = conn.execute("SELECT value FROM setting WHERE key='datagen.now'").fetchone()
    now = datetime.fromisoformat(row[0]) if row else None
    seed = base_seed if seed is None else seed

    world = worldmod.build_world(seed=base_seed, now=now)
    world.campaign["fleet_size"] = fleet_size
    world.campaign["target_passes"] = target_passes
    cid = world.campaign["id"]
    segments, graph = netmod.build_network(world)
    n_days = (world.end.date() - world.start.date()).days
    wind = wx.build_wind(world.start, n_days, base_seed)
    field = FieldModel(world, segments, wind)

    drive_days, plan_stats, _ = dp.build_drive_plan(
        world, segments, graph, fleet_size=fleet_size,
        target_passes=target_passes, shift_hours=shift_hours, seed=seed,
    )

    for t in ("vehicle_ping", "drive", "drive_route", "drive_plan",
              "segment_pass", "segment_stat", "mobile_wind_obs"):
        conn.execute(f"DELETE FROM {t}")

    plan_id = f"plan-{cid}-{seed % 100000:05d}"
    conn.execute(
        "INSERT OR REPLACE INTO drive_plan (id,campaign_id,name,fleet_size,target_passes,"
        "status,params_json,stats_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (plan_id, cid, f"Regenerated plan (seed {seed}, fleet {fleet_size})",
         fleet_size, target_passes, "active",
         json.dumps({"seed": seed, "shift_hours": shift_hours,
                     "fleet_size": fleet_size, "target_passes": target_passes}),
         json.dumps(plan_stats, default=str), world.now.isoformat(timespec="seconds")),
    )
    conn.execute("UPDATE campaign SET fleet_size=?, target_passes=? WHERE id=?",
                 (fleet_size, target_passes, cid))
    dbm.insert_many(conn, "drive_route", sim.route_rows(world, drive_days, plan_id, cid, segments))
    drives, pings = sim.drive_rows(world, drive_days, plan_id, cid)
    dbm.insert_many(conn, "drive", drives)
    dbm.insert_tuples(conn, "vehicle_ping",
                      ("drive_id", "ts", "lon", "lat", "speed_kph", "heading_deg", "segment_id"),
                      [(d, t, lo, la, sp, hd, segments[si].id if si is not None else None)
                       for (d, t, lo, la, sp, hd, si) in pings])
    pcols, prows = sim.segment_passes(world, segments, field, drive_days, cid)
    dbm.insert_tuples(conn, "segment_pass", pcols, prows)
    scols, srows = statmod.build_segment_stats(segments, pcols, prows, cid)
    dbm.insert_tuples(conn, "segment_stat", scols, srows)
    ocols, orows = mw.observations(world, segments, graph, wind, drive_days, cid)
    dbm.insert_tuples(conn, "mobile_wind_obs", ocols, orows)

    vstatus = sim.vehicle_status(world, drive_days)
    for vid, st in vstatus.items():
        conn.execute("UPDATE vehicle SET status=? WHERE id=?", (st, vid))
    return {"plan_id": plan_id, "stats": plan_stats,
            "counts": {"segment_pass": len(prows), "segment_stat": len(srows),
                       "vehicle_ping": len(pings), "mobile_wind_obs": len(orows)}}


# ---------------------------------------------------------------- CLI


def _print_summary(summary: dict, conn, db_path: Path, elapsed: float) -> None:
    W = 78
    def rule(ch="─"):
        print(ch * W)

    rule("═")
    print("air · datagen · Southwest Memphis Community Air Monitoring")
    rule("═")
    print(f"  seed {summary['seed']}   campaign {summary['campaign']}   now {summary['now']}")
    n = summary["network"]
    p = summary["plan"]
    print(f"  network   {n['n_segments']} segments · {n['total_km']} km · "
          f"mean {n['mean_len_m']} m · {len(n['by_district'])} districts")
    print(f"  coverage  {p['coverage_pct']}% at {p['target_passes']} passes · "
          f"mean {p['mean_passes']} · min {p['min_passes']} · max {p['max_passes']} · "
          f"target reached day {p['days_to_target']}")
    print(f"  fleet     {p['n_drives']} drives / {p['drive_days']} drive days · "
          f"{p['km_per_vehicle_day_mean']} km per vehicle-day "
          f"(p10 {p['km_per_vehicle_day_p10']} – p90 {p['km_per_vehicle_day_p90']})")
    v = summary["verification"]
    print(f"  model     north-half rose assumed {100 * v['north_half_assumed']:.1f}% vs "
          f"observed {100 * v['north_half_observed']:.1f}%  "
          f"(observed {v['north_ratio_observed_over_assumed']}x)")
    rule()
    print(f"  {'measure':<14}{'n':>9}{'p05':>10}{'p50':>10}{'p90':>10}{'p99':>10}{'max':>11}")
    for code, s in summary["measures"].items():
        print(f"  {code:<14}{s['n']:>9}{s['p05']:>10.3f}{s['p50']:>10.3f}"
              f"{s['p90']:>10.3f}{s['p99']:>10.3f}{s['max']:>11.3f}")
    rule()
    counts = dbm.table_counts(conn)
    items = [(k, v) for k, v in counts.items() if v]
    half = (len(items) + 1) // 2
    for i in range(half):
        left = items[i]
        right = items[i + half] if i + half < len(items) else None
        line = f"  {left[0]:<26}{left[1]:>10}"
        if right:
            line += f"     {right[0]:<26}{right[1]:>10}"
        print(line)
    rule()
    size_mb = db_path.stat().st_size / 1e6 if db_path.exists() else 0.0
    wal = db_path.with_suffix(db_path.suffix + "-wal")
    if wal.exists():
        size_mb += wal.stat().st_size / 1e6
    print(f"  {db_path}   {size_mb:.1f} MB   built in {elapsed:.1f}s")
    rule("═")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="air-datagen",
                                 description="Generate and seed data/air.db")
    ap.add_argument("command", nargs="?", default="build",
                    choices=["build", "drive-plan"])
    ap.add_argument("--seed", type=int, default=20260827)
    ap.add_argument("--fresh", action="store_true",
                    help="also drop the narrative tables (concerns, alerts, ...)")
    ap.add_argument("--db", type=Path, default=dbm.DB_PATH)
    ap.add_argument("--now", type=str, default=None,
                    help="override 'now' (ISO 8601), for a reproducible build")
    ap.add_argument("--fleet-size", type=int, default=None)
    ap.add_argument("--target-passes", type=int, default=None)
    ap.add_argument("--shift-hours", type=float, default=dp.SHIFT_HOURS)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    now = datetime.fromisoformat(args.now) if args.now else None
    t0 = time.time()
    conn = dbm.connect(args.db)
    try:
        if args.command == "drive-plan":
            out = regenerate_drive_plan(conn, fleet_size=args.fleet_size or 5,
                                        target_passes=args.target_passes or 25,
                                        shift_hours=args.shift_hours, seed=args.seed)
            conn.commit()
            print(json.dumps(out["stats"], indent=2, default=str))
            print(json.dumps(out["counts"], indent=2))
            return 0
        summary = build_world(conn, seed=args.seed, now=now, fresh=args.fresh,
                              fleet_size=args.fleet_size,
                              target_passes=args.target_passes,
                              shift_hours=args.shift_hours, quiet=args.quiet)
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("ANALYZE")
        conn.commit()
        conn.execute("VACUUM")  # ship the smallest file we can
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        _print_summary(summary, conn, args.db, time.time() - t0)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
