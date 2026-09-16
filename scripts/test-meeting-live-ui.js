"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLiveMeetingUi } = require("../src/renderer/live-meeting-ui");
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
  $("liveModel").value = "mimo-v2.5-asr";
  $("liveCaptureMode").value = "dual";
  let clock = 1800000000000;
  let status = { status: "idle", recording: false, recoverableSessions: [] };
  let settings = {
    meetingRealtimeModel: "mimo-v2.5-asr",
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
    meetingLiveStart: () => ({ ok: true, sessionId: "s1", status: "recording", recording: true, modelId: "mimo-v2.5-asr" }),
    meetingLiveStop: () => ({ ok: true, sessionId: "s1", status: "stopping", recording: false, pendingSegments: 2 }),
    meetingLiveRetry: () => ({ ok: true, ...status, status: "stopping" }),
    meetingLiveRecover: () => ({ ok: true, ...status, status: "interrupted" }),
    meetingLiveCleanup: () => ({ ok: true, ...status, cleanupStatus: "running", cleanupProgress: { completed: 0, total: 2 } }),
    meetingLiveChooseDestination: () => ({ ok: true, cancelled: false, destinationPath: "C:/mock/notes.md" }),
    meetingLiveOpenPath: () => ({ ok: true })
  };
  const api = Object.fromEntries(Object.keys(handlers).map((name) => [name, async (...args) => {
    calls.push({ name, args });
    return handlers[name](...args);
  }]));
  api.onMeetingLiveUpdate = (callback) => { callbacks.add(callback); return () => callbacks.delete(callback); };
  const win = { document: { getElementById: $, createElement: element }, mimoInput: api, addEventListener() {} };
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
  sessionId: "s1", status: "completed", recording: false, modelId: "mimo-v2.5-asr",
  rawText: "原始转写文本", pendingSegments: 0, failedSegments: 0, cleanupStatus: "idle", ...extra
});

test("view-only open is single-flight; close unsubscribes and reopen reloads", async () => {
  const f = fixture();
  await Promise.all([f.ui.open(), f.ui.open()]);
  assert.equal(f.count("meetingLiveStatus"), 1);
  assert.equal(f.count("meetingLiveStart"), 0);
  assert.equal(f.count("saveSettings"), 0);
  assert.equal(f.callbacks.size, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.$("liveStart").disabled, false);
  f.ui.close();
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.timers.size, 0);
  await f.ui.open();
  assert.equal(f.count("meetingLiveStatus"), 2);
  assert.equal(f.callbacks.size, 1);
  f.ui.close();
});

test("saved MiMo and Qwen batch profiles only; custom invalid models cannot start", async () => {
  const f = fixture();
  f.setSettings({ asrProfiles: {
    "custom-batch": { provider: "qwen3-asr" }, "fun-asr": { provider: "fun-asr" },
    "qwen-realtime": { provider: "qwen3-asr" }, "qwen-filetrans": { provider: "qwen3-asr" }
  } });
  await f.ui.open();
  const ids = f.$("liveModel").children.map((o) => o.value);
  assert(ids.includes("custom-batch"));
  assert(ids.includes("qwen3-asr-flash"));
  assert(!ids.includes("fun-asr") && !ids.includes("qwen-realtime") && !ids.includes("qwen-filetrans"));
  f.$("liveModel").value = "__custom__";
  f.$("liveCustomModel").value = "qwen-filetrans";
  f.$("liveModel").dispatch("change");
  assert.equal(f.$("liveCustomModelField").hidden, false);
  assert.equal(f.$("liveStart").disabled, true);
  assert.match(f.$("liveError").textContent, /不支持/);
  f.$("liveModel").value = "custom-batch";
  f.$("liveModel").dispatch("change");
  await tick();
  await f.click("liveStart");
  assert.equal(f.last("meetingLiveStart").args[0].provider, "qwen3-asr");
  assert.equal(f.last("meetingLiveStart").args[0].modelId, "custom-batch");
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
  assert.deepEqual(f.last("meetingLiveStart").args, [{ title: "项目例会", modelId: "mimo-v2.5-asr", provider: "mimo", captureMode: "microphone" }]);
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
  assert.match(f.$("liveStatus").textContent, /识别收尾/);
  assert.equal(f.count("meetingLiveCleanup"), 0);
  f.push(completed({ status: "needs_retry", failedSegments: 1 }));
  assert.equal(f.$("liveRetry").disabled, false);
  await f.click("liveRetry");
  assert.deepEqual(f.last("meetingLiveRetry").args, [{ sessionId: "s1" }]);
  f.push(completed({ status: "stopping", recording: true, error: { code: "live_stop_failed", message: "停止失败" } }));
  assert.equal(f.$("liveStop").disabled, false);
  assert.match(f.$("liveStop").textContent, /重试停止/);
});

test("recover selected persisted session without starting capture", async () => {
  const f = fixture();
  f.setStatus({ status: "idle", recoverableSessions: [{ sessionId: "old", title: "中断的例会", status: "interrupted", startedAtMs: 1800000000000 }] });
  await f.ui.open();
  assert.match(f.$("liveRecoverSession").children[1].textContent, /中断的例会/);
  f.$("liveRecoverSession").value = "old";
  await f.click("liveRecover");
  assert.deepEqual(f.last("meetingLiveRecover").args, [{ sessionId: "old" }]);
  assert.equal(f.count("meetingLiveStart"), 0);
  f.push(completed({ sessionId: "old", status: "interrupted" }));
  assert.equal(f.$("liveRetry").disabled, false);
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

test("cleanup is explicit, uses selected model, reports progress and opens only returned outputs", async () => {
  const f = fixture();
  await f.ui.open();
  const output = { markdownPath: "C:/mock/raw-s1.md", audioPaths: ["C:/mock/microphone-complete.wav", "C:/mock/system-complete.wav"] };
  f.push(completed(output));
  assert.equal(f.count("meetingLiveCleanup"), 0);
  f.$("liveCleanerModel").value = "analysis-b";
  await f.click("liveCleanup");
  assert.deepEqual(f.last("meetingLiveCleanup").args, [{ sessionId: "s1", modelId: "analysis-b" }]);
  f.push(completed({ ...output, cleanupStatus: "running", cleanupProgress: { completed: 1, total: 2 }, correctedText: "校订第一段" }));
  assert.match(f.$("liveCleanupStatus").textContent, /1 \/ 2/);
  assert.equal(f.$("liveCorrectedSection").hidden, false);
  assert.equal(f.$("liveCleanup").disabled, true);
  const cleaned = "C:/mock/raw-s1.cleaned-collision.md";
  f.push(completed({ ...output, cleanupStatus: "completed", correctedText: "校订结果", cleanedMarkdownPath: cleaned }));
  assert.equal(f.$("liveRaw").textContent, "原始转写文本");
  await f.click("liveOpenCleaned");
  assert.deepEqual(f.last("meetingLiveOpenPath").args, [{ path: cleaned }]);
  await f.click("liveOpenMarkdown");
  assert.deepEqual(f.last("meetingLiveOpenPath").args, [{ path: output.markdownPath }]);
  f.$("liveAudioOutputs").children[1].click();
  await tick();
  assert.deepEqual(f.last("meetingLiveOpenPath").args, [{ path: output.audioPaths[1] }]);
  f.push(completed({ cleanupStatus: "failed", error: { message: "校订失败" } }));
  assert.equal(f.$("liveCleanup").disabled, false);
  assert.match(f.$("liveCleanup").textContent, /重试/);
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

test("history tabs preserve legacy controls and file UI, with keyboard navigation", async () => {
  const f = fixture();
  await f.ui.open();
  await f.click("liveHistoryTab");
  assert.equal(f.$("meetingHistoryPanel").hidden, false);
  assert.equal(f.$("liveMeetingPanel").hidden, true);
  f.$("liveHistoryTab").dispatch("keydown", { key: "Home" });
  assert.equal(f.$("liveMeetingPanel").hidden, false);
  assert.equal(f.$("liveMeetingTab").focused, true);
  assert.equal(f.count("meetingLiveStart"), 0);
  for (const id of ["meetingSessionList", "meetingProcessStartBtn", "meetingResultPane", "filePanel", "fileProcessStartBtn"]) assert(f.$(id), id);
  assert(html.indexOf('src="./live-meeting-ui.js"') < html.indexOf('src="./renderer.js"'));
  assert.match(html, /legacy-capture-controls[^>]*hidden/);
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
async function verifyBrowser(page, screenshotDirectory) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const files = {
      "/": ["src/renderer/index.html", "text/html"],
      "/styles.css": ["src/renderer/styles.css", "text/css"],
      "/live-meeting.css": ["src/renderer/live-meeting.css", "text/css"],
      "/audio-utils.js": ["src/audio-utils.js", "text/javascript"],
      "/meeting-ui.js": ["src/renderer/meeting-ui.js", "text/javascript"],
      "/file-ui.js": ["src/renderer/file-ui.js", "text/javascript"],
      "/live-meeting-ui.js": ["src/renderer/live-meeting-ui.js", "text/javascript"],
      "/renderer.js": ["src/renderer/renderer.js", "text/javascript"]
    };
    const match = files[pathname];
    if (!match) return route.abort();
    return route.fulfill({ contentType: match[1], body: fs.readFileSync(path.join(root, match[0])) });
  });
  await page.addInitScript(() => {
    let dto = { status: "idle", recording: false, recoverableSessions: [] };
    let settings = {
      meetingRealtimeModel: "mimo-v2.5-asr", meetingFileAsrProfiles: { "mimo-v2.5-asr": { provider: "mimo" }, "qwen3-asr-flash": { provider: "qwen3-asr" } },
      meetingAnalysisModel: "analysis-demo", meetingAnalysisProfiles: { "analysis-demo": {} }
    };
    const hooks = {};
    window.mockCalls = [];
    window.mockPush = (patch) => { dto = { ...dto, ...patch }; hooks.onMeetingLiveUpdate?.(dto); };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: async () => [], getUserMedia: async () => { throw new Error("Microphone forbidden in UI test"); }
    } });
    window.mimoInput = new Proxy({}, { get(_target, name) {
      if (String(name).startsWith("on")) return (callback) => { hooks[name] = callback; return () => { delete hooks[name]; }; };
      return async (payload) => {
        window.mockCalls.push({ name, payload });
        if (name === "getSettings") return settings;
        if (name === "saveSettings") return settings = { ...settings, ...payload };
        if (name === "getStatus") return { settings, hasApiKey: false, registeredHotkeys: [] };
        if (name === "meetingLiveStatus") return { ok: true, ...dto };
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
        return { ok: true };
      };
    } });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("http://meeting-ui.mock/");
  await page.evaluate(async () => { window.applyWindowMode("meeting"); await window.MeetingLiveUi.open(); });
  assert.equal(await page.title(), "会议实时转录");
  assert.equal(await page.locator("#liveStart").isEnabled(), true);
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveStart").length), 0);
  await page.evaluate(() => window.mockPush({ recoverableSessions: [{ sessionId: "recovered", title: "中断会议", status: "interrupted", startedAtMs: Date.now() - 60000 }] }));
  await page.locator("#liveRecoverSession").selectOption("recovered");
  await page.locator("#liveRecover").click();
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveRecover").at(-1).payload.sessionId), "recovered");
  await page.locator("#liveModel").selectOption("qwen3-asr-flash");
  await page.waitForFunction(() => document.getElementById("liveStart").disabled === false);
  await page.locator("#liveChooseDestination").click();
  await page.locator("#liveTitle").fill("产品研发周会");
  await page.locator("#liveStart").click();
  await page.waitForFunction(() => document.getElementById("liveStop").disabled === false);
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveStart").at(-1).payload.provider), "qwen3-asr");
  await page.evaluate(() => window.mockPush({ rawText: "<script>这只是原文，不应执行</script>\n\n" + "本周完成接口联调，下一步验证恢复与导出。\n".repeat(60) }));
  assert.equal(await page.locator("#liveRaw script").count(), 0);
  await page.locator("#liveStop").click();
  await page.waitForFunction(() => document.getElementById("liveStatus").textContent.includes("识别收尾"));
  await page.evaluate(() => window.mockPush({ status: "needs_retry", failedSegments: 1, pendingSegments: 0, error: { message: "模拟识别失败，录音已保留" } }));
  assert.equal(await page.locator("#liveRetry").isEnabled(), true);
  await page.locator("#liveRetry").click();
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveRetry").at(-1).payload.sessionId), "demo");
  await page.evaluate(() => window.mockPush({ status: "completed", recording: false, pendingSegments: 0, failedSegments: 0, error: null }));
  await page.locator("#liveCleanup").click();
  await page.waitForFunction(() => document.getElementById("liveCleanupStatus").textContent.includes("1 / 2"));
  await page.evaluate(() => window.mockPush({ cleanupStatus: "completed", correctedText: "本周完成接口联调。\n下一步验证恢复与导出。\n".repeat(30), cleanedMarkdownPath: "C:/mock/项目例会-demo.cleaned-unique.md" }));
  await page.locator("#liveOpenCleaned").click();
  assert.equal(await page.evaluate(() => window.mockCalls.filter((c) => c.name === "meetingLiveOpenPath").at(-1).payload.path), "C:/mock/项目例会-demo.cleaned-unique.md");
  const viewports = [{ width: 1280, height: 900 }, { width: 960, height: 720 }, { width: 390, height: 844 }];
  const screenshots = [];
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
  await page.locator("#liveHistoryTab").click();
  assert.equal(await page.locator("#meetingHistoryPanel").isVisible(), true);
  assert.equal(await page.locator("#meetingStartBtn").isVisible(), false);
  await page.locator("#liveMeetingTab").click();
  await page.evaluate(() => window.applyWindowMode("file"));
  assert.equal(await page.locator("#filePanel").isVisible(), true);
  assert.equal(await page.locator("#meetingPanel").isVisible(), false);
  await page.evaluate(() => window.MeetingLiveUi.close());
  assert.deepEqual(errors, [], "browser exceptions");
  return { viewports, screenshots, errors, result: "real rendered mock UI passed" };
}

module.exports = { verifyBrowser };
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
