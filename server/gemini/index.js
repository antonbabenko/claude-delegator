#!/usr/bin/env node

/**
 * Claude Delegator - Gemini MCP Bridge
 * 
 * A zero-dependency MCP server that wraps the Gemini CLI.
 * Speaks JSON-RPC 2.0 over stdio.
 */

const { spawn } = require("node:child_process");

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
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

// --- JSON Parsing ---

/**
 * Extract the Gemini response JSON from CLI stdout.
 * The -o json flag outputs a single JSON object, but terminal noise
 * (keychain warnings, ANSI codes) can appear before/after it.
 * Strategy: find JSON objects by scanning for balanced braces from the end.
 */
function parseGeminiOutput(raw) {
  const trimmed = raw.trim();

  // Fast path: entire output is valid JSON
  try { return JSON.parse(trimmed); } catch (_) {}

  // Find the last complete JSON object (most likely the response)
  let depth = 0;
  let end = -1;
  let start = -1;

  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch === '}') {
      if (end === -1) end = i;
      depth++;
    } else if (ch === '{') {
      depth--;
      if (depth === 0) {
        start = i;
        break;
      }
    }
  }

  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in output");
  }

  return JSON.parse(trimmed.slice(start, end + 1));
}

// --- Gemini CLI Wrapper ---

async function runGemini(args, cwd, timeoutMs) {
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const geminiArgs = [...args, "-o", "json"];
    const geminiProcess = spawn("gemini", geminiArgs, {
      env: process.env,
      shell: false,
      cwd: cwd || process.cwd()
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    // Kill process on timeout to prevent indefinite hangs
    const timer = setTimeout(() => {
      killed = true;
      geminiProcess.kill("SIGTERM");
      // Force kill after 5s grace period
      setTimeout(() => {
        try { geminiProcess.kill("SIGKILL"); } catch (_) {}
      }, 5_000);
    }, timeout);

    geminiProcess.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error("Gemini CLI not found. Install with: npm install -g @google/gemini-cli"));
      } else {
        reject(err);
      }
    });

    geminiProcess.stdout.on("data", (data) => { stdout += data.toString(); });
    geminiProcess.stderr.on("data", (data) => { stderr += data.toString(); });

    geminiProcess.on("close", (code) => {
      clearTimeout(timer);

      if (killed) {
        return reject(new Error(
          `Gemini timed out after ${Math.round(timeout / 1000)}s. ` +
          "Try a shorter prompt or a faster model (gemini-2.5-flash)."
        ));
      }

      if (code !== 0 && !stdout) {
        const msg = stderr.trim() || `Gemini exited with code ${code}`;
        // Surface actionable info from common failures
        if (msg.includes("AbortError") || msg.includes("aborted")) {
          return reject(new Error(
            "Gemini API request was aborted (upstream timeout). " +
            "Try a shorter prompt or check network connectivity."
          ));
        }
        return reject(new Error(msg));
      }

      try {
        const data = parseGeminiOutput(stdout);
        resolve({
          response: data.response || "(No output)",
          threadId: data.session_id || "unknown"
        });
      } catch (e) {
        reject(new Error(`Parse error: ${e.message}\nRaw stdout (last 500 chars): ${stdout.slice(-500)}`));
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
      serverInfo: { name: "claude-delegator-gemini", version: "1.3.0" }
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
              timeout: { type: "number", description: "Timeout in ms (default: 300000 = 5min)", default: DEFAULT_TIMEOUT_MS }
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
              timeout: { type: "number", description: "Timeout in ms (default: 300000 = 5min)", default: DEFAULT_TIMEOUT_MS }
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
        if (args.sandbox === "workspace-write") {
          geminiArgs.push("-s", "--approval-mode", "yolo");
        } else {
          geminiArgs.push("--approval-mode", "plan");
        }
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
        if (args.sandbox === "workspace-write") {
          geminiArgs.push("-s", "--approval-mode", "yolo");
        } else {
          geminiArgs.push("--approval-mode", "plan");
        }
        geminiArgs.push("-p", args.prompt);
      } else {
        if (shouldRespond) sendError(id, -32601, `Tool not found: ${name}`);
        return;
      }

      const timeoutMs = (typeof args.timeout === "number" && args.timeout > 0) ? args.timeout : undefined;
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
      if (shouldRespond) {
        const msg = e.message || String(e);
        const retryable = msg.includes("timed out") || msg.includes("aborted") || msg.includes("ECONNRESET");
        sendResponse(id, {
          content: [{ type: "text", text: `Error: ${msg}${retryable ? "\n\n[RETRYABLE] This error is transient — retry with a shorter prompt, faster model, or failover to the other provider." : ""}` }],
          isError: true,
          retryable
        });
      }
    }
  },

  "notifications/initialized": () => {} 
};

// --- Main Loop (Robust JSON-RPC stream handling) ---

let buffer = "";
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

// Startup check — non-blocking, fails fast without stalling the event loop
const check = spawn("gemini", ["--version"], { stdio: "ignore" });
check.on("error", () => {
  process.stderr.write("Gemini CLI not found. Install with: npm install -g @google/gemini-cli\n");
  process.exit(1);
});
check.on("close", (code) => {
  if (code !== 0) {
    process.stderr.write("Gemini CLI check failed. Ensure 'gemini' is on your PATH.\n");
    process.exit(1);
  }
});
