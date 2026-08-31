"""Step 3 -- the spatio-temporal concentration field.  The heart of the simulation.

Nothing here assigns a value to a road segment.  Instead a *continuous field* is
built per hour over the whole campaign on a raster, and the drive samples it.  That
is why the map shows coherent structure -- plumes, corridors, gradients -- instead
of confetti.  Segments that are 80 m apart get similar values because they are
reading the same field, not two independent random numbers.

Five composed layers
--------------------
1. **Regional background.**  Low-frequency fBm evaluated in (x, y, day), so it is
   smooth in space and drifts day to day.  The noise coordinates are offset by a
   cumulative advection distance, so the airmass physically moves with the wind.
   Multiplied by a diurnal cycle per measure.
2. **Point-source plumes.**  A Briggs open-country Gaussian plume per
   `emission_point`, advected along the current hour's transport direction, with
   Pasquill-dependent sigma_y / sigma_z, buoyant plume rise, ground reflection,
   boundary-layer trapping, low-wind meander, and a small isotropic near-field term
   so a fenceline monitor upwind of a stack still sees something.  **This is the
   layer that makes the wind story work.**
3. **Line sources.**  Traffic, splatted from the real road network weighted by OSM
   highway class, with a rush-hour double peak and a separate heavy-duty (diesel)
   raster.  Dispersion width blends between a tight and a wide blur by wind speed
   and stability.
4. **Micro-scale noise.**  High-frequency fBm, mostly static (local geometry does
   not move) with a slow seasonal wobble, so adjacent segments differ believably.
5. **Measure-specific chemistry.**  See `_compose`.

Evolution over the 90 days
--------------------------
The field is never reused.  It changes hour to hour through the wind, day to day
through the background fBm and synoptic weather, and month to month through two
slow trends: Ridgeline's load ramp (`LOAD_RAMP`, 0.74 -> 1.00 as Phase 2 turbines
come online) and the growth of the Boxtown methane leak (`Leak.growth`).

Tunables are the module-level `K_*` scale constants and `BG_*` amplitudes; every one
is documented in `README.md`.
"""

from __future__ import annotations

import math

import numpy as np

from .measures import INDICATORS, MODALITIES  # noqa: F401
from .network import ROAD_WEIGHT
from .noise import bilinear_sample, box_blur, fbm3, ridged3

SQRT2PI = math.sqrt(2.0 * math.pi)

# ---------------------------------------------------------------- tunables

GRID_N = 256          # raster cells per side over the padded bbox (~46 m/cell)
PAD_M = 1500.0        # metres of padding around the campaign bbox

# Briggs open-country dispersion coefficients, keyed by Pasquill class.
# sigma_y = ay*x*(1+1e-4*x)^-0.5 ;  sigma_z per the class-specific form below.
_SIGY = {"A": 0.22, "B": 0.16, "C": 0.11, "D": 0.08, "E": 0.06, "F": 0.04}
_WIND_EXP = {"A": 0.07, "B": 0.07, "C": 0.10, "D": 0.15, "E": 0.35, "F": 0.55}

# Virtual-source offset (m). Real plumes do not start as points: stack diameter,
# exit momentum and building downwash give an initial spread, so sigma is evaluated
# at (x + SIGMA_X0). Without it the near-field lobe is a few tens of metres wide and
# no road segment ever intersects it.
SIGMA_X0 = 115.0

# Campus-scale near field. A 1.1 km2 industrial site is an *area* source: 24 turbine
# exhausts, on-site traffic, fugitive losses and building-wake recirculation blend
# into one campus plume within the first kilometre, which is how AERMOD treats a
# large facility. NEAR_Q sets the amplitude, NEAR_SIGMA_M its radius.
NEAR_Q = 1.00e-4
NEAR_SIGMA_M = 640.0

# Buoyant plume rise coefficient by emission-point kind: dh ~= COEF / u_stack.
RISE = {
    "generator": 58.0,
    "stack": 74.0,
    "backup": 22.0,
    "cooling_tower": 36.0,
    "traffic_gate": 0.0,
    "substation": 0.0,
}

# Background amplitudes (in each measure's own unit).
BG_NOX_PPB = (5.4, 13.4)     # (floor, span) regional NO2 before diurnal scaling
BG_O3_PPB = (34.0, 53.0)    # regional afternoon-peak ozone
BG_HAZE = (4.2, 9.0)        # regional PM2.5 haze
BG_CH4_PPM = (1.902, 0.052)
CO2_FLOOR_PPM = 419.0

# Regional smoke / stagnation episodes: (centre day, sigma in days, peak multiplier
# on the PM2.5 haze background). Transported wildfire smoke is the ordinary reason a
# Memphis summer breaches the 24-hour PM2.5 standard, and the regulator needs
# genuine exceedances to have a call to action. Nothing local causes these -- which
# is itself part of the attribution story.
HAZE_EPISODES = [(34.0, 1.6, 3.45), (71.0, 1.15, 2.85)]

# Point-source coupling: field units -> measure units.
K_PT_NO2 = 1.95e5
K_PT_PM = 5.4e4
K_PT_BC = 1.15e4
K_PT_CO = 1.7e3
K_PT_CO2 = 1.05e6
K_PT_CH4 = 1.9e2

# Line-source (traffic) coupling.
K_TR_NO2 = 19.5
K_TR_PM = 3.9
K_TR_BC = 2.45
K_TR_CO = 0.55
K_TR_CO2 = 27.0

# Micro-scale amplitudes.
MICRO = {"no2": 1.9, "pm25": 1.25, "bc": 0.055, "o3": 2.4, "co": 0.022, "co2": 3.4, "ch4": 0.013}

# Chemistry.
O3_TITRATION = 1.90       # ppb O3 destroyed per ppb of local NO2 excess.
# Greater than 1 on purpose: the titrating agent is NO, but the field carries NO2,
# and near a fresh combustion source NO/NO2 is typically 3-9. Titrating against NO2
# alone would badly understate the ozone hole around a stack.
NO2_PHOTOLYSIS = 0.26     # afternoon NO2 suppression fraction at peak sun
NIGHT_TRAP_REF_M = 620.0  # PBL height at which the night trapping factor is 1.0

# Ridgeline load ramp across the campaign (phase-2 turbines coming online).
LOAD_RAMP = (0.74, 1.00)


def duty_series(kind_duty: str, hours: np.ndarray, seed: int, idx: int) -> np.ndarray:
    """Activity factor in [0, ~1.15] for one emission point over *all* hours.

    Vectorised on purpose: scalar fBm calls in the hourly loop dominated the build.
    - `continuous`  slow load drift + an afternoon cooling-load bump
    - `daytime`     gates and yards, 06-20, twin peaks
    - `night`       night-shift only
    - `intermittent`bursty: turbine tests, backup-generator runs (~12 % of hours)
    - `rare`        a couple of runs a month
    """
    hod = hours % 24.0
    z = np.zeros_like(hours, dtype=float)
    if kind_duty == "continuous":
        drift = fbm3(hours * 0.021, z + idx * 3.7, z, seed + 51)
        return 0.86 + 0.16 * drift + 0.10 * np.sin((hod - 15.0) / 24.0 * 2 * np.pi)
    if kind_duty == "daytime":
        a = np.exp(-(((hod - 9.0) / 3.0) ** 2))
        b = np.exp(-(((hod - 15.5) / 3.2) ** 2))
        n = fbm3(hours * 0.07, z + idx * 11.0, z, seed + 61)
        v = (0.30 + 0.85 * np.maximum(a, b)) * (0.75 + 0.5 * n)
        return np.where((hod < 5.0) | (hod > 20.5), 0.06, v)
    if kind_duty == "night":
        return np.where((hod < 5.5) | (hod > 21.0), 0.9, 0.1)
    if kind_duty == "intermittent":
        n = fbm3(hours * 0.16, z + idx * 17.0, z, seed + 71)
        return np.maximum(0.0, (n - 0.63) / 0.37) ** 0.7 * 1.15
    if kind_duty == "rare":
        n = fbm3(hours * 0.23, z + idx * 23.0, z, seed + 81)
        return np.maximum(0.0, (n - 0.80) / 0.20) ** 0.6 * 1.1
    return np.ones_like(hours, dtype=float)


def _soft_cap(v, cap):
    """Smoothly compress absurd near-source outliers without flattening gradients."""
    return cap * np.tanh(v / cap)


class FieldModel:
    """Builds and samples the hourly concentration rasters."""

    def __init__(self, world, segments, wind, *, grid_n: int = GRID_N, pad_m: float = PAD_M):
        self.world = world
        self.wind = wind
        self.seed = world.seed
        self.proj = world.proj
        self.grid_n = grid_n
        self.n_hours = len(wind)

        W, S, E, N = world.campaign["bbox_w"], world.campaign["bbox_s"], world.campaign["bbox_e"], world.campaign["bbox_n"]
        x0, y0 = self.proj.xy(W, S)
        x1, y1 = self.proj.xy(E, N)
        self.x0, self.y0 = x0 - pad_m, y0 - pad_m
        self.x1, self.y1 = x1 + pad_m, y1 + pad_m
        self.cell = max((self.x1 - self.x0), (self.y1 - self.y0)) / (grid_n - 1)
        gx = self.x0 + np.arange(grid_n) * self.cell
        gy = self.y0 + np.arange(grid_n) * self.cell
        self.gx, self.gy = gx, gy
        self.X, self.Y = np.meshgrid(gx, gy)  # [row=y, col=x]

        # --- static layers -------------------------------------------------
        self._build_traffic(segments)
        self._build_micro()
        self._build_industry()
        self._build_leaks()

        # emission points, pre-projected, with their duty and meander series
        hours = np.arange(self.n_hours, dtype=float)
        self.points = []
        for i, p in enumerate(world.emission_points):
            if not p.strength:
                continue
            px, py = self.proj.xy(p.lon, p.lat)
            duty = duty_series(p.duty, hours, self.seed, i)
            if p.site_id == "site-ridgeline":
                duty = duty * (
                    LOAD_RAMP[0]
                    + (LOAD_RAMP[1] - LOAD_RAMP[0]) * hours / max(1.0, self.n_hours - 1)
                )
            wob = 30.0 * (fbm3(hours * 0.13, np.zeros_like(hours) + i * 5.5, np.zeros_like(hours), self.seed + 1301) - 0.5)
            self.points.append((i, p, px, py, duty, wob))
        self.leak_duty = [
            duty_series(lk.duty, hours, self.seed + 3000, abs(hash(lk.id)) % 997)
            for lk in world.leaks
        ]
        # constant upsample index grid for the coarse background rasters
        gi = np.linspace(0, 63, grid_n)
        self._up_gx, self._up_gy = np.meshgrid(gi, gi)
        cx = np.linspace(0, grid_n - 1, 64)
        self._bg_u0 = (self.x0 + cx * self.cell) / 5200.0
        self._bg_v0 = (self.y0 + cx * self.cell) / 5200.0

        # cumulative advection of the regional airmass (km), for background drift
        adv_x = np.cumsum([w.speed_ms * math.sin(math.radians(w.transport_deg)) * 3.6 for w in wind])
        adv_y = np.cumsum([w.speed_ms * math.cos(math.radians(w.transport_deg)) * 3.6 for w in wind])
        self.adv_x, self.adv_y = adv_x, adv_y

        self._cache_h: int | None = None
        self._cache: dict[str, np.ndarray] = {}

    # ------------------------------------------------------------------ static

    def _splat(self, xs, ys, wts) -> np.ndarray:
        g = np.zeros((self.grid_n, self.grid_n))
        ci = np.clip(((xs - self.x0) / self.cell).astype(int), 0, self.grid_n - 1)
        ri = np.clip(((ys - self.y0) / self.cell).astype(int), 0, self.grid_n - 1)
        np.add.at(g, (ri, ci), wts)
        return g

    def _build_traffic(self, segments):
        xs, ys, wa, wt = [], [], [], []
        for s in segments:
            x, y = self.proj.xy(s.mid_lon, s.mid_lat)
            w = ROAD_WEIGHT.get(s.road_class, 0.1)
            xs.append(x)
            ys.append(y)
            wa.append(w * s.length_m)
            # heavy-duty share: trucks are on the arterials, not the side streets
            hd = {"motorway": 1.0, "trunk": 0.9, "primary": 0.72, "secondary": 0.6,
                  "tertiary": 0.3, "unclassified": 0.22, "residential": 0.05,
                  "living_street": 0.02}.get(s.road_class, 0.05)
            wt.append(w * hd * s.length_m)
        xs = np.array(xs)
        ys = np.array(ys)
        raw_all = self._splat(xs, ys, np.array(wa))
        raw_hd = self._splat(xs, ys, np.array(wt))
        norm = 1.0 / max(1e-9, raw_all.max())
        self.tr_tight = box_blur(raw_all, 2) * norm * 30.0
        self.tr_wide = box_blur(raw_all, 6) * norm * 30.0
        nh = 1.0 / max(1e-9, raw_hd.max())
        self.hd_tight = box_blur(raw_hd, 1) * nh * 26.0
        self.hd_wide = box_blur(raw_hd, 4) * nh * 26.0

    def _build_micro(self):
        n = self.grid_n
        u = self.X / 420.0
        v = self.Y / 420.0
        self.micro_a = fbm3(u, v, np.zeros((n, n)) + 1.5, self.seed + 901, octaves=4) - 0.5
        self.micro_b = fbm3(u * 1.7, v * 1.7, np.zeros((n, n)) + 4.5, self.seed + 907, octaves=4) - 0.5
        self.micro_c = ridged3(u * 0.8, v * 0.8, np.zeros((n, n)) + 9.5, self.seed + 911, octaves=3) - 0.5

    def _build_industry(self):
        """Broad fugitive-emission floor over the real industrial parcels."""
        xs, ys, ws = [], [], []
        for p in self.world.parcels:
            x, y = self.proj.xy(*p.centroid)
            xs.append(x)
            ys.append(y)
            ws.append(min(p.area_m2, 4.0e5))
        if not xs:
            self.industry = np.zeros((self.grid_n, self.grid_n))
            return
        raw = self._splat(np.array(xs), np.array(ys), np.array(ws))
        raw = box_blur(raw, 7)
        self.industry = raw / max(1e-9, raw.max())

    def _build_leaks(self):
        self.leak_blobs = []
        for lk in self.world.leaks:
            lx, ly = self.proj.xy(lk.lon, lk.lat)
            d2 = (self.X - lx) ** 2 + (self.Y - ly) ** 2
            blob = np.exp(-d2 / (2.0 * lk.sigma_m**2))
            self.leak_blobs.append((lk, blob))

    # ------------------------------------------------------------------ plume

    def _sigmas(self, x, cls):
        ay = _SIGY[cls]
        sy = ay * x / np.sqrt(1.0 + 1e-4 * x)
        if cls == "A":
            sz = 0.20 * x
        elif cls == "B":
            sz = 0.12 * x
        elif cls == "C":
            sz = 0.08 * x / np.sqrt(1.0 + 2e-4 * x)
        elif cls == "D":
            sz = 0.06 * x / np.sqrt(1.0 + 1.5e-3 * x)
        elif cls == "E":
            sz = 0.03 * x / (1.0 + 3e-4 * x)
        else:
            sz = 0.016 * x / (1.0 + 3e-4 * x)
        return np.maximum(sy, 1.0), np.maximum(sz, 1.0)

    def _plume(self, out, px, py, height_m, kind, w, wob, scale):
        """Add one source's dimensionless dispersion field into `out` (in place)."""
        if scale <= 0.0:
            return
        u10 = max(0.5, w.speed_ms)
        cls = w.stability
        u = max(0.6, u10 * (max(height_m, 4.0) / 10.0) ** _WIND_EXP[cls])
        # buoyant rise + a stack-height floor for ground-level sources
        h_eff = max(2.5, height_m + RISE.get(kind, 0.0) / u)
        # plume meander: slow wobble of the axis, and extra lateral spread when calm
        theta = math.radians(w.transport_deg + wob)
        ux, uy = math.sin(theta), math.cos(theta)
        meander = 1.0 + 1.7 / max(0.8, u10)

        # sub-window: the lobe reaches ~4.5 km downwind and ~1.8 km across
        L, Wd = 4200.0, 1450.0
        cx = [0.0, L, L, 0.0]
        cy = [-Wd, -Wd, Wd, Wd]
        xs = [px + ux * a - uy * b for a, b in zip(cx, cy)]
        ys = [py + uy * a + ux * b for a, b in zip(cx, cy)]
        c0 = max(0, int((min(xs) - self.x0) / self.cell))
        c1 = min(self.grid_n, int((max(xs) - self.x0) / self.cell) + 2)
        r0 = max(0, int((min(ys) - self.y0) / self.cell))
        r1 = min(self.grid_n, int((max(ys) - self.y0) / self.cell) + 2)
        if c1 <= c0 or r1 <= r0:
            return
        dx = self.X[r0:r1, c0:c1] - px
        dy = self.Y[r0:r1, c0:c1] - py
        along = dx * ux + dy * uy
        cross = -dx * uy + dy * ux
        r2 = dx * dx + dy * dy

        pos = np.maximum(along, 6.0) + SIGMA_X0
        sy, sz = self._sigmas(pos, cls)
        sy = sy * meander
        vert = 2.0 * np.exp(-(h_eff**2) / (2.0 * sz**2)) / (SQRT2PI * sz)
        # boundary-layer trapping: once sigma_z outgrows the mixed layer the plume
        # is uniform through it, which is the floor rather than the Gaussian tail
        trapped = np.where(sz > 0.8 * w.pbl_m, 1.0 / w.pbl_m, 0.0)
        vert = np.maximum(vert, trapped)
        conc = (
            np.exp(-(cross**2) / (2.0 * sy**2))
            * vert
            / (SQRT2PI * sy * u)
        )
        conc = np.where(along > 0.0, conc, 0.0)
        # isotropic near field so an upwind fenceline node is not blind
        near = NEAR_Q * np.exp(-r2 / (2.0 * NEAR_SIGMA_M**2)) / (0.7 + 0.5 * u10)
        out[r0:r1, c0:c1] += scale * (conc + near)

    # ------------------------------------------------------------------ hourly

    def rasters(self, h: int) -> dict[str, np.ndarray]:
        if self._cache_h == h:
            return self._cache
        w = self.wind[h]
        hod = h % 24
        day = h / 24.0
        n = self.grid_n
        seed = self.seed
        # ---- 1. regional background (coarse fBm, upsampled: it is smooth by design)
        cn = 64
        U, V = np.meshgrid(self._bg_u0 + self.adv_x[h] / 46.0, self._bg_v0 + self.adv_y[h] / 46.0)
        Z = np.zeros((cn, cn))
        bg_nox_c = fbm3(U, V, Z + day * 0.30 + 2.0, seed + 1001, octaves=3)
        bg_o3_c = fbm3(U * 0.55, V * 0.55, Z + day * 0.22 + 6.0, seed + 1013, octaves=3)
        bg_haze_c = fbm3(U * 0.7, V * 0.7, Z + day * 0.26 + 11.0, seed + 1019, octaves=3)
        bg_ch4_c = fbm3(U * 1.1, V * 1.1, Z + day * 0.18 + 17.0, seed + 1031, octaves=3)

        def up(c):
            return bilinear_sample(c, self._up_gx, self._up_gy)

        bg_nox = BG_NOX_PPB[0] + BG_NOX_PPB[1] * up(bg_nox_c)
        bg_o3 = BG_O3_PPB[0] + BG_O3_PPB[1] * up(bg_o3_c)
        bg_haze = BG_HAZE[0] + BG_HAZE[1] * up(bg_haze_c)
        haze_ep = 1.0
        for d0, sg, amp in HAZE_EPISODES:
            haze_ep += (amp - 1.0) * math.exp(-(((day - d0) / sg) ** 2))
        bg_haze = bg_haze * haze_ep
        bg_ch4 = BG_CH4_PPM[0] + BG_CH4_PPM[1] * up(bg_ch4_c)

        # ---- diurnal / stability modifiers
        dn_no2 = 0.62 + 0.50 * math.exp(-(((hod - 7.5) / 2.3) ** 2)) + 0.62 * math.exp(-(((hod - 19.5) / 2.8) ** 2))
        dn_o3 = 0.24 + 0.80 * max(0.0, math.sin((hod - 6.0) / 24.0 * 2 * math.pi)) ** 1.4
        # ozone episodes are hot, sunny and stagnant -- tie the regional amplitude to
        # temperature and insolation so exceedances land on believable days.
        dn_o3 *= 0.82 + 0.30 * min(1.40, max(-1.2, (w.temp_c - 27.0) / 6.5)) + 0.18 * w.solar
        photo = max(0.0, math.sin((hod - 6.5) / 24.0 * 2 * math.pi)) ** 2 * w.solar
        trap = min(2.7, max(0.62, (NIGHT_TRAP_REF_M / w.pbl_m) ** 0.55))
        trap_pm = min(1.95, max(0.74, (NIGHT_TRAP_REF_M / w.pbl_m) ** 0.48))

        # ---- 2. point-source plumes, one dispersion raster per emitted species
        D = {k: np.zeros((n, n)) for k in ("nox", "co", "co2", "pm", "bc", "ch4")}
        for idx, p, px, py, duty, wob in self.points:
            act = float(duty[h])
            if act <= 0.002:
                continue
            tmp = np.zeros((n, n))
            self._plume(tmp, px, py, p.height_m, p.kind, w, float(wob[h]), act)
            for sp, kv in p.strength.items():
                if kv:
                    D[sp] += tmp * kv

        # ---- 3. line sources
        mix = min(1.0, max(0.0, (w.speed_ms - 1.0) / 5.0)) * (0.35 if w.stability in "EF" else 1.0)
        tr = self.tr_tight * (1 - mix) + self.tr_wide * mix
        hd = self.hd_tight * (1 - mix) + self.hd_wide * mix
        # rush-hour double peak; heavy duty is broad-daytime with a pre-dawn shoulder
        rush = (
            0.30
            + 0.95 * math.exp(-(((hod - 7.6) / 1.55) ** 2))
            + 1.00 * math.exp(-(((hod - 17.2) / 2.05) ** 2))
            + 0.22 * math.exp(-(((hod - 12.5) / 3.0) ** 2))
        )
        if hod < 5 or hod > 22:
            rush *= 0.35
        truck_h = 0.22 + 0.85 * math.exp(-(((hod - 11.0) / 5.2) ** 2)) + 0.25 * math.exp(-(((hod - 4.0) / 1.8) ** 2))
        wk = 1.0 if (h // 24) % 7 < 5 else 0.72  # weekend traffic relief
        tr_f = tr * rush * wk * trap
        hd_f = hd * truck_h * wk * trap

        # ---- 4. industry fugitive floor (dust, handling losses)
        ind = self.industry * (0.55 + 0.45 * float(bg_haze_c.mean())) * trap

        # ---- 5. compose
        out = self._compose(bg_nox, bg_o3, bg_haze, bg_ch4, D, tr_f, hd_f, ind,
                            dn_no2, dn_o3, photo, trap, trap_pm, w, h, day)
        self._cache_h = h
        self._cache = out
        return out

    def _compose(self, bg_nox, bg_o3, bg_haze, bg_ch4, D, tr, hd, ind,
                 dn_no2, dn_o3, photo, trap, trap_pm, w, h, day):
        m_a, m_b, m_c = self.micro_a, self.micro_b, self.micro_c
        slow = 0.8 + 0.4 * math.sin(day / 21.0 * 2 * math.pi)

        no2_bg = bg_nox * dn_no2
        no2_loc = _soft_cap(
            K_PT_NO2 * D["nox"] * trap + K_TR_NO2 * tr + 0.85 * ind, 190.0
        ) + MICRO["no2"] * m_a * slow
        no2 = np.maximum(0.6, (no2_bg + no2_loc) * (1.0 - NO2_PHOTOLYSIS * photo))

        # O3 is regional and *destroyed* by fresh NOx -- the anti-correlation that
        # makes a real dataset recognisable.
        nox_excess = np.maximum(0.0, no2 - no2_bg)
        o3 = np.clip(
            bg_o3 * dn_o3 - O3_TITRATION * nox_excess + MICRO["o3"] * m_c * 0.8,
            1.5,
            220.0,
        )

        pm25 = np.maximum(
            1.2,
            bg_haze * trap_pm
            + _soft_cap(K_PT_PM * D["pm"] * trap + K_TR_PM * tr + 1.35 * ind, 105.0)
            + MICRO["pm25"] * m_b * slow,
        )

        # BC: the tightest gradients on the map. Heavy-duty line source only,
        # tight blur, and the diesel point sources.
        bc = np.maximum(
            0.03,
            0.100 + 0.021 * bg_haze
            + _soft_cap(K_PT_BC * D["bc"] * trap * 1.12 + K_TR_BC * hd + 0.10 * ind, 16.0)
            + MICRO["bc"] * m_b,
        )

        co = np.maximum(
            0.04,
            0.095 + 0.0065 * bg_nox
            + _soft_cap(K_PT_CO * D["co"] * trap + K_TR_CO * tr + 0.05 * ind, 5.5)
            + MICRO["co"] * m_a,
        )

        # CO2: clear background floor plus combustion; night biogenic respiration.
        resp = 5.0 + 9.0 * max(0.0, (620.0 / w.pbl_m - 0.9))
        co2 = (
            CO2_FLOOR_PPM
            + 2.6 * (bg_nox - BG_NOX_PPB[0]) / BG_NOX_PPB[1]
            + _soft_cap(K_PT_CO2 * D["co2"] * trap + K_TR_CO2 * tr, 520.0)
            + resp
            + MICRO["co2"] * m_a
        )

        # CH4: flat background punctuated by discrete leak hotspots.
        ch4 = bg_ch4 + _soft_cap(K_PT_CH4 * D["ch4"] * trap, 12.0) + MICRO["ch4"] * m_c
        for li, (lk, blob) in enumerate(self.leak_blobs):
            g = 1.0 + (lk.growth - 1.0) * (h / max(1, self.n_hours - 1))
            act = float(self.leak_duty[li][h])
            ch4 = ch4 + blob * lk.ppm_peak * g * act * min(2.1, trap)

        return {"no2": no2, "pm25": pm25, "bc": bc, "o3": o3, "co": co, "co2": co2, "ch4": ch4}

    # ------------------------------------------------------------------ sampling

    def sample(self, h: int, lons, lats) -> dict[str, np.ndarray]:
        """Bilinear-sample every measure at the given points for hour `h`.

        Returns the 7 modalities plus the 3 derived indicators.  Indicators are
        pointwise functions of the modalities, so they are derived after sampling
        rather than rasterised.
        """
        r = self.rasters(h)
        x, y = self.proj.xy_arr(np.asarray(lons, dtype=float), np.asarray(lats, dtype=float))
        gx = (x - self.x0) / self.cell
        gy = (y - self.y0) / self.cell
        out = {k: bilinear_sample(v, gx, gy) for k, v in r.items()}
        return derive_indicators(out)


def derive_indicators(v: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """`diesel`, `nondiesel`, `methane_leak` from the sampled modalities."""
    bc_ex = np.maximum(0.0, v["bc"] - 0.15)
    no2_ex = np.maximum(0.0, v["no2"] - 8.0)
    diesel = 2.25 * np.sqrt(bc_ex * no2_ex / 12.0)
    v = dict(v)
    v["diesel"] = diesel
    v["nondiesel"] = np.maximum(0.25, v["pm25"] - diesel)
    v["methane_leak"] = np.maximum(0.0, v["ch4"] - 1.928)
    return v
