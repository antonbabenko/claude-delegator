# Providers

Provider selection, model routing, and parameter reference.

## Provider Selection

1. **Both available**: Default to Gemini. Use Codex when user explicitly asks for "GPT"/"Codex".
2. **One available**: Use it regardless of task type.
3. **Neither available**: Tell user to run `/claude-delegator:setup`.

## Model Auto-Selection

Match the model to the task — don't default to flash for everything.

### Gemini

| Expert / Task | Model | Why |
|---------------|-------|-----|
| Security Analyst | `gemini-2.5-pro` | Deep reasoning, OWASP coverage |
| Architect | `gemini-2.5-pro` | Complex tradeoff analysis |
| Plan Reviewer | `gemini-2.5-pro` | Multi-dimensional evaluation |
| Code Reviewer (large) | `gemini-2.5-pro` | Multi-file context |
| Code Reviewer (small) | `gemini-2.5-flash` | Simple reviews |
| Scope Analyst | `gemini-2.5-flash` | Fast classification |
| Quick advisory | `gemini-2.5-flash` | Short prompts |

**Rule**: prompt >1KB or multiple files → use `pro`.

### Codex (GPT)

All experts default to `gpt-5.3-codex`.

## Operating Modes

| Mode | Sandbox | Use When |
|------|---------|----------|
| **Advisory** | `read-only` | Analysis, reviews, recommendations |
| **Implementation** | `workspace-write` | Changes, fixes, implementation |

Mode is determined by the task, not the expert.

## Parameters

### Codex — `mcp__codex__codex`

| Param | Required | Notes |
|-------|----------|-------|
| `prompt` | Yes | 7-section delegation prompt |
| `developer-instructions` | No | Expert prompt from `prompts/*.md` |
| `sandbox` | No | `read-only` / `workspace-write` / `danger-full-access` |
| `approval-policy` | No | `untrusted` / `on-failure` / `on-request` / `never` |
| `model` | No | Override model (default from config) |
| `cwd` | No | Working directory |
| `config` | No | Override `config.toml` per-call |

### Codex — `mcp__codex__codex-reply`

| Param | Required | Notes |
|-------|----------|-------|
| `threadId` | Yes | From previous `codex` call |
| `prompt` | Yes | Follow-up instruction |

### Gemini — `mcp__gemini__gemini`

| Param | Required | Notes |
|-------|----------|-------|
| `prompt` | Yes | 7-section delegation prompt |
| `developer-instructions` | No | Expert prompt from `prompts/*.md` |
| `sandbox` | No | `read-only` / `workspace-write` |
| `model` | No | Override model (default: `gemini-2.5-flash`) |
| `cwd` | No | Working directory |
| `timeout` | No | Timeout in ms (default: 300000) |

### Gemini — `mcp__gemini__gemini-reply`

| Param | Required | Notes |
|-------|----------|-------|
| `threadId` | Yes | From previous `gemini` call |
| `prompt` | Yes | Follow-up instruction |
| `timeout` | No | Timeout in ms (default: 300000) |

### Response (both)

| Field | Type | Description |
|-------|------|-------------|
| `threadId` | string | Session ID for multi-turn |
| `content` | array | Response content blocks |
