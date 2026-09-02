"""Minimal fixture so every endpoint can be exercised end to end.

**This is for backend testing only.** `src/air/datagen` owns the real seed and
writes `data/air.db`; this writes `data/air_smoketest.db` by default so it can
never clobber that. Point the server at it with:

    AIR_DB=data/air_smoketest.db uv run air-server

Usage:
    uv run python -m air.server._smoketest_seed [--db PATH] [--force]
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sqlite3
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from air.server import config, geo

CENTER = (-90.132, 35.058)
BBOX = (-90.190, 35.020, -90.075, 35.115)
CAMPAIGN_ID = "cmp_swmemphis"
N_SEGMENTS = 22
DAYS = 14

MEASURES = [
    # code, label, short, unit, family, ref, healthy_max, scale, ramp, decimals, order, plain_name
    # The composite leads, as it does in the real registry. Its scale is the
    # identity because the value is already 0-100; its unit is the empty string
    # because it has none, and every unit-suppression path in the web app keys
    # off role and metric rather than off the measure.
    ("aclima_sense", "Aclima Sense", "Sense", "", "composite", 20.0, 30.0,
     [[0, 0], [100, 100]],
     ["#3FBF8F", "#9ED45C", "#F2C744", "#F08A3C", "#E2544F", "#9B4FA8", "#7A2438"], 0, 0,
     "the overall health score"),
    ("no2", "Nitrogen Dioxide", "NO2", "ppb", "modality", 20.0, 15.0,
     [[0, 0], [15, 20], [30, 45], [55, 70], [90, 90], [140, 100]],
     ["#e8f2e0", "#b9d99a", "#e8c95a", "#e08a3c", "#c0392b"], 1, 1, "traffic and generator exhaust"),
    ("pm25", "Fine Particulate Matter", "PM2.5", "µg/m³", "modality", 9.0, 7.0,
     [[0, 0], [7, 20], [14, 45], [25, 70], [40, 90], [70, 100]],
     ["#e8f2e0", "#b9d99a", "#e8c95a", "#e08a3c", "#c0392b"], 1, 2, "soot and smoke you can breathe in"),
    ("bc", "Black Carbon", "BC", "µg/m³", "modality", 1.0, 0.6,
     [[0, 0], [0.6, 20], [1.2, 45], [2.2, 70], [3.5, 90], [6.0, 100]],
     ["#eef0f2", "#a9b4c0", "#7d8794", "#4d5560", "#22262b"], 2, 3, "diesel soot"),
    ("o3", "Ozone", "O3", "ppb", "modality", 55.0, 40.0,
     [[0, 0], [40, 20], [55, 45], [70, 70], [90, 90], [120, 100]],
     ["#e8f2e0", "#b9d99a", "#e8c95a", "#e08a3c", "#c0392b"], 1, 4, "summer smog"),
    ("co", "Carbon Monoxide", "CO", "ppm", "modality", 1.0, 0.5,
     [[0, 0], [0.5, 20], [1.2, 45], [2.5, 70], [4.0, 90], [8.0, 100]],
     ["#e8f2e0", "#b9d99a", "#e8c95a", "#e08a3c", "#c0392b"], 2, 5, "incomplete burning"),
    ("co2", "Carbon Dioxide", "CO2", "ppm", "modality", 450.0, 420.0,
     [[380, 0], [420, 20], [470, 45], [540, 70], [650, 90], [800, 100]],
     ["#eaf0f6", "#b8cadb", "#7f9cbb", "#4f7196", "#2a4763"], 0, 6, "combustion nearby"),
    ("ch4", "Methane", "CH4", "ppm", "modality", 2.2, 1.95,
     [[1.8, 0], [2.0, 20], [2.4, 45], [3.0, 70], [4.5, 90], [8.0, 100]],
     ["#eef2ea", "#c3d9b0", "#8fbf6f", "#4f8f3f", "#245c22"], 2, 7, "natural gas in the air"),
    ("methane_leak", "Methane Leak Indicator", "CH4 leak", "index", "indicator", 0.5, 0.2,
     [[0, 0], [0.2, 20], [0.4, 45], [0.6, 70], [0.8, 90], [1.0, 100]],
     ["#eef2ea", "#c3d9b0", "#8fbf6f", "#4f8f3f", "#245c22"], 2, 8, "signs of a gas leak"),
    ("diesel", "Diesel Combustion Indicator", "Diesel", "index", "indicator", 0.5, 0.25,
     [[0, 0], [0.25, 20], [0.5, 45], [0.7, 70], [0.85, 90], [1.0, 100]],
     ["#eef0f2", "#a9b4c0", "#7d8794", "#4d5560", "#22262b"], 2, 9, "truck and generator exhaust"),
    ("nondiesel", "Non-diesel Combustion Indicator", "Non-diesel", "index", "indicator", 0.5, 0.25,
     [[0, 0], [0.25, 20], [0.5, 45], [0.7, 70], [0.85, 90], [1.0, 100]],
     ["#f2eeea", "#dbc3b0", "#bf8f6f", "#8f5f3f", "#5c3522"], 2, 10, "gas burning exhaust"),
]

ORGS = [
    ("org_ridgeline", "Ridgeline Compute", "Ridgeline", "company", "#3f7fd4", "▨",
     "AI compute campus operator. Gas turbines on site, diesel backup.", "https://example.invalid/ridgeline"),
    ("org_deltaforge", "Delta Forge Metals", "Delta Forge", "company", "#c9762f", "⬢",
     "Secondary metals processing on the south flank.", None),
    ("org_riverport", "Riverport Logistics", "Riverport", "company", "#7a6ec4", "▸",
     "Intermodal freight yard. Diesel truck traffic.", None),
    ("org_draqa", "Delta Regional Air Quality Authority", "DRAQA", "agency", "#2f7d6a", "◈",
     "State air quality authority. Operates the reference monitors.", None),
    ("org_boxtown", "Boxtown Air Watch", "Boxtown Air Watch", "cbo", "#c4553f", "✦",
     "Resident-led air monitoring group.", None),
    ("org_aclima", "Aclima", "Aclima", "aclima", "#1b6ef3", "◉",
     "Hyperlocal air measurement. The arbitrator of what the air is doing.", "https://aclima.earth/"),
]

USERS = [
    ("usr_dana", "Dana Whitfield", "dana@example.invalid", "community", "org_boxtown",
     "Resident, Boxtown", "🌻", "#c4553f", "Boxtown"),
    ("usr_marcus", "Marcus Enloe", "marcus@example.invalid", "community", "org_boxtown",
     "Resident, Westwood", "🎺", "#7a6ec4", "Westwood"),
    ("usr_perry", "Perry Okonkwo", "perry@example.invalid", "community", "org_boxtown",
     "Resident, Riverport", "⚓", "#2f7d6a", "Riverport"),
    ("usr_lena", "Lena Ashcroft", "lena@example.invalid", "community", "org_boxtown",
     "Organiser, Boxtown Air Watch", "📋", "#c9762f", "Boxtown"),
    ("usr_reg", "Yusuf Haddad", "yusuf@example.invalid", "regulator", "org_draqa",
     "Air Monitoring Lead, DRAQA", "🛰️", "#2f7d6a", None),
    ("usr_reg2", "Priya Raman", "priya@example.invalid", "regulator", "org_draqa",
     "Enforcement Analyst, DRAQA", "⚖️", "#2f7d6a", None),
    ("usr_ind", "Cole Berrigan", "cole@example.invalid", "industry", "org_ridgeline",
     "Site Operations Lead, Ridgeline South Campus", "🎛️", "#3f7fd4", None),
    ("usr_ind2", "Ines Vargas", "ines@example.invalid", "industry", "org_deltaforge",
     "EHS Manager, Delta Forge", "🦺", "#c9762f", None),
    ("usr_admin", "Aclima Ops", "ops@example.invalid", "admin", "org_aclima",
     "Campaign Operations", "◉", "#1b6ef3", None),
]

ACTION_LEVELS = [
    ("al_no2_spike", "no2", "NO2 1-hour action level", "spike", 60.0, "ppb", 1.0, "warning", "EPA NAAQS 1-hr (guess)"),
    ("al_no2_int", "no2", "NO2 8-hour integrated exposure", "integrated", 38.0, "ppb", 8.0, "watch", "local"),
    ("al_pm25_spike", "pm25", "PM2.5 1-hour action level", "spike", 35.0, "µg/m³", 1.0, "warning", "EPA NAAQS 24-hr (guess)"),
    ("al_pm25_int", "pm25", "PM2.5 24-hour integrated exposure", "integrated", 18.0, "µg/m³", 24.0, "watch", "local"),
    ("al_bc_spike", "bc", "Black carbon spike", "spike", 3.0, "µg/m³", 1.0, "watch", "local"),
    ("al_o3_spike", "o3", "Ozone 8-hour action level", "spike", 70.0, "ppb", 8.0, "warning", "EPA NAAQS 8-hr (guess)"),
    ("al_ch4_spike", "ch4", "Methane anomaly", "spike", 3.2, "ppm", 1.0, "watch", "local"),
]


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Seed a tiny fixture for backend smoke testing.")
    ap.add_argument("--db", default=str(config.REPO_ROOT / "data" / "air_smoketest.db"))
    ap.add_argument("--force", action="store_true", help="overwrite an existing file")
    args = ap.parse_args(argv)

    path = Path(args.db).resolve()
    if path == config.REPO_ROOT / "data" / "air.db" and not args.force:
        print("refusing to write data/air.db (datagen owns it). Pass --force to override.", file=sys.stderr)
        return 2
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    for suffix in ("-wal", "-shm"):
        p = Path(str(path) + suffix)
        if p.exists():
            p.unlink()

    conn = sqlite3.connect(path)
    conn.executescript(config.SCHEMA_PATH.read_text())
    conn.execute("PRAGMA foreign_keys = ON")
    rng = random.Random(20260827)
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    end_date = now.date()
    start_date = end_date - timedelta(days=DAYS - 1)

    # ── reference data ────────────────────────────────────────────────────────
    for m in MEASURES:
        conn.execute(
            """INSERT INTO measure_def (code,label,short_label,unit,family,ref_level,healthy_max,
                                        scale_json,ramp_json,decimals,sort_order,description,plain_name)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (m[0], m[1], m[2], m[3], m[4], m[5], m[6], json.dumps(m[7]), json.dumps(m[8]),
             m[9], m[10], f"{m[1]} — simulated.", m[11]),
        )
    for o in ORGS:
        conn.execute("INSERT INTO org (id,name,short_name,kind,brand_color,logo_emoji,blurb,website) VALUES (?,?,?,?,?,?,?,?)", o)
    for u in USERS:
        conn.execute(
            """INSERT INTO app_user (id,name,email,role,org_id,title,avatar_emoji,avatar_color,
                                     neighborhood,joined_at,is_demo_persona)
               VALUES (?,?,?,?,?,?,?,?,?,?,1)""",
            (*u, iso(now - timedelta(days=200))),
        )

    boundary = {
        "type": "Feature",
        "properties": {"name": "Southwest Memphis campaign boundary"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-90.178, 35.036], [-90.150, 35.024], [-90.104, 35.028], [-90.082, 35.052],
                [-90.088, 35.090], [-90.118, 35.108], [-90.158, 35.098], [-90.180, 35.070],
                [-90.178, 35.036],
            ]],
        },
    }
    conn.execute(
        """INSERT INTO campaign (id,slug,name,subtitle,description,region,state,center_lon,center_lat,
                                 default_zoom,bbox_w,bbox_s,bbox_e,bbox_n,boundary_geojson,
                                 start_date,end_date,status,fleet_size,target_passes,timezone,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', 5, 25, 'America/Chicago', ?)""",
        (CAMPAIGN_ID, "southwest-memphis", "Southwest Memphis Community Air Monitoring",
         "Boxtown · Westwood · Riverport", "SIMULATED smoke-test fixture.", "Southwest Memphis", "TN",
         CENTER[0], CENTER[1], 13.0, *BBOX, json.dumps(boundary),
         start_date.isoformat(), end_date.isoformat(), iso(now - timedelta(days=DAYS))),
    )

    # ── road segments on a rough street grid ──────────────────────────────────
    STREETS = ["Weaver Rd", "Kansas St", "Mallory Ave", "Horn Lake Rd", "Riverport Rd",
               "Boxtown Rd", "Church Rd", "Holmes Rd", "Third St", "Elvis Presley Blvd",
               "Person Ave", "Wilson School Rd"]
    DISTRICTS = ["Boxtown", "Westwood", "Riverport"]
    CLASSES = ["residential", "secondary", "tertiary", "service", "primary"]
    segments = []
    for i in range(N_SEGMENTS):
        name = STREETS[i % len(STREETS)]
        road_class = CLASSES[i % len(CLASSES)]
        # Lay them out on a lattice inside the bbox.
        col, row = i % 5, i // 5
        lon0 = BBOX[0] + 0.012 + col * 0.019 + rng.uniform(-0.002, 0.002)
        lat0 = BBOX[1] + 0.014 + row * 0.017 + rng.uniform(-0.002, 0.002)
        # Districts are latitude bands so "downwind" is geographically real:
        # Boxtown south of the campus, Westwood level with it, Riverport north.
        span = (BBOX[3] - BBOX[1]) or 1e-6
        band = min(2, int((lat0 - BBOX[1]) / span * 3))
        district = ("Boxtown", "Westwood", "Riverport")[band]
        bearing = 90.0 if i % 2 == 0 else 15.0
        pts = [(lon0, lat0)]
        for step in range(3):
            pts.append(geo.destination(*pts[-1], bearing + rng.uniform(-12, 12), 70.0))
        length = sum(geo.haversine_m(*pts[k], *pts[k + 1]) for k in range(len(pts) - 1))
        mid = pts[len(pts) // 2]
        sid = f"seg_{i:03d}"
        conn.execute(
            """INSERT INTO road_segment (id,campaign_id,osm_way_id,name,road_class,district,
                                         geometry_json,length_m,mid_lon,mid_lat,bearing_deg)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (sid, CAMPAIGN_ID, 100000 + i, name, road_class, district,
             json.dumps([[round(p[0], 6), round(p[1], 6)] for p in pts]),
             round(length, 1), mid[0], mid[1], bearing),
        )
        segments.append({"id": sid, "name": name, "district": district, "mid": mid, "length": length})

    # ── industry sites ───────────────────────────────────────────────────────
    def footprint(lon: float, lat: float, r: float) -> str:
        ring = [list(geo.destination(lon, lat, b, r)) for b in range(0, 360, 45)]
        ring.append(ring[0])
        return json.dumps({"type": "Polygon", "coordinates": [[[round(p[0], 6), round(p[1], 6)] for p in ring]]})

    SITES = [
        ("site_ridgeline", "org_ridgeline", "Ridgeline South Campus", "datacenter",
         -90.1215, 35.0665, "operating", 340.0, 220.0, 18, "natural gas + diesel backup", 78.0,
         "AI compute campus. 18 gas turbines with diesel backup, cooling towers on the north face.",
         "#3f7fd4", "▨", "usr_ind"),
        ("site_deltaforge", "org_deltaforge", "Delta Forge Metals Works", "manufacturing",
         -90.1520, 35.0415, "operating", None, None, 4, "natural gas", 52.0,
         "Secondary metals processing. Furnace stacks on the west side.", "#c9762f", "⬢", None),
        ("site_riverport", "org_riverport", "Riverport Intermodal Yard", "logistics",
         -90.0980, 35.0940, "operating", None, None, 0, "diesel (fleet)", 41.0,
         "Intermodal freight yard. Gate traffic is the main source.", "#7a6ec4", "▸", None),
    ]
    for s in SITES:
        (sid_, org_id, name, kind, lon, lat, status, cap, itload, gcount, fuel,
         headroom, blurb, brand, emoji, claimed) = s
        conn.execute(
            """INSERT INTO industry_site (id,campaign_id,org_id,name,kind,footprint_geojson,
                                          centroid_lon,centroid_lat,claimed_by_user_id,claimed_at,status,
                                          capacity_mw,it_load_mw,generator_count,generator_fuel,
                                          operating_since,blurb,brand_color,logo_emoji,website,headroom_pct)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (sid_, CAMPAIGN_ID, org_id, name, kind, footprint(lon, lat, 340.0), lon, lat,
             claimed, iso(now - timedelta(days=45)) if claimed else None, status,
             cap, itload, gcount, fuel, "2023-04-01", blurb, brand, emoji,
             "https://example.invalid/" + sid_, headroom),
        )

    # Emission points: a turbine bank east, cooling towers north, backup diesel south.
    EP = [
        ("ep_r_gen_a", "site_ridgeline", "Turbine Bank A", "generator", 85.0, 320.0, 24.0, 1, ["no2", "co", "co2", "ch4"]),
        ("ep_r_gen_b", "site_ridgeline", "Turbine Bank B", "generator", 105.0, 300.0, 24.0, 1, ["no2", "co", "co2", "ch4"]),
        ("ep_r_cool", "site_ridgeline", "Cooling Tower Row", "cooling_tower", 350.0, 260.0, 14.0, 1, ["pm25"]),
        ("ep_r_backup", "site_ridgeline", "Diesel Backup Bank", "backup", 195.0, 240.0, 9.0, 0, ["pm25", "bc", "no2"]),
        ("ep_r_gate", "site_ridgeline", "North Gate", "traffic_gate", 15.0, 300.0, 3.0, 1, ["bc", "diesel"]),
        ("ep_d_stack", "site_deltaforge", "Furnace Stack 1", "stack", 275.0, 180.0, 32.0, 1, ["pm25", "co"]),
        ("ep_p_gate", "site_riverport", "Yard Gate", "traffic_gate", 200.0, 220.0, 3.0, 1, ["bc", "diesel"]),
    ]
    for e in EP:
        site = next(s for s in SITES if s[0] == e[1])
        lon, lat = geo.destination(site[4], site[5], e[4], e[5])
        conn.execute(
            """INSERT INTO emission_point (id,site_id,name,kind,lon,lat,height_m,active,measures_json)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (e[0], e[1], e[2], e[3], lon, lat, e[6], e[7], json.dumps(e[8])),
        )

    # ── monitors: 2 regulator towers + 2 industry fenceline ──────────────────
    rl = next(s for s in SITES if s[0] == "site_ridgeline")
    east = geo.destination(rl[4], rl[5], 95.0, 520.0)
    south = geo.destination(rl[4], rl[5], 200.0, 560.0)
    MONITORS = [
        ("mon_draqa_boxtown", "Boxtown Reference Station", "47-157-0021", "regulator", "org_draqa", None,
         -90.1430, 35.0480, "reference", "online", ["no2", "pm25", "o3", "co"], 2500.0,
         "DRAQA reference tower. The gold standard for compliance."),
        ("mon_draqa_riverport", "Riverport Reference Station", "47-157-0043", "regulator", "org_draqa", None,
         -90.1005, 35.0905, "reference", "online", ["no2", "pm25", "o3"], 2500.0,
         "DRAQA reference tower on the north flank."),
        ("mon_ridge_east", "Ridgeline Fenceline East", "RL-FL-E", "industry", "org_ridgeline", "site_ridgeline",
         east[0], east[1], "lowcost", "online", ["no2", "pm25", "bc", "ch4", "co"], 500.0,
         "Operator fenceline sensor, east flank."),
        ("mon_ridge_south", "Ridgeline Fenceline South", "RL-FL-S", "industry", "org_ridgeline", "site_ridgeline",
         south[0], south[1], "lowcost", "online", ["no2", "pm25", "bc"], 500.0,
         "Operator fenceline sensor, south flank."),
        ("mon_cbo_school", "Boxtown Air Watch — Wilson School", "BAW-01", "community", "org_boxtown", None,
         -90.1330, 35.0555, "lowcost", "degraded", ["pm25"], 300.0,
         "Resident-hosted low-cost sensor."),
    ]
    for m in MONITORS:
        conn.execute(
            """INSERT INTO monitor (id,campaign_id,name,code,owner_type,org_id,site_id,lon,lat,
                                    elevation_m,grade,status,measures_json,radius_m,install_date,
                                    last_calibrated,blurb)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (m[0], CAMPAIGN_ID, m[1], m[2], m[3], m[4], m[5], m[6], m[7], 84.0, m[8], m[9],
             json.dumps(m[10]), m[11], "2024-02-01", iso(now - timedelta(days=21)), m[12]),
        )

    # ── action levels ────────────────────────────────────────────────────────
    for a in ACTION_LEVELS:
        conn.execute(
            """INSERT INTO action_level (id,campaign_id,measure,label,kind,threshold,unit,
                                         averaging_hours,severity,enabled,source,
                                         notify_community,notify_industry,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,1,?,1,1,?)""",
            (a[0], CAMPAIGN_ID, a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], iso(now - timedelta(days=7))),
        )

    # ── wind: hourly over the campaign ───────────────────────────────────────
    hours = DAYS * 24
    for h in range(hours, -1, -1):
        ts = now - timedelta(hours=h)
        phase = h / 18.0
        deg = (215 + 40 * math.sin(phase) + rng.uniform(-12, 12)) % 360
        spd = max(0.6, 3.4 + 1.7 * math.sin(phase * 0.7) + rng.uniform(-0.5, 0.5))
        stab = "D" if 5 <= ts.hour <= 18 else ("E" if spd > 2.0 else "F")
        conn.execute(
            """INSERT OR REPLACE INTO wind (campaign_id,ts,speed_ms,dir_deg,gust_ms,temp_c,rh,pbl_m,stability)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (CAMPAIGN_ID, iso(ts), round(spd, 2), round(deg, 1), round(spd * 1.7, 2),
             round(24 + 7 * math.sin((ts.hour - 4) / 24 * 2 * math.pi), 1),
             round(58 + 18 * math.cos((ts.hour - 4) / 24 * 2 * math.pi), 1),
             900.0 if stab == "D" else 300.0, stab),
        )

    # ── a smooth-ish concentration field so segment stats look plausible ─────
    def field(lon: float, lat: float, code: str, t: float) -> float:
        # Distance-weighted plume from Ridgeline + a road-class background.
        d = geo.haversine_m(lon, lat, rl[4], rl[5])
        plume = math.exp(-d / 1400.0)
        wobble = 0.5 + 0.5 * math.sin(lon * 900 + lat * 700 + t)
        base = {"no2": 14, "pm25": 7.5, "bc": 0.55, "o3": 34, "co": 0.32,
                "co2": 425, "ch4": 1.93, "methane_leak": 0.08, "diesel": 0.3, "nondiesel": 0.3}[code]
        gain = {"no2": 34, "pm25": 11, "bc": 1.5, "o3": -8, "co": 0.9,
                "co2": 120, "ch4": 0.5, "methane_leak": 0.5, "diesel": 0.55, "nondiesel": 0.5}[code]
        return max(0.0, base + gain * plume * (0.55 + 0.7 * wobble))

    codes = [m[0] for m in MEASURES]
    mdef = {m[0]: m for m in MEASURES}

    def risk_of(code: str, v: float) -> int:
        scale = mdef[code][7]
        pts = sorted((float(c), float(r)) for c, r in scale)
        if v <= pts[0][0]:
            return int(pts[0][1])
        for (c0, r0), (c1, r1) in zip(pts, pts[1:]):
            if v <= c1:
                f = 0 if c1 == c0 else (v - c0) / (c1 - c0)
                return int(round(r0 + f * (r1 - r0)))
        return int(pts[-1][1])

    # ── vehicles, drive plan, drives, passes, pings ──────────────────────────
    VEH = [("veh_01", "AC-01", "Bluebird", "ev"), ("veh_02", "AC-02", "Kestrel", "ev"),
           ("veh_03", "AC-03", "Heron", "phev")]
    for i, (vid, label, sign, pt) in enumerate(VEH):
        conn.execute(
            """INSERT INTO vehicle (id,campaign_id,label,call_sign,model,powertrain,status,
                                    operator_name,home_base_lon,home_base_lat,measures_json)
               VALUES (?,?,?,?, 'Aclima Mobile Node', ?, ?, ?,?,?,?)""",
            (vid, CAMPAIGN_ID, label, sign, pt, "driving" if i < 2 else "charging",
             ["R. Ellison", "T. Okafor", "M. Salas"][i], CENTER[0], CENTER[1], json.dumps(codes)),
        )

    plan_id = "dp_smoke"
    conn.execute(
        """INSERT INTO drive_plan (id,campaign_id,name,fleet_size,target_passes,status,
                                   params_json,stats_json,created_at)
           VALUES (?,?, 'Smoke-test plan', 3, 25, 'active', ?, ?, ?)""",
        (plan_id, CAMPAIGN_ID,
         json.dumps({"fleet_size": 3, "target_passes": 25, "shift_hours": 6, "seed": 42}),
         json.dumps({"total_segments": N_SEGMENTS, "total_km": round(sum(s["length"] for s in segments) / 1000, 1),
                     "days_to_target": 9, "km_per_vehicle_day": 108.0, "coverage_pct": 100.0,
                     "mean_passes": 21.0, "segments_below_target": 4}),
         iso(now - timedelta(days=DAYS))),
    )
    per = max(1, N_SEGMENTS // len(VEH))
    for day in range(3):
        for vi, (vid, *_rest) in enumerate(VEH):
            block = segments[vi * per:(vi + 1) * per] or segments[:per]
            coords = []
            for s in block:
                coords.append([round(s["mid"][0], 5), round(s["mid"][1], 5)])
            conn.execute(
                """INSERT INTO drive_route (id,plan_id,campaign_id,vehicle_id,day_index,date,shift,
                                            segment_ids_json,geometry_json,distance_m,duration_min,est_passes)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (f"dr_{day}_{vi}", plan_id, CAMPAIGN_ID, vid, day,
                 (start_date + timedelta(days=day)).isoformat(),
                 ["morning", "midday", "evening"][vi % 3],
                 json.dumps([s["id"] for s in block]), json.dumps(coords),
                 round(sum(s["length"] for s in block) * 1.4, 1), 240.0, 3),
            )

    pass_rows = 0
    for day in range(DAYS):
        date = start_date + timedelta(days=day)
        for vi, (vid, *_rest) in enumerate(VEH):
            drive_id = f"drv_{day}_{vi}"
            started = datetime.combine(date, datetime.min.time(), tzinfo=UTC) + timedelta(hours=7 + vi * 4)
            block = segments[vi * per:(vi + 1) * per] or segments[:per]
            conn.execute(
                """INSERT INTO drive (id,campaign_id,plan_id,route_id,vehicle_id,date,started_at,
                                      ended_at,status,distance_m,segments_covered,geometry_json)
                   VALUES (?,?,?,?,?,?,?,?, 'complete', ?,?,?)""",
                (drive_id, CAMPAIGN_ID, plan_id, f"dr_{day % 3}_{vi}", vid, date.isoformat(),
                 iso(started), iso(started + timedelta(hours=4)),
                 round(sum(s["length"] for s in block) * 1.4, 1), len(block),
                 json.dumps([[round(s["mid"][0], 5), round(s["mid"][1], 5)] for s in block])),
            )
            for k, s in enumerate(block):
                ts = started + timedelta(minutes=k * 11)
                conn.execute(
                    """INSERT OR REPLACE INTO vehicle_ping (drive_id,ts,lon,lat,speed_kph,heading_deg,segment_id)
                       VALUES (?,?,?,?,?,?,?)""",
                    (drive_id, iso(ts), round(s["mid"][0], 6), round(s["mid"][1], 6),
                     round(rng.uniform(18, 42), 1), round(rng.uniform(0, 359), 1), s["id"]),
                )
                for rep in range(2):
                    pts = ts + timedelta(minutes=k * 11 + rep * 4)
                    vals = {c: round(field(s["mid"][0], s["mid"][1], c, day * 0.3 + rep) *
                                     rng.uniform(0.85, 1.2), 4) for c in codes}
                    conn.execute(
                        """INSERT INTO segment_pass (campaign_id,segment_id,drive_id,vehicle_id,ts,
                                                     no2,pm25,bc,o3,co,co2,ch4,methane_leak,diesel,nondiesel,speed_kph)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (CAMPAIGN_ID, s["id"], drive_id, vid, iso(pts),
                         vals["no2"], vals["pm25"], vals["bc"], vals["o3"], vals["co"], vals["co2"],
                         vals["ch4"], vals["methane_leak"], vals["diesel"], vals["nondiesel"],
                         round(rng.uniform(18, 42), 1)),
                    )
                    pass_rows += 1

    # ── segment_stat: window 'all', per-date, per-hour ────────────────────────
    for s in segments:
        for c in codes:
            samples = [
                r[0] for r in conn.execute(
                    "SELECT %s FROM segment_pass WHERE segment_id=? AND %s IS NOT NULL" % (c, c), (s["id"],)
                )
            ]
            if not samples:
                continue
            samples.sort()
            n = len(samples)
            med = samples[n // 2]
            ref = mdef[c][5]
            over = sum(1 for v in samples if ref is not None and v > ref) / n
            conn.execute(
                """INSERT OR REPLACE INTO segment_stat
                     (segment_id,campaign_id,measure,window,n_passes,mean,median,p10,p90,max,persistence,risk)
                   VALUES (?,?,?, 'all', ?,?,?,?,?,?,?,?)""",
                (s["id"], CAMPAIGN_ID, c, n, round(sum(samples) / n, 4), round(med, 4),
                 round(samples[int(n * 0.1)], 4), round(samples[int(n * 0.9)], 4),
                 round(samples[-1], 4), round(over, 3), risk_of(c, med)),
            )
        # per-date and diurnal windows for the two headline measures
        for c in ("no2", "pm25"):
            for d in range(DAYS):
                date = (start_date + timedelta(days=d)).isoformat()
                vals = [
                    r[0] for r in conn.execute(
                        "SELECT %s FROM segment_pass WHERE segment_id=? AND substr(ts,1,10)=? AND %s IS NOT NULL"
                        % (c, c), (s["id"], date)
                    )
                ]
                if not vals:
                    continue
                vals.sort()
                med = vals[len(vals) // 2]
                conn.execute(
                    """INSERT OR REPLACE INTO segment_stat
                         (segment_id,campaign_id,measure,window,n_passes,mean,median,p10,p90,max,persistence,risk)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (s["id"], CAMPAIGN_ID, c, f"date:{date}", len(vals),
                     round(sum(vals) / len(vals), 4), round(med, 4), round(vals[0], 4),
                     round(vals[-1], 4), round(vals[-1], 4),
                     round(sum(1 for v in vals if v > mdef[c][5]) / len(vals), 3), risk_of(c, med)),
                )
            for hh in range(24):
                vals = [
                    r[0] for r in conn.execute(
                        "SELECT %s FROM segment_pass WHERE segment_id=? AND substr(ts,12,2)=? AND %s IS NOT NULL"
                        % (c, c), (s["id"], f"{hh:02d}")
                    )
                ]
                if not vals:
                    continue
                vals.sort()
                med = vals[len(vals) // 2]
                conn.execute(
                    """INSERT OR REPLACE INTO segment_stat
                         (segment_id,campaign_id,measure,window,n_passes,mean,median,p10,p90,max,persistence,risk)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (s["id"], CAMPAIGN_ID, c, f"hour:{hh:02d}", len(vals),
                     round(sum(vals) / len(vals), 4), round(med, 4), round(vals[0], 4),
                     round(vals[-1], 4), round(vals[-1], 4),
                     round(sum(1 for v in vals if v > mdef[c][5]) / len(vals), 3), risk_of(c, med)),
                )

    # ── monitor readings: hourly, mostly under the action levels ─────────────
    for m in MONITORS:
        for code in m[10]:
            for h in range(hours, -1, -1):
                ts = now - timedelta(hours=h)
                v = field(m[6], m[7], code, h / 20.0)
                # gentle diurnal
                v *= 0.85 + 0.3 * math.sin((ts.hour - 6) / 24 * 2 * math.pi)
                v *= rng.uniform(0.9, 1.12)
                conn.execute(
                    """INSERT OR REPLACE INTO monitor_reading (monitor_id,ts,measure,value,qc)
                       VALUES (?,?,?,?, 'valid')""",
                    (m[0], iso(ts), code, round(max(0.0, v), 4)),
                )

    # ── mobile wind: fleet anemometry along every ping ───────────────────────
    # Aclima's cars carry anemometers. This is the observed street-level wind the
    # "verify your consultant" screen compares the model against.
    wind_by_hour = {
        r[0]: (r[1], r[2])
        for r in conn.execute("SELECT ts, dir_deg, speed_ms FROM wind WHERE campaign_id=?", (CAMPAIGN_ID,))
    }

    def wind_at(ts_iso: str) -> tuple[float, float]:
        hour = ts_iso[:13] + ":00:00Z"
        return wind_by_hour.get(hour, (215.0, 3.2))

    mwo = 0
    pings = conn.execute(
        """SELECT p.drive_id, p.ts, p.lon, p.lat, p.speed_kph, p.segment_id, d.vehicle_id
             FROM vehicle_ping p JOIN drive d ON d.id = p.drive_id
            WHERE d.campaign_id = ? ORDER BY p.ts""",
        (CAMPAIGN_ID,),
    ).fetchall()
    for drive_id, p_ts, p_lon, p_lat, p_kph, p_seg, p_veh in pings:
        base_dir, base_spd = wind_at(p_ts)
        # Street-canyon steering plus honest platform noise.
        canyon = 14.0 * math.sin(p_lon * 640 + p_lat * 380)
        for k in range(3):  # a few observations per ping location
            spd = max(0.15, base_spd * rng.uniform(0.6, 1.35))
            veh = (p_kph or 25.0) * rng.uniform(0.7, 1.3)
            noise = rng.gauss(0, 8 + 26 / max(0.4, spd))
            direction = (base_dir + canyon + noise) % 360
            # Fast vehicle or calm air makes the correction unreliable — say so.
            if spd < 0.8 or veh > 46:
                quality = "rejected" if (spd < 0.6 or veh > 52) else "suspect"
            else:
                quality = "good"
            ts = iso(datetime.fromisoformat(p_ts.replace("Z", "+00:00")) + timedelta(seconds=k * 40))
            conn.execute(
                """INSERT INTO mobile_wind_obs (campaign_id,drive_id,vehicle_id,segment_id,ts,lon,lat,
                                                speed_ms,dir_deg,gust_ms,vehicle_speed_kph,quality)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (CAMPAIGN_ID, drive_id, p_veh, p_seg, ts,
                 round(p_lon + rng.uniform(-0.0006, 0.0006), 6),
                 round(p_lat + rng.uniform(-0.0006, 0.0006), 6),
                 round(spd, 2), round(direction, 1) % 360, round(spd * rng.uniform(1.2, 2.0), 2),
                 round(veh, 1), quality),
            )
            mwo += 1

    # ── the consultant's deliverable — DELIBERATELY IMPERFECT ────────────────
    # Derived from the campaign's own observed rose, then smoothed toward an
    # idealised distribution (as an airport-normals rose would be) and with the
    # NORTH sector suppressed. So the study is broadly right — and blind to
    # exactly the north-wind days that carry the plume south over Boxtown. That
    # makes the baseline verdict 'consistent' and `model_divergence` the thing
    # that exposes it, rather than the fixture pre-loading the conclusion.
    baseline = conn.execute(
        "SELECT dir_deg, speed_ms FROM mobile_wind_obs WHERE campaign_id=? AND quality!='rejected'",
        (CAMPAIGN_ID,),
    ).fetchall()
    counts = [0] * 16
    speeds = [[] for _ in range(16)]
    for d, sp in baseline:
        b = int(((d % 360) + 11.25) // 22.5) % 16
        counts[b] += 1
        speeds[b].append(sp)
    total = max(1, len(baseline))
    uniform = 100.0 / 16.0
    NORTH_BINS = (15, 0, 1)          # 337.5, 0, 22.5
    NORTH_SUPPRESSION = 0.18
    raw = []
    for b in range(16):
        share = 100.0 * counts[b] / total
        # 85% of the measured shape, 15% smoothed flat — an idealised rose.
        f = share * 0.85 + uniform * 0.15
        if b in NORTH_BINS:
            f *= NORTH_SUPPRESSION
        raw.append(f)
    scale = 100.0 / sum(raw)
    assumed = [
        (
            round(b * 22.5, 1),
            round(raw[b] * scale, 2),
            round(sum(speeds[b]) / len(speeds[b]), 2) if speeds[b] else 3.0,
        )
        for b in range(16)
    ]
    conn.execute(
        """INSERT INTO dispersion_model (id,site_id,campaign_id,name,vendor,method,measure,
                                         averaging_hours,issued_at,assumed_wind_json,notes)
           VALUES ('dm_ridgeline_aermod','site_ridgeline',?,
                   'Ridgeline South Campus NO2 Dispersion Study',
                   'Meridian Environmental Consulting','AERMOD','no2',1.0,?,?,
                   'Prepared for the operating permit application. Wind rose derived from the regional airport station, 2019-2023 normals. SIMULATED.')""",
        (CAMPAIGN_ID, iso(now - timedelta(days=420)),
         json.dumps([{"dir_deg": d, "freq": f, "mean_speed_ms": sp} for d, f, sp in assumed])),
    )
    # Contours elongated toward the NE — downwind of the assumed SW flow. Almost
    # nothing reaches south, which is precisely what model_divergence exposes.
    for band, (r0, r1, level) in enumerate([(60.0, 900.0, 42.0), (900.0, 1700.0, 24.0), (1700.0, 2600.0, 12.0)]):
        ring = geo.plume_polygon(rl[4], rl[5], 225.0, 4.9, "D", r0, r1, steps=18)
        conn.execute(
            "INSERT INTO dispersion_model_contour (model_id,band,level,geometry_json) VALUES (?,?,?,?)",
            ("dm_ridgeline_aermod", band, level,
             json.dumps({"type": "Polygon", "coordinates": [ring]})),
        )

    # ── community: concerns (2 clustered pairs + singles), responses ─────────
    concern_defs = [
        ("cn_001", "usr_dana", "smell", 4, "Chemical smell again after dark",
         "Same as last week, right around 9pm.", 140.0, "corroborated", 2, "👃"),
        ("cn_002", "usr_marcus", "noise", 3, "Generator drone all evening",
         "Started around six and never stopped.", 210.0, "new", 0, "🔊"),
        ("cn_003", "usr_perry", "smoke", 3, "Haze in the streetlights",
         "You can see it hanging under the lights.", 320.0, "under_review", 1, "🌫️"),
        ("cn_004", "usr_lena", "health", 5, "Burning eyes, whole block complaining",
         "Four households on this street.", 90.0, "new", 3, "🤒"),
    ]
    clon, clat = geo.destination(rl[4], rl[5], 135.0, 1250.0)
    for i, (cid_, author, kind, sev, title, body, off, status, corr, emoji) in enumerate(concern_defs):
        lon, lat = geo.destination(clon, clat, 40.0 + i * 70.0, off)
        occurred = now - timedelta(hours=6 + i * 3)
        conn.execute(
            """INSERT INTO concern (id,campaign_id,author_id,kind,severity,title,body,lon,lat,
                                    address_hint,district,occurred_at,created_at,status,cluster_id,
                                    corroborations,is_anonymous,photo_emoji,suspected_site_id)
               VALUES (?,?,?,?,?,?,?,?,?,?, 'Boxtown', ?,?,?,NULL,?,0,?,?)""",
            (cid_, CAMPAIGN_ID, author, kind, sev, title, body, lon, lat,
             f"{100 + i * 40} block", iso(occurred), iso(occurred), status, corr, emoji, "site_ridgeline"),
        )
    conn.execute(
        """INSERT INTO concern_response (id,concern_id,author_id,org_id,role,kind,body,created_at)
           VALUES ('cr_001','cn_003','usr_reg','org_draqa','regulator','acknowledge',
                   'Received. We are pulling the Boxtown reference station record for that window.', ?)""",
        (iso(now - timedelta(hours=8)),),
    )
    conn.execute(
        """INSERT INTO concern_response (id,concern_id,author_id,org_id,role,kind,body,created_at)
           VALUES ('cr_002','cn_001','usr_ind','org_ridgeline','industry','mitigation',
                   'Ridgeline South Campus: we have moved the evening turbine test window to daytime hours.', ?)""",
        (iso(now - timedelta(hours=5)),),
    )
    conn.execute("UPDATE concern SET status='mitigation_proposed' WHERE id='cn_001'")
    conn.execute(
        "INSERT INTO concern_corroboration (concern_id,user_id,created_at) VALUES ('cn_001','usr_marcus',?)",
        (iso(now - timedelta(hours=5, minutes=30)),),
    )

    # ── industry posts + a mitigation ────────────────────────────────────────
    conn.execute(
        """INSERT INTO site_post (id,campaign_id,site_id,org_id,author_id,kind,title,body,concern_id,
                                  media_emoji,pinned,created_at)
           VALUES ('sp_001',?, 'site_ridgeline','org_ridgeline','usr_ind','intro',
                   'Hello from Ridgeline South Campus',
                   'We operate the compute campus on Weaver Rd. This page is where we will post what we are doing about air quality in the neighbourhood.',
                   NULL,'👋',1,?)""",
        (CAMPAIGN_ID, iso(now - timedelta(days=9))),
    )
    conn.execute(
        """INSERT INTO site_post (id,campaign_id,site_id,org_id,author_id,kind,title,body,concern_id,
                                  media_emoji,pinned,created_at)
           VALUES ('sp_002',?, 'site_ridgeline','org_ridgeline','usr_ind','mitigation',
                   'Evening turbine tests moved to daytime',
                   'We heard the reports about evening noise and smell. Turbine test windows are moving to 10am-2pm starting this week.',
                   'cn_001','🛠️',0,?)""",
        (CAMPAIGN_ID, iso(now - timedelta(hours=5))),
    )
    conn.execute(
        """INSERT INTO mitigation (id,site_id,concern_id,cluster_id,alert_id,title,body,status,measure,
                                   expected_reduction_pct,started_at,completed_at,created_at)
           VALUES ('mi_001','site_ridgeline','cn_001',NULL,NULL,
                   'Move turbine test window to daytime',
                   'Shifts the NO2 peak out of the evening hours residents are reporting.',
                   'in_progress','no2',25.0,?,NULL,?)""",
        (iso(now - timedelta(hours=5)), iso(now - timedelta(hours=5))),
    )

    # ── regulator: an advisory + an enforcement action ────────────────────────
    conn.execute(
        """INSERT INTO advisory (id,campaign_id,org_id,author_id,kind,severity,title,body,measure,
                                 alert_id,audience_json,created_at,expires_at,pinned)
           VALUES ('ad_001',?, 'org_draqa','usr_reg','notice','info',
                   'What our monitors are showing this week',
                   'Levels around the neighbourhood have been close to normal this week, with a few higher evenings on the east side. We will post again if that changes.',
                   NULL,NULL,'["community"]',?,NULL,1)""",
        (CAMPAIGN_ID, iso(now - timedelta(days=2))),
    )
    conn.execute(
        """INSERT INTO enforcement_action (id,campaign_id,site_id,org_id,kind,status,title,body,
                                           alert_id,created_at,due_at,closed_at)
           VALUES ('ea_001',?, 'site_ridgeline','org_draqa','request_for_info','open',
                   'Request for turbine test logs',
                   'Provide generator run logs for the last 14 days of evening hours.',
                   NULL,?,?,NULL)""",
        (CAMPAIGN_ID, iso(now - timedelta(days=3)), iso(now + timedelta(days=11))),
    )

    # ── two pre-existing alerts so the RWR is not empty on first load ────────
    conn.execute(
        """INSERT INTO alert (id,campaign_id,kind,severity,measure,value,threshold,unit,source_type,
                              source_id,lon,lat,site_id,action_level_id,started_at,ended_at,status,
                              title,body,recommendation,audience_json,created_at)
           VALUES ('al_seed_1',?, 'exceedance','warning','no2',68.4,60.0,'ppb','monitor',
                   'mon_ridge_east',?,?, 'site_ridgeline','al_no2_spike',?,NULL,'active',
                   'NO2 over NO2 1-hour action level at Ridgeline Fenceline East',
                   'NO2 reached 68.4 ppb against a 60 ppb spike action level, 520 m E of Ridgeline South Campus.',
                   'Throttle Turbine Bank A and B and confirm with the fenceline ring.',
                   '["regulator","industry","admin","community"]',?)""",
        (CAMPAIGN_ID, east[0], east[1], iso(now - timedelta(hours=3)), iso(now - timedelta(hours=3))),
    )
    for i in range(10):
        conn.execute(
            "INSERT OR REPLACE INTO alert_sample (alert_id,ts,value) VALUES ('al_seed_1',?,?)",
            (iso(now - timedelta(hours=12 - i)), round(38 + i * 3.2, 2)),
        )
    conn.execute(
        """INSERT INTO alert (id,campaign_id,kind,severity,measure,value,threshold,unit,source_type,
                              source_id,lon,lat,site_id,action_level_id,started_at,ended_at,status,
                              title,body,recommendation,audience_json,created_at)
           VALUES ('al_seed_2',?, 'concern_cluster','watch',NULL,3.0,3.0,'reports','community',
                   'cl_seed',?,?, 'site_ridgeline',NULL,?,NULL,'active',
                   'Community concern cluster · 3 reports',
                   '3 community reports (health, noise, smell) within 320 m over 24 h, SE of Ridgeline South Campus.',
                   'Check generator logs for the reported window and post an acknowledgement.',
                   '["industry","regulator","admin"]',?)""",
        (CAMPAIGN_ID, clon, clat, iso(now - timedelta(hours=6)), iso(now - timedelta(hours=6))),
    )
    conn.execute(
        """INSERT INTO concern_cluster (id,campaign_id,label,centroid_lon,centroid_lat,radius_m,count,
                                        kinds_json,first_at,last_at,status,site_id)
           VALUES ('cl_seed',?, '3 reports · Boxtown',?,?,320.0,3,'["health","noise","smell"]',?,?,'active','site_ridgeline')""",
        (CAMPAIGN_ID, clon, clat, iso(now - timedelta(hours=15)), iso(now - timedelta(hours=6))),
    )
    conn.execute("INSERT INTO alert_ack (alert_id,user_id,note,created_at) VALUES ('al_seed_2','usr_ind','Looking at it.',?)",
                 (iso(now - timedelta(hours=4)),))

    # ── activity seed ────────────────────────────────────────────────────────
    for verb, obj_type, obj_id, summary, role in [
        ("campaign.created", "campaign", CAMPAIGN_ID, "Campaign created", "admin"),
        ("concern.created", "concern", "cn_001", "Chemical smell again after dark", "community"),
        ("alert.created", "alert", "al_seed_1", "NO2 over action level at Ridgeline Fenceline East", "regulator"),
        ("mitigation.created", "mitigation", "mi_001", "Move turbine test window to daytime", "industry"),
    ]:
        conn.execute(
            """INSERT INTO activity (campaign_id,ts,actor_role,actor_id,verb,object_type,object_id,summary,payload_json)
               VALUES (?,?,?,NULL,?,?,?,?,NULL)""",
            (CAMPAIGN_ID, iso(now - timedelta(hours=20)), role, verb, obj_type, obj_id, summary),
        )

    conn.execute("INSERT OR REPLACE INTO setting (key,value) VALUES ('fixture','smoketest')")
    conn.commit()

    counts = {
        t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in ("campaign", "road_segment", "segment_stat", "segment_pass", "monitor",
                  "monitor_reading", "industry_site", "emission_point", "concern",
                  "concern_response", "concern_cluster", "alert", "advisory", "site_post",
                  "mitigation", "action_level", "wind", "vehicle", "drive", "vehicle_ping",
                  "drive_plan", "drive_route", "activity", "org", "app_user", "measure_def",
                  "mobile_wind_obs", "dispersion_model", "dispersion_model_contour")
    }
    conn.close()
    print(f"seeded {path}")
    for k, v in counts.items():
        print(f"  {k:22s} {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
