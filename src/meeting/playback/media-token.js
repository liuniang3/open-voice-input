"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { assertPathInsideRoot, getMeetingSessionsRoot } = require("../paths");

const SCHEME = "mimo-meeting";
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TOKENS = 64;

/** @type {Map<string, { absPath: string, sessionId: string, expiresAt: number }>} */
const tokens = new Map();

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
  const root = path.resolve(sessionsRoot);
  const resolved = path.resolve(absPath);
  assertPathInsideRoot(root, resolved);
  const sessionDir = path.join(root, String(sessionId));
  assertPathInsideRoot(sessionDir, resolved);
  // Only allow files under session/archive/
  const archiveDir = path.join(sessionDir, "archive");
  assertPathInsideRoot(archiveDir, resolved);
  if (!/\.wav$/i.test(resolved)) {
    const error = new Error("playback only allows wav under archive");
    error.code = "playback_denied";
    throw error;
  }
  pruneTokens();
  const token = crypto.randomBytes(24).toString("hex");
  tokens.set(token, {
    absPath: resolved,
    sessionId: String(sessionId),
    expiresAt: Date.now() + TOKEN_TTL_MS
  });
  return {
    token,
    url: `${SCHEME}://play/${token}`,
    expiresAt: Date.now() + TOKEN_TTL_MS
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
  return entry;
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
  revokePlaybackToken,
  clearAllPlaybackTokens,
  playbackUrlFromToken,
  getMeetingSessionsRoot
};
