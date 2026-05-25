#!/usr/bin/env bash
# Fake agy that sleeps well past the bridge soft timeout, then prints. Used to
# exercise the bridge timeout path (grace=0 hard kill, or drain failure).
set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage of agy:"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv-slow.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv-slow.log}"

sleep 30
echo "TOO LATE"
