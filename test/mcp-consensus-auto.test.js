// test/mcp-consensus-auto.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildServer } = require("../server/mcp/index.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-ca-"));
}
/** A tools/call that returns the parsed JSON payload. */
async function callTool(srv, name, args, id) {
  const res = await srv.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return JSON.parse(res.result.content[0].text);
}

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
/** cfg with persistence ON (sessions.persist). */
const cfgPersist = (over) => ({ ...cfg(over), sessions: { persist: true } });

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

test("CA7: with persistence ON, a converged run is saved as a tool:consensus-auto v2 record", async () => {
  const dir = tmpDir();
  const srv = buildServer({ providers: [approve("codex"), approve("gemini"), approve("grok")], getConfig: () => cfgPersist(), sessionsDir: dir });
  const payload = await callTool(srv, "consensus-auto", { prompt: "ship it" }, 7);
  assert.equal(payload.converged, true);
  assert.ok(payload.sessionId, "a sessionId is returned when persistence is on");

  const got = await callTool(srv, "session-get", { sessionId: payload.sessionId }, 8);
  assert.equal(got.session.tool, "consensus-auto");
  assert.equal(got.session.schemaVersion, 2);
  assert.equal(got.session.converged, true);
  assert.equal(typeof got.session.confidence, "string");
  assert.equal(typeof got.session.rounds, "number");
  // opinions persist their structured verdict (lossless v2 shape).
  assert.ok(got.session.opinions.length >= 1);
  assert.equal(got.session.opinions[0].verdict, "APPROVE");
});

test("CA8: session-revisit on a consensus-auto record re-runs the LOOP + links a child", async () => {
  const dir = tmpDir();
  const srv = buildServer({ providers: [approve("codex"), approve("gemini"), approve("grok")], getConfig: () => cfgPersist(), sessionsDir: dir });
  const first = await callTool(srv, "consensus-auto", { prompt: "ship it" }, 9);

  const revisit = await callTool(srv, "session-revisit", { sessionId: first.sessionId }, 10);
  // The re-run is the LOOP (converged + rounds), not a one-shot consensus.
  assert.equal(revisit.converged, true);
  assert.equal(typeof revisit.rounds, "number");
  assert.equal(revisit.parentId, first.sessionId);
  assert.ok(revisit.sessionId && revisit.sessionId !== first.sessionId);

  const child = await callTool(srv, "session-get", { sessionId: revisit.sessionId }, 11);
  assert.equal(child.session.tool, "consensus-auto");
  assert.equal(child.session.parentId, first.sessionId);
});

test("CA9: an error-path run (host arbiter) does NOT persist - no sessionId", async () => {
  const dir = tmpDir();
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => cfgPersist({ arbiter: "host" }), sessionsDir: dir });
  const payload = await callTool(srv, "consensus-auto", { prompt: "x" }, 12);
  assert.equal(payload.error, "arbiter-is-host");
  assert.equal(payload.sessionId, undefined);
  assert.deepEqual(fs.readdirSync(dir), []); // nothing written
});
