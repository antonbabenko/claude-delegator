// test/mcp-consensus-auto.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildServer } = require("../server/mcp/index.js");

/** @param {string} name @param {string} verdictText */
function voter(name, verdictText) {
  return {
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    /** @param {{prompt:string}} req @returns {Promise<any>} */
    async ask(req) {
      // The arbiter's revision step asks to REVISE; return a plan body so the loop progresses.
      if (req.prompt.includes("REVISE THE PLAN")) return { provider: name, model: "m", isError: false, text: "REVISED plan", ms: 1 };
      // Adjudication + blind + peer review all just emit the configured verdict.
      return { provider: name, model: "m", isError: false, text: verdictText, ms: 1 };
    },
  };
}
const approve = (n) => voter(n, "**Verdict**: APPROVE");
const reject = (n) => voter(n, "**Verdict**: REQUEST_CHANGES\n- [ops] needs work");

const cfg = (over) => ({ providers: {}, openrouter: { maxFanout: 3, models: [] }, consensus: { arbiter: "auto", arbiterDefaulted: false, ...(over || {}) } });

test("CA1: tools/list advertises consensus-auto (advisory)", async () => {
  const srv = buildServer({ providers: [approve("codex")], getConfig: () => cfg() });
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const t = res.result.tools.find((x) => x.name === "consensus-auto");
  assert.ok(t);
  assert.equal(t.annotations.readOnlyHint, true);
});

test("CA2: all-APPROVE panel converges with a verdict", async () => {
  const srv = buildServer({ providers: [approve("codex"), approve("gemini"), approve("grok")], getConfig: () => cfg() });
  const res = await srv.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "consensus-auto", arguments: { prompt: "ship it", expert: "architect" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.converged, true);
  assert.equal(payload.verdict, "APPROVE");
  assert.equal(payload.arbiter.mode, "server");
});

test("CA3: persistent dissent ends unresolved at the configured maxRounds", async () => {
  const srv = buildServer({ providers: [reject("codex"), reject("gemini"), reject("grok")], getConfig: () => cfg({ maxRounds: 2 }) });
  const res = await srv.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "consensus-auto", arguments: { prompt: "ship it" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.converged, false);
  assert.equal(payload.rounds, 2);
});

test("CA4: never throws on an empty panel - returns a structured error", async () => {
  const srv = buildServer({ providers: [], getConfig: () => cfg() });
  const res = await srv.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "consensus-auto", arguments: { prompt: "x" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.converged, false);
  assert.ok(typeof payload.error === "string");
});

test("CA5: host-mode arbiter -> explicit arbiter-is-host error (no silent peer hijack)", async () => {
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => cfg({ arbiter: "host" }) });
  const res = await srv.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "consensus-auto", arguments: { prompt: "x" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.converged, false);
  assert.equal(payload.error, "arbiter-is-host");
  assert.equal(payload.arbiter.provider, null);
});

test("CA6: a 2-provider panel (arbiter + 1 distinct peer) converges without self-arbitration", async () => {
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => cfg() });
  const res = await srv.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "consensus-auto", arguments: { prompt: "x" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.converged, true);
  assert.equal(payload.opinions.length, 1); // exactly one peer reviewed (arbiter excluded)
});
