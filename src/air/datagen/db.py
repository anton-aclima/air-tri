"""SQLite plumbing for the datagen pipeline."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable, Sequence
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "src" / "air" / "db" / "schema.sql"
DB_PATH = REPO_ROOT / "data" / "air.db"

# Tables the physical layer owns.  Wiped (in FK-safe order) on every build so the
# build is idempotent; the narrative layer's tables are listed separately.
PHYSICAL_TABLES = [
    # These three were missing from this list, so every rebuild left the previous
    # run's rows in place: 28k orphaned mobile wind observations still pointing at
    # drive ids that no longer existed, and a duplicate set of dispersion studies.
    # Nothing complained, because SQLite only checks a foreign key when the row is
    # written -- the damage was silent and cumulative, and only surfaced once
    # `wipe()` started deferring its checks to commit.
    "mobile_wind_obs",
    "dispersion_model_contour",
    "dispersion_model",
    "vehicle_ping",
    "drive",
    "drive_route",
    "drive_plan",
    "segment_pass",
    "segment_stat",
    "road_segment",
    "monitor_reading",
    "monitor",
    "emission_point",
    "wind",
    "action_level",
    "vehicle",
    "industry_site",
    "campaign",
    "app_user",
    "org",
    "measure_def",
    "setting",
]

# Tables the narrative layer owns.  Also wiped on a --fresh build, because they
# reference campaign / segment ids that are about to be regenerated.
#
# ORDER IS LOAD-BEARING: children before parents.  Foreign keys are enforced on
# this connection, so deleting `concern` while a `site_post` or `mitigation`
# still points at it raises IntegrityError.  That went unnoticed for a long time
# because these tables were only ever nearly empty; the moment the API had
# written a real operator reply against a real concern, `--fresh` stopped
# working.  `wipe()` defers the constraint check as well, so this ordering is
# now belt and braces rather than the only thing holding it up.
NARRATIVE_TABLES = [
    # leaves first
    "alert_ack",
    "alert_sample",
    "concern_corroboration",
    "concern_response",
    "site_post",
    "mitigation",
    "enforcement_action",
    "advisory",
    "notification",
    "activity",
    # then the things they pointed at
    "alert",
    "concern",
    "concern_cluster",
]


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA cache_size = -80000")
    conn.execute("PRAGMA foreign_keys = OFF")  # bulk load order is not FK-friendly
    return conn


def apply_schema(conn: sqlite3.Connection) -> None:
    """Run schema.sql, then check it actually took.

    Every statement in schema.sql is `CREATE TABLE IF NOT EXISTS`, so adding a
    COLUMN to an existing table is a silent no-op against a database that
    already has it. The build then runs for as long as it takes to reach the
    first insert into that table and dies with

        sqlite3.OperationalError: table drive has no column named sampling_mode

    which names the symptom and not the cause, and looks like a code bug rather
    than a stale file. There are no migrations here on purpose — the database
    is generated, so the fix is always to delete it — but the error should say
    so.
    """
    conn.executescript(SCHEMA_PATH.read_text())
    missing = _schema_drift(conn)
    if missing:
        raise SystemExit(
            "this database predates the current schema and SQLite will not add "
            "columns to an existing table:\n"
            + "".join(f"    {t}.{c}\n" for t, c in missing)
            + "\nThe database is generated, so there are no migrations. Delete it "
            "and build again:\n"
            "    rm -f data/air.db data/air.db-wal data/air.db-shm\n"
            "    python3 -m air.datagen.build build --seed 20260827 "
            "--now 2026-08-28T13:54:00\n"
        )


def _schema_drift(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    """Columns schema.sql declares that the live database does not have."""
    import re

    sql = SCHEMA_PATH.read_text()
    live = {
        r[0]: {c[1] for c in conn.execute(f"PRAGMA table_info({r[0]})")}
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    out: list[tuple[str, str]] = []
    for block in re.finditer(
        r"CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\((.*?)\n\);", sql, re.S
    ):
        table, body = block.group(1), block.group(2)
        if table not in live:
            continue
        for line in body.splitlines():
            line = line.strip()
            if not line or line.startswith("--"):
                continue
            name = line.split()[0]
            if name.upper() in {
                "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT", "REFERENCES",
            }:
                continue
            if name not in live[table]:
                out.append((table, name))
    return out


def wipe(conn: sqlite3.Connection, tables: Iterable[str]) -> None:
    """Empty `tables`, tolerating ones that do not exist yet.

    Foreign keys are enforced on this connection, so a naive delete loop is
    order-dependent and fails the moment the data has real cross-references.
    `defer_foreign_keys` holds every check until the transaction commits, by
    which point all of the tables are empty and the graph is consistent again —
    so the caller's ordering stops being the only thing standing between a
    rebuild and an IntegrityError.  It resets itself on commit.
    """
    conn.execute("PRAGMA defer_foreign_keys = ON")
    for t in tables:
        try:
            conn.execute(f"DELETE FROM {t}")
        except sqlite3.OperationalError:
            pass  # table not created yet


def insert_many(conn: sqlite3.Connection, table: str, rows: Sequence[dict]) -> int:
    """Bulk insert dict rows.  All rows must share the first row's key set."""
    rows = list(rows)
    if not rows:
        return 0
    cols = list(rows[0].keys())
    q = f'INSERT OR REPLACE INTO {table} ({",".join(f'"{c}"' for c in cols)}) VALUES ({",".join("?" * len(cols))})'
    conn.executemany(q, [tuple(r[c] for c in cols) for r in rows])
    return len(rows)


def insert_tuples(conn: sqlite3.Connection, table: str, cols: Sequence[str], rows) -> int:
    q = f'INSERT OR REPLACE INTO {table} ({",".join(f'"{c}"' for c in cols)}) VALUES ({",".join("?" * len(cols))})'
    cur = conn.executemany(q, rows)
    return cur.rowcount


def table_counts(conn: sqlite3.Connection) -> dict[str, int]:
    names = [
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]
    out = {}
    for n in names:
        out[n] = conn.execute(f"SELECT COUNT(*) FROM {n}").fetchone()[0]
    return out
