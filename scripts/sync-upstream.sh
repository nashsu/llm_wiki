#!/usr/bin/env bash
# Sync this fork with nashsu/llm_wiki: fast-forward main, merge into web-mode.
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch upstream --tags
current=$(git rev-parse --abbrev-ref HEAD)
git checkout -q main
git merge --ff-only upstream/main
git checkout -q web-mode
if git merge --no-edit main; then
  echo "web-mode is up to date with upstream/main ($(git rev-parse --short main))."
  echo "Next: npm run build && npm run web:check"
else
  echo "Merge conflicts — resolve them, then: git add -A && git commit"
  exit 1
fi
[ "$current" = "web-mode" ] || git checkout -q "$current"
