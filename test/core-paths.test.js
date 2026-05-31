"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { resolveConfigPath, resolveGrokCachePath } = require("../core/paths.js");

// --- helpers -----------------------------------------------------------------
//
// Pure unit tests: no real FS. A fixed HOME and an injected `exists` probe that
// answers from an explicit set of "present" paths model the disk.

const HOME = "/home/tester";

/** Build an exists probe that returns true only for paths in `present`. */
function existsFor(/** @type {string[]} */ present) {
  const set = new Set(present);
  return (/** @type {string} */ p) => set.has(p);
}

/** exists probe that says nothing is on disk. */
const noneExist = () => false;

function canonicalConfig(/** @type {string} */ home) {
  return path.join(home, ".config", "deliberation", "config.json");
}
function legacyConfig(/** @type {string} */ home) {
  return path.join(home, ".claude", "deliberation", "config.json");
}
function canonicalCache(/** @type {string} */ home) {
  return path.join(home, ".cache", "deliberation", "grok-files.json");
}
function legacyCache(/** @type {string} */ home) {
  return path.join(home, ".claude", "cache", "deliberation", "grok-files.json");
}

// --- config: env override ----------------------------------------------------

test("CP1: DELIBERATION_CONFIG wins verbatim (read)", () => {
  const override = "/somewhere/custom/my-config.json";
  const got = resolveConfigPath({
    home: HOME,
    env: { DELIBERATION_CONFIG: override },
    platform: "linux",
    exists: noneExist,
  });
  assert.equal(got, override);
});

test("CP2: DELIBERATION_CONFIG wins verbatim (write)", () => {
  const override = "/somewhere/custom/my-config.json";
  const got = resolveConfigPath({
    home: HOME,
    env: { DELIBERATION_CONFIG: override },
    platform: "linux",
    exists: noneExist,
    forWrite: true,
  });
  assert.equal(got, override);
});

test("CP3: empty DELIBERATION_CONFIG falls through to canonical", () => {
  const got = resolveConfigPath({
    home: HOME,
    env: { DELIBERATION_CONFIG: "" },
    platform: "linux",
    exists: noneExist,
  });
  assert.equal(got, canonicalConfig(HOME));
});

// --- config: canonical / legacy precedence -----------------------------------

test("CP4: canonical exists -> canonical (read)", () => {
  const got = resolveConfigPath({
    home: HOME,
    env: {},
    platform: "linux",
    exists: existsFor([canonicalConfig(HOME)]),
  });
  assert.equal(got, canonicalConfig(HOME));
});

test("CP5: legacy only -> legacy (read-only back-compat)", () => {
  const got = resolveConfigPath({
    home: HOME,
    env: {},
    platform: "linux",
    exists: existsFor([legacyConfig(HOME)]),
  });
  assert.equal(got, legacyConfig(HOME));
});

test("CP6: both exist -> canonical wins", () => {
  const got = resolveConfigPath({
    home: HOME,
    env: {},
    platform: "linux",
    exists: existsFor([canonicalConfig(HOME), legacyConfig(HOME)]),
  });
  assert.equal(got, canonicalConfig(HOME));
});

test("CP7: none exist -> canonical (fresh-write default)", () => {
  const got = resolveConfigPath({
    home: HOME,
    env: {},
    platform: "linux",
    exists: noneExist,
  });
  assert.equal(got, canonicalConfig(HOME));
});

test("CP8: forWrite never returns legacy even when only legacy exists", () => {
  const got = resolveConfigPath({
    home: HOME,
    env: {},
    platform: "linux",
    exists: existsFor([legacyConfig(HOME)]),
    forWrite: true,
  });
  assert.equal(got, canonicalConfig(HOME));
});

// --- config: XDG_CONFIG_HOME + CLAUDE_CONFIG_DIR scope ------------------------

test("CP9: XDG_CONFIG_HOME relocates canonical only", () => {
  const xdg = "/xdg/cfg";
  const canonical = path.join(xdg, "deliberation", "config.json");
  const got = resolveConfigPath({
    home: HOME,
    env: { XDG_CONFIG_HOME: xdg },
    platform: "linux",
    exists: existsFor([canonical]),
  });
  assert.equal(got, canonical);
});

test("CP10: CLAUDE_CONFIG_DIR moves only the legacy branch, never the canonical default", () => {
  const claudeDir = "/custom/claude";
  const legacy = path.join(claudeDir, "deliberation", "config.json");
  // legacy present at the relocated dir -> read it
  const readLegacy = resolveConfigPath({
    home: HOME,
    env: { CLAUDE_CONFIG_DIR: claudeDir },
    platform: "linux",
    exists: existsFor([legacy]),
  });
  assert.equal(readLegacy, legacy);
  // nothing present -> canonical default, unaffected by CLAUDE_CONFIG_DIR
  const fresh = resolveConfigPath({
    home: HOME,
    env: { CLAUDE_CONFIG_DIR: claudeDir },
    platform: "linux",
    exists: noneExist,
  });
  assert.equal(fresh, canonicalConfig(HOME));
});

// --- config: windows shape ---------------------------------------------------

test("CP11: win32 uses APPDATA (Roaming) for canonical config", () => {
  const appData = "C:\\Users\\tester\\AppData\\Roaming";
  const canonical = path.join(appData, "deliberation", "config.json");
  const got = resolveConfigPath({
    home: "C:\\Users\\tester",
    env: { APPDATA: appData },
    platform: "win32",
    exists: existsFor([canonical]),
  });
  assert.equal(got, canonical);
});

test("CP12: win32 without APPDATA falls back to ~/AppData/Roaming", () => {
  const home = "C:\\Users\\tester";
  const got = resolveConfigPath({
    home,
    env: {},
    platform: "win32",
    exists: noneExist,
  });
  assert.equal(got, path.join(home, "AppData", "Roaming", "deliberation", "config.json"));
});

// --- config: relative XDG base must be ignored (XDG spec) ---------------------

test("CP13: relative XDG_CONFIG_HOME is ignored -> canonical default (~/.config)", () => {
  const got = resolveConfigPath({
    home: HOME,
    env: { XDG_CONFIG_HOME: "relative/cfg" },
    platform: "linux",
    exists: noneExist,
  });
  assert.equal(got, canonicalConfig(HOME));
});

test("CP14: win32 relative APPDATA is ignored -> ~/AppData/Roaming fallback", () => {
  const home = "C:\\Users\\tester";
  const got = resolveConfigPath({
    home,
    env: { APPDATA: "relative\\roaming" },
    platform: "win32",
    exists: noneExist,
  });
  assert.equal(got, path.join(home, "AppData", "Roaming", "deliberation", "config.json"));
});

// --- cache: env override + precedence ----------------------------------------

test("CC1: DELIBERATION_CACHE wins verbatim", () => {
  const override = "/somewhere/custom/grok-files.json";
  const got = resolveGrokCachePath({
    home: HOME,
    env: { DELIBERATION_CACHE: override },
    platform: "linux",
    exists: noneExist,
  });
  assert.equal(got, override);
});

test("CC2: none exist -> canonical cache (fresh-write default)", () => {
  const got = resolveGrokCachePath({
    home: HOME,
    env: {},
    platform: "linux",
    exists: noneExist,
  });
  assert.equal(got, canonicalCache(HOME));
});

test("CC3: legacy only -> legacy cache (read-only back-compat)", () => {
  const got = resolveGrokCachePath({
    home: HOME,
    env: {},
    platform: "linux",
    exists: existsFor([legacyCache(HOME)]),
  });
  assert.equal(got, legacyCache(HOME));
});

test("CC4: both exist -> canonical cache wins", () => {
  const got = resolveGrokCachePath({
    home: HOME,
    env: {},
    platform: "linux",
    exists: existsFor([canonicalCache(HOME), legacyCache(HOME)]),
  });
  assert.equal(got, canonicalCache(HOME));
});

test("CC5: XDG_CACHE_HOME relocates canonical cache", () => {
  const xdg = "/xdg/cache";
  const canonical = path.join(xdg, "deliberation", "grok-files.json");
  const got = resolveGrokCachePath({
    home: HOME,
    env: { XDG_CACHE_HOME: xdg },
    platform: "linux",
    exists: existsFor([canonical]),
  });
  assert.equal(got, canonical);
});

test("CC8: relative XDG_CACHE_HOME is ignored -> canonical default (~/.cache)", () => {
  const got = resolveGrokCachePath({
    home: HOME,
    env: { XDG_CACHE_HOME: "relative/cache" },
    platform: "linux",
    exists: noneExist,
  });
  assert.equal(got, canonicalCache(HOME));
});

test("CC9: win32 relative LOCALAPPDATA is ignored -> ~/AppData/Local fallback", () => {
  const home = "C:\\Users\\tester";
  const got = resolveGrokCachePath({
    home,
    env: { LOCALAPPDATA: "relative\\local" },
    platform: "win32",
    exists: noneExist,
  });
  assert.equal(got, path.join(home, "AppData", "Local", "deliberation", "grok-files.json"));
});

test("CC6: win32 uses LOCALAPPDATA (Local, not Roaming) for canonical cache", () => {
  const localAppData = "C:\\Users\\tester\\AppData\\Local";
  const canonical = path.join(localAppData, "deliberation", "grok-files.json");
  const got = resolveGrokCachePath({
    home: "C:\\Users\\tester",
    env: { LOCALAPPDATA: localAppData },
    platform: "win32",
    exists: existsFor([canonical]),
  });
  assert.equal(got, canonical);
});

test("CC7: win32 without LOCALAPPDATA falls back to ~/AppData/Local", () => {
  const home = "C:\\Users\\tester";
  const got = resolveGrokCachePath({
    home,
    env: {},
    platform: "win32",
    exists: noneExist,
  });
  assert.equal(got, path.join(home, "AppData", "Local", "deliberation", "grok-files.json"));
});

// --- cache: forWrite (canonical-only, legacy is read-only) -------------------

test("CC10: forWrite returns canonical even when only legacy exists", () => {
  const got = resolveGrokCachePath({
    home: HOME,
    env: {},
    platform: "linux",
    exists: existsFor([legacyCache(HOME)]),
    forWrite: true,
  });
  assert.equal(got, canonicalCache(HOME));
});

test("CC11: forWrite returns canonical when both exist (never legacy)", () => {
  const got = resolveGrokCachePath({
    home: HOME,
    env: {},
    platform: "linux",
    exists: existsFor([canonicalCache(HOME), legacyCache(HOME)]),
    forWrite: true,
  });
  assert.equal(got, canonicalCache(HOME));
});

test("CC12: forWrite honors DELIBERATION_CACHE verbatim", () => {
  const override = "/somewhere/custom/grok-files.json";
  const got = resolveGrokCachePath({
    home: HOME,
    env: { DELIBERATION_CACHE: override },
    platform: "linux",
    exists: existsFor([legacyCache(HOME)]),
    forWrite: true,
  });
  assert.equal(got, override);
});
