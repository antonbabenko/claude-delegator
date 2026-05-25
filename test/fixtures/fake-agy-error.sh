#!/usr/bin/env bash
# Fake agy that reports an agy-style failure: "Error: ..." on STDOUT at exit 0.
# Verifies the bridge treats an stdout Error: sentinel as a failure even though
# the process exits 0.
set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage of agy:"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

echo "Error: timed out waiting for response"
exit 0
