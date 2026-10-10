"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { parseWavHeader, readPcm16Frames, buildMonoPcm16WavHeader } = require("./wav-reader");
const { createLinearPcm16Resampler } = require("./resample");
const { mapArtifactTimeRange } = require("../archive/export-track-wav");
const { QWEN_NO_BUCKET, MIB } = require("./constants");
const { writeJsonAtomic } = require("./job-store");
const { choosePauseFrame } = require("../audio-boundaries");

const READ_FRAMES = 16 * 1024;

const EFFECTIVE_PCM_DURATION_CAP_SECONDS = QWEN_NO_BUCKET.effectivePcmDurationCapSeconds;

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

function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
}

async function sha256File(filePath, signal) {
  const fh = await fsp.open(filePath, "r");
  const hash = crypto.createHash("sha256");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    for (;;) {
      throwIfAborted(signal);
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
  return "data:audio/wav;base64,".length + b64;
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
    peek(n = total) {
      const size = Math.min(n, total);
      const out = Buffer.alloc(size);
      let offset = 0;
      for (const chunk of chunks) {
        offset += chunk.copy(out, offset, 0, Math.min(chunk.length, size - offset));
        if (offset === size) break;
      }
      return out;
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
  if (dur > limits.hardSegmentSeconds || (limits.documentedMaxDurationSeconds > 0 && dur > limits.documentedMaxDurationSeconds)) {
    const error = new Error(
      `${limits.provider} segment duration ${dur.toFixed(2)}s exceeds upload duration budget`
    );
    error.code = "segment_duration_exceeded";
    throw error;
  }
  const uriChars = estimateDataUriChars(wavBytes);
  if (uriChars > limits.maxDataUriChars || Math.ceil(wavBytes / 3) * 4 > limits.maxBase64Chars) {
    const error = new Error(
      `${limits.provider} segment data URI ~${uriChars} chars exceeds ${limits.maxBase64Chars} Base64 budget`
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
  limits = QWEN_NO_BUCKET,
  signal = null
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

  const sourceSha = await sha256File(wavPath, signal);
  const byteCap = Math.floor(Math.min(limits.maxBase64Chars, limits.maxDataUriChars - 64) / 4) * 3;
  const hardFrames = Math.floor(Math.min(limits.hardSegmentSeconds,
    limits.documentedMaxDurationSeconds > 0 ? limits.documentedMaxDurationSeconds : Infinity,
    (byteCap - 44) / 2 / targetSampleRate) * targetSampleRate);
  if (hardFrames < 1) throw Object.assign(new Error("ASR upload budget is too small."), { code: "segment_size_exceeded" });
  const targetFramesPerSeg = Math.max(1, Math.min(hardFrames, Math.floor(targetSampleRate * targetSegmentSeconds)));
  const searchFrames = Math.floor(targetSampleRate * Math.min(limits.pauseSearchSeconds || 0, targetSegmentSeconds * 0.1));
  const lookaheadFrames = Math.min(hardFrames, targetFramesPerSeg + Math.floor(targetSampleRate * Math.min(limits.pauseLookaheadSeconds || 0, targetSegmentSeconds * 0.045)));
  const resampler = createLinearPcm16Resampler(wavInfo.sampleRate, targetSampleRate);
  const acc = createPcmAccumulator();

  const segments = [];
  let segIndex = 0;
  let sourceFrameCursor = 0;
  let outFrameCursor = 0;
  let segSourceFrameStart = 0;

  async function publishSegment(pcmBuf, sourceFrameStart, sourceFrameEnd, outFrameStart, outFrameEnd) {
    throwIfAborted(signal);
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
      sourceTimeMapping: {
        sessionOriginQpc: meta.sessionOriginQpc ?? null,
        qpcFrequency: meta.qpcFrequency ?? null,
        chunks: (meta.chunks || []).filter(c => c.endMs >= artifactBeginMs && c.beginMs <= artifactEndMs)
          .map(c => ({ seq: c.seq, beginMs: c.beginMs, endMs: c.endMs, qpcStart: c.qpcStart, qpcFrequency: c.qpcFrequency }))
      },
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
      throwIfAborted(signal);
      const end = Math.min(wavInfo.frameCount, sourceFrameCursor + READ_FRAMES);
      const pcmIn = await readPcm16Frames(wavInfo, sourceFrameCursor, end, srcFh);
      const pcmOut = resampler.push(pcmIn);
      sourceFrameCursor = end;
      acc.push(pcmOut);

      while (acc.length / 2 >= lookaheadFrames) {
        const cutFrames = choosePauseFrame(acc.peek(lookaheadFrames * 2), targetSampleRate, targetFramesPerSeg,
          Math.max(1, targetFramesPerSeg - searchFrames), lookaheadFrames);
        const takeBytes = cutFrames * 2;
        const slice = acc.take(takeBytes);
        const outStart = outFrameCursor;
        const outEnd = outFrameCursor + cutFrames;
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
  while (acc.length / 2 > hardFrames) {
    const cutFrames = choosePauseFrame(acc.peek(hardFrames * 2), targetSampleRate, targetFramesPerSeg,
      Math.max(1, targetFramesPerSeg - searchFrames), hardFrames);
    const outEnd = outFrameCursor + cutFrames;
    const srcEnd = Math.min(wavInfo.frameCount, Math.round(outEnd / targetSampleRate * wavInfo.sampleRate));
    const published = await publishSegment(acc.take(cutFrames * 2), segSourceFrameStart, srcEnd, outFrameCursor, outEnd);
    if (published) segments.push(published);
    outFrameCursor = outEnd;
    segSourceFrameStart = srcEnd;
  }
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

async function splitPreparedSegment(segment, { outputDir, nextSeq, limits = QWEN_NO_BUCKET, signal } = {}) {
  throwIfAborted(signal);
  const info = await parseWavHeader(segment.wavPath);
  const parentMeta = JSON.parse(await fsp.readFile(segment.metaPath, "utf8"));
  let sourceTimeMapping = parentMeta.sourceTimeMapping;
  if (!sourceTimeMapping && parentMeta.sourceWavPath) {
    // Old plans retain their original archive sidecar; prefer it over interpolating across recording pauses.
    sourceTimeMapping = await fsp.readFile(`${parentMeta.sourceWavPath}.sidecar.json`, "utf8")
      .then(JSON.parse).catch(() => null);
  }
  const minFrames = Math.ceil(info.sampleRate * (limits.minSplitSeconds || 5));
  if (info.frameCount < minFrames * 2 || (segment.splitDepth || 0) >= (limits.maxSplitDepth || 6)) return null;
  await ensureDir(outputDir);
  const pcm = await readPcm16Frames(info, 0, info.frameCount);
  if (pcm.length !== info.frameCount * 2) throw Object.assign(new Error("Segment audio is incomplete."), { code: "segment_audio_incomplete" });
  const middle = Math.floor(info.frameCount / 2);
  const range = Math.min(Math.floor(info.sampleRate * 8), middle - minFrames);
  const cut = choosePauseFrame(pcm, info.sampleRate, middle, middle - range, middle + range);
  const children = [];
  function map(valueStart, valueEnd, frame) {
    return valueStart == null || valueEnd == null ? null : valueStart + (valueEnd - valueStart) * frame / info.frameCount;
  }
  for (const [index, start, end] of [[0, 0, cut], [1, cut, info.frameCount]]) {
    throwIfAborted(signal);
    const seq = nextSeq + index;
    const wavPath = path.join(outputDir, `${segment.track || "audio"}_seg_${String(seq).padStart(4, "0")}.wav`);
    const metaPath = wavPath.replace(/\.wav$/, ".json");
    const data = pcm.subarray(start * 2, end * 2);
    const bytes = Buffer.concat([buildMonoPcm16WavHeader(data.length, info.sampleRate), data]);
    assertSegmentPreflight(bytes.length, (end - start) / info.sampleRate, limits);
    const part = `${wavPath}.${makePartSuffix()}.part`;
    await fsp.writeFile(part, bytes);
    await fsp.rename(part, wavPath);
    const child = { ...segment, seq, wavPath, metaPath,
      contentSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      durationSeconds: (end - start) / info.sampleRate,
      splitDepth: (segment.splitDepth || 0) + 1, parentSeq: segment.seq,
      attempts: 0, status: "pending", hasResult: false, lastError: null };
    for (const prefix of ["artifact", "session", "qpc"]) {
      const a = prefix === "qpc" ? "qpcBegin" : `${prefix}BeginMs`;
      const b = prefix === "qpc" ? "qpcEnd" : `${prefix}EndMs`;
      child[a] = map(segment[a], segment[b], start);
      child[b] = map(segment[a], segment[b], end);
    }
    if (sourceTimeMapping) {
      const mapped = mapArtifactTimeRange(sourceTimeMapping, child.artifactBeginMs, child.artifactEndMs);
      for (const field of ["sessionBeginMs", "sessionEndMs", "qpcBegin", "qpcEnd"]) child[field] = mapped[field];
    }
    await writeJsonAtomic(metaPath, { ...child, sourceTimeMapping });
    children.push(child);
  }
  return children;
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
  choosePauseFrame,
  splitPreparedSegment,
  EFFECTIVE_PCM_DURATION_CAP_SECONDS,
  MIB
};
