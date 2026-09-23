"""Forward-looking weather whose error is MEASURED, not chosen.

WHY THIS IS NOT THREE TIERS
---------------------------
The first design invented `climatology` / `regional` / `aclima` forecast tiers
whose relative skill was a noise scale someone picked, and then shipped a
verification ledger that reported that choice back as though it were a finding.
It existed largely to feed a paywall narrative, and the paywall was cut. What
remained was a circular claim with a warning label on it.

Persistence and climatology are both computable from data already shipped, and
blending them gives a forecast with genuinely measured error. On this
campaign's own record, direction MAE:

    lead      6 h    12 h    24 h    48 h    72 h    96 h   120 h
    persist   4.8     9.3    16.9    28.5    37.5    44.4    48.5
    clim     32.7    32.7    32.7    33.1    33.3    33.4    33.4
    blend     4.8     9.2    16.5    25.4    29.4    32.2    33.4
    weight   1.00    0.95    0.85    0.45    0.40    0.30    0.10

Three honest properties fall out. At six hours the forecast simply IS
persistence — nothing beats "the wind is still doing what it is doing". At two
to three days the blend beats both baselines by three to four degrees. At five
days it collapses to the rose, which is the honest answer and is the same rose
the community app already shows.

**The crossover is the product.** The two baselines cross at about 60 hours, so
a five-day strip is not a hedge: days 0-2 are the forecast and days 3-5 are the
climatology, because that is where the lines actually cross.

WHAT IS FORECAST AND WHAT IS DERIVED
------------------------------------
`weather._solar` is pure solar geometry and is knowable exactly in advance, so
only direction, speed and stability are genuinely uncertain. Everything else
follows:

    direction, speed  blended (persistence -> climatology)
    stability         the same hour on the last observed day to 48 h, then
                      hour-of-day climatology (`stability_raw`), then passed
                      through `dispersion.coerce_class` against the speed
    boundary layer    derived from stability, solar and speed by the same
                      formula the generator uses, with a parity test

That is the same discipline as `coerce_class` itself: never emit F at 6 m/s,
and never emit a stable class under a 1,500 m mixed layer.

WHAT IT IS STILL HONEST TO SAY
------------------------------
This is one simulated campaign. The numbers the ledger reports are its own, not
the atmosphere's — a real forecast verified against real weather would look
nothing like this. But the error IS measured here rather than chosen, so the
disclaimer is about the world, not about the arithmetic.
"""

from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from air import dispersion
from air.server import cache, plumeframe

#: Weight on persistence at each lead, measured by sweeping the blend against
#: this record. Between the knots it is interpolated; past the last it holds.
#: Not tuned to flatter anything — these are the weights that minimise
#: direction MAE at each lead, read off the sweep in the module docstring.
BLEND_KNOTS = ((0, 1.00), (6, 1.00), (12, 0.95), (24, 0.85),
               (48, 0.45), (72, 0.40), (96, 0.30), (120, 0.10))

#: Leads the forecast is issued for, in hours.
DEFAULT_LEADS = (0, 3, 6, 12, 24, 36, 48, 72, 96, 120)

#: Lead at which climatology overtakes persistence, measured. Past this the
#: honest answer is the rose, and a screen should say so rather than drawing a
#: cone it cannot stand behind.
CROSSOVER_H = 60.0

#: Stability cannot be blended as a number; see `stability_raw` for the rule.
CLASSES = "ABCDEF"


@dataclass(frozen=True)
class ForecastHour:
    valid_at: str
    lead_h: int
    dir_deg: float
    #: Circular spread of the blend's own historical error at this lead, in
    #: degrees. This is what widens the corridor — it is measured, not assumed.
    dir_sd_deg: float
    speed_ms: float
    stability: str
    pbl_m: float
    #: Weight the blend put on persistence. 1.0 is pure persistence, 0.0 pure
    #: climatology; a screen can say which one it is looking at.
    persistence_weight: float
    #: True past `CROSSOVER_H`, where climatology beats persistence and the
    #: honest answer is the rose rather than a forecast.
    beyond_crossover: bool
    stability_coerced_from: str | None = None


@dataclass(frozen=True)
class SkillBin:
    lead_h: int
    n: int
    blend_mae_deg: float
    persistence_mae_deg: float
    climatology_mae_deg: float
    #: Share of cases the blend was more than 90 degrees out — the forecast
    #: pointing at the wrong half of the map.
    blend_wrong_half: float
    #: Positive means the blend beat the better of the two baselines.
    gain_deg: float


@dataclass(frozen=True)
class Forecast:
    campaign_id: str
    issued_at: str
    crossover_h: float
    basis: str
    hours: list[ForecastHour] = field(default_factory=list)


BASIS = (
    "derived — a measured blend of persistence and this campaign's own wind "
    "climatology. Its error is measured, not chosen. It is one simulated "
    "campaign, so the numbers are its own and not the atmosphere's."
)


# ── the blend ────────────────────────────────────────────────────────────────


def blend_weight(lead_h: float) -> float:
    """Weight on persistence at this lead. Linear between measured knots."""
    xs = [k for k, _ in BLEND_KNOTS]
    ys = [v for _, v in BLEND_KNOTS]
    if lead_h <= xs[0]:
        return ys[0]
    if lead_h >= xs[-1]:
        return ys[-1]
    return float(np.interp(lead_h, xs, ys))


def _norm_bearing(deg):
    """Into [0, 360) — and genuinely 0, not 360.

    `np.arctan2` returns about -1e-16 for a bearing that should be due north,
    and `-1e-16 % 360` is 360.0, not 0.0. A 360-degree bearing then fails every
    downstream `0 <= b < 360` check and sorts to the wrong end of a rose.
    """
    out = np.mod(np.asarray(deg, dtype=float), 360.0)
    return np.where(out >= 360.0 - 1e-9, 0.0, out)


def _circ_blend(a_deg, b_deg, w: float):
    """Blend two bearings on the circle. Averaging 350 and 10 must give 0."""
    ar, br = np.radians(a_deg), np.radians(b_deg)
    x = w * np.cos(ar) + (1 - w) * np.cos(br)
    y = w * np.sin(ar) + (1 - w) * np.sin(br)
    return _norm_bearing(np.degrees(np.arctan2(y, x)))


def _circ_mean(deg) -> float:
    r = np.radians(np.asarray(deg, dtype=float))
    return float(_norm_bearing(np.degrees(np.arctan2(np.sin(r).mean(), np.cos(r).mean()))))


def _circ_err(a, b):
    return np.abs((np.asarray(a, float) - np.asarray(b, float) + 180.0) % 360.0 - 180.0)


class _Record:
    """The wind record, plus the climatologies the blend falls back to."""

    def __init__(self, conn: sqlite3.Connection, campaign_id: str):
        rows = conn.execute(
            "SELECT ts, speed_ms, dir_deg, stability FROM wind "
            "WHERE campaign_id = ? ORDER BY ts",
            (campaign_id,),
        ).fetchall()
        self.ts = [r[0] for r in rows]
        self.speed = np.array([float(r[1] or 1.0) for r in rows])
        self.dir = np.array([float(r[2]) for r in rows])
        self.cls = np.array([(r[3] or "D").upper() for r in rows])
        self.index = {t[:13]: i for i, t in enumerate(self.ts)}
        self.hod = np.array([int(t[11:13]) for t in self.ts])

        self.clim_dir = _circ_mean(self.dir)
        self.clim_speed = float(self.speed.mean())
        # Per hour-of-day, because a forecast for 03:00 should fall back to
        # what 03:00 is usually like, not to the all-day average.
        self.clim_dir_hod = np.array([_circ_mean(self.dir[self.hod == h]) for h in range(24)])
        self.clim_speed_hod = np.array([float(self.speed[self.hod == h].mean()) for h in range(24)])
        self.clim_cls_hod = [
            max(set(self.cls[self.hod == h]), key=list(self.cls[self.hod == h]).count)
            for h in range(24)
        ]


def load(conn: sqlite3.Connection, campaign_id: str) -> _Record:
    key = ("forecast_record", campaign_id, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, _Record(conn, campaign_id))


def _pbl(stability: str, solar: float, u: float) -> float:
    """Mixed-layer depth from stability, insolation and wind.

    MIRRORS `air.datagen.weather.build_wind`. Replicated rather than imported
    because `air.server` does not import `air.datagen` — and asserted equal by
    `tests/test_forecast.py`, which is the same pattern the plume parity test
    uses. Without the synoptic wobble the generator applies, which is not
    knowable in advance.
    """
    if stability in "AB":
        pbl = 1050.0 + 700.0 * solar + 42.0 * u
    elif stability == "C":
        pbl = 780.0 + 470.0 * solar + 45.0 * u
    elif stability == "D":
        pbl = 380.0 + 300.0 * solar + 70.0 * u
    elif stability == "E":
        pbl = 205.0 + 55.0 * u
    else:
        pbl = 128.0 + 42.0 * u
    return min(1900.0, pbl)


def _solar(hour_of_day: float, doy: int) -> float:
    """Clear-sky insolation proxy. Pure geometry — knowable exactly ahead."""
    decl = 23.44 * math.sin(math.radians(360.0 * (284 + doy) / 365.0))
    lat = math.radians(35.06)
    d = math.radians(decl)
    ha = math.radians(15.0 * (hour_of_day - 12.6))
    sin_elev = math.sin(lat) * math.sin(d) + math.cos(lat) * math.cos(d) * math.cos(ha)
    return max(0.0, min(1.0, sin_elev / 0.95))


# ── issuing ──────────────────────────────────────────────────────────────────


def issue(
    conn: sqlite3.Connection,
    campaign_id: str,
    at: str | None = None,
    leads: tuple[int, ...] = DEFAULT_LEADS,
) -> Forecast:
    """The forecast as of `at`, for each lead."""
    import datetime as dt

    r = load(conn, campaign_id)
    if not r.ts:
        return Forecast(campaign_id, at or "", CROSSOVER_H, BASIS, [])
    i = r.index.get((at or r.ts[-1])[:13], len(r.ts) - 1)
    issued = r.ts[i]
    base = dt.datetime.fromisoformat(issued[:19])
    spread = _spread_by_lead(conn, campaign_id)

    out: list[ForecastHour] = []
    for lead in leads:
        valid = base + dt.timedelta(hours=int(lead))
        hod = valid.hour
        doy = valid.timetuple().tm_yday
        w = blend_weight(lead)

        d = float(_circ_blend(r.dir[i], r.clim_dir_hod[hod], w))
        u = float(w * r.speed[i] + (1 - w) * r.clim_speed_hod[hod])
        raw = stability_raw(r, i, int(lead), hod)
        cls, note = dispersion.coerce_class(raw, u)
        solar = _solar(float(hod), doy)
        out.append(ForecastHour(
            valid_at=valid.isoformat(timespec="seconds"),
            lead_h=int(lead),
            dir_deg=round(d, 1),
            dir_sd_deg=round(spread.get(int(lead), _interp_spread(spread, lead)), 1),
            speed_ms=round(u, 2),
            stability=cls,
            pbl_m=round(_pbl(cls, solar, u), 0),
            persistence_weight=round(w, 3),
            beyond_crossover=bool(lead > CROSSOVER_H),
            stability_coerced_from=raw if note else None,
        ))
    return Forecast(campaign_id, issued, CROSSOVER_H, BASIS, out)


#: Stability is persisted from the SAME HOUR on the last observed day, never
#: from the hour of issue, out to this lead; past it, the hour-of-day
#: climatology. See `stability_raw`.
DIURNAL_STABILITY_MAX_H = 48


def stability_raw(r: _Record, i: int, lead: int, hod: int) -> str:
    """The Pasquill class forecast for `lead` hours after record index `i`.

    Stability is driven by the sun, so persisting the class AT ISSUE is wrong
    the moment the forecast crosses sunset. The first version did exactly
    that while the direction blend leaned on persistence, and a 07:00 class B
    was forecast for 23:00 — "well-mixed air, tonight" — right 11% of the
    time at 12 hours, worse than guessing. Measured on this record, accuracy
    by lead:

        lead          1 h    3 h   12 h   24 h   48 h   72 h  120 h
        at issue     0.82   0.65   0.11   0.78   0.71   0.65   0.63
        same hour    0.78   0.78   0.78   0.78   0.71   0.65   0.63
        hour-of-day  0.65   0.65   0.65   0.65   0.66   0.67   0.67

    So: the class at issue for the first hour, the same hour on the last
    observed day to 48 hours, and the climatology after — which crosses over
    at about the same lead the direction blend does.
    """
    if lead <= 1:
        return str(r.cls[i])
    if lead <= DIURNAL_STABILITY_MAX_H:
        back = 24 * math.ceil(lead / 24)
        j = i + lead - back
        if j >= 0:
            return str(r.cls[j])
    return str(r.clim_cls_hod[hod])


def _interp_spread(spread: dict[int, float], lead: float) -> float:
    if not spread:
        return 30.0
    xs = sorted(spread)
    return float(np.interp(lead, xs, [spread[x] for x in xs]))


# ── the ledger ───────────────────────────────────────────────────────────────


SKILL_LEADS = (6, 12, 24, 48, 72, 96, 120)


def skill(conn: sqlite3.Connection, campaign_id: str) -> list[SkillBin]:
    """Replay the blend across the record and score it against what happened.

    No separate truth is needed and no table is written: the forecast is a
    function of the record, so scoring it is a second pass over the same rows.
    """
    r = load(conn, campaign_id)
    out: list[SkillBin] = []
    n = len(r.ts)
    for lead in SKILL_LEADS:
        if lead >= n:
            continue
        truth = r.dir[lead:]
        pers = r.dir[:-lead]
        hod = r.hod[lead:]
        clim = r.clim_dir_hod[hod]
        w = blend_weight(lead)
        blend = _circ_blend(pers, clim, w)
        b_mae = float(_circ_err(truth, blend).mean())
        p_mae = float(_circ_err(truth, pers).mean())
        c_mae = float(_circ_err(truth, clim).mean())
        out.append(SkillBin(
            lead_h=lead, n=int(truth.size),
            blend_mae_deg=round(b_mae, 1),
            persistence_mae_deg=round(p_mae, 1),
            climatology_mae_deg=round(c_mae, 1),
            blend_wrong_half=round(float((_circ_err(truth, blend) > 90.0).mean()), 4),
            gain_deg=round(min(p_mae, c_mae) - b_mae, 1),
        ))
    return out


def _spread_by_lead(conn: sqlite3.Connection, campaign_id: str) -> dict[int, float]:
    """The blend's own measured error spread per lead — what widens the corridor."""
    key = ("forecast_spread", campaign_id, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    r = load(conn, campaign_id)
    out: dict[int, float] = {0: 0.0}
    for lead in SKILL_LEADS:
        if lead >= len(r.ts):
            continue
        truth = r.dir[lead:]
        blend = _circ_blend(r.dir[:-lead], r.clim_dir_hod[r.hod[lead:]], blend_weight(lead))
        out[lead] = float(_circ_err(truth, blend).std())
    return cache.put(key, out)


def corridor(
    conn: sqlite3.Connection, campaign_id: str, site_id: str, at: str | None = None
) -> dict[str, Any]:
    """The forecast plume as a WIDENING CORRIDOR, never a centreline.

    A single cone at +72 h is a fabrication with a timestamp on it. The
    measured direction error at that lead displaces the centreline about 2.1 km
    at 4 km range, in a campaign barely 10 km across — so the honest shape is
    the sector the plume could be in, widened by the blend's own measured
    spread, and it visibly loses its shape by day three.
    """
    fc = issue(conn, campaign_id, at)
    sources = _site_sources(conn, site_id)
    out = []
    for h in fc.hours:
        if not sources:
            break
        rch = dispersion.reach(sources, u10=h.speed_ms, cls=h.stability, pbl_m=h.pbl_m)
        if rch.faint:
            continue
        # Two sigma of the MEASURED error, plus the plume's own width — the
        # same formula the Mission Brief tests routes against.
        full, _plume = plumeframe.half_angle(rch.x_reach, h.stability, h.speed_ms, h.dir_sd_deg)
        out.append({
            "lead_h": h.lead_h,
            "valid_at": h.valid_at,
            "axis_deg": (h.dir_deg + 180.0) % 360.0,
            "half_angle_deg": round(full, 1),
            "x_onset_m": round(rch.x_onset, 1),
            "x_reach_m": round(rch.x_reach, 1),
            "beyond_crossover": h.beyond_crossover,
            "persistence_weight": h.persistence_weight,
        })
    return {"site_id": site_id, "issued_at": fc.issued_at, "basis": BASIS,
            "crossover_h": fc.crossover_h, "leads": out}


def _site_sources(conn: sqlite3.Connection, site_id: str) -> list[dispersion.Source]:
    return [
        dispersion.Source(float(h or 12.0), k)
        for k, h in conn.execute(
            "SELECT kind, height_m FROM emission_point WHERE site_id = ? AND active = 1",
            (site_id,),
        )
    ]
