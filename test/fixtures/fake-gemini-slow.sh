#!/usr/bin/env bash
# Fake gemini that sleeps to trigger the bridge timeout.
set -euo pipefail

if [ "${1:-}" = "--version" ]; then
  echo "0.41.2-slow"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv-slow.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv-slow.log}"

# Hang well past the bridge's timeout so the kill path is exercised.
sleep 30
