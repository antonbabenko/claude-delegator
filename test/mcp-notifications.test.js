"use strict";
// Server-side verification of the Phase 4 progress spike: prove the unified MCP
// server ADVERTISES the logging capability, accepts logging/setLevel, and EMITS a
// `notifications/message` per provider (dispatch_start + one per voice) during an
// ask-all fan-out - carrying NO prompt/response text. (Whether a given HOST renders
// these mid-call is environmental and must be confirmed live; this pins the server.)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildServer } = require("../server/mcp/index.js");

function fakeProvider(/** @type {string} */ name) {
  return {
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) { return { provider: name, model: "m", text: `${name}:${req.prompt}`, isError: false, ms: 1, reasoningEffort: name === "grok" ? "high" : null }; },
  };
}
const config = { providers: {}, openrouter: { maxFanout: 3, models: [] } };

/** Build a server with a notification capture. */
function withCapture() {
  /** @type {any[]} */
  const notes = [];
  const srv = buildServer({
    providers: [fakeProvider("codex"), fakeProvider("grok")],
    getConfig: () => config,
    notify: (/** @type {string} */ method, /** @type {any} */ params) => notes.push({ method, params }),
  });
  return { srv, notes };
}

test("N1: initialize advertises the logging capability", async () => {
  const { srv } = withCapture();
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "test" } } });
  assert.ok(res.result.capabilities.logging, "server must advertise capabilities.logging");
  assert.ok(res.result.capabilities.tools, "tools capability still present");
});

test("N2: logging/setLevel accepts a valid level and rejects an invalid one", async () => {
  const { srv } = withCapture();
  const ok = await srv.handle({ jsonrpc: "2.0", id: 2, method: "logging/setLevel", params: { level: "warning" } });
  assert.deepEqual(ok.result, {});
  const bad = await srv.handle({ jsonrpc: "2.0", id: 3, method: "logging/setLevel", params: { level: "loud" } });
  assert.equal(bad.error.code, -32602);
});

test("N3: ask-all emits dispatch_start + one provider_result notification per voice, NO prompt text", async () => {
  const { srv, notes } = withCapture();
  await srv.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ask-all", arguments: { prompt: "SECRET-PROMPT", expert: "architect" } } });
  const msgs = notes.filter((n) => n.method === "notifications/message");
  assert.ok(msgs.length >= 3, `expected dispatch_start + 2 provider_result, got ${msgs.length}`);
  const events = msgs.map((m) => m.params.data.event);
  assert.ok(events.includes("dispatch_start"), "a dispatch_start notification must fire up front");
  assert.equal(events.filter((e) => e === "provider_result").length, 2, "one provider_result per voice");
  // Every notification: correct envelope + zero prompt/response leakage.
  for (const m of msgs) {
    assert.equal(m.params.level, "info");
    assert.equal(m.params.logger, "deliberation");
    const blob = JSON.stringify(m.params);
    assert.ok(!blob.includes("SECRET-PROMPT"), "notification must never carry the prompt");
  }
});

test("N4: raising the client min level above info suppresses the notifications", async () => {
  const { srv, notes } = withCapture();
  await srv.handle({ jsonrpc: "2.0", id: 5, method: "logging/setLevel", params: { level: "error" } });
  await srv.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ask-all", arguments: { prompt: "q", expert: "architect" } } });
  const msgs = notes.filter((n) => n.method === "notifications/message");
  assert.equal(msgs.length, 0, "info-level progress must be suppressed when the client raised the bar to error");
});

test("N5: a server built WITHOUT notify still answers ask-all (no-op notifications)", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask-all", arguments: { prompt: "q", expert: "architect" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.results.length, 1);
});
