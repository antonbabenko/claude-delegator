#!/usr/bin/env bash
# Fake agy (Antigravity CLI): records argv to $CDG_ARGV_LOG, emits plain-text
# answer on stdout, exits 0. Optionally writes the cwd->conversation-id map so
# the bridge's resolveConversationId returns a deterministic id.
set -euo pipefail

# Startup probe: bridge runs `agy --help`.
if [ "${1:-}" = "--help" ]; then
  echo "Usage of agy:"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

# Mimic agy's cwd->id cache so resolveConversationId(effCwd) can find the id.
if [ -n "${AGY_LAST_CONVERSATIONS:-}" ]; then
  printf '{"%s":"11111111-2222-3333-4444-555555555555"}' "$PWD" > "$AGY_LAST_CONVERSATIONS"
fi

echo "FAKE AGY OK"
exit 0
