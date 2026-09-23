"""P3-A and P3-B — the truth field exists everywhere, and does not depend on the compass.

Two window bugs lived in `FieldModel._plume`, and neither was visible from
inside it. Both are fixed by removing windows rather than resizing them, and
both regressions would be silent, so they are pinned here.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

import air.dispersion as k
from make_plume_golden import GRID_N, Raster, Wind


@pytest.fixture(scope="module")
def raster():
    return Raster()


def _field(raster, **kw):
    acc = np.zeros((GRID_N, GRID_N))
    raster._plume(acc, kw.pop("px"), kw.pop("py"), kw.pop("height_m"), kw.pop("kind"),
                  Wind(kw.pop("u10"), kw.pop("cls"), kw.pop("transport_deg"), kw.pop("pbl_m")),
                  kw.pop("wob", 0.0), kw.pop("scale", 1.0))
    return acc


# ── P3-A: no downwind window ─────────────────────────────────────────────────

@pytest.mark.parametrize(("cls", "u10", "pbl"), [("B", 2.5, 1460.0), ("D", 3.5, 610.0), ("F", 1.5, 190.0)])
def test_the_plume_exists_beyond_the_old_4200m_window(raster, cls, u10, pbl) -> None:
    """The bug that mattered: 1,007 of 1,307 road segments lie beyond 4,200 m
    from Ridgeline, and the truth field was identically zero for all of them."""
    px = py = 1000.0  # near a corner, so there is a lot of raster downwind
    f = _field(raster, px=px, py=py, height_m=21.0, kind="generator",
               u10=u10, cls=cls, transport_deg=45.0, pbl_m=pbl)
    d = np.hypot(raster.X - px, raster.Y - py)
    far = f[d > 4200.0]
    assert far.size > 1000, "the test raster has no far field to check"
    assert (far > 0).any(), f"nothing beyond 4,200 m under {cls}"
    assert float(far.sum()) > 0.02 * float(f.sum()), (
        f"only {far.sum() / f.sum():.1%} of the plume is beyond 4,200 m under {cls}"
    )


def test_a_source_outside_the_raster_still_reaches_it(raster) -> None:
    f = _field(raster, px=-9000.0, py=-9000.0, height_m=21.0, kind="generator",
               u10=3.0, cls="D", transport_deg=45.0, pbl_m=610.0)
    assert f.any(), "an off-grid source was clipped to nothing"


def test_the_truth_floor_is_far_below_the_draw_floor(raster) -> None:
    """The window was removed because there is no honest window to size.

    `DRAW_FLOOR` answers "is this worth colouring in" and is about 1.95 ppb of
    NO2 once `field.py`'s coupling is applied. `TRUTH_FLOOR` answers "does this
    still contribute" and is about 0.02 ppb. At the latter the plume covers the
    whole 11.8 km raster in every stability class, so a sub-window is the bug
    rather than the optimisation.
    """
    assert k.TRUTH_FLOOR < k.DRAW_FLOOR / 50.0
    for cls, u10, pbl in (("B", 2.5, 1460.0), ("D", 3.5, 610.0), ("F", 1.5, 190.0)):
        r = k.reach([k.Source(21.0, "generator")], u10=u10, cls=cls, pbl_m=pbl,
                    floor=k.TRUTH_FLOOR, max_m=16000.0, step_m=50.0)
        assert r.x_reach > 6000.0, f"{cls}: {r.x_reach:.0f} m — a window might be worth having again"


# ── P3-B: the near field is not a function of the compass ────────────────────

@pytest.mark.parametrize("upwind_m", [200.0, 400.0, 800.0])
def test_an_upwind_fenceline_node_sees_the_same_thing_on_every_wind(raster, upwind_m) -> None:
    """The artefact: the isotropic near-field term inherited the cone's rotated
    bounding box, which has ZERO upwind extent on a cardinal wind and 1,450 m
    on a diagonal one. The comment said the term exists "so an upwind fenceline
    node is not blind"; on a due-north wind it was exactly blind."""
    px = py = 5900.0
    seen = []
    for tdeg in (0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0):
        f = _field(raster, px=px, py=py, height_m=21.0, kind="generator",
                   u10=2.5, cls="D", transport_deg=tdeg, pbl_m=610.0)
        th = math.radians(tdeg)
        ix = int((px - math.sin(th) * upwind_m - raster.x0) / raster.cell)
        iy = int((py - math.cos(th) * upwind_m - raster.y0) / raster.cell)
        seen.append(float(f[iy, ix]))
    lo, hi = min(seen), max(seen)
    assert lo > 0.0, f"an upwind node saw nothing at {upwind_m:.0f} m"
    assert hi / lo < 1.25, (
        f"upwind reading varies {hi / lo:.2f}x with the compass at {upwind_m:.0f} m: "
        f"{[f'{v:.2e}' for v in seen]}"
    )


def test_the_near_field_box_is_wide_enough(raster) -> None:
    """3 * NEAR_SIGMA_M captures the term to e^-4.5; past that it is noise."""
    px = py = 5900.0
    f = _field(raster, px=px, py=py, height_m=3.0, kind="traffic_gate",
               u10=2.5, cls="D", transport_deg=180.0, pbl_m=610.0)
    d = np.hypot(raster.X - px, raster.Y - py)
    # Straight upwind of a ground source, past the box, there is nothing.
    upwind = (raster.Y > py + 3.2 * k.NEAR_SIGMA_M) & (np.abs(raster.X - px) < 100.0)
    assert upwind.any()
    assert float(f[upwind].max()) < float(f[d < 100.0].max()) * 1e-3
