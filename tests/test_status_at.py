"""Statuses as they stood at a replayed moment (phase 6 of PLAN-refocus, P4).

Only the final status of an alert, a report or a cluster is stored. Served
as it was, replay leaked the future: an alert acknowledged at 09:20 already
read 'acknowledged' at 06:00, and the regulator's "N not acknowledged", the
industry list and the Levels screen counted it so. `air.server.statusat`
rebuilds each one; these tests hold it to the stamps, as oracles computed
straight from the tables:

* no alert reads 'acknowledged' before its first `alert_ack.created_at`, and
  none reads 'resolved'/'expired' before its `ended_at`;
* the list and the detail agree at every moment, and a detail that reads
  'acknowledged' lists the acknowledgement that made it so;
* a served status never runs backwards as the moment moves forward, and at
  the end of the data every status is exactly the stored one;
* the generator's age rule (the one step with no stamp) holds on the
  checked-in data both ways, so evaluating it at `at` is evaluating the rule
  that wrote the data;
* no report reads 'resolved' before its regulator finding, or
  'mitigation_proposed' before an operator's reply or mitigation, and its
  `corroborations` count only what was filed by then;
* the `status` filter filters on the served status.
"""

from __future__ import annotations

import sqlite3
from typing import Any

import pytest

from air.server import statusat, timeutil

pytestmark = pytest.mark.needs_db

ALERT_RANK = {"active": 0, "acknowledged": 1, "resolved": 2, "expired": 2}
CONCERN_RANK = {"new": 0, "corroborated": 1, "under_review": 2, "mitigation_proposed": 3, "resolved": 4, "closed": 4}


def _end(db: sqlite3.Connection) -> str:
    return db.execute("SELECT value FROM setting WHERE key='datagen.now'").fetchone()[0]


def _alert_moments(db: sqlite3.Connection) -> list[str]:
    """Every moment where a status could change, a second either side, plus a
    daily grid, all before the end of the data."""
    end = _end(db)
    marks: set[str] = set()
    for r in db.execute("SELECT created_at, started_at, ended_at, kind FROM alert"):
        for t in (r["created_at"], r["ended_at"],
                  timeutil.shift(r["ended_at"], days=6),
                  timeutil.shift(r["started_at"], hours=96) if r["kind"] == "concern_cluster" else None):
            if t:
                marks |= {timeutil.shift(t, seconds=-1), t, timeutil.shift(t, seconds=1)}
    for (t,) in db.execute("SELECT created_at FROM alert_ack"):
        marks |= {timeutil.shift(t, seconds=-1), t}
    start = db.execute("SELECT MIN(started_at) FROM alert").fetchone()[0]
    t = start
    while t < end:
        marks.add(t)
        t = timeutil.shift(t, days=1)
    return sorted(m for m in marks if m and m < end)


def _first_acks(db: sqlite3.Connection) -> dict[str, str]:
    return {r[0]: r[1] for r in db.execute("SELECT alert_id, MIN(created_at) FROM alert_ack GROUP BY alert_id")}


@pytest.fixture(scope="module")
def served(client, api, json_ok, db) -> dict[str, dict[str, str]]:
    """{moment: {alert id: served status}} from /alerts?at= over every moment."""
    out = {}
    for m in _alert_moments(db):
        out[m] = {a["id"]: a["status"] for a in json_ok(client.get(f"{api}/alerts", params={"at": m}))}
    return out


def test_no_alert_is_acknowledged_before_its_acknowledgement(served, db):
    acks = _first_acks(db)
    for m, found in served.items():
        for aid, status in found.items():
            if status == "acknowledged":
                assert aid in acks and acks[aid] <= m, f"{aid} read 'acknowledged' at {m}; first ack {acks.get(aid)}"


def test_no_alert_is_resolved_before_it_ended(served, db):
    ended = {r["id"]: r["ended_at"] for r in db.execute("SELECT id, ended_at FROM alert")}
    for m, found in served.items():
        for aid, status in found.items():
            if status in ("resolved", "expired"):
                assert ended[aid] and ended[aid] <= m, f"{aid} read {status!r} at {m}; it ended {ended[aid]}"


def test_a_served_status_never_runs_backwards(served, db):
    stored = {r["id"]: r["status"] for r in db.execute("SELECT id, status FROM alert")}
    last: dict[str, int] = {}
    for m in sorted(served):
        for aid, status in served[m].items():
            rank = ALERT_RANK[status]
            assert rank >= last.get(aid, -1), f"{aid} went back to {status!r} at {m}"
            last[aid] = rank
            # ... and is never ahead of the stored one.
            assert rank <= ALERT_RANK[stored[aid]], (aid, m, status)


def test_the_end_of_the_data_is_the_stored_status(client, api, json_ok, db):
    stored = {r["id"]: r["status"] for r in db.execute("SELECT id, status FROM alert")}
    for params in ({}, {"at": _end(db)}):
        found = json_ok(client.get(f"{api}/alerts", params=params))
        assert found and all(a["status"] == stored[a["id"]] for a in found)


def test_replay_changes_what_it_should(served):
    """The case the item names: acknowledged at 09:20, not before; resolved
    once the generator's six days had passed, not the moment it ended."""
    def at(m: str) -> str:
        return statusat.alert_status_at(
            {"kind": "exceedance", "source_type": "monitor", "status": "resolved",
             "ended_at": "2026-07-19T06:00:00", "started_at": "2026-07-19T05:00:00"}, m, "2026-07-19T09:20:48")

    assert at("2026-07-19T06:00:00") == "active"
    assert at("2026-07-19T09:20:48") == "acknowledged"
    assert at("2026-07-25T06:00:00") == "acknowledged"
    assert at("2026-07-25T06:00:01") == "resolved"
    # And on the served list: there is a replayed moment where each stored
    # 'acknowledged' alert still reads 'active'.
    moments = sorted(served)
    for aid in ("al-no2-0034-014", "al-no2-0034-008"):
        seen = [served[m][aid] for m in moments if aid in served[m]]
        if seen:
            assert seen[0] == "active" and "acknowledged" in seen, (aid, seen)


def test_list_and_detail_agree(client, api, json_ok, db):
    acks = _first_acks(db)
    moments = _alert_moments(db)[::7]
    for m in moments:
        for a in json_ok(client.get(f"{api}/alerts", params={"at": m})):
            d = json_ok(client.get(f"{api}/alerts/{a['id']}", params={"at": m}))
            assert d["status"] == a["status"], (a["id"], m)
            if d["status"] == "acknowledged":
                assert d["acknowledged_by"], (a["id"], m)
            if a["id"] in acks and acks[a["id"]] > m:
                assert d["status"] != "acknowledged"


def test_the_status_filter_is_on_the_served_status(client, api, json_ok, served):
    for m in sorted(served)[::11]:
        for status in ("active", "acknowledged", "resolved"):
            got = {a["id"] for a in json_ok(client.get(f"{api}/alerts", params={"at": m, "status": status}))}
            assert got == {aid for aid, s in served[m].items() if s == status}, (m, status)


def test_the_generator_age_rule_holds_on_the_data(db):
    """The rule statusat tells at `at` is the rule that wrote the data."""
    end = _end(db)
    for r in db.execute("SELECT * FROM alert"):
        terminal = r["status"] in ("resolved", "expired")
        if r["kind"] in ("exceedance", "integrated_exposure") and r["source_type"] == "monitor":
            closes = timeutil.shift(r["ended_at"], **statusat.MONITOR_ALERT_CLOSES_AFTER)
            assert terminal == (closes is not None and end > closes), r["id"]
        elif r["kind"] == "concern_cluster":
            closes = timeutil.shift(r["started_at"], **statusat.CLUSTER_ALERT_CLOSES_AFTER)
            assert terminal == (end >= closes), r["id"]
    for r in db.execute("SELECT * FROM concern_cluster"):
        moved = timeutil.shift(r["last_at"], **statusat.CLUSTER_REVIEWED_AFTER)
        assert (r["status"] != "active") == (end >= moved), r["id"]


# ── reports and clusters ──────────────────────────────────────────────────────

def _concern_moments(db: sqlite3.Connection) -> list[str]:
    end = _end(db)
    marks = set()
    for (t,) in db.execute("SELECT created_at FROM concern_response UNION SELECT created_at FROM mitigation"):
        marks |= {timeutil.shift(t, seconds=-1), t}
    return sorted(m for m in marks if m < end)[::3]


def test_no_report_is_ahead_of_its_stamps(client, api, json_ok, db):
    finding: dict[str, str] = {}
    replied: dict[str, str] = {}
    for r in db.execute("SELECT concern_id, kind, MIN(created_at) AS t FROM concern_response GROUP BY 1, 2"):
        (finding if r["kind"] == "finding" else replied if r["kind"] == "mitigation" else {})[r["concern_id"]] = r["t"]
    cluster_of = {r["id"]: r["cluster_id"] for r in db.execute("SELECT id, cluster_id FROM concern")}
    mit = {r[0]: r[1] for r in db.execute("SELECT cluster_id, MIN(created_at) FROM mitigation GROUP BY 1")}
    seen = {}
    for r in db.execute("SELECT concern_id, created_at FROM concern_corroboration"):
        seen.setdefault(r["concern_id"], []).append(r["created_at"])
    stored = {r["id"]: (r["status"], r["corroborations"]) for r in db.execute("SELECT * FROM concern")}
    last: dict[str, int] = {}
    for m in _concern_moments(db):
        for c in json_ok(client.get(f"{api}/concerns", params={"at": m, "limit": 5000})):
            cid, status = c["id"], c["status"]
            if status in ("resolved", "closed"):
                assert cid in finding and finding[cid] <= m, (cid, m)
            if status == "mitigation_proposed":
                stamps = [t for t in (replied.get(cid), mit.get(cluster_of[cid] or "")) if t]
                assert stamps and min(stamps) <= m, (cid, m)
            assert CONCERN_RANK[status] >= last.get(cid, -1), (cid, m, status)
            last[cid] = CONCERN_RANK[status]
            later = sum(1 for t in seen.get(cid, []) if t > m)
            assert c["corroborations"] == max(0, stored[cid][1] - later), (cid, m)
    end = json_ok(client.get(f"{api}/concerns", params={"limit": 5000}))
    assert end and all((c["status"], c["corroborations"]) == stored[c["id"]] for c in end)


def test_a_replied_report_reads_its_earlier_status_before_the_reply(client, api, json_ok, db):
    r = db.execute(
        """SELECT c.id, MIN(cr.created_at) AS t FROM concern c JOIN concern_response cr ON cr.concern_id = c.id
            WHERE cr.kind = 'finding' GROUP BY c.id ORDER BY t LIMIT 1"""
    ).fetchone()
    assert r is not None
    before = timeutil.shift(r["t"], seconds=-1)
    got = {c["id"]: c for c in json_ok(client.get(f"{api}/concerns", params={"at": before, "limit": 5000}))}
    assert got[r["id"]]["status"] not in ("resolved", "closed")
    at = {c["id"]: c for c in json_ok(client.get(f"{api}/concerns", params={"at": r["t"], "limit": 5000}))}
    assert at[r["id"]]["status"] == "resolved"


def test_clusters_are_active_until_the_age_rule(client, api, json_ok, db):
    stored = {r["id"]: dict(r) for r in db.execute("SELECT * FROM concern_cluster")}
    for m in _concern_moments(db)[::4]:
        for c in json_ok(client.get(f"{api}/clusters", params={"at": m})):
            s = stored[c["id"]]
            if c["status"] != "active":
                assert m >= timeutil.shift(s["last_at"], **statusat.CLUSTER_REVIEWED_AFTER), (c["id"], m)
                assert c["status"] == s["status"]
    end = json_ok(client.get(f"{api}/clusters"))
    assert all(c["status"] == stored[c["id"]]["status"] for c in end)


def test_status_at_is_identity_at_the_end():
    row: dict[str, Any] = {"kind": "exceedance", "source_type": "monitor", "status": "acknowledged",
                           "ended_at": None, "started_at": "2026-01-01T00:00:00"}
    assert statusat.alert_status_at(row, None, None) == "acknowledged"
    assert statusat.concern_status_at("resolved", {}, None) == "resolved"
    assert statusat.corroborations_at(3, ["2099-01-01T00:00:00"], None) == 3


# ── a runtime resolution, and what the end of the data will show (phase 6) ────

def test_a_runtime_resolution_is_read_from_its_stamp():
    """resolve_alert keeps an `ended_at` the alert already had, so replay reads
    the resolution from its `alert.resolved` row, stamped at the build
    instant: the alert that ended Aug 20 and was resolved by a scenario does
    not read 'resolved' from Aug 20."""
    row = {"kind": "mobile_detection", "source_type": "mobile", "status": "resolved",
           "ended_at": "2026-08-20T00:00:00", "started_at": "2026-08-19T22:00:00"}
    stamp = "2026-08-28T13:54:00"
    assert statusat.alert_status_at(row, "2026-08-21T00:00:00", None) == "resolved"  # no stamp: ended_at
    assert statusat.alert_status_at(row, "2026-08-21T00:00:00", None, stamp) == "active"
    assert statusat.alert_status_at(row, "2026-08-21T00:00:00", "2026-08-20T01:00:00", stamp) == "acknowledged"
    assert statusat.alert_status_at(row, None, None, stamp) == "resolved"


def test_resolve_alert_keeps_the_ended_at_and_stamps_the_step(tmp_path):
    from air.datagen.db import apply_schema
    from air.server import domain

    conn = sqlite3.connect(tmp_path / "t.db")
    conn.row_factory = sqlite3.Row
    apply_schema(conn)
    conn.execute("PRAGMA foreign_keys=OFF")  # one alert table, no campaign row
    base = {"campaign_id": "c", "kind": "mobile_detection", "severity": "warning", "source_type": "mobile",
            "status": "active", "title": "t", "started_at": "2026-08-19T22:00:00", "created_at": "2026-08-19T22:00:00"}
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(alert)")]
    for aid, ended in (("a-ended", "2026-08-20T00:00:00"), ("a-live", None)):
        vals = {**{k: v for k, v in base.items() if k in cols}, "id": aid, "ended_at": ended}
        conn.execute(f"INSERT INTO alert ({','.join(vals)}) VALUES ({','.join('?' * len(vals))})", tuple(vals.values()))
    now = timeutil.now_iso()
    domain.resolve_alert(conn, "c", "a-ended", "test")
    domain.resolve_alert(conn, "c", "a-live", "test")
    got = {r["id"]: r["ended_at"] for r in conn.execute("SELECT id, ended_at FROM alert")}
    assert got == {"a-ended": "2026-08-20T00:00:00", "a-live": now}
    assert statusat.first_resolutions(conn, ["a-ended", "a-live"]) == {"a-ended": now, "a-live": now}


def test_replay_says_what_the_end_will_show(client, api, json_ok, db):
    """S7: before the end every alert carries `status_at_end` (the stored
    status) and `ongoing_at_end`; at the end neither is served."""
    end = _end(db)
    stored = {r["id"]: r for r in db.execute("SELECT * FROM alert")}
    moments = _alert_moments(db)[::13]
    assert moments
    for m in moments:
        found = json_ok(client.get(f"{api}/alerts", params={"at": m}))
        for a in found:
            r = stored[a["id"]]
            assert a["status_at_end"] == r["status"], (a["id"], m)
            ongoing = bool(r["ended_at"] is None or r["ended_at"] > end)
            assert a["ongoing_at_end"] == ongoing, (a["id"], m)
        if found:
            a = found[0]
            d = json_ok(client.get(f"{api}/alerts/{a['id']}", params={"at": m}))
            assert d["status_at_end"] == a["status_at_end"] and d["ongoing_at_end"] == a["ongoing_at_end"]
    for params in ({}, {"at": end}):
        for a in json_ok(client.get(f"{api}/alerts", params=params)):
            assert "status_at_end" not in a and "ongoing_at_end" not in a


def test_campaign_counts_follow_the_clock(client, api, json_ok, db):
    """S5: /stats/campaign's workflow counts as they stood at `at`."""
    end = _end(db)
    whole = json_ok(client.get(f"{api}/stats/campaign"))
    assert whole["concerns_total"] == db.execute("SELECT COUNT(*) FROM concern").fetchone()[0]
    assert whole["concerns_open"] == db.execute(
        "SELECT COUNT(*) FROM concern WHERE status NOT IN ('resolved','closed')").fetchone()[0]
    assert whole["alerts_active"] == db.execute("SELECT COUNT(*) FROM alert WHERE status='active'").fetchone()[0]
    mid = timeutil.shift(end, days=-30)
    then = json_ok(client.get(f"{api}/stats/campaign", params={"at": mid}))
    assert then["concerns_total"] == db.execute(
        "SELECT COUNT(*) FROM concern WHERE created_at <= ?", (mid,)).fetchone()[0]
    served = json_ok(client.get(f"{api}/concerns", params={"at": mid, "limit": 5000}))
    assert then["concerns_open"] == sum(1 for c in served if c["status"] not in ("resolved", "closed"))
    alerts = json_ok(client.get(f"{api}/alerts", params={"at": mid}))
    assert then["alerts_active"] == sum(1 for a in alerts if a["status"] == "active")
    assert then["km_driven"] == whole["km_driven"]  # the fleet figures are the whole campaign


def test_a_replayed_report_says_what_the_end_will_show(client, api, json_ok, db):
    """Reports carry `status_at_end` (the stored status) in replay, as alerts
    do, so a screen can tell whether "go to the end" to mark one leads
    anywhere; at the end it is not served."""
    end = _end(db)
    stored = {r["id"]: r["status"] for r in db.execute("SELECT id, status FROM concern")}
    for m in ("2026-06-17T09:00:00", "2026-07-21T12:00:00", "2026-08-25T06:00:00"):
        found = json_ok(client.get(f"{api}/concerns", params={"at": m, "limit": 500}))
        assert found, m
        for c in found:
            assert c["status_at_end"] == stored[c["id"]], (c["id"], m)
    for params in ({"limit": 500}, {"at": end, "limit": 500}):
        for c in json_ok(client.get(f"{api}/concerns", params=params)):
            assert "status_at_end" not in c
