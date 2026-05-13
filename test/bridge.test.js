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
