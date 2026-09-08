"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { assertPathInsideRoot } = require("../paths");
const {
  buildWavHeader,
  sha256File,
  makePartSuffix,
  verifyArchiveIntegrity
} = require("../archive/export-track-wav");

const CANONICAL_SAMPLE_RATE = 16000;
const IMPORT_SOURCE = "import";
/** Synthetic session clock: sessionMs == artifactMs */
const IMPORT_SESSION_ORIGIN_QPC = 0;
const IMPORT_QPC_FREQUENCY = 1000;

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  throw error;
}

async function parseImportWavHeader(filePath) {
  const fh = await fsp.open(filePath, "r");
  try {
    const st = await fh.stat();
    const fileSize = st.size;
    if (fileSize < 12) fail("wav_invalid", "WAV too short");
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
      fail("wav_invalid", "not a RIFF/WAVE file");
    }
    let offset = 12;
    let fmt = null;
    let dataOffset = -1;
    let dataSize = -1;
    while (offset + 8 <= fileSize) {
      const chunkHead = Buffer.alloc(8);
      const { bytesRead } = await fh.read(chunkHead, 0, 8, offset);
      if (bytesRead < 8) break;
      const id = chunkHead.toString("ascii", 0, 4);
      const size = chunkHead.readUInt32LE(4);
      const dataStart = offset + 8;
      const maxPayload = fileSize - dataStart;
      if (id === "fmt ") {
        const toRead = Math.min(size, 40);
        const fmtBuf = Buffer.alloc(toRead);
        await fh.read(fmtBuf, 0, toRead, dataStart);
        fmt = {
          audioFormat: fmtBuf.readUInt16LE(0),
          channels: fmtBuf.readUInt16LE(2),
          sampleRate: fmtBuf.readUInt32LE(4),
          bitsPerSample: fmtBuf.readUInt16LE(14),
          blockAlign: fmtBuf.readUInt16LE(12)
        };
      } else if (id === "data") {
        dataOffset = dataStart;
        dataSize = Math.min(size, Math.max(0, maxPayload));
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!fmt) fail("wav_invalid", "missing fmt");
    if (dataOffset < 0) fail("wav_invalid", "missing data");
    if (fmt.audioFormat !== 1) fail("wav_format_unsupported", `PCM required, got format=${fmt.audioFormat}`);
    if (!(fmt.channels >= 1 && fmt.channels <= 8)) fail("wav_invalid", `bad channels ${fmt.channels}`);
    if (fmt.bitsPerSample !== 16) fail("wav_format_unsupported", `16-bit required, got ${fmt.bitsPerSample}`);
    if (!(fmt.sampleRate > 0)) fail("wav_invalid", "bad sampleRate");
    const frameBytes = fmt.channels * 2;
    const frames = Math.floor(dataSize / frameBytes);
    return {
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitsPerSample: 16,
      blockAlign: frameBytes,
      dataOffset,
      dataSize: frames * frameBytes,
      frameCount: frames,
      durationMs: fmt.sampleRate > 0 ? (frames / fmt.sampleRate) * 1000 : 0,
      fileSize
    };
  } finally {
    await fh.close();
  }
}

function downmixInterleavedPcm16ToMono(input, channels) {
  const ch = Math.max(1, channels | 0);
  const frames = Math.floor(input.length / (ch * 2));
  if (ch === 1) return Buffer.from(input.subarray(0, frames * 2));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < ch; c += 1) {
      sum += input.readInt16LE((i * ch + c) * 2);
    }
    const avg = Math.max(-32768, Math.min(32767, Math.round(sum / ch)));
    out.writeInt16LE(avg, i * 2);
  }
  return out;
}

async function copyFilePreserve(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  await fsp.access(src, fs.constants.F_OK);
}

/**
 * Stream copy into session/import: write *.source.part, then quarantine any
 * existing final name and rename. AbortSignal cancels; parts go to quarantine.
 * Source file is never deleted.
 */
async function copyFileStreaming({
  src,
  destFinal,
  sessionDir,
  signal = null,
  onProgress = null
} = {}) {
  if (!src || !destFinal || !sessionDir) fail("import_invalid", "copy paths required");
  assertPathInsideRoot(sessionDir, destFinal);
  await fsp.mkdir(path.dirname(destFinal), { recursive: true });
  const partPath = `${destFinal}.source.part`;
  assertPathInsideRoot(sessionDir, partPath);
  const st = await fsp.stat(src);
  const total = st.size;
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(partPath);
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      rs.destroy();
      ws.destroy();
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      const error = new Error("copy cancelled");
      error.code = "aborted";
      done(error);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    rs.on("data", (chunk) => {
      bytes += chunk.length;
      if (typeof onProgress === "function") {
        try {
          onProgress({ phase: "copy", bytes, total });
        } catch {
          /* ignore */
        }
      }
    });
    rs.on("error", done);
    ws.on("error", done);
    ws.on("finish", () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      done();
    });
    rs.pipe(ws);
  }).catch(async (error) => {
    await quarantineParts(sessionDir, [partPath]);
    throw error;
  });
  if (signal?.aborted) {
    await quarantineParts(sessionDir, [partPath]);
    fail("aborted", "copy cancelled");
  }
  // Move previous final copy aside if present, then commit part
  try {
    await fsp.access(destFinal);
    await quarantineParts(sessionDir, [destFinal]);
  } catch {
    /* no previous */
  }
  await fsp.rename(partPath, destFinal);
  await fsp.access(src, fs.constants.F_OK);
  return { bytes, total, dest: destFinal };
}

/**
 * Move failed/cancelled .part (or stray) artifacts into import/quarantine.
 * Never permanently deletes user/production partials.
 */
async function quarantineParts(sessionDir, paths = []) {
  const qDir = path.join(sessionDir, "import", "quarantine");
  await fsp.mkdir(qDir, { recursive: true });
  assertPathInsideRoot(sessionDir, qDir);
  const moved = [];
  for (const p of paths) {
    if (!p) continue;
    try {
      assertPathInsideRoot(sessionDir, p);
      await fsp.access(p);
      const base = path.basename(p);
      const dest = path.join(qDir, `${Date.now()}.${process.pid}.${base}`);
      assertPathInsideRoot(sessionDir, dest);
      await fsp.rename(p, dest);
      moved.push(path.basename(dest));
    } catch {
      // missing is fine
    }
  }
  return moved;
}

async function invalidatePriorDerivedWork(sessionDir) {
  const qDir = path.join(sessionDir, "import", "quarantine");
  await fsp.mkdir(qDir, { recursive: true });
  assertPathInsideRoot(sessionDir, qDir);
  const dirs = ["transcription", "analysis"];
  for (const name of dirs) {
    const t = path.join(sessionDir, name);
    try {
      assertPathInsideRoot(sessionDir, t);
      await fsp.access(t);
      const dest = path.join(qDir, `${Date.now()}.${process.pid}.dir.${name}`);
      assertPathInsideRoot(sessionDir, dest);
      await fsp.rename(t, dest);
    } catch {
      /* absent ok */
    }
  }
  await quarantineParts(sessionDir, [path.join(sessionDir, "processing.json")]);
}

/**
 * Move existing archive artifacts aside before writing new ones (reimport).
 * Old files remain recoverable in quarantine if new import fails later.
 */
async function quarantineExistingArchive(sessionDir, track) {
  const archiveDir = path.join(sessionDir, "archive");
  const wavPath = path.join(archiveDir, `${track}.mono.wav`);
  const sidecarPath = `${wavPath}.sidecar.json`;
  const playHintPath = path.join(archiveDir, `${track}.play.hint.json`);
  return quarantineParts(sessionDir, [wavPath, sidecarPath, playHintPath]);
}

/**
 * Convert import WAV → archive/microphone.mono.wav (16k mono PCM16) + sidecar_v1.
 * Source file is only copied into session/import/; never deleted.
 * Absolute source path must not be written into session JSON / logs by callers.
 *
 * Reimport order:
 * 1) copy source + build new archive to .part
 * 2) verify new archive
 * 3) quarantine old archive (wav/sidecar/hint) then commit new
 * 4) only then invalidate old transcription/analysis
 * If steps 1–2 fail, old archive + derived work remain.
 */
async function importWavToSession({
  sourcePath,
  sessionDir,
  sessionId,
  title = "",
  track = "microphone",
  role = "self",
  signal = null,
  reimport = false,
  onProgress = null
} = {}) {
  if (!sourcePath || !sessionDir || !sessionId) fail("import_invalid", "sourcePath/sessionDir/sessionId required");
  const absSource = path.resolve(sourcePath);
  if (!fs.existsSync(absSource)) fail("import_source_missing", "source WAV not found");

  // Validate RIFF early (also done again inside canonical commit)
  await parseImportWavHeader(absSource);
  const importDir = path.join(sessionDir, "import");
  await fsp.mkdir(importDir, { recursive: true });
  assertPathInsideRoot(sessionDir, importDir);

  const baseName = path.basename(absSource);
  const safeName = baseName.replace(/[^\w.\u4e00-\u9fff-]+/g, "_").slice(0, 180) || "import.wav";
  const copiedPath = path.join(importDir, safeName);
  assertPathInsideRoot(sessionDir, copiedPath);
  if (typeof onProgress === "function") {
    try {
      onProgress({ phase: "copy" });
    } catch {
      /* ignore */
    }
  }
  await copyFileStreaming({
    src: absSource,
    destFinal: copiedPath,
    sessionDir,
    signal,
    onProgress
  });
  const sourceSha = await sha256File(copiedPath);
  if (!fs.existsSync(absSource)) fail("import_source_deleted", "source file missing after copy (must not delete)");

  if (signal?.aborted) fail("aborted", "import cancelled");

  const resolvedTrack = track === "system" ? "system" : "microphone";
  const resolvedRole =
    role || (resolvedTrack === "microphone" ? "self" : "remote_mix_for_diarization");
  // Lazy require avoids circular dependency with import-canonical.js
  const { commitCanonicalArchiveFromWav, buildImportSessionPatch } = require("./import-canonical");
  const sourceHeader = await parseImportWavHeader(copiedPath);
  if (typeof onProgress === "function") {
    try {
      onProgress({ phase: "commit" });
    } catch {
      /* ignore */
    }
  }
  const archive = await commitCanonicalArchiveFromWav({
    wavSourcePath: copiedPath,
    sessionDir,
    sessionId,
    track: resolvedTrack,
    role: resolvedRole,
    reimport,
    signal,
    importMeta: {
      sourceFileName: safeName,
      sourceContentSha256: sourceSha,
      sourceSampleRate: sourceHeader.sampleRate,
      sourceChannels: sourceHeader.channels,
      sourceDurationMs: sourceHeader.durationMs,
      mediaKind: "wav",
      extension: "wav",
      importer: "wav",
      track: resolvedTrack
    },
    mappingNoteExtra: ["WAV import converted to 16 kHz mono PCM16 archive."]
  });

  const sessionPatch = buildImportSessionPatch({
    title,
    resolvedTrack,
    contentSha256: archive.contentSha256,
    durationMs: archive.durationMs,
    importMeta: {
      sourceFileName: safeName,
      sourceContentSha256: sourceSha,
      sourceSampleRate: sourceHeader.sampleRate,
      sourceChannels: sourceHeader.channels,
      sourceDurationMs: sourceHeader.durationMs,
      mediaKind: "wav",
      extension: "wav",
      importer: "wav",
      track: resolvedTrack,
      durationMs: archive.durationMs
    }
  });

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
}

async function tryLoadExistingImportArchive(sessionDir, track = "microphone") {
  const wavPath = path.join(sessionDir, "archive", `${track}.mono.wav`);
  const sidecarPath = `${wavPath}.sidecar.json`;
  try {
    assertPathInsideRoot(sessionDir, wavPath);
    assertPathInsideRoot(sessionDir, sidecarPath);
    const v = await verifyArchiveIntegrity({ wavPath, sidecarPath });
    const raw = await fsp.readFile(sidecarPath, "utf8");
    const sidecar = JSON.parse(raw);
    return {
      ok: true,
      wavPath,
      sidecarPath,
      contentSha256: sidecar.contentSha256 || v.contentSha256,
      role: sidecar.role || (track === "microphone" ? "self" : "remote_mix_for_diarization"),
      track,
      durationMs: sidecar.durationMs,
      sessionOriginQpc: sidecar.sessionOriginQpc,
      qpcFrequency: sidecar.qpcFrequency
    };
  } catch {
    return null;
  }
}

module.exports = {
  CANONICAL_SAMPLE_RATE,
  IMPORT_SOURCE,
  IMPORT_SESSION_ORIGIN_QPC,
  IMPORT_QPC_FREQUENCY,
  parseImportWavHeader,
  downmixInterleavedPcm16ToMono,
  importWavToSession,
  tryLoadExistingImportArchive,
  copyFilePreserve,
  copyFileStreaming,
  quarantineParts,
  quarantineExistingArchive,
  invalidatePriorDerivedWork
};
