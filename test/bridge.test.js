"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startBridge, send, collectResponses, readArgv } = require("./_helpers.js");

test("B1: timeout kills slow gemini and surfaces structured error", async () => {
  const child = startBridge({ fakeBin: "fake-gemini-slow.sh" });
  const responsesP = collectResponses(child);
  const t0 = Date.now();

  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "slow", timeout: 500, "recovery-grace": 0 } },
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
  assert.ok(elapsed < 4500, "bridge returned within 4.5s, got " + elapsed + "ms");
});

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

// Pure-function unit tests for the parser helper. Bridge is required as a module - see Step 3.5 for the guards that make this safe.
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
  const child = startBridge({
    fakeBin: "fake-gemini.sh",
    env: { GEMINI_DEFAULT_MODEL: "" },
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
  assert.equal(argv[mIdx + 1], "gemini-2.5-flash");
});

// --- B7: trust-check classification (issue #2) ---

test("B7a: gemini trust failure surfaces errorKind=trust, retryable=true, hint=skip-trust", async () => {
  const child = startBridge({ fakeBin: "fake-gemini-trust.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi" } },
  });
  setTimeout(() => child.stdin.end(), 800);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.errorKind, "trust");
  assert.equal(r.result.retryable, true);
  assert.equal(r.result.hint, "skip-trust");
});

test("B7f: gemini-reply trust failure classifies identically", async () => {
  const child = startBridge({ fakeBin: "fake-gemini-trust.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini-reply", arguments: { threadId: "abc", prompt: "follow up" } },
  });
  setTimeout(() => child.stdin.end(), 800);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.errorKind, "trust");
  assert.equal(r.result.retryable, true);
  assert.equal(r.result.hint, "skip-trust");
});

test("B7g: stderr trust error is not masked when stdout has noise", async () => {
  const child = startBridge({ fakeBin: "fake-gemini-trust-with-stdout.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi" } },
  });
  setTimeout(() => child.stdin.end(), 800);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.errorKind, "trust", "stderr trust text must win over stdout banner");
  assert.equal(r.result.retryable, true);
});

// Pure-function classifier units (no spawn).
test("B7b: classifyGeminiError matches 'trusted directory' case-insensitively", () => {
  const { classifyGeminiError } = require("../server/gemini/index.js");
  assert.deepEqual(
    classifyGeminiError("Error: not a trusted directory", null),
    { errorKind: "trust", retryable: true, hint: "skip-trust" }
  );
  assert.deepEqual(
    classifyGeminiError("NOT A Trusted Directory", null),
    { errorKind: "trust", retryable: true, hint: "skip-trust" }
  );
});

test("B7c: classifyGeminiError matches 'trust check' wording", () => {
  const { classifyGeminiError } = require("../server/gemini/index.js");
  const r = classifyGeminiError("trust check failed for /tmp/x", null);
  assert.equal(r.errorKind, "trust");
  assert.equal(r.retryable, true);
  assert.equal(r.hint, "skip-trust");
});

test("B7d: classifyGeminiError preserves timeout / parse / missing-cli / abort branches", () => {
  const { classifyGeminiError } = require("../server/gemini/index.js");
  assert.deepEqual(classifyGeminiError("anything", "timeout"), { errorKind: "timeout", retryable: true });
  assert.deepEqual(classifyGeminiError("anything", "parse"),   { errorKind: "parse",   retryable: false });
  const missing = classifyGeminiError("Gemini CLI not found. Please install it.", null);
  assert.equal(missing.errorKind, "missing-cli");
  assert.equal(missing.retryable, false);
  const abort = classifyGeminiError("AbortError: signal aborted", null);
  assert.equal(abort.errorKind, "upstream-abort");
  assert.equal(abort.retryable, true);
});

test("B7e: classifyGeminiError falls back to unknown for unrelated text", () => {
  const { classifyGeminiError } = require("../server/gemini/index.js");
  const r = classifyGeminiError("network blip", null);
  assert.equal(r.errorKind, "unknown");
  assert.equal(r.retryable, false);
  assert.equal(r.hint, undefined);
});

test("B7e: classifyGeminiError tolerates null/undefined errMsg", () => {
  const { classifyGeminiError } = require("../server/gemini/index.js");
  assert.equal(classifyGeminiError(null, null).errorKind, "unknown");
  assert.equal(classifyGeminiError(undefined, null).errorKind, "unknown");
});

// --- B8: timeout-recovery (read late-flushed answer from disk) ---

const fs8 = require("node:fs");
const os8 = require("node:os");
const path8 = require("node:path");

function tmpRoot() {
  return fs8.mkdtempSync(path8.join(os8.tmpdir(), "cdg-gtmp-"));
}

test("B8a: soft timeout drains and recovers the disk-persisted answer", async () => {
  const root = tmpRoot();
  const child = startBridge({
    fakeBin: "fake-gemini-timeout-recover.sh",
    env: { GEMINI_TMP_ROOT: root, FAKE_GEMINI_SLEEP: "2" },
  });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "deep", timeout: 800, "recovery-grace": 10000 } },
  });
  setTimeout(() => child.stdin.end(), 12000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.ok(r, "got tools/call response");
  assert.ok(!r.result.isError, "not an error: " + JSON.stringify(r.result));
  assert.equal(r.result.recovered, true, "recovered flag");
  assert.equal(r.result.content[0].text, "RECOVERED ANSWER OK");
  assert.equal(r.result.threadId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("B8b: GEMINI_DISABLE_TIMEOUT_RECOVERY=1 keeps legacy timeout", async () => {
  const root = tmpRoot();
  const child = startBridge({
    fakeBin: "fake-gemini-timeout-recover.sh",
    env: { GEMINI_TMP_ROOT: root, FAKE_GEMINI_SLEEP: "2", GEMINI_DISABLE_TIMEOUT_RECOVERY: "1" },
  });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "deep", timeout: 500, "recovery-grace": 10000 } },
  });
  setTimeout(() => child.stdin.end(), 5000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.errorKind, "timeout");
  assert.equal(r.result.retryable, true);
});

test("B8c: no disk answer -> timeout after soft + grace", async () => {
  const root = tmpRoot();
  const child = startBridge({
    fakeBin: "fake-gemini-timeout-recover.sh",
    env: { GEMINI_TMP_ROOT: root, FAKE_GEMINI_SLEEP: "1", FAKE_GEMINI_NOWRITE: "1" },
  });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "deep", timeout: 500, "recovery-grace": 3000 } },
  });
  setTimeout(() => child.stdin.end(), 6000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.errorKind, "timeout");
});

test("B8d: stale answer (timestamp before spawn-start) is not returned", async () => {
  const root = tmpRoot();
  const child = startBridge({
    fakeBin: "fake-gemini-timeout-recover.sh",
    env: { GEMINI_TMP_ROOT: root, FAKE_GEMINI_SLEEP: "1", FAKE_GEMINI_STALE: "1" },
  });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "deep", timeout: 500, "recovery-grace": 3000 } },
  });
  setTimeout(() => child.stdin.end(), 6000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.errorKind, "timeout");
  assert.ok(
    !JSON.stringify(r.result).includes("RECOVERED ANSWER OK"),
    "stale content must not be returned"
  );
});

test("B8e: extractGeminiAnswer returns last gemini record + metadata threadId", () => {
  const { extractGeminiAnswer } = require("../server/gemini/index.js");
  const dir = tmpRoot();
  const f = path8.join(dir, "session-x.jsonl");
  const ts = new Date().toISOString();
  fs8.writeFileSync(f, [
    JSON.stringify({ sessionId: "sid-123", projectHash: "h", startTime: ts, lastUpdated: ts, kind: "main" }),
    JSON.stringify({ id: "u1", timestamp: ts, type: "user", content: "q" }),
    JSON.stringify({ id: "g1", timestamp: ts, type: "gemini", content: "first" }),
    JSON.stringify({ id: "g2", timestamp: ts, type: "gemini", content: "FINAL" }),
  ].join("\n") + "\n");
  const got = extractGeminiAnswer(f, Date.now() - 60000);
  assert.equal(got.content, "FINAL");
  assert.equal(got.threadId, "sid-123");
});

test("B8e: extractGeminiAnswer applies the stale guard", () => {
  const { extractGeminiAnswer } = require("../server/gemini/index.js");
  const dir = tmpRoot();
  const f = path8.join(dir, "session-y.jsonl");
  fs8.writeFileSync(f,
    JSON.stringify({ id: "g1", timestamp: "2000-01-01T00:00:00.000Z", type: "gemini", content: "OLD" }) + "\n");
  assert.equal(extractGeminiAnswer(f, Date.now()), null);
});

test("B8f: resolveSlugDir matches by .project_root content", () => {
  const { resolveSlugDir } = require("../server/gemini/index.js");
  const root = tmpRoot();
  const slug = path8.join(root, "some-slug");
  fs8.mkdirSync(path8.join(slug, "chats"), { recursive: true });
  const cwd = fs8.mkdtempSync(path8.join(os8.tmpdir(), "cdg-cwd-"));
  fs8.writeFileSync(path8.join(slug, ".project_root"), cwd);
  assert.equal(resolveSlugDir(cwd, root), slug);
  assert.equal(resolveSlugDir("/nonexistent/path/xyz", root), null);
});
