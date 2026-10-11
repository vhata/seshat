#!/usr/bin/env bash
# Configure tracked hooks for this Git repository; no dependencies to install.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v git >/dev/null || { echo 'setup: Git is required' >&2; exit 1; }
current_hooks="$(git config --get core.hooksPath || true)"
if [ -n "$current_hooks" ] && [ "$current_hooks" != '.githooks' ]; then
  echo "setup: existing core.hooksPath '$current_hooks'; resolve it before installing Seshat hooks" >&2
  exit 1
fi
for hook in .githooks/pre-commit .githooks/pre-push; do
  [ -x "$hook" ] || { echo "setup: $hook missing or not executable" >&2; exit 1; }
done
git config --local core.hooksPath .githooks
echo 'setup: tracked hooks configured; no application dependencies to install'
