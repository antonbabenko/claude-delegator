#!/usr/bin/env node

/**
 * Claude Delegator - Gemini MCP Bridge
 *
 * A zero-dependency MCP server that wraps the Gemini CLI.
 * Speaks JSON-RPC 2.0 over stdio.
 */

const { spawn, execSync } = require("node:child_process");

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
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

async function runGemini(args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT_MS;
    let killed = false;
    let settled = false;
    let graceTimer = null;
    // Force JSON output for reliable parsing
    const geminiArgs = [...args, "-o", "json"];
    const geminiProcess = spawn("gemini", geminiArgs, {
      env: process.env,
      shell: false,
      cwd: cwd || process.cwd() // Ensure we run in the requested directory
    });
    const killTimer = setTimeout(() => {
      killed = true;
      try { geminiProcess.kill("SIGTERM"); } catch (_) {}
      graceTimer = setTimeout(() => {
        try { geminiProcess.kill("SIGKILL"); } catch (_) {}
      }, 1_000);
    }, t);
    function clearTimers() { clearTimeout(killTimer); if (graceTimer) clearTimeout(graceTimer); }
    geminiProcess.on("close", clearTimers);
    geminiProcess.on("error", clearTimers);

    // exit fires when the process itself exits even if child pipes are still open.
    // Use it to surface the timeout error early without waiting for pipe drain.
    // Destroy the child streams so orphaned grandchildren (e.g. sleep) holding
    // the pipe fds open do not keep our event loop alive.
    geminiProcess.on("exit", () => {
      if (killed && !settled) {
        settled = true;
        clearTimers();
        try { geminiProcess.stdout.destroy(); } catch (_) {}
        try { geminiProcess.stderr.destroy(); } catch (_) {}
        const err = new Error("Gemini timed out after " + Math.round(t / 1000) + "s");
        err.code = "timeout";
        reject(err);
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
      if (settled) return; // already resolved/rejected via exit event
      settled = true;
      if (killed) {
        const err = new Error("Gemini timed out after " + Math.round(t / 1000) + "s");
        err.code = "timeout";
        return reject(err);
      }
      if (code !== 0 && !stdout) {
        return reject(new Error(stderr.trim() || `Gemini exited with code ${code}`));
      }

      try {
        const jsonStr = lastJSONObject(stdout);
        if (!jsonStr) throw new Error("No JSON response found");
        const data = JSON.parse(jsonStr);
        resolve({
          response: data.response || "(No output)",
          threadId: data.session_id || "unknown"
        });
      } catch (e) {
        const err = new Error(`Parse error: ${e.message}\nRaw output was: ${stdout}`);
        err.code = "parse";
        reject(err);
      }
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
      serverInfo: { name: "claude-delegator-gemini", version: "1.2.1" }
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
              timeout: { type: "number", description: "Bridge-side timeout in ms before SIGTERM. 1..600000. Default 120000.", default: DEFAULT_TIMEOUT_MS },
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
              timeout: { type: "number", description: "Bridge-side timeout in ms before SIGTERM. 1..600000. Default 120000.", default: DEFAULT_TIMEOUT_MS },
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
      const { response, threadId } = await runGemini(geminiArgs, args.cwd, timeoutMs);

      // Return metadata (threadId) at the top level for orchestration rules,
      // and standard content array for the UI.
      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: response }],
          threadId: threadId
        });
      }
    } catch (e) {
      const errMsg = (e && e.message) || String(e);
      const errCode = e && e.code;
      let errorKind = "unknown", retryable = false;
      if (errCode === "timeout") { errorKind = "timeout"; retryable = true; }
      else if (errCode === "parse") { errorKind = "parse"; retryable = false; }
      else if (errMsg.includes("trusted directory")) { errorKind = "trust"; retryable = false; }
      else if (errMsg.includes("Gemini CLI not found")) { errorKind = "missing-cli"; retryable = false; }
      else if (errMsg.includes("AbortError") || errMsg.includes("aborted")) { errorKind = "upstream-abort"; retryable = true; }

      if (shouldRespond) {
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          isError: true,
          errorKind,
          retryable,
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
}
