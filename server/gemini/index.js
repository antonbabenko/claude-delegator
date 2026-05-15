#!/usr/bin/env node

/**
 * Claude Delegator - Gemini MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Gemini CLI.
 * Speaks JSON-RPC 2.0 over stdio.
 */

const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_MODEL = process.env.GEMINI_DEFAULT_MODEL || "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes (Gemini 3 deep prompts run 200-260s)
const DEFAULT_RECOVERY_GRACE_MS = 120_000; // extra drain budget after the soft timeout
const RECOVERY_POLL_MS = 1_000;
const RECOVERY_SKEW_MS = 2_000; // clock-skew tolerance for the stale-answer guard
const MAX_MS = 600_000;
const VALID_SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);

// --- MCP Protocol Helpers ---

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result
  }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  }) + "\n");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasRequestId(request) {
  return isObject(request) && Object.prototype.hasOwnProperty.call(request, "id");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// --- Error Classification ---

// Pure helper: given a runGemini rejection's message and code, produce the
// structured error fields the orchestrator consumes. Exported for tests.
function classifyGeminiError(errMsg, errCode) {
  const msg = String(errMsg || "");
  const lower = msg.toLowerCase();
  if (errCode === "timeout") return { errorKind: "timeout", retryable: true };
  if (errCode === "parse")   return { errorKind: "parse",   retryable: false };
  if (
    lower.includes("trusted directory") ||
    lower.includes("trust check") ||
    lower.includes("not a trusted folder")
  ) {
    return { errorKind: "trust", retryable: true, hint: "skip-trust" };
  }
  if (msg.includes("Gemini CLI not found")) return { errorKind: "missing-cli", retryable: false };
  if (lower.includes("aborterror") || lower.includes("aborted")) {
    return { errorKind: "upstream-abort", retryable: true };
  }
  return { errorKind: "unknown", retryable: false };
}

// --- Timeout Recovery ---
//
// The Gemini CLI ignores SIGTERM and persists its full answer to disk at
// ~/.gemini/tmp/<slug>/chats/session-*.jsonl regardless. When the bridge's
// soft timeout fires we drain (keep the CLI alive, poll the jsonl) and return
// the late-flushed answer instead of failing hard.

function geminiTmpRoot() {
  return process.env.GEMINI_TMP_ROOT || path.join(os.homedir(), ".gemini", "tmp");
}

function realOrSelf(p) {
  try { return fs.realpathSync(p); } catch (_) { return p; }
}

// Find the slug dir whose .project_root points at `cwd`. Slug names are not
// derivable reliably, so match by file content rather than name.
function resolveSlugDir(cwd, root) {
  const base = root || geminiTmpRoot();
  const target = realOrSelf(path.resolve(cwd));
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); }
  catch (_) { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const slugDir = path.join(base, e.name);
    let content;
    try { content = fs.readFileSync(path.join(slugDir, ".project_root"), "utf8"); }
    catch (_) { continue; }
    if (realOrSelf(path.resolve(content.trim())) === target) return slugDir;
  }
  return null;
}

function newestSessionFile(slugDir) {
  const chats = path.join(slugDir, "chats");
  let names;
  try { names = fs.readdirSync(chats); }
  catch (_) { return null; }
  let best = null, bestMtime = -1;
  for (const n of names) {
    if (!n.startsWith("session-") || !n.endsWith(".jsonl")) continue;
    const fp = path.join(chats, n);
    let st;
    try { st = fs.statSync(fp); } catch (_) { continue; }
    if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = fp; }
  }
  return best;
}

// Last `type:"gemini"` record whose timestamp is at/after the spawn start
// (stale-answer guard). threadId comes from the metadata record's sessionId.
function extractGeminiAnswer(filePath, sinceMs) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (_) { return null; }
  const floor = (typeof sinceMs === "number" ? sinceMs : 0) - RECOVERY_SKEW_MS;
  let threadId = "unknown";
  let answer = null;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch (_) { continue; }
    if (o && typeof o === "object" && o.sessionId && o.type === undefined) {
      threadId = o.sessionId;
      continue;
    }
    if (o && o.type === "gemini" && typeof o.content === "string") {
      const ts = Date.parse(o.timestamp);
      if (Number.isFinite(ts) && ts >= floor) answer = o.content;
    }
  }
  if (answer == null) return null;
  return { content: answer, threadId };
}

function tryRecoverOnce(cwd, spawnStartMs) {
  const slugDir = resolveSlugDir(cwd);
  if (!slugDir) return null;
  const f = newestSessionFile(slugDir);
  if (!f) return null;
  return extractGeminiAnswer(f, spawnStartMs);
}

// Poll for a recovered answer until found or `graceMs` is exhausted.
// `isAborted()` lets the caller stop the loop once the call settles elsewhere.
async function recoverAfterTimeout({ cwd, spawnStartMs, graceMs, pollMs, isAborted }) {
  const deadline = Date.now() + (graceMs > 0 ? graceMs : 0);
  const step = pollMs > 0 ? pollMs : RECOVERY_POLL_MS;
  for (;;) {
    if (isAborted && isAborted()) return null;
    const rec = tryRecoverOnce(cwd, spawnStartMs);
    if (rec) return rec;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

// --- Gemini CLI Wrapper ---

function lastJSONObject(s) {
  const spans = [];
  let depth = 0, start = -1, inStr = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (depth === 0) {
      // Outside any candidate object: only `{` is meaningful. Reset string state.
      inStr = false; escape = false;
      if (c === "{") { depth = 1; start = i; }
      continue;
    }
    // depth >= 1: track string + escape per JSON grammar
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") { depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        spans.push([start, i]);
        start = -1;
      } else if (depth < 0) {
        // Defensive: floor at 0, abandon the candidate.
        depth = 0; start = -1;
      }
    }
  }
  if (!spans.length) return null;
  const [a, b] = spans[spans.length - 1];
  return s.slice(a, b + 1);
}

async function runGemini(args, cwd, timeoutMs, recoveryGraceMs) {
  return new Promise((resolve, reject) => {
    const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const effCwd = cwd || process.cwd();
    const spawnStartMs = Date.now();
    const disableRecovery = process.env.GEMINI_DISABLE_TIMEOUT_RECOVERY === "1";
    const grace = disableRecovery
      ? 0
      : (typeof recoveryGraceMs === "number" && recoveryGraceMs >= 0
          ? recoveryGraceMs
          : DEFAULT_RECOVERY_GRACE_MS);

    let killed = false;   // legacy hard-kill path (grace === 0)
    let draining = false; // soft timeout fired, waiting for a disk-flushed answer
    let settled = false;
    let graceTimer = null;

    // Force JSON output for reliable parsing
    const geminiArgs = [...args, "-o", "json"];
    const geminiProcess = spawn("gemini", geminiArgs, {
      env: process.env,
      shell: false,
      cwd: effCwd
    });

    function clearTimers() { clearTimeout(killTimer); if (graceTimer) clearTimeout(graceTimer); }
    function destroyStreams() {
      try { geminiProcess.stdout.destroy(); } catch (_) {}
      try { geminiProcess.stderr.destroy(); } catch (_) {}
    }
    function timeoutError() {
      const err = new Error("Gemini timed out after " + Math.round(t / 1000) + "s");
      err.code = "timeout";
      return err;
    }
    function finishRecovered(rec) {
      if (settled) return;
      settled = true;
      clearTimers();
      try { geminiProcess.kill("SIGTERM"); } catch (_) {}
      setTimeout(() => { try { geminiProcess.kill("SIGKILL"); } catch (_) {} }, 1_000);
      destroyStreams();
      process.stderr.write(
        "[claude-delegator] recovered Gemini answer from disk after soft timeout (" +
        Math.round((Date.now() - spawnStartMs) / 1000) + "s)\n"
      );
      resolve({ response: rec.content, threadId: rec.threadId, recovered: true });
    }
    function finishTimeout() {
      if (settled) return;
      settled = true;
      clearTimers();
      try { geminiProcess.kill("SIGTERM"); } catch (_) {}
      setTimeout(() => { try { geminiProcess.kill("SIGKILL"); } catch (_) {} }, 1_000);
      destroyStreams();
      reject(timeoutError());
    }

    const killTimer = setTimeout(() => {
      if (settled) return;
      if (grace > 0) {
        // Drain: do NOT kill. Keep Gemini alive and poll the chat jsonl for a
        // record newer than spawn-start, up to the grace budget.
        draining = true;
        recoverAfterTimeout({
          cwd: effCwd,
          spawnStartMs,
          graceMs: grace,
          pollMs: RECOVERY_POLL_MS,
          isAborted: () => settled,
        }).then((rec) => {
          if (settled) return;
          if (rec) finishRecovered(rec);
          else finishTimeout();
        }).catch(() => { if (!settled) finishTimeout(); });
        return;
      }
      // Legacy hard-kill path.
      killed = true;
      try { geminiProcess.kill("SIGTERM"); } catch (_) {}
      graceTimer = setTimeout(() => {
        try { geminiProcess.kill("SIGKILL"); } catch (_) {}
      }, 1_000);
    }, t);

    geminiProcess.on("close", clearTimers);
    geminiProcess.on("error", clearTimers);

    // exit fires when the process itself exits even if child pipes are still
    // open. Surface the legacy timeout early without waiting for pipe drain.
    geminiProcess.on("exit", () => {
      if (killed && !settled) {
        settled = true;
        clearTimers();
        destroyStreams();
        reject(timeoutError());
      }
    });

    let stdout = "";
    let stderr = "";

    geminiProcess.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (err.code === "ENOENT") {
        reject(new Error("Gemini CLI not found. Please install it with 'npm install -g @google/gemini-cli'."));
      } else {
        reject(err);
      }
    });

    geminiProcess.stdout.on("data", (data) => { stdout += data.toString(); });
    geminiProcess.stderr.on("data", (data) => { stderr += data.toString(); });

    geminiProcess.on("close", (code) => {
      if (settled) return; // already resolved/rejected elsewhere
      if (killed) {        // legacy soft-timeout kill
        settled = true;
        clearTimers();
        return reject(timeoutError());
      }

      // Child exited on its own. Prefer real stdout JSON (normal completion,
      // including slow-but-finished during drain).
      const trimmedErr = stderr.trim();
      const jsonStr = lastJSONObject(stdout);
      if (jsonStr) {
        try {
          const data = JSON.parse(jsonStr);
          settled = true;
          clearTimers();
          return resolve({
            response: data.response || "(No output)",
            threadId: data.session_id || "unknown"
          });
        } catch (e) {
          if (!draining) {
            settled = true;
            clearTimers();
            const err = new Error(`Parse error: ${e.message}\nRaw output was: ${stdout}`);
            err.code = "parse";
            return reject(err);
          }
          // draining: fall through to disk recovery
        }
      }

      // Prefer stderr on failure so trust/auth errors are not masked by
      // stdout banners (issue #2).
      if (code !== 0 && trimmedErr) {
        settled = true;
        clearTimers();
        return reject(new Error(trimmedErr));
      }

      if (draining) {
        // Soft timeout already fired; the child is gone. One final disk check,
        // then give up (no point waiting the rest of the grace budget).
        const rec = tryRecoverOnce(effCwd, spawnStartMs);
        if (rec) return finishRecovered(rec);
        return finishTimeout();
      }

      if (code !== 0 && !stdout) {
        settled = true;
        clearTimers();
        return reject(new Error(`Gemini exited with code ${code}`));
      }

      settled = true;
      clearTimers();
      const err = new Error(`Parse error: No JSON response found\nRaw output was: ${stdout}`);
      err.code = "parse";
      reject(err);
    });
  });
}

// --- Request Handlers ---

const handlers = {
  "initialize": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "claude-delegator-gemini", version: "1.5.0" }
    });
  },

  "tools/list": (id, _params, shouldRespond) => {
    if (!shouldRespond) return;
    sendResponse(id, {
      tools: [
        {
          name: "gemini",
          description: "Start a new Gemini expert session",
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "The delegation prompt" },
              "developer-instructions": { type: "string", description: "Expert system instructions" },
              sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
              cwd: { type: "string", description: "Current working directory" },
              model: { type: "string", default: DEFAULT_MODEL },
              "include-directories": {
                type: "array",
                items: { type: "string" },
                description: "Additional directories to include in the workspace alongside cwd. Equivalent to --include-directories on the Gemini CLI."
              },
              timeout: { type: "number", description: "Soft timeout in ms. 1..600000. Default 300000. On expiry the bridge drains and recovers the disk-flushed answer instead of failing.", default: DEFAULT_TIMEOUT_MS },
              "recovery-grace": { type: "number", description: "Extra ms to keep Gemini alive after the soft timeout to recover a late-flushed answer from disk. 0..600000. Default 120000. 0 disables drain.", default: DEFAULT_RECOVERY_GRACE_MS },
              "skip-trust": { type: "boolean", description: "Pass --skip-trust to bypass the Gemini CLI's trusted-directory check. Read-only sandbox is still gated separately.", default: false }
            },
            required: ["prompt"]
          }
        },
        {
          name: "gemini-reply",
          description: "Continue an existing Gemini session",
          inputSchema: {
            type: "object",
            properties: {
              threadId: { type: "string", description: "Session ID returned by a previous gemini call" },
              prompt: { type: "string", description: "Follow-up prompt" },
              sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
              cwd: { type: "string" },
              "include-directories": {
                type: "array",
                items: { type: "string" },
                description: "Additional directories to include in the workspace alongside cwd. Equivalent to --include-directories on the Gemini CLI."
              },
              timeout: { type: "number", description: "Soft timeout in ms. 1..600000. Default 300000. On expiry the bridge drains and recovers the disk-flushed answer instead of failing.", default: DEFAULT_TIMEOUT_MS },
              "recovery-grace": { type: "number", description: "Extra ms to keep Gemini alive after the soft timeout to recover a late-flushed answer from disk. 0..600000. Default 120000. 0 disables drain.", default: DEFAULT_RECOVERY_GRACE_MS },
              "skip-trust": { type: "boolean", description: "Pass --skip-trust to bypass the Gemini CLI's trusted-directory check. Read-only sandbox is still gated separately.", default: false }
            },
            required: ["threadId", "prompt"]
          }
        }
      ]
    });
  },

  "tools/call": async (id, params, shouldRespond) => {
    if (!isObject(params)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: expected an object");
      return;
    }

    const { name, arguments: args } = params;
    if (!isNonEmptyString(name)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'name' must be a non-empty string");
      return;
    }
    if (!isObject(args)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'arguments' must be an object");
      return;
    }
    if (args.sandbox !== undefined && !VALID_SANDBOX_VALUES.has(args.sandbox)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'sandbox' must be 'read-only' or 'workspace-write'");
      return;
    }
    if (args.cwd !== undefined && !isNonEmptyString(args.cwd)) {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'cwd' must be a non-empty string when provided");
      return;
    }
    if (args.timeout !== undefined) {
      if (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout > 600_000) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'timeout' must be a number > 0 and <= 600000 milliseconds");
        return;
      }
    }
    if (args["recovery-grace"] !== undefined) {
      const g = args["recovery-grace"];
      if (typeof g !== "number" || !Number.isFinite(g) || g < 0 || g > MAX_MS) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'recovery-grace' must be a number >= 0 and <= 600000 milliseconds");
        return;
      }
    }
    if (args["skip-trust"] !== undefined && typeof args["skip-trust"] !== "boolean") {
      if (shouldRespond) sendError(id, -32602, "Invalid params: 'skip-trust' must be a boolean when provided");
      return;
    }
    if (args["include-directories"] !== undefined) {
      if (!Array.isArray(args["include-directories"]) || args["include-directories"].length === 0) {
        if (shouldRespond) sendError(id, -32602, "Invalid params: 'include-directories' must be a non-empty array of strings when provided");
        return;
      }
      for (const dir of args["include-directories"]) {
        if (!isNonEmptyString(dir)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: each entry in 'include-directories' must be a non-empty string");
          return;
        }
      }
    }

    try {
      const geminiArgs = [];
      if (name === "gemini") {
        if (args.model !== undefined && !isNonEmptyString(args.model)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'model' must be a non-empty string when provided");
          return;
        }
        if (!isNonEmptyString(args.prompt)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
          return;
        }
        if (args["developer-instructions"] !== undefined && typeof args["developer-instructions"] !== "string") {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'developer-instructions' must be a string when provided");
          return;
        }

        geminiArgs.push("-m", args.model || DEFAULT_MODEL);
        if (args["include-directories"]) {
          geminiArgs.push("--include-directories", args["include-directories"].join(","));
        }
        if (args["skip-trust"] === true) geminiArgs.push("--skip-trust");
        if (args.sandbox === "workspace-write") geminiArgs.push("-s");
        let prompt = args.prompt;
        if (args["developer-instructions"]) prompt = `${args["developer-instructions"]}\n\n${prompt}`;
        geminiArgs.push("-p", prompt);
      } else if (name === "gemini-reply") {
        if (!isNonEmptyString(args.threadId)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' is required for gemini-reply");
          return;
        }
        const threadId = args.threadId.trim();
        if (threadId === "latest") {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'threadId' must be an explicit session id, not 'latest'");
          return;
        }
        if (!isNonEmptyString(args.prompt)) {
          if (shouldRespond) sendError(id, -32602, "Invalid params: 'prompt' is required");
          return;
        }

        geminiArgs.push("--resume", threadId);
        if (args["include-directories"]) {
          geminiArgs.push("--include-directories", args["include-directories"].join(","));
        }
        if (args["skip-trust"] === true) geminiArgs.push("--skip-trust");
        if (args.sandbox === "workspace-write") geminiArgs.push("-s");
        geminiArgs.push("-p", args.prompt);
      } else {
        if (shouldRespond) sendError(id, -32601, `Tool not found: ${name}`);
        return;
      }

      const timeoutMs = (typeof args.timeout === "number" && args.timeout > 0) ? args.timeout : DEFAULT_TIMEOUT_MS;
      const recoveryGraceMs = (typeof args["recovery-grace"] === "number" && args["recovery-grace"] >= 0)
        ? args["recovery-grace"]
        : DEFAULT_RECOVERY_GRACE_MS;
      const { response, threadId, recovered } = await runGemini(geminiArgs, args.cwd, timeoutMs, recoveryGraceMs);

      // Return metadata (threadId) at the top level for orchestration rules,
      // and standard content array for the UI.
      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: response }],
          threadId: threadId,
          ...(recovered ? { recovered: true } : {})
        });
      }
    } catch (e) {
      const errMsg = (e && e.message) || String(e);
      const errCode = e && e.code;
      const { errorKind, retryable, hint } = classifyGeminiError(errMsg, errCode);

      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          isError: true,
          errorKind,
          retryable,
          ...(hint ? { hint } : {}),
        });
      }
    }
  },

  "notifications/initialized": () => {}
};

// --- Main Loop (Robust JSON-RPC stream handling) ---

let buffer = "";

if (require.main === module) {
  process.stdin.on("data", async (chunk) => {
    buffer += chunk.toString();
    let lines = buffer.split("\n");
    buffer = lines.pop(); // Keep partial line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      let request;
      try {
        request = JSON.parse(line);
      } catch (e) {
        // Ignore parse errors from noise
        continue;
      }

      const shouldRespond = hasRequestId(request);
      if (!isObject(request) || typeof request.method !== "string") {
        if (shouldRespond) sendError(request.id, -32600, "Invalid Request");
        continue;
      }

      const handler = handlers[request.method];
      if (!handler) {
        if (shouldRespond) sendError(request.id, -32601, `Method not found: ${request.method}`);
        continue;
      }

      try {
        await handler(request.id, request.params, shouldRespond);
      } catch (e) {
        if (shouldRespond) sendError(request.id, -32603, `Internal error: ${e.message}`);
      }
    }
  });

  // Startup Check
  try {
    execSync("gemini --version", { stdio: "ignore" });
  } catch (e) {
    console.error("Gemini CLI not found. Please install it first.");
    process.exit(1);
  }
}

// Test-only exports
if (typeof module !== "undefined" && module.exports) {
  module.exports.lastJSONObject = lastJSONObject;
  module.exports.classifyGeminiError = classifyGeminiError;
  module.exports.geminiTmpRoot = geminiTmpRoot;
  module.exports.resolveSlugDir = resolveSlugDir;
  module.exports.newestSessionFile = newestSessionFile;
  module.exports.extractGeminiAnswer = extractGeminiAnswer;
  module.exports.recoverAfterTimeout = recoverAfterTimeout;
}
