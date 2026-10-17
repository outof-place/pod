#!/bin/bash
# Builds pod-sim into native/pod-sim-macos/.build/release/pod-sim (universal unless --single-arch,
# this Mac's architecture, or --arch, one named) and signs it the way Pod's packaging signs it:
# identifier codes.pod.sim (viewers admit it by that), hardened runtime, the empty entitlements of
# product/entitlements/none.plist, Developer ID when the login keychain has one (ad hoc otherwise,
# which stage 0 showed loads SimulatorKit too). POD_SIM_SIGN_IDENTITY overrides the identity.
# Packaging (product/electron-builder.pod.cjs) runs it with --arch and signs the copy again.
#
#   native/pod-sim-macos/scripts/build.sh [--single-arch | --arch arm64|x86_64]
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT="$HERE/.build/release/pod-sim"
SLICES="$HERE/.build/universal-slices"
ENTITLEMENTS="$REPO/product/entitlements/none.plist"
IDENTIFIER=codes.pod.sim

case "${1:-}" in
  --single-arch) TRIPLES=("$(uname -m)-apple-macosx") ;;
  --arch)
    [[ "${2:-}" == arm64 || "${2:-}" == x86_64 ]] || { echo "build.sh: --arch takes arm64 or x86_64" >&2; exit 64; }
    TRIPLES=("$2-apple-macosx")
    ;;
  "") TRIPLES=(arm64-apple-macosx x86_64-apple-macosx) ;;
  *) echo "usage: build.sh [--single-arch | --arch arm64|x86_64]" >&2; exit 64 ;;
esac

rm -rf "$SLICES"
mkdir -p "$SLICES" "$(dirname "$OUT")"
BUILT=()
for triple in "${TRIPLES[@]}"; do
  swift build -c release --package-path "$HERE" --triple "$triple" --product pod-sim
  BIN=$(swift build -c release --package-path "$HERE" --triple "$triple" --product pod-sim --show-bin-path)
  # Swift 6.4's build system writes every triple to one products dir: copy each slice out first.
  cp "$BIN/pod-sim" "$SLICES/pod-sim-$triple"
  BUILT+=("$SLICES/pod-sim-$triple")
done
rm -f "$OUT"
lipo -create "${BUILT[@]}" -output "$OUT"
chmod 755 "$OUT"

IDENTITY=${POD_SIM_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ { print $2; exit }')}
IDENTITY=${IDENTITY:--}
codesign --force --options runtime --timestamp=none --identifier "$IDENTIFIER" --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$OUT"
codesign -dvv "$OUT" 2>&1 | grep -E '^(Identifier|Format|CodeDirectory|Authority=Developer|TeamIdentifier|Signature)' || true
echo "built $OUT"
