"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertPathInsideRoot, normalizePathForCompare, getMeetingSessionsRoot } = require("../paths");

const SCHEME = "mimo-meeting";
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TOKENS = 64;

const tokens = new Map();
const REALTIME_WAV_NAMES = new Set(["microphone-complete.wav", "system-complete.wav"]);

function denied() {
  return Object.assign(new Error("playback denied"), { code: "playback_denied" });
}

function validatePlaybackPath({ sessionsRoot, sessionId, absPath }) {
  try {
    if (typeof sessionsRoot !== "string" || !path.isAbsolute(sessionsRoot)
      || typeof sessionId !== "string" || sessionId.length > 256 || sessionId !== sessionId.trim() || !/^[a-zA-Z0-9._-]+$/.test(sessionId)
      || [".", ".."].includes(sessionId) || typeof absPath !== "string" || !path.isAbsolute(absPath)) throw denied();
    const root = path.resolve(sessionsRoot);
    const sessionDir = path.join(root, sessionId);
    // Validate the original spelling before resolve can erase traversal components.
    assertPathInsideRoot(root, sessionDir);
    assertPathInsideRoot(sessionDir, absPath);
    const relative = path.relative(sessionDir, path.resolve(absPath));
    const parts = relative.split(path.sep);
    const archive = parts[0] === "archive" && parts.length >= 2 && /\.wav$/i.test(parts.at(-1));
    const realtime = parts.length === 2 && parts[0] === "realtime" && REALTIME_WAV_NAMES.has(parts[1]);
    if ((!archive && !realtime) || parts.some(part => !part || part === "." || part === ".." || /[:\0]/.test(part))) throw denied();

    const canonicalRoot = fs.realpathSync.native(root);
    let candidate = path.join(canonicalRoot, sessionId);
    // Reject links and junctions below the trusted root, including in-root aliases.
    for (const part of [null, ...parts]) {
      if (part !== null) candidate = path.join(candidate, part);
      if (fs.lstatSync(candidate).isSymbolicLink()
        || normalizePathForCompare(fs.realpathSync.native(candidate)) !== normalizePathForCompare(candidate)) throw denied();
    }
    assertPathInsideRoot(canonicalRoot, candidate);
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (!stat.isFile()) throw denied();
    return { absPath: candidate, sessionsRoot: canonicalRoot, sessionId,
      identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` };
  } catch {
    throw denied();
  }
}

function pruneTokens(now = Date.now()) {
  for (const [k, v] of tokens) {
    if (v.expiresAt <= now) tokens.delete(k);
  }
  while (tokens.size > MAX_TOKENS) {
    const first = tokens.keys().next().value;
    tokens.delete(first);
  }
}

function issuePlaybackToken({ sessionsRoot, sessionId, absPath }) {
  const entry = validatePlaybackPath({ sessionsRoot, sessionId, absPath });
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  pruneTokens();
  const token = crypto.randomBytes(24).toString("hex");
  tokens.set(token, { ...entry, expiresAt });
  pruneTokens();
  return {
    token,
    url: `${SCHEME}://play/${token}`,
    expiresAt
  };
}

function resolvePlaybackToken(token) {
  pruneTokens();
  const entry = tokens.get(String(token || ""));
  if (!entry) {
    const error = new Error("invalid or expired playback token");
    error.code = "playback_token_invalid";
    throw error;
  }
  if (entry.expiresAt <= Date.now()) {
    tokens.delete(String(token));
    const error = new Error("playback token expired");
    error.code = "playback_token_expired";
    throw error;
  }
  try {
    const checked = validatePlaybackPath(entry);
    if (checked.absPath !== entry.absPath || checked.identity !== entry.identity) throw denied();
  } catch {
    tokens.delete(String(token));
    throw denied();
  }
  return { ...entry };
}

function openPlaybackToken(token) {
  const entry = resolvePlaybackToken(token);
  let fd;
  try {
    fd = fs.openSync(entry.absPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const identity = fs.fstatSync(fd, { bigint: true });
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || `${identity.dev}:${identity.ino}:${identity.birthtimeNs}` !== entry.identity) throw denied();
    // The protocol streams this descriptor; a later path swap cannot redirect it.
    resolvePlaybackToken(token);
    return { ...entry, fd, stat };
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    tokens.delete(String(token));
    throw denied();
  }
}

function revokePlaybackToken(token) {
  tokens.delete(String(token || ""));
}

function clearAllPlaybackTokens() {
  tokens.clear();
}

function playbackUrlFromToken(token) {
  return `${SCHEME}://play/${token}`;
}

module.exports = {
  SCHEME,
  TOKEN_TTL_MS,
  issuePlaybackToken,
  resolvePlaybackToken,
  openPlaybackToken,
  revokePlaybackToken,
  clearAllPlaybackTokens,
  playbackUrlFromToken,
  getMeetingSessionsRoot
};
