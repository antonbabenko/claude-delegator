---
name: uninstall
description: Uninstall claude-delegator (remove MCP config and rules)
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
timeout: 30000
---

# Uninstall

Remove claude-delegator from Claude Code.

## Confirm Removal

**Question**: "Remove Codex/Gemini MCP configuration and plugin rules?"
**Options**:
- "Yes, uninstall"
- "No, cancel"

If cancelled, stop here.

## Remove MCP Configuration

```bash
claude mcp remove --scope user codex
claude mcp remove --scope user gemini
```

## Remove Installed Rules

```bash
rm -rf ~/.claude/rules/delegator/
```

## Remove Short Command Aliases (if installed)

Only the four aliases that `/setup` may have copied; the namespaced
`claude-delegator:*` commands are removed by uninstalling the plugin itself.
Ownership-aware: a copied alias is removed only if it is byte-identical to the
plugin's bundled command (so an unrelated user-authored same-named command,
which `/setup` would have skipped rather than overwritten, is left untouched).
```bash
for c in ask-gpt ask-gemini ask-both consensus; do
  dest=~/.claude/commands/$c.md
  src="${CLAUDE_PLUGIN_ROOT}/commands/$c.md"
  if [ ! -e "$dest" ]; then
    continue
  elif [ -f "$src" ] && cmp -s "$src" "$dest"; then
    rm -f "$dest" && echo "removed /$c"
  else
    echo "skip $c: ~/.claude/commands/$c.md differs from plugin copy (left untouched)"
  fi
done
```

## Confirm Completion

```
✓ Removed providers from MCP servers
✓ Removed rules from ~/.claude/rules/delegator/
✓ Removed short command aliases from ~/.claude/commands/ (if present)

To reinstall: /claude-delegator:setup
```
