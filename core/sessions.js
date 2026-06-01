"use strict";

/**
 * core/sessions.js - opt-in per-session store for deliberation.
 *
 * Zero runtime dependencies (node builtins only). SYNCHRONOUS API to match
 * core/paths.js and server/grok/cache.js. JSDoc-typed so it passes strict `tsc`
 * (it is inside the strict tsconfig include).
 *
 * One JSON file per session at `<dir>/<id>.json`, written atomically
 * (temp -> rename) with mode 0600. No global lock - each file is independent;
 * the only read-modify-write race is `annotateSession` on ONE file, documented
 * last-writer-wins (acceptable for a local single-user stdio server).
 *
 * SECURITY: `scrubSecrets` is best-effort. User-provided transcript text may
 * still carry secrets in shapes this does not recognize.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** Current on-disk record shape version. 1a enrichment will bump this. */
const SCHEMA_VERSION = 1;
/** Anchored id guard: rejects `../`, dots, slashes - no path traversal. */
const ID_RE = /^[A-Za-z0-9-]+$/;
/** ~100 KB cap per stored opinion/verdict text, so a runaway response can't bloat the store. */
const MAX_TEXT_BYTES = 100 * 1024;

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * @typedef {Object} SessionOpinion
 * @property {string} provider
 * @property {string} [model]
 * @property {string} [text]
 */

/**
 * @typedef {Object} SessionFileRef
 * @property {string} path  attachment ref (path only, scrubbed) - NOT the body
 */

/**
 * @typedef {Object} SessionAnnotation
 * @property {string} note
 * @property {string} at  ISO timestamp
 */

/**
 * @typedef {Object} SessionArbiter
 * @property {string} mode
 * @property {(string|null)} [provider]
 */

/**
 * @typedef {Object} SessionRecord
 * @property {string} id
 * @property {(string|null)} parentId
 * @property {number} schemaVersion
 * @property {string} createdAt  ISO timestamp
 * @property {("consensus"|"ask-all")} tool
 * @property {string} question
 * @property {(string|null)} [expert]
 * @property {(SessionFileRef[]|null)} [files]
 * @property {SessionOpinion[]} opinions
 * @property {(string|null)} [blindVerdict]
 * @property {(string|null)} [verdict]
 * @property {(SessionArbiter|null)} [arbiter]
 * @property {string[]} [warnings]
 * @property {SessionAnnotation[]} [annotations]
 */

/**
 * Redact common API-key shapes from a string. Best-effort - see module note.
 * @param {string} text
 * @returns {string}
 */
function scrubSecrets(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text
    // Leading \b so a key embedded in a normal word (e.g. "risk-analysis" ->
    // "sk-analysis") is NOT matched. OpenRouter (sk-or-) BEFORE OpenAI (sk-) so the
    // more specific shape wins.
    .replace(/\bsk-or-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    // xAI keys.
    .replace(/\bxai-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    // Google API keys: AIza + >=35 chars. {35,} (not {35}) so a longer-than-39
    // key cannot leak its tail; over-matching only redacts MORE, never less.
    .replace(/\bAIza[0-9A-Za-z_-]{35,}/g, "[REDACTED]")
    // Generic `Bearer <token>` headers.
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

/**
 * Cap text at MAX_TEXT_BYTES (byte-aware so multibyte text cannot exceed the
 * cap); append a truncation note when cut.
 * @param {string} text
 * @returns {string}
 */
function capText(text) {
  if (typeof text !== "string") return text;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MAX_TEXT_BYTES) return text;
  const suffix = `\n\n[truncated: original ${buf.length} bytes]`;
  // Reserve room for the suffix so the RETURNED string stays within the cap, and
  // back up off any UTF-8 continuation byte so we never split a codepoint (which
  // would otherwise emit a 3-byte U+FFFD and bloat past the budget).
  let end = Math.max(0, MAX_TEXT_BYTES - Buffer.byteLength(suffix, "utf8"));
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8") + suffix;
}

/**
 * True only for a non-empty id matching the anchored safe-id shape.
 * @param {unknown} id
 * @returns {id is string}
 */
function isSafeId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

/** @returns {string} a fresh session id ([0-9a-f-], matches the safe-id guard). */
function newSessionId() {
  return crypto.randomUUID();
}

/**
 * Scrub secrets + cap large text on a record before it is written. Returns a NEW
 * record; never mutates the input. Applies to question, each opinion text,
 * verdict, blindVerdict, and the `files[].path` refs.
 * @param {SessionRecord} record
 * @returns {SessionRecord}
 */
function sanitizeRecord(record) {
  /** @type {SessionRecord} */
  const out = { ...record };
  out.question = scrubSecrets(String(record.question == null ? "" : record.question));
  if (Array.isArray(record.opinions)) {
    out.opinions = record.opinions.map((o) => ({
      provider: o.provider,
      model: o.model,
      text: typeof o.text === "string" ? capText(scrubSecrets(o.text)) : undefined,
    }));
  }
  if (record.verdict != null) out.verdict = capText(scrubSecrets(String(record.verdict)));
  if (record.blindVerdict != null) out.blindVerdict = capText(scrubSecrets(String(record.blindVerdict)));
  if (Array.isArray(record.files)) {
    out.files = record.files.map((f) => ({ path: scrubSecrets(String(f && f.path != null ? f.path : "")) }));
  }
  return out;
}

/**
 * Write a session record atomically as `<dir>/<id>.json`. Secrets are scrubbed
 * and large text capped first. The temp file is created with mode 0600 DIRECTLY
 * (not write-then-chmod, which would leave a world-readable window). Prunes the
 * store after the write.
 * @param {SessionRecord} record  must carry a safe `id`
 * @param {{dir:string, maxRecords?:number, maxAgeDays?:number}} opts
 * @returns {string} the written id
 */
function writeSession(record, opts) {
  const dir = opts.dir;
  const id = record.id;
  if (!isSafeId(id)) throw new Error(`unsafe session id: ${String(id)}`);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(sanitizeRecord(record));
  const dest = path.join(dir, `${id}.json`);
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    // A failed rename would otherwise orphan the temp file (listSessions/prune
    // ignore non-.json names, so it would never be cleaned up). Remove it, then
    // surface the original error.
    removeFile(tmp);
    throw e;
  }
  pruneSessions({ dir, maxRecords: opts.maxRecords, maxAgeDays: opts.maxAgeDays });
  return id;
}

/**
 * Read + parse a session record. Returns null when the id is unsafe, the file is
 * absent, or the JSON is corrupt - never throws on those.
 * @param {string} id
 * @param {{dir:string}} opts
 * @returns {(SessionRecord|null)}
 */
function readSession(id, opts) {
  if (!isSafeId(id)) return null;
  const file = path.join(opts.dir, `${id}.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return /** @type {SessionRecord} */ (obj);
    return null;
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} SessionListEntry
 * @property {string} id
 * @property {string} file
 * @property {number} mtimeMs
 */

/**
 * List records newest-first by mtime. A missing dir yields []. Best-effort: a
 * file that disappears mid-listing is skipped.
 * @param {{dir:string}} opts
 * @returns {SessionListEntry[]}
 */
function listSessions(opts) {
  const dir = opts.dir;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {SessionListEntry[]} */
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!isSafeId(id)) continue;
    const file = path.join(dir, name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    out.push({ id, file, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Best-effort, ENOENT-tolerant delete. A concurrent prune racing on the same
 * file never throws (rmSync force:true).
 * @param {string} file
 * @returns {boolean} true when a delete call succeeded
 */
function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete records older than maxAgeDays, then trim to the newest maxRecords.
 * Called after each write. Best-effort + ENOENT-tolerant.
 * @param {{dir:string, maxRecords?:number, maxAgeDays?:number}} opts
 * @returns {{removed:number}}
 */
function pruneSessions(opts) {
  const mr = opts.maxRecords;
  const md = opts.maxAgeDays;
  const maxRecords = typeof mr === "number" && Number.isInteger(mr) && mr > 0 ? mr : DEFAULT_MAX_RECORDS;
  const maxAgeDays = typeof md === "number" && Number.isInteger(md) && md > 0 ? md : DEFAULT_MAX_AGE_DAYS;
  const entries = listSessions({ dir: opts.dir });
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  /** @type {SessionListEntry[]} */
  const survivors = [];
  for (const e of entries) {
    if (e.mtimeMs < cutoff) {
      if (removeFile(e.file)) removed++;
    } else {
      survivors.push(e);
    }
  }
  // survivors stays newest-first; trim the tail beyond maxRecords.
  if (survivors.length > maxRecords) {
    for (const e of survivors.slice(maxRecords)) {
      if (removeFile(e.file)) removed++;
    }
  }
  return { removed };
}

/**
 * Append an annotation to an existing record and rewrite it. Returns the updated
 * record, or null when the id is unsafe/unknown. Last-writer-wins (documented;
 * single-user local server).
 * @param {string} id
 * @param {string} note
 * @param {{dir:string, at?:string, maxRecords?:number, maxAgeDays?:number}} opts
 * @returns {(SessionRecord|null)}
 */
function annotateSession(id, note, opts) {
  const rec = readSession(id, { dir: opts.dir });
  if (!rec) return null;
  const at = typeof opts.at === "string" && opts.at ? opts.at : new Date().toISOString();
  const annotations = Array.isArray(rec.annotations) ? rec.annotations.slice() : [];
  annotations.push({ note: capText(scrubSecrets(String(note == null ? "" : note))), at });
  /** @type {SessionRecord} */
  const updated = { ...rec, annotations };
  writeSession(updated, { dir: opts.dir, maxRecords: opts.maxRecords, maxAgeDays: opts.maxAgeDays });
  return updated;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_TEXT_BYTES,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_AGE_DAYS,
  scrubSecrets,
  capText,
  sanitizeRecord,
  isSafeId,
  newSessionId,
  writeSession,
  readSession,
  listSessions,
  pruneSessions,
  annotateSession,
};
