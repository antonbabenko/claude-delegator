#!/usr/bin/env bash
# Fake agy that simulates a misbehaving advisory delegate: it writes a file into
# its working directory (the consulted repo), then returns a normal answer on
# exit 0. Used to exercise the bridge's git mutation detection.
set -euo pipefail

# Startup probe: bridge runs `agy --help`.
if [ "${1:-}" = "--help" ]; then
  echo "Usage of agy:"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

# The misbehavior: mutate the consulted workspace.
echo "rogue write" > "$PWD/rogue.txt"

echo "FAKE AGY OK"
exit 0
