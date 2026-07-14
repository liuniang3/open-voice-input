const assert = require("node:assert/strict");
const { createOpenAiCompatibleClient, parseChatCompletionBody } = require("../src/providers/openai-compatible-client");
const { normalizeFunAsrModel } = require("../src/providers/asr/fun-asr-provider");
const { normalizeFunAsrRealtimeModel, parseRealtimeEvents: parseFunRealtimeEvents } = require("../src/providers/asr/fun-asr-realtime-session");
const { normalizeMimoAsrModel } = require("../src/providers/asr/mimo-asr-provider");
const { joinTranscript, normalizeQwenRealtimeModel, parseRealtimeEvents: parseQwenRealtimeEvents } = require("../src/providers/asr/qwen-realtime-session");
const { createVoicePipeline, normalizeQwenAsrMode, normalizeQwenAsrModel } = require("../src/providers/voice-pipeline");

async function run() {
  const calls = [];
  const pipeline = createVoicePipeline({
    getSettings: () => ({ asrProvider: "mimo", cleanerProvider: "mimo", transcriptionMode: "stable" }),
    logEvent: (message, detail) => calls.push(["log", message, detail]),
    providerOverrides: {
      asrProviders: {
        mimo: {
          id: "test-asr",
          transcribeFast: async () => {
            calls.push(["fast"]);
            return { text: "fast text" };
          },
          transcribeRaw: async () => {
            calls.push(["raw"]);
            return { text: "raw text" };
          }
        }
      },
      cleanerProviders: {
        mimo: {
          id: "test-cleaner",
          clean: async ({ rawText }) => {
            calls.push(["clean", rawText]);
            return { text: `${rawText} cleaned` };
          }
        }
      }
    }
  });

  const fastText = await pipeline.transcribe({
    audioDataUrl: "data:audio/wav;base64,test",
    transcriptionMode: "fast"
  });
  assert.equal(fastText, "fast text");
  assert.deepEqual(calls.filter(([name]) => name !== "log"), [["fast"]]);

  calls.length = 0;
  const stableText = await pipeline.transcribe({
    audioDataUrl: "data:audio/wav;base64,test",
    transcriptionMode: "stable"
  });
  assert.equal(stableText, "raw text cleaned");
  assert.deepEqual(calls.filter(([name]) => name !== "log"), [["raw"], ["clean", "raw text"]]);

  calls.length = 0;
  const switchedPipeline = createVoicePipeline({
    getSettings: () => ({ asrProvider: "qwen3-asr", cleanerProvider: "openai-compatible", transcriptionMode: "stable" }),
    logEvent: (message, detail) => calls.push(["log", message, detail]),
    providerOverrides: {
      asrProviders: {
        mimo: {
          id: "mimo",
          transcribeFast: async () => {
            throw new Error("mimo fast should not run");
          },
          transcribeRaw: async () => {
            throw new Error("mimo raw should not run");
          }
        },
        "qwen3-asr": {
          id: "qwen3-asr",
          kind: "dedicated-asr",
          transcribeFast: async () => {
            calls.push(["qwen-fast"]);
            return { text: "qwen fast" };
          },
          transcribeRaw: async () => {
            calls.push(["qwen-raw"]);
            return { text: "qwen raw" };
          }
        }
      },
      cleanerProviders: {
        mimo: {
          id: "mimo",
          clean: async () => {
            throw new Error("mimo cleaner should not run");
          }
        },
        "openai-compatible": {
          id: "openai-compatible",
          clean: async ({ rawText }) => {
            calls.push(["openai-clean", rawText]);
            return { text: `${rawText} openai-cleaned` };
          }
        }
      }
    }
  });

  const switchedStableText = await switchedPipeline.transcribe({
    audioDataUrl: "data:audio/wav;base64,test",
    transcriptionMode: "stable"
  });
  assert.equal(switchedStableText, "qwen raw openai-cleaned");
  assert.deepEqual(calls.filter(([name]) => name !== "log"), [["qwen-raw"], ["openai-clean", "qwen raw"]]);

  calls.length = 0;
  const realtimeCleanedText = await switchedPipeline.cleanText({
    rawText: "qwen realtime raw",
    shortContext: "window title"
  });
  assert.equal(realtimeCleanedText, "qwen realtime raw openai-cleaned");
  assert.deepEqual(calls.filter(([name]) => name !== "log"), [["openai-clean", "qwen realtime raw"]]);

  calls.length = 0;
  const funPipeline = createVoicePipeline({
    getSettings: () => ({ asrProvider: "fun-asr", cleanerProvider: "openai-compatible", transcriptionMode: "stable" }),
    logEvent: (message, detail) => calls.push(["log", message, detail]),
    providerOverrides: {
      asrProviders: {
        mimo: {
          id: "mimo",
          transcribeFast: async () => {
            throw new Error("mimo fast should not run");
          },
          transcribeRaw: async () => {
            throw new Error("mimo raw should not run");
          }
        },
        "fun-asr": {
          id: "fun-asr",
          kind: "dedicated-asr",
          transcribeFast: async ({ pcm16Base64 }) => {
            calls.push(["fun-fast", pcm16Base64]);
            return { text: "fun fast" };
          },
          transcribeRaw: async () => {
            calls.push(["fun-raw"]);
            return { text: "fun raw" };
          },
          testConnection: async () => {
            calls.push(["fun-test"]);
          }
        }
      },
      cleanerProviders: {
        mimo: {
          id: "mimo",
          clean: async () => {
            throw new Error("mimo cleaner should not run");
          }
        },
        "openai-compatible": {
          id: "openai-compatible",
          clean: async ({ rawText }) => {
            calls.push(["openai-clean", rawText]);
            return { text: `${rawText} openai-cleaned` };
          }
        }
      }
    }
  });

  const funFastText = await funPipeline.transcribe({
    audioDataUrl: "data:audio/wav;base64,test",
    pcm16Base64: "pcm-test",
    transcriptionMode: "fast"
  });
  assert.equal(funFastText, "fun fast");
  assert.deepEqual(calls.filter(([name]) => name !== "log"), [["fun-fast", "pcm-test"]]);

  calls.length = 0;
  let currentSettings = { asrProvider: "fun-asr", cleanerProvider: "mimo", transcriptionMode: "fast" };
  const snapshotPipeline = createVoicePipeline({
    getSettings: () => currentSettings,
    logEvent: (message, detail) => calls.push(["log", message, detail]),
    providerOverrides: {
      asrProviders: {
        mimo: {
          id: "mimo",
          transcribeFast: async () => {
            calls.push(["mimo-fast"]);
            return { text: "mimo snapshot" };
          },
          transcribeRaw: async () => {
            calls.push(["mimo-raw"]);
            return { text: "mimo raw" };
          }
        },
        "fun-asr": {
          id: "fun-asr",
          transcribeFast: async () => {
            throw new Error("current Fun-ASR provider should not be used for a snapshotted retry");
          },
          transcribeRaw: async () => {
            throw new Error("current Fun-ASR provider should not be used for a snapshotted retry");
          }
        }
      },
      cleanerProviders: {
        mimo: {
          id: "mimo",
          clean: async ({ rawText }) => ({ text: rawText })
        }
      }
    }
  });
  const snapshottedRetryText = await snapshotPipeline.transcribe({
    audioDataUrl: "data:audio/wav;base64,test",
    transcriptionMode: "fast",
    settingsSnapshot: { asrProvider: "mimo", cleanerProvider: "mimo", transcriptionMode: "fast" }
  });
  assert.equal(snapshottedRetryText, "mimo snapshot");
  assert.deepEqual(calls.filter(([name]) => name !== "log"), [["mimo-fast"]]);

  const client = createOpenAiCompatibleClient({
    apiKey: "test",
    baseUrl: "https://example.com",
    model: "test-model"
  });
  assert.equal(client.resolveBaseUrl(), "https://example.com/v1");

  const streamedBody = parseChatCompletionBody([
    'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"你"}}]}',
    "",
    'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"好"}}]}',
    "",
    "data: [DONE]"
  ].join("\n"));
  assert.equal(streamedBody.message.content, "你好");

  const compactStreamedBody = parseChatCompletionBody([
    'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"不"}}]}',
    'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"崩"}}]}',
    "data: [DONE]"
  ].join("\n"));
  assert.equal(compactStreamedBody.message.content, "不崩");

  const normalBody = parseChatCompletionBody('{"choices":[{"message":{"content":"ok"}}]}');
  assert.equal(normalBody.message.content, "ok");

  const realtimeEvents = parseQwenRealtimeEvents('data: {"type":"response.text.delta","delta":"hi"}\n\ndata: [DONE]');
  assert.equal(realtimeEvents.length, 1);
  assert.equal(realtimeEvents[0].delta, "hi");
  assert.equal(parseFunRealtimeEvents('data: {"header":{"event":"task-started"}}\n\n')[0].header.event, "task-started");

  assert.equal(normalizeQwenAsrModel(""), "qwen3-asr-flash");
  assert.equal(normalizeQwenAsrModel("mimo-v2.5"), "qwen3-asr-flash");
  assert.equal(normalizeQwenAsrModel("mimo-v2.5-asr"), "qwen3-asr-flash");
  assert.equal(normalizeQwenAsrModel("qwen3-asr-flash-realtime-2026-02-10"), "qwen3-asr-flash");
  assert.equal(normalizeQwenAsrModel("qwen3-asr-flash"), "qwen3-asr-flash");
  assert.equal(normalizeMimoAsrModel(""), "mimo-v2.5-asr");
  assert.equal(normalizeMimoAsrModel("mimo-v2.5"), "mimo-v2.5-asr");
  assert.equal(normalizeMimoAsrModel("qwen3-asr-flash"), "mimo-v2.5-asr");
  assert.equal(normalizeMimoAsrModel("mimo-v2.5-asr"), "mimo-v2.5-asr");
  assert.equal(normalizeQwenAsrMode("realtime"), "realtime");
  assert.equal(normalizeQwenAsrMode("unknown"), "batch");
  assert.equal(normalizeQwenRealtimeModel(""), "qwen3-asr-flash-realtime");
  assert.equal(normalizeQwenRealtimeModel("qwen3-asr-flash"), "qwen3-asr-flash-realtime");
  assert.equal(normalizeQwenRealtimeModel("qwen3-asr-flash-realtime-2026-02-10"), "qwen3-asr-flash-realtime-2026-02-10");
  assert.equal(normalizeFunAsrModel(""), "fun-asr");
  assert.equal(normalizeFunAsrModel("mimo-v2.5"), "fun-asr");
  assert.equal(normalizeFunAsrModel("mimo-v2.5-asr"), "fun-asr");
  assert.equal(normalizeFunAsrModel("fun-asr-realtime-2026-02-10"), "fun-asr");
  assert.equal(normalizeFunAsrModel("fun-asr-2026-02-10"), "fun-asr-2026-02-10");
  assert.equal(normalizeFunAsrRealtimeModel(""), "fun-asr-realtime");
  assert.equal(normalizeFunAsrRealtimeModel("fun-asr"), "fun-asr-realtime");
  assert.equal(normalizeFunAsrRealtimeModel("fun-asr-realtime-2026-02-10"), "fun-asr-realtime-2026-02-10");
  assert.equal(joinTranscript("第一句。", "第二句。"), "第一句，第二句。");
  assert.equal(joinTranscript("第一句。", "然后第二句。"), "第一句。然后第二句。");
  assert.equal(joinTranscript("hello", "world"), "hello world");
  assert.equal(joinTranscript("第一句。第二句。", "第二句。"), "第一句。第二句。");

  console.log("voice pipeline tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
