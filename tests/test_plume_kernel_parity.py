"""P1-B: moving the plume physics into `air.dispersion` changed nothing.

`FieldModel._plume` writes the simulation's ground truth. Every calibrated
constant downstream — K_PT_NO2, the action levels, the aclima_sense
distribution, every number in PLAN-sense.md — was tuned against its output. A
refactor that shifted it by a percent would invalidate all of that silently,
which is the one failure mode a "pure move" refactor actually has.

So the physics was snapshotted BEFORE the move (tests/make_plume_golden.py) and
this asserts bit-for-bit equality after it. `np.array_equal`, not `allclose`:
the claim is that the arithmetic is the same arithmetic, and a tolerance would
hide exactly the kind of reordering that is not.

The window fix (P3-A) and the near-field fix (P3-B) are deliberately held back
to phase 3 so that this step is provably a no-op. When they land, regenerate
the fixture in the same commit and say so.
"""

from __future__ import annotations

import pathlib

import numpy as np
import pytest

# pytest's default import mode puts `tests/` on sys.path, so the generator's
# case list is importable here — the test and the fixture cannot drift.
from make_plume_golden import CASES, Raster, Wind

GOLDEN = pathlib.Path(__file__).parent / "fixtures" / "plume_golden.npz"


@pytest.fixture(scope="module")
def golden():
    if not GOLDEN.exists():
        pytest.skip(f"no fixture at {GOLDEN} — run `uv run python tests/make_plume_golden.py`")
    with np.load(GOLDEN) as z:
        return {k: z[k] for k in z.files}


def test_every_case_is_still_in_the_fixture(golden) -> None:
    assert set(golden) == {c[0] for c in CASES}, (
        "the case list and the fixture disagree — regenerate the fixture deliberately"
    )


@pytest.mark.parametrize("case", CASES, ids=lambda c: c[0])
def test_plume_is_bit_identical(golden, case) -> None:
    label, h, kind, spd, cls, tdeg, pbl, wob, scale, px, py = case
    r = Raster()
    acc = np.zeros((r.grid_n, r.grid_n))
    r._plume(acc, px, py, h, kind, Wind(spd, cls, tdeg, pbl), wob, scale)

    want = golden[label]
    if np.array_equal(acc, want):
        return
    diff = np.abs(acc - want)
    bad = int((diff > 0).sum())
    pytest.fail(
        f"{label}: {bad} of {diff.size} cells changed, max |delta| {diff.max():.6e}, "
        f"sum {acc.sum():.12e} vs {want.sum():.12e}"
    )


def test_an_off_grid_source_contributes_a_faint_tail(golden) -> None:
    """A source outside the raster still has a plume over it (P3-A).

    This test used to assert the opposite, because the old sub-window clipped
    a source 9 km off-grid to literally nothing. That was the same bug as the
    4,200 m window, seen from the other side: a plume does not stop existing at
    the edge of the array you happened to allocate. It should be faint — four
    orders of magnitude under a source sitting in the middle of the raster —
    but not absent.
    """
    far = golden["offgrid"]
    near = golden["gen_D_windy"]
    assert far.any(), "an off-grid source was clipped to zero again"
    assert far.sum() < near.sum() / 100.0, (far.sum(), near.sum())


def test_a_lofted_stack_leaves_the_near_field_alone(golden) -> None:
    """Physics sanity, not just parity: under F a 34 m stack does not touch down.

    What reaches the ground within a few hundred metres is the isotropic
    near-field term, not the cone — so the peak sits at the source and is small.
    This is the behaviour `lofted` reports in P1-C, asserted here on the truth
    field so the kernel and the drawn cone cannot disagree about it later.
    """
    f = golden["stack_F_lofted"]
    assert f.max() > 0
    r = Raster()
    peak = np.unravel_index(int(np.argmax(f)), f.shape)
    px, py = 3000.0, 6000.0
    d = float(np.hypot(r.X[peak] - px, r.Y[peak] - py))
    assert d < 400.0, f"expected the near-field term to dominate, peak was {d:.0f} m out"
