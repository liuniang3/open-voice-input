"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { resolveL0SampleEncoding } = require("./l0-format");

const ARTIFACT_SCHEMA = "meeting_archive_wav_v1";
const SIDECAR_SCHEMA = "meeting_archive_sidecar_v1";
const READ_CHUNK_BYTES = 64 * 1024;
/** WAV RIFF chunk size is uint32; file size = riffSize + 8 */
const MAX_WAV_DATA_BYTES = 0xffffffff - 36;

/**
 * Pause-hole policy (Stage 1A):
 * - Journal pause holes are recorded explicitly in the sidecar `gaps[]`.
 * - WAV output is a continuous concatenation of committed L0 frames only.
 * - We do NOT insert invented speech. We also do NOT insert silence frames into
 *   the WAV for pause holes (device timeline already omits discarded pause frames).
 * - Consumers must use sidecar gaps + shared session QPC mapping; do not treat
 *   WAV as wall-clock continuous across pause.
 */
const PAUSE_HOLE_POLICY = Object.freeze({
  id: "explicit_metadata_no_wav_silence",
  insertSilenceInWav: false,
  inventSpeech: false,
  note:
    "Pause holes appear only in sidecar.gaps from journal; WAV is sealed-frame concatenation without bridging."
});

/**
 * QPC mapping policy: capture index qpcStart/qpcEnd are point samples, not
 * frame-interpolated ends. Artifact ms → QPC uses:
 *   qpc ≈ qpcStart + round((artifactMs - chunk.beginMs) / 1000 * qpcFrequency)
 * anchored on the containing chunk's qpcStart (begin and end independently).
 */
const QPC_MAPPING_POLICY = Object.freeze({
  id: "qpc_start_plus_sample_offset",
  interpolatesQpcStartEnd: false,
  note:
    "Do not linearly blend qpcStart..qpcEnd; offset from qpcStart by output sample time via qpcFrequency."
});

function makePartSuffix() {
  const rand = crypto.randomBytes(4).toString("hex");
  return `${process.pid}.${Date.now()}.${rand}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function clampInt16(n) {
  if (n > 32767) return 32767;
  if (n < -32768) return -32768;
  return n | 0;
}

/** FileHandle.write may be partial; loop until all bytes are written. */
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
  return offset;
}

function assertWavDataSize(dataBytes) {
  const n = Number(dataBytes);
  if (!Number.isFinite(n) || n < 0) {
    const error = new Error(`invalid WAV data size: ${dataBytes}`);
    error.code = "wav_size_invalid";
    throw error;
  }
  if (n > MAX_WAV_DATA_BYTES) {
    const error = new Error(
      `WAV data exceeds RIFF uint32 limit (${n} > ${MAX_WAV_DATA_BYTES}). Split the track before archive export.`
    );
    error.code = "wav_riff_overflow";
    throw error;
  }
}

/**
 * Downmix interleaved PCM16 or float32 to mono PCM16 with clipping.
 * Processes whole frames only; trailing partial frame bytes are dropped.
 */
function downmixInterleavedToMonoPcm16(input, encoding) {
  const { kind, channels, blockAlign } = encoding;
  const frameCount = Math.floor(input.length / blockAlign);
  if (frameCount <= 0) return Buffer.alloc(0);

  const out = Buffer.alloc(frameCount * 2);
  if (kind === "pcm16") {
    for (let f = 0; f < frameCount; f += 1) {
      let sum = 0;
      const base = f * blockAlign;
      for (let c = 0; c < channels; c += 1) {
        sum += input.readInt16LE(base + c * 2);
      }
      const avg = Math.round(sum / channels);
      out.writeInt16LE(clampInt16(avg), f * 2);
    }
    return out;
  }

  for (let f = 0; f < frameCount; f += 1) {
    let sum = 0;
    const base = f * blockAlign;
    for (let c = 0; c < channels; c += 1) {
      sum += input.readFloatLE(base + c * 4);
    }
    const avg = sum / channels;
    const clipped = Math.max(-1, Math.min(1, avg));
    const sample = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
    out.writeInt16LE(clampInt16(Math.round(sample)), f * 2);
  }
  return out;
}

function buildWavHeader(dataBytes, sampleRate, channels = 1, bitsPerSample = 16) {
  assertWavDataSize(dataBytes);
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function indexEntriesBySeq(indexEntries) {
  const map = new Map();
  for (const entry of indexEntries || []) {
    if (!entry || entry.seq == null) continue;
    map.set(Number(entry.seq), entry);
  }
  return map;
}

function encodingsCompatible(a, b) {
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.sampleRate === b.sampleRate &&
    a.channels === b.channels &&
    a.bitsPerSample === b.bitsPerSample &&
    a.blockAlign === b.blockAlign
  );
}

function pickEventQpc(...candidates) {
  for (const v of candidates) {
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function unwrapHolePayload(obj) {
  // Rust pause: { t, kind:"hole", detail:{ reason:"pause_begin|pause_end", detail:{ holeQpc, pauseGen, ... }, track, role, at } }
  // Rust discontinuity: { kind:"hole", detail:{ reason:"discontinuity", detail:{ qpc, qpcFrequency, sessionOriginQpc, ... }, track, role } }
  // Legacy: { op|event|type:"hole", reason, detail:{ holeQpc }, track, ... }
  if (!obj || typeof obj !== "object") return null;

  const isRustHole = obj.kind === "hole";
  const isLegacyHole =
    obj.op === "hole" || obj.event === "hole" || obj.type === "hole" || obj.reason === "pause";
  if (!isRustHole && !isLegacyHole) return null;

  const outer = isRustHole ? obj.detail || {} : obj;
  const nested =
    outer.detail && typeof outer.detail === "object" && !Array.isArray(outer.detail)
      ? outer.detail
      : {};
  // Prefer nested timing object when it carries any QPC-related field (incl. plain `qpc`).
  const nestedHasTiming =
    nested.holeQpc != null ||
    nested.sharedHoleQpc != null ||
    nested.qpc != null ||
    nested.pauseGen != null ||
    nested.sessionOriginQpc != null ||
    nested.qpcFrequency != null;
  const timing = nestedHasTiming
    ? nested
    : outer.detail && typeof outer.detail === "object"
      ? outer.detail
      : outer;

  const reason = String(outer.reason || nested.reason || obj.reason || "pause");
  // holeQpc first (pause), then sharedHoleQpc, then plain qpc (discontinuity / point events)
  const holeQpc = pickEventQpc(
    timing.holeQpc,
    timing.sharedHoleQpc,
    timing.qpc,
    outer.holeQpc,
    outer.qpc,
    obj.holeQpc,
    obj.qpc
  );
  return {
    reason,
    holeQpc,
    pauseGen: timing.pauseGen ?? outer.pauseGen ?? null,
    sessionOriginQpc: timing.sessionOriginQpc ?? outer.sessionOriginQpc ?? null,
    qpcFrequency: timing.qpcFrequency ?? outer.qpcFrequency ?? null,
    discardedFrames: timing.discardedFrames ?? outer.discardedFrames ?? 0,
    track: outer.track || nested.track || obj.track || null,
    role: outer.role || nested.role || obj.role || null,
    at: outer.at || nested.at || obj.at || obj.t || null,
    raw: obj
  };
}

/**
 * Normalize journal hole records into gap intervals.
 * Pairs pause_begin + pause_end with the same pauseGen when possible.
 * Non-pause reasons (e.g. discontinuity) become phase="point" and never pair with pause.
 * Tolerates unmatched begin/end and legacy single-shot hole markers.
 */
function parseJournalGapsFromEntries(entries) {
  const events = [];
  for (const obj of entries || []) {
    const payload = unwrapHolePayload(obj);
    if (payload) events.push(payload);
  }

  const gaps = [];
  const openByGen = new Map();
  let synthetic = 0;

  function openKey(ev) {
    if (ev.pauseGen != null && Number.isFinite(Number(ev.pauseGen))) {
      return `g:${Number(ev.pauseGen)}`;
    }
    return `t:${ev.track || ""}:${synthetic++}`;
  }

  for (const ev of events) {
    const reason = String(ev.reason || "");
    if (reason === "pause_begin" || reason === "pause") {
      const key =
        ev.pauseGen != null && Number.isFinite(Number(ev.pauseGen))
          ? `g:${Number(ev.pauseGen)}`
          : openKey(ev);
      openByGen.set(key, ev);
      continue;
    }
    if (reason === "pause_end") {
      const key =
        ev.pauseGen != null && Number.isFinite(Number(ev.pauseGen))
          ? `g:${Number(ev.pauseGen)}`
          : null;
      let begin = key && openByGen.has(key) ? openByGen.get(key) : null;
      if (begin && key) openByGen.delete(key);
      // Only pair with an open pause_begin — never with discontinuity/point events
      if (!begin && openByGen.size === 1) {
        const onlyKey = openByGen.keys().next().value;
        const candidate = openByGen.get(onlyKey);
        const candReason = String(candidate?.reason || "");
        if (candReason === "pause_begin" || candReason === "pause") {
          begin = candidate;
          openByGen.delete(onlyKey);
        }
      }
      gaps.push(buildGapInterval(begin, ev));
      continue;
    }
    // Non-pause hole (discontinuity, etc.): explicit point gap, never enters pause pairing
    gaps.push(buildPointGap(ev));
  }

  for (const begin of openByGen.values()) {
    gaps.push(buildGapInterval(begin, null));
  }

  return gaps;
}

function buildPointGap(ev) {
  const qpc = ev?.holeQpc ?? null;
  return {
    reason: ev?.reason || "hole",
    phase: "point",
    qpcBegin: qpc,
    qpcEnd: qpc,
    holeQpc: qpc,
    pauseGen: null,
    discardedFrames: Number(ev?.discardedFrames ?? 0) || 0,
    sessionOriginQpc: ev?.sessionOriginQpc ?? null,
    qpcFrequency: ev?.qpcFrequency ?? null,
    track: ev?.track ?? null,
    role: ev?.role ?? null,
    atBegin: ev?.at ?? null,
    atEnd: ev?.at ?? null
  };
}

function buildGapInterval(beginEv, endEv) {
  const begin = beginEv || endEv || {};
  const end = endEv || null;
  const qpcBegin = beginEv?.holeQpc ?? null;
  const qpcEnd = endEv?.holeQpc ?? null;
  return {
    reason: endEv && beginEv ? "pause" : begin.reason || "pause",
    phase: endEv && beginEv ? "interval" : beginEv ? "begin_only" : endEv ? "end_only" : "point",
    qpcBegin,
    qpcEnd,
    holeQpc: qpcBegin ?? qpcEnd,
    pauseGen: beginEv?.pauseGen ?? endEv?.pauseGen ?? null,
    discardedFrames: Number(endEv?.discardedFrames ?? beginEv?.discardedFrames ?? 0) || 0,
    sessionOriginQpc: beginEv?.sessionOriginQpc ?? endEv?.sessionOriginQpc ?? null,
    qpcFrequency: beginEv?.qpcFrequency ?? endEv?.qpcFrequency ?? null,
    track: beginEv?.track ?? endEv?.track ?? null,
    role: beginEv?.role ?? endEv?.role ?? null,
    atBegin: beginEv?.at ?? null,
    atEnd: endEv?.at ?? null
  };
}

async function readJournalEntries(trackDir) {
  const journalPath = path.join(trackDir, "journal.jsonl");
  let raw = "";
  try {
    raw = await fsp.readFile(journalPath, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      entries.push(JSON.parse(t));
    } catch {
      // tolerate tail corruption
    }
  }
  return entries;
}

function qpcToMs(qpcDelta, qpcFrequency) {
  const freq = Number(qpcFrequency);
  if (!Number.isFinite(freq) || freq <= 0) return null;
  const d = Number(qpcDelta);
  if (!Number.isFinite(d)) return null;
  return (d / freq) * 1000;
}

function sessionMsFromQpc(qpc, sessionOriginQpc, qpcFrequency) {
  if (qpc == null || sessionOriginQpc == null) return null;
  return qpcToMs(Number(qpc) - Number(sessionOriginQpc), qpcFrequency);
}

/**
 * Edge-aware chunk selection after compacted pauses.
 * @param {"begin"|"end"} edge
 * - begin: half-open [beginMs, endMs) — exact endMs boundary belongs to the *next* chunk
 * - end:   (beginMs, endMs] — exact beginMs of next chunk as end stays on *previous* chunk
 * Clamp only outside the overall artifact range.
 */
function findChunkForArtifactMs(chunks, ms, edge = "begin") {
  if (!Number.isFinite(ms) || !chunks?.length) return null;
  const sorted = [...chunks].filter((c) => Number.isFinite(Number(c.beginMs)) && Number.isFinite(Number(c.endMs)));
  if (!sorted.length) return null;
  sorted.sort((a, b) => Number(a.beginMs) - Number(b.beginMs) || Number(a.endMs) - Number(b.endMs));

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const rangeBegin = Number(first.beginMs);
  const rangeEnd = Number(last.endMs);

  if (ms < rangeBegin) return first;
  if (ms > rangeEnd) return last;

  if (edge === "end") {
    // Prefer previous chunk on exact shared boundary (ms === chunk.endMs === next.beginMs)
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const c = sorted[i];
      const cb = Number(c.beginMs);
      const ce = Number(c.endMs);
      if (ms > cb && ms <= ce) return c;
      if (ms === cb && i === 0) return c;
    }
    // exact rangeBegin only
    if (ms === rangeBegin) return first;
  } else {
    // begin edge: [begin, end) — boundary ms === ce goes to next chunk
    for (let i = 0; i < sorted.length; i += 1) {
      const c = sorted[i];
      const cb = Number(c.beginMs);
      const ce = Number(c.endMs);
      if (ms >= cb && ms < ce) return c;
      // final chunk includes its endMs so a point at EOF still maps
      if (i === sorted.length - 1 && ms === ce) return c;
    }
  }

  // fallback nearest (should be rare)
  let best = sorted[0];
  let bestDist = Infinity;
  for (const c of sorted) {
    const cb = Number(c.beginMs);
    const ce = Number(c.endMs);
    const dist = ms < cb ? cb - ms : ms > ce ? ms - ce : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

/**
 * Map artifact-relative ms to shared session QPC using containing chunk qpcStart
 * + sample-time offset (not qpcStart..qpcEnd linear blend).
 */
function artifactMsToQpc(ms, chunk, sidecar) {
  if (!Number.isFinite(ms)) return null;
  const freq = Number(chunk?.qpcFrequency ?? sidecar?.qpcFrequency);
  const qpcStart = chunk?.qpcStart;
  const beginMs = Number(chunk?.beginMs);
  if (qpcStart == null || !Number.isFinite(freq) || freq <= 0 || !Number.isFinite(beginMs)) {
    const origin = sidecar?.sessionOriginQpc;
    if (origin == null || !Number.isFinite(freq) || freq <= 0) return null;
    return Math.round(Number(origin) + (ms / 1000) * freq);
  }
  const deltaMs = ms - beginMs;
  return Math.round(Number(qpcStart) + (deltaMs / 1000) * freq);
}

function gapsOverlappingQpc(gaps, qpcBegin, qpcEnd) {
  const list = gaps || [];
  if (qpcBegin == null && qpcEnd == null) return [];
  const lo = qpcBegin != null ? Number(qpcBegin) : Number(qpcEnd);
  const hi = qpcEnd != null ? Number(qpcEnd) : Number(qpcBegin);
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return [];
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return list.filter((g) => {
    const g0 = g.qpcBegin != null ? Number(g.qpcBegin) : g.holeQpc != null ? Number(g.holeQpc) : null;
    const g1 = g.qpcEnd != null ? Number(g.qpcEnd) : g0;
    if (g0 == null || !Number.isFinite(g0)) return false;
    const gb = Number.isFinite(g1) ? Math.min(g0, g1) : g0;
    const ge = Number.isFinite(g1) ? Math.max(g0, g1) : g0;
    // closed interval overlap
    return gb <= b && ge >= a;
  });
}

/**
 * Stream committed L0 chunks for one track into mono PCM16 WAV + sidecar.
 * Idempotent: completed artifact+sidecar is left intact; re-run overwrites via temp+rename.
 * On failure, `.part` files are kept for diagnosis (not deleted).
 * Note: WAV rename then sidecar rename is not a single two-file atomic commit;
 * sidecar.contentSha256 lets readers detect mismatched pairs.
 */
async function exportTrackArchive({
  trackDir,
  track = null,
  role = null,
  sessionId = null,
  outputDir = null,
  artifactBaseName = null,
  committed = null,
  indexEntries = null,
  manifest = null
} = {}) {
  if (!trackDir) {
    const error = new Error("trackDir is required");
    error.code = "invalid_argument";
    throw error;
  }

  const resolvedTrackDir = path.resolve(trackDir);
  const outDir = path.resolve(outputDir || path.join(resolvedTrackDir, "..", "..", "archive"));
  await ensureDir(outDir);

  let files = committed;
  if (!files) {
    const names = await fsp.readdir(resolvedTrackDir).catch(() => []);
    files = [];
    for (const name of names) {
      if (!/\.l0\.pcm$/i.test(name)) continue;
      const filePath = path.join(resolvedTrackDir, name);
      const st = await fsp.stat(filePath).catch(() => null);
      if (!st || !st.isFile()) continue;
      const seqMatch = name.match(/^(\d+)/);
      files.push({
        name,
        path: filePath,
        bytes: st.size,
        seq: seqMatch ? Number(seqMatch[1]) : null
      });
    }
    files.sort((a, b) => {
      if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq;
      return a.name.localeCompare(b.name);
    });
  }

  if (!files.length) {
    const error = new Error(`no committed L0 chunks in ${resolvedTrackDir}`);
    error.code = "no_committed_chunks";
    throw error;
  }

  let entries = indexEntries;
  if (!entries) {
    try {
      const raw = await fsp.readFile(path.join(resolvedTrackDir, "index.jsonl"), "utf8");
      entries = [];
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          entries.push(JSON.parse(t));
        } catch {
          break;
        }
      }
    } catch {
      entries = [];
    }
  }

  let man = manifest;
  if (!man) {
    try {
      man = JSON.parse(await fsp.readFile(path.join(resolvedTrackDir, "manifest.json"), "utf8"));
    } catch {
      man = null;
    }
  }

  // Derive track/role from manifest when caller omits them (never assume microphone for system).
  const resolvedTrack =
    track != null && String(track).trim() !== ""
      ? String(track)
      : man?.track || entries.find((e) => e && e.track)?.track || null;
  const resolvedRole =
    role != null && String(role).trim() !== ""
      ? String(role)
      : man?.role || entries.find((e) => e && e.role)?.role || null;

  if (!resolvedTrack) {
    const error = new Error(
      "track is required: pass track= or ensure manifest.json/index includes track (refusing default microphone)"
    );
    error.code = "track_required";
    throw error;
  }

  const base =
    artifactBaseName ||
    `${String(resolvedTrack).replace(/[^a-zA-Z0-9._-]/g, "_")}.mono`;
  const wavPath = path.join(outDir, `${base}.wav`);
  const sidecarPath = path.join(outDir, `${base}.wav.sidecar.json`);
  const partSuffix = makePartSuffix();
  const wavPartPath = `${wavPath}.${partSuffix}.part`;
  const sidecarPartPath = `${sidecarPath}.${partSuffix}.part`;

  const bySeq = indexEntriesBySeq(entries);
  const firstIndexed = entries.find((e) => e && e.format) || null;
  const formatSource =
    (man && man.actualL0Format) ||
    (firstIndexed && firstIndexed.format) ||
    (files[0] && bySeq.get(files[0].seq)?.format) ||
    null;

  const encoding = resolveL0SampleEncoding(formatSource);
  const journalEntries = await readJournalEntries(resolvedTrackDir);
  const gaps = parseJournalGapsFromEntries(journalEntries);

  const wavFd = await fsp.open(wavPartPath, "w");
  let dataBytes = 0;
  let outFrameCursor = 0;
  const chunkMaps = [];
  let sessionOriginQpc = null;
  let qpcFrequency = null;
  let wavFdClosed = false;

  try {
    await writeAll(wavFd, Buffer.alloc(44), 0);

    for (const file of files) {
      const idx = file.seq != null ? bySeq.get(Number(file.seq)) : null;
      if (idx?.format) {
        let chunkEnc;
        try {
          chunkEnc = resolveL0SampleEncoding(idx.format);
        } catch (error) {
          error.message = `chunk seq=${file.seq} format invalid: ${error.message}`;
          throw error;
        }
        if (!encodingsCompatible(encoding, chunkEnc)) {
          const error = new Error(
            `chunk seq=${file.seq} format incompatible with track manifest encoding`
          );
          error.code = "l0_format_mismatch";
          error.manifestEncoding = encoding;
          error.chunkEncoding = chunkEnc;
          throw error;
        }
      }

      const filePath = file.path || path.join(resolvedTrackDir, file.name);
      const st = await fsp.stat(filePath);
      const fileBytes = st.size;
      const alignedIn = Math.floor(fileBytes / encoding.blockAlign) * encoding.blockAlign;
      if (alignedIn <= 0) continue;

      if (idx) {
        if (sessionOriginQpc == null && idx.sessionOriginQpc != null) {
          sessionOriginQpc = idx.sessionOriginQpc;
        }
        if (qpcFrequency == null && idx.qpcFrequency != null) {
          qpcFrequency = idx.qpcFrequency;
        }
      }

      const outFrameStart = outFrameCursor;
      let offset = 0;
      const fh = await fsp.open(filePath, "r");
      try {
        const buf = Buffer.alloc(Math.min(READ_CHUNK_BYTES, alignedIn));
        while (offset < alignedIn) {
          const toRead = Math.min(buf.length, alignedIn - offset);
          const alignedRead = Math.floor(toRead / encoding.blockAlign) * encoding.blockAlign;
          if (alignedRead <= 0) break;
          const { bytesRead } = await fh.read(buf, 0, alignedRead, offset);
          if (bytesRead <= 0) break;
          const usable = Math.floor(bytesRead / encoding.blockAlign) * encoding.blockAlign;
          if (usable <= 0) break;
          const mono = downmixInterleavedToMonoPcm16(buf.subarray(0, usable), encoding);
          const nextData = dataBytes + mono.length;
          assertWavDataSize(nextData);
          await writeAll(wavFd, mono, 44 + dataBytes);
          dataBytes = nextData;
          outFrameCursor += mono.length / 2;
          offset += usable;
        }
      } finally {
        await fh.close();
      }

      const outFrameEnd = outFrameCursor;
      const sampleRate = encoding.sampleRate;
      chunkMaps.push({
        seq: file.seq,
        sourceFile: file.name,
        sourceBytes: fileBytes,
        sourceFrames: Math.floor(alignedIn / encoding.blockAlign),
        outFrameStart,
        outFrameEnd,
        outByteStart: outFrameStart * 2,
        outByteEnd: outFrameEnd * 2,
        beginMs: sampleRate > 0 ? (outFrameStart / sampleRate) * 1000 : null,
        endMs: sampleRate > 0 ? (outFrameEnd / sampleRate) * 1000 : null,
        devicePosStart: idx?.devicePosStart ?? null,
        devicePosEnd: idx?.devicePosEnd ?? null,
        qpcStart: idx?.qpcStart ?? null,
        qpcEnd: idx?.qpcEnd ?? null,
        sessionOriginQpc: idx?.sessionOriginQpc ?? sessionOriginQpc,
        qpcFrequency: idx?.qpcFrequency ?? qpcFrequency,
        silentFrames: idx?.silentFrames ?? 0,
        track: idx?.track || resolvedTrack,
        role: idx?.role || resolvedRole || null
      });
    }

    assertWavDataSize(dataBytes);
    const header = buildWavHeader(dataBytes, encoding.sampleRate, 1, 16);
    await writeAll(wavFd, header, 0);
    await wavFd.close();
    wavFdClosed = true;

    // Stream full-file SHA-256 (header + PCM) without buffering whole WAV
    const contentSha256 = await sha256File(wavPartPath);
    const durationMs =
      encoding.sampleRate > 0 ? (outFrameCursor / encoding.sampleRate) * 1000 : 0;

    // Canonical sidecar is deterministic for unchanged inputs (no createdAt).
    const sidecar = {
      schema: SIDECAR_SCHEMA,
      artifactSchema: ARTIFACT_SCHEMA,
      sessionId: sessionId || man?.sessionId || null,
      track: resolvedTrack,
      role: resolvedRole,
      sourceTrackDir: resolvedTrackDir,
      wavRelativeHint: path.basename(wavPath),
      contentSha256,
      commit: {
        orderedRename: ["wav", "sidecar"],
        twoFileAtomic: false,
        note:
          "WAV then sidecar rename is ordered but not a single multi-file atomic commit; verify contentSha256 against WAV bytes via verifyArchiveIntegrity."
      },
      pauseHolePolicy: PAUSE_HOLE_POLICY,
      qpcMappingPolicy: QPC_MAPPING_POLICY,
      inputFormat: {
        sampleRate: encoding.sampleRate,
        channels: encoding.channels,
        bitsPerSample: encoding.bitsPerSample,
        blockAlign: encoding.blockAlign,
        kind: encoding.kind,
        formatTag: encoding.formatTag,
        subFormat: encoding.subFormat
      },
      outputFormat: {
        sampleRate: encoding.sampleRate,
        channels: 1,
        bitsPerSample: 16,
        encoding: "s16le",
        container: "wav",
        layer: "archive_mono_pcm16"
      },
      sessionOriginQpc,
      qpcFrequency,
      totalOutFrames: outFrameCursor,
      totalOutBytes: dataBytes,
      durationMs,
      gaps,
      chunks: chunkMaps,
      mappingNotes: [
        "beginMs/endMs are relative to archive WAV timeline (concatenated sealed frames; pauses compacted out).",
        "Begin timestamps use half-open [chunk.beginMs, chunk.endMs); end timestamps use (beginMs, endMs].",
        "Shared timeline uses sessionBeginMs/sessionEndMs from QPC: (qpc - sessionOriginQpc) / qpcFrequency.",
        "QPC approximation: qpcStart + sample-time offset via qpcFrequency (qpcStart/qpcEnd are point samples).",
        "Pause holes are not filled with silence in WAV; see gaps[] and pauseHolePolicy.",
        "contentSha256 covers the complete WAV file bytes after header finalization.",
        "Canonical sidecar omits wall-clock timestamps for deterministic re-export."
      ]
    };

    await fsp.writeFile(sidecarPartPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
    await fsp.rename(wavPartPath, wavPath);
    await fsp.rename(sidecarPartPath, sidecarPath);

    return {
      ok: true,
      wavPath,
      sidecarPath,
      contentSha256,
      track: sidecar.track,
      role: sidecar.role,
      sampleRate: encoding.sampleRate,
      channels: 1,
      durationMs,
      totalOutFrames: outFrameCursor,
      dataBytes,
      chunkCount: chunkMaps.length,
      gapCount: gaps.length,
      pauseHolePolicy: PAUSE_HOLE_POLICY,
      qpcMappingPolicy: QPC_MAPPING_POLICY,
      encoding: encoding.kind,
      mono: true,
      exportedAt: new Date().toISOString()
    };
  } catch (error) {
    if (!wavFdClosed) {
      try {
        await wavFd.close();
      } catch {
        // ignore
      }
    }
    // Keep .part files for diagnosis/recovery — do not delete.
    error.wavPartPath = wavPartPath;
    error.sidecarPartPath = sidecarPartPath;
    throw error;
  }
}

async function sha256File(filePath) {
  const fh = await fsp.open(filePath, "r");
  const hash = crypto.createHash("sha256");
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
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

/**
 * Map a provider-relative time range (ms from WAV start) through sidecar chunks
 * onto shared session QPC / session ms.
 * Begin and end use separate edge-aware chunk selection.
 */
function mapArtifactTimeRange(sidecar, beginMs, endMs) {
  const b = Number(beginMs);
  const e = Number(endMs);
  const chunks = sidecar?.chunks || [];
  const origin = sidecar?.sessionOriginQpc ?? null;
  const freq = sidecar?.qpcFrequency ?? null;

  if (!Number.isFinite(b)) {
    return {
      artifactBeginMs: Number.isFinite(b) ? b : null,
      artifactEndMs: Number.isFinite(e) ? e : null,
      beginMs: Number.isFinite(b) ? b : null,
      endMs: Number.isFinite(e) ? e : null,
      sessionOriginQpc: origin,
      qpcFrequency: freq,
      qpcBegin: null,
      qpcEnd: null,
      sessionBeginMs: null,
      sessionEndMs: null,
      beginChunkSeq: null,
      endChunkSeq: null,
      coveringSeqs: [],
      gapsOverlapping: [],
      qpcMappingPolicy: QPC_MAPPING_POLICY
    };
  }

  const beginChunk = findChunkForArtifactMs(chunks, b, "begin");
  const endChunk = Number.isFinite(e) ? findChunkForArtifactMs(chunks, e, "end") : beginChunk;
  const qpcBegin = artifactMsToQpc(b, beginChunk, sidecar);
  const qpcEnd = Number.isFinite(e) ? artifactMsToQpc(e, endChunk, sidecar) : null;

  const covering = [];
  for (const c of [beginChunk, endChunk]) {
    if (c && !covering.some((x) => x.seq === c.seq)) covering.push(c);
  }
  for (const c of chunks) {
    const cb = Number(c.beginMs);
    const ce = Number(c.endMs);
    if (!Number.isFinite(cb) || !Number.isFinite(ce)) continue;
    if (Number.isFinite(e) && e <= cb) continue;
    if (b >= ce) continue;
    if (!covering.some((x) => x.seq === c.seq)) covering.push(c);
  }

  return {
    artifactBeginMs: b,
    artifactEndMs: Number.isFinite(e) ? e : null,
    beginMs: b,
    endMs: Number.isFinite(e) ? e : null,
    sessionOriginQpc: origin,
    qpcFrequency: freq,
    qpcBegin,
    qpcEnd,
    sessionBeginMs: sessionMsFromQpc(qpcBegin, origin, freq),
    sessionEndMs: sessionMsFromQpc(qpcEnd, origin, freq),
    beginChunkSeq: beginChunk?.seq ?? null,
    endChunkSeq: endChunk?.seq ?? null,
    coveringSeqs: covering.map((c) => c.seq).filter((s) => s != null),
    gapsOverlapping: gapsOverlappingQpc(sidecar?.gaps || [], qpcBegin, qpcEnd),
    qpcMappingPolicy: QPC_MAPPING_POLICY
  };
}

/**
 * Stream-verify WAV bytes against sidecar.contentSha256.
 * @param {{ wavPath: string, sidecarPath?: string, sidecar?: object }} args
 */
async function verifyArchiveIntegrity({ wavPath, sidecarPath = null, sidecar = null } = {}) {
  const wav = String(wavPath || "").trim();
  if (!wav) {
    const error = new Error("wavPath is required");
    error.code = "invalid_argument";
    throw error;
  }

  let meta = sidecar;
  if (!meta && sidecarPath) {
    try {
      meta = JSON.parse(await fsp.readFile(sidecarPath, "utf8"));
    } catch (error) {
      const err = new Error(`sidecar unreadable: ${error.message}`);
      err.code = "sidecar_unreadable";
      throw err;
    }
  }
  if (!meta || typeof meta !== "object") {
    const error = new Error("sidecar object or sidecarPath is required");
    error.code = "sidecar_missing";
    throw error;
  }
  const expected = String(meta.contentSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    const error = new Error("sidecar.contentSha256 missing or invalid");
    error.code = "content_sha256_missing";
    throw error;
  }

  let actual;
  try {
    actual = (await sha256File(wav)).toLowerCase();
  } catch (error) {
    const err = new Error(`wav unreadable: ${error.message}`);
    err.code = "wav_unreadable";
    throw err;
  }

  if (actual !== expected) {
    const error = new Error(
      `archive integrity mismatch: wav sha256 ${actual} != sidecar.contentSha256 ${expected}`
    );
    error.code = "content_sha256_mismatch";
    error.actual = actual;
    error.expected = expected;
    throw error;
  }

  return {
    ok: true,
    wavPath: wav,
    contentSha256: actual,
    track: meta.track || null,
    role: meta.role || null
  };
}

module.exports = {
  ARTIFACT_SCHEMA,
  SIDECAR_SCHEMA,
  PAUSE_HOLE_POLICY,
  QPC_MAPPING_POLICY,
  MAX_WAV_DATA_BYTES,
  exportTrackArchive,
  verifyArchiveIntegrity,
  downmixInterleavedToMonoPcm16,
  buildWavHeader,
  mapArtifactTimeRange,
  findChunkForArtifactMs,
  parseJournalGapsFromEntries,
  unwrapHolePayload,
  qpcToMs,
  sessionMsFromQpc,
  artifactMsToQpc,
  writeAll,
  assertWavDataSize,
  sha256File,
  makePartSuffix
};
