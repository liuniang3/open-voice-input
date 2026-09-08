"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  ARTIFACT_SCHEMA,
  SIDECAR_SCHEMA,
  PAUSE_HOLE_POLICY,
  QPC_MAPPING_POLICY,
  buildWavHeader,
  sha256File,
  makePartSuffix,
  verifyArchiveIntegrity
} = require("../archive/export-track-wav");
const { createLinearPcm16Resampler } = require("../transcription/resample");
const { assertPathInsideRoot } = require("../paths");
const {
  CANONICAL_SAMPLE_RATE,
  IMPORT_SOURCE,
  IMPORT_SESSION_ORIGIN_QPC,
  IMPORT_QPC_FREQUENCY,
  parseImportWavHeader,
  downmixInterleavedPcm16ToMono,
  quarantineParts,
  quarantineExistingArchive,
  invalidatePriorDerivedWork
} = require("./import-wav");

const READ_CHUNK = 64 * 1024;

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  throw error;
}

/**
 * Build canonical 16k mono archive from a local WAV path already under session root
 * (or any readable wav). Shared by wav + media importers.
 */
async function commitCanonicalArchiveFromWav({
  wavSourcePath,
  sessionDir,
  sessionId,
  track = "microphone",
  role = "self",
  reimport = false,
  signal = null,
  importMeta = {},
  mappingNoteExtra = []
} = {}) {
  if (!wavSourcePath || !sessionDir || !sessionId) {
    fail("import_invalid", "wavSourcePath/sessionDir/sessionId required");
  }
  const archiveDir = path.join(sessionDir, "archive");
  await fsp.mkdir(archiveDir, { recursive: true });
  assertPathInsideRoot(sessionDir, archiveDir);

  const sourceHeader = await parseImportWavHeader(wavSourcePath);
  const resolvedTrack = track === "system" ? "system" : "microphone";
  const resolvedRole =
    role || (resolvedTrack === "microphone" ? "self" : "remote_mix_for_diarization");
  const wavName = `${resolvedTrack}.mono.wav`;
  const wavPath = path.join(archiveDir, wavName);
  const sidecarPath = `${wavPath}.sidecar.json`;
  assertPathInsideRoot(sessionDir, wavPath);
  assertPathInsideRoot(sessionDir, sidecarPath);

  const part = makePartSuffix();
  const wavPart = `${wavPath}.${part}.part`;
  const scPart = `${sidecarPath}.${part}.part`;
  const partPaths = [wavPart, scPart];

  try {
    const resampler = createLinearPcm16Resampler(sourceHeader.sampleRate, CANONICAL_SAMPLE_RATE);
    const fhIn = await fsp.open(wavSourcePath, "r");
    const fhOut = await fsp.open(wavPart, "w");
    let outFrames = 0;
    try {
      await fhOut.write(buildWavHeader(0, CANONICAL_SAMPLE_RATE, 1, 16), 0, 44, 0);
      let pos = sourceHeader.dataOffset;
      const end = sourceHeader.dataOffset + sourceHeader.dataSize;
      const buf = Buffer.alloc(
        READ_CHUNK - (READ_CHUNK % sourceHeader.blockAlign) || sourceHeader.blockAlign * 1024
      );
      while (pos < end) {
        if (signal?.aborted) fail("aborted", "import cancelled");
        const toRead = Math.min(buf.length, end - pos);
        const aligned = toRead - (toRead % sourceHeader.blockAlign);
        if (aligned <= 0) break;
        const { bytesRead } = await fhIn.read(buf, 0, aligned, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const mono = downmixInterleavedPcm16ToMono(buf.subarray(0, bytesRead), sourceHeader.channels);
        const resampled = resampler.push(mono);
        if (resampled.length) {
          await fhOut.write(resampled, 0, resampled.length, 44 + outFrames * 2);
          outFrames += resampled.length / 2;
        }
      }
      const flushed = resampler.flush();
      if (flushed.length) {
        await fhOut.write(flushed, 0, flushed.length, 44 + outFrames * 2);
        outFrames += flushed.length / 2;
      }
      const dataBytes = outFrames * 2;
      await fhOut.write(buildWavHeader(dataBytes, CANONICAL_SAMPLE_RATE, 1, 16), 0, 44, 0);
    } finally {
      await fhIn.close().catch(() => {});
      await fhOut.close().catch(() => {});
    }

    if (signal?.aborted) fail("aborted", "import cancelled");

    const contentSha256 = await sha256File(wavPart);
    const durationMs = CANONICAL_SAMPLE_RATE > 0 ? (outFrames / CANONICAL_SAMPLE_RATE) * 1000 : 0;
    const sidecar = {
      schema: SIDECAR_SCHEMA,
      artifactSchema: ARTIFACT_SCHEMA,
      sessionId,
      track: resolvedTrack,
      role: resolvedRole,
      sourceTrackDir: null,
      wavRelativeHint: wavName,
      contentSha256,
      commit: {
        orderedRename: ["wav", "sidecar"],
        twoFileAtomic: false,
        note: "import-derived archive; verify contentSha256"
      },
      pauseHolePolicy: PAUSE_HOLE_POLICY,
      qpcMappingPolicy: QPC_MAPPING_POLICY,
      inputFormat: {
        sampleRate: sourceHeader.sampleRate,
        channels: sourceHeader.channels,
        bitsPerSample: 16,
        kind: "pcm16",
        import: true
      },
      outputFormat: {
        sampleRate: CANONICAL_SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
        encoding: "s16le",
        container: "wav",
        layer: "archive_mono_pcm16"
      },
      sessionOriginQpc: IMPORT_SESSION_ORIGIN_QPC,
      qpcFrequency: IMPORT_QPC_FREQUENCY,
      totalOutFrames: outFrames,
      totalOutBytes: outFrames * 2,
      durationMs,
      gaps: [],
      chunks: [
        {
          seq: 0,
          beginMs: 0,
          endMs: durationMs,
          outFrameStart: 0,
          outFrameEnd: outFrames,
          outByteStart: 0,
          outByteEnd: outFrames * 2,
          qpcStart: IMPORT_SESSION_ORIGIN_QPC,
          qpcEnd: Math.round(durationMs * (IMPORT_QPC_FREQUENCY / 1000)),
          sessionOriginQpc: IMPORT_SESSION_ORIGIN_QPC,
          qpcFrequency: IMPORT_QPC_FREQUENCY
        }
      ],
      mappingNotes: [
        "Import converted to 16 kHz mono PCM16 archive.",
        "Synthetic sessionOriginQpc=0 qpcFrequency=1000 so sessionMs equals artifactMs.",
        "Source media copied under session/import/ and never deleted.",
        "contentSha256 covers complete archive WAV bytes.",
        ...mappingNoteExtra
      ],
      import: {
        ...(importMeta || {}),
        track: resolvedTrack
      }
    };
    await fsp.writeFile(scPart, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
    await verifyArchiveIntegrity({ wavPath: wavPart, sidecarPath: scPart });
    if (reimport) {
      await quarantineExistingArchive(sessionDir, resolvedTrack);
    }
    await fsp.rename(wavPart, wavPath);
    await fsp.rename(scPart, sidecarPath);
    await verifyArchiveIntegrity({ wavPath, sidecarPath });

    const playHintPath = path.join(archiveDir, `${resolvedTrack}.play.hint.json`);
    await fsp.writeFile(
      playHintPath,
      `${JSON.stringify({
        schema: "meeting_playback_hint_v1",
        track: resolvedTrack,
        wavRelativeHint: wavName,
        contentSha256,
        durationMs
      })}\n`,
      "utf8"
    );

    if (reimport) {
      await invalidatePriorDerivedWork(sessionDir);
    }

    return {
      wavPath,
      sidecarPath,
      contentSha256,
      durationMs,
      track: resolvedTrack,
      role: resolvedRole,
      sampleRate: CANONICAL_SAMPLE_RATE
    };
  } catch (error) {
    const moved = await quarantineParts(sessionDir, partPaths);
    error.quarantined = moved;
    throw error;
  }
}

/**
 * FFmpeg already emitted 16 kHz mono PCM16 WAV. Validate, write sidecar, move
 * the extract workPart directly to live archive (no second resample/copy).
 * On success workPart is consumed (renamed), not left in quarantine.
 */
async function commitPreparedCanonicalWav({
  preparedWavPath,
  sessionDir,
  sessionId,
  track = "microphone",
  role = "self",
  reimport = false,
  signal = null,
  importMeta = {},
  mappingNoteExtra = []
} = {}) {
  if (!preparedWavPath || !sessionDir || !sessionId) {
    fail("import_invalid", "preparedWavPath/sessionDir/sessionId required");
  }
  if (signal?.aborted) fail("aborted", "import cancelled");
  const archiveDir = path.join(sessionDir, "archive");
  await fsp.mkdir(archiveDir, { recursive: true });
  assertPathInsideRoot(sessionDir, archiveDir);
  assertPathInsideRoot(sessionDir, preparedWavPath);

  const header = await parseImportWavHeader(preparedWavPath);
  if (header.sampleRate !== CANONICAL_SAMPLE_RATE || header.channels !== 1) {
    fail(
      "prepared_wav_invalid",
      `expected ${CANONICAL_SAMPLE_RATE}Hz mono, got ${header.sampleRate}Hz ch=${header.channels}`
    );
  }

  const resolvedTrack = track === "system" ? "system" : "microphone";
  const resolvedRole =
    role || (resolvedTrack === "microphone" ? "self" : "remote_mix_for_diarization");
  const wavName = `${resolvedTrack}.mono.wav`;
  const wavPath = path.join(archiveDir, wavName);
  const sidecarPath = `${wavPath}.sidecar.json`;
  assertPathInsideRoot(sessionDir, wavPath);
  assertPathInsideRoot(sessionDir, sidecarPath);

  const part = makePartSuffix();
  const scPart = `${sidecarPath}.${part}.part`;
  const partPaths = [scPart];

  try {
    if (signal?.aborted) fail("aborted", "import cancelled");
    const contentSha256 = await sha256File(preparedWavPath);
    const outFrames = header.frameCount;
    const durationMs = header.durationMs;
    const sidecar = {
      schema: SIDECAR_SCHEMA,
      artifactSchema: ARTIFACT_SCHEMA,
      sessionId,
      track: resolvedTrack,
      role: resolvedRole,
      sourceTrackDir: null,
      wavRelativeHint: wavName,
      contentSha256,
      commit: {
        orderedRename: ["wav", "sidecar"],
        twoFileAtomic: false,
        note: "ffmpeg-prepared archive moved into place; verify contentSha256"
      },
      pauseHolePolicy: PAUSE_HOLE_POLICY,
      qpcMappingPolicy: QPC_MAPPING_POLICY,
      inputFormat: {
        sampleRate: header.sampleRate,
        channels: 1,
        bitsPerSample: 16,
        kind: "pcm16",
        import: true,
        prepared: true
      },
      outputFormat: {
        sampleRate: CANONICAL_SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
        encoding: "s16le",
        container: "wav",
        layer: "archive_mono_pcm16"
      },
      sessionOriginQpc: IMPORT_SESSION_ORIGIN_QPC,
      qpcFrequency: IMPORT_QPC_FREQUENCY,
      totalOutFrames: outFrames,
      totalOutBytes: outFrames * 2,
      durationMs,
      gaps: [],
      chunks: [
        {
          seq: 0,
          beginMs: 0,
          endMs: durationMs,
          outFrameStart: 0,
          outFrameEnd: outFrames,
          outByteStart: 0,
          outByteEnd: outFrames * 2,
          qpcStart: IMPORT_SESSION_ORIGIN_QPC,
          qpcEnd: Math.round(durationMs * (IMPORT_QPC_FREQUENCY / 1000)),
          sessionOriginQpc: IMPORT_SESSION_ORIGIN_QPC,
          qpcFrequency: IMPORT_QPC_FREQUENCY
        }
      ],
      mappingNotes: [
        "FFmpeg extract already 16 kHz mono PCM16; archive is move-commit without re-encode.",
        "Synthetic sessionOriginQpc=0 qpcFrequency=1000 so sessionMs equals artifactMs.",
        "Source media copied under session/import/ and never deleted.",
        "contentSha256 covers complete archive WAV bytes.",
        ...mappingNoteExtra
      ],
      import: {
        ...(importMeta || {}),
        track: resolvedTrack
      }
    };
    await fsp.writeFile(scPart, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
    await verifyArchiveIntegrity({ wavPath: preparedWavPath, sidecarPath: scPart });
    if (reimport) {
      await quarantineExistingArchive(sessionDir, resolvedTrack);
    }
    // Consume prepared part → live wav (no leftover extract in quarantine on success)
    await fsp.rename(preparedWavPath, wavPath);
    await fsp.rename(scPart, sidecarPath);
    await verifyArchiveIntegrity({ wavPath, sidecarPath });

    const playHintPath = path.join(archiveDir, `${resolvedTrack}.play.hint.json`);
    await fsp.writeFile(
      playHintPath,
      `${JSON.stringify({
        schema: "meeting_playback_hint_v1",
        track: resolvedTrack,
        wavRelativeHint: wavName,
        contentSha256,
        durationMs
      })}\n`,
      "utf8"
    );

    if (reimport) {
      await invalidatePriorDerivedWork(sessionDir);
    }

    return {
      wavPath,
      sidecarPath,
      contentSha256,
      durationMs,
      track: resolvedTrack,
      role: resolvedRole,
      sampleRate: CANONICAL_SAMPLE_RATE
    };
  } catch (error) {
    const moved = await quarantineParts(sessionDir, [...partPaths, preparedWavPath]);
    error.quarantined = moved;
    throw error;
  }
}

function buildImportSessionPatch({
  title,
  resolvedTrack,
  contentSha256,
  durationMs,
  importMeta
}) {
  return {
    title: String(title || "").slice(0, 200),
    status: "stopped",
    source: IMPORT_SOURCE,
    import: {
      ...(importMeta || {}),
      track: resolvedTrack,
      archiveContentSha256: contentSha256,
      durationMs,
      importedAt: new Date().toISOString()
    },
    processing: { stage: "idle", lastError: null },
    analysis: null,
    tracks: {
      microphone: {
        relativeDir: "audio/microphone",
        status: resolvedTrack === "microphone" ? "imported" : "idle",
        role: "self"
      },
      system: {
        relativeDir: "audio/system",
        status: resolvedTrack === "system" ? "imported" : "idle",
        role: "remote_mix_for_diarization"
      }
    },
    capabilities: {
      microphone: resolvedTrack === "microphone",
      systemLoopback: false,
      dualTrack: false,
      asr: false,
      summary: false,
      processLoopback: false,
      import: true
    },
    notes: ["Stage 4B import: stopped; user must explicitly generate transcript (no auto ASR)"]
  };
}

module.exports = {
  commitCanonicalArchiveFromWav,
  commitPreparedCanonicalWav,
  buildImportSessionPatch
};
