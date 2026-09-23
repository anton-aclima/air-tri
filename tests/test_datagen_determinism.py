"""The generator must reproduce itself given `--seed` and `--now`.

Everything downstream of phase 1 is "freeze the seed, change one thing,
diff" — the phase-2 parameter sweep, the phase-2 multi-seed check, the
phase-3 re-tune. All of it assumes a fixed build is a fixed number.

It was not. `FieldModel` derived each methane leak's duty offset from
`abs(hash(leak_id))`, and Python randomises `hash()` on str per process, so
two builds of the same seed at the same `--now` differed in ch4 — and only in
ch4, because leaks were the only thing that hashed an id. Measured before the
fix: SUM(ch4) 109821.0891 vs 109802.3856 across two runs, 2,777 differing
segment_stat rows, every other measure identical to the last digit.

A full rebuild is 113 seconds, which is too slow to assert here. These tests
pin the mechanism instead: the spreader is a pure function of the string, and
no module reaches for `hash()` on anything but an int.
"""

from __future__ import annotations

import ast
import pathlib
import subprocess
import sys

import pytest

from air.datagen.field import _stable_idx
from air.datagen.world import LEAKS

SRC = pathlib.Path(__file__).resolve().parents[1] / "src" / "air"

# Frozen. If a leak id changes these move with it — that is fine and expected.
# If they move WITHOUT an id changing, reproducibility has broken again.
EXPECTED = {
    "leak-boxtown-main": 381,
    "leak-ridgeline-skid": 100,
    "leak-riverport-cng": 151,
    "leak-channel-fill": 590,
    "leak-westwood-vent": 921,
}


def test_the_spreader_is_frozen() -> None:
    assert {lk.id: _stable_idx(lk.id) for lk in LEAKS} == EXPECTED


def test_the_spreader_survives_a_different_hash_seed() -> None:
    """The actual regression: a fresh interpreter with a different PYTHONHASHSEED.

    `hash("leak-boxtown-main")` differs between these two runs; `_stable_idx`
    must not.
    """
    code = (
        "import sys; sys.path.insert(0, %r);"
        "from air.datagen.field import _stable_idx;"
        "print([_stable_idx(k) for k in %r])" % (str(SRC.parent), sorted(EXPECTED))
    )
    seen = set()
    for hashseed in ("0", "1", "12345"):
        env = {"PYTHONHASHSEED": hashseed, "PATH": "/usr/bin:/bin"}
        r = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=60
        )
        assert r.returncode == 0, r.stderr[-500:]
        seen.add(r.stdout.strip())
    assert len(seen) == 1, f"the spreader moved with PYTHONHASHSEED: {seen}"


def test_no_module_hashes_a_string() -> None:
    """`hash()` on anything but an int is a reproducibility bug waiting to happen.

    Python randomises str, bytes and datetime hashing per process. int, float
    and tuple-of-int hashing is stable, so this only rejects the dangerous
    shapes — and rejects an unresolvable argument rather than guessing.
    """
    offenders: list[str] = []
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
                continue
            if node.func.id != "hash" or not node.args:
                continue
            arg = node.args[0]
            safe = isinstance(arg, ast.Constant) and isinstance(arg.value, (int, float))
            if not safe:
                rel = path.relative_to(SRC.parent)
                offenders.append(f"{rel}:{node.lineno}")
    assert not offenders, (
        "hash() on a non-numeric value is randomised per process — use "
        f"air.datagen.field._stable_idx or zlib.crc32 instead: {offenders}"
    )


@pytest.mark.needs_db
def test_the_checked_in_build_is_pinned(pinned_build, db) -> None:
    """The build on disk should be the reproducible one, so diffs mean something."""
    seed = db.execute("SELECT value FROM setting WHERE key='datagen.seed'").fetchone()
    assert seed and seed[0] == "20260827", "unexpected seed in data/air.db"
    assert pinned_build, (
        "data/air.db was built without the --now pinned in CLAUDE.md; rebuild before "
        "comparing any number to one written down earlier"
    )
