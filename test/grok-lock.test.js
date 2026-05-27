"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lock = require("../server/grok/lock.js");

function tmpLockBase() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grok-lock-")), "cache.json");
}

test("acquire creates lockDir with unique owner marker", () => {
  const base = tmpLockBase();
  const handle = lock.acquire(base, { maxWaitMs: 100 });
  assert.ok(handle, "lock acquired");
  const lockDir = `${base}.lock`;
  assert.ok(fs.existsSync(lockDir), "lockDir exists");
  const markers = fs.readdirSync(lockDir).filter((f) => f.startsWith("owner."));
  assert.equal(markers.length, 1);
  assert.match(markers[0], /^owner\.[0-9a-f]{32}\.txt$/);
  lock.release(handle);
});

test("acquire returns null when lock already held and not stale", () => {
  const base = tmpLockBase();
  const h1 = lock.acquire(base, { maxWaitMs: 50 });
  assert.ok(h1, "first acquire");
  const h2 = lock.acquire(base, { maxWaitMs: 50 });
  assert.equal(h2, null, "second acquire fails");
  lock.release(h1);
});

test("release removes our marker and rmdirs the lockDir", () => {
  const base = tmpLockBase();
  const handle = lock.acquire(base, { maxWaitMs: 100 });
  lock.release(handle);
  const lockDir = `${base}.lock`;
  assert.equal(fs.existsSync(lockDir), false);
});
