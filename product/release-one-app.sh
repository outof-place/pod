#!/bin/bash
# The one-app Pod.app release, end to end on the release Mac:
#   1. the runtime (product/release.sh <version>, or --runtime);
#   2. the PodNative outer (PodNative's scripts/release-app.sh: Developer ID, notarized);
#   3. the assembly (product/assemble-one-app.sh: the app, DMG and zip, notarized and stapled);
#   4. the Sparkle appcast for the DMG (product/scripts/sparkle-appcast.sh);
#   5. a release directory a GitHub release takes as it is, with SHA256SUMS and artifacts.txt.
# It publishes nothing: it ends with the command that does (see RELEASE-RUNBOOK.md).
#
#   product/release-one-app.sh <X.Y.Z | X.Y.Z-rcN> --native-checkout <dir> [options]
#
#   --native-checkout <dir>   a clean PodNative checkout at the revision this release ships
#   --runtime <app>           a notarized runtime of this version (default: build it with release.sh)
#   --dry-run                 sign with a throwaway EdDSA key made here and kept in this shell's
#                             memory (Sparkle's tools read it on stdin): never the keychain, never
#                             generate_keys. The outer carries its public half.
#   --feed-url <url>          dry-run only: the outer's SUFeedURL (an update rehearsal on 127.0.0.1)
#   --download-url-prefix <url>  dry-run only: the appcast's download URL prefix
#   --out <dir>               the release directory (default dist/release-<version>; must not exist)
#
# Versions: CFBundleShortVersionString is <version> in both apps; the outer's CFBundleVersion comes
# from product/scripts/pod-build-number.sh, the number Sparkle compares.
# Assets: Pod-<version>.dmg (the download and the Sparkle update), Pod-<version>.zip, appcast.xml,
# SHA256SUMS. The feed is the `appcast` prerelease's asset, not releases/latest: GitHub's latest skips
# prereleases, and RCs are prereleases. A real release takes the key from this Mac's login keychain through sparkle-appcast.sh,
# and the outer's public key from PodNative's scripts/sparkle-ed-public-key.txt.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() {
  printf '\033[31merror\033[0m %s\n' "$*" >&2
  exit 1
}

version="" native_checkout="" runtime="" dry_run=0 feed_url="" url_prefix="" out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --native-checkout) native_checkout=${2:?--native-checkout needs a directory}; shift 2 ;;
    --runtime) runtime=${2:?--runtime needs an app}; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --feed-url) feed_url=${2:?--feed-url needs a URL}; shift 2 ;;
    --download-url-prefix) url_prefix=${2:?--download-url-prefix needs a URL}; shift 2 ;;
    --out) out=${2:?--out needs a directory}; shift 2 ;;
    -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$version" ] || die "one version only"; version="${1#v}"; shift ;;
  esac
done
[ -n "$version" ] && [ -n "$native_checkout" ] ||
  die "usage: product/release-one-app.sh <version> --native-checkout <PodNative checkout> [--dry-run]"
build=$(product/scripts/pod-build-number.sh "$version")
tag="v$version"
[ "$dry_run" = 1 ] || { [ -z "$feed_url" ] && [ -z "$url_prefix" ]; } ||
  die "--feed-url and --download-url-prefix are for --dry-run only: a release reads Pod's own feed"
native_checkout=$(cd "$native_checkout" && pwd)
[ -x "$native_checkout/scripts/release-app.sh" ] || die "$native_checkout is not a PodNative checkout"
[ -z "$(git -C "$native_checkout" status --porcelain)" ] || die "$native_checkout is dirty"

display_name="$(node -p "require('./product/identity.json').displayName")"
app_id="$(node -p "require('./product/identity.json').appId")"
out="${out:-dist/release-$version}"
assembled="dist/one-app-$version"
for dir in "$out" "$assembled"; do [ ! -e "$dir" ] || die "$dir already exists"; done
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || true; }

# The signing key: a throwaway in memory for a dry-run, else the release key's public half as
# PodNative ships it (sparkle-appcast.sh then fails unless the keychain's private key matches).
if [ "$dry_run" = 1 ]; then
  keys=$(swift - <<'SWIFT'
import CryptoKit
let key = Curve25519.Signing.PrivateKey()
print(key.rawRepresentation.base64EncodedString())
print(key.publicKey.rawRepresentation.base64EncodedString())
SWIFT
  )
  seed=$(sed -n 1p <<<"$keys")
  public_key=$(sed -n 2p <<<"$keys")
  unset keys
  expected_feed=${feed_url:-https://github.com/outof-place/pod/releases/download/appcast/appcast.xml}
else
  key_file="$native_checkout/scripts/sparkle-ed-public-key.txt"
  [ -s "$key_file" ] || die "no Sparkle public key in $key_file: this release could never update (RELEASE-RUNBOOK.md)"
  public_key=$(tr -d '[:space:]' <"$key_file")
  expected_feed=https://github.com/outof-place/pod/releases/download/appcast/appcast.xml
fi
log "Pod $version (CFBundleVersion $build)$([ "$dry_run" = 1 ] && echo ', dry run with a throwaway key')"

# 1. The runtime.
if [ -z "$runtime" ]; then
  log "runtime: product/release.sh $version"
  product/release.sh "$version"
  runtime="dist/mac-arm64/$display_name.app"
fi
[ "$(plist "$runtime" CFBundleShortVersionString)" = "$version" ] || die "$runtime is not version $version"
# One CFBundleVersion in both halves.
[ "$(plist "$runtime" CFBundleVersion)" = "$build" ] || die "$runtime: CFBundleVersion is not $build"

# 2. The outer, in a directory of this run's own.
native_out=$(mktemp -d /tmp/pod-release-native.XXXXXX)
update_args=()
if [ "$dry_run" = 1 ]; then
  update_args=(--update-key "$public_key")
  [ -n "$feed_url" ] && update_args+=(--update-feed "$feed_url")
fi
log "outer: PodNative release-app.sh at $(git -C "$native_checkout" rev-parse --short HEAD)"
(cd "$native_checkout" && POD_NATIVE_RELEASE_DIR="$native_out" scripts/release-app.sh \
  --display-name "$display_name" --version "$version" --build-version "$build" ${update_args[@]+"${update_args[@]}"})
native_app=$(find "$native_out" -maxdepth 2 -name PodNative.app -type d | head -1)
[ -n "$native_app" ] || die "release-app.sh left no PodNative.app in $native_out"
check_outer() {
  local app=$1
  [ "$(plist "$app" CFBundleShortVersionString)" = "$version" ] || die "$app: CFBundleShortVersionString is not $version"
  [ "$(plist "$app" CFBundleVersion)" = "$build" ] || die "$app: CFBundleVersion is not $build"
  [ "$(plist "$app" SUFeedURL)" = "$expected_feed" ] || die "$app: SUFeedURL is not $expected_feed"
  [ "$(plist "$app" SUPublicEDKey)" = "$public_key" ] || die "$app: SUPublicEDKey is not this release's key"
  [ "$(plist "$app" SURequireSignedFeed)" = true ] || die "$app: SURequireSignedFeed is not set"
}
check_outer "$native_app"

# 3. The assembly: notarized and stapled app, DMG and zip.
log "assembly: product/assemble-one-app.sh $version"
product/assemble-one-app.sh "$version" "$native_app" --runtime "$runtime" --out "$assembled"
check_outer "$assembled/$display_name.app"

# 4. The release directory and the appcast. The DMG is both the download and Sparkle's update: it is
# Developer ID signed, Sparkle's way back if the EdDSA key is ever lost.
mkdir -p "$out"
dmg="$out/$display_name-$version.dmg"
cp -c "$assembled/$display_name-$version.dmg" "$dmg"
cp -c "$assembled/$display_name-$version.zip" "$out/$display_name-$version.zip"
log "appcast"
if [ "$dry_run" = 1 ]; then
  appcast_env=(SPARKLE_KEY_ON_STDIN=1)
  [ -n "$url_prefix" ] && appcast_env+=(SPARKLE_DOWNLOAD_URL_PREFIX="$url_prefix")
  printf '%s' "$seed" | env "${appcast_env[@]}" product/scripts/sparkle-appcast.sh "$dmg" "$tag" "$out"
  unset seed
else
  product/scripts/sparkle-appcast.sh "$dmg" "$tag" "$out"
fi
python3 -I - "$out/appcast.xml" "$build" "$version" <<'PY'
import sys
import xml.etree.ElementTree as ET
path, build, version = sys.argv[1:]
ns = {"sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
item = ET.parse(path).getroot().find("./channel/item")
got = {k: (item.findtext(f"sparkle:{k}", namespaces=ns) or "") for k in ("version", "shortVersionString", "channel")}
assert got["version"] == build, f"appcast sparkle:version {got['version']} is not {build}"
assert got["shortVersionString"] == version, f"appcast shortVersionString {got['shortVersionString']} is not {version}"
# PodNative's updater sets no allowed channels: an item on a channel would never be offered.
assert not got["channel"], f"appcast item is on channel {got['channel']}"
enclosure = item.find("enclosure")
assert enclosure.get("{%s}edSignature" % ns["sparkle"]), "the DMG has no EdDSA signature"
PY
node product/release-feed-gate.cjs "$app_id" "$assembled/$display_name.app" "$out"/*

# 5. Checksums and the list of what the GitHub release takes.
(cd "$out" && shasum -a 256 "$display_name-$version.dmg" "$display_name-$version.zip" appcast.xml >SHA256SUMS)
{
  echo "Pod $version (CFBundleVersion $build), tag $tag$([ "$dry_run" = 1 ] && echo ', DRY RUN: throwaway key, never publish')"
  echo "runtime  $(plist "$runtime" CFBundleShortVersionString) from $runtime"
  echo "outer    PodNative $(plist "$assembled/$display_name.app" PodNativeRevision)"
  echo "feed     $expected_feed"
  echo "key      $public_key"
  (cd "$out" && for f in "$display_name-$version.dmg" "$display_name-$version.zip" appcast.xml SHA256SUMS; do
    printf '%-28s %12s  %s\n' "$f" "$(stat -f %z "$f")" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
  done)
} | tee "$out/artifacts.txt"
remove=$(command -v pod-tmp-rm || echo "$HOME/.local/bin/pod-tmp-rm")
[ -x "$remove" ] && "$remove" "$native_out" >/dev/null || true

log "done: $out"
if [ "$dry_run" = 1 ]; then
  echo "dry run: these assets carry a throwaway key; never publish them"
else
  # The release first, then the feed that points at it (RELEASE-RUNBOOK.md); an RC is a prerelease.
  prerelease=""
  [[ "$version" == *-rc* ]] && prerelease=" --prerelease"
  echo "publish (RELEASE-RUNBOOK.md), in this order:"
  echo "  gh release create $tag \"$out/$display_name-$version.dmg\" \"$out/$display_name-$version.zip\" \"$out/SHA256SUMS\" --repo outof-place/pod --title \"$display_name $version\" --notes-file <notes.md>$prerelease"
  echo "  gh release upload appcast \"$out/appcast.xml\" --repo outof-place/pod --clobber"
fi
