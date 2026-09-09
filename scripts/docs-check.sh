#!/usr/bin/env bash
# Docs-drift check. Same script for the Claude Code Stop hook (--hook) and CI (--ci).
# Rules (spec 8.2):
#   A: code changed  -> CHANGELOG.md changed and [Unreleased] has a bullet
#   B: routes/schemas changed -> npm run openapi -- --check passes
#   C: architectural file changed -> an ADR under docs/adr/ changed
set -uo pipefail

MODE="${1:-}"
if [[ "$MODE" != "--hook" && "$MODE" != "--ci" ]]; then
  echo "usage: scripts/docs-check.sh --hook | --ci" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COUNTER_FILE=".claude/.docs-check-blocks"
MARKER_FILE=".claude/DOCS-CHECK-FAILED"
MAX_BLOCKS=3

# Claude Code feeds the Stop hook a JSON object on stdin. `stop_hook_active` is true when this stop
# is itself the continuation forced by an earlier block, so "consecutive" blocks are counted within
# one continuation chain: an explicit false (a fresh stop) restarts the count. A missing or
# unparseable payload (manual runs, other callers) leaves the counter's legacy behaviour alone.
STOP_HOOK_ACTIVE=""
if [[ "$MODE" == "--hook" && ! -t 0 ]]; then
  HOOK_INPUT="$(cat || true)"
  if [[ -n "$HOOK_INPUT" ]]; then
    STOP_HOOK_ACTIVE="$(printf '%s' "$HOOK_INPUT" | node -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        try {
          const v = JSON.parse(d).stop_hook_active;
          process.stdout.write(v === true ? "true" : v === false ? "false" : "");
        } catch {
          process.stdout.write("");
        }
      });
    ')"
  fi
fi

root_commit() { git rev-list --max-parents=0 HEAD | tail -n 1; }

# 1. Changed set.
if [[ "$MODE" == "--hook" ]]; then
  if git rev-parse --verify -q origin/develop >/dev/null; then
    BASE="$(git merge-base HEAD origin/develop)"
  elif git rev-parse --verify -q develop >/dev/null; then
    BASE="$(git merge-base HEAD develop)"
  else
    BASE="$(root_commit)"
  fi
  CHANGED="$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } | sort -u )"
else
  : "${BASE_SHA:?BASE_SHA is required in --ci mode}"
  if [[ "$BASE_SHA" =~ ^0+$ ]] || ! git cat-file -e "$BASE_SHA" 2>/dev/null; then
    BASE_SHA="$(root_commit)"
  fi
  CHANGED="$( { git diff --name-only "$BASE_SHA...HEAD" 2>/dev/null || git diff --name-only "$BASE_SHA" HEAD; } | sort -u )"
fi

if [[ -z "$CHANGED" ]]; then
  echo "docs-check: no changes"
  rm -f "$COUNTER_FILE" "$MARKER_FILE"
  exit 0
fi

# 2. Code set and architectural matches.
CODE_SET="$(grep -E '^(src/|drizzle/|\.railway/|scripts/|package\.json$)' <<<"$CHANGED" || true)"

match_glob() {
  local pattern="${1//\*\*/*}"
  [[ "$2" == $pattern ]]
}

ARCH_MATCHES=""
if [[ -f docs/architectural-files.txt ]]; then
  while IFS= read -r glob; do
    [[ -z "$glob" || "$glob" == \#* ]] && continue
    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      if match_glob "$glob" "$file"; then
        ARCH_MATCHES+="$file"$'\n'
      fi
    done <<<"$CHANGED"
  done < docs/architectural-files.txt
fi

if [[ -z "$CODE_SET" && -z "$ARCH_MATCHES" ]]; then
  echo "docs-check: no code or architectural changes"
  rm -f "$COUNTER_FILE" "$MARKER_FILE"
  exit 0
fi

unreleased_has_bullet() {
  awk '
    /^## \[Unreleased\]/ { inside = 1; next }
    /^## / { if (inside) exit }
    inside && /^[[:space:]]*[-*] / { found = 1; exit }
    END { exit found ? 0 : 1 }
  ' CHANGELOG.md
}

FAILURES=()

# 3. Rule A.
if [[ -n "$CODE_SET" ]]; then
  if ! grep -qx 'CHANGELOG.md' <<<"$CHANGED"; then
    FAILURES+=("Rule A: code changed but CHANGELOG.md did not. Fix: add a bullet under [Unreleased] in CHANGELOG.md")
  elif ! unreleased_has_bullet; then
    FAILURES+=("Rule A: CHANGELOG.md [Unreleased] has no bullet. Fix: add a bullet under [Unreleased] in CHANGELOG.md")
  fi
fi

# 4. Rule B.
if grep -qE '^src/(routes|schemas)/' <<<"$CHANGED"; then
  if ! npm run --silent openapi -- --check >/dev/null 2>&1; then
    FAILURES+=("Rule B: routes or schemas changed and openapi.json or docs/API.md is stale. Fix: run npm run openapi and commit")
  fi
fi

# 5. Rule C, independent of Rule A.
if [[ -n "$ARCH_MATCHES" ]]; then
  if ! grep -qE '^docs/adr/[^/]+\.md$' <<<"$CHANGED"; then
    LIST="$(printf '%s' "$ARCH_MATCHES" | sort -u | tr '\n' ' ')"
    FAILURES+=("Rule C: architectural files changed (${LIST}) without an ADR. Fix: add or update an ADR under docs/adr/")
  fi
fi

if [[ ${#FAILURES[@]} -eq 0 ]]; then
  echo "docs-check: OK"
  rm -f "$COUNTER_FILE" "$MARKER_FILE"
  exit 0
fi

# 6. Failure output with the exact fix per rule.
MESSAGE="DOCS CHECK FAILED"$'\n'
for failure in "${FAILURES[@]}"; do
  MESSAGE+="  - ${failure}"$'\n'
done

if [[ "$MODE" == "--ci" ]]; then
  printf '%s' "$MESSAGE"
  exit 1
fi

# 7. Hook mode: block (exit 2) up to MAX_BLOCKS consecutive times, then stop blocking but never report success.
mkdir -p .claude
if [[ "$STOP_HOOK_ACTIVE" == "false" ]]; then
  rm -f "$COUNTER_FILE" # a fresh stop, not a continuation of an earlier block: the count starts over
fi
COUNT=$(( $(cat "$COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$COUNT" > "$COUNTER_FILE"

printf '%s' "$MESSAGE"
printf '%s' "$MESSAGE" >&2

if (( COUNT > MAX_BLOCKS )); then
  printf '%s' "$MESSAGE" > "$MARKER_FILE"
  BANNER="DOCS CHECK FAILED, human intervention required (blocked ${MAX_BLOCKS} times; no longer blocking; see ${MARKER_FILE}; CI will still fail)"
  echo "$BANNER"
  echo "$BANNER" >&2
  exit 1
fi

echo "(block ${COUNT} of ${MAX_BLOCKS})" >&2
exit 2
