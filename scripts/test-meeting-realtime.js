"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createSessionStore } = require("../src/meeting/session-store");
const { createRealtimeMeetingService } = require("../src/meeting/realtime");
const { RATE, HEADER_BYTES, wavHeader, normalizeChunk } = require("../src/meeting/realtime/audio");
const { profileFor, transcriber, cleaner, meetingTransportFor } = require("../src/meeting/realtime/providers");
const { RAW_TRANSCRIPT_REL } = require("../src/meeting/analysis/constants");
const format = { sampleRate: RATE, channels: 1, bitsPerSample: 16, formatTag: 1, blockAlign: 2 };

async function setup(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ovi-live-test-"));
  const store = createSessionStore({ sessionsRoot: path.join(root, "sessions") });
  let active = null;
  let stops = 0;
  const capture = { store, getLifecycle: () => ({ status: active ? "recording" : "idle" }),
    createAndPrepareSession: async ({ title }) => ({ sessionId: (await store.createSession({ title })).session.id }),
    startMicrophone: async id => { active = id; return { ok: true }; },
    startDual: async id => { active = id; return { ok: true }; },
    stop: async () => { active = null; stops++; return { ok: true }; }
  };
  const calls = [];
  const api = createRealtimeMeetingService({ captureService: capture, getSettings: () => ({}),
    defaultDirectory: path.join(root, "notes"), segmentSeconds: 1, pumpIntervalMs: 60000, saveIntervalMs: 60000,
    transcribeImpl: async input => { calls.push(input.segmentIndex); return { text: `Original ${input.segmentIndex}.` }; },
    cleanImpl: async text => text, ...overrides });
  async function add(track, frames, seq = 1, options = {}) {
    const dir = path.join(store.sessionsRoot, api.status().sessionId, "audio", track);
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ actualL0Format: format }));
    const data = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) data.writeInt16LE(1234, i * 2);
    const file = `${String(seq).padStart(6, "0")}.l0.pcm`;
    await fs.writeFile(path.join(dir, file), data);
    if (!options.noIndex) await fs.appendFile(path.join(dir, "index.jsonl"), JSON.stringify({ seq, file, format, frameStart: options.start || 0 }) + "\n");
    return dir;
  }
  return { api, root, store, capture, calls, add, stops: () => stops };
}

async function main() {
  let count = 0;
  const test = async (name, fn) => { await fn(); console.log(`ok - ${name}`); count++; };
  await test("continuous archive, ordered segments, tail, separate cleanup", async () => {
    const x = await setup();
    try {
      await x.api.start({ captureMode: "microphone" }); await x.add("microphone", RATE * 2 + 400);
      await x.api.flush(); await x.api.waitForIdle(); assert.deepEqual(x.calls, [0, 1]);
      await x.api.stop(); await x.api.waitForIdle(); assert.deepEqual(x.calls, [0, 1, 2]);
      const dto = x.api.status(); assert.equal(dto.status, "completed"); assert.equal(x.stops(), 1);
      assert.equal((await fs.stat(dto.audioPaths[0])).size, HEADER_BYTES + (RATE * 2 + 400) * 2);
      const raw = await fs.readFile(dto.markdownPath, "utf8");
      assert.ok(raw.indexOf("Original 0") < raw.indexOf("Original 2"));
      await x.api.cleanup({ modelId: "fixture" }); await x.api.waitForIdle();
      assert.equal(x.api.status().cleanupStatus, "completed");
      assert.equal(await fs.readFile(dto.markdownPath, "utf8"), raw);
      const doc = JSON.parse(await fs.readFile(path.join(x.store.sessionsRoot, dto.sessionId, RAW_TRANSCRIPT_REL)));
      assert.equal(doc.items.length, 3); assert.equal(doc.diarization, false);
    } finally { await x.api.shutdown(); }
  });
  await test("history metadata and local reopening do not contact ASR", async () => {
    const x = await setup();
    try {
      await x.api.start({ captureMode: "microphone", modelId: "mimo-v2.5-asr" });
      await x.add("microphone", RATE + 200);
      await x.api.stop(); await x.api.waitForIdle();
      const firstId = x.api.status().sessionId;
      const callsAfterFirst = x.calls.length;
      await x.api.start({ captureMode: "microphone", modelId: "mimo-v2.5-asr" });
      await x.add("microphone", RATE * 2);
      await x.api.stop(); await x.api.waitForIdle();
      const callsBeforeHistory = x.calls.length;
      const listed = await x.api.listHistory();
      assert.equal(listed.recoverableSessions.length, 2);
      const first = listed.recoverableSessions.find(item => item.sessionId === firstId);
      assert.equal(first.modelId, "mimo-v2.5-asr");
      assert.equal(first.hasTranscript, true);
      assert.equal(first.hasCorrection, false);
      assert.ok(first.durationMs >= 1000);
      const opened = await x.api.openHistory({ sessionId: firstId });
      assert.equal(opened.sessionId, firstId);
      assert.equal(opened.rawText, "Original 0.\n\nOriginal 1.");
      assert.equal(x.calls.length, callsBeforeHistory, "opening history must not invoke ASR");
      assert.ok(callsBeforeHistory > callsAfterFirst);
      await x.api.cleanup({ sessionId: firstId, modelId: "fixture" });
      await x.api.waitForIdle();
      assert.equal(x.api.status().cleanupStatus, "completed");
      assert.equal(x.calls.length, callsBeforeHistory, "cleaning saved text must not invoke ASR");
      const refreshed = await x.api.listHistory();
      assert.equal(refreshed.recoverableSessions.find(item => item.sessionId === firstId).hasCorrection, true);
    } finally { await x.api.shutdown(); }
  });
  await test("MiMo fallback transport honors per-session transcription and autosave intervals", async () => {
    assert.equal(meetingTransportFor("mimo-v2.5-asr"), "mimo-batch");
    assert.equal(meetingTransportFor("qwen-audio-3.0-asr-flash-streaming"), "ali-streaming");
    assert.equal(meetingTransportFor("qwen3-asr-flash"), null);
    const x = await setup();
    try {
      await x.api.start({ captureMode: "microphone", modelId: "mimo-v2.5-asr",
        transcriptionIntervalSeconds: 2, saveIntervalSeconds: 0.02 });
      assert.equal(x.api.status().transport, "mimo-batch");
      assert.equal(x.api.status().transcriptionIntervalSeconds, 2);
      assert.equal(x.api.status().saveIntervalSeconds, 0.02);
      await x.add("microphone", RATE * 3);
      await x.api.flush();
      await x.api.waitForIdle();
      assert.deepEqual(x.calls, [0]);
      await x.api.stop();
      await x.api.waitForIdle();
      assert.deepEqual(x.calls, [0, 1]);
    } finally { await x.api.shutdown(); }
  });
  await test("production meeting routing creates the MiMo provider for the batch fallback", async () => {
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, text: async () => JSON.stringify({
        choices: [{ message: { content: "MiMo meeting segment" }, finish_reason: "stop" }]
      }) };
    };
    const x = await setup({
      transcribeImpl: undefined,
      getSettings: () => ({
        meetingRealtimeModel: "mimo-v2.5-asr",
        meetingFileAsrProfiles: {
          "mimo-v2.5-asr": { provider: "mimo", apiKey: "fixture", baseUrl: "https://example.invalid/v1" }
        }
      })
    });
    try {
      await x.api.start({ captureMode: "microphone", modelId: "mimo-v2.5-asr",
        transcriptionIntervalSeconds: 5 });
      await x.add("microphone", RATE);
      await x.api.stop();
      await x.api.waitForIdle();
      assert.equal(x.api.status().transport, "mimo-batch");
      assert.equal(x.api.status().rawText, "MiMo meeting segment");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, "mimo-v2.5-asr");
    } finally {
      await x.api.shutdown();
      global.fetch = originalFetch;
    }
  });
  await test("existing note and external edits preserved", async () => {
    const x = await setup();
    try {
      const existing = path.join(x.root, "existing.md"); await fs.writeFile(existing, "Original note");
      await x.api.start({ destinationPath: existing, captureMode: "microphone" });
      assert.equal(x.api.status().markdownPath, existing);
      assert.ok((await fs.readFile(existing, "utf8")).startsWith("Original note"));
      await fs.appendFile(existing, "\nExternal edit outside block"); await x.api.flush();
      assert.ok((await fs.readFile(existing, "utf8")).endsWith("External edit outside block"));
      const note = await fs.readFile(existing, "utf8");
      await fs.writeFile(existing, note.replace("## 原始转录", "## Edited inside block")); await x.api.flush();
      assert.equal(x.api.status().error.code, "live_save_failed");
      assert.ok((await fs.readFile(existing, "utf8")).includes("Edited inside block"));
      const edited = x.api.status().markdownPath;
      await assert.rejects(x.api.stop(), error => error.code === "live_save_failed");
      await assert.rejects(x.api.shutdown(), error => error.code === "live_save_failed");
      await x.api.retry(); await x.api.waitForIdle();
      assert.notEqual(x.api.status().markdownPath, edited);
      assert.ok((await fs.readFile(edited, "utf8")).includes("Edited inside block"));
    } finally { await x.api.shutdown(); }
  });
  await test("retry only failed ASR segments, no secret error persistence", async () => {
    let fail = true; const calls = [];
    const x = await setup({ maxAttempts: 1, transcribeImpl: async input => { calls.push(input.segmentIndex); if (fail && input.segmentIndex === 0) throw new Error("secret transport payload"); return { text: `result ${input.segmentIndex}` }; } });
    try {
      await x.api.start({ captureMode: "microphone" }); await x.add("microphone", RATE * 2);
      await x.api.stop(); await x.api.waitForIdle(); assert.equal(x.api.status().status, "needs_retry");
      assert.equal(x.api.status().failedSegments, 1); assert.ok(!JSON.stringify(x.api.status()).includes("secret transport"));
      fail = false; await x.api.retry(); await x.api.waitForIdle();
      assert.deepEqual(calls, [0, 1, 0]); assert.equal(x.api.status().status, "completed");
    } finally { await x.api.shutdown(); }
  });
  await test("dual-track ASR mixes one window and retains both full tracks", async () => {
    const x = await setup();
    try {
      await x.api.start(); await x.add("microphone", RATE); await x.add("system", RATE);
      await x.api.stop(); await x.api.waitForIdle(); assert.equal(x.calls.length, 1);
      assert.equal(x.api.status().audioPaths.length, 2);
    } finally { await x.api.shutdown(); }
  });
  await test("recover unindexed tail without resending successful ASR", async () => {
    const x = await setup(); let second;
    try {
      await x.api.start({ captureMode: "microphone" }); await x.add("microphone", RATE);
      await x.api.flush(); await x.api.waitForIdle(); await x.api.shutdown();
      await x.add("microphone", 300, 2, { noIndex: true });
      second = createRealtimeMeetingService({ captureService: x.capture, getSettings: () => ({}), defaultDirectory: path.join(x.root, "notes"), segmentSeconds: 1,
        transcribeImpl: async input => { x.calls.push(input.segmentIndex); return { text: "tail" }; } });
      await second.recover(); assert.deepEqual(x.calls, [0]);
      assert.equal((await fs.stat(second.status().audioPaths[0])).size, HEADER_BYTES + (RATE + 300) * 2);
      await second.retry(); await second.waitForIdle(); assert.deepEqual(x.calls, [0, 1]);
    } finally { if (second) await second.shutdown(); }
  });
  await test("concurrent start idempotent, cleanup blocked during recording", async () => {
    const x = await setup();
    try {
      const [a,b] = await Promise.all([x.api.start({ captureMode: "microphone" }), x.api.start()]);
      assert.equal(a.sessionId, b.sessionId); await assert.rejects(x.api.cleanup());
    } finally { await x.api.shutdown(); }
  });
  await test("large RF64 headers and stereo float audio conversion", async () => {
    assert.equal(wavHeader(5 * 1024 ** 3).toString("ascii", 0, 4), "RF64");
    assert.equal(wavHeader(100).readUInt32LE(76), 100);
    const b = Buffer.alloc(8); b.writeFloatLE(0.5, 0); b.writeFloatLE(0.5, 4);
    assert.equal(normalizeChunk(b, { sampleRate: RATE, channels: 2, bitsPerSample: 32, formatTag: 3, blockAlign: 8 }).readInt16LE(0), 16384);
  });
  await test("profile isolation and MiMo Token Plan support", async () => {
    assert.throws(() => profileFor({ asrModel: "qwen3-asr-flash", asrApiKey: "fixture" }, "mimo-v2.5-asr", false, {}));
    const p = profileFor({ asrProfiles: { "mimo-v2.5-asr": { apiKey: "fixture", baseUrl: "https://example.invalid/v1" } } }, "mimo-v2.5-asr", false, {});
    assert.equal(p.provider, "mimo");
    const tokenPlan = profileFor({ providerConnections: { mimo: {
      apiKey: "tp-fixture", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1"
    } } }, "mimo-v2.5-asr", false, {});
    assert.equal(tokenPlan.provider, "mimo");
    assert.equal(tokenPlan.apiKey, "tp-fixture");
    assert.equal(tokenPlan.baseUrl, "https://token-plan-cn.xiaomimimo.com/v1");
  });
  await test("MiMo Token Plan meeting ASR uses its own endpoint and current audio only", async () => {
    const originalFetch = global.fetch;
    let request;
    global.fetch = async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return { ok: true, text: async () => JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "Token Plan transcript" } }]
      }) };
    };
    try {
      const profile = profileFor({ providerConnections: { mimo: {
        apiKey: "tp-fixture", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1"
      } } }, "mimo-v2.5-asr", false, {});
      const result = await transcriber(profile)({ audioDataUrl: "data:audio/wav;base64,CURRENT" });
      assert.equal(result.text, "Token Plan transcript");
      assert.equal(request.url, "https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
      assert.equal(request.headers["api-key"], "tp-fixture");
      assert.equal(request.body.model, "mimo-v2.5-asr");
      assert.deepEqual(request.body.messages, [{ role: "user", content: [{
        type: "input_audio", input_audio: { data: "data:audio/wav;base64,CURRENT" }
      }] }]);
    } finally {
      global.fetch = originalFetch;
    }
  });
  await test("audio written before checkpoint replays without duplication", async () => {
    const x = await setup(); let recovered;
    try {
      await x.api.start({ captureMode: "microphone" });
      const statePath = path.join(x.store.sessionsRoot, x.api.status().sessionId, "realtime", "state.json");
      const checkpoint = await fs.readFile(statePath);
      await x.add("microphone", RATE, 1);
      await x.add("microphone", RATE, 2, { start: RATE });
      await x.api.stop(); await x.api.waitForIdle(); await x.api.shutdown();
      await fs.writeFile(statePath, checkpoint);
      recovered = createRealtimeMeetingService({ captureService: x.capture, defaultDirectory: path.join(x.root, "notes"), segmentSeconds: 1,
        transcribeImpl: async () => ({ text: "recovered" }) });
      await recovered.recover();
      assert.equal(recovered.status().durationMs, 2000);
      assert.equal((await fs.stat(recovered.status().audioPaths[0])).size, HEADER_BYTES + RATE * 4);
      await recovered.retry(); await recovered.waitForIdle();
    } finally { await recovered?.shutdown(); }
  });
  await test("silent system source cannot block microphone preview", async () => {
    const x = await setup();
    try {
      await x.api.start(); await x.add("microphone", RATE * 4);
      await x.api.flush(); await x.api.waitForIdle();
      assert.deepEqual(x.calls, [0, 1]);
      assert.equal(x.api.status().recording, true);
    } finally { await x.api.shutdown(); }
  });
  await test("autosave and archive progress while an ASR request is stalled", async () => {
    let finish;
    const x = await setup({ pumpIntervalMs: 10, saveIntervalMs: 25,
      transcribeImpl: async () => new Promise(resolve => { finish = resolve; }) });
    try {
      await x.api.start({ captureMode: "microphone" }); await x.add("microphone", RATE);
      const firstSave = x.api.status().lastSavedAt;
      for (let i = 0; i < 100 && (!finish || x.api.status().lastSavedAt === firstSave); i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(finish); assert.notEqual(x.api.status().lastSavedAt, firstSave);
      assert.equal((await fs.stat(x.api.status().audioPaths[0])).size, HEADER_BYTES + RATE * 2);
      assert.ok((await fs.readFile(x.api.status().markdownPath, "utf8")).includes("open-voice-input:"));
      finish({ text: "delayed ASR" }); await x.api.waitForIdle();
    } finally { if (finish) finish({ text: "done" }); await x.api.shutdown(); }
  });
  await test("startup permission failure reports failed state and preserves files", async () => {
    const x = await setup();
    x.capture.startDual = async () => { throw new Error("permission denied"); };
    try {
      await assert.rejects(x.api.start());
      assert.equal(x.api.status().status, "failed");
      assert.equal(x.api.status().recording, false);
      assert.ok(await fs.stat(x.api.status().markdownPath));
    } finally { await x.api.shutdown(); }
  });
  await test("late system audio invalidates only affected preview windows", async () => {
    const x = await setup();
    try {
      await x.api.start(); await x.add("microphone", RATE * 4);
      await x.api.flush(); await x.api.waitForIdle(); assert.deepEqual(x.calls, [0, 1]);
      await x.add("system", RATE * 4);
      await x.api.flush(); await x.api.waitForIdle();
      assert.deepEqual(x.calls, [0, 1, 0, 1, 2, 3]);
      await x.api.stop(); await x.api.waitForIdle();
      assert.equal(x.api.status().status, "completed");
      assert.equal(x.calls.length, 6);
    } finally { await x.api.shutdown(); }
  });
  await test("unconfirmed native stop blocks shutdown instead of discarding tail", async () => {
    const x = await setup();
    const originalStop = x.capture.stop;
    try {
      await x.api.start({ captureMode: "microphone" });
      x.capture.stop = async () => ({ ok: false });
      await assert.rejects(x.api.shutdown(), error => error.code === "live_stop_failed");
      assert.equal(x.api.status().recording, true);
    } finally { x.capture.stop = originalStop; await x.api.shutdown(); }
  });
  await test("MiMo ASR requests contain only current audio and keep uncleaned text", async () => {
    const originalFetch = global.fetch; const requests = [];
    global.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "um, original words" } }] }) };
    };
    try {
      const asr = transcriber({ provider: "mimo", modelId: "mimo-v2.5-asr", apiKey: "fixture", baseUrl: "https://example.invalid/v1" });
      const first = await asr({ audioDataUrl: "data:audio/wav;base64,AAAA" });
      const second = await asr({ audioDataUrl: "data:audio/wav;base64,BBBB" });
      assert.equal(first.text, "um, original words"); assert.equal(second.text, first.text);
      assert.equal(requests[1].messages.length, 1);
      assert.equal(requests[1].messages[0].content.length, 1);
      assert.equal(requests[1].messages[0].content[0].input_audio.data, "data:audio/wav;base64,BBBB");
      assert.equal(requests[1].stream, true);
      assert.ok(!JSON.stringify(requests[1]).includes("original words"));
    } finally { global.fetch = originalFetch; }
  });
  await test("cleanup rejects model expansion instead of publishing fabricated content", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"text":"invented explanation"}' } }] }) });
    try {
      const clean = cleaner({ provider: "openai-compatible", modelId: "fixture", apiKey: "fixture", baseUrl: "https://example.invalid/v1" });
      await assert.rejects(clean("keep my original words"), error => error.code === "live_cleanup_validation_failed");
    } finally { global.fetch = originalFetch; }
  });
  await test("final audio drain retries after disk failure without stopping native twice", async () => {
    const x = await setup(); const originalOpen = fs.open;
    try {
      await x.api.start({ captureMode: "microphone" }); await x.add("microphone", RATE);
      fs.open = async (file, ...args) => {
        if (String(file).endsWith("-complete.wav") && args[0] === "r+") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return originalOpen(file, ...args);
      };
      await assert.rejects(x.api.stop(), error => error.code === "live_audio_failed");
      assert.equal(x.api.status().recording, false);
      assert.equal(x.api.status().finalizationPending, true);
      await assert.rejects(x.api.start());
      fs.open = originalOpen;
      await x.api.stop(); await x.api.waitForIdle();
      assert.equal(x.api.status().durationMs, 1000);
      assert.equal(x.api.status().finalizationPending, false);
      assert.equal(x.stops(), 1);
      assert.equal((await fs.stat(x.api.status().audioPaths[0])).size, HEADER_BYTES + RATE * 2);
    } finally { fs.open = originalOpen; await x.api.shutdown(); }
  });
  await test("cleanup key without an explicit endpoint is never routed to Qwen", async () => {
    assert.throws(() => profileFor({ cleanerProfiles: { custom: { provider: "openai-compatible", apiKey: "fixture" } } }, "custom", true, {}),
      error => error.code === "live_credentials_missing");
  });
  console.log(`${count} realtime meeting tests passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
