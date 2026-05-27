"use strict";
// crypto + fs helpers are used by buildCacheKey, readCache/writeCache, lookup/store/evict in T2-T7.
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { mkdirSync, readFileSync, writeFileSync, renameSync } = require("node:fs");

const CACHE_DIR = path.join(os.homedir(), ".claude", "cache", "claude-delegator");
const CACHE_FILE = path.join(CACHE_DIR, "grok-files.json");
const CACHE_VERSION = 1;

function normalize(apiBase) {
  let u;
  try { u = new URL(apiBase); }
  catch (_) {
    u = new URL(`https://${apiBase}`);
  }
  const proto = u.protocol.toLowerCase();
  const host = u.host.toLowerCase();
  let pathname = u.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  return `${proto}//${host}${pathname}`;
}

function buildCacheKey({ bytes, apiKey, apiBase, filename }) {
  const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const keyFp = crypto.createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 16);
  const baseNorm = normalize(apiBase);
  return `${contentHash}@${keyFp}@${baseNorm}@${filename}`;
}

function readCache(file) {
  try {
    const raw = readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && obj.entries && typeof obj.entries === "object") {
      return { version: obj.version || CACHE_VERSION, entries: obj.entries };
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") {
      process.stderr.write(`[grok] cache read failed (${e.message}); treating as empty\n`);
    }
  }
  return { version: CACHE_VERSION, entries: {} };
}

function writeCache(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

module.exports = { normalize, buildCacheKey, readCache, writeCache, CACHE_DIR, CACHE_FILE, CACHE_VERSION };
