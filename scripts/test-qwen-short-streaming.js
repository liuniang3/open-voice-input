"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createQwenRealtimeSession,
  isQwenAudioStreamingModel,
  normalizeQwenRealtimeModel
} = require("../src/providers/asr/qwen-realtime-session");
const { ensureConnectionProfiles } = require("../src/settings/connection-profiles");

const MODEL = "qwen-audio-3.0-asr-flash-streaming";
const ROOT = path.join(__dirname, "..");

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function fakeStreamFactory(state) {
  return (options) => {
    state.options = options;
    return {
      model: options.model,
      ready: Promise.resolve(),
      async appendPcm(chunk) {
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        await new Promise(resolve => setImmediate(resolve));
        state.chunks.push(Buffer.from(chunk));
        state.active--;
      },
      async finish() { state.finished++; },
      async close() { state.closed++; }
    };
  };
}

(async () => {
  await test("latest Qwen Audio streaming is the short-preview default and legacy default migrates", async () => {
    assert.equal(normalizeQwenRealtimeModel(""), MODEL);
    assert.equal(normalizeQwenRealtimeModel("qwen3-asr-flash"), MODEL);
    assert.equal(normalizeQwenRealtimeModel("qwen3-asr-flash-realtime"), MODEL);
    assert.equal(isQwenAudioStreamingModel(MODEL), true);
    assert.equal(isQwenAudioStreamingModel(`${MODEL}-2026-09-18`), true);
    assert.equal(isQwenAudioStreamingModel("qwen3-asr-flash-realtime-2026-02-10"), false);

    const settings = ensureConnectionProfiles({
      _connectionProfilesMigrated: true,
      _providerConnectionsMigrated: true,
      providerConnections: { aliyun: { baseUrl: "https://dashscope.aliyuncs.com", apiKey: "test-only" } },
      asrProvider: "qwen3-asr",
      asrMode: "realtime",
      asrModel: "qwen3-asr-flash",
      asrProfiles: {
        "qwen3-asr-flash": {
          provider: "qwen3-asr",
          mode: "realtime",
          realtimeModel: "qwen3-asr-flash-realtime"
        }
      }
    });
    assert.equal(settings.asrRealtimeModel, MODEL);
    assert.equal(settings.asrProfiles["qwen3-asr-flash"].realtimeModel, MODEL);
  });

  await test("short preview splits PCM into ordered 100ms frames and waits before finish", async () => {
    const state = { chunks: [], active: 0, maxActive: 0, finished: 0, closed: 0, options: null };
    const partials = [];
    const finals = [];
    const session = createQwenRealtimeSession({
      apiKey: "test-only",
      baseUrl: "https://dashscope.aliyuncs.com/api-ws/v1/inference",
      model: MODEL,
      streamFactory: fakeStreamFactory(state),
      onPartial: text => partials.push(text),
      onFinal: text => finals.push(text)
    });

    const first = Buffer.alloc(7000, 1);
    const second = Buffer.alloc(4000, 2);
    const appends = [session.appendPcm16Base64(first.toString("base64")), session.appendPcm16Base64(second.toString("base64"))];
    state.options.onSentence({ id: "one", text: "第一句。", final: false });
    state.options.onSentence({ id: "one", text: "第一句。", final: true });
    state.options.onSentence({ id: "two", text: "第一句。", final: true });
    state.options.onSentence({ id: "three", text: "hello.", final: true });
    state.options.onSentence({ id: "four", text: "world", final: true });
    await Promise.all(appends);
    const text = await session.finish();

    assert.equal(state.options.model, MODEL);
    assert.equal(state.options.baseUrl, "https://dashscope.aliyuncs.com/api-ws/v1/inference");
    assert.deepEqual(state.chunks.map(chunk => chunk.length), [3200, 3200, 600, 3200, 800]);
    assert.equal(Buffer.concat(state.chunks).equals(Buffer.concat([first, second])), true);
    assert.equal(state.maxActive, 1, "IPC appends must never reorder concurrent PCM writes");
    assert.equal(state.finished, 1);
    assert.equal(partials[0], "第一句。");
    assert.equal(text, "第一句，第一句。hello. world");
    assert.equal(finals.at(-1), text);
  });

  await test("invalid or excessive audio fails closed so the renderer can use full-recording fallback", async () => {
    const state = { chunks: [], active: 0, maxActive: 0, finished: 0, closed: 0 };
    const session = createQwenRealtimeSession({
      apiKey: "test-only",
      model: MODEL,
      maxQueuedBytes: 3200,
      streamFactory: fakeStreamFactory(state)
    });
    await assert.rejects(session.appendPcm16Base64("not base64"), error => error.code === "invalid_pcm_chunk");
    await assert.rejects(session.appendPcm16Base64(Buffer.alloc(3202).toString("base64")), error => error.code === "audio_queue_overflow");
    await assert.rejects(session.finish(), error => error.code === "audio_queue_overflow");
    await session.close();
    assert.equal(state.closed, 1);
  });

  await test("renderer falls back to the retained complete recording when realtime finalization fails", async () => {
    const renderer = fs.readFileSync(path.join(ROOT, "src", "renderer", "renderer.js"), "utf8");
    const stopRecording = renderer.slice(
      renderer.indexOf("async function stopRecording()"),
      renderer.indexOf("function createRecordingSegmentState")
    );
    assert.match(stopRecording, /let realtimeSucceeded = false/);
    assert.match(stopRecording, /realtimeSucceeded = socketRealtime && Boolean\(realtimeText\)/);
    assert.match(stopRecording, /queueBufferedRecordingAudio\(segmentState, \{ transcribe: !realtimeSucceeded \}\)/);
    assert.match(stopRecording, /if \(realtimeSucceeded\)[\s\S]*collectCachedSegmentTranscripts\(segmentState\)/);
    assert.match(renderer, /onPartialTranscript\(\(text\) => \{\s*if \(!isRecording\) return;/);
  });

  console.log("Qwen short streaming tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
