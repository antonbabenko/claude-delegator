"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { runSetup, STARTER_CONFIG } = require("../server/mcp/setup.js");

/** Make an isolated temp HOME; never touches the real ~/.claude. */
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-setup-"));
}
function rmrf(/** @type {string} */ dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
/** Capture stdout lines from runSetup. */
function capture() {
  /** @type {string[]} */
  const lines = [];
  return { out: (/** @type {string} */ l) => lines.push(l), lines };
}

// SU1: config absent -> writes a starter with a consensus block, exit 0.
test("SU1: absent config -> writes starter with consensus block", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out });

    assert.equal(code, 0);
    assert.equal(fs.existsSync(override), true);
    const written = JSON.parse(fs.readFileSync(override, "utf8"));
    assert.deepEqual(written.consensus, { arbiter: "auto" });
    assert.deepEqual(written, STARTER_CONFIG);
    assert.ok(lines.some((l) => l.includes("Wrote starter config")));
  } finally {
    rmrf(home);
  }
});

// SU2: config exists -> never clobbered; guidance emitted, exit 0.
test("SU2: existing config -> not overwritten, guidance emitted", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    fs.mkdirSync(path.dirname(override), { recursive: true });
    const original = '{"version":1,"my":"custom","openrouter":{"enabled":true,"models":[]}}';
    fs.writeFileSync(override, original);

    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out });

    assert.equal(code, 0);
    assert.equal(fs.readFileSync(override, "utf8"), original); // byte-for-byte unchanged
    assert.ok(lines.some((l) => l.includes("leaving it unchanged")));
    assert.ok(lines.some((l) => l.includes('"consensus"'))); // suggested block printed
  } finally {
    rmrf(home);
  }
});

// SU3: unwritable parent -> non-zero exit, real error reported, nothing thrown.
test("SU3: unwritable target -> exit 1 with error message", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    const fsImpl = {
      statSync: () => { const e = new Error("ENOENT"); /** @type {any} */ (e).code = "ENOENT"; throw e; },
      mkdirSync: () => { throw new Error("EACCES: permission denied"); },
      writeFileSync: () => { throw new Error("should not reach writeFileSync"); },
    };
    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out, fsImpl });

    assert.equal(code, 1);
    assert.ok(lines.some((l) => l.includes("Could not write config")));
  } finally {
    rmrf(home);
  }
});

// SU4: config path is a DIRECTORY -> exit 1, no write, clear message.
test("SU4: existing path is a directory -> exit 1, no write, clear message", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    fs.mkdirSync(override, { recursive: true }); // create a dir AT the config path
    const before = fs.readdirSync(override);

    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out });

    assert.equal(code, 1);
    assert.equal(fs.statSync(override).isDirectory(), true); // still a dir, nothing written into it as a file
    assert.deepEqual(fs.readdirSync(override), before); // untouched
    assert.ok(lines.some((l) => l.includes("not a regular file")));
  } finally {
    rmrf(home);
  }
});

// SU5: TOCTOU - file appears between stat and write -> EEXIST treated as unchanged, exit 0.
test("SU5: write race (EEXIST) -> leave unchanged, exit 0", () => {
  const home = makeHome();
  try {
    const override = path.join(home, "cfg", "config.json");
    const fsImpl = {
      statSync: () => { const e = new Error("ENOENT"); /** @type {any} */ (e).code = "ENOENT"; throw e; },
      mkdirSync: () => undefined,
      writeFileSync: () => { const e = new Error("EEXIST: file already exists"); /** @type {any} */ (e).code = "EEXIST"; throw e; },
    };
    const { out, lines } = capture();
    const code = runSetup({ env: { DELIBERATION_CONFIG: override }, out, fsImpl });

    assert.equal(code, 0);
    assert.ok(lines.some((l) => l.includes("leaving it unchanged")));
  } finally {
    rmrf(home);
  }
});
