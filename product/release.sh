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
# Signing:      POD_SIGN_IDENTITY (default: outofplace's Developer ID, whose key lives only in
#               this Mac's login keychain; CI imports its own certificate).
# Notarization, one of (default: NOTARY_PROFILE=pod-notary):
#   NOTARY_PROFILE=<name>                      notarytool keychain profile (local; see RELEASING.md)
#   APPLE_API_KEY=<path .p8> APPLE_API_KEY_ID APPLE_API_ISSUER   App Store Connect API key (CI)
#   APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID           Apple ID (fallback)
set -euo pipefail

DEFAULT_SIGN_IDENTITY="Developer ID Application: OUTOFPLACE POLAND SP. Z O.O (75Y2KR6P5W)"
DEFAULT_NOTARY_PROFILE=pod-notary

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
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$version" ] || die "one version only"; version="${1#v}"; shift ;;
  esac
done
[ -n "$version" ] || die "usage: product/release.sh <version> [--publish]"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "version '$version' is not semver"
[ "$(uname -s)" = Darwin ] || die "macOS only"

identity() { node -p "require('./product/identity.json')$1"; }
has_script() { node -e "process.exit(require('./package.json').scripts['$1'] ? 0 : 1)"; }
display_name="$(identity .displayName)"
app_id="$(identity .appId)"
feed_repo="$(node -p "const f=require('./product/identity.json').updateFeed; f ? f.owner + '/' + f.repo : ''")"
arch=arm64

sign_identity="${POD_SIGN_IDENTITY:-${CSC_NAME:-$DEFAULT_SIGN_IDENTITY}}"
identities="$(security find-identity -v -p codesigning)"
grep -Fq "\"$sign_identity\"" <<<"$identities" || die "signing identity not in the keychain: $sign_identity"
case "$sign_identity" in
  "Developer ID Application:"*) ;;
  *) die "notarized releases need a Developer ID Application identity, not: $sign_identity" ;;
esac
team_id="${sign_identity##*(}"
team_id="${team_id%)}"

if [ -z "${NOTARY_PROFILE:-}${APPLE_API_KEY:-}${APPLE_ID:-}" ]; then
  NOTARY_PROFILE="$DEFAULT_NOTARY_PROFILE"
fi
notary_args=()
if [ -n "${NOTARY_PROFILE:-}" ]; then
  notary_args=(--keychain-profile "$NOTARY_PROFILE")
  export APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE"
  # electron-builder prefers Apple ID and API-key variables over the profile.
  unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  notary_args=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  die "no notarization credentials: set NOTARY_PROFILE, or APPLE_API_KEY(+_ID,+ISSUER), or APPLE_ID(+APPLE_APP_SPECIFIC_PASSWORD,+APPLE_TEAM_ID)"
fi

# Apple's timestamp service fails now and then mid-signing ("The timestamp service is not
# available", "A timestamp was expected but was not found"). Reruns only that failure: 3 attempts,
# 3 min apart; anything else fails at once.
with_timestamp_retry() {
  local attempt status output
  for attempt in 1 2 3; do
    output="$(mktemp)"
    status=0
    "$@" 2>&1 | tee "$output" || status=${PIPESTATUS[0]}
    if [ "$status" -eq 0 ]; then
      rm -f "$output"
      return 0
    fi
    if [ "$attempt" -eq 3 ] || ! grep -qi 'timestamp' "$output"; then
      rm -f "$output"
      return "$status"
    fi
    rm -f "$output"
    log "Apple's timestamp service failed (attempt $attempt of 3); retrying in 3 min"
    sleep 180
  done
}

# Fails fast (instead of hanging mid-build) when the key's ACL would raise a keychain prompt.
preflight_sign() {
  local dir status=0
  dir="$(mktemp -d)"
  cp /usr/bin/true "$dir/pod-sign-probe"
  perl -e 'alarm 60; exec @ARGV' codesign --force --options runtime --timestamp \
    --sign "$sign_identity" "$dir/pod-sign-probe" >/dev/null 2>&1 || status=$?
  rm -rf "$dir"
  [ "$status" -eq 0 ] && return 0
  [ "$status" -eq 142 ] &&
    die "codesign waited 60 s, most likely on a keychain prompt: allow access to the key (Always Allow), then rerun"
  die "test signature with $sign_identity failed (exit $status)"
}

log "$display_name $version ($app_id, $arch), signed by $sign_identity"
log "test signature (keychain access, timestamp server)"
preflight_sign
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
# Upstream's strict release signing for helpers and the bundle (hardened runtime, timestamps).
export ORCA_MAC_RELEASE=1
# electron-builder wants the name without the certificate-type prefix; codesign matches either.
export CSC_NAME="${sign_identity#Developer ID Application: }"

if [ "$skip_build" -eq 0 ]; then
  log "install dependencies"
  pnpm install --frozen-lockfile
  (cd mobile && pnpm install --frozen-lockfile)
  log "build JavaScript, relay, CLI, web and mobile bundles"
  pnpm run build:desktop
  log "build native helpers with the product's identifiers"
  ORCA_COMPUTER_MACOS_BUNDLE_ID="$app_id.computer-use" pnpm run build:computer-macos
  pnpm run build:keyboard-layout-macos
  node config/scripts/build-notification-status-macos.mjs --bundle-id "$app_id"
  # Helpers that only some stacks carry (native terminal, proc-info): build each one the checkout
  # has, and fail if it fails, so a release never silently ships without it.
  for script in build:ghostty-terminal-macos build:proc-info-macos; do
    if has_script "$script"; then
      pnpm run "$script"
    else
      log "no $script in this checkout"
    fi
  done
  pnpm run ensure:electron-runtime
fi

# claude-acc payload, once the pod/acc branch is in the stack; a no-op when already fetched.
if [ -f config/scripts/fetch-claude-acc-payload.mjs ]; then
  log "fetch the claude-acc payload pinned in config/claude-acc-payload.json"
  node config/scripts/fetch-claude-acc-payload.mjs
fi
# the Python that runs it (claude-acc phase 2), pinned in config/pod-python.json; also a no-op then.
if [ -f config/scripts/fetch-pod-python.mjs ]; then
  log "fetch the Python pinned in config/pod-python.json"
  node config/scripts/fetch-pod-python.mjs
fi
# pod-hookd (pod/hookd branch), built from the private fasthooks tag in native/pod-hookd/pin.json
# with gh's credentials; cached per commit. Required locally, where gh auth is; CI has no access
# and ships without it (no hookd, no agent).
if [ -f native/pod-hookd/build.mjs ]; then
  [ -n "${GITHUB_ACTIONS:-}" ] || export POD_REQUIRE_HOOKD="${POD_REQUIRE_HOOKD:-1}"
  log "build pod-hookd pinned in native/pod-hookd/pin.json (required: ${POD_REQUIRE_HOOKD:-0})"
  POD_ARCH="$arch" node native/pod-hookd/build.mjs
fi

log "package, sign and notarize the app (electron-builder staples it)"
rm -rf dist
POD_RELEASE=1 POD_VERSION="$version" POD_ARCH="$arch" with_timestamp_retry \
  pnpm exec electron-builder --config product/electron-builder.pod.cjs --mac "--$arch" --publish never

app="dist/mac-$arch/$display_name.app"
dmg="dist/$display_name-$version-$arch.dmg"
zip="dist/$display_name-$version-$arch-mac.zip"
for f in "$app" "$dmg" "$zip" dist/latest-mac.yml; do [ -e "$f" ] || die "missing build output $f"; done

node product/release-bundle-gate.cjs --dmg "$dmg"

log "notarize and staple the DMG"
xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait
xcrun stapler staple "$dmg"
node product/scripts/refresh-latest-mac-yml.mjs dist

log "verify (Gatekeeper gate)"
codesign --verify --deep --strict --verbose=2 "$app"
signature="$(codesign -dv "$app" 2>&1)"
grep -Fqx "TeamIdentifier=$team_id" <<<"$signature" || die "$app is not signed by team $team_id"
xcrun stapler validate "$app"
xcrun stapler validate "$dmg"
gatekeeper="$(spctl -a -vv "$app" 2>&1)" || die "spctl rejected $app: $gatekeeper"
printf '%s\n' "$gatekeeper"
grep -Fq "source=Notarized Developer ID" <<<"$gatekeeper" || die "$app is not notarized: $gatekeeper"
spctl -a -vv -t open --context context:primary-signature "$dmg"
[ -f "$app/Contents/Resources/product-identity.json" ] || die "app lacks product-identity.json"
node product/scripts/verify-claude-acc-host.mjs "$app"

if [ "$publish" -eq 1 ]; then
  [ -n "$feed_repo" ] || die "identity.updateFeed is null; nothing to publish to"
  log "publish GitHub release v$version to $feed_repo"
  assets=("$dmg" "$zip" dist/latest-mac.yml)
  [ -f "$zip.blockmap" ] && assets+=("$zip.blockmap")
  gh release create "v$version" "${assets[@]}" --repo "$feed_repo" \
    --title "$display_name $version" --notes "$display_name $version, built on Orca (MIT)."
fi
log "done: $dmg"
