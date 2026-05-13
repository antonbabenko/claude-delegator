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
  assert.ok(elapsed < 4500, "bridge returned within 4.5s, got " + elapsed + "ms");
});
