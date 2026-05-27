"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const idx = require("../server/grok/index.js");
const cache = require("../server/grok/cache.js");

test("validateFiles accepts {dir} with Windows-style backslash path", () => {
  const err = idx.validateFiles([{ dir: "C:\\project\\modules", include: ["**/*.tf"] }]);
  assert.equal(err, null, `expected null, got ${err}`);
});

test("validateFiles rejects include pattern containing backslashes", () => {
  const err = idx.validateFiles([{ dir: ".", include: ["src\\*.tf"] }]);
  assert.match(err || "", /backslash/i);
});

test("normalize(apiBase) without scheme uses https:// fallback", () => {
  assert.equal(cache.normalize("api.x.ai/v1"), "https://api.x.ai/v1");
});

test("normalize(apiBase) throws clear error on truly invalid input", () => {
  assert.throws(() => cache.normalize("::not a url::"), /Invalid|URL/i);
});
