"""The one clock, server half (docs/PLAN-refocus.md, Phase 2 contract, F1/F2).

Two rules, both of which failed silently before they were written down:

- **"Now" is the build instant, frozen, and naive.** `timeutil.now()` used to be
  the wall clock written with a `Z`; the data is naive campaign time, so every
  server stamp drifted by the viewer's UTC offset and every "latest" window
  emptied once the demo was a day old.
- **Events follow the clock, bounded before the LIMIT.** `/feed`, `/concerns`,
  `/clusters`, `/stats/community` and `/alerts` take `at`. A browser filter
  applied after the server's LIMIT empties the list: the newest N at the end
  of the data are all later than a mid-campaign moment. What rides on a row
  follows it too: a report's cluster, its replies, a mitigation's status, an
  alert's acknowledgements, a monitor's latest reading.

The moment used below is 16 days before the build, at noon — Aug 12 12:00 on
the pinned build — so it is mid-campaign on any build, and no test asserts a
number that depends on which one this is.
"""

from __future__ import annotations

import pytest

from air.server import timeutil

pytestmark = pytest.mark.needs_db


@pytest.fixture(scope="module")
def build_now(db) -> str:
    row = db.execute("SELECT value FROM setting WHERE key='datagen.now'").fetchone()
    if row is None:
        pytest.skip("database has no datagen.now build stamp")
    return row[0]


@pytest.fixture(scope="module")
def mid(build_now: str) -> str:
    return f"{timeutil.shift(build_now, days=-16)[:10]}T12:00:00"


def _naive(t: str | None) -> bool:
    """`YYYY-MM-DDTHH:MM:SS`, exactly: no `Z`, no offset, no fraction."""
    return t is not None and len(t) == 19 and timeutil.iso(timeutil.parse(t)) == t


# ── now ───────────────────────────────────────────────────────────────────────

def test_now_is_the_build_stamp(build_now: str) -> None:
    assert timeutil.now_iso() == build_now
    assert "Z" not in timeutil.now_iso()
    assert _naive(timeutil.now_iso())


def test_bootstrap_now_is_naive_and_is_the_build(client, api, json_ok) -> None:
    flags = json_ok(client.get(f"{api}/bootstrap"))["flags"]
    assert "Z" not in flags["now"]
    assert _naive(flags["now"])
    assert flags["now"] == flags["generated_at"]


def test_a_z_is_dropped_not_converted() -> None:
    """A client that sends `...Z` gets the hour it wrote, not one shifted by an
    offset — the bug that served an hour 5-7 h away from the one on screen."""
    assert timeutil.iso(timeutil.parse("2026-08-12T12:00:00Z")) == "2026-08-12T12:00:00"
    assert timeutil.iso(timeutil.parse("2026-08-12T12:00:00.000Z")) == "2026-08-12T12:00:00"
    assert timeutil.iso(timeutil.parse("2026-08-12T12:00:00-05:00")) == "2026-08-12T12:00:00"


# ── /alerts ───────────────────────────────────────────────────────────────────

def _begun(a: dict) -> str:
    """When an alert entered the record: `started_at`, but `created_at` (when it
    was raised) for a concern cluster, whose `started_at` is when the episode
    was first noticed — hours before any report was posted."""
    return a["created_at"] if a["kind"] == "concern_cluster" else a["started_at"]


def _ongoing(a: dict, now: str) -> bool:
    return _begun(a) <= now and (a["ended_at"] is None or a["ended_at"] > now)


def test_alerts_at_returns_only_what_had_started(client, api, json_ok, mid) -> None:
    served = json_ok(client.get(f"{api}/alerts", params={"at": mid}))
    everything = json_ok(client.get(f"{api}/alerts"))
    assert served, f"no alert had started by {mid}"
    assert len(served) < len(everything), "`at` bounded nothing"
    assert all(_begun(a) <= mid for a in served)
    assert {a["id"] for a in served} == {a["id"] for a in everything if _begun(a) <= mid}
    for a in served:
        assert a["ongoing"] is _ongoing(a, mid), a["id"]


def test_a_cluster_alert_waits_for_its_cluster(client, api, json_ok, db) -> None:
    """A concern-cluster alert is not served before it was raised, and when it
    is, /clusters at that moment lists its cluster. Bounded on `started_at`,
    al-cluster-01 was served at Jun 17 07:00 as a 7-report cluster while
    /clusters said nothing had formed and not one of its reports was posted."""
    alerts = [
        dict(r) for r in db.execute(
            """SELECT id, source_id, started_at, created_at FROM alert
                WHERE kind='concern_cluster' AND source_id IS NOT NULL AND created_at > started_at
                ORDER BY created_at"""
        )
    ]
    if not alerts:
        pytest.skip("no concern-cluster alert raised after its episode began")
    for al in alerts[:3]:
        before = timeutil.shift(al["created_at"], seconds=-1)
        assert before >= al["started_at"]
        ids = {a["id"] for a in json_ok(client.get(f"{api}/alerts", params={"at": before}))}
        assert al["id"] not in ids, f"{al['id']} served before it was raised"
        at = al["created_at"]
        served = {a["id"]: a for a in json_ok(client.get(f"{api}/alerts", params={"at": at}))}
        assert al["id"] in served and served[al["id"]]["ongoing"] is True
        clusters = {c["id"] for c in json_ok(client.get(f"{api}/clusters", params={"at": at}))}
        assert al["source_id"] in clusters, f"{al['id']} raised over a cluster /clusters did not list"


def test_cluster_alerts_are_raised_after_their_cluster_forms(db) -> None:
    """The invariant the alert bound leans on: `created_at` is never before the
    CLUSTER_MIN_COUNT-th member was posted (live, `detect_cluster` raises the
    alert in the same write as that report). If datagen ever breaks it, an
    alert would again precede its cluster on every replayed list."""
    from air.server import config

    for al_id, cl_id, raised in db.execute(
        "SELECT id, source_id, created_at FROM alert WHERE kind='concern_cluster' AND source_id IS NOT NULL"
    ):
        posted = [
            r[0] for r in db.execute(
                "SELECT created_at FROM concern WHERE cluster_id=? ORDER BY created_at", (cl_id,)
            )
        ]
        if len(posted) >= config.CLUSTER_MIN_COUNT:
            assert raised >= posted[config.CLUSTER_MIN_COUNT - 1], al_id


# ── /alerts/{id} ──────────────────────────────────────────────────────────────

def test_alert_detail_at_is_bounded(client, api, json_ok, db) -> None:
    """Acknowledgements and samples from by `at`, not after: unbounded,
    al-no2-0034-003 at Jul 19 06:00 carried a 09:20 ack and samples to 08:00."""
    row = db.execute(
        """SELECT a.id, a.started_at, MIN(k.created_at) AS acked FROM alert a
             JOIN alert_ack k ON k.alert_id = a.id
            WHERE a.kind != 'concern_cluster' GROUP BY a.id
           HAVING acked > a.started_at ORDER BY a.started_at LIMIT 1"""
    ).fetchone()
    if row is None:
        pytest.skip("no alert acknowledged after it started")
    at = row["started_at"]
    got = json_ok(client.get(f"{api}/alerts/{row['id']}", params={"at": at}))
    assert got["not_started"] is False
    assert all(k["created_at"] <= at for k in got["acknowledged_by"])
    assert not got["acknowledged_by"], "an acknowledgement from after `at`"
    assert all(s["t"] <= at for s in got["samples"])
    full = json_ok(client.get(f"{api}/alerts/{row['id']}"))
    assert full["acknowledged_by"] and full["not_started"] is False
    assert len(full["samples"]) >= len(got["samples"])


def test_alert_detail_before_it_began_is_flagged_not_404(client, api, json_ok, db, mid) -> None:
    row = db.execute(
        """SELECT id FROM alert WHERE (CASE WHEN kind='concern_cluster' THEN created_at
                                            ELSE started_at END) > ? ORDER BY started_at DESC LIMIT 1""",
        (mid,),
    ).fetchone()
    if row is None:
        pytest.skip(f"every alert had begun by {mid}")
    got = json_ok(client.get(f"{api}/alerts/{row['id']}", params={"at": mid}))
    assert got["not_started"] is True and got["ongoing"] is False
    assert all(s["t"] <= mid for s in got["samples"])
    assert all(c["created_at"] <= mid for c in got["concerns"])
    assert all(m["created_at"] <= mid for m in got["mitigations"])
    assert not any(k["created_at"] > mid for k in got["acknowledged_by"])
    assert client.get(f"{api}/alerts/{row['id']}", params={"at": "garbage"}).status_code == 422


def test_ongoing_is_not_status(client, api, json_ok, build_now) -> None:
    """"Live" is begun-and-not-ended, not `status == 'active'`: a status field
    cannot say when an alert ended."""
    served = json_ok(client.get(f"{api}/alerts"))
    for a in served:
        assert a["ongoing"] is _ongoing(a, build_now), a["id"]
    assert any(a["ongoing"] for a in served), "nothing ongoing at the end of the data"
    if not any(a["status"] == "active" and not a["ongoing"] for a in served):
        pytest.skip("no 'active' alert that has already ended in this build")


def test_no_at_is_the_end(client, api, json_ok, build_now) -> None:
    """Sending no `at` means the end, and the server agrees; past the end is the end."""
    default = json_ok(client.get(f"{api}/alerts"))
    assert json_ok(client.get(f"{api}/alerts", params={"at": build_now})) == default
    assert json_ok(client.get(f"{api}/alerts", params={"at": "2099-01-01T00:00:00"})) == default


def test_at_with_a_z_is_the_same_moment(client, api, json_ok, mid) -> None:
    plain = json_ok(client.get(f"{api}/alerts", params={"at": mid}))
    assert json_ok(client.get(f"{api}/alerts", params={"at": f"{mid}Z"})) == plain


def test_a_bad_at_is_a_422(client, api) -> None:
    r = client.get(f"{api}/alerts", params={"at": "yesterday"})
    assert r.status_code == 422
    assert "json" in r.headers.get("content-type", "")


# ── /feed, /concerns, /clusters: the bound is before the LIMIT ────────────────

def test_feed_at_is_bounded_before_the_limit(client, api, json_ok, mid) -> None:
    params = {"role": "community", "limit": 40}
    served = json_ok(client.get(f"{api}/feed", params={**params, "at": mid}))
    assert served, f"empty feed at {mid}"
    assert all(i["at"] <= mid for i in served)
    # What a browser filter over the end-of-data response would have kept. If
    # the bound ran after the LIMIT, the two would be the same list.
    filtered = [i for i in json_ok(client.get(f"{api}/feed", params=params)) if i["at"] <= mid]
    assert len(served) > len(filtered)


def test_feed_readings_are_built_as_of_at(client, api, json_ok, mid) -> None:
    served = json_ok(client.get(f"{api}/feed", params={"role": "regulator", "at": mid}))
    readings = [i for i in served if i["type"] == "reading"]
    for i in readings:
        assert i["at"] <= mid
        for v in i["monitor"]["latest"].values():
            assert v["ts"] <= mid, "the monitor riding in the item carries a later reading"


def test_concerns_at_is_bounded_before_the_limit(client, api, json_ok, mid) -> None:
    served = json_ok(client.get(f"{api}/concerns", params={"at": mid, "limit": 40}))
    assert served, f"no report filed by {mid}"
    assert all(c["created_at"] <= mid for c in served)
    filtered = [
        c for c in json_ok(client.get(f"{api}/concerns", params={"limit": 40}))
        if c["created_at"] <= mid
    ]
    assert len(served) > len(filtered)


def test_clusters_at_only_what_had_begun(client, api, json_ok, mid) -> None:
    served = json_ok(client.get(f"{api}/clusters", params={"at": mid}))
    assert served
    assert len(served) < len(json_ok(client.get(f"{api}/clusters")))
    assert all(c["first_at"] <= mid and c["last_at"] <= mid for c in served)


def test_a_cluster_is_recounted_from_what_had_been_posted(client, api, json_ok, db) -> None:
    """The row is the final shape. At a moment inside it the count is the
    members posted by then, and below three the cluster had not formed —
    the rule the community map's `clusterAsOf` applies."""
    from air.server import config

    row = db.execute(
        """SELECT k.id, k.count FROM concern_cluster k
            WHERE (SELECT COUNT(*) FROM concern c WHERE c.cluster_id = k.id) = k.count
              AND k.count > ? ORDER BY k.first_at LIMIT 1""",
        (config.CLUSTER_MIN_COUNT,),
    ).fetchone()
    if row is None:
        pytest.skip("no cluster with all its members on file")
    posted = [
        r[0] for r in db.execute(
            "SELECT created_at FROM concern WHERE cluster_id=? ORDER BY created_at", (row["id"],)
        )
    ]

    def served(at: str) -> dict | None:
        found = json_ok(client.get(f"{api}/clusters", params={"at": at}))
        return next((c for c in found if c["id"] == row["id"]), None)

    early = posted[config.CLUSTER_MIN_COUNT - 2]  # one short of forming
    assert served(early) is None, "a cluster was served before it had formed"
    at = posted[config.CLUSTER_MIN_COUNT - 1]
    got = served(at)
    assert got is not None
    assert got["count"] == sum(t <= at for t in posted) < row["count"]
    assert got["last_at"] <= at
    assert got["last_posted_at"] == at, "last_posted_at is the newest member counted"
    # `last_posted_at` at the end is the moment the whole cluster is on file:
    # landing the clock there shows every member. `last_at` (noticed) does not.
    whole = served(posted[-1])
    assert whole is not None and whole["count"] == row["count"]
    assert whole["last_posted_at"] == posted[-1]
    end = next(c for c in json_ok(client.get(f"{api}/clusters")) if c["id"] == row["id"])
    assert end["last_posted_at"] == posted[-1]


def _cluster_forming(db) -> tuple[str, list[str]]:
    from air.server import config

    row = db.execute(
        """SELECT k.id FROM concern_cluster k
            WHERE (SELECT COUNT(*) FROM concern c WHERE c.cluster_id = k.id) = k.count
              AND k.count >= ? ORDER BY k.first_at LIMIT 1""",
        (config.CLUSTER_MIN_COUNT,),
    ).fetchone()
    if row is None:
        pytest.skip("no cluster with all its members on file")
    posted = [
        r[0] for r in db.execute(
            "SELECT created_at FROM concern WHERE cluster_id=? ORDER BY created_at", (row[0],)
        )
    ]
    return row[0], posted


def test_a_report_is_not_grouped_before_its_cluster_formed(client, api, json_ok, db) -> None:
    """`cluster_id` follows the /clusters recount. At Jun 17 08:30 two of
    cl-01's reports were posted, /clusters did not list it, and both came back
    with cluster_id='cl-01-2026' — "Part of a group" over a group of two."""
    from air.server import config

    cl, posted = _cluster_forming(db)
    early = posted[config.CLUSTER_MIN_COUNT - 2]
    mine = [
        c for c in json_ok(client.get(f"{api}/concerns", params={"at": early, "limit": 400}))
        if c["created_at"] >= posted[0] and c["created_at"] <= early
    ]
    ids = {r[0] for r in db.execute("SELECT id FROM concern WHERE cluster_id=?", (cl,))}
    members = [c for c in mine if c["id"] in ids]
    assert len(members) == config.CLUSTER_MIN_COUNT - 1
    assert all(c["cluster_id"] is None for c in members), "grouped before the group existed"
    assert json_ok(client.get(f"{api}/concerns", params={"at": early, "cluster_id": cl})) == []
    assert cl not in {c["id"] for c in json_ok(client.get(f"{api}/clusters", params={"at": early}))}

    formed = posted[config.CLUSTER_MIN_COUNT - 1]
    grouped = json_ok(client.get(f"{api}/concerns", params={"at": formed, "cluster_id": cl}))
    assert len(grouped) == config.CLUSTER_MIN_COUNT
    assert all(c["cluster_id"] == cl for c in grouped)
    # The feed carries the same concern objects, so the same rule.
    feed = json_ok(client.get(f"{api}/feed", params={"role": "community", "at": early, "limit": 80}))
    for i in feed:
        if i["type"] == "concern" and i["concern"]["id"] in ids:
            assert i["concern"]["cluster_id"] is None


def test_responses_are_the_ones_filed_by_at(client, api, json_ok, db) -> None:
    row = db.execute(
        """SELECT c.id, c.created_at FROM concern c JOIN concern_response r ON r.concern_id = c.id
            WHERE r.created_at > c.created_at ORDER BY c.created_at LIMIT 1"""
    ).fetchone()
    if row is None:
        pytest.skip("no concern answered after it was filed")
    at = row["created_at"]
    got = next(
        c for c in json_ok(client.get(f"{api}/concerns", params={"at": at, "limit": 5}))
        if c["id"] == row["id"]
    )
    assert all(r["created_at"] <= at for r in got["responses"])
    later = db.execute(
        "SELECT COUNT(*) FROM concern_response WHERE concern_id=? AND created_at > ?", (row["id"], at)
    ).fetchone()[0]
    assert later and len(got["responses"]) == db.execute(
        "SELECT COUNT(*) FROM concern_response WHERE concern_id=?", (row["id"],)
    ).fetchone()[0] - later


def test_a_mitigation_completed_later_is_in_progress(client, api, json_ok, db) -> None:
    """At Aug 12 the feed said the operator "has finished" mt-003, which
    completes Aug 18."""
    row = db.execute(
        """SELECT id, created_at, completed_at FROM mitigation
            WHERE status='completed' AND completed_at > created_at ORDER BY created_at LIMIT 1"""
    ).fetchone()
    if row is None:
        pytest.skip("no mitigation completed after it was filed")
    at = timeutil.shift(row["completed_at"], seconds=-1)
    feed = json_ok(client.get(f"{api}/feed", params={"role": "community", "at": at, "limit": 200}))
    got = next(
        (i["mitigation"] for i in feed if i["type"] == "mitigation" and i["mitigation"]["id"] == row["id"]),
        None,
    )
    assert got is not None, "mitigation missing from the feed at a moment it existed"
    assert got["status"] == "in_progress" and got["completed_at"] is None
    # At the end it has fallen off the feed's newest-N; /mitigations lists all.
    done = next(m for m in json_ok(client.get(f"{api}/mitigations")) if m["id"] == row["id"])
    assert done["status"] == "completed" and done["completed_at"] == row["completed_at"]


# ── /stats/community ──────────────────────────────────────────────────────────

def test_stats_at_is_the_stats_now(client, api, json_ok, db, mid) -> None:
    default = json_ok(client.get(f"{api}/stats/community"))
    served = json_ok(client.get(f"{api}/stats/community", params={"at": mid}))
    moving = ("concern_count_7d", "advisory_count_active", "trend_pct")
    assert tuple(served[k] for k in moving) != tuple(default[k] for k in moving)
    week = db.execute(
        "SELECT COUNT(*) FROM concern WHERE created_at >= ? AND created_at <= ?",
        (timeutil.shift(mid, days=-7), mid),
    ).fetchone()[0]
    assert served["concern_count_7d"] == week
    # Street colours stay whole-campaign (D2): only the clock-bound numbers move.
    assert served["worst_streets"] == default["worst_streets"]
    assert [m["risk"] for m in served["by_measure"]] == [m["risk"] for m in default["by_measure"]]


def test_passes_to_date_follows_the_clock(client, api, json_ok, db, mid, build_now) -> None:
    """`passes_total` is the whole record (beside the street colours); "so
    far" at a replayed moment is `passes_to_date`."""
    served = json_ok(client.get(f"{api}/stats/community", params={"at": mid}))
    driven = db.execute("SELECT COUNT(*) FROM segment_pass WHERE ts <= ?", (mid,)).fetchone()[0]
    assert served["passes_to_date"] == driven
    assert 0 < served["passes_to_date"] < served["passes_total"]
    end = json_ok(client.get(f"{api}/stats/community"))
    assert end["passes_to_date"] == db.execute(
        "SELECT COUNT(*) FROM segment_pass WHERE ts <= ?", (build_now,)
    ).fetchone()[0]
    assert end["passes_to_date"] <= end["passes_total"]


# ── reads served as of a moment: /monitors, /wind, /coverage/calibration ──────

def test_monitors_latest_is_as_of_at(client, api, json_ok, mid) -> None:
    """Without `at` every tower read its Aug 28 13:00 reading whatever the clock
    showed, while the bounded feed beside it read the same tower at Aug 12."""
    served = json_ok(client.get(f"{api}/monitors", params={"at": mid}))
    default = json_ok(client.get(f"{api}/monitors"))
    assert served and any(m["latest"] for m in served)
    for m in served:
        for v in m["latest"].values():
            assert v["ts"] <= mid, f"{m['id']} carries a reading from after {mid}"
    assert served != default
    one = next(m for m in served if m["latest"])
    detail = json_ok(client.get(f"{api}/monitors/{one['id']}", params={"at": mid}))
    assert detail["latest"] == one["latest"]
    assert json_ok(client.get(f"{api}/monitors", params={"at": "2099-01-01T00:00:00"})) == default
    assert client.get(f"{api}/monitors", params={"at": "garbage"}).status_code == 422
    assert client.get(f"{api}/monitors/{one['id']}", params={"at": "garbage"}).status_code == 422


def test_wind_current_goes_through_as_of(client, api, json_ok, mid) -> None:
    """`at=garbage` compared `ts <= 'garbage'` (true for every row) and served
    the 23:00 wind, nine hours past the build; `12:00` without seconds sorted
    before `12:00:00` and got the 11:00 row."""
    default = json_ok(client.get(f"{api}/wind/current"))
    assert json_ok(client.get(f"{api}/wind/current", params={"at": "2099-01-01T00:00:00"})) == default
    assert client.get(f"{api}/wind/current", params={"at": "garbage"}).status_code == 422
    assert json_ok(client.get(f"{api}/wind/current", params={"at": mid[:16]})) == json_ok(
        client.get(f"{api}/wind/current", params={"at": mid})
    )
    assert json_ok(client.get(f"{api}/wind/current", params={"at": mid}))["ts"] <= mid


def test_dispersion_goes_through_as_of(client, api, db) -> None:
    site = db.execute("SELECT id FROM industry_site ORDER BY id LIMIT 1").fetchone()
    if site is None:
        pytest.skip("no industry site")
    r = client.get(f"{api}/wind/dispersion", params={"site_id": site[0], "at": "garbage"})
    assert r.status_code == 422


def test_calibration_age_is_from_at_and_never_mirrored(client, api, json_ok, mid, build_now) -> None:
    """At Aug 12 the NO2 row read "11 d" for an Aug 18 calibration: the age was
    measured from MAX(ts) and taken `abs()`."""
    end = json_ok(client.get(f"{api}/coverage/calibration"))
    assert end["as_of"] == build_now
    served = json_ok(client.get(f"{api}/coverage/calibration", params={"at": mid}))
    assert served["as_of"] == mid
    assert [c["anchored"] for c in served["channels"]] == [c["anchored"] for c in end["channels"]]
    for c in served["channels"]:
        for a in c["anchors"]:
            assert a["last_calibrated"] is None or a["last_calibrated"] <= mid
        if c["last_anchored_at"] is None:
            assert c["age_days"] is None
        else:
            assert c["last_anchored_at"] <= mid and c["age_days"] >= 0
    early = json_ok(client.get(f"{api}/coverage/calibration", params={"at": f"{build_now[:4]}-01-01T00:00:00"}))
    assert all(c["age_days"] is None for c in early["channels"]), "an age for a calibration not yet made"
    assert client.get(f"{api}/coverage/calibration", params={"at": "garbage"}).status_code == 422


# ── writes are stamped with the demo's now ────────────────────────────────────

def test_a_new_report_is_stamped_naive_at_the_build(client, api, json_ok, monkeypatch, build_now) -> None:
    """Posted inside a transaction that is rolled back, so the database the
    demo serves is untouched: `Writer.__exit__` is swapped for a rollback."""
    from air.server import db as air_db

    def rollback(self, exc_type, exc, tb) -> None:
        try:
            self.conn.rollback()
        finally:
            air_db._write_lock.release()

    monkeypatch.setattr(air_db.Writer, "__exit__", rollback)
    near = json_ok(client.get(f"{api}/concerns", params={"limit": 1}))[0]
    lon, lat = near["lon"], near["lat"]
    made = client.post(
        f"{api}/concerns",
        json={"kind": "smell", "title": "test_clock: rolled back", "lon": lon, "lat": lat,
              "occurred_at": "2099-01-01T00:00:00Z"},
    )
    assert made.status_code == 201, made.text[:200]
    body = made.json()
    assert body["created_at"] == build_now and _naive(body["created_at"])
    assert body["occurred_at"] == build_now, "a report cannot occur after the demo's now"
    assert not any(
        c["id"] == body["id"] for c in json_ok(client.get(f"{api}/concerns", params={"limit": 5}))
    ), "the rollback did not hold"
