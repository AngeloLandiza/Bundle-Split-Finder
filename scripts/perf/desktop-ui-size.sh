#!/bin/sh
# Builds the desktop UI (production, VITE_MOCK unset) into a fresh temp directory outside the repo
# and prints the directory. Measure with:
#   python3 <optimize-codebase>/scripts/bench.py size --name desktop-ui-js "$(scripts/perf/desktop-ui-size.sh)/assets/*.js"
# VITE_MOCK=1 in the environment builds the mock variant.
set -e
cd "$(dirname "$0")/../.."
out="$(mktemp -d "${TMPDIR:-/tmp}/desktop-ui-build.XXXXXX")"
npx vite build --config desktop-ui/vite.config.ts --outDir "$out" --emptyOutDir >&2
echo "$out"
