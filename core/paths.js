"use strict";

/**
 * core/paths.js - shared config + cache path resolver for deliberation.
 *
 * Zero runtime dependencies. CommonJS. JSDoc-typed so it passes strict `tsc`
 * (it is inside the strict tsconfig include).
 *
 * Resolves which on-disk file the bridges and the unified server should use.
 * Host-neutral: a standalone (Codex/Kiro/Cursor) user may not have Claude Code
 * installed, so the canonical location is the OS-standard XDG base dir, not
 * `~/.claude`. The legacy `~/.claude/...` location is still READ for back-compat
 * (Claude Code users who set up before this change keep working) but is never
 * the fresh-write target.
 *
 * Exports:
 *   - resolveConfigPath(opts?)    -> config.json to use (read-with-fallback by
 *                                    default; canonical-only when forWrite:true)
 *   - resolveGrokCachePath(opts?) -> grok-files.json cache to use
 *
 * Both accept an optional `{ home, env, platform, exists }` injection so callers
 * (and tests) can point at a temp HOME, a fake env, a fixed platform, and a fake
 * existence probe without touching real process state or the filesystem. When
 * omitted they default to os.homedir(), process.env, process.platform, and
 * fs.existsSync.
 */

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

/**
 * @typedef {Object} ResolveOptions
 * @property {string} [home] Home directory to resolve `~/...` against. Defaults to os.homedir().
 * @property {NodeJS.ProcessEnv} [env] Environment to read overrides from. Defaults to process.env.
 * @property {NodeJS.Platform} [platform] Platform string. Defaults to process.platform.
 * @property {(p: string) => boolean} [exists] Existence probe. Defaults to fs.existsSync.
 * @property {boolean} [forWrite] When true, resolveConfigPath returns the canonical write target only (never legacy).
 */

/**
 * Resolve `{home, env, platform, exists}` with defaults. Internal helper so each
 * resolver reads the same injection points.
 * @param {ResolveOptions} [opts]
 */
function resolveInjection(opts) {
  return {
    home: (opts && opts.home) || os.homedir(),
    env: (opts && opts.env) || process.env,
    platform: (opts && opts.platform) || process.platform,
    exists: (opts && opts.exists) || fs.existsSync,
  };
}

/**
 * Canonical config dir per platform (no filename). macOS/Linux use
 * `$XDG_CONFIG_HOME` or `~/.config`; Windows uses `%APPDATA%` or
 * `~/AppData/Roaming`.
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function canonicalConfigDir(home, env, platform) {
  if (platform === "win32") {
    const appData = env.APPDATA;
    const base = typeof appData === "string" && appData.length > 0
      ? appData
      : path.join(home, "AppData", "Roaming");
    return path.join(base, "deliberation");
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = typeof xdg === "string" && xdg.length > 0 ? xdg : path.join(home, ".config");
  return path.join(base, "deliberation");
}

/**
 * Legacy config dir (read-only back-compat). Driven by `CLAUDE_CONFIG_DIR` or
 * `~/.claude`. `CLAUDE_CONFIG_DIR` affects ONLY this legacy branch.
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function legacyConfigDir(home, env) {
  const claudeDir = env.CLAUDE_CONFIG_DIR;
  const base = typeof claudeDir === "string" && claudeDir.length > 0 ? claudeDir : path.join(home, ".claude");
  return path.join(base, "deliberation");
}

/**
 * Resolve the absolute path to the config.json the caller should use.
 *
 * Read precedence (default):
 *   1. DELIBERATION_CONFIG if non-empty -> return it verbatim. Wins everywhere.
 *   2. Canonical XDG path IF it exists.
 *   3. Legacy `~/.claude/deliberation/config.json` IF it exists (read-only back-compat).
 *   4. Else canonical (the fresh-write default).
 *
 * Existence only - this never inspects file CONTENTS. If the canonical file
 * exists but is invalid JSON, the config reader reports the parse error; it does
 * NOT fall back to legacy on a parse error. The resolver is pure (path logic +
 * existence probe) and has no copy/write side effects.
 *
 * Write target (forWrite:true):
 *   1. DELIBERATION_CONFIG if non-empty -> verbatim.
 *   2. Else canonical. NEVER legacy.
 *
 * @param {ResolveOptions} [opts]
 * @returns {string} absolute path to the config.json to use
 */
function resolveConfigPath(opts) {
  const { home, env, platform, exists } = resolveInjection(opts);

  const override = env.DELIBERATION_CONFIG;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }

  const canonical = path.join(canonicalConfigDir(home, env, platform), "config.json");
  if (opts && opts.forWrite) return canonical;

  if (exists(canonical)) return canonical;

  const legacy = path.join(legacyConfigDir(home, env), "config.json");
  if (exists(legacy)) return legacy;

  return canonical;
}

/**
 * Resolve the absolute legacy config path (`${CLAUDE_CONFIG_DIR or ~/.claude}/deliberation/config.json`).
 *
 * Exposed so the setup migration can detect a legacy config and copy it to the
 * canonical location without re-deriving the legacy layout. Pure: path logic
 * only, no FS access. Independent of DELIBERATION_CONFIG (that override replaces
 * both branches, so a migration is moot when it is set).
 *
 * @param {ResolveOptions} [opts]
 * @returns {string} absolute path to the legacy config.json
 */
function legacyConfigPath(opts) {
  const { home, env } = resolveInjection(opts);
  return path.join(legacyConfigDir(home, env), "config.json");
}

/**
 * Canonical cache dir per platform (no filename). macOS/Linux use
 * `$XDG_CACHE_HOME` or `~/.cache`; Windows uses `%LOCALAPPDATA%` (LOCAL, not
 * Roaming) or `~/AppData/Local`.
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function canonicalCacheDir(home, env, platform) {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const base = typeof localAppData === "string" && localAppData.length > 0
      ? localAppData
      : path.join(home, "AppData", "Local");
    return path.join(base, "deliberation");
  }
  const xdg = env.XDG_CACHE_HOME;
  const base = typeof xdg === "string" && xdg.length > 0 ? xdg : path.join(home, ".cache");
  return path.join(base, "deliberation");
}

/**
 * Legacy cache dir (read-only back-compat): `${CLAUDE_CONFIG_DIR or ~/.claude}/cache/deliberation`.
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function legacyCacheDir(home, env) {
  const claudeDir = env.CLAUDE_CONFIG_DIR;
  const base = typeof claudeDir === "string" && claudeDir.length > 0 ? claudeDir : path.join(home, ".claude");
  return path.join(base, "cache", "deliberation");
}

/**
 * Resolve the absolute path to the Grok files cache the caller should use.
 *
 * Precedence:
 *   1. DELIBERATION_CACHE if non-empty -> verbatim.
 *   2. Canonical XDG cache path IF it exists.
 *   3. Legacy `~/.claude/cache/deliberation/grok-files.json` IF it exists (read-only back-compat).
 *   4. Else canonical (the fresh-write default).
 *
 * Single resolver (reads-or-creates the cache): prefer canonical for a new
 * cache, fall back to reading legacy if it is already present.
 *
 * @param {ResolveOptions} [opts]
 * @returns {string} absolute path to the grok-files.json cache to use
 */
function resolveGrokCachePath(opts) {
  const { home, env, platform, exists } = resolveInjection(opts);

  const override = env.DELIBERATION_CACHE;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }

  const canonical = path.join(canonicalCacheDir(home, env, platform), "grok-files.json");
  if (exists(canonical)) return canonical;

  const legacy = path.join(legacyCacheDir(home, env), "grok-files.json");
  if (exists(legacy)) return legacy;

  return canonical;
}

module.exports = {
  resolveConfigPath,
  resolveGrokCachePath,
  legacyConfigPath,
};
