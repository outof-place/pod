#!/usr/bin/env bash
# Disables every active GitHub Actions workflow Pod does not own and cancels their unfinished runs.
#
# Pod owns .github/workflows/upstream-sync.yml and .github/workflows/pod-*.yml; every other workflow
# came from Orca and needs Stably's secrets, and some deploy Stably's infrastructure. A workflow
# file that first appears in a push is registered as active and starts at once, so run this after
# every push that can bring new Orca workflows (main, sync/orca-*).
#
# Usage: scripts/pod-workflow-quarantine.sh [owner/repo]
# Needs gh and a token that can write Actions (GITHUB_TOKEN with `actions: write` is enough).
set -euo pipefail

repo=${1:-${GITHUB_REPOSITORY:-outof-place/pod}}
own='^\\.github/workflows/(upstream-sync|pod-[^/]+)\\.ya?ml$'
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

gh api "repos/$repo/actions/workflows" --paginate \
  --jq ".workflows[] | select(.state == \"active\") | select(.path | test(\"$own\") | not) | \"\(.id)\t\(.path)\"" |
  while IFS=$'\t' read -r id path; do
    gh api -X PUT "repos/$repo/actions/workflows/$id/disable"
    echo "Disabled $path" | tee -a "$summary"
  done

gh api "repos/$repo/actions/runs?per_page=100" \
  --jq ".workflow_runs[] | select(.status != \"completed\") | select(.path | test(\"$own\") | not) | \"\(.id)\t\(.path)\"" |
  while IFS=$'\t' read -r id path; do
    gh api -X POST "repos/$repo/actions/runs/$id/cancel" >/dev/null || true
    echo "Cancelled run $id of $path" | tee -a "$summary"
  done
