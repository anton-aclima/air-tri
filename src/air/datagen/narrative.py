"""Step 9 -- the narrative layer.

`build.py` seeds the *physical* world: roads, passes, concentrations, wind,
monitors, vehicles.  None of that says anything about people.  This module adds
the human record on top -- what residents reported, what tripped, what the
regulator did about it, and what the operators said in reply -- and it is the
only place those tables are written.  See the big `THE NARRATIVE SEAM` block in
`build.py` for the `ctx` contract; this module is its other half.

Why it matters
--------------
The product's argument is that three parties want different things from the same
air.  The physical layer cannot make that argument on its own -- a concentration
field has no opinions.  The tension only becomes visible once the same event
exists three times over: as a resident's complaint, as a regulator's exceedance,
and as an operator's inbound threat.  So the generator here is built around
**episodes** rather than rows.  One turbine test at 03:00 produces a monitor
exceedance, a cluster of "low hum" reports downwind of it, an alert on the
industry radar, a mitigation post that does *not* close anything, and a
regulator finding that does.  Every table below is a different projection of the
same handful of episodes.

Honesty rules baked into the data
---------------------------------
* **Industry can never close a concern.**  Operator responses move a concern to
  `mitigation_proposed` and no further.  Only a regulator finding produces
  `resolved`.  This is enforced in the API too; it must not be contradicted here.
* **Attribution stays ambiguous.**  A concern gets `suspected_site_id` only when
  the wind at the time actually carried from that site to that point.  Three
  emitters sit on three sides and plenty of reports are genuinely unattributable;
  those keep `NULL`, which is the honest answer and the more persuasive one.
* **Values agree with the map.**  Every alert value comes from
  `ctx["sample_field"]`, so an alert that says 118 ppb is standing on the same
  field the road grid is painted from.  Nothing here invents a number.
* **Nothing is dated after `ctx["now"]`.**

Reproducibility
---------------
All randomness derives from `ctx["rng_seed"]`, so a rebuild at the same seed
produces the same story.
"""

from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, timedelta
from typing import Any

import numpy as np

# Tables this module owns outright.  Cleared on entry so a re-run is idempotent
# whether or not `build.py` dropped them first (it does so only under --fresh).
OWNED_TABLES = [
    "activity",
    "notification",
    "alert_ack",
    "alert_sample",
    "alert",
    "enforcement_action",
    "advisory",
    "mitigation",
    "site_post",
    "concern_corroboration",
    "concern_response",
    "concern",
    "concern_cluster",
]

TS_FMT = "%Y-%m-%dT%H:%M:%S"

# Cluster rule from the product spec: 3+ concerns inside 600 m within 24 h.
CLUSTER_RADIUS_M = 600.0
CLUSTER_WINDOW_H = 24.0

M_PER_DEG_LAT = 110540.0
M_PER_DEG_LON = 111320.0


def _ts(dt: datetime) -> str:
    return dt.strftime(TS_FMT)


def _offset(lon: float, lat: float, bearing_deg: float, dist_m: float) -> tuple[float, float]:
    """Move `dist_m` along `bearing_deg` (compass, 0 = north) from a lon/lat."""
    rad = math.radians(bearing_deg)
    dlat = (dist_m * math.cos(rad)) / M_PER_DEG_LAT
    dlon = (dist_m * math.sin(rad)) / (M_PER_DEG_LON * math.cos(math.radians(lat)))
    return lon + dlon, lat + dlat


def _bearing(from_lon: float, from_lat: float, to_lon: float, to_lat: float) -> float:
    dx = (to_lon - from_lon) * M_PER_DEG_LON * math.cos(math.radians(from_lat))
    dy = (to_lat - from_lat) * M_PER_DEG_LAT
    return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0


def _dist_m(a_lon: float, a_lat: float, b_lon: float, b_lat: float) -> float:
    dx = (b_lon - a_lon) * M_PER_DEG_LON * math.cos(math.radians(a_lat))
    dy = (b_lat - a_lat) * M_PER_DEG_LAT
    return math.hypot(dx, dy)


def _ang_diff(a: float, b: float) -> float:
    """Smallest absolute angle between two compass bearings, 0-180."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


# --------------------------------------------------------------- copy pools
#
# Community voice: no units, no acronyms, first person, specific.  A resident
# says "the air smelled like a struck match", not "elevated SO2".

CONCERN_COPY: dict[str, list[tuple[str, str, str]]] = {
    "smell": [
        ("Sharp chemical smell again", "Walking back up {road} around {when} and it hit me at the corner. Same as last week.", "\U0001f44e"),
        ("Something like burnt plastic", "Woke up to it. Had to shut the windows in {when_part}.", "\U0001f624"),
        ("Smells like a struck match outside", "Standing on the porch on {road}. My throat went dry within a minute.", "\U0001f9ea"),
        ("Fuel smell hanging in the street", "Strong enough that I could taste it. Gone by morning but it was bad {when}.", "\U000026fd"),
        ("That sour smell is back on {road}", "Third night this week. My neighbour smelled it too.", "\U0001f637"),
        ("Exhaust smell with no traffic around", "Nothing was driving past. It was just sitting in the air.", "\U0001f4a8"),
    ],
    "noise": [
        ("Low hum shaking the windows", "Started around {when} and has not stopped. You feel it more than hear it.", "\U0001f50a"),
        ("Constant drone since midnight", "Cannot sleep through it. It is a machine noise, not traffic.", "\U0001f634"),
        ("Something running all night off {road}", "It cuts in and out every few minutes. Been going since {when}.", "\U0001f3ed"),
        ("Roaring sound from the west", "Loud enough that I went outside to check it was not my own unit.", "\U0001f4e2"),
    ],
    "smoke": [
        ("Haze over the street under the lights", "You can see it in the beam of the streetlight on {road}. Thick.", "\U0001f32b"),
        ("Grey plume visible from my yard", "Watched it drift over the houses for about twenty minutes around {when}.", "\U0001f4a8"),
        ("Air looks dirty this {when_part}", "Everything more than a block away has gone soft and grey.", "\U0001f327"),
        ("Something was burning nearby", "Could see it and smell it at the same time. Kept the kids in.", "\U0001f525"),
    ],
    "dust": [
        ("Film of grit on the car every morning", "Wipe it off and it is back the next day. Black, not pollen.", "\U0001f697"),
        ("Black dust on the window sills", "Cleaned them {when} and they are already dirty again.", "\U0001fa9f"),
        ("Cannot keep the porch clean on {road}", "Sweeping twice a day now. It never used to be like this.", "\U0001f9f9"),
    ],
    "health": [
        ("Headache and burning eyes all evening", "Came on after I was outside for a while. Better once I came in.", "\U0001fac1"),
        ("My son needed his inhaler twice tonight", "He is normally fine. Both times right after being out on {road}.", "\U0001fac1"),
        ("Chest feels tight when I go outside", "It has been like this for a few days now, worst in the {when_part}.", "\U0001f3e5"),
        ("Sore throat that clears up indoors", "Which tells me it is something out there and not a cold.", "\U0001f912"),
        ("Coughing every time I walk the dog", "Same stretch of {road} each time.", "\U0001f415"),
    ],
    "light": [
        ("Floodlights on all night again", "The whole back of the house is lit up. Been every night this week.", "\U0001f4a1"),
        ("Sky glow to the {compass} is worse lately", "Never used to be able to read by it.", "\U0001f319"),
    ],
    "traffic": [
        ("Truck queue idling on the shoulder", "Counted eleven of them, engines running, on {road}.", "\U0001f69b"),
        ("Trucks running through here before dawn", "They are not supposed to be on this street at all.", "\U0001f6a6"),
        ("Line of trucks waiting with engines on", "Sat there the whole time I was making dinner.", "\U0001f6a7"),
    ],
    "vibration": [
        ("House shakes when the generators start", "Pictures move on the wall. Happens most nights around {when}.", "\U0001f3da"),
        ("Windows rattling in the {when_part}", "It comes in waves. Started a few weeks back.", "\U0001fa9f"),
    ],
    "other": [
        ("Something is different about the air", "Cannot describe it better than that. It does not feel right on {road}.", "\U00002753"),
        ("Birds have gone quiet around here", "Probably nothing. Wanted it on the record anyway.", "\U0001f426"),
    ],
}

# Weighted so the loud, visceral kinds dominate -- that is what people actually file.
KIND_WEIGHTS = {
    "smell": 0.30, "health": 0.19, "noise": 0.15, "smoke": 0.12,
    "dust": 0.09, "traffic": 0.07, "vibration": 0.05, "light": 0.02, "other": 0.01,
}

COMPASS_16 = ["north", "north-northeast", "northeast", "east-northeast", "east",
              "east-southeast", "southeast", "south-southeast", "south",
              "south-southwest", "southwest", "west-southwest", "west",
              "west-northwest", "northwest", "north-northwest"]


def _compass(bearing: float) -> str:
    return COMPASS_16[int((bearing % 360.0) / 22.5 + 0.5) % 16]


def _when_phrase(hour: int) -> tuple[str, str]:
    """(`{when}`, `{when_part}`) -- how a person would say a time of day."""
    if hour < 5:
        return "two or three in the morning", "small hours"
    if hour < 9:
        return "just after sunrise", "morning"
    if hour < 12:
        return "mid-morning", "morning"
    if hour < 15:
        return "the middle of the day", "afternoon"
    if hour < 18:
        return "late afternoon", "afternoon"
    if hour < 21:
        return "just after dark", "evening"
    return "around midnight", "night"


# ------------------------------------------------------------------- seeding


def seed(conn: sqlite3.Connection, ctx: dict[str, Any]) -> None:
    """Write the whole narrative layer.  Called once by `build.py`."""
    rng = np.random.default_rng(int(ctx["rng_seed"]) + 90210)

    for table in OWNED_TABLES:
        conn.execute(f"DELETE FROM {table}")

    world = _World(conn, ctx, rng)
    episodes = world.plan_episodes()

    world.write_concerns(episodes)
    world.write_clusters(episodes)
    world.write_alerts(episodes)
    world.write_industry_replies(episodes)
    world.write_regulator_actions(episodes)
    world.write_notifications()
    world.write_activity()


class _World:
    """Shared state for one narrative build.

    Held as an object purely so the writers can see each other's ids -- an
    advisory needs its alert, a mitigation needs its concern, and the activity
    log needs all of them in timestamp order.
    """

    def __init__(self, conn: sqlite3.Connection, ctx: dict[str, Any], rng: np.random.Generator):
        self.conn = conn
        self.ctx = ctx
        self.rng = rng
        self.cid = ctx["campaign"]["id"]
        self.now: datetime = ctx["now"]
        self.start: datetime = ctx["start"]
        self.segments = ctx["segments"]
        self.sites = ctx["sites"]
        self.monitors = ctx["monitors"]
        self.wind = ctx["wind"]
        self.action_levels = [a for a in ctx["action_levels"] if a["enabled"]]
        self.users = ctx["users"]
        self.residents = [u for u in self.users if u["role"] == "community"]
        self.regulators = [u for u in self.users if u["role"] == "regulator"]
        self.industry_users = [u for u in self.users if u["role"] == "industry"]
        self.admins = [u for u in self.users if u["role"] == "admin"]

        self.site_by_id = {s["id"]: s for s in self.sites}
        self.org_by_site = {s["id"]: s["org_id"] for s in self.sites}

        # Segment midpoints as a lookup grid -- used to snap a concern to a real
        # street name, which is what makes the copy read as a real neighbourhood.
        self._seg_lon = np.array([s["mid_lon"] for s in self.segments])
        self._seg_lat = np.array([s["mid_lat"] for s in self.segments])

        self.n_hours = len(self.wind)

        # Collected as we go, then flushed in timestamp order by write_activity.
        self.activity: list[tuple[datetime, str, str | None, str, str | None, str | None, str, dict]] = []
        self.notifications: list[tuple[datetime, str | None, str | None, str, str, str, str, str | None]] = []
        self._decks: dict[str, list[tuple[str, str, str]]] = {}
        self.alert_rows: list[dict] = []
        self.concern_rows: list[dict] = []
        self.cluster_rows: list[dict] = []

    # ------------------------------------------------------------- helpers

    def _log(self, ts: datetime, role: str, actor: str | None, verb: str,
             obj_type: str | None, obj_id: str | None, summary: str, payload: dict | None = None) -> None:
        self.activity.append((ts, role, actor, verb, obj_type, obj_id, summary, payload or {}))

    def _notify(self, ts: datetime, user_id: str | None, role: str | None, kind: str,
                severity: str, title: str, body: str, link: str | None) -> None:
        self.notifications.append((ts, user_id, role, kind, severity, title, body, link))

    def _hour_index(self, dt: datetime) -> int:
        return max(0, min(self.n_hours - 1, int((dt - self.start).total_seconds() // 3600)))

    def _wind_at(self, dt: datetime) -> dict:
        return self.wind[self._hour_index(dt)]

    def _nearest_segment(self, lon: float, lat: float) -> dict:
        dx = (self._seg_lon - lon) * M_PER_DEG_LON * math.cos(math.radians(lat))
        dy = (self._seg_lat - lat) * M_PER_DEG_LAT
        return self.segments[int(np.argmin(dx * dx + dy * dy))]

    def _pick(self, seq):
        return seq[int(self.rng.integers(len(seq)))]

    def _draw_copy(self, kind: str, avoid: set[str] | None) -> tuple[str, str, str]:
        """Draw a report template, spacing repeats as far apart as possible.

        Sampling this pool with replacement puts the same sentence on the feed
        twice in a row often enough to notice -- and "Closest to you" showing
        the identical headline at positions one and four reads as a bug in the
        product, not as two neighbours who happen to feel the same way. So each
        kind gets a shuffled deck that is dealt out and only reshuffled once
        exhausted. `avoid` still applies on top, for repeats inside one burst.
        """
        deck = self._decks.get(kind)
        if not deck:
            pool = list(CONCERN_COPY[kind])
            deck = [pool[int(i)] for i in self.rng.permutation(len(pool))]
            self._decks[kind] = deck
        for idx, candidate in enumerate(deck):
            if not avoid or candidate[0] not in avoid:
                return deck.pop(idx)
        return deck.pop()

    def _suspect(self, lon: float, lat: float, dt: datetime) -> str | None:
        """Which site the wind actually came from, or None.

        The whole point of the ambiguity rule: a concern is only attributed when
        the transport direction at that hour genuinely lines up with a site
        upwind of it, within 30 degrees and 4 km.  Everything else stays NULL.
        """
        w = self._wind_at(dt)
        best: tuple[float, str] | None = None
        for s in self.sites:
            slon, slat = s["centroid"]
            d = _dist_m(slon, slat, lon, lat)
            if d > 4000.0 or d < 150.0:
                continue
            to_point = _bearing(slon, slat, lon, lat)
            off = _ang_diff(to_point, w["transport_deg"])
            if off > 30.0:
                continue
            score = off + d / 400.0
            if best is None or score < best[0]:
                best = (score, s["id"])
        return best[1] if best else None

    # ------------------------------------------------------------ episodes

    def plan_episodes(self) -> list[dict]:
        """Pick the handful of moments the whole story is told through.

        An episode is a time, a place and a cause.  Everything downstream --
        concerns, clusters, alerts, replies -- is a projection of one of these,
        which is what keeps the four interfaces telling the *same* story rather
        than four unrelated ones.
        """
        eps: list[dict] = []
        span_h = int((self.now - self.start).total_seconds() // 3600)

        # Eight community-visible episodes, spread across the campaign but
        # weighted late so the demo opens on a live situation.
        fracs = [0.06, 0.19, 0.31, 0.44, 0.58, 0.72, 0.88, 0.985]
        causes = [
            ("generator_test", "site-ridgeline", "Turbine bank ran through the night"),
            ("truck_surge", "site-riverport", "Drayage queue built up before dawn"),
            ("furnace_cycle", "site-deltaforge", "Furnace cycle with a low inversion"),
            ("generator_test", "site-ridgeline", "Backup generators under load test"),
            ("gas_leak", None, "Street-level gas leak, no fixed monitor in range"),
            ("furnace_cycle", "site-deltaforge", "Sustained furnace run, still air"),
            ("truck_surge", "site-riverport", "Overnight intermodal surge"),
            ("generator_test", "site-ridgeline", "Generator test under a collapsed boundary layer"),
        ]

        for i, (frac, (cause, site_id, headline)) in enumerate(zip(fracs, causes)):
            h = int(span_h * frac)
            # Push the episode into the hours these things actually happen: the
            # small hours, when the boundary layer is down and the plume is
            # trapped. That is also when the physical field is worst, so the
            # concentrations back the story up.
            t = self.start + timedelta(hours=h)
            t = t.replace(hour=int(self.rng.integers(1, 6)), minute=int(self.rng.integers(0, 60)))
            if t > self.now:
                t = self.now - timedelta(hours=3)

            w = self._wind_at(t)
            if site_id:
                slon, slat = self.site_by_id[site_id]["centroid"]
                # Downwind, where the plume actually goes -- not an arbitrary blob.
                dist = float(self.rng.uniform(700, 1900))
                clon, clat = _offset(slon, slat, w["transport_deg"], dist)
            else:
                leak = self.ctx["leaks"][0] if self.ctx.get("leaks") else None
                clon = leak["lon"] if leak else self.ctx["campaign"]["center_lon"]
                clat = leak["lat"] if leak else self.ctx["campaign"]["center_lat"]

            seg = self._nearest_segment(clon, clat)
            eps.append({
                "idx": i,
                "cause": cause,
                "site_id": site_id,
                "headline": headline,
                "t": t,
                "lon": clon,
                "lat": clat,
                "district": seg["district"],
                "road": seg["name"] or "the block",
                "n_reports": int(self.rng.integers(4, 11)),
                "wind": w,
                "cluster_id": f"cl-{i:02d}-{self.cid[-4:]}",
                "concern_ids": [],
                "alert_ids": [],
            })
        return eps

    # ------------------------------------------------------------ concerns

    def _concern_text(self, kind: str, road: str, hour: int, bearing: float,
                      avoid: set[str] | None = None) -> tuple[str, str, str]:
        # Two neighbours filing word-for-word identical reports in the same hour
        # reads as generated, which is exactly the impression to avoid.
        title, body, emoji = self._draw_copy(kind, avoid)
        if avoid is not None:
            avoid.add(title)
        when, when_part = _when_phrase(hour)
        fmt = {"road": road, "when": when, "when_part": when_part, "compass": _compass(bearing)}
        return title.format(**fmt), body.format(**fmt), emoji

    def _insert_concern(self, *, cid_: str, author, kind: str, severity: int, lon: float, lat: float,
                        occurred: datetime, created: datetime, status: str, cluster_id: str | None,
                        suspected: str | None, avoid: set[str] | None = None) -> dict:
        seg = self._nearest_segment(lon, lat)
        road = seg["name"] or "the block"
        bearing = _bearing(lon, lat, self.ctx["campaign"]["center_lon"], self.ctx["campaign"]["center_lat"])
        title, body, emoji = self._concern_text(kind, road, occurred.hour, bearing, avoid)
        anon = int(self.rng.random() < 0.12)
        row = {
            "id": cid_, "campaign_id": self.cid, "author_id": author["id"], "kind": kind,
            "severity": severity, "title": title, "body": body, "lon": lon, "lat": lat,
            "address_hint": f"near {road}", "district": seg["district"],
            "occurred_at": _ts(occurred), "created_at": _ts(created), "status": status,
            "cluster_id": cluster_id, "corroborations": 0, "is_anonymous": anon,
            "photo_emoji": emoji, "suspected_site_id": suspected,
        }
        self.concern_rows.append(row)
        self._log(created, "community", author["id"], "concern.created", "concern", cid_,
                  f"{author['name'] if not anon else 'A neighbour'} reported: {title}",
                  {"kind": kind, "severity": severity, "district": seg["district"]})
        return row

    def write_concerns(self, episodes: list[dict]) -> None:
        kinds = list(KIND_WEIGHTS)
        probs = np.array([KIND_WEIGHTS[k] for k in kinds])
        probs = probs / probs.sum()
        n = 0

        # 1 -- burst reports around each episode.  These are what form clusters,
        #      so they are deliberately tight in space and time.
        for ep in episodes:
            used: set[str] = set()
            for j in range(ep["n_reports"]):
                # Inside the cluster radius, so the 3-in-600 m rule actually fires.
                r = float(self.rng.uniform(60, CLUSTER_RADIUS_M * 0.85))
                th = float(self.rng.uniform(0, 360))
                lon, lat = _offset(ep["lon"], ep["lat"], th, r)
                # Reports trickle in over the hours after the event, not at once.
                occurred = ep["t"] + timedelta(minutes=float(self.rng.uniform(-40, 240)))
                created = occurred + timedelta(minutes=float(self.rng.uniform(4, 260)))
                if created > self.now:
                    created = self.now - timedelta(minutes=float(self.rng.uniform(1, 90)))
                    occurred = min(occurred, created - timedelta(minutes=5))
                if ep["cause"] == "truck_surge":
                    kind = self._pick(["traffic", "noise", "smell", "health", "dust"])
                elif ep["cause"] == "gas_leak":
                    kind = self._pick(["smell", "health", "smell", "other"])
                elif ep["cause"] == "furnace_cycle":
                    kind = self._pick(["smoke", "dust", "smell", "health"])
                else:
                    kind = self._pick(["noise", "vibration", "smell", "health", "smoke"])
                severity = int(np.clip(self.rng.normal(3.4, 0.9), 1, 5))
                cid_ = f"cn-{ep['idx']:02d}{j:02d}-{n:04d}"
                self._insert_concern(
                    cid_=cid_, author=self._pick(self.residents), kind=kind, severity=severity,
                    lon=lon, lat=lat, occurred=occurred, created=created,
                    status="corroborated", cluster_id=ep["cluster_id"],
                    suspected=self._suspect(lon, lat, occurred), avoid=used,
                )
                ep["concern_ids"].append(cid_)
                n += 1

        # 2 -- the background hum.  Life goes on between episodes and a feed that
        #      only contains crises reads as staged.
        span_h = max(1, int((self.now - self.start).total_seconds() // 3600))
        for _ in range(150):
            # Recency-weighted: a feed that opens on 90-day-old posts feels dead.
            frac = float(self.rng.beta(2.6, 1.5))
            occurred = self.start + timedelta(hours=frac * span_h)
            occurred += timedelta(minutes=float(self.rng.uniform(0, 60)))
            if occurred > self.now - timedelta(minutes=20):
                occurred = self.now - timedelta(minutes=float(self.rng.uniform(20, 900)))
            created = occurred + timedelta(minutes=float(self.rng.uniform(5, 400)))
            if created > self.now:
                created = self.now - timedelta(minutes=float(self.rng.uniform(1, 40)))

            seg = self._pick(self.segments)
            lon = seg["mid_lon"] + float(self.rng.normal(0, 0.0006))
            lat = seg["mid_lat"] + float(self.rng.normal(0, 0.0005))
            kind = str(self.rng.choice(kinds, p=probs))
            severity = int(np.clip(self.rng.normal(2.6, 1.0), 1, 5))
            age_h = (self.now - created).total_seconds() / 3600.0
            if age_h < 20:
                status = "new"
            elif self.rng.random() < 0.30:
                status = "corroborated"
            else:
                status = "new"
            cid_ = f"cn-bg-{n:04d}"
            self._insert_concern(
                cid_=cid_, author=self._pick(self.residents), kind=kind, severity=severity,
                lon=lon, lat=lat, occurred=occurred, created=created, status=status,
                cluster_id=None, suspected=self._suspect(lon, lat, occurred),
            )
            n += 1

        # Concerns land before anything can reference them.  `build.py` documents
        # this connection as `foreign_keys = OFF`; it is not, so insert order is
        # load-bearing and a corroboration written first fails the FK.
        cols = ("id, campaign_id, author_id, kind, severity, title, body, lon, lat, address_hint, "
                "district, occurred_at, created_at, status, cluster_id, corroborations, is_anonymous, "
                "photo_emoji, suspected_site_id")
        names = [c.strip() for c in cols.split(",")]
        self.conn.executemany(
            f"INSERT INTO concern ({cols}) VALUES ({','.join('?' * 19)})",
            [tuple(r[c] for c in names) for r in self.concern_rows],
        )

        # 3 -- corroborations.  A neighbour tapping "same here" is the cheapest
        #      civic action in the product and the one that makes a cluster.
        for row in self.concern_rows:
            base = 0.75 if row["cluster_id"] else 0.22
            if self.rng.random() > base:
                continue
            k = int(self.rng.integers(1, 6 if row["cluster_id"] else 3))
            created = datetime.strptime(row["created_at"], TS_FMT)
            picks = self.rng.permutation(len(self.residents))[:k]
            seen = 0
            for pi in picks:
                u = self.residents[int(pi)]
                if u["id"] == row["author_id"]:
                    continue
                at = created + timedelta(minutes=float(self.rng.uniform(10, 900)))
                if at > self.now:
                    at = self.now - timedelta(minutes=float(self.rng.uniform(1, 60)))
                self.conn.execute(
                    "INSERT OR IGNORE INTO concern_corroboration (concern_id, user_id, created_at) VALUES (?,?,?)",
                    (row["id"], u["id"], _ts(at)),
                )
                seen += 1
            row["corroborations"] = seen
            if seen >= 2 and row["status"] == "new":
                row["status"] = "corroborated"
            self.conn.execute(
                "UPDATE concern SET corroborations=?, status=? WHERE id=?",
                (seen, row["status"], row["id"]),
            )

    # ------------------------------------------------------------ clusters

    def write_clusters(self, episodes: list[dict]) -> None:
        by_id = {c["id"]: c for c in self.concern_rows}
        for ep in episodes:
            members = [by_id[i] for i in ep["concern_ids"]]
            if len(members) < 3:
                continue
            times = sorted(datetime.strptime(m["occurred_at"], TS_FMT) for m in members)
            lons = [m["lon"] for m in members]
            lats = [m["lat"] for m in members]
            clon, clat = float(np.mean(lons)), float(np.mean(lats))
            radius = max(120.0, max(_dist_m(clon, clat, lo, la) for lo, la in zip(lons, lats)))
            kinds = sorted({m["kind"] for m in members})
            age_h = (self.now - times[-1]).total_seconds() / 3600.0
            status = "active" if age_h < 72 else ("reviewed" if self.rng.random() < 0.6 else "closed")
            label = f"{ep['district']} · {ep['road']}"
            self.cluster_rows.append({
                "id": ep["cluster_id"], "campaign_id": self.cid, "label": label,
                "centroid_lon": clon, "centroid_lat": clat, "radius_m": round(radius, 1),
                "count": len(members), "kinds_json": json.dumps(kinds),
                "first_at": _ts(times[0]), "last_at": _ts(times[-1]),
                "status": status, "site_id": ep["site_id"],
            })
            ep["cluster_centroid"] = (clon, clat)
            ep["cluster_count"] = len(members)
            self._log(times[2], "admin", None, "cluster.formed", "concern_cluster", ep["cluster_id"],
                      f"{len(members)} reports within {int(radius)} m formed a cluster at {label}",
                      {"kinds": kinds, "count": len(members)})

        cols = ("id, campaign_id, label, centroid_lon, centroid_lat, radius_m, count, kinds_json, "
                "first_at, last_at, status, site_id")
        self.conn.executemany(
            f"INSERT INTO concern_cluster ({cols}) VALUES ({','.join('?' * 12)})",
            [tuple(r[c.strip()] for c in cols.split(",")) for r in self.cluster_rows],
        )

    # -------------------------------------------------------------- alerts

    def _scan_monitor_series(self) -> dict[str, np.ndarray]:
        """Concentration at every monitor for every campaign hour.

        Sampled from the same field the road grid is painted from, so an
        exceedance the regulator sees is standing on the map they are looking at.
        """
        lons = np.array([m["lon"] for m in self.monitors])
        lats = np.array([m["lat"] for m in self.monitors])
        codes = sorted({a["measure"] for a in self.action_levels})
        out = {c: np.zeros((self.n_hours, len(self.monitors)), dtype=np.float32) for c in codes}
        sample = self.ctx["sample_field"]
        for h in range(self.n_hours):
            s = sample(h, lons, lats)
            for c in codes:
                if c in s:
                    out[c][h] = np.asarray(s[c], dtype=np.float32)
        return out

    def write_alerts(self, episodes: list[dict]) -> None:
        series = self._scan_monitor_series()
        mon_measures = [set(json.loads(m["measures_json"])) for m in self.monitors]
        now_h = self._hour_index(self.now)
        rows: list[dict] = []
        samples: list[tuple[str, str, float]] = []
        seq = 0

        # 1 -- threshold episodes at the regulator's own monitors.  Contiguous
        #      exceeding hours are merged into one alert; a row per hour would
        #      bury the operator in noise and misrepresent one event as many.
        for al in self.action_levels:
            code = al["measure"]
            if code not in series:
                continue
            avg = max(1, int(round(al["averaging_hours"])))
            for mi, mon in enumerate(self.monitors):
                # Honest network gap: a monitor cannot exceed on something it
                # does not measure.  This is what makes BC/diesel/CH4 unreachable
                # for DRAQA and is the leapfrog argument, stated as data.
                if code not in mon_measures[mi]:
                    continue
                if mon["owner_type"] != "regulator":
                    continue
                v = series[code][:now_h, mi]
                if v.size < avg + 1:
                    continue
                if avg > 1:
                    k = np.ones(avg, dtype=np.float32) / avg
                    v = np.convolve(v, k, mode="valid")
                over = v > al["threshold"]
                if not over.any():
                    continue
                # Merge contiguous runs.
                idx = np.flatnonzero(over)
                splits = np.flatnonzero(np.diff(idx) > 2)
                runs = np.split(idx, splits + 1)
                for run in runs:
                    if run.size == 0:
                        continue
                    h0, h1 = int(run[0]), int(run[-1])
                    peak_i = int(run[int(np.argmax(v[run]))])
                    peak = float(v[peak_i])
                    t0 = self.start + timedelta(hours=h0)
                    t1 = self.start + timedelta(hours=h1 + 1)
                    if t0 > self.now:
                        continue
                    ended = None if t1 >= self.now - timedelta(hours=1) else _ts(min(t1, self.now))
                    aid = f"al-{code}-{mon['id'][-4:]}-{seq:03d}"
                    seq += 1
                    kind = "exceedance" if al["kind"] == "spike" else "integrated_exposure"
                    # `status` is workflow state, not physics.  The value dropping
                    # sets `ended_at`; the alert stays on the regulator's board
                    # until somebody actually works it.  A queue that self-clears
                    # the moment the air improves shows an empty watchfloor for a
                    # region with a real and ongoing problem.
                    age_d = (self.now - t1).total_seconds() / 86400.0
                    if age_d > 6:
                        status = "resolved" if self.rng.random() < 0.9 else "expired"
                    elif self.rng.random() < 0.45:
                        status = "acknowledged"
                    else:
                        status = "active"
                    site_id = self._suspect(mon["lon"], mon["lat"], self.start + timedelta(hours=peak_i))
                    unit = al["unit"]
                    dur = h1 - h0 + 1
                    if kind == "exceedance":
                        title = f"{al['label']} exceeded at {mon['name']}"
                        body = (f"{peak:.1f} {unit} against a {al['threshold']:.0f} {unit} "
                                f"{al['label'].lower()}. {dur} hour{'s' if dur != 1 else ''} over the line.")
                    else:
                        title = f"{al['label']} exceeded at {mon['name']}"
                        body = (f"{avg}-hour average reached {peak:.1f} {unit} against "
                                f"{al['threshold']:.0f} {unit}. Sustained for {dur} hour{'s' if dur != 1 else ''}.")
                    rec = _recommendation(code, al["severity"], site_id, self.site_by_id)
                    rows.append({
                        "id": aid, "campaign_id": self.cid, "kind": kind, "severity": al["severity"],
                        "measure": code, "value": round(peak, 2), "threshold": al["threshold"],
                        "unit": unit, "source_type": "monitor", "source_id": mon["id"],
                        "lon": mon["lon"], "lat": mon["lat"], "site_id": site_id,
                        "action_level_id": al["id"], "started_at": _ts(t0), "ended_at": ended,
                        "status": status, "title": title, "body": body, "recommendation": rec,
                        "audience_json": json.dumps(["regulator", "industry", "admin"]),
                        "created_at": _ts(min(t0 + timedelta(minutes=8), self.now)),
                    })
                    for hh in range(max(0, h0 - 3), min(now_h, h1 + 4)):
                        samples.append((aid, _ts(self.start + timedelta(hours=hh)), float(v[min(hh, v.size - 1)])))

        # Keep the demo legible.  A 90-day campaign genuinely produces more
        # exceedance episodes than anyone can read; keep the worst and the most
        # recent, and say so rather than pretending the rest never happened.
        rows.sort(key=lambda r: (r["started_at"]))
        if len(rows) > 26:
            keep = set(id(r) for r in sorted(rows, key=lambda r: -(r["value"] or 0))[:14])
            keep |= set(id(r) for r in rows[-12:])
            rows = [r for r in rows if id(r) in keep]

        # 2 -- one alert per community cluster.  This is loop 1 of the spine:
        #      residents file, the cluster forms, and it lands on the industry
        #      radar and in the regulator queue without anyone re-typing it.
        for ep in episodes:
            if ep.get("cluster_count", 0) < 3:
                continue
            clon, clat = ep["cluster_centroid"]
            t0 = ep["t"]
            aid = f"al-cluster-{ep['idx']:02d}"
            age_h = (self.now - t0).total_seconds() / 3600.0
            rows.append({
                "id": aid, "campaign_id": self.cid, "kind": "concern_cluster",
                "severity": "warning" if ep["cluster_count"] >= 7 else "watch",
                "measure": None, "value": float(ep["cluster_count"]), "threshold": 3.0,
                "unit": "reports", "source_type": "community", "source_id": ep["cluster_id"],
                "lon": clon, "lat": clat, "site_id": ep["site_id"], "action_level_id": None,
                "started_at": _ts(t0),
                "ended_at": None if age_h < 96 else _ts(t0 + timedelta(hours=72)),
                "status": "active" if age_h < 96 else "resolved",
                "title": f"{ep['cluster_count']} community reports clustered near {ep['road']}",
                "body": (f"{ep['cluster_count']} separate residents reported within "
                         f"{int(CLUSTER_RADIUS_M)} m of each other inside a day. "
                         f"Wind at the time carried from {_compass((ep['wind']['transport_deg'] + 180) % 360)}."),
                "recommendation": ("Check operations for this window and reply to the cluster. "
                                   "An operator reply does not close a resident's report."),
                "audience_json": json.dumps(["regulator", "industry", "admin"]),
                "created_at": _ts(min(t0 + timedelta(hours=5), self.now)),
            })
            ep["alert_ids"].append(aid)

        # 3 -- the leapfrog.  Three action levels exist for measures that not one
        #      reference monitor carries, so DRAQA's own network can never trip
        #      them.  The fleet trips all three, and the value quoted is the value
        #      a car actually recorded on that block -- read back out of
        #      `segment_stat`, not sampled from the middle of a plume the road
        #      does not pass through.
        for code, al_id, plain in (
            ("ch4", "al-ch4-spike-09", "methane"),
            ("bc", "al-bc-spike-07", "black carbon"),
            ("diesel", "al-diesel-integrated-08", "diesel-attributable particulate"),
        ):
            al = next((x for x in self.action_levels if x["id"] == al_id), None)
            if al is None:
                continue
            # A spike level is about the worst pass; an exposure level is about
            # the bulk of them.  Quoting the wrong one is how an honest dataset
            # starts telling a dishonest story.
            stat_key = "max" if al["kind"] == "spike" else "p90"
            best: tuple[float, dict] | None = None
            for sg in self.segments:
                st = self.ctx["segment_stat"](sg["id"], code, "all")
                if not st or st.get(stat_key) is None:
                    continue
                v = float(st[stat_key])
                if best is None or v > best[0]:
                    best = (v, sg)
            if best is None or best[0] < al["threshold"]:
                continue
            val, sg = best
            t0 = self.now - timedelta(hours=float(self.rng.uniform(3, 30)))
            where = sg["name"] or "an unnamed street"
            if code == "ch4":
                title = f"Methane plume crossed on {where}"
                body = (f"Repeated passes recorded {val:.2f} {al['unit']} against a "
                        f"{al['threshold']:g} {al['unit']} screening level, over a footprint a few "
                        "hundred metres across. A leak this tight sits between fixed monitors; "
                        "a car drives straight through it.")
                rec = "Survey the block on foot. Mobile passes have re-detected this on consecutive days."
            else:
                title = f"Highest {plain} on the network: {where}"
                body = (f"The {'worst pass' if stat_key == 'max' else '90th percentile'} on this "
                        f"segment in {sg['district']} reached {val:.2f} {al['unit']}, against a "
                        f"{al['threshold']:g} {al['unit']} level.")
                rec = "Site a temporary monitor here, or accept mobile evidence."
            rows.append({
                "id": f"al-mobile-{code}-00", "campaign_id": self.cid, "kind": "mobile_detection",
                "severity": al["severity"], "measure": code, "value": round(val, 2),
                "threshold": al["threshold"], "unit": al["unit"], "source_type": "mobile",
                "source_id": sg["id"], "lon": sg["mid_lon"], "lat": sg["mid_lat"],
                "site_id": self._suspect(sg["mid_lon"], sg["mid_lat"], t0),
                "action_level_id": al_id, "started_at": _ts(t0), "ended_at": None, "status": "active",
                "title": title,
                "body": body + (f" No reference monitor in the network measures {code}, so the fixed "
                                "network cannot raise this at all."),
                "recommendation": rec + " The action level is set, but no instrument in the fixed network measures this channel.",
                "audience_json": json.dumps(["regulator", "admin"]),
                "created_at": _ts(min(t0 + timedelta(minutes=40), self.now)),
            })

        # 4 -- the consultant's model is wrong, and the cars can prove it.
        models = self.ctx.get("dispersion_models") or []
        if models:
            m0 = models[0]
            t0 = self.now - timedelta(hours=float(self.rng.uniform(20, 60)))
            rows.append({
                "id": "al-windshift-00", "campaign_id": self.cid, "kind": "wind_shift",
                "severity": "watch", "measure": None, "value": None, "threshold": None, "unit": None,
                "source_type": "model", "source_id": m0.get("id"),
                "lon": self.site_by_id["site-ridgeline"]["centroid"][0],
                "lat": self.site_by_id["site-ridgeline"]["centroid"][1],
                "site_id": "site-ridgeline", "action_level_id": None,
                "started_at": _ts(t0), "ended_at": None, "status": "active",
                "title": "Measured wind disagrees with the dispersion study",
                "body": ("The permit model assumes the north half of the rose almost never happens. "
                         "Our vehicle wind observations put it far higher, and higher still inside "
                         "shift episodes. The modelled plume and the measured plume do not point "
                         "the same way."),
                "recommendation": "Re-run the dispersion study against measured wind before the next permit filing.",
                "audience_json": json.dumps(["regulator", "industry", "admin"]),
                "created_at": _ts(min(t0 + timedelta(hours=1), self.now)),
            })

        # 5 -- a fleet gap.  Admin's problem, and an honest one: coverage is a
        #      claim the product has to keep earning.
        veh = [v for v in self.ctx["vehicles"] if v.get("status") == "maintenance"]
        if veh:
            t0 = self.now - timedelta(hours=float(self.rng.uniform(10, 30)))
            rows.append({
                "id": "al-fleet-00", "campaign_id": self.cid, "kind": "fleet_anomaly",
                "severity": "info", "measure": None, "value": None, "threshold": None, "unit": None,
                "source_type": "regulator", "source_id": veh[0]["id"],
                "lon": None, "lat": None, "site_id": None, "action_level_id": None,
                "started_at": _ts(t0), "ended_at": None, "status": "active",
                "title": f"{veh[0].get('call_sign') or veh[0]['id']} out of service",
                "body": "One vehicle down for maintenance. Its routes are being absorbed by the rest of the fleet, so passes on its blocks will thin out until it returns.",
                "recommendation": "Rebalance the drive plan or accept reduced passes on the affected blocks.",
                "audience_json": json.dumps(["admin", "regulator"]),
                "created_at": _ts(min(t0 + timedelta(minutes=12), self.now)),
            })

        cols = ("id, campaign_id, kind, severity, measure, value, threshold, unit, source_type, "
                "source_id, lon, lat, site_id, action_level_id, started_at, ended_at, status, "
                "title, body, recommendation, audience_json, created_at")
        self.conn.executemany(
            f"INSERT INTO alert ({cols}) VALUES ({','.join('?' * 22)})",
            [tuple(r[c.strip()] for c in cols.split(",")) for r in rows],
        )
        live_ids = {r["id"] for r in rows}
        self.conn.executemany(
            "INSERT OR IGNORE INTO alert_sample (alert_id, ts, value) VALUES (?,?,?)",
            [s for s in samples if s[0] in live_ids],
        )
        self.alert_rows = rows

        for r in rows:
            ts = datetime.strptime(r["created_at"], TS_FMT)
            self._log(ts, "admin", None, "alert.raised", "alert", r["id"], r["title"],
                      {"kind": r["kind"], "severity": r["severity"], "measure": r["measure"]})
            if r["severity"] in ("warning", "critical"):
                self._notify(ts, None, "regulator", r["kind"], r["severity"], r["title"],
                             r["body"] or "", f"/regulator/alerts/{r['id']}")
                if r["site_id"]:
                    self._notify(ts, None, "industry", r["kind"], r["severity"], r["title"],
                                 r["body"] or "", f"/industry/alerts/{r['id']}")

        # Acknowledgements -- the regulator works the queue rather than watching it.
        for r in rows:
            worked = r["status"] == "acknowledged" or (
                r["status"] in ("active", "resolved") and self.rng.random() < 0.35)
            if worked:
                u = self._pick(self.regulators)
                born = datetime.strptime(r["created_at"], TS_FMT)
                at = min(born + timedelta(minutes=float(self.rng.uniform(12, 300))), self.now)
                note = self._pick([
                    "Confirmed against the reference trace. Watching it.",
                    "Cross-checked with the mobile passes. Consistent.",
                    "Operator contacted. Awaiting a response.",
                    "Holding for one more hour before we notify the public.",
                ])
                self.conn.execute(
                    "INSERT OR IGNORE INTO alert_ack (alert_id, user_id, note, created_at) VALUES (?,?,?,?)",
                    (r["id"], u["id"], note, _ts(at)))
                self._log(at, "regulator", u["id"], "alert.acknowledged", "alert", r["id"],
                          f"{u['name']} acknowledged: {r['title']}", {"note": note})

    # ---------------------------------------------------- industry replies

    def write_industry_replies(self, episodes: list[dict]) -> None:
        """What the operators say -- and the ceiling on what it can do.

        Every reply here stops at `mitigation_proposed`.  Nothing an operator
        writes moves a concern to `resolved`; that asymmetry is the product's
        most important honesty guarantee and the data must not undercut it.
        """
        posts: list[tuple] = []
        mits: list[tuple] = []
        by_id = {c["id"]: c for c in self.concern_rows}

        intro = {
            "site-ridgeline": ("We are your neighbours on the south side",
                               "Ridgeline South Campus runs compute for AI workloads. We hold an air permit for our "
                               "turbines and backup generators, and we publish what we are doing about the concerns "
                               "raised here. We do not decide whether a report is resolved."),
            "site-deltaforge": ("Delta Forge on Channel Avenue",
                                "We have operated the Channel Avenue works for decades. Our furnace cycles are the "
                                "most likely thing you notice from us, and we post when we change them."),
            "site-riverport": ("Riverport Intermodal, north-east of the neighbourhood",
                               "We move containers. Most of what reaches you from us is truck traffic on the approach "
                               "roads, and that is where we are focusing."),
        }
        for s in self.sites:
            title, body = intro[s["id"]]
            t = self.start + timedelta(days=float(self.rng.uniform(1, 6)))
            posts.append((f"sp-intro-{s['id'][-6:]}", self.cid, s["id"], s["org_id"],
                          self._pick([u for u in self.industry_users if u["org_id"] == s["org_id"]] or self.industry_users)["id"],
                          "intro", title, body, None, "\U0001f3e2", 1, _ts(t)))

        mi = 0
        for ep in episodes:
            if not ep["site_id"] or ep.get("cluster_count", 0) < 3:
                continue
            # Not every cluster gets an answer.  Silence is also a position, and
            # a demo where industry always replies is a demo that flatters them.
            if self.rng.random() < 0.25:
                continue
            site_id = ep["site_id"]
            org = self.org_by_site[site_id]
            author = self._pick([u for u in self.industry_users if u["org_id"] == org] or self.industry_users)
            target = by_id[ep["concern_ids"][0]]
            t_reply = ep["t"] + timedelta(hours=float(self.rng.uniform(6, 40)))
            if t_reply > self.now:
                t_reply = self.now - timedelta(hours=float(self.rng.uniform(1, 5)))

            action, detail, pct, measure = _mitigation_for(ep["cause"], self.rng)
            mid = f"mt-{mi:03d}"
            mi += 1
            age_h = (self.now - t_reply).total_seconds() / 3600.0
            if age_h > 400:
                status, completed = "completed", _ts(t_reply + timedelta(days=float(self.rng.uniform(3, 20))))
            elif age_h > 60:
                status, completed = "in_progress", None
            else:
                status, completed = "proposed", None
            mits.append((mid, site_id, target["id"], ep["cluster_id"], (ep["alert_ids"] or [None])[0],
                         action, detail, status, measure, pct, _ts(t_reply), completed, _ts(t_reply)))

            # The post is the neighbour-facing half and has to *read* like it.
            # It shares an id and a subject with the mitigation but not a
            # sentence: the mitigation records the mechanism for the operator
            # and the regulator, the post speaks to the person who filed the
            # report. Restating `detail` verbatim in both put two cards with
            # identical body text side by side on the oversight screen.
            #
            # It also has to obey the community language rule -- this lands in a
            # resident's feed, where "no2" is not a word.
            plain = _PLAIN.get(measure or "", "what we put in the air")
            posts.append((f"sp-{mid}", self.cid, site_id, org, author["id"], "mitigation",
                          f"What we are doing about the reports near {ep['road']}",
                          f"We have read the reports from {ep['road']} and we think they line up with "
                          f"our own records for those hours. {action}. We expect that to cut the "
                          f"{plain} coming from us by roughly {int(pct)} percent, and we will post "
                          "again once it is done. This is what we are attempting. It is not a finding, "
                          "and it does not close anyone's report.",
                          target["id"], "\U0001f527", 0, _ts(t_reply)))

            for cid_ in ep["concern_ids"]:
                row = by_id[cid_]
                if row["status"] not in ("resolved", "closed"):
                    row["status"] = "mitigation_proposed"
                self.conn.execute("UPDATE concern SET status=? WHERE id=?", (row["status"], cid_))

            self.conn.execute(
                "INSERT INTO concern_response (id, concern_id, author_id, org_id, role, kind, body, created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (f"cr-{mid}", target["id"], author["id"], org, "industry", "mitigation",
                 f"{detail} We are logging this against the reports from {ep['road']}. "
                 "We cannot mark your report resolved, and we are not asking for that.", _ts(t_reply)))

            self._log(t_reply, "industry", author["id"], "mitigation.proposed", "mitigation", mid,
                      f"{self.site_by_id[site_id]['name']} proposed: {action}",
                      {"site_id": site_id, "cluster_id": ep["cluster_id"], "closes_concern": False})
            self._notify(t_reply, None, "community", "mitigation", "info",
                         f"{self.site_by_id[site_id]['name']} replied to reports near {ep['road']}",
                         "An operator says it attempted a fix. Your report stays open.",
                         f"/community/concerns/{target['id']}")

        # A couple of routine operational posts so the outreach page is not
        # only crisis management.
        for s in self.sites[:2]:
            t = self.now - timedelta(days=float(self.rng.uniform(2, 25)))
            posts.append((f"sp-upd-{s['id'][-6:]}", self.cid, s["id"], s["org_id"],
                          self._pick(self.industry_users)["id"], "update",
                          "Scheduled maintenance window next week",
                          "We will be running equipment outside the usual hours for two nights. "
                          "You may notice more noise than normal. We are posting ahead rather than after.",
                          None, "\U0001f4c5", 0, _ts(t)))

        self.conn.executemany(
            "INSERT INTO site_post (id, campaign_id, site_id, org_id, author_id, kind, title, body, "
            "concern_id, media_emoji, pinned, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", posts)
        self.conn.executemany(
            "INSERT INTO mitigation (id, site_id, concern_id, cluster_id, alert_id, title, body, status, "
            "measure, expected_reduction_pct, started_at, completed_at, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", mits)

        for p in posts:
            self._log(datetime.strptime(p[11], TS_FMT), "industry", p[4], "post.published",
                      "site_post", p[0], p[6], {"site_id": p[2]})

    # -------------------------------------------------- regulator actions

    def write_regulator_actions(self, episodes: list[dict]) -> None:
        """Advisories to the public, enforcement to the operators, findings that close.

        The regulator is the only actor here that can end a concern's life, which
        is what makes them the referee rather than a third opinion.
        """
        advs: list[tuple] = []
        enfs: list[tuple] = []
        by_id = {c["id"]: c for c in self.concern_rows}

        # Advisories ride on the alerts whose action level says notify_community.
        al_by_id = {a["id"]: a for a in self.action_levels}
        pushed = 0
        for r in sorted(self.alert_rows, key=lambda x: x["started_at"], reverse=True):
            al = al_by_id.get(r["action_level_id"] or "")
            if not al or not al["notify_community"] or pushed >= 6:
                continue
            author = self._pick(self.regulators)
            t = datetime.strptime(r["created_at"], TS_FMT) + timedelta(minutes=float(self.rng.uniform(20, 180)))
            if t > self.now:
                t = self.now - timedelta(minutes=float(self.rng.uniform(5, 120)))
            plain = _PLAIN.get(r["measure"] or "", "air pollution")
            advs.append((f"adv-{pushed:02d}", self.cid, "org-draqa", author["id"],
                         "warning" if r["severity"] in ("warning", "critical") else "advisory",
                         r["severity"], f"Air quality notice for {_area_of(r, self.monitors)}",
                         f"Levels of {plain} went above the level we act on. If you are outside and it "
                         "bothers you, come in and close your windows for now. We will post again when "
                         "it comes back down.",
                         r["measure"], r["id"], json.dumps(["community"]), _ts(t),
                         _ts(min(t + timedelta(hours=18), self.now + timedelta(hours=18))),
                         1 if pushed == 0 else 0))
            self._log(t, "regulator", author["id"], "advisory.published", "advisory", f"adv-{pushed:02d}",
                      f"{author['name']} pushed a public advisory for {plain}", {"alert_id": r["id"]})
            self._notify(t, None, "community", "advisory", r["severity"],
                         f"Air quality notice for {_area_of(r, self.monitors)}",
                         "The air agency posted a notice for your area.", "/community")
            pushed += 1

        # An all-clear, because a regulator that only ever warns is not credible.
        if advs:
            t = self.now - timedelta(hours=float(self.rng.uniform(30, 90)))
            author = self._pick(self.regulators)
            advs.append(("adv-clear", self.cid, "org-draqa", author["id"], "all_clear", "info",
                         "Back to normal in Boxtown and White Chapel",
                         "The levels we warned about yesterday have come back down. Nothing further to do.",
                         None, None, json.dumps(["community"]), _ts(t), None, 0))

        # Enforcement -- what actually lands on an operator's desk.
        ei = 0
        for ep in episodes:
            if not ep["site_id"] or ep.get("cluster_count", 0) < 5:
                continue
            site_id = ep["site_id"]
            t = ep["t"] + timedelta(hours=float(self.rng.uniform(20, 90)))
            if t > self.now:
                continue
            age_d = (self.now - t).days
            kind = "notice_of_violation" if ep["cluster_count"] >= 8 else self._pick(
                ["inquiry", "request_for_info", "site_visit"])
            if age_d > 30:
                status, closed = ("closed", _ts(t + timedelta(days=float(self.rng.uniform(8, 25)))))
            elif age_d > 8:
                status, closed = ("responded", None)
            else:
                status, closed = ("open", None)
            enfs.append((f"enf-{ei:02d}", self.cid, site_id, "org-draqa", kind, status,
                         f"{_ENF_TITLE[kind]} — {self.site_by_id[site_id]['name']}",
                         f"Following {ep['cluster_count']} clustered resident reports near {ep['road']} and "
                         "the monitor record for the same window, we are requiring the operator to account "
                         "for operations during those hours.",
                         (ep["alert_ids"] or [None])[0], _ts(t),
                         _ts(t + timedelta(days=21)), closed))
            self._log(t, "regulator", self._pick(self.regulators)["id"], "enforcement.opened",
                      "enforcement_action", f"enf-{ei:02d}", f"{_ENF_TITLE[kind]} issued to "
                      f"{self.site_by_id[site_id]['name']}", {"site_id": site_id, "kind": kind})
            self._notify(t, None, "industry", "enforcement", "warning",
                         f"{_ENF_TITLE[kind]} from the air agency",
                         "The regulator has opened an action against your site.", "/industry/alerts")
            ei += 1

            # The finding that actually closes the loop.  Only this path resolves.
            if status == "closed":
                author = self._pick(self.regulators)
                tf = datetime.strptime(closed, TS_FMT)
                finding = ("We reviewed the monitor record and the operator's response for this "
                           "window. The operator has changed how it runs that equipment overnight "
                           "and we have verified the change. We are closing these reports.")
                # One finding per report, not one per cluster.  A resident opening
                # their own report has to see who closed it and why -- otherwise
                # the status changes under them with no visible author, which is
                # precisely the opacity the product exists to remove.
                for k, cid_ in enumerate(ep["concern_ids"]):
                    self.conn.execute(
                        "INSERT INTO concern_response (id, concern_id, author_id, org_id, role, kind, body, created_at) "
                        "VALUES (?,?,?,?,?,?,?,?)",
                        (f"cr-find-{ei:02d}-{k:02d}", cid_, author["id"], "org-draqa",
                         "regulator", "finding", finding, closed))
                    self.conn.execute("UPDATE concern SET status='resolved' WHERE id=?", (cid_,))
                    by_id[cid_]["status"] = "resolved"
                self._log(tf, "regulator", author["id"], "concern.resolved", "concern_cluster",
                          ep["cluster_id"], f"{author['name']} closed {len(ep['concern_ids'])} reports "
                          f"near {ep['road']} after a verified change", {"cluster_id": ep["cluster_id"]})

        self.conn.executemany(
            "INSERT INTO advisory (id, campaign_id, org_id, author_id, kind, severity, title, body, "
            "measure, alert_id, audience_json, created_at, expires_at, pinned) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", advs)
        self.conn.executemany(
            "INSERT INTO enforcement_action (id, campaign_id, site_id, org_id, kind, status, title, body, "
            "alert_id, created_at, due_at, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", enfs)

        # The action levels themselves were set by someone, on a date. Showing
        # that in the oversight log is what makes them feel editable rather than
        # handed down.
        for al in self.action_levels[:5]:
            t = self.start + timedelta(days=float(self.rng.uniform(0, 4)))
            u = self._pick(self.regulators)
            self._log(t, "regulator", u["id"], "action_level.updated", "action_level", al["id"],
                      f"{u['name']} set {al['label']} to {al['threshold']:g} {al['unit']}",
                      {"threshold": al["threshold"], "source": al["source"]})

    # ------------------------------------------------- notifications, log

    def write_notifications(self) -> None:
        rows = []
        for i, (ts, user_id, role, kind, severity, title, body, link) in enumerate(self.notifications):
            if ts > self.now:
                ts = self.now
            # Role-wide notices fan out to the people in that role, which is what
            # gives each persona a plausible unread count.
            targets = [user_id] if user_id else [
                u["id"] for u in self.users if u["role"] == role][:3]
            for j, uid in enumerate(targets):
                age_h = (self.now - ts).total_seconds() / 3600.0
                read = None if age_h < 8 or self.rng.random() < 0.25 else _ts(
                    ts + timedelta(hours=float(self.rng.uniform(0.5, 6))))
                rows.append((f"nt-{i:04d}-{j}", self.cid, uid, role, kind, severity,
                             title, body, link, _ts(ts), read))
        self.conn.executemany(
            "INSERT INTO notification (id, campaign_id, user_id, role, kind, severity, title, body, "
            "link, created_at, read_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)

    def write_activity(self) -> None:
        """One chronological record of everything all three sides did.

        This is the admin oversight feed, and it is the only place the whole
        argument is visible at once: the report, the alert it raised, the
        operator's answer, and the regulator's ruling, in the order they
        actually happened.
        """
        rows = []
        for ts, role, actor, verb, obj_type, obj_id, summary, payload in sorted(
                self.activity, key=lambda a: a[0]):
            if ts > self.now:
                ts = self.now
            rows.append((self.cid, _ts(ts), role, actor, verb, obj_type, obj_id,
                         summary, json.dumps(payload)))
        self.conn.executemany(
            "INSERT INTO activity (campaign_id, ts, actor_role, actor_id, verb, object_type, "
            "object_id, summary, payload_json) VALUES (?,?,?,?,?,?,?,?,?)", rows)


# ------------------------------------------------------------- copy tables

_PLAIN = {
    "no2": "traffic and engine fumes", "pm25": "smoke and dust", "bc": "diesel soot",
    "o3": "smog", "co": "invisible exhaust gas", "ch4": "natural gas",
    "diesel": "diesel exhaust",
}

_ENF_TITLE = {
    "inquiry": "Inquiry",
    "request_for_info": "Request for information",
    "notice_of_violation": "Notice of violation",
    "stipulation": "Stipulated agreement",
    "site_visit": "Site visit scheduled",
}


def _area_of(alert: dict, monitors: list[dict]) -> str:
    for m in monitors:
        if m["id"] == alert.get("source_id"):
            return f"the {m['name']} area"
    return "southwest Memphis"


def _recommendation(code: str, severity: str, site_id: str | None, sites: dict) -> str:
    """The alert's stored recommendation, read by every room.

    It no longer names a site. For a Warning or worse it used to add "Wind at
    the time carried from <site>; expect to be asked about it." — naming a
    site on the wind alone, which F7 / D7 forbids in every room (the
    placebo-checked downwind test has to agree, and the generator has not run
    it). `site_id` and `severity` stay in the signature so the call and the
    RNG draw order are unchanged; shapes.unname strips the old clause from
    databases built before this. The NO2 line named a datacentre's equipment
    for every site; it is site-neutral now, and /alerts?site_id= words it for
    the site it is served to.
    """
    del site_id, severity, sites
    base = {
        "no2": "Check what was burning on site in this window.",
        "pm25": "Confirm whether this is regional haze or a local source before acting.",
        "bc": "Look at diesel movements on the approach roads.",
        "o3": "Regional and largely not locally controllable; document and monitor.",
        "co": "Check combustion efficiency on anything running at the time.",
        "ch4": "Survey for leaks on foot; the fixed network cannot see this.",
        "diesel": "Look at diesel movements and idling on the approach roads.",
    }.get(code, "Review operations for this window.")
    return base


def _mitigation_for(cause: str, rng) -> tuple[str, str, float, str | None]:
    options = {
        "generator_test": [
            ("Move load tests out of the overnight window",
             "We have moved our generator load tests from the small hours to mid-morning, when the air "
             "mixes instead of holding everything at street level.", 35.0, "no2"),
            ("Stagger turbine starts",
             "Rather than bringing the bank up together we are staggering starts across twenty minutes, "
             "which cuts the peak even though the total run is the same.", 22.0, "no2"),
        ],
        "truck_surge": [
            ("Hold trucks inside the gate instead of on the shoulder",
             "We have opened the yard earlier so drivers queue inside rather than idling on the public "
             "road next to houses.", 40.0, "bc"),
            ("No-idle rule on the approach roads",
             "We have written a no-idle rule into our carrier agreements and we are enforcing it at the "
             "gate.", 28.0, "diesel"),
        ],
        "furnace_cycle": [
            ("Delay furnace cycles when the air is still",
             "We are holding furnace cycles when the forecast shows still air and a low ceiling, and "
             "running them when there is wind to carry it away.", 30.0, "pm25"),
            ("Additional baghouse maintenance",
             "We have brought forward filter maintenance on the affected line.", 18.0, "pm25"),
        ],
        "gas_leak": [
            ("Line survey on the affected blocks",
             "We have asked the utility to survey the block. This is not our line, but it was reported "
             "to us and we passed it on the same day.", 0.0, "ch4"),
        ],
    }[cause]
    return options[int(rng.integers(len(options)))]
