#!/bin/bash
# Builds, signs, notarizes and (optionally) publishes a product release described by
# product/identity.json: an arm64 DMG + zip, notarized and stapled, plus latest-mac.yml for the
# in-app updater. The same script runs locally and in .github/workflows/pod-release.yml.
#
#   product/release.sh <version> [--publish] [--skip-build]
#
#   <version>     semver without "v" (the git tag is v<version>)
#   --publish     create the GitHub release v<version> in identity.updateFeed's repo (needs gh auth)
#   --skip-build  reuse out/ and the native helpers from a previous run; package/notarize only
#
# Signing:      POD_SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" in the keychain.
# Notarization, one of:
#   NOTARY_PROFILE=<name>                      notarytool keychain profile (local; see RELEASING.md)
#   APPLE_API_KEY=<path .p8> APPLE_API_KEY_ID APPLE_API_ISSUER   App Store Connect API key (CI)
#   APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID           Apple ID (fallback)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() {
  printf '\033[31merror\033[0m %s\n' "$*" >&2
  exit 1
}

version=""
publish=0
skip_build=0
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) publish=1; shift ;;
    --skip-build) skip_build=1; shift ;;
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$version" ] || die "one version only"; version="${1#v}"; shift ;;
  esac
done
[ -n "$version" ] || die "usage: product/release.sh <version> [--publish]"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "version '$version' is not semver"
[ "$(uname -s)" = Darwin ] || die "macOS only"

identity() { node -p "require('./product/identity.json')$1"; }
display_name="$(identity .displayName)"
app_id="$(identity .appId)"
feed_repo="$(node -p "const f=require('./product/identity.json').updateFeed; f ? f.owner + '/' + f.repo : ''")"
arch=arm64

sign_identity="${POD_SIGN_IDENTITY:-${CSC_NAME:-}}"
[ -n "$sign_identity" ] || die "set POD_SIGN_IDENTITY to your \"Developer ID Application: …\" identity"
security find-identity -v -p codesigning | grep -Fq "\"$sign_identity\"" ||
  die "signing identity not in the keychain: $sign_identity"
case "$sign_identity" in
  "Developer ID Application:"*) ;;
  *) die "notarized releases need a Developer ID Application identity, not: $sign_identity" ;;
esac

notary_args=()
if [ -n "${NOTARY_PROFILE:-}" ]; then
  notary_args=(--keychain-profile "$NOTARY_PROFILE")
  export APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE"
elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  notary_args=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  die "no notarization credentials: set NOTARY_PROFILE, or APPLE_API_KEY(+_ID,+ISSUER), or APPLE_ID(+APPLE_APP_SPECIFIC_PASSWORD,+APPLE_TEAM_ID)"
fi

log "$display_name $version ($app_id, $arch), signed by $sign_identity"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
# Upstream's strict release signing for helpers and the bundle (hardened runtime, timestamps).
export ORCA_MAC_RELEASE=1
export CSC_NAME="$sign_identity"

if [ "$skip_build" -eq 0 ]; then
  log "install dependencies"
  pnpm install --frozen-lockfile
  (cd mobile && pnpm install --frozen-lockfile)
  log "build JavaScript, relay, CLI, web and mobile bundles"
  pnpm run build:desktop
  log "build native helpers with the product's identifiers"
  pnpm run build:ghostty-terminal-macos 2>/dev/null || log "no native terminal addon in this checkout"
  ORCA_COMPUTER_MACOS_BUNDLE_ID="$app_id.computer-use" pnpm run build:computer-macos
  pnpm run build:keyboard-layout-macos
  node config/scripts/build-notification-status-macos.mjs --bundle-id "$app_id"
  pnpm run ensure:electron-runtime
fi

log "package, sign and notarize the app (electron-builder staples it)"
rm -rf dist
POD_RELEASE=1 POD_VERSION="$version" POD_ARCH="$arch" \
  pnpm exec electron-builder --config product/electron-builder.pod.cjs --mac "--$arch" --publish never

app="dist/mac-$arch/$display_name.app"
dmg="dist/$display_name-$version-$arch.dmg"
zip="dist/$display_name-$version-$arch-mac.zip"
for f in "$app" "$dmg" "$zip" dist/latest-mac.yml; do [ -e "$f" ] || die "missing build output $f"; done

log "notarize and staple the DMG"
xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait
xcrun stapler staple "$dmg"
node product/scripts/refresh-latest-mac-yml.mjs dist

log "verify"
codesign --verify --deep --strict --verbose=2 "$app"
xcrun stapler validate "$app"
xcrun stapler validate "$dmg"
spctl --assess --type execute --verbose=2 "$app"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
[ -f "$app/Contents/Resources/product-identity.json" ] || die "app lacks product-identity.json"

if [ "$publish" -eq 1 ]; then
  [ -n "$feed_repo" ] || die "identity.updateFeed is null; nothing to publish to"
  log "publish GitHub release v$version to $feed_repo"
  assets=("$dmg" "$zip" dist/latest-mac.yml)
  [ -f "$zip.blockmap" ] && assets+=("$zip.blockmap")
  gh release create "v$version" "${assets[@]}" --repo "$feed_repo" \
    --title "$display_name $version" --notes "$display_name $version, built on Orca (MIT)."
fi
log "done: $dmg"
