"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const cache = require("../server/grok/cache.js");

test("normalize(apiBase) lowercases scheme+host, preserves pathname, strips trailing slash", () => {
  assert.equal(cache.normalize("https://API.x.ai/v1/"), "https://api.x.ai/v1");
  assert.equal(cache.normalize("http://Example.com/Path/"), "http://example.com/Path");
  assert.equal(cache.normalize("https://api.x.ai/v1"), "https://api.x.ai/v1");
});

test("normalize(apiBase) falls back to prepending https:// when scheme is missing", () => {
  assert.equal(cache.normalize("api.x.ai/v1"), "https://api.x.ai/v1");
});

test("normalize(apiBase) throws on garbage input", () => {
  assert.throws(() => cache.normalize("::not a url::"));
});
