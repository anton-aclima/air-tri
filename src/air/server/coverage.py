"""Do the regulator's instruments stand where the plume goes?

THE REGULATOR'S QUESTION, answered from this campaign's own record rather than
from a siting rule of thumb. Three things, all built on `air.dispersion`'s cone
test so they cannot disagree with the plume anyone else is looking at:

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

EVERYTHING HERE IS MODELLED
---------------------------
"Inside a plume" means inside a MODELLED cone from `air.dispersion`. Nobody
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
from functools import lru_cache
from typing import Any

import numpy as np

from air import dispersion
from air.server import cache

R_EARTH = 6371008.8

#: Multiples of sigma_y for the sector, matching the touchdown estimator and
#: the climatology so "downwind" means one thing across the product.
N_SIGMA = 2.0

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
    #: Which sites' plumes ever reached it, and how often.
    by_site: dict[str, int] = field(default_factory=dict)


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


def _haversine(lon1, lat1, lon2, lat2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dphi, dlam = p2 - p1, np.radians(lon2 - lon1)
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlam / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.minimum(1.0, np.sqrt(a)))


def _bearing(lon1, lat1, lon2, lat2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dlam = np.radians(lon2 - lon1)
    y = np.sin(dlam) * np.cos(p2)
    x = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dlam)
    # Normalised so due north is 0, never 360: arctan2 returns a tiny
    # NEGATIVE for a northward bearing, and both `x % 360` and
    # `(x + 360) % 360` return 360.0 for one. Latent here — these feed
    # wrap-safe angular differences — but it is the same landmine that
    # `forecast._norm_bearing` exists for.
    out = np.mod(np.degrees(np.arctan2(y, x)), 360.0)
    return np.where(out >= 360.0 - 1e-9, 0.0, out)


def _to_local(origin: tuple[float, float], lons, lats):
    """Metres east and north of `origin`, which is what the kernel takes."""
    d = _haversine(origin[0], origin[1], lons, lats)
    b = np.radians(_bearing(origin[0], origin[1], lons, lats))
    return d * np.sin(b), d * np.cos(b)


@lru_cache(maxsize=4096)
def _site_extent(sources: tuple, u10: float, cls: str, pbl_m: float) -> tuple[float, float]:
    """(onset, reach) in metres for one site under one hour's weather.

    Cached on quantised weather because 2,160 hours x 3 sites collapses to a
    few hundred distinct answers, and `reach` walks an 8 km profile each call.
    """
    srcs = [dispersion.Source(h, k) for h, k in sources]
    r = dispersion.reach(srcs, u10=u10, cls=cls, pbl_m=pbl_m)
    if r.faint:
        return (0.0, 0.0)
    return (r.x_onset, r.x_reach)


class _World:
    """Sites, instruments, road segments and weather, projected once."""

    def __init__(self, conn: sqlite3.Connection, campaign_id: str):
        self.campaign_id = campaign_id

        acc: dict[str, list] = {}
        for sid, kind, lon, lat, height in conn.execute(
            "SELECT e.site_id, e.kind, e.lon, e.lat, e.height_m FROM emission_point e "
            "JOIN industry_site s ON s.id = e.site_id "
            "WHERE e.active = 1 AND s.campaign_id = ?",
            (campaign_id,),
        ):
            w = dispersion.STRENGTH.get(kind, 0.6)
            a = acc.setdefault(sid, [0.0, 0.0, 0.0, []])
            a[0] += w * lon
            a[1] += w * lat
            a[2] += w
            a[3].append((float(height or 12.0), kind))
        #: site_id -> ((lon, lat), sources tuple)
        self.sites = {
            k: ((v[0] / v[2], v[1] / v[2]), tuple(sorted(v[3])))
            for k, v in acc.items()
            if v[2] > 0
        }

        mons = conn.execute(
            "SELECT id, name, owner_type, grade, status, lon, lat, measures_json "
            "FROM monitor WHERE campaign_id = ? ORDER BY grade, name",
            (campaign_id,),
        ).fetchall()
        self.monitors = [dict(zip(
            ("id", "name", "owner_type", "grade", "status", "lon", "lat", "measures_json"),
            m, strict=True,
        )) for m in mons]
        self.mon_lon = np.array([m["lon"] for m in self.monitors])
        self.mon_lat = np.array([m["lat"] for m in self.monitors])

        segs = conn.execute(
            "SELECT id, name, district, mid_lon, mid_lat, length_m FROM road_segment "
            "WHERE campaign_id = ? ORDER BY id",
            (campaign_id,),
        ).fetchall()
        self.seg_ids = [s[0] for s in segs]
        self.seg_name = [s[1] for s in segs]
        self.seg_district = [s[2] for s in segs]
        self.seg_lon = np.array([s[3] for s in segs])
        self.seg_lat = np.array([s[4] for s in segs])
        self.seg_len = np.array([s[5] or 200.0 for s in segs])

        wind = conn.execute(
            "SELECT ts, speed_ms, dir_deg, stability, pbl_m FROM wind "
            "WHERE campaign_id = ? ORDER BY ts",
            (campaign_id,),
        ).fetchall()
        self.ts = [w[0] for w in wind]
        self.u10 = np.array([max(0.4, float(w[1] or 1.0)) for w in wind])
        self.axis = np.array([(float(w[2]) + 180.0) % 360.0 for w in wind])
        self.cls = np.array([(w[3] or "D").upper() for w in wind])
        self.pbl = np.array([float(w[4] or 500.0) for w in wind])
        self.stable = np.isin(self.cls, list(STABLE_CLASSES))

        # Per site, receptors in the site's own local metric frame.
        self.mon_xy = {}
        self.seg_xy = {}
        for sid, (origin, _src) in self.sites.items():
            self.mon_xy[sid] = _to_local(origin, self.mon_lon, self.mon_lat)
            self.seg_xy[sid] = _to_local(origin, self.seg_lon, self.seg_lat)


def load(conn: sqlite3.Connection, campaign_id: str) -> _World:
    key = ("coverage_world", campaign_id, cache.version())
    hit = cache.get(key)
    if hit is not None:
        return hit
    return cache.put(key, _World(conn, campaign_id))


# ── the three answers ────────────────────────────────────────────────────────


def _hourly_masks(w: _World, dx_by_site: dict, n_receptors: int):
    """Yield (hour index, receptor-mask) for every hour, over all sites merged.

    One pass, shared by `interception` and `residency`, so the two can never
    disagree about which hours had a plume anywhere. Merged with OR across
    sites: a receptor standing in Ridgeline's plume is in *a* plume, and
    counting it three times because three sites exist would be an artefact of
    how many sites the campaign happens to have.
    """
    for h in range(len(w.ts)):
        cls = str(w.cls[h])
        u10 = float(w.u10[h])
        pbl = float(w.pbl[h])
        axis = float(w.axis[h])
        merged = np.zeros(n_receptors, dtype=bool)
        per_site: dict[str, np.ndarray] = {}
        for sid, (_origin, sources) in w.sites.items():
            onset, reach = _site_extent(
                sources, round(u10, 1), cls, round(pbl / 10.0) * 10.0
            )
            if reach <= 0.0:
                continue
            dx, dy = dx_by_site[sid]
            m = dispersion.cone_mask(
                dx, dy, axis, x_min=onset, x_max=reach, cls=cls, u10=u10, n_sigma=N_SIGMA
            )
            per_site[sid] = m
            merged |= m
        yield h, merged, per_site


def interception(conn: sqlite3.Connection, campaign_id: str) -> Interception:
    """How often each fixed instrument stands inside a modelled plume."""
    w = load(conn, campaign_id)
    n = len(w.monitors)
    if n == 0 or not w.sites:
        return Interception(campaign_id, len(w.ts), _BASIS, [])

    hits = np.zeros(n, dtype=int)
    hits_stable = np.zeros(n, dtype=int)
    by_site = [{sid: 0 for sid in w.sites} for _ in range(n)]
    for h, merged, per_site in _hourly_masks(w, w.mon_xy, n):
        hits += merged
        if w.stable[h]:
            hits_stable += merged
        for sid, m in per_site.items():
            for i in np.flatnonzero(m):
                by_site[i][sid] += 1

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
        )
        for i, m in enumerate(w.monitors)
    ]
    return Interception(campaign_id, n_hours, _BASIS, out)


_BASIS = (
    "modelled — air.dispersion, driven by this campaign's hourly wind record. "
    "Nobody measured the air at these instruments and compared it to anything."
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
    mon_iter = _hourly_masks(w, w.mon_xy, n_mon)
    seg_iter = _hourly_masks(w, w.seg_xy, n_seg)
    for (_h1, _mm, mon_by_site), (_h2, _sm, seg_by_site) in zip(
        mon_iter, seg_iter, strict=True
    ):
        for sid, seg_mask in seg_by_site.items():
            if not seg_mask.any():
                continue
            # BOTH counted per (hour, site). Counting the denominator per hour
            # (merged across sites) and the numerator per site gave segments an
            # unobserved share of 104%.
            plume_hours += seg_mask
            watched = mon_by_site.get(sid)
            if watched is None or not watched.any():
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
    are 8.4% and 4.8%. The finding survived, the margin did not — it is 1.75x,
    not 4x — which is exactly why this is arithmetic and not a caption.
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
        _hourly_masks(w, w.mon_xy, n_m), _hourly_masks(w, w.seg_xy, n_s), strict=True
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
