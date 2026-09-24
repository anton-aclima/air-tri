"""F7, server side: when may a named site be tied to an alert?

PLAN-refocus F7 / owner decision D7 / CONTRACT 10b "Naming a site": a report,
cluster or alert is linked to a named site only when BOTH hold:

  (a) the wind at the time carried from the site to it, and
  (b) the site's placebo-checked downwind test for that pollutant
      (`/sites/{id}/touchdown`) is `elevated_downwind`.

The deck applies this rule in the browser (industry/lib.tsx `reportLinked`,
`clusterLinked`, `wasDownwindAtStart`). The advisor needs the same answer on
the server, because it is the advisor that turns "where the wind blew" into
"throttle by 25%" — and an action taken on proximity alone is attribution by
proximity in the form of an action (phase 3 honesty review). Before this, the
rules engine judged "downwind" from the LATEST 24 h of wind with a 55 deg cone,
so an alert that began on a south-easterly two days earlier was advised as if
today's south-westerly had carried the site's air to it.

Three details, each a measured failure:

* **The wind at the alert's START**, the hourly record at or before
  `started_at` (within two hours, as `windAt` on the deck). Not the wind now.
* **Within the detection envelope for that hour's class.** CONTRACT 10b:
  nothing is judged from the part of the plume past the envelope; a monitor
  under it is not "downwind". DRAQA's Riverport Road monitor is 6.3 km from
  Ridgeline, past every envelope, so it is never Ridgeline's by this rule.
* **The half-angle is the deck's 35 deg** (`DOWNWIND_HALF_ANGLE`), so the
  advisor and the deck's Downwind list cannot disagree about the geometry.

Reports and clusters use (a) as the data records it: a concern's
`suspected_site_id` is set by the generator only when the wind at the time
carried from that site to that point. Noise, vibration, light and traffic
reports are never linked by an air test (CONTRACT 10b).
"""

from __future__ import annotations

import sqlite3
from typing import Any

from air import dispersion as plume
from air.server import domain, geo, timeutil
from air.server import touchdown as td

#: The deck's own half-angle (web/src/apps/industry/lib.tsx DOWNWIND_HALF_ANGLE).
DOWNWIND_HALF_ANGLE = 35.0
#: How stale an hourly wind row may be and still describe "when it began".
WIND_MAX_AGE_H = 2.0

#: Report kinds an air test can speak to, and the pollutant whose downwind
#: test stands in for them. Smoke and dust are particulate; a smell or a
#: health report is read against the combustion tracer, which is the plume
#: species the deck draws. Anything not listed is never linked by an air test.
REPORT_MEASURE = {
    "smell": "no2",
    "health": "no2",
    "other": "no2",
    "smoke": "pm25",
    "dust": "pm25",
}


def wind_at(conn: sqlite3.Connection, cid: str, ts: str | None) -> dict[str, Any] | None:
    """The hourly wind row at or before `ts`, if it is at most two hours old."""
    if not ts:
        return None
    w = domain.current_wind(conn, cid, ts)
    if not w:
        return None
    a, b = timeutil.parse(w["ts"]), timeutil.parse(ts)
    if a is None or b is None or a > b or (b - a).total_seconds() > WIND_MAX_AGE_H * 3600.0:
        return None
    return w


def touchdown_state(conn: sqlite3.Connection, cid: str, site_id: str, measure: str | None) -> str | None:
    """The site's pooled downwind verdict for `measure`, as `/sites/{id}/touchdown`
    serves it with its defaults (the deck's `useTouchdown(site, {measure})`).
    None when the measure has no calibrated detection floor: there is no test
    to pass, so nothing can be linked on it."""
    if not measure or measure not in td.DETECT_FLOOR:
        return None
    passes = td.load(conn, cid, measure)
    if site_id not in passes.sites:
        return None
    return td.estimate(passes, site_id, measure).state


def _off_axis(bearing: float, toward: float) -> float:
    return abs(((bearing - toward + 180.0) % 360.0) - 180.0)


def alert_link(
    conn: sqlite3.Connection,
    cid: str,
    alert: dict[str, Any],
    site: dict[str, Any],
    concerns: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Does F7 hold between `alert` and `site`? Always returns the evidence,
    whichever way it comes out, so copy can say WHY a site is not named.

    `reason` is one of: `linked`, `no_place`, `no_wind`, `not_downwind`,
    `beyond_envelope`, `not_downwind_reports`, `not_an_air_report`,
    `no_test`, and the touchdown state itself (`no_detection`, `contested`,
    `insufficient_passes`, `not_measured`) when (a) held and (b) did not.
    """
    c = site.get("centroid") or (None, None)
    out: dict[str, Any] = {
        "linked": False,
        "reason": "no_place",
        "downwind_at_start": None,
        "within_envelope": None,
        "off_axis_deg": None,
        "envelope_m": None,
        "wind_at_start": None,
        "measure": None,
        "touchdown_state": None,
    }
    w = wind_at(conn, cid, alert.get("started_at"))
    if w:
        cls, _note = plume.coerce_class((w.get("stability") or "D").upper(), max(0.4, float(w["speed_ms"] or 1.0)))
        out["wind_at_start"] = {
            "ts": w["ts"],
            "dir_deg": w["dir_deg"],
            "speed_ms": w["speed_ms"],
            "stability": cls,
            "toward_deg": round((float(w["dir_deg"]) + 180.0) % 360.0, 1),
        }
        out["envelope_m"] = plume.DETECTION_ENVELOPE.get(cls, 1500.0)

    located = alert.get("lon") is not None and alert.get("lat") is not None and c[0] is not None
    dist = geo.haversine_m(c[0], c[1], alert["lon"], alert["lat"]) if located else None
    if dist is not None and dist < 1.0:
        located = False  # stored ON the centroid: the absence of a place

    if alert.get("kind") == "concern_cluster":
        members = [x for x in (concerns or []) if x.get("kind") in REPORT_MEASURE]
        if not members:
            out["reason"] = "not_an_air_report" if concerns else "no_place"
            return out
        mine = [x for x in members if x.get("suspected_site_id") == site["id"]]
        out["downwind_at_start"] = len(mine) * 2 >= len(members)
        kinds = [REPORT_MEASURE[x["kind"]] for x in (mine or members)]
        measure = max(set(kinds), key=kinds.count)
    else:
        if not located:
            return out
        if not w:
            out["reason"] = "no_wind"
            return out
        brg = geo.bearing_deg(c[0], c[1], alert["lon"], alert["lat"])
        off = _off_axis(brg, out["wind_at_start"]["toward_deg"])
        out["off_axis_deg"] = round(off, 1)
        out["downwind_at_start"] = off <= DOWNWIND_HALF_ANGLE
        out["within_envelope"] = bool(dist is not None and dist <= out["envelope_m"])
        measure = alert.get("measure")

    out["measure"] = measure
    if not out["downwind_at_start"]:
        out["reason"] = "not_downwind_reports" if alert.get("kind") == "concern_cluster" else "not_downwind"
        return out
    if out["within_envelope"] is False:
        out["reason"] = "beyond_envelope"
        return out
    state = touchdown_state(conn, cid, site["id"], measure)
    out["touchdown_state"] = state
    if state is None:
        out["reason"] = "no_test"
        return out
    if state != "elevated_downwind":
        out["reason"] = state
        return out
    out["linked"] = True
    out["reason"] = "linked"
    return out
