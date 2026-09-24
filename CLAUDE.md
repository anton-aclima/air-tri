# Working in this repo

## Verification commands — use these exact ones

```sh
# Web typecheck. MUST be `-b`: the root tsconfig.json is solution-style
# (references only, no include/files), so `tsc --noEmit` finds ZERO files and
# exits 0 on a codebase full of errors. This was believed to be a passing
# typecheck for an entire session; a JSX syntax error reached the dev server
# through it. `npm run build` uses `tsc -b` for the same reason.
cd web && npx tsc -b --force

cd web && npx oxlint src        # the repo's linter

# Python tests. `uv run` because pytest is in the dev dependency group, which
# `uv sync --no-dev` deliberately keeps out of the deployed image.
uv run pytest

# Rebuild data/air.db. `--now` is NOT optional if you intend to compare any
# number to a number written down earlier. Without it the generator anchors the
# campaign to wall-clock time, so every rebuild shifts the whole 90 days and no
# measurement is reproducible. 2026-08-28T13:54:00 is what `setting`
# ('datagen.now') holds in the checked-in database.
python3 -m air.datagen.build build --seed 20260827 --now 2026-08-28T13:54:00
```

**Adding a column to `schema.sql` does nothing to an existing database.** Every
statement there is `CREATE TABLE IF NOT EXISTS`, so SQLite silently skips the
table and the build dies later with `table drive has no column named
sampling_mode` — a symptom that looks like a code bug. There are no migrations
on purpose (the database is generated), so the fix is always to delete it:

```sh
rm -f data/air.db data/air.db-wal data/air.db-shm
```

`apply_schema` now detects the drift up front and says exactly that.

**The deployed image deliberately does NOT pin `--now`** (the `air.datagen.build` line in the Dockerfile), so a
container's data ends on its own build date and the fleet layer is alive the
moment it boots. That is right for the demo and it means **prod numbers and
local numbers are not comparable** — never check one against the other.

**Never pipe a command whose exit code you intend to read.** `cmd | head -20`
and `cmd | tail -40` both exit with *head/tail's* status, not the command's.
This masked two separate failures in one session: a typecheck that checked
nothing, and a failed Cloud Run deploy that reported success. Redirect to a file
and read it, or run unpiped and check `$?`.

## Tests

`tests/` is pytest, run with `uv run pytest`. Two things to know:

- **DB-backed tests carry `@pytest.mark.needs_db`** and skip when `data/air.db`
  is absent (it is gitignored). Pure-geometry tests run on a fresh clone.
- **Every route lives under `/api/v1`** and the SPA catch-all serves HTML for
  everything else — so a wrong path returns **200 with an HTML body**, not a
  404. Use the `api` and `json_ok` fixtures; `json_ok` checks the content type
  for exactly this reason.

There are no expected failures. The last one (non-negotiable #5, the community
fleet delay) was fixed by the one clock below and its marker removed.

## Time: one clock, naive, frozen

Every timestamp is **naive campaign time** — `YYYY-MM-DDTHH:MM:SS`, no `Z`, the
digits datagen writes. The demo's **now is the build instant** and never moves:
server `timeutil.now()` = `setting('datagen.now')`; client `time.cursor === null`
means *paused at the end of the data*. Never `toISOString()` for a campaign time
and never `Date.now()`/`new Date()` for "now" — use `web/src/core/clock.ts` and
the session helpers. The full contract is the "Phase 2 contract" section of
`docs/PLAN-refocus.md`. This is why `--now` still matters: it sets the instant
the whole product is frozen at.

## The touchdown estimator

`scripts/probe_touchdown.py` is throwaway analysis that produced a decision.
The decision is pinned by `tests/fixtures/touchdown_frozen.json` and the
reasoning is the sweep table in `docs/PLAN-plume.md` (phase 2). **Do not
regenerate the fixture to make a red test green** — that throws away the only
record of why the estimator looks like this.

```sh
uv run python scripts/probe_touchdown.py sweep     # 64 configs x 3 sites x 2 measures
uv run python scripts/probe_touchdown.py frozen    # what the chosen config returns
uv run python scripts/probe_touchdown.py null      # the noise floor, from 14 fake bearings
uv run python scripts/probe_touchdown.py samples   # conditioned sample sizes
```

Two rules from that phase bind everything downstream:

- **Nothing past 4,200 m is reportable** until P3-A lands. Beyond it `field.py`
  clips the truth field to zero, and an estimator run there passed both
  rotation tests on a plume that does not exist.
- **The Boxtown beat may be depended on; its number may not.** The place holds
  across four seeds (77–94% of downwind passes); the magnitude moves +2.9 to
  +5.3 ppb. Generate every figure from the payload at runtime.

## Servers

`dev/serve.sh` (API, :8000) and `dev/web.sh` (vite, :5173) both APPEND to
`var/*.log` with timestamped start banners. Read the tail of those logs before
believing anything about server state — vite mirrors browser console errors into
`var/vite.log`, which is how transform failures surface.

## Deployment

Live demo, runbook and the two things that broke on the way: `docs/DEPLOY.md`.

## Current work

`docs/PLAN-refocus.md` is the resume point for the owner's zoom-out review:
four surfaces redesigned (time control, community, regulator, industry), the
owner's 13 decisions (§6a), and the order of work (§5).

`docs/PLAN-sense.md` is the resume point for the measure-selection and
`aclima_sense` work — design decisions, task boxes, and the four places the
original design was contradicted by measurement.
