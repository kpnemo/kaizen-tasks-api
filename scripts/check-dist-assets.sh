#!/usr/bin/env bash
# CI gate: fails if the build output is missing the compiled entry point or the prompt asset.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

missing=0
for f in dist/server.js dist/agent/prompts/breakdown.system.md; do
  if [[ ! -f "$f" ]]; then
    echo "check-dist-assets: missing $f" >&2
    missing=1
  fi
done

if (( missing != 0 )); then
  exit 1
fi
echo "check-dist-assets: OK"
