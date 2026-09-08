"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const PCM16_FORMAT = 1;

/**
 * Robust RIFF/WAVE header parse — walks chunks; does not assume data at offset 44.
 * Validates mono PCM16, positive sample rate, alignment, chunk bounds.
 */
async function parseWavHeader(filePath) {
  const fh = await fsp.open(filePath, "r");
  try {
    const st = await fh.stat();
    const fileSize = st.size;
    if (fileSize < 12) {
      const error = new Error("WAV too short");
      error.code = "wav_invalid";
      throw error;
    }

    const headerBuf = Buffer.alloc(12);
    const { bytesRead: n0 } = await fh.read(headerBuf, 0, 12, 0);
    if (n0 < 12) {
      const error = new Error("WAV too short");
      error.code = "wav_invalid";
      throw error;
    }
    if (headerBuf.toString("ascii", 0, 4) !== "RIFF" || headerBuf.toString("ascii", 8, 12) !== "WAVE") {
      const error = new Error("not a RIFF/WAVE file");
      error.code = "wav_invalid";
      throw error;
    }

    let offset = 12;
    let fmt = null;
    let dataOffset = -1;
    let dataSize = -1;
    const extraChunks = [];

    while (offset + 8 <= fileSize) {
      const chunkHead = Buffer.alloc(8);
      const { bytesRead } = await fh.read(chunkHead, 0, 8, offset);
      if (bytesRead < 8) break;
      const id = chunkHead.toString("ascii", 0, 4);
      const size = chunkHead.readUInt32LE(4);
      if (!Number.isFinite(size) || size < 0) {
        const error = new Error(`invalid chunk size for ${id}`);
        error.code = "wav_invalid";
        throw error;
      }
      const dataStart = offset + 8;
      if (dataStart > fileSize) {
        const error = new Error(`chunk ${id} starts past EOF`);
        error.code = "wav_invalid";
        throw error;
      }
      // Allow final data chunk to be truncated to file end; other chunks must fit
      const maxPayload = fileSize - dataStart;
      if (id !== "data" && size > maxPayload) {
        const error = new Error(`chunk ${id} size ${size} exceeds remaining file ${maxPayload}`);
        error.code = "wav_invalid";
        throw error;
      }

      if (id === "fmt ") {
        if (size < 16) {
          const error = new Error("fmt chunk too small");
          error.code = "wav_invalid";
          throw error;
        }
        const toRead = Math.min(size, 64);
        const fmtBuf = Buffer.alloc(toRead);
        const { bytesRead: fr } = await fh.read(fmtBuf, 0, toRead, dataStart);
        if (fr < 16) {
          const error = new Error(`fmt bytes read ${fr} < 16`);
          error.code = "wav_invalid";
          throw error;
        }
        fmt = {
          audioFormat: fmtBuf.readUInt16LE(0),
          channels: fmtBuf.readUInt16LE(2),
          sampleRate: fmtBuf.readUInt32LE(4),
          byteRate: fmtBuf.readUInt32LE(8),
          blockAlign: fmtBuf.readUInt16LE(12),
          bitsPerSample: fmtBuf.readUInt16LE(14)
        };
      } else if (id === "data") {
        dataOffset = dataStart;
        dataSize = Math.min(size, maxPayload);
        break;
      } else {
        extraChunks.push({ id, size, offset: dataStart });
      }

      const step = 8 + size + (size % 2);
      if (step <= 0) {
        const error = new Error("chunk walk made no progress");
        error.code = "wav_invalid";
        throw error;
      }
      offset += step;
    }

    if (!fmt) {
      const error = new Error("WAV missing fmt chunk");
      error.code = "wav_invalid";
      throw error;
    }
    if (dataOffset < 0 || dataSize < 0) {
      const error = new Error("WAV missing data chunk");
      error.code = "wav_invalid";
      throw error;
    }
    if (fmt.audioFormat !== PCM16_FORMAT) {
      const error = new Error(`WAV must be PCM (format=1), got ${fmt.audioFormat}`);
      error.code = "wav_format_unsupported";
      throw error;
    }
    if (fmt.channels !== 1) {
      const error = new Error(`WAV must be mono, got channels=${fmt.channels}`);
      error.code = "wav_not_mono";
      throw error;
    }
    if (fmt.bitsPerSample !== 16) {
      const error = new Error(`WAV must be 16-bit, got ${fmt.bitsPerSample}`);
      error.code = "wav_format_unsupported";
      throw error;
    }
    if (!(fmt.sampleRate > 0) || !Number.isFinite(fmt.sampleRate)) {
      const error = new Error(`invalid sampleRate ${fmt.sampleRate}`);
      error.code = "wav_invalid";
      throw error;
    }
    if (fmt.blockAlign !== 2) {
      const error = new Error(`unexpected blockAlign=${fmt.blockAlign}`);
      error.code = "wav_invalid";
      throw error;
    }

    const available = Math.max(0, Math.min(dataSize, fileSize - dataOffset));
    if (available % 2 !== 0) {
      // frame-align by dropping trailing odd byte
    }
    const frameCount = Math.floor(available / 2);

    return {
      path: path.resolve(filePath),
      sampleRate: fmt.sampleRate,
      channels: 1,
      bitsPerSample: 16,
      blockAlign: 2,
      dataOffset,
      dataSize: frameCount * 2,
      frameCount,
      durationMs: fmt.sampleRate > 0 ? (frameCount / fmt.sampleRate) * 1000 : 0,
      extraChunks
    };
  } finally {
    await fh.close();
  }
}

/**
 * Read mono PCM16 frames [frameStart, frameEnd) using an open FileHandle or path.
 */
async function readPcm16Frames(wavInfo, frameStart, frameEnd, fhIn = null) {
  const start = Math.max(0, Math.floor(frameStart));
  const end = Math.min(wavInfo.frameCount, Math.floor(frameEnd));
  if (end <= start) return Buffer.alloc(0);
  const byteStart = wavInfo.dataOffset + start * 2;
  const byteLen = (end - start) * 2;
  const buf = Buffer.alloc(byteLen);
  const owns = !fhIn;
  const fh = fhIn || (await fsp.open(wavInfo.path, "r"));
  try {
    let offset = 0;
    while (offset < byteLen) {
      const { bytesRead } = await fh.read(buf, offset, byteLen - offset, byteStart + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (offset < byteLen) return buf.subarray(0, offset - (offset % 2));
    return buf;
  } finally {
    if (owns) await fh.close();
  }
}

function buildMonoPcm16WavHeader(dataBytes, sampleRate) {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

module.exports = {
  parseWavHeader,
  readPcm16Frames,
  buildMonoPcm16WavHeader,
  PCM16_FORMAT
};
