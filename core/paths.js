"use strict";

/**
 * core/paths.js - shared config + cache path resolver for the deliberation rebrand.
 *
 * Zero runtime dependencies. CommonJS. JSDoc-typed so it passes strict `tsc`
 * (it is inside the strict tsconfig include).
 *
 * Resolves which on-disk file the bridges and the unified server should use,
 * preferring the new `deliberation` paths while transparently migrating from the
 * legacy `claude-delegator` paths. Migration is a best-effort side effect: on any
 * filesystem error it degrades to reading the legacy file in place and never throws.
 *
 * Exports:
 *   - resolveConfigPath(opts?)    -> absolute path to the config.json to use
 *   - resolveGrokCachePath(opts?) -> absolute path to the grok-files.json cache to use
 *
 * Both accept an optional `{ home, env }` injection so callers (and tests) can
 * point at a temp HOME and a fake env without mutating real process state. When
 * omitted they default to `os.homedir()` and `process.env`.
 */

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

/**
 * @typedef {Object} ResolveOptions
 * @property {string} [home] Home directory to resolve `~/.claude/...` against. Defaults to os.homedir().
 * @property {NodeJS.ProcessEnv} [env] Environment to read overrides from. Defaults to process.env.
 */

// --- warn-once state (module scope, one print per distinct warning per process) ---
let warnedEnvConflict = false;
let warnedConfigMigrate = false;
let warnedGrokMigrate = false;

/**
 * Emit a one-line stderr note at most once per process for a given flag.
 * @param {"envConflict"|"configMigrate"|"grokMigrate"} kind
 * @param {string} message
 * @returns {void}
 */
function warnOnce(kind, message) {
  if (kind === "envConflict") {
    if (warnedEnvConflict) return;
    warnedEnvConflict = true;
  } else if (kind === "configMigrate") {
    if (warnedConfigMigrate) return;
    warnedConfigMigrate = true;
  } else if (kind === "grokMigrate") {
    if (warnedGrokMigrate) return;
    warnedGrokMigrate = true;
  }
  process.stderr.write(message.endsWith("\n") ? message : message + "\n");
}

/**
 * Test-only hook: reset the warn-once flags so each test can observe a fresh
 * "at most once" window. Not part of the public Wave-1 contract.
 * @returns {void}
 */
function _resetWarnOnceForTests() {
  warnedEnvConflict = false;
  warnedConfigMigrate = false;
  warnedGrokMigrate = false;
}

/**
 * True if the path exists on disk.
 * @param {string} p
 * @returns {boolean}
 */
function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Atomically migrate `legacyPath` -> `newPath`: mkdir -p the new dir, write the
 * legacy contents to a temp file in the NEW dir, then renameSync onto newPath.
 * Leaves the legacy file in place (enables downgrade). On ANY error, cleans up
 * the temp file and rethrows so the caller can fall back to legacy-in-place.
 *
 * @param {string} legacyPath
 * @param {string} newPath
 * @returns {void}
 */
function atomicMigrate(legacyPath, newPath) {
  const newDir = path.dirname(newPath);
  const tmpPath = newPath + ".tmp-" + process.pid;
  fs.mkdirSync(newDir, { recursive: true });
  try {
    const data = fs.readFileSync(legacyPath);
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, newPath);
  } catch (err) {
    // Best-effort temp cleanup; never let cleanup mask the original error.
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Core precedence shared by config + grok-cache resolution (minus env override).
 *
 * 1. NEW path exists -> return NEW (no migration).
 * 2. LEGACY exists -> migrate atomically -> return NEW. On migration failure,
 *    warn-once and return LEGACY (read in place this run).
 * 3. Neither exists -> return NEW (fresh install; caller creates on first write).
 *
 * @param {string} newPath
 * @param {string} legacyPath
 * @param {"configMigrate"|"grokMigrate"} warnKind
 * @param {string} label Human label used in the migration-failure warning.
 * @returns {string}
 */
function resolveWithMigration(newPath, legacyPath, warnKind, label) {
  if (exists(newPath)) return newPath;

  if (exists(legacyPath)) {
    try {
      atomicMigrate(legacyPath, newPath);
      return newPath;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnOnce(
        warnKind,
        "[deliberation] could not migrate " +
          label +
          " from " +
          legacyPath +
          " to " +
          newPath +
          " (" +
          reason +
          "); reading legacy path in place.",
      );
      return legacyPath;
    }
  }

  return newPath;
}

/**
 * Resolve the absolute path to the config.json the caller should use, performing
 * legacy->new migration as a side effect when needed.
 *
 * Precedence:
 *   1. Env override (verbatim, NO migration):
 *      - DELIBERATION_CONFIG if non-empty -> return it.
 *      - else CLAUDE_DELEGATOR_CONFIG if non-empty -> return it (legacy honored).
 *      - if BOTH set, DELIBERATION_CONFIG wins and a one-line stderr note is
 *        emitted (warn-once).
 *   2. NEW `~/.claude/deliberation/config.json` if it exists -> return it.
 *   3. LEGACY `~/.claude/claude-delegator/config.json` if it exists -> migrate
 *      atomically -> return NEW (or LEGACY in place if migration fails).
 *   4. Neither exists -> return NEW (fresh install).
 *
 * @param {ResolveOptions} [opts]
 * @returns {string} absolute path to the config.json to use
 */
function resolveConfigPath(opts) {
  const home = (opts && opts.home) || os.homedir();
  const env = (opts && opts.env) || process.env;

  const deliberationEnv = env.DELIBERATION_CONFIG;
  const legacyEnv = env.CLAUDE_DELEGATOR_CONFIG;
  const hasDeliberationEnv =
    typeof deliberationEnv === "string" && deliberationEnv.length > 0;
  const hasLegacyEnv = typeof legacyEnv === "string" && legacyEnv.length > 0;

  if (hasDeliberationEnv) {
    if (hasLegacyEnv) {
      warnOnce(
        "envConflict",
        "[deliberation] both DELIBERATION_CONFIG and CLAUDE_DELEGATOR_CONFIG are set; using DELIBERATION_CONFIG.",
      );
    }
    return deliberationEnv;
  }
  if (hasLegacyEnv) {
    return legacyEnv;
  }

  const newPath = path.join(home, ".claude", "deliberation", "config.json");
  const legacyPath = path.join(
    home,
    ".claude",
    "claude-delegator",
    "config.json",
  );

  return resolveWithMigration(newPath, legacyPath, "configMigrate", "config");
}

/**
 * Resolve the absolute path to the Grok files cache the caller should use,
 * performing legacy->new migration as a side effect when needed. Same precedence
 * shape as resolveConfigPath but with NO env override (the grok cache has none).
 *
 * NEW    `~/.claude/cache/deliberation/grok-files.json`
 * LEGACY `~/.claude/cache/claude-delegator/grok-files.json`
 *
 * @param {ResolveOptions} [opts]
 * @returns {string} absolute path to the grok-files.json cache to use
 */
function resolveGrokCachePath(opts) {
  const home = (opts && opts.home) || os.homedir();

  const newPath = path.join(
    home,
    ".claude",
    "cache",
    "deliberation",
    "grok-files.json",
  );
  const legacyPath = path.join(
    home,
    ".claude",
    "cache",
    "claude-delegator",
    "grok-files.json",
  );

  return resolveWithMigration(newPath, legacyPath, "grokMigrate", "grok cache");
}

module.exports = {
  resolveConfigPath,
  resolveGrokCachePath,
  _resetWarnOnceForTests,
};
