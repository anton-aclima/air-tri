"""Step 6a -- hourly meteorology for the whole campaign.

A plausible Memphis late-spring-into-summer wind rose: prevailing from the S/SW,
multi-day synoptic regimes, calm stable nights, gusty unstable afternoons.  Every
value is a pure function of the hour index and the seed, so the series is
reproducible and can be recomputed for a single hour.

The row carries `stability` (Pasquill A-F) and `pbl_m` because the dispersion model
in `field.py` needs both: a 180 m nocturnal boundary layer under class F is why
pollutants pile up overnight, and a 1700 m class-B afternoon is why they vanish.

One episode is **scripted**, because the `wind_shift` demo scenario needs it: over
four days near the end of the campaign the wind backs from SSW through W and NW to
NNE.  Transport direction therefore sweeps clockwise from NE across Boxtown, White
Chapel, Westwood, Darwin and Goodman before pointing out over the river.  Knobs:
`SHIFT_START_DAY_FROM_END`, `SHIFT_DAYS`, `SHIFT_FROM_DEG`, `SHIFT_TO_DEG`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np

from .noise import scalar_series

PREVAILING_DEG = 208.0  # direction the wind comes FROM (SSW)
DIR_SPREAD_DEG = 74.0

SHIFT_START_DAY_FROM_END = 27  # episode begins this many days before the last day
SHIFT_DAYS = 4
SHIFT_FROM_DEG = 205.0
SHIFT_TO_DEG = 380.0  # 20 deg, unwrapped so the rotation goes SSW -> W -> NW -> NNE

STABILITY_CLASSES = "ABCDEF"


@dataclass
class WindHour:
    ts: datetime
    hour_index: int
    speed_ms: float
    dir_deg: float  # meteorological, direction FROM
    gust_ms: float
    temp_c: float
    rh: float
    pbl_m: float
    stability: str
    solar: float  # 0..1 insolation proxy, not persisted

    @property
    def transport_deg(self) -> float:
        """Direction the plume travels TOWARD."""
        return (self.dir_deg + 180.0) % 360.0

    def row(self, campaign_id: str) -> dict:
        return {
            "campaign_id": campaign_id,
            "ts": self.ts.isoformat(timespec="seconds"),
            "speed_ms": round(self.speed_ms, 2),
            "dir_deg": round(self.dir_deg, 1),
            "gust_ms": round(self.gust_ms, 2),
            "temp_c": round(self.temp_c, 1),
            "rh": round(self.rh, 1),
            "pbl_m": round(self.pbl_m, 0),
            "stability": self.stability,
        }


def _solar(hour_of_day: float, doy: int) -> float:
    """Crude clear-sky insolation proxy in [0,1] for ~35 deg N."""
    decl = 23.44 * math.sin(math.radians(360.0 * (284 + doy) / 365.0))
    lat = math.radians(35.06)
    d = math.radians(decl)
    ha = math.radians(15.0 * (hour_of_day - 12.6))
    sin_elev = math.sin(lat) * math.sin(d) + math.cos(lat) * math.cos(d) * math.cos(ha)
    return max(0.0, min(1.0, sin_elev / 0.95))


def _pasquill(solar: float, u: float, cloud: float = 0.0) -> str:
    """Pasquill class from insolation, 10 m wind speed and cloud cover."""
    if solar > 0.06:
        if solar > 0.72:
            band = 0
        elif solar > 0.38:
            band = 1
        else:
            band = 2
        table = [
            ["A", "A", "B", "B", "C"],  # strong
            ["B", "B", "B", "C", "C"],  # moderate
            ["B", "B", "C", "C", "D"],  # slight
        ][band]
    elif cloud > 0.55:
        table = ["E", "D", "D", "D", "D"]  # overcast night -> near-neutral
    else:
        table = ["F", "F", "E", "D", "D"]
    if u < 2.0:
        i = 0
    elif u < 3.0:
        i = 1
    elif u < 4.5:
        i = 2
    elif u < 6.0:
        i = 3
    else:
        i = 4
    return table[i]


def build_wind(start: datetime, days: int, seed: int) -> list[WindHour]:
    n = days * 24
    h = np.arange(n, dtype=float)
    day = h / 24.0

    # ---- synoptic regimes (day scale)
    syn = scalar_series(day * 0.36, seed + 101, octaves=4) * 2.0 - 1.0        # -1..1
    syn_slow = scalar_series(day * 0.12, seed + 137, octaves=3) * 2.0 - 1.0
    rot = scalar_series(day * 0.28, seed + 211, octaves=3) * 2.0 - 1.0
    calm = scalar_series(day * 0.9, seed + 307, octaves=2)
    # cloud cover tracks the synoptic index: windy regimes are the cloudy ones.
    cloud_s = np.clip(0.46 + 0.52 * syn + 0.18 * syn_slow, 0.0, 1.0)

    # ---- direction
    direction = PREVAILING_DEG + DIR_SPREAD_DEG * rot + 22.0 * syn_slow
    # a couple of organic multi-day frontal passages on top of the noise
    for k, (d0, span, delta) in enumerate([(19.0, 2.6, 118.0), (48.0, 3.1, -96.0)]):
        w = np.exp(-(((day - d0) / span) ** 2))
        direction = direction + delta * w

    # ---- the scripted wind_shift episode
    d0 = days - SHIFT_START_DAY_FROM_END
    t = np.clip((day - d0) / SHIFT_DAYS, 0.0, 1.0)
    ramp = t * t * (3 - 2 * t)  # smoothstep
    inside = (day >= d0 - 0.4) & (day <= d0 + SHIFT_DAYS + 1.6)
    scripted = SHIFT_FROM_DEG + (SHIFT_TO_DEG - SHIFT_FROM_DEG) * ramp
    blend = np.where(inside, np.clip((np.minimum(day - (d0 - 0.4), (d0 + SHIFT_DAYS + 1.6) - day)) / 0.5, 0, 1), 0.0)
    direction = direction * (1 - blend) + scripted * blend
    direction = direction % 360.0

    # ---- speed: diurnal x synoptic, with genuinely calm nights
    hod = h % 24.0
    diurnal = 0.55 + 0.62 * np.clip(np.sin((hod - 6.4) / 24.0 * 2 * math.pi), -1, 1)
    diurnal = np.clip(diurnal, 0.44, 1.30)
    base = 4.45 * (1.0 + 0.46 * syn + 0.20 * syn_slow)
    jitter = scalar_series(h * 0.31, seed + 401, octaves=3) * 2.0 - 1.0
    speed = base * diurnal * (1.0 + 0.20 * jitter)
    # deep calm on a handful of nights (stagnation episodes -> PM2.5 build-up)
    night = (hod < 6.5) | (hod > 21.5)
    speed = np.where(night & (calm > 0.74), speed * 0.40, speed)
    # the scripted episode brings a real frontal wind, then a lull behind it
    speed = speed * (1.0 + 0.85 * blend * np.exp(-(((t - 0.45) / 0.28) ** 2)))
    speed = np.clip(speed, 0.50, 13.0)

    # ---- temperature / humidity: seasonal ramp + diurnal + synoptic
    doy0 = start.timetuple().tm_yday
    doy = (doy0 + day.astype(int)) % 366
    seasonal = 22.0 + 6.4 * np.sin((doy - 106) / 365.0 * 2 * math.pi)
    temp = seasonal + 6.6 * np.sin((hod - 9.6) / 24.0 * 2 * math.pi) + 3.4 * syn_slow + 1.1 * jitter
    rh = np.clip(62.0 - 2.1 * (temp - seasonal) + 11.0 * cloud_s - 8.0 * syn + 9.0 * (1 - diurnal), 22.0, 97.0)

    out: list[WindHour] = []
    for i in range(n):
        cl = float(cloud_s[i])
        s = _solar(float(hod[i]), int(doy[i])) * (1.0 - 0.82 * cl)
        u = float(speed[i])
        st = _pasquill(s, u, cl)
        # PBL: collapses at night under stable classes, deep on unstable afternoons
        if st in "AB":
            pbl = 1050.0 + 700.0 * s + 42.0 * u
        elif st == "C":
            pbl = 780.0 + 470.0 * s + 45.0 * u
        elif st == "D":
            pbl = 380.0 + 300.0 * s + 70.0 * u
        elif st == "E":
            pbl = 205.0 + 55.0 * u
        else:
            pbl = 128.0 + 42.0 * u
        pbl = min(1900.0, pbl * (1.0 + 0.10 * float(syn_slow[i])))
        out.append(
            WindHour(
                ts=start + timedelta(hours=i),
                hour_index=i,
                speed_ms=u,
                dir_deg=float(direction[i]),
                gust_ms=u * (1.42 + 0.55 * max(0.0, float(jitter[i]))) + 0.4,
                temp_c=float(temp[i]),
                rh=float(rh[i]),
                pbl_m=max(90.0, pbl),
                stability=st,
                solar=s,
            )
        )
    return out


def wind_rose(wind: list[WindHour], bins: int = 16) -> dict[str, float]:
    counts = [0] * bins
    for w in wind:
        counts[int((w.dir_deg + 180.0 / bins) % 360.0 / (360.0 / bins))] += 1
    labels = [
        "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
        "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
    ]
    total = max(1, len(wind))
    return {labels[i]: round(100.0 * counts[i] / total, 1) for i in range(bins)}
