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
python3 -m air.datagen.build build --seed 20260827   # rebuild data/air.db
```

**Never pipe a command whose exit code you intend to read.** `cmd | head -20`
and `cmd | tail -40` both exit with *head/tail's* status, not the command's.
This masked two separate failures in one session: a typecheck that checked
nothing, and a failed Cloud Run deploy that reported success. Redirect to a file
and read it, or run unpiped and check `$?`.

## Servers

`dev/serve.sh` (API, :8000) and `dev/web.sh` (vite, :5173) both APPEND to
`var/*.log` with timestamped start banners. Read the tail of those logs before
believing anything about server state — vite mirrors browser console errors into
`var/vite.log`, which is how transform failures surface.

## Deployment

Live demo, runbook and the two things that broke on the way: `docs/DEPLOY.md`.

## Current work

`docs/PLAN-sense.md` is the resume point for the measure-selection and
`aclima_sense` work — design decisions, task boxes, and the four places the
original design was contradicted by measurement.
