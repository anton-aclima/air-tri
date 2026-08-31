"""Build gallery fixtures from the cached OSM extract.

Real Memphis geometry, FICTIONAL actors (CONTRACT §2). The pollutant field is a
sum of downwind Gaussian plumes plus a broad traffic term plus smooth low-
frequency noise, so the road grid reads as a coherent field with plume structure
rather than per-segment noise.
"""
import json, math, random, pathlib

ROOT = pathlib.Path("/Users/antonvattay/Workspace/air")
OUT = ROOT / "web/src/components/fixtures"
random.seed(7)

BBOX = (-90.190, 35.020, -90.075, 35.115)
CENTER = (-90.132, 35.058)

BOUNDARY = [
    [-90.1735, 35.0345], [-90.1530, 35.0205], [-90.1180, 35.0160],
    [-90.0855, 35.0245], [-90.0678, 35.0465], [-90.0662, 35.0795],
    [-90.0795, 35.1025], [-90.1025, 35.1155], [-90.1335, 35.1125],
    [-90.1565, 35.0935], [-90.1735, 35.0345],
]

M_LAT = 110540.0
def m_lon(lat): return 111320.0 * math.cos(math.radians(lat))

def to_m(lon, lat):
    return ((lon - CENTER[0]) * m_lon(CENTER[1]), (lat - CENTER[1]) * M_LAT)

def inside(lon, lat, ring):
    c = False
    n = len(ring)
    for i in range(n - 1):
        x1, y1 = ring[i]; x2, y2 = ring[i + 1]
        if (y1 > lat) != (y2 > lat):
            xi = x1 + (lat - y1) / (y2 - y1) * (x2 - x1)
            if lon < xi: c = not c
    return c

# ── the field ──────────────────────────────────────────────────────────────
# Wind from the SW (225°), so plumes elongate to the NE.
WIND_FROM = 218.0
plume_axis = math.radians((WIND_FROM + 180.0) % 360.0)

# Sources, in metres from campaign centre. The datacenter is the main emitter.
SOURCES = [
    # (x, y, amplitude, sigma_cross, sigma_along)
    (2450, 3050, 1.00, 620, 2300),   # Ridgeline South Campus  (NE, the big one)
    (-260, 1450, 0.52, 480, 1500),   # Delta Forge Metals
    (1500, -1750, 0.44, 700, 1900),  # Riverport Logistics (diesel gate)
]

def smooth_noise(x, y):
    v = 0.0
    for fx, fy, a, px, py in (
        (1/2600, 1/3100, 0.34, 0.7, 2.1),
        (1/1250, 1/1500, 0.19, 2.6, 0.4),
        (1/620,  1/700,  0.09, 1.1, 3.3),
    ):
        v += a * math.sin(x * fx * 6.283 + px) * math.cos(y * fy * 6.283 + py)
    return v

def field(lon, lat):
    x, y = to_m(lon, lat)
    total = 0.0
    for sx, sy, amp, sc, sa in SOURCES:
        dx, dy = x - sx, y - sy
        # rotate into the plume frame: `al` along the wind, `cr` across it
        al = dx * math.sin(plume_axis) + dy * math.cos(plume_axis)
        cr = dx * math.cos(plume_axis) - dy * math.sin(plume_axis)
        # only downwind of the source gets the long tail
        sig_a = sa if al > 0 else sa * 0.26
        # the plume widens as it travels
        spread = sc * (1.0 + max(0.0, al) / (sa * 1.15))
        total += amp * math.exp(-(al * al) / (2 * sig_a * sig_a) - (cr * cr) / (2 * spread * spread))
    # A broad urban background keeps ordinary streets in the middle of the ramp;
    # the plumes are what push a corridor to the top.
    return max(0.0, 0.80 * total + 0.17 * smooth_noise(x, y) + 0.42)

# Persistence gets its own, partly-independent field, so "hot but rare" and
# "mild but constant" are both visible on the grid. That is the whole point of
# the dual encoding.
def persist_field(lon, lat):
    x, y = to_m(lon, lat)
    v = 0.0
    for fx, fy, a, p in ((1/3400, 1/2900, 0.5, 0.3), (1/1100, 1/1400, 0.28, 1.9)):
        v += a * math.sin(x * fx * 6.283 + p) * math.cos(y * fy * 6.283 - p)
    return v

CLASS_WEIGHT = {
    "motorway": 1.30, "trunk": 1.24, "primary": 1.18, "secondary": 1.10,
    "tertiary": 1.02, "residential": 0.90, "unclassified": 0.92,
    "service": 0.86, "living_street": 0.88,
}
CLASS_KEEP = set(CLASS_WEIGHT) | {"motorway_link", "primary_link", "trunk_link", "secondary_link"}

def norm_class(h):
    return h.replace("_link", "") if h.endswith("_link") else h

# ── split ways into ~200 m segments ────────────────────────────────────────
def haversine(a, b):
    R = 6371008.8
    dlat = math.radians(b[1] - a[1]); dlon = math.radians(b[0] - a[0])
    la1 = math.radians(a[1]); la2 = math.radians(b[1])
    h = math.sin(dlat/2)**2 + math.cos(la1)*math.cos(la2)*math.sin(dlon/2)**2
    return 2 * R * math.asin(math.sqrt(h))

roads = json.loads((ROOT / "data/cache/osm_roads.json").read_text())["elements"]
segments = []
sid = 0
for way in roads:
    tags = way.get("tags", {})
    hw = tags.get("highway", "")
    if hw not in CLASS_KEEP: continue
    geom = [[g["lon"], g["lat"]] for g in way.get("geometry", [])]
    if len(geom) < 2: continue
    name = tags.get("name")
    rc = norm_class(hw)

    cur = [geom[0]]; acc = 0.0
    for i in range(1, len(geom)):
        d = haversine(geom[i-1], geom[i])
        cur.append(geom[i]); acc += d
        if acc >= 200.0 or i == len(geom) - 1:
            if len(cur) >= 2 and acc > 45:
                mid = cur[len(cur)//2]
                if inside(mid[0], mid[1], BOUNDARY):
                    segments.append({"coords": cur[:], "len": acc, "name": name,
                                     "rc": rc, "mid": mid})
            cur = [geom[i]]; acc = 0.0

# ── attach values ─────────────────────────────────────────────────────────
raw = []
for s in segments:
    lon, lat = s["mid"]
    raw.append(field(lon, lat) * CLASS_WEIGHT.get(s["rc"], 1.0))
lo, hi = min(raw), max(raw)
span = (hi - lo) or 1.0
# A pure plume field puts most streets at the very bottom of the ramp, which
# reads as "nothing here" rather than as structure. Blend the raw magnitude with
# its percentile RANK: rank is monotone in the field, so the spatial structure is
# preserved exactly, but the grid uses the whole ramp.
order = sorted(range(len(raw)), key=lambda i: raw[i])
rank = [0.0] * len(raw)
for pos, i in enumerate(order):
    rank[i] = pos / max(1, len(raw) - 1)

# NO2 in ppb: a plausible urban range, ref level 21 ppb.
V_LO, V_HI = 5.5, 46.0
features = []
for idx, (s, r) in enumerate(zip(segments, raw)):
    t = 0.62 * rank[idx] + 0.38 * ((r - lo) / span)
    jitter = random.uniform(-0.022, 0.022)
    t = min(1.0, max(0.0, t + jitter))
    median = V_LO + (V_HI - V_LO) * (t ** 1.12)
    p90 = median * (1.30 + 0.30 * t)
    p10 = median * (0.70 - 0.10 * t)
    mx = p90 * (1.22 + 0.34 * random.random())
    lon, lat = s["mid"]
    pf = persist_field(lon, lat)
    # Half magnitude, half its own field — so "hot but rare" and "mild but
    # constant" both exist on the grid. Rank-normalised below to use the full
    # width channel.
    persistence = 0.55 * t + 0.45 * (pf * 0.5 + 0.5) + random.uniform(-0.04, 0.04)
    risk = min(100.0, max(2.0, 100.0 * (t ** 0.9) * 0.92 + random.uniform(-3, 3)))
    npass = int(19 + 26 * random.random() + (8 if s["rc"] in ("primary", "secondary", "trunk", "motorway") else 0))
    sid += 1
    features.append({
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": [[round(c[0], 6), round(c[1], 6)] for c in s["coords"]]},
        "properties": {
            "id": f"seg_{sid:05d}",
            "name": s["name"],
            "road_class": s["rc"],
            "district": None,
            "value": round(median, 2),
            "median": round(median, 2),
            "p90": round(p90, 2),
            "p10": round(p10, 2),
            "max": round(mx, 2),
            "persistence": round(persistence, 3),
            "risk": round(risk, 1),
            "n_passes": npass,
            "length_m": round(s["len"], 1),
        },
    })

# Rank-normalise persistence into [0.08, 0.95] so the width channel is fully used.
praw = [f["properties"]["persistence"] for f in features]
porder = sorted(range(len(praw)), key=lambda i: praw[i])
for pos, i in enumerate(porder):
    features[i]["properties"]["persistence"] = round(
        0.08 + 0.87 * (pos / max(1, len(praw) - 1)), 3)

print(f"segments: {len(features)}")
vals = sorted(f["properties"]["value"] for f in features)
print("value p05/p50/p95:", round(vals[len(vals)//20],1), round(vals[len(vals)//2],1), round(vals[len(vals)*19//20],1))

(OUT / "segments.json").write_text(json.dumps(
    {"type": "FeatureCollection", "features": features}, separators=(",", ":")))

(OUT / "boundary.json").write_text(json.dumps({
    "type": "FeatureCollection",
    "features": [{"type": "Feature",
                  "properties": {"name": "Southwest Memphis Community Air Monitoring"},
                  "geometry": {"type": "Polygon", "coordinates": [BOUNDARY]}}]},
    separators=(",", ":")))

# ── industry footprints: real polygons, fictional operators ───────────────
ind = json.loads((ROOT / "data/cache/osm_industrial.json").read_text())["elements"]
cands = []
for e in ind:
    if e["type"] != "way": continue
    g = e.get("geometry") or []
    if len(g) < 4: continue
    ring = [[round(p["lon"], 6), round(p["lat"], 6)] for p in g]
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    if not inside(cx, cy, BOUNDARY): continue
    # rough area proxy
    ax = (max(p[0] for p in ring) - min(p[0] for p in ring)) * m_lon(cy)
    ay = (max(p[1] for p in ring) - min(p[1] for p in ring)) * M_LAT
    cands.append((ax * ay, ring, [round(cx, 6), round(cy, 6)]))
cands.sort(key=lambda c: -c[0])
print("industrial candidates in boundary:", len(cands))
(OUT / "footprints.json").write_text(json.dumps(
    [{"ring": c[1], "centroid": c[2], "area": round(c[0])} for c in cands[:8]],
    separators=(",", ":")))
