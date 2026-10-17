#!/bin/bash
# Runs the Pod benchmark suites and writes results/<date>/<suite>.json plus summary.json.
#
#   bench/run.sh [suite...]      default: polling hooks git-status search startup panes throughput browser
#
# Every sample waits until the 1-minute load average is <= POD_BENCH_MAX_LOAD (default 8).
# The visible-window latency suite is never part of the default run: it takes the desktop.
# Run it on its own, in a slot nobody else is using the Mac:
#   node bench/suites/latency.mjs --confirm-visible
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$here/tools/build.sh"
out="${POD_BENCH_OUT:-$here/results/$(date -u +%F)}"
mkdir -p "$out"
# As run-final.sh: a change to the user's claude-acc install stops the run (lib/acc-guard.mjs).
export POD_BENCH_ACC_BASELINE="$out/acc-baseline.raw"
node "$here/lib/acc-guard.mjs" --baseline "$POD_BENCH_ACC_BASELINE"
suites=("$@")
[ ${#suites[@]} -gt 0 ] || suites=(polling hooks git-status search startup panes throughput browser)
for suite in "${suites[@]}"; do
  # The shared Mac's gate right before each suite: bench hold + GO, /tmp/pod-heavy-state, load, disk.
  node "$here/lib/heavy-gate.mjs" || exit $?
  echo "==> $suite"
  node "$here/suites/$suite.mjs"
  node "$here/lib/acc-guard.mjs" --check "$POD_BENCH_ACC_BASELINE"
  node "$here/summarize.mjs" "$out"
done
