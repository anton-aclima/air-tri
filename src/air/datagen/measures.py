"""`measure_def` and default `action_level` content.

Ten measures: the seven ambient modalities Aclima's mobile platforms carry, plus
three derived indicators.  Every number here is a *plausible guess* meant to be
tweaked from the admin interface -- that is an explicit requirement of the build
contract, not a shortcut.

`plain_name` is the community-facing wording.  The community interface shows
`plain_name` and never `label`, so these are written for a resident who has never
heard of PM2.5.  No units, no acronyms, no chemistry.

`scale_json` is a piecewise-linear map from concentration to a 0-100 unitless
"risk" score: `[[concentration, risk], ...]`, ascending, interpolated between
breakpoints and clamped at the ends.  `stats.risk_from_scale` is the reference
implementation; the frontend must produce the same numbers.

`ref_level` is the persistence threshold: `segment_stat.persistence` is the share
of passes on that segment above `ref_level`.  It is deliberately *not* a health
standard -- it is the level above which a street is "regularly elevated".

`ramp_json` is the fallback colour ramp.  Modalities carry the analytical
`--ramp-intensity-*` stops; indicators carry the public-health `--ramp-aqi-*`
stops, because indicators are what the community sees.  Kept in sync with
`web/src/design/tokens.css` by hand.
"""

from __future__ import annotations

import json

RAMP_INTENSITY = [
    "#10182F",
    "#24356F",
    "#4B3D9B",
    "#823C93",
    "#C0417F",
    "#E6614F",
    "#F79B3D",
    "#FFD84D",
]
RAMP_AQI = ["#3FBF8F", "#9ED45C", "#F2C744", "#F08A3C", "#E2544F", "#9B4FA8", "#7A2438"]


# code, label, short, unit, family, ref_level, healthy_max, scale, decimals, plain_name, description
_MEASURES: list[tuple] = [
    (
        "no2",
        "Nitrogen Dioxide",
        "NO2",
        "ppb",
        "modality",
        20.0,
        15.0,
        [[0, 0], [8, 12], [15, 25], [25, 42], [45, 62], [75, 82], [120, 100]],
        1,
        "traffic and engine fumes",
        "Combustion tracer from vehicles, turbines and generators. Strong morning and "
        "evening peaks; suppressed on sunny afternoons as photochemistry converts it.",
    ),
    (
        "pm25",
        "Fine Particulate Matter",
        "PM2.5",
        "ug/m3",
        "modality",
        12.0,
        9.0,
        [[0, 0], [5, 12], [9, 25], [15, 45], [25, 65], [40, 82], [90, 100]],
        1,
        "smoke and dust you breathe in",
        "Particles under 2.5 microns. A regional haze floor plus local combustion; "
        "builds up overnight when the boundary layer collapses.",
    ),
    (
        "bc",
        "Black Carbon",
        "BC",
        "ug/m3",
        "modality",
        1.0,
        0.6,
        [[0, 0], [0.35, 12], [0.7, 25], [1.4, 45], [2.8, 65], [5.5, 85], [12, 100]],
        2,
        "diesel soot",
        "Soot from diesel engines and turbine startup. The sharpest gradients in the "
        "dataset: elevated within a block of a truck route, back to background beyond it.",
    ),
    (
        "o3",
        "Ozone",
        "O3",
        "ppb",
        "modality",
        55.0,
        50.0,
        [[0, 0], [25, 10], [45, 25], [60, 42], [72, 62], [88, 84], [110, 100]],
        1,
        "smog on hot afternoons",
        "Secondary pollutant formed in sunlight. Regional, peaks mid-afternoon, near "
        "zero at night, and destroyed locally by fresh engine exhaust.",
    ),
    (
        "co",
        "Carbon Monoxide",
        "CO",
        "ppm",
        "modality",
        0.6,
        0.45,
        [[0, 0], [0.25, 10], [0.5, 24], [1.0, 42], [2.5, 62], [6, 84], [12, 100]],
        2,
        "invisible exhaust gas",
        "Incomplete-combustion tracer. Tracks NO2 closely; useful for separating "
        "fresh exhaust from aged regional air.",
    ),
    (
        "co2",
        "Carbon Dioxide",
        "CO2",
        "ppm",
        "modality",
        450.0,
        430.0,
        [[400, 0], [425, 10], [445, 24], [480, 42], [560, 62], [720, 84], [1100, 100]],
        0,
        "greenhouse gas from burning fuel",
        "Not a local health pollutant, but the cleanest quantitative tracer of how much "
        "fuel is being burned nearby. Background floor near 420 ppm.",
    ),
    (
        "ch4",
        "Methane",
        "CH4",
        "ppm",
        "modality",
        2.1,
        2.0,
        [[1.8, 0], [1.95, 8], [2.1, 22], [2.6, 45], [4.0, 66], [8.0, 86], [20, 100]],
        2,
        "natural gas leaks",
        "Flat regional background near 1.92 ppm punctuated by tight, discrete leak "
        "plumes. Invisible to a sparse stationary network; a mobile platform drives "
        "straight through it.",
    ),
    (
        "methane_leak",
        "Methane Leak Indicator",
        "CH4 excess",
        "ppm",
        "indicator",
        0.15,
        0.05,
        [[0, 0], [0.04, 10], [0.12, 26], [0.4, 48], [1.5, 70], [5, 88], [15, 100]],
        2,
        "signs of a gas leak nearby",
        "Methane above the local rolling background. Isolates leak plumes from the "
        "regional methane floor, so a single elevated pass is actionable.",
    ),
    (
        "diesel",
        "Diesel Combustion",
        "Diesel",
        "ug/m3",
        "indicator",
        1.2,
        0.8,
        [[0, 0], [0.4, 12], [0.9, 28], [1.8, 48], [3.5, 68], [7, 88], [15, 100]],
        2,
        "diesel truck and generator exhaust",
        "Diesel-attributable particulate, derived from the co-variance of black carbon "
        "and NO2 excess. High only where both are elevated together.",
    ),
    (
        "nondiesel",
        "Non-Diesel Combustion",
        "Non-diesel",
        "ug/m3",
        "indicator",
        8.0,
        6.0,
        [[0, 0], [3, 12], [7, 28], [12, 48], [20, 68], [32, 88], [60, 100]],
        1,
        "other smoke and burning",
        "The part of PM2.5 that is not diesel-attributable: regional haze, gas "
        "combustion, cooking, brake and road dust.",
    ),
]


# ---------------------------------------------------------------- composites

SENSE = "aclima_sense"

# Health Canada AQHI coefficients (Stieb et al. 2008): mutually-adjusted
# log-relative-risks of same-day non-accidental mortality, from a JOINT
# three-pollutant time-series model over 12 cities. Being jointly estimated is
# the whole licence for adding them: NO2, PM2.5 and every combustion tracer in
# this dataset are correlated at r = 0.57-0.93, so single-pollutant coefficients
# would re-weight one latent factor several times and call it independent
# evidence. Units are per-ppb for the gases and per-ug/m3 for PM2.5, which is
# exactly what UNITS already stores -- `stats` asserts that at build time.
SENSE_BETA = {"no2": 0.000871, "o3": 0.000537, "pm25": 0.000487}

# 1000/10.4 is the AQHI's own normaliser; the extra x10 maps AQHI 1-10 onto
# 0-100 so the published band edges survive: 30 = top of Low, 60 = top of
# Moderate, 100 = AQHI 10.
SENSE_K = 10 * (1000.0 / 10.4)

_SENSE_DESC = (
    "A derived index, not a measurement. "
    "sense = 961.538 x [ (e^0.000871*NO2ppb - 1) + (e^0.000537*O3ppb - 1) "
    "+ (e^0.000487*PM25ugm3 - 1) ], clamped to 0-100, computed on each drive-by pass "
    "and then aggregated like any other measure. "
    "The three weights are same-day mortality coefficients from the joint "
    "three-pollutant model behind Health Canada's AQHI (Stieb et al. 2008). They are "
    "mutually adjusted -- estimated together -- which is the only thing that makes "
    "adding them legitimate, because NO2 and PM2.5 are far too correlated to combine "
    "with coefficients fitted separately. The scale is AQHI x10, so 30 = top of the "
    "Low band and 60 = top of Moderate. "
    "IT IS NOT THE AQHI OF THIS STREET. The coefficients were fitted on 3-hour "
    "averages; this applies them to instantaneous curbside air, which runs higher. "
    "On this campaign the typical street reads 27 that way, against 20 if the index "
    "were evaluated at each pollutant's median instead -- a 7-point gap that comes "
    "from NO2 and ozone being anti-correlated at the curb, so most passes are "
    "elevated in one or the other while neither median is high. "
    "The per-pass version is published because it is the only one for which the "
    "spread, the worst pass and the persistence share mean anything. "
    "It covers three pollutants and no others -- nothing here sees methane, CO2, "
    "carbon monoxide or black carbon, so a gas leak scoring zero is not a safe leak. "
    "It is short-term risk, not lifetime burden: the risk of being outside on a bad "
    "day here, not the risk of living here for twenty years. "
    "It is not an AQI and is not comparable to one. "
    "Source: Aclima construct, after Stieb et al. 2008. No agency publishes this "
    "number and there is no external standard behind it."
)

# Same 11-field shape as _MEASURES. `ref_level` and `healthy_max` are INDEX
# POINTS, not concentrations. The scale is the identity on purpose: the value is
# already 0-100, and a second ladder on top of it would be an undocumented
# transform -- see `stats.risk_from_scale` and the frontend's `riskFromValue`,
# both of which become no-ops against it.
_COMPOSITES: list[tuple] = [
    (
        SENSE,
        "Aclima Sense",
        "Sense",
        "",
        "composite",
        # Both land on 30 = AQHI 3, the top of Health Canada's Low band -- the
        # one externally anchored boundary on this scale. As `ref_level` it is
        # also, by luck rather than design, where `persistence` spreads widest on
        # this campaign: the per-pass index runs p25/p50/p75 = 21.7/28.1/39.3, so
        # a threshold of 30 splits roughly in half and the width channel carries
        # real contrast (persistence p10/p50/p90 = 0.32/0.42/0.54).
        # An earlier draft used 20, which was read off the index-of-medians
        # distribution -- not the one that ships. At 20 nearly every pass exceeds
        # and the width channel goes flat.
        30.0,
        30.0,
        [[0, 0], [100, 100]],
        0,
        "the overall health score",
        _SENSE_DESC,
    ),
]


def measure_rows() -> list[dict]:
    out = []
    for i, (
        code,
        label,
        short,
        unit,
        family,
        ref,
        healthy,
        scale,
        dec,
        plain,
        desc,
    ) in enumerate(_COMPOSITES + _MEASURES):
        out.append(
            {
                "code": code,
                "label": label,
                "short_label": short,
                "unit": unit,
                "family": family,
                "ref_level": ref,
                "healthy_max": healthy,
                "scale_json": json.dumps(scale),
                # Modalities are analytical magnitude; indicators and the health
                # composite are public-health colour.
                "ramp_json": json.dumps(RAMP_INTENSITY if family == "modality" else RAMP_AQI),
                "decimals": dec,
                "sort_order": i,
                "description": desc,
                "plain_name": plain,
            }
        )
    return out


# MEASURE_CODES / MODALITIES / INDICATORS drive the *physical* pipeline:
# `simulate` splices MODALITIES + INDICATORS into the `segment_pass` column
# tuple and subscripts MOBILE_NOISE with each one. A composite has no per-pass
# column and no instrument noise, so it must stay out of all three or the build
# dies before it reaches the database. The lookup maps below are a different
# job -- `stats` indexes them per emitted row -- so those do include it.
MEASURE_CODES = [m[0] for m in _MEASURES]
MODALITIES = [m[0] for m in _MEASURES if m[4] == "modality"]
INDICATORS = [m[0] for m in _MEASURES if m[4] == "indicator"]
COMPOSITES = [m[0] for m in _COMPOSITES]

_ALL = _COMPOSITES + _MEASURES
REF_LEVELS = {m[0]: m[5] for m in _ALL}
SCALES = {m[0]: m[7] for m in _ALL}
UNITS = {m[0]: m[3] for m in _ALL}
DECIMALS = {m[0]: m[8] for m in _ALL}


# ---------------------------------------------------------------- action levels

# label, measure, kind, threshold, averaging_hours, severity, source
_ACTION_LEVELS = [
    ("NO2 1-hour watch", "no2", "spike", 60.0, 1, "watch", "DRAQA local screening"),
    ("NO2 1-hour standard", "no2", "spike", 100.0, 1, "warning", "EPA NAAQS 1-hr"),
    ("Ozone 8-hour standard", "o3", "integrated", 70.0, 8, "warning", "EPA NAAQS 8-hr"),
    ("Ozone 8-hour watch", "o3", "integrated", 62.0, 8, "watch", "DRAQA local screening"),
    ("PM2.5 24-hour standard", "pm25", "integrated", 35.0, 24, "warning", "EPA NAAQS 24-hr"),
    ("PM2.5 24-hour watch", "pm25", "integrated", 25.0, 24, "watch", "DRAQA local screening"),
    ("PM2.5 1-hour spike", "pm25", "spike", 55.0, 1, "watch", "DRAQA local screening"),
    ("Black carbon 1-hour spike", "bc", "spike", 5.0, 1, "watch", "DRAQA local screening"),
    ("Diesel exposure 8-hour", "diesel", "integrated", 3.0, 8, "watch", "DRAQA local screening"),
    ("Methane leak screening", "ch4", "spike", 5.0, 1, "watch", "DRAQA leak screening"),
    ("CO 8-hour standard", "co", "integrated", 9.0, 8, "info", "EPA NAAQS 8-hr"),
]


def action_level_rows(campaign_id: str, updated_at: str) -> list[dict]:
    out = []
    for i, (label, measure, kind, thr, avg, sev, src) in enumerate(_ACTION_LEVELS):
        out.append(
            {
                "id": f"al-{measure}-{kind}-{i:02d}",
                "campaign_id": campaign_id,
                "measure": measure,
                "label": label,
                "kind": kind,
                "threshold": thr,
                "unit": UNITS[measure],
                "averaging_hours": avg,
                "severity": sev,
                "enabled": 1,
                "source": src,
                "notify_community": 1 if sev in ("warning", "critical") else 0,
                "notify_industry": 1,
                "updated_at": updated_at,
            }
        )
    return out
