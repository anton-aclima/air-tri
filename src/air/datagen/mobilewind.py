"""Step 6b -- observed street-level wind, and the consultant's dispersion study.

Two halves of one argument (CONTRACT.md 8b, "Verify your consultant"):

`mobile_wind_obs`
    Anemometry from the fleet, one observation per segment traversal, already
    corrected for vehicle motion.  This is **not** a copy of the regional `wind`
    row for that hour.  Street-level wind differs from the 10 m regional wind in
    ways that are physically specific, and all of them are modelled here:

    * **Street-canyon channelling.**  Flow turns toward the street axis and slows.
      Strength scales with the canyon aspect ratio, which we proxy from OSM road
      class: a residential street channels hard, a motorway barely at all.
    * **Industrial wakes.**  Within ~450 m of a large industrial parcel the flow is
      slowed and veered by building wake, with the sign of the veer set by which
      side of the obstacle you are on.
    * **Low-wind scatter.**  Direction variance goes as roughly 1/u: below ~1 m/s
      the direction is close to meaningless, which is exactly why `quality` exists.
    * **Turbulence and gusts.**

    `quality` is honest rather than flattering: `suspect` when the wind was calm or
    the vehicle was fast (motion correction dominates the signal), `rejected` for
    the occasional blocked or iced inlet.  The UI must be able to filter these out;
    it must not pretend they are not there.

`dispersion_model` / `dispersion_model_contour`
    One consultant deliverable per industry site, seeded **deliberately imperfect**
    in a specific and defensible way.  The assumed rose is derived from the true
    regional rose by three distortions a real short-record off-site study makes:

    1. rotated clockwise (an off-site station with different local channelling),
    2. the whole northern half of the rose compressed by `NORTH_SUPPRESS`,
    3. smoothed into a tidy unimodal shape.

    The contour polygons are then computed **from that assumed rose**, using the
    same Gaussian-plume physics as `field.py`: a frequency-weighted sum over the 16
    sectors, contoured at fixed design levels.  So the polygons are genuinely
    consistent with the assumed rose and genuinely inconsistent with what the fleet
    measured -- nothing about the disagreement is hardcoded.  Recompute the observed
    rose from `mobile_wind_obs`, compare it to `assumed_wind_json`, and the mismatch
    is there in the numbers.

    The `wind_shift` episode in `weather.py` is what makes it visible inside one
    week: the wind backs SSW -> W -> NW -> NNE, the northern-half frequency the study
    suppressed spikes, and observed transport sweeps across districts the contour
    never reaches.
"""

from __future__ import annotations

import json
import math

import numpy as np

from .geo import chaikin, concave_hull, douglas_peucker, polygon_geojson, trace_outline
from .network import ROAD_SPEED_KPH  # noqa: F401
from .noise import box_blur, fbm3


def wx_shift_start(n_days: float) -> float:
    from .weather import SHIFT_START_DAY_FROM_END
    return float(SHIFT_START_DAY_FROM_END)


def wx_shift_days() -> float:
    from .weather import SHIFT_DAYS
    return float(SHIFT_DAYS)

# ---------------------------------------------------------------- tunables

# Street-canyon channelling strength by OSM class: 0 = open country, 1 = deep canyon.
CANYON = {
    "motorway": 0.06,
    "trunk": 0.10,
    "primary": 0.18,
    "secondary": 0.24,
    "tertiary": 0.34,
    "unclassified": 0.40,
    "residential": 0.52,
    "living_street": 0.60,
}
CANYON_DRAG = 0.34        # max fractional speed loss from canyon walls
WAKE_RADIUS_M = 450.0     # industrial building-wake influence radius
WAKE_SLOW = 0.38          # max fractional speed loss in a wake
WAKE_VEER_DEG = 34.0      # max direction veer in a wake
SCATTER_BASE_DEG = 6.0
SCATTER_CALM_DEG = 34.0   # scatter ~ SCATTER_BASE + SCATTER_CALM / u
CALM_SUSPECT_MS = 1.3     # below this the direction is not trustworthy
FAST_SUSPECT_KPH = 52.0   # above this the motion correction dominates
REJECT_RATE = 0.004
# One observation per segment traversal is already a 3x decimation of the GPS ping
# stream; halve it again. The decimation is deliberately **uniform in time**: an
# episode-weighted sample would inflate the northerly frequency in the observed rose
# and the model-verification divergence has to come from the study's distortion, not
# from how we chose to store rows.
DECIMATE = 2

ROSE_BINS = 16
ROSE_LABELS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
               "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
NORTH_SECTORS = ["NW", "NNW", "N", "NNE", "NE"]  # the half the study suppressed

# Consultant-study distortions.
ASSUMED_ROTATE_DEG = -24.0   # clockwise rotation of the assumed rose
NORTH_SUPPRESS = 0.34        # northern-half frequencies multiplied by this
ASSUMED_SMOOTH_PASSES = 2


# ---------------------------------------------------------------- observations


def _bin_of(dir_deg) -> np.ndarray:
    step = 360.0 / ROSE_BINS
    return (((np.asarray(dir_deg) + step / 2.0) % 360.0) / step).astype(int)


def rose_from_dirs(dirs, speeds=None) -> list[dict]:
    """16-sector wind rose: [{dir_deg, label, freq, mean_speed_ms, n}, ...]."""
    dirs = np.asarray(dirs, dtype=float)
    b = _bin_of(dirs)
    n = max(1, len(dirs))
    out = []
    for i in range(ROSE_BINS):
        m = b == i
        cnt = int(m.sum())
        ms = float(np.mean(np.asarray(speeds)[m])) if (speeds is not None and cnt) else None
        out.append(
            {
                "dir_deg": round(i * 360.0 / ROSE_BINS, 1),
                "label": ROSE_LABELS[i],
                "freq": round(cnt / n, 5),
                "mean_speed_ms": None if ms is None else round(ms, 2),
                "n": cnt,
            }
        )
    return out


def observations(world, segments, graph, wind, drive_days, campaign_id: str):
    """One `mobile_wind_obs` row per segment traversal."""
    proj = world.proj
    rng = np.random.default_rng(world.seed + 777)

    # large industrial parcels, for building wakes
    big = [p for p in world.parcels if p.area_m2 > 8.0e4]
    wx = np.array([proj.xy(*p.centroid)[0] for p in big]) if big else np.zeros(0)
    wy = np.array([proj.xy(*p.centroid)[1] for p in big]) if big else np.zeros(0)

    seg_xy = np.array([proj.xy(s.mid_lon, s.mid_lat) for s in segments])
    seg_axis = np.array([s.bearing_deg % 180.0 for s in segments])
    seg_canyon = np.array([CANYON.get(s.road_class, 0.4) for s in segments])

    # per-segment wake influence, precomputed once
    if big:
        d = np.hypot(seg_xy[:, None, 0] - wx[None, :], seg_xy[:, None, 1] - wy[None, :])
        j = np.argmin(d, axis=1)
        dmin = d[np.arange(len(segments)), j]
        wake = np.clip(1.0 - dmin / WAKE_RADIUS_M, 0.0, 1.0)
        wake_side = np.sign(
            (seg_xy[:, 0] - wx[j]) * 1.0 - (seg_xy[:, 1] - wy[j]) * 0.0
        )
        wake_side = np.where(wake_side == 0, 1.0, wake_side)
    else:
        wake = np.zeros(len(segments))
        wake_side = np.ones(len(segments))

    cols = (
        "campaign_id", "drive_id", "vehicle_id", "segment_id", "ts", "lon", "lat",
        "speed_ms", "dir_deg", "gust_ms", "vehicle_speed_kph", "quality",
    )
    rows = []
    start = world.start
    now = world.now
    n_h = len(wind)
    kept = 0
    for d in drive_days:
        vid = world.vehicles[d.vehicle_idx]["id"]
        for pi, p in enumerate(d.passes):
            if p.ts > now:
                continue
            h = int((p.ts - start).total_seconds() // 3600)
            if h < 0 or h >= n_h:
                continue
            if kept % DECIMATE:
                kept += 1
                continue
            kept += 1
            w = wind[h]
            si = p.seg_idx
            s = segments[si]
            u0 = w.speed_ms
            dir0 = w.dir_deg

            # --- street-canyon channelling: turn toward the nearer street axis
            axis = seg_axis[si]
            cand = (axis, (axis + 180.0) % 360.0)
            trans = (dir0 + 180.0) % 360.0
            diffs = [abs(((c - trans + 180.0) % 360.0) - 180.0) for c in cand]
            along = cand[0] if diffs[0] <= diffs[1] else cand[1]
            dev = ((along - trans + 180.0) % 360.0) - 180.0
            ch = seg_canyon[si] * (1.0 - abs(dev) / 180.0) ** 0.35
            trans_c = trans + dev * ch
            # cross-canyon flow is braked more than along-canyon flow
            u = u0 * (1.0 - CANYON_DRAG * seg_canyon[si] * (abs(dev) / 90.0 if abs(dev) < 90 else 1.0))

            # --- industrial building wake
            if wake[si] > 0.02:
                u *= 1.0 - WAKE_SLOW * wake[si]
                trans_c += WAKE_VEER_DEG * wake[si] * wake_side[si]

            # --- turbulence: scatter grows as the wind drops
            sd = SCATTER_BASE_DEG + SCATTER_CALM_DEG / max(0.6, u0)
            trans_c += rng.normal(0.0, sd)
            u = max(0.15, u * float(rng.normal(1.0, 0.16)))
            gust = u * (1.35 + 0.5 * abs(float(rng.normal(0.0, 1.0)))) + 0.2

            obs_dir = (trans_c + 180.0) % 360.0
            q = "good"
            if rng.random() < REJECT_RATE:
                q = "rejected"
            elif u0 < CALM_SUSPECT_MS or u < 0.55 or p.speed_kph > FAST_SUSPECT_KPH:
                q = "suspect"
            rows.append(
                (
                    campaign_id, p.drive_id, vid, s.id,
                    p.ts.isoformat(timespec="seconds"),
                    round(s.mid_lon, 6), round(s.mid_lat, 6),
                    round(u, 2), round(obs_dir, 1), round(gust, 2),
                    p.speed_kph, q,
                )
            )
    return cols, rows


def observed_rose(rows, cols, *, quality=("good",)) -> list[dict]:
    ci = {c: i for i, c in enumerate(cols)}
    dirs, sp = [], []
    for r in rows:
        if r[ci["quality"]] in quality:
            dirs.append(r[ci["dir_deg"]])
            sp.append(r[ci["speed_ms"]])
    return rose_from_dirs(dirs, sp)


# ---------------------------------------------------------------- the study


def _assumed_rose(true_rose: list[dict]) -> list[dict]:
    """Distort a true rose the way a short-record off-site study distorts it."""
    freq = np.array([b["freq"] for b in true_rose], dtype=float)
    spd = np.array([b["mean_speed_ms"] or 3.0 for b in true_rose], dtype=float)

    # 1. rotate (an off-site station with different channelling)
    step = 360.0 / ROSE_BINS
    shift = ASSUMED_ROTATE_DEG / step
    idx = (np.arange(ROSE_BINS) - shift) % ROSE_BINS
    lo = np.floor(idx).astype(int) % ROSE_BINS
    hi = (lo + 1) % ROSE_BINS
    t = idx - np.floor(idx)
    freq = freq[lo] * (1 - t) + freq[hi] * t
    spd = spd[lo] * (1 - t) + spd[hi] * t

    # 2. suppress the northern half -- the record was a single winter quarter and
    #    the northerly regime that matters here is simply not in it
    for i, lab in enumerate(ROSE_LABELS):
        if lab in NORTH_SECTORS:
            freq[i] *= NORTH_SUPPRESS

    # 3. idealise into a tidy unimodal rose
    for _ in range(ASSUMED_SMOOTH_PASSES):
        freq = 0.25 * np.roll(freq, 1) + 0.5 * freq + 0.25 * np.roll(freq, -1)
    freq = freq / max(1e-9, freq.sum())
    spd = np.clip(spd * 1.12, 1.5, 9.0)  # models like a brisker, tidier wind
    return [
        {
            "dir_deg": round(i * step, 1),
            "label": ROSE_LABELS[i],
            "freq": round(float(freq[i]), 5),
            "mean_speed_ms": round(float(spd[i]), 2),
        }
        for i in range(ROSE_BINS)
    ]


class _StudyWind:
    """Minimal stand-in for a `WindHour`, so we can reuse FieldModel._plume."""

    def __init__(self, dir_deg, speed_ms, stability="D", pbl_m=800.0):
        self.dir_deg = dir_deg
        self.speed_ms = speed_ms
        self.stability = stability
        self.pbl_m = pbl_m

    @property
    def transport_deg(self):
        return (self.dir_deg + 180.0) % 360.0


def _rose_weighted_field(field, site, rose) -> np.ndarray:
    """Frequency-weighted plume sum over the assumed rose, on the field raster."""
    n = field.grid_n
    acc = np.zeros((n, n))
    pts = [
        (p, *field.proj.xy(p.lon, p.lat))
        for p in site.points
        if p.strength.get("nox")
    ]
    for b in rose:
        if b["freq"] <= 1e-4:
            continue
        w = _StudyWind(b["dir_deg"], max(1.2, b["mean_speed_ms"] or 3.0))
        tmp = np.zeros((n, n))
        for p, px, py in pts:
            field._plume(tmp, px, py, p.height_m, p.kind, w, 0.0, p.strength["nox"])
        acc += tmp * b["freq"]
    return box_blur(acc, 2)


def _contours(field, raster, levels, max_scaled_to: float):
    """Polygon rings for each level, largest connected blob only."""
    peak = float(raster.max())
    if peak <= 0:
        return []
    scaled = raster * (max_scaled_to / peak)
    out = []
    for band, lv in enumerate(levels):
        mask = scaled >= lv
        if mask.sum() < 12:
            continue
        from .geo import fill_holes, largest_component

        mask = fill_holes(largest_component(mask))
        outline = trace_outline(mask)
        if len(outline) < 6:
            continue
        ring_m = [
            (field.x0 + (c + 0.5) * field.cell, field.y0 + (r + 0.5) * field.cell)
            for (r, c) in outline
        ]
        ring = [field.proj.lonlat(x, y) for x, y in ring_m]
        ring = douglas_peucker(ring, 55.0 / 110540.0)
        if len(ring) > 3 and ring[0] == ring[-1]:
            ring = ring[:-1]
        if len(ring) < 4:
            continue
        ring = chaikin(ring, 2)
        out.append((band, lv, ring))
    return out


# vendor, study name suffix, measure, averaging hours, design peak (measure units),
# contour levels, notes
STUDY_SPECS = {
    "site-ridgeline": (
        "Cypress Ridge Environmental LLC",
        "Phase 1 Air Dispersion Modelling Report",
        "no2",
        1.0,
        68.0,
        [42.0, 28.0, 18.0, 11.0],
        "AERMOD 23132, flat terrain, rural dispersion. Meteorology: 90-day surface "
        "record from Memphis International (KMEM), 18 km ENE, Q1 of the preceding "
        "year, upper air from Little Rock. On-site meteorology was not available at "
        "the time of the application. Receptor grid 100 m to 3 km. Turbine emissions "
        "per vendor guarantee at 100 % load, 24 units, no simultaneous diesel "
        "operation assumed. Results are 1-hour design concentrations (98th "
        "percentile). Applicant is advised that a single-quarter meteorological "
        "record may not represent the annual wind distribution and that the "
        "north-westerly through northerly regime is under-represented in this "
        "dataset; a full year of on-site data is recommended before Phase 2.",
    ),
    "site-deltaforge": (
        "Cypress Ridge Environmental LLC",
        "Title V Renewal Dispersion Screening",
        "pm25",
        24.0,
        21.0,
        [13.0, 9.0, 6.0],
        "AERMOD screening run supporting Title V renewal. Meteorology: 5-year KMEM "
        "surface record. Furnace stacks only; fugitive scrap-yard and gate emissions "
        "were not modelled. 24-hour averaging.",
    ),
    "site-riverport": (
        "Marsh & Kettering Consulting Engineers",
        "Intermodal Expansion Air Quality Assessment",
        "bc",
        1.0,
        3.4,
        [2.1, 1.4, 0.85],
        "CALPUFF screening of yard and gate diesel activity for the proposed third "
        "gate. Emission factors from EMFAC-equivalent drayage fleet mix, model year "
        "2019 average. Idling time assumed at 4 minutes per move; observed idling "
        "was not measured.",
    ),
}


def dispersion_models(world, field, true_rose, campaign_id: str):
    """One consultant study per site, plus its contour polygons."""
    models = []
    contours = []
    from datetime import timedelta

    for site in world.sites:
        spec = STUDY_SPECS.get(site.id)
        if not spec:
            continue
        vendor, name, measure, avg_h, peak, levels, notes = spec
        assumed = _assumed_rose(true_rose)
        mid = f"dm-{site.id.replace('site-', '')}-{measure}"
        raster = _rose_weighted_field(field, site, assumed)
        polys = _contours(field, raster, levels, peak)
        models.append(
            {
                "id": mid,
                "site_id": site.id,
                "campaign_id": campaign_id,
                "name": f"{site.row['name']} — {name}",
                "vendor": vendor,
                "method": "CALPUFF" if "CALPUFF" in notes else "AERMOD",
                "measure": measure,
                "averaging_hours": avg_h,
                "issued_at": (world.start - timedelta(days=118)).isoformat(timespec="seconds"),
                "assumed_wind_json": json.dumps(assumed),
                "notes": notes,
                # The filed study. An `aclima` row is computed from the observed
                # rose at request time rather than generated, because it has to
                # move when the fleet measures more wind.
                "model_tier": "permit",
            }
        )
        for band, lv, ring in polys:
            contours.append(
                {
                    "model_id": mid,
                    "band": band,
                    "level": lv,
                    "geometry_json": json.dumps(
                        polygon_geojson(
                            ring,
                            {
                                "model_id": mid,
                                "band": band,
                                "level": lv,
                                "measure": measure,
                                "unit": "ppb" if measure in ("no2", "o3") else "ug/m3",
                            },
                        )
                    ),
                }
            )
    return models, contours


def episode_hours(n_hours: int) -> tuple[int, int]:
    """The scripted `wind_shift` window, as campaign hour indices."""
    from .weather import SHIFT_DAYS, SHIFT_START_DAY_FROM_END

    n_days = n_hours / 24.0
    h0 = int((n_days - SHIFT_START_DAY_FROM_END) * 24)
    return h0, h0 + int((SHIFT_DAYS + 2) * 24)


def verification_numbers(world, assumed, observed, wind, obs_rows=None, obs_cols=None) -> dict:
    """The arithmetic behind `GET /sites/{id}/model-verification`, for the report."""
    a = {b["label"]: b["freq"] for b in assumed}
    o = {b["label"]: b["freq"] for b in observed}
    north_a = sum(a.get(k, 0.0) for k in NORTH_SECTORS)
    north_o = sum(o.get(k, 0.0) for k in NORTH_SECTORS)
    sw_a = sum(a.get(k, 0.0) for k in ("SSW", "SW", "WSW"))
    sw_o = sum(o.get(k, 0.0) for k in ("SSW", "SW", "WSW"))
    per_bearing = {
        lab: round(o.get(lab, 0.0) - a.get(lab, 0.0), 4) for lab in ROSE_LABELS
    }
    understated = [lab for lab, d in per_bearing.items() if d > 0.02]
    episode = None
    if obs_rows is not None and obs_cols is not None:
        ci = {c: i for i, c in enumerate(obs_cols)}
        h0, h1 = episode_hours(len(wind))
        t0 = (world.start + __import__("datetime").timedelta(hours=h0)).isoformat()
        t1 = (world.start + __import__("datetime").timedelta(hours=h1)).isoformat()
        ed = [r[ci["dir_deg"]] for r in obs_rows
              if r[ci["quality"]] == "good" and t0 <= r[ci["ts"]] <= t1]
        if ed:
            er = {b["label"]: b["freq"] for b in rose_from_dirs(ed)}
            episode = {
                "hours": [h0, h1],
                "n_obs": len(ed),
                "north_half_observed": round(sum(er.get(k, 0.0) for k in NORTH_SECTORS), 4),
            }
    return {
        "episode": episode,
        "north_half_assumed": round(north_a, 4),
        "north_half_observed": round(north_o, 4),
        "north_ratio_observed_over_assumed": round(north_o / max(1e-6, north_a), 2),
        "sw_assumed": round(sw_a, 4),
        "sw_observed": round(sw_o, 4),
        "per_bearing_bias": per_bearing,
        "understated_sectors": understated,
    }
