#!/bin/bash
# The release's step 0: the Electron zip electron-builder unpacks, already in its download cache and
# checked, so a release on a flaky network never fetches 120 MB mid-build.
#
#   product/scripts/electron-cache.sh [--from <zip> | --fetch]
#
#   (no option)   check the cached zip; fails when it is missing or differs
#   --from <zip>  fill a missing or different cache entry from <zip> (another cache, a download)
#   --fetch       fill it from Electron's GitHub release
#
# The version is the lockfile's (node_modules/electron, installed from pnpm-lock.yaml). The zip must
# match that package's checksums.json and Electron's published SHASUMS256.txt.
# electron-builder 26.15.3 downloads it through @electron/get 3.1.0 with no cache option, so the cache
# is env-paths' ~/Library/Caches/electron/<sha256 of the release URL>/: ELECTRON_CACHE and
# electron_config_cache are not read there, and ELECTRON_BUILDER_CACHE moves only electron-builder's
# own tools. @electron/get still fetches SHASUMS256.txt on every build, cache or not.
set -euo pipefail

# release.sh's only arch.
ARCH=arm64
BASE_URL=https://github.com/electron/electron/releases/download

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
die() {
  printf '\033[31merror\033[0m electron-cache: %s\n' "$*" >&2
  exit 1
}

from="" fetch=0
case "${1:-}" in
  "") ;;
  --from) from=${2:?--from needs a zip}; [ -f "$from" ] || die "no zip at $from" ;;
  --fetch) fetch=1 ;;
  *) die "usage: product/scripts/electron-cache.sh [--from <zip> | --fetch]" ;;
esac
# A mirror or custom path changes the URL, so the build would look in another cache directory.
if env | grep -iqE '^(npm_config_|npm_package_config_)?electron_(mirror|custom_?dir|custom_?filename|nightly_?mirror)='; then
  die "an Electron mirror variable is set: electron-builder would not read this cache"
fi

version=$(node -p "require('electron/package.json').version")
grep -qxF "  electron@$version:" pnpm-lock.yaml || die "pnpm-lock.yaml does not pin electron $version: run pnpm install"
pinned=$(node -p "const p = require('./package.json'); (p.devDependencies || {}).electron || (p.dependencies || {}).electron")
[ "$pinned" = "$version" ] || die "package.json asks for electron $pinned, node_modules has $version"
name="electron-v$version-darwin-$ARCH.zip"
expected=$(node -p "require('electron/checksums.json')['$name'] || ''")
[ -n "$expected" ] || die "electron $version's checksums.json has no $name"

work=$(mktemp -d /tmp/pod-electron-cache.XXXXXX)
remove=$(command -v pod-tmp-rm || echo "$HOME/.local/bin/pod-tmp-rm")
trap 'if [ -x "$remove" ]; then "$remove" "$work" > /dev/null || true; fi' EXIT
curl -fsSL --retry 5 --retry-all-errors --connect-timeout 20 --max-time 120 \
  -o "$work/SHASUMS256.txt" "$BASE_URL/v$version/SHASUMS256.txt" || die "cannot fetch Electron's SHASUMS256.txt"
published=$(awk -v f="*$name" '$2 == f { print $1 }' "$work/SHASUMS256.txt")
[ "$published" = "$expected" ] || die "$name: SHASUMS256.txt says '$published', checksums.json says $expected"

dir="$HOME/Library/Caches/electron/$(printf '%s' "$BASE_URL/v$version" | shasum -a 256 | cut -d' ' -f1)"
cached="$dir/$name"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
if [ ! -f "$cached" ] || [ "$(sha "$cached")" != "$expected" ]; then
  [ -f "$cached" ] && state="differs from $expected" || state="is missing"
  if [ "$fetch" = 1 ]; then
    curl -fL --retry 5 --retry-all-errors --connect-timeout 20 -o "$work/$name" "$BASE_URL/v$version/$name" ||
      die "cannot download $name"
    from="$work/$name"
  fi
  [ -n "$from" ] || die "$cached $state: run with --from <zip> or --fetch (RELEASE-RUNBOOK.md, step 0)"
  [ "$(sha "$from")" = "$expected" ] || die "$from is not $name ($expected)"
  mkdir -p "$dir"
  cp "$from" "$cached.partial"
  mv -f "$cached.partial" "$cached"
fi
echo "electron cache OK: $cached (sha256 $expected, as checksums.json and SHASUMS256.txt)"
