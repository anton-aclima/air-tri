"""OpenStreetMap ingest for the `air` simulation.

Downloads the real road network, industrial parcels and neighbourhood place nodes
for the campaign bbox from the Overpass API, and caches every response under
``data/cache/``.  Overpass is slow and rate-limited: **a cached file is never
re-fetched**.  Delete ``data/cache/*.json`` by hand if you truly want fresh data.

Nothing in this module is random -- it is pure I/O plus light parsing, so the rest
of the pipeline stays deterministic.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_MIRRORS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
)

# Campaign bbox: -90.190, 35.020 -> -90.075, 35.115  (west, south, east, north)
BBOX = (-90.190, 35.020, -90.075, 35.115)

DRIVABLE = (
    "motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street"
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CACHE_DIR = REPO_ROOT / "data" / "cache"


def _bbox_str(bbox: tuple[float, float, float, float]) -> str:
    """Overpass wants (south, west, north, east)."""
    w, s, e, n = bbox
    return f"{s},{w},{n},{e}"


def query_roads(bbox=BBOX) -> str:
    return f"""
[out:json][timeout:180];
way["highway"~"^({DRIVABLE})$"]({_bbox_str(bbox)});
out geom;
""".strip()


def query_industrial(bbox=BBOX) -> str:
    return f"""
[out:json][timeout:180];
(
  way["landuse"="industrial"]({_bbox_str(bbox)});
  relation["landuse"="industrial"]({_bbox_str(bbox)});
);
out geom;
""".strip()


PLACE_KINDS = "neighbourhood|suburb|quarter|hamlet|village|island|locality"


def query_places(bbox=BBOX) -> str:
    """Neighbourhood-scale place nodes.

    SW Memphis is thinly tagged, so we take hamlet/island/locality too -- that is
    where Boxtown, White Chapel, Wyanoke, Darwin and President's Island live.
    A small pad picks up anchors just outside the bbox whose territory reaches in.
    """
    return f"""
[out:json][timeout:180];
node["place"~"^({PLACE_KINDS})$"]({_bbox_str(_pad(bbox, 0.012))});
out body;
""".strip()


def _pad(bbox, d):
    w, s, e, n = bbox
    return (w - d, s - d, e + d, n + d)


def fetch(
    name: str,
    query: str,
    *,
    cache_dir: Path | None = None,
    min_elements: int = 1,
) -> dict:
    """POST `query` to Overpass, caching the JSON under data/cache/<name>.json.

    Returns the parsed response.  Never re-fetches if the cache file exists.

    Some Overpass load-balancer nodes answer 200 OK from a stale/empty database.
    `min_elements` guards against silently caching one of those: a response with
    fewer elements is treated as a failure and the next mirror is tried.
    """
    cache_dir = cache_dir or CACHE_DIR
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"{name}.json"
    if path.exists():
        with path.open() as fh:
            return json.load(fh)

    body = urllib.parse.urlencode({"data": query}).encode()
    last_err: Exception | None = None
    for attempt, url in enumerate(OVERPASS_MIRRORS * 2):
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={
                    "User-Agent": "air-prototype/0.1 (aclima demo; contact: dev@example.invalid)",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )
            with urllib.request.urlopen(req, timeout=240) as resp:
                raw = resp.read()
            data = json.loads(raw)
            if "elements" not in data:
                raise ValueError(f"unexpected Overpass payload: {raw[:200]!r}")
            if len(data["elements"]) < min_elements:
                raise ValueError(
                    f"Overpass mirror {url} returned only "
                    f"{len(data['elements'])} elements for {name!r} "
                    f"(base {data.get('osm3s', {}).get('timestamp_osm_base')}) "
                    "-- looks like a stale node"
                )
            path.write_text(json.dumps(data))
            return data
        except Exception as exc:  # noqa: BLE001 - mirror fallback
            last_err = exc
            time.sleep(3 + 4 * attempt)
    raise RuntimeError(f"Overpass fetch for {name!r} failed: {last_err}")


# ------------------------------------------------------------------ parsing


@dataclass(frozen=True)
class Way:
    osm_id: int
    name: str | None
    road_class: str
    coords: tuple[tuple[float, float], ...]  # [(lon, lat), ...]
    oneway: bool
    lanes: int | None


@dataclass(frozen=True)
class Parcel:
    osm_id: int
    name: str | None
    ring: tuple[tuple[float, float], ...]
    area_m2: float
    centroid: tuple[float, float]


@dataclass(frozen=True)
class Place:
    osm_id: int
    name: str
    kind: str
    lon: float
    lat: float


def parse_roads(payload: dict) -> list[Way]:
    ways: list[Way] = []
    for el in payload.get("elements", []):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        tags = el.get("tags", {})
        hw = tags.get("highway")
        if hw not in DRIVABLE.split("|"):
            continue
        coords = tuple((float(p["lon"]), float(p["lat"])) for p in geom)
        lanes = tags.get("lanes")
        try:
            lanes_i = int(str(lanes).split(";")[0]) if lanes else None
        except ValueError:
            lanes_i = None
        ways.append(
            Way(
                osm_id=int(el["id"]),
                name=tags.get("name"),
                road_class=hw,
                coords=coords,
                oneway=tags.get("oneway") in ("yes", "1", "-1", "true"),
                lanes=lanes_i,
            )
        )
    ways.sort(key=lambda w: w.osm_id)
    return ways


def _ring_area_m2(ring) -> float:
    """Shoelace area in m^2 using a local equirectangular projection."""
    if len(ring) < 3:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    import math

    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 110540.0
    a = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i][0] * kx, ring[i][1] * ky
        x2, y2 = ring[(i + 1) % len(ring)][0] * kx, ring[(i + 1) % len(ring)][1] * ky
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def parse_parcels(payload: dict) -> list[Parcel]:
    out: list[Parcel] = []
    for el in payload.get("elements", []):
        tags = el.get("tags", {})
        rings: list[list[tuple[float, float]]] = []
        if el.get("type") == "way" and el.get("geometry"):
            rings.append([(float(p["lon"]), float(p["lat"])) for p in el["geometry"]])
        elif el.get("type") == "relation":
            for m in el.get("members", []):
                if m.get("role") == "outer" and m.get("geometry"):
                    rings.append([(float(p["lon"]), float(p["lat"])) for p in m["geometry"]])
        for ring in rings:
            if len(ring) < 4:
                continue
            area = _ring_area_m2(ring)
            if area < 4000:  # ignore slivers
                continue
            cx = sum(p[0] for p in ring) / len(ring)
            cy = sum(p[1] for p in ring) / len(ring)
            out.append(
                Parcel(
                    osm_id=int(el["id"]),
                    name=tags.get("name"),
                    ring=tuple(ring),
                    area_m2=area,
                    centroid=(cx, cy),
                )
            )
    out.sort(key=lambda p: (-p.area_m2, p.osm_id))
    return out


def parse_places(payload: dict) -> list[Place]:
    seen: set[int] = set()
    out: list[Place] = []
    for el in payload.get("elements", []):
        if el.get("type") != "node":
            continue
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name or int(el["id"]) in seen:
            continue
        if tags.get("place") not in PLACE_KINDS.split("|"):
            continue
        seen.add(int(el["id"]))
        out.append(
            Place(
                osm_id=int(el["id"]),
                name=name,
                kind=tags.get("place", "neighbourhood"),
                lon=float(el["lon"]),
                lat=float(el["lat"]),
            )
        )
    out.sort(key=lambda p: p.osm_id)
    return out


@dataclass
class OsmBundle:
    ways: list[Way] = field(default_factory=list)
    parcels: list[Parcel] = field(default_factory=list)
    places: list[Place] = field(default_factory=list)


def load_osm(bbox=BBOX, cache_dir: Path | None = None) -> OsmBundle:
    roads = fetch("osm_roads", query_roads(bbox), cache_dir=cache_dir, min_elements=200)
    industrial = fetch(
        "osm_industrial", query_industrial(bbox), cache_dir=cache_dir, min_elements=5
    )
    places = fetch("osm_places", query_places(bbox), cache_dir=cache_dir, min_elements=3)
    return OsmBundle(
        ways=parse_roads(roads),
        parcels=parse_parcels(industrial),
        places=parse_places(places),
    )


if __name__ == "__main__":  # pragma: no cover - manual cache warm-up
    b = load_osm()
    print(f"ways={len(b.ways)} parcels={len(b.parcels)} places={len(b.places)}")
    for p in b.places[:40]:
        print("  place:", p.name, p.kind, round(p.lon, 4), round(p.lat, 4))
    for p in b.parcels[:15]:
        print("  parcel:", p.name, int(p.area_m2), [round(c, 4) for c in p.centroid])
