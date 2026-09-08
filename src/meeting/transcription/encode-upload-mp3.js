"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { resolveFfmpegPath } = require("../import/resolve-ffmpeg");
const { scrubFfmpegText, DEFAULT_TIMEOUT_MS } = require("../import/ffmpeg-runner");
const { assertPathInsideRoot } = require("../paths");
const { makePartSuffix } = require("../archive/export-track-wav");

const ALLOWED_BITRATES = Object.freeze([32, 48, 64]);
const DEFAULT_BITRATE_KBPS = 48;

function normalizeBitrateKbps(value) {
  const n = Number(value);
  if (ALLOWED_BITRATES.includes(n)) return n;
  return DEFAULT_BITRATE_KBPS;
}

/**
 * Encode archive mono WAV → 16 kHz mono MP3 via libmp3lame.
 * Input may be any sample rate mono/stereo WAV; FFmpeg resamples.
 */
function buildUploadMp3Args({ inputPath, outputPath, bitrateKbps = DEFAULT_BITRATE_KBPS } = {}) {
  if (!inputPath || !outputPath) {
    const error = new Error("inputPath and outputPath required");
    error.code = "ffmpeg_invalid";
    throw error;
  }
  const br = normalizeBitrateKbps(bitrateKbps);
  return [
    "-nostdin",
    "-hide_banner",
    "-y",
    "-i",
    String(inputPath),
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    `${br}k`,
    "-f",
    "mp3",
    String(outputPath)
  ];
}

function runFfmpegArgs({
  ffmpegPath,
  args,
  signal = null,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      const error = new Error("ffmpegPath required");
      error.code = "ffmpeg_missing";
      reject(error);
      return;
    }
    let settled = false;
    let stderr = "";
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      const error = new Error(scrubFfmpegText(message || code));
      error.code = code;
      reject(error);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      fail("ffmpeg_timeout", "ffmpeg timed out");
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      fail("aborted", "ffmpeg cancelled");
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fail(error.code === "ENOENT" ? "ffmpeg_missing" : "ffmpeg_spawn_failed", error.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ ok: true, code: 0 });
        return;
      }
      const error = new Error(scrubFfmpegText(stderr || `ffmpeg exit ${code}`));
      error.code = signal?.aborted ? "aborted" : "ffmpeg_failed";
      error.exitCode = code;
      reject(error);
    });
  });
}

/**
 * Probe duration seconds via ffmpeg -i (parse Duration= from stderr).
 */
async function probeDurationSec(ffmpegPath, filePath, signal = null) {
  return new Promise((resolve) => {
    if (!ffmpegPath || !filePath) {
      resolve(null);
      return;
    }
    let stderr = "";
    const child = spawn(ffmpegPath, ["-nostdin", "-hide_banner", "-i", String(filePath)], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const done = () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);
      if (!m) {
        resolve(null);
        return;
      }
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      resolve(Number.isFinite(sec) ? sec : null);
    };
    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(null);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stderr?.on("data", (c) => {
      stderr = `${stderr}${c}`.slice(-8000);
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      done();
    });
  });
}

/**
 * @returns {{ mp3Path, bitrateKbps, bytes, durationSec, sourceDurationSec }}
 */
async function encodeArchiveWavToUploadMp3({
  inputWavPath,
  outputDir,
  sessionDir = null,
  bitrateKbps = DEFAULT_BITRATE_KBPS,
  expectedDurationMs = null,
  signal = null,
  ffmpegPath = null,
  isPackaged = false,
  resourcesPath = "",
  appRoot = "",
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!inputWavPath || !outputDir) {
    const error = new Error("inputWavPath and outputDir required");
    error.code = "encode_invalid";
    throw error;
  }
  if (sessionDir) {
    assertPathInsideRoot(sessionDir, outputDir);
    assertPathInsideRoot(sessionDir, inputWavPath);
  }
  await fsp.mkdir(outputDir, { recursive: true });
  const br = normalizeBitrateKbps(bitrateKbps);
  const part = path.join(outputDir, `upload.${br}k.${makePartSuffix()}.mp3.part`);
  const finalPath = path.join(outputDir, `system.upload.${br}k.mp3`);
  if (sessionDir) {
    assertPathInsideRoot(sessionDir, part);
    assertPathInsideRoot(sessionDir, finalPath);
  }
  const bin =
    ffmpegPath ||
    resolveFfmpegPath({ isPackaged, resourcesPath, appRoot });
  const args = buildUploadMp3Args({
    inputPath: inputWavPath,
    outputPath: part,
    bitrateKbps: br
  });
  try {
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.code = "aborted";
      throw error;
    }
    await runFfmpegArgs({ ffmpegPath: bin, args, signal, timeoutMs });
    const st = await fsp.stat(part);
    if (!st.size || st.size < 32) {
      const error = new Error("encoded mp3 empty or too small");
      error.code = "encode_empty";
      throw error;
    }
    const durationSec = await probeDurationSec(bin, part, signal);
    const sourceDurationSec =
      expectedDurationMs != null && Number.isFinite(Number(expectedDurationMs))
        ? Number(expectedDurationMs) / 1000
        : await probeDurationSec(bin, inputWavPath, signal);
    if (
      durationSec != null &&
      sourceDurationSec != null &&
      sourceDurationSec > 0.5 &&
      Math.abs(durationSec - sourceDurationSec) > Math.max(2, sourceDurationSec * 0.25)
    ) {
      const error = new Error(
        `mp3 duration ${durationSec}s diverges from source ${sourceDurationSec}s`
      );
      error.code = "encode_duration_mismatch";
      throw error;
    }
    await fsp.rename(part, finalPath);
    const finalSt = await fsp.stat(finalPath);
    return {
      mp3Path: finalPath,
      bitrateKbps: br,
      bytes: finalSt.size,
      durationSec,
      sourceDurationSec
    };
  } catch (error) {
    try {
      await fsp.unlink(part);
    } catch {
      /* keep part if unlink fails — caller may quarantine */
    }
    throw error;
  }
}

module.exports = {
  ALLOWED_BITRATES,
  DEFAULT_BITRATE_KBPS,
  normalizeBitrateKbps,
  buildUploadMp3Args,
  runFfmpegArgs,
  probeDurationSec,
  encodeArchiveWavToUploadMp3
};
