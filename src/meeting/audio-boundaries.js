"use strict";

// Search only a bounded PCM range. Silence is a boundary hint, never discarded audio.
function findQuietFrame(pcm, sampleRate, targetFrame, minFrame, maxFrame, quietSeconds = 0.2) {
  const frames = Math.floor(pcm.length / 2);
  const window = Math.max(1, Math.round(sampleRate * quietSeconds));
  const half = Math.ceil(window / 2);
  const step = Math.max(1, Math.round(sampleRate * 0.02));
  const low = Math.max(half, Math.ceil(minFrame));
  const high = Math.min(frames - half, Math.floor(maxFrame));
  if (high < low) return null;
  const start = low - half;
  const end = Math.min(frames, high + half);
  const sums = new Float64Array(end - start + 1);
  for (let i = start; i < end; i++) {
    const value = pcm.readInt16LE(i * 2) / 32768;
    sums[i - start + 1] = sums[i - start] + value * value;
  }
  let best = null;
  let distance = Infinity;
  for (let center = low; center <= high; center += step) {
    const a = center - Math.floor(window / 2), b = a + window;
    const rms = Math.sqrt(Math.max(0, sums[b - start] - sums[a - start]) / window);
    const d = Math.abs(center - targetFrame);
    if (rms <= 0.006 && d < distance) { best = center; distance = d; }
  }
  return best;
}

function choosePauseFrame(pcm, sampleRate, targetFrame, minFrame, maxFrame) {
  return findQuietFrame(pcm, sampleRate, targetFrame, minFrame, maxFrame)
    ?? Math.max(1, Math.min(Math.floor(pcm.length / 2) - 1, Math.round(targetFrame)));
}

// Keep only 20ms RMS state between network frames, archive reads and scheduler kicks.
function createQuietDetector(sampleRate, quietSeconds = 0.3) {
  const block = Math.max(1, Math.round(sampleRate * 0.02));
  const required = Math.max(block, Math.round(sampleRate * quietSeconds));
  let count = 0, energy = 0, quietFrames = 0;
  return {
    append(pcm) {
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        const value = pcm.readInt16LE(i) / 32768;
        energy += value * value;
        if (++count === block) {
          quietFrames = energy / count <= 0.006 ** 2 ? quietFrames + count : 0;
          count = 0; energy = 0;
        }
      }
      return quietFrames >= required && (!count || energy / count <= 0.006 ** 2);
    }
  };
}

module.exports = { findQuietFrame, choosePauseFrame, createQuietDetector };
