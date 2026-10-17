#!/bin/bash
# Installs this checkout's pod-gocache on this account through Pod's own install path
# (src/main/pod/gocache/pod-gocache-lifecycle.ts): the helper copied to ~/.pod/gocache/bin, proven
# to answer `version`, renamed into place, and the codes.pod.gocache launch agent written to
# ~/Library/LaunchAgents and (re)loaded in gui/<uid>. The build is a dev prerelease of build.sh's
# version: a Pod that bundles that version or newer replaces it at its next start, unless
# POD_GOCACHE=0 or the setting is off. It needs go on PATH: Pod installs nothing without it.
#
#   native/pod-gocache-macos/scripts/dev-install.sh [--dry-run] [--force]
#   native/pod-gocache-macos/scripts/dev-install.sh --uninstall [--purge] [--dry-run]
#
# --force replaces the installed helper whatever version it answers, still through a temp copy and
# a rename. --dry-run builds unsigned and changes nothing. --uninstall boots the agent out and
# deletes its plist; the helper stays, because open Pod terminals still name it in GOCACHEPROG and
# it works without the daemon. --purge deletes it too: go then fails in those terminals until they are reopened.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
LABEL=codes.pod.gocache
PLIST="${HOME:?}/Library/LaunchAgents/$LABEL.plist"
BIN_DIR="${HOME:?}/.pod/gocache/bin"

DRY= FORCE= UNINSTALL= PURGE=
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    *) echo "usage: dev-install.sh [--dry-run] [--force] | --uninstall [--purge] [--dry-run]" >&2; exit 64 ;;
  esac
done

# launchctl and the files must agree on whose account this is (acc-lifecycle.ts's HOME rule).
ACCOUNT_HOME=$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{ print $2 }')
if [[ "$(cd "$HOME" && pwd -P)" != "$(cd "$ACCOUNT_HOME" && pwd -P)" ]]; then
  echo "dev-install.sh: HOME $HOME is not the account home $ACCOUNT_HOME; refusing" >&2
  exit 4
fi

step() {
  if [[ -n "$DRY" ]]; then
    printf 'would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

if [[ -n "$UNINSTALL" ]]; then
  # 3 and 113: nothing loaded under the label
  step launchctl bootout "gui/$(id -u)/$LABEL" || { rc=$?; [[ $rc == 3 || $rc == 113 ]]; }
  step rm -f "$PLIST"
  if [[ -n "$PURGE" ]]; then
    step rm -rf "${BIN_DIR:?}"
  else
    echo "kept $BIN_DIR/pod-gocache: open Pod terminals still use it (--purge deletes it)"
  fi
  echo "Pod reinstalls the agent at its next start unless POD_GOCACHE=0, its setting is off, or launchctl disable gui/$(id -u)/$LABEL"
  exit 0
fi

BUILT=$(mktemp -d "${TMPDIR:-/tmp}/pod-gocache-dev.XXXXXX")
trap 'rm -rf "$BUILT"' EXIT
# Why unsigned under --dry-run: codesign may raise a keychain prompt.
SIGN=--sign
[[ -z "$DRY" ]] || { SIGN=; echo "would sign the build: build.sh --sign (codes.pod.gocache)"; }
"$HERE/build.sh" --dev ${SIGN:+"$SIGN"} --out "$BUILT/pod-gocache"
cd "$REPO"
# not exec: the EXIT trap removes the build once the lifecycle copied it
node_modules/.bin/tsx --conditions=orca-source "$HERE/dev-install-lifecycle.ts" \
  "$BUILT/pod-gocache" ${DRY:+--dry-run} ${FORCE:+--force}
