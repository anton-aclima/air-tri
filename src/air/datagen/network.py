"""Step 2 -- segmentation.

Cuts the real OSM ways into ~200 m `road_segment` rows, the atom of the whole
product.  Three stages:

1. **Topology.**  A coordinate shared by two or more ways (or visited twice by one
   way) is an intersection node.  Every way is split there into *links*.
2. **Cutting.**  Each link is cut into pieces of `target_len_m` (200 m) with the
   remainder distributed evenly, so a 470 m link becomes 2 x 235 m rather than
   200 + 200 + 70.  Links shorter than `min_len_m` stay whole.
3. **Clipping + labelling.**  A segment is kept when its midpoint is inside the
   campaign boundary.  Its `district` is the nearest real OSM neighbourhood node.

Segment ids are `seg-<osm_way_id>-<link>-<piece>`: stable across rebuilds as long
as the OSM cache does not change, which is exactly what a demo database wants.

The same pass builds the **drive graph** used by `driveplan.py`: nodes are segment
end points keyed by rounded coordinate, edges are segments.  Nothing here is
random.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np

from .geo import Projector, bearing_deg, cumulative_m, ring_contains, slice_polyline

# Relative traffic emission weight per OSM highway class.  Drives the line-source
# layer in field.py and the vehicle speed model in driveplan.py.
ROAD_WEIGHT = {
    "motorway": 1.00,
    "trunk": 0.82,
    "primary": 0.68,
    "secondary": 0.52,
    "tertiary": 0.34,
    "unclassified": 0.20,
    "residential": 0.10,
    "living_street": 0.05,
}
ROAD_SPEED_KPH = {
    "motorway": 88.0,
    "trunk": 68.0,
    "primary": 55.0,
    "secondary": 46.0,
    "tertiary": 38.0,
    "unclassified": 30.0,
    "residential": 22.0,
    "living_street": 14.0,
}

NODE_PRECISION = 7


def _key(c) -> tuple[float, float]:
    return (round(c[0], NODE_PRECISION), round(c[1], NODE_PRECISION))


@dataclass
class Segment:
    id: str
    osm_way_id: int
    name: str | None
    road_class: str
    district: str | None
    coords: list[tuple[float, float]]
    length_m: float
    mid_lon: float
    mid_lat: float
    bearing_deg: float
    node_a: int
    node_b: int

    def row(self, campaign_id: str) -> dict:
        return {
            "id": self.id,
            "campaign_id": campaign_id,
            "osm_way_id": self.osm_way_id,
            "name": self.name,
            "road_class": self.road_class,
            "district": self.district,
            "geometry_json": json.dumps([[round(x, 6), round(y, 6)] for x, y in self.coords]),
            "length_m": round(self.length_m, 1),
            "mid_lon": round(self.mid_lon, 6),
            "mid_lat": round(self.mid_lat, 6),
            "bearing_deg": round(self.bearing_deg, 1),
        }


@dataclass
class Graph:
    """Undirected multigraph over segments."""

    segments: list[Segment]
    node_xy: list[tuple[float, float]] = field(default_factory=list)  # metres
    node_lonlat: list[tuple[float, float]] = field(default_factory=list)
    adj: dict[int, list[tuple[int, int]]] = field(default_factory=dict)  # node -> [(other, edge_id)]
    index: dict[str, int] = field(default_factory=dict)
    # virtual deadhead-only edges: (node_a, node_b, length_m); edge id is -(k+1)
    connectors: list[tuple[int, int, float]] = field(default_factory=list)

    def neighbours(self, n: int):
        return self.adj.get(n, [])


def build_segments(
    world,
    *,
    target_len_m: float = 200.0,
    min_len_m: float = 55.0,
) -> tuple[list[Segment], Graph]:
    proj: Projector = world.proj
    ring = np.array(world.boundary_ring, dtype=float)

    # ---- 1. intersection nodes
    counts: dict[tuple[float, float], int] = defaultdict(int)
    for w in world.ways:
        seen_in_way: set[tuple[float, float]] = set()
        for c in w.coords:
            k = _key(c)
            if k in seen_in_way:
                counts[k] += 1  # self-touch
            else:
                seen_in_way.add(k)
                counts[k] += 1
    junction = {k for k, n in counts.items() if n >= 2}

    # ---- 2. split ways into links, cut links into pieces
    segments: list[Segment] = []
    node_ids: dict[tuple[float, float], int] = {}
    node_lonlat: list[tuple[float, float]] = []

    def node_id(c) -> int:
        k = _key(c)
        nid = node_ids.get(k)
        if nid is None:
            nid = len(node_lonlat)
            node_ids[k] = nid
            node_lonlat.append(k)
        return nid

    for w in world.ways:
        # break points: way ends plus interior junctions
        breaks = [0]
        for i in range(1, len(w.coords) - 1):
            if _key(w.coords[i]) in junction:
                breaks.append(i)
        breaks.append(len(w.coords) - 1)
        breaks = sorted(set(breaks))
        for li in range(len(breaks) - 1):
            link = list(w.coords[breaks[li] : breaks[li + 1] + 1])
            if len(link) < 2:
                continue
            cum = cumulative_m(link, proj)
            total = cum[-1]
            if total < 1.0:
                continue
            n_pieces = max(1, int(round(total / target_len_m)))
            if total / n_pieces < min_len_m and n_pieces > 1:
                n_pieces = max(1, int(total // min_len_m))
            for pi in range(n_pieces):
                d0 = total * pi / n_pieces
                d1 = total * (pi + 1) / n_pieces
                coords = slice_polyline(link, cum, d0, d1)
                if len(coords) < 2:
                    continue
                seg_len = d1 - d0
                mid = ((coords[0][0] + coords[-1][0]) / 2, (coords[0][1] + coords[-1][1]) / 2)
                # true midpoint along the arc reads better on the map
                from .geo import point_at_distance

                scum = cumulative_m(coords, proj)
                mid = point_at_distance(coords, scum, scum[-1] / 2)
                segments.append(
                    Segment(
                        id=f"seg-{w.osm_id}-{li}-{pi}",
                        osm_way_id=w.osm_id,
                        name=w.name,
                        road_class=w.road_class,
                        district=None,
                        coords=coords,
                        length_m=seg_len,
                        mid_lon=mid[0],
                        mid_lat=mid[1],
                        bearing_deg=bearing_deg(coords[0], coords[-1], proj),
                        node_a=node_id(coords[0]),
                        node_b=node_id(coords[-1]),
                    )
                )

    # ---- 3. clip to the boundary by midpoint
    mlon = np.array([s.mid_lon for s in segments])
    mlat = np.array([s.mid_lat for s in segments])
    keep = ring_contains(ring, mlon, mlat)
    segments = [s for s, k in zip(segments, keep) if k]

    # ---- districts from the real place nodes
    places = [p for p in world.places]
    if places:
        px, py = proj.xy_arr(
            np.array([p.lon for p in places]), np.array([p.lat for p in places])
        )
        sx, sy = proj.xy_arr(
            np.array([s.mid_lon for s in segments]), np.array([s.mid_lat for s in segments])
        )
        d2 = (sx[:, None] - px[None, :]) ** 2 + (sy[:, None] - py[None, :]) ** 2
        nearest = np.argmin(d2, axis=1)
        for s, j in zip(segments, nearest):
            s.district = places[int(j)].name

    segments.sort(key=lambda s: s.id)

    # ---- 4. graph over the surviving segments
    used_nodes = sorted({n for s in segments for n in (s.node_a, s.node_b)})
    remap = {old: i for i, old in enumerate(used_nodes)}
    g = Graph(segments=segments)
    g.node_lonlat = [node_lonlat[o] for o in used_nodes]
    g.node_xy = [proj.xy(*ll) for ll in g.node_lonlat]
    g.adj = {i: [] for i in range(len(used_nodes))}
    for si, s in enumerate(segments):
        s.node_a = remap[s.node_a]
        s.node_b = remap[s.node_b]
        g.index[s.id] = si
        g.adj[s.node_a].append((s.node_b, si))
        if s.node_b != s.node_a:
            g.adj[s.node_b].append((s.node_a, si))
    return segments, g


def largest_connected(g: Graph) -> set[int]:
    """Segment indices in the largest connected component of the drive graph."""
    seen_nodes: set[int] = set()
    best: set[int] = set()
    for start in range(len(g.node_xy)):
        if start in seen_nodes:
            continue
        stack = [start]
        comp_nodes = {start}
        comp_segs: set[int] = set()
        seen_nodes.add(start)
        while stack:
            n = stack.pop()
            for other, si in g.adj[n]:
                comp_segs.add(si)
                if other not in comp_nodes:
                    comp_nodes.add(other)
                    seen_nodes.add(other)
                    stack.append(other)
        if len(comp_segs) > len(best):
            best = comp_segs
    return best


def stats(segments: list[Segment]) -> dict:
    by_class: dict[str, int] = defaultdict(int)
    by_district: dict[str, int] = defaultdict(int)
    for s in segments:
        by_class[s.road_class] += 1
        by_district[s.district or "-"] += 1
    lens = [s.length_m for s in segments]
    return {
        "n_segments": len(segments),
        "total_km": round(sum(lens) / 1000, 1),
        "mean_len_m": round(sum(lens) / max(1, len(lens)), 1),
        "min_len_m": round(min(lens), 1) if lens else 0,
        "max_len_m": round(max(lens), 1) if lens else 0,
        "by_class": dict(sorted(by_class.items(), key=lambda kv: -kv[1])),
        "by_district": dict(sorted(by_district.items(), key=lambda kv: -kv[1])),
    }


# ---------------------------------------------------------------- connectivity

# Aclima drives public roads, so `service` ways and `*_link` ramps are not fetched.
# That leaves real gaps in the graph -- most importantly the causeway onto
# President's Island.  We bridge such gaps with *virtual connector* edges: they are
# drivable for deadheading but are never `road_segment` rows and never collect
# passes.  Edge index is negative for a connector, non-negative for a segment.


def add_virtual_connectors(g: Graph, max_m: float = 1400.0) -> list[tuple[int, int, float]]:
    """Join disconnected components to the main one while the gap is plausible."""
    connectors: list[tuple[int, int, float]] = []
    xy = np.array(g.node_xy, dtype=float)
    while True:
        comps = _node_components(g)
        if len(comps) <= 1:
            break
        comps.sort(key=len, reverse=True)
        main = np.array(sorted(comps[0]))
        best = None
        for c in comps[1:]:
            idx = np.array(sorted(c))
            d = np.hypot(
                xy[idx][:, None, 0] - xy[main][None, :, 0],
                xy[idx][:, None, 1] - xy[main][None, :, 1],
            )
            k = int(np.argmin(d))
            i, j = divmod(k, d.shape[1])
            if best is None or d[i, j] < best[0]:
                best = (float(d[i, j]), int(idx[i]), int(main[j]))
        if best is None or best[0] > max_m:
            break
        dist, a, b = best
        eid = -(len(connectors) + 1)
        g.adj[a].append((b, eid))
        g.adj[b].append((a, eid))
        connectors.append((a, b, dist))
    g.connectors = connectors  # type: ignore[attr-defined]
    return connectors


def _node_components(g: Graph) -> list[set[int]]:
    seen: set[int] = set()
    out: list[set[int]] = []
    for start in range(len(g.node_xy)):
        if start in seen:
            continue
        stack = [start]
        comp = {start}
        seen.add(start)
        while stack:
            n = stack.pop()
            for other, _ in g.adj[n]:
                if other not in comp:
                    comp.add(other)
                    seen.add(other)
                    stack.append(other)
        out.append(comp)
    return out


def restrict_to_largest(segments: list[Segment], g: Graph) -> tuple[list[Segment], Graph]:
    """Drop segments the fleet cannot reach, then rebuild the graph.

    A real drive plan cannot include an unreachable stub, and a permanently blank
    street on the hero map reads as a bug rather than as honesty.
    """
    comps = _node_components(g)
    comps.sort(key=len, reverse=True)
    keep_nodes = comps[0]
    kept = [s for s in segments if s.node_a in keep_nodes and s.node_b in keep_nodes]
    if len(kept) == len(segments):
        return segments, g
    old_conn = getattr(g, "connectors", [])
    used = sorted({n for s in kept for n in (s.node_a, s.node_b)})
    remap = {o: i for i, o in enumerate(used)}
    g2 = Graph(segments=kept)
    g2.node_lonlat = [g.node_lonlat[o] for o in used]
    g2.node_xy = [g.node_xy[o] for o in used]
    g2.adj = {i: [] for i in range(len(used))}
    for si, s in enumerate(kept):
        s.node_a = remap[s.node_a]
        s.node_b = remap[s.node_b]
        g2.index[s.id] = si
        g2.adj[s.node_a].append((s.node_b, si))
        if s.node_b != s.node_a:
            g2.adj[s.node_b].append((s.node_a, si))
    conns: list[tuple[int, int, float]] = []
    for a, b, d in old_conn:
        if a in remap and b in remap:
            eid = -(len(conns) + 1)
            g2.adj[remap[a]].append((remap[b], eid))
            g2.adj[remap[b]].append((remap[a], eid))
            conns.append((remap[a], remap[b], d))
    g2.connectors = conns  # type: ignore[attr-defined]
    return kept, g2


def build_network(world, **kw) -> tuple[list[Segment], Graph]:
    """Full step 2: segment, bridge the plausible gaps, drop the unreachable rest."""
    segments, g = build_segments(world, **kw)
    add_virtual_connectors(g)
    return restrict_to_largest(segments, g)
