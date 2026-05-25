#!/usr/bin/env bash
# Fake agy that prints a banner to stdout, an error to stderr, and exits 1.
# Verifies the bridge surfaces stderr (not the stdout banner) on failure.
set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage of agy:"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

echo "Loaded agy config banner"
echo "Error: not a trusted folder; trust check failed" >&2
exit 1
