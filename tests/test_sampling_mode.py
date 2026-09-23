"""P3-C — why a car was sent somewhere, recorded once.

Currently inert by design: the planner emits nothing but `uniform`, and will
until the Mission Brief starts dispatching (phase 9). The column and the filter
are installed now because a guard has to exist before the thing it guards
against, and because a rebuild was already happening.

What it guards: targeted driving biases a per-segment median upward by up to
+57%, and 2.66x on the worst near-source case from four passes. Those medians
feed the community headline risk score and the regulator's street ranking, so
without the split the product's headline is a function of the dispatcher.
"""

from __future__ import annotations

import pytest

from air.datagen.stats import uniform_only

pytestmark = pytest.mark.needs_db

MODES = {"uniform", "targeted", "control"}


def test_drive_records_why_it_happened(db) -> None:
    cols = {r[1] for r in db.execute("PRAGMA table_info(drive)")}
    assert "sampling_mode" in cols
    seen = {r[0] for r in db.execute("SELECT DISTINCT sampling_mode FROM drive")}
    assert seen, "no drives in the database"
    assert seen <= MODES, seen
    assert seen == {"uniform"}, (
        f"the planner started dispatching ({seen}) — re-read P3-C and check that "
        "community statistics still use uniform passes only"
    )


def test_every_pass_inherits_its_drive_s_mode(db) -> None:
    cols = {r[1] for r in db.execute("PRAGMA table_info(segment_pass)")}
    assert "sampling_mode" in cols
    mismatched = db.execute(
        """SELECT COUNT(*) FROM segment_pass p JOIN drive d ON d.id = p.drive_id
           WHERE p.sampling_mode <> d.sampling_mode"""
    ).fetchone()[0]
    assert mismatched == 0, f"{mismatched} passes disagree with their drive"


def test_the_check_constraint_is_live() -> None:
    """A typo'd mode must be rejected by the database, not absorbed.

    Built in memory from `schema.sql` rather than poked at the real file: the
    `db` fixture is read-only on purpose, and a test that needs write access to
    the campaign database is a test that can corrupt it.
    """
    import sqlite3

    from air.server import config as air_config

    conn = sqlite3.connect(":memory:")
    conn.executescript(air_config.SCHEMA_PATH.read_text())
    # This test is about the CHECK constraint on `sampling_mode`, not about
    # `campaign` having every NOT NULL column filled in, so the foreign key is
    # switched off rather than satisfied.
    conn.execute("PRAGMA foreign_keys = OFF")
    row = ("x", "cmp", "2026-01-01", "2026-01-01T00:00:00", "complete")
    conn.execute(
        "INSERT INTO drive (id, campaign_id, date, started_at, status, sampling_mode) "
        "VALUES (?,?,?,?,?,'targeted')", row,
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO drive (id, campaign_id, date, started_at, status, sampling_mode) "
            "VALUES ('y',?,?,?,?,'oportunistic')", row[1:],
        )


# ── the filter itself, without a database ────────────────────────────────────

COLS = ("segment_id", "no2", "sampling_mode")
ROWS = [("a", 10.0, "uniform"), ("b", 99.0, "targeted"), ("c", 11.0, "uniform"), ("d", 1.0, "control")]


def test_uniform_only_keeps_only_routine_coverage() -> None:
    assert uniform_only(COLS, ROWS) == [ROWS[0], ROWS[2]]


def test_uniform_only_tolerates_an_older_database() -> None:
    """A database built before the column still aggregates rather than crashing."""
    old_cols = ("segment_id", "no2")
    old_rows = [("a", 10.0), ("b", 99.0)]
    assert uniform_only(old_cols, old_rows) == old_rows


def test_the_community_statistics_actually_call_it() -> None:
    """The filter is worthless if a statistic forgets to apply it."""
    import inspect

    from air.datagen import stats

    for fn in (stats.build_segment_stats, stats.campaign_summary, stats.district_rollup):
        src = inspect.getsource(fn)
        assert "uniform_only(" in src, f"{fn.__name__} does not filter by sampling_mode"
