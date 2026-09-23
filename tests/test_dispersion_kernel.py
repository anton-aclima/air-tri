"""`air.dispersion` — the one copy of the plume arithmetic.

Two jobs. First, containment: the kernel is shared by the generator and the
server precisely so the truth field and the drawn cone cannot disagree, which
means it must not depend on either of them (CONTRACT section 10d). Second, the
physics that the drawn cone now inherits — reach that moves with stability, a
lofted plume whose worst ground impact is kilometres downwind, and bands that
are contours rather than radial slices.
"""

from __future__ import annotations

import ast
import pathlib
import subprocess
import sys

import numpy as np
import pytest

import air.dispersion as k

KERNEL = pathlib.Path(k.__file__)
SITE = [k.Source(21.0, "generator")] * 6 + [
    k.Source(12.0, "backup"),
    k.Source(12.0, "backup"),
    k.Source(16.0, "cooling_tower"),
    k.Source(16.0, "cooling_tower"),
    k.Source(16.0, "cooling_tower"),
    k.Source(8.0, "substation"),
    k.Source(3.0, "traffic_gate"),
]
REGIMES = [("B", 2.5, 1460.0), ("C", 4.5, 1180.0), ("D", 3.5, 610.0),
           ("E", 2.0, 320.0), ("F", 1.5, 190.0)]


# ── containment ──────────────────────────────────────────────────────────────

def test_the_kernel_imports_neither_datagen_nor_server() -> None:
    """Statically, so a lazy import inside a function does not slip through."""
    tree = ast.parse(KERNEL.read_text(), filename=str(KERNEL))
    imported: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.append(node.module)
    banned = [m for m in imported if m.split(".")[0:2] in (["air", "datagen"], ["air", "server"])]
    assert not banned, (
        f"air.dispersion must not import {banned} — it is shared BY those packages. "
        "See CONTRACT section 10d."
    )


def test_the_kernel_imports_in_isolation() -> None:
    """And dynamically: a fresh interpreter that can only see `src`."""
    code = (
        "import sys; sys.path.insert(0, %r);"
        "import air.dispersion;"
        "bad=[m for m in sys.modules if m.startswith(('air.datagen','air.server'))];"
        "print(bad)" % str(KERNEL.parents[2])
    )
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr[-800:]
    assert r.stdout.strip() == "[]", f"importing the kernel dragged in {r.stdout.strip()}"


# ── Pasquill coercion (P1-D) ─────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("cls", "u10", "want"),
    [
        ("F", 1.5, "F"), ("F", 2.9, "F"), ("E", 3.69, "E"), ("A", 2.96, "A"),
        ("B", 5.32, "B"), ("C", 9.83, "C"), ("D", 20.0, "D"),
        # Cascading: F is undefined above 3, and so is E above 4.5, so a
        # fabricated "F at 6 m/s" lands at D rather than stopping at E.
        ("F", 6.0, "D"), ("E", 6.0, "D"), ("A", 8.0, "C"),
    ],
)
def test_coercion_steps_toward_neutral(cls: str, u10: float, want: str) -> None:
    got, note = k.coerce_class(cls, u10)
    assert got == want
    assert (note is None) == (got == cls)


def test_an_unknown_class_becomes_neutral_and_says_so() -> None:
    got, note = k.coerce_class("Z", 3.0)
    assert got == "D" and note and "Z" in note


def test_coercion_never_fires_on_this_campaign(db) -> None:
    """P1-D's actual point. "F at 6 m/s" was quoted as a measured finding in
    four design documents; it does not occur. If this ever fails, the weather
    generator changed and every narrative built on the guard needs rereading.
    """
    rows = db.execute("SELECT stability, speed_ms FROM wind").fetchall()
    assert rows
    coerced = [(r[0], r[1]) for r in rows if k.coerce_class(r[0], max(0.4, r[1]))[1]]
    assert not coerced, f"{len(coerced)} wind rows need coercion, e.g. {coerced[:3]}"


test_coercion_never_fires_on_this_campaign = pytest.mark.needs_db(
    test_coercion_never_fires_on_this_campaign
)


# ── reach ────────────────────────────────────────────────────────────────────

def test_reach_grows_monotonically_with_stability() -> None:
    """The headline fix. The old endpoint spanned 3x from A to F; the physics
    spans far more, and that difference IS the tiny blob."""
    got = [k.reach(SITE, u10=2.5, cls=c, pbl_m=p).x_reach for c, p in
           (("A", 1600.0), ("B", 1460.0), ("C", 1180.0), ("D", 610.0), ("E", 320.0), ("F", 190.0))]
    assert got == sorted(got), f"reach must not shrink as air stabilises: {got}"
    assert got[-1] / got[0] > 5.0, f"only {got[-1] / got[0]:.1f}x across A to F: {got}"


def test_reach_grows_with_how_much_is_emitted() -> None:
    """`STRENGTH` and source count must both move it, or a substation draws
    the same cone as six 14.6 MW turbine banks."""
    one = k.reach([k.Source(21.0, "generator")], u10=2.5, cls="D", pbl_m=610.0)
    six = k.reach([k.Source(21.0, "generator")] * 6, u10=2.5, cls="D", pbl_m=610.0)
    weak = k.reach([k.Source(21.0, "generator", strength=0.2)], u10=2.5, cls="D", pbl_m=610.0)
    assert weak.x_reach < one.x_reach < six.x_reach


def test_no_sources_is_faint_not_a_crash() -> None:
    r = k.reach([], u10=2.5, cls="D", pbl_m=610.0)
    assert r.faint and r.x_reach == 0.0
    assert k.bands(r, [], u10=2.5, cls="D", pbl_m=610.0) == []


def test_a_ground_level_release_is_never_lofted() -> None:
    for cls, u10, pbl in REGIMES:
        r = k.reach([k.Source(3.0, "traffic_gate")], u10=u10, cls=cls, pbl_m=pbl)
        assert not r.lofted, f"a 3 m traffic gate came back lofted under {cls}"


def test_a_stack_is_lofted_and_touches_down_further_out_in_stable_air() -> None:
    stack = [k.Source(34.0, "stack")]
    calm = k.reach(stack, u10=2.5, cls="B", pbl_m=1460.0)
    still = k.reach(stack, u10=1.5, cls="F", pbl_m=190.0)
    assert calm.lofted and still.lofted
    assert still.x_peak > calm.x_peak, (
        f"stable air must carry the touchdown further: {calm.x_peak} -> {still.x_peak}"
    )


def test_loftedness_does_not_move_with_the_draw_floor() -> None:
    """It is a shape property. Tying it to `DRAW_FLOOR` made Delta Forge's two
    34 m stacks come back aloft in daytime B for no physical reason."""
    src = [k.Source(34.0, "stack")]
    at = [k.reach(src, u10=2.5, cls="B", pbl_m=1460.0, floor=f).lofted
          for f in (1e-7, 1e-6, 1e-5, 1e-4)]
    assert len(set(at)) == 1, f"lofted flipped with the floor: {at}"


# ── bands ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(("cls", "u10", "pbl"), REGIMES)
def test_bands_are_ordered_contours_covering_the_drawn_extent(cls, u10, pbl) -> None:
    r = k.reach(SITE, u10=u10, cls=cls, pbl_m=pbl)
    b = k.bands(r, SITE, u10=u10, cls=cls, pbl_m=pbl)
    assert b, f"no bands under {cls}"
    assert b[0][1] == r.x_onset and b[-1][2] == pytest.approx(r.x_reach)
    for i in range(len(b) - 1):
        assert b[i][2] <= b[i + 1][1] + 1e-9, "bands overlap"
        assert b[i][3] > b[i + 1][3], "level must fall strictly outward"
    assert all(0.0 < lv <= 1.0 for _i, _a, _b, lv in b)


def test_bands_survive_a_trapped_profile() -> None:
    """`np.maximum(vert, trapped)` steps the profile UP where sigma_z outgrows
    the mixed layer, so a band labelled by its MEAN came out brighter than the
    band inside it. Labelling by the contour fixed it; this is the case."""
    b = k.bands(
        k.reach([k.Source(21.0, "generator")], u10=0.6, cls="D", pbl_m=90.0),
        [k.Source(21.0, "generator")], u10=0.6, cls="D", pbl_m=90.0,
    )
    levels = [lv for _i, _a, _b, lv in b]
    assert levels == sorted(levels, reverse=True), levels


# ── the profile itself ───────────────────────────────────────────────────────

def test_sources_add() -> None:
    xs = np.arange(0.0, 4000.0, 50.0)
    a = k.profile(xs, [k.Source(21.0, "generator")], u10=2.5, cls="D", pbl_m=610.0)
    b = k.profile(xs, [k.Source(3.0, "traffic_gate")], u10=2.5, cls="D", pbl_m=610.0)
    both = k.profile(
        xs, [k.Source(21.0, "generator"), k.Source(3.0, "traffic_gate")],
        u10=2.5, cls="D", pbl_m=610.0,
    )
    assert np.allclose(both, a + b)


def test_the_axis_profile_excludes_the_near_field_term() -> None:
    """The campus near field is a separate area source. Folding it into the
    cone would put a bright band at the stack of every lofted plume — the
    exact artefact P1-C removes."""
    at_source = float(k.ground_axis(
        np.array([0.0]), height_m=34.0, kind="stack", u10=1.5, cls="F", pbl_m=190.0)[0])
    assert at_source < k.NEAR_Q * 1e-2, (
        "ground_axis is carrying the near-field term; it must not"
    )


# ── the sector gate ──────────────────────────────────────────────────────────

def test_point_in_cone_respects_the_axis_and_the_window() -> None:
    kw = dict(x_min=100.0, x_max=3000.0, cls="D", u10=3.0)
    # Transport due north: 1 km north is in, 1 km south is not.
    assert k.point_in_cone(0.0, 1000.0, 0.0, **kw)
    assert not k.point_in_cone(0.0, -1000.0, 0.0, **kw)
    # Outside the downwind window either way.
    assert not k.point_in_cone(0.0, 50.0, 0.0, **kw)
    assert not k.point_in_cone(0.0, 5000.0, 0.0, **kw)


def test_the_sector_narrows_with_stability() -> None:
    wide = k.half_width(2000.0, "A", 3.0)
    tight = k.half_width(2000.0, "F", 3.0)
    assert tight < wide / 3.0, f"A {wide:.0f} m vs F {tight:.0f} m is not much of a difference"
    off_axis = 0.5 * (float(wide) + float(tight))
    assert k.point_in_cone(off_axis, 2000.0, 0.0, x_min=0.0, x_max=4000.0, cls="A", u10=3.0)
    assert not k.point_in_cone(off_axis, 2000.0, 0.0, x_min=0.0, x_max=4000.0, cls="F", u10=3.0)
