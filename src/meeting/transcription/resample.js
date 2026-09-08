"use strict";

/**
 * Deterministic stateful linear resampler: mono PCM16 → mono PCM16.
 * Carries trailing odd bytes across push (including identity path).
 * flush() returns remaining aligned output; dangling odd byte is discarded
 * and reported via flush().danglingOddByte.
 */
function createLinearPcm16Resampler(sourceRate, targetRate) {
  const src = Number(sourceRate);
  const dst = Number(targetRate);
  if (!(src > 0) || !(dst > 0)) {
    const error = new Error(`invalid sample rates src=${sourceRate} dst=${targetRate}`);
    error.code = "resample_invalid_rate";
    throw error;
  }

  let oddCarry = Buffer.alloc(0);

  function takeAligned(input) {
    const b = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
    const combined = oddCarry.length ? Buffer.concat([oddCarry, b]) : b;
    const alignedLen = combined.length - (combined.length % 2);
    const aligned = combined.subarray(0, alignedLen);
    oddCarry = combined.subarray(alignedLen);
    return aligned;
  }

  if (src === dst) {
    return {
      sourceRate: src,
      targetRate: dst,
      push(pcm16Buf) {
        const aligned = takeAligned(pcm16Buf);
        return aligned.length ? Buffer.from(aligned) : Buffer.alloc(0);
      },
      flush() {
        const danglingOddByte = oddCarry.length > 0;
        oddCarry = Buffer.alloc(0);
        return Object.assign(Buffer.alloc(0), { danglingOddByte });
      },
      reset() {
        oddCarry = Buffer.alloc(0);
      },
      get pendingOddBytes() {
        return oddCarry.length;
      }
    };
  }

  const ratio = src / dst;
  let srcPos = 0;
  let prevSample = 0;
  let hasPrev = false;
  let totalInFrames = 0;

  function push(pcm16Buf) {
    const aligned = takeAligned(pcm16Buf);
    const inFrames = aligned.length / 2;
    if (inFrames <= 0) return Buffer.alloc(0);

    const samples = new Int16Array(inFrames + (hasPrev ? 1 : 0));
    let base = 0;
    if (hasPrev) {
      samples[0] = prevSample;
      base = 1;
    }
    for (let i = 0; i < inFrames; i += 1) {
      samples[base + i] = aligned.readInt16LE(i * 2);
    }

    const localOriginGlobal = totalInFrames - (hasPrev ? 1 : 0);
    const localEndGlobal = totalInFrames + inFrames;

    const out = [];
    while (true) {
      const g = srcPos;
      if (g > localEndGlobal - 1) break;
      if (g < localOriginGlobal) {
        srcPos = localOriginGlobal;
        continue;
      }
      const local = g - localOriginGlobal;
      const i0 = Math.floor(local);
      const frac = local - i0;
      const i1 = Math.min(i0 + 1, samples.length - 1);
      const s0 = samples[i0];
      const s1 = samples[i1];
      const v = Math.round(s0 + (s1 - s0) * frac);
      out.push(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
      srcPos += ratio;
    }

    prevSample = aligned.readInt16LE((inFrames - 1) * 2);
    hasPrev = true;
    totalInFrames += inFrames;

    const outBuf = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i += 1) {
      outBuf.writeInt16LE(out[i], i * 2);
    }
    return outBuf;
  }

  function flush() {
    const danglingOddByte = oddCarry.length > 0;
    oddCarry = Buffer.alloc(0);
    return Object.assign(Buffer.alloc(0), { danglingOddByte });
  }

  function reset() {
    srcPos = 0;
    prevSample = 0;
    hasPrev = false;
    totalInFrames = 0;
    oddCarry = Buffer.alloc(0);
  }

  return {
    sourceRate: src,
    targetRate: dst,
    push,
    flush,
    reset,
    get pendingOddBytes() {
      return oddCarry.length;
    }
  };
}

module.exports = {
  createLinearPcm16Resampler
};
