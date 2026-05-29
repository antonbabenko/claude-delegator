"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inlineFiles } = require("../server/openrouter/files.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdg-orf-"));
}

test("F1: a {path} entry is inlined as a labeled text block", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world");
  const { blocks, notes } = inlineFiles([{ path: "a.txt", mode: "upload" }], { roots: [dir] });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /a\.txt/);
  assert.match(blocks[0], /hello world/);
  assert.deepEqual(notes, []);
});

test("F2: a {dir} entry inlines each text file via the glob walker", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "AAA");
  fs.writeFileSync(path.join(dir, "b.txt"), "BBB");
  const { blocks } = inlineFiles([{ dir: ".", include: ["**/*.txt"] }], { roots: [dir] });
  assert.equal(blocks.length, 2);
  assert.ok(blocks.join("\n").includes("AAA"));
  assert.ok(blocks.join("\n").includes("BBB"));
});

test("F3: file_id / file_url are rejected", () => {
  assert.throws(() => inlineFiles([{ file_id: "x" }], { roots: [tmpDir()] }), /file_id|file_url|not supported/i);
  assert.throws(() => inlineFiles([{ file_url: "http://x" }], { roots: [tmpDir()] }), /file_id|file_url|not supported/i);
});

test("F4: a file over the per-file cap is skipped with a note", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(5000));
  const { blocks, notes } = inlineFiles([{ path: "big.txt" }], { roots: [dir], perFileCap: 1000 });
  assert.equal(blocks.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /big\.txt/);
  assert.match(notes[0], /skipped/i);
});

test("F5: aggregate cap stops adding further files and notes the omission", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "x".repeat(800));
  fs.writeFileSync(path.join(dir, "b.txt"), "y".repeat(800));
  const { blocks, notes } = inlineFiles([{ dir: ".", include: ["**/*.txt"] }], { roots: [dir], perFileCap: 2000, totalCap: 1000 });
  assert.equal(blocks.length, 1);
  assert.ok(notes.some((n) => /omitted|aggregate|budget/i.test(n)));
});
