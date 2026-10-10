#!/bin/sh
# Builds the warm-shell client (named zsh: Claude Code only accepts CLAUDE_CODE_SHELL paths
# containing "zsh", and the path must not contain "bash") and its daemon into $1.
set -eu
out=${1:?usage: build.sh OUT_DIR [arch]}
arch=${2:-arm64}
here=$(cd "$(dirname "$0")" && pwd)
case "$out" in *bash*) echo "build.sh: $out contains \"bash\"; Claude Code would pick bash quoting" >&2; exit 1 ;; esac
mkdir -p "$out"
for target in "zsh:client.c" "pod-shelld:shelld.c"; do
  name=${target%%:*}
  xcrun clang -O2 -Wall -Wextra -Wno-unused-parameter -Wno-deprecated-declarations \
    -target "$arch-apple-macos13" -o "$out/$name.tmp" "$here/src/${target#*:}"
  # Rename over the old binary: overwriting a running one in place gets new launches killed.
  mv -f "$out/$name.tmp" "$out/$name"
done
