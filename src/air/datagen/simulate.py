"""Step 5 -- turn the drive plan and the field into measurements.

Two producers, both reading the *same* hourly field so the mobile and stationary
records agree with each other.  That agreement is the demo's whole credibility: the
regulator screen compares its towers against our fleet, and the numbers have to be
consistent or the comparison is theatre.

`segment_passes`  -- one row per vehicle traverse of one segment, sampled at the
                     segment midpoint at the moment the vehicle crossed it, with
                     mobile-platform instrument noise and occasional dropouts.
`monitor_readings`-- hourly per monitor per measure, sampled at the monitor
                     location, with **grade-appropriate** error: reference nodes are
                     tight and unbiased, low-cost nodes are noisy and drift.

Passes for drives still in progress at `world.now` are truncated at `now` -- the
database must not contain measurements from the future.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta

import numpy as np

from .measures import INDICATORS, MODALITIES

# Mobile platform 1-Hz-averaged precision: (absolute, relative) 1-sigma.
MOBILE_NOISE = {
    "no2": (0.75, 0.045),
    "pm25": (0.55, 0.055),
    "bc": (0.030, 0.075),
    "o3": (1.10, 0.035),
    "co": (0.014, 0.045),
    "co2": (1.40, 0.0030),
    "ch4": (0.0075, 0.010),
}
PASS_DROP_RATE = 0.003      # whole traverse lost (GPS gap, filter change)
MEASURE_DROP_RATE = 0.0035  # single modality invalidated by QC

# Stationary noise by grade: (absolute, relative, drift_amplitude_relative)
MONITOR_NOISE = {
    "reference": (0.35, 0.020, 0.010),
    "fem": (0.60, 0.035, 0.020),
    "lowcost": (1.40, 0.115, 0.085),
}


def segment_passes(world, segments, field, drive_days, campaign_id: str):
    """Yield `segment_pass` row tuples, sampling the field per hour."""
    cols = (
        "campaign_id", "segment_id", "drive_id", "vehicle_id", "ts",
        *MODALITIES, *INDICATORS, "speed_kph", "sampling_mode",
    )
    # Inherited from the drive, not re-derived. Which stratum a pass falls into
    # is geometry and stays computed at analysis time; why the car was sent is
    # a fact about the dispatch that is known once and unrecoverable after.
    mode_of = {
        p.drive_id: d.sampling_mode for d in drive_days for p in d.passes
    }
    start = world.start
    now = world.now
    rng = np.random.default_rng(world.seed + 4242)

    # bucket every pass by campaign hour index
    buckets: dict[int, list] = {}
    for d in drive_days:
        for p in d.passes:
            if p.ts > now:
                continue
            h = int((p.ts - start).total_seconds() // 3600)
            if h < 0 or h >= field.n_hours:
                continue
            buckets.setdefault(h, []).append(p)

    rows = []
    for h in sorted(buckets):
        evs = buckets[h]
        idx = np.array([e.seg_idx for e in evs])
        lons = np.array([segments[i].mid_lon for i in idx])
        lats = np.array([segments[i].mid_lat for i in idx])
        vals = field.sample(h, lons, lats)
        n = len(evs)
        noisy = {}
        for m in MODALITIES:
            a, r = MOBILE_NOISE[m]
            v = vals[m] + rng.normal(0.0, 1.0, n) * (a + r * np.abs(vals[m]))
            floor = 0.0 if m not in ("co2", "ch4") else (390.0 if m == "co2" else 1.70)
            noisy[m] = np.maximum(floor, v)
        # indicators are recomputed from the *noisy* modalities, as in the real
        # pipeline: they are products of the calibrated measurements, not of truth
        from .field import derive_indicators

        noisy = derive_indicators(noisy)
        keep = rng.random(n) >= PASS_DROP_RATE
        drop = rng.random((n, len(MODALITIES) + len(INDICATORS))) < MEASURE_DROP_RATE
        order = list(MODALITIES) + list(INDICATORS)
        for j, e in enumerate(evs):
            if not keep[j]:
                continue
            vv = []
            for k, m in enumerate(order):
                vv.append(None if drop[j, k] else round(float(noisy[m][j]), 4))
            rows.append(
                (
                    campaign_id,
                    segments[e.seg_idx].id,
                    e.drive_id,
                    e.vehicle_id,
                    e.ts.isoformat(timespec="seconds"),
                    *vv,
                    e.speed_kph,
                    mode_of.get(e.drive_id, "uniform"),
                )
            )
    return cols, rows


def monitor_readings(world, field, campaign_id: str):
    """Hourly readings for every monitor, with grade-appropriate error."""
    rng = np.random.default_rng(world.seed + 8080)
    mons = world.monitors
    lons = np.array([m["lon"] for m in mons])
    lats = np.array([m["lat"] for m in mons])
    measures = [json.loads(m["measures_json"]) for m in mons]
    grades = [m["grade"] for m in mons]
    # per-monitor, per-measure slow calibration drift (a sine with a random phase)
    phase = rng.uniform(0, 2 * math.pi, (len(mons), 8))
    period = rng.uniform(280.0, 900.0, (len(mons), 8))
    # offline / degraded behaviour
    offline_from = {}
    for i, m in enumerate(mons):
        if m["status"] == "offline":
            offline_from[i] = int(field.n_hours * 0.62)  # failed partway through

    rows = []
    n_h = field.n_hours
    for h in range(n_h):
        ts = (world.start + timedelta(hours=h)).isoformat(timespec="seconds")
        if world.start + timedelta(hours=h) > world.now:
            break
        vals = field.sample(h, lons, lats)
        for i, m in enumerate(mons):
            if i in offline_from and h >= offline_from[i]:
                continue
            a, r, dr = MONITOR_NOISE[grades[i]]
            for k, code in enumerate(measures[i]):
                truth = float(vals[code][i])
                drift = 1.0 + dr * math.sin(2 * math.pi * h / period[i, k % 8] + phase[i, k % 8])
                v = truth * drift + rng.normal(0.0, 1.0) * (a + r * abs(truth))
                if code == "co2":
                    v = max(390.0, v)
                elif code == "ch4":
                    v = max(1.70, v)
                else:
                    v = max(0.0, v)
                qc = "valid"
                if m["status"] == "degraded" and rng.random() < 0.045:
                    qc = "suspect"
                elif grades[i] == "lowcost" and rng.random() < 0.012:
                    qc = "suspect"
                rows.append((m["id"], ts, code, round(v, 4), qc))
    return ("monitor_id", "ts", "measure", "value", "qc"), rows


def drive_rows(world, drive_days, plan_id: str, campaign_id: str):
    """`drive` rows plus decimated `vehicle_ping` rows."""
    from .driveplan import PING_RECENT_DAYS, PING_STORE_OLD_S, PING_STORE_RECENT_S

    drives = []
    pings = []
    recent_cut = world.now - timedelta(days=PING_RECENT_DAYS)
    for d in drive_days:
        vid = world.vehicles[d.vehicle_idx]["id"]
        did = f"drv-{d.the_date.isoformat()}-{world.vehicles[d.vehicle_idx]['label']}"
        ended = None if d.status in ("in_progress", "planned") else d.end.isoformat(timespec="seconds")
        covered = len(set(d.seg_sequence))
        drives.append(
            {
                "id": did,
                "campaign_id": campaign_id,
                "plan_id": plan_id,
                "route_id": f"rt-{d.day_index:03d}-{world.vehicles[d.vehicle_idx]['label']}",
                "vehicle_id": vid,
                "date": d.the_date.isoformat(),
                "started_at": d.start.isoformat(timespec="seconds"),
                "ended_at": ended,
                "status": {"planned": "planned", "in_progress": "in_progress"}.get(d.status, "complete"),
                "distance_m": round(d.distance_m, 1),
                "segments_covered": covered,
                "geometry_json": json.dumps(
                    [[round(x, 6), round(y, 6)] for x, y in _thin(d.geometry, 8)]
                ),
                "sampling_mode": d.sampling_mode,
            }
        )
        if d.status == "planned":
            continue
        step = PING_STORE_RECENT_S if d.start >= recent_cut else PING_STORE_OLD_S
        keep_every = max(1, int(round(step / PING_STORE_RECENT_S)))
        for k, p in enumerate(d.pings):
            if k % keep_every:
                continue
            pings.append(
                (
                    did,
                    p.ts.isoformat(timespec="seconds"),
                    round(p.lon, 6),
                    round(p.lat, 6),
                    p.speed_kph,
                    p.heading_deg,
                    None if p.seg_idx is None else p.seg_idx,
                )
            )
    return drives, pings


def route_rows(world, drive_days, plan_id: str, campaign_id: str, segments):
    rows = []
    for d in drive_days:
        rows.append(
            {
                "id": f"rt-{d.day_index:03d}-{world.vehicles[d.vehicle_idx]['label']}",
                "plan_id": plan_id,
                "campaign_id": campaign_id,
                "vehicle_id": world.vehicles[d.vehicle_idx]["id"],
                "day_index": d.day_index,
                "date": d.the_date.isoformat(),
                "shift": d.shift,
                "segment_ids_json": json.dumps([segments[i].id for i in d.seg_sequence]),
                "geometry_json": json.dumps(
                    [[round(x, 6), round(y, 6)] for x, y in _thin(d.geometry, 4)]
                ),
                "distance_m": round(d.distance_m, 1),
                "duration_min": round(d.duration_min, 1),
                "est_passes": len(d.seg_sequence),
            }
        )
    return rows


def vehicle_status(world, drive_days) -> dict[str, str]:
    """What each car is doing at `world.now` -- drives the live fleet layer."""
    status = {v["id"]: "idle" for v in world.vehicles}
    charging = set()
    for d in drive_days:
        vid = world.vehicles[d.vehicle_idx]["id"]
        if d.status == "in_progress":
            status[vid] = "driving"
        elif d.the_date == world.now.date() and d.status == "complete":
            charging.add(vid)
    for vid in charging:
        if status[vid] == "idle":
            status[vid] = "charging"
    # one car is always in the shop; it reads as a real fleet
    spare = [v["id"] for v in world.vehicles if status[v["id"]] == "idle"]
    if spare:
        status[spare[-1]] = "maintenance"
    return status


def _thin(coords, every: int):
    if len(coords) <= 2 or every <= 1:
        return coords
    out = coords[::every]
    if out[-1] != coords[-1]:
        out = list(out) + [coords[-1]]
    return out
