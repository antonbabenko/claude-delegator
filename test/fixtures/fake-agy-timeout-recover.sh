#!/usr/bin/env bash
# Fake agy that streams a partial line, sleeps past the bridge soft timeout,
# then prints the final answer and exits 0. Exercises the stdout-drain
# recovery path: a slow-but-eventually-clean completion during drain.
#
# Env knobs (set by the harness):
#   FAKE_AGY_SLEEP   seconds to sleep before the final line (default 2)
set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage of agy:"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

# Stream the answer incrementally (proves drain buffers streamed stdout): a
# partial prefix now, the rest after the sleep. Trimmed, the full stdout is
# exactly the final answer "RECOVERED ANSWER OK".
printf 'RECOVERED '
sleep "${FAKE_AGY_SLEEP:-2}"
printf 'ANSWER OK\n'
exit 0
