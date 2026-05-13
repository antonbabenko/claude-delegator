# Delegation

How and when to delegate to external experts via MCP.

## Tools

| Tool | Provider | Use For |
|------|----------|---------|
| `mcp__codex__codex` | GPT | Start new session |
| `mcp__codex__codex-reply` | GPT | Continue session (multi-turn) |
| `mcp__gemini__gemini` | Gemini | Start new session |
| `mcp__gemini__gemini-reply` | Gemini | Continue session (multi-turn) |

## Experts

| Expert | Prompt File | Triggers |
|--------|-------------|----------|
| **Architect** | `${CLAUDE_PLUGIN_ROOT}/prompts/architect.md` | "how should I structure", "tradeoffs of", design questions, 2+ failed fixes |
| **Plan Reviewer** | `${CLAUDE_PLUGIN_ROOT}/prompts/plan-reviewer.md` | "review this plan", before significant work |
| **Scope Analyst** | `${CLAUDE_PLUGIN_ROOT}/prompts/scope-analyst.md` | "clarify the scope", vague requirements |
| **Code Reviewer** | `${CLAUDE_PLUGIN_ROOT}/prompts/code-reviewer.md` | "review this code", "find issues", after implementing features |
| **Security Analyst** | `${CLAUDE_PLUGIN_ROOT}/prompts/security-analyst.md` | "is this secure", "harden this", "vulnerabilities", auth/data changes |

## Trigger Detection (Check EVERY Message)

### Priority Order

1. **Explicit request** — "ask GPT/Gemini to...", "review this code/plan/architecture" → delegate immediately
2. **Security concerns** — auth, sensitive data, new endpoints → Security Analyst
3. **Architecture decisions** — system design, tradeoffs → Architect
4. **Failure escalation** — 2+ failed fix attempts → Architect (fresh perspective)
5. **Default** — handle directly, don't delegate trivial tasks

### When NOT to Delegate

- Simple questions you can answer directly
- First attempt at any fix
- Trivial file operations or decisions
- Research/documentation tasks

---

## Delegation Flow

### Step 1: Match expert from triggers table above

### Step 2: Read expert prompt
```
Read ${CLAUDE_PLUGIN_ROOT}/prompts/[expert].md
```

### Step 3: Determine mode

| Task Type | Mode | Sandbox |
|-----------|------|---------|
| Analysis, review, recommendations | Advisory | `read-only` |
| Make changes, fix issues, implement | Implementation | `workspace-write` |

### Step 4: Notify user
```
Delegating to [Expert Name]: [brief task summary]
```

### Step 5: Build prompt (7-section format)

```
1. TASK: [One sentence — atomic, specific goal]
2. EXPECTED OUTCOME: [What success looks like]
3. CONTEXT:
   - Current state: [what exists now]
   - Relevant code: [paths or snippets]
   - Background: [why this is needed]
4. CONSTRAINTS:
   - Technical: [versions, dependencies]
   - Patterns: [existing conventions]
   - Limitations: [what cannot change]
5. MUST DO:
   - [Requirement 1]
   - [Requirement 2]
6. MUST NOT DO:
   - [Forbidden action 1]
   - [Forbidden action 2]
7. OUTPUT FORMAT:
   - [How to structure response]
```

### Step 6: Call the expert

```typescript
mcp__codex__codex({           // or mcp__gemini__gemini
  prompt: "[7-section prompt]",
  "developer-instructions": "[contents of expert prompt file]",
  sandbox: "[read-only or workspace-write]",
  cwd: "[working directory]"
})
```

### Step 7: Handle response
1. **Synthesize** — never show raw output
2. **Extract insights** — key recommendations, issues, changes
3. **Apply judgment** — experts can be wrong
4. **Verify** — for implementation mode, confirm changes work

---

## Session Patterns

### Single-Shot (default)
Fresh session per call. Include ALL context in the prompt.
**Best for**: advisory reviews, one-off analysis.

### Multi-Turn
Initial call returns `threadId`. Pass to `*-reply` for follow-ups with preserved context.

```typescript
const result = mcp__codex__codex({ prompt: "...", ... })
// result.threadId = "019c58e5-..."

mcp__codex__codex-reply({
  threadId: "019c58e5-...",
  prompt: "Follow-up instruction"
})
```

**Best for**: chained implementation, iterative refinement, retries.

---

## Retry Flow

```
Attempt 1 (initial call) → Verify → [Fail]
  ↓
Attempt 2 (*-reply + error details) → Verify → [Fail]
  ↓
Attempt 3 (*-reply + full history) → Verify → [Fail]
  ↓
Escalate to user
```

---

## Provider Failover

When a provider fails:

1. **Timeout/AbortError** → retry once with shorter prompt or faster model
2. **Still fails** → failover to the other provider with full context
3. **Both fail** → report to user with error details

---

## Anti-Patterns

| Don't | Do |
|-------|----|
| Delegate trivial questions | Answer directly |
| Show raw expert output | Synthesize and interpret |
| Skip reading prompt file | ALWAYS read and inject expert prompt |
| Skip user notification | ALWAYS notify before delegating |
| Retry without error context | Include FULL history |
| Assume cross-session memory | Use `*-reply` for multi-turn |
| Spam multiple delegations | One well-structured call |
