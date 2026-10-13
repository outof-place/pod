#!/bin/bash
# Prints the CFBundleVersion of a Pod release: the one number Sparkle compares (sparkle:version;
# SUStandardVersionComparator wants numeric components), so it must grow with every release.
#
#   product/scripts/pod-build-number.sh <X.Y.Z | X.Y.Z-rcN>
#
#   MAJOR*1000000 + MINOR*10000 + PATCH*100 + N, where N is the rc number (1-98) or 99 for the
#   release itself: 1.0.0-rc1 1000001, 1.0.0-rc2 1000002, 1.0.0 1000099, 1.0.1-rc1 1000101.
# CFBundleShortVersionString stays the version itself; Sparkle only shows it.
set -euo pipefail

version=${1:?usage: pod-build-number.sh <X.Y.Z | X.Y.Z-rcN>}
[[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-rc([0-9]+))?$ ]] ||
  { echo "version '$version' is not X.Y.Z or X.Y.Z-rcN" >&2; exit 2; }
major=$((10#${BASH_REMATCH[1]})) minor=$((10#${BASH_REMATCH[2]})) patch=$((10#${BASH_REMATCH[3]}))
n=99
[ -n "${BASH_REMATCH[5]}" ] && n=$((10#${BASH_REMATCH[5]}))
[ "$minor" -le 99 ] && [ "$patch" -le 99 ] || { echo "minor and patch go up to 99" >&2; exit 2; }
[ "$n" -ge 1 ] && [ "$n" -le 99 ] && { [ -z "${BASH_REMATCH[5]}" ] || [ "$n" -le 98 ]; } ||
  { echo "rc numbers go from 1 to 98" >&2; exit 2; }
echo $((major * 1000000 + minor * 10000 + patch * 100 + n))
