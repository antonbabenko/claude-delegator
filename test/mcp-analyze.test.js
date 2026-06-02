"use strict";
// The `analyze` MCP tool: read-only run analytics over the opt-in debug log +
// session store. Reads files, returns pre-aggregated JSON, writes nothing, and
// degrades gracefully when the log is missing or persistence is off.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { buildServer } = require("../server/mcp/index.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-analyze-"));
}
/** @param {any} srv @param {any} args */
async function callAnalyze(srv, args) {
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "analyze", arguments: args || {} } });
  return JSON.parse(res.result.content[0].text);
}
/** @param {string} provider @param {string} model @param {number} ms @param {object} [extra] */
function line(provider, model, ms, extra = {}) {
  return JSON.stringify({ event: "provider_result", at: 1, tool: "ask-one", provider, model, ms, isError: false, reasoningEffort: null, ...extra });
}

test("M1: analyze is advertised in tools/list as read-only", async () => {
  const srv = buildServer({ providers: [], getConfig: () => ({}) });
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tool = res.result.tools.find((/** @type {any} */ t) => t.name === "analyze");
  assert.ok(tool, "analyze tool present");
  assert.equal(tool.annotations.readOnlyHint, true);
});

test("M2: analyze aggregates a debug log pointed at by config.debug.path", async () => {
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  fs.writeFileSync(logPath, [
    line("grok", "grok-m", 100, { usage: { totalTokens: 500 } }),
    line("grok", "grok-m", 100, { usage: { totalTokens: 700 } }),
    line("openrouter:foo", "vendor/foo", 6000, { reasoningEffort: "high", usage: { totalTokens: 3000 } }),
    line("openrouter:foo", "vendor/foo", 6000, { reasoningEffort: "high", usage: { totalTokens: 3200 } }),
    "", "{ broken json",
  ].join("\n") + "\n");
  const config = { debug: { enabled: true, path: logPath }, models: { foo: { provider: "openrouter", reasoningEffort: "high", askAll: true } } };
  const srv = buildServer({ providers: [], getConfig: () => config });

  const out = await callAnalyze(srv, {});
  assert.equal(out.meta.insufficientData, false);
  assert.equal(out.meta.eventsParsed, 4, "two broken/blank lines dropped");
  // slowest first
  assert.equal(out.stats[0].provider, "openrouter:foo");
  assert.equal(out.stats[1].provider, "grok");
  // a slow OpenRouter model yields an advisory askAll suggestion (no writes)
  const askAll = out.recommendations.find((/** @type {any} */ r) => r.configKey === "models.foo.askAll");
  assert.ok(askAll, "suggests dropping the slow model from ask-all");
  // tool never wrote anything beyond the log we created
  assert.deepEqual(fs.readdirSync(dir), ["debug.jsonl"]);
});

test("M3: analyze degrades gracefully when the debug log is missing", async () => {
  const dir = tmpdir();
  const config = { debug: { enabled: true, path: path.join(dir, "nope.jsonl") } };
  const srv = buildServer({ providers: [], getConfig: () => config });
  const out = await callAnalyze(srv, {});
  assert.equal(out.meta.insufficientData, true);
  assert.equal(out.meta.eventsParsed, 0);
  assert.deepEqual(out.stats, []);
  assert.deepEqual(out.recommendations, []);
});

test("M4: analyze folds in the agreement lens when sessions persist", async () => {
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  fs.writeFileSync(logPath, [
    line("grok", "grok-m", 100), line("grok", "grok-m", 100),
    line("openrouter:foo", "vendor/foo", 6000), line("openrouter:foo", "vendor/foo", 6000),
  ].join("\n") + "\n");
  const sessionsDir = path.join(dir, "sessions");
  fs.mkdirSync(sessionsDir);
  const rec = {
    id: "11111111-1111-1111-1111-111111111111", schemaVersion: 1, tool: "consensus",
    createdAt: new Date(0).toISOString(), question: "q", verdict: "APPROVE",
    opinions: [
      { provider: "openrouter:foo", model: "vendor/foo", verdict: "APPROVE" },
      { provider: "grok", model: "grok-m", verdict: "REJECT" },
    ],
  };
  fs.writeFileSync(path.join(sessionsDir, rec.id + ".json"), JSON.stringify(rec));

  const config = { debug: { enabled: true, path: logPath }, sessions: { persist: true }, models: { foo: { provider: "openrouter", askAll: true } } };
  const srv = buildServer({ providers: [], getConfig: () => config, sessionsDir });
  const out = await callAnalyze(srv, {});
  assert.equal(out.meta.sessionsPersist, true);
  assert.equal(out.meta.sessionsRead, 1);
  const fooAgree = out.agreement.find((/** @type {any} */ a) => a.provider === "openrouter:foo");
  assert.ok(fooAgree);
  assert.equal(fooAgree.agreementRate, 1, "foo matched the APPROVE verdict");
});

test("M5: analyze skips the agreement lens when persistence is off", async () => {
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  fs.writeFileSync(logPath, line("grok", "grok-m", 100) + "\n" + line("grok", "grok-m", 100) + "\n");
  const config = { debug: { enabled: true, path: logPath } }; // no sessions.persist, no sessionsDir
  const srv = buildServer({ providers: [], getConfig: () => config });
  const out = await callAnalyze(srv, {});
  assert.equal(out.meta.sessionsPersist, false);
  assert.equal(out.meta.sessionsRead, 0);
  assert.deepEqual(out.agreement, []);
});
