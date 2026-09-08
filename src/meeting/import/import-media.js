"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { assertPathInsideRoot } = require("../paths");
const { sha256File, makePartSuffix } = require("../archive/export-track-wav");
const {
  copyFileStreaming,
  quarantineParts,
  IMPORT_SOURCE,
  CANONICAL_SAMPLE_RATE
} = require("./import-wav");
const { commitPreparedCanonicalWav, buildImportSessionPatch } = require("./import-canonical");
const { resolveFfmpegPath } = require("./resolve-ffmpeg");
const { runFfmpegExtract } = require("./ffmpeg-runner");

const MAX_MEDIA_BYTES = 8 * 1024 * 1024 * 1024;
const MEDIA_EXTS = new Set([
  "wav",
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "wma",
  "mp4",
  "mkv",
  "webm",
  "mov",
  "avi",
  "m4v"
]);

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  throw error;
}

function safeMediaBaseName(filePath) {
  const base = path.basename(String(filePath || ""));
  return base.replace(/[^\w.\u4e00-\u9fff-]+/g, "_").slice(0, 180) || "import.media";
}

function mediaKindFromExt(ext) {
  const e = String(ext || "")
    .toLowerCase()
    .replace(/^\./, "");
  if (["mp4", "mkv", "webm", "mov", "avi", "m4v"].includes(e)) return "video";
  if (e === "wav") return "wav";
  return "audio";
}

function assertSupportedMedia(filePath, size) {
  const ext = path
    .extname(filePath || "")
    .toLowerCase()
    .replace(/^\./, "");
  if (!MEDIA_EXTS.has(ext)) {
    fail("media_unsupported", `unsupported media extension: ${ext || "(none)"}`);
  }
  if (!(size > 0) || size > MAX_MEDIA_BYTES) {
    fail("media_too_large", "media exceeds 8 GiB limit or empty");
  }
  return ext;
}

/**
 * Import arbitrary media via ffmpeg extract → prepared canonical archive (no re-encode).
 * Source is stream-copied under session/import/; never deleted.
 */
async function importMediaToSession({
  sourcePath,
  sessionDir,
  sessionId,
  title = "",
  track = "microphone",
  role = null,
  signal = null,
  reimport = false,
  ffmpegPath = null,
  isPackaged = false,
  resourcesPath = "",
  appRoot = "",
  onProgress = null
} = {}) {
  if (!sourcePath || !sessionDir || !sessionId) {
    fail("import_invalid", "sourcePath/sessionDir/sessionId required");
  }
  const absSource = path.resolve(sourcePath);
  if (!fs.existsSync(absSource)) fail("import_source_missing", "source media not found");
  const st = await fsp.stat(absSource);
  const ext = assertSupportedMedia(absSource, st.size);

  const importDir = path.join(sessionDir, "import");
  await fsp.mkdir(importDir, { recursive: true });
  assertPathInsideRoot(sessionDir, importDir);

  const safeName = safeMediaBaseName(absSource);
  const copiedPath = path.join(importDir, safeName);
  assertPathInsideRoot(sessionDir, copiedPath);

  const report = (phase, extra = {}) => {
    if (typeof onProgress === "function") {
      try {
        onProgress({ phase, ...extra });
      } catch {
        /* ignore */
      }
    }
  };

  report("copy", { bytes: 0, total: st.size });
  await copyFileStreaming({
    src: absSource,
    destFinal: copiedPath,
    sessionDir,
    signal,
    onProgress: (p) => report("copy", p)
  });
  const sourceSha = await sha256File(copiedPath);
  if (!fs.existsSync(absSource)) fail("import_source_deleted", "source file missing after copy");

  if (signal?.aborted) fail("aborted", "import cancelled");

  const resolvedTrack = track === "system" ? "system" : "microphone";
  const resolvedRole =
    role || (resolvedTrack === "microphone" ? "self" : "remote_mix_for_diarization");

  const workPart = path.join(importDir, `extract.${makePartSuffix()}.wav.part`);
  assertPathInsideRoot(sessionDir, workPart);
  const partPaths = [workPart];

  try {
    report("extract", {});
    const bin =
      ffmpegPath || resolveFfmpegPath({ isPackaged, resourcesPath, appRoot });
    await runFfmpegExtract({
      ffmpegPath: bin,
      inputPath: copiedPath,
      outputPath: workPart,
      signal
    });
    if (signal?.aborted) fail("aborted", "import cancelled");

    const importMeta = {
      sourceFileName: safeName,
      sourceContentSha256: sourceSha,
      mediaKind: mediaKindFromExt(ext),
      extension: ext,
      track: resolvedTrack,
      importer: "media"
    };

    report("commit", {});
    const archive = await commitPreparedCanonicalWav({
      preparedWavPath: workPart,
      sessionDir,
      sessionId,
      track: resolvedTrack,
      role: resolvedRole,
      reimport,
      signal,
      importMeta,
      mappingNoteExtra: ["Media import via ffmpeg first audio stream → 16 kHz mono PCM16 (move-commit)."]
    });
    // workPart was renamed into live archive on success — not quarantined

    const sessionPatch = buildImportSessionPatch({
      title,
      resolvedTrack,
      contentSha256: archive.contentSha256,
      durationMs: archive.durationMs,
      importMeta: {
        ...importMeta,
        durationMs: archive.durationMs
      }
    });

    report("done", {});
    return {
      ok: true,
      sessionId,
      status: "stopped",
      source: IMPORT_SOURCE,
      archive: {
        track: archive.track,
        contentSha256: archive.contentSha256,
        durationMs: archive.durationMs,
        sampleRate: CANONICAL_SAMPLE_RATE
      },
      import: sessionPatch.import,
      sessionPatch,
      _paths: { wavPath: archive.wavPath, sidecarPath: archive.sidecarPath, copiedPath }
    };
  } catch (error) {
    const moved = await quarantineParts(sessionDir, partPaths);
    error.quarantined = [...(error.quarantined || []), ...moved];
    throw error;
  }
}

module.exports = {
  MAX_MEDIA_BYTES,
  MEDIA_EXTS,
  importMediaToSession,
  assertSupportedMedia,
  mediaKindFromExt,
  safeMediaBaseName
};
