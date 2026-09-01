#!/usr/bin/env sh
# Start the API with an APPENDED log.
#
# Every restart used to truncate `server.log` with `>`, which is fine until you
# need to answer "who wrote this row?" — at which point the evidence has been
# thrown away by the next restart. Two action levels drifted off their seeded
# values with no attributable request, and the log that would have named the
# caller had been overwritten three times over. Append, and stamp each start so
# the boundaries are still readable.
set -e
cd "$(dirname "$0")/.."
. dev/env.sh
LOG="${AIR_SERVER_LOG:-var/server.log}"
mkdir -p "$(dirname "$LOG")"
{
  echo ""
  echo "──────── air-server start $(date -u +%Y-%m-%dT%H:%M:%SZ) ────────"
} >> "$LOG"
exec uv run air-server >> "$LOG" 2>&1
