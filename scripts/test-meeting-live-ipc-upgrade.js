"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { ensureConnectionProfiles, MEETING_LIVE_MODEL } = require("../src/settings/connection-profiles");
const { validateHotkey, normalizeAccelerator } = require("../src/hotkeys/validate-hotkey");
const root = path.resolve(__dirname, "..");
const tick = () => new Promise(setImmediate);
const plain = (value) => JSON.parse(JSON.stringify(value));

// Reuse the existing Electron sandbox without running its older integration cases.
const harnessSource = fs.readFileSync(path.join(__dirname, "test-settings-shortcuts.js"), "utf8");
const harnessCode = harnessSource.slice(harnessSource.indexOf("function mainHarness("),
  harnessSource.indexOf("async function integrationTests(")).replace(
    '    "./platform/macos": mac',
    `    "./meeting/realtime/providers": { previewProfileFor: (_settings, modelId) => {
      (controls.connectionProfileModels ||= []).push(modelId);
      if (controls.connectionProfileError) throw controls.connectionProfileError;
      return { apiKey: "unit-value", baseUrl: "https://unit.example/api-ws/v1/inference",
        model: modelId, provider: "aliyun-streaming" };
    } },
    "./providers/asr/ali-meeting-stream": { createAliMeetingStream: (options) => {
      controls.connectionStreamOptions = options;
      return { ready: controls.connectionReady || Promise.resolve(), close: async () => {
        controls.connectionClosed = (controls.connectionClosed || 0) + 1;
      } };
    } },
    "./platform/macos": mac`
  );
const mainHarness = vm.runInNewContext(harnessCode + "\nmainHarness;", {
  fs, path, vm, pathToFileURL, root, require, ensureConnectionProfiles, validateHotkey, normalizeAccelerator,
  Buffer, URL, structuredClone, console
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

test("streaming defaults migrate choices and unify Ali model credentials", () => {
  for (const old of [undefined, "mimo-v2.5-asr", "qwen3-asr-flash", "qwen3-asr-flash-filetrans"]) {
    const saved = { _connectionProfilesMigrated: true, meetingRealtimeModel: old,
      meetingQwenModel: "qwen3-asr-flash", meetingQwenApiKey: "obsolete-active-key",
      asrProfiles: { [MEETING_LIVE_MODEL]: { apiKey: "preview-key", baseUrl: "https://preview.example/v1" } },
      meetingQwenProfiles: { "qwen3-asr-flash": { apiKey: "batch-key" } },
      meetingFileAsrProfiles: { "mimo-v2.5-asr": { apiKey: "review-key" } },
      meetingAnalysisProfiles: { "gpt-5.4-mini": { apiKey: "summary-key" } } };
    const snapshot = structuredClone(saved);
    const next = ensureConnectionProfiles(saved);
    assert.equal(next.meetingRealtimeModel, MEETING_LIVE_MODEL);
    assert.equal(next.asrProfiles[MEETING_LIVE_MODEL].apiKey, "preview-key");
    assert.equal(next.meetingQwenProfiles["qwen3-asr-flash"].apiKey, "preview-key");
    assert.equal(next.meetingFileAsrProfiles["mimo-v2.5-asr"].apiKey, "review-key");
    assert.equal(next.meetingAnalysisProfiles["gpt-5.4-mini"].apiKey, "summary-key");
    assert.deepEqual(saved, snapshot);
    const switched = ensureConnectionProfiles({ ...next, meetingQwenModel: MEETING_LIVE_MODEL });
    assert.equal(switched.meetingQwenApiKey, "preview-key");
    assert.equal(switched.meetingQwenProfiles["qwen3-asr-flash"].apiKey, "preview-key");
  }
  const legacy = ensureConnectionProfiles({ meetingQwenApiKey: "old-batch-only" });
  assert.equal(legacy.meetingQwenModel, "qwen3-asr-flash");
  assert.equal(legacy.meetingRealtimeModel, MEETING_LIVE_MODEL);
  assert.equal(legacy.meetingQwenProfiles[MEETING_LIVE_MODEL], undefined);
  const fresh = ensureConnectionProfiles({});
  assert.equal(fresh.meetingQwenModel, MEETING_LIVE_MODEL);
  assert.equal(fresh.meetingQwenApiKey, "");
  assert.equal(ensureConnectionProfiles({ meetingRealtimeModel: "fun-asr-realtime" }).meetingRealtimeModel, "fun-asr-realtime");
});

test("settings renderer prefers the shared provider map and only migrates legacy profiles once", () => {
  const source = fs.readFileSync(path.join(root, "src/renderer/renderer.js"), "utf8");
  const code = source.slice(source.indexOf("const OPENAI_API_STYLES"), source.indexOf("let audioContext"));
  const context = vm.createContext({});
  vm.runInContext(code, context);
  context.input = {
    providerConnections: {
      openai: { baseUrl: "https://shared.example/v1", apiKey: "shared-key", apiStyle: "chat-completions" }
    },
    meetingAnalysisProfiles: {
      "gpt-5.5": { baseUrl: "https://api.openai.com/v1", apiKey: "stale-key" }
    }
  };
  const shared = plain(vm.runInContext("providerConnectionsForSettings(input)", context));
  assert.deepEqual(shared.openai, {
    baseUrl: "https://shared.example/v1", apiKey: "shared-key", apiStyle: "chat-completions"
  });
  context.input = {
    cleanerProfiles: {
      "gpt-5.4-mini": { baseUrl: "https://nowcoding.example/v1", apiKey: "nowcoding-key" }
    },
    meetingAnalysisProfiles: {
      "gpt-5.5": { baseUrl: "https://api.openai.com/v1", apiKey: "nowcoding-key" }
    }
  };
  const migrated = plain(vm.runInContext("providerConnectionsForSettings(input)", context));
  assert.equal(migrated.openai.baseUrl, "https://nowcoding.example/v1");
  assert.equal(migrated.openai.apiKey, "nowcoding-key");
  assert.match(source, /providerConnections:\s*collectProviderConnections\(\)/);
  assert.doesNotMatch(source, /meetingQwenApiKeyInput|meetingFileAsrApiKeyInput|meetingFunAsrApiKeyInput/);
});

test("live connection test uses the selected realtime model and closes its probe", async () => {
  const h = mainHarness();
  h.run(`settings.meetingRealtimeModel = 'fun-asr-realtime'; settings.meetingQwenModel = 'qwen3-asr-flash';`);
  const connected = await h.invoke("meeting:live:test-connection", {});
  assert.deepEqual(plain(connected), {
    ok: true, modelId: "fun-asr-realtime", scope: "meeting-preview", audioTested: false
  });
  assert.deepEqual(plain(h.controls.connectionProfileModels), ["fun-asr-realtime"]);
  assert.equal(h.controls.connectionStreamOptions.model, "fun-asr-realtime");
  assert.equal(h.controls.connectionStreamOptions.readyTimeoutMs, 10000);
  assert.equal(h.controls.connectionStreamOptions.closeTimeoutMs, 1000);
  assert.equal(h.controls.connectionClosed, 1);

  const explicit = await h.invoke("meeting:live:test-connection", { modelId: `  ${MEETING_LIVE_MODEL}  ` });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.modelId, MEETING_LIVE_MODEL);
  assert.equal(h.controls.connectionClosed, 2);
  assert.equal((await h.invoke("meeting:live:test-connection", [])).error.code, "invalid_payload");
  assert.equal((await h.invoke("meeting:live:test-connection", { modelId: " " })).error.code, "invalid_payload");

  h.controls.connectionReady = Promise.reject(new Error("private-provider-response"));
  const failed = await h.invoke("meeting:live:test-connection", { modelId: MEETING_LIVE_MODEL });
  assert.equal(failed.error.code, "live_connection_failed");
  assert.doesNotMatch(JSON.stringify(failed), /private-provider-response/);
  assert.equal(h.controls.connectionClosed, 3);

  h.controls.connectionReady = null;
  assert.equal((await h.invoke("meeting:live:start", { modelId: MEETING_LIVE_MODEL })).ok, true);
  const before = h.controls.connectionProfileModels.length;
  assert.equal((await h.invoke("meeting:live:test-connection", { modelId: MEETING_LIVE_MODEL })).error.code, "capture_busy");
  assert.equal(h.controls.connectionProfileModels.length, before);
});

for (const platform of ["win32", "darwin"]) {
  test(`${platform}: system audio never requests microphone; pause/resume preserve ownership`, async () => {
    const h = mainHarness(platform);
    h.controls.permissions.microphone = "denied";
    h.controls.permissions.screen = "not-determined";
    h.run(`getRealtimeMeeting(); macUtilities && (macUtilities.requestMicrophoneAccess = async () => { throw new Error('mic requested'); });
      realtimeMeeting.pause = async () => { Object.assign(testState, { recording: true, paused: true, status: 'paused' }); return testState; };
      realtimeMeeting.resume = async () => { Object.assign(testState, { recording: true, paused: false, status: 'recording' }); return testState; };`);
    h.context.testState = h.controls.state;
    const started = await h.invoke("meeting:live:start", { captureMode: "system" });
    assert.equal(started.ok, true);
    assert.equal(h.controls.startInput.modelId, MEETING_LIVE_MODEL);
    assert.equal(h.controls.startInput.captureMode, "system");
    assert.equal(h.controls.screenRequested, platform === "darwin" ? true : undefined);
    assert.equal((await h.invoke("meeting:live:pause")).paused, true);
    h.controls.options.onUpdate(h.controls.state);
    assert.equal(h.run("captureOwner"), "live");
    assert.equal((await h.invoke("meeting:capture:start", { sessionId: "other" })).ok, false);
    assert.equal((await h.invoke("meeting:live:recover", { sessionId: "other" })).ok, false);
    assert.equal((await h.invoke("meeting:live:resume")).paused, false);
    assert.equal((await h.invoke("meeting:live:stop")).recording, false);
  });

  test(`${platform}: floating restore and navigation cannot resize recording/settings`, async () => {
    const h = mainHarness(platform);
    const geometry = { bounds: { x: 50, y: 80, width: 1130, height: 760 }, minimumSize: [960, 640],
      resizable: true, top: false, maximized: false };
    h.context.geometry = geometry;
    h.run(`Object.assign(testWindow, {
      getBounds: () => ({ ...geometry.bounds }), getNormalBounds: () => ({ ...geometry.bounds }),
      getMinimumSize: () => [...geometry.minimumSize], isResizable: () => geometry.resizable,
      isAlwaysOnTop: () => geometry.top, isMaximized: () => geometry.maximized,
      setBounds: (value) => { geometry.bounds = { ...value }; },
      setMinimumSize: (...size) => { geometry.minimumSize = size; },
      setResizable: (value) => { geometry.resizable = value; }, setAlwaysOnTop: (value) => { geometry.top = value; },
      maximize: () => { geometry.maximized = true; }, unmaximize: () => { geometry.maximized = false; }
    }); windowMode = 'meeting';`);
    const saved = plain(geometry);
    const floated = await h.invoke("meeting:live:window", { floating: true, compact: true, alwaysOnTop: true });
    assert.equal(floated.ok, true);
    assert.equal(floated.window.compact, true);
    assert.equal(floated.resizable, true);
    assert.deepEqual(plain(geometry.minimumSize), [360, 240]);
    assert.equal(geometry.top, true);
    assert.equal(h.run("windowMode"), "meeting");
    assert.equal((await h.invoke("meeting:live:status")).window.floating, true);
    h.run("enforceWindowGeometry(testWindow, 'meeting')");
    assert.equal(geometry.bounds.width, 420);
    await h.invoke("meeting:live:window", { compact: false });
    assert.deepEqual(plain(geometry.minimumSize), [520, 420]);
    geometry.maximized = true;
    const restored = await h.invoke("meeting:live:window", { floating: false });
    assert.equal(restored.floating, false);
    assert.deepEqual(plain(geometry), saved);
    await h.invoke("meeting:live:window", { floating: true, alwaysOnTop: true });
    h.run("setWindowMode('settings')");
    assert.equal(geometry.top, false);
    assert.deepEqual(plain(geometry.minimumSize), [640, 480]);
    const before = plain(geometry);
    assert.equal((await h.invoke("meeting:live:window", { floating: true })).error.code, "window_mode_unavailable");
    assert.deepEqual(plain(geometry), before);
    h.run("setWindowMode('recording')");
    assert.equal(geometry.resizable, false);
    assert.deepEqual(plain(geometry.minimumSize), [1, 1]);
    assert.equal(geometry.bounds.width, h.run("WINDOW_SIZES.recording.width"));
    assert.equal(geometry.bounds.height, h.run("WINDOW_SIZES.recording.height"));
    geometry.bounds.width += 50;
    const resizedRecording = plain(geometry.bounds);
    h.run("enforceWindowGeometry(testWindow, 'recording')");
    assert.deepEqual(plain(geometry.bounds), resizedRecording);
    assert.equal((await h.invoke("meeting:live:window", { floating: "true" })).error.code, "invalid_payload");

    h.run("setWindowMode('meeting')");
    geometry.maximized = true;
    const maximizedBounds = plain(geometry.bounds);
    await h.invoke("meeting:live:window", { floating: true, compact: true, alwaysOnTop: true });
    assert.equal(geometry.maximized, false);
    await h.invoke("meeting:live:window", { floating: false, compact: false, alwaysOnTop: true });
    assert.equal(geometry.maximized, true);
    assert.equal(geometry.top, true);
    assert.deepEqual(plain(geometry.bounds), maximizedBounds);
    await h.invoke("meeting:live:window", { alwaysOnTop: false });
    assert.equal(geometry.maximized, true);
    assert.equal(geometry.top, false);

    await h.invoke("meeting:live:window", { floating: true, compact: true, alwaysOnTop: true });
    geometry.bounds.x = 250;
    geometry.bounds.y = 180;
    h.run("testWindow.isVisible = () => false; testWindow.center = () => { geometry.bounds.x = 0; geometry.bounds.y = 0; }");
    h.run("prepareWindowForDisplay(testWindow, 'meeting')");
    assert.equal(geometry.bounds.x, 250);
    assert.equal(geometry.bounds.y, 180);
    h.run("testWindow.isVisible = () => true; showFileTranscriptionWorkspace()");
    assert.equal(h.run("windowMode"), "file");
    assert.equal(geometry.top, false);
    assert.equal(h.run("liveWindowRestore"), null);
    assert.deepEqual(plain(h.run("liveWindowFlags")), { floating: false, compact: false, alwaysOnTop: false });
    assert.equal(h.controls.startCount, 0);
  });
}

test("postprocessing rejects stale sessions, string booleans and overlapping starts/recovery", async () => {
  const h = mainHarness();
  h.context.testState = h.controls.state;
  Object.assign(h.controls.state, { sessionId: "s-current", status: "completed", paused: false });
  assert.equal((await h.invoke("meeting:live:cleanup", { sessionId: "s-old" })).error.code, "live_session_invalid");
  assert.equal(h.controls.cleanupInput, undefined);
  assert.equal((await h.invoke("meeting:live:cleanup", { useMimoReview: "false" })).error.code, "invalid_payload");
  const cleaned = await h.invoke("meeting:live:cleanup", { sessionId: "s-current", modelId: "llm-a", useMimoReview: false,
    reviewModelId: "mimo-v2.5-asr", apiKey: "never-forward" });
  assert.equal(cleaned.ok, true);
  assert.deepEqual(plain(h.controls.cleanupInput), { sessionId: "s-current", modelId: "llm-a", useMimoReview: false, reviewModelId: "mimo-v2.5-asr" });
  h.run("realtimeMeeting.summarize = async input => { summaryInput = input; testState.postprocessStatus = 'running'; return testState; }");
  assert.equal((await h.invoke("meeting:live:summarize", { sessionId: "s-current", modelId: "llm-b", apiKey: "never-forward" })).ok, true);
  assert.deepEqual(plain(h.run("summaryInput")), { sessionId: "s-current", modelId: "llm-b" });
  for (const action of ["start", "recover", "retry", "cleanup", "summarize"]) {
    assert.equal((await h.invoke(`meeting:live:${action}`, { sessionId: "s-current" })).error.code, "live_busy");
  }
  h.controls.state.postprocessStatus = "completed";
  h.controls.state.cleanupStatus = "running";
  assert.equal((await h.invoke("meeting:live:start")).error.code, "live_busy");
  h.controls.state.cleanupStatus = "completed";
  h.run("realtimeMeeting.summarize = async () => { throw Object.assign(new Error('private-provider-body'), { code: 'live_summary_failed' }); }");
  const failed = await h.invoke("meeting:live:summarize", { sessionId: "s-current" });
  assert.equal(failed.error.code, "live_summary_failed");
  assert.doesNotMatch(JSON.stringify(failed), /private-provider-body/);
  assert.equal(h.run("liveActionPromise"), null);
});

test("pause/stop race waits for capture control and safely propagates rejections", async () => {
  const h = mainHarness();
  await h.invoke("meeting:live:start");
  h.context.gate = deferred();
  h.run("realtimeMeeting.pause = () => gate.promise");
  const pause = h.invoke("meeting:live:pause");
  await tick();
  assert.equal((await h.invoke("meeting:live:resume")).error.code, "capture_busy");
  const stop = h.invoke("meeting:live:stop");
  await tick();
  assert.equal(h.events.includes("live-stop"), false);
  h.context.gate.reject(Object.assign(new Error("private"), { code: "live_pause_failed" }));
  assert.equal((await pause).error.code, "live_pause_failed");
  assert.equal((await stop).ok, true);
});

test("DTO whitelists nested fields, derived paths and drops stale update events", async () => {
  const h = mainHarness();
  const s = h.controls.state;
  Object.assign(s, { sessionId: "s-current", paused: true, previewText: "preview", previewStatus: "streaming",
    reviewedText: "reviewed", reviewedMarkdownPath: path.join(root, "output", "reviewed.md"),
    summaryMarkdownPath: path.join(root, "output", "summary.md"),
    summary: { title: "Topic", mindmap: { text: "root", uncertain: false, children: [
      { text: "child", uncertain: true, provenance: [{ sourceId: "1", quote: "original", source: "original", startFrame: 0, endFrame: 10, apiKey: "hidden-secret" }], apiKey: "hidden-secret" }
    ] }, markdown: "# Summary", apiKey: "hidden-secret", sections: [{
      heading: "Decisions", apiKey: "hidden-secret", items: [{
        text: "Confirmed decision", uncertain: true, apiKey: "hidden-secret", children: [{ text: "hidden-secret" }],
        provenance: [{ sourceId: "1", quote: "original", source: "original", startFrame: 0, endFrame: 10,
          charStart: 1, charEnd: 9, providerResponse: "hidden-secret", nested: { apiKey: "hidden-secret" } }]
      }]
    }] },
    postprocessProgress: { kind: "reconcile", stage: "review", completed: 1, total: 2, failed: 0, providerResponse: "hidden-secret" },
    cleanupProgress: { completed: 1, total: 2, apiKey: "hidden-secret" },
    audioPaths: [path.join(root, "output", "audio.wav"), path.join(root, "hidden-secret.json")],
    recoverableSessions: [{ sessionId: "history", title: "title", apiKey: "hidden-secret" }],
    apiKey: "hidden-secret", error: { code: "bad", message: "hidden-secret" } });
  const dto = await h.invoke("meeting:live:status");
  assert.doesNotMatch(JSON.stringify(dto), /hidden-secret/);
  assert.equal(dto.paused, true);
  assert.equal(dto.reviewedText, "reviewed");
  assert.equal(dto.summary.title, "Topic");
  assert.equal(dto.summary.mindmap.children[0].text, "child");
  assert.equal(dto.summary.mindmap.children[0].uncertain, true);
  assert.equal(dto.summary.mindmap.children[0].provenance[0].quote, "original");
  assert.deepEqual(plain(dto.summary.sections), [{ heading: "Decisions", items: [{
    text: "Confirmed decision", uncertain: true, provenance: [{ sourceId: "1", quote: "original", source: "original",
      startFrame: 0, endFrame: 10, charStart: 1, charEnd: 9 }]
  }] }]);
  assert.equal(dto.postprocessProgress.kind, "reconcile");
  assert.equal(dto.postprocessProgress.failed, 0);
  assert.equal(dto.postprocessProgress.stage, "review");
  assert.equal((await h.invoke("meeting:live:open-path", { path: s.reviewedMarkdownPath })).ok, true);
  assert.equal((await h.invoke("meeting:live:open-path", { path: s.summaryMarkdownPath })).ok, true);
  const before = h.controls.sent.length;
  h.controls.options.onUpdate({ sessionId: "s-old", correctedText: "stale" });
  assert.equal(h.controls.sent.length, before);
  h.controls.options.onUpdate(s);
  assert.deepEqual(plain(h.controls.sent.at(-1)[1].summary.sections), plain(dto.summary.sections));
  s.summary = null;
  assert.equal((await h.invoke("meeting:live:status")).summary, null);
});

test("summary sections reject malformed nodes and retain legacy markdown fallback", async () => {
  const h = mainHarness();
  const s = h.controls.state;
  s.summary = { markdown: "## Legacy summary" };
  const legacy = await h.invoke("meeting:live:status");
  assert.equal(legacy.summary.markdown, s.summary.markdown);
  assert.equal(Object.hasOwn(legacy.summary, "sections"), false);
  s.summary.sections = [null, [], "bad", { heading: { apiKey: "hidden-secret" } }, {
    heading: "Details", items: [null, [], "bad", { text: { apiKey: "hidden-secret" } }, {
      text: "A detail", uncertain: "true", provenance: [{ quote: { apiKey: "hidden-secret" }, sourceId: "2", endFrame: Infinity }]
    }]
  }, { heading: "Empty", items: { apiKey: "hidden-secret" } }];
  const dto = await h.invoke("meeting:live:status");
  assert.deepEqual(plain(dto.summary.sections), [{ heading: "Details", items: [{
    text: "A detail", uncertain: false, provenance: [{ sourceId: "2" }]
  }] }, { heading: "Empty", items: [] }]);
  assert.doesNotMatch(JSON.stringify(dto), /hidden-secret/);
});

test("preload exposes only the new scoped live IPC methods", async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/preload.js"), "utf8"), { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); } }
  }) });
  await api.meetingLivePause();
  await api.meetingLiveResume();
  await api.meetingLiveSummarize({ sessionId: "s", modelId: "llm" });
  await api.meetingLiveWindow({ floating: true });
  await api.meetingLiveTestConnection({ modelId: MEETING_LIVE_MODEL });
  assert.deepEqual(calls.map(call => call[0]), ["meeting:live:pause", "meeting:live:resume", "meeting:live:summarize",
    "meeting:live:window", "meeting:live:test-connection"]);
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log(`ok - ${name}`);
  }
  console.log(`${tests.length} live upgrade IPC/settings cases passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
