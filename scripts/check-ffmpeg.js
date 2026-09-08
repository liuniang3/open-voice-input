"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PREPARED = path.join(ROOT, "native", "ffmpeg", "ffmpeg.exe");
const REL = "native/ffmpeg/ffmpeg.exe";

function main() {
  if (!fs.existsSync(PREPARED)) {
    console.error("prepared ffmpeg missing:", REL);
    console.error("Run: npm run prepare:ffmpeg");
    process.exitCode = 1;
    return;
  }
  const r = spawnSync(PREPARED, ["-hide_banner", "-version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000
  });
  if (r.error || r.status !== 0) {
    console.error("ffmpeg -version failed");
    process.exitCode = 1;
    return;
  }
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (!/ffmpeg\s+version/i.test(out)) {
    console.error("unexpected ffmpeg -version output");
    process.exitCode = 1;
    return;
  }
  console.log("ffmpeg ok:", REL);
}

main();
