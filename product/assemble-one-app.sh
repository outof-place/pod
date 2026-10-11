#!/bin/bash
# Assembles the one-app Pod.app from two notarized-grade builds: PodNative is the outer app (the one
# the user sees, codes.pod.native), and the Electron runtime release.sh built is nested whole at
# Contents/Helpers/Pod Runtime.app (identity.appId, LSUIElement). The runtime's URL and document
# types move to the outer, which now answers pod:// and opens the documents.
#
#   product/assemble-one-app.sh <version> <PodNative.app> [--runtime <app>] [--out <dir>]
#
#   <version>        both apps' CFBundleShortVersionString must equal it
#   <PodNative.app>  Developer ID signed with hardened runtime and a timestamp (nt-lean's build)
#   --runtime        default dist/mac-arm64/<displayName>.app, from `product/release.sh <version>`
#   --out            default dist/one-app; must not exist yet
#   Relative paths are taken from the repository root, as in release.sh.
#
# Signs inside out: the nested runtime's top level again (its Info.plist changed; nested code keeps
# electron-builder's signatures), then the outer last, each with the entitlements it already had.
# Notarizes and staples the outer, then the DMG, zips the stapled app and runs release.sh's gates.
# The outer side (PodNative, Sparkle) may carry no entitlements: PodNative is not sandboxed.
# Never publish latest-mac.yml for a one-app build: electron-updater is off in that layout.
#
# Signing and notarization as in release.sh: POD_SIGN_IDENTITY; credentials from
# product/notary-credentials.sh (by default the App Store Connect key in ~/.appstoreconnect).
set -euo pipefail

DEFAULT_SIGN_IDENTITY="Developer ID Application: OUTOFPLACE POLAND SP. Z O.O (75Y2KR6P5W)"
NATIVE_APP_ID=codes.pod.native
NESTED_PATH="Contents/Helpers/Pod Runtime.app"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() {
  printf '\033[31merror\033[0m %s\n' "$*" >&2
  exit 1
}

identity() { node -p "require('./product/identity.json')$1"; }
display_name="$(identity .displayName)"
app_id="$(identity .appId)"
arch=arm64

version="" native="" runtime="" out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) runtime="${2:?--runtime needs a path}"; shift 2 ;;
    --out) out="${2:?--out needs a path}"; shift 2 ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *)
      if [ -z "$version" ]; then version="${1#v}"
      elif [ -z "$native" ]; then native="$1"
      else die "unexpected argument $1"
      fi
      shift ;;
  esac
done
[ -n "$version" ] && [ -n "$native" ] || die "usage: product/assemble-one-app.sh <version> <PodNative.app>"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "version '$version' is not semver"
[ "$(uname -s)" = Darwin ] || die "macOS only"
runtime="${runtime:-dist/mac-$arch/$display_name.app}"
out="${out:-dist/one-app}"
for path in "$native" "$runtime" "$out"; do
  # Touching a running app's bundle gets it killed by Gatekeeper on macOS 27.
  parent="$(cd "$(dirname "$path")" 2>/dev/null && pwd || true)"
  case "${parent%/}/$(basename "$path")" in
    /Applications | /Applications/*) die "$path is under /Applications; assemble from build outputs only" ;;
  esac
done
[ ! -e "$out" ] || die "$out exists; move it out of the worktree first"

sign_identity="${POD_SIGN_IDENTITY:-$DEFAULT_SIGN_IDENTITY}"
identities="$(security find-identity -v -p codesigning)"
grep -Fq "\"$sign_identity\"" <<<"$identities" || die "signing identity not in the keychain: $sign_identity"
team_id="${sign_identity##*(}"
team_id="${team_id%)}"
. "$repo_root/product/notary-credentials.sh"
pod_notary_credentials pod-notary
pod_notary_preflight

plist_value() { plutil -extract "$2" raw "$1/Contents/Info.plist"; }
check_input() {
  local app="$1" expected_id="$2" signature
  [ -d "$app/Contents/MacOS" ] || die "no app at $app"
  [ "$(plist_value "$app" CFBundleIdentifier)" = "$expected_id" ] || die "$app is not $expected_id"
  [ "$(plist_value "$app" CFBundleShortVersionString)" = "$version" ] || die "$app is not version $version"
  codesign --verify --deep --strict "$app" || die "$app fails codesign --verify --deep --strict"
  signature="$(codesign -dv "$app" 2>&1)"
  grep -Fqx "TeamIdentifier=$team_id" <<<"$signature" || die "$app is not signed by team $team_id"
  grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime' <<<"$signature" || die "$app lacks hardened runtime"
}
check_input "$runtime" "$app_id"
check_input "$native" "$NATIVE_APP_ID"
[ -d "$runtime/Contents/Frameworks" ] || die "$runtime is not an Electron runtime"
# PodNative's safe quit needs ui-host protocol 2; a version 1 runtime makes it fall back.
node product/scripts/verify-ui-host-protocol.mjs "$runtime"

scratch="$(mktemp -d -t pod-one-app)"
trap 'rm -rf "$scratch"' EXIT
# Each top level keeps the entitlements it was signed with; none is a valid answer for the outer.
has_entitlements() {
  codesign -d --entitlements - --xml "$1" > "$2" 2>/dev/null || true
  [ -s "$2" ] && plutil -lint -s "$2"
}
runtime_entitlements=() native_entitlements=()
if has_entitlements "$runtime" "$scratch/runtime.plist"; then
  runtime_entitlements=(--entitlements "$scratch/runtime.plist")
fi
if has_entitlements "$native" "$scratch/native.plist"; then
  native_entitlements=(--entitlements "$scratch/native.plist")
fi

mkdir -p "$out"
touch "$out/.metadata_never_index"
app="$out/$display_name.app"
nested="$app/$NESTED_PATH"

log "assemble $app: $NATIVE_APP_ID outer, $app_id at $NESTED_PATH"
ditto "$native" "$app"
mkdir -p "$app/Contents/Helpers"
ditto "$runtime" "$nested"
# The runtime's stapled ticket stops matching once its top level is re-signed; the outer's covers it.
rm -f "$nested/Contents/CodeResources"
# Why: an APFS clone keeps xattrs (quarantine included) whatever ditto's flags say.
xattr -cr "$app"

log "move the URL and document types to the outer; the nested runtime becomes LSUIElement"
/usr/bin/python3 -I - "$app/Contents/Info.plist" "$nested/Contents/Info.plist" <<'PY'
import plistlib, sys
outer_path, nested_path = sys.argv[1:3]
with open(outer_path, 'rb') as f: outer = plistlib.load(f)
with open(nested_path, 'rb') as f: nested = plistlib.load(f)
outer['CFBundleURLTypes'] = nested.pop('CFBundleURLTypes')
docs = nested.pop('CFBundleDocumentTypes')
for doc in docs:
    # The runtime's document icon is not in the outer's Resources; the outer's own icon stands in.
    if 'CFBundleTypeIconFile' in doc: doc['CFBundleTypeIconFile'] = outer.get('CFBundleIconFile', 'Pod')
outer['CFBundleDocumentTypes'] = docs
for key in ('UTExportedTypeDeclarations', 'UTImportedTypeDeclarations'):
    if key in nested: outer[key] = nested.pop(key)
nested['LSUIElement'] = True
with open(outer_path, 'wb') as f: plistlib.dump(outer, f)
with open(nested_path, 'wb') as f: plistlib.dump(nested, f)
PY
plutil -lint -s "$app/Contents/Info.plist" "$nested/Contents/Info.plist"

log "re-sign the nested runtime's top level"
codesign --force --options runtime --timestamp ${runtime_entitlements[@]+"${runtime_entitlements[@]}"} \
  --sign "$sign_identity" "$nested"
codesign --verify --deep --strict "$nested"
[ "$(codesign -dv "$nested" 2>&1 | sed -n 's/^Identifier=//p')" = "$app_id" ] || die "nested runtime lost $app_id"

log "sign the outer last (no --deep: nested code keeps its signatures)"
codesign --force --options runtime --timestamp ${native_entitlements[@]+"${native_entitlements[@]}"} \
  --sign "$sign_identity" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

log "notarize and staple the app"
ditto -c -k --keepParent "$app" "$scratch/notarize.zip"
xcrun notarytool submit "$scratch/notarize.zip" "${notary_args[@]}" --wait
xcrun stapler staple "$app"

log "DMG and zip"
dmg="$out/$display_name-$version-$arch.dmg"
zip="$out/$display_name-$version-$arch-mac.zip"
mkdir "$scratch/stage"
ditto "$app" "$scratch/stage/$display_name.app"
ln -s /Applications "$scratch/stage/Applications"
hdiutil create -volname "$display_name $version" -srcfolder "$scratch/stage" -fs HFS+ -format UDZO "$dmg" >/dev/null
codesign --force --timestamp --sign "$sign_identity" "$dmg"
node product/release-bundle-gate.cjs --dmg "$dmg"
xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait
xcrun stapler staple "$dmg"
ditto -c -k --keepParent "$app" "$zip"

log "verify (Gatekeeper, release.sh's bundle gates on the nested runtime, no outer entitlements)"
codesign --verify --deep --strict --verbose=2 "$app"
signature="$(codesign -dv "$app" 2>&1)"
grep -Fqx "TeamIdentifier=$team_id" <<<"$signature" || die "$app is not signed by team $team_id"
xcrun stapler validate "$app"
xcrun stapler validate "$dmg"
gatekeeper="$(spctl -a -vv "$app" 2>&1)" || die "spctl rejected $app: $gatekeeper"
printf '%s\n' "$gatekeeper"
grep -Fq "source=Notarized Developer ID" <<<"$gatekeeper" || die "$app is not notarized: $gatekeeper"
spctl -a -vv -t open --context context:primary-signature "$dmg"
[ "$(plist_value "$nested" LSUIElement)" = true ] || die "nested runtime is not LSUIElement"
if plutil -extract CFBundleURLTypes xml1 -o - "$nested/Contents/Info.plist" >/dev/null 2>&1; then
  die "nested runtime still declares URL types"
fi
[ ! -e "$out/latest-mac.yml" ] || die "one-app outputs must not carry latest-mac.yml"
node -e "require('./product/release-bundle-gate.cjs').assertAppAsar(process.argv[1])" "$nested/Contents/Resources"
node product/scripts/verify-claude-acc-host.mjs "$nested"
node product/scripts/verify-bundle-seal.mjs "$nested"
node product/scripts/verify-entitlements.mjs "$nested"
node product/scripts/verify-entitlements.mjs --outer "$app" "$NESTED_PATH"
log "done: $app, $dmg, $zip"
