"""Regenerate tests/fixtures/plume_golden.npz.

Run by hand — `uv run python tests/make_plume_golden.py` — and ONLY when the
truth field is meant to change. `test_plume_kernel_parity.py` asserts the
current `FieldModel._plume` reproduces this file bit for bit; regenerating it
to make a failing test pass would defeat the entire point of P1-B.

REGENERATED ONCE, deliberately, for P3-A and P3-B (2026-09-10). The fixture
before that captured the truth field as it was when the cone was evaluated on a
fixed 4,200 m x 1,450 m window and the isotropic near field inherited that
window's rotated bounding box. Both are gone. Effect on these ten cases:

    case                old sum   new sum   ratio   nonzero cells
    gen_B_calm           0.0533    0.0648    1.22   10,340 -> 35,065
    gen_F_stable         0.0665    0.0891    1.34    9,523 -> 31,436
    stack_F_lofted       0.0424    0.0828    1.95    4,224 -> 15,995
    sub_E                0.0140    0.0205    1.46    7,326 -> 33,067
    offgrid              0.0000    0.0001     n/a        0 -> 65,536

The lofted stack nearly doubles because a lofted plume's mass is far downwind,
exactly where the window was cutting it off. `offgrid` went from literally
nothing to a faint tail: a source 9 km outside the raster still has a plume
over it, and the old window dropped it entirely.

The stand-in below carries exactly the attributes `_plume` reads off `self`
(`X, Y, x0, y0, cell, grid_n`), which is why this does not need a `World`, a
road network or a 110-second datagen run.
"""

from __future__ import annotations

import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from air.datagen.field import FieldModel  # noqa: E402

OUT = pathlib.Path(__file__).parent / "fixtures" / "plume_golden.npz"

GRID_N = 256
SPAN_M = 11_800.0  # the real campaign raster is ~11.8 km across at 256 cells


class Wind:
    """The four fields `_plume` reads off a `WindHour`."""

    def __init__(self, speed_ms: float, stability: str, transport_deg: float, pbl_m: float):
        self.speed_ms = speed_ms
        self.stability = stability
        self.transport_deg = transport_deg
        self.pbl_m = pbl_m


class Raster:
    """The six attributes `_plume` reads off a `FieldModel`."""

    def __init__(self) -> None:
        self.grid_n = GRID_N
        self.cell = SPAN_M / (GRID_N - 1)
        self.x0 = self.y0 = 0.0
        g = np.arange(GRID_N) * self.cell
        self.X, self.Y = np.meshgrid(g, g)

    # `_plume` is the only method under test. It used to also call
    # `self._sigmas`; that is `air.dispersion.sigmas` now, which is why this
    # stand-in no longer borrows it.
    _plume = FieldModel._plume


# (label, height_m, kind, speed_ms, stability, transport_deg, pbl_m, wobble, scale, source x/y)
CASES = [
    ("gen_B_calm",      21.0, "generator",    2.5, "B",  19.0, 1460.0,  3.0, 1.0, 5900.0, 5900.0),
    ("gen_F_stable",    21.0, "generator",    1.5, "F",  19.0,  190.0, -2.0, 1.0, 5900.0, 5900.0),
    ("gen_D_windy",     21.0, "generator",    6.0, "D", 208.0,  610.0,  0.0, 0.8, 5900.0, 5900.0),
    ("stack_F_lofted",  34.0, "stack",        1.5, "F", 270.0,  190.0,  0.0, 1.0, 3000.0, 6000.0),
    ("stack_A_unstable",34.0, "stack",        2.0, "A",  90.0, 1600.0,  4.5, 1.0, 8000.0, 4000.0),
    ("gate_C",           3.0, "traffic_gate", 4.5, "C", 135.0, 1180.0,  0.0, 0.6, 5900.0, 5900.0),
    ("sub_E",            8.0, "substation",   2.0, "E",   0.0,  320.0, -6.0, 0.2, 5900.0, 5900.0),
    ("ct_D_edge",       16.0, "cooling_tower",3.5, "D", 315.0,  610.0,  0.0, 0.5,  400.0,  400.0),
    ("gen_trapped",     21.0, "generator",    0.6, "F",  45.0,   90.0, 12.0, 1.0, 5900.0, 5900.0),
    ("offgrid",         21.0, "generator",    3.0, "D",  19.0,  607.0,  0.0, 1.0, -9000.0, -9000.0),
]


def build() -> dict[str, np.ndarray]:
    r = Raster()
    out: dict[str, np.ndarray] = {}
    for label, h, kind, spd, cls, tdeg, pbl, wob, scale, px, py in CASES:
        acc = np.zeros((GRID_N, GRID_N))
        r._plume(acc, px, py, h, kind, Wind(spd, cls, tdeg, pbl), wob, scale)
        out[label] = acc
    return out


if __name__ == "__main__":
    fields = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(OUT, **fields)
    total = sum(float(v.sum()) for v in fields.values())
    nz = sum(int((v != 0).sum()) for v in fields.values())
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KiB)")
    print(f"{len(fields)} cases, {nz} non-zero cells, checksum sum={total!r}")
