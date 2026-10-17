#!/bin/bash
# Publishes a release on Pod's update host (product/update-host), whose appcast every Pod since rc5
# reads at https://updates.pod.codes/appcast.xml (RELEASE-RUNBOOK.md):
#   1. the DMG the appcast names goes into the Blob store under its own name, once: a published
#      archive is never replaced (an app may be checking those bytes against the signature it read).
#      A run that finds it there checks its bytes instead;
#   2. product/update-host with the appcast becomes a production deployment that is not on the
#      domain yet (--skip-domain). It must serve the appcast byte for byte, and the DMG through its
#      redirect byte for byte, before anything changes for installed apps;
#   3. `vercel promote` puts it on the domain, which must then serve the appcast byte for byte. A
#      domain that never does goes back to the deployment it served before.
#
#   product/scripts/publish-update.sh <release dir>
#   product/scripts/publish-update.sh --rehearsal <dir> <https://updates.pod.codes/rehearsal/<name>/>
#   product/scripts/publish-update.sh --remove-rehearsal <https://updates.pod.codes/rehearsal/<name>/>
#
# <release dir> is release-one-app.sh's (appcast.xml, the DMG it names, artifacts.txt), never a dry
# run's. The release owner runs it from Terminal, logged in to Vercel (`vercel login`) with access to
# the outofplace team, after `gh release create`. Pods up to rc4 read GitHub's feed:
# publish-github-appcast.sh, for the bridge release only.
# --rehearsal puts every file of <dir> under rehearsal/<name>/ (an update rehearsal's own feed:
# PodNative's scripts/update-rehearsal.sh, REHEARSAL_PUBLISH_SCRIPT); it touches neither the feed nor
# an archive, so agents may run it. --remove-rehearsal deletes those files again.
# Tests only: POD_UPDATE_READ_HOST replaces the host it reads back, POD_PUBLISH_RETRY_SECONDS the 5 s
# between reads.
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/../update-host/update-host.sh"
site_files=$(cd "$(dirname "${BASH_SOURCE[0]}")/../update-host" && pwd)
read_host=${POD_UPDATE_READ_HOST:-$POD_UPDATE_HOST}

die() {
  printf '\033[31merror\033[0m publish-update: %s\n' "$*" >&2
  exit 1
}
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
# The sha256 of what <url> serves at the end of its redirects ("" when it serves nothing).
served_sha() {
  local out
  out=$(curl -fsSL --connect-timeout 20 --max-time 1800 "$1" | shasum -a 256) || return 0
  cut -d' ' -f1 <<<"$out"
}
# The Content-Length <url> answers at the end of its redirects ("" when it answers none).
served_length() {
  curl -fsSIL --connect-timeout 20 --max-time 60 "$1" 2>/dev/null | tr -d '\r' |
    awk 'tolower($1) == "content-length:" { n = $2 } END { print n }'
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
trap 'if [ -x "$remove" ]; then "$remove" "$work" > /dev/null || true; fi' EXIT
vercel_team() { vercel "$@" --scope "$POD_UPDATE_SCOPE"; }

# The Blob store over OIDC: `vercel env pull` issues a token for the project's development
# environment (12 hours), which is read into memory; the pulled file goes at once.
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
# The size of Blob <pathname>, or "" when there is none.
blob_size() {
  blob list --json --prefix "$1" | python3 -I -c '
import json, sys
name = sys.argv[1]
print(next((str(b["size"]) for b in json.load(sys.stdin)["blobs"] if b["pathname"] == name), ""))
' "$1"
}

rehearsal_path() {
  local base=$1
  [[ "$base" =~ ^$POD_UPDATE_HOST/rehearsal/[A-Za-z0-9._-]+/$ ]] ||
    die "a rehearsal's feed is $POD_UPDATE_HOST/rehearsal/<name>/, not $base"
  echo "${base#"$POD_UPDATE_HOST/"}"
}

if [ "${1:-}" = --rehearsal ]; then
  dir=${2:?usage: publish-update.sh --rehearsal <dir> <base URL>}
  path=$(rehearsal_path "${3:?usage: publish-update.sh --rehearsal <dir> <base URL>}")
  blob_login
  for file in "$dir"/*; do
    [ -f "$file" ] || continue
    name=${file##*/}
    blob put "$file" --access public --pathname "$path$name" --allow-overwrite true \
      --cache-control-max-age 60 >"$work/put.log" 2>&1 || die "Blob $path$name: $(tail -n 1 "$work/put.log")"
    # The feed byte for byte; an archive by its length: the run's Sparkle downloads it and checks its
    # signature anyway, and a second download would only hold the shared e2e lock longer.
    if [ "$name" = appcast.xml ]; then
      expected=$(sha "$file")
      check() { [ "$(served_sha "$read_host/$path$name")" = "$expected" ]; }
    else
      expected=$(stat -f %z "$file")
      check() { [ "$(served_length "$read_host/$path$name")" = "$expected" ]; }
    fi
    retry_reads check || die "$POD_UPDATE_HOST/$path$name does not serve $file"
    echo "publish-update: $POD_UPDATE_HOST/$path$name"
  done
  exit 0
fi
if [ "${1:-}" = --remove-rehearsal ]; then
  path=$(rehearsal_path "${2:?usage: publish-update.sh --remove-rehearsal <base URL>}")
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
# One item whose enclosure is <host>/<DMG>, and the DMG beside it at that length.
read -r build archive length < <(python3 -I - "$feed" "$POD_UPDATE_HOST/" <<'PY'
import sys
import xml.etree.ElementTree as ET
path, host = sys.argv[1:]
ns = {"sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
items = ET.parse(path).getroot().findall("./channel/item")
if len(items) == 1:
    enclosure = items[0].find("enclosure")
    url = enclosure.get("url", "") if enclosure is not None else ""
    name = url[len(host):]
    if url.startswith(host) and name.startswith("Pod-") and name.endswith(".dmg") and "/" not in name:
        print(items[0].findtext("sparkle:version", namespaces=ns), name, enclosure.get("length"))
PY
) || true
[ -n "${archive:-}" ] || die "$feed is not a one-item appcast whose enclosure is $POD_UPDATE_HOST/Pod-<version>.dmg"
dmg=$release/$archive
[ -f "$dmg" ] || die "no $archive in $release"
[ "$(stat -f %z "$dmg")" = "$length" ] || die "$archive is not the $length bytes the appcast says"
dmg_sha=$(sha "$dmg")

# 1. The archive.
blob_login
existing=$(blob_size "$archive") || die "cannot list the Blob store"
if [ -z "$existing" ]; then
  echo "publish-update: uploading $archive ($length bytes)"
  blob put "$dmg" --access public --pathname "$archive" >"$work/put.log" 2>&1 ||
    die "the upload of $archive failed ($(tail -n 1 "$work/put.log")); the feed is unchanged"
elif [ "$existing" != "$length" ]; then
  die "Blob $archive has $existing bytes, not $dmg's $length: a published archive is never replaced, ship a new version"
fi

# 2. The deployment, off the domain.
mkdir "$work/site"
cp "$site_files/vercel.json" "$site_files/robots.txt" "$work/site/"
cp "$feed" "$work/site/appcast.xml"
vercel_team deploy "$work/site" --prod --skip-domain --project "$POD_UPDATE_PROJECT_ID" --yes --json \
  >"$work/deploy.json" 2>"$work/deploy.log" || die "vercel deploy failed (log: $(tail -n 3 "$work/deploy.log")); the feed is unchanged"
# --json prints the deployment itself in a Terminal, wrapped in {"deployment": ...} for an agent.
staged=$(python3 -I -c 'import json, sys; d = json.load(open(sys.argv[1])); print(d.get("deployment", d)["url"])' "$work/deploy.json") ||
  die "vercel deploy named no deployment; the feed is unchanged"
[ "$(served_sha "$staged/appcast.xml")" = "$(sha "$feed")" ] ||
  die "deployment $staged does not serve $feed; the feed is unchanged"
if [ "$(served_sha "$staged/$archive")" != "$dmg_sha" ]; then
  [ -z "$existing" ] || die "Blob $archive is not $dmg: a published archive is never replaced, ship a new version"
  die "deployment $staged does not serve $archive through its redirect; the feed is unchanged"
fi

# 3. The domain.
previous=$(vercel_team inspect "${POD_UPDATE_HOST#https://}" --json 2>/dev/null |
  python3 -I -c 'import json, sys; print(json.load(sys.stdin)["id"])' 2>/dev/null) || previous=""
serves_feed() { [ "$(served_sha "$read_host/appcast.xml")" = "$(sha "$feed")" ]; }
# A deployment already on the domain refuses a promote (409): then the feed only has to be there.
vercel_team promote "$staged" --yes >"$work/promote.log" 2>&1 || serves_feed ||
  die "vercel promote $staged failed ($(tail -n 1 "$work/promote.log")); the feed is unchanged"
if ! retry_reads serves_feed; then
  [ -n "$previous" ] || die "$POD_UPDATE_FEED does not serve $feed, and there was no deployment before: check it with curl"
  vercel_team promote "$previous" --yes >/dev/null 2>&1 &&
    die "$POD_UPDATE_FEED did not serve $feed: the domain is back on $previous"
  die "$POD_UPDATE_FEED did not serve $feed and going back failed: vercel promote $previous --scope $POD_UPDATE_SCOPE"
fi
echo "publish-update: $POD_UPDATE_FEED serves $feed (sparkle:version $build), $POD_UPDATE_HOST/$archive its archive"
