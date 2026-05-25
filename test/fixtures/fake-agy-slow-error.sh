#!/usr/bin/env bash
# Fake agy that streams a partial line, sleeps past the bridge soft timeout, then
# prints an agy-style "Error:" sentinel on stdout and exits 0 - i.e. a failed run
# whose failure arrives DURING the drain window. Verifies the drain branch never
# returns a partial/failed run as a successful recovery.
#
# Env knobs (set by the harness):
#   FAKE_AGY_SLEEP   seconds to sleep before the Error line (default 3)
set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  echo "Usage of agy:"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

# Partial streamed line first (terminated), then the sentinel on its own line -
# this mirrors agy emitting "Error: <msg>" as a distinct line after streaming.
printf 'partial answer so far\n'
sleep "${FAKE_AGY_SLEEP:-3}"
echo "Error: boom"
exit 0
