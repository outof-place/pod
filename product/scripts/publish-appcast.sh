#!/bin/bash
# Publishes Pod's update feed: makes <appcast.xml> the `appcast` release's appcast.xml asset, which
# every installed Pod reads (RELEASE-RUNBOOK.md). GitHub refuses a second asset of one name, and
# `gh release upload --clobber` deletes before it uploads, so a failed upload would leave the feed
# at 404 until someone noticed. Here:
#   1. upload it as appcast.xml.new and download it back: it must be byte for byte this file;
#   2. rename the live asset to appcast.xml.old, then the new one to appcast.xml. The feed is
#      missing only between those two calls, and a failed second rename puts the old one back;
#   3. delete appcast.xml.old, then read the feed until it offers this appcast's sparkle:version.
#
#   product/scripts/publish-appcast.sh <appcast.xml>
#
# The release owner runs it from Terminal, after `gh release create` of the release it points at.
# Tests only: POD_FEED_URL replaces the feed URL it reads back, POD_PUBLISH_RETRY_SECONDS the 5 s
# between attempts.
set -euo pipefail

REPO=outof-place/pod
TAG=appcast
FEED_URL=${POD_FEED_URL:-https://github.com/$REPO/releases/download/$TAG/appcast.xml}

die() {
  printf '\033[31merror\033[0m publish-appcast: %s\n' "$*" >&2
  exit 1
}
feed=${1:?usage: product/scripts/publish-appcast.sh <appcast.xml>}
[ -f "$feed" ] || die "no appcast at $feed"
[ -z "${CLAUDECODE:-}" ] || die "run this in your own Terminal: it publishes the feed every installed Pod reads"

version_of() {
  python3 -I -c '
import sys
import xml.etree.ElementTree as ET
ns = {"sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
items = ET.parse(sys.argv[1]).getroot().findall("./channel/item")
print(items[0].findtext("sparkle:version", namespaces=ns) if len(items) == 1 else "")
' "$1" 2>/dev/null || true
}
build=$(version_of "$feed")
[ -n "$build" ] || die "$feed is not a one-item appcast"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

work=$(mktemp -d /tmp/pod-publish-appcast.XXXXXX)
remove=$(command -v pod-tmp-rm || echo "$HOME/.local/bin/pod-tmp-rm")
trap 'if [ -x "$remove" ]; then "$remove" "$work" > /dev/null || true; fi' EXIT
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

# 3. The old feed goes; the new one must be what apps get.
[ -z "$old" ] || retry gh api -X DELETE "repos/$REPO/releases/assets/$old" ||
  echo "publish-appcast: asset $old appcast.xml.old is still there; delete it before the next release" >&2
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsL --connect-timeout 20 --max-time 60 -o "$work/live/appcast.xml" "$FEED_URL" &&
    [ "$(version_of "$work/live/appcast.xml")" = "$build" ]; then
    echo "publish-appcast: $FEED_URL offers sparkle:version $build"
    exit 0
  fi
  sleep 6
done
die "$FEED_URL does not offer sparkle:version $build yet: check it with curl before telling anyone"
