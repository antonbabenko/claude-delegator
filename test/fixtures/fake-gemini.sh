#!/usr/bin/env bash
# Fake gemini CLI: records argv to $CDG_ARGV_LOG, emits valid JSON, exits 0.
set -euo pipefail

if [ "${1:-}" = "--version" ]; then
  echo "0.41.2-fake"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

printf '{"response":"FAKE_OK","session_id":"fake-session-123"}\n'
