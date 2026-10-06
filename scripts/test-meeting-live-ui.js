"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLiveMeetingUi } = require("../src/renderer/live-meeting-ui");
const TextSupplierUi = require("../src/renderer/text-supplier-ui");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// A small event-capable DOM keeps the regression suite dependency-free and offline.
function element(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(), value: "", textContent: "", hidden: false, disabled: false,
    dataset: {}, children: [], attributes: {}, scrollHeight: 500, clientHeight: 200, scrollTop: 300,
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) },
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    dispatch(name, payload = {}) { for (const fn of listeners.get(name) || []) fn({ preventDefault() {}, ...payload }); },
    click() { if (!this.disabled) this.dispatch("click"); },
    focus() { this.focused = true; }
  };
}

function fixture() {
  const elements = new Map([...html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map((m) => [m[2], element(m[1])]));
  const $ = (id) => elements.get(id);
  $("liveModel").value = "qwen-audio-3.0-asr-flash-streaming";
  $("liveCaptureMode").value = "dual";
  let clock = 1800000000000;
  let status = { status: "idle", recording: false, recoverableSessions: [] };
  let settings = {
    meetingRealtimeModel: "qwen-audio-3.0-asr-flash-streaming",
    meetingFileAsrProfiles: { "mimo-v2.5-asr": { provider: "mimo" }, "qwen3-asr-flash": { provider: "qwen3-asr" } },
    meetingAnalysisModel: "analysis-a", meetingAnalysisProfiles: { "analysis-a": {}, "analysis-b": {} }
  };
  const callbacks = new Set();
  const timers = new Set();
  const calls = [];
  const handlers = {
    getSettings: () => settings,
    saveSettings: (patch) => { settings = { ...settings, ...patch }; return settings; },
    meetingLiveStatus: () => ({ ok: true, ...status }),
    meetingLiveStart: () => ({ ok: true, sessionId: "s1", status: "recording", recording: true, modelId: "qwen-audio-3.0-asr-flash-streaming" }),
    meetingLiveStop: () => ({ ok: true, sessionId: "s1", status: "stopping", recording: false, pendingSegments: 2 }),
    meetingLiveRetry: () => ({ ok: true, ...status, status: "stopping" }),
    meetingLiveHistory: () => ({ ok: true, ...status }),
    meetingLiveOpenSession: ({ sessionId }) => ({ ok: true, ...completed({
      sessionId, title: "历史例会", rawText: "历史会议原文", durationMs: 72000,
      markdownPath: "C:/mock/history.md", audioPaths: ["C:/mock/history.wav"]
    }), recoverableSessions: status.recoverableSessions || [] }),
    meetingLiveCleanup: () => ({ ok: true, ...status, cleanupStatus: "running", cleanupProgress: { completed: 0, total: 2 } }),
    meetingLiveChooseDestination: () => ({ ok: true, cancelled: false, destinationPath: "C:/mock/notes.md" }),
    meetingLiveOpenPath: () => ({ ok: true })
  };
  handlers.meetingLivePause = () => ({ ok: true, ...status, paused: true });
  handlers.meetingLiveResume = () => ({ ok: true, ...status, paused: false });
  handlers.meetingLiveWindow = (flags) => ({ ok: true, ...flags });
  handlers.meetingLiveSummarize = () => ({ ok: true, ...status, postprocessStatus: "summarizing" });
  handlers.meetingLiveCancelSummary = () => ({ ok: true, ...status, postprocessStatus: "cancelled" });
  const api = Object.fromEntries(Object.keys(handlers).map((name) => [name, async (...args) => {
    calls.push({ name, args });
    return handlers[name](...args);
  }]));
  api.onMeetingLiveUpdate = (callback) => { callbacks.add(callback); return () => callbacks.delete(callback); };
  const win = { document: { getElementById: $, createElement: element }, mimoInput: api, TextSupplierUi,
    MeetingUi: require("../src/renderer/meeting-ui"), addEventListener() {} };
  const ui = createLiveMeetingUi(win, {
    now: () => clock, every: (fn) => { timers.add(fn); return fn; }, cancel: (fn) => timers.delete(fn)
  });
  return {
    $, ui, api, handlers, calls, timers, callbacks,
    setSettings(value) { settings = { ...settings, ...value }; },
    setStatus(value) { status = value; },
    push(value) { status = value; for (const cb of callbacks) cb(value); },
    advance(ms) { clock += ms; for (const fn of timers) fn(); },
    count(name) { return calls.filter((call) => call.name === name).length; },
    last(name) { return calls.filter((call) => call.name === name).at(-1); },
    async click(id) { $(id).click(); await tick(); }
  };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
const completed = (extra = {}) => ({
  sessionId: "s1", status: "completed", recording: false, modelId: "qwen-audio-3.0-asr-flash-streaming",
  rawText: "原始转写文本", pendingSegments: 0, failedSegments: 0, cleanupStatus: "idle", ...extra
});

test("view-only open is single-flight; navigation keeps updates and destruction unsubscribes", async () => {
  const f = fixture();
  await Promise.all([f.ui.open(), f.ui.open()]);
  assert.equal(f.count("meetingLiveStatus"), 1);
  assert.equal(f.count("meetingLiveStart"), 0);
  assert.equal(f.count("saveSettings"), 0);
  assert.equal(f.callbacks.size, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.$("liveStart").disabled, false);
  f.ui.close();
  assert.equal(f.callbacks.size, 1, "navigation preserves the background state subscription");
  assert.equal(f.timers.size, 0);
  await f.ui.open();
  assert.equal(f.count("meetingLiveStatus"), 2);
  assert.equal(f.callbacks.size, 1);
  f.ui.destroy();
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.timers.size, 0);
});

test("meeting summary finishes off-screen and reopens without restarting or cancelling", async () => {
  const f = fixture();
  f.setStatus(completed());
  await f.ui.open();
  f.$("liveCleanerModel").value = "analysis-a";
  await f.click("liveSummarize");
  f.ui.close();
  assert.equal(f.timers.size, 0, "hidden views need no foreground polling");
  f.push(completed({ postprocessStatus: "running", postprocessProgress: { stage: "receiving", outputChars: 1234 } }));
  const final = completed({ postprocessStatus: "completed", summaryMarkdownPath: "C:/mock/background.summary.md",
    summary: { schema: "meeting_summary_v2", title: "Background article", mindmap: { text: "Topic", children: [] },
      sections: [{ heading: "正文", paragraphs: [{ text: "A completed coherent article.", uncertain: false }], items: [] }] } });
  f.push(final);
  assert.equal(f.$("liveSummarySection").hidden, true, "off-screen updates store state without repainting");
  const read = deferred();
  f.handlers.meetingLiveStatus = () => read.promise;
  const reopening = f.ui.open();
  assert.equal(f.$("liveSummarySection").hidden, false, "cached completed output is immediately available");
  assert.match(f.$("liveSummaryDetail").children[0].textContent, /completed coherent article/);
  read.resolve({ ok: true, ...final });
  await reopening;
  assert.equal(f.count("meetingLiveSummarize"), 1);
  assert.equal(f.count("meetingLiveCancelSummary"), 0);
  assert.equal(f.count("meetingLiveStart"), 0);
  assert.equal(f.callbacks.size, 1);
  f.ui.destroy();
});

test("meeting background failures stay recoverable after repeated view switches", async () => {
  const f = fixture();
  f.setStatus(completed({ postprocessStatus: "running" }));
  await f.ui.open();
  for (let i = 0; i < 3; i++) { f.ui.close(); await f.ui.open(); }
  f.ui.close();
  f.push(completed({ postprocessStatus: "failed", postprocessProgress: { failureCode: "postprocess_request_failed" } }));
  await f.ui.open();
  assert.equal(f.$("liveSummarize").disabled, false);
  assert.match(f.$("liveCleanupStatus").textContent, /失败/);
  assert.equal(f.count("meetingLiveSummarize"), 0);
  assert.equal(f.count("meetingLiveCancelSummary"), 0);
  assert.equal(f.callbacks.size, 1, "reopening never duplicates the background listener");
  f.ui.destroy();
});

test("streaming transports and the MiMo batch fallback appear; invalid models stay blocked", async () => {
  const f = fixture();
  f.setSettings({ asrProfiles: {
    "custom-batch": { provider: "qwen3-asr" }, "fun-asr": { provider: "fun-asr" },
    "qwen-realtime": { provider: "qwen3-asr" }, "qwen-filetrans": { provider: "qwen3-asr" }
  } });
  await f.ui.open();
  const ids = f.$("liveModel").children.map((o) => o.value);
  assert.deepEqual(ids, ["qwen-audio-3.0-asr-flash-streaming", "fun-asr-realtime", "mimo-v2.5-asr", "__custom__"]);
  f.$("liveModel").value = "__custom__";
  for (const model of ["qwen3-asr-flash", "custom-batch", "qwen-filetrans", "fun-asr-realtime-2026", "qwen-audio-3.0-asr-flash-streaming-2026", "fun-asr-realtime-2026-9-18"]) {
    f.$("liveCustomModel").value = model;
    f.$("liveModel").dispatch("change");
    assert.equal(f.$("liveCustomModelField").hidden, false);
    assert.equal(f.$("liveStart").disabled, true);
    assert.match(f.$("liveError").textContent, /不支持/);
  }
  assert.equal(f.count("saveSettings"), 0);
  f.$("liveCustomModel").value = "fun-asr-realtime-2026-09-18";
  f.$("liveCustomModel").dispatch("input");
  assert.equal(f.$("liveStart").disabled, false);
  await f.click("liveStart");
  assert.equal(f.last("meetingLiveStart").args[0].modelId, "fun-asr-realtime-2026-09-18");
  f.push({ status: "idle", recording: false, recoverableSessions: [] });
  f.$("liveModel").value = "fun-asr-realtime";
  f.$("liveModel").dispatch("change");
  await tick();
  await f.click("liveStart");
  assert.equal(f.last("meetingLiveStart").args[0].provider, "aliyun-streaming");
  assert.equal(f.last("meetingLiveStart").args[0].modelId, "fun-asr-realtime");
  f.push({ status: "idle", recording: false, recoverableSessions: [] });
  f.$("liveModel").value = "mimo-v2.5-asr";
  f.$("liveModel").dispatch("change");
  await tick();
  assert.equal(f.$("liveTranscriptionIntervalField").hidden, false);
  f.$("liveTranscriptionInterval").value = "15";
  f.$("liveSaveInterval").value = "60";
  await f.click("liveStart");
  assert.deepEqual(f.last("meetingLiveStart").args[0], {
    title: "", modelId: "mimo-v2.5-asr", provider: "mimo", captureMode: "dual",
    transcriptionIntervalSeconds: 15, saveIntervalSeconds: 60
  });
});

test("start payload has no credentials; duplicate clicks do not duplicate start", async () => {
  const f = fixture();
  const start = deferred();
  f.handlers.meetingLiveStart = () => start.promise;
  await f.ui.open();
  f.$("liveTitle").value = "  项目例会  ";
  f.$("liveCaptureMode").value = "microphone";
  await f.click("liveStart");
  await f.click("liveStart");
  assert.equal(f.count("meetingLiveStart"), 1);
  assert.deepEqual(f.last("meetingLiveStart").args, [{ title: "项目例会", modelId: "qwen-audio-3.0-asr-flash-streaming",
    provider: "aliyun-streaming", captureMode: "microphone", transcriptionIntervalSeconds: 30, saveIntervalSeconds: 30 }]);
  start.resolve({ ok: true, ...completed(), status: "recording", recording: true });
  await tick();
  assert.equal(f.$("liveStop").disabled, false);
  assert.equal(f.$("liveCleanupSection").hidden, true);
});

test("destination cancellation, actual collision-safe path, explicit default reset", async () => {
  const f = fixture();
  f.setSettings({ meetingRealtimeDestination: "C:/mock/original.md" });
  await f.ui.open();
  f.handlers.meetingLiveChooseDestination = () => ({ cancelled: true });
  await f.click("liveChooseDestination");
  assert.equal(f.$("liveDestination").textContent, "C:/mock/original.md");
  f.handlers.meetingLiveChooseDestination = () => ({ ok: true, destinationPath: "C:/mock/notes.md" });
  await f.click("liveChooseDestination");
  assert.equal(f.count("saveSettings"), 0);
  await f.click("liveStart");
  assert.equal(f.last("meetingLiveStart").args[0].destinationPath, "C:/mock/notes.md");
  f.push(completed({ status: "recording", recording: true, markdownPath: "C:/mock/notes-s1.md" }));
  assert.match(f.$("liveDestination").textContent, /notes-s1\.md/);
  assert.match(f.$("liveDestination").textContent, /未覆盖/);
  f.push(completed({ markdownPath: "C:/mock/notes-s1.md" }));
  await f.click("liveDefaultDestination");
  assert.deepEqual(f.last("saveSettings").args, [{ meetingRealtimeDestination: "" }]);
  await f.click("liveStart");
  assert.equal(f.last("meetingLiveStart").args[0].destinationPath, undefined);
});

test("stop tracks ASR drain; retry only after stop; stop failure remains recoverable", async () => {
  const f = fixture();
  await f.ui.open();
  f.push(completed({ status: "recording", recording: true, failedSegments: 1 }));
  assert.equal(f.$("liveRetry").disabled, true);
  await f.click("liveStop");
  assert.deepEqual(f.last("meetingLiveStop").args, []);
  assert.equal(f.$("liveStart").disabled, true);
  assert.equal(f.$("liveRetry").disabled, true);
  assert.match(f.$("liveStatus").title, /识别收尾/);
  assert.equal(f.count("meetingLiveSummarize"), 0);
  f.push(completed({ status: "needs_retry", failedSegments: 1 }));
  assert.equal(f.$("liveRetry").disabled, false);
  await f.click("liveRetry");
  assert.deepEqual(f.last("meetingLiveRetry").args, [{ sessionId: "s1" }]);
  f.push(completed({ status: "stopping", recording: true, error: { code: "live_stop_failed", message: "停止失败" } }));
  assert.equal(f.$("liveStop").disabled, false);
  assert.match(f.$("liveStop").textContent, /重试停止/);
});

test("history browser opens a local session without starting capture or ASR", async () => {
  const f = fixture();
  f.setStatus({ status: "idle", recording: false, recoverableSessions: [{
    sessionId: "old", title: "历史例会", status: "completed", startedAtMs: 1800000000000,
    durationMs: 72000, modelId: "mimo-v2.5-asr", hasTranscript: true, hasCorrection: false, hasSummary: false
  }] });
  await f.ui.open();
  await f.click("liveHistoryToggle");
  await tick();
  assert.equal(f.count("meetingLiveHistory"), 1);
  assert.equal(f.$("liveHistoryBrowser").hidden, false);
  assert.equal(f.$("liveHistoryList").children.length, 1);
  assert.match(f.$("liveHistoryList").children[0].textContent + f.$("liveHistoryList").children[0].children[0].children[0].textContent, /历史例会/);
  f.$("liveHistoryList").children[0].click();
  await tick(); await tick();
  assert.deepEqual(f.last("meetingLiveOpenSession").args, [{ sessionId: "old" }]);
  assert.equal(f.count("meetingLiveStart"), 0);
  assert.equal(f.count("meetingLiveRetry"), 0);
  assert.equal(f.$("liveRaw").textContent, "历史会议原文");
  assert.equal(f.$("liveHistoryBrowser").hidden, true);
  f.$("liveCleanerModel").value = "analysis-b";
  f.push(completed({ sessionId: "old", title: "历史例会", rawText: "历史会议原文" }));
  await f.click("liveSummarize");
  assert.equal(f.last("meetingLiveSummarize").args[0].sessionId, "old");
  assert.equal(f.last("meetingLiveSummarize").args[0].useMimoReview, false);
  assert.equal(f.count("meetingLiveCleanup"), 0);
});

test("save indicator uses backend timestamp, flags delayed saves and freezes duration", async () => {
  const f = fixture();
  await f.ui.open();
  f.push(completed({ status: "recording", recording: true, durationMs: 65000, lastSavedAt: null }));
  assert.equal(f.$("liveElapsed").textContent, "01:05");
  assert.match(f.$("liveSaved").textContent, /每 30 秒.*尚未保存/);
  f.advance(46000);
  assert.match(f.$("liveSaved").textContent, /确认延迟/);
  f.push(completed({ status: "recording", recording: true, durationMs: 111000, lastSavedAt: 1800000046000 }));
  assert.equal(f.$("liveSaved").dataset.kind, "saved");
  f.push(completed({ durationMs: 111000 }));
  f.advance(60000);
  assert.equal(f.$("liveElapsed").textContent, "01:51");
});

test("transcript renders plain text, preserves manual scroll, follows bottom, resets next session", async () => {
  const f = fixture();
  await f.ui.open();
  f.$("liveRaw").scrollTop = 20;
  const raw = "<img src=x onerror=alert(1)>\n" + "会议原文\n".repeat(1000);
  f.push(completed({ rawText: raw }));
  assert.equal(f.$("liveRaw").textContent, raw);
  assert.equal(f.$("liveRaw").scrollTop, 20);
  assert.equal(f.$("liveRaw").children.length, 0);
  f.$("liveRaw").scrollTop = 300;
  f.push(completed({ rawText: raw + "末尾" }));
  assert.equal(f.$("liveRaw").scrollTop, 500);
  f.push({ sessionId: "s2", status: "recording", recording: true });
  assert.equal(f.$("liveRaw").textContent, "尚无转写内容");
  assert.equal(f.$("liveOpenMarkdown").disabled, true);
});

test("summary is one-shot with default-off MiMo review, durable status and returned outputs only", async () => {
  const f = fixture();
  await f.ui.open();
  const output = { markdownPath: "C:/mock/raw-s1.md", audioPaths: ["C:/mock/microphone-complete.wav", "C:/mock/system-complete.wav"] };
  f.push(completed(output));
  assert.equal(f.$("liveCleanup"), undefined);
  assert.ok(!f.$("liveUseMimoReview").checked, "MiMo review defaults off");
  f.$("liveCleanerModel").value = "analysis-b";
  await f.click("liveSummarize");
  assert.deepEqual(f.last("meetingLiveSummarize").args, [{ sessionId: "s1", supplierId: "__legacy__", modelId: "analysis-b", useMimoReview: false, reviewModelId: "mimo-v2.5-asr" }]);
  f.push(completed({ ...output, postprocessStatus: "running", postprocessProgress: { kind: "summary", completed: 1, total: 2 } }));
  assert.equal(f.$("liveCleanupStatus").textContent, "正在生成摘要");
  assert.equal(f.$("liveSummarize").disabled, true);
  const summaryPath = "C:/mock/raw-s1.summary.md";
  f.push(completed({ ...output, postprocessStatus: "completed",
    summary: { title: "会议摘要", markdown: "## 详情\n连贯段落。", mindmap: { text: "根", uncertain: false, provenance: [], children: [] },
      sections: [{ heading: "详情", paragraphs: [{ text: "一段连贯的摘要散文内容。", uncertain: false, provenance: [] }], items: [] }] },
    summaryMarkdownPath: summaryPath }));
  assert.equal(f.$("liveCleanupStatus").textContent, "摘要已生成");
  assert.ok(f.$("liveSummaryDetail").children.some(node => node.tagName === "P"
    && node.textContent.includes("一段连贯的摘要散文内容。")), "paragraph prose renders on the right pane");
  assert.equal(f.$("liveRaw").textContent, "原始转写文本");
  await f.click("liveOpenSummary");
  assert.deepEqual(f.last("meetingLiveOpenPath").args, [{ path: summaryPath }]);
  await f.click("liveOpenMarkdown");
  assert.deepEqual(f.last("meetingLiveOpenPath").args, [{ path: output.markdownPath }]);
  f.$("liveAudioOutputs").children[1].click();
  await tick();
  assert.deepEqual(f.last("meetingLiveOpenPath").args, [{ path: output.audioPaths[1] }]);
  f.$("liveUseMimoReview").checked = true;
  f.$("liveUseMimoReview").dispatch("change");
  await f.click("liveSummarize");
  assert.deepEqual(f.last("meetingLiveSummarize").args[0],
    { sessionId: "s1", supplierId: "__legacy__", modelId: "analysis-b", useMimoReview: true, reviewModelId: "mimo-v2.5-asr" });
  assert.equal(f.count("meetingLiveCleanup"), 0);
});

test("MiMo audio review can recover a saved meeting when realtime ASR has no final text", async () => {
  const f = fixture();
  await f.ui.open();
  f.push(completed({ status: "needs_retry", rawText: "", failedSegments: 1,
    audioPaths: ["C:/mock/complete.wav"] }));
  assert.equal(f.$("liveSummarize").disabled, true);
  f.$("liveUseMimoReview").checked = true;
  f.$("liveUseMimoReview").dispatch("change");
  assert.equal(f.$("liveSummarize").disabled, false);
  await f.click("liveSummarize");
  assert.equal(f.last("meetingLiveSummarize").args[0].useMimoReview, true);
});

test("meeting summary sends the exact supplier and model pair selected in settings", async () => {
  const f = fixture();
  f.setSettings({
    textSuppliers: [{ id: "vendor-a", name: "Vendor A", baseUrl: "https://example.invalid/v1", apiStyle: "chat-completions", apiKey: "test-placeholder" }],
    textSupplierCatalogs: { "vendor-a": { models: ["shared-model"] } },
    textModelSelections: { summary: { supplierId: "vendor-a", modelId: "shared-model" } }
  });
  await f.ui.open();
  assert.equal(f.$("liveCleanerModel").value, "vendor-a::shared-model");
  f.push(completed());
  await f.click("liveSummarize");
  assert.deepEqual(f.last("meetingLiveSummarize").args[0], {
    sessionId: "s1", supplierId: "vendor-a", modelId: "shared-model",
    useMimoReview: false, reviewModelId: "mimo-v2.5-asr"
  });
});

test("push supersedes a stale status response; closing invalidates pending reads", async () => {
  const f = fixture();
  const stale = deferred();
  f.handlers.meetingLiveStatus = () => stale.promise;
  const opening = f.ui.open();
  f.push(completed({ status: "recording", recording: true, rawText: "最新推送" }));
  stale.resolve({ ok: true, status: "idle" });
  await opening;
  assert.equal(f.$("liveRaw").textContent, "最新推送");
  assert.equal(f.$("liveStop").disabled, false);
  const pending = deferred();
  f.handlers.meetingLiveStatus = () => pending.promise;
  const reopening = f.ui.open();
  f.ui.close();
  pending.resolve({ ok: true, ...completed({ rawText: "过期结果" }) });
  await reopening;
  assert.equal(f.$("liveRaw").textContent, "最新推送");
});

test("missing bridge and rejected IPC show errors without enabling capture", async () => {
  const f = fixture();
  delete f.api.meetingLiveStatus;
  await f.ui.open();
  assert.equal(f.$("liveStart").disabled, true);
  assert.match(f.$("liveError").textContent, /接口尚未接入/);
  f.api.meetingLiveStatus = async () => ({ ok: true, status: "idle" });
  await f.ui.open();
  f.handlers.meetingLiveStart = () => ({ ok: false, error: { code: "missing_profile", message: "请配置所选模型" } });
  await f.click("liveStart");
  assert.match(f.$("liveError").textContent, /请配置/);
  assert.equal(f.$("liveStart").disabled, false);
  f.handlers.meetingLiveStart = () => { throw new Error("连接已关闭"); };
  await f.click("liveStart");
  assert.match(f.$("liveError").textContent, /连接已关闭/);
});

test("history is integrated into realtime UI, searchable, and blocked while recording", async () => {
  const f = fixture();
  f.setStatus({ status: "idle", recording: false, recoverableSessions: [
    { sessionId: "alpha", title: "产品周会", status: "completed", startedAtMs: 1800000000000, modelId: "mimo-v2.5-asr" },
    { sessionId: "beta", title: "设计评审", status: "completed", startedAtMs: 1790000000000, modelId: "qwen-audio-3.0-asr-flash-streaming" }
  ] });
  await f.ui.open();
  assert.equal(f.$("liveHistoryTab"), undefined);
  assert.equal(f.$("liveMeetingTab"), undefined);
  await f.click("liveHistoryToggle"); await tick();
  assert.equal(f.$("liveHistoryList").children.length, 2);
  f.$("liveHistorySearch").value = "设计";
  f.$("liveHistorySearch").dispatch("input");
  assert.equal(f.$("liveHistoryList").children.length, 1);
  f.$("liveHistoryBrowser").dispatch("keydown", { key: "Escape" });
  assert.equal(f.$("liveHistoryBrowser").hidden, true);
  f.push(completed({ status: "recording", recording: true }));
  assert.equal(f.$("liveHistoryToggle").disabled, true);
  assert.equal(f.count("meetingLiveStart"), 0);
  for (const id of ["meetingSessionList", "meetingProcessStartBtn", "meetingResultPane", "filePanel", "fileProcessStartBtn"]) assert(f.$(id), id);
  assert(html.indexOf('src="./live-meeting-ui.js"') < html.indexOf('src="./renderer.js"'));
  assert.match(html, /legacyMeetingHistoryPanel[^>]*inert[^>]*hidden/);
});

test("streaming summary progress and cancellation are visible without exposing partial output", async () => {
  const f = fixture(); await f.ui.open();
  f.push(completed({ postprocessStatus: "running", postprocessProgress: { stage: "receiving", outputChars: 250,
    reasoningChars: 12, completed: 0, total: 1, content: "PRIVATE" } }));
  assert.equal(f.$("liveCancelSummary").disabled, false);
  assert.match(f.$("livePostprocessStatus").textContent, /250/);
  assert.doesNotMatch(f.$("livePostprocessStatus").textContent, /PRIVATE/);
  f.push(completed({ postprocessStatus: "running", postprocessProgress: { stage: "retrying", retry: 2, maxRetries: 5, delayMs: 4000 } }));
  assert.match(f.$("livePostprocessStatus").textContent, /2\/5/);
  f.push(completed({ postprocessStatus: "running", postprocessProgress: { stage: "validation_retry", validationRetry: 1 } }));
  assert.match(f.$("livePostprocessStatus").textContent, /自动重新生成/);
  f.push(completed({ postprocessStatus: "running", postprocessProgress: { stage: "receiving", validationRetry: 1, outputChars: 250 } }));
  assert.match(f.$("livePostprocessStatus").textContent, /格式重试/);
  await f.click("liveCancelSummary");
  assert.deepEqual(f.last("meetingLiveCancelSummary").args, [{ sessionId: "s1" }]);
  assert.equal(f.$("liveCancelSummary").disabled, true);
  f.push(completed({ postprocessStatus: "needs_retry", postprocessProgress: { failureCode: "postprocess_credentials_invalid" } }));
  assert.match(f.$("livePostprocessStatus").textContent, /认证/);
});

test("platform key capture distinguishes macOS Command/Control and Windows Ctrl/Super", () => {
  const source = fs.readFileSync(path.join(root, "src/renderer/renderer.js"), "utf8");
  const fn = source.slice(source.indexOf("function formatHotkey("), source.indexOf("function handleHotkeyCaptureKeydown("));
  function format(platform, mods) {
    return vm.runInNewContext(`${fn}; formatHotkey(event)`, { navigator: { platform }, event: { key: "m", code: "KeyM", ...mods } });
  }
  assert.equal(format("MacIntel", { metaKey: true, altKey: true }), "Command+Alt+M");
  assert.equal(format("MacIntel", { ctrlKey: true }), "Control+M");
  assert.equal(format("Win32", { ctrlKey: true }), "CommandOrControl+M");
  assert.equal(format("Win32", { metaKey: true }), "Super+M");
});

test("temporary microphone permission probe stops tracks before releasing capture ownership", async () => {
  const source = fs.readFileSync(path.join(root, "src/renderer/renderer.js"), "utf8");
  const fn = source.slice(source.indexOf("async function refreshMicrophones("), source.indexOf("async function saveMicrophoneSelection("));
  async function probe(scenario) {
    const events = [];
    const context = {
      isRecording: scenario === "already-recording", isStartingRecording: scenario === "already-starting",
      appSettings: {}, microphoneSelect: { append() {} }, microphoneHint: {}, Option: function Option() {},
      setStatus() { events.push("error"); },
      window: { mimoInput: { clearRecordingKeys: async () => events.push("release") } },
      navigator: { mediaDevices: {
        enumerateDevices: async () => [],
        getUserMedia: async () => {
          events.push("probe");
          if (scenario === "denied") throw new Error("permission denied");
          if (scenario === "recording-during-probe") context.isRecording = true;
          if (scenario === "starting-during-probe") context.isStartingRecording = true;
          return { getTracks: () => [{ stop: () => events.push("stop") }] };
        }
      } }
    };
    await vm.runInNewContext(`${fn}; refreshMicrophones({ requestPermission: true })`, context);
    return events;
  }
  assert.deepEqual(await probe("success"), ["probe", "stop", "release"]);
  assert.deepEqual(await probe("denied"), ["probe", "release", "error"]);
  assert.deepEqual(await probe("already-recording"), []);
  assert.deepEqual(await probe("already-starting"), []);
  assert.deepEqual(await probe("recording-during-probe"), ["probe", "stop"]);
  assert.deepEqual(await probe("starting-during-probe"), ["probe", "stop"]);
  assert.match(source, /if \(isRecording \|\| isTranscribing \|\| isStartingRecording\) return;/);
});

async function run() {
  let failed = 0;
  for (const { name, run: check } of tests) {
    try { await check(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`not ok - ${name}\n${error.stack}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} live UI tests passed`);
  if (failed) process.exitCode = 1;
}

// Optional real-browser verification: pass a Playwright Page. All requests are mocked.
async function prepareBrowser(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const files = {
      "/": ["src/renderer/index.html", "text/html"],
      "/styles.css": ["src/renderer/styles.css", "text/css"],
      "/live-meeting.css": ["src/renderer/live-meeting.css", "text/css"],
      "/app-shell.css": ["src/renderer/app-shell.css", "text/css"],
      "/reading-layout.css": ["src/renderer/reading-layout.css", "text/css"],
      "/supplier-manager.css": ["src/renderer/supplier-manager.css", "text/css"],
      "/settings-workspace.css": ["src/renderer/settings-workspace.css", "text/css"],
      "/settings-workspace.js": ["src/renderer/settings-workspace.js", "text/javascript"],
      "/voice-history-ui.js": ["src/renderer/voice-history-ui.js", "text/javascript"],
      "/voice-settings-snapshot.js": ["src/renderer/voice-settings-snapshot.js", "text/javascript"],
      "/reading-layout.js": ["src/renderer/reading-layout.js", "text/javascript"],
      "/home-ui.js": ["src/renderer/home-ui.js", "text/javascript"],
      "/onboarding-ui.js": ["src/renderer/onboarding-ui.js", "text/javascript"],
      "/audio-utils.js": ["src/audio-utils.js", "text/javascript"],
      "/asr-provider-info.js": ["src/asr-provider-info.js", "text/javascript"],
      "/meeting-ui.js": ["src/renderer/meeting-ui.js", "text/javascript"],
      "/text-supplier-ui.js": ["src/renderer/text-supplier-ui.js", "text/javascript"],
      "/text-supplier-manager.js": ["src/renderer/text-supplier-manager.js", "text/javascript"],
      "/file-ui.js": ["src/renderer/file-ui.js", "text/javascript"],
      "/live-meeting-ui.js": ["src/renderer/live-meeting-ui.js", "text/javascript"],
      "/renderer.js": ["src/renderer/renderer.js", "text/javascript"]
    };
    const asset = /^\/(?:brand|icons)\/[a-z0-9-]+\.svg$/.test(pathname) ? [`src/renderer${pathname}`, "image/svg+xml"] : null;
    const match = files[pathname] || asset;
    if (!match) return route.abort();
    return route.fulfill({ contentType: match[1], body: fs.readFileSync(path.join(root, match[0])) });
  });
  await page.addInitScript(() => {
    let dto = { status: "idle", recording: false, recoverableSessions: [] };
    let settings = {
      meetingRealtimeModel: "fun-asr-realtime-2026-09-18",
      meetingRealtimeProfiles: { "fun-asr-realtime-2026-09-18": { provider: "aliyun-streaming", apiKey: "test-only-live-key", baseUrl: "https://example.invalid/v1" } },
      meetingQwenProfiles: { "qwen3-asr-flash": { provider: "qwen3-asr", apiKey: "test-only-batch-key" } },
      meetingFileAsrProfiles: { "mimo-v2.5-asr": { provider: "mimo" }, "qwen3-asr-flash": { provider: "qwen3-asr" } },
      meetingAnalysisModel: "analysis-demo", meetingAnalysisProfiles: { "analysis-demo": {} }
    };
    const hooks = {};
    window.mockHome = {
      ok: true, platform: "win32", hotkey: "CommandOrControl+Alt+M", hotkeyRegistered: true,
      asrConfigured: true, cleanerConfigured: true, transcriptionMode: "stable", meetingRecording: false,
      usage: { today: { count: 18, characters: 2384 }, week: { count: 126, characters: 18562 } },
      onboarding: { status: "migrated" }, recent: [
        { id: "file-demo", kind: "file", title: "产品反馈访谈", date: "2026-09-30T07:30:00Z" },
        { id: "recovered", kind: "meeting", title: "团队例会", date: "2026-09-29T06:00:00Z" }
      ]
    };
    window.mockSettings = () => settings;
    window.mockVoiceRecords = [
      { requestId: "00000000-0000-4000-a000-000000000002", createdAt: "2026-10-07T02:00:00.000Z",
        rawText: "呃，请检查测试页面的布局。", text: "请检查测试页面的布局。", transcriptionMode: "stable", cleanupApplied: true },
      { requestId: "00000000-0000-4000-a000-000000000001", createdAt: "2026-10-06T01:00:00.000Z",
        rawText: "这是较早的一条语音输入测试记录。", text: "这是较早的一条语音输入测试记录。", transcriptionMode: "fast", cleanupApplied: false }
    ];
    window.mockHooks = hooks;
    window.mockCalls = [];
    window.mockPush = (patch) => { dto = { ...dto, ...patch }; hooks.onMeetingLiveUpdate?.(dto); };
    window.mockOpenSettings = () => hooks.onOpenSettings?.();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: async () => [], getUserMedia: async () => { throw new Error("Microphone forbidden in UI test"); }
    } });
    window.mimoInput = new Proxy({}, { get(_target, name) {
      if (window.mockApiOverrides?.[name]) return window.mockApiOverrides[name];
      if (/^on[A-Z]/.test(String(name))) return (callback) => { hooks[name] = callback; return () => { delete hooks[name]; }; };
      return async (payload) => {
        window.mockCalls.push({ name, payload });
        if (name === "getSettings") return settings;
        if (name === "getHomeOverview") return window.mockHome;
        if (name === "listVoiceHistory") {
          const rows = window.mockVoiceRecords.filter(row => !payload?.query || (row.rawText + row.text).includes(payload.query));
          return { ok: true, total: rows.length, entries: rows.slice(payload?.offset || 0, (payload?.offset || 0) + (payload?.limit || 40))
            .map(({ requestId, createdAt, transcriptionMode, cleanupApplied, text }) => ({ requestId, createdAt, transcriptionMode, cleanupApplied, preview: text.slice(0, 160) })) };
        }
        if (name === "getVoiceHistory") return { ok: true, entry: window.mockVoiceRecords.find(row => row.requestId === payload.requestId) };
        if (name === "openHome") { hooks.onOpenHome?.(); return { ok: true }; }
        if (name === "openSettings") { hooks.onOpenSettings?.(); return { ok: true }; }
        if (name === "openMeetingWorkspace") { hooks.onOpenMeeting?.(); return { ok: true }; }
        if (name === "finishOnboarding") { window.mockHome.onboarding = { status: payload.skipped ? "skipped" : "completed" }; return { ok: true }; }
        if (name === "testOnboardingAsr") return { ok: true, latencyMs: 120 };
        if (name === "checkHotkey") return { ok: true, accelerator: payload.accelerator };
        if (name === "listProviderModels") {
          if (payload?.supplierId) settings.textSupplierCatalogs = { ...settings.textSupplierCatalogs,
            [payload.supplierId]: { models: ["custom-text-model"] } };
          return { ok: true, supplierId: payload?.supplierId, models: ["custom-text-model"], latencyMs: 12 };
        }
        if (name === "saveSettings") return settings = { ...settings, ...payload };
        if (name === "getStatus") return { settings, hasApiKey: false, registeredHotkeys: [] };
        if (name === "meetingLiveStatus") return { ok: true, ...dto };
        if (name === "meetingLiveHistory") return { ok: true, ...dto, recoverableSessions: [{
          sessionId: "recovered", title: "历史例会", status: "completed", startedAtMs: Date.now() - 60000,
          durationMs: 60000, modelId: "mimo-v2.5-asr", hasTranscript: true, hasCorrection: false, hasSummary: false
        }] };
        if (name === "meetingLiveOpenSession") {
          dto = { status: "completed", recording: false, sessionId: payload.sessionId, title: "历史例会",
            rawText: "历史会议原文", pendingSegments: 0, failedSegments: 0,
            markdownPath: "C:/mock/history.md", audioPaths: ["C:/mock/history.wav"], recoverableSessions: dto.recoverableSessions || [] };
          return { ok: true, ...dto };
        }
        if (name === "meetingLiveWindow") return { ok: true, ...payload };
        if (name === "meetingLivePause" || name === "meetingLiveResume") {
          window.mockPush({ paused: name === "meetingLivePause" });
          return { ok: true, ...dto };
        }
        if (name === "meetingLiveSummarize") {
          window.mockPush({ postprocessStatus: "summarizing" });
          return { ok: true, ...dto };
        }
        if (name === "meetingLiveCancelSummary") {
          window.mockPush({ postprocessStatus: "cancelled" });
          return { ok: true, ...dto };
        }
        if (name === "meetingLiveStart") {
          window.mockPush({ sessionId: "demo", status: "recording", recording: true, modelId: payload.modelId,
            markdownPath: "C:/mock/项目例会-demo.md", audioPaths: ["C:/mock/microphone-complete.wav", "C:/mock/system-complete.wav"],
            startedAtMs: Date.now() - 91000, durationMs: 91000, lastSavedAt: Date.now(), pendingSegments: 1, failedSegments: 0 });
          return { ok: true, ...dto };
        }
        if (name === "meetingLiveStop") { window.mockPush({ status: "stopping", recording: false }); return { ok: true, ...dto }; }
        if (name === "meetingLiveCleanup") { window.mockPush({ cleanupStatus: "running", cleanupProgress: { completed: 1, total: 2 } }); return { ok: true, ...dto }; }
        if (name === "meetingLiveChooseDestination") return { ok: true, destinationPath: "C:/mock/项目例会.md" };
        if (name === "meetingListSessions") return { ok: true, sessions: [] };
        if (name === "fileChooseMedia" || name === "meetingChooseMedia") return { ok: true, cancelled: true };
        return { ok: true };
      };
    } });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("http://localhost/");
  return errors;
}

async function verifyBrowser(page, screenshotDirectory) {
  const errors = await prepareBrowser(page);
  const screenshots = [];
  await page.evaluate(async () => { window.applyWindowMode("meeting"); await window.MeetingLiveUi.open(); });
  assert.equal(await page.title(), "会议实时转录");
  assert.equal(await page.locator("#liveStart").isEnabled(), true);
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveStart").length), 0);
  await page.locator("#liveModel").selectOption("mimo-v2.5-asr");
  await page.waitForFunction(() => document.getElementById("liveTranscriptionIntervalField").hidden === false);
  assert.equal(await page.locator("#liveStart").textContent(), "开始分段转录");
  for (const size of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    const layout = await page.evaluate(() => {
      const panel = document.getElementById("liveMeetingPanel");
      const visible = [...panel.querySelectorAll("button, input, select")].filter((el) => el.getClientRects().length);
      return {
        overflow: visible.filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < -1 || rect.right > innerWidth + 1;
        }).map((el) => el.id),
        width: document.documentElement.scrollWidth,
        viewport: innerWidth
      };
    });
    assert.deepEqual(layout.overflow, [], `MiMo controls overflow at ${size.width}`);
    assert(layout.width <= layout.viewport + 1, `MiMo page overflow at ${size.width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, "meeting-live-mimo-1280.png") });
  await page.locator("#liveHistoryToggle").click();
  await page.waitForFunction(() => document.querySelectorAll("#liveHistoryList > button").length === 1);
  await page.locator("#liveHistoryList > button").click();
  await page.waitForFunction(() => document.getElementById("liveRaw").textContent === "历史会议原文");
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveOpenSession").at(-1).payload.sessionId), "recovered");
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveStart").length), 0);
  await page.locator("#liveModel").selectOption("qwen-audio-3.0-asr-flash-streaming");
  await page.waitForFunction(() => document.getElementById("liveStart").disabled === false);
  await page.locator("#liveChooseDestination").click();
  await page.locator("#liveTitle").fill("产品研发周会");
  await page.locator("#liveStart").click();
  await page.waitForFunction(() => document.getElementById("liveStop").disabled === false);
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveStart").at(-1).payload.provider), "aliyun-streaming");
  await page.evaluate(() => window.mockPush({ rawText: "<script>这只是原文，不应执行</script>\n\n" + "本周完成接口联调，下一步验证恢复与导出。\n".repeat(60) }));
  assert.equal(await page.locator("#liveRaw script").count(), 0);
  await page.locator("#liveStop").click();
  await page.waitForFunction(() => document.getElementById("liveStatus").title.includes("识别收尾"));
  await page.evaluate(() => window.mockPush({ status: "needs_retry", failedSegments: 1, pendingSegments: 0, error: { message: "模拟识别失败，录音已保留" } }));
  assert.equal(await page.locator("#liveRetry").isEnabled(), true);
  await page.locator("#liveRetry").click();
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveRetry").at(-1).payload.sessionId), "demo");
  await page.evaluate(() => window.mockPush({ status: "completed", recording: false, pendingSegments: 0, failedSegments: 0, error: null }));
  await page.locator("#liveSummarize").click();
  await page.waitForFunction(() => document.getElementById("livePostprocessStatus").textContent.includes("生成摘要"));
  await page.evaluate(() => window.mockPush({ postprocessStatus: "running",
    postprocessProgress: { stage: "receiving", outputChars: 1200, completed: 0, total: 1 } }));
  assert.match(await page.locator("#livePostprocessStatus").textContent(), /1200/);
  assert.equal(await page.locator("#liveCancelSummary").isEnabled(), true);
  for (const progress of [{ stage: "receiving", outputChars: 1200 }, { stage: "waiting" },
    { stage: "retrying", retry: 2, maxRetries: 5, delayMs: 4000 }]) {
    await page.evaluate(progress => window.mockPush({ postprocessStatus: "running",
      postprocessProgress: { ...progress, completed: 0, total: 1 } }), progress);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.locator("#livePostprocessStatus").scrollIntoViewIfNeeded();
      assert.equal(await page.locator("#liveCancelSummary").isEnabled(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${progress.stage} must not overflow at ${width}`);
      if (screenshotDirectory) {
        const file = path.join(screenshotDirectory, `meeting-live-${progress.stage}-${width}.png`);
        await page.screenshot({ path: file });
        screenshots.push(file);
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#liveCancelSummary").click();
  assert.match(await page.locator("#livePostprocessStatus").textContent(), /已取消/);
  assert.equal(await page.evaluate(() => window.mockCalls.filter(c => c.name === "meetingLiveCancelSummary").at(-1).payload.sessionId), "demo");
  assert.equal(await page.locator("#liveCancelSummary").isEnabled(), false);
  await page.locator("#liveSummarize").click();
  await page.evaluate(() => window.mockPush({ postprocessStatus: "completed",
    summary: { schema: "meeting_summary_v2", title: "Summary", markdown: "## 正文\nCoherent prose.", mindmap: { text: "Root", uncertain: false, provenance: [{ quote: "source only on the left" }], children: [] },
      sections: [{ heading: "正文", paragraphs: [{ text: "Coherent paragraph for the record.", uncertain: false, provenance: [{ quote: "private source quote" }] }], items: [] }] },
    summaryMarkdownPath: "C:/mock/summary.md" }));
  await page.waitForFunction(() => /Coherent paragraph/.test(document.getElementById("liveSummaryDetail").textContent));
  assert.equal(await page.locator("#liveDetailHeading").textContent(), "整理正文");
  assert.doesNotMatch(await page.locator("#liveSummaryDetail").textContent(), /来源：|private source quote|Details/);
  assert.match(await page.locator("#liveMindmap").textContent(), /source only on the left/);
  await page.evaluate(() => window.mockPush({ summary: { title: "Old", mindmap: { text: "Root", provenance: [], children: [] },
    sections: [{ heading: "旧决策", items: [{ text: "保留旧纪要", provenance: [] }] }] } }));
  assert.equal(await page.locator("#liveDetailHeading").textContent(), "详细纪要");
  assert.match(await page.locator("#liveSummaryDetail").textContent(), /保留旧纪要/);
  await page.evaluate(() => window.mockPush({ summary: { schema: "meeting_summary_v2", title: "Summary",
    mindmap: { text: "Root", uncertain: false, provenance: [], children: [] },
    sections: [{ heading: "正文", paragraphs: [{ text: "Coherent paragraph for the record.", uncertain: false, provenance: [] }], items: [] }] } }));
  await page.locator("#liveOpenSummary").click();
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveOpenPath").at(-1).payload.path), "C:/mock/summary.md");
  const viewports = [{ width: 1280, height: 900 }, { width: 960, height: 720 }, { width: 390, height: 844 }];
  for (const size of viewports) {
    await page.setViewportSize(size);
    await page.locator("#liveMeetingPanel").evaluate((el) => { el.scrollTop = 0; });
    const layout = await page.evaluate(() => {
      const panel = document.getElementById("liveMeetingPanel");
      const visible = [...panel.querySelectorAll("button, input, select")].filter((el) => el.getClientRects().length);
      const overflow = visible.filter((el) => { const rect = el.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1; }).map((el) => el.id);
      const overlaps = [];
      for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i].getBoundingClientRect();
        const b = visible[j].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push([visible[i].id, visible[j].id]);
      }
      const raw = document.getElementById("liveRaw");
      return { overflow, overlaps, width: document.documentElement.scrollWidth, viewport: innerWidth,
        transcriptScrolls: raw.scrollHeight > raw.clientHeight, panelHeight: panel.clientHeight };
    });
    assert.deepEqual(layout.overflow, [], `controls overflow at ${size.width}`);
    assert.deepEqual(layout.overlaps, [], `controls overlap at ${size.width}`);
    assert(layout.width <= layout.viewport + 1, `page overflow at ${size.width}`);
    assert(layout.transcriptScrolls, `raw transcript must scroll at ${size.width}`);
    assert(layout.panelHeight > 200);
    if (screenshotDirectory) {
      const file = path.join(screenshotDirectory, `meeting-live-${size.width}.png`);
      await page.screenshot({ path: file });
      screenshots.push(file);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#liveHistoryToggle").click();
  assert.equal(await page.locator("#liveHistoryBrowser").isVisible(), true);
  assert.equal(await page.locator("#legacyMeetingHistoryPanel").isVisible(), false);
  for (const size of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    const historyLayout = await page.evaluate(() => {
      const browser = document.getElementById("liveHistoryBrowser");
      const visible = [...browser.querySelectorAll("button, input")].filter((el) => el.getClientRects().length);
      return {
        overflow: visible.filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left < -1 || rect.right > innerWidth + 1;
        }).map((el) => el.id || el.className),
        pageWidth: document.documentElement.scrollWidth,
        viewport: innerWidth
      };
    });
    assert.deepEqual(historyLayout.overflow, [], `history controls overflow at ${size.width}`);
    assert(historyLayout.pageWidth <= historyLayout.viewport + 1, `history page overflow at ${size.width}`);
    if (screenshotDirectory) {
      const file = path.join(screenshotDirectory, `meeting-live-history-${size.width}.png`);
      await page.screenshot({ path: file });
      screenshots.push(file);
    }
  }
  await page.locator("#liveHistoryClose").click();
  await page.evaluate(() => window.applyWindowMode("file"));
  assert.equal(await page.locator("#filePanel").isVisible(), true);
  assert.equal(await page.locator("#meetingPanel").isVisible(), false);
  await page.evaluate(() => window.MeetingLiveUi.close());
  assert.deepEqual(errors, [], "browser exceptions");
  return { viewports, screenshots, errors, result: "real rendered mock UI passed" };
}

module.exports = { verifyBrowser, prepareBrowser, fixture, tick, deferred, completed };
if (require.main === module) (async () => {
  await run();
  if (process.exitCode || !process.argv.includes("--browser")) return;
  // Optional local Playwright install; never install packages or contact providers here.
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
  try {
    const screenshots = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "meeting-live-ui-"));
    console.log(JSON.stringify(await verifyBrowser(await browser.newPage(), screenshots), null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
