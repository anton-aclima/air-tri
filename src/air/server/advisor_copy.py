"""The advisor's words, held against the rules — for the rules engine AND the model.

These lists used to live only in tests/test_advisor_copy.py, which ran them
over the rules engine's templates. The model's answer never met them: it
replaced the rules answer on every alert detail and, on the pinned build, named
the site as the source of another operator's monitor 6.3 km away ("pushing the
plume straight north over the Riverport Road reference monitor … throttle
turbine banks D, A and B"), of a fleet street detection, and of a black-carbon
reading at a site whose downwind test is `no_detection` ("its 9 m stack is the
lowest-level soot source and sits directly upwind of Channel Avenue") — the
prompt forbade all three (phase 3 honesty review). A rule the model never
meets is a request, so the same checks now run on its reply before it is
swapped in, and a reply that fails keeps the rules answer on screen
(`advisor_jobs`).

Four families, each from a written rule:

* `COCKPIT` / `ANNUNCIATOR` — CONTRACT 10a.7, PLAN-refocus F5/I11: the design
  metaphor is never copy.
* `NEVER_SAY` — CONTRACT 10a and the owner's list: no all-clear, no
  compliance claim, no "yours", no selling evasion.
* `attribution` — F7/D7: unless the wind at the alert's start AND the site's
  placebo-checked downwind test agree (`naming.alert_link`), the text may
  describe where the wind carried air but may not name the site, its plume or
  its equipment as where the air came from, and may not quantify an effect
  anywhere but the site's own fenceline.
* `actions` — no cut "by N%" as the response to an alert that has ended, that
  sits on another operator's sensor, or that F7 does not link (staging one,
  ready if the site's own sensors rise, is allowed), no "for the next N h" on
  an ended alert, and no equipment the site does not have (turbines and
  compute were advised to a truck terminal).

The screen is deliberately strict. A false positive costs nothing — the rules
answer is complete on its own — and a false negative is the failure above.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Any

# CONTRACT 10a.7 and PLAN-refocus F5/I11: the design metaphor, never in copy.
COCKPIT = [
    r"\bmfd\b", r"\brwr\b", r"\bradar\b", r"\bscope\b", r"\bslew", r"\block(ed|s|-on)?\b",
    r"\bcontacts?\b", r"\bcaution\b", r"\bannunciator", r"\bexcd\b", r"\bbrg\b", r"\bsrc\b",
    r"\bup for\b", r"\bproximity\b", r"\btripwire", r"\barmed\b", r"\binvader", r"suspected emitter",
    r"flight deck", r"watchfloor", r"drafting table", r"tower defen[cs]e", r"\bbears\b",
    r"\bplume track\b",
]
# Annunciator words as a status are capitals; "Warning" is a severity word.
ANNUNCIATOR = re.compile(r"\b(CAUTION|WARNING|ADVISORY|NORMAL)\b")
# CONTRACT 10a + PLAN-plume "Never say" (the industry lines) + the owner's list.
NEVER_SAY = [
    r"\bclear(s|ed)?\b", r"all[- ]clear", r"within limits", r"\bcompliant\b", r"no exceedance",
    r"\bunfounded\b", r"not attributable", r"\byours\b", r"\bsafe(ly)?\b", r"caused by",
    r"responsible for", r"\bverified\b", r"\bconfirm(s|ed)\b", r"\bproven?\b", r"\baccurate\b",
    r"real[- ]time", r"enforcement", r"ahead of the regulator", r"regulator inquiry",
    r"upwind of it",
]
BANNED = [re.compile(p, re.IGNORECASE) for p in COCKPIT + NEVER_SAY]

# F7: naming the site, its plume or its equipment as where the air came from.
# Only applied when the link does not hold.
ATTRIBUTION = [re.compile(p, re.IGNORECASE) for p in (
    r"\bsources? of\b",
    r"\b(is|are|was|were|as|be) (the |a |an |our |your |its )?(likely |probable |main |dominant |"
    r"primary |biggest |largest |lowest[- ]level |nearest )?(source|emitter|contributor|culprit)s?\b",
    r"\b(coming|came|comes) from (the |our |your )?(site|campus|plant|terminal|works|yard|stacks?|"
    r"furnaces?|turbines?|generators?|gensets?|banks?|gates?)\b",
    r"\boriginat", r"\battribut", r"\bcontribut", r"\bdominat",
    # "Directly upwind of" a place is naming the source; upwind of the site's
    # OWN fence sensors is where the site's equipment sits, which is allowed.
    r"\bdirectly upwind of (?!(the |your |our )?([a-z-]+ ){0,2}fence)",
    r"\bupwind of (the )?(alert|monitor|segment|street|road|reports?|cluster|neighbou?rhood)",
    # "Carrying our air toward the N" describes the wind; "our air reaching
    # the monitor" names the source.
    r"\b(our|your|the site's|its|site) (air|plume|emissions?|exhaust|soot|nox)\b[^.;]{0,80}"
    r"\b(reach(es|ed|ing)?|hit(s|ting)?|lands?|landing|arriv(e|es|ed|ing)|over the|onto|into the|"
    r"at the (alert|monitor|segment|street|road|reports?|cluster))\b",
    r"\bwhat reaches (it|the)",
    r"\b(plume|emissions?|exhaust|soot)\b[^.;]{0,80}\b(reach(es|ed|ing)?|hit(s|ting)?|lands?|landing|"
    r"arriv(e|es|ed|ing)|push(es|ed|ing)?|straight (over|at|through)|over the|onto|into the)\b",
    # Carrying or pushing air NORTH is a wind description; carrying it
    # straight over a named kind of place is not.
    r"\bstraight (over|at|through|onto|into) (the )?(alert|monitor|segment|street|road|reports?|cluster|"
    r"neighbou?rhood)",
)]
# A reduction quantified somewhere; allowed only at the site's own fence when
# the link does not hold.
_EFFECT = re.compile(
    r"(\d+\s*(-|–|to)?\s*\d*\s*%|\b\d+(\.\d+)?\s*(ppb|ppm|µg|ug)|\ba few (ppb|ppm)\b|\bpercent\b)",
    re.IGNORECASE,
)
_FENCE = re.compile(r"\bfence(line)?\b", re.IGNORECASE)
# What the air does as a result — "30% lower NO2 at Riverport Road". Not the
# size of the cut itself ("a 15% reduction on the furnaces"), which says
# nothing about any place.
_RESULT = re.compile(
    r"\b(lower|less|fall(s|ing)? (back|under|below)|drops? (to|under|below)|off the|avoids?|"
    r"under the \d)", re.IGNORECASE,
)
# The quantity is about the air, not about generation demand or throughput.
_AIR = re.compile(
    r"\b(ppb|ppm|µg|ug|no2|nox|pm2?\.?5?|bc|black carbon|diesel|particulate|soot|methane|ozone|"
    r"concentration|reading|level)s?\b", re.IGNORECASE,
)
# A cut, and the words that make it a plan rather than a response.
_CUT = re.compile(
    r"\b(throttle|reduce|cut|curtail|derate|drop|shed|shut( down)?|take [^.]{0,40}(down|off)|"
    r"turn [^.]{0,20}down|pull [^.]{0,40}back|lower)\b[^.;]{0,80}(\bby \d+|\d+\s*%|\bto zero\b|"
    r"\boff[- ]?(line|load)\b|\bstandby\b)",
    re.IGNORECASE,
)
_STAGED = re.compile(r"\b(stage|staged|ready|prepare|standby plan|if your|should your|only if|in case)\b",
                     re.IGNORECASE)
_NEXT_HOURS = re.compile(r"\bfor the next \d|\bright now\b|\bimmediately\b", re.IGNORECASE)
# Equipment an operator can only act on if the site has it.
EQUIPMENT = {
    r"\bturbines?\b": ("turbine",),
    r"\bcompute\b|\bracks?\b|\bworkloads?\b|\bgpus?\b|\bservers?\b|\bdata ?cent(er|re)\b": ("datacenter",),
    r"\bgensets?\b": ("genset",),
    r"\bfurnaces?\b": ("furnace",),
    r"\bboilers?\b": ("boiler",),
    r"\b(yard )?tractors?\b": ("tractor",),
    r"\breefers?\b": ("reefer",),
    r"\bcooling towers?\b": ("cooling tower",),
}


def texts(reply: dict[str, Any]) -> Iterator[tuple[str, str]]:
    yield "recommendation", reply.get("recommendation") or ""
    yield "rationale", reply.get("rationale") or ""
    for i, a in enumerate(reply.get("actions") or []):
        for key in ("label", "detail", "impact"):
            if a.get(key):
                yield f"actions[{i}].{key}", str(a[key])


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.;!?])\s+|\s+[—–]\s+", text) if s.strip()]


def word_offences(reply: dict[str, Any], quoted: tuple[str, ...] = ()) -> list[str]:
    """Banned words in the reply's own words. `quoted` strings (the alert's
    own title, which one branch quotes verbatim) are removed first: that copy
    belongs to the generator, not to the advisor."""
    bad = []
    for where, text in texts(reply):
        own = text
        for q in quoted:
            if q:
                own = own.replace(q, "")
        for rx in BANNED:
            if rx.search(own):
                bad.append(f"{where}: /{rx.pattern}/ in {text!r}")
        if ANNUNCIATOR.search(own):
            bad.append(f"{where}: annunciator word in {text!r}")
    return bad


def site_vocabulary(site: dict[str, Any] | None) -> str:
    """Everything the context says the site HAS, as one lower-case string."""
    if not site:
        return ""
    parts = [site.get("kind") or "", site.get("name") or "", site.get("generator_fuel") or ""]
    for p in site.get("emission_points") or []:
        parts += [p.get("name") or "", p.get("kind") or ""]
    return " ".join(parts).lower()


def stance(ctx: dict[str, Any]) -> dict[str, Any]:
    """What the context allows the advice to do, derived once for both the
    rules engine and the screen: whether a site may be named (F7), whether a
    cut is a legitimate response, and whether the alert is still ongoing."""
    alert = ctx.get("alert") or {}
    link = ctx.get("link") or {}
    owner = ctx.get("alert_monitor") or {}
    site = ctx.get("site") or {}
    # Ended means it had ended BY the moment shown. An alert that had not yet
    # begun (a replay cursor before it, `not_started`) is not ended — it is
    # not there yet, and `build_context` answers it without the model.
    if "ended_by_moment" in alert:
        ended = bool(alert["ended_by_moment"])
    else:
        ended = bool(alert) and not alert.get("ongoing", True) and not alert.get("not_started")
    other_operator = bool(owner.get("site_id")) and owner.get("site_id") != site.get("id")
    linked = bool(link.get("linked"))
    return {
        "has_alert": bool(alert),
        "ended": ended,
        "other_operator": other_operator,
        "linked": linked,
        # A cut "by N%" answers an alert only when the site's air is tied to
        # it, it is still going on, and it is not someone else's sensor.
        "may_cut": linked and not ended and not other_operator,
    }


def screen(reply: dict[str, Any], ctx: dict[str, Any]) -> list[str]:
    """Every rule the reply breaks, empty when it may be shown."""
    alert = ctx.get("alert") or {}
    st = stance(ctx)
    bad = word_offences(reply, (alert.get("title") or "",))

    if not st["linked"]:
        for where, text in texts(reply):
            for rx in ATTRIBUTION:
                if rx.search(text):
                    bad.append(f"{where}: names a source without F7 — /{rx.pattern}/ in {text!r}")
            for s in _sentences(text):
                if _EFFECT.search(s) and not _FENCE.search(s) and _RESULT.search(s):
                    bad.append(f"{where}: quantifies an effect away from the fenceline without F7: {s!r}")
        for i, a in enumerate(reply.get("actions") or []):
            imp = a.get("impact")
            if imp and _EFFECT.search(str(imp)) and not _FENCE.search(str(imp)) and (
                _RESULT.search(str(imp)) or _AIR.search(str(imp))
            ):
                bad.append(f"actions[{i}].impact: an effect away from the fenceline without F7: {imp!r}")

    if not st["may_cut"]:
        for where, text in texts(reply):
            for s in _sentences(text):
                if _CUT.search(s) and not _STAGED.search(s):
                    why = "ended" if st["ended"] else "another operator's sensor" if st["other_operator"] else "not linked"
                    bad.append(f"{where}: a cut as the response to an alert that is {why}: {s!r}")
    if st["ended"]:
        for where, text in texts(reply):
            if _NEXT_HOURS.search(text):
                bad.append(f"{where}: forward-looking instruction on an ended alert: {text!r}")

    vocab = site_vocabulary(ctx.get("site"))
    if vocab:
        for where, text in texts(reply):
            for pat, need in EQUIPMENT.items():
                if re.search(pat, text, re.IGNORECASE) and not any(n in vocab for n in need):
                    bad.append(f"{where}: equipment this site does not have (/{pat}/): {text!r}")
    return bad
