# Hosting the demo on GCP

> **LIVE:** <https://air-demo-224782196484.us-central1.run.app>
> `aclima-lab` / `us-central1` / service `air-demo`, behind IAP restricted to
> `domain:aclima.earth`. Deployed and verified 2026-09-02.
>
> Redeploy: `PROJECT=aclima-lab sh deploy/cloudrun.sh`
> Tear down: `gcloud run services delete air-demo --region us-central1 --project aclima-lab`
> Stop the bill without deleting: `gcloud run services update air-demo --region us-central1 --project aclima-lab --min-instances 0`

Written for someone who knows Supabase + Railway + Netlify and has not used GCP.
The short translation:

| your stack | here | why |
|---|---|---|
| Railway | **Cloud Run** | Same idea: hand it a repo, get a container and an HTTPS URL. |
| Netlify | **nothing** | `app.py` already serves `web/dist` at `/` with an SPA fallback. One origin, no CORS, no second deploy. |
| Supabase | **nothing, yet** | The database is a SQLite file *inside* the container. This is the one real compromise — see below. |

So: one image, one service, one URL.

---

## Before you touch anything

Checked against `aclima-lab` on 2026-09-02, so this is a record rather than
advice:

1. **Project: `aclima-lab` ("The Lab")**, inside the Aclima org, with
   `anton.vattay@aclima.earth` as `roles/owner`. `run`, `cloudbuild`,
   `artifactregistry`, `iap` and `secretmanager` were all already enabled, so
   the `gcloud services enable` line below is a no-op there.
2. **Region: `us-central1`.** Five existing services in `aclima-lab` all live
   there, so that is the house convention and the script's default.
3. **Org policy does NOT protect you.**
   `constraints/iam.allowedPolicyMemberDomains` is `allValues: ALLOW`, so
   `allUsers` is **not** blocked. Many orgs forbid it and I had assumed this one
   would; it does not. There is therefore no guardrail between this service and
   the open internet except the flags in `deploy/cloudrun.sh`. Do not drop
   `--no-allow-unauthenticated`, and do not take a tutorial's
   `--allow-unauthenticated` at face value.

Then, once:

```sh
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

---

## Deploy

```sh
PROJECT=<PROJECT_ID> sh deploy/cloudrun.sh
```

That builds the image with Cloud Build and deploys it. First build takes ~5
minutes; the demo world is generated *inside* the image and that alone is ~110
seconds. Subsequent builds reuse the npm and pip layers.

The flags and the reasoning behind each are in `deploy/cloudrun.sh`. The one
you must not change is **`--max-instances 1`**.

### The build needs `data/cache/`, and that is not optional

The datagen builds its road network from an **OpenStreetMap extract fetched
from Overpass**, cached under `data/cache/` — three files, 748 KB. `osm.py`
never re-fetches a cached file, but with no cache present it falls through to a
live Overpass call.

The first Cloud Build failed on exactly that, ten minutes in:

```
RuntimeError: Overpass fetch for 'osm_places' failed: Overpass mirror
https://overpass.osm.ch/api/interpreter returned only 0 elements
```

The local Docker build had succeeded an hour earlier only because Overpass
happened to answer. So `.dockerignore` and `.gcloudignore` exclude `data/*` but
re-include `data/cache`, and the Dockerfile copies it in before running the
generator.

Two consequences worth keeping in mind:

- **`data/cache/` is gitignored**, so the build works from a machine that has
  it and would fail the same way from a clean clone or from CI. If anyone other
  than you ever needs to deploy this, either commit the cache (748 KB, and the
  UI already carries the `© OpenStreetMap` attribution ODbL wants) or park it in
  a GCS bucket the build pulls from.
- **It pins the world.** Shipping the cache means the deployed road network is
  the same one the demo was developed against, rather than whatever Overpass
  serves on build day. That is the more important reason to keep doing it.

### Building locally, and the arm64 trap

To iterate on the image without waiting on Cloud Build:

```sh
docker build -t air-demo:local .
docker run --rm -p 8080:8080 -e PORT=8080 air-demo:local
# http://localhost:8080
```

On an Apple Silicon Mac that produces an **arm64** image. Cloud Run runs
**linux/amd64 only**, so a locally-built image cannot be pushed and deployed as
is — it will fail to start with an exec-format error that does not obviously say
"wrong architecture".

`deploy/cloudrun.sh` sidesteps this entirely: `--source .` builds on Cloud
Build, which is amd64. Local builds are for testing the Dockerfile, not for
shipping. If you ever do want to push one from this machine:

```sh
docker build --platform linux/amd64 -t air-demo:amd64 .
```

Expect it to be several times slower under emulation, and note that the
in-image datagen step (~110 s native) is the part that suffers most.

---

## Letting colleagues in

The service deploys with `--no-allow-unauthenticated`, so the URL returns 403
until you grant access. Three ways, in the order I would actually do them.

### 1. IAM + the local proxy — *not used, kept for reference*

This was the interim plan before IAP went in. It no longer works against
`air-demo` as configured, because the invoker policy names only the IAP service
agent. Useful if you ever stand up a second service and want engineer-only
access without IAP.

```sh
gcloud run services add-iam-policy-binding air-demo \
  --region us-central1 \
  --member 'user:someone@aclima.earth' \
  --role roles/run.invoker
```

They then run, on their own machine:

```sh
gcloud run services proxy air-demo --region us-central1 --port 8080
# opens the demo at http://localhost:8080
```

Real Google identity, real IAM, nothing public. The catch is that they need
`gcloud` installed, which rules out anyone non-technical.

### 2. IAP, restricted to the domain — **this is what is deployed**

Done and verified end to end on 2026-09-02. Anyone with an `@aclima.earth`
Google account can open the URL; everyone else gets the sign-in wall.

```sh
# 1. Put IAP in front. This also creates the IAP service agent and grants it
#    run.invoker on the service — gcloud prints "Setting IAP service agent".
gcloud run services update air-demo --project aclima-lab --region us-central1 --iap

# 2. Grant the domain access. NOTE THE RESOURCE: this role lives on the IAP
#    resource, NOT on the Cloud Run service.
gcloud iap web add-iam-policy-binding \
  --project aclima-lab \
  --resource-type=cloud-run \
  --region=us-central1 \
  --service=air-demo \
  --member='domain:aclima.earth' \
  --role='roles/iap.httpsResourceAccessor'
```

**The trap, which I walked into first:** doing step 2 against the Cloud Run
service fails with `INVALID_ARGUMENT: Role roles/iap.httpsResourceAccessor is
not supported for this resource`. It has to be `gcloud iap web
add-iam-policy-binding --resource-type=cloud-run`, and `--region` is mandatory
with that resource type.

Resulting state, both checked:

```
IAP policy           roles/iap.httpsResourceAccessor -> domain:aclima.earth
Cloud Run invoker    ONLY serviceAccount:service-<num>@gcp-sa-iap.iam.gserviceaccount.com
unauthenticated      302 -> accounts.google.com
raw owner ID token   401
browser, signed in as an aclima.earth account   works
```

**IAP is the only door, and that is deliberate.** `--iap` scoped the Cloud Run
invoker role to the IAP service agent alone, so nobody — not even a project
owner with an identity token — can reach the container without going through
IAP. I did *not* need `--no-invoker-iam-check`, and that is the better outcome:
had the invoker check been disabled, disabling IAP later would have left the
service open to the internet with no second gate.

The OAuth consent screen IAP depends on already existed in `aclima-lab` (brand
"Aclima"), so there was nothing to configure. A fresh project would need that
first.

> **Consequence: you can no longer smoke-test this from a terminal.** The
> `curl -H "Authorization: Bearer $(gcloud auth print-identity-token)"` recipe
> used to verify the deployment now returns 401, and `gcloud run services proxy`
> will not work either, because the invoker policy names only the IAP agent.
> Verification is a browser, or nothing. To get a terminal path back you would
> have to widen the invoker policy, which reopens the bypass — not worth it.

### 3. What I would not do

**Make it public.** A `*.run.app` URL is obscure, not private. This prototype
carries invented advisories attributed to a fictional agency (DRAQA) alongside
real Memphis geography and Aclima's own branding. Every screen is marked
SIMULATED DATA, which is the right mitigation for a viewer who knows the
context and a weak one for a stranger who found it in a search index.

---

## Open decisions — deliberately not actioned

### The deploy only works from Anton's laptop

`data/cache/` is gitignored. The deploy therefore works from a machine that has
those three Overpass responses and would fail from a clean clone, from CI, or
from a colleague's checkout — with the same `0 elements` error that killed the
first Cloud Build, ten minutes in and nowhere near the obvious cause.

Nothing is broken today. This is a note about who else can ship this, and it is
invisible from reading the repo, which is the actual hazard.

Three ways out, whenever it matters:

| | cost | effect |
|---|---|---|
| **Commit `data/cache/`** | 748 KB in git, and a call on vendoring third-party data | Build hermetic from a clean clone. The UI already carries the `© OpenStreetMap` attribution ODbL asks for. |
| **Park it in a GCS bucket** the build pulls from | a bucket, and build-time auth | Keeps the repo clean, adds a moving part |
| **Leave it** | free | Anton is the only person who can deploy |

Reviewed 2026-09-02 and **left as-is on purpose** — the demo is being shown from
one laptop and the cost of being wrong is one confusing build failure. Revisit
if anyone else needs to deploy, or if this outlives the show-and-tell.

### `--min-instances 1` stays for now

Roughly $20–30/month to keep the instance warm, which is what stops a colleague
paying a cold start on their first click and what lets a demo's edits survive
between visits. **Kept deliberately** through the show-and-tell period.

The lever, when that period ends:

```sh
gcloud run services update air-demo --project aclima-lab --region us-central1 --min-instances 0
```

## The compromise: SQLite in the container

Worth understanding before someone asks you why their change vanished.

The database is a ~100 MB file baked into the image. Cloud Run's filesystem is
writable but **ephemeral and per-instance**, which has two consequences:

**`--max-instances 1` is mandatory.** Two instances would be two divergent
worlds — a colleague acks an alert on one and it is still open on the other,
depending on which instance their request happened to land on. This is also why
the demo cannot serve real load, which is fine, because it is a demo.

**Writes live only as long as the instance.** The demo *does* write — acking an
alert, filing a resident concern, marking one under review, editing an action
level, regenerating a drive plan. Those survive as long as the container does,
and `--min-instances 1` keeps it alive for long stretches. But Cloud Run
recycles instances on its own schedule, and any redeploy definitely resets it.

That is genuinely fine here, and arguably a feature: the generator is
deterministic, so every restart hands you a pristine demo rather than one
covered in three weeks of colleagues' clicking. Just do not promise anyone that
their edit persists.

**If persistence starts to matter,** the answer is not to fight Cloud Run.
Either move to Cloud SQL (Postgres) — a real porting job, since the server uses
raw `sqlite3` with SQLite-specific SQL and `PRAGMA`s throughout — or run a
single `e2-small` Compute Engine VM with a persistent disk, which is much closer
to your Railway mental model and where SQLite simply works. Do not mount the
database from GCS via gcsfuse: SQLite's file locking is not properly supported
there and you can corrupt it.

---

## The demo clock drifts

The generator anchors its last shift to build time, so the fleet layer is alive
the moment the image is built. The flip side: a container running a month after
its build has a "now" that has run off the end of its own data — empty wind
series, a dead plume, stale alerts.

The app already detects this via `flags.generated_at` and offers **Pin to end of
data** in the SIMULATED DATA panel. But the real fix is to redeploy, which
rebuilds the world. **Redeploy before any demo you care about.**

---

## Secrets

`.dockerignore` excludes `.env`, deliberately — `ANTHROPIC_API_KEY` and
`GOOGLE_MAPS_API_KEY` must not enter an image layer, where anyone who can pull
the image can read them. Both features degrade gracefully without a key: the
advisor falls back to its rules engine and the basemap to MapLibre, which is a
perfectly good demo.

If you do want them, use Secret Manager (`deploy/cloudrun.sh` has the commands
commented at the bottom), and note two things:

- `ANTHROPIC_API_KEY` makes every advisor click a **paid API call** —
  `AIR_ADVISOR_UPGRADE` defaults on. Set `AIR_ADVISOR_UPGRADE=0` if you want the
  instant rules answer without the model behind it.
- `GOOGLE_MAPS_API_KEY` reaches the browser by design. Restrict it by HTTP
  referrer to the service's hostname before deploying, or it is a key anyone who
  loads the page can lift and bill.

---

## Cost

Order of **$20–30/month**, dominated by `--min-instances 1` holding one 1-vCPU /
2 GiB instance warm. Worth checking against the pricing calculator rather than
trusting this number.

The lever, if that is too much: drop to `--min-instances 0`. It becomes nearly
free, at the cost of a cold start on the first click after idle and a container
that recycles constantly — so demo edits vanish more often. For something you
open in front of colleagues, the warm instance is worth the money.

Cloud Build and Artifact Registry are rounding errors at this cadence.

---

## What was and was not verified

**The image builds and runs.** `docker build` clean, then `docker run` and
exercised for real:

```
image                      585 MB, datagen produced /app/data/air.db at 100.0 MB
GET /                      200   <title>air — Aclima</title>
GET /community             200   ┐
GET /regulator             200   │ SPA fallback, all four roles
GET /industry              200   │
GET /admin                 200   ┘
GET /api/v1/bootstrap      200   11 measures (the composite is there)
composite median            41.1
community headline          27 Fair
SSE /api/v1/events/stream  streams (": air event stream open", then event: hello)
uid                        10001(air) — non-root
SQLite write               PATCH /concerns/{id} -> 200, status changed,
                           and -wal/-shm siblings appeared, so WAL works
                           under the non-root user on the container filesystem
403 rule                   industry -> 'resolved' rejected 403, both via the
                           payload's `role` and via the X-Air-Role header;
                           industry -> 'mitigation_proposed' allowed 200
```

Two corrections found by doing it, both of which would have bitten later:

1. The Dockerfile originally pinned `ghcr.io/astral-sh/uv:0.5`, but `uv.lock` is
   `version = 1, revision = 3`, written by uv 0.12.6. An older uv cannot read a
   newer lock revision and `--frozen` would have failed. Now pinned to `0.12` —
   **keep that in step with whatever uv writes the lockfile.**
2. I had written that the image was "reproducible from the repo alone." It was
   not: the datagen reaches out to Overpass, and excluding `data/` from the
   build context turned that into a live network dependency that failed on
   Cloud Build. See the `data/cache/` section above.

**Nothing has been deployed** — `gcloud` is not installed on this machine, so
every GCP command in this document is unrun. The build and the container are
real; the deployment is still reasoning.

Two timings worth calibrating against, both from an M-series Mac under Docker
Desktop:

- Full `docker build`: **~5 minutes**, of which the in-image datagen was
  **392 s** — versus 110 s running natively. Docker Desktop on macOS is a VM and
  the datagen is I/O-heavy. Cloud Build runs native amd64 and should land nearer
  the 110 s figure.
- Container boot to first 200: **3 seconds**.

### One thing the testing turned up about access

The API has **no authentication of its own**, and `PATCH /concerns/{id}`
defaults an unspecified role to `"regulator"`. So anyone who can reach the
service can act as a regulator — resolve concerns, and by the same pattern edit
action levels — without ever claiming to be one. That is correct for a
single-player demo where you switch roles by navigating, and it is a third
concrete reason the service must not be public: the front door is the only door.

One layout detail that the Dockerfile depends on and that is easy to break
later: `config.REPO_ROOT` is `parents[3]` of `src/air/server/config.py`, and
`AIR_DB`, `SCHEMA_PATH` and `WEB_DIST` all hang off it. That is why the
container keeps the repo's shape under `/app` and runs from `PYTHONPATH` instead
of pip-installing the package — installed into `site-packages`, `REPO_ROOT`
would resolve to `site-packages` and the server would hunt for the database and
the web bundle inside it.
