#!/usr/bin/env bash
# Assembles the Pod product branch from pod-stack.json.
#
# Each manifest entry names a topic branch. Its own commits (not on Orca main, not on an Orca
# release branch) are replayed in manifest order onto the Orca base commit, and every replayed
# commit gets the entry's `Upstream: <PR url>` or `Fork-only: <reason>` trailer. Commits are
# built with `git merge-tree` and `git commit-tree`, so no working tree is touched and a dry
# run is a complete assembly that only skips the final ref update.
#
# A commit whose patch is already stacked is skipped, so a topic branch built on an older copy of
# an earlier entry needs no rebase when that entry is rewritten. A rewritten copy (same author,
# date and subject) whose change differs stops the run instead.
#
# After stacking, every entry is checked against its branch: a pinned "ref" must contain the branch
# tip, and a copy's "source" branch must have every commit in the result, by author, date and
# subject or by patch id. A miss fails the run.
#
# Exit codes: 0 done, 1 usage or environment error, 2 conflict or stale copy, 3 would drop commits,
# 4 a listed branch is not fully in the result.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/pod-stack.sh [options]

Builds the product branch from pod-stack.json onto an Orca commit. Dry run by default.

Options:
  --manifest PATH         manifest (default: pod-stack.json at the repository root)
  --onto REV              Orca commit to build on: a sha, an Orca tag or a ref
                          (default: "ref" in upstream.json)
  --green                 build on the newest Orca main commit whose GitHub Actions checks all
                          passed (scripts/pod-orca-base.sh green; needs gh)
  --branch NAME           product branch to build (default: manifest "branch", else "main")
  --source origin|local   read topic branches from origin/<name> or local <name> (default: origin;
                          a branch that is only local is used with a note)
  --upstream-remote NAME  remote that points at stablyai/orca (default: detected)
  --no-fetch              do not fetch origin and the upstream remote first
  --apply                 move the local product branch to the result (old tip kept under refs/pod-stack/backup/)
  --push                  --apply, then push to origin with --force-with-lease and run
                          scripts/pod-workflow-quarantine.sh (needs gh)
  --allow-drop            apply even when the current branch has commits the result lacks
  -h, --help              show this help

Manifest:
  {
    "branch": "main",
    "stack": [
      { "branch": "pod/infra", "forkOnly": "why this never goes upstream" },
      { "branch": "feat/native-ghostty-terminal", "upstream": "https://github.com/stablyai/orca/pull/26914" },
      { "branch": "some/topic", "upstream": "https://github.com/stablyai/orca/pull/1", "base": "<ref>" }
    ]
  }
  Each entry needs exactly one of "upstream" or "forkOnly". "base" is optional: a ref, or a list
  of refs, whose commits are excluded, for a topic branch cut from something other than Orca main.
  "ref" is optional: a commit to stack instead of the branch tip, to pin a snapshot.
  "hold" (a reason) marks a "ref" kept behind its branch on purpose: the coverage check reports it
  instead of failing.
  "source" names the branch a stack/* copy was replayed from; "sourceSince" (a commit) limits the
  check to the source commits after it, for a copy that squashed the earlier ones.
  "squash": true stacks the branch as one commit, its net change since the Orca main it last
  merged. Use it for a pull request branch that maintainers update by merging Orca main into it:
  the merges hold conflict resolutions that a commit-by-commit replay would lose.
  "note" is free text for people and is ignored.

Commits are deduplicated by patch id against everything stacked so far. A topic branch that
still carries an older copy of an earlier entry's commits replays only its own commits. If an old
copy differs in content from the stacked commit (same author, date and subject), the run stops
with exit code 2 and names the files, and nothing is resolved for you.
EOF
}

die() {
  printf 'pod-stack: %s\n' "$*" >&2
  exit 1
}

manifest=''
onto=''
green=0
branch=''
source_kind=origin
upstream_remote=''
fetch=1
apply=0
push=0
allow_drop=0

while [ $# -gt 0 ]; do
  case $1 in
    --manifest) manifest=${2:?--manifest needs a path}; shift 2 ;;
    --onto) onto=${2:?--onto needs a commit}; shift 2 ;;
    --green) green=1; shift ;;
    --branch) branch=${2:?--branch needs a name}; shift 2 ;;
    --source) source_kind=${2:?--source needs origin or local}; shift 2 ;;
    --upstream-remote) upstream_remote=${2:?--upstream-remote needs a name}; shift 2 ;;
    --no-fetch) fetch=0; shift ;;
    --apply) apply=1; shift ;;
    --push) apply=1; push=1; shift ;;
    --allow-drop) allow_drop=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

case $source_kind in origin|local) ;; *) die "--source must be origin or local" ;; esac
command -v node >/dev/null 2>&1 || die "node is required to read the manifest"

# merge-tree --write-tree --merge-base needs Git 2.40.
git_version=$(git version | sed -E 's/^git version ([0-9]+)\.([0-9]+).*/\1 \2/')
read -r git_major git_minor <<<"$git_version"
if [ "$git_major" -lt 2 ] || { [ "$git_major" -eq 2 ] && [ "$git_minor" -lt 40 ]; }; then
  die "Git 2.40 or newer is required (found $(git version))"
fi

root=$(git rev-parse --show-toplevel)
manifest=${manifest:-$root/pod-stack.json}
[ -f "$manifest" ] || die "no manifest at $manifest (run from a checkout of main or pod/infra, or pass --manifest)"

if [ -z "$upstream_remote" ]; then
  for remote in $(git remote); do
    if git remote get-url "$remote" | grep -Eq 'github\.com[:/]stablyai/orca(\.git)?$'; then
      upstream_remote=$remote
      break
    fi
  done
  [ -n "$upstream_remote" ] || die "no remote points at stablyai/orca; add one or pass --upstream-remote"
fi

# One entry per line: branch, trailer key, trailer value, base. Validation happens here.
entries=$(node -e '
const fs = require("fs")
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const fail = (msg) => { console.error("pod-stack: " + msg); process.exit(1) }
if (!Array.isArray(m.stack) || m.stack.length === 0) fail("manifest needs a non-empty \"stack\" array")
const lines = [m.branch || ""]
m.stack.forEach((e, i) => {
  const where = "stack[" + i + "]"
  if (typeof e.branch !== "string" || !e.branch) fail(where + " needs a \"branch\"")
  const hasUp = typeof e.upstream === "string" && e.upstream !== ""
  const hasFork = typeof e.forkOnly === "string" && e.forkOnly !== ""
  if (hasUp === hasFork) fail(where + " (" + e.branch + ") needs exactly one of \"upstream\" or \"forkOnly\"")
  if (hasUp && !/^https:\/\/github\.com\/stablyai\/orca\/pull\/\d+$/.test(e.upstream))
    fail(where + " (" + e.branch + "): \"upstream\" must be a stablyai/orca pull request URL")
  const value = hasUp ? e.upstream : e.forkOnly
  const bases = e.base === undefined ? [] : Array.isArray(e.base) ? e.base : [e.base]
  if (bases.some((b) => typeof b !== "string" || !b || /\s/.test(b))) fail(where + " (" + e.branch + "): \"base\" must be a ref or a list of refs")
  if (e.ref !== undefined && (typeof e.ref !== "string" || !e.ref || /\s/.test(e.ref))) fail(where + " (" + e.branch + "): \"ref\" must be a commit")
  if (e.squash !== undefined && typeof e.squash !== "boolean") fail(where + " (" + e.branch + "): \"squash\" must be true or false")
  for (const k of ["source", "sourceSince"]) if (e[k] !== undefined && (typeof e[k] !== "string" || !e[k] || /\s/.test(e[k]))) fail(where + " (" + e.branch + "): \"" + k + "\" must be a ref")
  if (e.hold !== undefined && (typeof e.hold !== "string" || !e.hold || /[\t\n]/.test(e.hold) || e.ref === undefined)) fail(where + " (" + e.branch + "): \"hold\" needs a reason and a \"ref\"")
  if (e.sourceSince !== undefined && e.source === undefined) fail(where + " (" + e.branch + "): \"sourceSince\" needs \"source\"")
  if (/[\t\n]/.test(value + e.branch)) fail(where + " contains a tab or newline")
  lines.push([e.branch, hasUp ? "Upstream" : "Fork-only", value, bases.join(" ") || "-", e.ref || "-", e.squash ? "squash" : "-", e.source || "-", e.sourceSince || "-", e.hold || "-"].join("\t"))
})
console.log(lines.join("\n"))
' "$manifest")

manifest_branch=$(printf '%s\n' "$entries" | head -n 1)
entries=$(printf '%s\n' "$entries" | tail -n +2)
branch=${branch:-${manifest_branch:-main}}

base_script=$root/scripts/pod-orca-base.sh
[ -f "$base_script" ] || die "no $base_script (run from a checkout of main or pod/infra)"
[ -n "$onto" ] && [ "$green" -eq 1 ] && die "pass --onto or --green, not both"

if [ "$fetch" -eq 1 ]; then
  printf 'Fetching origin and %s...\n' "$upstream_remote"
  git fetch --quiet origin
  # Orca's release tags go to a private namespace so Pod's own tags never count as Orca's.
  git fetch --quiet --no-tags "$upstream_remote" \
    "+refs/heads/main:refs/remotes/$upstream_remote/main" "+refs/tags/v*:refs/pod-stack/orca-tags/v*"
fi

upstream_main=$(git rev-parse --verify --quiet "refs/remotes/$upstream_remote/main") \
  || die "refs/remotes/$upstream_remote/main not found; fetch $upstream_remote"

if [ "$green" -eq 1 ]; then
  upstream_repo=$(git remote get-url "$upstream_remote" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')
  onto=$(bash "$base_script" green "$upstream_repo") || die "could not find a green Orca main commit"
  git cat-file -e "$onto^{commit}" 2>/dev/null || die "green commit $onto is newer than the fetched Orca main; fetch again"
elif [ -z "$onto" ]; then
  [ -f "$root/upstream.json" ] || die "no upstream.json at $root; pass --onto or --green"
  onto=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(p.ref || p.sha || "")' "$root/upstream.json")
  [ -n "$onto" ] || die "upstream.json has no \"ref\""
fi
base_sha=$(git rev-parse --verify --quiet "$onto^{commit}" || git rev-parse --verify --quiet "refs/pod-stack/orca-tags/$onto^{commit}") \
  || die "Orca commit $onto not found (fetch $upstream_remote)"
git merge-base --is-ancestor "$base_sha" "$upstream_main" \
  || printf 'Note: %s is not on Orca main (a release tag?).\n' "$onto" >&2
base_label=$(bash "$base_script" describe "$base_sha" refs/pod-stack/orca-tags/ "refs/remotes/$upstream_remote/main")
# Topic branches cut from a release tag carry that release branch's commits; every Orca tag excludes them.
orca_tags=$(git for-each-ref --format='%(refname)' 'refs/pod-stack/orca-tags/')
[ -n "$orca_tags" ] || printf 'Warning: no Orca tags under refs/pod-stack/orca-tags/; run without --no-fetch once.\n' >&2

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pin_blob=$(bash "$base_script" pin "$base_sha" refs/pod-stack/orca-tags/ "refs/remotes/$upstream_remote/main" | git hash-object -w --stdin)

# Replace upstream.json in a tree with the pin for the base commit.
pin_tree() {
  GIT_INDEX_FILE=$tmp/index git read-tree "$1"
  GIT_INDEX_FILE=$tmp/index git update-index --add --cacheinfo "100644,$pin_blob,upstream.json"
  GIT_INDEX_FILE=$tmp/index git write-tree
}

short() { git rev-parse --short "$1"; }

# Patch id of one commit, or of the change between two; empty when nothing changes.
patch_id() { git diff-tree -p --no-commit-id -r "$@" | git patch-id --stable | cut -d' ' -f1; }

# The lines a change adds and removes per file, without context or line numbers.
change_lines() {
  git diff-tree -p --no-commit-id -r --no-renames "$@" | awk '
    /^diff --git / { file = $NF; sub(/^b\//, "", file); header = 1; next }
    header && /^index / { blobs = $0; next }
    header && /^Binary files / { print file "\t" blobs; next }
    header && /^(new|deleted) file mode |^old mode |^new mode / { print file "\t" $0; next }
    /^@@ / { header = 0; next }
    !header && /^[-+]/ { print file "\t" $0 }
  ' | LC_ALL=C sort
}

# Stacked commits by patch id ("<patch id> <source> <entry> <topic>") and by author, date and
# subject ("<key> <source> <built> <entry> <topic>").
: >"$tmp/patch-ids"
: >"$tmp/coverage"
: >"$tmp/commit-keys"
remember() {
  local commit=$1 built=$2 pid=$3 key=$4 built_pid=$5
  [ -z "$pid" ] || printf '%s %s %d %s\n' "$pid" "$commit" "$index" "$topic" >>"$tmp/patch-ids"
  [ -z "$built_pid" ] || [ "$built_pid" = "$pid" ] || printf '%s %s %d %s\n' "$built_pid" "$commit" "$index" "$topic" >>"$tmp/patch-ids"
  printf '%s %s %s %d %s\n' "$key" "$commit" "$built" "$index" "$topic" >>"$tmp/commit-keys"
}

tip=$base_sha
picked_total=0
pinned=0
seen=' '

printf '\nPod stack: %s on Orca %s (%s, %s), topic branches from %s\n\n' "$branch" "$(short "$base_sha")" "$base_label" \
  "$(TZ=UTC0 git log -1 --date=format-local:'%Y-%m-%d %H:%M UTC' --format=%cd "$base_sha")" "$source_kind"

index=0
while IFS=$'\t' read -r -u 3 topic key value base pin squash src src_since hold; do
  [ -n "$topic" ] || continue
  index=$((index + 1))
  note=''
  local_sha=$(git rev-parse --verify --quiet "refs/heads/$topic^{commit}" || true)
  origin_sha=$(git rev-parse --verify --quiet "refs/remotes/origin/$topic^{commit}" || true)
  if [ "$source_kind" = origin ]; then
    ref_sha=$origin_sha
    if [ -z "$ref_sha" ] && [ -n "$local_sha" ]; then
      ref_sha=$local_sha
      note=" (not on origin, using the local branch)"
    fi
  else
    ref_sha=$local_sha
  fi
  if [ "$pin" != - ]; then
    ref_sha=$(git rev-parse --verify --quiet "$pin^{commit}") || die "$topic: pinned ref $pin not found"
    note=" (pinned)"
  fi
  [ -n "$ref_sha" ] || die "$topic: no such branch locally or on origin"
  if [ -n "$local_sha" ] && [ -n "$origin_sha" ] && [ "$local_sha" != "$origin_sha" ]; then
    note=" (local $topic differs from origin: $(git rev-list --left-right --count "$local_sha...$origin_sha" | awk '{print $1 " ahead, " $2 " behind"}'))"
  fi
  printf '%2d. %s @ %s  %s: %s%s\n' "$index" "$topic" "$(short "$ref_sha")" "$key" "$value" "$note"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$index" "$topic" "$ref_sha" "$pin" "$src" "$src_since" "$hold" >>"$tmp/coverage"

  if [ "$key" = Upstream ]; then other_key=Fork-only; else other_key=Upstream; fi
  exclude=("^$upstream_main" "^$base_sha")
  if [ "$base" != - ]; then
    for base_ref in $base; do
      exclude+=("^$(git rev-parse --verify "$base_ref^{commit}")")
    done
  fi

  # Revs go through stdin: a thousand tag exclusions overflow a Windows command line.
  revs=$(printf '%s\n' "$ref_sha" "${exclude[@]}"; [ -z "$orca_tags" ] || printf '%s\n' "$orca_tags" | sed 's/^/^/')
  merges=$(git rev-list --stdin --min-parents=2 <<<"$revs")
  if [ -n "$merges" ] && [ "$squash" != squash ]; then
    printf '    ! skipping %d merge commit(s); their conflict resolutions are not replayed\n' "$(printf '%s\n' "$merges" | wc -l | tr -d ' ')"
  fi

  if [ "$squash" = squash ]; then
    commits=$(git rev-list --stdin --reverse --topo-order --no-merges <<<"$revs")
    if [ -z "$commits" ]; then
      printf '    (nothing new to stack)\n'
      continue
    fi
    count=$(printf '%s\n' "$commits" | wc -l | tr -d ' ')
    # The newest Orca main commit merged into the branch: the net change is measured from it.
    squash_base=$(git merge-base "$ref_sha" "$upstream_main")
    git merge-base --is-ancestor "$squash_base" "$base_sha" \
      || printf '    ! %s has merged Orca main past %s; its net change may rely on newer Orca code\n' "$topic" "$(short "$base_sha")"
    set +e
    merge_out=$(git merge-tree --write-tree --name-only --no-messages --merge-base="$squash_base" "$tip" "$ref_sha")
    merge_status=$?
    set -e
    if [ "$merge_status" -eq 1 ] && [ "$(printf '%s\n' "$merge_out" | tail -n +2 | grep -v '^$')" = upstream.json ]; then
      merge_status=0
    fi
    if [ "$merge_status" -eq 1 ]; then
      {
        printf '\nCONFLICT while stacking entry %d (%s, squashed)\n' "$index" "$topic"
        printf '  change:   %d commit(s) since Orca %s, at %s\n' "$count" "$(short "$squash_base")" "$(short "$ref_sha")"
        printf '  onto:     %s (Orca %s plus %d stacked commit(s))\n' "$(short "$tip")" "$(short "$base_sha")" "$picked_total"
        printf '  files:\n'
        printf '%s\n' "$merge_out" | tail -n +2 | sed 's/^/    /'
        printf '\nNothing was changed. Merge a newer Orca main into %s and resolve, reorder the manifest, or drop the entry.\n' "$topic"
      } >&2
      exit 2
    elif [ "$merge_status" -ne 0 ]; then
      die "git merge-tree failed on $topic (squashed)"
    fi
    tree=$(printf '%s\n' "$merge_out" | head -n 1)
    if [ -n "$(git diff --name-only "$squash_base" "$ref_sha" -- upstream.json)" ]; then
      tree=$(pin_tree "$tree")
      pinned=1
    fi
    for commit in $commits; do
      seen="$seen$commit "
      printf '%s %s %s %d %s\n' "$(git log -1 --format='%ae%n%aI%n%s' "$commit" | git hash-object --stdin)" "$commit" "$commit" "$index" "$topic" >>"$tmp/commit-keys"
    done
    if [ "$tree" = "$(git rev-parse "$tip^{tree}")" ]; then
      printf '    - %d commit(s) at %s (change already present, dropped)\n' "$count" "$(short "$ref_sha")"
      continue
    fi
    first=$(printf '%s\n' "$commits" | head -n 1)
    if [ "$count" -eq 1 ]; then
      message=$(git log -1 --format=%B "$first" | grep -v "^$other_key: ")
    else
      message=$(printf '%s: %d commits squashed at %s\n\n' "$topic" "$count" "$(short "$ref_sha")"
        for commit in $commits; do git log -1 --format='- %s' "$commit"; done)
    fi
    message=$(printf '%s\n' "$message" | git interpret-trailers --if-exists doNothing --trailer "$key: $value")
    tip=$(
      GIT_AUTHOR_NAME=$(git log -1 --format=%an "$first") \
      GIT_AUTHOR_EMAIL=$(git log -1 --format=%ae "$first") \
      GIT_AUTHOR_DATE=$(git log -1 --format=%aI "$first") \
      git commit-tree "$tree" -p "$tip" <<<"$message"
    )
    picked_total=$((picked_total + 1))
    printf '    + %d commit(s) since Orca %s, squashed at %s\n' "$count" "$(short "$squash_base")" "$(short "$ref_sha")"
    continue
  fi

  picked=0
  for commit in $(git rev-list --stdin --reverse --topo-order --no-merges <<<"$revs"); do
    subject=$(git log -1 --format=%s "$commit")
    case $seen in *" $commit "*)
      printf '    = %s %s (already stacked by an earlier entry)\n' "$(short "$commit")" "$subject"
      continue ;;
    esac
    seen="$seen$commit "

    pid=$(patch_id "$commit")
    same=''
    [ -z "$pid" ] || same=$(awk -v p="$pid" '$1 == p { print $2 " " $3 " " $4; exit }' "$tmp/patch-ids")
    if [ -n "$same" ]; then
      read -r same_commit same_index same_topic <<<"$same"
      printf '    = %s %s (same patch as %s from entry %d, %s)\n' "$(short "$commit")" "$subject" "$(short "$same_commit")" "$same_index" "$same_topic"
      continue
    fi
    key=$(git log -1 --format='%ae%n%aI%n%s' "$commit" | git hash-object --stdin)
    copy=$(awk -v k="$key" '$1 == k { print $2 " " $3 " " $4 " " $5; exit }' "$tmp/commit-keys")
    if [ -n "$copy" ]; then
      read -r copy_commit copy_built copy_index copy_topic <<<"$copy"
      lines=$(change_lines "$commit")
      if [ "$lines" = "$(change_lines "$copy_commit")" ] || [ "$lines" = "$(change_lines "${copy_built}^" "$copy_built")" ]; then
        printf '    = %s %s (copy of %s from entry %d, %s; same lines, other context)\n' "$(short "$commit")" "$subject" "$(short "$copy_commit")" "$copy_index" "$copy_topic"
        remember "$commit" "$copy_built" "$pid" "$key" ''
        continue
      fi
      {
        printf '\nSTALE COPY while stacking entry %d (%s)\n' "$index" "$topic"
        printf '  commit:   %s %s\n' "$(short "$commit")" "$subject"
        printf '  copy of:  %s from entry %d (%s): same author, date and subject, different change\n' "$(short "$copy_commit")" "$copy_index" "$copy_topic"
        printf '  files that differ:\n'
        diff <(change_lines "$copy_commit") <(printf '%s\n' "$lines") | sed -n 's/^[<>] //p' | cut -f1 | sort -u | sed 's/^/    /' || true
        printf '\nNothing was changed. Rebase %s onto the current %s, or give its entry a "base" past the old copy.\n' "$topic" "$copy_topic"
      } >&2
      exit 2
    fi

    parent=$(git rev-parse "$commit^")
    set +e
    merge_out=$(git merge-tree --write-tree --name-only --no-messages --merge-base="$parent" "$tip" "$commit")
    merge_status=$?
    set -e
    # upstream.json is rewritten with the pin below, so a conflict confined to it is no conflict.
    if [ "$merge_status" -eq 1 ] && [ "$(printf '%s\n' "$merge_out" | tail -n +2 | grep -v '^$')" = upstream.json ]; then
      merge_status=0
    fi
    if [ "$merge_status" -eq 1 ]; then
      {
        printf '\nCONFLICT while stacking entry %d (%s)\n' "$index" "$topic"
        printf '  commit:   %s %s\n' "$(short "$commit")" "$subject"
        printf '  onto:     %s (Orca %s plus %d stacked commit(s))\n' "$(short "$tip")" "$(short "$base_sha")" "$picked_total"
        printf '  files:\n'
        printf '%s\n' "$merge_out" | tail -n +2 | sed 's/^/    /'
        printf '\nNothing was changed. Rebase %s onto %s and resolve, reorder the manifest, or drop the entry.\n' "$topic" "$(short "$base_sha")"
      } >&2
      exit 2
    elif [ "$merge_status" -ne 0 ]; then
      die "git merge-tree failed on $(short "$commit") ($topic)"
    fi
    tree=$(printf '%s\n' "$merge_out" | head -n 1)

    if [ -n "$(git diff-tree --no-commit-id --name-only -r "$parent" "$commit" -- upstream.json)" ]; then
      tree=$(pin_tree "$tree")
      pinned=1
    fi

    if [ "$tree" = "$(git rev-parse "$tip^{tree}")" ]; then
      printf '    - %s %s (change already present, dropped)\n' "$(short "$commit")" "$subject"
      remember "$commit" "$commit" "$pid" "$key" ''
      continue
    fi

    # A commit's own trailer of the same kind is more specific than the entry's; the other kind is overruled.
    message=$(git log -1 --format=%B "$commit")
    if [ -n "$(git log -1 --format="%(trailers:key=$other_key,valueonly)" "$commit")" ]; then
      printf '    ! %s carries a %s trailer; the manifest says %s, so it is replaced\n' "$(short "$commit")" "$other_key" "$key"
      message=$(printf '%s\n' "$message" | grep -v "^$other_key: ")
    fi
    message=$(printf '%s\n' "$message" | git interpret-trailers --if-exists doNothing --trailer "$key: $value")
    prev_tip=$tip
    tip=$(
      GIT_AUTHOR_NAME=$(git log -1 --format=%an "$commit") \
      GIT_AUTHOR_EMAIL=$(git log -1 --format=%ae "$commit") \
      GIT_AUTHOR_DATE=$(git log -1 --format=%aI "$commit") \
      git commit-tree "$tree" -p "$tip" <<<"$message"
    )
    picked=$((picked + 1))
    picked_total=$((picked_total + 1))
    remember "$commit" "$tip" "$pid" "$key" "$(patch_id "$prev_tip" "$tip")"
    printf '    + %s %s\n' "$(short "$commit")" "$subject"
  done
  [ "$picked" -gt 0 ] || printf '    (nothing new to stack)\n'
done 3<<<"$entries"

# The tip of a branch as the stack reads it: origin, else local (or local only with --source local).
branch_tip() {
  if [ "$source_kind" = origin ]; then
    git rev-parse --verify --quiet "refs/remotes/origin/$1^{commit}" || git rev-parse --verify --quiet "refs/heads/$1^{commit}" || true
  else
    git rev-parse --verify --quiet "refs/heads/$1^{commit}" || true
  fi
}

printf '\nCoverage:\n'
uncovered=0
while IFS=$'\t' read -r c_index c_topic c_ref c_pin c_src c_since c_hold; do
  if [ "$c_pin" != - ]; then
    branch_sha=$(branch_tip "$c_topic")
    if [ -n "$branch_sha" ] && ! git merge-base --is-ancestor "$branch_sha" "$c_ref" && [ "$c_hold" != - ]; then
      printf '  ~ entry %d (%s) held at %s, branch at %s (%d commit(s) not stacked): %s\n' \
        "$c_index" "$c_topic" "$(short "$c_ref")" "$(short "$branch_sha")" "$(git rev-list --count "$c_ref..$branch_sha")" "$c_hold"
    elif [ -n "$branch_sha" ] && ! git merge-base --is-ancestor "$branch_sha" "$c_ref"; then
      printf '  ! entry %d (%s) is pinned at %s, but the branch is at %s: %d commit(s) are not stacked\n' \
        "$c_index" "$c_topic" "$(short "$c_ref")" "$(short "$branch_sha")" "$(git rev-list --count "$c_ref..$branch_sha")"
      uncovered=1
    fi
  fi
  [ "$c_src" != - ] || continue
  src_sha=$(branch_tip "$c_src")
  if [ -z "$src_sha" ]; then
    printf '  ! entry %d (%s): source branch %s not found\n' "$c_index" "$c_topic" "$c_src"
    uncovered=1
    continue
  fi
  src_revs=$(printf '%s\n' "$src_sha" "^$upstream_main" "^$base_sha"; [ "$c_since" = - ] || printf '^%s\n' "$(git rev-parse --verify "$c_since^{commit}")"; [ -z "$orca_tags" ] || printf '%s\n' "$orca_tags" | sed 's/^/^/')
  missing=0
  for commit in $(git rev-list --stdin --no-merges <<<"$src_revs"); do
    case $seen in *" $commit "*) continue ;; esac
    k=$(git log -1 --format='%ae%n%aI%n%s' "$commit" | git hash-object --stdin)
    grep -q "^$k " "$tmp/commit-keys" && continue
    p=$(patch_id "$commit")
    [ -n "$p" ] && grep -q "^$p " "$tmp/patch-ids" && continue
    printf '  ! entry %d (%s) lacks %s %s from its source %s\n' "$c_index" "$c_topic" "$(short "$commit")" "$(git log -1 --format=%s "$commit")" "$c_src"
    missing=1
  done
  if [ "$missing" -eq 1 ]; then
    uncovered=1
  else
    printf '  = entry %d (%s) has every commit of %s @ %s\n' "$c_index" "$c_topic" "$c_src" "$(short "$src_sha")"
  fi
done <"$tmp/coverage"
if [ "$uncovered" -eq 1 ]; then
  printf '\nNothing was changed: a listed branch is not fully in the result. Refresh the pin or the copy.\n' >&2
  exit 4
fi
printf '  every pinned entry contains its branch tip\n'

if [ "$pinned" -eq 0 ]; then
  printf '\nWarning: no stacked commit owns upstream.json, so the result does not record its Orca base.\n'
fi

printf '\nResult: %s, %d commit(s) on Orca %s (%s)\n' "$(short "$tip")" "$picked_total" "$(short "$base_sha")" "$base_label"

# Compare with the published product branch, falling back to the local one.
old=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch^{commit}" || git rev-parse --verify --quiet "refs/heads/$branch^{commit}" || true)
dropped=''
if [ -n "$old" ]; then
  old_base=$(git show "$old:upstream.json" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s);process.stdout.write(p.ref||p.sha||"")}catch{}})' || true)
  if [ -z "$old_base" ]; then
    printf 'Current %s: %s has no upstream.json, so it is not a Pod build.\n' "$branch" "$(short "$old")"
    dropped="everything on the current $branch (applying replaces it)"$'\n'
  else
    git merge-base --is-ancestor "$old_base" "$old" || old_base=$(git merge-base "$old" "$base_sha")
    # A commit that only re-pins upstream.json is replaced by the new pin, not lost.
    while read -r mark commit; do
      [ "$mark" = + ] || continue
      [ "$(git diff-tree --no-commit-id --name-only -r "$commit^" "$commit")" = upstream.json ] && continue
      dropped="$dropped$(short "$commit") $(git log -1 --format=%s "$commit")"$'\n'
    done < <(git cherry "$tip" "$old" "$old_base")
    printf 'Current %s: %s, built on %s\n' "$branch" "$(short "$old")" "$(short "$old_base")"
  fi
  if [ -n "$dropped" ]; then
    printf 'Commits on the current %s that the result lacks (not in any manifest branch):\n' "$branch"
    printf '%s' "$dropped" | sed 's/^/  /'
  else
    printf 'Every commit on the current %s is in the result.\n' "$branch"
  fi
else
  printf 'No %s branch yet.\n' "$branch"
fi

if [ "$apply" -eq 0 ]; then
  printf '\nDry run: no refs changed. Re-run with --apply (local branch) or --push (local + origin).\n'
  exit 0
fi

if [ -n "$dropped" ] && [ "$allow_drop" -eq 0 ]; then
  printf '\nRefusing to apply: it would drop the commits above. Add their branch to the manifest, or pass --allow-drop.\n' >&2
  exit 3
fi

if git for-each-ref --format='%(refname)' "refs/heads/$branch/" | grep -q .; then
  die "branches under $branch/ exist, so refs/heads/$branch cannot be created; rename them first"
fi

local_old=$(git rev-parse --verify --quiet "refs/heads/$branch^{commit}" || true)
if [ -n "$local_old" ]; then
  backup=refs/pod-stack/backup/$branch-$(date -u +%Y%m%dT%H%M%SZ)
  git update-ref "$backup" "$local_old"
  printf '\nOld local %s kept as %s\n' "$branch" "$backup"
fi

checked_out=$(git worktree list --porcelain | awk -v ref="refs/heads/$branch" '/^worktree /{wt=substr($0,10)} $0=="branch " ref {print wt}')
if [ -n "$checked_out" ]; then
  if [ "$checked_out" != "$root" ]; then
    die "$branch is checked out in $checked_out; run this there, or detach that worktree first"
  fi
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "$branch is checked out here with local changes; commit or stash them first"
  git reset --quiet --keep "$tip"
else
  git update-ref "refs/heads/$branch" "$tip" ${local_old:+"$local_old"}
fi
printf 'Local %s is now %s\n' "$branch" "$(short "$tip")"

if [ "$push" -eq 1 ]; then
  remote_old=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch^{commit}" || true)
  git push --force-with-lease="refs/heads/$branch:${remote_old}" origin "$tip:refs/heads/$branch"
  printf 'Pushed %s to origin/%s\n' "$(short "$tip")" "$branch"

  # A push can register new Orca workflows as active, and they start at once.
  quarantine=$root/scripts/pod-workflow-quarantine.sh
  origin_repo=$(git remote get-url origin | sed -E 's#^.*github\.com[:/]##; s#\.git$##')
  if command -v gh >/dev/null 2>&1 && [ -f "$quarantine" ]; then
    sleep 15
    bash "$quarantine" "$origin_repo" || printf 'Warning: the quarantine failed; run %s %s\n' "$quarantine" "$origin_repo" >&2
  else
    printf 'Run scripts/pod-workflow-quarantine.sh %s now: this push can start Orca workflows.\n' "$origin_repo" >&2
  fi
fi
