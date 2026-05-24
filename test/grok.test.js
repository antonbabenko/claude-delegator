"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const BRIDGE = path.join(__dirname, "..", "server", "grok", "index.js");

// Spawn the Grok bridge with a controlled environment.
function startGrokBridge(env = {}) {
  return spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Minimal request/response-correlated JSON-RPC client over the child's stdio.
function rpcClient(child) {
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  return {
    request(obj) {
      return new Promise((resolve) => {
        waiters.set(obj.id, resolve);
        child.stdin.write(JSON.stringify(obj) + "\n");
      });
    },
  };
}

// Start a localhost mock of the xAI chat/completions endpoint.
function startMockXai(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}/v1` });
    });
  });
}

test("G1: grok then grok-reply accumulates the transcript", async () => {
  const received = [];
  const { server, base } = await startMockXai((req, res, body) => {
    received.push(JSON.parse(body));
    const turn = received.length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `reply-${turn}` } }] }));
  });
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: base });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const r1 = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "hello", "developer-instructions": "sys" } },
    });
    assert.equal(r1.result.isError, undefined, "no error on first call");
    assert.equal(r1.result.content[0].text, "reply-1");
    const threadId = r1.result.threadId;
    assert.ok(threadId, "threadId returned");

    const r2 = await rpc.request({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "grok-reply", arguments: { threadId, prompt: "again" } },
    });
    assert.equal(r2.result.content[0].text, "reply-2");
    assert.equal(r2.result.threadId, threadId, "same threadId preserved");

    assert.deepEqual(received[0].messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
    assert.deepEqual(received[1].messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply-1" },
      { role: "user", content: "again" },
    ]);
  } finally {
    child.stdin.end();
    server.close();
  }
});

test("G2: missing XAI_API_KEY returns errorKind missing-auth", async () => {
  const child = startGrokBridge({ XAI_API_KEY: "", XAI_API_BASE: "http://127.0.0.1:1/v1" });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "hi" } },
    });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.errorKind, "missing-auth");
    assert.equal(r.result.retryable, false);
  } finally {
    child.stdin.end();
  }
});

test("G3: grok-reply on an unknown threadId returns unknown-thread", async () => {
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: "http://127.0.0.1:1/v1" });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok-reply", arguments: { threadId: "does-not-exist", prompt: "x" } },
    });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.errorKind, "unknown-thread");
    assert.equal(r.result.retryable, false);
  } finally {
    child.stdin.end();
  }
});

test("G4: timeout aborts the call and surfaces errorKind timeout", async () => {
  // Mock that delays past the call timeout so AbortController fires.
  const { server, base } = await startMockXai((req, res) => {
    setTimeout(() => {
      try {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
      } catch (_) {}
    }, 5000);
  });
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: base });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "slow", timeout: 300 } },
    });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.errorKind, "timeout");
    assert.equal(r.result.retryable, true);
  } finally {
    child.stdin.end();
    server.close();
  }
});

test("G5: tools/list advertises grok and grok-reply", async () => {
  const child = startGrokBridge({ XAI_API_KEY: "test" });
  const rpc = rpcClient(child);
  try {
    const r = await rpc.request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = r.result.tools.map((t) => t.name);
    assert.deepEqual(names.sort(), ["grok", "grok-reply"]);
  } finally {
    child.stdin.end();
  }
});

// --- Pure-function unit tests (bridge required as a module) ---

test("G6: classifyGrokError maps transport codes and HTTP statuses", () => {
  const { classifyGrokError } = require("../server/grok/index.js");
  assert.deepEqual(classifyGrokError(null, "missing-auth"), { errorKind: "missing-auth", retryable: false });
  assert.deepEqual(classifyGrokError(null, "unknown-thread"), { errorKind: "unknown-thread", retryable: false });
  assert.deepEqual(classifyGrokError(null, "timeout"), { errorKind: "timeout", retryable: true });
  assert.deepEqual(classifyGrokError(null, "network"), { errorKind: "network", retryable: true });
  assert.deepEqual(classifyGrokError(null, "parse"), { errorKind: "parse", retryable: false });
  assert.deepEqual(classifyGrokError(401), { errorKind: "auth", retryable: false });
  assert.deepEqual(classifyGrokError(403), { errorKind: "auth", retryable: false });
  assert.deepEqual(classifyGrokError(429), { errorKind: "rate-limit", retryable: true });
  assert.deepEqual(classifyGrokError(503), { errorKind: "upstream", retryable: true });
  assert.deepEqual(classifyGrokError(200), { errorKind: "unknown", retryable: false });
});

test("G7: buildMessages adds system only when developer-instructions present", () => {
  const { buildMessages } = require("../server/grok/index.js");
  assert.deepEqual(buildMessages("sys", "p"), [
    { role: "system", content: "sys" },
    { role: "user", content: "p" },
  ]);
  assert.deepEqual(buildMessages("", "p"), [{ role: "user", content: "p" }]);
  assert.deepEqual(buildMessages(undefined, "p"), [{ role: "user", content: "p" }]);
});

test("G8: parseChatCompletion extracts content and throws on malformed", () => {
  const { parseChatCompletion } = require("../server/grok/index.js");
  assert.equal(parseChatCompletion({ choices: [{ message: { content: "hi" } }] }), "hi");
  assert.throws(() => parseChatCompletion({}), /Parse error/);
  assert.throws(() => parseChatCompletion({ choices: [] }), /Parse error/);
  assert.throws(() => parseChatCompletion({ choices: [{ message: {} }] }), /Parse error/);
});

test("G9: runGrok uses injected fetch (success, http error, missing key)", async () => {
  const { runGrok } = require("../server/grok/index.js");

  const okFetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
  });
  assert.equal(
    await runGrok({ messages: [{ role: "user", content: "x" }], apiKey: "k", fetchImpl: okFetch }),
    "ok"
  );

  const errFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(
    runGrok({ messages: [], apiKey: "k", fetchImpl: errFetch }),
    (e) => e.status === 500
  );

  await assert.rejects(
    runGrok({ messages: [], apiKey: "", fetchImpl: okFetch }),
    (e) => e.code === "missing-auth"
  );
});
