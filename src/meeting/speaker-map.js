"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { assertPathInsideRoot } = require("./paths");

const SPEAKER_MAP_SCHEMA = "meeting_speaker_map_v1";
const SPEAKER_MAP_FILENAME = "speaker-map.json";
const MAX_DISPLAY_NAME = 80;
const MAX_SPEAKERS = 64;

function sanitizeDisplayName(name) {
  const s = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!s) return "";
  return s.length > MAX_DISPLAY_NAME ? s.slice(0, MAX_DISPLAY_NAME) : s;
}

function sanitizeSpeakerId(id) {
  const s = String(id ?? "")
    .replace(/[^a-zA-Z0-9._:@-]/g, "_")
    .slice(0, 64);
  return s || "unknown";
}

function emptySpeakerMap(sessionId) {
  return {
    schema: SPEAKER_MAP_SCHEMA,
    sessionId: sessionId || null,
    speakers: {}
  };
}

function speakerMapPath(sessionDir) {
  return path.join(sessionDir, SPEAKER_MAP_FILENAME);
}

async function readSpeakerMap(sessionDir, sessionId) {
  const p = speakerMapPath(sessionDir);
  assertPathInsideRoot(sessionDir, p);
  try {
    const raw = await fsp.readFile(p, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return emptySpeakerMap(sessionId);
    const speakers = {};
    const src = data.speakers && typeof data.speakers === "object" ? data.speakers : {};
    for (const [k, v] of Object.entries(src)) {
      if (Object.keys(speakers).length >= MAX_SPEAKERS) break;
      const id = sanitizeSpeakerId(k);
      const displayName = sanitizeDisplayName(v?.displayName ?? v);
      if (displayName) speakers[id] = { displayName };
    }
    return {
      schema: SPEAKER_MAP_SCHEMA,
      sessionId: sessionId || data.sessionId || null,
      speakers
    };
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "wav_invalid")) {
      return emptySpeakerMap(sessionId);
    }
    if (error instanceof SyntaxError) return emptySpeakerMap(sessionId);
    throw error;
  }
}

async function writeSpeakerMap(sessionDir, sessionId, patch = {}) {
  const current = await readSpeakerMap(sessionDir, sessionId);
  const nextSpeakers = { ...current.speakers };
  const incoming = patch.speakers && typeof patch.speakers === "object" ? patch.speakers : patch;
  for (const [k, v] of Object.entries(incoming || {})) {
    const id = sanitizeSpeakerId(k);
    if (v == null || v === "" || (typeof v === "object" && !v.displayName)) {
      delete nextSpeakers[id];
      continue;
    }
    const displayName = sanitizeDisplayName(typeof v === "string" ? v : v.displayName);
    if (!displayName) {
      delete nextSpeakers[id];
      continue;
    }
    nextSpeakers[id] = { displayName };
  }
  const keys = Object.keys(nextSpeakers);
  if (keys.length > MAX_SPEAKERS) {
    for (const k of keys.slice(MAX_SPEAKERS)) delete nextSpeakers[k];
  }
  const doc = {
    schema: SPEAKER_MAP_SCHEMA,
    sessionId: sessionId || current.sessionId || null,
    speakers: nextSpeakers
  };
  const p = speakerMapPath(sessionDir);
  assertPathInsideRoot(sessionDir, p);
  const part = `${p}.${process.pid}.part`;
  await fsp.writeFile(part, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  await fsp.rename(part, p);
  return doc;
}

/** Apply display names for UI/export only — never mutates transcript items' speakerId or text. */
function resolveDisplayName(speakerMap, speakerId, fallback) {
  const id = sanitizeSpeakerId(speakerId);
  const mapped = speakerMap?.speakers?.[id]?.displayName;
  if (mapped) return mapped;
  if (fallback) return String(fallback);
  return id;
}

function decorateTranscriptForDisplay(transcript, speakerMap) {
  const items = Array.isArray(transcript?.items) ? transcript.items : [];
  return {
    ...transcript,
    items: items.map((it) => ({
      ...it,
      speakerDisplayName: resolveDisplayName(speakerMap, it.speakerId, it.speakerLabel || it.speakerId)
    }))
  };
}

module.exports = {
  SPEAKER_MAP_SCHEMA,
  SPEAKER_MAP_FILENAME,
  MAX_DISPLAY_NAME,
  sanitizeDisplayName,
  sanitizeSpeakerId,
  emptySpeakerMap,
  speakerMapPath,
  readSpeakerMap,
  writeSpeakerMap,
  resolveDisplayName,
  decorateTranscriptForDisplay
};
