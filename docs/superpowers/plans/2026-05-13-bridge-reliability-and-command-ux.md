# Bridge Reliability and Command UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the claude-delegator Gemini MCP bridge resilient (timeout, skip-trust, string-aware JSON parsing, enriched error classification, env-driven model default) and make the four ask-* commands report progress and survive single-provider failures.

**Architecture:** Two phases. Phase 1 modifies a single file (`server/gemini/index.js`) on a feature branch in `~/Sites/claude-delegator` and ships as one PR to `antonbabenko/claude-delegator:main` with a version bump to 1.3.0. Phase 2 edits four command markdown files under `~/.claude/commands/` plus the installed `~/.claude/rules/delegator/orchestration.md`. All bridge work is verified with a Node test file that spawns the bridge as a subprocess and pipes JSON-RPC through stdio (zero external deps, matches the bridge's own design).

**Tech Stack:** Node 20+ (built-in `node:test` and `node:assert`), bash, ripgrep (`rg`), `gh` CLI for the PR. No npm install required.

**Convergence record:** This plan converged across 5 rounds of `/agree-both` review (Claude + GPT + Gemini). Round 5 produced unanimous APPROVE. See the round-by-round delta trail at the bottom of this file.

**Out of scope (deliberate, learned from rejected upstream PR #10):**
- Switching bridge output from `-o json` to `-o stream-json` (PR #10 introduced delta/aggregate duplication and a dangling-line-buffer bug).
- Adding `--approval-mode plan` for read-only calls (PR #10 regression: plan mode returns a planning summary instead of executing the prompt).
- Rules consolidation (separate concern).
- Provider-side retry, multi-tenant config, telemetry (Phase 3+).

---

## File Structure

### Phase 1 - Bridge (target repo: `~/Sites/claude-delegator`)

- **Modify:** `server/gemini/index.js` - adds `DEFAULT_TIMEOUT_MS`, `lastJSONObject()`, error classifier, two new schema props (`timeout`, `skip-trust`), env-driven `DEFAULT_MODEL`, kill-timer logic in `runGemini`, enriched `result` payload on errors. Stays zero-dep, stays one file.
- **Modify:** `.claude-plugin/plugin.json` - `version` bump `1.1.0` to `1.3.0`.
- **Modify:** `server/gemini/index.js` - `serverInfo.version` literal `"1.2.1"` to `"1.3.0"`.
- **Create:** `test/bridge.test.js` - uses `node:test`. Spawns the bridge as a child, pipes JSON-RPC, asserts responses.
- **Create:** `test/_helpers.js` - shared helpers for the test file (start bridge, send JSON-RPC, collect responses, parse argv log).
- **Create:** `test/fixtures/fake-gemini.sh` - bash stub that emits a fixed JSON response and records argv.
- **Create:** `test/fixtures/fake-gemini-slow.sh` - bash stub that sleeps to trigger the bridge timeout.
- **Modify or create:** `package.json` - add `"scripts": { "test": "node --test test/" }`.

### Phase 2 - Commands (target dir: `~/.claude/commands/`, no PR - direct edits)

- **Modify:** `ask-gpt.md` - replace hardcoded plugin-cache version with owner-agnostic glob; add inlined fallback prompts for all five experts; replace "Delegating to GPT" notification with the new C3 status line.
- **Modify:** `ask-gemini.md` - same glob + inlined fallbacks + status line; add trust-file pre-flight with B2 capability detection.
- **Modify:** `ask-both.md` - same glob + inlined fallbacks + parallel status line; trust pre-flight; remove "Dispatching parallel" wording.
- **Modify:** `agree-both.md` - same glob + Plan-Reviewer inlined fallback only; parallel status line in the round-header text; add growth cap on `ROUND METADATA`; 1-2s backoff after dual-error rounds.
- **Modify:** `~/.claude/rules/delegator/orchestration.md` - remove or align "Step 4: Notify User" so the single source of truth lives in the command files.

---

## Phase 1: Bridge changes

### Task 0: Branch setup and scaffolding

**Files:**
- Create: `~/Sites/claude-delegator/test/`
- Create: `~/Sites/claude-delegator/test/fixtures/`
- Create: `~/Sites/claude-delegator/package.json` (if absent)

- [ ] **Step 0.1: Confirm working tree is clean and on main**

```bash
cd ~/Sites/claude-delegator && git checkout main && git status -sb
```
Expected: `## main...origin/main` and no unstaged changes.

- [ ] **Step 0.2: Create feature branch**

```bash
git checkout -b feat/bridge-reliability
```
Expected: `Switched to a new branch 'feat/bridge-reliability'`.

- [ ] **Step 0.3: Add or update `package.json` with a test script**

If `~/Sites/claude-delegator/package.json` does not exist, create it with:

```json
{
  "name": "claude-delegator",
  "version": "1.1.0",
  "private": true,
  "scripts": {
    "test": "node --test test/"
  }
}
```

If it exists, add the `scripts.test` entry above without touching other fields.

- [ ] **Step 0.4: Create the fake-gemini stub**

Path: `test/fixtures/fake-gemini.sh`

```bash
#!/usr/bin/env bash
# Fake gemini CLI: records argv to $CDG_ARGV_LOG, emits valid JSON, exits 0.
set -euo pipefail

if [ "${1:-}" = "--version" ]; then
  echo "0.41.2-fake"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

printf '{"response":"FAKE_OK","session_id":"fake-session-123"}\n'
```

Then run `chmod +x test/fixtures/fake-gemini.sh`.

- [ ] **Step 0.5: Create the slow fake-gemini stub**

Path: `test/fixtures/fake-gemini-slow.sh`

```bash
#!/usr/bin/env bash
# Fake gemini that sleeps to trigger the bridge timeout.
set -euo pipefail

if [ "${1:-}" = "--version" ]; then
  echo "0.41.2-slow"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv-slow.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv-slow.log}"

# Hang well past the bridge's timeout so the kill path is exercised.
sleep 30
```

Then run `chmod +x test/fixtures/fake-gemini-slow.sh`.

- [ ] **Step 0.6: Create the test helper**

Path: `test/_helpers.js`

```js
"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const REPO_ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(REPO_ROOT, "server/gemini/index.js");
const FIXTURES = path.join(__dirname, "fixtures");

function startBridge({ env = {}, fakeBin = "fake-gemini.sh" } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-bin-"));
  // Bridge spawns "gemini"; symlink the chosen fixture under that name.
  fs.symlinkSync(path.join(FIXTURES, fakeBin), path.join(tmpDir, "gemini"));
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      PATH: `${tmpDir}:${process.env.PATH}`,
      CDG_ARGV_LOG: path.join(tmpDir, "argv.log"),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.argvLog = path.join(tmpDir, "argv.log");
  child.tmpDir = tmpDir;
  return child;
}

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function collectResponses(child) {
  return new Promise((resolve) => {
    let buf = "";
    const out = [];
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (e) { out.push({ _parseError: e.message, raw: line }); }
      }
    });
    child.on("close", () => {
      if (buf.trim()) { try { out.push(JSON.parse(buf)); } catch (_) {} }
      resolve(out);
    });
  });
}

function readArgv(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath);
  // Each invocation: NUL-separated args terminated by '\n'.
  const invocations = [];
  let cur = [];
  let acc = "";
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (b === 0x00) { cur.push(acc); acc = ""; }
    else if (b === 0x0a) { invocations.push(cur); cur = []; }
    else acc += String.fromCharCode(b);
  }
  if (acc || cur.length) invocations.push([...cur, acc].filter(Boolean));
  return invocations;
}

module.exports = { startBridge, send, collectResponses, readArgv };
```

- [ ] **Step 0.7: Commit scaffolding**

```bash
cd ~/Sites/claude-delegator
git add package.json test/_helpers.js test/fixtures/fake-gemini.sh test/fixtures/fake-gemini-slow.sh
git commit -m "test: add bridge test harness scaffolding"
```
Expected: one new commit listing four files.

---

### Task 1: B1 - Timeout (write test first)

**Files:**
- Create: `test/bridge.test.js` (add timeout test case)
- Modify: `server/gemini/index.js`

- [ ] **Step 1.1: Write the failing test**

Path: `test/bridge.test.js` (create the file)

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startBridge, send, collectResponses } = require("./_helpers.js");

test("B1: timeout kills slow gemini and surfaces structured error", async () => {
  const child = startBridge({ fakeBin: "fake-gemini-slow.sh" });
  const responsesP = collectResponses(child);
  const t0 = Date.now();

  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "slow", timeout: 500 } },
  });

  // Close stdin shortly after sending; bridge should still complete via its timeout.
  setTimeout(() => child.stdin.end(), 3000);
  const responses = await responsesP;
  const elapsed = Date.now() - t0;

  const callRes = responses.find((r) => r.id === 2);
  assert.ok(callRes, "got a tools/call response");
  assert.equal(callRes.result.isError, true, "isError");
  assert.equal(callRes.result.errorKind, "timeout", "errorKind");
  assert.equal(callRes.result.retryable, true, "retryable");
  assert.ok(elapsed < 3500, "bridge returned within 3.5s, got " + elapsed + "ms");
});
```

- [ ] **Step 1.2: Run the test and verify it FAILS**

```bash
cd ~/Sites/claude-delegator && npm test 2>&1 | tail -30
```
Expected: failure mentioning either a hang, missing `errorKind`, or missing `timeout` / `retryable` fields. (The current bridge has no timeout, no errorKind.)

- [ ] **Step 1.3: Add the `DEFAULT_TIMEOUT_MS` constant**

Edit `server/gemini/index.js`. Locate the constants block near the top (search for `DEFAULT_MODEL`). Add a new line directly below `DEFAULT_MODEL`:

```js
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
```

- [ ] **Step 1.4: Add `timeout` to both inputSchemas**

Edit `server/gemini/index.js`. In the `tools/list` handler, locate the `gemini` tool's `inputSchema.properties` block and append this property after `model`:

```js
timeout: { type: "number", description: "Bridge-side timeout in ms before SIGTERM. 1..600000. Default 120000.", default: DEFAULT_TIMEOUT_MS },
```

Then in the same `tools/list` handler, locate the `gemini-reply` tool's `inputSchema.properties` block and add the same `timeout` property after `cwd`.

- [ ] **Step 1.5: Add `timeout` validation to the shared params block**

In the `tools/call` handler, immediately after the existing `cwd` validation, add:

```js
if (args.timeout !== undefined) {
  if (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout > 600_000) {
    if (shouldRespond) sendError(id, -32602, "Invalid params: 'timeout' must be a number > 0 and <= 600000 milliseconds");
    return;
  }
}
```

- [ ] **Step 1.6: Thread `timeoutMs` into `runGemini`**

Change the `runGemini` signature from `async function runGemini(args, cwd)` to `async function runGemini(args, cwd, timeoutMs)`.

At the top of the `new Promise(...)` body, before `const geminiProcess = spawn(...)`, add:

```js
const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT_MS;
let killed = false;
let graceTimer = null;
```

Immediately after the `spawn(...)` line, add:

```js
const killTimer = setTimeout(() => {
  killed = true;
  try { geminiProcess.kill("SIGTERM"); } catch (_) {}
  graceTimer = setTimeout(() => {
    try { geminiProcess.kill("SIGKILL"); } catch (_) {}
  }, 1_000);
}, t);
function clearTimers() { clearTimeout(killTimer); if (graceTimer) clearTimeout(graceTimer); }
geminiProcess.on("close", clearTimers);
geminiProcess.on("error", clearTimers);
```

Then in the existing `geminiProcess.on("close", (code) => { ... })` handler, prepend a killed-check branch so the killed path is evaluated FIRST:

```js
geminiProcess.on("close", (code) => {
  if (killed) {
    const err = new Error("Gemini timed out after " + Math.round(t / 1000) + "s");
    err.code = "timeout";
    return reject(err);
  }
  // ... existing handler body unchanged below
});
```

- [ ] **Step 1.7: Pass timeout from `tools/call` to `runGemini`**

In the `tools/call` handler, locate the existing line:

```js
const { response, threadId } = await runGemini(geminiArgs, args.cwd);
```

Replace with:

```js
const timeoutMs = (typeof args.timeout === "number" && args.timeout > 0) ? args.timeout : DEFAULT_TIMEOUT_MS;
const { response, threadId } = await runGemini(geminiArgs, args.cwd, timeoutMs);
```

Explicit `??`-style fallback at the call site, not relying on schema-default propagation. (Round-5 GPT recommendation folded in.)

- [ ] **Step 1.8: Enrich the catch in `tools/call` for timeout**

In the `catch (e)` block at the bottom of `tools/call`, replace:

```js
sendResponse(id, {
  content: [{ type: "text", text: `Error: ${e.message}` }],
  isError: true
});
```

with:

```js
const errMsg = (e && e.message) || String(e);
const errorKind = (e && e.code === "timeout") ? "timeout" : "unknown";
const retryable = errorKind === "timeout";
sendResponse(id, {
  content: [{ type: "text", text: `Error: ${errMsg}` }],
  isError: true,
  errorKind,
  retryable,
});
```

(Task 4 expands the kind classifier; for now timeout vs unknown is enough to pass Step 1.1.)

- [ ] **Step 1.9: Run the test and verify it PASSES**

```bash
cd ~/Sites/claude-delegator && npm test 2>&1 | tail -15
```
Expected: `# pass 1` in the test summary.

- [ ] **Step 1.10: Commit**

```bash
git add server/gemini/index.js test/bridge.test.js
git commit -m "feat(bridge): add timeout with SIGTERM/SIGKILL escalation"
```

---

### Task 2: B2 - skip-trust passthrough

**Files:**
- Modify: `test/bridge.test.js`
- Modify: `server/gemini/index.js`

- [ ] **Step 2.1: Write the failing tests**

Append to `test/bridge.test.js`:

```js
const { readArgv } = require("./_helpers.js");

test("B2: skip-trust true pushes --skip-trust into argv", async () => {
  const child = startBridge({ fakeBin: "fake-gemini.sh" });
  const responsesP = collectResponses(child);

  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi", "skip-trust": true } },
  });
  setTimeout(() => child.stdin.end(), 800);
  await responsesP;

  const invocations = readArgv(child.argvLog);
  assert.ok(invocations.length >= 1, "at least one gemini invocation captured");
  assert.ok(invocations[0].includes("--skip-trust"), "argv contains --skip-trust");
});

test("B2: skip-trust omitted does not push --skip-trust", async () => {
  const child = startBridge({ fakeBin: "fake-gemini.sh" });
  const responsesP = collectResponses(child);

  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi" } },
  });
  setTimeout(() => child.stdin.end(), 800);
  await responsesP;

  const invocations = readArgv(child.argvLog);
  assert.ok(!invocations[0].includes("--skip-trust"), "argv does not contain --skip-trust");
});

test("B2: skip-trust non-boolean returns -32602", async () => {
  const child = startBridge({ fakeBin: "fake-gemini.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi", "skip-trust": "yes" } },
  });
  setTimeout(() => child.stdin.end(), 800);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.error && r.error.code, -32602);
});
```

- [ ] **Step 2.2: Run the tests and verify they FAIL**

```bash
npm test 2>&1 | tail -20
```
Expected: three new failures - `--skip-trust` not in argv, params not validated.

- [ ] **Step 2.3: Add `skip-trust` to both inputSchemas**

In `tools/list`, append to BOTH `gemini` and `gemini-reply` `inputSchema.properties` blocks (after the `timeout` prop added in Task 1):

```js
"skip-trust": { type: "boolean", description: "Pass --skip-trust to bypass the Gemini CLI's trusted-directory check. Read-only sandbox is still gated separately.", default: false },
```

- [ ] **Step 2.4: Add validation in the shared params block**

Immediately after the `timeout` validation block from Task 1, add:

```js
if (args["skip-trust"] !== undefined && typeof args["skip-trust"] !== "boolean") {
  if (shouldRespond) sendError(id, -32602, "Invalid params: 'skip-trust' must be a boolean when provided");
  return;
}
```

- [ ] **Step 2.5: Wire `--skip-trust` into both name branches**

In the `gemini` branch (inside `if (name === "gemini") { ... }`), find the line `if (args.sandbox === "workspace-write") geminiArgs.push("-s");` and add immediately BEFORE it:

```js
if (args["skip-trust"] === true) geminiArgs.push("--skip-trust");
```

Apply the same insertion in the `gemini-reply` branch, immediately before its `if (args.sandbox === "workspace-write")` line.

- [ ] **Step 2.6: Run the tests and verify they PASS**

```bash
npm test 2>&1 | tail -15
```
Expected: all four tests passing (`# pass 4`).

- [ ] **Step 2.7: Commit**

```bash
git add server/gemini/index.js test/bridge.test.js
git commit -m "feat(bridge): add skip-trust passthrough flag"
```

---

### Task 3: B4 - String-aware balanced-brace JSON scanner

**Files:**
- Modify: `test/bridge.test.js`
- Modify: `server/gemini/index.js`

- [ ] **Step 3.1: Write the failing unit tests for `lastJSONObject`**

Append to `test/bridge.test.js`:

```js
// Pure-function unit tests for the parser helper. We re-require the bridge module fresh.
// We expose lastJSONObject via module exports for testing only - see Step 3.3.
test("B4: lastJSONObject returns the trailing valid object", () => {
  const { lastJSONObject } = require("../server/gemini/index.js");
  const s = 'warning: {"foo": 1}\n{"response":"ok","session_id":"x"}\n';
  assert.equal(lastJSONObject(s), '{"response":"ok","session_id":"x"}');
});

test("B4: lastJSONObject handles brace inside JSON string", () => {
  const { lastJSONObject } = require("../server/gemini/index.js");
  const s = '{"response":"} text","session_id":"y"}\ntrailing junk';
  assert.equal(lastJSONObject(s), '{"response":"} text","session_id":"y"}');
});

test("B4: lastJSONObject returns the outer object, not inner", () => {
  const { lastJSONObject } = require("../server/gemini/index.js");
  const s = '{"outer":{"inner":1}}';
  assert.equal(lastJSONObject(s), '{"outer":{"inner":1}}');
});

test("B4: lastJSONObject tolerates noisy preamble", () => {
  const { lastJSONObject } = require("../server/gemini/index.js");
  const s = 'junk \\ unmatched } "quoted" prefix\n{"response":"ok","session_id":"z"}\n';
  assert.equal(lastJSONObject(s), '{"response":"ok","session_id":"z"}');
});

test("B4: lastJSONObject returns null on no object", () => {
  const { lastJSONObject } = require("../server/gemini/index.js");
  assert.equal(lastJSONObject("no json here"), null);
});
```

- [ ] **Step 3.2: Run the tests and verify they FAIL**

```bash
npm test 2>&1 | tail -25
```
Expected: failure on `lastJSONObject is not a function` (helper does not exist yet, and the bridge is currently not a CommonJS module that exports anything).

- [ ] **Step 3.3: Add the helper and export it for tests**

Edit `server/gemini/index.js`. Find the `runGemini` function declaration. Immediately ABOVE it, insert:

```js
function lastJSONObject(s) {
  const spans = [];
  let depth = 0, start = -1, inStr = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (depth === 0) {
      // Outside any candidate object: only `{` is meaningful. Reset string state.
      inStr = false; escape = false;
      if (c === "{") { depth = 1; start = i; }
      continue;
    }
    // depth >= 1: track string + escape per JSON grammar
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") { depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        spans.push([start, i]);
        start = -1;
      } else if (depth < 0) {
        // Defensive: floor at 0, abandon the candidate.
        depth = 0; start = -1;
      }
    }
  }
  if (!spans.length) return null;
  const [a, b] = spans[spans.length - 1];
  return s.slice(a, b + 1);
}
```

At the very bottom of `server/gemini/index.js`, add:

```js
// Test-only exports
if (typeof module !== "undefined" && module.exports) {
  module.exports.lastJSONObject = lastJSONObject;
}
```

- [ ] **Step 3.4: Replace the greedy regex with `lastJSONObject`**

In `runGemini`, locate the existing block:

```js
try {
  // Extract JSON block (ignoring potential terminal noise)
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON response found");

  const data = JSON.parse(jsonMatch[0]);
  resolve({
    response: data.response || "(No output)",
    threadId: data.session_id || "unknown"
  });
} catch (e) {
  reject(new Error(`Parse error: ${e.message}\nRaw output was: ${stdout}`));
}
```

Replace with:

```js
try {
  const jsonStr = lastJSONObject(stdout);
  if (!jsonStr) throw new Error("No JSON response found");
  const data = JSON.parse(jsonStr);
  resolve({
    response: data.response || "(No output)",
    threadId: data.session_id || "unknown"
  });
} catch (e) {
  const err = new Error(`Parse error: ${e.message}\nRaw output was: ${stdout}`);
  err.code = "parse";
  reject(err);
}
```

The `err.code = "parse"` is consumed by the B5 classifier in Task 4. (Round-5 Gemini recommendation folded in: parse failures flow through the enriched-error pipeline.)

- [ ] **Step 3.5: Make the bridge safely importable for tests**

The bridge starts a side-effect at module load (the `gemini --version` execSync probe) and another at module load (the stdin handler). Both need to be guarded so the unit tests can `require()` the file without triggering them.

In `server/gemini/index.js`, locate the bottom block:

```js
// Startup Check
try {
  execSync("gemini --version", { stdio: "ignore" });
} catch (e) {
  console.error("Gemini CLI not found. Please install it first.");
  process.exit(1);
}
```

Wrap it so it only runs when the script is the entry point AND a `--no-startup-check` flag is absent:

```js
if (require.main === module && !process.argv.includes("--no-startup-check")) {
  try {
    execSync("gemini --version", { stdio: "ignore" });
  } catch (e) {
    console.error("Gemini CLI not found. Please install it first.");
    process.exit(1);
  }
}
```

Then locate the `process.stdin.on("data", ...)` block earlier in the file (the JSON-RPC main loop) and wrap THAT in `if (require.main === module) { ... }` too so importing the file does not consume stdin.

The spawn-based integration tests are unaffected: the fake-gemini fixtures answer `--version` correctly, and the harness drives the bridge as a child process where `require.main === module` is true.

- [ ] **Step 3.6: Run the tests and verify they PASS**

```bash
npm test 2>&1 | tail -25
```
Expected: all nine tests now passing (`# pass 9`).

- [ ] **Step 3.7: Commit**

```bash
git add server/gemini/index.js test/bridge.test.js
git commit -m "feat(bridge): replace greedy JSON regex with string-aware scanner"
```

---

### Task 4: B5 - Full error classifier on enriched result

**Files:**
- Modify: `test/bridge.test.js`
- Modify: `server/gemini/index.js`

- [ ] **Step 4.1: Write the failing test**

Append to `test/bridge.test.js`:

```js
test("B5: parse failures surface errorKind 'parse' with retryable false", async () => {
  // Use an ad-hoc stub that emits non-JSON garbage.
  const path = require("node:path");
  const fs = require("node:fs");
  const os = require("node:os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-junk-"));
  fs.writeFileSync(path.join(tmpDir, "gemini"), '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "0.0.0-junk"; exit 0; fi\necho "no JSON anywhere here just plain text"\n', { mode: 0o755 });

  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, [require.resolve("../server/gemini/index.js")], {
    env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "junk" } },
  });
  setTimeout(() => child.stdin.end(), 1000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.errorKind, "parse");
  assert.equal(r.result.retryable, false);
});
```

- [ ] **Step 4.2: Run the test and verify it FAILS**

```bash
npm test 2>&1 | tail -10
```
Expected: failure on missing `errorKind === "parse"` (the catch in Task 1 only handles "timeout").

- [ ] **Step 4.3: Replace the catch block with the full classifier**

In `server/gemini/index.js`, locate the catch block at the bottom of `tools/call` that you edited in Step 1.8. Replace the whole block with:

```js
} catch (e) {
  const errMsg = (e && e.message) || String(e);
  const errCode = e && e.code;
  let errorKind = "unknown", retryable = false;
  if (errCode === "timeout") { errorKind = "timeout"; retryable = true; }
  else if (errCode === "parse") { errorKind = "parse"; retryable = false; }
  else if (errMsg.includes("trusted directory")) { errorKind = "trust"; retryable = false; }
  else if (errMsg.includes("Gemini CLI not found")) { errorKind = "missing-cli"; retryable = false; }
  else if (errMsg.includes("AbortError") || errMsg.includes("aborted")) { errorKind = "upstream-abort"; retryable = true; }

  if (shouldRespond) {
    sendResponse(id, {
      content: [{ type: "text", text: `Error: ${errMsg}` }],
      isError: true,
      errorKind,
      retryable,
    });
  }
}
```

`missing-cli` here covers RUNTIME loss (the binary disappears between bridge startup and a `tools/call`). Startup-time loss is still fatal via the unchanged `execSync` probe.

- [ ] **Step 4.4: Run the tests and verify all PASS**

```bash
npm test 2>&1 | tail -15
```
Expected: ten tests passing.

- [ ] **Step 4.5: Commit**

```bash
git add server/gemini/index.js test/bridge.test.js
git commit -m "feat(bridge): classify bridge-side errors with errorKind and retryable"
```

---

### Task 5: B6 - Default model via env var

**Files:**
- Modify: `test/bridge.test.js`
- Modify: `server/gemini/index.js`

- [ ] **Step 5.1: Write the failing tests**

Append to `test/bridge.test.js`:

```js
test("B6: GEMINI_DEFAULT_MODEL env overrides the default model", async () => {
  const child = startBridge({
    fakeBin: "fake-gemini.sh",
    env: { GEMINI_DEFAULT_MODEL: "auto-gemini-3" },
  });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi" } },
  });
  setTimeout(() => child.stdin.end(), 800);
  await responsesP;

  const invocations = readArgv(child.argvLog);
  const argv = invocations[0];
  const mIdx = argv.indexOf("-m");
  assert.notEqual(mIdx, -1, "argv contains -m");
  assert.equal(argv[mIdx + 1], "auto-gemini-3", "model is auto-gemini-3");
});

test("B6: unset env falls back to gemini-2.5-flash", async () => {
  const child = startBridge({ fakeBin: "fake-gemini.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi" } },
  });
  setTimeout(() => child.stdin.end(), 800);
  await responsesP;

  const invocations = readArgv(child.argvLog);
  const argv = invocations[0];
  const mIdx = argv.indexOf("-m");
  assert.equal(argv[mIdx + 1], "gemini-2.5-flash");
});
```

- [ ] **Step 5.2: Run the tests and verify they FAIL**

```bash
npm test 2>&1 | tail -10
```
Expected: the auto-gemini-3 test fails because the bridge ignores the env var. The fallback test passes (current default already is gemini-2.5-flash).

- [ ] **Step 5.3: Edit the `DEFAULT_MODEL` line**

Find:

```js
const DEFAULT_MODEL = "gemini-2.5-flash";
```

Replace with:

```js
const DEFAULT_MODEL = process.env.GEMINI_DEFAULT_MODEL || "gemini-2.5-flash";
```

Per-call `args.model` still overrides; no further changes needed.

- [ ] **Step 5.4: Run the tests and verify PASS**

```bash
npm test 2>&1 | tail -10
```
Expected: twelve tests passing.

- [ ] **Step 5.5: Commit**

```bash
git add server/gemini/index.js test/bridge.test.js
git commit -m "feat(bridge): read default model from GEMINI_DEFAULT_MODEL env"
```

---

### Task 6: Version bump to 1.3.0

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `server/gemini/index.js`
- Modify: `package.json`

- [ ] **Step 6.1: Bump `plugin.json` version**

Edit `.claude-plugin/plugin.json`. Find `"version": "1.1.0"` and change to `"version": "1.3.0"`.

- [ ] **Step 6.2: Bump the literal `serverInfo.version` in the bridge**

Edit `server/gemini/index.js`. Find the `serverInfo: { name: "claude-delegator-gemini", version: "1.2.1" }` line and change to `version: "1.3.0"`.

- [ ] **Step 6.3: Bump `package.json` version**

Edit `package.json`. Change `"version": "1.1.0"` to `"version": "1.3.0"`.

- [ ] **Step 6.4: Run the tests to confirm no regression**

```bash
npm test 2>&1 | tail -10
```
Expected: still twelve tests passing.

- [ ] **Step 6.5: Commit**

```bash
git add .claude-plugin/plugin.json server/gemini/index.js package.json
git commit -m "chore: bump to 1.3.0 (bridge reliability)"
```

---

### Task 7: Open Phase 1 PR

**Files:** none

- [ ] **Step 7.1: Push the branch**

```bash
cd ~/Sites/claude-delegator
git push -u origin feat/bridge-reliability
```

- [ ] **Step 7.2: Open the PR via `gh`**

```bash
gh pr create --title "feat: bridge reliability (timeout, skip-trust, robust parser, error classification, model default)" --body "$(cat <<'EOF'
## Summary

Hardens the Gemini MCP bridge with the smallest viable set of fixes:

- **B1** Per-call timeout with SIGTERM then SIGKILL escalation. Defaults to 2 min; per-call override via `timeout` param (1..600000 ms).
- **B2** `skip-trust` passthrough so callers can opt out of the Gemini CLI's trusted-directory check explicitly.
- **B4** String-aware balanced-brace JSON extractor replaces the greedy regex parser.
- **B5** Bridge-side errors are classified into `errorKind` and `retryable` fields on the existing `result.isError` payload (backwards compatible).
- **B6** `GEMINI_DEFAULT_MODEL` env var controls the default model; per-call `model` still wins.

Bumps version to 1.3.0.

## Out of scope

- `-o stream-json` (regression history; see internal review of upstream PR #10).
- `--approval-mode plan` for read-only (regression).

## Test plan

- [ ] `npm test` passes (twelve assertions across timeout, skip-trust, parser, classifier, model default).
- [ ] Manual: from an untrusted cwd, calling the bridge with `skip-trust: true` succeeds where it currently fails with the "not in trusted directory" error.
- [ ] Manual: a 500 ms timeout against a stub gemini that sleeps 5 s returns `result.errorKind: "timeout"` within ~1.6 s, no orphan child process.
EOF
)"
```

- [ ] **Step 7.3: Record the PR URL**

`gh` prints the PR URL. Save it for the merge step.

---

## Phase 2: Command changes

Phase 2 has no compile step. Each step is an edit plus a `rg` or read-back verification. Phase 2 depends on Phase 1 being merged AND installed; the `agree-both.md` file already exists under `~/.claude/commands/agree-both.md`.

### Task 8: Detect whether `~/.claude` is git-managed

**Files:** none (decision step)

- [ ] **Step 8.1: Check**

```bash
git -C ~/.claude rev-parse --is-inside-work-tree 2>/dev/null || echo "not a repo"
```
Expected: either `true` (commit changes per file) or `not a repo` (save changes without committing). Record which one for use in later steps.

---

### Task 9: C1 - Owner-agnostic plugin cache glob with role-preserving fallback

**Files:**
- Modify: `~/.claude/commands/ask-gpt.md`
- Modify: `~/.claude/commands/ask-gemini.md`
- Modify: `~/.claude/commands/ask-both.md`
- Modify: `~/.claude/commands/agree-both.md`

- [ ] **Step 9.1: Update `ask-gpt.md` - cache glob**

In `~/.claude/commands/ask-gpt.md`, find the step labeled "Read expert prompt from `~/.claude/plugins/cache/jarrodwatts-claude-delegator/claude-delegator/1.1.0/prompts/[expert].md`" and replace its body with:

```markdown
2. **Read expert prompt** via this resolution sequence:
   1. Glob `~/.claude/plugins/cache/*claude-delegator/claude-delegator/*/prompts/[expert].md`. Pick the match with the highest semver version segment (the segment immediately after `claude-delegator/`, parsed as semver - not lexical string compare).
   2. If no match, look up the inlined fallback under the heading `## Inlined fallback - [Expert]` in this command file (see end of this file).
   3. If neither found, abort with: `Error: claude-delegator plugin cache missing for expert "[Expert]". Run /plugin install claude-delegator or /reload-plugins.`
```

- [ ] **Step 9.2: Append inlined-fallback blocks to `ask-gpt.md`**

At the bottom of `~/.claude/commands/ask-gpt.md`, append:

```markdown

<!-- DO NOT DELETE: required fallback if plugin cache missing. See C1 in implementation plan. -->

## Inlined fallback - Architect

[Paste the full contents of `~/.claude/plugins/cache/jarrodwatts-claude-delegator/claude-delegator/1.1.0/prompts/architect.md` here, verbatim.]

## Inlined fallback - Code Reviewer

[Paste the full contents of `prompts/code-reviewer.md` verbatim.]

## Inlined fallback - Security Analyst

[Paste the full contents of `prompts/security-analyst.md` verbatim.]

## Inlined fallback - Plan Reviewer

[Paste the full contents of `prompts/plan-reviewer.md` verbatim.]

## Inlined fallback - Scope Analyst

[Paste the full contents of `prompts/scope-analyst.md` verbatim.]
```

To get the actual content:

```bash
for f in architect code-reviewer security-analyst plan-reviewer scope-analyst; do
  echo "--- $f ---"
  cat ~/.claude/plugins/cache/jarrodwatts-claude-delegator/claude-delegator/1.1.0/prompts/$f.md
  echo
done
```

Copy each body under the matching heading. Keep the `<!-- DO NOT DELETE -->` comment.

- [ ] **Step 9.3: Apply the same change to `ask-gemini.md`**

Repeat Steps 9.1 and 9.2 in `~/.claude/commands/ask-gemini.md`, with the same five inlined experts.

- [ ] **Step 9.4: Apply the same change to `ask-both.md`**

Repeat in `~/.claude/commands/ask-both.md`, same five inlined experts.

- [ ] **Step 9.5: Apply a narrower change to `agree-both.md`**

In `~/.claude/commands/agree-both.md`, update the "Read expert prompt ONCE from ..." step in the Setup section to use the same resolution sequence as Step 9.1. Append at the bottom only ONE inlined-fallback block (Plan Reviewer) because that is the default and recommended expert for this command.

- [ ] **Step 9.6: Verify with `rg`**

```bash
rg "claude-delegator/1.1.0" ~/.claude/commands/*.md
```
Expected: no matches.

```bash
rg "Inlined fallback - " ~/.claude/commands/*.md | wc -l
```
Expected: 16 (5 experts in each of ask-gpt, ask-gemini, ask-both = 15; plus 1 in agree-both = 16).

- [ ] **Step 9.7: Commit (if `~/.claude` is git-managed)**

```bash
git -C ~/.claude add commands/ask-gpt.md commands/ask-gemini.md commands/ask-both.md commands/agree-both.md
git -C ~/.claude commit -m "chore(commands): owner-agnostic cache glob with inlined fallbacks"
```

Otherwise (not a repo): no commit needed - saves are persistent.

---

### Task 10: C2 - Trusted cwd preservation + B2 capability detection

**Files:**
- Modify: `~/.claude/commands/ask-gemini.md`
- Modify: `~/.claude/commands/ask-both.md`
- Modify: `~/.claude/commands/agree-both.md`

- [ ] **Step 10.1: Add a pre-flight section to `ask-gemini.md`**

Insert a new step BEFORE the "Call Gemini" step:

```markdown
4. **Pre-flight cwd trust check**:
   - Always use `process.cwd()` as the MCP `cwd` argument; NEVER switch folders.
   - Detect B2 (skip-trust) support: glob `~/.claude/plugins/cache/*claude-delegator/claude-delegator/*/.claude-plugin/plugin.json`, parse the highest-semver match, treat `version >= "1.3.0"` (semver compare) as B2-supported. On parse error or no match: treat as B2 absent.
   - Try reading `~/.gemini/trustedFolders.json`. On any error (ENOENT, EACCES, SyntaxError, value not an object): treat the trusted set as EMPTY and emit a one-line warning to stderr including the specific error message (for example `trustedFolders.json unreadable: ENOENT: no such file`).
   - Build trusted-set = direct keys plus all descendants of keys whose value is `"TRUST_PARENT"`. Normalize paths first: resolve `~`, follow symlinks, strip trailing slashes (use `path.resolve` plus `fs.realpathSync` semantics).
   - If `process.cwd()` (normalized) is in trusted-set: call as today.
   - Else if B2 is supported: set `"skip-trust": true` on the call.
   - Else: abort with: `Error: cwd "${process.cwd()}" not in trustedFolders.json; trust it via `gemini` once, or upgrade claude-delegator to 1.3.0+ for skip-trust support.`
```

- [ ] **Step 10.2: Apply the same pre-flight in `ask-both.md`**

Add the same pre-flight section before the "Parallel dispatch" step.

- [ ] **Step 10.3: Apply the same pre-flight in `agree-both.md`**

`agree-both.md` already has a setup step that mentions trusted folders; update it to match the C2 pre-flight verbatim, including B2 detection and the abort path. Replace the prior "if process.cwd() is listed; otherwise fall back to a known-trusted folder" wording - that fallback was the wrong design and is removed.

- [ ] **Step 10.4: Verify with `rg`**

```bash
rg "fall back to a known-trusted folder|first trusted folder" ~/.claude/commands/*.md
```
Expected: no matches.

```bash
rg "skip-trust.*true" ~/.claude/commands/*.md | wc -l
```
Expected: at least 3 (one per file).

- [ ] **Step 10.5: Commit (if applicable)**

```bash
git -C ~/.claude add commands/ask-gemini.md commands/ask-both.md commands/agree-both.md
git -C ~/.claude commit -m "chore(commands): preserve cwd; detect B2; handle missing trustedFolders.json"
```

---

### Task 11: C3 - Pre-dispatch status line

**Files:**
- Modify: `~/.claude/commands/ask-gpt.md`
- Modify: `~/.claude/commands/ask-gemini.md`
- Modify: `~/.claude/commands/ask-both.md`
- Modify: `~/.claude/commands/agree-both.md`
- Modify: `~/.claude/rules/delegator/orchestration.md`

- [ ] **Step 11.1: Replace the "Notify user" rule in `ask-gpt.md`**

In `~/.claude/commands/ask-gpt.md` under the "Rules" section, replace:

```
- **Notify user** before delegating: `Delegating to GPT ([Expert]): [task summary]`
```

with:

```
- **Print status line** immediately before the MCP dispatch: `Codex working (typical 30-60s)...`
```

- [ ] **Step 11.2: Replace the "Notify user" rule in `ask-gemini.md`**

Same change with `Gemini working (typical 30-60s)...` instead.

- [ ] **Step 11.3: Replace step 4 of `ask-both.md`**

Find the step that reads `**Notify user**: \`Dispatching parallel: GPT ([Expert]) + Gemini ([Expert])\`` and replace with:

```markdown
4. **Print status line**: `Codex + Gemini working in parallel (typical 30-60s)...`
```

- [ ] **Step 11.4: Replace the round-header text in `agree-both.md`**

Find the line `--- Round R/5 --- dispatching parallel review` (in the Round-loop section) and change the trailing text to:

```
--- Round R/5 --- Codex + Gemini working in parallel (typical 30-60s)...
```

- [ ] **Step 11.5: Update `orchestration.md`**

Open `~/.claude/rules/delegator/orchestration.md` and find "Step 4: Notify User". Replace its body with:

```markdown
Status line is owned by each command file (see ask-gpt.md, ask-gemini.md, ask-both.md, agree-both.md). Commands print exactly one line immediately before the MCP tool dispatch:

- single-provider: `Codex working (typical 30-60s)...` or `Gemini working (typical 30-60s)...`
- parallel: `Codex + Gemini working in parallel (typical 30-60s)...`

This rule file no longer defines the wording. The command files are the source of truth.
```

- [ ] **Step 11.6: Verify with `rg`**

```bash
rg "Delegating to|Dispatching parallel|Notify user before delegating" ~/.claude/commands/*.md ~/.claude/rules/delegator/orchestration.md
```
Expected: no matches.

```bash
rg "Codex working|Gemini working|Codex \+ Gemini working" ~/.claude/commands/*.md | wc -l
```
Expected: at least 4 (one status line per command).

- [ ] **Step 11.7: Commit (if applicable)**

```bash
git -C ~/.claude add commands/ rules/delegator/orchestration.md
git -C ~/.claude commit -m "chore(commands): replace 'Delegating to'/'Dispatching parallel' with status line"
```

---

### Task 12: C4 - agree-both prompt growth cap + inter-round backoff

**Files:**
- Modify: `~/.claude/commands/agree-both.md`

- [ ] **Step 12.1: Cap the ROUND METADATA section**

In `~/.claude/commands/agree-both.md`, locate the "Build identical review prompt" step inside the "Round loop". Under the **ROUND METADATA** sub-bullet, add:

```markdown
   - **Round metadata is BOUNDED**: include the last 2 rounds verbatim; for any rounds older than that, include only a one-line summary of each (verdict + applied-change phrase). This prevents prompt-length growth across 5 rounds.
```

- [ ] **Step 12.2: Add the dual-error backoff**

At the end of the round-loop section (after the "Continue to round R+1" instruction), add:

```markdown
   - **Backoff after dual error**: if BOTH providers returned a provider-error in round R (not a regular REQUEST CHANGES verdict, but an MCP error or `result.isError`), wait 1-2 seconds before dispatching round R+1 to let transient API hiccups clear.
```

- [ ] **Step 12.3: Verify**

```bash
rg "Round metadata is BOUNDED|Backoff after dual error" ~/.claude/commands/agree-both.md
```
Expected: two matches.

- [ ] **Step 12.4: Commit (if applicable)**

```bash
git -C ~/.claude add commands/agree-both.md
git -C ~/.claude commit -m "chore(agree-both): cap prompt growth; add inter-round backoff"
```

---

## Final verification

### Task 13: End-to-end smoke

**Files:** none (verification only)

- [ ] **Step 13.1: Restart Claude Code**

So the bumped bridge (after Phase 1 PR is merged and plugin re-installs) is loaded. Confirm with:

```bash
claude mcp get gemini | rg "server/gemini/index.js"
```

- [ ] **Step 13.2: Schema check via raw JSON-RPC**

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | node ~/Sites/claude-delegator/server/gemini/index.js --no-startup-check \
  | tail -1 | python3 -c 'import json,sys; d=json.load(sys.stdin); print([list(t["inputSchema"]["properties"].keys()) for t in d["result"]["tools"]])'
```
Expected output mentions both `timeout` and `skip-trust` for each tool.

- [ ] **Step 13.3: Timeout smoke test against the installed bridge**

Use the same flow as `test/bridge.test.js`'s timeout case, but point at the cached bridge that Claude Code actually loads. Confirm a 500 ms timeout returns within ~1.6 s and produces `result.errorKind === "timeout"`.

- [ ] **Step 13.4: Orphan check**

```bash
sleep 7 && ps aux | rg "[g]emini"
```
Expected: empty (the bracket trick excludes `rg` itself).

- [ ] **Step 13.5: Trust-bypass smoke test**

Run `/ask-gemini "what is 2+2"` from `~/Sites/claude-delegator` (which is NOT in `~/.gemini/trustedFolders.json`) inside Claude Code. Confirm the answer comes back without manual trustedFolders.json editing.

- [ ] **Step 13.6: Status-line smoke test**

Run each of `/ask-gpt`, `/ask-gemini`, `/ask-both`, `/agree-both` with a trivial input. Confirm the chat log contains the C3 status line exactly once per dispatch, and the old "Delegating to" / "Dispatching parallel" / "Notify user" strings do not appear.

- [ ] **Step 13.7: Final repo cleanup**

```bash
cd ~/Sites/claude-delegator && git status
```
Expected: clean working tree on `main` (after PR merge) or on `feat/bridge-reliability` (before merge).

---

## Risks recap

- **R1** B5 only adds optional fields. Backwards compatible.
- **R2** `GEMINI_DEFAULT_MODEL` env default. Explicit per-call `args.model` still wins.
- **R3** With B2 merged, `skip-trust: true` only suppresses the Gemini CLI's trust check; `sandbox=workspace-write` is still gated by the bridge's own sandbox arg.
- **R4** B4 scanner is O(n), string-aware inside candidates only.
- **R5** C3 rule edit to `~/.claude/rules/delegator/orchestration.md` is installed-copy only; upstream PR to `jarrodwatts/claude-delegator` deferred.
- **R6** C1 inlined fallback prompts add ~5 KB per command file. Acceptable.
- **R7** B2 capability detection by parsing plugin.json is fragile if the cache layout changes. Mitigation: the glob is owner-agnostic and the parser tolerates parse failure (degrades to "B2 absent" with the explicit error path).

## Convergence record

| Round | GPT | Gemini | Claude | Changes applied |
|---|---|---|---|---|
| 1 | RC | APPR | RC | tightened B4, fixed JSON in tests, kept B5 backwards-compat, C2 preserves cwd, dropped streaming-partial promise, added test-harness refs |
| 2 | RC | APPR | RC | full string-aware brace scanner; ~/.claude commit-strategy clarified; B1 grace 3s to 1s |
| 3 | RC | APPR | RC | depth-gated scanner with floor; C3 explicit per-file replacements; C1 role-preserving fallback |
| 4 | RC | APPR | RC | owner-agnostic cache glob; B2 capability detection via plugin.json semver; agree-both acceptance relaxed |
| 5 | APPR | APPR | APPR | (nice-to-have recommendations folded in) |
