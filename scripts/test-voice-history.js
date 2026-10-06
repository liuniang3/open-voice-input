"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createVoiceHistory, historyRecord } = require("../src/voice-history");
const { createVoicePipeline } = require("../src/providers/voice-pipeline");

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ovi-voice-history-"));
  let clock = new Date("2026-10-06T12:00:00Z");
  const store = createVoiceHistory({ directory, now: () => clock });
  assert.deepEqual(await store.list(), { entries: [], total: 0 });
  const first = { requestId: randomUUID(), rawText: "呃，请你看看这里。", text: "请你看看这里。", transcriptionMode: "stable", cleanupApplied: true,
    durationMs: 1234, asrModel: "asr-demo", cleanerModel: "text-demo", apiKey: "fixture-private-key", settings: { secret: "fixture-private-key" } };
  await store.record(first);
  const original = await store.get(first.requestId);
  assert.equal(original.rawText, first.rawText);
  assert.equal(original.text, first.text);
  assert.doesNotMatch(JSON.stringify(original), /fixture-private|apiKey|settings/);
  clock = new Date("2026-10-06T12:01:00Z");
  await store.record({ ...first, text: "请看看这里。" });
  assert.equal((await store.get(first.requestId)).createdAt, original.createdAt);
  assert.equal((await store.get(first.requestId)).updatedAt, clock.toISOString());
  assert.equal((await store.list()).total, 1, "retry overwrites the same request, never adds another row");
  const second = { requestId: randomUUID(), rawText: "Another sentence.", text: "Another sentence.", transcriptionMode: "fast" };
  await store.record(second);
  assert.equal((await store.list({ limit: 1 })).entries[0].requestId, second.requestId);
  assert.equal((await store.list({ offset: 1, limit: 1 })).entries[0].requestId, first.requestId);
  assert.equal((await store.list({ query: "看看" })).total, 1);
  const fresh = createVoiceHistory({ directory });
  assert.equal((await fresh.get(first.requestId)).rawText, first.rawText, "history survives restart");
  await assert.rejects(store.get("../../settings"));
  await assert.rejects(store.get([first.requestId]));
  await assert.rejects(store.record({ requestId: randomUUID(), rawText: "", text: "" }));
  assert.throws(() => historyRecord({ ...first, text: "X".repeat(250001) }, null, clock));
  await fs.writeFile(path.join(directory, "voice-history", `${randomUUID()}.json`), "broken-json");
  await fs.writeFile(path.join(directory, "voice-history", `${randomUUID()}.tmp`), "partial-write");
  assert.equal((await store.list()).total, 2, "corrupt and temporary files don't hide valid history");
  const broken = createVoiceHistory({ directory, fsImpl: { ...fs, rename: async () => { throw new Error("fixture disk failure"); } } });
  await assert.rejects(broken.record({ ...first, text: "replacement" }));
  assert.equal((await fresh.get(first.requestId)).text, "请看看这里。", "failed atomic save keeps prior record");

  const events = [];
  const messages = [];
  const settings = { asrProvider: "mimo", asrModel: "asr-demo", cleanerProvider: "mimo", cleanerModel: "text-demo" };
  const pipeline = createVoicePipeline({ getSettings: () => settings,
    onTranscript: value => { events.push(value); },
    providerOverrides: {
      asrProviders: { mimo: { id: "fixture-asr", transcribeRaw: async () => ({ text: "呃，请你看看这里。" }), transcribeFast: async () => ({ text: "请你看看这里。" }) } },
      cleanerProviders: { mimo: { id: "fixture-cleaner", clean: async value => { messages.push(value); return { text: "请你看看这里。" }; } } }
    } });
  const payload = { audioDataUrl: "data:audio/wav;base64,fixture", history: { requestId: first.requestId, durationMs: 1234 } };
  await pipeline.transcribe({ ...payload, transcriptionMode: "stable" });
  assert.equal(events.length, 1); assert.equal(events[0].cleanupApplied, true);
  assert.equal(events[0].rawText, "呃，请你看看这里。");
  await pipeline.transcribe({ ...payload, transcriptionMode: "fast" });
  assert.equal(events.length, 2); assert.equal(events[1].cleanupApplied, false);
  await pipeline.transcribe({ audioDataUrl: payload.audioDataUrl, transcriptionMode: "fast" });
  await pipeline.transcribeSegment({ audioDataUrl: payload.audioDataUrl });
  assert.equal(events.length, 2, "live previews and segments don't become history rows");
  await pipeline.cleanText({ rawText: "新的本次转写", history: payload.history });
  assert.equal(events.length, 3);
  assert.equal(messages.at(-1).rawText, "新的本次转写。", "history isn't reused as model context");
  assert.equal(events.at(-1).rawText, "新的本次转写", "history keeps the received text before local punctuation normalization");
  const failing = createVoicePipeline({ getSettings: () => settings, onTranscript: () => { throw new Error("fixture disk failure"); },
    providerOverrides: { asrProviders: { mimo: { id: "fixture-asr", transcribeFast: async () => ({ text: "unchanged" }) } } } });
  assert.equal(await failing.transcribe({ ...payload, transcriptionMode: "fast" }), "unchanged", "disk failure cannot fail a dictation");
  console.log("Voice history: persistence, privacy, search, retry dedupe, archive isolation and completion tests passed.");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
