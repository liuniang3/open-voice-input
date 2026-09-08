"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { HELPER_NAME, HELPER_VERSION } = require("./constants");

function stripExtendedPrefix(input) {
  const value = String(input || "");
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function normalizePathForCompare(input) {
  return stripExtendedPrefix(path.resolve(String(input || "")))
    .replace(/\//g, "\\")
    .toLowerCase();
}

function tryRealpath(input) {
  try {
    return stripExtendedPrefix(fs.realpathSync.native(input));
  } catch {
    try {
      return stripExtendedPrefix(fs.realpathSync(input));
    } catch {
      return null;
    }
  }
}

/**
 * Resolve nearest existing ancestor via realpath (junction/symlink aware),
 * then rejoin the missing suffix. Does not create directories.
 */
function resolveCanonicalCandidate(candidatePath) {
  const abs = path.resolve(String(candidatePath || ""));
  if (!abs) {
    const error = new Error("path is empty");
    error.code = "path_empty";
    throw error;
  }

  const existingReal = tryRealpath(abs);
  if (existingReal) {
    return { resolved: existingReal, existed: true };
  }

  let cur = abs;
  const suffix = [];
  while (true) {
    const parent = path.dirname(cur);
    if (!parent || parent === cur) {
      const error = new Error("path has no resolvable ancestor");
      error.code = "path_denied";
      throw error;
    }
    suffix.unshift(path.basename(cur));
    const parentReal = tryRealpath(parent);
    if (parentReal) {
      return {
        resolved: path.join(parentReal, ...suffix),
        existed: false,
        realParent: parentReal
      };
    }
    cur = parent;
  }
}

function isPathInsideRoot(rootDir, candidatePath) {
  const rootReal = tryRealpath(rootDir) || path.resolve(rootDir);
  const root = normalizePathForCompare(rootReal);
  const candidate = normalizePathForCompare(candidatePath);
  if (candidate === root) return true;
  const prefix = root.endsWith("\\") ? root : `${root}\\`;
  return candidate.startsWith(prefix);
}

/**
 * Canonical path guard: realpath nearest parent, verify containment, then return path.
 * Never follows a junction that would place the real parent outside root.
 */
function assertPathInsideRoot(rootDir, candidatePath) {
  const value = String(candidatePath || "");
  if (!value.trim()) {
    const error = new Error("path is empty");
    error.code = "path_empty";
    throw error;
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) {
    const error = new Error("path must not contain ..");
    error.code = "path_denied";
    throw error;
  }

  const rootAbs = path.resolve(rootDir);
  const rootReal = tryRealpath(rootAbs) || rootAbs;

  const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(rootAbs, value);
  const { resolved, realParent } = resolveCanonicalCandidate(abs);

  // Containment check uses real parent when candidate does not exist yet.
  const checkTarget = realParent || resolved;
  if (!isPathInsideRoot(rootReal, checkTarget)) {
    const error = new Error(`path escapes session root: ${resolved}`);
    error.code = "path_denied";
    throw error;
  }
  if (!isPathInsideRoot(rootReal, resolved)) {
    const error = new Error(`path escapes session root: ${resolved}`);
    error.code = "path_denied";
    throw error;
  }
  return resolved;
}

function getMeetingSessionsRoot(userDataPath) {
  return path.join(userDataPath, "meeting-sessions");
}

function getSessionDir(sessionsRoot, sessionId) {
  const safeId = String(sessionId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safeId) {
    const error = new Error("sessionId is required");
    error.code = "invalid_session_id";
    throw error;
  }
  return path.join(sessionsRoot, safeId);
}

function getMicrophoneTrackDir(sessionDir) {
  return path.join(sessionDir, "audio", "microphone");
}

function getSystemTrackDir(sessionDir) {
  return path.join(sessionDir, "audio", "system");
}

function resolveHelperPath({ isPackaged, resourcesPath, appRoot, overridePath }) {
  if (overridePath) {
    return path.resolve(overridePath);
  }
  if (isPackaged) {
    return path.join(resourcesPath, "native", `${HELPER_NAME}.exe`);
  }
  const candidates = [
    path.join(appRoot, "native", "audio-capture-helper", "target", "release", `${HELPER_NAME}.exe`),
    path.join(appRoot, "native", "audio-capture-helper", "target-release-out", `${HELPER_NAME}.exe`),
    path.join(appRoot, "native", `${HELPER_NAME}.exe`)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function helperExists(helperPath) {
  try {
    return fs.existsSync(helperPath) && fs.statSync(helperPath).isFile();
  } catch {
    return false;
  }
}

function assertHelperReady(helperPath, { requiredVersion = HELPER_VERSION } = {}) {
  if (!helperExists(helperPath)) {
    const error = new Error(
      `audio-capture-helper missing at ${helperPath}. Build native/audio-capture-helper release before packaging.`
    );
    error.code = "helper_missing";
    error.helperPath = helperPath;
    throw error;
  }
  return {
    path: helperPath,
    requiredVersion,
    name: HELPER_NAME
  };
}

module.exports = {
  stripExtendedPrefix,
  normalizePathForCompare,
  tryRealpath,
  resolveCanonicalCandidate,
  isPathInsideRoot,
  assertPathInsideRoot,
  getMeetingSessionsRoot,
  getSessionDir,
  getMicrophoneTrackDir,
  getSystemTrackDir,
  resolveHelperPath,
  helperExists,
  assertHelperReady
};
