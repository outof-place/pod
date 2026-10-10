#!/bin/bash
# The whole benchmark in one go, for the final quiet window: pin and build the search inputs, every
# headless suite, the claude-acc re-measurements, then the visible-window latency and throughput
# run (it takes the desktop and keyboard focus for about 20 minutes), summary.json and the tables.
#
#   bench/run-final.sh --pod /path/to/Pod.app [--pod-commit SHA] [--orca /Applications/Orca.app]
#                      [--og-sha SHA] [--og-features pcre2] [--search-client-sha SHA]
#                      [--no-visible] [--vdisplay]
#
# --pod-commit is the main commit the Pod build came from (read from the bundle when it records
# one); every Pod row and the stack check use it. --og-sha is the pod-search commit confirmed as
# bench-ready: its ogd must advertise search.full_lines and search.max_filesize, checked before
# anything is measured. Without it the og and ogd rows are listed as "coming", with no numbers.
# --vdisplay adds a virtual display for 20 s, which moves the user's display layout, so it is off
# unless asked for.
#
# Every sample still waits for a 1-minute load average <= POD_BENCH_MAX_LOAD (default 8).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pod="${POD_BENCH_POD_APP:-}"
orca="${POD_BENCH_ORCA_APP:-/Applications/Orca.app}"
pod_commit=""
og_sha=""
og_features="pcre2"
client_sha=""
visible=1
vdisplay=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pod) pod="${2:?}"; shift 2 ;;
    --pod-commit) pod_commit="${2:?}"; shift 2 ;;
    --orca) orca="${2:?}"; shift 2 ;;
    --og-sha) og_sha="${2:?}"; shift 2 ;;
    --og-features) og_features="$2"; shift 2 ;;
    --search-client-sha) client_sha="${2:?}"; shift 2 ;;
    --no-visible) visible=0; shift ;;
    --vdisplay) vdisplay=1; shift ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
# Never benchmark a stale build by accident: the Pod app is always named explicitly.
[ -n "$pod" ] && [ -d "$pod/Contents" ] || { echo "pass --pod <Pod.app> (the build under test)" >&2; exit 2; }
[ -d "$orca/Contents" ] || { echo "no Orca at $orca" >&2; exit 2; }
# A commit, not a ref: the og rows name the pod-search build that was confirmed, not whatever a
# branch or HEAD points at on the day.
[ -z "$og_sha" ] || [[ "$og_sha" =~ ^[0-9a-f]{7,40}$ ]] || {
  echo "--og-sha takes a commit SHA, not a ref: $og_sha" >&2
  exit 2
}
export POD_BENCH_POD_APP="$pod" POD_BENCH_ORCA_APP="$orca"
export POD_BENCH_OUT="${POD_BENCH_OUT:-$here/results/$(date -u +%F)}"
mkdir -p "$POD_BENCH_OUT"
echo "==> results: $POD_BENCH_OUT"
echo "==> Pod:  $pod ($(plutil -extract CFBundleShortVersionString raw -o - "$pod/Contents/Info.plist"))"
echo "==> Orca: $orca ($(plutil -extract CFBundleShortVersionString raw -o - "$orca/Contents/Info.plist"))"
if [ -z "$pod_commit" ]; then
  pod_commit="$(plutil -extract commit raw -o - "$pod/Contents/Resources/orca-local-build.json" 2>/dev/null || true)"
fi
[ -n "$pod_commit" ] || { echo "the Pod bundle records no commit: pass --pod-commit <main SHA>" >&2; exit 2; }
git -C "$here/.." fetch -q origin
pod_commit="$(git -C "$here/.." rev-parse "$pod_commit^{commit}")"
echo "==> Pod commit: $pod_commit"

"$here/tools/build.sh"
# Search inputs first: their builds are not measured and go through claude-acc's scheduler.
inputs="$POD_BENCH_OUT/search-inputs.raw"
prepare=(--out "$inputs")
[ -z "$og_sha" ] || prepare+=(--og-sha "$og_sha" --og-features "$og_features")
[ -z "$client_sha" ] || prepare+=(--search-client-sha "$client_sha")
"$here/search/prepare.sh" "${prepare[@]}"
field() { node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]' "$inputs" "$1"; }
search_repo="$(field searchRepo)"
if [ -n "$og_sha" ]; then
  # The ogd rows measure full-line results within --max-filesize; a build without them would
  # publish numbers for a different search.
  for feature in search.full_lines search.max_filesize; do
    grep -a -q -F "$feature" "$(field ogd)" || {
      echo "ogd at pod-search $og_sha does not advertise $feature: not the bench-ready build" >&2
      exit 2
    }
  done
fi
# Search rows this run cannot measure are listed as coming, with no numbers.
coming=""
if [ -z "$og_sha" ]; then
  coming="og,ogd"
elif [ -z "$client_sha" ]; then
  coming="ogd"
fi
node -e '
  const fs = require("fs"), [out, podApp, podCommit, orcaApp, inputs, comingList] = process.argv.slice(1)
  const reasons = {
    og: { suite: "search", subject: "og (pod-search)", reason: "no bench-ready pod-search build was confirmed for this run" },
    ogd: { suite: "ogd", subject: "Pod search on ogd", reason: "needs a bench-ready pod-search build and a pinned pod/search-client" }
  }
  const coming = comingList ? comingList.split(",").map((id) => ({ id, status: "coming", ...reasons[id] })) : []
  fs.writeFileSync(out, JSON.stringify({ podApp, podCommit, orcaApp, startedAt: new Date().toISOString(), search: JSON.parse(fs.readFileSync(inputs, "utf8")), coming }, null, 2) + "\n")
' "$POD_BENCH_OUT/run.json" "$pod" "$pod_commit" "$orca" "$inputs" "$coming"

node "$here/suites/preflight.mjs"
run_suite() {
  echo "==> $*"
  node "$here/suites/$1.mjs" "${@:2}"
  node "$here/summarize.mjs" "$POD_BENCH_OUT"
}
run_suite polling
run_suite polling --extra-ptys 80
run_suite git-status
if [ -n "$og_sha" ]; then
  run_suite search --repo "$search_repo" --engines rg,og --og "$(field og)" --ogd "$(field ogd)" \
    --ogctl "$(field ogctl)" --og-sha "$(field ogSha)"
else
  run_suite search --repo "$search_repo"
fi
if [ -n "$og_sha" ] && [ -n "$client_sha" ]; then
  run_suite ogd --inputs "$inputs"
fi
run_suite startup
run_suite panes
run_suite throughput
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
