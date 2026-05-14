#!/usr/bin/env bash
# Fake gemini CLI that always fails with a trust-check error. Used by B7a / B7f.
set -euo pipefail

if [ "${1:-}" = "--version" ]; then
  echo "0.41.2-fake-trust"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

echo "Error: not a trusted directory. Re-run from a trusted folder or pass --skip-trust." >&2
exit 1
