#!/bin/bash
# Runs the Pod benchmark suites and writes results/<date>/<suite>.json plus summary.json.
#
#   bench/run.sh [suite...]      default: polling git-status search startup panes throughput
#
# Every sample waits until the 1-minute load average is <= POD_BENCH_MAX_LOAD (default 8).
# The visible-window latency suite is never part of the default run: it takes the desktop.
# Run it on its own, in a slot nobody else is using the Mac:
#   node bench/suites/latency.mjs --confirm-visible
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$here/tools/build.sh"
suites=("$@")
[ ${#suites[@]} -gt 0 ] || suites=(polling git-status search startup panes throughput)
for suite in "${suites[@]}"; do
  echo "==> $suite"
  node "$here/suites/$suite.mjs"
  node "$here/summarize.mjs" "${POD_BENCH_OUT:-$here/results/$(date -u +%F)}"
done
