#!/usr/bin/env python3
"""P5-B — does the operating envelope survive a reseed?

Phase 2's rule, applied before any copy is written: **the beat may be depended
on, the number may not**. The Boxtown touchdown survived four seeds and its
magnitude moved by a factor of 1.8; Riverport's detection appeared in two of
four and may not carry a demo beat. This asks the same question of the
envelope, which is a much larger effect and should survive comfortably — but
"should" is what phase 2 exists to stop us saying.

    for S in 20260828 20260829 20260830; do
      uv run python -m air.datagen.build build --seed $S \
        --now 2026-08-28T13:54:00 --quiet --db /tmp/seed_$S.db
    done
    uv run python scripts/probe_envelope.py --db data/air.db --also /tmp/seed_*.db
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from air.server import envelope as env  # noqa: E402

SITES = ("site-ridgeline", "site-deltaforge", "site-riverport")


def one(db: Path, measure: str) -> dict:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    levels = [
        dict(r)
        for r in conn.execute(
            "SELECT id,label,measure,threshold,unit,severity,source FROM action_level "
            "WHERE measure=? AND enabled=1 ORDER BY threshold",
            (measure,),
        )
    ]
    cid = conn.execute("SELECT id FROM campaign LIMIT 1").fetchone()[0]
    p = env.load(conn, cid, measure)
    nulls = env.decoy_null(p, measure, env.REGIMES["stable"])
    out = {"_null_p95": float(np.percentile(np.abs(nulls), 95)) if nulls.size else None}
    for site in SITES:
        load = conn.execute(
            "SELECT it_load_mw FROM industry_site WHERE id=?", (site,)
        ).fetchone()
        e = env.estimate(conn, p, site, measure, levels[0]["unit"] if levels else "",
                         load[0] if load else None, levels)
        stable = next(r for r in e.regimes if r.regime == "stable")
        day = next(r for r in e.regimes if r.regime == "unstable")
        out[site] = {
            "stable_excess": stable.excess,
            "stable_p50": stable.level_p50,
            "day_excess": day.excess,
            "state": stable.state,
            "share_over": stable.thresholds[0].share_over if stable.thresholds else None,
            "cut_pct": stable.thresholds[0].cut_pct_typical if stable.thresholds else None,
        }
    conn.close()
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=Path("data/air.db"))
    ap.add_argument("--also", nargs="*", type=Path, default=[])
    ap.add_argument("--measure", default="no2")
    args = ap.parse_args(argv)

    dbs = [args.db, *args.also]
    results = []
    for db in dbs:
        if not db.exists():
            print(f"   (missing {db})")
            continue
        results.append((db.stem, one(db, args.measure)))

    print(f"# Envelope across {len(results)} seeds — {args.measure}\n")
    print(f"   {'database':16}{'decoy p95':>11}", end="")
    for s in SITES:
        print(f"{s.replace('site-', ''):>28}", end="")
    print()
    print(f"   {'':16}{'':>11}" + "".join(f"{'day / night  state':>28}" for _ in SITES))
    for name, r in results:
        print(f"   {name:16}{r['_null_p95']:>11.2f}", end="")
        for s in SITES:
            d = r[s]
            day = f"{d['day_excess']:+.1f}" if d["day_excess"] is not None else "  —"
            night = f"{d['stable_excess']:+.1f}" if d["stable_excess"] is not None else "  —"
            print(f"{day:>8} /{night:>7}  {d['state']:<10}", end="")
        print()

    print()
    for s in SITES:
        vals = [r[s]["stable_excess"] for _n, r in results if r[s]["stable_excess"] is not None]
        states = {r[s]["state"] for _n, r in results}
        if not vals:
            print(f"   {s:17} no estimate in any seed")
            continue
        print(f"   {s:17} stable excess {min(vals):+.1f} to {max(vals):+.1f} "
              f"(x{max(vals) / max(1e-9, min(vals)):.2f})   states {sorted(states)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
