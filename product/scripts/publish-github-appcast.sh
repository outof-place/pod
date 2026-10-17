#!/bin/bash
# Publishes the bridge release on GitHub's feed, the `appcast` release's appcast.xml asset that Pods up
# to rc4 read (RELEASE-RUNBOOK.md). Every later Pod reads Pod's own host (publish-update.sh), so this
# runs once, for POD_BRIDGE_VERSION (product/update-host/update-host.sh): its appcast must be the one
# the host already serves, with the archive at https://updates.pod.codes/download/ (a redirect to
# outof-place/pod-releases, public when outof-place/pod is not), and nothing after it is written here.
# GitHub refuses a second asset of one name, and `gh release upload --clobber` deletes before it
# uploads, so a failed upload would leave the feed at 404 until someone noticed. Here:
#   1. upload it as appcast.xml.new and download it back: it must be byte for byte this file;
#   2. rename the live asset to appcast.xml.old, then the new one to appcast.xml. The feed is
#      missing only between those two calls, and a failed second rename puts the old one back;
#   3. read the feed until it serves this file byte for byte, and only then delete appcast.xml.old.
#      Nothing proves the download URL follows a renamed asset, so a feed that never shows up
#      rolls the swap back: the new asset to appcast.xml.new, the old one to appcast.xml.
#
#   product/scripts/publish-github-appcast.sh <appcast.xml>
#
# The release owner runs it from Terminal, after publish-update.sh of the same release.
# Tests only: POD_FEED_URL replaces the feed URL it reads back, POD_UPDATE_READ_HOST the update host,
# POD_PUBLISH_RETRY_SECONDS the 5 s between attempts (3 for an API call, 10 for the feed).
set -euo pipefail

scripts=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$scripts/../update-host/update-host.sh"
REPO=outof-place/pod
TAG=appcast
FEED_URL=${POD_FEED_URL:-$POD_GITHUB_FEED}

die() {
  printf '\033[31merror\033[0m publish-github-appcast: %s\n' "$*" >&2
  exit 1
}
feed=${1:?usage: product/scripts/publish-github-appcast.sh <appcast.xml>}
[ -f "$feed" ] || die "no appcast at $feed"
[ -z "${CLAUDECODE:-}" ] || die "run this in your own Terminal: it publishes the feed every installed Pod reads"

# "<sparkle:version> <enclosure URL>" of a one-item appcast, else nothing.
item_of() {
  python3 -I -c '
import sys
import xml.etree.ElementTree as ET
ns = {"sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
items = ET.parse(sys.argv[1]).getroot().findall("./channel/item")
if len(items) == 1:
    enclosure = items[0].find("enclosure")
    print(items[0].findtext("sparkle:version", namespaces=ns), "" if enclosure is None else enclosure.get("url", ""))
' "$1" 2>/dev/null || true
}
read -r build enclosure <<<"$(item_of "$feed")" || true
[ -n "${build:-}" ] || die "$feed is not a one-item appcast"
bridge=$("$scripts/pod-build-number.sh" "$POD_BRIDGE_VERSION")
[ "$build" = "$bridge" ] ||
  die "GitHub's feed was last written for $POD_BRIDGE_VERSION ($bridge), not $build: Pods since then read $POD_UPDATE_FEED"
[[ "${enclosure:-}" == "$POD_DOWNLOAD/"* ]] ||
  die "the archive is ${enclosure:-missing}, not on $POD_DOWNLOAD/ (Pod's own name for $POD_RELEASES_REPO): outof-place/pod turns private, and a signed feed must name a URL we can point elsewhere"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
# The host first: Pods that move over through this feed find the same release there.
host_feed=$(curl -fsSL --connect-timeout 20 --max-time 60 "${POD_UPDATE_READ_HOST:-$POD_UPDATE_HOST}/appcast.xml" | shasum -a 256 | cut -d' ' -f1) ||
  host_feed=""
[ "$host_feed" = "$(sha "$feed")" ] || die "$POD_UPDATE_FEED does not serve $feed yet: run publish-update.sh first"

work=$(mktemp -d /tmp/pod-publish-github-appcast.XXXXXX)
remove=$(command -v pod-tmp-rm || echo "$HOME/.local/bin/pod-tmp-rm")
trap 'if [ -x "$remove" ]; then "$remove" "$work" > /dev/null || true; else rm -rf "${work:?}"; fi' EXIT
mkdir "$work/up" "$work/back" "$work/live"
cp "$feed" "$work/up/appcast.xml.new"

asset_id() {
  gh api "repos/$REPO/releases/tags/$TAG" --jq '.assets[] | "\(.id) \(.name)"' |
    awk -v name="$1" '$2 == name { print $1 }'
}
rename() { gh api -X PATCH "repos/$REPO/releases/assets/$1" -f name="$2" --jq .name >/dev/null; }
retry() {
  local attempt
  for attempt in 1 2 3; do
    "$@" && return 0
    [ "$attempt" = 3 ] || sleep "${POD_PUBLISH_RETRY_SECONDS:-5}"
  done
  return 1
}

stale=$(asset_id appcast.xml.old)
[ -z "$stale" ] || die "asset $stale appcast.xml.old is left from an earlier run. If appcast.xml is missing, rename it back: gh api -X PATCH repos/$REPO/releases/assets/$stale -f name=appcast.xml; else delete it. Then run this again."
leftover=$(asset_id appcast.xml.new)
[ -z "$leftover" ] || gh api -X DELETE "repos/$REPO/releases/assets/$leftover"

# 1. Upload under a name no app reads.
retry gh release upload "$TAG" "$work/up/appcast.xml.new" --repo "$REPO" || die "the upload failed; the feed is unchanged"
new=$(asset_id appcast.xml.new)
[ -n "$new" ] || die "the upload left no appcast.xml.new; the feed is unchanged"
gh release download "$TAG" --repo "$REPO" --pattern appcast.xml.new --dir "$work/back"
[ "$(sha "$work/back/appcast.xml.new")" = "$(sha "$feed")" ] ||
  die "GitHub's appcast.xml.new (asset $new) is not $feed; the feed is unchanged"

# 2. The swap.
old=$(asset_id appcast.xml)
[ -z "$old" ] || retry rename "$old" appcast.xml.old || die "could not rename the live feed; it is unchanged"
if ! retry rename "$new" appcast.xml; then
  [ -n "$old" ] && retry rename "$old" appcast.xml && die "could not rename asset $new to appcast.xml; the old feed is back"
  die "THE FEED IS MISSING: gh api -X PATCH repos/$REPO/releases/assets/$new -f name=appcast.xml"
fi

# 3. What apps get must be this file before the old feed goes.
serves_feed() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    rm -f "$work/live/appcast.xml"
    curl -fsL --connect-timeout 20 --max-time 60 -o "$work/live/appcast.xml" "$FEED_URL" &&
      [ "$(sha "$work/live/appcast.xml")" = "$(sha "$feed")" ] && return 0
    [ "$attempt" = 10 ] || sleep "${POD_PUBLISH_RETRY_SECONDS:-5}"
  done
  return 1
}
if ! serves_feed; then
  [ -n "$old" ] || die "$FEED_URL does not serve $feed, and there is no old feed to go back to: check it with curl"
  retry rename "$new" appcast.xml.new && retry rename "$old" appcast.xml &&
    die "$FEED_URL did not serve $feed: the swap is rolled back, the old feed is appcast.xml again"
  die "$FEED_URL did not serve $feed and the rollback failed: fix the assets by hand (gh api repos/$REPO/releases/tags/$TAG)"
fi
[ -z "$old" ] || retry gh api -X DELETE "repos/$REPO/releases/assets/$old" ||
  echo "publish-github-appcast: asset $old appcast.xml.old is still there; delete it by hand" >&2
echo "publish-github-appcast: $FEED_URL serves $feed (sparkle:version $build)"
