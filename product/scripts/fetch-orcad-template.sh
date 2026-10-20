#!/bin/bash
# Puts the orcad deployment template (design D2) into out/orcad-template, which electron-builder
# packs into Contents/Resources/orcad-template: SSH relays deploy a remote host's slot from it. It
# comes from the pod-orcad-template run (.github/workflows/pod-orcad-template.yml) on this checkout's
# commit: the run must be that workflow's, successful and on HEAD, and the download must read
# `pod <HEAD>` / `run <id>` and match its SHA256SUMS (config/scripts/pod-orcad-template-provenance.mjs).
#
#   product/scripts/fetch-orcad-template.sh [--run <id>]
#
# Without --run it takes the template already in out/ (checked again), else the newest successful
# run on HEAD. Start one while a ref points at HEAD (main, stack/cand-<n> or the tag):
#   gh workflow run pod-orcad-template.yml -R outof-place/pod --ref <ref>
# It never deletes: a template from another commit or run stops it until someone moves it away.
set -euo pipefail

REPO=outof-place/pod
WORKFLOW=pod-orcad-template.yml
ARTIFACT=pod-orcad-template

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
die() {
  printf '\033[31merror\033[0m fetch-orcad-template: %s\n' "$*" >&2
  exit 1
}

run=""
case "${1:-}" in
  --run) run="${2:-}"; [ $# -eq 2 ] || die "usage: product/scripts/fetch-orcad-template.sh [--run <id>]" ;;
  "") ;;
  *) die "usage: product/scripts/fetch-orcad-template.sh [--run <id>]" ;;
esac
head=$(git rev-parse HEAD)
paths=(out/orcad-template out/orcad-template.source out/orcad-template.SHA256SUMS)
present=0
for path in "${paths[@]}"; do
  if [ -e "$path" ]; then present=$((present + 1)); fi
done
[ "$present" -eq 0 ] || [ "$present" -eq 3 ] ||
  die "out/ holds part of an orcad template: move ${paths[*]} away first"

if [ -z "$run" ] && [ "$present" -eq 3 ]; then
  run=$(sed -n 's/^run \([1-9][0-9]*\)$/\1/p' out/orcad-template.source)
fi
if [ -z "$run" ]; then
  run=$(gh run list -R "$REPO" --workflow "$WORKFLOW" --commit "$head" --status success --limit 1 \
    --json databaseId --jq '.[0].databaseId // empty')
  [ -n "$run" ] || die "no successful $WORKFLOW run on $head; start one: gh workflow run $WORKFLOW -R $REPO --ref <a ref at $head>"
fi
[[ "$run" =~ ^[1-9][0-9]*$ ]] || die "run id '$run' is not a number"

# The run's own record, before any of its bytes: this workflow, finished green, on this commit.
view=$(gh run view "$run" -R "$REPO" --json headSha,status,conclusion,workflowName \
  --jq '[.headSha, .status, .conclusion, .workflowName] | join(" ")')
[ "$view" = "$head completed success pod-orcad-template" ] ||
  die "run $run is not a successful pod-orcad-template run on $head: $view"

if [ "$present" -eq 0 ]; then
  mkdir -p out
  gh run download "$run" -R "$REPO" -n "$ARTIFACT" -D out
fi
node config/scripts/pod-orcad-template-provenance.mjs check-template out "$head" "$run" ||
  die "out/orcad-template is not run $run's template for $head (above): move ${paths[*]} away and rerun"
printf 'orcad template: run %s, pod %s\n' "$run" "$head"
