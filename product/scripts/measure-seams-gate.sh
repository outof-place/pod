#!/bin/bash
# Measurement seams: POD_MEASURE_SEAMS=1 marks a PodNative as a test build (it changes only code under
# `#if POD_MEASURE_SEAMS`) and sets PodMeasureSeams = true in its Info.plist. Such a build is for
# local test packages only: assemble-one-app.sh signs it but never notarizes it, and
# release-one-app.sh never asks for one.
#
#   product/scripts/measure-seams-gate.sh <PodNative.app>
#
# Exit 0: no seams. Exit 1: seams, with the reason on stdout (the outer's marker, or POD_MEASURE_SEAMS
# set and not 0 in this environment). Exit 2: no Info.plist to read.
set -euo pipefail

app="${1:?usage: measure-seams-gate.sh <PodNative.app>}"
plist="$app/Contents/Info.plist"
[ -f "$plist" ] || { echo "measure-seams-gate: no $plist" >&2; exit 2; }

reasons=()
if [ "${POD_MEASURE_SEAMS:-0}" != 0 ]; then
  reasons+=("POD_MEASURE_SEAMS=${POD_MEASURE_SEAMS} in the environment")
fi
# Why python and not plutil: the gate's test runs on Linux CI too.
marker="$(python3 -I -c 'import plistlib, sys; print(plistlib.load(open(sys.argv[1], "rb")).get("PodMeasureSeams") is True)' "$plist")"
if [ "$marker" = True ]; then
  reasons+=("the outer's Info.plist has PodMeasureSeams")
fi

[ "${#reasons[@]}" -gt 0 ] || exit 0
(IFS=';'; printf 'measurement seams build (%s)\n' "${reasons[*]}")
exit 1
