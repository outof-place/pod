#!/usr/bin/env bash
# S0 measurement harness for pod-gocache. One command per measurement; see RESULTS.md.
# Everything throwaway lives in $WORK (default /tmp/podgc-s0); `./run.sh clean` removes it.
# Never points anything at ~/Library/Caches/go-build: the e2e runs use an APFS clone of it.
set -euo pipefail

BENCH="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-/tmp/podgc-s0}"
PORTIVO="${PORTIVO:-$HOME/Desktop/projekty/portivo}"
BIN="$WORK/bin"
RES="$WORK/results"
mkdir -p "$RES"

build() {
  mkdir -p "$BIN" "$WORK/shim"
  cd "$BENCH"
  GOEXPERIMENT=simd go build -o "$BIN/passprog" ./cmd/passprog
  GOEXPERIMENT=simd go build -o "$BIN/micro" ./cmd/micro
  go build -o "$BIN/e2e" ./cmd/e2e
  go build -o "$BIN/getrtt" ./cmd/getrtt
  go build -o "$BIN/execcost" ./cmd/execcost
  # cmd/e2e puts this first on PATH as "go" so timing starts after the scheduler admits the run.
  go build -o "$WORK/shim/go" ./cmd/goshim
}

case "${1:-}" in
setup)
  # A committed Portivo snapshot (git archive does not touch the repo) and a clone of the shared cache.
  if [ ! -d "$WORK/src/apps/charter-service" ]; then
    mkdir -p "$WORK/src"
    git -C "$PORTIVO" archive --format=tar HEAD go.work go.work.sum apps/charter-service apps/auth-service | tar -x -C "$WORK/src"
    git -C "$PORTIVO" rev-parse HEAD >"$WORK/src/PORTIVO_COMMIT"
  fi
  [ -d "$WORK/gocache" ] || cp -c -R "$HOME/Library/Caches/go-build" "$WORK/gocache"
  build
  # Warm the clone for this snapshot (compiles whatever the shared cache lacks).
  "$BIN/e2e" -scenario warm-build -modes builtin -runs 0 -warmup 1 -out "$WORK/e2e-warmup"
  "$BIN/e2e" -scenario warm-test -modes builtin -runs 0 -warmup 1 -out "$WORK/e2e-warmup"
  ;;
build) build ;;
test)
  cd "$BENCH"
  GOEXPERIMENT=simd go test -count=1 -v ./b64 | tee "$RES/test-simd.txt"
  go test -count=1 ./b64 | tee "$RES/test-scalar.txt"
  ;;
micro) "$BIN/micro" "${2:-all}" -reps "${REPS:-7}" | tee "$RES/micro-${2:-all}.md" ;;
exec) "$BIN/execcost" -pkg "$BENCH" -fresh "${FRESH:-5}" -later "${LATER:-30}" | tee "$RES/exec.md" ;;
e2e)
  # ./run.sh e2e warm-build|warm-test|put [modes] [runs]; TRACE=1 splits runs at the link, WARMUP=n
  "$BIN/e2e" -scenario "$2" -modes "${3:-builtin,client}" -runs "${4:-5}" -warmup "${WARMUP:-1}" ${TRACE:+-trace} \
    -out "$WORK/e2e" | tee "$RES/e2e-$2${TRACE:+-trace}.md"
  ;;
getrtt)
  # ./run.sh getrtt <passprog log of a warm run>, e.g. $WORK/e2e/logs/warm-build-*-client-r0.prog.jsonl
  "$BIN/getrtt" -log "$2" -reps "${REPS:-5}" | tee "$RES/getrtt.md"
  ;;
clean) rm -rf "${WORK:?}" ;;
*)
  echo "usage: $0 setup|build|test|micro [b64|write|pipe|all]|exec|e2e <scenario> [modes] [runs]|getrtt <log>|clean" >&2
  exit 2
  ;;
esac
