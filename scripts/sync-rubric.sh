#!/usr/bin/env bash
# Vendor the readiness rubric from kaizen-tasks-assembly-line, or check it for drift.
#
#   scripts/sync-rubric.sh [ref]             download rubric/readiness.md at <ref> (default develop)
#                                            from GitHub over src/agent/prompts/readiness.md
#   scripts/sync-rubric.sh --local <path>    copy from a local checkout instead of downloading
#   scripts/sync-rubric.sh --check [ref]     compare the version: lines only; warn on drift; exit 0
#   scripts/sync-rubric.sh --check --local <path>
#
# Engineering owns the rubric in the assembly-line repo. This script only copies it; never edit
# src/agent/prompts/readiness.md by hand. It is a system block of the interview prompt, so a change
# to it is a prompt change (docs/architectural-files.txt, ADR 0005).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_RUBRIC="$REPO_ROOT/src/agent/prompts/readiness.md"
UPSTREAM_REPO="kpnemo/kaizen-tasks-assembly-line"
UPSTREAM_PATH="rubric/readiness.md"

check=0
source_path=""
ref="develop"

while [ $# -gt 0 ]; do
  case "$1" in
    --check)
      check=1
      shift
      ;;
    --local)
      source_path="${2:-}"
      if [ -z "$source_path" ]; then
        echo "error: --local needs a path" >&2
        exit 2
      fi
      shift 2
      ;;
    -h | --help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    -*)
      echo "error: unknown option $1" >&2
      exit 2
      ;;
    *)
      ref="$1"
      shift
      ;;
  esac
done

warn() {
  echo "warning: $1" >&2
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::warning::$1"
  fi
}

version_of() {
  grep -m1 '^version:' "$1" | sed 's/^version:[[:space:]]*//' | sed -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//"
}

# The vendored copy must exist: it is a system block of the interview prompt, and the API asserts
# it at startup. Missing is a hard failure even in --check mode; drift is only a warning.
require_local() {
  if [ ! -f "$LOCAL_RUBRIC" ]; then
    echo "error: src/agent/prompts/readiness.md is missing; run npm run rubric:sync" >&2
    return 1
  fi
  return 0
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if [ -n "$source_path" ]; then
  if [ ! -f "$source_path" ]; then
    echo "error: $source_path does not exist" >&2
    exit 1
  fi
  cp "$source_path" "$tmp"
  origin="$source_path"
else
  origin="https://raw.githubusercontent.com/$UPSTREAM_REPO/$ref/$UPSTREAM_PATH"
  if ! curl -fsSL "$origin" -o "$tmp"; then
    if [ "$check" -eq 1 ]; then
      warn "rubric drift check skipped: could not download $origin"
      require_local
      exit "$?"
    fi
    echo "error: could not download $origin" >&2
    exit 1
  fi
fi

upstream_version="$(version_of "$tmp" || true)"
if [ -z "$upstream_version" ]; then
  echo "error: no version: line in $origin" >&2
  exit 1
fi

if [ "$check" -eq 1 ]; then
  require_local || exit 1
  local_version="$(version_of "$LOCAL_RUBRIC" || true)"
  if [ "$local_version" = "$upstream_version" ]; then
    echo "rubric up to date: version $local_version"
  else
    warn "rubric drift: local version ${local_version:-none}, upstream version $upstream_version. Run npm run rubric:sync"
  fi
  exit 0
fi

mkdir -p "$(dirname "$LOCAL_RUBRIC")"
cp "$tmp" "$LOCAL_RUBRIC"
echo "src/agent/prompts/readiness.md updated to version $upstream_version from $origin"
