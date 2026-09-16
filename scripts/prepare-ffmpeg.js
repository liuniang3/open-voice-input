"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "native", "ffmpeg");
const NAME = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const OUT_EXE = path.join(OUT_DIR, NAME);
const REL_OUT = `native/ffmpeg/${NAME}`;

async function main() {
  if (!["win32", "darwin"].includes(process.platform)) throw new Error("Packaged FFmpeg is supported on Windows/macOS only");
  if (process.env.OVI_TARGET_ARCH && process.env.OVI_TARGET_ARCH !== process.arch) {
    throw new Error("FFmpeg must be prepared on a runner matching the target architecture");
  }
  let src;
  try {
    src = require("ffmpeg-static");
  } catch {
    console.error("ffmpeg-static not installed. Run: npm install --save-dev --save-exact ffmpeg-static@5.3.0");
    process.exitCode = 1;
    return;
  }
  if (!src || !fs.existsSync(src)) {
    console.error("ffmpeg-static binary missing from package");
    process.exitCode = 1;
    return;
  }
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const srcStat = fs.statSync(src);
  // Refuse obviously truncated downloads (full Windows essentials build is tens of MB)
  if (srcStat.size < 1024 * 1024) {
    console.error("ffmpeg-static binary looks truncated; reinstall ffmpeg-static@5.3.0");
    process.exitCode = 1;
    return;
  }
  await fsp.copyFile(src, OUT_EXE);
  if (process.platform !== "win32") await fsp.chmod(OUT_EXE, 0o755);
  console.log("prepared ffmpeg ok:", REL_OUT);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
