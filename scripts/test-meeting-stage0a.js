"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const {
  createSessionStore,
  parseIndexJsonl,
  buildRecoveryView,
  scanTrackDirectory
} = require("../src/meeting/session-store");
const { createAudioCaptureSupervisor } = require("../src/meeting/supervisor");
const { createMeetingCaptureService } = require("../src/meeting");
const {
  assertPathInsideRoot,
  isPathInsideRoot,
  resolveHelperPath,
  assertHelperReady,
  helperExists
} = require("../src/meeting/paths");
const {
  parseHelperLine,
  assertHelloCompatible,
  validateStartPathInput,
  buildCommand
} = require("../src/meeting/protocol");
const {
  HELPER_VERSION,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES
} = require("../src/meeting/constants");

const ROOT = path.resolve(__dirname, "..");
const FAKE_HELPER = path.join(ROOT, "scripts", "meeting", "fake-audio-capture-helper.js");

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      console.error(error);
      process.exitCode = 1;
      throw error;
    });
}

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-meeting-0b-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function stage0bHello(overrides = {}) {
  return {
    type: "hello",
    name: "audio-capture-helper",
    version: HELPER_VERSION,
    protocol_version: PROTOCOL_VERSION,
    capabilities: [...REQUIRED_CAPABILITIES],
    ...overrides
  };
}

function makeSupervisor(sessionsRoot, extra = {}) {
  return createAudioCaptureSupervisor({
    sessionRoot: sessionsRoot,
    requiredVersion: HELPER_VERSION,
    commandTimeoutMs: 5000,
    helperPath: FAKE_HELPER,
    spawnImpl: () =>
      spawn(process.execPath, [FAKE_HELPER], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FAKE_HELPER_VERSION: HELPER_VERSION }
      }),
    logger: () => {},
    ...extra
  });
}

async function run() {
  await test("protocol: parse and hello compatibility", () => {
    const hello = parseHelperLine(JSON.stringify(stage0bHello()));
    const ok = assertHelloCompatible(hello);
    assert.equal(ok.ok, true);
    const bad = assertHelloCompatible(
      stage0bHello({ version: "9.9.9" })
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "helper_version_mismatch");
    const cmd = buildCommand("ping");
    assert.equal(cmd.cmd, "ping");
    assert.ok(cmd.id);
  });

  await test("protocol: capability gate rejects missing dual_track", () => {
    const hello = stage0bHello({
      capabilities: REQUIRED_CAPABILITIES.filter((c) => c !== "dual_track")
    });
    const bad = assertHelloCompatible(hello);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "helper_capability_missing");
    assert.ok(bad.missing.includes("dual_track"));
  });

  await test("protocol: path deny patterns", () => {
    assert.equal(validateStartPathInput("../outside").ok, false);
    assert.equal(validateStartPathInput("foo/../../x").ok, false);
    assert.equal(validateStartPathInput("audio/microphone").ok, true);
  });

  await test("paths: canonical root guard", async () => {
    await withTempDir(async (dir) => {
      const inside = path.join(dir, "a", "b");
      fs.mkdirSync(inside, { recursive: true });
      assert.equal(isPathInsideRoot(dir, inside), true);
      assert.throws(() => assertPathInsideRoot(dir, path.join(dir, "..", "escape")), (err) => {
        return err.code === "path_denied" || /escapes|\.\./.test(err.message);
      });
      assert.throws(() => assertPathInsideRoot(dir, "../x"), (err) => err.code === "path_denied");
      const resolved = assertPathInsideRoot(dir, path.join("a", "b"));
      assert.ok(isPathInsideRoot(dir, resolved));
    });
  });

  await test("paths: windows junction escape denied", async () => {
    if (process.platform !== "win32") {
      console.log("  # skip - not windows");
      return;
    }
    await withTempDir(async (dir) => {
      const root = path.join(dir, "root");
      const outside = path.join(dir, "outside");
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      const link = path.join(root, "escape-link");
      let created = false;
      try {
        execFileSync("cmd.exe", ["/c", "mklink", "/J", link, outside], {
          stdio: "ignore",
          windowsHide: true
        });
        created = true;
      } catch {
        console.log("  # skip - mklink /J not permitted");
        return;
      }
      assert.ok(created);
      assert.throws(
        () => assertPathInsideRoot(root, path.join(link, "nested-track")),
        (err) => err.code === "path_denied"
      );
    });
  });

  await test("session scan: committed files authoritative over bad index tail", async () => {
    await withTempDir(async (dir) => {
      const trackDir = path.join(dir, "audio", "microphone");
      fs.mkdirSync(trackDir, { recursive: true });
      fs.writeFileSync(path.join(trackDir, "000001.l0.pcm"), Buffer.alloc(16));
      fs.writeFileSync(path.join(trackDir, "000002.l0.pcm"), Buffer.alloc(32));
      fs.writeFileSync(path.join(trackDir, "current.part"), Buffer.alloc(8));
      fs.writeFileSync(
        path.join(trackDir, "index.jsonl"),
        `${JSON.stringify({ seq: 1, file: "000001.l0.pcm", bytes: 16 })}\n` +
          `${JSON.stringify({ seq: 2, file: "000002.l0.pcm", bytes: 32 })}\n` +
          `{"seq":3,file:"broken-tail`
      );
      fs.writeFileSync(
        path.join(trackDir, "manifest.json"),
        JSON.stringify({
          archivePending: true,
          actualL0Format: { sampleRate: 44100, channels: 2, layer: "L0" }
        })
      );

      const parsed = parseIndexJsonl(fs.readFileSync(path.join(trackDir, "index.jsonl"), "utf8"));
      assert.equal(parsed.entries.length, 2);
      assert.ok(parsed.errors.length >= 1);

      const scan = await scanTrackDirectory(trackDir);
      assert.equal(scan.committed.length, 2);
      assert.ok(scan.partFile);
      assert.equal(scan.partFile.incomplete, true);

      const recovery = buildRecoveryView(scan);
      assert.equal(recovery.authoritativeCommitted.length, 2);
      assert.equal(recovery.archivePending, true);
      assert.equal(recovery.actualL0Format.sampleRate, 44100);
      assert.ok(recovery.recoverable);
    });
  });

  await test("session store: create dual dirs and scan", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ sessionsRoot: path.join(dir, "sessions") });
      const created = await store.createSession({ title: "t" });
      assert.ok(created.session.id);
      assert.ok(created.micDir);
      assert.ok(created.sysDir);
      assert.equal(created.session.stage, "0B");
      assert.equal(created.session.capabilities.dualTrack, true);
      fs.writeFileSync(path.join(created.micDir, "000001.l0.pcm"), Buffer.alloc(4));
      fs.writeFileSync(path.join(created.sysDir, "000001.l0.pcm"), Buffer.alloc(8));
      const scanned = await store.scanSession(created.session.id);
      assert.equal(scanned.microphone.committed.length, 1);
      assert.equal(scanned.system.committed.length, 1);
      assert.equal(scanned.dualRecovery.committedCount, 2);
      const listed = await store.listSessions();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].title, "t");
      assert.equal(listed[0].sessionDir, undefined);
      assert.equal(listed[0].transcript, undefined);
      assert.ok(!("path" in listed[0]));
    });
  });

  await test("listSessionsSafe: title present, paths/transcript absent", async () => {
    await withTempDir(async (dir) => {
      const longTitle = `会议${"标".repeat(220)}`;
      const service = createMeetingCaptureService({
        userDataPath: dir,
        isPackaged: false,
        appRoot: ROOT,
        helperPath: FAKE_HELPER
      });
      const created = await service.store.createSession({ title: longTitle });
      const sessionId = created.session.id;
      assert.ok(sessionId);
      const listed = await service.listSessions();
      assert.equal(listed.length, 1);
      assert.ok(typeof listed[0].title === "string");
      assert.ok(listed[0].title.length <= 200);
      assert.ok(listed[0].title.startsWith("会议"));
      assert.equal(listed[0].id, sessionId);
      assert.equal(listed[0].sessionDir, undefined);
      assert.equal(listed[0].transcript, undefined);
      assert.equal(listed[0].path, undefined);
      const keys = Object.keys(listed[0]).sort();
      for (const k of ["id", "title", "status", "createdAt", "updatedAt"]) {
        assert.ok(keys.includes(k), `missing ${k}`);
      }
      assert.ok(!keys.includes("sessionDir"));
      assert.ok(!keys.includes("transcript"));
      assert.ok(!keys.includes("micDir"));
      const blob = JSON.stringify(listed[0]);
      assert.equal(blob.includes("transcript"), false);
      assert.equal(blob.includes(path.join(dir, "sessions")), false);
    });
  });

  await test("supervisor: fake helper ACK, result, idempotent stop/start", async () => {
    await withTempDir(async (dir) => {
      const sessionsRoot = path.join(dir, "sessions");
      fs.mkdirSync(sessionsRoot, { recursive: true });
      const micDir = path.join(sessionsRoot, "s1", "audio", "microphone");
      fs.mkdirSync(micDir, { recursive: true });

      const supervisor = makeSupervisor(sessionsRoot);
      assert.equal(helperExists(FAKE_HELPER), true);

      const started = await supervisor.start();
      assert.equal(started.started, true);
      assert.equal(started.hello.version, HELPER_VERSION);
      assert.ok(started.hello.capabilities.includes("dual_track"));

      const cfg = await supervisor.configure({ root: sessionsRoot, pid: process.pid });
      assert.equal(cfg.ok, true);
      assert.ok(cfg.ack);
      assert.equal(cfg.result.result.data.jobObject, false);

      const ping = await supervisor.ping();
      assert.equal(ping.ok, true);
      assert.ok(ping.ack);
      assert.equal(ping.ack.command, "ping");

      const start1 = await supervisor.startCapture({ sessionId: "s1", outputDir: micDir });
      assert.equal(start1.ok, true);
      assert.ok(start1.ack);

      const start2 = await supervisor.startCapture({ sessionId: "s1", outputDir: micDir });
      assert.equal(start2.ok, true);
      assert.equal(start2.idempotent, true);

      const busy = await supervisor
        .startCapture({ sessionId: "s2", outputDir: micDir })
        .then(
          () => null,
          (error) => error
        );
      assert.ok(busy);
      assert.equal(busy.code, "already_capturing");

      await supervisor.stopCapture();
      const denied = await supervisor
        .startCapture({ sessionId: "s2", outputDir: path.join(dir, "outside") })
        .then(
          () => null,
          (error) => error
        );
      assert.ok(denied);
      assert.ok(
        denied.code === "path_denied" ||
          denied.code === "start_failed" ||
          /escapes|path/i.test(denied.message)
      );

      const helperDenied = await supervisor.sendCommand("start", {
        session_id: "evil",
        track: "microphone",
        output_dir: path.join(dir, "..", "escape-out")
      });
      assert.equal(helperDenied.ok, false);
      assert.equal(helperDenied.error.code, "path_denied");

      const stop1 = await supervisor.stopCapture();
      assert.equal(stop1.ok, true);
      const stop2 = await supervisor.stopCapture();
      assert.equal(stop2.ok, true);

      await supervisor.shutdown();
    });
  });

  await test("supervisor: dual start single RPC + idempotent + already_capturing", async () => {
    await withTempDir(async (dir) => {
      const sessionsRoot = path.join(dir, "sessions");
      const mic = path.join(sessionsRoot, "d1", "audio", "microphone");
      const sys = path.join(sessionsRoot, "d1", "audio", "system");
      fs.mkdirSync(mic, { recursive: true });
      fs.mkdirSync(sys, { recursive: true });
      const supervisor = makeSupervisor(sessionsRoot);
      await supervisor.start();
      await supervisor.configure({ root: sessionsRoot, pid: process.pid });

      const start1 = await supervisor.startDualCapture({
        sessionId: "d1",
        microphoneOutputDir: mic,
        systemOutputDir: sys
      });
      assert.equal(start1.ok, true);
      assert.equal(start1.result.result.data.captureMode, "dual");

      const start2 = await supervisor.startDualCapture({
        sessionId: "d1",
        microphoneOutputDir: mic,
        systemOutputDir: sys
      });
      assert.equal(start2.ok, true);
      assert.equal(start2.idempotent, true);

      const busy = await supervisor
        .startDualCapture({
          sessionId: "d2",
          microphoneOutputDir: path.join(sessionsRoot, "d2", "audio", "microphone"),
          systemOutputDir: path.join(sessionsRoot, "d2", "audio", "system")
        })
        .then(
          () => null,
          (e) => e
        );
      assert.ok(busy);
      assert.equal(busy.code, "already_capturing");

      const pause = await supervisor.pause();
      assert.equal(pause.ok, true);
      assert.ok(pause.result.result.data.holeQpc != null);
      const resume = await supervisor.resume();
      assert.equal(resume.ok, true);

      await supervisor.stopCapture();
      await supervisor.shutdown();
    });
  });

  await test("supervisor: bad render device leaves recording=false", async () => {
    await withTempDir(async (dir) => {
      const sessionsRoot = path.join(dir, "sessions");
      const mic = path.join(sessionsRoot, "bad", "audio", "microphone");
      const sys = path.join(sessionsRoot, "bad", "audio", "system");
      fs.mkdirSync(mic, { recursive: true });
      fs.mkdirSync(sys, { recursive: true });
      const supervisor = makeSupervisor(sessionsRoot);
      await supervisor.start();
      await supervisor.configure({ root: sessionsRoot, pid: process.pid });
      const err = await supervisor
        .startDualCapture({
          sessionId: "bad",
          microphoneOutputDir: mic,
          systemOutputDir: sys,
          systemDeviceId: "bad-render-device"
        })
        .then(
          () => null,
          (e) => e
        );
      assert.ok(err);
      assert.equal(err.code, "start_failed");
      if (fs.existsSync(path.join(sys, "manifest.json"))) {
        const m = JSON.parse(fs.readFileSync(path.join(sys, "manifest.json"), "utf8"));
        assert.equal(m.recording, false);
      }
      await supervisor.shutdown();
    });
  });

  await test("supervisor: helper already_capturing for different session", async () => {
    await withTempDir(async (dir) => {
      const sessionsRoot = path.join(dir, "sessions");
      const mic1 = path.join(sessionsRoot, "a", "audio", "microphone");
      const mic2 = path.join(sessionsRoot, "b", "audio", "microphone");
      fs.mkdirSync(mic1, { recursive: true });
      fs.mkdirSync(mic2, { recursive: true });
      const supervisor = makeSupervisor(sessionsRoot);
      await supervisor.start();
      await supervisor.configure({ root: sessionsRoot, pid: process.pid });
      await supervisor.startCapture({ sessionId: "a", outputDir: mic1 });
      const raw = await supervisor.sendCommand("start", {
        session_id: "b",
        track: "microphone",
        output_dir: mic2
      });
      assert.equal(raw.ok, false);
      assert.equal(raw.error.code, "already_capturing");
      await supervisor.shutdown();
    });
  });

  await test("supervisor: version mismatch rejects", async () => {
    await withTempDir(async () => {
      const supervisor = createAudioCaptureSupervisor({
        helperPath: FAKE_HELPER,
        requiredVersion: "0.2.0",
        commandTimeoutMs: 5000,
        spawnImpl: () =>
          spawn(process.execPath, [FAKE_HELPER], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, FAKE_HELPER_VERSION: "0.0.1" }
          })
      });
      await assert.rejects(() => supervisor.start(), (err) => err.code === "helper_version_mismatch");
      await supervisor.shutdown();
    });
  });

  await test("service lifecycle: available vs implemented when helper missing", async () => {
    await withTempDir(async (dir) => {
      const missing = path.join(dir, "no-helper.exe");
      const service = createMeetingCaptureService({
        userDataPath: path.join(dir, "ud"),
        helperPath: missing,
        appRoot: dir
      });
      const life = service.getLifecycle();
      assert.equal(life.stage, "0B");
      assert.equal(life.implemented.microphoneCaptureHelper, true);
      assert.equal(life.implemented.dualTrack, true);
      assert.equal(life.implemented.systemLoopback, true);
      assert.equal(life.available.microphoneCaptureHelper, false);
      assert.equal(life.available.reason, "helper_missing");
      await assert.rejects(() => service.ensureReady(), (err) => err.code === "helper_missing");
    });
  });

  await test("service: create/start/pause/resume/stop with fake helper", async () => {
    await withTempDir(async (dir) => {
      const service = createMeetingCaptureService({
        userDataPath: path.join(dir, "ud"),
        helperPath: FAKE_HELPER,
        appRoot: dir
      });
      const sup = createAudioCaptureSupervisor({
        sessionRoot: service.store.sessionsRoot,
        helperPath: FAKE_HELPER,
        requiredVersion: HELPER_VERSION,
        commandTimeoutMs: 5000,
        spawnImpl: () =>
          spawn(process.execPath, [FAKE_HELPER], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, FAKE_HELPER_VERSION: HELPER_VERSION }
          })
      });
      await service.store.init();
      const created = await service.store.createSession({ title: "demo" });
      await sup.start();
      await sup.configure({ root: service.store.sessionsRoot, pid: process.pid });
      const micDir = service.store.getMicrophoneTrackDir(created.sessionDir);
      const sysDir = service.store.getSystemTrackDir(created.sessionDir);
      const start = await sup.startDualCapture({
        sessionId: created.session.id,
        microphoneOutputDir: micDir,
        systemOutputDir: sysDir
      });
      assert.equal(start.ok, true);
      const pause = await sup.pause();
      assert.equal(pause.ok, true);
      const resume = await sup.resume();
      assert.equal(resume.ok, true);
      const stop = await sup.stopCapture();
      assert.equal(stop.ok, true);
      await sup.shutdown();
      await service.shutdown();
    });
  });

  await test("packaging paths: missing release helper fails assert", () => {
    const missing = path.join(
      ROOT,
      "native",
      "audio-capture-helper",
      "target",
      "release",
      "no-such-helper.exe"
    );
    assert.equal(helperExists(missing), false);
    assert.throws(() => assertHelperReady(missing), (err) => err.code === "helper_missing");

    const devPath = resolveHelperPath({
      isPackaged: false,
      appRoot: ROOT,
      resourcesPath: ""
    });
    assert.ok(devPath.includes("audio-capture-helper"));

    const pkgPath = resolveHelperPath({
      isPackaged: true,
      appRoot: ROOT,
      resourcesPath: path.join(ROOT, "resources-fake")
    });
    assert.equal(pkgPath, path.join(ROOT, "resources-fake", "native", "audio-capture-helper.exe"));
  });

  await test("supervisor: hang prepare returns bounded + recoverable", async () => {
    await withTempDir(async (dir) => {
      const sessionsRoot = path.join(dir, "sessions");
      const mic = path.join(sessionsRoot, "h", "audio", "microphone");
      const sys = path.join(sessionsRoot, "h", "audio", "system");
      fs.mkdirSync(mic, { recursive: true });
      fs.mkdirSync(sys, { recursive: true });
      const supervisor = createAudioCaptureSupervisor({
        sessionRoot: sessionsRoot,
        requiredVersion: HELPER_VERSION,
        commandTimeoutMs: 2000,
        helperPath: FAKE_HELPER,
        spawnImpl: () =>
          spawn(process.execPath, [FAKE_HELPER], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              FAKE_HELPER_VERSION: HELPER_VERSION,
              FAKE_HELPER_HANG_PREPARE: "1",
              FAKE_HELPER_HANG_MS: "100"
            }
          })
      });
      await supervisor.start();
      await supervisor.configure({ root: sessionsRoot, pid: process.pid });
      const t0 = Date.now();
      const err = await supervisor
        .startDualCapture({
          sessionId: "h",
          microphoneOutputDir: mic,
          systemOutputDir: sys
        })
        .then(
          () => null,
          (e) => e
        );
      const elapsed = Date.now() - t0;
      assert.ok(err, "should fail");
      assert.ok(elapsed < 5000, `bounded fail elapsed=${elapsed}`);
      // recoverable: stop/shutdown ok
      await supervisor.stopCapture();
      await supervisor.shutdown();
    });
  });

  await test("supervisor: session_fault progress updates fault handler", async () => {
    await withTempDir(async (dir) => {
      const sessionsRoot = path.join(dir, "sessions");
      const mic = path.join(sessionsRoot, "f", "audio", "microphone");
      const sys = path.join(sessionsRoot, "f", "audio", "system");
      fs.mkdirSync(mic, { recursive: true });
      fs.mkdirSync(sys, { recursive: true });
      const supervisor = makeSupervisor(sessionsRoot);
      const faults = [];
      supervisor.onFault((m) => faults.push(m));
      await supervisor.start();
      await supervisor.configure({ root: sessionsRoot, pid: process.pid });
      await supervisor.startDualCapture({
        sessionId: "f",
        microphoneOutputDir: mic,
        systemOutputDir: sys
      });
      const inj = await supervisor.sendCommand("inject_fault");
      assert.equal(inj.ok, true);
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(faults.some((f) => f.event === "session_fault"));
      assert.equal(supervisor.getState().sessionFaulted, true);
      await supervisor.shutdown();
    });
  });

  await test("supervisor: dual pause holes begin/end once per track (fake journal)", async () => {
    await withTempDir(async (dir) => {
      const sessionsRoot = path.join(dir, "sessions");
      const mic = path.join(sessionsRoot, "p", "audio", "microphone");
      const sys = path.join(sessionsRoot, "p", "audio", "system");
      fs.mkdirSync(mic, { recursive: true });
      fs.mkdirSync(sys, { recursive: true });
      const supervisor = makeSupervisor(sessionsRoot);
      await supervisor.start();
      await supervisor.configure({ root: sessionsRoot, pid: process.pid });
      await supervisor.startDualCapture({
        sessionId: "p",
        microphoneOutputDir: mic,
        systemOutputDir: sys
      });
      await supervisor.pause();
      await supervisor.resume();
      await supervisor.stopCapture();
      function countHoles(trackDir, reason) {
        const j = path.join(trackDir, "journal.jsonl");
        if (!fs.existsSync(j)) return 0;
        return fs
          .readFileSync(j, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter((x) => x && x.kind === "hole" && x.detail?.reason === reason).length;
      }
      assert.equal(countHoles(mic, "pause_begin"), 1);
      assert.equal(countHoles(mic, "pause_end"), 1);
      assert.equal(countHoles(sys, "pause_begin"), 1);
      assert.equal(countHoles(sys, "pause_end"), 1);
      const totalPause = ["pause_begin", "pause_end", "pause_discard"].reduce(
        (n, r) => n + countHoles(mic, r) + countHoles(sys, r),
        0
      );
      assert.ok(totalPause <= 6, `pause holes total=${totalPause}`);
      await supervisor.shutdown();
    });
  });

  await test("rust persist unit test source present", () => {
    const persist = fs.readFileSync(
      path.join(ROOT, "native", "audio-capture-helper", "src", "persist.rs"),
      "utf8"
    );
    assert.ok(persist.includes("seals_multiple_subchunks_to_committed_files"));
    assert.ok(persist.includes("seal_current_part"));
    assert.ok(persist.includes("l0_chunk_v1"));
    assert.ok(persist.includes("abort_preparing"));
    assert.ok(persist.includes("000001.l0.pcm"));
    const toolchain = fs.readFileSync(
      path.join(ROOT, "native", "audio-capture-helper", "rust-toolchain.toml"),
      "utf8"
    );
    assert.ok(toolchain.includes("1.85.1"));
    const protocol = fs.readFileSync(
      path.join(ROOT, "native", "audio-capture-helper", "src", "protocol.rs"),
      "utf8"
    );
    assert.ok(protocol.includes('0.2.0'));
    assert.ok(protocol.includes("dual_track"));
  });

  if (process.exitCode) {
    console.error(`\nMeeting Stage 0B tests failed (${passed} passed before failure).`);
    process.exit(1);
  }
  console.log(`\nAll meeting Stage 0B tests passed (${passed}).`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
