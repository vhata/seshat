#!/usr/bin/env bash
# Configure tracked hooks and install the locked application dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v git >/dev/null || { echo 'setup: Git is required' >&2; exit 1; }
command -v node >/dev/null || { echo 'setup: Node.js is required (see .node-version)' >&2; exit 1; }
command -v npm >/dev/null || { echo 'setup: npm is required' >&2; exit 1; }
required_node="$(tr -d '[:space:]' < .node-version)"
required_node="${required_node#v}"
required_major="${required_node%%.*}"
case "$required_major" in
  ''|*[!0-9]*) echo "setup: .node-version must start with a major version; found '$required_node'" >&2; exit 1 ;;
esac
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt "$required_major" ]; then
  echo "setup: Node.js $required_major or later is required; found $(node --version)" >&2
  exit 1
fi
current_hooks="$(git config --get core.hooksPath || true)"
if [ -n "$current_hooks" ] && [ "$current_hooks" != '.githooks' ]; then
  echo "setup: existing core.hooksPath '$current_hooks'; resolve it before installing Seshat hooks" >&2
  exit 1
fi
for hook in .githooks/pre-commit .githooks/pre-push; do
  [ -x "$hook" ] || { echo "setup: $hook missing or not executable" >&2; exit 1; }
done
git config --local core.hooksPath .githooks
echo 'setup: tracked hooks configured'
# Dependency install scripts stay off; the packages that have them ship their
# platform binaries as optional dependencies instead.
npm ci --ignore-scripts --no-audit --no-fund
WRANGLER_SEND_METRICS=false npm run --silent typegen >/dev/null
echo 'setup: dependencies installed and Worker types generated'
