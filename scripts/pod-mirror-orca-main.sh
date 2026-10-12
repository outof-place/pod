#!/usr/bin/env bash
# Fast-forwards orca-main to Orca's main with plain git.
#
# outof-place/pod left Orca's fork network on 2026-10-12, so it no longer shares Orca's objects:
# the refs API can't point orca-main at a commit only Orca has ("Object does not exist", HTTP 422),
# and there is no fork to sync. The new commits are fetched from Orca and pushed instead.
#
# Only the history since orca-main is fetched: Orca's main, shallow, deepened (200, 2000, 20000
# commits, then all) until orca-main's commit is in it and every new commit's parents are too (an
# Orca branch merged since can reach far back). By depth, not by date: git 2.56 lists a merge's
# cut-off parent as shallow without sending it under --shallow-since, and deepening then fails
# ("error in object: unshallow"). The push is a plain one, never forced: a commit on orca-main that
# Orca doesn't have makes the run fail instead of being overwritten.
#
# Usage: scripts/pod-mirror-orca-main.sh
#   CI: GH_TOKEN pushes (it needs Contents and Workflows write: Orca's commits change workflows);
#   GITHUB_REPOSITORY, UPSTREAM_REPO and MIRROR_BRANCH name the repos and the branch.
#   POD_MIRROR_DRY_RUN=1 does everything but the push and needs no token.
#   POD_MIRROR_ORIGIN_URL / POD_MIRROR_UPSTREAM_URL replace the GitHub URLs (tests).
set -euo pipefail

upstream_url=${POD_MIRROR_UPSTREAM_URL:-https://github.com/${UPSTREAM_REPO:?}.git}
origin_url=${POD_MIRROR_ORIGIN_URL:-https://github.com/${GITHUB_REPOSITORY:?}.git}
branch=${MIRROR_BRANCH:?}
dry_run=${POD_MIRROR_DRY_RUN:-}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

if [ -z "$dry_run" ] && [ -z "${GH_TOKEN:-}" ]; then
  echo "::error::POD_SYNC_TOKEN is not set. See CONTRIBUTING.md, section 'Maintainers: the sync token'."
  exit 1
fi

current=$(git ls-remote "$origin_url" "refs/heads/$branch" | cut -f1)
upstream=$(git ls-remote "$upstream_url" refs/heads/main | cut -f1)
if [ -z "$upstream" ]; then
  echo "::error::$upstream_url has no main"
  exit 1
fi
if [ "$current" = "$upstream" ]; then
  echo "$branch is at $upstream" | tee -a "$summary"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export GIT_DIR=$work/repo
git init -q --bare "$GIT_DIR"

fetch() {
  git fetch -q --no-tags "$@" "$upstream_url" "+refs/heads/main:refs/mirror/upstream"
}

# Whether the fetched history holds orca-main and every new commit's parents.
complete() {
  git cat-file -e "$current^{commit}" 2>/dev/null || return 1
  git merge-base --is-ancestor "$current" refs/mirror/upstream || return 1
  [ -s "$GIT_DIR/shallow" ] || return 0
  # Not grep -q: under pipefail, rev-list's SIGPIPE would read as "no cut-off commit".
  [ -z "$(git rev-list refs/mirror/upstream "^$current" | grep -Fx -f "$GIT_DIR/shallow" || true)" ]
}

if [ -z "$current" ]; then
  # A new branch: all of Orca's history.
  fetch
else
  ready=
  for depth in 200 2000 20000; do
    fetch --depth="$depth"
    if complete; then
      echo "Orca's main fetched to depth $depth"
      ready=1
      break
    fi
    # All of it already: deepening can't help.
    [ -s "$GIT_DIR/shallow" ] || break
  done
  if [ -z "$ready" ]; then
    if [ -s "$GIT_DIR/shallow" ]; then
      fetch --unshallow
      echo "Orca's main fetched whole"
    fi
    if ! complete; then
      echo "::error::$branch ($current) is not an ancestor of Orca's main: it has commits Orca doesn't. Not overwriting it."
      exit 1
    fi
  fi
fi

target=$(git rev-parse refs/mirror/upstream)
if [ -n "$current" ]; then
  count=$(git rev-list --count "$target" "^$current")
else
  count=$(git rev-list --count "$target")
fi
if [ -n "$dry_run" ]; then
  echo "Dry run: would fast-forward $branch from ${current:-nothing} to $target ($count commits)" | tee -a "$summary"
  exit 0
fi

# The token reaches only this push, through the environment (not argv, not a remote URL).
auth=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')
echo "::add-mask::$auth"
GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader \
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth" \
  git push -q "$origin_url" "$target:refs/heads/$branch"
echo "$branch is at $target ($count new commits)" | tee -a "$summary"
