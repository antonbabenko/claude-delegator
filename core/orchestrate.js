"use strict";
/** @typedef {import("./types.js").Provider} Provider */
/** @typedef {import("./types.js").DelegationRequest} DelegationRequest */
/** @typedef {import("./types.js").DelegationResult} DelegationResult */
/** @typedef {import("./types.js").DelegationSuccess} DelegationSuccess */

const { parseReview } = require("./provider.js");
const loop = require("./consensus-loop.js");

/**
 * Fan out ONE request to N providers concurrently. The whole serialization fix:
 * the host harness sees a single tool call, so it cannot stagger the providers.
 * Failures are isolated - the batch never rejects.
 * @param {Provider[]} providers
 * @param {DelegationRequest} req
 * @returns {Promise<DelegationResult[]>}
 */
async function askAll(providers, req) {
  const settled = await Promise.allSettled(
    providers.map((/** @type {Provider} */ p) =>
      p.ask({ ...req, files: req.files ? req.files.map((f) => ({ ...f })) : undefined })
    )
  );
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          provider: providers[i].name,
          model: "unknown",
          isError: true,
          errorKind: "unknown",
          retryable: false,
          message: String((s.reason && s.reason.message) || s.reason || "rejected"),
          ms: 0,
        }
  );
}

/**
 * Single-provider call (advisory one-shot). Shared entrypoint for ask-* tools.
 * @param {Provider} provider
 * @param {DelegationRequest} req
 * @returns {Promise<DelegationResult>}
 */
async function askOne(provider, req) {
  return provider.ask({ ...req, files: req.files ? req.files.map((f) => ({ ...f })) : undefined });
}

/**
 * Assemble the arbiter prompt from independent opinions for blind cross-review.
 * @param {string} question
 * @param {DelegationSuccess[]} opinions  // successful opinions only (text guaranteed)
 * @returns {string}
 */
function buildArbiterPrompt(question, opinions) {
  // Labels are anonymized (### Opinion N, no provider name) so the arbiter
  // judges substance, not source reputation. The opinions array returned to the
  // caller keeps provider names; only this prompt is anonymized.
  const blocks = opinions.map((o, i) => `### Opinion ${i + 1}\n${o.text}`).join("\n\n");
  return [
    "You are the arbiter. Below are independent expert opinions on the same question.",
    "Cross-review them: note where they agree, where they disagree, and which view is best supported.",
    "Then produce ONE synthesized verdict.",
    "",
    `## Original question\n${question}`,
    "",
    `## Opinions\n${blocks}`,
    "",
    "## Your verdict\nBottom line, points of agreement, points of disagreement, final recommendation.",
  ].join("\n");
}

/**
 * Single-round advisory consensus: fan out to all providers, then run ONE arbiter
 * pass over the successful opinions. The arbiter is just another Provider
 * (default: the first in the set).
 *
 * Optional `blindVote`: the arbiter ALSO answers the original question cold (no
 * peer opinions) to produce a `blindVerdict`, fired in PARALLEL with the peer
 * fan-out (no extra round). It reduces the arbiter anchoring on the peers' framing.
 * Failure-isolated: a thrown blind pass yields `blindVerdict:null`, never failing
 * the run. `blindVerdict` is `null` when `blindVote` is off or no arbiter exists.
 * @param {Provider[]} providers
 * @param {DelegationRequest} req
 * @param {{arbiter?:Provider, arbiterInstructions?:string, blindVote?:boolean}} [opts]
 * @returns {Promise<{opinions:DelegationResult[], blindVerdict:(DelegationResult|null), verdict:(DelegationResult|null), error?:string}>}
 */
async function consensus(providers, req, opts = {}) {
  const arbiter = opts.arbiter || providers[0];
  // Blind pre-vote runs concurrently with the peer fan-out. It uses the ORIGINAL
  // prompt (no opinions) + the arbiter persona. `.then(v, () => null)` isolates a
  // blind-pass failure so it can never reject the batch.
  const blindPromise = opts.blindVote && arbiter
    ? // Promise.resolve().then(...) so even a SYNCHRONOUS throw in ask() is caught
      // by the rejection handler (a bare arbiter.ask() could throw before awaiting).
      Promise.resolve()
        .then(() =>
          arbiter.ask({
            ...req,
            files: req.files ? req.files.map((f) => ({ ...f })) : undefined,
            developerInstructions: opts.arbiterInstructions || req.developerInstructions,
          })
        )
        .then((v) => v, () => null)
    : Promise.resolve(/** @type {DelegationResult|null} */ (null));

  const [opinions, blindVerdict] = await Promise.all([askAll(providers, req), blindPromise]);
  // The union guarantees `text` on the success branch, so `!o.isError` alone
  // narrows each survivor to DelegationSuccess - no `&& o.text` guard needed.
  const ok = /** @type {DelegationSuccess[]} */ (opinions.filter((o) => !o.isError));
  if (!ok.length) return { opinions, blindVerdict, verdict: null, error: "all-providers-failed" };
  if (!arbiter) return { opinions, blindVerdict, verdict: null, error: "no-arbiter" };
  try {
    const verdict = await arbiter.ask({
      ...req,
      files: req.files ? req.files.map((f) => ({ ...f })) : undefined,
      prompt: buildArbiterPrompt(req.prompt, ok),
      developerInstructions: opts.arbiterInstructions || req.developerInstructions,
    });
    return { opinions, blindVerdict, verdict };
  } catch {
    return { opinions, blindVerdict, verdict: null, error: "arbiter-failed" };
  }
}

/**
 * Build the per-round adjudication prompt for the provider arbiter. Embeds each
 * peer's verdict + issues verbatim (so the arbiter - and a deterministic test
 * stub - can see dissent), and asks for a single overall verdict.
 * @param {{currentPlan:string}} state
 * @param {Array<{source:string, isError:boolean, verdict:(string|null), criticalIssues:{category:string,description:string}[]}>} results
 * @returns {string}
 */
function buildAdjudicationPrompt(state, results) {
  const peerBlocks = results.map((r) => {
    if (r.isError) return `Peer ${r.source}: ERRORED`;
    const issues = (r.criticalIssues || []).map((i) => `  - [${i.category}] ${i.description}`).join("\n");
    return `Peer ${r.source}: ${r.verdict || "UNKNOWN"}${issues ? "\n" + issues : ""}`;
  }).join("\n");
  return [
    "ADJUDICATE the peer reviews below and give ONE overall verdict.",
    `## Plan\n${state.currentPlan}`,
    `## Peer reviews\n${peerBlocks}`,
    "End with **Verdict**: APPROVE | REQUEST_CHANGES | REJECT.",
  ].join("\n\n");
}

/**
 * Build the per-round revision prompt for the provider arbiter.
 * @param {{currentPlan:string}} state
 * @param {Array<{source:string, isError:boolean, verdict:(string|null), criticalIssues:{category:string,description:string}[]}>} results
 * @returns {string}
 */
function buildRevisionPrompt(state, results) {
  const feedback = results
    .filter((r) => !r.isError && r.verdict !== "APPROVE")
    .flatMap((r) => (r.criticalIssues || []).map((i) => `- [${i.category}] ${i.description}`))
    .join("\n");
  return [
    "REVISE THE PLAN to address the critical issues below. Return ONLY the revised plan.",
    `## Current plan\n${state.currentPlan}`,
    `## Must-fix issues\n${feedback || "(reviewers gave no specific issues; tighten the weakest part)"}`,
  ].join("\n\n");
}

/** Resolve a provider reply to non-empty text, or null. */
function okText(/** @type {any} */ res) {
  return res && res.isError === false && typeof res.text === "string" && res.text.trim() ? res.text : null;
}

/**
 * Drive the full multi-round consensus loop to convergence using a PROVIDER
 * arbiter - the non-Claude host path. Shares the exact core/consensus-loop.js
 * state machine the Claude command drives client-side (single source of truth);
 * here the arbiter's blind/adjudication/revision steps are provider calls and
 * the blind pass runs in PARALLEL with the peer fan-out (no interactive stall).
 * Failure-isolated and never rejects: a failed blind pass degrades to a
 * sentinel, a failed adjudication holds the verdict at REQUEST_CHANGES, a failed
 * revision keeps the current plan.
 * @param {Provider[]} providers  peer panel
 * @param {DelegationRequest} req  `prompt` is the initial plan
 * @param {{arbiter?:Provider, maxRounds?:number}} [opts]
 * @returns {Promise<{converged:boolean, verdict:(string|null), confidence:string, finalReport?:string, rounds:any[], opinions:any[], error?:string}>}
 */
async function runToConvergence(providers, req, opts = {}) {
  const arbiter = opts.arbiter;
  if (!arbiter) return { converged: false, verdict: null, confidence: "none", rounds: [], opinions: [], error: "no-arbiter" };

  let state = loop.initConsensusLoop({
    plan: typeof req.prompt === "string" ? req.prompt : "",
    maxRounds: opts.maxRounds,
    expert: req.expert,
    arbiterMode: "provider",
  });
  /** @type {any[]} */
  let lastResults = [];

  // Top-level guard: a synchronous throw from a malformed provider (e.g. askAll's
  // map building) or any state-machine transition must NOT reject - the loop is
  // failure-isolated. Return a structured error with whatever we have so far.
  try {
    while (state.status !== "converged" && state.status !== "unresolved") {
      const { peerPrompt, blindPrompt } = loop.prepareRound(state);
      // Blind pass runs concurrently with the peer fan-out; isolate its failure.
      const [blindRes, peerResults] = await Promise.all([
        Promise.resolve().then(() => arbiter.ask({ ...req, prompt: blindPrompt })).then((r) => r, () => null),
        askAll(providers, { ...req, prompt: peerPrompt }),
      ]);
      state = loop.recordBlindVerdict(state, okText(blindRes) || "(blind pass unavailable)");

      lastResults = peerResults.map((r) =>
        r.isError
          ? { source: r.provider, isError: true, errorKind: r.errorKind, verdict: null, criticalIssues: [] }
          // parseReview spread FIRST so the explicit structural fields always win.
          : { ...parseReview(typeof r.text === "string" ? r.text : ""), source: r.provider, isError: false, ms: r.ms }
      );
      state = loop.addOpinions(state, lastResults);

      /** @type {"APPROVE"|"REQUEST_CHANGES"|"REJECT"} */
      let verdict = "REQUEST_CHANGES";
      try {
        const adj = await arbiter.ask({ ...req, prompt: buildAdjudicationPrompt(state, lastResults) });
        const t = okText(adj);
        if (t) { const p = parseReview(t); if (p.verdict) verdict = p.verdict; }
      } catch { /* arbiter adjudication failed -> hold at REQUEST_CHANGES */ }
      state = loop.submitAdjudication(state, { verdict, decisions: [] });
      if (state.status === "converged") break;

      let revised = state.currentPlan;
      try {
        const rev = await arbiter.ask({ ...req, prompt: buildRevisionPrompt(state, lastResults) });
        revised = okText(rev) || state.currentPlan;
      } catch { /* keep the current plan */ }
      state = loop.submitRevision(state, revised, "arbiter revision");
    }
  } catch (e) {
    return {
      converged: false,
      verdict: null,
      confidence: "none",
      rounds: state.history,
      opinions: lastResults,
      error: `loop-failed: ${String((e && /** @type {any} */ (e).message) || e)}`,
    };
  }

  const { finalReport, confidence } = loop.finalize(state);
  return {
    converged: state.status === "converged",
    verdict: state.hostVerdict ? state.hostVerdict.verdict : null,
    confidence,
    finalReport,
    rounds: state.history,
    opinions: lastResults,
  };
}

module.exports = { askAll, askOne, consensus, buildArbiterPrompt, runToConvergence };
