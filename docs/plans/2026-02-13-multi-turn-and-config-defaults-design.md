# Design: Multi-Turn Support, Config Defaults, and Model Update

**Date:** 2026-02-13
**Status:** Approved
**Scope:** Surgical updates to existing files (Approach A)

## Problem

The claude-delegator plugin has three gaps discovered through hands-on testing:

1. **Model pinned to gpt-5.2-codex** — Codex CLI now supports gpt-5.3-codex
2. **Stateless claim is incorrect** — `codex-reply` with `threadId` works for multi-turn conversations, but docs say it doesn't
3. **No config.toml documentation** — Users must pass `sandbox`/`approval-policy` per call; global defaults via `~/.codex/config.toml` are undocumented

## Evidence

Tested on 2026-02-13 in a live Claude Code session:

- **Write access**: `mcp__codex__codex` with `sandbox: "workspace-write"` successfully created files
- **Multi-turn**: `mcp__codex__codex` returned `threadId`, then `mcp__codex__codex-reply` with that `threadId` successfully appended to the same file with full context preservation
- **Config defaults**: Added `sandbox = "workspace-write"` and `ask_for_approval = "on-failure"` to `~/.codex/config.toml`; subsequent calls without per-call params used the defaults

## Changes

### 1. Model Version Update (gpt-5.2-codex -> gpt-5.3-codex)

Find-and-replace across all files:
- `config/providers.json`
- `config/mcp-servers.example.json`
- `README.md`
- `CLAUDE.md`
- `commands/setup.md`

### 2. Correct Stateless Claims, Document Multi-Turn

**rules/orchestration.md:**
- Replace "Stateless Design" section with "Session Management" covering both patterns
- Single-shot (default): full context per call, for advisory and one-off tasks
- Multi-turn: `threadId` returned by `codex`, used with `codex-reply` for chained steps
- Update Retry Flow to use `codex-reply` instead of rebuilding context

**CLAUDE.md:**
- Correct "Stateless calls" bullet
- Update architecture description

### 3. Config Defaults Documentation

**rules/orchestration.md:**
- New "Codex Configuration Defaults" section documenting `~/.codex/config.toml`
- Show `sandbox` and `ask_for_approval` keys
- Note per-call params override defaults

**rules/model-selection.md:**
- Expand Codex Parameters Reference table with full param list
- Add `danger-full-access` to sandbox values
- Add `model`, `config`, `approval-policy` params

**README.md:**
- Add "Configuration Defaults" subsection under Configuration
- Add "Multi-Turn Conversations" subsection under How It Works

### 4. No New Files, No Structural Changes

All updates are in-place edits to existing files. Clean diff suitable for upstream PR.

## Files Modified

| File | Changes |
|------|---------|
| `config/providers.json` | Model 5.2 -> 5.3 |
| `config/mcp-servers.example.json` | Model 5.2 -> 5.3 |
| `rules/orchestration.md` | Correct stateless claims, add multi-turn, add config defaults, update retry flow |
| `rules/model-selection.md` | Expand parameters table |
| `README.md` | Model 5.2 -> 5.3, add multi-turn section, add config defaults |
| `CLAUDE.md` | Model 5.2 -> 5.3, correct stateless claim |
| `commands/setup.md` | Model 5.2 -> 5.3 |
