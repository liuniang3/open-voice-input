#!/usr/bin/env node
"use strict";

/**
 * Fake helper for supervisor protocol tests (Stage 0B).
 * Emits JSONL on stdout; never claims real WASAPI capture.
 */

const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

const VERSION = process.env.FAKE_HELPER_VERSION || "0.2.0";
const PROTOCOL_VERSION = 1;

const CAPABILITIES = [
  "dual_track",
  "system_loopback_shared",
  "dual_start_single_rpc",
  "query_devices_capture_and_render",
  "clock_qpc_ticks_iaudioclock",
  "pause_holes_shared_qpc",
  "durable_subchunk_seal_frame_aligned",
  "mic_shared",
  "query_devices",
  "pause_resume",
  "durable_subchunk_seal",
  "l0_device_format",
  "parent_pid_watch",
  "fake"
];

let sessionRoot = null;
let capturing = false;
let paused = false;
let activeSessionId = null;
let activeMicDir = null;
let activeSysDir = null;
let activeMode = null;
const seenStartKeys = new Set();

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function ack(id, command) {
  emit({ type: "ack", id, command });
}

function ok(id, data) {
  emit({ type: "result", id, result: { ok: true, data } });
}

function fail(id, code, message) {
  emit({ type: "result", id, result: { ok: false, error: { code, message } } });
}

function hasParent(p) {
  return /(^|[\\/])\.\.([\\/]|$)/.test(String(p || ""));
}

function underRoot(root, candidate) {
  const r = path.resolve(root).toLowerCase();
  const c = path.resolve(candidate).toLowerCase();
  return c === r || c.startsWith(r.endsWith("\\") ? r : `${r}\\`);
}

function writeFakeManifest(out, track, role) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, "manifest.json"),
    JSON.stringify({
      archivePending: true,
      recording: true,
      track,
      role,
      state: "recording",
      actualL0Format: { layer: "L0", sampleRate: 48000, channels: 2, note: "fake" },
      fake: true
    }),
    "utf8"
  );
}

function finishManifest(dir) {
  if (!dir) return;
  try {
    const p = path.join(dir, "manifest.json");
    if (!fs.existsSync(p)) return;
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.recording = false;
    m.state = "finished";
    fs.writeFileSync(p, JSON.stringify(m), "utf8");
  } catch {
    // ignore
  }
}

emit({
  type: "hello",
  name: "audio-capture-helper",
  version: VERSION,
  protocol_version: PROTOCOL_VERSION,
  capabilities: CAPABILITIES,
  notes: ["fake_helper_for_tests", "not_real_wasapi", "stage_0b"]
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = String(line || "").trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (error) {
    emit({ type: "error", id: null, code: "parse_error", message: error.message });
    return;
  }
  const { cmd, id } = msg;
  if (!id) {
    emit({ type: "error", id: null, code: "missing_id", message: "id required" });
    return;
  }

  switch (cmd) {
    case "hello":
      ack(id, "hello");
      ok(id, {
        name: "audio-capture-helper",
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CAPABILITIES
      });
      break;
    case "ping":
      ack(id, "ping");
      ok(id, { pong: true });
      break;
    case "query_devices":
      ack(id, "query_devices");
      ok(id, {
        capture: [{ id: "fake-mic", name: "Fake Microphone", is_default: true, flow: "capture" }],
        render: [{ id: "fake-render", name: "Fake Speakers", is_default: true, flow: "render" }],
        devices: [{ id: "fake-mic", name: "Fake Microphone", is_default: true, flow: "capture" }]
      });
      break;
    case "configure":
      ack(id, "configure");
      if (!msg.session_root || hasParent(msg.session_root)) {
        fail(id, "invalid_session_root", "bad session_root");
        break;
      }
      try {
        fs.mkdirSync(msg.session_root, { recursive: true });
        sessionRoot = path.resolve(msg.session_root);
        ok(id, {
          configured: true,
          jobObject: false,
          parentWatcher: Boolean(msg.parent_pid),
          fake: true
        });
      } catch (error) {
        fail(id, "invalid_session_root", error.message);
      }
      break;
    case "start":
      ack(id, "start");
      if (!sessionRoot) {
        fail(id, "not_configured", "configure first");
        break;
      }
      {
        // Test hook: hang prepare (bounded) — production unused
        if (process.env.FAKE_HELPER_HANG_PREPARE === "1") {
          const hangMs = Number(process.env.FAKE_HELPER_HANG_MS || 800);
          const t0 = Date.now();
          while (Date.now() - t0 < hangMs) {
            // busy wait small
          }
          fail(id, "start_failed", "prepare hang simulated timeout path");
          break;
        }
        const mode = String(msg.capture_mode || "").toLowerCase();
        const isDual =
          mode === "dual" || (msg.microphone && msg.system && mode !== "microphone");

        if (isDual) {
          if (!msg.microphone?.output_dir || !msg.system?.output_dir) {
            fail(id, "invalid_start", "dual requires microphone and system output_dir");
            break;
          }
          if (
            hasParent(msg.microphone.output_dir) ||
            !underRoot(sessionRoot, msg.microphone.output_dir) ||
            hasParent(msg.system.output_dir) ||
            !underRoot(sessionRoot, msg.system.output_dir)
          ) {
            fail(id, "path_denied", "output_dir escapes session root or contains ..");
            break;
          }
          const micOut = path.resolve(msg.microphone.output_dir);
          const sysOut = path.resolve(msg.system.output_dir);
          const key = `${msg.session_id}::dual::${micOut}::${sysOut}`;
          if (capturing) {
            if (
              activeSessionId === msg.session_id &&
              activeMode === "dual" &&
              activeMicDir === micOut &&
              activeSysDir === sysOut
            ) {
              ok(id, {
                started: true,
                idempotent: true,
                fake: true,
                sessionId: msg.session_id,
                captureMode: "dual"
              });
              break;
            }
            fail(id, "already_capturing", `capture already active for session ${activeSessionId}`);
            break;
          }
          if (msg.system?.device_id === "bad-render-device") {
            // Simulate prepare failure: no recording=true residual
            try {
              fs.mkdirSync(sysOut, { recursive: true });
              fs.writeFileSync(
                path.join(sysOut, "manifest.json"),
                JSON.stringify({
                  recording: false,
                  state: "faulted",
                  track: "system",
                  role: "remote_mix_for_diarization",
                  fake: true
                }),
                "utf8"
              );
            } catch {
              // ignore
            }
            fail(id, "start_failed", "bad render device (fake)");
            break;
          }
          try {
            writeFakeManifest(micOut, "microphone", "self");
            writeFakeManifest(sysOut, "system", "remote_mix_for_diarization");
          } catch (error) {
            fail(id, "start_failed", error.message);
            break;
          }
          capturing = true;
          activeSessionId = msg.session_id;
          activeMicDir = micOut;
          activeSysDir = sysOut;
          activeMode = "dual";
          seenStartKeys.add(key);
          ok(id, {
            started: true,
            sessionId: msg.session_id,
            captureMode: "dual",
            fake: true,
            sessionOriginQpc: 1000,
            qpcFrequency: 10000000,
            microphone: { track: "microphone", role: "self", outputDir: micOut },
            system: {
              track: "system",
              role: "remote_mix_for_diarization",
              outputDir: sysOut,
              captureScope: "endpoint_mix"
            },
            archivePending: true
          });
          break;
        }

        // mic-only
        if (msg.track && msg.track !== "microphone") {
          fail(id, "unsupported_track", "mic only or dual");
          break;
        }
        const outDir = msg.microphone?.output_dir || msg.output_dir;
        if (hasParent(outDir) || !underRoot(sessionRoot, outDir)) {
          fail(id, "path_denied", "output_dir escapes session root or contains ..");
          break;
        }
        const out = path.resolve(outDir);
        const key = `${msg.session_id}::${out}`;
        if (capturing) {
          if (activeSessionId === msg.session_id && activeMicDir === out && activeMode !== "dual") {
            ok(id, { started: true, idempotent: true, fake: true, sessionId: msg.session_id });
            break;
          }
          fail(id, "already_capturing", `capture already active for session ${activeSessionId}`);
          break;
        }
        if (seenStartKeys.has(key) && !capturing) {
          // allow restart after stop
        }
        try {
          writeFakeManifest(out, "microphone", "self");
        } catch (error) {
          fail(id, "start_failed", error.message);
          break;
        }
        capturing = true;
        activeSessionId = msg.session_id;
        activeMicDir = out;
        activeSysDir = null;
        activeMode = "microphone";
        seenStartKeys.add(key);
        ok(id, {
          started: true,
          sessionId: msg.session_id,
          track: "microphone",
          role: "self",
          fake: true,
          actualL0Format: { layer: "L0", sampleRate: 48000, channels: 2 },
          archivePending: true
        });
      }
      break;
    case "pause":
      ack(id, "pause");
      if (!capturing) {
        fail(id, "not_started", "no capture");
        break;
      }
      paused = true;
      // Simulate single begin hole per track (no per-packet discard journal)
      for (const dir of [activeMicDir, activeSysDir].filter(Boolean)) {
        try {
          fs.appendFileSync(
            path.join(dir, "journal.jsonl"),
            `${JSON.stringify({
              t: Date.now(),
              kind: "hole",
              detail: {
                reason: "pause_begin",
                detail: { holeQpc: 123456789, pauseGen: 1 },
                track: dir === activeMicDir ? "microphone" : "system"
              }
            })}\n`
          );
        } catch {
          // ignore
        }
      }
      ok(id, {
        paused: true,
        policy: "keep_audioclient_running_discard_buffers_record_hole",
        holeQpc: 123456789,
        broadcast: true
      });
      break;
    case "resume":
      ack(id, "resume");
      if (!capturing) {
        fail(id, "not_started", "no capture");
        break;
      }
      paused = false;
      for (const dir of [activeMicDir, activeSysDir].filter(Boolean)) {
        try {
          fs.appendFileSync(
            path.join(dir, "journal.jsonl"),
            `${JSON.stringify({
              t: Date.now(),
              kind: "hole",
              detail: {
                reason: "pause_end",
                detail: {
                  holeQpc: 123456790,
                  pauseGen: 1,
                  discardedFrames: 48,
                  firstQpc: 1,
                  lastQpc: 2
                },
                track: dir === activeMicDir ? "microphone" : "system"
              }
            })}\n`
          );
        } catch {
          // ignore
        }
      }
      ok(id, { paused: false });
      break;
    case "inject_fault":
      // test-only command
      ack(id, "inject_fault");
      if (!capturing) {
        fail(id, "not_started", "no capture");
        break;
      }
      emit({
        type: "progress",
        session_id: activeSessionId,
        track: "microphone",
        event: "track_fault",
        detail: { code: "fake_fault", message: "injected fault", track: "microphone" }
      });
      emit({
        type: "progress",
        session_id: activeSessionId,
        track: "microphone",
        event: "session_fault",
        detail: { code: "session_fault", message: "injected session fault" }
      });
      ok(id, { injected: true });
      break;
    case "stop":
      ack(id, "stop");
      if (!capturing) {
        ok(id, { stopped: true, idempotent: true });
        break;
      }
      finishManifest(activeMicDir);
      finishManifest(activeSysDir);
      capturing = false;
      paused = false;
      activeSessionId = null;
      activeMicDir = null;
      activeSysDir = null;
      activeMode = null;
      ok(id, { stopped: true, fake: true, captureMode: activeMode });
      break;
    case "shutdown":
      ack(id, "shutdown");
      ok(id, { shutdown: true });
      process.exit(0);
      break;
    default:
      ack(id, cmd || "unknown");
      fail(id, "unknown_cmd", `unknown cmd ${cmd}`);
  }
});
