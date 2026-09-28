"""A stored status, told as it stood at a replayed moment (phase 6, PLAN-refocus).

Only the FINAL status of an alert, a report or a cluster is stored. Served as
it is, replay leaked the future: at Jul 19 06:00 an alert acknowledged at 09:20
already read 'acknowledged', and the regulator's "N not acknowledged", the
industry list and the Levels screen all counted it that way. Every read bounded
by `at` now serves the status rebuilt here instead.

THE RULE. Workflow only moves forward (active -> acknowledged -> resolved or
expired; new -> corroborated -> under_review -> mitigation_proposed -> resolved
or closed), so the status at `at` is the STORED status walked back past every
step whose moment is after `at`. A step is taken at its stamp. A step with no
stamp is taken at the end of the data, never earlier -- the served status then
UNDER-claims, which is the honest direction: replay never shows a step it
cannot show happened by then. Consequences:

- At the end of the data (no `at`, or `at` at/after the build instant) every
  status is exactly the stored one. Nothing changes when paused at the end.
- A replayed status is never "ahead" of the stored one: it only walks back.
- A status set at runtime (the acknowledge endpoint, the scenarios, a PATCH)
  is stamped at the frozen build instant, so it never shows inside replay.

WHAT IS STAMPED (rebuilt exactly):

- alert 'acknowledged': the first `alert_ack.created_at`.
- report 'mitigation_proposed': the first mitigation reply on the report
  (`concern_response` kind 'mitigation'), or the first `mitigation` filed for
  the report or its cluster (narrative.write_industry_replies moves every
  member of the cluster at the moment it writes the reply).
- report 'resolved'/'closed': the first regulator finding on the report
  (`concern_response` kind 'finding', narrative.py writes one per report).
- report 'under_review': a regulator acknowledge/finding reply
  (routers/concerns.py add_response) or a `concern.status.under_review`
  activity row.
- any report status set through PATCH: its `concern.status.<status>` row.
- report 'corroborated', background reports: the SECOND corroboration
  (narrative.py promotes 'new' at two). Episode reports are written
  'corroborated' at insert, so theirs is `created_at`.

WHAT IS NOT STAMPED, and how it is told instead:

- When a GENERATED alert was RESOLVED or EXPIRED. No column, no activity
  row. The generator decides it from age at the build instant
  (narrative.write_alerts): a monitor alert resolves or expires once it has
  been over for more than `MONITOR_ALERT_CLOSES_AFTER` (6 days); a cluster
  alert resolves `CLUSTER_ALERT_CLOSES_AFTER` (96 h) after its episode
  started. That same rule is evaluated at `at` -- what a build at `at` would
  have stored. Every other alert (the leapfrog, the fleet, the wind-shift
  alerts) is taken as resolved no earlier than its `ended_at`.
  tests/test_status_at.py pins the rule against the checked-in data, both
  ways.
- An alert resolved at RUNTIME (domain.resolve_alert) IS stamped: its
  `alert.resolved` activity row, at the frozen build instant. That stamp
  gates every rule above (`first_resolutions`), because resolve_alert keeps
  an `ended_at` the alert already had (COALESCE): an alert that ended on
  Aug 20 and was resolved by a scenario would otherwise read 'resolved' from
  Aug 20 in replay.
- Whether a background report drawn 'corroborated' was drawn so. The generator
  marks 30 % of background reports older than `CONCERN_CORROBORATED_AFTER`
  (20 h) at the build 'corroborated' with no corroboration at all; those read
  'corroborated' from 20 h after posting (the same rule, at `at`). One that
  also has two corroborations reads it from the second: which path set it is
  not recorded, and the stamped one never claims early.
- A cluster's 'reviewed'/'closed'. The generator decides it from age too
  (narrative.write_clusters: 'active' until `CLUSTER_REVIEWED_AFTER`, 72 h,
  after its last report was noticed), and it is told by that rule.

LEFT AS STORED, on purpose: four alerts are stored 'active' with an
acknowledgement filed (narrative.write_alerts acknowledges 35 % of 'active'
rows without moving the status). They read 'active' at every moment, as they
do at the end of the data, and their detail's `acknowledged_by` lists the
acknowledgement. Promoting them would change the end of the data, and at
runtime an 'active' row with an acknowledgement is a legitimate state: a
re-raised alert (domain.evaluate_action_level / detect_cluster set 'active'
again).
"""

from __future__ import annotations

import sqlite3
from typing import Any, Iterable

from air.server import shapes, timeutil
from air.server.db import rows

#: narrative.write_alerts: `age_d > 6` -> resolved (90 %) or expired, where the
#: age runs from `ended_at`. Strictly more than, as there.
MONITOR_ALERT_CLOSES_AFTER = {"days": 6}
#: narrative.write_alerts: a cluster alert is 'active' while `age_h < 96` from
#: its episode's start (`started_at`), then 'resolved'.
CLUSTER_ALERT_CLOSES_AFTER = {"hours": 96}
#: narrative.write_clusters: 'active' while `age_h < 72` from `last_at`.
CLUSTER_REVIEWED_AFTER = {"hours": 72}
#: narrative.write_concerns: a background report younger than 20 h is 'new'.
CONCERN_CORROBORATED_AFTER = {"hours": 20}

_MONITOR_KINDS = ("exceedance", "integrated_exposure")
_TERMINAL_ALERT = ("resolved", "expired")
_CONCERN_PATH = ("new", "corroborated", "under_review", "mitigation_proposed")


def at_end(at: str | None) -> bool:
    """True when `at` is the end of the data: no moment, or the build instant
    or later. Every stamp is naive `YYYY-MM-DDTHH:MM:SS`, so strings compare."""
    return not at or at >= timeutil.now_iso()


# ── alerts ────────────────────────────────────────────────────────────────────

def first_acks(conn: sqlite3.Connection, alert_ids: Iterable[str]) -> dict[str, str]:
    """Each alert's first acknowledgement, `alert_ack.created_at`."""
    ids = list(dict.fromkeys(alert_ids))
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    return {
        r["alert_id"]: r["first"]
        for r in rows(
            conn,
            f"SELECT alert_id, MIN(created_at) AS first FROM alert_ack WHERE alert_id IN ({marks}) GROUP BY alert_id",
            ids,
        )
    }


def first_resolutions(conn: sqlite3.Connection, alert_ids: Iterable[str]) -> dict[str, str]:
    """Each alert's first runtime resolution: its `alert.resolved` activity
    row (domain.resolve_alert). The generator writes none (module doc)."""
    ids = list(dict.fromkeys(alert_ids))
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    return {
        r["object_id"]: r["first"]
        for r in rows(
            conn,
            f"""SELECT object_id, MIN(ts) AS first FROM activity
                 WHERE object_type = 'alert' AND verb = 'alert.resolved' AND object_id IN ({marks})
                 GROUP BY object_id""",
            ids,
        )
    }


def _alert_closed_by(r: Any, at: str, resolved_at: str | None = None) -> bool:
    """Had a stored 'resolved'/'expired' alert reached it by `at`? (module doc)."""
    if resolved_at and at < resolved_at:
        return False
    if r["kind"] in _MONITOR_KINDS and r["source_type"] == "monitor":
        closes = timeutil.shift(r["ended_at"], **MONITOR_ALERT_CLOSES_AFTER)
        return closes is not None and at > closes
    if r["kind"] == "concern_cluster":
        closes = timeutil.shift(r["started_at"], **CLUSTER_ALERT_CLOSES_AFTER)
        return closes is not None and at >= closes
    return bool(r["ended_at"]) and at >= r["ended_at"]


def alert_status_at(
    r: Any, at: str | None, first_ack: str | None, resolved_at: str | None = None
) -> str:
    """The alert row's status as it stood at `at` (module doc for the rule).
    `resolved_at` is its `first_resolutions` stamp, when it has one."""
    stored = r["status"]
    if at_end(at):
        return stored
    assert at is not None
    if stored in _TERMINAL_ALERT:
        if _alert_closed_by(r, at, resolved_at):
            return stored
        stored = "acknowledged"
    if stored == "acknowledged":
        return "acknowledged" if first_ack and first_ack <= at else "active"
    return stored


def at_end_fields(r: Any, at: str | None) -> dict[str, Any]:
    """What the END of the data will show for this alert, for a read served at
    an earlier `at` (empty at the end, where the served fields already are it).

    `status_at_end` is the stored status and `ongoing_at_end` is begun and not
    ended at the end of the data (shapes.alert_ongoing). A replay screen reads
    them to know whether "go to the end to acknowledge" leads anywhere: an
    alert 'active' at `at` may be 'resolved' at the end, or long over."""
    if at_end(at):
        return {}
    return {"status_at_end": r["status"], "ongoing_at_end": shapes.alert_ongoing(r, timeutil.now_iso())}


# ── reports ───────────────────────────────────────────────────────────────────

def _earliest(d: dict[str, str], key: str, ts: str | None) -> None:
    if ts and (key not in d or ts < d[key]):
        d[key] = ts


def concern_steps(conn: sqlite3.Connection, found: list[Any]) -> dict[str, dict[str, Any]]:
    """Per report: {'reached': {status: first moment}, 'corroborated_at': [..]}
    from every stamp the data carries (module doc)."""
    if not found:
        return {}
    ids = [c["id"] for c in found]
    marks = ",".join("?" * len(ids))
    out: dict[str, dict[str, Any]] = {
        c["id"]: {"reached": {"new": c["created_at"]}, "corroborated_at": []} for c in found
    }
    for r in rows(
        conn,
        f"SELECT concern_id, created_at FROM concern_corroboration WHERE concern_id IN ({marks}) ORDER BY created_at",
        ids,
    ):
        out[r["concern_id"]]["corroborated_at"].append(r["created_at"])
    for r in rows(
        conn,
        f"SELECT concern_id, role, kind, created_at FROM concern_response WHERE concern_id IN ({marks})",
        ids,
    ):
        reached = out[r["concern_id"]]["reached"]
        if r["kind"] == "mitigation":
            _earliest(reached, "mitigation_proposed", r["created_at"])
        if r["kind"] == "finding":
            _earliest(reached, "resolved", r["created_at"])
            _earliest(reached, "closed", r["created_at"])
        if r["role"] == "regulator" and r["kind"] in ("acknowledge", "finding"):
            _earliest(reached, "under_review", r["created_at"])
    for r in rows(
        conn,
        f"""SELECT object_id, verb, MIN(ts) AS ts FROM activity
             WHERE object_type = 'concern' AND verb LIKE 'concern.status.%' AND object_id IN ({marks})
             GROUP BY object_id, verb""",
        ids,
    ):
        _earliest(out[r["object_id"]]["reached"], r["verb"][len("concern.status."):], r["ts"])

    clusters = sorted({c["cluster_id"] for c in found if c["cluster_id"]})
    cmarks = ",".join("?" * len(clusters)) or "NULL"
    by_cluster: dict[str, str] = {}
    by_concern: dict[str, str] = {}
    for r in rows(
        conn,
        f"""SELECT concern_id, cluster_id, created_at FROM mitigation
             WHERE concern_id IN ({marks}) OR cluster_id IN ({cmarks})""",
        (*ids, *clusters),
    ):
        _earliest(by_concern, r["concern_id"] or "", r["created_at"])
        _earliest(by_cluster, r["cluster_id"] or "", r["created_at"])
    for c in found:
        steps = out[c["id"]]
        reached = steps["reached"]
        _earliest(reached, "mitigation_proposed", by_concern.get(c["id"]))
        if c["cluster_id"]:
            _earliest(reached, "mitigation_proposed", by_cluster.get(c["cluster_id"]))
            # An episode's reports are written 'corroborated' at insert.
            _earliest(reached, "corroborated", c["created_at"])
        else:
            seen = steps["corroborated_at"]
            if len(seen) >= 2:
                _earliest(reached, "corroborated", seen[1])
            elif c["status"] == "corroborated":
                _earliest(
                    reached, "corroborated",
                    timeutil.shift(c["created_at"], **CONCERN_CORROBORATED_AFTER),
                )
    return out


def concern_status_at(stored: str, reached: dict[str, str], at: str | None) -> str:
    """The report's status as it stood at `at`: the stored one if its step was
    taken by then, else the furthest earlier step that was (module doc)."""
    if at_end(at):
        return stored
    assert at is not None
    if reached.get(stored) and reached[stored] <= at:
        return stored
    below = _CONCERN_PATH[: _CONCERN_PATH.index(stored)] if stored in _CONCERN_PATH else _CONCERN_PATH
    for s in reversed(below):
        if reached.get(s) and reached[s] <= at:
            return s
    return "new"


def corroborations_at(stored: int, seen: list[str], at: str | None) -> int:
    """The count as it stood at `at`: the stored one less those filed later."""
    if at_end(at):
        return stored
    assert at is not None
    return max(0, int(stored or 0) - sum(1 for t in seen if t > at))


# ── clusters ──────────────────────────────────────────────────────────────────

def cluster_status_at(r: Any, at: str | None) -> str:
    """A cluster row's status at `at`: 'active' until the generator's age rule
    (or a runtime change, stamped at the build instant) moved it (module doc)."""
    stored = r["status"]
    if at_end(at) or stored == "active":
        return stored
    assert at is not None
    moved = timeutil.shift(r["last_at"], **CLUSTER_REVIEWED_AFTER)
    return stored if moved is not None and at >= moved else "active"
