#!/usr/bin/env bash
# Copies runtime assets that tsc does not emit. Run by `npm run build`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SRC="src/agent/prompts"
DEST="dist/agent/prompts"

if [[ ! -d "$SRC" ]]; then
  echo "copy-assets: missing $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
cp -R "$SRC"/. "$DEST"/
echo "copy-assets: copied $SRC -> $DEST"
