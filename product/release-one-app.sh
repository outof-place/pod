#!/bin/bash
# The one-app Pod.app release, end to end on the release Mac:
#   1. the runtime (product/release.sh <version>, or --runtime);
#   2. the PodNative outer (PodNative's scripts/release-app.sh: Developer ID, notarized);
#   3. the assembly (product/assemble-one-app.sh: the app, DMG and zip, notarized and stapled);
#   4. the Sparkle appcast for the DMG (product/scripts/sparkle-appcast.sh);
#   5. a release directory with SHA256SUMS and artifacts.txt, which the GitHub releases and Pod's
#      update host take as it is.
# It publishes nothing: it ends with the commands that do (see RELEASE-RUNBOOK.md).
#
#   product/release-one-app.sh <X.Y.Z | X.Y.Z-rcN> --native-checkout <dir> [options]
#
#   --native-checkout <dir>   a clean PodNative checkout at the revision this release ships
#   --runtime <app>           a notarized runtime of this version (default: build it with release.sh)
#   --dry-run                 sign with a throwaway EdDSA key made here and kept in this shell's
#                             memory (Sparkle's tools read it on stdin): never the keychain, never
#                             generate_keys. The outer carries its public half.
#   --feed-url <url>          dry-run only: the outer's SUFeedURL (an update rehearsal's own feed)
#   --download-url-prefix <url>  dry-run only: the appcast's download URL prefix
#   --out <dir>               outside this checkout, must not exist: <dir>/one-app (the assembly) and
#                             <dir>/release (what the GitHub release takes)
# Step 0, the Electron zip in electron-builder's cache: product/scripts/electron-cache.sh (checked here).
# On a flaky network put ~/.local/share/pod-release/net-shims first on PATH (codesign/xcrun retries).
# A real release runs from the release owner's Terminal, never from an agent (CLAUDECODE).
# release.sh leaves latest-mac.yml in dist/: never publish it.
#
# Versions: CFBundleShortVersionString is <version> in both apps, and so is one numeric CFBundleVersion
# from product/scripts/pod-build-number.sh (the number Sparkle compares in the outer).
# Assets: Pod-<version>.dmg (the download and the Sparkle update), Pod-<version>.zip, appcast.xml,
# SHA256SUMS. The feed lives on Pod's update host and names the DMG as an asset of the public
# outof-place/pod-releases (product/update-host/update-host.sh): https://updates.pod.codes/appcast.xml
# names .../pod-releases/releases/download/v<version>/Pod-<version>.dmg. Pods up to rc4 read
# GitHub's `appcast` release instead, written one last time for the bridge release. A real
# release signs with the key in this Mac's login keychain (sparkle-appcast.sh); the outer's public key
# is PodNative's scripts/sparkle-ed-public-key.txt.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
. product/update-host/update-host.sh
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
    -h | --help) sed -n '2,35p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$version" ] || die "one version only"; version="${1#v}"; shift ;;
  esac
done
[ -n "$version" ] && [ -n "$native_checkout" ] && [ -n "$out" ] ||
  die "usage: product/release-one-app.sh <version> --native-checkout <PodNative checkout> --out <dir> [--dry-run]"
build=$(product/scripts/pod-build-number.sh "$version")
tag="v$version"
release_repo=outof-place/pod
[ "$dry_run" = 1 ] || { [ -z "$feed_url" ] && [ -z "$url_prefix" ]; } ||
  die "--feed-url and --download-url-prefix are for --dry-run only: a release reads Pod's own feed"
# The real path signs with the release owner's keychain key, which an agent never touches.
[ "$dry_run" = 1 ] || [ -z "${CLAUDECODE:-}" ] ||
  die "run this in your own Terminal: a real release signs with your keychain's Sparkle key (agents: --dry-run)"
[ -z "$(git status --porcelain)" ] || die "the Pod checkout is dirty: electron-builder would pack what no commit has"
pod_commit=$(git rev-parse HEAD)
# Why both: clones that fetch upstream carry Orca's own v1.0.1 and up, which GitHub's repo does not.
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "tag $tag already exists in this clone"
remote_tag=$(git ls-remote --tags "https://github.com/$release_repo.git" "refs/tags/$tag") ||
  die "cannot list $release_repo's tags"
[ -z "$remote_tag" ] || die "tag $tag already exists on $release_repo"
native_checkout=$(cd "$native_checkout" && pwd)
[ -x "$native_checkout/scripts/release-app.sh" ] || die "$native_checkout is not a PodNative checkout"
[ -z "$(git -C "$native_checkout" status --porcelain)" ] || die "$native_checkout is dirty"

display_name="$(node -p "require('./product/identity.json').displayName")"
app_id="$(node -p "require('./product/identity.json').appId")"
[ ! -e "$out" ] || die "$out already exists"
[ -d "$(dirname "$out")" ] || die "$(dirname "$out") does not exist"
out="$(cd "$(dirname "$out")" && pwd -P)/$(basename "$out")"
# Why outside: electron-builder packs the checkout into app.asar, and the next release would carry this one.
case "$out/" in "$(pwd -P)/"*) die "--out must be outside $(pwd -P)" ;; esac
mkdir "$out"
assembled="$out/one-app"
release_dir="$out/release"
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
  expected_feed=${feed_url:-$POD_UPDATE_FEED}
else
  key_file="$native_checkout/scripts/sparkle-ed-public-key.txt"
  [ -s "$key_file" ] || die "no Sparkle public key in $key_file: this release could never update (RELEASE-RUNBOOK.md)"
  public_key=$(tr -d '[:space:]' <"$key_file")
  expected_feed=$POD_UPDATE_FEED
fi
# The bridge release is also written to GitHub's feed, the one Pods up to rc4 read.
bridge=0
[ "$version" = "$POD_BRIDGE_VERSION" ] && bridge=1
log "Pod $version (CFBundleVersion $build)$([ "$dry_run" = 1 ] && echo ', dry run with a throwaway key')"

# 1. The runtime.
if [ -z "$runtime" ]; then
  product/scripts/electron-cache.sh
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
  # Also what lets a Developer ID-signed DMG through after a key rotation.
  [ "$(plist "$app" SUVerifyUpdateBeforeExtraction)" = true ] || die "$app: SUVerifyUpdateBeforeExtraction is not set"
}
check_outer "$native_app"

# 3. The assembly: notarized and stapled app, DMG and zip.
log "assembly: product/assemble-one-app.sh $version"
product/assemble-one-app.sh "$version" "$native_app" --runtime "$runtime" --out "$assembled"
check_outer "$assembled/$display_name.app"

# 4. The release directory and the appcast. The DMG is both the download and Sparkle's update: it is
# Developer ID signed, Sparkle's way back if the EdDSA key is ever lost.
mkdir -p "$release_dir"
dmg="$release_dir/$display_name-$version.dmg"
cp -c "$assembled/$display_name-$version.dmg" "$dmg"
cp -c "$assembled/$display_name-$version.zip" "$release_dir/$display_name-$version.zip"
log "appcast"
if [ "$dry_run" = 1 ]; then
  appcast_env=(SPARKLE_KEY_ON_STDIN=1)
  [ -n "$url_prefix" ] && appcast_env+=(SPARKLE_DOWNLOAD_URL_PREFIX="$url_prefix")
  printf '%s' "$seed" | env "${appcast_env[@]}" product/scripts/sparkle-appcast.sh "$dmg" "$tag" "$release_dir"
  unset seed
else
  product/scripts/sparkle-appcast.sh "$dmg" "$tag" "$release_dir"
fi
signature=$(python3 -I - "$release_dir/appcast.xml" "$build" "$version" "$dmg" <<'PY'
import os
import sys
import xml.etree.ElementTree as ET
path, build, version, dmg = sys.argv[1:]
ns = {"sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
item = ET.parse(path).getroot().find("./channel/item")
got = {k: (item.findtext(f"sparkle:{k}", namespaces=ns) or "") for k in ("version", "shortVersionString", "channel")}
assert got["version"] == build, f"appcast sparkle:version {got['version']} is not {build}"
assert got["shortVersionString"] == version, f"appcast shortVersionString {got['shortVersionString']} is not {version}"
# PodNative's updater sets no allowed channels: an item on a channel would never be offered.
assert not got["channel"], f"appcast item is on channel {got['channel']}"
enclosure = item.find("enclosure")
signature = enclosure.get("{%s}edSignature" % ns["sparkle"])
assert signature, "the DMG has no EdDSA signature"
assert enclosure.get("length") == str(os.path.getsize(dmg)), f"enclosure length {enclosure.get('length')} is not the DMG's"
print(signature)
PY
)
# The signature as the installed app checks it, with the outer's own SUPublicEDKey.
swift product/scripts/sparkle-ed-verify.swift "$dmg" "$signature" "$(plist "$assembled/$display_name.app" SUPublicEDKey)"
node product/release-feed-gate.cjs "$app_id" "$assembled/$display_name.app" "$release_dir"/*

# 5. Checksums and the list of what the GitHub release takes.
(cd "$release_dir" && shasum -a 256 "$display_name-$version.dmg" "$display_name-$version.zip" appcast.xml >SHA256SUMS)
{
  echo "Pod $version (CFBundleVersion $build), tag $tag at $pod_commit$([ "$dry_run" = 1 ] && echo ', DRY RUN: throwaway key, never publish')"
  echo "runtime  $(plist "$runtime" CFBundleShortVersionString) ($(plist "$runtime" CFBundleVersion)) from $runtime"
  echo "outer    PodNative $(plist "$assembled/$display_name.app" PodNativeRevision)"
  echo "feed     $expected_feed"
  [ "$bridge" = 0 ] || echo "bridge   $POD_GITHUB_FEED (Pods up to rc4)"
  echo "key      $public_key"
  (cd "$release_dir" && for f in "$display_name-$version.dmg" "$display_name-$version.zip" appcast.xml SHA256SUMS; do
    printf '%-28s %12s  %s\n' "$f" "$(stat -f %z "$f")" "$(shasum -a 256 "$f" | cut -d' ' -f1)"
  done)
} | tee "$release_dir/artifacts.txt"
remove=$(command -v pod-tmp-rm || echo "$HOME/.local/bin/pod-tmp-rm")
[ -x "$remove" ] && "$remove" "$native_out" >/dev/null || true

log "done: $release_dir"
if [ "$dry_run" = 1 ]; then
  echo "dry run: these assets carry a throwaway key; never publish them"
  echo "a release of $version publishes its feed on: $POD_UPDATE_FEED$([ "$bridge" = 0 ] || echo " and $POD_GITHUB_FEED")"
else
  # The tag and notes first, then the update host, then (the bridge only) GitHub's feed, which
  # checks that the host already serves the same appcast (RELEASE-RUNBOOK.md). An RC is a prerelease.
  prerelease=""
  [[ "$version" == *-rc* ]] && prerelease=" --prerelease"
  # The notes carry the release's known issues (product/release-notes/<version>.md).
  notes="$repo_root/product/release-notes/$version.md"
  [ -f "$notes" ] || { echo "no release notes at $notes: write them before publishing"; notes="<notes.md>"; }
  echo "publish (RELEASE-RUNBOOK.md), in this order:"
  echo "  gh release create $tag \"$release_dir/$display_name-$version.dmg\" \"$release_dir/$display_name-$version.zip\" \"$release_dir/SHA256SUMS\" --repo $release_repo --target $pod_commit --title \"$display_name $version\" --notes-file \"$notes\"$prerelease"
  echo "  product/scripts/publish-update.sh \"$release_dir\""
  [ "$bridge" = 0 ] || echo "  product/scripts/publish-github-appcast.sh \"$release_dir/appcast.xml\""
fi
