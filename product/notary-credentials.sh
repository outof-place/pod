# Sourced by product/release.sh and product/assemble-one-app.sh. pod_notary_credentials <default
# profile> picks the notarization credentials, fills the `notary_args` array for notarytool and
# leaves electron-builder's variables for the same set; pod_notary_preflight then checks the
# keychain and those credentials before anything is built. The first set present wins:
#   NOTARY_PROFILE=<name>                                   notarytool keychain profile
#   APPLE_API_KEY=<.p8> APPLE_API_KEY_ID APPLE_API_ISSUER   App Store Connect API key
#   APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID      Apple ID
#   ~/.appstoreconnect: private_keys/AuthKey_<key id>.p8 and `issuer`, the local default
#   the default profile, when that directory holds neither
# Why the key on disk first: the pod-notary keychain item vanished twice (2026-10-10 and 10-11).

# The account's home from the user database: shells with an overridden HOME (schedulers, E2E
# profiles) once made the credentials look gone.
# Empty when there is no user database (Linux CI) or dscl fails; callers fall back to HOME. Why `|| true`:
# under errexit and pipefail a failing dscl would end the sourcing script without a word.
pod_account_home() {
  dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p' || true
}

pod_notary_credentials() {
  local default_profile="$1" asc keys issuer home
  if [ -z "${NOTARY_PROFILE:-}${APPLE_API_KEY:-}${APPLE_ID:-}" ]; then
    home="$(pod_account_home)"
    asc="${POD_APPSTORECONNECT_DIR:-${home:-$HOME}/.appstoreconnect}"
    keys=("$asc"/private_keys/AuthKey_*.p8)
    if [ -s "$asc/issuer" ] && [ "${#keys[@]}" -eq 1 ] && [ -f "${keys[0]}" ]; then
      issuer="$(tr -d '[:space:]' < "$asc/issuer")"
      [[ "$issuer" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]] ||
        die "$asc/issuer is not an App Store Connect issuer id"
      APPLE_API_KEY_ID="${keys[0]##*/AuthKey_}"
      export APPLE_API_KEY="${keys[0]}" APPLE_API_KEY_ID="${APPLE_API_KEY_ID%.p8}"
      export APPLE_API_ISSUER="$issuer"
    else
      NOTARY_PROFILE="$default_profile"
    fi
  fi
  notary_args=()
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    notary_args=(--keychain-profile "$NOTARY_PROFILE")
    export APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE"
    # electron-builder prefers Apple ID and API-key variables over the profile.
    unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
  elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    [ -f "$APPLE_API_KEY" ] || die "APPLE_API_KEY $APPLE_API_KEY does not exist"
    notary_args=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
    export APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
    unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_KEYCHAIN_PROFILE
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
  else
    die "no notarization credentials: set NOTARY_PROFILE, or APPLE_API_KEY(+_ID,+ISSUER), or APPLE_ID(+APPLE_APP_SPECIFIC_PASSWORD,+APPLE_TEAM_ID), or put the key and issuer in ~/.appstoreconnect"
  fi
}

# What the user's keychain setup and environment look like, for a failed preflight.
pod_notary_diagnostics() {
  {
    echo "notarization diagnostics:"
    echo "  default-keychain -d user: $(security default-keychain -d user 2>&1 | tr -s ' ')"
    echo "  list-keychains -d user:"
    security list-keychains -d user 2>&1 | sed 's/^/  /'
    echo "  environment:"
    env | grep -E 'HOME|CFFIXED' | sed 's/^/    /' || true
  } >&2
}

# Before anything is built: codesign must find the user's login keychain, and notarytool must
# accept exactly the credentials pod_notary_credentials picked (one read-only history call).
pod_notary_preflight() {
  local home expected actual err
  home="$(pod_account_home)"
  expected="${home:-$HOME}/Library/Keychains/login.keychain-db"
  actual="$(security default-keychain -d user 2>/dev/null | sed -n 's/^[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p')"
  echo "default keychain: ${actual:-unknown}"
  if [ "$actual" != "$expected" ]; then
    pod_notary_diagnostics
    die "the default keychain is ${actual:-unknown}, not $expected"
  fi
  err="$(mktemp)"
  if ! xcrun notarytool history "${notary_args[@]}" >/dev/null 2>"$err"; then
    sed 's/^/  notarytool: /' "$err" >&2
    rm -f "$err"
    pod_notary_diagnostics
    die "notarytool history failed with the chosen credentials"
  fi
  rm -f "$err"
  echo "notarization credentials: notarytool history OK"
}
