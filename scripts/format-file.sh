#!/usr/bin/env bash
# PostToolUse hook for Edit|Write: reads the tool input JSON from stdin and runs prettier on the
# edited file when it is inside this repository and has a formattable extension. Never fails the tool.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

INPUT="$(cat)"
FILE="$(printf '%s' "$INPUT" | node -e '
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    try {
      const j = JSON.parse(d);
      process.stdout.write(String(j.tool_input?.file_path ?? ""));
    } catch {
      process.stdout.write("");
    }
  });
')"
[[ -z "$FILE" ]] && exit 0

case "$FILE" in
  /*) ABS="$FILE" ;;
  *) ABS="$ROOT/$FILE" ;;
esac
DIR="$(cd "$(dirname "$ABS")" 2>/dev/null && pwd)" || exit 0
ABS="$DIR/$(basename "$ABS")"

[[ "$ABS" == "$ROOT/"* ]] || exit 0
[[ -f "$ABS" ]] || exit 0

case "$ABS" in
  *.ts|*.js|*.mjs|*.cjs|*.json|*.md|*.yml|*.yaml) ;;
  *) exit 0 ;;
esac

cd "$ROOT" && npx prettier --write --log-level warn "$ABS" >/dev/null 2>&1 || true
exit 0
