"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveHelperPath } = require("../src/meeting/paths");

if (!["win32", "darwin"].includes(process.platform)) {
  console.log("skip - native system-capture tests require Windows or macOS");
} else {
  const helper = process.env.OVI_SYSTEM_CAPTURE_HELPER || resolveHelperPath({ appRoot: path.resolve(__dirname, "..") });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-native-system-"));
  function invoke(args, commands = []) {
    const result = spawnSync(helper, args, { input: commands.map(c => JSON.stringify(c)).join("\n") + "\n",
      encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }
  const commands = [
    { cmd: "configure", id: "configure", session_root: temp },
    { cmd: "start", id: "invalid-mode", session_id: "synthetic", capture_mode: "unknown", output_dir: temp },
    { cmd: "start", id: "conflicting-track", session_id: "synthetic", capture_mode: "microphone", track: "system", output_dir: temp },
    ...(process.platform === "win32" ? [
      { cmd: "start", id: "missing-system", session_id: "synthetic", capture_mode: "system",
        microphone: { output_dir: path.join(temp, "must-not-open-mic") } },
      { cmd: "start", id: "invalid-render", session_id: "synthetic", capture_mode: "system",
        device_id: "nonexistent-system-endpoint-test", output_dir: path.join(temp, "system") }
    ] : []),
    { cmd: "ping", id: "ping" },
    { cmd: "shutdown", id: "shutdown" }
  ];
  const messages = invoke([], commands);
  assert.ok(messages.find(m => m.type === "hello").capabilities.includes("system_only"));
  const response = id => messages.find(m => m.type === "result" && m.id === id)?.result;
  assert.equal(response("invalid-mode").error.code, "invalid_capture_mode");
  assert.equal(response("conflicting-track").error.code, "invalid_track");
  assert.equal(response("ping").ok, true);
  if (process.platform === "win32") {
    assert.equal(response("missing-system").error.code, "invalid_start");
    assert.equal(response("invalid-render").error.code, "start_failed");
    assert.match(response("invalid-render").error.message, /GetDevice/);
    assert.equal(fs.existsSync(path.join(temp, "must-not-open-mic")), false);
    console.log("ok - native WASAPI system-only capability, strict dispatch, no microphone fallback");
  } else {
    const archive = path.join(temp, "system");
    const result = invoke(["--self-test-system-pause", archive])[0].result;
    assert.equal(result.ok, true);
    assert.equal(result.data.sessionFaulted, false);
    const manifest = JSON.parse(fs.readFileSync(path.join(archive, "manifest.json"), "utf8"));
    assert.equal(manifest.track, "system");
    assert.equal(manifest.recording, false);
    const entries = fs.readFileSync(path.join(archive, "index.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(entries.reduce((sum, e) => sum + e.frames, 0), 200);
    const pcm = Buffer.concat(entries.map(e => fs.readFileSync(path.join(archive, e.file))));
    assert.equal(pcm.length, 800);
    for (let frame = 0; frame < 200; frame++) assert.equal(pcm.readFloatLE(frame * 4), frame < 25 ? 0.25 : 0.5);
    const journal = fs.readFileSync(path.join(archive, "journal.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const holes = journal.filter(e => e.kind === "hole").map(e => e.detail);
    assert.deepEqual(holes.map(e => e.reason), ["pause_begin", "pause_end", "pause_begin", "pause_end"]);
    assert.equal(holes[1].detail.discardedFrames, 50);
    console.log("ok - native Swift system PCM, partial seals, repeated pause, resume and stop-while-paused");
  }
  console.log(`No hardware capture or permissions requested; synthetic fixtures retained: ${temp}`);
}
