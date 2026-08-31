"""Step 1 -- world definition.

Everything that exists before a single measurement is taken: the campaign and its
boundary, the organisations and demo personas, the three industry sites on real
industrial parcels, the stationary monitor network, the vehicle fleet, and the
methane leak sources.

Geography is real (OpenStreetMap, Southwest Memphis).  Every *actor* is fictional:
the industrial parcels come from OSM but their real occupants' names are never
stored -- `Ridgeline Compute`, `Delta Forge Metals` and `Riverport Logistics` are
inventions placed on real land.  Neighbourhood names (Boxtown, Westwood, White
Chapel, Darwin, Pisgah Heights, Goodman, Wyanoke, President's Island) are real,
because the community deserves to see its own street names.

Site placement is not arbitrary.  With the Memphis prevailing wind from the
S/SW, transport is toward the NNE, and `Ridgeline South Campus` is sited on the
riverfront industrial parcel *south-west* of Boxtown so that on a typical day its
plume lands on the community.  As the wind backs through W and NW the plume sweeps
clockwise across Boxtown (055 deg) -> White Chapel (060) -> Westwood (096) ->
Darwin (120) -> Goodman (118).  `Delta Forge Metals` sits due north of Boxtown and
`Riverport Logistics` to the north-east, so on north-wind days the community is
hit by a *different* source -- that ambiguity is the attribution story.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from . import osm
from .geo import Projector, densify, polygon_geojson, ring_contains, concave_hull
from .measures import MEASURE_CODES  # noqa: F401  (re-exported for convenience)

BBOX = osm.BBOX
CENTER = (-90.132, 35.058)
CAMPAIGN_ID = "cmp-swmem-2026"
CAMPAIGN_DAYS = 90

# ---------------------------------------------------------------- orgs & people

ORGS = [
    {
        "id": "org-aclima",
        "name": "Aclima",
        "short_name": "Aclima",
        "kind": "aclima",
        "brand_color": "#1FA8A0",
        "logo_emoji": "🛰️",
        "blurb": "Hyperlocal air measurement. We drive the streets so the numbers are "
        "where people actually breathe.",
        "website": "https://aclima.earth",
    },
    {
        "id": "org-draqa",
        "name": "Delta Regional Air Quality Authority",
        "short_name": "DRAQA",
        "kind": "agency",
        "brand_color": "#2F6FB8",
        "logo_emoji": "🏛️",
        "blurb": "State-delegated air authority for the Memphis-Delta airshed. Operates "
        "the reference monitoring network and sets local action levels.",
        "website": None,
    },
    {
        "id": "org-ridgeline",
        "name": "Ridgeline Compute",
        "short_name": "Ridgeline",
        "kind": "company",
        "brand_color": "#C9773A",
        "logo_emoji": "▲",
        "blurb": "AI compute infrastructure. Ridgeline South Campus is a 350 MW "
        "training cluster on the Memphis riverfront.",
        "website": None,
    },
    {
        "id": "org-deltaforge",
        "name": "Delta Forge Metals",
        "short_name": "Delta Forge",
        "kind": "company",
        "brand_color": "#8C6D4F",
        "logo_emoji": "⚒️",
        "blurb": "Secondary aluminium and specialty alloy finishing, Channel Avenue.",
        "website": None,
    },
    {
        "id": "org-riverport",
        "name": "Riverport Logistics",
        "short_name": "Riverport",
        "kind": "company",
        "brand_color": "#5B7A8C",
        "logo_emoji": "🚚",
        "blurb": "Intermodal drayage and cold-chain warehousing off Riverport Road.",
        "website": None,
    },
    {
        "id": "org-boxtown",
        "name": "Boxtown Air Watch",
        "short_name": "BAW",
        "kind": "cbo",
        "brand_color": "#7A5CA8",
        "logo_emoji": "🌿",
        "blurb": "Residents of Boxtown, Westwood and White Chapel keeping our own record "
        "of what we smell, hear and breathe.",
        "website": None,
    },
]

USERS = [
    # community
    ("usr-com-01", "Yolanda Bridges", "community", "org-boxtown", "Boxtown Air Watch, founder", "🌻", "#7A5CA8", "Boxtown"),
    ("usr-com-02", "Marcus Teague", "community", "org-boxtown", "Resident", "🎺", "#C9773A", "Boxtown"),
    ("usr-com-03", "Renita Alcorn", "community", "org-boxtown", "Resident, block captain", "📓", "#2F6FB8", "White Chapel"),
    ("usr-com-04", "Samuel Ojo", "community", None, "Resident", "🚲", "#3FBF8F", "Westwood"),
    ("usr-com-05", "Della Whitfield", "community", None, "Resident, retired nurse", "🩺", "#E2544F", "Boxtown"),
    ("usr-com-06", "Curtis Nabors", "community", None, "Resident", "🎣", "#5B7A8C", "Pisgah Heights"),
    ("usr-com-07", "Anita Ramos", "community", "org-boxtown", "Resident, youth program lead", "📣", "#F08A3C", "Westwood"),
    ("usr-com-08", "Terrance Poole", "community", None, "Resident", "🧰", "#9ED45C", "Darwin"),
    # regulator
    ("usr-reg-01", "Dr. Priya Raghunathan", "regulator", "org-draqa", "Air Monitoring Manager", "🔬", "#2F6FB8", None),
    ("usr-reg-02", "Owen Castellanos", "regulator", "org-draqa", "Field Operations Lead", "🧭", "#4B3D9B", None),
    ("usr-reg-03", "Hana Mbeki", "regulator", "org-draqa", "Data Scientist", "📈", "#1FA8A0", None),
    ("usr-reg-04", "Ellis Trethewey", "regulator", "org-draqa", "Enforcement Counsel", "⚖️", "#823C93", None),
    # industry
    ("usr-ind-01", "Grant Ellery", "industry", "org-ridgeline", "Director, Site Operations", "▲", "#C9773A", None),
    ("usr-ind-02", "Wei-Lin Chao", "industry", "org-ridgeline", "Environmental Compliance", "🧪", "#F79B3D", None),
    ("usr-ind-03", "Roy Pemberton", "industry", "org-deltaforge", "Plant Manager", "⚒️", "#8C6D4F", None),
    ("usr-ind-04", "Tasha Greer", "industry", "org-riverport", "Terminal Manager", "🚚", "#5B7A8C", None),
    # admin
    ("usr-adm-01", "Anton Vattay", "admin", "org-aclima", "Campaign Architect", "🛰️", "#1FA8A0", None),
    ("usr-adm-02", "Aclima Data Ops", "admin", "org-aclima", "Data Operations", "🧮", "#3FBF8F", None),
]

VEHICLES = [
    ("AC-01", "Bluebird", "Ford E-Transit", "ev", "Dominic Reyes"),
    ("AC-02", "Kingfisher", "Chevrolet Bolt EUV", "ev", "Aisha Coleman"),
    ("AC-03", "Redwing", "Toyota RAV4 Prime", "phev", "Beto Salazar"),
    ("AC-04", "Nighthawk", "Kia Niro EV", "ev", "Priscilla Adeyemi"),
    ("AC-05", "Sparrow", "Ford Escape PHEV", "phev", "Jonah Pike"),
]
FLEET_MEASURES = ["no2", "pm25", "bc", "o3", "co", "co2", "ch4"]
DEPOT = (-90.1006, 35.0692)  # Aclima ops depot, off Riverport Road


# ---------------------------------------------------------------- site templates

# Chosen from the real OSM landuse=industrial parcels by anchor coordinate.
# See the module docstring for why these three locations.
SITE_SPECS = [
    {
        "id": "site-ridgeline",
        "anchor": (-90.1479, 35.0348),
        "org_id": "org-ridgeline",
        "name": "Ridgeline South Campus",
        "kind": "datacenter",
        "status": "operating",
        "capacity_mw": 352.0,
        "it_load_mw": 268.0,
        "generator_count": 24,
        "generator_fuel": "natural gas turbine (24 x 14.6 MW) + diesel backup",
        "operating_since_days": 412,
        "headroom_pct": 79.0,
        "brand_color": "#C9773A",
        "logo_emoji": "▲",
        "blurb": "352 MW AI training campus on the Memphis riverfront. Behind-the-meter "
        "generation: 24 aeroderivative gas turbines plus a diesel backup yard. "
        "Phase 2 permitting is open.",
    },
    {
        "id": "site-deltaforge",
        "anchor": (-90.1211, 35.0812),
        "org_id": "org-deltaforge",
        "name": "Delta Forge Channel Avenue Works",
        "kind": "manufacturing",
        "status": "operating",
        "capacity_mw": 46.0,
        "it_load_mw": None,
        "generator_count": 2,
        "generator_fuel": "natural gas boilers + 2 diesel standby",
        "operating_since_days": 6900,
        "headroom_pct": 61.0,
        "brand_color": "#8C6D4F",
        "logo_emoji": "⚒️",
        "blurb": "Secondary aluminium remelt and coil finishing. Two reverberatory "
        "furnace stacks; operates two shifts.",
    },
    {
        "id": "site-riverport",
        "anchor": (-90.0969, 35.0729),
        "org_id": "org-riverport",
        "name": "Riverport Intermodal Terminal",
        "kind": "logistics",
        "status": "operating",
        "capacity_mw": 12.0,
        "it_load_mw": None,
        "generator_count": 3,
        "generator_fuel": "diesel yard tractors, reefer gensets, 1 standby",
        "operating_since_days": 3100,
        "headroom_pct": 44.0,
        "brand_color": "#5B7A8C",
        "logo_emoji": "🚚",
        "blurb": "Intermodal drayage yard and cold-chain cross-dock. ~900 heavy-duty "
        "truck moves a day through two gates.",
    },
]


# ---------------------------------------------------------------- dataclasses


@dataclass
class EmissionPoint:
    id: str
    site_id: str
    name: str
    kind: str
    lon: float
    lat: float
    height_m: float
    active: int
    measures: list[str]
    # simulation-only knobs (not persisted)
    strength: dict[str, float] = field(default_factory=dict)
    duty: str = "continuous"  # continuous | daytime | night | intermittent | rare

    def row(self) -> dict:
        return {
            "id": self.id,
            "site_id": self.site_id,
            "name": self.name,
            "kind": self.kind,
            "lon": round(self.lon, 6),
            "lat": round(self.lat, 6),
            "height_m": self.height_m,
            "active": self.active,
            "measures_json": json.dumps(self.measures),
        }


@dataclass
class Site:
    row: dict
    ring: list[tuple[float, float]]
    points: list[EmissionPoint]

    @property
    def id(self) -> str:
        return self.row["id"]

    @property
    def centroid(self) -> tuple[float, float]:
        return (self.row["centroid_lon"], self.row["centroid_lat"])


@dataclass
class Leak:
    id: str
    lon: float
    lat: float
    sigma_m: float
    ppm_peak: float
    duty: str
    growth: float  # multiplier applied linearly across the campaign
    label: str


@dataclass
class World:
    proj: Projector
    ways: list
    places: list
    parcels: list
    boundary_ring: list[tuple[float, float]]
    boundary_geojson: dict
    campaign: dict
    orgs: list[dict]
    users: list[dict]
    sites: list[Site]
    monitors: list[dict]
    vehicles: list[dict]
    leaks: list[Leak]
    start: datetime
    end: datetime
    now: datetime
    seed: int

    @property
    def emission_points(self) -> list[EmissionPoint]:
        return [p for s in self.sites for p in s.points]

    def site(self, sid: str) -> Site:
        return next(s for s in self.sites if s.id == sid)


# ---------------------------------------------------------------- helpers


def _ray_hit(ring, c, bearing_deg_, proj, lo: float = 0.0, hi: float = 1e9) -> float:
    """Distance in metres from centroid `c` to the ring along `bearing_deg_`.

    Real industrial parcels are often long riverfront strips, so the raw hit can be
    kilometres away.  `lo`/`hi` clamp it to a plausible campus radius; the parcel
    ring is still what gets stored as the site footprint.
    """
    cx, cy = proj.xy(*c)
    th = math.radians(bearing_deg_)
    dx, dy = math.sin(th), math.cos(th)
    best = None
    n = len(ring)
    for i in range(n):
        ax, ay = proj.xy(*ring[i])
        bx, by = proj.xy(*ring[(i + 1) % n])
        ex, ey = bx - ax, by - ay
        den = dx * ey - dy * ex
        if abs(den) < 1e-9:
            continue
        t = ((ax - cx) * ey - (ay - cy) * ex) / den
        u = ((ax - cx) * dy - (ay - cy) * dx) / den
        if t > 0 and -1e-9 <= u <= 1 + 1e-9:
            if best is None or t < best:
                best = t
    return min(max(best if best is not None else 300.0, lo), hi)


def _offset(c, bearing_deg_, dist_m, proj):
    cx, cy = proj.xy(*c)
    th = math.radians(bearing_deg_)
    return proj.lonlat(cx + math.sin(th) * dist_m, cy + math.cos(th) * dist_m)


def _pick_parcel(parcels, anchor, proj, min_area=60000.0):
    best, best_d = None, 1e18
    ax, ay = proj.xy(*anchor)
    for p in parcels:
        if p.area_m2 < min_area:
            continue
        px, py = proj.xy(*p.centroid)
        d = math.hypot(px - ax, py - ay)
        if d < best_d:
            best, best_d = p, d
    return best


# ---------------------------------------------------------------- emission points


def _ridgeline_points(site_id, ring, centroid, proj) -> list[EmissionPoint]:
    """13 emission points: 6 turbine banks on the NE flank, a diesel backup yard,
    3 cooling towers, the truck gate and the substation."""
    pts: list[EmissionPoint] = []
    # Turbine hall runs along a NE-SW line on the north-east flank of the parcel.
    r_ne = _ray_hit(ring, centroid, 55.0, proj, 260.0, 520.0)
    hall_center = _offset(centroid, 55.0, r_ne * 0.62, proj)
    for i in range(6):
        # two rows of three, spaced 55 m along a 145 deg axis
        along = (i % 3 - 1) * 78.0
        across = (0 if i < 3 else 1) * 62.0 - 31.0
        p0 = _offset(hall_center, 145.0, along, proj)
        p1 = _offset(p0, 235.0, across, proj)
        pts.append(
            EmissionPoint(
                id=f"ep-rl-gt{i + 1:02d}",
                site_id=site_id,
                name=f"Turbine bank {chr(65 + i)} (4 x 14.6 MW)",
                kind="generator",
                lon=p1[0],
                lat=p1[1],
                height_m=21.0,
                active=1,
                measures=["no2", "co", "co2", "pm25", "ch4"],
                strength={"nox": 1.0, "co": 0.55, "co2": 1.0, "pm": 0.30, "bc": 0.10, "ch4": 0.05},
                duty="continuous",
            )
        )
    # Diesel backup yard, tucked on the south flank; runs on test days and peaks.
    r_s = _ray_hit(ring, centroid, 185.0, proj, 260.0, 520.0)
    yard = _offset(centroid, 185.0, r_s * 0.55, proj)
    for i in range(2):
        p = _offset(yard, 95.0, (i - 0.5) * 90.0, proj)
        pts.append(
            EmissionPoint(
                id=f"ep-rl-bk{i + 1:02d}",
                site_id=site_id,
                name=f"Diesel backup bank {i + 1} (10 x 3.2 MW)",
                kind="backup",
                lon=p[0],
                lat=p[1],
                height_m=12.0,
                active=1,
                measures=["no2", "bc", "pm25", "co"],
                strength={"nox": 0.62, "co": 0.30, "co2": 0.35, "pm": 0.55, "bc": 1.00},
                duty="intermittent",
            )
        )
    # Cooling towers along the west flank -- water vapour, a little drift PM.
    r_w = _ray_hit(ring, centroid, 275.0, proj, 260.0, 520.0)
    cool = _offset(centroid, 275.0, r_w * 0.5, proj)
    for i in range(3):
        p = _offset(cool, 5.0, (i - 1) * 105.0, proj)
        pts.append(
            EmissionPoint(
                id=f"ep-rl-ct{i + 1:02d}",
                site_id=site_id,
                name=f"Cooling tower cell {i + 1}",
                kind="cooling_tower",
                lon=p[0],
                lat=p[1],
                height_m=16.0,
                active=1,
                measures=["pm25"],
                strength={"nox": 0.0, "co": 0.0, "co2": 0.0, "pm": 0.16, "bc": 0.0},
                duty="continuous",
            )
        )
    # Truck / construction gate on the access road, and the substation.
    r_e = _ray_hit(ring, centroid, 88.0, proj, 300.0, 560.0)
    gate = _offset(centroid, 88.0, r_e * 0.94, proj)
    pts.append(
        EmissionPoint(
            id="ep-rl-gate01",
            site_id=site_id,
            name="North gate (construction + delivery)",
            kind="traffic_gate",
            lon=gate[0],
            lat=gate[1],
            height_m=3.0,
            active=1,
            measures=["no2", "bc", "pm25"],
            strength={"nox": 0.34, "co": 0.22, "co2": 0.20, "pm": 0.36, "bc": 0.64},
            duty="daytime",
        )
    )
    r_n = _ray_hit(ring, centroid, 20.0, proj, 260.0, 520.0)
    sub = _offset(centroid, 20.0, r_n * 0.55, proj)
    pts.append(
        EmissionPoint(
            id="ep-rl-sub01",
            site_id=site_id,
            name="Grid interconnect substation",
            kind="substation",
            lon=sub[0],
            lat=sub[1],
            height_m=8.0,
            active=1,
            measures=[],
            strength={},
            duty="continuous",
        )
    )
    return pts


def _deltaforge_points(site_id, ring, centroid, proj) -> list[EmissionPoint]:
    pts = []
    for i, (brg, frac, name, kind, h, st, duty) in enumerate(
        [
            (30.0, 0.55, "Remelt furnace stack A", "stack", 34.0,
             {"nox": 0.58, "co": 0.42, "co2": 0.52, "pm": 0.72, "bc": 0.24}, "continuous"),
            (110.0, 0.5, "Remelt furnace stack B", "stack", 34.0,
             {"nox": 0.50, "co": 0.38, "co2": 0.46, "pm": 0.64, "bc": 0.20}, "daytime"),
            (220.0, 0.5, "Standby generator pad", "backup", 9.0,
             {"nox": 0.28, "co": 0.14, "co2": 0.16, "pm": 0.24, "bc": 0.44}, "rare"),
            (300.0, 0.85, "Scrap yard gate", "traffic_gate", 3.0,
             {"nox": 0.22, "co": 0.16, "co2": 0.14, "pm": 0.30, "bc": 0.40}, "daytime"),
        ]
    ):
        r = _ray_hit(ring, centroid, brg, proj, 90.0, 420.0)
        p = _offset(centroid, brg, r * frac, proj)
        pts.append(
            EmissionPoint(
                id=f"ep-df-{i + 1:02d}",
                site_id=site_id,
                name=name,
                kind=kind,
                lon=p[0],
                lat=p[1],
                height_m=h,
                active=1,
                measures=["no2", "pm25", "co", "bc"],
                strength=st,
                duty=duty,
            )
        )
    return pts


def _riverport_points(site_id, ring, centroid, proj) -> list[EmissionPoint]:
    pts = []
    for i, (brg, frac, name, kind, h, st, duty) in enumerate(
        [
            (200.0, 0.9, "South truck gate", "traffic_gate", 3.0,
             {"nox": 0.74, "co": 0.30, "co2": 0.34, "pm": 0.56, "bc": 1.05}, "daytime"),
            (20.0, 0.9, "North truck gate", "traffic_gate", 3.0,
             {"nox": 0.52, "co": 0.22, "co2": 0.26, "pm": 0.40, "bc": 0.76}, "daytime"),
            (120.0, 0.45, "Reefer genset row", "generator", 4.0,
             {"nox": 0.44, "co": 0.20, "co2": 0.22, "pm": 0.42, "bc": 0.72}, "continuous"),
            (280.0, 0.5, "Yard tractor fuelling apron", "stack", 4.0,
             {"nox": 0.30, "co": 0.16, "co2": 0.18, "pm": 0.26, "bc": 0.46}, "daytime"),
        ]
    ):
        r = _ray_hit(ring, centroid, brg, proj, 90.0, 420.0)
        p = _offset(centroid, brg, r * frac, proj)
        pts.append(
            EmissionPoint(
                id=f"ep-rp-{i + 1:02d}",
                site_id=site_id,
                name=name,
                kind=kind,
                lon=p[0],
                lat=p[1],
                height_m=h,
                active=1,
                measures=["no2", "pm25", "bc"],
                strength=st,
                duty=duty,
            )
        )
    return pts


_POINT_BUILDERS = {
    "site-ridgeline": _ridgeline_points,
    "site-deltaforge": _deltaforge_points,
    "site-riverport": _riverport_points,
}


# ---------------------------------------------------------------- monitors

# name, code, lon, lat, measures, status, blurb
REFERENCE_MONITORS = [
    (
        "Weaver Road",
        "47-157-0021",
        -90.0928,
        35.0432,
        ["o3", "no2", "pm25"],
        "online",
        "DRAQA neighbourhood-scale reference site. FEM ozone and NO2, "
        "gravimetric-equivalent PM2.5. The closest reference instrument to the "
        "Westwood residential grid.",
    ),
    (
        "Riverport Road",
        "47-157-0034",
        -90.1000,
        35.0755,
        ["pm25", "no2", "co"],
        "online",
        "Source-oriented reference site on the freight corridor. Sited in 2011 for "
        "the intermodal terminal, not for the datacenter build-out.",
    ),
    (
        "West Shelby Drive",
        "47-157-0047",
        -90.1105,
        35.0212,
        ["o3", "pm25"],
        "online",
        "Regional-scale background and ozone transport site at the southern edge of "
        "the airshed.",
    ),
    (
        "Harbor Avenue",
        "47-157-0058",
        -90.1300,
        35.0873,
        ["o3", "no2"],
        "degraded",
        "River-industrial reference site. NO2 channel has been drifting since the "
        "last calibration; QC flags are elevated.",
    ),
]

FENCELINE_RING = [
    ("N", 15.0, ["no2", "pm25", "bc"], "online"),
    ("NE", 60.0, ["no2", "pm25", "bc"], "online"),
    ("E", 95.0, ["no2", "pm25", "bc", "co"], "online"),
    ("SE", 150.0, ["no2", "pm25", "bc"], "online"),
    ("S", 205.0, ["no2", "pm25"], "online"),
    ("W", 260.0, ["no2", "pm25"], "online"),
    ("NW", 320.0, ["no2", "pm25"], "offline"),
]

COMMUNITY_MONITORS = [
    ("Boxtown Road porch sensor", -90.1232, 35.0505, ["pm25", "no2"], "online", "Boxtown"),
    ("White Chapel church roof", -90.1160, 35.0470, ["pm25"], "degraded", "White Chapel"),
]

LEAKS = [
    Leak("leak-boxtown-main", -90.1223, 35.0532, 135.0, 11.5, "continuous", 2.3,
         "Distribution main, Boxtown Road"),
    Leak("leak-ridgeline-skid", -90.1447, 35.0372, 95.0, 6.8, "intermittent", 1.0,
         "Gas supply skid, Ridgeline South Campus"),
    Leak("leak-riverport-cng", -90.0985, 35.0716, 80.0, 4.0, "daytime", 1.0,
         "CNG dispenser, Riverport Intermodal"),
    Leak("leak-channel-fill", -90.1140, 35.0930, 260.0, 1.5, "continuous", 1.15,
         "Closed fill area, Channel Avenue"),
    Leak("leak-westwood-vent", -90.0952, 35.0498, 75.0, 3.0, "intermittent", 1.0,
         "Sewer vent, Westwood"),
]


# ---------------------------------------------------------------- build


def build_world(seed: int = 20260827, now: datetime | None = None) -> World:
    """Assemble the whole static world.  Pure function of (seed, now)."""
    proj = Projector(*CENTER)
    bundle = osm.load_osm()
    ways, parcels, places = bundle.ways, bundle.parcels, bundle.places

    now = (now or datetime.now()).replace(second=0, microsecond=0)
    end_day = now.date()
    start_day = end_day - timedelta(days=CAMPAIGN_DAYS - 1)
    start = datetime.combine(start_day, datetime.min.time())
    end = datetime.combine(end_day, datetime.min.time()) + timedelta(days=1)

    # ---- industry sites on real parcels
    sites: list[Site] = []
    for spec in SITE_SPECS:
        parcel = _pick_parcel(parcels, spec["anchor"], proj)
        ring = [(round(x, 6), round(y, 6)) for x, y in parcel.ring]
        if ring[0] == ring[-1]:
            ring = ring[:-1]
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        row = {
            "id": spec["id"],
            "campaign_id": CAMPAIGN_ID,
            "org_id": spec["org_id"],
            "name": spec["name"],
            "kind": spec["kind"],
            "footprint_geojson": json.dumps(
                polygon_geojson(ring, {"site_id": spec["id"], "osm_way_id": parcel.osm_id})
            ),
            "centroid_lon": round(cx, 6),
            "centroid_lat": round(cy, 6),
            "claimed_by_user_id": None,
            "claimed_at": None,
            "status": spec["status"],
            "capacity_mw": spec["capacity_mw"],
            "it_load_mw": spec["it_load_mw"],
            "generator_count": spec["generator_count"],
            "generator_fuel": spec["generator_fuel"],
            "operating_since": (end - timedelta(days=spec["operating_since_days"])).date().isoformat(),
            "blurb": spec["blurb"],
            "brand_color": spec["brand_color"],
            "logo_emoji": spec["logo_emoji"],
            "website": None,
            "headroom_pct": spec["headroom_pct"],
        }
        pts = _POINT_BUILDERS[spec["id"]](spec["id"], ring, (cx, cy), proj)
        sites.append(Site(row=row, ring=ring, points=pts))

    # the operators who claimed their sites
    sites[0].row["claimed_by_user_id"] = "usr-ind-01"
    sites[1].row["claimed_by_user_id"] = "usr-ind-03"
    sites[2].row["claimed_by_user_id"] = "usr-ind-04"
    for s in sites:
        s.row["claimed_at"] = (start - timedelta(days=9)).isoformat(timespec="seconds")

    # ---- campaign boundary: concave hull of the in-bbox road network + the three parcels
    W, S, E, N = BBOX
    cloud: list[tuple[float, float]] = []
    for w in ways:
        run: list[tuple[float, float]] = []
        for c in w.coords:
            if W <= c[0] <= E and S <= c[1] <= N:
                run.append(c)
            else:
                if len(run) >= 2:
                    cloud += densify(run, proj, 60.0)
                run = []
        if len(run) >= 2:
            cloud += densify(run, proj, 60.0)
        elif len(run) == 1:
            cloud.append(run[0])
    for s in sites:
        cloud += densify(list(s.ring) + [s.ring[0]], proj, 60.0)
    boundary_ring = concave_hull(cloud, proj, cell_m=70.0, dilate_m=430.0, erode_m=250.0,
                                 simplify_m=95.0, smooth=2)
    boundary_geojson = {
        "type": "FeatureCollection",
        "features": [
            polygon_geojson(
                boundary_ring,
                {
                    "name": "Southwest Memphis Community Air Monitoring",
                    "kind": "campaign_boundary",
                },
            )
        ],
    }

    campaign = {
        "id": CAMPAIGN_ID,
        "slug": "southwest-memphis",
        "name": "Southwest Memphis Community Air Monitoring",
        "subtitle": "Boxtown · Westwood · White Chapel · Riverport corridor",
        "description": "A 90-day hyperlocal mobile-monitoring campaign across the "
        "Boxtown, Westwood, White Chapel and Riverport corridor of Southwest Memphis. "
        "Five instrumented vehicles repeatedly traverse every public road segment in "
        "the boundary, building a street-by-street record of seven pollutants and "
        "three derived indicators alongside the regulator's reference network.",
        "region": "Southwest Memphis",
        "state": "TN",
        "center_lon": CENTER[0],
        "center_lat": CENTER[1],
        "default_zoom": 12.6,
        "bbox_w": W,
        "bbox_s": S,
        "bbox_e": E,
        "bbox_n": N,
        "boundary_geojson": json.dumps(boundary_geojson),
        "start_date": start_day.isoformat(),
        "end_date": end_day.isoformat(),
        "status": "active",
        "fleet_size": len(VEHICLES),
        "target_passes": 25,
        "timezone": "America/Chicago",
        "created_at": (start - timedelta(days=21)).isoformat(timespec="seconds"),
    }

    # ---- monitors
    monitors: list[dict] = []
    for name, code, lon, lat, meas, status, blurb in REFERENCE_MONITORS:
        monitors.append(
            {
                "id": f"mon-ref-{code[-4:]}",
                "campaign_id": CAMPAIGN_ID,
                "name": name,
                "code": code,
                "owner_type": "regulator",
                "org_id": "org-draqa",
                "site_id": None,
                "lon": lon,
                "lat": lat,
                "elevation_m": 78.0,
                "grade": "reference",
                "status": status,
                "measures_json": json.dumps(meas),
                "radius_m": 2500.0,
                "install_date": (start - timedelta(days=1000 + 300 * len(monitors))).date().isoformat(),
                "last_calibrated": (end - timedelta(days=11 + 9 * len(monitors))).date().isoformat(),
                "blurb": blurb,
            }
        )
    rl = sites[0]
    for i, (tag, brg, meas, status) in enumerate(FENCELINE_RING):
        r = _ray_hit(rl.ring, rl.centroid, brg, proj, 430.0, 620.0)
        lon, lat = _offset(rl.centroid, brg, r, proj)
        monitors.append(
            {
                "id": f"mon-rlfl-{i + 1:02d}",
                "campaign_id": CAMPAIGN_ID,
                "name": f"Ridgeline fenceline {tag}",
                "code": f"RC-FL-{i + 1:02d}",
                "owner_type": "industry",
                "org_id": "org-ridgeline",
                "site_id": rl.id,
                "lon": round(lon, 6),
                "lat": round(lat, 6),
                "elevation_m": 76.0,
                "grade": "lowcost",
                "status": status,
                "measures_json": json.dumps(meas),
                "radius_m": 250.0,
                "install_date": (start - timedelta(days=140)).date().isoformat(),
                "last_calibrated": (end - timedelta(days=24 + 3 * i)).date().isoformat(),
                "blurb": f"Low-cost fenceline node on the {tag} boundary, {int(r + 55)} m "
                "from the campus centroid. Calibrated against DRAQA reference by "
                "co-location transfer.",
            }
        )
    for i, (name, lon, lat, meas, status, district) in enumerate(COMMUNITY_MONITORS):
        monitors.append(
            {
                "id": f"mon-baw-{i + 1:02d}",
                "campaign_id": CAMPAIGN_ID,
                "name": name,
                "code": f"BAW-{i + 1:02d}",
                "owner_type": "community",
                "org_id": "org-boxtown",
                "site_id": None,
                "lon": lon,
                "lat": lat,
                "elevation_m": 74.0,
                "grade": "lowcost",
                "status": status,
                "measures_json": json.dumps(meas),
                "radius_m": 400.0,
                "install_date": (start + timedelta(days=6 + 11 * i)).date().isoformat(),
                "last_calibrated": (start + timedelta(days=6 + 11 * i)).date().isoformat(),
                "blurb": f"Resident-hosted low-cost sensor in {district}, run by Boxtown "
                "Air Watch. Useful for trends, not for enforcement.",
            }
        )

    # ---- vehicles
    vehicles = []
    for i, (label, call, model, power, operator) in enumerate(VEHICLES):
        vehicles.append(
            {
                "id": f"veh-{label.lower()}",
                "campaign_id": CAMPAIGN_ID,
                "label": label,
                "call_sign": call,
                "model": model,
                "powertrain": power,
                "status": "idle",
                "operator_name": operator,
                "home_base_lon": DEPOT[0],
                "home_base_lat": DEPOT[1],
                "measures_json": json.dumps(FLEET_MEASURES),
            }
        )

    users = [
        {
            "id": uid,
            "name": name,
            "email": (
                "anton.vattay@aclima.earth"
                if uid == "usr-adm-01"
                else f"{name.split()[0].lower()}.{name.split()[-1].lower()}@example.invalid"
            ),
            "role": role,
            "org_id": org,
            "title": title,
            "avatar_emoji": emoji,
            "avatar_color": color,
            "neighborhood": hood,
            "joined_at": (start - timedelta(days=30 - i)).isoformat(timespec="seconds"),
            "is_demo_persona": 1,
        }
        for i, (uid, name, role, org, title, emoji, color, hood) in enumerate(USERS)
    ]

    return World(
        proj=proj,
        ways=ways,
        places=[p for p in places],
        parcels=parcels,
        boundary_ring=boundary_ring,
        boundary_geojson=boundary_geojson,
        campaign=campaign,
        orgs=list(ORGS),
        users=users,
        sites=sites,
        monitors=monitors,
        vehicles=vehicles,
        leaks=list(LEAKS),
        start=start,
        end=end,
        now=now,
        seed=seed,
    )


def inside_boundary(world: World, lon, lat):
    import numpy as np

    ring = np.array(world.boundary_ring, dtype=float)
    return ring_contains(ring, lon, lat)
