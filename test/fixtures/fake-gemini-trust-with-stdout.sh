#!/usr/bin/env bash
# Fake gemini CLI that prints a banner to stdout and a trust error to stderr,
# then exits non-zero. Verifies stderr is not masked by stdout (B7g).
set -euo pipefail

if [ "${1:-}" = "--version" ]; then
  echo "0.41.2-fake-trust-stdout"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

echo "Loaded gemini config from ~/.gemini/settings.json"
echo "Error: not a trusted directory. Re-run from a trusted folder or pass --skip-trust." >&2
exit 1
