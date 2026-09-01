#!/usr/bin/env sh
# Start the vite dev server with an APPENDED log, same reasoning as dev/serve.sh.
#
# Vite mirrors every browser console error into this log. A React duplicate-key
# warning firing on every render of every list entry can fill it faster than
# anyone notices, and a truncating `>` hides both the flood and whatever killed
# the process last time.
set -e
cd "$(dirname "$0")/.."
. dev/env.sh
LOG="${AIR_WEB_LOG:-var/vite.log}"
mkdir -p "$(dirname "$LOG")"
{
  echo ""
  echo "──────── vite start $(date -u +%Y-%m-%dT%H:%M:%SZ) ────────"
} >> "$LOG"
cd web
exec npx vite --port "${AIR_WEB_PORT:-5173}" --strictPort >> "../$LOG" 2>&1
