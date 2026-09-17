"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createSessionStore } = require("../src/meeting/session-store");
const { createRealtimeMeetingService } = require("../src/meeting/realtime");
const { RATE, HEADER_BYTES } = require("../src/meeting/realtime/audio");
const { RAW_TRANSCRIPT_REL } = require("../src/meeting/analysis/constants");

const MODEL = "qwen-audio-3.0-asr-flash-streaming";
const FORMAT = { sampleRate: RATE, channels: 1, bitsPerSample: 16, formatTag: 1, blockAlign: 2 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await predicate();
    if (result) return result;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Timed out: ${description}`);
}

function pcm(frames, value = 1200) {
  const buffer = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(value + i % 31, i * 2);
  return buffer;
}

function modelReply(input, { punctuate = false } = {}) {
  const evidence = item => ({ sourceId: item.id, quote: item.text });
  if (input.target) {
    const items = input.items.filter(item => input.target.source === "live" || item.id === input.target.id);
    return JSON.stringify({ text: input.target.text + (punctuate ? "." : ""), evidence: items.map(evidence), uncertain: false });
  }
  const item = input.items[0];
  const claim = { text: item.text, evidence: [evidence(item)], uncertain: Boolean(item.uncertain) };
  return JSON.stringify({ title: "Integration meeting", mindmap: { ...claim, children: [] },
    sections: [{ heading: "Details", items: [claim] }] });
}

async function fixture({ configure, serviceOptions = {}, getSettings } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ovi-streaming-integration-"));
  const store = createSessionStore({ sessionsRoot: path.join(root, "sessions") });
  const services = new Set();
  const streams = [];
  const updates = [];
  const nativeFiles = new Map();
  const positions = new Map();
  const hooks = {};
  let lifecycle = "idle";
  let nativeStops = 0;
  const capture = {
    store,
    getLifecycle: () => ({ status: lifecycle }),
    createAndPrepareSession: async ({ title }) => ({ sessionId: (await store.createSession({ title })).session.id }),
    startMicrophone: async () => { lifecycle = "recording"; return { ok: true }; },
    startSystem: async () => { lifecycle = "recording"; return { ok: true }; },
    startDual: async () => { lifecycle = "recording"; return { ok: true }; },
    pause: async () => { lifecycle = "paused"; await hooks.pause?.(); return { ok: true }; },
    resume: async () => { lifecycle = "recording"; return { ok: true }; },
    stop: async () => { nativeStops++; lifecycle = "idle"; await hooks.stop?.(); return { ok: true }; }
  };
  const factory = ({ onSentence, onError }) => {
    const n = streams.length + 1;
    const id = `${n.toString(16).padStart(32, "0")}:utterance:0`;
    const stream = { id, onSentence, onError, chunks: [], frames: 0, finishes: 0, closes: 0,
      ready: Promise.resolve(),
      appendPcm: async buffer => {
        assert.ok(Buffer.isBuffer(buffer) && buffer.length <= RATE / 10 * 2 && buffer.length % 2 === 0);
        stream.chunks.push(Buffer.from(buffer));
        stream.frames += buffer.length / 2;
        onSentence({ id, text: "Draft words", beginMs: 0, endMs: stream.frames * 1000 / RATE, final: false });
      },
      finish: async () => {
        stream.finishes++;
        onSentence({ id, text: "Repeated words", beginMs: 0, endMs: stream.frames * 1000 / RATE, final: true });
      },
      close: () => { stream.closes++; }
    };
    streams.push(stream);
    configure?.(stream, n);
    return stream;
  };
  function makeService(overrides = {}) {
    const api = createRealtimeMeetingService({ captureService: capture,
      defaultDirectory: path.join(root, "notes"),
      getSettings: getSettings || (() => ({ meetingRealtimeProfiles: {
        [MODEL]: { apiKey: "integration-only-placeholder", baseUrl: "https://example.invalid/api/v1" }
      } })),
      previewStreamImpl: factory, pumpIntervalMs: 60000, saveIntervalMs: 30000,
      onUpdate: update => { updates.push(structuredClone(update)); }, ...serviceOptions, ...overrides });
    services.add(api);
    return api;
  }
  const api = makeService();
  const dir = service => path.join(store.sessionsRoot, service.status().sessionId);
  const statePath = service => path.join(dir(service), "realtime", "state.json");
  async function checkpoint(service = api) { return JSON.parse(await fs.readFile(statePath(service), "utf8")); }
  async function add(track, frames, { startFrame, indexed = true, part = false, value = 1200, clockStart } = {}) {
    const previous = positions.get(track) || { seq: 0, frame: 0 };
    const seq = previous.seq + 1;
    const start = startFrame ?? previous.frame;
    const folder = path.join(dir(api), "audio", track);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "manifest.json"), JSON.stringify({ actualL0Format: FORMAT }));
    const file = part ? "current.part" : `${String(seq).padStart(6, "0")}.l0.pcm`;
    const filePath = path.join(folder, file);
    const bytes = pcm(frames, value);
    const handle = await fs.open(filePath, "wx");
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    nativeFiles.set(filePath, bytes);
    if (indexed && !part) {
      const entry = { seq, file, format: FORMAT, frameStart: start };
      if (clockStart != null) Object.assign(entry, { qpcStart: clockStart, sessionOriginQpc: 0, qpcFrequency: RATE });
      await fs.appendFile(path.join(folder, "index.jsonl"), JSON.stringify(entry) + "\n");
    }
    positions.set(track, { seq, frame: start + frames });
    return bytes;
  }
  async function assertArchive(service, expectedByTrack) {
    const state = await checkpoint(service);
    for (const [track, expected] of Object.entries(expectedByTrack)) {
      const wav = await fs.readFile(state.tracks[track].path);
      assert.equal(wav.length, HEADER_BYTES + expected.length, `${track}: full WAV length`);
      assert.deepEqual(wav.subarray(HEADER_BYTES), expected, `${track}: every sample preserved`);
      assert.equal(state.tracks[track].frames, expected.length / 2);
    }
    for (const [file, expected] of nativeFiles) assert.deepEqual(await fs.readFile(file), expected, "native PCM is immutable");
  }
  async function close(service) {
    if (!services.has(service)) return;
    await service.shutdown();
    services.delete(service);
  }
  async function dispose() {
    for (const service of [...services].reverse()) await close(service);
  }
  return { root, api, streams, updates, hooks, add, checkpoint, statePath, dir, assertArchive,
    makeService, close, dispose, nativeStops: () => nativeStops };
}

async function main() {
  const failures = [];
  let count = 0;
  async function test(name, run) {
    count++;
    try { await run(); console.log(`ok - ${name}`); }
    catch (error) { failures.push(name); console.error(`not ok - ${name}\n${error.stack}`); }
  }

  await test("live drafts and finals arrive before the 30-second Markdown autosave", async () => {
    const x = await fixture({ serviceOptions: { pumpIntervalMs: 20 } });
    try {
      await x.api.start({ captureMode: "microphone" });
      const note = x.api.status().markdownPath;
      const initialMarkdown = await fs.readFile(note, "utf8");
      const started = Date.now();
      const audio = await x.add("microphone", RATE);
      await eventually(() => x.api.status().previewText === "Draft words", "draft from the real pump");
      assert.ok(Date.now() - started < 30000);
      assert.equal(x.api.status().rawText, "");
      assert.equal(x.api.status().recording, true);
      assert.ok(x.updates.some(update => update.previewText === "Draft words" && update.rawText === ""));
      assert.equal(await fs.readFile(note, "utf8"), initialMarkdown, "preview does not force a Markdown autosave");
      const stream = x.streams[0];
      stream.onSentence({ id: stream.id, text: "Confirmed early", beginMs: 0, endMs: 100, final: true });
      stream.onSentence({ id: stream.id, text: "late stale draft", beginMs: 0, endMs: 100, final: false });
      assert.equal(x.api.status().rawText, "Confirmed early");
      assert.equal(x.api.status().previewText, "");
      await eventually(async () => (await x.checkpoint()).segments[0]?.text === "Confirmed early", "durable final before Markdown timer");
      await x.api.stop();
      assert.equal(x.api.status().rawText, "Confirmed early");
      assert.ok((await fs.readFile(note, "utf8")).includes("Confirmed early"));
      assert.deepEqual(Buffer.concat(stream.chunks), audio);
      await x.assertArchive(x.api, { microphone: audio });
    } finally { await x.dispose(); }
  });

  await test("pause drains native tail; resume sends silence gap and next audio without duplication", async () => {
    const x = await fixture();
    try {
      await x.api.start({ captureMode: "microphone" });
      const first = await x.add("microphone", 2000);
      await x.api.flush();
      let tail;
      x.hooks.pause = async () => { tail = await x.add("microphone", 123); };
      await x.api.pause();
      assert.equal(x.api.status().paused, true);
      assert.equal(x.api.status().recording, true);
      assert.equal(x.streams[0].finishes, 1);
      assert.equal(x.streams[0].closes, 1);
      assert.deepEqual(Buffer.concat(x.streams[0].chunks), Buffer.concat([first, tail]));
      await x.api.flush();
      assert.equal(x.streams.length, 1, "paused pump cannot reopen the stream");
      await x.api.resume();
      const secondStart = RATE / 2;
      const second = await x.add("microphone", 1607, { startFrame: 0, clockStart: secondStart, value: 2000 });
      await x.api.flush();
      await x.api.stop();
      const silence = Buffer.alloc((secondStart - 2123) * 2);
      assert.equal(x.streams.length, 2);
      assert.deepEqual(Buffer.concat(x.streams[1].chunks), Buffer.concat([silence, second]));
      assert.equal(x.api.status().rawText, "Repeated words\n\nRepeated words");
      const state = await x.checkpoint();
      assert.deepEqual(state.preview.windows.map(w => [w.startFrame, w.endFrame]), [[0, 2123], [2123, secondStart + 1607]]);
      await x.assertArchive(x.api, { microphone: Buffer.concat([first, tail, silence, second]) });
      assert.equal(x.nativeStops(), 1);
    } finally { await x.dispose(); }
  });

  await test("stop sends fractional tail and waits for task-finished before publishing raw output", async () => {
    const receipt = deferred();
    const finishRequested = deferred();
    const x = await fixture({ configure: stream => {
      const finish = stream.finish;
      stream.finish = async () => { finishRequested.resolve(); await receipt.promise; await finish(); };
    } });
    try {
      await x.api.start({ captureMode: "microphone" });
      const audio = await x.add("microphone", 1733);
      let stopped = false;
      const stop = x.api.stop().then(() => { stopped = true; });
      await finishRequested.promise;
      assert.equal(stopped, false);
      assert.equal(x.api.status().finalizationPending, true);
      assert.equal(x.api.status().rawText, "");
      assert.deepEqual(Buffer.concat(x.streams[0].chunks), audio);
      receipt.resolve();
      await stop;
      assert.equal(x.api.status().status, "completed");
      const raw = JSON.parse(await fs.readFile(path.join(x.dir(x.api), RAW_TRANSCRIPT_REL), "utf8"));
      assert.equal(raw.items.length, 1);
      assert.equal(raw.items[0].text, "Repeated words");
      assert.equal(raw.items[0].endMs, 1733 * 1000 / RATE);
      await x.assertArchive(x.api, { microphone: audio });
    } finally { receipt.resolve(); await x.dispose(); }
  });

  await test("network failure preserves recording, checkpoints a gap, and retries only failed windows", async () => {
    let offline = true;
    const x = await fixture({ configure: stream => {
      if (offline) stream.ready = Promise.reject(new Error("PRIVATE_TRANSPORT_SENTINEL"));
    } });
    try {
      await x.api.start({ captureMode: "microphone" });
      const first = await x.add("microphone", 2000);
      await x.api.flush();
      await eventually(() => x.api.status().failedSegments === 1, "failed initial connection");
      assert.equal(x.api.status().recording, true);
      const tail = await x.add("microphone", 321);
      await x.api.stop();
      const failed = await x.checkpoint();
      assert.equal(x.api.status().status, "needs_retry");
      assert.ok(failed.preview.windows.every(w => w.status === "failed"));
      assert.equal(failed.preview.windows.at(-1).endFrame, 2321);
      assert.ok(!JSON.stringify(failed).includes("PRIVATE_TRANSPORT_SENTINEL"));
      assert.ok(!JSON.stringify(x.updates).includes("PRIVATE_TRANSPORT_SENTINEL"));
      await x.assertArchive(x.api, { microphone: Buffer.concat([first, tail]) });
      const beforeRetry = x.streams.length;
      offline = false;
      await x.api.retry();
      await x.api.waitForIdle();
      assert.equal(x.api.status().status, "completed");
      assert.equal(x.api.status().failedSegments, 0);
      assert.equal(x.streams.length - beforeRetry, failed.preview.windows.length);
      assert.deepEqual(Buffer.concat(x.streams.slice(beforeRetry).flatMap(stream => stream.chunks)), Buffer.concat([first, tail]));
      const raw = JSON.parse(await fs.readFile(path.join(x.dir(x.api), RAW_TRANSCRIPT_REL), "utf8"));
      assert.equal(raw.items.length, failed.preview.windows.length);
      const calls = x.streams.length;
      await x.api.retry(); await x.api.waitForIdle();
      assert.equal(x.streams.length, calls, "successful windows are never resent");
      await x.assertArchive(x.api, { microphone: Buffer.concat([first, tail]) });
    } finally { await x.dispose(); }
  });

  await test("retry replaces finals only after task-finished and rolls back a failed replacement", async () => {
    const failedFinishEntered = deferred();
    const failedFinishReceipt = deferred();
    const successfulFinishEntered = deferred();
    const successfulFinishReceipt = deferred();
    const x = await fixture({ configure: (stream, n) => {
      if (n === 1) {
        let failed = false;
        stream.appendPcm = async buffer => {
          stream.chunks.push(Buffer.from(buffer));
          stream.frames += buffer.length / 2;
          if (failed) return;
          failed = true;
          stream.onSentence({ id: stream.id, text: "Original final", beginMs: 0, endMs: 100, final: true });
          stream.onError(new Error("offline"));
        };
      } else if (n === 2) {
        stream.finish = async () => {
          stream.onSentence({ id: stream.id, text: "Rejected replacement", beginMs: 0, endMs: 100, final: true });
          failedFinishEntered.resolve();
          await failedFinishReceipt.promise;
          throw new Error("task failed");
        };
      } else if (n === 3) {
        stream.finish = async () => {
          stream.finishes++;
          stream.onSentence({ id: stream.id, text: "Repeated words", beginMs: 0,
            endMs: stream.frames * 1000 / RATE, final: true });
          successfulFinishEntered.resolve();
          await successfulFinishReceipt.promise;
        };
      }
    } });
    try {
      await x.api.start({ captureMode: "microphone" });
      const audio = await x.add("microphone", 2000);
      await x.api.flush();
      await eventually(() => x.api.status().failedSegments === 1, "initial failed window");
      await x.api.stop();
      assert.equal(x.api.status().rawText, "Original final");
      const failedRetry = x.api.retry();
      await failedFinishEntered.promise;
      assert.equal(x.api.status().rawText, "Original final", "staged failure must not become visible");
      assert.equal((await x.checkpoint()).preview.windows[0].sentences[0].text, "Original final");
      failedFinishReceipt.resolve();
      await failedRetry;
      await x.api.waitForIdle();
      assert.equal(x.api.status().rawText, "Original final");
      assert.equal(x.api.status().failedSegments, 1);
      const successfulRetry = x.api.retry();
      await successfulFinishEntered.promise;
      assert.equal(x.api.status().rawText, "Original final", "replacement waits for task-finished");
      assert.equal((await x.checkpoint()).preview.windows[0].sentences[0].text, "Original final");
      successfulFinishReceipt.resolve();
      await successfulRetry;
      await x.api.waitForIdle();
      assert.equal(x.api.status().rawText, "Repeated words");
      assert.equal(x.api.status().failedSegments, 0);
      await x.assertArchive(x.api, { microphone: audio });
    } finally {
      failedFinishReceipt.resolve();
      successfulFinishReceipt.resolve();
      await x.dispose();
    }
  });

  await test("archive pump and Markdown autosave continue while ASR readiness is stalled", async () => {
    const ready = deferred();
    const x = await fixture({ serviceOptions: { pumpIntervalMs: 20, saveIntervalMs: 40 },
      configure: stream => { stream.ready = ready.promise; } });
    try {
      await x.api.start({ captureMode: "microphone" });
      const initialSave = x.api.status().lastSavedAt;
      const first = await x.add("microphone", 1600);
      await eventually(() => x.streams.length === 1, "pending connection");
      const second = await x.add("microphone", 1234);
      await eventually(async () => (await x.checkpoint()).tracks.microphone.frames === 2834, "archive advances independently of ready");
      await eventually(() => x.api.status().lastSavedAt !== initialSave, "independent Markdown autosave");
      assert.equal(x.streams[0].chunks.length, 0);
      assert.equal(x.api.status().recording, true);
      await x.assertArchive(x.api, { microphone: Buffer.concat([first, second]) });
      ready.resolve();
      await x.api.stop();
      assert.deepEqual(Buffer.concat(x.streams[0].chunks), Buffer.concat([first, second]));
    } finally { ready.resolve(); await x.dispose(); }
  });

  await test("recovery archives indexed and unindexed tails without automatically connecting", async () => {
    const x = await fixture();
    try {
      await x.api.start({ captureMode: "microphone" });
      const first = await x.add("microphone", 1600);
      await x.api.stop();
      await x.close(x.api);
      const state = await x.checkpoint();
      state.recording = true;
      state.status = "recording";
      state.preview.windows[0].status = "streaming";
      state.preview.windows[0].sentences.push({ id: "unfinished", text: "discard draft", beginMs: 100, endMs: 150, final: false });
      await fs.writeFile(x.statePath(x.api), JSON.stringify(state));
      const indexed = await x.add("microphone", 321);
      const unindexed = await x.add("microphone", 211, { indexed: false });
      const part = await x.add("microphone", 117, { part: true });
      const audio = Buffer.concat([first, indexed, unindexed, part]);
      const calls = x.streams.length;
      const recovered = x.makeService();
      await recovered.recover({ sessionId: state.sessionId });
      await x.assertArchive(recovered, { microphone: audio });
      assert.equal(recovered.status().recording, false);
      assert.equal(recovered.status().previewText, "");
      assert.ok(recovered.status().rawText.startsWith("Repeated words"));
      assert.equal(x.streams.length, calls, "recovery must not connect ASR for a newly discovered archive tail");
      const restored = await x.checkpoint(recovered);
      assert.equal(restored.preview.windows.at(-1).endFrame, audio.length / 2);
      assert.ok(restored.preview.windows.every(w => w.status === "failed"));
      await recovered.retry(); await recovered.waitForIdle();
      assert.equal(recovered.status().failedSegments, 0);
      assert.equal(recovered.status().status, "completed");
      await x.assertArchive(recovered, { microphone: audio });
    } finally { await x.dispose(); }
  });

  await test("completed dual-track recovery preserves both full WAVs and does not resend successful windows", async () => {
    const x = await fixture();
    try {
      await x.api.start();
      const mic = await x.add("microphone", 1831, { value: 1000 });
      const system = await x.add("system", 1831, { value: 3000 });
      await x.api.stop();
      const id = x.api.status().sessionId;
      await x.close(x.api);
      const calls = x.streams.length;
      const mixed = Buffer.concat(x.streams[0].chunks);
      for (let i = 0; i < 1831; i++) {
        assert.equal(mixed.readInt16LE(i * 2), Math.round(mic.readInt16LE(i * 2) / 2) + Math.round(system.readInt16LE(i * 2) / 2));
      }
      const recovered = x.makeService();
      await recovered.recover({ sessionId: id });
      assert.equal(x.streams.length, calls);
      assert.equal(recovered.status().rawText, "Repeated words");
      await recovered.retry(); await recovered.waitForIdle();
      assert.equal(x.streams.length, calls);
      await x.assertArchive(recovered, { microphone: mic, system });
    } finally { await x.dispose(); }
  });

  await test("late system audio marks an already submitted preview interval for explicit retry", async () => {
    const x = await fixture();
    try {
      await x.api.start();
      const mic = await x.add("microphone", RATE * 2 + 1600, { value: 1000 });
      await x.api.flush();
      await eventually(() => x.streams[0]?.frames >= 1600, "mic preview beyond two-second arrival margin");
      const system = await x.add("system", RATE * 2 + 1600, { value: 3000 });
      await x.api.flush();
      await x.api.stop();
      await x.assertArchive(x.api, { microphone: mic, system });
      const expectedFirst = Math.round(mic.readInt16LE(0) / 2) + Math.round(system.readInt16LE(0) / 2);
      assert.notEqual(x.streams[0].chunks[0].readInt16LE(0), expectedFirst, "the original request lacked the late system samples");
      assert.ok(x.api.status().failedSegments > 0,
        "late source audio must leave a retry gap; completed preview cannot claim coverage of never-submitted speech");
      const calls = x.streams.length;
      await x.api.retry(); await x.api.waitForIdle();
      assert.ok(x.streams.length > calls);
      assert.equal(x.api.status().failedSegments, 0);
    } finally { await x.dispose(); }
  });

  await test("live-only cleanup is explicit, never calls review ASR, and summary uses corrected text", async () => {
    const requests = [];
    let reviews = 0;
    const x = await fixture({ serviceOptions: {
      reviewImpl: async () => { reviews++; throw new Error("Review must be opt-in"); },
      llmImpl: async ({ messages }) => {
        const input = JSON.parse(messages.find(message => message.role === "user").content);
        requests.push(input);
        return modelReply(input, { punctuate: true });
      }
    } });
    try {
      await x.api.start({ captureMode: "microphone" });
      const audio = await x.add("microphone", 1701);
      await assert.rejects(x.api.cleanup({ useMimoReview: false }), /live_cleanup_not_ready/);
      assert.equal(requests.length, 0);
      await x.api.stop();
      const original = x.api.status();
      const note = await fs.readFile(original.markdownPath, "utf8");
      const rawPath = path.join(x.dir(x.api), RAW_TRANSCRIPT_REL);
      const raw = await fs.readFile(rawPath, "utf8");
      assert.equal(requests.length, 0, "stopping must not start automatic cleanup");
      await x.api.cleanup({ useMimoReview: false }); await x.api.waitForIdle();
      assert.equal(x.api.status().cleanupStatus, "completed");
      assert.ok(x.api.status().correctedText.includes("Repeated words."));
      assert.equal(x.api.status().reviewedMarkdownPath, "");
      assert.equal(reviews, 0);
      assert.notEqual(x.api.status().cleanedMarkdownPath, original.markdownPath);
      assert.ok((await fs.readFile(x.api.status().cleanedMarkdownPath, "utf8")).includes("Repeated words\\."));
      await x.api.summarize(); await x.api.waitForIdle();
      assert.equal(x.api.status().postprocessStatus, "completed");
      assert.equal(requests.at(-1).items[0].text, "Repeated words.", "summary reads reconciled result");
      assert.equal(x.api.status().summary.mindmap.text, "Repeated words.");
      assert.ok((await fs.readFile(x.api.status().summaryMarkdownPath, "utf8")).includes("Integration meeting"));
      assert.equal(reviews, 0);
      assert.equal(x.api.status().rawText, original.rawText);
      assert.equal(await fs.readFile(original.markdownPath, "utf8"), note);
      assert.equal(await fs.readFile(rawPath, "utf8"), raw);
      await x.assertArchive(x.api, { microphone: audio });
    } finally { await x.dispose(); }
  });

  await test("optional MiMo review covers all saved audio even when live preview has no successful text", async () => {
    const reviews = [];
    const requests = [];
    const x = await fixture({ configure: stream => { stream.ready = Promise.reject(new Error("offline")); },
      serviceOptions: {
        reviewImpl: async input => {
          reviews.push(Buffer.from(input.audioDataUrl.split(",")[1], "base64"));
          return { text: "All preserved audio reviewed." };
        },
        llmImpl: async ({ messages }) => {
          const input = JSON.parse(messages.find(message => message.role === "user").content);
          requests.push(input);
          return modelReply(input);
        }
      }
    });
    try {
      await x.api.start({ captureMode: "microphone" });
      const audio = await x.add("microphone", RATE + 137);
      await x.api.stop();
      assert.equal(x.api.status().status, "needs_retry");
      assert.equal(x.api.status().rawText, "");
      const notePath = x.api.status().markdownPath;
      const note = await fs.readFile(notePath, "utf8");
      const streams = x.streams.length;
      await x.api.cleanup({ useMimoReview: true }); await x.api.waitForIdle();
      assert.equal(x.api.status().cleanupStatus, "completed");
      assert.equal(reviews.length, 1);
      assert.deepEqual(reviews[0].subarray(44), audio, "MiMo receives the full archive despite failed preview");
      assert.equal(requests[0].target.source, "mimo");
      assert.equal(x.api.status().reviewedText, "All preserved audio reviewed.");
      assert.ok(x.api.status().correctedText.includes("All preserved audio reviewed."));
      assert.ok((await fs.readFile(x.api.status().reviewedMarkdownPath, "utf8")).includes("All preserved audio reviewed\\."));
      assert.notEqual(x.api.status().reviewedMarkdownPath, x.api.status().cleanedMarkdownPath);
      await x.api.summarize(); await x.api.waitForIdle();
      assert.equal(x.api.status().postprocessStatus, "completed");
      assert.equal(x.api.status().summary.mindmap.text, "All preserved audio reviewed.");
      assert.equal(reviews.length, 1, "summary must not launch another ASR review");
      assert.equal(x.streams.length, streams, "cleanup and summary never reconnect live ASR");
      assert.equal(x.api.status().rawText, "");
      assert.equal(await fs.readFile(notePath, "utf8"), note);
      await x.assertArchive(x.api, { microphone: audio });
    } finally { await x.dispose(); }
  });

  await test("standalone summary uses original text without cleanup or review", async () => {
    const requests = [];
    const x = await fixture({ serviceOptions: {
      reviewImpl: async () => { assert.fail("standalone summary cannot call ASR"); },
      llmImpl: async ({ messages }) => {
        const input = JSON.parse(messages.find(message => message.role === "user").content);
        requests.push(input);
        return modelReply(input);
      }
    } });
    try {
      await x.api.start({ captureMode: "microphone" });
      await x.add("microphone", 1600);
      await x.api.stop();
      await x.api.summarize(); await x.api.waitForIdle();
      assert.equal(x.api.status().postprocessStatus, "completed");
      assert.equal(x.api.status().cleanupStatus, "idle");
      assert.equal(x.api.status().correctedText, "");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].target, undefined);
      assert.equal(requests[0].items[0].text, "Repeated words");
      assert.ok(requests[0].items[0].id.startsWith("live:"));
      assert.equal(x.api.status().summary.mindmap.text, "Repeated words");
      assert.ok((await fs.readFile(x.api.status().summaryMarkdownPath, "utf8")).includes("Repeated words"));
    } finally { await x.dispose(); }
  });

  await test("concurrent cleanup and summary calls cannot enter before the first persistence await", async () => {
    const gate = deferred();
    let calls = 0;
    const x = await fixture({ serviceOptions: { llmImpl: async ({ messages }) => {
      calls++;
      await gate.promise;
      return modelReply(JSON.parse(messages.find(message => message.role === "user").content));
    } } });
    try {
      await x.api.start({ captureMode: "microphone" });
      await x.add("microphone", 1600);
      await x.api.stop();
      const first = x.api.cleanup({ useMimoReview: false });
      await assert.rejects(x.api.cleanup({ useMimoReview: false }), /live_cleanup_not_ready/);
      await assert.rejects(x.api.summarize(), /live_cleanup_not_ready/);
      await first;
      await eventually(() => calls === 1, "one active cleanup request");
      gate.resolve();
      await x.api.waitForIdle();
      assert.equal(x.api.status().cleanupStatus, "completed");
      assert.equal(calls, 1);
    } finally { gate.resolve(); await x.dispose(); }
  });

  await test("recover then summarize reuses previous reconciliation and unchanged audio fingerprints", async () => {
    let reviews = 0;
    const requests = [];
    const x = await fixture({ serviceOptions: {
      reviewImpl: async () => { reviews++; return { text: "Repeated words" }; },
      llmImpl: async ({ messages }) => {
        const input = JSON.parse(messages.find(message => message.role === "user").content);
        requests.push(input);
        return modelReply(input, { punctuate: true });
      }
    } });
    try {
      await x.api.start({ captureMode: "microphone" });
      const audio = await x.add("microphone", 1777);
      await x.api.stop();
      await x.api.cleanup({ useMimoReview: true }); await x.api.waitForIdle();
      assert.equal(x.api.status().cleanupStatus, "completed");
      const status = x.api.status();
      const exported = await fs.readFile(status.cleanedMarkdownPath, "utf8");
      const stat = await fs.stat(status.audioPaths[0]);
      await x.close(x.api);
      const recovered = x.makeService();
      await recovered.recover({ sessionId: status.sessionId });
      const after = await fs.stat(status.audioPaths[0]);
      assert.equal(after.mtimeMs, stat.mtimeMs, "intact WAV recovery preserves cached audio fingerprint");
      assert.equal(after.ctimeMs, stat.ctimeMs);
      assert.equal(recovered.status().cleanupStatus, "completed");
      assert.ok(recovered.status().correctedText.includes("Repeated words."));
      await recovered.summarize(); await recovered.waitForIdle();
      assert.equal(recovered.status().postprocessStatus, "completed", "reconciled cache remains valid after recovery");
      assert.equal(requests.length, 2, "one correction plus one summary, no re-reconciliation");
      assert.equal(reviews, 1, "recovery and summary do not call review ASR again");
      assert.equal(requests.at(-1).items[0].text, "Repeated words.");
      assert.equal(recovered.status().summary.mindmap.text, "Repeated words.");
      assert.equal(await fs.readFile(status.cleanedMarkdownPath, "utf8"), exported);
      await x.assertArchive(recovered, { microphone: audio });
    } finally { await x.dispose(); }
  });

  await test("changed final text from retry invalidates derived display but preserves every exported file", async () => {
    let offline = true;
    const x = await fixture({ configure: stream => {
      if (offline) stream.ready = Promise.reject(new Error("offline"));
    }, serviceOptions: {
      reviewImpl: async () => ({ text: "Audio review before live retry." }),
      llmImpl: async ({ messages }) => modelReply(JSON.parse(messages.find(message => message.role === "user").content))
    } });
    try {
      await x.api.start({ captureMode: "microphone" });
      const audio = await x.add("microphone", 1666);
      await x.api.stop();
      assert.equal(x.api.status().rawText, "");
      await x.api.cleanup({ useMimoReview: true }); await x.api.waitForIdle();
      assert.equal(x.api.status().cleanupStatus, "completed");
      await x.api.summarize(); await x.api.waitForIdle();
      assert.equal(x.api.status().postprocessStatus, "completed");
      const before = x.api.status();
      assert.ok(before.correctedText.includes("Audio review before live retry."));
      assert.ok(before.summary);
      const files = new Map();
      for (const file of [before.cleanedMarkdownPath, before.reviewedMarkdownPath, before.summaryMarkdownPath]) {
        assert.ok(file);
        await fs.appendFile(file, "\nUser edit retained.\n");
        files.set(file, await fs.readFile(file));
      }
      offline = false;
      await x.api.retry(); await x.api.waitForIdle();
      const after = x.api.status();
      assert.equal(after.rawText, "Repeated words");
      assert.equal(after.correctedText, "");
      assert.equal(after.reviewedText, "");
      assert.equal(after.summary, null);
      assert.equal(after.cleanedMarkdownPath, "");
      assert.equal(after.reviewedMarkdownPath, "");
      assert.equal(after.summaryMarkdownPath, "");
      assert.equal(after.cleanupStatus, "idle");
      assert.equal(after.postprocessStatus, "idle");
      for (const [file, content] of files) assert.deepEqual(await fs.readFile(file), content);
      const saved = await x.checkpoint();
      assert.equal(saved.correctedText, "");
      assert.equal(saved.summary, null);
      await x.assertArchive(x.api, { microphone: audio });
    } finally { await x.dispose(); }
  });

  console.log(`Streaming integration: ${count - failures.length}/${count} tests passed.`);
  if (failures.length) {
    console.error(`Failed: ${failures.join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
