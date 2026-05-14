"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const REPO_ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(REPO_ROOT, "server/gemini/index.js");
const FIXTURES = path.join(__dirname, "fixtures");

function startBridge({ env = {}, fakeBin = "fake-gemini.sh" } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-bin-"));
  // Bridge spawns "gemini"; symlink the chosen fixture under that name.
  fs.symlinkSync(path.join(FIXTURES, fakeBin), path.join(tmpDir, "gemini"));
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      PATH: `${tmpDir}:${process.env.PATH}`,
      CDG_ARGV_LOG: path.join(tmpDir, "argv.log"),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.argvLog = path.join(tmpDir, "argv.log");
  child.tmpDir = tmpDir;
  return child;
}

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function collectResponses(child) {
  return new Promise((resolve) => {
    let buf = "";
    const out = [];
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (e) { out.push({ _parseError: e.message, raw: line }); }
      }
    });
    child.on("close", () => {
      if (buf.trim()) { try { out.push(JSON.parse(buf)); } catch (_) {} }
      resolve(out);
    });
  });
}

function readArgv(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath);
  // Each invocation: NUL-separated args terminated by '\n'.
  const invocations = [];
  let cur = [];
  let acc = "";
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (b === 0x00) { cur.push(acc); acc = ""; }
    else if (b === 0x0a) { invocations.push(cur); cur = []; }
    else acc += String.fromCharCode(b);
  }
  if (acc || cur.length) invocations.push([...cur, acc].filter(Boolean));
  return invocations;
}

module.exports = { startBridge, send, collectResponses, readArgv };
