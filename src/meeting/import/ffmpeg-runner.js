"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

/** Default 6h wall clock; still abortable via AbortSignal. */
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function scrubFfmpegText(text) {
  return String(text || "")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .replace(/\\\\[^\s"']+/g, "[path]")
    .replace(/\/(?:Users|home|tmp|var|opt)\/[^\s"']+/g, "[path]")
    .slice(0, 800);
}

/**
 * Build argv for first-audio-track → 16k mono PCM16 WAV.
 * No shell. Caller supplies absolute paths; never log them.
 */
function buildExtractArgs({ inputPath, outputPath } = {}) {
  if (!inputPath || !outputPath) {
    const error = new Error("inputPath and outputPath required");
    error.code = "ffmpeg_invalid";
    throw error;
  }
  return [
    "-nostdin",
    "-hide_banner",
    "-y",
    "-i",
    String(inputPath),
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    String(outputPath)
  ];
}

/**
 * Spawn ffmpeg with arg array only (no shell). Supports AbortSignal.
 */
function runFfmpegExtract({
  ffmpegPath,
  inputPath,
  outputPath,
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
    const args = buildExtractArgs({ inputPath, outputPath });
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

module.exports = {
  buildExtractArgs,
  runFfmpegExtract,
  scrubFfmpegText,
  DEFAULT_TIMEOUT_MS
};
