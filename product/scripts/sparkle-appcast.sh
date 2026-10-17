#!/bin/bash
# Writes the Sparkle appcast for one release of the one-app Pod.app: a single item for <archive>,
# its EdDSA signature and the feed's own (PodNative sets SURequireSignedFeed), with the download URL
# on Pod's update host (product/update-host: https://updates.pod.codes/<archive name>), where
# publish-update.sh puts both (RELEASE-RUNBOOK.md).
#
#   product/scripts/sparkle-appcast.sh <archive> <tag> <out dir>
#
#   <archive>  the notarized DMG (Developer ID signed: Sparkle's way back if the EdDSA key is ever
#              lost) or a zip of the stapled Pod.app (`ditto -c -k --keepParent`)
#   <tag>      the release tag, e.g. v0.1.0 (checked; the download URL no longer carries it)
#
# The private key is read from this Mac's login keychain (`generate_keys --account $SPARKLE_ACCOUNT`,
# default codes.pod), by generate_appcast and again by sign_update: macOS asks twice. Never from a file.
# SPARKLE_KEY_ON_STDIN=1 reads a throwaway key from stdin instead (tests and rehearsals only).
# SPARKLE_DOWNLOAD_URL_PREFIX replaces the release's download URL (a rehearsal's feed on 127.0.0.1).
# The archive's app must carry the signing key's public half: generate_appcast only warns.
# Sparkle's tools come from the release whose framework PodNative pins, checked against its digest.
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/../update-host/update-host.sh"
SPARKLE_VERSION=2.10.0
SPARKLE_SHA256=c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
ACCOUNT=${SPARKLE_ACCOUNT:-codes.pod}
KEY=(--account "$ACCOUNT")
[ "${SPARKLE_KEY_ON_STDIN:-0}" = 1 ] && KEY=(--ed-key-file -)

archive=${1:?usage: sparkle-appcast.sh <archive> <tag> <out dir>}
tag=${2:?usage: sparkle-appcast.sh <archive> <tag> <out dir>}
out=${3:?usage: sparkle-appcast.sh <archive> <tag> <out dir>}
[ -f "$archive" ] || { echo "no archive at $archive" >&2; exit 2; }
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "tag '$tag' is not v<semver>" >&2; exit 2; }
# The keychain's key is the release owner's: an agent (CLAUDECODE) signs only with a stdin throwaway.
[ "${SPARKLE_KEY_ON_STDIN:-0}" = 1 ] || [ -z "${CLAUDECODE:-}" ] ||
  { echo "sparkle-appcast.sh: run this in your own Terminal: it signs with your keychain's Sparkle key (agents: SPARKLE_KEY_ON_STDIN=1)" >&2; exit 2; }
mkdir -p "$out"

work=$(mktemp -d /tmp/pod-appcast.XXXXXX)
# generate_appcast keeps each archive it extracts in the account's caches for later runs (a whole
# Pod.app); this run's entries go again.
cache=$HOME/Library/Caches/Sparkle_generate_appcast
if [ -d "$cache" ]; then cached_before=$(ls "$cache"); else cached_before=none; fi
drop_cache() {
  [ -d "$cache" ] || return 0
  if [ "$cached_before" = none ]; then /usr/bin/trash "$cache" 2>/dev/null || true; return 0; fi
  local entry
  for entry in "$cache"/*; do
    [ -e "$entry" ] || continue
    grep -qxF "${entry##*/}" <<<"$cached_before" || /usr/bin/trash "$entry" 2>/dev/null || true
  done
}
# The work directory is this run's own and regenerable: removed for good through pod-tmp-rm (owner,
# protected paths and lsof checked) where the Mac has it, never kept in the Trash.
remove=$(command -v pod-tmp-rm || echo "$HOME/.local/bin/pod-tmp-rm")
trap 'drop_cache; if [ -x "$remove" ]; then "$remove" "$work" > /dev/null || true; fi' EXIT
curl -fsSL -o "$work/sparkle.tar.xz" \
  "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz"
[ "$(shasum -a 256 "$work/sparkle.tar.xz" | cut -d' ' -f1)" = "$SPARKLE_SHA256" ] \
  || { echo "Sparkle $SPARKLE_VERSION download digest mismatch" >&2; exit 1; }
mkdir "$work/tools" "$work/feed"
tar -xJf "$work/sparkle.tar.xz" -C "$work/tools" bin

# generate_appcast reads every archive in a folder: this release's alone.
cp -c "$archive" "$work/feed/"
# A stdin key is read once, into memory, and handed to both tools.
[ "${SPARKLE_KEY_ON_STDIN:-0}" = 1 ] && key=$(cat)
run_with_key() { if [ -n "${key:-}" ]; then printf '%s' "$key" | "$@"; else "$@"; fi; }
prefix=${SPARKLE_DOWNLOAD_URL_PREFIX:-$POD_UPDATE_HOST/}
run_with_key "$work/tools/bin/generate_appcast" "${KEY[@]}" \
  --download-url-prefix "$prefix" \
  --link https://pod.codes "$work/feed" 2>&1 | tee "$work/generate_appcast.log"
# Why: an app with another key's SUPublicEDKey refuses every update this feed offers.
! grep -q 'does not match' "$work/generate_appcast.log" ||
  { echo "the archive's SUPublicEDKey is not the signing key's: its app would refuse this update" >&2; exit 1; }
# generate_appcast signs the feed only for an app that sets SURequireSignedFeed (PodNative's
# build-app.sh does); an unsigned feed stops the release here.
run_with_key "$work/tools/bin/sign_update" --verify "${KEY[@]}" "$work/feed/appcast.xml"
unset key
# One item, at this release's download URL.
python3 -I - "$work/feed/appcast.xml" "$prefix" "$(basename "$archive")" <<'PY'
import sys
import xml.etree.ElementTree as ET
path, prefix, name = sys.argv[1:]
items = ET.parse(path).getroot().findall("./channel/item")
assert len(items) == 1, f"expected one appcast item, found {len(items)}"
url = items[0].find("enclosure").get("url")
assert url == prefix + name, f"enclosure URL {url} is not {prefix}{name}"
PY
cp "$work/feed/appcast.xml" "$out/appcast.xml"
echo "$out/appcast.xml"
