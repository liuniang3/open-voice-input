"use strict";

/**
 * Packaging gate: release helper must exist outside asar.
 * Does not build Rust; fails clearly when audio-capture-helper.exe is missing.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assertHelloCompatible } = require("../src/meeting/protocol");

const ROOT = path.resolve(__dirname, "..");
const HELPER_NAME = process.platform === "darwin" ? "audio-capture-helper" : "audio-capture-helper.exe";

const candidates = process.platform === "darwin" ? [
  path.join(ROOT, "native", "macos-audio-capture-helper", ".build", "release", HELPER_NAME)
] : [
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
  console.error("Packaging requires the native platform capture helper. Run: npm run build:helper");
  console.error("Expected one of:");
  for (const c of candidates) console.error(`  - ${c}`);
  console.error("");
  console.error("Do not package a fake helper. Short-voice getUserMedia path remains available without this binary.");
  process.exit(1);
}

if (!["win32", "darwin"].includes(process.platform)) throw new Error("Unsupported native capture platform");
const probe = spawnSync(found, [], { input: '{"cmd":"ping","id":"check-ping"}\n{"cmd":"shutdown","id":"check-shutdown"}\n',
  encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
if (probe.error || probe.status !== 0) throw new Error(`Helper protocol probe failed: ${probe.error?.message || probe.status}`);
const messages = String(probe.stdout).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const compatibility = assertHelloCompatible(messages.find(message => message.type === "hello"));
if (!compatibility.ok) throw new Error(compatibility.message);
if (!messages.some(message => message.type === "result" && message.id === "check-ping" && message.result?.ok)) {
  throw new Error("Helper did not acknowledge ping before EOF/shutdown");
}
if (process.platform === "darwin") {
  const arch = spawnSync("lipo", ["-archs", found], { encoding: "utf8" });
  const expected = process.arch === "x64" ? "x86_64" : "arm64";
  if (arch.status !== 0 || !String(arch.stdout).trim().split(/\s+/).includes(expected)) throw new Error("Helper Mach-O architecture mismatch");
}

console.log(`audio-capture-helper present: ${found}`);
process.exit(0);
