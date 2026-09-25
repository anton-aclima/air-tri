"""Deterministic fallback for POST /advisor.

The demo must never break because of a missing key or a network hiccup, so this
rules engine produces a real, specific recommendation from alert kind + measure
+ the wind when the alert began + site geometry. It is keyed, not random: same
input, same answer. It is also the answer that stays on screen whenever the
model's reply fails `advisor_copy.screen`, so it has to pass that screen itself
(tests/test_advisor_copy.py runs every branch through it).

PLAIN LANGUAGE (CONTRACT 10a.7, owner review 2026-09-23). This text used to
read like the radar dial it sat beside — "the NO2 contact bears ENE (072°) at
6268 m", "while the level clears", "watching the fenceline ring". An alert is
an alert and a place is "6.3 km NE of the site".

WHAT THE ADVICE MAY DO (phase 3 honesty review). Three things were wrong and
are the shape of this module now:

* **"Downwind" was judged from the latest 24 h of wind**, with a 55° cone, and
  answered with "+10% throttle" and "The wind is carrying air from the site
  toward it" — for an alert that began two days earlier on a different wind,
  and for another operator's monitor 6.3 km away. Attribution by proximity in
  the form of an action. The link is now F7 (`naming.alert_link`): the wind AT
  THE ALERT'S START carried from the site to it, inside the detection
  envelope, AND the site's placebo-checked downwind test for that pollutant is
  `elevated_downwind`. Only then does the advice cut load in response; an
  ongoing alert F7 does not link gets a reduction STAGED, to apply if the
  site's own fenceline sensors rise.
* **An ended alert was advised "for the next 4 h".** It now gets review
  advice: the hours it ran, the logs to pull, the sensors to compare.
  Another operator's fenceline sensor never draws a cut at all.
* **Every site got datacentre advice** — turbines, compute, racks — including
  a truck terminal and a remelt works. Levers and load-shifting now come from
  `industry_site.kind` and the site's own emission points.
"""

from __future__ import annotations

from typing import Any

from air.server import advisor_copy, geo, timeutil

# (lever, why) per site kind, per measure. The lever is what an operator of
# THAT kind of site can turn; the why is one plain sentence of chemistry.
SITE_LEVERS: dict[str, dict[str, tuple[str, str]]] = {
    "datacenter": {
        "no2": ("turbine load", "combustion NOx tracks turbine load almost linearly"),
        "nondiesel": ("turbine load", "the non-diesel indicator points at the gas turbines"),
        "pm25": ("diesel backup running", "particulate on this campus comes mostly from the diesel backup when it runs"),
        "bc": ("diesel backup running", "black carbon is a direct diesel-soot marker"),
        "diesel": ("diesel backup running", "the diesel indicator isolates compression-ignition exhaust"),
        "co": ("burner tuning on the turbines", "CO rises when combustion runs rich"),
        "o3": ("turbine load in the afternoon", "ozone forms downwind from NOx and sunlight"),
        "co2": ("total generation dispatch", "CO2 scales with fuel burn, not with tuning"),
        "ch4": ("the gas supply train and turbine seals", "methane at the fenceline means unburned fuel"),
        "methane_leak": ("the gas supply train and turbine seals", "a leak indicator means unburned fuel is escaping"),
    },
    "manufacturing": {
        "no2": ("furnace and boiler firing rate", "combustion NOx tracks firing rate"),
        "nondiesel": ("furnace and boiler firing rate", "the non-diesel indicator points at the gas-fired plant"),
        "pm25": ("furnace charging and scrap-yard handling", "particulate here comes from melting, charging and yard dust"),
        "bc": ("the diesel standby and yard trucks", "black carbon is a direct diesel-soot marker"),
        "diesel": ("the diesel standby and yard trucks", "the diesel indicator isolates compression-ignition exhaust"),
        "co": ("burner tuning on the furnaces and boilers", "CO rises when combustion runs rich"),
        "o3": ("furnace firing in the afternoon", "ozone forms downwind from NOx and sunlight"),
        "co2": ("total fuel burn", "CO2 scales with fuel burn, not with tuning"),
        "ch4": ("the gas supply to the furnaces and boilers", "methane at the fenceline means unburned fuel"),
        "methane_leak": ("the gas supply to the furnaces and boilers", "a leak indicator means unburned fuel is escaping"),
    },
    "logistics": {
        "no2": ("yard tractor, genset and truck-gate activity",
                "NOx here comes from diesel engines: yard tractors, reefer gensets and trucks at the gates"),
        "nondiesel": ("on-site vehicle activity", "the non-diesel indicator points away from the diesel fleet"),
        "pm25": ("diesel idling in the yard and at the gates", "particulate here is mostly diesel exhaust and yard dust"),
        "bc": ("diesel idling in the yard and at the gates", "black carbon is a direct diesel-soot marker"),
        "diesel": ("diesel idling in the yard and at the gates", "the diesel indicator isolates compression-ignition exhaust"),
        "co": ("engine idling in the yard", "CO rises with idling and cold engines"),
        "o3": ("afternoon diesel activity", "ozone forms downwind from NOx and sunlight"),
        "co2": ("total diesel burn", "CO2 scales with fuel burn"),
        "ch4": ("fuel handling on the fuelling apron", "methane at the fenceline means fuel is escaping"),
        "methane_leak": ("fuel handling on the fuelling apron", "a leak indicator means fuel is escaping"),
    },
}
DEFAULT_LEVER = ("on-site combustion", "this is a combustion tracer")
# No single lever moves a composite: it is built from three pollutants with
# different sources, so the honest advice is to name the term that is driving
# it rather than to pretend there is one dial.
COMPOSITE_LEVER = ("whichever of NOx, PM or ozone precursors is driving the score",
                   "this is a health index over three pollutants, not a tracer with one source")

# The emission-point kinds each measure's lever reaches, per site kind.
# Without it the three NEAREST points were named, whatever they were: the
# diesel alert on Paul R Lowry Road advised "Apply to Cooling tower cell 1,
# Cooling tower cell 2, Cooling tower cell 3". A site with none of the
# preferred kinds falls back to its nearest active points.
_COMBUSTION = ("generator", "stack")
LEVER_KINDS: dict[str, dict[str, tuple[str, ...]]] = {
    "datacenter": {
        "no2": _COMBUSTION, "co": _COMBUSTION, "o3": _COMBUSTION, "nondiesel": _COMBUSTION,
        "co2": ("generator", "stack", "backup"), "pm25": ("backup",), "bc": ("backup",),
        "diesel": ("backup",), "ch4": ("generator",), "methane_leak": ("generator",),
    },
    "manufacturing": {
        "no2": ("stack",), "co": ("stack",), "o3": ("stack",), "nondiesel": ("stack",),
        "co2": ("stack", "backup"), "pm25": ("stack", "traffic_gate"), "bc": ("backup", "traffic_gate"),
        "diesel": ("backup", "traffic_gate"), "ch4": ("stack",), "methane_leak": ("stack",),
    },
    "logistics": {
        "no2": ("generator", "stack", "traffic_gate"), "co": ("generator", "stack", "traffic_gate"),
        "o3": ("generator", "stack", "traffic_gate"), "nondiesel": ("traffic_gate",),
        "co2": ("generator", "stack", "traffic_gate"), "pm25": ("generator", "stack", "traffic_gate"),
        "bc": ("generator", "stack", "traffic_gate"), "diesel": ("generator", "stack", "traffic_gate"),
        "ch4": ("stack",), "methane_leak": ("stack",),
    },
}

# Moving the load rather than cutting it, per site kind. Compute deferral is
# a datacentre's; a works moves a heat, a terminal meters its moves.
LOAD_SHIFT: dict[str, tuple[str, str, str | None]] = {
    "datacenter": (
        "Defer non-urgent compute",
        "Move batch and training workloads out of the {hours} h window, or to racks fed from grid "
        "supply rather than on-site generation.",
        "Takes about {shift}% of on-site generation demand off without a customer-visible impact (estimate)",
    ),
    "manufacturing": (
        "Move the next heat",
        "If the production plan allows, move the next furnace charge out of the {hours} h window.",
        None,
    ),
    "logistics": (
        "Meter yard moves and gate arrivals",
        "Batch non-urgent yard moves and hold queued trucks with engines off for the {hours} h window.",
        None,
    ),
}

SEVERITY_THROTTLE = {"critical": 40, "warning": 25, "watch": 15, "info": 10}
SEVERITY_HOURS = {"critical": 6, "warning": 4, "watch": 2, "info": 1}
CONFIDENCE = {"monitor": "high", "mobile": "medium", "community": "medium", "regulator": "high", "model": "low"}

# Why F7 did not link, in words an operator reads once. Never a denial: the
# data cannot say where the air came from, which is not the same as "not us".
_NO_LINK = {
    "no_place": "it has no single location to test",
    "no_wind": "there is no wind record for the hour it began",
    "not_downwind": "the wind when it began was not carrying air from the site toward it",
    "beyond_envelope": "it lies beyond measurement range, where the plume is model only",
    "not_downwind_reports": "most of the reports were filed when the wind was not carrying air from the site toward them",
    "not_an_air_report": "the reports are about noise, light or traffic, which an air test cannot speak to",
    "no_test": "there is no calibrated downwind test for {short}",
    "no_detection": "the site's measured downwind test for {short} is inside the noise",
    "contested": "the site's measured downwind test for {short} did not pass the rotation check",
    "insufficient_passes": "there are not yet enough downwind passes to test {short}",
    "not_measured": "the fleet has not driven downwind of the site in stable air for {short}",
}


def lever_for(site: dict[str, Any] | None, measure: str | None) -> tuple[str, str]:
    """(lever, why) for this kind of site and this measure."""
    if measure == "aclima_sense":
        return COMPOSITE_LEVER
    kind = (site or {}).get("kind") or ""
    return SITE_LEVERS.get(kind, {}).get(measure or "no2", DEFAULT_LEVER)


def _lever_points(
    points: list[dict[str, Any]], target, kinds: tuple[str, ...] = ()
) -> list[dict[str, Any]]:
    """The nearest active emission points to the alert that the lever reaches."""
    active = [p for p in points if p.get("active")]
    preferred = [p for p in active if p.get("kind") in kinds]
    pool = preferred or active
    if target is None or not pool:
        return pool[:3]
    tlon, tlat = target
    pool = sorted(pool, key=lambda p: geo.haversine_m(p["lon"], p["lat"], tlon, tlat))
    return pool[:3]


def _where(brg: float | None, dist: float | None) -> str:
    """Where the alert is, the way the deck's Downwind list says it: "6.3 km NE
    of the site". No degrees — a bearing in degrees is an instrument reading,
    and the compass point carries what an operator acts on.

    An alert with no location (the wind-shift and model-comparison alerts) is
    "site-wide". At zero distance a bearing is noise: the generator places
    unlocated alerts ON the site centroid, and compass(0.0) would call them
    "N of the site".
    """
    if brg is None or (dist is not None and dist < 1.0):
        return "site-wide"
    side = f"{geo.compass(brg)} of the site"
    if not dist:
        return side
    far = f"{dist / 1000:.1f} km" if dist >= 1000 else f"{int(round(dist, -1))} m"
    return f"{far} {side}"


def _when(ts: str | None) -> str:
    dt = timeutil.parse(ts)
    return f"{dt:%b} {dt.day} {dt:%H:%M}" if dt else "the start"


def _span(a: str | None, b: str | None) -> str:
    """"Aug 27 06:00–07:00", or across days "Aug 3 05:37 to Aug 6 05:37"."""
    da, db = timeutil.parse(a), timeutil.parse(b)
    if not da or not db:
        return "the hours it ran"
    if da.date() == db.date():
        return f"{_when(a)}–{db:%H:%M}"
    return f"{_when(a)} to {_when(b)}"


def _over(value: float | None, threshold: float | None, unit: str) -> str:
    if value is None or not threshold:
        return ""
    pct = 100.0 * (value / threshold - 1.0)
    by = "just over" if 0.0 <= pct < 1.0 else f"{pct:.0f}% over" if pct >= 0 else f"{-pct:.0f}% under"
    return f"{value:.1f} against {threshold:g} {unit} ({by})"


def _wind_then(link: dict[str, Any]) -> str:
    """The wind when the alert began, and where the alert lay against it — a
    description of the wind, never of whose air it was. The same reading the
    alert detail's "The wind when it began" prints."""
    w = link.get("wind_at_start")
    if not w:
        return ""
    base = (
        f"When it began ({_when(w['ts'])}) the wind was from the {geo.compass(w['dir_deg'])} at "
        f"{float(w['speed_ms'] or 0.0):.1f} m/s, carrying air from the site toward the "
        f"{geo.compass(w['toward_deg'])}"
    )
    off = link.get("off_axis_deg")
    if off is None:
        return f"{base}."
    if off <= 35.0 and link.get("within_envelope") is False:
        return f"{base}; the alert lay that way, but beyond measurement range."
    if off <= 35.0:
        return f"{base}; the alert lay downwind of the site then."
    if off > 130.0:
        return f"{base}; the alert lay upwind of the site then."
    return f"{base}; the alert lay across the wind from the site then."


def _link_txt(link: dict[str, Any], short: str, cluster: bool = False) -> str:
    """F7 in one sentence. Linked, it adds the measured half to the wind
    sentence before it (which already said where the alert lay); not linked,
    it says why the data cannot say — never a denial."""
    if link.get("linked"):
        if cluster:
            return (
                "Most of the reports were filed while the wind carried air from the site toward "
                f"them, and the site's measured downwind test for {short} passed the rotation check."
            )
        return f"The site's measured downwind test for {short} passed the rotation check too."
    why = _NO_LINK.get(link.get("reason") or "", "")
    if not why:
        return ""
    return f"The data here cannot say where this air came from: {why.format(short=short)}."


def build(ctx: dict[str, Any]) -> dict[str, Any]:
    alert = ctx.get("alert") or {}
    site = ctx.get("site") or {}
    wind = ctx.get("wind") or {}
    mdef = ctx.get("measure_def") or {}
    levels = ctx.get("action_levels") or []
    points = site.get("emission_points") or []
    link = ctx.get("link") or {}
    st = advisor_copy.stance(ctx)
    site_kind = site.get("kind") or ""

    kind = alert.get("kind") or "regulatory_notice"
    severity = alert.get("severity") or "watch"
    measure = alert.get("measure") or link.get("measure") or "no2"
    short = mdef.get("short_label") or {"pm25": "PM2.5", "no2": "NO2"}.get(measure, measure.upper())
    unit = alert.get("unit") or mdef.get("unit") or ""
    lever, why = lever_for(site, measure)

    target = None
    if alert.get("lon") is not None and alert.get("lat") is not None:
        target = (alert["lon"], alert["lat"])
    centroid = site.get("centroid")
    brg = alert.get("bearing_deg")
    dist = alert.get("distance_m")
    if brg is None and centroid and target:
        brg = round(geo.bearing_deg(centroid[0], centroid[1], target[0], target[1]), 1)
        dist = round(geo.haversine_m(centroid[0], centroid[1], target[0], target[1]), 1)
    where = _where(brg, dist)

    # The wind NOW (at the moment shown), from our own anemometers if we have
    # them. It describes the air for a direct question and for the study
    # alert. An alert is described by the wind when it BEGAN (`_wind_then`).
    measured = ctx.get("measured_local_wind") or {}
    wind_from = measured.get("dir_deg", wind.get("dir_deg"))
    wind_speed = measured.get("speed_ms", wind.get("speed_ms") or 0.0)
    wind_now = ""
    if wind_from is not None:
        blows_to = (wind_from + 180.0) % 360.0
        if measured:
            win = f" over the last {measured['window_h']:.0f} h" if measured.get("window_h") else ""
            wind_now = (
                f"Our vehicles measured wind from the {geo.compass(wind_from)} at "
                f"{wind_speed:.1f} m/s{win} (spread {measured.get('dir_sd', 0):.0f}° over "
                f"{measured.get('n', 0)} observations), carrying air from the site toward the "
                f"{geo.compass(blows_to)}."
            )
        else:
            wind_now = (
                f"The hourly weather record has wind from the {geo.compass(wind_from)} at "
                f"{wind_speed:.1f} m/s (stability {wind.get('stability') or 'D'}), carrying air "
                f"from the site toward the {geo.compass(blows_to)}."
            )
    wind_then = _wind_then(link) if alert else ""
    link_txt = _link_txt(link, short, kind == "concern_cluster") if alert else ""

    throttle = SEVERITY_THROTTLE.get(severity, 15)
    hours = SEVERITY_HOURS.get(severity, 2)
    if st["may_cut"]:
        throttle += 10
    kinds = LEVER_KINDS.get(site_kind, LEVER_KINDS["datacenter"]).get(measure, _COMBUSTION)
    nearest = _lever_points(points, target, kinds)
    named = ", ".join(p["name"] for p in nearest) or "the nearest combustion source"
    expected = min(60, int(throttle * 0.75)) if st["may_cut"] else min(45, int(throttle * 0.55))
    ended_at = _when(alert.get("ended_at")) if alert.get("ended_at") else None
    shift = LOAD_SHIFT.get(site_kind)

    actions: list[dict[str, Any]] = []
    ver = ctx.get("model_verification") or {}
    # "Verify your consultant" is a supporting point (owner, 2026-09-23). It
    # rides only where the study is the question: the study alert itself, a
    # direct question with no alert, or an alert lying along a transport
    # direction the study under-weights (within 45° of wind-from + 180).
    along = [(b + 180.0) % 360.0 for b in (ver.get("understated_bearings") or [])]
    study_relevant = (
        not alert
        or bool(alert.get("about_study"))
        or (
            where != "site-wide"
            and brg is not None
            and any(abs(((brg - t + 180.0) % 360.0) - 180.0) <= 45.0 for t in along)
        )
    )
    if not study_relevant:
        ver = {}

    check_sensors = {
        "label": "Check your fenceline sensors",
        "detail": (
            f"Compare the {short} reading with your own fenceline sensors and the nearest "
            "reference monitor for the same hours. One sensor above a level does not say where "
            "the air came from."
        ),
        "impact": None,
    }
    stage = {
        "label": f"Stage a {throttle}% reduction on {named}",
        "detail": (
            f"Have it ready to apply for {hours} h if your own fenceline sensors rise while the "
            "alert is still ongoing."
        ),
        "impact": f"About {expected}% lower {short} at the fenceline if applied (estimate)",
    }

    def review(opening: str) -> None:
        """An alert that has ended: what to look at, never what to cut."""
        nonlocal recommendation, actions
        span = _span(alert.get("started_at"), alert.get("ended_at"))
        recommendation = (
            f"{opening} {wind_then} {link_txt} Pull your own logs for {span} and keep them with "
            "the alert."
        )
        actions = [
            {
                "label": "Pull your own logs for those hours",
                "detail": f"Line up what {named} were doing against {span}.",
                "impact": None,
            },
            check_sensors,
        ]
        if link.get("linked"):
            actions.append(
                {
                    "label": "Plan for the same weather",
                    "detail": (
                        f"The same wind and stability will come back. Plan {lever} for those hours "
                        "before they do."
                    ),
                    "impact": None,
                }
            )

    recommendation = ""
    if alert.get("not_started"):
        # A replay cursor before the alert was raised (the deck never lists
        # one; a link can outlive a scrub backwards).
        recommendation = (
            f"This alert was raised later, at {_when(alert.get('created_at') or alert.get('started_at'))}. "
            "At the moment shown there is nothing to act on yet."
        )
        actions = [check_sensors]
        kind = "not_started"
    elif kind in ("exceedance", "integrated_exposure", "mobile_detection"):
        reading = _over(alert.get("value"), alert.get("threshold"), unit)
        over = f" — {reading}" if reading else ""
        if st["ended"]:
            review(
                f"The {short} alert {where} ended at {ended_at or 'its last reading'}"
                + (f"; it read {reading}." if reading else ".")
            )
        elif st["other_operator"]:
            recommendation = (
                f"This {short} alert is on another operator's fenceline sensor, {where}{over}. "
                f"{wind_then} Check your own fenceline sensors for the same hours before changing "
                "anything on site."
            )
            actions = [check_sensors]
        elif st["may_cut"]:
            recommendation = (
                f"Throttle {named} by {throttle}% for the next {hours} h. The {short} alert is "
                f"{where}{over}. {wind_then} {link_txt}"
            )
            actions = [
                {
                    "label": f"Throttle {named} by {throttle}%",
                    "detail": (
                        f"Apply for {hours} h, then step back in 10% increments while watching your "
                        "fenceline sensors."
                    ),
                    "impact": f"About {expected}% lower {short} at the fenceline within one averaging period (estimate)",
                },
                check_sensors,
            ]
            if shift:
                label, detail, impact = shift
                actions.insert(1, {
                    "label": label,
                    "detail": detail.format(hours=hours),
                    "impact": impact.format(shift=max(5, throttle // 2)) if impact else None,
                })
        else:
            # A fleet detection is a measurement on a street (D13), said as one.
            subject = (
                f"A {short} reading by Aclima's vehicles on a street {where}{over}."
                if alert.get("source_type") == "mobile"
                else f"The {short} alert is {where}{over}."
            )
            recommendation = (
                f"Check your fenceline sensors before changing anything. {subject} {wind_then} "
                f"{link_txt} Have a {throttle}% reduction on {named} ready if your own sensors rise."
            )
            actions = [check_sensors, stage]
        if measure in ("ch4", "methane_leak") and not st["ended"]:
            walk = {
                "logistics": ("Walk the fuelling apron for leaks",
                              "Check hoses, nozzles and tank vents on the fuelling apron with a handheld "
                              "before assuming combustion is the cause."),
            }.get(site_kind, ("Walk the gas supply for leaks",
                              "Survey supply piping, filter skids and seals with a handheld before "
                              "assuming combustion is the cause."))
            actions.insert(1, {"label": walk[0], "detail": walk[1],
                               "impact": "A single fitting can account for the whole signal"})

    elif kind == "concern_cluster":
        members = ctx.get("cluster_members") or []
        count = int(alert.get("value") or len(members) or 3)
        report_kinds = sorted({c.get("kind") for c in members if c.get("kind")})
        what = f" ({', '.join(report_kinds)})" if report_kinds else ""
        opening = f"{count} community reports{what} clustered {where}."
        ack = {
            "label": "Answer on the community feed",
            "detail": (
                "Post a short, plain-language update naming the hours you are looking at. "
                "Only the air agency or Aclima can close a resident's report; proposing a "
                "mitigation is the step open to you."
            ),
            "impact": "Residents see that you are looking at the same hours they reported",
        }
        if st["ended"]:
            review(f"{opening} The cluster ended at {ended_at or 'its last report'}.")
            actions.insert(0, ack)
        elif st["may_cut"]:
            recommendation = (
                f"{opening} {wind_then} {link_txt} Post an acknowledgement to the community feed "
                f"today, then throttle {named} by {throttle}% during the reported hours."
            )
            actions = [
                ack,
                {
                    "label": f"Throttle {lever} by {throttle}% during the reported hours",
                    "detail": f"Apply to {named} across the same time-of-day window the reports came from, for {max(2, hours)} h.",
                    "impact": f"About {expected}% lower {short} at the fenceline in those hours (estimate)",
                },
                {
                    "label": "Pull your own logs for the reported hours",
                    "detail": f"Line up what {named} were doing against the report times.",
                    "impact": None,
                },
            ]
        else:
            recommendation = (
                f"{opening} {wind_then} {link_txt} Answer on the community feed today and pull your "
                "own logs for the reported hours."
            )
            actions = [
                ack,
                {
                    "label": "Pull your own logs for the reported hours",
                    "detail": f"Line up what {named} were doing against the report times.",
                    "impact": None,
                },
                check_sensors,
            ]

    elif kind == "wind_shift" and alert.get("about_study"):
        # The generator files the study-vs-measured-wind finding under the
        # `wind_shift` kind, so this branch used to answer it with "The wind
        # has veered … reduce turbine load now" — advice about weather that
        # did not happen. It is a planning finding.
        study = ver.get("model_name") or "the dispersion study on file"
        recommendation = (
            f"The wind our vehicles measured disagrees with {study}. {wind_now} "
            "Plan load on the measured wind, not the study's, and have the study re-run "
            "against it before the next permit filing."
        )
        actions = [
            {
                "label": "Plan load on the measured wind",
                "detail": (
                    "Use the fleet's measured rose, not the study's, to decide which nights "
                    "need a lower load."
                ),
                "impact": None,
            },
        ]

    elif kind == "wind_shift":
        # A veer has no place, so F7 cannot link it; what the model can say is
        # where its plume points now. The response is to watch the new
        # downwind side, with a reduction ready.
        if st["ended"]:
            review(f"The wind veered and settled again by {ended_at or 'the next reading'}.")
        else:
            recommendation = (
                f"The wind has veered. {wind_now} The modelled plume now points at places that were "
                f"crosswind an hour ago. Watch the fenceline sensors on the new downwind side and "
                f"have a {throttle}% reduction on {named} ready if they rise."
            )
            actions = [
                stage,
                {
                    "label": "Re-check who is downwind",
                    "detail": "Schools, clinics and the reporting neighbourhoods that were crosswind are now on the modelled plume's path.",
                    "impact": None,
                },
            ]

    elif not alert:
        # A direct question with no alert picked. There is no place to name.
        recommendation = (
            f"{wind_now} Review {lever} against your fenceline sensors before changing dispatch."
        )
        actions = [
            {
                "label": "Check the reading",
                "detail": "Compare your fenceline sensors with the nearest reference monitor before changing dispatch.",
                "impact": None,
            },
        ]

    else:
        title = alert.get("title") or "This alert"
        if st["ended"]:
            review(f"{title}: {where}, ended at {ended_at or 'its last reading'}.")
        else:
            recommendation = (
                f"{title}: {where}. {wind_then} Review {lever} and check the reading against your "
                "fenceline sensors before responding."
            )
            actions = [
                {
                    "label": "Check the reading",
                    "detail": "Compare against your own fenceline sensors and the nearest reference monitor before changing dispatch.",
                    "impact": None,
                },
                stage,
            ]

    if ver.get("verdict") == "understates":
        districts = ver.get("affected_districts") or []
        who = " and ".join(d["district"] for d in districts[:2]) or "the places downwind"
        # Compass points, not degrees: these are wind directions an operator
        # reads once, not a heading to fly.
        sectors = " and ".join(
            dict.fromkeys(f"the {geo.compass(b)}" for b in (ver.get("understated_bearings") or [])[:3])
        )
        # The verdict is about HOW OFTEN, and the number that says so is the
        # frequency pair. `disagreement` (hours outside the contour) is a
        # different measure: on the pinned build it is 0.0 at all three sites
        # while the verdict is `understates`, and "0% of the hours fall outside
        # its contour" beside "under-weights" read as a contradiction.
        top = districts[0] if districts else None
        freq = (
            f" It assumed {top['assumed_freq']:.1f}% of hours carrying air toward "
            f"{top['district']}; our vehicles measured {top['observed_freq']:.1f}%."
            if top and top.get("assumed_freq") is not None and top.get("observed_freq") is not None
            else ""
        )
        outside = (
            f" {ver['disagreement'] * 100:.0f}% of the hours we measured fall outside its contour."
            if ver.get("disagreement")
            else ""
        )
        actions.append(
            {
                "label": "Re-run the dispersion study with our measured rose",
                "detail": (
                    f"{ver.get('model_name') or 'The study on file'} under-weights wind from "
                    f"{sectors or 'several directions'}, which carries air toward {who}.{freq}{outside} "
                    "Plan on that transport until the study is revised."
                ),
                "impact": "The filed study matches the wind the fleet measured before the next permit review",
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
    elif kind == "wind_shift" and alert.get("about_study"):
        # The alert says the two disagree even when this site's own
        # comparison has no `understates` verdict to quote; it still needs
        # the one action it exists to prompt.
        actions.append(
            {
                "label": "Re-run the dispersion study with our measured rose",
                "detail": "Hand the consultant the fleet's measured wind for the same months and ask for the contour again.",
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
        # The verdict is the STUDY's, judged against our rose.
        ver_txt = (
            f" Against the wind our vehicles measured, {ver.get('model_name') or 'the study on file'} "
            f"{ver['verdict']} how often the wind blows from some directions."
        )
    # The measured operating envelope, for the regime the air was in (at the
    # alert's start, or now) — never `site.headroom_pct`, a generator constant.
    env_txt = ""
    if ctx.get("envelope") and not st["ended"]:
        e = ctx["envelope"]
        env_txt = (
            f" In {e['regime']} air your fenceline runs {e['excess']:+.0f} {e['unit']} over "
            f"comparable roads, measured over {e['episodes']} episodes."
        )
    wind_txt = (wind_then or wind_now) if alert and kind != "wind_shift" else wind_now
    # Not `str.capitalize()`: it lowercases the rest, and printed "Combustion
    # nox tracks turbine load" — a chemical formula is case-sensitive.
    rationale = (
        f"{why[:1].upper()}{why[1:]}, so the shortest lever is {lever}. "
        f"{wind_txt}{ver_txt}{level_txt}{env_txt}"
    )

    return {
        "recommendation": " ".join(recommendation.split()),
        "actions": actions,
        "rationale": " ".join(rationale.split()),
        "confidence": CONFIDENCE.get(alert.get("source_type") or "", "medium"),
        "source": "rules",
    }
