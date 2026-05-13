#!/usr/bin/env bash
# Install orchestration rules to ~/.claude/rules/delegator/
# Removes legacy rule files from previous versions and copies current ones.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RULES_SRC="${SCRIPT_DIR}/../rules"
RULES_DST="${HOME}/.claude/rules/delegator"

LEGACY_FILES=(
  "orchestration.md"
  "triggers.md"
  "delegation-format.md"
  "model-selection.md"
)

mkdir -p "$RULES_DST"

# Remove legacy files that were replaced by consolidated versions
for f in "${LEGACY_FILES[@]}"; do
  target="${RULES_DST}/${f}"
  if [ -f "$target" ]; then
    echo "Removing legacy: ${f}"
    rm "$target"
  fi
done

# Copy current rules
cp "${RULES_SRC}"/*.md "$RULES_DST/"
echo "Installed rules to ${RULES_DST}:"
ls -1 "$RULES_DST"/*.md
