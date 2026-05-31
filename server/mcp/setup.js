#!/usr/bin/env node
"use strict";

/**
 * deliberation-setup - onboarding helper for non-Claude MCP hosts.
 *
 * Separate bin from the stdio server (index.js). The server owns stdout for the
 * JSON-RPC channel and must stay silent; this is its own process, so it prints
 * setup guidance freely.
 *
 * Behavior:
 *   - Resolve the WRITE path (canonical XDG, honoring DELIBERATION_CONFIG; never
 *     legacy) and, separately, the legacy `~/.claude/...` read path.
 *   - Safe write, never clobber: if the canonical config already exists, print
 *     the suggested consensus block plus guidance and leave the file untouched
 *     so the user merges by hand. If it is absent, create the parent dir and
 *     write a starter config with a consensus block and a commented openrouter
 *     example.
 *   - Migration: if the canonical config is ABSENT and a legacy config exists,
 *     copy legacy -> canonical (exclusive write), print what it did, and leave
 *     the legacy file untouched (no delete, no .bak). If BOTH exist, canonical
 *     wins and a one-line notice says the legacy file is ignored. No merge.
 *   - Print which env key each provider needs and the recommended cross-host
 *     arbiter.
 *   - Exit 0 on success, non-zero only on a real error (e.g. unwritable dir).
 *
 * Zero runtime deps, bundle-safe: no fs reads of bundled repo files. It reads
 * and writes the user's config path at runtime - that is user data, not a
 * bundled asset.
 */

const fs = require("node:fs");
const path = require("node:path");
const { resolveConfigPath, legacyConfigPath } = require("../../core/paths.js");

/** Starter config written when none exists. Consensus arbiter defaults to "auto". */
const STARTER_CONFIG = {
  version: 1,
  consensus: { arbiter: "auto" },
  openrouter: {
    enabled: false,
    models: [],
  },
};

/**
 * Starter config file text: pretty-printed JSON. The openrouter:<alias> example
 * is printed to stdout, not embedded (JSON has no comments).
 * @returns {string}
 */
function starterConfigText() {
  return JSON.stringify(STARTER_CONFIG, null, 2) + "\n";
}

/**
 * Lines shown for the openrouter example. Printed to stdout (not written into
 * the JSON, which cannot carry comments).
 * @returns {string[]}
 */
function openrouterExampleLines() {
  return [
    "Example openrouter model entry (add under openrouter.models, set enabled: true):",
    '  { "alias": "claude", "model": "anthropic/claude-3.7-sonnet", "askAll": true, "consensus": true }',
    "Then reference it as the arbiter with consensus.arbiter = \"openrouter:claude\".",
  ];
}

/**
 * Provider env-key and login guidance. Kept short.
 * @returns {string[]}
 */
function providerGuidanceLines() {
  return [
    "Provider setup:",
    "  GPT (Codex)   - install the Codex CLI and run `codex login` (no env key).",
    "  Gemini        - install Antigravity and run `agy` once to sign in (no env key).",
    "  Grok (xAI)    - set XAI_API_KEY in the server env.",
    "  OpenRouter    - set OPENROUTER_API_KEY and declare models in the config.",
    "",
    "Recommended cross-host arbiter: openrouter:<a claude alias> (an out-of-panel",
    "Claude model), so consensus is adjudicated by a model that is not one of the",
    "voting providers. Set it with consensus.arbiter in the config.",
  ];
}

/**
 * The suggested consensus block, shown when the config already exists so the
 * user can merge it by hand.
 * @returns {string[]}
 */
function consensusBlockLines() {
  return [
    "Suggested consensus block (merge into your existing config):",
    '  "consensus": { "arbiter": "auto" }',
  ];
}

/**
 * The subset of fs runSetup needs. Lets tests inject a partial mock without
 * satisfying the full node:fs surface.
 * @typedef {Object} FsLike
 * @property {(p: string) => { isFile: () => boolean }} statSync
 * @property {(p: string, opts?: { recursive?: boolean }) => string | undefined} mkdirSync
 * @property {(p: string, data: string, opts?: { flag?: string }) => void} writeFileSync
 * @property {(p: string, enc: string) => string} [readFileSync] Used only by the legacy->canonical migration.
 * @property {(p: string) => boolean} [existsSync] Optional fast existence probe; falls back to statSync.
 * @property {(p: string) => void} [unlinkSync] Optional cleanup of a partial file after a failed write.
 */

/**
 * Run setup against an injected fs/env/out for testability. Returns the exit
 * code; the CLI wrapper calls process.exit with it.
 *
 * @param {Object} [deps]
 * @param {FsLike} [deps.fsImpl] fs implementation (default node:fs).
 * @param {NodeJS.ProcessEnv} [deps.env] environment (default process.env).
 * @param {(line: string) => void} [deps.out] stdout sink (default console.log).
 * @param {string} [deps.home] home dir override forwarded to resolveConfigPath.
 * @returns {number} exit code (0 success, non-zero on a real error)
 */
function runSetup(deps) {
  const fsImpl = (deps && deps.fsImpl) || fs;
  const env = (deps && deps.env) || process.env;
  const out = (deps && deps.out) || ((line) => console.log(line));
  const home = deps && deps.home;

  // Write to the canonical (XDG) target, never legacy. The legacy path is read
  // only for the one-time migration below. When DELIBERATION_CONFIG is set it
  // replaces BOTH branches, so migration is moot - suppress the legacy path so
  // we never copy an unrelated `~/.claude` config into an explicit override.
  const configPath = resolveConfigPath({ home, env, forWrite: true });
  const override = env.DELIBERATION_CONFIG;
  const hasOverride = typeof override === "string" && override.length > 0;
  const legacyPath = hasOverride ? configPath : legacyConfigPath({ home, env });

  /** @param {string[]} lines */
  const print = (lines) => {
    for (const line of lines) out(line);
  };

  out("deliberation setup");
  out("");

  /**
   * Best-effort existence check via the injected fs. Returns false on any error
   * so a missing or unstattable legacy path never aborts setup.
   * @param {string} p
   * @returns {boolean}
   */
  const fileExists = (p) => {
    if (typeof fsImpl.existsSync === "function") {
      try { return fsImpl.existsSync(p); } catch (_) { return false; }
    }
    try { return fsImpl.statSync(p).isFile(); } catch (_) { return false; }
  };

  /** Guidance printed when a regular-file config already exists: leave it, merge by hand. */
  const leaveUnchanged = () => {
    out(`Config already exists at ${configPath} - leaving it unchanged.`);
    // Canonical wins. If a legacy config also exists, say so once - it is read
    // for back-compat only when the canonical one is absent, so it is ignored here.
    if (legacyPath !== configPath && fileExists(legacyPath)) {
      out(`Note: a legacy config at ${legacyPath} is ignored (canonical wins). No merge.`);
    }
    out("");
    print(consensusBlockLines());
    out("");
    print(openrouterExampleLines());
    out("");
    print(providerGuidanceLines());
    return 0;
  };

  // Stat first. If the path exists and is a regular file, leave it alone. If it
  // exists but is NOT a regular file (e.g. DELIBERATION_CONFIG points at a
  // directory), fail loudly - the server cannot read it.
  let stat = null;
  try {
    stat = fsImpl.statSync(configPath);
  } catch (_) {
    stat = null; // ENOENT (or unstattable) -> fall through to write.
  }
  if (stat) {
    if (stat.isFile()) return leaveUnchanged();
    out(`Config path ${configPath} is not a regular file - refusing to write.`);
    return 1;
  }

  // Canonical is absent. If a legacy config exists, migrate it (copy legacy ->
  // canonical) instead of writing a fresh starter. The legacy file is left
  // untouched - no delete, no .bak.
  let migrated = false;
  /** @type {string} */
  let payload = starterConfigText();
  if (legacyPath !== configPath && typeof fsImpl.readFileSync === "function" && fileExists(legacyPath)) {
    // FIX 1: the legacy config exists but its read threw (EACCES/transient). Do
    // NOT write a starter - a starter at canonical would win every future read
    // and permanently shadow the user's real legacy config. Bail out so the user
    // fixes the underlying error and re-runs.
    try {
      payload = fsImpl.readFileSync(legacyPath, "utf8");
      migrated = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out(`Could not read legacy config at ${legacyPath}: ${message}. Refusing to write a starter that would shadow it - fix the permission and re-run.`);
      return 1;
    }
  }

  // FIX 3: create the parent dir in its own try so a mkdir failure (e.g. a parent
  // component is a regular file -> EEXIST/ENOTDIR) is reported as a dir error and
  // not mistaken for the write-side TOCTOU EEXIST that means "already exists".
  try {
    fsImpl.mkdirSync(path.dirname(configPath), { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out(`Could not create config directory ${path.dirname(configPath)}: ${message}`);
    return 1;
  }

  try {
    // Exclusive write: "wx" fails with EEXIST if a file appears between the stat
    // above and here (TOCTOU). Treat that race as "already exists, unchanged".
    fsImpl.writeFileSync(configPath, payload, { flag: "wx" });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : null;
    if (code === "EEXIST") return leaveUnchanged();
    const message = err instanceof Error ? err.message : String(err);
    // FIX 2: a mid-write failure (ENOSPC/EACCES) can leave a truncated/empty file.
    // Since canonical now exists, future reads skip the legacy fallback and crash
    // on JSON.parse. Remove the partial file before reporting. Ignore unlink errors.
    if (fileExists(configPath) && typeof fsImpl.unlinkSync === "function") {
      try { fsImpl.unlinkSync(configPath); } catch (_) { /* best effort */ }
    }
    out(`Could not write config at ${configPath}: ${message}`);
    return 1;
  }

  if (migrated) {
    out(`Migrated legacy config ${legacyPath} -> ${configPath} (legacy left untouched).`);
  } else {
    out(`Wrote starter config at ${configPath}.`);
  }
  out("");
  print(openrouterExampleLines());
  out("");
  print(providerGuidanceLines());
  out("");
  out("Next: set the env keys for the providers you use, then point your MCP");
  out("host at the deliberation server (npx -y @antonbabenko/deliberation-mcp).");
  return 0;
}

module.exports = { runSetup, starterConfigText, STARTER_CONFIG };

// CLI entry: only run when invoked directly, not when required by a test.
if (require.main === module) {
  process.exit(runSetup());
}
