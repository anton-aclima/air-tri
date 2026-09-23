"""Deterministic fallback for POST /advisor.

The demo must never break because of a missing key or a network hiccup, so this
rules engine produces a real, specific recommendation from alert kind + measure
+ wind direction + site geometry. It is keyed, not random: same input, same
answer.
"""

from __future__ import annotations

from typing import Any

from air.server import geo

MEASURE_LEVERS = {
    "no2": ("gas turbine load", "combustion NOx tracks turbine load almost linearly"),
    "pm25": ("diesel backup generators", "PM is dominated by diesel combustion on this campus"),
    "bc": ("diesel backup generators", "black carbon is a direct diesel-soot marker"),
    "co": ("burner tuning on the turbines", "CO rises when combustion runs rich"),
    "o3": ("NOx precursors — turbine load in the afternoon", "ozone is formed downwind from NOx and sunlight"),
    "co2": ("total generation dispatch", "CO2 scales with fuel burn, not with tuning"),
    "ch4": ("gas supply train and turbine seals", "methane at the fenceline means unburned fuel"),
    "methane_leak": ("gas supply train and turbine seals", "a leak indicator means unburned fuel is escaping"),
    "diesel": ("diesel backup generators", "the diesel indicator isolates compression-ignition exhaust"),
    "nondiesel": ("gas turbine load", "the non-diesel indicator points at the gas fleet"),
    # No single lever moves a composite: it is built from three pollutants with
    # different sources, so the honest advice is to name the term that is driving
    # it rather than to pretend there is one dial.
    "aclima_sense": ("whichever of NOx, PM or ozone precursors is driving the score",
                     "this is a health index over three pollutants, not a tracer with one source"),
}

SEVERITY_THROTTLE = {"critical": 40, "warning": 25, "watch": 15, "info": 10}
SEVERITY_HOURS = {"critical": 6, "warning": 4, "watch": 2, "info": 1}
CONFIDENCE = {"monitor": "high", "mobile": "medium", "community": "medium", "regulator": "high", "model": "low"}


def _upwind_points(points: list[dict[str, Any]], site_centroid, target) -> list[dict[str, Any]]:
    """Emission points that sit between the site and the alert — the ones that matter."""
    if target is None or not points:
        return points[:3]
    tlon, tlat = target
    scored = []
    for p in points:
        if not p.get("active"):
            continue
        brg = geo.bearing_deg(p["lon"], p["lat"], tlon, tlat)
        dist = geo.haversine_m(p["lon"], p["lat"], tlon, tlat)
        scored.append((dist, brg, p))
    scored.sort(key=lambda s: s[0])
    return [p for _, _, p in scored[:3]]


def build(ctx: dict[str, Any]) -> dict[str, Any]:
    alert = ctx.get("alert") or {}
    site = ctx.get("site") or {}
    wind = ctx.get("wind") or {}
    concerns = ctx.get("concerns") or []
    mdef = ctx.get("measure_def") or {}
    levels = ctx.get("action_levels") or []
    points = (site.get("emission_points") or [])

    kind = alert.get("kind") or "regulatory_notice"
    severity = alert.get("severity") or "watch"
    measure = alert.get("measure") or "no2"
    short = mdef.get("short_label") or measure.upper()
    unit = alert.get("unit") or mdef.get("unit") or ""
    lever, why = MEASURE_LEVERS.get(measure, ("primary combustion sources", "this is a combustion tracer"))

    target = None
    if alert.get("lon") is not None and alert.get("lat") is not None:
        target = (alert["lon"], alert["lat"])
    centroid = site.get("centroid")
    brg = alert.get("bearing_deg")
    dist = alert.get("distance_m")
    if brg is None and centroid and target:
        brg = round(geo.bearing_deg(centroid[0], centroid[1], target[0], target[1]), 1)
        dist = round(geo.haversine_m(centroid[0], centroid[1], target[0], target[1]), 1)
    where = f"{geo.compass(brg)} ({brg:.0f}°)" if brg is not None else "on the fenceline"
    range_txt = f" at {int(dist)} m" if dist else ""

    # Prefer wind our own anemometers measured over the modelled hourly row.
    measured = ctx.get("measured_local_wind") or {}
    wind_from = measured.get("dir_deg", wind.get("dir_deg"))
    wind_speed = measured.get("speed_ms", wind.get("speed_ms") or 0.0)
    wind_txt = ""
    downwind = False
    if wind_from is not None:
        blows_to = (wind_from + 180.0) % 360.0
        if measured:
            win = f" over the last {measured['window_h']:.0f} h" if measured.get("window_h") else ""
            wind_txt = (
                f"Our vehicles measured wind from {geo.compass(wind_from)} at "
                f"{wind_speed:.1f} m/s{win} (spread {measured.get('dir_sd', 0):.0f}° over "
                f"{measured.get('n', 0)} observations), carrying the plume toward "
                f"{geo.compass(blows_to)}."
            )
        else:
            wind_txt = (
                f"Wind is from {geo.compass(wind_from)} at {wind_speed:.1f} m/s "
                f"(stability {wind.get('stability') or 'D'}), carrying the plume toward "
                f"{geo.compass(blows_to)}."
            )
        if brg is not None:
            delta = abs(((blows_to - brg + 180.0) % 360.0) - 180.0)
            downwind = delta <= 55.0

    throttle = SEVERITY_THROTTLE.get(severity, 15)
    hours = SEVERITY_HOURS.get(severity, 2)
    if downwind:
        throttle += 10
    nearest = _upwind_points(points, centroid, target)
    named = ", ".join(p["name"] for p in nearest) or "the nearest generator bank"
    expected = min(60, int(throttle * 0.75)) if downwind else min(45, int(throttle * 0.55))

    actions: list[dict[str, Any]] = []

    if kind in ("exceedance", "integrated_exposure", "mobile_detection"):
        threshold = alert.get("threshold")
        value = alert.get("value")
        over = ""
        if value is not None and threshold:
            over = f" — {value:.1f} against {threshold:g} {unit} ({100 * (value / threshold - 1):.0f}% over)"
        recommendation = (
            f"Throttle {named} by {throttle}% for the next {hours} h. The {short} contact bears "
            f"{where}{range_txt}{over}. {'You are directly upwind of it. ' if downwind else ''}"
            f"Shift the deferrable compute to the {geo.compass((brg + 180) % 360) if brg is not None else 'opposite'} "
            f"side of the campus while the level clears."
        )
        actions = [
            {
                "label": f"Reduce {lever} by {throttle}%",
                "detail": f"Apply to {named} for {hours} h, then step back in 10% increments while watching the fenceline ring.",
                "impact": f"≈{expected}% lower {short} at the affected fenceline within one averaging period",
            },
            {
                "label": "Defer non-urgent compute",
                "detail": f"Move batch and training workloads out of the {hours} h window, or to racks fed from grid supply rather than on-site generation.",
                "impact": f"Removes {max(5, throttle // 2)}% of generation demand without a customer-visible impact",
            },
            {
                "label": "Confirm with the fenceline ring before reporting",
                "detail": (
                    f"Compare the {short} reading against your own ring and the nearest reference monitor. "
                    "A single stationary sensor over the line is not yet an attribution."
                ),
                "impact": None,
            },
        ]
        if measure in ("ch4", "methane_leak"):
            actions.insert(
                1,
                {
                    "label": "Walk the gas train for leaks",
                    "detail": "Survey supply piping, filter skids and turbine seals with a handheld before assuming combustion is the cause.",
                    "impact": "A single seal can account for the whole signal",
                },
            )

    elif kind == "concern_cluster":
        count = int(alert.get("value") or len(concerns) or 3)
        kinds = sorted({c.get("kind") for c in concerns if c.get("kind")}) or ["smell"]
        recommendation = (
            f"{count} community reports ({', '.join(kinds)}) have clustered {where}{range_txt}. "
            f"{wind_txt} Post an acknowledgement to the community feed today, then throttle {named} "
            f"by {throttle}% during the reported hours."
        )
        actions = [
            {
                "label": "Acknowledge in the community feed",
                "detail": (
                    "Post a short, plain-language update naming the window you are investigating. "
                    "You cannot close a community concern — proposing a mitigation is what lands."
                ),
                "impact": "Stops the cluster from escalating into a regulator inquiry",
            },
            {
                "label": f"Throttle {lever} by {throttle}% during the reported hours",
                "detail": f"Apply to {named} across the same time-of-day window the reports came from, for {max(2, hours)} h.",
                "impact": f"≈{expected}% lower {short} toward the reporting neighbourhood",
            },
            {
                "label": "Pull your own logs for the reported window",
                "detail": "Cross-check generator starts, cooling-tower cycles and gate truck traffic against the report timestamps.",
                "impact": None,
            },
        ]

    elif kind == "wind_shift":
        recommendation = (
            f"The wind has veered. {wind_txt} Your plume now runs over receptors that were clear an hour ago. "
            f"Pre-emptively reduce {lever} by {throttle}% and hold until the direction stabilises."
        )
        actions = [
            {
                "label": f"Pre-emptive {throttle}% reduction on {named}",
                "detail": f"Hold for {hours} h or until the wind backs by more than 45°.",
                "impact": f"≈{expected}% lower downwind {short} through the shift",
            },
            {
                "label": "Re-check the downwind receptor list",
                "detail": "Schools, clinics and the reporting neighbourhoods that were previously crosswind are now in the plume path.",
                "impact": None,
            },
        ]

    else:
        recommendation = (
            f"{alert.get('title') or 'Contact'} bears {where}{range_txt}. {wind_txt} "
            f"Review {lever} and confirm the signal against your fenceline ring before responding."
        )
        actions = [
            {
                "label": "Confirm the signal",
                "detail": "Compare against your own ring and the nearest reference monitor before changing dispatch.",
                "impact": None,
            },
            {
                "label": f"Stage a {throttle}% reduction on {named}",
                "detail": f"Have it ready to apply for {hours} h if the contact stays up.",
                "impact": f"≈{expected}% lower {short} if applied",
            },
        ]

    ver = ctx.get("model_verification") or {}
    if ver.get("verdict") == "understates":
        who = ", ".join(d["district"] for d in (ver.get("affected_districts") or [])[:2]) or "downwind receptors"
        bearings = ", ".join(f"{b:.0f}°" for b in (ver.get("understated_bearings") or [])[:3])
        actions.append(
            {
                "label": "Re-run the dispersion study with our measured rose",
                "detail": (
                    f"{ver.get('model_name') or 'The study on file'} under-weights wind from "
                    f"{bearings or 'several sectors'}; {ver['disagreement'] * 100:.0f}% of the hours we "
                    f"measured fall outside its contour, and {who} sits downwind on those days. "
                    "Treat that transport as live until the study is revised."
                ),
                "impact": "Removes the biggest attribution risk at the next permit review",
            }
        )
    elif ver.get("verdict") == "insufficient_data":
        actions.append(
            {
                "label": "Keep collecting before judging the study",
                "detail": (
                    f"Only {ver.get('n_obs', 0)} usable mobile wind observations so far — not enough to "
                    "compare against the consultant's rose. More passes, then re-check."
                ),
                "impact": None,
            }
        )

    level_txt = ""
    if levels:
        lv = levels[0]
        level_txt = (
            f" The governing action level is {lv['label']} at {lv['threshold']:g} {lv['unit']} "
            f"({lv['kind']}, {lv['averaging_hours']:g} h)."
        )
    ver_txt = ""
    if ver.get("verdict") in ("understates", "overstates"):
        ver_txt = f" Our measured rose {ver['verdict']} against {ver.get('model_name') or 'the study on file'}."
    # The envelope sentence used to quote `site.headroom_pct` — a constant baked
    # into the generator, identical on a still night and a windy afternoon, that
    # an operator could not check. Quoting it to an operator (or to a model that
    # then quotes it back) is asserting something nobody measured. The measured
    # envelope lives on `GET /sites/{id}/envelope`; the rules advisor has no
    # database handle here, so it says nothing rather than something false.
    env_txt = ""
    if ctx.get("envelope"):
        e = ctx["envelope"]
        env_txt = (
            f" In {e['regime']} air your fenceline runs {e['excess']:+.0f} {e['unit']} over "
            f"comparable roads, measured over {e['episodes']} episodes."
        )
    rationale = f"{why.capitalize()}, so {lever} is the shortest lever. {wind_txt}{ver_txt}{level_txt}{env_txt}"

    return {
        "recommendation": recommendation.strip(),
        "actions": actions,
        "rationale": rationale.strip(),
        "confidence": CONFIDENCE.get(alert.get("source_type") or "", "medium"),
        "source": "rules",
    }
