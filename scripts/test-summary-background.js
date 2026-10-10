"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const MeetingUi = require("../src/renderer/meeting-ui");
const TextSupplierUi = require("../src/renderer/text-supplier-ui");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "src/renderer/file-ui.js"), "utf8");
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function element(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(), value: "", textContent: "", hidden: false, disabled: false,
    dataset: {}, children: [],
    classList: { add: name => classes.add(name), contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
    setAttribute() {},
    get firstChild() { return this.children[0]; },
    get options() { return this.children.flatMap(child => child.tagName === "OPTGROUP" ? child.children : [child]); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    dispatch(name) { for (const fn of listeners.get(name) || []) fn({ preventDefault() {} }); },
    click() { if (!this.disabled) this.dispatch("click"); }
  };
}

function fixture(settingsPatch = {}, view = {}) {
  const elements = new Map([...html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)]
    .map(match => [match[2], element(match[1])]));
  const $ = id => elements.get(id);
  for (const id of ["fileAsrProviderSelect", "fileAsrModelSelect"]) {
    const markup = html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`))[1];
    for (const match of markup.matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)) {
      const option = element("option"); option.value = match[1]; option.textContent = match[2]; $(id).appendChild(option);
    }
  }
  const tabs = ["raw", "summary"].map(tab => {
    const button = element("button"); button.dataset.fileTab = tab; return button;
  });
  $("filePanel").querySelectorAll = () => tabs;
  const timers = new Set();
  const callbacks = new Set();
  const events = new Map();
  const modeCallbacks = new Set();
  const jobs = new Map();
  const calls = [];
  const sessions = ["file-a", "file-b"].map(id => ({ id, title: id, source: "import", hasArchive: true,
    hasRaw: true, status: "stopped", processing: { stage: "completed" } }));
  const settings = { meetingAnalysisModel: "analysis-a", meetingAnalysisProfiles: { "analysis-a": {} }, ...settingsPatch };
  const handlers = {
    getSettings: () => settings,
    saveSettings: patch => Object.assign(settings, require("../src/settings/connection-profiles").ensureConnectionProfiles({ ...settings, ...patch })),
    meetingListSessions: () => ({ ok: true, sessions }),
    meetingScanSession: id => ({ ok: true, session: { id, status: "stopped" } }),
    meetingProcessStatus: () => ({ ok: true, processing: { stage: "completed" } }),
    meetingTranscriptGet: ({ sessionId }) => ({ ok: true, transcript: { items: [{ text: `Original ${sessionId}` }] } }),
    meetingFileSummaryStatus: ({ sessionId }) => ({ ok: true, summary: jobs.get(sessionId) || { sessionId, status: "idle" } }),
    meetingFileSummaryStart: ({ sessionId }) => {
      const summary = { sessionId, status: "running" }; jobs.set(sessionId, summary); return { ok: true, summary };
    },
    meetingFileSummaryCancel: ({ sessionId }) => {
      const summary = { sessionId, status: "cancelled" }; jobs.set(sessionId, summary); return { ok: true, summary };
    },
    meetingAnalysisSummary: () => ({ ok: false }),
    fileImportMedia: () => ({ ok: true, cancelled: true })
  };
  const api = Object.fromEntries(Object.keys(handlers).map(name => [name, async payload => {
    calls.push({ name, payload }); return handlers[name](payload);
  }]));
  api.onMeetingFileSummaryUpdate = callback => { callbacks.add(callback); return () => callbacks.delete(callback); };
  api.onWindowMode = callback => modeCallbacks.add(callback);
  const doc = { getElementById: $, createElement: element, body: element("body") };
  let mode = "file";
  const setMode = value => {
    mode = value; doc.body.classList.toggle("file-mode", value === "file");
    for (const callback of modeCallbacks) callback(value);
  };
  setMode("file");
  const preferences = new Map();
  const storage = view.storage || { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) };
  const win = { mimoInput: api, TextSupplierUi, AsrDefaults: require("../src/asr-defaults"), applyWindowMode: setMode,
    innerWidth: view.width || 1180, localStorage: storage,
    addEventListener: (name, callback) => events.set(name, callback),
    MeetingUi: { ...MeetingUi,
      appendTranscriptBlocks: (container, blocks) => { container.textContent = blocks.map(block => block.text).join("\n"); },
      renderSummaryDocument: (container, summary) => { container.textContent = summary.markdown; }
    }
  };
  vm.runInNewContext(source, { window: win, document: doc, console,
    setInterval: callback => { timers.add(callback); return callback; },
    clearInterval: callback => timers.delete(callback), setTimeout });
  return {
    $, tabs, timers, callbacks, handlers, jobs, calls, events, setMode, storage, ui: win.FileTranscriptionUi,
    mode: () => mode,
    count: name => calls.filter(call => call.name === name).length,
    push(job) { jobs.set(job.sessionId, job); for (const callback of callbacks) callback(job); },
    async open() { await win.FileTranscriptionUi.openWorkspace({ fromModeEvent: true }); await tick(); },
    async change(id, value) { $(id).value = value; $(id).dispatch("change"); await tick(); },
    async click(id) { $(id).click(); await tick(); }
  };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
const finalJob = sessionId => ({ sessionId, status: "completed", summaryMarkdownPath: "C:/mock/article.md",
  summary: { schema: "meeting_summary_v2", markdown: "A complete coherent article.", sections: [] } });

test("file ASR follows dictation, persists explicit choices and can return to following", async () => {
  const f = fixture({ asrProvider: "qwen3-asr", asrModel: "qwen3-asr-flash", meetingFileAsrFollowDictation: true });
  await f.open();
  assert.equal(f.$("fileAsrModelSelect").value, "__dictation__");
  assert.equal(f.$("fileAsrProviderSelect").value, "__dictation__");
  assert.match(f.$("fileAsrConfigStatus").textContent, /qwen3-asr-flash/);
  await f.change("fileAsrModelSelect", "mimo-v2.5-asr");
  assert.equal(f.ui.state.settings.meetingFileAsrFollowDictation, false);
  assert.equal(f.ui.state.settings.meetingFileAsrProvider, "mimo");
  assert.match(f.$("fileAsrModelSelect").options.find(option => option.value === "__dictation__").textContent, /qwen3-asr-flash/);
  await f.change("fileAsrProviderSelect", "__dictation__");
  assert.equal(f.ui.state.settings.meetingFileAsrFollowDictation, true);
  assert.equal(f.ui.state.settings.meetingFileAsrModel, "qwen3-asr-flash");
  assert.equal(f.$("fileAsrModelSelect").value, "__dictation__");
});

test("file summary finishes while another page is visible; late start response cannot replace it", async () => {
  const f = fixture(); await f.open();
  const start = deferred();
  f.handlers.meetingFileSummaryStart = () => start.promise;
  await f.click("fileAnalysisStartBtn");
  f.setMode("settings");
  assert.equal(f.timers.size, 0);
  f.push({ sessionId: "file-a", status: "running", progress: { stage: "receiving", outputChars: 1200 } });
  assert.equal(f.ui.state.summaryJob.progress.outputChars, 1200);
  f.push(finalJob("file-a"));
  start.resolve({ ok: true, summary: { sessionId: "file-a", status: "running" } });
  await tick();
  assert.equal(f.ui.state.summaryJob.status, "completed");
  assert.equal(f.mode(), "settings", "background completion does not navigate");
  await f.open();
  f.tabs[1].click(); await tick();
  assert.equal(f.$("fileResultContent").textContent, "A complete coherent article.");
  assert.equal(f.count("meetingFileSummaryStart"), 1);
  assert.equal(f.count("meetingFileSummaryCancel"), 0);
  assert.equal(f.callbacks.size, 1);
  f.events.get("beforeunload")();
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.timers.size, 0);
});

test("switching files keeps jobs independent and rejects an old file's late failure", async () => {
  const f = fixture(); await f.open();
  const start = deferred();
  f.handlers.meetingFileSummaryStart = () => start.promise;
  await f.click("fileAnalysisStartBtn");
  f.$("fileSessionList").children[1].click(); await tick();
  assert.equal(f.ui.state.selectedId, "file-b");
  f.push(finalJob("file-a"));
  start.reject(new Error("Old file failed"));
  await tick();
  assert.equal(f.ui.state.summaryJob.status, "idle");
  assert.equal(f.ui.state.summaryDoc, null);
  assert.equal(f.count("meetingFileSummaryCancel"), 0);
  f.$("fileSessionList").children[0].click(); await tick();
  assert.equal(f.ui.state.summaryJob.status, "completed");
  assert.equal(f.ui.state.summaryDoc.markdown, "A complete coherent article.");
  f.events.get("beforeunload")();
});

test("push completion wins over an older in-flight status poll", async () => {
  const f = fixture(); await f.open(); await f.click("fileAnalysisStartBtn");
  const stale = deferred();
  f.handlers.meetingFileSummaryStatus = () => stale.promise;
  for (const timer of f.timers) timer();
  await tick();
  f.push(finalJob("file-a"));
  stale.resolve({ ok: true, summary: { sessionId: "file-a", status: "running" } });
  await tick();
  assert.equal(f.ui.state.summaryJob.status, "completed");
  assert.equal(f.ui.state.summaryPath, "C:/mock/article.md");
  f.events.get("beforeunload")();
});

test("only explicit cancellation stops the selected summary, including after reopening", async () => {
  const f = fixture(); await f.open(); await f.click("fileAnalysisStartBtn");
  f.setMode("home");
  assert.equal(f.count("meetingFileSummaryCancel"), 0);
  await f.open();
  await f.click("fileAnalysisCancelBtn");
  assert.equal(f.count("meetingFileSummaryCancel"), 1);
  assert.equal(f.ui.state.summaryJob.status, "cancelled");
  f.events.get("beforeunload")();
});

test("file progress bridge forwards only the DTO and disposes its listener", () => {
  const listeners = new Map();
  let api, received;
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/preload.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke() {}, on: (name, callback) => listeners.set(name, callback),
        removeListener: name => listeners.delete(name) } })
  });
  const off = api.onMeetingFileSummaryUpdate(value => { received = value; });
  listeners.get("meeting:file-summary:update")({ privateElectronEvent: true }, { sessionId: "file-a", status: "completed" });
  assert.equal(received.status, "completed");
  assert.equal(received.privateElectronEvent, undefined);
  off();
  assert.equal(listeners.has("meeting:file-summary:update"), false);
});

async function verifyBrowser(page, screenshotDirectory) {
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const errors = await prepareBrowser(page);
  const screenshots = [];
  await page.locator("#homeMeetingOpen").click();
  await page.waitForFunction(() => document.body.classList.contains("meeting-mode"));
  await page.evaluate(() => window.mockPush({
    sessionId: "background-meeting", status: "completed", recording: false,
    rawText: "Synthetic meeting transcript for the background navigation test.",
    pendingSegments: 0, failedSegments: 0, window: { floating: false }
  }));
  await page.locator("#liveSummarize").click();
  await page.waitForFunction(() => window.mockCalls.some(call => call.name === "meetingLiveSummarize"));
  await page.locator("#settingsBtn").click();
  await page.waitForFunction(() => document.body.classList.contains("settings-open"));
  await page.evaluate(() => window.mockPush({ postprocessStatus: "running",
    postprocessProgress: { kind: "summary", stage: "receiving", outputChars: 1200 } }));
  await page.evaluate(() => window.mockPush({ postprocessStatus: "completed",
    summaryMarkdownPath: "C:/mock/background-meeting.md", summary: {
      schema: "meeting_summary_v2", title: "Background meeting", markdown: "The meeting summary completed in the background.",
      mindmap: { text: "Overview", children: [], provenance: [] },
      sections: [{ heading: "Article", paragraphs: [{ text: "The meeting summary completed in the background." }], items: [] }]
    }
  }));
  assert.equal(await page.locator("#settingsPanel").isVisible(), true, "completion must not steal the active page");
  await page.locator("#homeBtn").click();
  await page.waitForFunction(() => document.body.classList.contains("home-mode"));
  await page.locator("#homeMeetingOpen").click();
  await page.waitForFunction(() => document.querySelector("#liveSummaryDetail").textContent.includes("completed in the background"));
  assert.equal(await page.locator("#liveSummarySection").isVisible(), true);
  assert.equal(await page.locator("#liveOpenSummary").isEnabled(), true);
  assert.equal(await page.evaluate(() => window.mockCalls.filter(call => call.name === "meetingLiveSummarize").length), 1);
  assert.equal(await page.evaluate(() => window.mockCalls.filter(call => call.name === "meetingLiveCancelSummary").length), 0);
  if (screenshotDirectory) {
    await page.locator("#liveSummarySection").scrollIntoViewIfNeeded();
    const file = path.join(screenshotDirectory, "background-meeting-completed.png");
    await page.screenshot({ path: file }); screenshots.push(file);
  }

  await page.evaluate(() => {
    const sessionId = "background-file";
    const test = window.backgroundFileTest = { starts: 0, cancels: 0, job: { sessionId, status: "idle" } };
    window.mockApiOverrides = {
      meetingListSessions: async () => ({ ok: true, sessions: [{ id: sessionId, title: "Background file",
        source: "import", hasArchive: true, hasRaw: true, status: "stopped", processing: { stage: "completed" } }] }),
      meetingScanSession: async () => ({ ok: true, session: { id: sessionId, status: "stopped" } }),
      meetingProcessStatus: async () => ({ ok: true, processing: { stage: "completed" } }),
      meetingTranscriptGet: async () => ({ ok: true, transcript: { items: [{ text: "Synthetic file transcript." }] } }),
      meetingFileSummaryStatus: async () => ({ ok: true, summary: test.job }),
      meetingFileSummaryStart: async () => {
        test.starts++;
        test.job = { sessionId, status: "running" };
        // Deliberately leave the start reply pending through off-screen completion.
        return new Promise(resolve => { test.resolveStart = resolve; });
      },
      meetingFileSummaryCancel: async () => { test.cancels++; return { ok: true }; },
      fileImportMedia: async () => ({ ok: true, cancelled: true }),
      meetingAnalysisSummary: async () => ({ ok: false })
    };
  });
  await page.locator("#fileBtn").click();
  await page.waitForFunction(() => window.FileTranscriptionUi.state.selectedId === "background-file"
    && !document.getElementById("fileAnalysisStartBtn").disabled);
  await page.locator("#fileAnalysisStartBtn").click();
  await page.waitForFunction(() => window.backgroundFileTest.starts === 1);
  await page.locator("#settingsBtn").click();
  await page.waitForFunction(() => document.body.classList.contains("settings-open"));
  await page.evaluate(() => {
    const test = window.backgroundFileTest;
    test.job = { sessionId: "background-file", status: "running", progress: { stage: "receiving", outputChars: 2300 } };
    window.mockHooks.onMeetingFileSummaryUpdate(test.job);
  });
  assert.equal(await page.evaluate(() => window.FileTranscriptionUi.state.summaryJob.progress.outputChars), 2300);
  await page.evaluate(() => {
    const test = window.backgroundFileTest;
    test.job = { sessionId: "background-file", status: "completed", summaryMarkdownPath: "C:/mock/background-file.md",
      summary: { schema: "meeting_summary_v2", title: "Background file", markdown: "The file summary completed in the background.",
        mindmap: { text: "Overview", children: [], provenance: [] },
        sections: [{ heading: "Article", paragraphs: [{ text: "The file summary completed in the background." }], items: [] }] } };
    window.mockHooks.onMeetingFileSummaryUpdate(test.job);
    test.resolveStart({ ok: true, summary: { sessionId: "background-file", status: "running" } });
  });
  await page.waitForFunction(() => window.FileTranscriptionUi.state.summaryJob.status === "completed");
  assert.equal(await page.locator("#settingsPanel").isVisible(), true);
  await page.locator("#homeBtn").click();
  await page.waitForFunction(() => document.body.classList.contains("home-mode"));
  await page.locator("#homeFileOpen").click();
  await page.waitForFunction(() => document.body.classList.contains("file-mode")
    && window.FileTranscriptionUi.state.summaryDoc?.title === "Background file");
  await page.locator('[data-file-tab="summary"]').click();
  await page.waitForFunction(() => document.querySelector("#fileResultContent").textContent.includes("completed in the background"));
  assert.equal(await page.locator("#fileResultContent").isVisible(), true);
  assert.equal(await page.evaluate(() => window.FileTranscriptionUi.state.summaryPath), "C:/mock/background-file.md");
  assert.deepEqual(await page.evaluate(() => ({ starts: window.backgroundFileTest.starts, cancels: window.backgroundFileTest.cancels })),
    { starts: 1, cancels: 0 });
  if (screenshotDirectory) {
    const file = path.join(screenshotDirectory, "background-file-completed.png");
    await page.screenshot({ path: file }); screenshots.push(file);
  }
  assert.deepEqual(errors, [], "browser exceptions");
  return { result: "file and meeting summaries survive settings/home navigation", screenshots, errors };
}

module.exports = { verifyBrowser, fixture };
if (require.main === module) (async () => {
  for (const { name, run } of tests) { await run(); console.log(`ok - ${name}`); }
  console.log(`${tests.length} background summary tests passed`);
  if (!process.argv.includes("--browser")) return;
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
  try {
    const screenshots = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "summary-background-ui-"));
    console.log(JSON.stringify(await verifyBrowser(await browser.newPage(), screenshots), null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
