#!/bin/bash
# The whole benchmark in one go, for the final quiet window: every headless suite, the claude-acc
# re-measurements, then the visible-window latency and throughput run (it takes the desktop and
# keyboard focus for about 20 minutes), a virtual display check, summary.json and the tables.
#
#   bench/run-final.sh --pod /path/to/Pod.app [--orca /Applications/Orca.app] [--no-visible] [--no-vdisplay]
#
# Every sample still waits for a 1-minute load average <= POD_BENCH_MAX_LOAD (default 8).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pod="${POD_BENCH_POD_APP:-}"
orca="${POD_BENCH_ORCA_APP:-/Applications/Orca.app}"
visible=1
vdisplay=1
while [ $# -gt 0 ]; do
  case "$1" in
    --pod) pod="${2:?}"; shift 2 ;;
    --orca) orca="${2:?}"; shift 2 ;;
    --no-visible) visible=0; shift ;;
    --no-vdisplay) vdisplay=0; shift ;;
    -h | --help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
# Never benchmark a stale build by accident: the Pod app is always named explicitly.
[ -n "$pod" ] && [ -d "$pod/Contents" ] || { echo "pass --pod <Pod.app> (the build under test)" >&2; exit 2; }
[ -d "$orca/Contents" ] || { echo "no Orca at $orca" >&2; exit 2; }
export POD_BENCH_POD_APP="$pod" POD_BENCH_ORCA_APP="$orca"
export POD_BENCH_OUT="${POD_BENCH_OUT:-$here/results/$(date -u +%F)}"
mkdir -p "$POD_BENCH_OUT"
echo "==> results: $POD_BENCH_OUT"
echo "==> Pod:  $pod ($(plutil -extract CFBundleShortVersionString raw -o - "$pod/Contents/Info.plist"))"
echo "==> Orca: $orca ($(plutil -extract CFBundleShortVersionString raw -o - "$orca/Contents/Info.plist"))"

"$here/tools/build.sh"
node "$here/suites/preflight.mjs"
for suite in polling git-status search startup panes throughput; do
  echo "==> $suite"
  node "$here/suites/$suite.mjs"
  node "$here/summarize.mjs" "$POD_BENCH_OUT"
done
echo "==> claude-acc (historical + fresh)"
node "$here/suites/claude-acc.mjs" --fresh
node "$here/summarize.mjs" "$POD_BENCH_OUT"

if [ "$visible" = 1 ]; then
  if [ "$vdisplay" = 1 ]; then
    echo "==> virtual display check (adds a display for 20 s)"
    "$here/.build/bin/vdisplay" --create --hold 20 > "$POD_BENCH_OUT/vdisplay.raw" &
    vd=$!
    sleep 5
    "$here/.build/bin/keylat" --preflight > "$POD_BENCH_OUT/vdisplay-preflight.raw" || true
    wait "$vd" || true
    node -e '
      const fs = require("fs"), [created, preflight, out] = process.argv.slice(1)
      const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return null } }
      fs.writeFileSync(out, JSON.stringify({ suite: "vdisplay", writtenAt: new Date().toISOString(), created: read(created), displaysWhileCreated: read(preflight)?.displays ?? null, metrics: [] }, null, 2) + "\n")
    ' "$POD_BENCH_OUT/vdisplay.raw" "$POD_BENCH_OUT/vdisplay-preflight.raw" "$POD_BENCH_OUT/vdisplay.json"
    rm -f "$POD_BENCH_OUT/vdisplay.raw" "$POD_BENCH_OUT/vdisplay-preflight.raw"
  fi
  echo "==> visible windows: latency and throughput (takes the desktop)"
  node "$here/suites/latency.mjs" --confirm-visible --throughput
  node "$here/summarize.mjs" "$POD_BENCH_OUT"
fi

node "$here/report.mjs" "$POD_BENCH_OUT/summary.json"
echo "==> done: $POD_BENCH_OUT/summary.json"
