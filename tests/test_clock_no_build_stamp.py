"""The one clock on a database WITHOUT `setting('datagen.now')`.

A half-built database or the smoke-test fixture (data/air_smoketest.db) has no
build stamp. The server's clock then had two fallbacks: writes were stamped with
the wall clock (in UTC digits, labelled as Chicago time) while reads were bounded
by `domain.data_now`, which fell back to the newest row. Measured on the
smoke-test database: a new report was stamped 2026-09-24T02:23:52 against a read
bound of 2026-08-27T23:10:49, so `/concerns`, `/feed` and `/stats/community`
never showed it, and bootstrap's `generated_at` was null, so the client took its
clock's end from the wall clock while the server served Aug 27.

Now there is ONE fallback, in `timeutil`: the newest monitor reading or segment
pass. These tests build a throwaway database from schema.sql in a temp
directory, so they need no data/air.db and run on a fresh clone. The app is
driven without its lifespan (a bare TestClient), because the lifespan's
`ensure_db` would otherwise create an empty data/air.db before the path is
swapped — which would turn every `needs_db` skip on a fresh clone into a
failure.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from air.server import cache, config, timeutil
from air.server import db as air_db

CAMPAIGN = "cmp-no-build-stamp"
NEWEST_READING = "2026-08-27T23:00:00"
NEWEST_PASS = "2026-08-27T23:10:49"  # the later of the two: the fallback


def _build(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(config.SCHEMA_PATH.read_text())
        conn.execute(
            """INSERT INTO campaign (id, slug, name, center_lon, center_lat, boundary_geojson,
                                     start_date, end_date, status, created_at)
               VALUES (?, 'no-stamp', 'No build stamp', -90.05, 35.05,
                       '{"type":"FeatureCollection","features":[]}',
                       '2026-08-01', '2026-08-27', 'active', '2026-08-01T00:00:00')""",
            (CAMPAIGN,),
        )
        conn.execute(
            """INSERT INTO monitor (id, campaign_id, name, owner_type, lon, lat, grade, status, measures_json)
               VALUES ('mon-x', ?, 'Tower', 'regulator', -90.05, 35.05, 'reference', 'online', '["no2"]')""",
            (CAMPAIGN,),
        )
        for ts in ("2026-08-27T21:00:00", NEWEST_READING):
            conn.execute(
                "INSERT INTO monitor_reading (monitor_id, ts, measure, value) VALUES ('mon-x', ?, 'no2', 9.0)",
                (ts,),
            )
        conn.execute(
            """INSERT INTO road_segment (id, campaign_id, name, district, geometry_json, length_m,
                                         mid_lon, mid_lat)
               VALUES ('seg-x', ?, 'Test Road', 'Boxtown', '[[-90.051,35.05],[-90.049,35.05]]',
                       180.0, -90.05, 35.05)""",
            (CAMPAIGN,),
        )
        for ts in ("2026-08-27T20:00:00", NEWEST_PASS):
            conn.execute(
                "INSERT INTO segment_pass (campaign_id, segment_id, ts) VALUES (?, 'seg-x', ?)",
                (CAMPAIGN, ts),
            )
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM setting WHERE key='datagen.now'").fetchone()[0] == 0
    finally:
        conn.close()


@pytest.fixture
def no_stamp_db(tmp_path, monkeypatch):
    path = tmp_path / "no_stamp.db"
    _build(path)
    monkeypatch.setattr(config, "DB_PATH", path)
    # The write connection is a module-level singleton on the REAL database;
    # swap in a fresh slot so a write here opens the temp one.
    monkeypatch.setattr(air_db, "_write_conn", None)
    monkeypatch.setattr(air_db, "_ensured", False)
    cache.invalidate()  # timeutil re-reads its stamp per cache version
    try:
        yield path
    finally:
        if air_db._write_conn is not None:
            air_db._write_conn.close()
        monkeypatch.undo()
        cache.invalidate()  # and back to the real database's stamp


def test_now_falls_back_to_the_newest_reading_or_pass(no_stamp_db) -> None:
    assert timeutil.now_iso() == NEWEST_PASS


def test_reads_and_writes_share_the_fallback(no_stamp_db) -> None:
    from fastapi.testclient import TestClient

    from air.server.app import app

    api = config.API_PREFIX
    client = TestClient(app)  # no `with`: no lifespan, see the module docstring

    flags = client.get(f"{api}/bootstrap").json()["flags"]
    assert flags["now"] == NEWEST_PASS
    assert flags["generated_at"] == NEWEST_PASS, "the client's clock would end somewhere else"

    made = client.post(
        f"{api}/concerns",
        json={"kind": "smell", "title": "no build stamp", "lon": -90.05, "lat": 35.05},
    )
    assert made.status_code == 201, made.text[:200]
    body = made.json()
    assert body["created_at"] == NEWEST_PASS, "a write stamped by a different clock than the reads"

    listed = client.get(f"{api}/concerns").json()
    assert [c["id"] for c in listed] == [body["id"]], "a report filed live is missing from the list"
    feed = client.get(f"{api}/feed", params={"role": "community", "include_readings": False}).json()
    assert body["id"] in {i["concern"]["id"] for i in feed if i["type"] == "concern"}
    stats = client.get(f"{api}/stats/community").json()
    assert stats["concern_count_7d"] == 1
