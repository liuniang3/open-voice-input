"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { createAudioCaptureSupervisor, createMeetingCaptureService, constants } = require("../src/meeting");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-system-capture-"));
let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`ok - ${name}`);
  passed += 1;
}

function fixture(platform, systemOnly = true) {
  const commands = [];
  const failures = new Map();
  let proc;
  const send = message => proc.stdout.write(`${JSON.stringify(message)}\n`);
  return {
    commands, failures, send,
    spawnImpl() {
      proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new Writable({ write(data, encoding, callback) {
        const command = JSON.parse(data.toString());
        commands.push(command);
        send({ type: "ack", id: command.id, command: command.cmd });
        send({ type: "result", id: command.id, result: failures.has(command.cmd)
          ? { ok: false, error: { code: failures.get(command.cmd), message: "Synthetic failure" } }
          : { ok: true, data: { paused: command.cmd === "pause", holeQpc: 1234 } } });
        callback();
      } });
      proc.kill = () => { proc.stdout.end(); proc.emit("exit", 0, null); };
      setImmediate(() => send({ type: "hello", name: "audio-capture-helper", version: constants.HELPER_VERSION,
        protocol_version: 1, capabilities: [...constants.requiredCapabilitiesForPlatform(platform),
          ...(systemOnly ? [constants.SYSTEM_ONLY_CAPABILITY] : [])] }));
      return proc;
    }
  };
}

async function run() {
  for (const platform of ["win32", "darwin"]) {
    await test(`${platform}: supervisor sends only a system track, protects mode identity and forwards faults`, async () => {
      const fake = fixture(platform);
      const sup = createAudioCaptureSupervisor({ platform, helperPath: __filename, sessionRoot: temp,
        spawnImpl: fake.spawnImpl });
      try {
        await sup.configure();
        const fields = { sessionId: "system-session", outputDir: path.join(temp, platform, "system") };
        await sup.startSystemCapture(fields);
        const command = fake.commands.find(c => c.cmd === "start");
        assert.equal(command.capture_mode, "system");
        assert.equal(command.track, "system");
        assert.equal(command.microphone, undefined);
        assert.equal(fake.commands.some(c => c.cmd === "query_devices"), false);
        assert.equal(sup.getState().activeCaptureMode, "system");
        assert.equal(sup.getState().activeSystemOutputDir, command.output_dir);
        assert.equal((await sup.startSystemCapture(fields)).idempotent, true);
        await assert.rejects(sup.startCapture(fields), { code: "already_capturing" });
        assert.equal(fake.commands.filter(c => c.cmd === "start").length, 1);
        assert.equal((await sup.pause()).ok, true);
        assert.equal((await sup.resume()).ok, true);
        const received = [];
        sup.onMessage(m => received.push(m));
        fake.send({ type: "progress", session_id: fields.sessionId, track: "system", event: "subchunk_sealed", detail: { seq: 1 } });
        fake.send({ type: "progress", session_id: fields.sessionId, track: "system", event: "session_fault", detail: { code: "disk_full" } });
        assert.equal(received.length, 2);
        assert.equal(sup.getState().sessionFaulted, true);
        await sup.stopCapture();
        assert.equal(sup.getState().activeCaptureMode, null);
      } finally { await sup.shutdown(); }
    });

    await test(`${platform}: legacy helpers cannot fall back to microphone for system-only`, async () => {
      const fake = fixture(platform, false);
      const sup = createAudioCaptureSupervisor({ platform, helperPath: __filename, sessionRoot: temp, spawnImpl: fake.spawnImpl });
      try {
        await sup.configure();
        await assert.rejects(sup.startSystemCapture({ sessionId: "legacy", outputDir: path.join(temp, "legacy") }),
          { code: "helper_capability_missing" });
        assert.equal(fake.commands.some(c => c.cmd === "start"), false);
        await sup.startCapture({ sessionId: "mic", outputDir: path.join(temp, "mic") });
        assert.equal(fake.commands.find(c => c.cmd === "start").track, "microphone");
      } finally { await sup.shutdown(); }
    });

    for (const captureMode of ["microphone", "dual", "system"]) {
      await test(`${platform}: service.start ${captureMode}, pause/resume and persisted lifecycle`, async () => {
        const fake = fixture(platform);
        const service = createMeetingCaptureService({ userDataPath: path.join(temp, platform, captureMode),
          platform, helperPath: __filename, spawnImpl: fake.spawnImpl });
        try {
          await assert.rejects(service.start({ captureMode: "unknown" }), { code: "invalid_capture_mode" });
          assert.equal(fake.commands.length, 0);
          const { sessionId } = await service.createAndPrepareSession();
          const fields = { sessionId, captureMode, deviceId: "mic-input", systemDeviceId: "system-output", subchunkMs: 200 };
          const started = await service.start(fields);
          assert.equal(started.captureMode, captureMode);
          const start = fake.commands.find(c => c.cmd === "start");
          assert.equal(start.subchunk_ms, 200);
          if (captureMode === "system") {
            assert.equal(start.microphone, undefined);
            assert.equal(start.device_id, "system-output");
            assert.deepEqual(Object.keys(started.tracks), ["system"]);
            const saved = await service.store.readSession(sessionId);
            assert.equal(saved.session.captureMode, "system");
            assert.equal(saved.session.tracks.microphone.status, "idle");
            assert.deepEqual(fs.readdirSync(service.store.getMicrophoneTrackDir(saved.sessionDir)), []);
          }
          const before = fake.commands.length;
          await assert.rejects(service.pause("unrelated-session"), { code: "session_mismatch" });
          assert.equal(fake.commands.length, before);
          fake.failures.set("pause", "pause_failed");
          assert.equal((await service.pause(sessionId)).ok, false);
          assert.equal(service.getLifecycle().status, "recording");
          fake.failures.clear();
          assert.equal((await service.pause(sessionId)).holeQpc, 1234);
          assert.equal((await service.store.readSession(sessionId)).session.status, "paused");
          assert.equal((await service.start(fields)).idempotent, true);
          assert.equal(service.getLifecycle().status, "paused");
          assert.equal(service.getLifecycle().startedAtMs, started.startedAtMs);
          fake.failures.set("resume", "resume_failed");
          assert.equal((await service.resume()).ok, false);
          assert.equal(service.getLifecycle().status, "paused");
          fake.failures.clear();
          assert.equal((await service.resume()).paused, false);
          assert.equal((await service.store.readSession(sessionId)).session.status, "recording");
          assert.equal((await service.stop()).ok, true);
          await assert.rejects(service.resume(sessionId), { code: "not_started" });
        } finally { await service.shutdown(); }
      });
    }
  }
  console.log(`${passed} system-capture tests passed; synthetic fixtures retained: ${temp}`);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
