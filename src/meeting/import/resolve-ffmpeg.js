"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Resolve ffmpeg binary:
 * - packaged: resources/native/ffmpeg.exe only
 * - dev: native/ffmpeg/ffmpeg.exe prepared copy, else require("ffmpeg-static")
 */
function resolveFfmpegPath({ isPackaged = false, resourcesPath = "", appRoot = "", platform = process.platform } = {}) {
  const name = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  if (isPackaged) {
    const packaged = path.join(resourcesPath || process.resourcesPath || "", "native", name);
    if (fs.existsSync(packaged)) return packaged;
    const err = new Error("packaged ffmpeg missing");
    err.code = "ffmpeg_missing";
    throw err;
  }
  const root = appRoot || path.resolve(__dirname, "..", "..", "..");
  const prepared = path.join(root, "native", "ffmpeg", name);
  if (fs.existsSync(prepared)) return prepared;
  try {
    const staticPath = require("ffmpeg-static");
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch {
    /* not installed */
  }
  const err = new Error("ffmpeg not found (run npm run prepare:ffmpeg)");
  err.code = "ffmpeg_missing";
  throw err;
}

module.exports = { resolveFfmpegPath };
