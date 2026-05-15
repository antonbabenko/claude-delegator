#!/usr/bin/env bash
# Fake gemini CLI: simulates the timeout-then-late-flush failure mode.
# Sleeps past the bridge soft timeout, then persists an answer to the
# Gemini chat jsonl on disk and exits, mimicking the real CLI ignoring SIGTERM.
#
# Env knobs (set by the test harness):
#   GEMINI_TMP_ROOT   base dir (the bridge's recovery code honors this too)
#   FAKE_GEMINI_NOWRITE=1   exit without writing any jsonl (no-recovery case)
#   FAKE_GEMINI_STALE=1     write a gemini record timestamped in the past
#   FAKE_GEMINI_SLEEP       seconds to sleep before writing (default 2)
set -euo pipefail

if [ "${1:-}" = "--version" ]; then
  echo "0.41.2-fake-timeout-recover"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

sleep "${FAKE_GEMINI_SLEEP:-2}"

if [ "${FAKE_GEMINI_NOWRITE:-}" = "1" ]; then
  exit 0
fi

ROOT="${GEMINI_TMP_ROOT:?GEMINI_TMP_ROOT required}"
SLUG_DIR="$ROOT/test-slug"
CHATS="$SLUG_DIR/chats"
mkdir -p "$CHATS"
printf '%s' "$PWD" > "$SLUG_DIR/.project_root"

if [ "${FAKE_GEMINI_STALE:-}" = "1" ]; then
  TS="2000-01-01T00:00:00.000Z"
else
  TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
fi

SID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
SESSION_FILE="$CHATS/session-$(date -u +%Y-%m-%dT%H-%M)-aaaaaaaa.jsonl"

{
  printf '%s\n' "{\"sessionId\":\"$SID\",\"projectHash\":\"deadbeef\",\"startTime\":\"$TS\",\"lastUpdated\":\"$TS\",\"kind\":\"main\"}"
  printf '%s\n' "{\"id\":\"u1\",\"timestamp\":\"$TS\",\"type\":\"user\",\"content\":\"ping\"}"
  printf '%s\n' "{\"id\":\"g1\",\"timestamp\":\"$TS\",\"type\":\"gemini\",\"content\":\"RECOVERED ANSWER OK\",\"thoughts\":\"\",\"tokens\":1,\"model\":\"fake\"}"
} > "$SESSION_FILE"

exit 0
