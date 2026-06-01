#!/usr/bin/env node
"use strict";
/** Minimal stdio JSON-RPC MCP server over deliberation-core. Zero deps. */
/** @typedef {import("../../core/types.js").Provider} Provider */
/** @typedef {import("../../core/types.js").DelegationRequest} DelegationRequest */

const { makeRegistry, pinAlias } = require("../../core/registry.js");
const { askAll, askOne, consensus } = require("../../core/orchestrate.js");
const { PROMPTS } = require("../../core/prompts/index.js");

const ADVISORY = { readOnlyHint: true };
/** @type {Record<string, string>} */
const ASK_PROVIDER = { "ask-gpt": "codex", "ask-gemini": "gemini", "ask-grok": "grok", "ask-openrouter": "openrouter" };
const EXPERTS = ["architect", "plan-reviewer", "scope-analyst", "code-reviewer", "security-analyst", "researcher", "debugger"];

/**
 * One-line guidance per expert, surfaced in tools/list. Non-Claude hosts read
 * these descriptions to pick a tool, so each states the persona + when to use it.
 * @type {Record<string, string>}
 */
const EXPERT_DESCRIPTIONS = {
  "architect": "Software architect for system design, tradeoff analysis, and complex decisions. Use for architecture, API/schema design, multi-service interactions, or when a fix has failed twice and needs a fresh perspective.",
  "plan-reviewer": "Work-plan reviewer that verifies a plan is executable before anyone builds. Use to validate an implementation plan for clarity, completeness, and gaps before starting significant work.",
  "scope-analyst": "Pre-planning consultant that catches ambiguities, hidden requirements, and pitfalls before planning begins. Use when a request is vague or could be interpreted multiple ways.",
  "code-reviewer": "Senior engineer doing code review for bugs, security holes, and maintainability - not style nitpicks. Use to review a diff or file before merging.",
  "security-analyst": "Security engineer for threat modeling and vulnerability assessment. Use for auth/authorization changes, untrusted input handling, new endpoints, or a focused security audit.",
  "researcher": "Research specialist for external libraries, frameworks, APIs, and open-source code. Use for 'how do I use X', best-practice, or 'why does this dependency behave this way' questions, with evidence and honest unverified flags.",
  "debugger": "Debugging specialist that produces ranked root-cause hypotheses and the smallest safe fix from a bug report, logs, and code - or says honestly that the evidence shows no bug. Use for crashes, failing tests, or wrong output.",
};

function inputSchema() {
  return {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      expert: { type: "string" },
      developerInstructions: { type: "string" },
      cwd: { type: "string" },
      reasoningEffort: { type: "string", enum: ["low", "medium", "high", "none"] },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            dir: { type: "string" },
            file_id: { type: "string" },
            file_url: { type: "string" },
            mode: { type: "string", enum: ["auto", "inline", "upload"] },
          },
        },
      },
    },
  };
}

// Session tools take a sessionId (+ note for annotate), NOT a prompt - so they
// need their OWN input schemas rather than the prompt-required inputSchema().
function sessionGetInputSchema() {
  // `cwd` is advertised (optional) so session-revisit can resolve the original
  // file refs against the caller's workspace, not the server process dir. It
  // flows through req.cwd -> childReq.cwd. session-get ignores it harmlessly.
  return { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, cwd: { type: "string" } } };
}
function sessionAnnotateInputSchema() {
  return { type: "object", required: ["sessionId", "note"], properties: { sessionId: { type: "string" }, note: { type: "string" } } };
}

function toolList() {
  /** @type {any[]} */
  const tools = [
    { name: "ask-all", description: "Fan out one question to GPT, Gemini, Grok, and any configured OpenRouter models in parallel for independent second opinions, then return all results (advisory, no cross-contamination). Pass `expert` to apply a persona to every delegate.", inputSchema: inputSchema(), annotations: ADVISORY },
    { name: "consensus", description: "Fan out one question to all enabled providers, then run a single arbiter pass that cross-reviews the independent opinions and returns one synthesized verdict (advisory). Pass `expert` to apply a persona to the fan-out and arbiter.", inputSchema: inputSchema(), annotations: ADVISORY },
  ];
  for (const t of Object.keys(ASK_PROVIDER)) {
    tools.push({ name: t, description: `Single-provider second opinion via ${ASK_PROVIDER[t]} (advisory, single-shot). Pass \`expert\` to apply one of the expert personas.`, inputSchema: inputSchema(), annotations: ADVISORY });
  }
  for (const e of EXPERTS) {
    tools.push({ name: e, description: EXPERT_DESCRIPTIONS[e], inputSchema: inputSchema(), annotations: ADVISORY });
  }
  // Session store tools (opt-in; report "disabled" when sessions.persist is off).
  tools.push({ name: "session-get", description: "Fetch a persisted consensus/ask-all session record by id (opinions, verdict, arbiter, annotations). Requires sessions.persist; advisory, read-only.", inputSchema: sessionGetInputSchema(), annotations: ADVISORY });
  tools.push({ name: "session-revisit", description: "Re-run a persisted session's original question with the CURRENT providers/config and save a linked child record (parentId). Requires sessions.persist; advisory.", inputSchema: sessionGetInputSchema(), annotations: ADVISORY });
  tools.push({ name: "session-annotate", description: "Append a freeform note to a persisted session's audit trail. Requires sessions.persist; writes to the local session store.", inputSchema: sessionAnnotateInputSchema() });
  return tools;
}

/** @typedef {{ mode: "host"|"server", provider: (Provider|null), warning?: string }} ArbiterResolution */

const BUILTIN_NAMES = new Set(["codex", "gemini", "grok"]);

/**
 * Resolve the configured arbiter spec into an execution decision. Host-agnostic:
 * any host can name a concrete arbiter instead of relying on the implicit
 * providers[0]. Soft-degrade only - an unusable spec falls back to "auto" with a
 * warning rather than failing the consensus call.
 *
 * The spec is the NORMALIZED arbiter from config (resolveConsensus): either a
 * shorthand string or an object { model: "<id>" }.
 *
 * - "host"          -> { mode:"host", provider:null }. The handler SKIPS the
 *                      arbiter pass entirely (verdict:null); the host arbitrates.
 * - "auto"          -> first provider in `selected` whose health() is ok,
 *                      PREFERRING an openrouter:* one; falls back to selected[0].
 * - builtin         -> registry.get(name) if registered + enabled, else degrade.
 * - { model: id }   -> pinAlias on the openrouter provider for that models id,
 *                      else degrade to auto + warning. The id need NOT be
 *                      consensus:true - arbiter eligibility != panel membership.
 *
 * @param {string|{model:string}} spec
 * @param {Provider[]} selected  the consensus voting panel
 * @param {{get:(n:string)=>(Provider|undefined)}} registry
 * @param {() => any} getConfig
 * @returns {Promise<ArbiterResolution>}
 */
async function resolveArbiter(spec, selected, registry, getConfig) {
  if (spec === "host") return { mode: "host", provider: null };

  /** @param {string|undefined} warning @returns {Promise<ArbiterResolution>} pick first healthy, prefer openrouter:* */
  async function auto(warning) {
    const checked = await Promise.all(
      selected.map(async (p) => ({ p, ok: await isHealthy(p) }))
    );
    const healthy = checked.filter((c) => c.ok).map((c) => c.p);
    const pool = healthy.length ? healthy : selected;
    const preferred = pool.find((p) => p.name.startsWith("openrouter:")) || pool[0] || null;
    const base = `auto-selected arbiter '${preferred ? preferred.name : "none"}'; set consensus.arbiter to choose`;
    return { mode: "server", provider: preferred, warning: warning ? `${warning}; ${base}` : base };
  }

  if (spec === "auto") return auto(undefined);

  const cfg = getConfig() || {};

  // Object form { model: "<id>" }: pin that models entry as the arbiter.
  if (spec && typeof spec === "object") {
    const id = spec.model;
    const orProvider = registry.get("openrouter");
    const models = (cfg.openrouter && cfg.openrouter.models) || [];
    const model = models.find((/** @type {any} */ m) => m && m.alias === id);
    // OpenRouter must be enabled both as a provider and as the openrouter block.
    const orEnabled = providerEnabled(cfg, "openrouter") && !(cfg.openrouter && cfg.openrouter.enabled === false);
    if (orProvider && model && orEnabled) return { mode: "server", provider: pinAlias(orProvider, model) };
    return auto(`configured arbiter model '${id}' is not available`);
  }

  if (BUILTIN_NAMES.has(spec)) {
    const p = registry.get(spec);
    // Mirror core/registry.js builtinsFor: a provider disabled in config is not
    // a usable arbiter even though the registry still holds it (enablement is
    // applied at selection time, not at registry build). Degrade, never hard-fail.
    if (p && providerEnabled(cfg, spec)) return { mode: "server", provider: p };
    return auto(`configured arbiter '${spec}' is not available`);
  }

  // Unrecognized spec (config validation should have degraded it already; this
  // is a defensive second guard so the handler never trusts a raw spec).
  return auto(`configured arbiter '${spec}' is not recognized`);
}

/**
 * Whether a provider is enabled in config. Mirrors core/registry.js: a missing
 * flag means enabled; only an explicit enabled:false disables it.
 * @param {any} cfg
 * @param {string} name
 * @returns {boolean}
 */
function providerEnabled(cfg, name) {
  const p = cfg && cfg.providers && cfg.providers[name];
  return !p || p.enabled !== false;
}

/**
 * Best-effort health probe. A provider whose health() throws is treated as not
 * healthy rather than crashing arbiter selection.
 * @param {Provider} p
 * @returns {Promise<boolean>}
 */
async function isHealthy(p) {
  try {
    const h = await p.health();
    return !!(h && h.ok);
  } catch {
    return false;
  }
}

/**
 * @param {Object} deps
 * @param {Provider[]} deps.providers
 * @param {() => any} deps.getConfig
 * @param {() => (string|null)} [deps.getConfigError]  // last config load error (e.g. JSON parse), or null
 * @param {string} [deps.sessionsDir]  // dir for the opt-in session store; omit to disable persistence
 */
function buildServer({ providers, getConfig, getConfigError, sessionsDir }) {
  const registry = makeRegistry(providers);
  const sessions = /** @type {any} */ (require("../../core/sessions.js"));

  // Client identity for arbiter-default selection. Connection-scoped: set from the
  // MCP `initialize` handshake (clientInfo.name) for the life of this stdio session.
  let clientName = /** @type {string|null} */ (null);

  /**
   * Whether this server is running under Claude Code (or another Claude host).
   * Primary signal: Claude Code injects `CLAUDECODE=1` into stdio MCP subprocess
   * env (Claude Code CHANGELOG v2.1.147) - deterministic + documented. Secondary:
   * a `clientInfo.name` containing "claude" (e.g. Claude Desktop). Used ONLY to
   * pick the DEFAULT arbiter when the user has not set `consensus.arbiter`.
   * @returns {boolean}
   */
  function isClaudeHost() {
    if (process.env.CLAUDECODE === "1") return true;
    return typeof clientName === "string" && clientName.toLowerCase().includes("claude");
  }

  /**
   * Inject the bundled persona for `expert` when the caller did not supply its
   * own developerInstructions. Caller-supplied instructions ALWAYS win, so the
   * Claude Code path (which passes its own persona) is unchanged. Returns a new
   * request - never mutates the input.
   * @param {DelegationRequest} request
   * @param {string|undefined} expert
   * @returns {DelegationRequest}
   */
  function withPersona(request, expert) {
    if (!expert) return request;
    if (request.developerInstructions) return request;
    // Own-property check: an untrusted args.expert could be an inherited key
    // ("constructor", "__proto__", "toString"), which would otherwise resolve up
    // the prototype chain to a truthy non-string and corrupt developerInstructions.
    const persona = Object.prototype.hasOwnProperty.call(PROMPTS, expert) ? PROMPTS[expert] : undefined;
    if (!persona) return request;
    return { ...request, developerInstructions: persona };
  }

  // --- session store wiring -------------------------------------------------
  // Persistence is opt-in (sessions.persist) AND requires a configured dir. When
  // either is missing, the session-* tools report "disabled" and the
  // consensus/ask-all paths write nothing / return no sessionId.

  /** @returns {{persist:boolean, maxRecords:number, maxAgeDays:number}} */
  function sessionsCfg() {
    const c = getConfig() || {};
    const s = c.sessions || {};
    return {
      persist: !!s.persist,
      maxRecords: typeof s.maxRecords === "number" ? s.maxRecords : sessions.DEFAULT_MAX_RECORDS,
      maxAgeDays: typeof s.maxAgeDays === "number" ? s.maxAgeDays : sessions.DEFAULT_MAX_AGE_DAYS,
    };
  }
  /** @returns {boolean} */
  function persistEnabled() {
    return !!sessionsDir && sessionsCfg().persist;
  }

  /** @param {any} obj @returns {{content:{type:string,text:string}[]}} */
  function jsonResult(obj) {
    return { content: [{ type: "text", text: JSON.stringify(obj) }] };
  }
  function disabledMsg() {
    return jsonResult({ error: "session persistence is disabled (set sessions.persist)" });
  }
  /** @param {unknown} id */
  function notFoundMsg(id) {
    return jsonResult({ error: `session not found: ${String(id)}` });
  }

  /** @param {any} files @returns {({path:string}[]|null)} input attachment REFS only (paths), never bodies */
  function refsFromFiles(files) {
    if (!Array.isArray(files)) return null;
    /** @type {{path:string}[]} */
    const refs = [];
    for (const f of files) {
      if (f && typeof f.path === "string") refs.push({ path: f.path });
    }
    return refs.length ? refs : null;
  }
  /** @param {any} results @returns {{provider:string, model:string, text:(string|undefined)}[]} */
  function opinionsFrom(results) {
    if (!Array.isArray(results)) return [];
    return results.map((r) => ({
      provider: r && r.provider,
      model: r && r.model,
      text: r && r.isError === false && typeof r.text === "string" ? r.text : undefined,
    }));
  }
  /** @param {any} result @returns {(string|null)} the verdict text, or null */
  function textOf(result) {
    if (!result) return null;
    if (typeof result === "string") return result;
    if (result.isError === false && typeof result.text === "string") return result.text;
    return null;
  }

  /**
   * Persist a completed run when persistence is on. Best-effort: a write failure
   * never fails the tool call. Returns the new sessionId, or null when off.
   * @param {("consensus"|"ask-all")} tool
   * @param {DelegationRequest} req
   * @param {string|undefined} expert
   * @param {any} parts  // { opinions, blindVerdict?, verdict?, arbiter?, warnings?, parentId? }
   * @returns {(string|null)}
   */
  function persistRun(tool, req, expert, parts) {
    if (!persistEnabled()) return null;
    const cfg = sessionsCfg();
    const id = sessions.newSessionId();
    const record = {
      id,
      parentId: parts.parentId == null ? null : parts.parentId,
      schemaVersion: sessions.SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      tool,
      question: typeof req.prompt === "string" ? req.prompt : "",
      expert: expert || null,
      files: refsFromFiles(req.files),
      opinions: opinionsFrom(parts.opinions),
      blindVerdict: textOf(parts.blindVerdict),
      verdict: textOf(parts.verdict),
      arbiter: parts.arbiter || null,
      warnings: Array.isArray(parts.warnings) ? parts.warnings : [],
      annotations: [],
    };
    try {
      sessions.writeSession(record, { dir: sessionsDir, maxRecords: cfg.maxRecords, maxAgeDays: cfg.maxAgeDays });
      return id;
    } catch {
      return null;
    }
  }

  /**
   * Run the ask-all fan-out. Returns the response payload plus the parts needed
   * to persist a record. Shared by the ask-all tool and session-revisit.
   * @param {DelegationRequest} req
   * @param {string|undefined} expert
   * @returns {Promise<{payload:any, parts:any}>}
   */
  async function runAskAll(req, expert) {
    const { providers: selected, omitted } = registry.selectForAskAll({ config: getConfig(), expert: expert || "" });
    const results = await askAll(selected, withPersona(req, expert));
    return {
      payload: { results, omitted },
      parts: { opinions: results, blindVerdict: null, verdict: null, arbiter: null, warnings: [] },
    };
  }

  /**
   * Run the consensus fan-out + arbiter resolution. Returns the response payload
   * plus the parts needed to persist a record. Shared by the consensus tool and
   * session-revisit.
   * @param {DelegationRequest} req
   * @param {string|undefined} expert
   * @returns {Promise<{payload:any, parts:any}>}
   */
  async function runConsensus(req, expert) {
    const cfg = getConfig() || {};
    const { providers: selected } = registry.selectForConsensus({ config: cfg, expert: expert || "" });
    const cc = cfg.consensus || {};
    const arbiterSpec = cc.arbiterDefaulted ? (isClaudeHost() ? "host" : "auto") : (cc.arbiter || "auto");
    const blindVote = !!cc.blindVote;
    const warnings = Array.isArray(cfg.consensusWarnings) ? cfg.consensusWarnings.slice() : [];
    const cfgErr = typeof getConfigError === "function" ? getConfigError() : null;
    if (cfgErr) warnings.push(`config not loaded: ${cfgErr}`);

    const resolved = await resolveArbiter(arbiterSpec, selected, registry, getConfig);
    if (resolved.warning) warnings.push(resolved.warning);

    if (resolved.mode === "host") {
      const opinions = await askAll(selected, withPersona(req, expert));
      const arbiter = { mode: "host" };
      const body = { opinions, blindVerdict: null, verdict: null, arbiter, warnings };
      return { payload: body, parts: body };
    }

    if (!resolved.provider) {
      const out = await consensus(selected, withPersona(req, expert), { arbiterInstructions: PROMPTS.arbiter });
      const arbiter = { mode: "server", provider: null };
      return {
        payload: { opinions: out.opinions, blindVerdict: out.blindVerdict, verdict: out.verdict, error: out.error, arbiter, warnings },
        parts: { opinions: out.opinions, blindVerdict: out.blindVerdict, verdict: out.verdict, arbiter, warnings },
      };
    }

    const arbiterP = resolved.provider;
    let peers = selected.filter((p) => p.name !== arbiterP.name);
    if (peers.length < 2) {
      peers = selected;
      warnings.push(`panel too small to exclude arbiter '${arbiterP.name}'; kept it in the peer panel (floor of 2)`);
    }
    const out = await consensus(peers, withPersona(req, expert), { arbiter: arbiterP, arbiterInstructions: PROMPTS.arbiter, blindVote });
    const arbiter = { mode: "server", provider: arbiterP.name };
    return {
      payload: { opinions: out.opinions, blindVerdict: out.blindVerdict, verdict: out.verdict, error: out.error, arbiter, warnings },
      parts: { opinions: out.opinions, blindVerdict: out.blindVerdict, verdict: out.verdict, arbiter, warnings },
    };
  }

  /**
   * @param {string} name
   * @param {any} args  // untrusted JSON-RPC tool arguments
   */
  async function call(name, args) {
    // The named expert tools (architect, etc.) carry the expert in the TOOL
    // NAME, not in args.expert. For a named expert tool the tool name MUST win
    // (otherwise args.expert could pick a contradictory persona vs. the selected
    // providers). args.expert is only honored on non-named tools (ask-*), and is
    // type-guarded since it is untrusted JSON-RPC input.
    const namedExpert = EXPERTS.includes(name) ? name : undefined;
    const argExpert = typeof args.expert === "string" ? args.expert : undefined;
    const expert = namedExpert || argExpert;
    /** @type {DelegationRequest} */
    const req = {
      prompt: args.prompt,
      expert: args.expert,
      developerInstructions: args.developerInstructions,
      cwd: args.cwd,
      reasoningEffort: args.reasoningEffort,
      files: args.files,
    };
    if (name === "ask-all") {
      // selectForAskAll returns a FLAT provider list: enabled built-ins + per-alias OR wrappers.
      const { payload, parts } = await runAskAll(req, expert);
      const sid = persistRun("ask-all", req, expert, parts);
      if (sid) payload.sessionId = sid;
      return jsonResult(payload);
    }
    if (name === "consensus") {
      // selectForConsensus returns a FLAT, uncapped voting panel. The arbiter is
      // resolved from config (host/auto/builtin/openrouter:<alias>) instead of the
      // implicit providers[0], so any host can synthesize a real verdict. The whole
      // pass lives in runConsensus so session-revisit can re-run it identically.
      const { payload, parts } = await runConsensus(req, expert);
      const sid = persistRun("consensus", req, expert, parts);
      if (sid) payload.sessionId = sid;
      return jsonResult(payload);
    }
    if (name === "session-get") {
      if (!persistEnabled()) return disabledMsg();
      const rec = sessions.readSession(String(args.sessionId == null ? "" : args.sessionId), { dir: sessionsDir });
      if (!rec) return notFoundMsg(args.sessionId);
      return jsonResult({ session: rec });
    }
    if (name === "session-annotate") {
      if (!persistEnabled()) return disabledMsg();
      const cfg = sessionsCfg();
      const updated = sessions.annotateSession(
        String(args.sessionId == null ? "" : args.sessionId),
        String(args.note == null ? "" : args.note),
        { dir: sessionsDir, maxRecords: cfg.maxRecords, maxAgeDays: cfg.maxAgeDays }
      );
      if (!updated) return notFoundMsg(args.sessionId);
      return jsonResult({ session: updated });
    }
    if (name === "session-revisit") {
      if (!persistEnabled()) return disabledMsg();
      const rec = sessions.readSession(String(args.sessionId == null ? "" : args.sessionId), { dir: sessionsDir });
      if (!rec) return notFoundMsg(args.sessionId);
      // Re-run the ORIGINAL question with the CURRENT providers/config via the same
      // path, then write a CHILD record linked by parentId. Re-run (not replay):
      // revisit's purpose is to re-evaluate against the current context.
      const childExpert = rec.expert || undefined;
      // Carry the original attachment REFS so the re-run sees the same file
      // context the parent did (paths were scrubbed on write).
      const childFiles = Array.isArray(rec.files) && rec.files.length ? rec.files : undefined;
      /** @type {DelegationRequest} */
      const childReq = { ...req, prompt: rec.question, expert: childExpert, files: childFiles };
      const tool = rec.tool === "ask-all" ? "ask-all" : "consensus";
      const { payload, parts } = tool === "ask-all"
        ? await runAskAll(childReq, childExpert)
        : await runConsensus(childReq, childExpert);
      const sid = persistRun(tool, childReq, childExpert, { ...parts, parentId: rec.id });
      if (sid) payload.sessionId = sid;
      payload.parentId = rec.id;
      return jsonResult(payload);
    }
    if (Object.prototype.hasOwnProperty.call(ASK_PROVIDER, name)) {
      const p = registry.get(ASK_PROVIDER[name]);
      if (!p) return { content: [{ type: "text", text: JSON.stringify({ error: `provider ${ASK_PROVIDER[name]} not registered` }) }] };
      const result = await askOne(p, withPersona(req, expert));
      return { content: [{ type: "text", text: JSON.stringify({ result }) }] };
    }
    if (EXPERTS.includes(name)) {
      const { providers: selected } = registry.selectForAskAll({ config: getConfig(), expert: name });
      const results = await askAll(selected, withPersona({ ...req, expert: name }, expert));
      return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
    }
    throw new Error(`unknown tool: ${name}`);
  }

  /** @param {any} msg */
  async function handle(msg) {
    try {
      if (msg.method === "initialize") {
        // Capture the client name (hint for the arbiter default; see isClaudeHost).
        const ci = msg.params && msg.params.clientInfo;
        if (ci && typeof ci.name === "string") clientName = ci.name;
        return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "deliberation-mcp", version: "0.1.0" } } };
      }
      if (msg.method === "tools/list") return { jsonrpc: "2.0", id: msg.id, result: { tools: toolList() } };
      if (msg.method === "tools/call") {
        const result = await call(msg.params.name, msg.params.arguments || {});
        return { jsonrpc: "2.0", id: msg.id, result };
      }
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
    } catch (e) {
      const err = /** @type {any} */ (e);
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String((err && err.message) || err) } };
    }
  }

  return { handle, toolList };
}

function startStdio() {
  const { makeOpenAICompatibleProvider } = require("../../core/providers/openai-compatible.js");
  const { makeGrokProvider } = require("../../core/providers/grok.js");
  const { makeAntigravityProvider } = require("../../core/providers/antigravity.js");
  const { makeCodexProvider } = require("../../core/providers/codex.js");
  const configMod = /** @type {any} */ (require("../openrouter/config.js"));
  const { makeConfigReader, DEFAULT_API_BASE, DEFAULT_API_KEY_ENV } = configMod;
  const reader = makeConfigReader(require("../../core/paths.js").resolveConfigPath());
  /** @returns {any} */
  const getConfig = () => (reader.get().resolved || { providers: {}, openrouter: {} });
  // Expose the last config load error (e.g. JSON parse failure) so the consensus
  // handler can surface a broken config.json as a warning rather than swallow it.
  /** @returns {(string|null)} */
  const getConfigError = () => {
    const r = reader.get();
    return r && r.ok === false ? (r.error || "config load failed") : null;
  };

  const initialOr = (getConfig().openrouter) || {};
  /** @type {Provider[]} */
  // Composition root: core is transport-agnostic, so wire each adapter to its
  // bridge here. Codex spawns the `codex` CLI directly and needs no bridge.
  const providers = [
    makeCodexProvider({}),
    makeAntigravityProvider({ bridge: require("../gemini/index.js") }),
    makeGrokProvider({ bridge: require("../grok/index.js") }),
    makeOpenAICompatibleProvider({
      name: "openrouter",
      apiBase: initialOr.apiBase || DEFAULT_API_BASE,
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      resolveModel: (req) => req.model || (getConfig().openrouter && getConfig().openrouter.defaultModel) || "",
      bridge: require("../openrouter/index.js"),
    }),
  ];
  const sessionsDir = require("../../core/paths.js").resolveSessionsDir();
  const srv = buildServer({ providers, getConfig, getConfigError, sessionsDir });

  if (typeof globalThis.fetch !== "function") {
    console.error("deliberation-mcp requires Node 18+ (global fetch unavailable).");
    process.exit(1);
  }

  let buffer = "";
  process.stdin.on("data", async (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      let msg;
      try { msg = JSON.parse(l); } catch { continue; }
      const res = await srv.handle(msg);
      if (msg.id !== undefined) process.stdout.write(JSON.stringify(res) + "\n");
    }
  });
}

if (require.main === module) startStdio();

module.exports = { buildServer, toolList };
