"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createSessionStore } = require("../src/meeting/session-store");
const {
  createMeetingSessionProcessor,
  buildHelperReadyErrorResponse,
  assertValidSessionId
} = require("../src/meeting/processing/session-processor");
const {
  resolveMeetingQwenCredentials,
  assertMeetingCompatibleBaseUrl
} = require("../src/meeting/processing/meeting-credentials");
const {
  toProcessStatusDto,
  toTranscriptDto,
  sanitizeIpcError
} = require("../src/meeting/processing/sanitize-ipc");
const { JOB_STATUS, SEGMENT_STATUS } = require("../src/meeting/transcription/constants");
const { createNoBucketMeetingTranscriptionService } = require("../src/meeting/transcription/no-bucket-service");

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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-meeting-2b-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function writePcm16Mono(frames, sample) {
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) buf.writeInt16LE(sample, i * 2);
  return buf;
}

async function seedL0Track(trackDir, { track, role, frames = 16000, sampleRate = 16000, sessionId = "mtg" } = {}) {
  await fsp.mkdir(trackDir, { recursive: true });
  const format = {
    sampleRate,
    channels: 1,
    bitsPerSample: 16,
    blockAlign: 2,
    formatTag: 1,
    subFormat: "WAVE_FORMAT_PCM",
    layer: "L0"
  };
  const payload = writePcm16Mono(frames, 100);
  const name = "000001.l0.pcm";
  await fsp.writeFile(path.join(trackDir, name), payload);
  await fsp.writeFile(
    path.join(trackDir, "index.jsonl"),
    `${JSON.stringify({
      schema: "l0_chunk_v1",
      seq: 1,
      file: name,
      bytes: payload.length,
      frames,
      frameStart: 0,
      frameEnd: frames,
      qpcStart: 0,
      qpcEnd: frames,
      sessionOriginQpc: 0,
      qpcFrequency: 1000,
      track,
      role,
      format
    })}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(trackDir, "manifest.json"),
    JSON.stringify({
      schema: "l0_track_manifest_v1",
      sessionId,
      track,
      role,
      recording: false,
      archivePending: true,
      actualL0Format: format
    }),
    "utf8"
  );
}

function makeFakeCapture({ store, lifecycle = { status: "stopped", sessionId: null } }) {
  let life = { ...lifecycle };
  return {
    store,
    getLifecycle: () => ({ ...life }),
    setLifecycle: (l) => {
      life = { ...life, ...l };
    },
    listSessions: () => store.listSessions(),
    scanSession: async (id) => {
      const scanned = await store.scanSession(id);
      if (!scanned) return null;
      return {
        id: scanned.session.id,
        status: scanned.session.status,
        recovery: scanned.recovery,
        tracks: {
          microphone: {
            committedCount: scanned.microphone?.committed?.length || 0,
            role: scanned.microphone?.manifest?.role || "self"
          },
          system: {
            committedCount: scanned.system?.committed?.length || 0,
            role: scanned.system?.manifest?.role || "remote_mix_for_diarization"
          }
        }
      };
    },
    stop: async (sessionId) => {
      life = { status: "stopped", sessionId };
      if (sessionId) await store.updateSession(sessionId, { status: "stopped" });
      return { ok: true, sessionId, stopped: true };
    }
  };
}

function makeProcessor(dir, capture, { createTranscribeSegment, resolveCredentials, cancelWaitMs } = {}) {
  return createMeetingSessionProcessor({
    userDataPath: dir,
    getCaptureService: () => capture,
    cancelWaitMs: cancelWaitMs || 8000,
    resolveCredentials:
      resolveCredentials ||
      (() => ({
        apiKey: "test-key",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelId: "qwen3-asr-flash"
      })),
    createTranscribeSegment:
      createTranscribeSegment ||
      (() => async () => ({ text: "ok" }))
  });
}

async function run() {
  await test("credentials + invalid session id", () => {
    const creds = resolveMeetingQwenCredentials({
      env: {
        OVI_MEETING_QWEN_API_KEY: "test-key-not-real",
        OVI_MEETING_DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
      }
    });
    assert.ok(creds.baseUrl.includes("compatible-mode"));
    assert.throws(
      () =>
        resolveMeetingQwenCredentials({
          env: {
            OVI_MEETING_QWEN_API_KEY: "k",
            OVI_MEETING_DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/api/v1"
          }
        }),
      (e) => e.code === "meeting_base_url_invalid"
    );
    assert.throws(() => assertValidSessionId("a/../b"), (e) => e.code === "invalid_session_id");
    assert.throws(() => assertValidSessionId("a b"), (e) => e.code === "invalid_session_id");
    assert.equal(assertValidSessionId("mtg-ok_1.2"), "mtg-ok_1.2");
  });

  await test("helper ready error scrubbed (no path)", () => {
    const err = new Error("helper missing at D:\\app\\native\\audio-capture-helper.exe");
    err.code = "helper_missing";
    err.helperPath = "D:\\app\\native\\audio-capture-helper.exe";
    const res = buildHelperReadyErrorResponse(err);
    assert.equal(res.ok, false);
    assert.equal(res.helperAvailable, false);
    const s = JSON.stringify(res);
    assert.ok(!s.includes("D:\\"));
    assert.ok(!s.includes("audio-capture-helper.exe"));
    assert.ok(!s.includes("helperPath"));
  });

  await test("stop zero ASR; mic-only; dual; wrong URL zero ASR", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const created = await store.createSession({ title: "t" });
      const sid = created.session.id;
      await store.updateSession(sid, { status: "stopped" });
      await seedL0Track(created.micDir, { track: "microphone", role: "self", sessionId: sid, frames: 8000 });

      let asrCalls = 0;
      const capture = makeFakeCapture({ store, lifecycle: { status: "stopped", sessionId: sid } });
      await capture.stop(sid);
      assert.equal(asrCalls, 0);

      const processor = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async ({ audioDataUrl }) => {
          asrCalls += 1;
          assert.ok(String(audioDataUrl).startsWith("data:audio/"));
          return { text: "hello" };
        }
      });
      const st = await processor.processSession(sid);
      assert.equal(st.stage, "completed");
      assert.equal(st.tracks.microphone, "exported");
      assert.ok(asrCalls >= 1);
      assert.ok(st.transcription.segmentTotal >= 1);

      // wrong URL — zero ASR
      let badCalls = 0;
      const bad = makeProcessor(dir, capture, {
        resolveCredentials: () => {
          assertMeetingCompatibleBaseUrl("https://dashscope.aliyuncs.com/api/v1");
        },
        createTranscribeSegment: () => async () => {
          badCalls += 1;
          return { text: "nope" };
        }
      });
      const cBad = await store.createSession({ title: "badurl" });
      await store.updateSession(cBad.session.id, { status: "stopped" });
      await seedL0Track(cBad.micDir, {
        track: "microphone",
        role: "self",
        sessionId: cBad.session.id
      });
      await assert.rejects(() => bad.processSession(cBad.session.id), (e) => e.code === "meeting_base_url_invalid");
      assert.equal(badCalls, 0);

      // dual
      const c2 = await store.createSession({ title: "d" });
      await store.updateSession(c2.session.id, { status: "stopped" });
      await seedL0Track(c2.micDir, { track: "microphone", role: "self", sessionId: c2.session.id });
      await seedL0Track(c2.sysDir, {
        track: "system",
        role: "remote_mix_for_diarization",
        sessionId: c2.session.id
      });
      const st2 = await processor.processSession(c2.session.id);
      assert.equal(st2.tracks.system, "exported");
      const tr2 = await processor.getRawTranscript(c2.session.id);
      assert.ok(tr2.items.some((i) => i.speakerId === "remote_unknown"));
    });
  });

  await test("same-session race; true cross-session overlap", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const a = await store.createSession({ title: "a" });
      const b = await store.createSession({ title: "b" });
      for (const c of [a, b]) {
        await store.updateSession(c.session.id, { status: "stopped" });
        await seedL0Track(c.micDir, {
          track: "microphone",
          role: "self",
          sessionId: c.session.id
        });
      }
      const capture = makeFakeCapture({ store });
      let inFlight = 0;
      let maxInFlight = 0;
      const gates = new Map();
      const processor = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async ({ track, seq }) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const key = `${track}-${seq}-${inFlight}`;
          await new Promise((r) => {
            gates.set(key, r);
            // auto-release shortly so test ends
            setTimeout(r, 40);
          });
          inFlight -= 1;
          return { text: "x" };
        }
      });

      const pA = processor.processSession(a.session.id);
      const pA2 = processor.processSession(a.session.id);
      const pB = processor.processSession(b.session.id);
      const settled = await Promise.allSettled([pA, pA2, pB]);
      const rejected = settled.filter((s) => s.status === "rejected");
      assert.ok(rejected.some((r) => r.reason.code === "process_already_running"));
      assert.ok(maxInFlight >= 2, `expected concurrent ASR, maxInFlight=${maxInFlight}`);
      assert.equal(settled.filter((s) => s.status === "fulfilled").length, 2);
    });
  });

  await test("restart: disk RUNNING + valid result → new processor zero ASR", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const c = await store.createSession({ title: "rs" });
      await store.updateSession(c.session.id, { status: "stopped" });
      await seedL0Track(c.micDir, { track: "microphone", role: "self", sessionId: c.session.id });
      const capture = makeFakeCapture({ store });
      let calls = 0;
      const p1 = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async () => {
          calls += 1;
          return { text: "keep-me-exact" };
        }
      });
      await p1.processSession(c.session.id);
      assert.equal(calls, 1);

      const nb = createNoBucketMeetingTranscriptionService({
        sessionDir: path.join(store.sessionsRoot, c.session.id),
        sessionId: c.session.id,
        transcribeSegment: async () => ({ text: "no" })
      });
      const job = await nb.store.loadJob();
      const seg = job.tracks.microphone.segments[0];
      const attemptsBefore = 2;
      seg.status = SEGMENT_STATUS.RUNNING;
      seg.attempts = attemptsBefore;
      job.status = JOB_STATUS.RUNNING;
      await nb.store.saveJob(job);

      calls = 0;
      const p2 = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async () => {
          calls += 1;
          return { text: "REBILL" };
        }
      });
      const beforeKeys = p2._handles.size;
      const st = await p2.getProcessStatus(c.session.id);
      assert.equal(p2._handles.size, beforeKeys);
      assert.ok(st.transcription.segmentTotal >= 1);

      await p2.processSession(c.session.id);
      assert.equal(calls, 0);
      const job2 = await nb.store.loadJob();
      assert.equal(job2.status, JOB_STATUS.COMPLETED);
      assert.equal(job2.tracks.microphone.segments[0].attempts, attemptsBefore);
      assert.equal((await p2.getRawTranscript(c.session.id)).items[0].text, "keep-me-exact");
    });
  });

  await test("FAILED same inputs need retry; model/source change prepares fresh", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const c = await store.createSession({ title: "fail" });
      await store.updateSession(c.session.id, { status: "stopped" });
      await seedL0Track(c.micDir, { track: "microphone", role: "self", sessionId: c.session.id });
      const capture = makeFakeCapture({ store });
      let calls = 0;
      const failP = makeProcessor(dir, capture, {
        resolveCredentials: () => ({
          apiKey: "k",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          modelId: "m1"
        }),
        createTranscribeSegment: () => async () => {
          calls += 1;
          const err = new Error("upstream");
          err.code = "upstream";
          throw err;
        }
      });
      await assert.rejects(() => failP.processSession(c.session.id), (e) => e.code === "upstream");
      assert.ok(calls >= 1);

      // same model/source → must not silent reset
      await assert.rejects(
        () => failP.processSession(c.session.id),
        (e) => e.code === "process_needs_retry"
      );

      // switch model m2 → processSession prepares fresh without retryProcess
      let m2Calls = 0;
      const m2P = makeProcessor(dir, capture, {
        resolveCredentials: () => ({
          apiKey: "k",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          modelId: "m2"
        }),
        createTranscribeSegment: () => async () => {
          m2Calls += 1;
          return { text: "from-m2" };
        }
      });
      const stM2 = await m2P.processSession(c.session.id);
      assert.equal(stM2.stage, "completed");
      assert.equal(m2Calls, 1);
      const trM2 = await m2P.getRawTranscript(c.session.id);
      assert.equal(trM2.items[0].text, "from-m2");
      assert.equal(trM2.modelId, "m2");

      // fail again then change source content → also fresh prepare
      const c2 = await store.createSession({ title: "srcchg" });
      await store.updateSession(c2.session.id, { status: "stopped" });
      await seedL0Track(c2.micDir, {
        track: "microphone",
        role: "self",
        sessionId: c2.session.id,
        frames: 4000
      });
      let fail2 = 0;
      const f2 = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async () => {
          fail2 += 1;
          const err = new Error("up");
          err.code = "upstream";
          throw err;
        }
      });
      await assert.rejects(() => f2.processSession(c2.session.id), (e) => e.code === "upstream");
      // rewrite L0 with different content (different frames → different SHA)
      await seedL0Track(c2.micDir, {
        track: "microphone",
        role: "self",
        sessionId: c2.session.id,
        frames: 9000
      });
      let okSrc = 0;
      const okP = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async () => {
          okSrc += 1;
          return { text: "new-source" };
        }
      });
      const stSrc = await okP.processSession(c2.session.id);
      assert.equal(stSrc.stage, "completed");
      assert.equal(okSrc, 1);
      assert.equal((await okP.getRawTranscript(c2.session.id)).items[0].text, "new-source");

      // same-input retry still works
      const c3 = await store.createSession({ title: "retry" });
      await store.updateSession(c3.session.id, { status: "stopped" });
      await seedL0Track(c3.micDir, { track: "microphone", role: "self", sessionId: c3.session.id });
      const f3 = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async () => {
          const err = new Error("up");
          err.code = "upstream";
          throw err;
        }
      });
      await assert.rejects(() => f3.processSession(c3.session.id));
      let okCalls = 0;
      const okR = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async () => {
          okCalls += 1;
          return { text: "recovered" };
        }
      });
      const st = await okR.retryProcess(c3.session.id, { resetAttempts: true });
      assert.equal(st.stage, "completed");
      assert.equal(okCalls, 1);
      assert.equal((await okR.getRawTranscript(c3.session.id)).items[0].text, "recovered");
    });
  });

  await test("cancel → CANCELLED → explicit retry exactly one ASR", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const c = await store.createSession({ title: "cx" });
      await store.updateSession(c.session.id, { status: "stopped" });
      await seedL0Track(c.micDir, {
        track: "microphone",
        role: "self",
        sessionId: c.session.id,
        frames: 8000
      });
      const capture = makeFakeCapture({ store });
      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      let asrEntered = false;
      let asrEnteredResolve;
      const asrEnteredP = new Promise((r) => {
        asrEnteredResolve = r;
      });
      const processor = makeProcessor(dir, capture, {
        cancelWaitMs: 5000,
        createTranscribeSegment: () => async ({ signal }) => {
          asrEntered = true;
          asrEnteredResolve();
          await gate;
          if (signal?.aborted) {
            const err = new Error("aborted");
            err.code = "aborted";
            throw err;
          }
          return { text: "late" };
        }
      });
      const runP = processor.processSession(c.session.id);
      // Cancel only after ASR is blocked inside the gated call (job is RUNNING)
      await Promise.race([
        asrEnteredP,
        new Promise((_, rej) => setTimeout(() => rej(new Error("ASR never entered")), 10000))
      ]);
      assert.equal(asrEntered, true);
      const cancelP = processor.cancelProcess(c.session.id);
      setTimeout(() => release(), 20);
      const [, cancelSt] = await Promise.all([runP, cancelP]);
      assert.equal(cancelSt.stage, "cancelled");
      const after = await processor.getProcessStatus(c.session.id);
      assert.equal(after.stage, "cancelled");

      const nb = createNoBucketMeetingTranscriptionService({
        sessionDir: path.join(store.sessionsRoot, c.session.id),
        sessionId: c.session.id,
        transcribeSegment: async () => ({ text: "no" })
      });
      const job = await nb.store.loadJob();
      assert.equal(job.status, JOB_STATUS.CANCELLED);

      // processSession must refuse
      await assert.rejects(
        () => processor.processSession(c.session.id),
        (e) => e.code === "process_needs_retry"
      );

      let n = 0;
      const p2 = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async () => {
          n += 1;
          return { text: "after-cancel" };
        }
      });
      const st = await p2.retryProcess(c.session.id, { resetAttempts: true });
      assert.equal(st.stage, "completed");
      assert.equal(n, 1);
      assert.equal((await p2.getRawTranscript(c.session.id)).items[0].text, "after-cancel");
    });
  });

  await test("cancel timeout cancelling lock; shutdown settles", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const c = await store.createSession({ title: "cto" });
      await store.updateSession(c.session.id, { status: "stopped" });
      await seedL0Track(c.micDir, { track: "microphone", role: "self", sessionId: c.session.id });
      const capture = makeFakeCapture({ store });

      // signal-ignoring provider: holds until external release; ignore AbortSignal
      let releaseHold;
      const hold = new Promise((r) => {
        releaseHold = r;
      });
      let asrEntered = false;
      const processor = makeProcessor(dir, capture, {
        cancelWaitMs: 40,
        createTranscribeSegment: () => async () => {
          asrEntered = true;
          await hold;
          // intentionally ignore signal — return success after hold
          return { text: "ignored-signal" };
        }
      });
      const runP = processor.processSession(c.session.id);
      for (let i = 0; i < 100 && !asrEntered; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(asrEntered, true);
      const cancelSt = await processor.cancelProcess(c.session.id);
      assert.equal(cancelSt.stage, "cancelling");
      await assert.rejects(
        () => processor.processSession(c.session.id),
        (e) => e.code === "process_cancelling" || e.code === "process_already_running"
      );
      await assert.rejects(
        () => processor.retryProcess(c.session.id),
        (e) => e.code === "process_cancelling" || e.code === "process_already_running"
      );
      releaseHold();
      await runP;
      const final = await processor.getProcessStatus(c.session.id);
      // Abort was signaled; 2A may mark cancelled on next throwIfAborted even if provider ignored signal.
      // Deterministic allowed set after settle (lock released).
      assert.ok(
        ["completed", "cancelled"].includes(final.stage),
        `expected completed|cancelled, got ${final.stage}`
      );
      const hDone = processor._handles.get(c.session.id);
      assert.equal(Boolean(hDone && hDone.runActive), false);
      assert.equal(Boolean(hDone && hDone.cancelling), false);

      // shutdown while active (signal-aware)
      const c3 = await store.createSession({ title: "sh" });
      await store.updateSession(c3.session.id, { status: "stopped" });
      await seedL0Track(c3.micDir, { track: "microphone", role: "self", sessionId: c3.session.id });
      let release2;
      const gate2 = new Promise((r) => {
        release2 = r;
      });
      const p3 = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async ({ signal }) => {
          await gate2;
          if (signal?.aborted) {
            const err = new Error("aborted");
            err.code = "aborted";
            throw err;
          }
          return { text: "x" };
        }
      });
      const run3 = p3.processSession(c3.session.id);
      await new Promise((r) => setTimeout(r, 15));
      const shut = p3.shutdown();
      release2();
      await Promise.allSettled([run3, shut]);
      await new Promise((r) => setTimeout(r, 20));
      const h = p3._handles.get(c3.session.id);
      assert.ok(!h || !h.runActive);
    });
  });

  await test("transcript >500 exact; getStatus leaves handles.size unchanged", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const c = await store.createSession({ title: "long" });
      await store.updateSession(c.session.id, { status: "stopped" });
      await seedL0Track(c.micDir, { track: "microphone", role: "self", sessionId: c.session.id });
      const longText = `Lead${"字".repeat(520)}Trail`;
      const capture = makeFakeCapture({ store });
      const processor = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async () => ({ text: longText })
      });
      const sizeBefore = processor._handles.size;
      await processor.getProcessStatus(c.session.id);
      assert.equal(processor._handles.size, sizeBefore);

      await processor.processSession(c.session.id);
      const tr = await processor.getRawTranscript(c.session.id);
      assert.equal(tr.items[0].text, longText);
      assert.ok(tr.items[0].text.startsWith("Lead"));
      assert.ok(tr.items[0].text.endsWith("Trail"));
      const st = await processor.getProcessStatus(c.session.id);
      assert.ok(!JSON.stringify(st).includes("Lead"));
      assert.ok(st.transcription.segmentCompleted >= 1);
      assert.ok(st.transcription.segmentTotal >= 1);
    });
  });

  await test("IPC privacy scrub", async () => {
    const err = sanitizeIpcError({
      code: "x",
      message: `fail C:\\Users\\x\\meeting-sessions\\a Bearer sk-abcdefgh token`
    });
    assert.ok(!JSON.stringify(err).includes("Bearer"));
    assert.ok(!JSON.stringify(err).includes("sk-"));
    assert.ok(!JSON.stringify(err).includes("C:\\"));
  });

  console.log(`\n${passed} tests passed`);
}

run().catch(() => {
  process.exitCode = 1;
});
