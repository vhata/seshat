#!/usr/bin/env bash
# Repository gates: workflow and documentation checks, then the application's
# generated types, type check, tests and build. `--quick` stops after the type
# check, for the pre-commit hook.
set -euo pipefail
cd "$(dirname "$0")/.."

quick=0
case "${1:-}" in
  '') ;;
  --quick) quick=1 ;;
  *) echo 'usage: bash scripts/check.sh [--quick]' >&2; exit 2 ;;
esac

echo 'check: Bash syntax'
while IFS= read -r -d '' file; do
  case "$file" in
    *.sh|.githooks/*) bash -n "$file" ;;
  esac
done < <(git ls-files --cached --others --exclude-standard -z)

bash docket/scripts/check-queues.sh --strict
bash docket/scripts/check-links.sh

if [ ! -f node_modules/.package-lock.json ]; then
  echo 'check: dependencies are not installed; run bash scripts/setup.sh' >&2
  exit 1
fi
if [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo 'check: package-lock.json changed since install; run bash scripts/setup.sh' >&2
  exit 1
fi

# Gates never report usage to Cloudflare.
export WRANGLER_SEND_METRICS=false

echo 'check: Worker types (wrangler types)'
npm run --silent typegen >/dev/null
echo 'check: type check'
npm run --silent typecheck

if [ "$quick" -eq 1 ]; then
  echo 'check: quick gates passed; tests and build not run'
  exit 0
fi

echo 'check: tests'
npm test --silent
echo 'check: build'
npm run --silent build >/dev/null
echo 'check: all gates passed'
