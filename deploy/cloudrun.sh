#!/usr/bin/env sh
#
# Deploy the demo to Cloud Run. See docs/DEPLOY.md for the reasoning and for the
# access-control step, which this script deliberately does not decide for you.
#
#   PROJECT=my-gcp-project sh deploy/cloudrun.sh
#
set -e
cd "$(dirname "$0")/.."

: "${PROJECT:?set PROJECT=<your-gcp-project-id>}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-air-demo}"

# ── the flags that matter, and why ───────────────────────────────────────────
#
# --max-instances 1   LOAD-BEARING. The database is a SQLite file inside the
#                     container. Two instances would be two divergent worlds:
#                     a colleague acks an alert on one and it is still open on
#                     the other. One instance, one world.
#
# --min-instances 1   Keeps the instance warm, so (a) nobody's first click pays
#                     a cold start, and (b) the container's writable layer —
#                     which is where every demo edit lives — survives between
#                     visits. This is the line item you are paying for; see
#                     docs/DEPLOY.md.
#
# --timeout 3600      The app holds an SSE stream open at /api/v1/events/stream.
#                     At the 300 s default, Cloud Run cuts it every five minutes
#                     and the client reconnects — survivable but visibly janky.
#
# --no-allow-unauthenticated
#                     Not public. This is an Aclima-branded prototype full of
#                     invented advisories attributed to a fictional agency, and
#                     a *.run.app URL is obscure, not private. docs/DEPLOY.md
#                     covers how to let colleagues in.
#
# --memory 2Gi        The segment endpoints cache serialized GeoJSON per
#                     measure, and there are eleven measures now. 1Gi probably
#                     holds; an OOM mid-demo costs more than the difference.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --source . \
  --no-allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --memory 2Gi \
  --cpu 1 \
  --timeout 3600 \
  --set-env-vars AIR_HOST=0.0.0.0,AIR_RELOAD=0

# ── optional: the advisor and the Google basemap ──────────────────────────────
#
# Both are off unless a key is present — the app falls back to its rules engine
# and to MapLibre, which is a perfectly good demo. If you do want them, put the
# keys in Secret Manager and mount them, never --set-env-vars:
#
#   printf %s "$KEY" | gcloud secrets create air-anthropic-key --data-file=- --project "$PROJECT"
#   gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" \
#     --set-secrets ANTHROPIC_API_KEY=air-anthropic-key:latest
#
# Note that ANTHROPIC_API_KEY makes every advisor click a paid API call
# (AIR_ADVISOR_UPGRADE defaults on), and that a GOOGLE_MAPS_API_KEY reaches the
# browser — restrict it by HTTP referrer to the service's hostname first.

echo
echo "Deployed. The URL is above, and it will 403 until you grant access —"
echo "see the 'Letting colleagues in' section of docs/DEPLOY.md."
