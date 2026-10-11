#!/usr/bin/env bash
# Documentation/workflow gates; no application test suite exists yet.
set -euo pipefail
cd "$(dirname "$0")/.."

echo 'check: Bash syntax'
while IFS= read -r -d '' file; do
  case "$file" in
    *.sh|.githooks/*) bash -n "$file" ;;
  esac
done < <(git ls-files --cached --others --exclude-standard -z)

bash docket/scripts/check-queues.sh --strict
bash docket/scripts/check-links.sh
echo 'check: scaffold gates passed'
