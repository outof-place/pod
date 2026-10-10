#!/bin/bash
# Pins and builds the search suites' inputs before the measured run. Writes their paths and SHAs as
# JSON to --out. Heavy builds go through claude-acc's scheduler like any agent build; only the
# measured processes later run unscheduled.
#
#   bench/search/prepare.sh --out FILE [--og-sha SHA] [--og-features pcre2]
#                           [--search-client-sha SHA] [--repo-source ~/.local/share/portivo-repo]
#
# - a clone of ~/Documents/pod-search at --og-sha, built with `cargo build --release --locked`;
# - a worktree of this repo at --search-client-sha (pod/search-client) with node_modules and the
#   E2E build, for its ogd parity test and pod-native-search spec;
# - a fresh local clone of the Portivo mirror, the repo every search suite reads (never written).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
base="$HOME/Library/Application Support/orca-native/bench/search"
out=""
og_sha=""
og_features="pcre2"
client_sha=""
repo_source="$HOME/.local/share/portivo-repo"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="${2:?}"; shift 2 ;;
    --og-sha) og_sha="${2:?}"; shift 2 ;;
    --og-features) og_features="$2"; shift 2 ;;
    --search-client-sha) client_sha="${2:?}"; shift 2 ;;
    --repo-source) repo_source="${2:?}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$out" ] || { echo "pass --out FILE" >&2; exit 2; }
mkdir -p "$base"

# Through claude-acc's scheduler when it is installed, as an agent's build would be.
acc_src="$(cat "$HOME/.local/share/claude-acc/source" 2>/dev/null || true)"
acc_py="$HOME/.local/share/claude-acc/python"
scheduled() {
  local dir="$1" command="$2"
  if [ -n "$acc_src" ] && [ -f "$acc_src/sched.py" ] && [ -x "$acc_py" ]; then
    (cd "$dir" && "$acc_py" "$acc_src/sched.py" run --via cli --shell "$command")
  else
    (cd "$dir" && /bin/zsh -c "$command")
  fi
}

ogd="" ogctl="" og_dir=""
if [ -n "$og_sha" ]; then
  og_dir="$base/pod-search-${og_sha:0:12}"
  if [ ! -d "$og_dir/.git" ]; then
    git clone -q --no-checkout "$HOME/Documents/pod-search" "$og_dir"
  fi
  git -C "$og_dir" checkout -q --detach "$og_sha"
  features=()
  [ -z "$og_features" ] || features=(--features "$og_features")
  scheduled "$og_dir" "cargo build --release --locked ${features[*]}"
  ogd="$og_dir/target/release/ogd"
  ogctl="$og_dir/target/release/ogctl"
  [ -x "$ogd" ] || { echo "no ogd after the build" >&2; exit 1; }
fi

client_dir=""
if [ -n "$client_sha" ]; then
  client_dir="$base/search-client-${client_sha:0:12}"
  git -C "$repo_root" fetch -q origin
  if [ ! -e "$client_dir/.git" ]; then
    git -C "$repo_root" worktree add -q --detach "$client_dir" "$client_sha"
  else
    git -C "$client_dir" checkout -q --detach "$client_sha"
  fi
  scheduled "$client_dir" "pnpm install --frozen-lockfile"
  # The two builds tests/e2e/global-setup.ts makes; the measured runs then use SKIP_BUILD=1.
  scheduled "$client_dir" "VITE_EXPOSE_STORE=true npx electron-vite build --mode e2e && pnpm run build:cli"
fi

search_repo="$base/portivo"
if [ ! -d "$search_repo/.git" ] || [ -n "$(git -C "$search_repo" status --porcelain)" ]; then
  [ ! -e "$search_repo" ] || mv "$search_repo" "$search_repo.stale.$(date +%s)"
  git clone -q --local "$repo_source" "$search_repo"
fi
search_repo_sha="$(git -C "$search_repo" rev-parse HEAD)"

node -e '
  const [out, ...v] = process.argv.slice(1)
  const [ogSha, ogFeatures, ogd, ogctl, clientSha, client, repo, repoSha, source] = v
  require("fs").writeFileSync(out, JSON.stringify({
    ogSha: ogSha || null, ogFeatures: (ogSha && ogFeatures) || null, ogd: ogd || null, ogctl: ogctl || null,
    searchClientSha: clientSha || null, searchClient: client || null,
    searchRepo: repo, searchRepoSha: repoSha, searchRepoSource: source
  }, null, 2) + "\n")
' "$out" "$og_sha" "$og_features" "$ogd" "$ogctl" "$client_sha" "$client_dir" "$search_repo" "$search_repo_sha" "$repo_source"
cat "$out"
