"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { resolveL0SampleEncoding } = require("../archive/l0-format");

const RATE = 16000;
const HEADER_BYTES = 80;

// Reserve ds64 space from the start so recordings can grow past RIFF's 4 GiB limit.
function wavHeader(bytes, extended = true) {
  const size = extended ? HEADER_BYTES : 44;
  const b = Buffer.alloc(size);
  const large = bytes + size - 8 > 0xffffffff;
  b.write(large ? "RF64" : "RIFF", 0);
  b.writeUInt32LE(large ? 0xffffffff : bytes + size - 8, 4);
  b.write("WAVE", 8);
  let offset = 12;
  if (extended) {
    b.write(large ? "ds64" : "JUNK", 12);
    b.writeUInt32LE(28, 16);
    if (large) {
      b.writeBigUInt64LE(BigInt(bytes + size - 8), 20);
      b.writeBigUInt64LE(BigInt(bytes), 28);
      b.writeBigUInt64LE(BigInt(bytes / 2), 36);
    }
    offset = 48;
  }
  b.write("fmt ", offset);
  b.writeUInt32LE(16, offset + 4);
  b.writeUInt16LE(1, offset + 8);
  b.writeUInt16LE(1, offset + 10);
  b.writeUInt32LE(RATE, offset + 12);
  b.writeUInt32LE(RATE * 2, offset + 16);
  b.writeUInt16LE(2, offset + 20);
  b.writeUInt16LE(16, offset + 22);
  b.write("data", offset + 24);
  b.writeUInt32LE(large ? 0xffffffff : bytes, offset + 28);
  return b;
}

async function writeAll(handle, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, done, buffer.length - done, position + done);
    if (!bytesWritten) throw new Error("audio_write_incomplete");
    done += bytesWritten;
  }
}

function normalizeChunk(buffer, format) {
  const encoding = resolveL0SampleEncoding(format);
  const frames = Math.floor(buffer.length / encoding.blockAlign);
  const count = Math.round(frames * RATE / encoding.sampleRate);
  const output = Buffer.alloc(count * 2);
  const sample = (frame) => {
    let sum = 0;
    const stride = encoding.kind === "float32" ? 4 : 2;
    for (let ch = 0; ch < encoding.channels; ch++) {
      const p = Math.min(frames - 1, frame) * encoding.blockAlign + ch * stride;
      const v = encoding.kind === "float32" ? buffer.readFloatLE(p) * 32768 : buffer.readInt16LE(p);
      sum += Number.isFinite(v) ? v : 0;
    }
    return sum / encoding.channels;
  };
  for (let i = 0; i < count; i++) {
    const p = i * encoding.sampleRate / RATE;
    const left = Math.floor(p);
    const v = sample(left) * (1 - (p - left)) + sample(left + 1) * (p - left);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return output;
}

async function ensureWave(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const h = await fs.open(file, "wx", 0o600);
    try { await writeAll(h, wavHeader(0), 0); await h.sync(); } finally { await h.close(); }
  } catch (error) { if (error.code !== "EEXIST") throw error; }
}

async function writePcm(file, pcm, startFrame) {
  const h = await fs.open(file, "r+");
  try {
    await writeAll(h, pcm, HEADER_BYTES + startFrame * 2);
    const bytes = Math.max(0, (await h.stat()).size - HEADER_BYTES);
    await writeAll(h, wavHeader(bytes), 0);
    await h.sync();
    return bytes / 2;
  } finally { await h.close(); }
}

async function repairWave(file) {
  const h = await fs.open(file, "r+");
  try {
    const bytes = (await h.stat()).size - HEADER_BYTES;
    if (bytes < 0 || bytes % 2) throw new Error("audio_archive_invalid");
    const expected = wavHeader(bytes);
    const existing = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await h.read(existing, 0, existing.length, 0);
    // Opening an intact archive must not invalidate content-based review checkpoints.
    if (bytesRead !== expected.length || !existing.equals(expected)) {
      await writeAll(h, expected, 0);
      await h.sync();
    }
    return bytes / 2;
  } finally { await h.close(); }
}

async function readMixed(paths, start, end) {
  const bytes = (end - start) * 2;
  if (bytes < 0 || bytes > RATE * 2 * 40) throw new Error("audio_segment_limit");
  const output = Buffer.alloc(bytes);
  for (const file of paths) {
    const h = await fs.open(file, "r");
    const buffer = Buffer.alloc(bytes);
    try {
      let done = 0;
      while (done < bytes) {
        const { bytesRead } = await h.read(buffer, done, bytes - done, HEADER_BYTES + start * 2 + done);
        if (!bytesRead) break;
        done += bytesRead;
      }
    } finally { await h.close(); }
    for (let i = 0; i < bytes; i += 2) {
      const sample = output.readInt16LE(i) + Math.round(buffer.readInt16LE(i) / paths.length);
      output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
    }
  }
  return Buffer.concat([wavHeader(bytes, false), output]);
}

module.exports = { RATE, HEADER_BYTES, wavHeader, normalizeChunk, ensureWave, writePcm, repairWave, readMixed };
