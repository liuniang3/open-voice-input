"use strict";

const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");
const MAX_TEXT = 4096;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_TIMEOUT_MS = 45000;
const NATIVE_STOPS = new Set(["unsupported", "focus-changed", "range-invalidated", "timeout"]);

function validText(text) {
  return typeof text === "string" && text.length > 0 && text.length <= MAX_TEXT &&
    text.trim().length > 0 && !text.includes("\0") && Buffer.from(text, "utf8").toString("utf8") === text;
}

// Immutable guards are INSIDE the inserted range. Boundary corrections are
// unsupported: never recover by reading the surrounding document.
function guardsMatch(before, after) {
  const chars = Array.from(before);
  if (chars.length < 12) return false;
  const left = chars.slice(0, 4).join("");
  const right = chars.slice(-4).join("");
  const unique = (value, guard) => value.indexOf(guard) === value.lastIndexOf(guard);
  return left.trim() && right.trim() && left !== right &&
    after.startsWith(left) && after.endsWith(right) &&
    Array.from(after).length > 8 && after.length <= Math.min(MAX_TEXT, before.length + 256) &&
    unique(before, left) && unique(before, right) && unique(after, left) && unique(after, right);
}

/**
 * Call only after successful injection, with its exact inserted text and HWND.
 * onStatus receives {status}, with fixed, text-free codes. At most one correction
 * is delivered, after native idle confirmation AND a clean process exit.
 * Stop on dictation, injection, reconfigure/quit. spawnImpl allows portable tests;
 * production is Windows-only. The helper does not support boundary corrections.
 * Requires >=12 Unicode characters, <=4096 UTF-16 units, unique nonblank first/
 * last four-character guards; edits may grow by <=256 UTF-16 units. Native polls
 * at 500ms, confirms two seconds idle, and stops within 45s. Timeout/stop never
 * flush an unstable candidate. Unchanged submissions cannot be inferred via UIA.
 */
function startCorrectionObservation({ helperPath, target, text, onCorrection, onStatus,
  spawnImpl = spawn, timeoutMs = MAX_TIMEOUT_MS } = {}) {
  if (typeof helperPath !== "string" || !helperPath || helperPath.includes("\0") ||
      typeof target !== "string" || !/^[1-9]\d{0,18}$/.test(target) ||
      BigInt(target) > 9223372036854775807n || !validText(text) ||
      typeof onCorrection !== "function" || (onStatus !== undefined && typeof onStatus !== "function") ||
      typeof spawnImpl !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Invalid correction observation options");
  }
  const deadlineMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);
  let child, timer, stopped = false, closed = false, observing = false, terminal = false;
  let buffer = "", bytes = 0, messages = 0, candidate = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const invoke = (callback, value) => {
    try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* Caller-owned callback. */ }
  };
  const notify = status => invoke(onStatus, { status });
  const onParentExit = () => finish("stopped");
  function finish(status, kill = true) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    process.removeListener("exit", onParentExit);
    buffer = "";
    candidate = null;
    if (kill && child && !closed) {
      // EOF also trips the native watchdog if kill races a blocked UIA call.
      try { child.stdin.destroy(); } catch { /* Already closed. */ }
      try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
    }
    notify(status);
  }
  const handle = { stop: () => finish("stopped") };
  if (process.platform !== "win32" && spawnImpl === spawn) {
    finish("unsupported-platform");
    return handle;
  }
  try {
    child = spawnImpl(helperPath, ["--watch-correction"], {
      windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"]
    });
  } catch {
    finish("spawn-error");
    return handle;
  }
  process.once("exit", onParentExit);
  timer = setTimeout(() => finish("timeout"), deadlineMs);
  timer.unref?.();
  child.on("error", () => finish("helper-error"));
  child.stdin.on("error", () => finish("helper-error"));
  child.stdout.on("error", () => finish("helper-error"));
  function parseLine(line) {
    if (++messages > 3 || !line || Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error();
    const value = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value) || terminal || candidate) throw new Error();
    const keys = Object.keys(value).sort().join(",");
    if (value.type === "status" && keys === "status,type") {
      if (value.status === "observing" && !observing) observing = true;
      else if (NATIVE_STOPS.has(value.status)) terminal = true;
      else throw new Error();
      notify(value.status);
    } else if (value.type === "correction" && keys === "after,before,type" && observing &&
               value.before === text && validText(value.after) && value.after !== text &&
               guardsMatch(text, value.after)) {
      candidate = { before: text, after: value.after };
    } else throw new Error();
  }
  child.stdout.on("data", chunk => {
    if (stopped) return;
    try {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > MAX_OUTPUT_BYTES) throw new Error();
      buffer += decoder.decode(data, { stream: true });
      let newline;
      while (!stopped && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        parseLine(line);
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw new Error();
    } catch { finish("protocol-error"); }
  });
  child.once("close", (code, signal) => {
    closed = true;
    if (stopped) return;
    try {
      buffer += decoder.decode();
      if (buffer.length) throw new Error();
    } catch { finish("protocol-error", false); return; }
    const result = code === 0 && !signal ? candidate : null;
    finish(result ? "corrected" : "helper-exit", false);
    if (result) invoke(onCorrection, result);
  });
  try {
    // One JSON line, no text in argv. Do NOT end stdin until stopping the child.
    child.stdin.write(`${JSON.stringify({ target, text, timeoutMs: deadlineMs })}\n`, "utf8");
  } catch { finish("helper-error"); }
  return handle;
}

module.exports = { startCorrectionObservation };
