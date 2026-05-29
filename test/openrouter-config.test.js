"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig } = require("../server/openrouter/config.js");

function base() {
  return {
    version: 1,
    openrouter: {
      enabled: true,
      apiKeyEnv: "OPENROUTER_API_KEY",
      apiBase: "https://openrouter.ai/api/v1",
      allowRawModel: false,
      maxFanout: 3,
      defaultModel: "openai/gpt-5.5",
      defaults: { reasoning_effort: "high", timeout: 180000 },
      models: [
        { alias: "gpt55", model: "openai/gpt-5.5", experts: ["architect"], askAll: true, consensus: true },
        { alias: "llama", model: "meta/llama", experts: ["researcher"] },
        { alias: "deep", model: "deepseek/r2", experts: [], consensus: true },
      ],
    },
  };
}

test("C1: a valid config resolves with defaults applied", () => {
  const { ok, resolved, error } = validateConfig(base());
  assert.equal(ok, true, error);
  assert.equal(resolved.openrouter.enabled, true);
  assert.equal(resolved.openrouter.models[1].askAll, true);
  assert.equal(resolved.openrouter.models[1].consensus, false);
  assert.equal(resolved.openrouter.models[0].consensus, true);
  assert.deepEqual(resolved.openrouter.models[2].experts, []);
});

test("C2: duplicate alias is rejected", () => {
  const c = base();
  c.openrouter.models[1].alias = "gpt55";
  const { ok, error } = validateConfig(c);
  assert.equal(ok, false);
  assert.match(error, /duplicate alias/i);
});

test("C3: reserved alias openrouter-default is rejected", () => {
  const c = base();
  c.openrouter.models[0].alias = "openrouter-default";
  const { ok, error } = validateConfig(c);
  assert.equal(ok, false);
  assert.match(error, /reserved/i);
});

test("C4: unknown expert key is rejected", () => {
  const c = base();
  c.openrouter.models[0].experts = ["wizard"];
  const { ok, error } = validateConfig(c);
  assert.equal(ok, false);
  assert.match(error, /unknown expert/i);
});

test("C5: non-integer or <1 maxFanout is rejected", () => {
  for (const bad of [0, -1, 2.5, "3", null]) {
    const c = base();
    c.openrouter.maxFanout = bad;
    const { ok } = validateConfig(c);
    assert.equal(ok, false, `maxFanout=${bad} should be invalid`);
  }
});

test("C6: unknown major version is rejected", () => {
  const c = base();
  c.version = 2;
  const { ok, error } = validateConfig(c);
  assert.equal(ok, false);
  assert.match(error, /version/i);
});

test("C7: bad alias characters are rejected", () => {
  const c = base();
  c.openrouter.models[0].alias = "GPT_55";
  const { ok, error } = validateConfig(c);
  assert.equal(ok, false);
  assert.match(error, /alias/i);
});

test("C8: omitted openrouter block resolves to disabled, no error", () => {
  const { ok, resolved } = validateConfig({ version: 1 });
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.enabled, false);
  assert.deepEqual(resolved.openrouter.models, []);
});
