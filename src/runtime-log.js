"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

/**
 * Per-file size threshold for rotation (default 5 MiB).
 * With maxFiles=3 (current + .1 + .2) total retained log disk is about 15 MiB.
 */
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** current + .1 + .2 */
const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_DETAIL_CHARS = 2000;
const DEFAULT_MAX_LINE_CHARS = 4000;

const DATA_URI_RE = /data:[^;,\s]+;base64,[A-Za-z0-9+/=\s]+/gi;
const LONG_BASE64_RE = /(?:^|[^A-Za-z0-9+/=])[A-Za-z0-9+/]{240,}={0,2}(?=$|[^A-Za-z0-9+/=])/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// Credential-like tokens (avoid eating normal Chinese/transcript prose).
// sk-/tp-/ak- allow internal hyphens/underscores (e.g. sk-proj-...).
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi;
const SK_KEY_RE = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g;
const TP_KEY_RE = /\btp-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g;
const AK_KEY_RE = /\bak-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/gi;
// JSON / query / assignment style secret fields (camelCase, snake, kebab)
const SENSITIVE_FIELD_NAMES =
  "api[_-]?key|authorization|access[_-]?key[_-]?id|access[_-]?key[_-]?secret|accesskeyid|accesskeysecret|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|password|secret|token";
const SENSITIVE_ASSIGN_RE = new RegExp(
  `([?&"'\\s,{])((?:${SENSITIVE_FIELD_NAMES}))\\s*([=:])\\s*("?)([^"&\\s,}\\]]{4,})("?)`,
  "gi"
);

const SENSITIVE_KEY_RE = new RegExp(
  `^(api[_-]?key|authorization|access[_-]?key[_-]?id|access[_-]?key[_-]?secret|accesskeyid|accesskeysecret|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|password|secret|token)$`,
  "i"
);

function redactSecretStrings(s) {
  let out = String(s ?? "");
  out = out.replace(BEARER_RE, "Bearer [redacted]");
  out = out.replace(SK_KEY_RE, "sk-[redacted]");
  out = out.replace(TP_KEY_RE, "tp-[redacted]");
  out = out.replace(AK_KEY_RE, "ak-[redacted]");
  out = out.replace(SENSITIVE_ASSIGN_RE, (_, pre, key, sep, q1, _val, q2) => {
    const quote = q1 || q2 || "";
    return `${pre}${key}${sep}${quote}[redacted]${quote}`;
  });
  return out;
}

function sanitizeLogMessage(message, maxChars = 500) {
  let s = String(message ?? "")
    .replace(CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = redactSecretStrings(s);
  const limit = Math.max(32, Number(maxChars) || 500);
  if (s.length > limit) s = s.slice(0, limit);
  return s;
}

/**
 * Deep-clone scrub for objects: redact sensitive keys, break cycles.
 * Does not mutate the input.
 */
function scrubValue(value, seen, depth) {
  if (value == null) return value;
  if (typeof value === "string") {
    return redactSecretStrings(
      value
        .replace(CONTROL_RE, " ")
        .replace(DATA_URI_RE, "[data-uri-omitted]")
        .replace(LONG_BASE64_RE, " [base64-omitted] ")
    );
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[function]";
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (depth > 8) return "[max-depth]";
  if (typeof value !== "object") return String(value);

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => scrubValue(v, seen, depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = scrubValue(v, seen, depth + 1);
  }
  return out;
}

function sanitizeLogDetail(detail, maxDetailChars = DEFAULT_MAX_DETAIL_CHARS) {
  if (detail == null || detail === "") return "";
  let s;
  if (typeof detail === "string") {
    s = detail;
    s = s.replace(CONTROL_RE, " ");
    s = s.replace(DATA_URI_RE, "[data-uri-omitted]");
    s = s.replace(LONG_BASE64_RE, " [base64-omitted] ");
    s = redactSecretStrings(s);
  } else if (Buffer.isBuffer(detail)) {
    s = `[buffer ${detail.length} bytes]`;
  } else if (typeof detail === "object") {
    try {
      const scrubbed = scrubValue(detail, new WeakSet(), 0);
      s = JSON.stringify(scrubbed);
    } catch {
      s = redactSecretStrings(String(detail));
    }
  } else {
    s = redactSecretStrings(String(detail));
  }
  s = s.replace(/\s+/g, " ").trim();
  const limit = Math.max(64, Number(maxDetailChars) || DEFAULT_MAX_DETAIL_CHARS);
  if (s.length > limit) {
    s = `${s.slice(0, limit)}…[truncated ${s.length - limit} chars]`;
  }
  return s;
}

function formatLogLine(message, detail = "", { now = () => new Date(), maxDetailChars, maxLineChars } = {}) {
  const ts = now().toISOString();
  const msg = sanitizeLogMessage(message, 500);
  const det = sanitizeLogDetail(detail, maxDetailChars);
  let line = `[${ts}] ${msg}${det ? ` ${det}` : ""}\n`;
  const lineLimit = Math.max(256, Number(maxLineChars) || DEFAULT_MAX_LINE_CHARS);
  if (line.length > lineLimit) {
    line = `${line.slice(0, lineLimit - 1)}…\n`;
  }
  return line;
}

/**
 * Serial async append logger with size-based rotation.
 * Non-blocking enqueue; write/rotate failures are swallowed.
 *
 * maxFileBytes (default 5 MiB) is the **per-file** rotation threshold.
 * With maxFiles=3 this retains current + .1 + .2 ≈ up to ~15 MiB total.
 */
function createRuntimeLogWriter({
  logFilePath,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  maxDetailChars = DEFAULT_MAX_DETAIL_CHARS,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
  fsImpl = fsp,
  now = () => new Date()
} = {}) {
  if (!logFilePath) {
    throw new Error("logFilePath required");
  }
  // Allow small thresholds in tests; production uses DEFAULT_MAX_FILE_BYTES (5 MiB per file).
  const maxBytes = Math.max(256, Number(maxFileBytes) || DEFAULT_MAX_FILE_BYTES);
  const keep = Math.max(1, Math.min(10, Number(maxFiles) || DEFAULT_MAX_FILES));
  let chain = Promise.resolve();
  let closed = false;

  async function safeRm(p) {
    try {
      await fsImpl.rm(p, { force: true });
    } catch {
      /* ignore missing/locked */
    }
  }

  async function safeRename(src, dest) {
    try {
      await fsImpl.rename(src, dest);
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      try {
        await safeRm(dest);
        await fsImpl.rename(src, dest);
        return true;
      } catch {
        try {
          await fsImpl.copyFile(src, dest);
          await fsImpl.writeFile(src, "", "utf8");
          return true;
        } catch {
          return false;
        }
      }
    }
  }

  async function rotateIfNeeded() {
    let st;
    try {
      st = await fsImpl.stat(logFilePath);
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      return;
    }
    if (!st || st.size < maxBytes) return;

    for (let i = keep - 1; i >= 2; i -= 1) {
      const src = `${logFilePath}.${i - 1}`;
      const dest = `${logFilePath}.${i}`;
      await safeRm(dest);
      await safeRename(src, dest);
    }
    if (keep >= 2) {
      const dest = `${logFilePath}.1`;
      await safeRm(dest);
      const moved = await safeRename(logFilePath, dest);
      if (!moved) {
        try {
          await fsImpl.writeFile(logFilePath, "", "utf8");
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        await fsImpl.writeFile(logFilePath, "", "utf8");
      } catch {
        /* ignore */
      }
    }
  }

  async function writeLine(line) {
    const dir = path.dirname(logFilePath);
    await fsImpl.mkdir(dir, { recursive: true });
    await rotateIfNeeded();
    await fsImpl.appendFile(logFilePath, line, "utf8");
  }

  function enqueue(message, detail = "") {
    if (closed) return false;
    let line;
    try {
      line = formatLogLine(message, detail, { now, maxDetailChars, maxLineChars });
    } catch {
      return false;
    }
    chain = chain
      .then(() => writeLine(line))
      .catch(() => {
        /* never reject outward */
      });
    return true;
  }

  function flush() {
    return chain.then(() => undefined).catch(() => undefined);
  }

  /**
   * Reject further enqueue, optionally append a final line, then flush.
   * Final line is included in the returned flush promise.
   */
  function close(finalMessage, finalDetail = "") {
    if (closed) return flush();
    if (finalMessage != null && finalMessage !== "") {
      // Enqueue while still open so the exit line is part of the same chain.
      enqueue(finalMessage, finalDetail);
    }
    closed = true;
    return flush();
  }

  return {
    enqueue,
    log: enqueue,
    flush,
    close,
    get closed() {
      return closed;
    },
    formatLogLine: (message, detail) => formatLogLine(message, detail, { now, maxDetailChars, maxLineChars }),
    sanitizeLogDetail: (detail) => sanitizeLogDetail(detail, maxDetailChars),
    sanitizeLogMessage,
    get pending() {
      return chain;
    }
  };
}

module.exports = {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_DETAIL_CHARS,
  DEFAULT_MAX_LINE_CHARS,
  sanitizeLogDetail,
  sanitizeLogMessage,
  redactSecretStrings,
  scrubValue: (value) => scrubValue(value, new WeakSet(), 0),
  formatLogLine,
  createRuntimeLogWriter
};
