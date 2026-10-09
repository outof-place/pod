#!/usr/bin/env bash
# Picks and describes the Orca commit Pod builds on.
#
#   pod-orca-base.sh green [owner/repo] [branch]
#       Prints the newest commit on Orca's main whose GitHub Actions checks all passed: at least
#       one github-actions check suite, every one of them completed, and every check run concluded
#       success, skipped or neutral. A queued workflow shows up as a queued suite, so a commit
#       whose slower workflows have not started is not green. Other apps' suites never complete
#       on Orca, so they are ignored. Needs gh.
#   pod-orca-base.sh pin <commit> [tags-prefix] [main-ref]
#       Prints upstream.json for <commit>: {ref, nearestTag, date}.
#   pod-orca-base.sh describe <commit> [tags-prefix] [main-ref]
#       Prints a label such as v1.4.223+289.
#
# nearestTag is the newest stable Orca release whose branch point <commit> contains. Orca tags sit
# on release branches, so `git describe` never finds them from main. tags-prefix holds Orca's
# tags (default refs/pod-stack/orca-tags/) and main-ref is Orca's main (default
# refs/remotes/upstream/main).
set -euo pipefail

die() {
  printf 'pod-orca-base: %s\n' "$*" >&2
  exit 1
}

gh_retry() {
  local attempt
  for attempt in 1 2 3; do
    if gh "$@"; then return 0; fi
    [ "$attempt" -lt 3 ] && sleep 5
  done
  return 1
}

# Counts lines that are not "completed success|skipped|neutral".
count_unfinished() {
  printf '%s\n' "$1" | grep -cvE '^completed (success|skipped|neutral)$' || true
}

green() {
  local repo=${1:-stablyai/orca} branch=${2:-main} sha suites runs
  for sha in $(gh_retry api "repos/$repo/commits?sha=$branch&per_page=40" --jq '.[].sha'); do
    suites=$(gh_retry api --paginate "repos/$repo/commits/$sha/check-suites?per_page=100" \
      --jq '.check_suites[] | select(.app.slug == "github-actions") | "\(.status) \(.conclusion)"')
    if [ -z "$suites" ] || [ "$(count_unfinished "$suites")" != 0 ]; then
      printf '%s not green: %s\n' "${sha:0:10}" "$(printf '%s\n' "$suites" | sort | uniq -c | xargs)" >&2
      continue
    fi
    runs=$(gh_retry api --paginate "repos/$repo/commits/$sha/check-runs?per_page=100" \
      --jq '.check_runs[] | "\(.status) \(.conclusion)"')
    if [ "$(count_unfinished "$runs")" != 0 ]; then
      printf '%s not green: %s\n' "${sha:0:10}" "$(printf '%s\n' "$runs" | sort | uniq -c | xargs)" >&2
      continue
    fi
    printf '%s green: %d check runs\n' "${sha:0:10}" "$(printf '%s\n' "$runs" | grep -c .)" >&2
    printf '%s\n' "$sha"
    return 0
  done
  die "no green commit among the last 40 on $repo $branch"
}

# Sets nearest_tag, nearest_ref and nearest_fork for a commit.
nearest() {
  local commit=$1 prefix=$2 main=$3 ref name fork
  nearest_tag='' nearest_ref='' nearest_fork=''
  git rev-parse --verify --quiet "$main^{commit}" >/dev/null || die "$main not found; fetch Orca's main"
  for ref in $(git for-each-ref --sort=-v:refname --format='%(refname)' "$prefix"); do
    name=${ref#"$prefix"}
    [[ $name =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    fork=$(git merge-base "$ref" "$main") || continue
    if git merge-base --is-ancestor "$fork" "$commit"; then
      nearest_tag=$name nearest_ref=$ref nearest_fork=$fork
      return 0
    fi
  done
}

cmd=${1:-}
case $cmd in
  green)
    shift
    green "$@"
    ;;
  pin|describe)
    [ $# -ge 2 ] || die "usage: $0 $cmd <commit> [tags-prefix] [main-ref]"
    commit=$(git rev-parse --verify --quiet "$2^{commit}") || die "commit $2 not found"
    nearest "$commit" "${3:-refs/pod-stack/orca-tags/}" "${4:-refs/remotes/upstream/main}"
    if [ "$cmd" = pin ]; then
      date=$(TZ=UTC0 git log -1 --date=iso-strict-local --format=%cd "$commit")
      printf '{\n  "ref": "%s",\n  "nearestTag": "%s",\n  "date": "%s"\n}\n' "$commit" "$nearest_tag" "$date"
    elif [ -z "$nearest_tag" ]; then
      git rev-parse --short "$commit"
    elif [ "$(git rev-parse "$nearest_ref^{commit}")" = "$commit" ]; then
      printf '%s\n' "$nearest_tag"
    else
      printf '%s+%s\n' "$nearest_tag" "$(git rev-list --count "$nearest_fork..$commit")"
    fi
    ;;
  *)
    die "usage: $0 green [owner/repo] [branch] | pin <commit> [tags-prefix] [main-ref] | describe <commit> [tags-prefix] [main-ref]"
    ;;
esac
