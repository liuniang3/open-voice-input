"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { parseWavHeader, readPcm16Frames, buildMonoPcm16WavHeader } = require("./wav-reader");
const { createLinearPcm16Resampler } = require("./resample");
const { mapArtifactTimeRange } = require("../archive/export-track-wav");
const { QWEN_NO_BUCKET, MIB } = require("./constants");

const READ_FRAMES = 16 * 1024;

/** Effective PCM duration from 10 MiB Base64 budget (WAV+header ≈ raw*4/3). ~245s @16k mono. */
const EFFECTIVE_PCM_DURATION_CAP_SECONDS = 245;

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeAll(fh, buffer, position) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let offset = 0;
  let pos = position;
  while (offset < buf.length) {
    const { bytesWritten } = await fh.write(buf, offset, buf.length - offset, pos);
    if (!bytesWritten) {
      const error = new Error("write returned 0 bytes");
      error.code = "write_incomplete";
      throw error;
    }
    offset += bytesWritten;
    if (pos != null) pos += bytesWritten;
  }
}

function makePartSuffix() {
  return `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
}

async function sha256File(filePath) {
  const fh = await fsp.open(filePath, "r");
  const hash = crypto.createHash("sha256");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return hash.digest("hex");
}

function estimateDataUriChars(wavBytes) {
  const b64 = Math.ceil(wavBytes / 3) * 4;
  return 22 + b64;
}

/**
 * Bounded PCM accumulator: O(n) concat via chunk list, not repeated Buffer.concat of whole buffer.
 */
function createPcmAccumulator() {
  const chunks = [];
  let total = 0;
  return {
    get length() {
      return total;
    },
    push(buf) {
      if (!buf || !buf.length) return;
      chunks.push(buf);
      total += buf.length;
    },
    /** Take first n bytes; leave remainder. */
    take(n) {
      if (n <= 0) return Buffer.alloc(0);
      if (n >= total) {
        const all = Buffer.concat(chunks, total);
        chunks.length = 0;
        total = 0;
        return all;
      }
      const out = Buffer.alloc(n);
      let filled = 0;
      while (filled < n && chunks.length) {
        const c = chunks[0];
        const need = n - filled;
        if (c.length <= need) {
          c.copy(out, filled);
          filled += c.length;
          total -= c.length;
          chunks.shift();
        } else {
          c.copy(out, filled, 0, need);
          chunks[0] = c.subarray(need);
          total -= need;
          filled += need;
        }
      }
      return out;
    },
    clear() {
      chunks.length = 0;
      total = 0;
    }
  };
}

function assertSegmentPreflight(wavBytes, durationSeconds, limits = QWEN_NO_BUCKET) {
  const dur = Number(durationSeconds);
  if (dur > limits.hardSegmentSeconds || dur > limits.documentedMaxDurationSeconds) {
    const error = new Error(
      `segment duration ${dur.toFixed(2)}s exceeds hard limit ${limits.hardSegmentSeconds}s (Qwen Base64 max 300s; effective PCM cap ~${EFFECTIVE_PCM_DURATION_CAP_SECONDS}s from 10 MiB Base64)`
    );
    error.code = "segment_duration_exceeded";
    throw error;
  }
  const uriChars = estimateDataUriChars(wavBytes);
  if (uriChars > limits.maxDataUriChars || uriChars > limits.maxBase64Chars + 64) {
    const error = new Error(
      `segment data URI ~${uriChars} chars exceeds ${limits.maxBase64Chars} Base64 budget (10 MiB; ~${EFFECTIVE_PCM_DURATION_CAP_SECONDS}s PCM @16k mono before network)`
    );
    error.code = "segment_size_exceeded";
    throw error;
  }
  return { uriChars, durationSeconds: dur };
}

async function prepareTrackSegments({
  wavPath,
  sidecarPath = null,
  sidecar = null,
  track,
  role = null,
  outputDir,
  targetSegmentSeconds = QWEN_NO_BUCKET.targetSegmentSeconds,
  targetSampleRate = QWEN_NO_BUCKET.targetSampleRate,
  limits = QWEN_NO_BUCKET
} = {}) {
  if (!wavPath) {
    const error = new Error("wavPath required");
    error.code = "invalid_argument";
    throw error;
  }
  if (!track) {
    const error = new Error("track required");
    error.code = "invalid_argument";
    throw error;
  }
  if (!outputDir) {
    const error = new Error("outputDir required");
    error.code = "invalid_argument";
    throw error;
  }

  await ensureDir(outputDir);
  const wavInfo = await parseWavHeader(wavPath);
  let meta = sidecar;
  if (!meta && sidecarPath) {
    meta = JSON.parse(await fsp.readFile(sidecarPath, "utf8"));
  }
  if (!meta) {
    const error = new Error("sidecar required for session time mapping");
    error.code = "sidecar_missing";
    throw error;
  }

  const sourceSha = await sha256File(wavPath);
  const targetFramesPerSeg = Math.max(1, Math.floor(targetSampleRate * targetSegmentSeconds));
  const resampler = createLinearPcm16Resampler(wavInfo.sampleRate, targetSampleRate);
  const acc = createPcmAccumulator();

  const segments = [];
  let segIndex = 0;
  let sourceFrameCursor = 0;
  let outFrameCursor = 0;
  let segSourceFrameStart = 0;

  async function publishSegment(pcmBuf, sourceFrameStart, sourceFrameEnd, outFrameStart, outFrameEnd) {
    if (!pcmBuf.length) return null;
    const durationSeconds = pcmBuf.length / 2 / targetSampleRate;
    const header = buildMonoPcm16WavHeader(pcmBuf.length, targetSampleRate);
    const totalBytes = header.length + pcmBuf.length;
    assertSegmentPreflight(totalBytes, durationSeconds, limits);

    const seq = segIndex;
    const base = `${String(track).replace(/[^a-zA-Z0-9._-]/g, "_")}_seg_${String(seq).padStart(4, "0")}`;
    const wavOut = path.join(outputDir, `${base}.wav`);
    const metaOut = path.join(outputDir, `${base}.json`);

    const artifactBeginMs = wavInfo.sampleRate > 0 ? (sourceFrameStart / wavInfo.sampleRate) * 1000 : 0;
    const artifactEndMs = wavInfo.sampleRate > 0 ? (sourceFrameEnd / wavInfo.sampleRate) * 1000 : 0;
    const mapped = mapArtifactTimeRange(meta, artifactBeginMs, artifactEndMs);

    try {
      const existingMeta = JSON.parse(await fsp.readFile(metaOut, "utf8"));
      if (
        existingMeta.sourceWavSha256 === sourceSha &&
        existingMeta.outputFrames === pcmBuf.length / 2 &&
        existingMeta.artifactBeginMs === artifactBeginMs &&
        existingMeta.artifactEndMs === artifactEndMs
      ) {
        const existingSha = await sha256File(wavOut).catch(() => null);
        if (existingSha && existingSha === existingMeta.contentSha256) {
          segIndex += 1;
          return { ...existingMeta, reused: true, wavPath: wavOut, metaPath: metaOut };
        }
      }
    } catch {
      // write fresh
    }

    const partSuffix = makePartSuffix();
    const wavPart = `${wavOut}.${partSuffix}.part`;
    const metaPart = `${metaOut}.${partSuffix}.part`;
    const fh = await fsp.open(wavPart, "w");
    try {
      await writeAll(fh, header, 0);
      await writeAll(fh, pcmBuf, header.length);
    } catch (error) {
      try {
        await fh.close();
      } catch {
        // keep part
      }
      error.wavPartPath = wavPart;
      throw error;
    }
    await fh.close();
    const contentSha256 = await sha256File(wavPart);

    const segmentMeta = {
      schema: "meeting_qwen_segment_v1",
      track,
      role,
      seq,
      sourceWavPath: path.resolve(wavPath),
      sourceWavSha256: sourceSha,
      sourceSampleRate: wavInfo.sampleRate,
      sourceFrameStart,
      sourceFrameEnd,
      artifactBeginMs,
      artifactEndMs,
      sessionBeginMs: mapped.sessionBeginMs,
      sessionEndMs: mapped.sessionEndMs,
      qpcBegin: mapped.qpcBegin,
      qpcEnd: mapped.qpcEnd,
      sessionOriginQpc: mapped.sessionOriginQpc ?? meta.sessionOriginQpc ?? null,
      qpcFrequency: mapped.qpcFrequency ?? meta.qpcFrequency ?? null,
      outputSampleRate: targetSampleRate,
      outputFrames: pcmBuf.length / 2,
      outputBytes: totalBytes,
      durationSeconds,
      contentSha256,
      dataUriCharEstimate: estimateDataUriChars(totalBytes),
      timestampPrecision: limits.timestampPrecision || "segment",
      provider: limits.provider || "qwen3-asr",
      mode: "no_bucket"
    };

    await fsp.writeFile(metaPart, `${JSON.stringify(segmentMeta, null, 2)}\n`, "utf8");
    await fsp.rename(wavPart, wavOut);
    await fsp.rename(metaPart, metaOut);
    segIndex += 1;
    return { ...segmentMeta, reused: false, wavPath: wavOut, metaPath: metaOut };
  }

  const srcFh = await fsp.open(wavInfo.path, "r");
  try {
    while (sourceFrameCursor < wavInfo.frameCount) {
      const end = Math.min(wavInfo.frameCount, sourceFrameCursor + READ_FRAMES);
      const pcmIn = await readPcm16Frames(wavInfo, sourceFrameCursor, end, srcFh);
      const pcmOut = resampler.push(pcmIn);
      sourceFrameCursor = end;
      acc.push(pcmOut);

      while (acc.length / 2 >= targetFramesPerSeg) {
        const takeBytes = targetFramesPerSeg * 2;
        const slice = acc.take(takeBytes);
        const outStart = outFrameCursor;
        const outEnd = outFrameCursor + targetFramesPerSeg;
        outFrameCursor = outEnd;
        const srcStart = segSourceFrameStart;
        const srcEndApprox = Math.min(
          wavInfo.frameCount,
          Math.round((outEnd / targetSampleRate) * wavInfo.sampleRate)
        );
        const published = await publishSegment(slice, srcStart, srcEndApprox, outStart, outEnd);
        if (published) segments.push(published);
        segSourceFrameStart = srcEndApprox;
      }
    }
  } finally {
    await srcFh.close();
  }

  const tail = resampler.flush();
  if (tail.length) acc.push(tail);
  if (acc.length >= 2) {
    const frames = Math.floor(acc.length / 2);
    const slice = acc.take(frames * 2);
    const outStart = outFrameCursor;
    const outEnd = outFrameCursor + frames;
    const published = await publishSegment(
      slice,
      segSourceFrameStart,
      wavInfo.frameCount,
      outStart,
      outEnd
    );
    if (published) segments.push(published);
  }
  acc.clear();

  return {
    ok: true,
    track,
    role,
    sourceWavSha256: sourceSha,
    sourceSampleRate: wavInfo.sampleRate,
    targetSampleRate,
    segmentCount: segments.length,
    segments,
    targetSegmentSeconds
  };
}

async function segmentToDataUrl(segmentWavPath, limits = QWEN_NO_BUCKET) {
  const info = await parseWavHeader(segmentWavPath);
  const buf = await fsp.readFile(segmentWavPath);
  const durationSeconds = info.durationMs / 1000;
  assertSegmentPreflight(buf.length, durationSeconds, limits);
  const b64 = buf.toString("base64");
  const uri = `data:audio/wav;base64,${b64}`;
  if (uri.length > limits.maxDataUriChars) {
    const error = new Error(`data URI length ${uri.length} exceeds limit`);
    error.code = "segment_size_exceeded";
    throw error;
  }
  return { audioDataUrl: uri, byteLength: buf.length, base64Length: b64.length, durationSeconds };
}

module.exports = {
  prepareTrackSegments,
  segmentToDataUrl,
  assertSegmentPreflight,
  estimateDataUriChars,
  sha256File,
  createPcmAccumulator,
  EFFECTIVE_PCM_DURATION_CAP_SECONDS,
  MIB
};
