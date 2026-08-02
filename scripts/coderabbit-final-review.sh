#!/usr/bin/env bash
set -uo pipefail

review_marker="$(git rev-parse --git-path sunder-coderabbit-final-review.started)"

if [[ -e "${review_marker}" ]]; then
  echo "Sunder final CodeRabbit review has already been started in this clone; refusing a second run." >&2
  exit 2
fi

if pgrep -f '[c]oderabbit review' >/dev/null; then
  echo "Another CodeRabbit review process is already active; refusing to overlap runs." >&2
  exit 2
fi

printf '%s\n' "$(date -u +%FT%TZ) $(git rev-parse HEAD)" > "${review_marker}"

set +e
timeout --foreground --signal=INT --kill-after=15s 10m \
  coderabbit review --agent --base main -c AGENTS.md
status=$?
set -e

if [[ ${status} -eq 124 || ${status} -eq 137 ]]; then
  echo "CodeRabbit final review exceeded 10 minutes and was terminated by the watchdog." >&2
  exit 124
fi

exit "${status}"
