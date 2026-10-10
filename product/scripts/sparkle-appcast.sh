#!/bin/bash
# Writes the Sparkle appcast for one release of the one-app Pod.app: a single item for <archive>,
# its EdDSA signature and the feed's own (PodNative sets SURequireSignedFeed), with download URLs
# under the release's tag. PodNative reads it from releases/latest/download/appcast.xml.
#
#   product/scripts/sparkle-appcast.sh <archive> <tag> <out dir>
#
#   <archive>  the notarized DMG (Developer ID signed: Sparkle's way back if the EdDSA key is ever
#              lost) or a zip of the stapled Pod.app (`ditto -c -k --keepParent`)
#   <tag>      the release tag, e.g. v0.1.0
#
# The private key is read from this Mac's login keychain (`generate_keys --account $SPARKLE_ACCOUNT`,
# default codes.pod); the first use asks for keychain access once. It is never read from a file.
# SPARKLE_KEY_ON_STDIN=1 reads a throwaway key from stdin instead (tests and rehearsals only).
# Sparkle's tools come from the release whose framework PodNative pins, checked against its digest.
set -euo pipefail

SPARKLE_VERSION=2.10.0
SPARKLE_SHA256=c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
ACCOUNT=${SPARKLE_ACCOUNT:-codes.pod}
KEY=(--account "$ACCOUNT")
[ "${SPARKLE_KEY_ON_STDIN:-0}" = 1 ] && KEY=(--ed-key-file -)
FEED_REPO=outof-place/pod

archive=${1:?usage: sparkle-appcast.sh <archive> <tag> <out dir>}
tag=${2:?usage: sparkle-appcast.sh <archive> <tag> <out dir>}
out=${3:?usage: sparkle-appcast.sh <archive> <tag> <out dir>}
[ -f "$archive" ] || { echo "no archive at $archive" >&2; exit 2; }
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "tag '$tag' is not v<semver>" >&2; exit 2; }
mkdir -p "$out"

work=$(mktemp -d /tmp/pod-appcast.XXXXXX)
trap '/usr/bin/trash "$work" 2>/dev/null || true' EXIT
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
run_with_key "$work/tools/bin/generate_appcast" "${KEY[@]}" \
  --download-url-prefix "https://github.com/$FEED_REPO/releases/download/$tag/" \
  --link https://pod.codes "$work/feed"
# generate_appcast signs the feed only for an app that sets SURequireSignedFeed (PodNative's
# build-app.sh does); an unsigned feed stops the release here.
run_with_key "$work/tools/bin/sign_update" --verify "${KEY[@]}" "$work/feed/appcast.xml"
unset key
# One item, pointing at this tag.
python3 - "$work/feed/appcast.xml" "$tag" "$(basename "$archive")" <<'PY'
import sys
import xml.etree.ElementTree as ET
path, tag, name = sys.argv[1:]
items = ET.parse(path).getroot().findall("./channel/item")
assert len(items) == 1, f"expected one appcast item, found {len(items)}"
url = items[0].find("enclosure").get("url")
assert url.endswith(f"/releases/download/{tag}/{name}"), f"enclosure URL {url} is not under {tag}"
PY
cp "$work/feed/appcast.xml" "$out/appcast.xml"
echo "$out/appcast.xml"
