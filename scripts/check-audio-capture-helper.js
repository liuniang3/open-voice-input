"use strict";

/**
 * Packaging gate: release helper must exist outside asar.
 * Does not build Rust; fails clearly when audio-capture-helper.exe is missing.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const HELPER_NAME = "audio-capture-helper.exe";

const candidates = [
  path.join(ROOT, "native", "audio-capture-helper", "target", "release", HELPER_NAME),
  path.join(ROOT, "native", "audio-capture-helper", "target-release-out", HELPER_NAME),
  path.join(ROOT, "native", HELPER_NAME)
];

const found = candidates.find((p) => {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
});

if (!found) {
  console.error("audio-capture-helper release binary missing.");
  console.error("Stage 0B packaging requires a real WASAPI dual-track helper build:");
  console.error("  cd native/audio-capture-helper");
  console.error("  cargo build --release");
  console.error("Expected one of:");
  for (const c of candidates) console.error(`  - ${c}`);
  console.error("");
  console.error("Do not package a fake helper. Short-voice getUserMedia path remains available without this binary.");
  process.exit(1);
}

console.log(`audio-capture-helper present: ${found}`);
process.exit(0);
