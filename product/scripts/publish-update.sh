#!/bin/bash
# Publishes a release for Pod's updater (RELEASE-RUNBOOK.md). Every Pod since rc5 reads the appcast at
# https://updates.pod.codes/appcast.xml, and every appcast names its DMG at
# https://updates.pod.codes/download/<tag>/<DMG>, a 302 to the asset of the tag's release in
# outof-place/pod-releases (product/update-host/update-host.sh). Before any change it checks the DMG
# against artifacts.txt's sha256, that the domain serves no higher sparkle:version (the same one is a
# re-run), and which deployment the domain is on (the way back; none while it serves a feed stops).
#   1. the DMG goes up as that asset, once; a missing release is created with it (a prerelease for
#      an RC). A published asset is never replaced (an app may be checking those bytes against the
#      signature it read): a run that finds it there checks its size and digest instead;
#   2. product/update-host with the appcast becomes a production deployment that is not on the
#      domain yet (--skip-domain). It must serve the appcast byte for byte, and its download/
#      redirect must deliver the DMG byte for byte (length and sha256), followed to the end as
#      Sparkle does, before anything changes for installed apps;
#   3. `vercel promote` puts it on the domain, which must then serve the appcast byte for byte. A
#      domain that never does goes back to the deployment it served before.
#
#   product/scripts/publish-update.sh <release dir>
#   product/scripts/publish-update.sh --rehearsal <dir> <https://updates.pod.codes/rehearsal/<name>/>
#   product/scripts/publish-update.sh --remove-rehearsal <https://updates.pod.codes/rehearsal/<name>/>
#   product/scripts/publish-update.sh --rehearsal-downloads <https://updates.pod.codes/rehearsal/<name>/>
#
# <release dir> is release-one-app.sh's (appcast.xml, the DMG it names, artifacts.txt), never a dry
# run's. The release owner runs it from Terminal, with `gh auth status` green for outof-place and
# `vercel login` with access to the outofplace team. Pods up to rc4 read GitHub's feed:
# publish-github-appcast.sh, for the bridge release only.
# An update rehearsal (PodNative's scripts/update-rehearsal.sh, REHEARSAL_PUBLISH_SCRIPT) has a
# prerelease of its own, rehearsal-<name>, named download/rehearsal-<name>/ on the host (the domain's
# deployment must carry the download/ redirect). --rehearsal uploads every archive of <dir> there (replacing
# one of the same name), checks that each enclosure of <dir>/appcast.xml delivers its archive, then
# puts the appcast under rehearsal/<name>/ on the host. It touches neither the feed nor a published
# archive, so agents may run it. --remove-rehearsal deletes the release, its tag and the appcast;
# --rehearsal-downloads prints the download URL prefix the rehearsal's appcast must use.
# Tests only: POD_UPDATE_READ_HOST replaces the host it reads back, POD_PUBLISH_RETRY_SECONDS the 5 s
# between reads.
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/../update-host/update-host.sh"
site_files=$(cd "$(dirname "${BASH_SOURCE[0]}")/../update-host" && pwd)
read_host=${POD_UPDATE_READ_HOST:-$POD_UPDATE_HOST}
# Appended to a failure of the real release: nothing an installed Pod reads has changed yet.
unchanged=""

die() {
  printf '\033[31merror\033[0m publish-update: %s\n' "$*" >&2
  exit 1
}
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
size() { wc -c <"$1" | tr -d ' '; }
# The sha256 of what <url> serves at the end of its redirects ("" when it serves nothing).
served_sha() {
  local out
  out=$(curl -fsSL --connect-timeout 20 --max-time 120 "$1" | shasum -a 256) || return 0
  cut -d' ' -f1 <<<"$out"
}
retry_reads() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    "$@" && return 0
    [ "$attempt" = 10 ] || sleep "${POD_PUBLISH_RETRY_SECONDS:-5}"
  done
  return 1
}

work=$(mktemp -d /tmp/pod-publish-update.XXXXXX)
remove=$(command -v pod-tmp-rm || echo "$HOME/.local/bin/pod-tmp-rm")
trap 'if [ -x "$remove" ]; then "$remove" "$work" > /dev/null || true; else rm -rf "${work:?}"; fi' EXIT
vercel_team() { vercel "$@" --scope "$POD_UPDATE_SCOPE"; }

# The Blob store (rehearsal feeds only) over OIDC: `vercel env pull` issues a token for the
# project's development environment (12 hours), which is read into memory; the pulled file goes at once.
blob_login() {
  mkdir -p "$work/link/.vercel" "$work/blob"
  printf '{"projectId":"%s","orgId":"%s"}\n' "$POD_UPDATE_PROJECT_ID" "$POD_UPDATE_ORG_ID" >"$work/link/.vercel/project.json"
  (cd "$work/link" && vercel env pull "$work/link/oidc.env" --environment development --yes) >"$work/env-pull.log" 2>&1 ||
    die "vercel env pull failed ($(tail -n 1 "$work/env-pull.log")): \`vercel login\` with access to the $POD_UPDATE_SCOPE team"
  VERCEL_OIDC_TOKEN=$(sed -n 's/^VERCEL_OIDC_TOKEN="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$work/link/oidc.env")
  rm -f "$work/link/oidc.env"
  [ -n "$VERCEL_OIDC_TOKEN" ] || die "the project gave no OIDC token: is the Blob store still connected to its development environment?"
  export VERCEL_OIDC_TOKEN BLOB_STORE_ID=$POD_UPDATE_BLOB_STORE
}
# Run from a directory of its own: the CLI also reads credentials from a .env.local in its cwd.
blob() { (cd "$work/blob" && vercel blob "$@"); }

# "<id> <name> <size> <state> <digest>" for each asset of release <tag>; status 3 when there is none.
release_assets() {
  local out
  if out=$(gh api "repos/$POD_RELEASES_REPO/releases/tags/$1" \
    --jq '.assets[] | "\(.id) \(.name) \(.size) \(.state) \(.digest // "-")"' 2>"$work/gh-api.log"); then
    [ -z "$out" ] || printf '%s\n' "$out"
    return 0
  fi
  grep -q 'HTTP 404' "$work/gh-api.log" && return 3
  return 1
}
# Puts <file> on release <tag>, creating the release with it when there is none. A published asset
# is never replaced unless <replace> is 1 (a rehearsal's own): it must be <file>. An upload that never
# finished (state not "uploaded") is deleted first: no one could have downloaded it.
publish_archive() {
  local tag=$1 file=$2 replace=$3 title=$4 notes=$5 prerelease=$6
  local name=${2##*/} assets status=0 id="" state="" asset_size="" digest="" flags=()
  [ "$prerelease" = 1 ] && flags+=(--prerelease)
  assets=$(release_assets "$tag") || status=$?
  if [ "$status" = 3 ]; then
    echo "publish-update: creating $POD_RELEASES_REPO $tag with $name ($(size "$file") bytes)"
    gh release create "$tag" "$file" --repo "$POD_RELEASES_REPO" --title "$title" --notes "$notes" \
      ${flags[@]+"${flags[@]}"} >"$work/gh.log" 2>&1 ||
      die "could not create $POD_RELEASES_REPO $tag with $name ($(tail -n 1 "$work/gh.log"))$unchanged"
    return 0
  fi
  [ "$status" = 0 ] ||
    die "cannot read $POD_RELEASES_REPO $tag ($(tail -n 1 "$work/gh-api.log")): is \`gh auth status\` green?$unchanged"
  read -r id state asset_size digest < <(awk -v n="$name" '$2 == n { print $1, $4, $3, $5 }' <<<"$assets") || true
  if [ -n "$id" ] && [ "$state" != uploaded ]; then
    gh api -X DELETE "repos/$POD_RELEASES_REPO/releases/assets/$id" >"$work/gh.log" 2>&1 ||
      die "could not delete the unfinished upload $name of $POD_RELEASES_REPO $tag ($(tail -n 1 "$work/gh.log"))$unchanged"
    id=""
  fi
  if [ -n "$id" ] && [ "$replace" = 0 ]; then
    [ "$asset_size" = "$(size "$file")" ] && { [ "$digest" = - ] || [ "$digest" = "sha256:$(sha "$file")" ]; } ||
      die "$POD_RELEASES_REPO $tag already has $name ($asset_size bytes, $digest), not $file: a published archive is never replaced, ship a new version$unchanged"
    echo "publish-update: $name is already on $POD_RELEASES_REPO $tag"
    return 0
  fi
  [ "$replace" = 1 ] && flags=(--clobber) || flags=()
  echo "publish-update: uploading $name ($(size "$file") bytes) to $POD_RELEASES_REPO $tag"
  gh release upload "$tag" "$file" --repo "$POD_RELEASES_REPO" ${flags[@]+"${flags[@]}"} >"$work/gh.log" 2>&1 ||
    die "the upload of $name to $POD_RELEASES_REPO $tag failed ($(tail -n 1 "$work/gh.log"))$unchanged"
}
# The URL this run reads for <url> on the domain (tests read the domain from a directory).
read_url() {
  case "$1" in
    "$POD_UPDATE_HOST/"*) echo "$read_host/${1#"$POD_UPDATE_HOST/"}" ;;
    *) echo "$1" ;;
  esac
}
# The highest sparkle:version of the appcast at <file> ("" for none).
feed_version() {
  python3 -I -c '
import sys
import xml.etree.ElementTree as ET
ns = {"sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
items = ET.parse(sys.argv[1]).getroot().findall("./channel/item")
versions = [int(v) for v in (i.findtext("sparkle:version", namespaces=ns) for i in items) if v and v.isdigit()]
print(max(versions) if versions else "")' "$1" 2>/dev/null || true
}
# What the domain serves now, in words, for a message.
domain_serves() {
  local served
  rm -f "$work/domain.xml"
  curl -fsSL --connect-timeout 20 --max-time 120 -o "$work/domain.xml" "$read_host/appcast.xml" 2>/dev/null ||
    { echo "no appcast"; return 0; }
  served=$(feed_version "$work/domain.xml")
  echo "sparkle:version ${served:-unknown} (sha256 $(sha "$work/domain.xml"))"
}
# Whether <url>, followed to the end of its redirects as Sparkle does, delivers <file> byte for byte.
# A minute without a byte is a stall, as for Sparkle (NSURLRequest's 60 s); three tries. The last
# failure is in $work/delivered.why.
delivers() {
  local url=$1 file=$2 attempt took
  for attempt in 1 2 3; do
    rm -f "$work/delivered"
    if took=$(curl -fsSL --connect-timeout 20 --speed-limit 1 --speed-time 60 -w '%{time_total}' \
      -o "$work/delivered" "$url" 2>"$work/delivered.why"); then
      if [ "$(size "$work/delivered")" = "$(size "$file")" ] && [ "$(sha "$work/delivered")" = "$(sha "$file")" ]; then
        echo "publish-update: $url delivered $(size "$file") bytes, sha256 $(sha "$file"), in ${took%.*} s"
        rm -f "$work/delivered"
        return 0
      fi
      echo "got $(size "$work/delivered") bytes, sha256 $(sha "$work/delivered")" >"$work/delivered.why"
    fi
    [ "$attempt" = 3 ] || sleep "${POD_PUBLISH_RETRY_SECONDS:-5}"
  done
  rm -f "$work/delivered"
  return 1
}

rehearsal_path() {
  local base=$1
  [[ "$base" =~ ^$POD_UPDATE_HOST/rehearsal/[A-Za-z0-9._-]+/$ ]] && [[ ! "$base" =~ /\.\.?/$ ]] ||
    die "a rehearsal's feed is $POD_UPDATE_HOST/rehearsal/<name>/, not $base"
  echo "${base#"$POD_UPDATE_HOST/"}"
}
# A rehearsal's own prerelease: never a v<version> tag.
rehearsal_tag() {
  local path
  path=$(rehearsal_path "$1") || exit 1
  path=${path#rehearsal/}
  echo "rehearsal-${path%/}"
}

if [ "${1:-}" = --rehearsal-downloads ]; then
  tag=$(rehearsal_tag "${2:?usage: publish-update.sh --rehearsal-downloads <base URL>}")
  echo "$POD_DOWNLOAD/$tag/"
  exit 0
fi
if [ "${1:-}" = --rehearsal ]; then
  dir=${2:?usage: publish-update.sh --rehearsal <dir> <base URL>}
  base=${3:?usage: publish-update.sh --rehearsal <dir> <base URL>}
  path=$(rehearsal_path "$base")
  tag=$(rehearsal_tag "$base")
  [ -f "$dir/appcast.xml" ] || die "no appcast.xml in $dir"
  enclosures=$(python3 -I -c '
import sys
import xml.etree.ElementTree as ET
for item in ET.parse(sys.argv[1]).getroot().findall("./channel/item"):
    enclosure = item.find("enclosure")
    if enclosure is not None:
        print(enclosure.get("url", ""))
' "$dir/appcast.xml") || die "cannot read $dir/appcast.xml"
  [ -n "$enclosures" ] || die "$dir/appcast.xml names no archive"
  while IFS= read -r url; do
    name=${url#"$POD_DOWNLOAD/$tag/"}
    [ "$name" != "$url" ] && [[ "$name" != */* ]] && [ -f "$dir/$name" ] ||
      die "the enclosure $url is not an archive of $dir under $POD_DOWNLOAD/$tag/ (--rehearsal-downloads)"
  done <<<"$enclosures"
  # 1. The archives, on the rehearsal's own prerelease.
  for file in "$dir"/*; do
    [ -f "$file" ] && [ "${file##*/}" != appcast.xml ] || continue
    publish_archive "$tag" "$file" 1 "Update rehearsal $tag" \
      "An update rehearsal's archive (PodNative's scripts/update-rehearsal.sh), deleted when the rehearsal ends." 1
  done
  # 2. Each enclosure delivers its archive, as the run's Sparkle will download it.
  while IFS= read -r url; do
    name=${url#"$POD_DOWNLOAD/$tag/"}
    delivers "$(read_url "$url")" "$dir/$name" ||
      die "$url does not deliver $dir/$name byte for byte (3 downloads; last: $(tail -n 1 "$work/delivered.why"))"
  done <<<"$enclosures"
  # 3. The feed, under rehearsal/<name>/ on the host.
  blob_login
  blob put "$dir/appcast.xml" --access public --pathname "${path}appcast.xml" --allow-overwrite true \
    --cache-control-max-age 60 >"$work/put.log" 2>&1 || die "Blob ${path}appcast.xml: $(tail -n 1 "$work/put.log")"
  expected=$(sha "$dir/appcast.xml")
  check() { [ "$(served_sha "$read_host/${path}appcast.xml")" = "$expected" ]; }
  retry_reads check || die "$POD_UPDATE_HOST/${path}appcast.xml does not serve $dir/appcast.xml"
  echo "publish-update: $POD_UPDATE_HOST/${path}appcast.xml"
  exit 0
fi
if [ "${1:-}" = --remove-rehearsal ]; then
  base=${2:?usage: publish-update.sh --remove-rehearsal <base URL>}
  path=$(rehearsal_path "$base")
  tag=$(rehearsal_tag "$base")
  status=0
  release_assets "$tag" >/dev/null || status=$?
  case "$status" in
    0)
      gh release delete "$tag" --repo "$POD_RELEASES_REPO" --yes --cleanup-tag >"$work/gh.log" 2>&1 ||
        die "could not delete $POD_RELEASES_REPO $tag: $(tail -n 1 "$work/gh.log")"
      echo "publish-update: deleted $POD_RELEASES_REPO $tag and its tag" ;;
    3)
      # A tag a failed create may have left behind.
      if gh api -X DELETE "repos/$POD_RELEASES_REPO/git/refs/tags/$tag" >/dev/null 2>&1; then
        echo "publish-update: deleted tag $tag of $POD_RELEASES_REPO"
      else
        echo "publish-update: no release $tag in $POD_RELEASES_REPO"
      fi ;;
    *) die "cannot read $POD_RELEASES_REPO $tag: $(tail -n 1 "$work/gh-api.log")" ;;
  esac
  blob_login
  names=$(blob list --json --prefix "$path" --limit 1000 |
    python3 -I -c 'import json, sys; print("\n".join(b["pathname"] for b in json.load(sys.stdin)["blobs"]))')
  [ -n "$names" ] || { echo "publish-update: nothing under $path"; exit 0; }
  while IFS= read -r name; do
    blob del "$name" >"$work/del.log" 2>&1 || die "could not delete Blob $name: $(tail -n 1 "$work/del.log")"
    echo "publish-update: deleted $name"
  done <<<"$names"
  exit 0
fi

release=${1:?usage: product/scripts/publish-update.sh <release dir>}
[ -z "${CLAUDECODE:-}" ] || die "run this in your own Terminal: it publishes the feed every installed Pod reads"
feed=$release/appcast.xml
[ -f "$feed" ] || die "no appcast at $feed"
[ -f "$release/artifacts.txt" ] || die "no artifacts.txt in $release: publish what release-one-app.sh made"
! head -n 1 "$release/artifacts.txt" | grep -q 'DRY RUN' ||
  die "$release is a dry run: its throwaway key would lock every installed Pod out of the feed"
# One item whose enclosure is <host>/download/v<version>/Pod-<version>.dmg, and the DMG beside it at
# that length (the length and EdDSA signature the appcast carries are that file's).
read -r build tag archive length < <(python3 -I - "$feed" "$POD_DOWNLOAD/" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET
path, prefix = sys.argv[1:]
ns = {"sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
items = ET.parse(path).getroot().findall("./channel/item")
if len(items) == 1:
    enclosure = items[0].find("enclosure")
    url = enclosure.get("url", "") if enclosure is not None else ""
    version = r"([0-9][0-9A-Za-z.-]*)"
    match = re.fullmatch(re.escape(prefix) + "v" + version + "/(Pod-" + version + r"\.dmg)", url)
    if match and match.group(1) == match.group(3):
        print(items[0].findtext("sparkle:version", namespaces=ns), "v" + match.group(1), match.group(2), enclosure.get("length"))
PY
) || true
[ -n "${archive:-}" ] ||
  die "$feed is not a one-item appcast whose enclosure is $POD_DOWNLOAD/v<version>/Pod-<version>.dmg"
version=${tag#v}
enclosure=$POD_DOWNLOAD/$tag/$archive
dmg=$release/$archive
[ -f "$dmg" ] || die "no $archive in $release"
[ "$(size "$dmg")" = "$length" ] || die "$archive is not the $length bytes the appcast says"
# The DMG release-one-app.sh made: its line in artifacts.txt is "<name> <size> <sha256>".
recorded=$(awk -v n="$archive" '$1 == n { print $3; exit }' "$release/artifacts.txt")
[ -n "$recorded" ] || die "artifacts.txt names no sha256 for $archive"
[ "$recorded" = "$(sha "$dmg")" ] || die "$archive is not the DMG artifacts.txt records (sha256 $recorded)"
unchanged="; the feed is unchanged"

# Before any change: no step back for installed Pods, and a way back for the domain.
domain_feed=0
if curl -fsSL --connect-timeout 20 --max-time 120 -o "$work/domain.xml" "$read_host/appcast.xml" 2>/dev/null; then
  domain_feed=1
  served=$(feed_version "$work/domain.xml")
  [ -n "$served" ] || die "$POD_UPDATE_FEED serves an appcast with no sparkle:version: check it with curl$unchanged"
  [ "$build" -ge "$served" ] ||
    die "sparkle:version $build is below $served, which $POD_UPDATE_FEED serves: installed Pods never take a lower one$unchanged"
fi
previous=$(vercel_team inspect "${POD_UPDATE_HOST#https://}" --json 2>/dev/null |
  python3 -I -c 'import json, sys; print(json.load(sys.stdin)["id"])' 2>/dev/null) || previous=""
[ -n "$previous" ] || [ "$domain_feed" = 0 ] ||
  die "vercel inspect names no deployment of ${POD_UPDATE_HOST#https://}, which serves a feed: no deployment to go back to$unchanged"

# 1. The archive.
prerelease=0
[[ "$version" == *-* ]] && prerelease=1
publish_archive "$tag" "$dmg" 0 "Pod $version" \
  "Pod $version: the signed DMG Pod's updater downloads (feed: $POD_UPDATE_FEED)." "$prerelease"

# 2. The deployment, off the domain: its appcast, and the DMG through its own download/ redirect.
mkdir "$work/site"
cp "$site_files/vercel.json" "$site_files/robots.txt" "$work/site/"
cp "$feed" "$work/site/appcast.xml"
vercel_team deploy "$work/site" --prod --skip-domain --project "$POD_UPDATE_PROJECT_ID" --yes --json \
  >"$work/deploy.json" 2>"$work/deploy.log" || die "vercel deploy failed (log: $(tail -n 3 "$work/deploy.log"))$unchanged"
# --json prints the deployment itself in a Terminal, wrapped in {"deployment": ...} for an agent.
staged=$(python3 -I -c 'import json, sys; d = json.load(open(sys.argv[1])); print(d.get("deployment", d)["url"])' "$work/deploy.json") ||
  die "vercel deploy named no deployment$unchanged"
[ "$(served_sha "$staged/appcast.xml")" = "$(sha "$feed")" ] ||
  die "deployment $staged does not serve $feed$unchanged"
delivers "$staged/download/$tag/$archive" "$dmg" ||
  die "$enclosure does not deliver $archive byte for byte through $staged (3 downloads; last: $(tail -n 1 "$work/delivered.why"))$unchanged"

# 3. The domain.
serves_feed() { [ "$(served_sha "$read_host/appcast.xml")" = "$(sha "$feed")" ]; }
# A deployment already on the domain refuses a promote (409): then the feed only has to be there.
if ! vercel_team promote "$staged" --yes >"$work/promote.log" 2>&1; then
  retry_reads serves_feed ||
    die "vercel promote $staged failed ($(tail -n 1 "$work/promote.log"))$unchanged: the domain serves $(domain_serves)"
fi
if ! retry_reads serves_feed; then
  [ -n "$previous" ] || die "$POD_UPDATE_FEED does not serve $feed, and there was no deployment before: check it with curl"
  vercel_team promote "$previous" --yes >/dev/null 2>&1 &&
    die "$POD_UPDATE_FEED did not serve $feed: the domain is back on $previous"
  die "$POD_UPDATE_FEED did not serve $feed and going back failed: vercel promote $previous --scope $POD_UPDATE_SCOPE"
fi
echo "publish-update: $POD_UPDATE_FEED serves $feed (sparkle:version $build), its archive $enclosure"
