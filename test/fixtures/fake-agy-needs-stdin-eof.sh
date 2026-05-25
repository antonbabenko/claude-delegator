#!/usr/bin/env bash
# Reproduces agy print mode: blocks until stdin reaches EOF, then prints the
# answer. If the bridge leaves agy's stdin pipe open, `cat` never returns and the
# call stalls to the timeout. With stdin set to /dev/null the EOF is immediate.
case "$1" in
  --help) exit 0 ;;
esac
cat >/dev/null 2>&1
echo "STDIN EOF OK"
