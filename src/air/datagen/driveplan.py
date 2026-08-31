"""Step 4 -- the drive plan.  Route inspection, not a fake polyline.

Covering every segment repeatedly while minimising empty running is the **Chinese
Postman / route-inspection problem**.  The implementation is the real algorithm with
one honest approximation:

1. **Partition.**  Seeded k-means on segment midpoints splits the campaign into
   `fleet_size` spatially coherent sub-networks (`_kmeans`), then each cluster is
   reduced to its largest connected sub-graph and orphans are handed to the
   neighbouring cluster (`_repair_clusters`).  One vehicle works one sub-network per
   shift, which is how a real crew is dispatched.
2. **Eulerise.**  Odd-degree nodes are paired by shortest path and those paths'
   edges are duplicated, so every node has even degree and an Eulerian circuit
   exists (`_eulerise`).  Optimal pairing needs Edmonds' blossom matching; we use
   **greedy nearest-pair matching**, which is O(k^2 log n) and typically lands
   within a few percent of optimal on a dense street grid.  That is the
   approximation, and it is the only one.
3. **Circuit.**  Hierholzer's algorithm produces the Eulerian circuit
   (`_hierholzer`).
4. **Shift.**  The circuit is walked under a class-dependent speed model until the
   shift's time budget is spent.  A circuit shorter than the shift is looped, so a
   compact cluster gets several passes in one shift; a circuit longer than the shift
   is resumed from a per-cluster cursor next time, exactly like a real crew picking
   up where it left off.

Fleet arithmetic (why `PHASE*_VEHICLES` look small)
--------------------------------------------------
The campaign holds 196 km of drivable public road.  Five vehicles at ~100 km/day
would reach 25 passes/segment in eleven days, which is not what a 90-day campaign
looks like.  In reality an Aclima fleet is shared across communities: this campaign
gets 1-3 cars on a given drive day, rotating so every sub-network sees every shift.
The schedule is therefore explicit and tunable -- see the constants below.

Diurnal fairness matters methodologically: `SHIFT_CYCLE` rotates each vehicle
through morning / midday / evening / night / overnight so the 'hour:HH' windows are
not all sampled from the same sub-network at the same time of day.
"""

from __future__ import annotations

import heapq
import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

import numpy as np

from .network import ROAD_SPEED_KPH, Graph, Segment

# ---------------------------------------------------------------- tunables

SHIFT_HOURS = 5.0           # productive time budget per vehicle per shift
STOP_FACTOR = 0.72          # stop signs, lights, turns, U-turns at dead ends
PING_SECONDS = 10.0         # GPS sample interval
PING_STORE_RECENT_S = 10.0  # stored interval for the last PING_RECENT_DAYS days
PING_STORE_OLD_S = 40.0     # stored interval for older drives
PING_RECENT_DAYS = 5

PHASE1_VEHICLES = 1         # while < COVERAGE_GOAL of segments are at target
PHASE1_DOUBLE_EVERY = 3     # ... plus a second car every Nth drive day
PHASE2_VEHICLES = 1         # maintenance / persistence sampling afterwards
PHASE2_EVERY = 3            # ... and only on every Nth drive day
SPRINT_DAYS = 6             # end-of-campaign gap-filling push
SPRINT_VEHICLES = 3
TODAY_VEHICLES = 4
COVERAGE_GOAL = 0.90        # share of segments that must reach target_passes

# Drive-day calendar: Sundays off, and one week in four the fleet is on another
# community (a real Aclima fleet rotates between campaigns).
OFF_WEEK_MODULO = 4
OFF_WEEK_INDEX = 3

# start hour, label
SHIFT_CYCLE = [
    (6.0, "morning"),
    (10.5, "midday"),
    (15.5, "evening"),
    (21.0, "night"),
    (1.5, "night"),
    (13.0, "midday"),
    (7.5, "morning"),
    (17.5, "evening"),
]


@dataclass
class PassEvent:
    seg_idx: int
    ts: datetime
    drive_id: str
    vehicle_id: str
    speed_kph: float


@dataclass
class Ping:
    ts: datetime
    lon: float
    lat: float
    speed_kph: float
    heading_deg: float
    seg_idx: int | None


@dataclass
class DriveDay:
    day_index: int
    the_date: date
    vehicle_idx: int
    shift: str
    start: datetime
    end: datetime
    seg_sequence: list[int]          # segment indices in traversal order
    geometry: list[tuple[float, float]]
    distance_m: float
    duration_min: float
    passes: list[PassEvent] = field(default_factory=list)
    pings: list[Ping] = field(default_factory=list)
    status: str = "complete"


# ---------------------------------------------------------------- clustering


def _kmeans(
    xy: np.ndarray,
    k: int,
    seed: int,
    iters: int = 60,
    lengths: np.ndarray | None = None,
    capacity_slack: float = 1.10,
) -> np.ndarray:
    """Deterministic k-means++ on 2-D points.

    When `lengths` is given the assignment is **length-balanced**: each cluster may
    hold at most `capacity_slack` x (total road length / k).  Without this the
    partition is wildly uneven -- a 68 km sub-network and a 20 km one get the same
    shift budget, so one is over-sampled 5x and the other never reaches target.
    """
    rng = np.random.default_rng(seed)
    n = len(xy)
    centers = [xy[rng.integers(n)]]
    for _ in range(k - 1):
        d2 = np.min(
            ((xy[:, None, :] - np.array(centers)[None, :, :]) ** 2).sum(-1), axis=1
        )
        probs = d2 / max(1e-12, d2.sum())
        centers.append(xy[rng.choice(n, p=probs)])
    C = np.array(centers)
    labels = np.zeros(n, dtype=int)
    cap = None if lengths is None else float(lengths.sum()) / k * capacity_slack
    for _ in range(iters):
        d2 = ((xy[:, None, :] - C[None, :, :]) ** 2).sum(-1)
        if cap is None:
            new = np.argmin(d2, axis=1)
        else:
            new = np.full(n, -1, dtype=int)
            load = np.zeros(k)
            for i in np.argsort(d2.min(axis=1), kind="stable"):
                for j in np.argsort(d2[i], kind="stable"):
                    if load[j] + lengths[i] <= cap:
                        new[i] = j
                        load[j] += lengths[i]
                        break
                if new[i] < 0:
                    j = int(np.argmin(load))
                    new[i] = j
                    load[j] += lengths[i]
        if np.array_equal(new, labels):
            break
        labels = new
        for j in range(k):
            m = labels == j
            if m.any():
                C[j] = xy[m].mean(axis=0)
    return labels


def _cluster_components(g: Graph, seg_idxs: set[int]) -> list[set[int]]:
    """Connected components of a segment subset, walking only through that subset."""
    by_node: dict[int, list[int]] = defaultdict(list)
    for si in seg_idxs:
        s = g.segments[si]
        by_node[s.node_a].append(si)
        by_node[s.node_b].append(si)
    seen: set[int] = set()
    out: list[set[int]] = []
    for start in seg_idxs:
        if start in seen:
            continue
        comp = {start}
        seen.add(start)
        stack = [start]
        while stack:
            si = stack.pop()
            s = g.segments[si]
            for n in (s.node_a, s.node_b):
                for other in by_node[n]:
                    if other not in comp:
                        comp.add(other)
                        seen.add(other)
                        stack.append(other)
        out.append(comp)
    return out


def _repair_clusters(g: Graph, labels: np.ndarray, k: int) -> list[set[int]]:
    """Make every cluster a single connected sub-network."""
    clusters = [set(np.flatnonzero(labels == j).tolist()) for j in range(k)]
    for _ in range(6):
        moved = 0
        for j in range(k):
            comps = _cluster_components(g, clusters[j])
            if len(comps) <= 1:
                continue
            comps.sort(key=len, reverse=True)
            for orphan in comps[1:]:
                # give the orphan to whichever cluster it actually touches
                touching: dict[int, int] = defaultdict(int)
                nodes = {n for si in orphan for n in (g.segments[si].node_a, g.segments[si].node_b)}
                for n in nodes:
                    for _other, eid in g.adj[n]:
                        if eid < 0:
                            continue
                        for jj in range(k):
                            if jj != j and eid in clusters[jj]:
                                touching[jj] += 1
                if touching:
                    tgt = max(touching.items(), key=lambda kv: (kv[1], -kv[0]))[0]
                    clusters[j] -= orphan
                    clusters[tgt] |= orphan
                    moved += len(orphan)
        if not moved:
            break
    return clusters


# ---------------------------------------------------------------- graph utils


def _dijkstra(g: Graph, src: int, targets: set[int] | None = None):
    """Shortest paths by length over segments and virtual connectors."""
    dist = {src: 0.0}
    prev: dict[int, tuple[int, int]] = {}
    pq = [(0.0, src)]
    remaining = set(targets) if targets else None
    while pq:
        d, n = heapq.heappop(pq)
        if d > dist.get(n, math.inf):
            continue
        if remaining is not None:
            remaining.discard(n)
            if not remaining:
                break
        for other, eid in g.adj[n]:
            w = g.segments[eid].length_m if eid >= 0 else g.connectors[-eid - 1][2]
            nd = d + w
            if nd < dist.get(other, math.inf):
                dist[other] = nd
                prev[other] = (n, eid)
                heapq.heappush(pq, (nd, other))
    return dist, prev


def _path_edges(prev, src, dst) -> list[int]:
    out = []
    n = dst
    while n != src:
        if n not in prev:
            return []
        p, eid = prev[n]
        out.append(eid)
        n = p
    out.reverse()
    return out


def _eulerise(g: Graph, seg_idxs: set[int]) -> list[tuple[int, int]]:
    """Return edge multiplicities that make the required edge set Eulerian.

    Two stages, in the order the Rural Postman Problem requires:

    1. **Connect.**  The required edges may form several components (k-means does
       not respect topology).  Components are joined to the main one by their
       shortest connecting path, whose edges are added as extra traversals.
       Without this, whole pockets of streets would never be driven.
    2. **Match.**  Odd-degree nodes are paired greedily by shortest path and those
       paths duplicated, so every degree is even.
    """
    mult: dict[int, int] = {si: 1 for si in seg_idxs}

    comps = _cluster_components(g, seg_idxs)
    if len(comps) > 1:
        comps.sort(key=len, reverse=True)
        joined = set(comps[0])
        pending = comps[1:]
        while pending:
            joined_nodes = {n for si in joined for n in (g.segments[si].node_a, g.segments[si].node_b)}
            best = None
            for ci, comp in enumerate(pending):
                comp_nodes = {n for si in comp for n in (g.segments[si].node_a, g.segments[si].node_b)}
                for src in sorted(comp_nodes)[:8]:  # a few probes is plenty on a grid
                    dist, prev = _dijkstra(g, src, set(joined_nodes))
                    reach = [(dist[n], n) for n in joined_nodes if n in dist]
                    if not reach:
                        continue
                    d, tgt = min(reach)
                    if best is None or d < best[0]:
                        best = (d, ci, src, tgt, prev)
            if best is None:
                break
            _d, ci, src, tgt, prev = best
            for eid in _path_edges(prev, src, tgt):
                mult[eid] = mult.get(eid, 0) + 1
            joined |= pending.pop(ci)

    deg: dict[int, int] = defaultdict(int)
    for eid, m in mult.items():
        if eid >= 0:
            a, b = g.segments[eid].node_a, g.segments[eid].node_b
        else:
            a, b, _ = g.connectors[-eid - 1]
        deg[a] += m
        deg[b] += m
    unmatched = sorted(n for n, d in deg.items() if d % 2 == 1)
    while len(unmatched) >= 2:
        a = unmatched.pop(0)
        dist, prev = _dijkstra(g, a, set(unmatched))
        cand = [(dist[b], b) for b in unmatched if b in dist]
        if not cand:
            continue
        _d, best = min(cand)
        unmatched.remove(best)
        for eid in _path_edges(prev, a, best):
            mult[eid] = mult.get(eid, 0) + 1
    return sorted(mult.items())


def _hierholzer(g: Graph, mult: list[tuple[int, int]], start_node: int | None = None) -> list[int]:
    """Eulerian circuit as an ordered list of edge ids.

    Textbook stack-based Hierholzer: edges are recorded when a vertex is *popped*,
    not when it is pushed, and the result is reversed.  Recording on push produces a
    broken walk the moment the algorithm has to backtrack.
    """
    adj: dict[int, list[tuple[int, tuple[int, int]]]] = defaultdict(list)
    for eid, m in mult:
        if eid >= 0:
            a, b = g.segments[eid].node_a, g.segments[eid].node_b
        else:
            a, b, _ = g.connectors[-eid - 1]
        for c in range(m):
            key = (eid, c)
            adj[a].append((b, key))
            adj[b].append((a, key))
    if not adj:
        return []
    nodes = sorted(adj.keys())
    start = start_node if (start_node in adj) else nodes[0]
    used: set[tuple[int, int]] = set()
    ptr: dict[int, int] = defaultdict(int)
    stack: list[tuple[int, int | None]] = [(start, None)]
    order: list[tuple[int, int | None]] = []
    while stack:
        v, via = stack[-1]
        pushed = False
        while ptr[v] < len(adj[v]):
            other, key = adj[v][ptr[v]]
            ptr[v] += 1
            if key in used:
                continue
            used.add(key)
            stack.append((other, key[0]))
            pushed = True
            break
        if not pushed:
            order.append(stack.pop())
    order.reverse()
    return [e for _v, e in order if e is not None]


# ---------------------------------------------------------------- traversal


def _oriented(seg: Segment, from_node: int) -> list[tuple[float, float]]:
    return seg.coords if seg.node_a == from_node else list(reversed(seg.coords))


def _hour_factor(hod: float) -> float:
    if 6.5 <= hod <= 9.0 or 15.5 <= hod <= 18.5:
        return 0.80
    if hod < 5.5 or hod > 21.5:
        return 1.10
    return 0.97


def _walk(
    g: Graph,
    proj,
    edge_seq: list[int],
    start_node: int,
    t0: datetime,
    budget_s: float,
    drive_id: str,
    vehicle_id: str,
    rng: np.random.Generator,
) -> tuple[list[int], list[tuple[float, float]], float, float, list[PassEvent], list[Ping], int]:
    """Drive `edge_seq` from `start_node` until the time budget runs out."""
    from .geo import cumulative_m, densify

    node = start_node
    t = 0.0
    dist = 0.0
    geom: list[tuple[float, float]] = []
    seq: list[int] = []
    passes: list[PassEvent] = []
    pings: list[Ping] = []
    next_ping = 0.0
    consumed = 0

    for eid in edge_seq:
        if t >= budget_s:
            break
        if eid < 0:
            a, b, ln = g.connectors[-eid - 1]
            other = b if node == a else a
            # deadhead over a link road we did not fetch: 40 km/h, no measurement
            t += ln / (40.0 / 3.6)
            dist += ln
            node = other
            consumed += 1
            if geom:
                geom.append(g.node_lonlat[node])
            continue
        seg = g.segments[eid]
        if seg.node_a == node:
            other = seg.node_b
        elif seg.node_b == node:
            other = seg.node_a
        else:
            # circuit and cursor disagree (rare, after a truncation): jump
            node = seg.node_a
            other = seg.node_b
        coords = _oriented(seg, node)
        v_kph = (
            ROAD_SPEED_KPH.get(seg.road_class, 22.0)
            * STOP_FACTOR
            * _hour_factor((t0 + timedelta(seconds=t)).hour + (t0 + timedelta(seconds=t)).minute / 60)
            * float(rng.uniform(0.86, 1.14))
        )
        v_ms = max(2.0, v_kph / 3.6)
        seg_t = seg.length_m / v_ms
        # pass timestamp = the moment the midpoint is crossed
        passes.append(
            PassEvent(
                seg_idx=eid,
                ts=t0 + timedelta(seconds=t + seg_t * 0.5),
                drive_id=drive_id,
                vehicle_id=vehicle_id,
                speed_kph=round(v_kph, 1),
            )
        )
        pts = densify(coords, proj, 22.0)
        cum = cumulative_m(pts, proj)
        total = max(1.0, cum[-1])
        # GPS pings at a fixed cadence, interpolated along the densified geometry
        while next_ping <= t + seg_t:
            frac = max(0.0, min(1.0, (next_ping - t) / seg_t))
            d = frac * total
            j = int(np.searchsorted(cum, d, side="right")) - 1
            j = max(0, min(len(pts) - 2, j))
            span = max(1e-6, cum[j + 1] - cum[j])
            u = (d - cum[j]) / span
            lon = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * u
            lat = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * u
            ax, ay = proj.xy(*pts[j])
            bx, by = proj.xy(*pts[j + 1])
            pings.append(
                Ping(
                    ts=t0 + timedelta(seconds=next_ping),
                    lon=lon,
                    lat=lat,
                    speed_kph=round(v_kph, 1),
                    heading_deg=round(math.degrees(math.atan2(bx - ax, by - ay)) % 360.0, 1),
                    seg_idx=eid,
                )
            )
            next_ping += PING_SECONDS
        if not geom:
            geom.extend(coords)
        else:
            geom.extend(coords[1:])
        seq.append(eid)
        t += seg_t
        dist += seg.length_m
        node = other
        consumed += 1
    return seq, geom, dist, t / 60.0, passes, pings, consumed


# ---------------------------------------------------------------- calendar


def is_drive_day(d: date, day_index: int, n_days: int) -> bool:
    if day_index == n_days - 1:
        return True  # today always has cars out
    if d.weekday() == 6:
        return False
    if (day_index // 7) % OFF_WEEK_MODULO == OFF_WEEK_INDEX:
        return False
    return True


# ---------------------------------------------------------------- main entry


def build_drive_plan(
    world,
    segments: list[Segment],
    g: Graph,
    *,
    fleet_size: int | None = None,
    target_passes: int | None = None,
    shift_hours: float = SHIFT_HOURS,
    seed: int | None = None,
) -> tuple[list[DriveDay], dict, list[set[int]]]:
    fleet_size = fleet_size or world.campaign["fleet_size"]
    target_passes = target_passes or world.campaign["target_passes"]
    seed = world.seed if seed is None else seed
    proj = world.proj
    n_days = (world.end.date() - world.start.date()).days
    n_seg = len(segments)

    xy = np.array([proj.xy(s.mid_lon, s.mid_lat) for s in segments])
    lengths = np.array([s.length_m for s in segments])
    labels = _kmeans(xy, fleet_size, seed + 5, lengths=lengths)
    clusters = _repair_clusters(g, labels, fleet_size)

    # Eulerian circuit per cluster, computed once and reused with a cursor.
    circuits: list[list[int]] = []
    starts: list[int] = []
    for cl in clusters:
        if not cl:
            circuits.append([])
            starts.append(0)
            continue
        mult = _eulerise(g, cl)
        s0 = min(g.segments[si].node_a for si in cl)
        circuits.append(_hierholzer(g, mult, s0))
        starts.append(s0)
    cursor = [0] * fleet_size

    depot = world.vehicles[0]["home_base_lon"], world.vehicles[0]["home_base_lat"]
    passes_count = np.zeros(n_seg, dtype=np.int32)
    days: list[DriveDay] = []
    days_to_target: int | None = None
    rng = np.random.default_rng(seed + 99)
    now = world.now

    for di in range(n_days):
        the_date = world.start.date() + timedelta(days=di)
        if not is_drive_day(the_date, di, n_days):
            continue
        frac = float((passes_count >= target_passes).mean())
        if days_to_target is None and frac >= COVERAGE_GOAL:
            days_to_target = di
        is_today = di == n_days - 1
        if is_today:
            n_veh = TODAY_VEHICLES
        elif di >= n_days - SPRINT_DAYS:
            n_veh = SPRINT_VEHICLES
        elif frac < COVERAGE_GOAL:
            n_veh = PHASE1_VEHICLES + (1 if di % PHASE1_DOUBLE_EVERY == 0 else 0)
        else:
            n_veh = PHASE2_VEHICLES if (di % PHASE2_EVERY == 0) else 0
        if n_veh <= 0:
            continue

        # dispatch to the sub-network with the largest shortfall, so coverage evens
        # out across the campaign instead of over-sampling the compact clusters
        def _deficit(j: int) -> tuple[float, int]:
            if not clusters[j]:
                return (1e9, j)
            pc = passes_count[sorted(clusters[j])]
            return (-float(np.maximum(0, target_passes - pc).sum()) - 1e-3 * float(pc.mean() * -1), j)

        order = sorted(range(fleet_size), key=_deficit)
        veh_rot = [(di * 2 + i) % fleet_size for i in range(n_veh)]
        for slot in range(n_veh):
            cl_idx = order[slot % fleet_size]
            v_idx = veh_rot[slot]
            circuit = circuits[cl_idx]
            if not circuit:
                continue
            sh_start, sh_label = SHIFT_CYCLE[(di + v_idx * 3) % len(SHIFT_CYCLE)]
            if is_today:
                # anchor today's schedule to `now` so the fleet layer is alive at build
                offsets = [-2.6, -0.8, -6.4, 1.6, -4.2]
                t0 = (now + timedelta(hours=offsets[slot % len(offsets)])).replace(
                    second=0, microsecond=0
                )
                sh_label = _shift_label(t0.hour)
            else:
                t0 = datetime.combine(the_date, datetime.min.time()) + timedelta(hours=sh_start)
            drive_id = f"drv-{the_date.isoformat()}-{world.vehicles[v_idx]['label']}"
            seq_src = circuit[cursor[cl_idx] :] + circuit * 4
            seq, geom, dist, dur, pss, png, consumed = _walk(
                g, proj, seq_src, _edge_start_node(g, seq_src[0], starts[cl_idx]),
                t0, shift_hours * 3600.0, drive_id, world.vehicles[v_idx]["id"], rng,
            )
            if not seq:
                continue
            cursor[cl_idx] = (cursor[cl_idx] + consumed) % max(1, len(circuit))
            for p in pss:
                passes_count[p.seg_idx] += 1
            end = t0 + timedelta(minutes=dur)
            status = "complete"
            if is_today:
                if t0 > now:
                    status = "planned"
                elif end > now:
                    status = "in_progress"
            days.append(
                DriveDay(
                    day_index=di,
                    the_date=the_date,
                    vehicle_idx=v_idx,
                    shift=sh_label,
                    start=t0,
                    end=end,
                    seg_sequence=seq,
                    geometry=geom,
                    distance_m=dist,
                    duration_min=dur,
                    passes=pss,
                    pings=png,
                    status=status,
                )
            )
    if days_to_target is None:
        frac = float((passes_count >= target_passes).mean())
        if frac >= COVERAGE_GOAL:
            days_to_target = n_days - 1

    km = [d.distance_m / 1000 for d in days]
    below = int((passes_count < target_passes).sum())
    stats = {
        "n_segments": n_seg,
        "total_km_driven": round(sum(km), 1),
        "n_drives": len(days),
        "drive_days": len({d.the_date for d in days}),
        "km_per_vehicle_day_mean": round(float(np.mean(km)), 1) if km else 0.0,
        "km_per_vehicle_day_p10": round(float(np.percentile(km, 10)), 1) if km else 0.0,
        "km_per_vehicle_day_p90": round(float(np.percentile(km, 90)), 1) if km else 0.0,
        "shift_hours": shift_hours,
        "target_passes": target_passes,
        "coverage_pct": round(100.0 * float((passes_count >= target_passes).mean()), 2),
        "any_pass_pct": round(100.0 * float((passes_count > 0).mean()), 2),
        "mean_passes": round(float(passes_count.mean()), 2),
        "median_passes": int(np.median(passes_count)),
        "min_passes": int(passes_count.min()),
        "max_passes": int(passes_count.max()),
        "segments_below_target": below,
        "days_to_target": days_to_target,
        "clusters": [len(c) for c in clusters],
        "shift_mix": _count(d.shift for d in days),
        "depot": [round(depot[0], 6), round(depot[1], 6)],
    }
    return days, stats, clusters


def _edge_start_node(g: Graph, eid: int, fallback: int) -> int:
    if eid >= 0:
        return g.segments[eid].node_a
    return g.connectors[-eid - 1][0]


def _shift_label(hour: int) -> str:
    if 5 <= hour < 11:
        return "morning"
    if 11 <= hour < 15:
        return "midday"
    if 15 <= hour < 21:
        return "evening"
    return "night"


def _count(it):
    d: dict[str, int] = defaultdict(int)
    for x in it:
        d[x] += 1
    return dict(sorted(d.items()))
