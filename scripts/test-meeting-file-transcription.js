"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createSessionStore } = require("../src/meeting/session-store");
const { createMeetingSessionProcessor } = require("../src/meeting/processing/session-processor");
const { createMeetingSessionAnalyzer } = require("../src/meeting/analysis/session-analyzer");
const { buildWavHeader, sha256File } = require("../src/meeting/archive/export-track-wav");
const { writeExportFiles } = require("../src/meeting/export/session-export");

const FAKE_MIMO_KEY = "mimo-test-key";
const FAKE_QWEN_KEY = "qwen-test-key";
const MIMO_MODEL = "mimo-v2.5-asr";
const QWEN_MODEL = "qwen3-asr-flash";
const MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

let passed = 0;

function responseJson(value, status = 200) {
  const body = JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    }
  };
}

function makeWav(frames = 16000) {
  const pcm = Buffer.alloc(frames * 2, 0);
  return Buffer.concat([buildWavHeader(pcm.length, 16000, 1, 16), pcm]);
}

async function makeImportedSession(store, { title = "file transcription test", text = "" } = {}) {
  const created = await store.createSession({ title });
  const sessionId = created.session.id;
  const archiveDir = path.join(created.sessionDir, "archive");
  await fsp.mkdir(archiveDir, { recursive: true });

  const wavPath = path.join(archiveDir, "microphone.mono.wav");
  const wav = makeWav();
  await fsp.writeFile(wavPath, wav);
  const contentSha256 = await sha256File(wavPath);
  const sidecar = {
    schema: "meeting_archive_sidecar_v1",
    artifactSchema: "meeting_archive_wav_v1",
    sessionId,
    track: "microphone",
    role: "self",
    contentSha256,
    sessionOriginQpc: 0,
    qpcFrequency: 1000,
    durationMs: 1000,
    gaps: [],
    chunks: [
      {
        seq: 0,
        beginMs: 0,
        endMs: 1000,
        outFrameStart: 0,
        outFrameEnd: 16000,
        qpcStart: 0,
        qpcEnd: 1000,
        sessionOriginQpc: 0,
        qpcFrequency: 1000
      }
    ],
    import: {
      sourceFileName: "fixture.wav",
      mediaKind: "audio",
      importer: "test"
    }
  };
  await fsp.writeFile(`${wavPath}.sidecar.json`, `${JSON.stringify(sidecar)}\n`, "utf8");

  await store.updateSession(sessionId, {
    status: "stopped",
    source: "import",
    import: {
      sourceFileName: "fixture.wav",
      mediaKind: "audio",
      importer: "test",
      track: "microphone",
      archiveContentSha256: contentSha256
    },
    testText: text
  });
  return { sessionId, sessionDir: created.sessionDir };
}

function makeProcessor(store, resolveFileAsrCredentials, counters = {}) {
  return createMeetingSessionProcessor({
    userDataPath: store.sessionsRoot,
    getCaptureService: () => ({
      store,
      getLifecycle: () => ({ status: "stopped", sessionId: null }),
      listSessions: () => store.listSessions()
    }),
    resolveFileAsrCredentials: () => {
      counters.fileCredentialResolutions = (counters.fileCredentialResolutions || 0) + 1;
      return resolveFileAsrCredentials();
    },
    resolveOssCredentials: () => {
      counters.ossCredentialResolutions = (counters.ossCredentialResolutions || 0) + 1;
      throw new Error("file mode must not resolve OSS credentials");
    },
    createPublisher: () => {
      counters.publisherCreations = (counters.publisherCreations || 0) + 1;
      throw new Error("file mode must not create an OSS publisher");
    }
  });
}

function assertAudioOnlyRequest(call) {
  const body = call.body;
  assert.equal(body.messages.length, 1, "file ASR must send one current user message");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content.length, 1, "file ASR message must contain one audio part");
  assert.equal(body.messages[0].content[0].type, "input_audio");
  assert.match(body.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
  assert.doesNotMatch(JSON.stringify(body), /previous|history|prior|context|old transcript/i);
}

async function withMockFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`not ok - ${name}: ${error.message}`);
  }
}

async function testProviderDispatchAndIsolation() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-file-asr-"));
  const store = createSessionStore({ sessionsRoot: path.join(root, "sessions") });
  await store.init();
  const mimo = await makeImportedSession(store, { title: "mimo file" });
  const qwen = await makeImportedSession(store, { title: "qwen file" });
  const calls = [];
  let active = "mimo";
  const counters = {};
  const processor = makeProcessor(
    store,
    () =>
      active === "mimo"
        ? {
            provider: "mimo",
            modelId: MIMO_MODEL,
            baseUrl: MIMO_BASE_URL,
            apiKey: FAKE_MIMO_KEY
          }
        : {
            provider: "qwen3-asr",
            modelId: QWEN_MODEL,
            baseUrl: QWEN_BASE_URL,
            apiKey: FAKE_QWEN_KEY
          },
    counters
  );

  await withMockFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const isMimo = body.model === MIMO_MODEL;
    return responseJson({
      choices: [
        {
          message: {
            content: isMimo ? "mimo imported text" : "qwen imported text"
          }
        }
      ]
    });
  }, async () => {
    const mimoStatus = await processor.processSession(mimo.sessionId);
    assert.equal(mimoStatus.processMode, "file");
    active = "qwen3-asr";
    const qwenStatus = await processor.processSession(qwen.sessionId);
    assert.equal(qwenStatus.processMode, "file");
  });

  assert.equal(calls.length, 2);
  const mimoCall = calls.find((call) => call.body.model === MIMO_MODEL);
  const qwenCall = calls.find((call) => call.body.model === QWEN_MODEL);
  assert.ok(mimoCall);
  assert.ok(qwenCall);

  assert.equal(mimoCall.url, `${MIMO_BASE_URL}/chat/completions`);
  assert.equal(mimoCall.body.stream, true);
  assert.equal(mimoCall.body.asr_options.language, "auto");
  assert.equal(mimoCall.init.headers["api-key"], FAKE_MIMO_KEY);
  assert.equal(mimoCall.init.headers.Authorization, undefined);

  assert.equal(qwenCall.url, `${QWEN_BASE_URL}/chat/completions`);
  assert.equal(qwenCall.body.stream, false);
  assert.equal(qwenCall.body.asr_options, undefined);
  assert.match(qwenCall.init.headers.Authorization, /^Bearer /);
  assert.equal(qwenCall.init.headers["api-key"], undefined);

  for (const call of calls) assertAudioOnlyRequest(call);
  assert.equal(counters.ossCredentialResolutions || 0, 0);
  assert.equal(counters.publisherCreations || 0, 0);

  const mimoTranscript = JSON.parse(
    await fsp.readFile(path.join(mimo.sessionDir, "transcription", "qwen-no-bucket", "raw-transcript.json"), "utf8")
  );
  const qwenTranscript = JSON.parse(
    await fsp.readFile(path.join(qwen.sessionDir, "transcription", "qwen-no-bucket", "raw-transcript.json"), "utf8")
  );
  assert.equal(mimoTranscript.items[0].text, "mimo imported text");
  assert.equal(qwenTranscript.items[0].text, "qwen imported text");
  assert.equal(mimoTranscript.provider, "mimo");
  assert.equal(mimoTranscript.modelId, MIMO_MODEL);
  assert.equal(mimoTranscript.mode, "file");
  assert.equal(mimoTranscript.source, "import");
  assert.equal(mimoTranscript.sourceFileName, "fixture.wav");
  assert.equal(mimoTranscript.mediaKind, "audio");
  assert.equal(mimoTranscript.importer, "test");
  assert.equal(qwenTranscript.provider, "qwen3-asr");
  assert.equal(qwenTranscript.modelId, QWEN_MODEL);
  assert.equal(qwenTranscript.mode, "file");
}

async function testFailedRetryKeepsProvider() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-file-retry-"));
  const store = createSessionStore({ sessionsRoot: path.join(root, "sessions") });
  await store.init();
  const fixture = await makeImportedSession(store, { title: "retry file" });
  const calls = [];
  let fail = true;
  const counters = {};
  const processor = makeProcessor(
    store,
    () => ({
      provider: "qwen3-asr",
      modelId: QWEN_MODEL,
      baseUrl: QWEN_BASE_URL,
      apiKey: FAKE_QWEN_KEY
    }),
    counters
  );

  await withMockFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (fail) return responseJson({ error: { message: "mock upstream failure" } }, 503);
    return responseJson({ choices: [{ message: { content: "retry succeeded" } }] });
  }, async () => {
    await assert.rejects(() => processor.processSession(fixture.sessionId));
    const jobPath = path.join(fixture.sessionDir, "transcription", "qwen-no-bucket", "job.json");
    const failedJob = JSON.parse(await fsp.readFile(jobPath, "utf8"));
    assert.equal(failedJob.status, "failed");
    assert.equal(failedJob.provider, "qwen3-asr");
    assert.equal(failedJob.modelId, QWEN_MODEL);

    const retryStart = calls.length;
    fail = false;
    const retryStatus = await processor.retryProcess(fixture.sessionId);
    assert.equal(retryStatus.processMode, "file");
    assert.ok(calls.length > retryStart);
    for (const call of calls.slice(retryStart)) {
      assert.equal(call.url, `${QWEN_BASE_URL}/chat/completions`);
      assert.equal(call.body.model, QWEN_MODEL);
      assertAudioOnlyRequest(call);
    }
  });

  assert.ok((counters.fileCredentialResolutions || 0) >= 2);
  const transcript = JSON.parse(
    await fsp.readFile(path.join(fixture.sessionDir, "transcription", "qwen-no-bucket", "raw-transcript.json"), "utf8")
  );
  assert.equal(transcript.provider, "qwen3-asr");
  assert.equal(transcript.items[0].text, "retry succeeded");
}

function buildAnalysisModelResponse(payload) {
  const firstItemId = payload.items?.[0]?.id || payload.batches?.[0]?.inputItemIds?.[0] || "microphone:0";
  if (payload.task === "correct_batch") {
    const item = payload.items[0];
    return {
      items: [
        {
          sourceItemId: item.id,
          correctedText: item.text,
          ops: [],
          uncertain: []
        }
      ]
    };
  }
  if (payload.task === "extract_batch") {
    return {
      facts: [{ text: "imported audio was transcribed", sourceItemIds: [firstItemId] }],
      entities: [],
      decisions: [],
      actionItems: [],
      openIssues: [],
      speakerPoints: [],
      keyQuotes: [],
      coreIdeas: [],
      supportingPoints: [],
      assumptions: [],
      openQuestions: [],
      nextSteps: []
    };
  }
  const batch = payload.batches?.[0] || {};
  const sourceItemIds = batch.facts?.[0]?.sourceItemIds || [firstItemId];
  return {
    template: "meeting",
    executiveSummary: {
      text: "Imported file was transcribed successfully.",
      sourceItemIds
    },
    topicsOutline: [],
    timeline: [],
    speakerPoints: [],
    decisions: [],
    actionItems: [],
    openIssues: [],
    risks: [],
    keyQuotes: []
  };
}

async function testAnalysisReadsImportedRawTranscript() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-file-analysis-"));
  const store = createSessionStore({ sessionsRoot: path.join(root, "sessions") });
  await store.init();
  const fixture = await makeImportedSession(store, { title: "analysis file" });
  const processor = makeProcessor(store, () => ({
    provider: "mimo",
    modelId: MIMO_MODEL,
    baseUrl: MIMO_BASE_URL,
    apiKey: FAKE_MIMO_KEY
  }));

  await withMockFetch(async () => responseJson({ choices: [{ message: { content: "analysis source text" } }] }), async () => {
    await processor.processSession(fixture.sessionId);
  });

  const analysisCalls = [];
  const analyzer = createMeetingSessionAnalyzer({
    userDataPath: store.sessionsRoot,
    getCaptureService: () => ({ store }),
    resolveCredentials: () => ({
      apiKey: "analysis-test-key",
      baseUrl: "https://analysis.example.test/v1",
      modelId: "mock-analysis-model",
      contextWindowTokens: 16000,
      maxOutputTokens: 2048,
      budgetRatio: 0.65
    }),
    requestChat: async (messages) => {
      const payload = JSON.parse(messages[1].content);
      analysisCalls.push(payload);
      return { content: JSON.stringify(buildAnalysisModelResponse(payload)) };
    }
  });

  const status = await analyzer.startAnalysis(fixture.sessionId, { template: "meeting" });
  assert.equal(status.status, "completed");
  assert.ok(analysisCalls.some((call) => call.task === "correct_batch"));
  assert.ok(analysisCalls.some((call) => call.task === "extract_batch"));
  assert.ok(analysisCalls.some((call) => call.task === "merge_extracts"));
  const corrected = await analyzer.getCorrectedTranscript(fixture.sessionId);
  const summary = await analyzer.getSummary(fixture.sessionId);
  assert.equal(corrected.items[0].correctedText, "analysis source text");
  assert.equal(summary.executiveSummary.text, "Imported file was transcribed successfully.");

  const analysisJob = JSON.parse(await fsp.readFile(path.join(fixture.sessionDir, "analysis", "job.json"), "utf8"));
  assert.equal(analysisJob.source.rawTranscriptRel, "transcription/qwen-no-bucket/raw-transcript.json");
  assert.equal(analysisJob.profile.apiKey, undefined);
}

async function testForcedAnalysisUsesFreshGenerationWithoutStaleResults() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-file-analysis-force-"));
  const store = createSessionStore({ sessionsRoot: path.join(root, "sessions") });
  await store.init();
  const fixture = await makeImportedSession(store, { title: "forced analysis file" });
  const processor = makeProcessor(store, () => ({
    provider: "mimo",
    modelId: MIMO_MODEL,
    baseUrl: MIMO_BASE_URL,
    apiKey: FAKE_MIMO_KEY
  }));

  await withMockFetch(async () => responseJson({ choices: [{ message: { content: "fresh generation text" } }] }), async () => {
    await processor.processSession(fixture.sessionId);
  });

  let pauseNextCall = false;
  let releasePausedCall = null;
  let notifyPausedCall = null;
  const pausedCall = new Promise((resolve) => {
    notifyPausedCall = resolve;
  });
  const analyzer = createMeetingSessionAnalyzer({
    userDataPath: store.sessionsRoot,
    getCaptureService: () => ({ store }),
    resolveCredentials: () => ({
      apiKey: "analysis-test-key",
      baseUrl: "https://analysis.example.test/v1",
      modelId: "mock-analysis-model",
      contextWindowTokens: 16000,
      maxOutputTokens: 2048,
      budgetRatio: 0.65
    }),
    requestChat: async (messages) => {
      if (pauseNextCall) {
        pauseNextCall = false;
        notifyPausedCall();
        await new Promise((resolve) => {
          releasePausedCall = resolve;
        });
      }
      const payload = JSON.parse(messages[1].content);
      return { content: JSON.stringify(buildAnalysisModelResponse(payload)) };
    }
  });

  const first = await analyzer.startAnalysis(fixture.sessionId, { template: "meeting" });
  assert.equal(first.generation, 1);
  assert.ok(await analyzer.getSummary(fixture.sessionId));

  pauseNextCall = true;
  const forcedRun = analyzer.startAnalysis(fixture.sessionId, {
    template: "meeting",
    force: true
  });
  await pausedCall;

  const running = await analyzer.getAnalysisStatus(fixture.sessionId);
  assert.equal(running.generation, 2);
  assert.equal(running.status, "running");
  assert.equal(
    await analyzer.getSummary(fixture.sessionId),
    null,
    "a running generation must not expose the previous stable summary"
  );

  releasePausedCall();
  const completed = await forcedRun;
  assert.equal(completed.status, "completed");
  assert.equal(completed.generation, 2);
  const summary = await analyzer.getSummary(fixture.sessionId);
  assert.equal(summary.generation, 2);
}

async function testSparseLegacySummaryRehydratesFromMergeArtifact() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-file-analysis-legacy-"));
  const store = createSessionStore({ sessionsRoot: path.join(root, "sessions") });
  await store.init();
  const fixture = await makeImportedSession(store, { title: "legacy summary file" });
  const processor = makeProcessor(store, () => ({
    provider: "mimo",
    modelId: MIMO_MODEL,
    baseUrl: MIMO_BASE_URL,
    apiKey: FAKE_MIMO_KEY
  }));

  await withMockFetch(async () => responseJson({ choices: [{ message: { content: "legacy source text" } }] }), async () => {
    await processor.processSession(fixture.sessionId);
  });

  const analyzer = createMeetingSessionAnalyzer({
    userDataPath: store.sessionsRoot,
    getCaptureService: () => ({ store }),
    resolveCredentials: () => ({
      apiKey: "analysis-test-key",
      baseUrl: "https://analysis.example.test/v1",
      modelId: "mock-analysis-model",
      contextWindowTokens: 16000,
      maxOutputTokens: 2048,
      budgetRatio: 0.65
    }),
    requestChat: async (messages) => {
      const payload = JSON.parse(messages[1].content);
      if (payload.task === "correct_batch") {
        return {
          content: JSON.stringify({
            items: payload.items.map((item) => ({
              sourceItemId: item.id,
              correctedText: item.text,
              ops: [],
              uncertain: []
            }))
          })
        };
      }
      if (payload.task === "extract_batch") {
        return {
          content: JSON.stringify({
            facts: [],
            entities: [],
            decisions: [],
            actionItems: [],
            openIssues: [],
            speakerPoints: [],
            keyQuotes: [],
            coreIdeas: [],
            supportingPoints: [],
            assumptions: [],
            openQuestions: [{ question: "需要后续确认的术语", sourceItemIds: [payload.items[0].id] }],
            nextSteps: []
          })
        };
      }
      return {
        content: JSON.stringify({
          template: "personal",
          facts: [],
          entities: [],
          coreIdeas: [],
          argumentOutline: [],
          supportingPoints: [],
          assumptions: [],
          openQuestions: [{ question: "需要后续确认的术语", sourceItemIds: ["microphone:0"] }],
          nextSteps: [],
          keyQuotes: []
        })
      };
    }
  });

  const status = await analyzer.startAnalysis(fixture.sessionId, { template: "personal" });
  assert.equal(status.status, "completed");

  const summaryPath = path.join(fixture.sessionDir, "analysis", "summary.json");
  const sparse = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
  sparse.openQuestions = [];
  await fsp.writeFile(summaryPath, `${JSON.stringify(sparse, null, 2)}\n`, "utf8");

  const recovered = await analyzer.getSummary(fixture.sessionId);
  assert.equal(recovered.openQuestions[0].text, "需要后续确认的术语");
  assert.deepEqual(recovered.openQuestions[0].sourceItemIds, ["microphone:0"]);
}

async function testFileExports() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-file-export-"));
  const outPath = path.join(root, "file-result.docx");
  const report = await writeExportFiles({
    outPath,
    format: "docx",
    scope: "all",
    session: { id: "file-export", title: "文件导出测试", source: "import" },
    transcript: { items: [{ speakerId: "unknown", text: "原始文本", beginMs: 0, endMs: 1000 }] },
    corrected: { items: [{ speakerId: "unknown", correctedText: "校订文本", sourceBeginMs: 0, sourceEndMs: 1000 }] },
    summary: { template: "meeting", executiveSummary: { text: "结构化总结" } }
  });
  const bytes = await fsp.readFile(outPath);
  assert.equal(report.ok, true);
  assert.equal(report.files[0], "file-result.docx");
  assert.equal(bytes.subarray(0, 2).toString(), "PK", "DOCX must be a valid ZIP package");
  assert.ok(bytes.includes(Buffer.from("word/document.xml")), "DOCX package must contain document.xml");
}

async function main() {
  await test("file mode dispatches MiMo and Qwen request formats without OSS", testProviderDispatchAndIsolation);
  await test("failed file transcription retry keeps the original provider", testFailedRetryKeepsProvider);
  await test("analysis reads the raw transcript produced by file mode", testAnalysisReadsImportedRawTranscript);
  await test("forced analysis creates a fresh generation without stale results", testForcedAnalysisUsesFreshGenerationWithoutStaleResults);
  await test("legacy sparse summaries recover supported merge fields", testSparseLegacySummaryRehydratesFromMergeArtifact);
  await test("file results export as a real DOCX package", testFileExports);
  console.log(`${passed} file transcription regression tests passed`);
  if (process.exitCode) process.exitCode = 1;
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`fatal - ${error.message}`);
});
