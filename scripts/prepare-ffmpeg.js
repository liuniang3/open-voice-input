"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "native", "ffmpeg");
const OUT_EXE = path.join(OUT_DIR, "ffmpeg.exe");
const REL_OUT = "native/ffmpeg/ffmpeg.exe";

async function main() {
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
  if (srcStat.size < 20 * 1024 * 1024) {
    console.error("ffmpeg-static binary looks truncated; reinstall ffmpeg-static@5.3.0");
    process.exitCode = 1;
    return;
  }
  await fsp.copyFile(src, OUT_EXE);
  console.log("prepared ffmpeg ok:", REL_OUT);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
