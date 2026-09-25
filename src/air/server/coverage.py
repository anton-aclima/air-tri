"""Do the regulator's instruments stand where the plume goes?

THE REGULATOR'S QUESTION, answered from this campaign's own record rather than
from a siting rule of thumb. Three things, all built on `plumegeom` — the
outline `/wind/dispersion?outline=1` draws — so they cannot disagree with the
plume anyone else is looking at:

    interception()       how often each fixed instrument stands inside a
                         modelled plume, over the whole record
    residency()          per road segment, how many plume-hours crossed it —
                         and how many of those NO instrument observed
    siting_candidates()  the streets carrying the most unobserved plume-hours

WHAT THIS IS NOT
----------------
It is not a recommendation about where to put an instrument. Siting involves
land access, power, security and network-design rules this product knows
nothing about, and telling a public agency where to place a regulatory monitor
is the closest this whole system comes to giving regulatory advice. Every row
`siting_candidates` returns is phrased as "these streets carry the most
unobserved plume-hours in this record" and never as "put your tower here" — the
ranking is an observation about the record, and the decision is theirs.

ONE GEOMETRY (R0, docs/PLAN-refocus.md section 3.3)
---------------------------------------------------
This module used to test one sigma_y wedge from each site's emission-weighted
centroid (`air.dispersion.cone_mask`) on weather rounded for a cache. The map
draws the union of every release point's wedge. Near a spread-out site the two
disagree: Riverport Road, 424 m from Riverport Intermodal, was inside the drawn
outline in 15 of its 17 watch-level NO2 hours and outside this module's wedge
in 12 of those 15, because the monitor sits directly downwind of the stack and
134 m crosswind of the centroid. Every count here now comes from the drawn
outline, hour by hour (`plumegeom.SitePlume.locate_polar`), and each instrument
carries its hours split by part: `inside` the detection envelope, and `beyond`
it, where CONTRACT 10b says nothing is judged.

EVERYTHING HERE IS MODELLED
---------------------------
"Inside a plume" means inside a MODELLED outline from `air.dispersion`. Nobody
measured the air at these towers and compared it to anything. Per CONTRACT
section 10a the word `modelled` travels with every number this module returns,
and the model tier is named on screen beside the verdict — which is why
`Interception` carries `basis` rather than leaving the caller to remember.

A NOTE ON A NUMBER THAT NO LONGER EXISTS
----------------------------------------
Earlier design work quoted a 20.1% interception rate. That figure came from the
`base_reach = (700 + 240 * speed) * reach_mult` formula which phase 1 deleted —
it ignored source strength, spanned 3x across Pasquill A to F where the physics
spans about 40x, and put the brightest band at the stack. Any screen built on
it would have shipped pre-invalidated. Every figure here is recomputed from the
current kernel; if you find 20.1% written down anywhere, it is stale.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field

import numpy as np

from air.server import plumegeom, timeutil

#: Stability classes treated as the stable regime, for the split reporting.
STABLE_CLASSES = "EF"

#: A segment needs this many plume-hours before it can be a siting candidate.
#: Ranking a street that caught the plume twice is ranking noise.
MIN_PLUME_HOURS = 20


@dataclass(frozen=True)
class InstrumentCoverage:
    monitor_id: str
    name: str
    owner_type: str
    grade: str | None
    status: str
    lon: float
    lat: float
    measures: list[str]
    n_hours: int
    #: Hours this instrument stood inside ANY site's modelled plume.
    hours_in_plume: int
    share: float
    #: The same, restricted to stable air.
    hours_in_plume_stable: int
    share_stable: float
    #: Which sites' plumes ever reached it, and how often (either part).
    by_site: dict[str, int] = field(default_factory=dict)
    #: The same hours split by the part of the outline the instrument stood
    #: in. `beyond` is past the detection envelope: CONTRACT 10b, model only,
    #: nothing judged from it — and the part a 6 km-away site reaches it with.
    hours_in_plume_inside: int = 0
    share_inside: float = 0.0
    by_site_inside: dict[str, int] = field(default_factory=dict)
    by_site_beyond: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class Interception:
    campaign_id: str
    n_hours: int
    #: What the cone came from. Named on screen beside the verdict.
    basis: str
    instruments: list[InstrumentCoverage] = field(default_factory=list)

    @property
    def reference(self) -> list[InstrumentCoverage]:
        return [i for i in self.instruments if i.grade == "reference"]


@dataclass(frozen=True)
class SegmentResidency:
    segment_id: str
    name: str | None
    district: str | None
    lon: float
    lat: float
    length_m: float
    #: Hours any site's modelled plume crossed this segment.
    plume_hours: int
    #: Of those, the hours when NO fixed instrument stood in a plume.
    unobserved_hours: int
    unobserved_share: float


# ── geometry ─────────────────────────────────────────────────────────────────


class _World:
    """Sites, instruments, road segments and weather, projected once.

    Receptors are held as (distance, bearing) FROM each site's plume origin —
    the axis's first vertex, which does not move from hour to hour — so an
    hour's membership test is the frame rotation and two interpolations.
    """

    def __init__(self, conn: sqlite3.Connection, campaign_id: str):
        self.campaign_id = campaign_id

        #: site_id -> release points, in `plumegeom`'s total order.
        self.points = plumegeom.load_points(conn, campaign_id)
        #: site_id -> the plume origin `/wind/dispersion` draws the axis from.
        self.sites = {sid: plumegeom.origin_of(pts) for sid, pts in self.points.items()}

        mons = conn.execute(
            "SELECT id, name, owner_type, grade, status, lon, lat, measures_json "
            "FROM monitor WHERE campaign_id = ? ORDER BY grade, name",
            (campaign_id,),
        ).fetchall()
        self.monitors = [dict(zip(
            ("id", "name", "owner_type", "grade", "status", "lon", "lat", "measures_json"),
            m, strict=True,
        )) for m in mons]
        self.mon_lon = np.array([m["lon"] for m in self.monitors], dtype=float)
        self.mon_lat = np.array([m["lat"] for m in self.monitors], dtype=float)

        segs = conn.execute(
            "SELECT id, name, district, mid_lon, mid_lat, length_m FROM road_segment "
            "WHERE campaign_id = ? ORDER BY id",
            (campaign_id,),
        ).fetchall()
        self.seg_ids = [s[0] for s in segs]
        self.seg_name = [s[1] for s in segs]
        self.seg_district = [s[2] for s in segs]
        self.seg_lon = np.array([s[3] for s in segs], dtype=float)
        self.seg_lat = np.array([s[4] for s in segs], dtype=float)
        self.seg_len = np.array([s[5] or 200.0 for s in segs])

        # Only the hours that had happened by the demo's now. The wind is
        # generated to the end of the build day (23:00 on Aug 28, ten hours
        # past `datagen.now`), and `/wind/dispersion` clamps `at` to now, so
        # those ten hours were counted here and could never be drawn — the
        # only hours where the two surfaces disagreed once they shared a shape.
        wind = conn.execute(
            "SELECT ts, speed_ms, dir_deg, stability, pbl_m FROM wind "
            "WHERE campaign_id = ? AND ts <= ? ORDER BY ts",
            (campaign_id, timeutil.now_iso()),
        ).fetchall()
        cols = ("ts", "speed_ms", "dir_deg", "stability", "pbl_m")
        #: Exactly the inputs the router reads — the coerced class, the exact
        #: wind and mixing height. Rounding them for a cache was one of the
        #: ways this module stopped drawing the same plume as the map.
        self.weather = [plumegeom.weather(dict(zip(cols, r, strict=True))) for r in wind]
        self.ts = [w.ts for w in self.weather]
        self.stable = np.array([w.cls in STABLE_CLASSES for w in self.weather], dtype=bool)

        self.mon_polar = {
            sid: plumegeom.polar_from(o, self.mon_lon, self.mon_lat) for sid, o in self.sites.items()
        }
        self.seg_polar = {
            sid: plumegeom.polar_from(o, self.seg_lon, self.seg_lat) for sid, o in self.sites.items()
        }
        self._plumes: list[dict[str, plumegeom.SitePlume]] | None = None

    def plumes(self) -> list[dict[str, plumegeom.SitePlume]]:
        """Every hour's drawn plumes, built once per world. ~2 s for 2,160
        hours x 3 sites on the pinned build, behind the cache."""
        if self._plumes is None:
            self._plumes = [plumegeom.plumes_at(self.points, w) for w in self.weather]
        return self._plumes


#: signature -> world. Not in `cache`: every write (a report, an
#: acknowledgement, a slider move) clears that whole store, and rebuilding the
#: 2,150 hourly outlines costs ~2 s, although nothing a write can touch goes
#: into them. The signature covers everything that does — the wind, the ACTIVE
#: release points (`sim.generator_test` switches some on), the monitors, the
#: segments, the build instant and the database file — so a reseed or a sim
#: that changes the geometry still gets a new world.
_WORLDS: dict[tuple, _World] = {}
_WORLDS_MAX = 2


def _signature(conn: sqlite3.Connection, campaign_id: str) -> tuple:
    db = conn.execute("PRAGMA database_list").fetchone()
    r = conn.execute(
        """SELECT
             (SELECT COUNT(*) || ':' || IFNULL(SUM(speed_ms + dir_deg), 0) || ':' || IFNULL(MAX(ts), '')
                FROM wind WHERE campaign_id = ?1),
             (SELECT COUNT(*) || ':' || IFNULL(SUM(e.lon + e.lat + IFNULL(e.height_m, 0)), 0)
                FROM emission_point e JOIN industry_site s ON s.id = e.site_id
               WHERE s.campaign_id = ?1 AND e.active = 1),
             (SELECT COUNT(*) || ':' || IFNULL(SUM(lon + lat), 0) FROM monitor WHERE campaign_id = ?1),
             (SELECT COUNT(*) FROM road_segment WHERE campaign_id = ?1)""",
        (campaign_id,),
    ).fetchone()
    return (str(db[2]) if db else "", campaign_id, timeutil.now_iso(), *r)


def load(conn: sqlite3.Connection, campaign_id: str) -> _World:
    sig = _signature(conn, campaign_id)
    hit = _WORLDS.get(sig)
    if hit is not None:
        return hit
    world = _World(conn, campaign_id)
    while len(_WORLDS) >= _WORLDS_MAX:
        _WORLDS.pop(next(iter(_WORLDS)))
    _WORLDS[sig] = world
    return world


# ── the three answers ────────────────────────────────────────────────────────


def _hourly_masks(w: _World, polar_by_site: dict, n_receptors: int):
    """Yield (hour index, merged mask, {site: part codes}) for every hour.

    Part codes are `plumegeom.OUTSIDE / INSIDE / BEYOND` per receptor, from
    the outline the map draws. One pass, shared by `interception`,
    `residency` and `concession`, so they can never disagree about which hours
    had a plume anywhere. `merged` is either part of any site's outline, OR'd
    across sites: a receptor standing in Ridgeline's plume is in *a* plume,
    and counting it three times because three sites exist would be an
    artefact of how many sites the campaign happens to have.
    """
    for h, by_site in enumerate(w.plumes()):
        merged = np.zeros(n_receptors, dtype=bool)
        per_site: dict[str, np.ndarray] = {}
        for sid, sp in by_site.items():
            d, b = polar_by_site[sid]
            codes = sp.locate_polar(d, b)
            per_site[sid] = codes
            merged |= codes > 0
        yield h, merged, per_site


def interception(conn: sqlite3.Connection, campaign_id: str) -> Interception:
    """How often each fixed instrument stands inside a modelled plume."""
    w = load(conn, campaign_id)
    n = len(w.monitors)
    if n == 0 or not w.sites:
        return Interception(campaign_id, len(w.ts), _BASIS, [])

    hits = np.zeros(n, dtype=int)
    hits_stable = np.zeros(n, dtype=int)
    hits_inside = np.zeros(n, dtype=int)
    by_site = [{sid: 0 for sid in w.sites} for _ in range(n)]
    by_inside = [{sid: 0 for sid in w.sites} for _ in range(n)]
    by_beyond = [{sid: 0 for sid in w.sites} for _ in range(n)]
    for h, merged, per_site in _hourly_masks(w, w.mon_polar, n):
        hits += merged
        if w.stable[h]:
            hits_stable += merged
        inside_any = np.zeros(n, dtype=bool)
        for sid, codes in per_site.items():
            inside_any |= codes == plumegeom.INSIDE
            for i in np.flatnonzero(codes):
                by_site[i][sid] += 1
                if codes[i] == plumegeom.INSIDE:
                    by_inside[i][sid] += 1
                else:
                    by_beyond[i][sid] += 1
        hits_inside += inside_any

    import json as _json

    n_hours = len(w.ts)
    n_stable = int(w.stable.sum())
    out = [
        InstrumentCoverage(
            monitor_id=m["id"], name=m["name"], owner_type=m["owner_type"],
            grade=m["grade"], status=m["status"], lon=m["lon"], lat=m["lat"],
            measures=_json.loads(m["measures_json"] or "[]"),
            n_hours=n_hours,
            hours_in_plume=int(hits[i]),
            share=round(float(hits[i]) / max(1, n_hours), 4),
            hours_in_plume_stable=int(hits_stable[i]),
            share_stable=round(float(hits_stable[i]) / max(1, n_stable), 4),
            by_site={k: v for k, v in by_site[i].items() if v},
            hours_in_plume_inside=int(hits_inside[i]),
            share_inside=round(float(hits_inside[i]) / max(1, n_hours), 4),
            by_site_inside={k: v for k, v in by_inside[i].items() if v},
            by_site_beyond={k: v for k, v in by_beyond[i].items() if v},
        )
        for i, m in enumerate(w.monitors)
    ]
    return Interception(campaign_id, n_hours, _BASIS, out)


_BASIS = (
    "modelled — the plume outline drawn on the map (air.dispersion, driven by this "
    "campaign's hourly wind record). Nobody measured the air at these instruments "
    "and compared it to anything."
)


def residency(conn: sqlite3.Connection, campaign_id: str) -> list[SegmentResidency]:
    """Per segment: plume-hours, and how many of them nothing observed.

    `unobserved` rather than raw residency is the right encoding. Raw residency
    is hottest where the plume goes most often, which here is President's
    Island — and Riverport Road already stands there, so the hottest streets on
    a raw map are the ones already covered. What a regulator needs is the
    plume-hours that passed with nothing standing in the plume that caused
    them.

    NOTE a segment can exceed its own `plume_hours` count in neither field:
    both are counted per (hour, site), so an hour in which two sites' plumes
    both cross a street contributes two — which is correct, because they are
    two different unobserved events with two different answers.
    """
    w = load(conn, campaign_id)
    n_seg = len(w.seg_ids)
    if n_seg == 0 or not w.sites:
        return []

    plume_hours = np.zeros(n_seg, dtype=int)
    unobserved = np.zeros(n_seg, dtype=int)
    n_mon = len(w.monitors)

    # Attributed PER SITE, not merged.
    #
    # The loose version — "this street had a plume in an hour when no
    # instrument anywhere was in one" — conflates two different failures and
    # flatters the network: an hour where Riverport Road stands in Riverport's
    # plume counts as observed even for a street under RIDGELINE's plume on the
    # far side of the campaign. The question a regulator is actually asking is
    # whether anything was standing in the plume that crossed THIS street, so
    # a segment-hour is unobserved when no instrument stood in the same site's
    # plume in the same hour.
    mon_iter = _hourly_masks(w, w.mon_polar, n_mon)
    seg_iter = _hourly_masks(w, w.seg_polar, n_seg)
    for (_h1, _mm, mon_by_site), (_h2, _sm, seg_by_site) in zip(
        mon_iter, seg_iter, strict=True
    ):
        for sid, seg_codes in seg_by_site.items():
            seg_mask = seg_codes > 0
            if not seg_mask.any():
                continue
            # BOTH counted per (hour, site). Counting the denominator per hour
            # (merged across sites) and the numerator per site gave segments an
            # unobserved share of 104%.
            plume_hours += seg_mask
            watched = mon_by_site.get(sid)
            if watched is None or not (watched > 0).any():
                unobserved += seg_mask

    return [
        SegmentResidency(
            segment_id=w.seg_ids[i], name=w.seg_name[i], district=w.seg_district[i],
            lon=float(w.seg_lon[i]), lat=float(w.seg_lat[i]), length_m=float(w.seg_len[i]),
            plume_hours=int(plume_hours[i]), unobserved_hours=int(unobserved[i]),
            unobserved_share=round(float(unobserved[i]) / max(1, plume_hours[i]), 4),
        )
        for i in range(n_seg)
    ]


def siting_candidates(
    conn: sqlite3.Connection, campaign_id: str, limit: int = 10
) -> list[SegmentResidency]:
    """The streets carrying the most unobserved plume-hours in this record.

    NOT a recommendation. See the module docstring: the ranking is an
    observation about the record and the decision belongs to the agency. Every
    consumer must phrase it that way.
    """
    rows = [r for r in residency(conn, campaign_id) if r.plume_hours >= MIN_PLUME_HOURS]
    rows.sort(key=lambda r: (-r.unobserved_hours, -r.plume_hours))
    # One per district, so the list is not ten segments of the same road.
    seen: set[str] = set()
    out: list[SegmentResidency] = []
    for r in rows:
        key = r.name or r.segment_id
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
        if len(out) >= limit:
            break
    return out


# ── the concession (P7-C) ────────────────────────────────────────────────────


@dataclass(frozen=True)
class Concession:
    """What four fixed points do well, and what they cannot do.

    The fleet's LOSING number, computed and served in the same payload as
    everything the fleet wins on, so it is structurally impossible to print
    only the comparison we win. An always-on instrument beats a moving one on
    duty cycle and does here.

    Every figure is computed. An earlier draft of the screen carried "8,598
    records vs 56,673 passes" and "5.7% vs 1.4%" copied out of a design
    document; measured on this database the records are 21,500 and the shares
    were 8.4% and 4.8% (1.75x, not 4x). R0 then moved them again, to 15.0%
    and 6.1% (2.5x), when this module started counting against the outline the
    map draws instead of a single centroid wedge — Riverport Road, 424 m from
    a site whose release points spread ~300 m across the wind, is the reading
    that moved. The finding survived both times and the margin moved both
    times, which is exactly why this is arithmetic and not a caption.
    """

    n_reference_instruments: int
    n_segments: int
    n_reference_readings: int
    n_fleet_passes: int
    reference_in_plume: int
    fleet_in_plume: int
    reference_share: float
    fleet_share: float


def concession(conn: sqlite3.Connection, campaign_id: str) -> Concession:
    w = load(conn, campaign_id)
    hour_ix = {t[:13]: i for i, t in enumerate(w.ts)}
    n_h, n_m, n_s = len(w.ts), len(w.monitors), len(w.seg_ids)

    mon = np.zeros((n_h, n_m), dtype=bool)
    seg = np.zeros((n_h, n_s), dtype=bool)
    for (h, mm, _p1), (_h2, sm, _p2) in zip(
        _hourly_masks(w, w.mon_polar, n_m), _hourly_masks(w, w.seg_polar, n_s), strict=True
    ):
        mon[h] = mm
        seg[h] = sm

    mid = {m["id"]: i for i, m in enumerate(w.monitors)}
    ref_ids = {m["id"] for m in w.monitors if m["grade"] == "reference"}
    sid = {v: i for i, v in enumerate(w.seg_ids)}

    ref_total = ref_hit = 0
    for m_id, ts in conn.execute(
        "SELECT r.monitor_id, r.ts FROM monitor_reading r JOIN monitor m ON m.id = r.monitor_id "
        "WHERE m.campaign_id = ? AND m.grade = 'reference'",
        (campaign_id,),
    ):
        h = hour_ix.get(ts[:13])
        if h is None or m_id not in ref_ids:
            continue
        ref_total += 1
        ref_hit += bool(mon[h][mid[m_id]])

    fleet_total = fleet_hit = 0
    for s_id, ts in conn.execute(
        "SELECT segment_id, ts FROM segment_pass WHERE campaign_id = ?", (campaign_id,)
    ):
        h = hour_ix.get(ts[:13])
        i = sid.get(s_id)
        if h is None or i is None:
            continue
        fleet_total += 1
        fleet_hit += bool(seg[h][i])

    return Concession(
        n_reference_instruments=len(ref_ids),
        n_segments=n_s,
        n_reference_readings=ref_total,
        n_fleet_passes=fleet_total,
        reference_in_plume=ref_hit,
        fleet_in_plume=fleet_hit,
        reference_share=round(ref_hit / max(1, ref_total), 4),
        fleet_share=round(fleet_hit / max(1, fleet_total), 4),
    )
