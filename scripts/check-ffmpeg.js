"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NAME = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const PREPARED = path.join(ROOT, "native", "ffmpeg", NAME);
const REL = `native/ffmpeg/${NAME}`;

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
  if (process.platform === "darwin") {
    const result = spawnSync("lipo", ["-archs", PREPARED], { encoding: "utf8" });
    const expected = process.arch === "x64" ? "x86_64" : "arm64";
    if (result.status !== 0 || !String(result.stdout).trim().split(/\s+/).includes(expected)) {
      throw new Error(`Prepared FFmpeg does not contain native ${expected} architecture`);
    }
  }
  console.log("ffmpeg ok:", REL);
}

main();
