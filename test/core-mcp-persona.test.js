"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildServer, toolList } = require("../server/mcp/index.js");
const { PROMPTS } = require("../core/prompts/index.js");

/** @typedef {import("../core/types.js").Provider} Provider */

/**
 * Capturing fake provider: records the developerInstructions it received so we
 * can assert what the server injected.
 * @param {string} name
 * @param {{di:(string|undefined)[]}} sink
 * @returns {Provider}
 */
function capturingProvider(name, sink) {
  return {
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(req) {
      sink.di.push(req.developerInstructions);
      return { provider: name, model: "m", text: `${name}:${req.prompt}`, isError: false, ms: 1 };
    },
  };
}

const config = { providers: {}, openrouter: { maxFanout: 3, models: [] } };

test("PJ1: direct expert tool injects that expert persona (expert in tool NAME)", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "architect", arguments: { prompt: "design X" } } });
  assert.equal(sink.di[0], PROMPTS["architect"]);
});

test("PJ2: ask-all with expert injects persona on every fanned-out provider", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink), capturingProvider("grok", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "ask-all", arguments: { prompt: "x", expert: "security-analyst" } } });
  assert.equal(sink.di.length, 2);
  for (const di of sink.di) assert.equal(di, PROMPTS["security-analyst"]);
});

test("PJ3: consensus with expert injects persona on opinions AND arbiter", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink), capturingProvider("grok", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "consensus", arguments: { prompt: "x", expert: "debugger" } } });
  // 2 opinions + 1 arbiter pass = 3 asks, all carry the debugger persona.
  assert.equal(sink.di.length, 3);
  for (const di of sink.di) assert.equal(di, PROMPTS["debugger"]);
});

test("PJ4: ask-gpt with expert injects persona", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "ask-gpt", arguments: { prompt: "x", expert: "researcher" } } });
  assert.equal(sink.di[0], PROMPTS["researcher"]);
});

test("PJ5: caller-supplied developerInstructions always wins (Claude Code path unchanged)", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "architect", arguments: { prompt: "x", developerInstructions: "MY OWN PROMPT" } } });
  assert.equal(sink.di[0], "MY OWN PROMPT");
});

test("PJ6: ask-gpt with NO expert leaves developerInstructions undefined (no persona)", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "ask-gpt", arguments: { prompt: "x" } } });
  assert.equal(sink.di[0], undefined);
});

test("PJ9: named expert tool wins over args.expert; arg honored only on non-named tools", async () => {
  // Named tool "architect" with a conflicting args.expert -> tool name wins.
  const sink1 = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv1 = buildServer({ providers: [capturingProvider("codex", sink1)], getConfig: () => config });
  await srv1.handle({ jsonrpc: "2.0", id: 91, method: "tools/call",
    params: { name: "architect", arguments: { prompt: "x", expert: "researcher" } } });
  assert.equal(sink1.di[0], PROMPTS["architect"]);

  // Non-named tool "ask-gpt" honors args.expert.
  const sink2 = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv2 = buildServer({ providers: [capturingProvider("codex", sink2)], getConfig: () => config });
  await srv2.handle({ jsonrpc: "2.0", id: 92, method: "tools/call",
    params: { name: "ask-gpt", arguments: { prompt: "x", expert: "architect" } } });
  assert.equal(sink2.di[0], PROMPTS["architect"]);
});

test("PJ8: prototype-chain expert keys never inject (constructor / __proto__)", async () => {
  for (const evil of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
    const srv = buildServer({ providers: [capturingProvider("codex", sink)], getConfig: () => config });
    // Pass via ask-gpt so the evil string flows through args.expert -> withPersona.
    await srv.handle({ jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "ask-gpt", arguments: { prompt: "x", expert: evil } } });
    assert.equal(sink.di[0], undefined, `expert "${evil}" must not inject a persona`);
  }
});

test("PJ7: inputSchema exposes files array; descriptions are richer per-expert", () => {
  const tools = toolList();
  const architect = tools.find((t) => t.name === "architect");
  assert.ok(architect);
  // files property present in schema
  assert.ok(architect.inputSchema.properties.files);
  assert.equal(architect.inputSchema.properties.files.type, "array");
  // richer description: not the old terse default
  assert.equal(/Direct architect expert \(advisory\)\.$/.test(architect.description), false);
  assert.ok(architect.description.length > 40);
  // ask-all / consensus describe fan-out / arbiter
  const askAll = tools.find((t) => t.name === "ask-all");
  const cons = tools.find((t) => t.name === "consensus");
  assert.ok(askAll && /parallel|fan/i.test(askAll.description));
  assert.ok(cons && /arbiter|synthesiz/i.test(cons.description));
});
