#!/bin/bash
# Builds the benchmark's native tools into bench/.build/bin.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="$here/../.build/bin"
mkdir -p "$bin"
for tool in procstat ttyprobe termload; do
  xcrun clang -O2 -Wall -Wextra -o "$bin/$tool" "$here/$tool.c"
done
xcrun swiftc -swift-version 5 -O -o "$bin/keylat" "$here/../latency/keylat.swift"
xcrun clang -O2 -fobjc-arc -framework Foundation -framework CoreGraphics -o "$bin/vdisplay" "$here/../latency/vdisplay.m"
echo "built: $(ls "$bin" | tr '\n' ' ')"
