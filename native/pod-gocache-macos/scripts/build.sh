#!/bin/bash
# Builds pod-gocache for macOS: CGO_ENABLED=0, the pinned toolchain, GOENV=off so no `go env -w`
# value reaches the build, -trimpath and no VCS stamp so one source tree always gives the same bytes,
# stripped, with scripts/VERSION stamped into main.version. The build proves the binary answers
# `version` with it whenever this Mac can run the binary. Packaging (product/gocache) runs it per
# app arch and signs the copy; --sign signs this output as the packaging does (codes.pod.gocache,
# hardened runtime, Developer ID when the login keychain has one, ad hoc otherwise) for
# dev-install.sh. POD_GOCACHE_SIGN_IDENTITY overrides the identity. --check-toolchain only proves
# the pinned Go runs here (release.sh's preflight).
#
# VERSION orders installs: Pod replaces only an older helper, so bump it whenever the helper changes
# and run scripts/stamp-version.cjs (a test fails on changed sources under an unchanged VERSION).
#
#   native/pod-gocache-macos/scripts/build.sh [--arch arm64|amd64|universal] [--out <path>]
#       [--version <semver> | --dev] [--sign] [--module <dir>]
#   native/pod-gocache-macos/scripts/build.sh --check-toolchain
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$HERE/../.." && pwd)
VERSION=$(tr -d '[:space:]' <"$HERE/scripts/VERSION")
TOOLCHAIN=go1.27.2
IDENTIFIER=codes.pod.gocache
ENTITLEMENTS="$REPO/product/entitlements/none.plist"
PKG=./cmd/pod-gocache
VERSION_SYMBOL=main.version

usage() {
  echo "usage: build.sh [--arch arm64|amd64|universal] [--out <path>] [--version <semver> | --dev] [--sign] [--module <dir>] | --check-toolchain" >&2
  exit 64
}

ARCH=$(uname -m)
[[ "$ARCH" == x86_64 ]] && ARCH=amd64
OUT="$HERE/.build/pod-gocache"
MODULE="$HERE"
SIGN=
CHECK_TOOLCHAIN=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) [[ "${2:-}" =~ ^(arm64|amd64|universal)$ ]] || usage; ARCH=$2; shift 2 ;;
    --out) [[ -n "${2:-}" ]] || usage; OUT=$2; shift 2 ;;
    --version) [[ "${2:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]] || usage; VERSION=$2; shift 2 ;;
    # a prerelease of this version: any bundled build of it replaces a dev install
    --dev) VERSION="$VERSION-dev.$(date -u +%Y%m%d%H%M%S)"; shift ;;
    --sign) SIGN=1; shift ;;
    --check-toolchain) CHECK_TOOLCHAIN=1; shift ;;
    # tests build a fixture module with the same CLI
    --module) [[ -d "${2:-}" ]] || usage; MODULE=$(cd "$2" && pwd); shift 2 ;;
    *) usage ;;
  esac
done

if ! command -v go >/dev/null 2>&1; then
  echo "build.sh: Go is missing: pod-gocache is built with Go ($TOOLCHAIN; Homebrew: brew install go)" >&2
  exit 69
fi
# Why GOENV=off here and in the build: `go env -w` values (GOTOOLCHAIN, GOFLAGS, GOAMD64...) never apply.
if [[ -n "$CHECK_TOOLCHAIN" ]]; then
  if ! answer=$(env GOENV=off GOTOOLCHAIN="$TOOLCHAIN" go version 2>&1) || [[ "$answer" != "go version $TOOLCHAIN "* ]]; then
    echo "build.sh: Go $TOOLCHAIN does not run here ($answer); pod-gocache is built with it" >&2
    exit 69
  fi
  echo "$answer"
  exit 0
fi
[[ "$OUT" == /* ]] || OUT="$PWD/$OUT"
mkdir -p "$(dirname "$OUT")"

build_arch() {
  # Why env -u: the helper must not build through an installed pod-gocache or the builder's own flags.
  env -u GOCACHEPROG -u GOFLAGS -u GOEXPERIMENT -u GOAMD64 -u GOARM64 GOENV=off GOWORK=off \
    GOTOOLCHAIN="$TOOLCHAIN" GOOS=darwin GOARCH="$1" CGO_ENABLED=0 \
    go build -C "$MODULE" -trimpath -buildvcs=false \
    -ldflags "-s -w -X $VERSION_SYMBOL=$VERSION" -o "$2" "$PKG"
}

SLICES=$(mktemp -d "${TMPDIR:-/tmp}/pod-gocache-build.XXXXXX")
trap 'rm -rf "$SLICES"' EXIT
case "$ARCH" in
  universal)
    build_arch arm64 "$SLICES/arm64"
    build_arch amd64 "$SLICES/amd64"
    lipo -create "$SLICES/arm64" "$SLICES/amd64" -output "$SLICES/out"
    ;;
  *) build_arch "$ARCH" "$SLICES/out" ;;
esac
chmod 755 "$SLICES/out"

# A renamed version variable is silently ignored by -X: the binary would answer its default.
self_test() {
  local answer
  answer=$("$@" version 2>&1) || { echo "build.sh: $OUT failed to run 'version': $answer" >&2; exit 70; }
  if [[ " $answer " != *" $VERSION "* ]]; then
    echo "build.sh: $OUT answers '$answer', not version $VERSION: is $VERSION_SYMBOL still the version variable?" >&2
    exit 70
  fi
}
HOST=$(uname -m)
if [[ "$ARCH" == universal || "$ARCH" == arm64 && "$HOST" == arm64 || "$ARCH" == amd64 && "$HOST" == x86_64 ]]; then
  self_test "$SLICES/out"
elif [[ "$ARCH" == amd64 ]] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  self_test arch -x86_64 "$SLICES/out"
else
  echo "build.sh: this Mac cannot run $ARCH binaries; the version self-test is skipped" >&2
fi

if [[ -n "$SIGN" ]]; then
  IDENTITY=${POD_GOCACHE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ { print $2; exit }')}
  IDENTITY=${IDENTITY:--}
  codesign --force --options runtime --timestamp=none --identifier "$IDENTIFIER" \
    --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$SLICES/out"
fi
mv -f "$SLICES/out" "$OUT"
echo "built $OUT ($ARCH, $VERSION)"
