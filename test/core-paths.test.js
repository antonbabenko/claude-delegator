"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const {
  resolveConfigPath,
  resolveGrokCachePath,
  _resetWarnOnceForTests,
} = require("../core/paths.js");

// --- helpers -----------------------------------------------------------------

/** Make an isolated temp HOME; never touches the real ~/.claude. */
function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-paths-"));
}

function rmrf(/** @type {string} */ dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function configNewPath(/** @type {string} */ home) {
  return path.join(home, ".claude", "deliberation", "config.json");
}
function configLegacyPath(/** @type {string} */ home) {
  return path.join(home, ".claude", "claude-delegator", "config.json");
}
function grokNewPath(/** @type {string} */ home) {
  return path.join(home, ".claude", "cache", "deliberation", "grok-files.json");
}
function grokLegacyPath(/** @type {string} */ home) {
  return path.join(
    home,
    ".claude",
    "cache",
    "claude-delegator",
    "grok-files.json",
  );
}

function writeFile(/** @type {string} */ p, /** @type {string} */ contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

// --- tests -------------------------------------------------------------------

// (a) both exist -> returns NEW, no migration side effect on legacy.
test("CP1: both new and legacy exist -> returns NEW, legacy untouched", () => {
  _resetWarnOnceForTests();
  const home = makeHome();
  try {
    writeFile(configNewPath(home), '{"src":"new"}');
    writeFile(configLegacyPath(home), '{"src":"legacy"}');

    const got = resolveConfigPath({ home, env: {} });

    assert.equal(got, configNewPath(home));
    // legacy still has its original contents (no copy over it, no deletion)
    assert.equal(fs.readFileSync(configLegacyPath(home), "utf8"), '{"src":"legacy"}');
    assert.equal(fs.readFileSync(configNewPath(home), "utf8"), '{"src":"new"}');
  } finally {
    rmrf(home);
  }
});

// (b) only legacy exists -> returns NEW path AND new file now exists w/ legacy contents.
test("CP2: only legacy exists -> migrates atomically, returns NEW with legacy contents", () => {
  _resetWarnOnceForTests();
  const home = makeHome();
  try {
    writeFile(configLegacyPath(home), '{"src":"legacy-only"}');

    const got = resolveConfigPath({ home, env: {} });

    assert.equal(got, configNewPath(home));
    assert.equal(fs.existsSync(configNewPath(home)), true);
    assert.equal(fs.readFileSync(configNewPath(home), "utf8"), '{"src":"legacy-only"}');
    // legacy left in place for downgrade
    assert.equal(fs.existsSync(configLegacyPath(home)), true);
    // no leaked temp files in the new dir
    const newDir = path.dirname(configNewPath(home));
    const leftovers = fs.readdirSync(newDir).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmrf(home);
  }
});

// (c) DELIBERATION_CONFIG set -> returns it verbatim, no migration.
test("CP3: DELIBERATION_CONFIG wins verbatim, no migration", () => {
  _resetWarnOnceForTests();
  const home = makeHome();
  try {
    // legacy on disk should be ignored entirely when env override is set
    writeFile(configLegacyPath(home), '{"src":"legacy"}');
    const override = path.join(home, "custom", "my-config.json");

    const got = resolveConfigPath({ home, env: { DELIBERATION_CONFIG: override } });

    assert.equal(got, override);
    // no migration happened: new path was never created
    assert.equal(fs.existsSync(configNewPath(home)), false);
  } finally {
    rmrf(home);
  }
});

// (d) only CLAUDE_DELEGATOR_CONFIG set -> returns it verbatim.
test("CP4: legacy env CLAUDE_DELEGATOR_CONFIG honored verbatim when new env unset", () => {
  _resetWarnOnceForTests();
  const home = makeHome();
  try {
    const legacyOverride = path.join(home, "custom", "legacy-config.json");

    const got = resolveConfigPath({
      home,
      env: { CLAUDE_DELEGATOR_CONFIG: legacyOverride },
    });

    assert.equal(got, legacyOverride);
    assert.equal(fs.existsSync(configNewPath(home)), false);
  } finally {
    rmrf(home);
  }
});

// (c+d combined) both env set -> DELIBERATION_CONFIG wins.
test("CP5: both env vars set -> DELIBERATION_CONFIG wins", () => {
  _resetWarnOnceForTests();
  const home = makeHome();
  try {
    const newOverride = path.join(home, "a.json");
    const legacyOverride = path.join(home, "b.json");

    const got = resolveConfigPath({
      home,
      env: {
        DELIBERATION_CONFIG: newOverride,
        CLAUDE_DELEGATOR_CONFIG: legacyOverride,
      },
    });

    assert.equal(got, newOverride);
  } finally {
    rmrf(home);
  }
});

// (e) copy failure -> returns LEGACY path, does NOT throw.
test("CP6: migration copy failure -> falls back to legacy path, does not throw", () => {
  _resetWarnOnceForTests();
  const home = makeHome();
  try {
    writeFile(configLegacyPath(home), '{"src":"legacy-only"}');

    // Make the NEW parent dir (~/.claude/deliberation) un-mkdir-able by
    // planting a regular FILE where the directory needs to be. mkdirSync of a
    // child under a file path throws ENOTDIR -> migration fails -> fallback.
    const newDir = path.dirname(configNewPath(home));
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.writeFileSync(newDir, "i am a file, not a dir");

    let got;
    assert.doesNotThrow(() => {
      got = resolveConfigPath({ home, env: {} });
    });

    assert.equal(got, configLegacyPath(home));
    // legacy still intact
    assert.equal(fs.readFileSync(configLegacyPath(home), "utf8"), '{"src":"legacy-only"}');
  } finally {
    rmrf(home);
  }
});

// (f) resolveGrokCachePath: only-legacy -> migrates to new cache path.
test("CP7: grok cache only-legacy -> migrates atomically to new cache path", () => {
  _resetWarnOnceForTests();
  const home = makeHome();
  try {
    writeFile(grokLegacyPath(home), '{"files":["legacy"]}');

    const got = resolveGrokCachePath({ home });

    assert.equal(got, grokNewPath(home));
    assert.equal(fs.existsSync(grokNewPath(home)), true);
    assert.equal(fs.readFileSync(grokNewPath(home), "utf8"), '{"files":["legacy"]}');
    assert.equal(fs.existsSync(grokLegacyPath(home)), true);
  } finally {
    rmrf(home);
  }
});

// grok cache: neither exists -> returns NEW (fresh install).
test("CP8: grok cache neither exists -> returns NEW path, no file created", () => {
  _resetWarnOnceForTests();
  const home = makeHome();
  try {
    const got = resolveGrokCachePath({ home });
    assert.equal(got, grokNewPath(home));
    assert.equal(fs.existsSync(grokNewPath(home)), false);
  } finally {
    rmrf(home);
  }
});

// config: neither exists -> returns NEW (fresh install).
test("CP9: config neither exists -> returns NEW path, no file created", () => {
  _resetWarnOnceForTests();
  const home = makeHome();
  try {
    const got = resolveConfigPath({ home, env: {} });
    assert.equal(got, configNewPath(home));
    assert.equal(fs.existsSync(configNewPath(home)), false);
  } finally {
    rmrf(home);
  }
});
