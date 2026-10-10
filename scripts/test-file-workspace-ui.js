"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture } = require("./test-summary-background");

async function contracts() {
  const f = fixture();
  await f.open();
  assert.equal(f.$("fileProcessStartBtn").hidden, true, "completed transcription omits its unavailable start action");
  for (const id of ["fileProcessRetryBtn", "fileProcessCancelBtn", "fileAnalysisRetryBtn", "fileAnalysisCancelBtn"]) {
    assert.equal(f.$(id).hidden, true, `${id} only appears when it can be used`);
  }
  assert.equal(f.$("fileAnalysisStartBtn").hidden, false);
  const selected = f.ui.state.selectedId;
  assert.equal(f.$("fileHistorySidebar").hidden, true);
  assert.equal(f.$("fileSetupDetails").open, true);
  await f.click("fileHistoryToggle");
  assert.equal(f.$("fileHistorySidebar").hidden, false);
  assert.equal(f.$("fileSetupDetails").open, true, "desktop sidebars are independent");
  await f.click("fileSetupClose");
  assert.equal(f.$("fileSetupDetails").open, false);
  assert.equal(f.$("fileHistorySidebar").hidden, false);
  await f.click("fileHistoryClose");
  assert.equal(f.ui.state.selectedId, selected);
  assert.equal(f.count("meetingFileSummaryStart"), 0);
  assert.equal(f.count("meetingFileSummaryCancel"), 0);
  const configured = { asrConnections: { aliyun: { apiKey: "test-only-asr-key" } } };
  const reopened = fixture(configured, { storage: f.storage });
  await reopened.open();
  assert.equal(reopened.$("fileSetupDetails").open, false);
  assert.equal(reopened.$("fileHistorySidebar").hidden, true);
  const missing = fixture({}, { storage: f.storage });
  await missing.open();
  assert.equal(missing.$("fileSetupDetails").open, true, "unconfigured ASR overrides a previously closed setup");
  await missing.click("fileSetupClose");
  await missing.click("fileRefreshBtn");
  assert.equal(missing.$("fileSetupDetails").open, false, "list refresh must not force setup open again");
  const narrow = fixture({}, { width: 720 });
  await narrow.click("fileHistoryToggle");
  assert.equal(narrow.$("fileHistorySidebar").hidden, false);
  assert.equal(narrow.$("fileSetupDetails").open, false);
  await narrow.click("fileSetupToggle");
  assert.equal(narrow.$("fileHistorySidebar").hidden, true);
  assert.equal(narrow.$("fileSetupDetails").open, true);
  await narrow.click("fileSidebarBackdrop");
  assert.equal(narrow.$("fileSetupDetails").open, false);
  const toolbar = fixture(); await toolbar.open();
  toolbar.push({ sessionId: toolbar.ui.state.selectedId, status: "running", progress: { stage: "receiving", outputChars: 1200 } });
  assert.equal(toolbar.$("fileAnalysisStartBtn").hidden, true);
  assert.equal(toolbar.$("fileAnalysisCancelBtn").hidden, false);
  assert.equal(toolbar.$("fileAnalysisCancelBtn").disabled, false);
  toolbar.push({ sessionId: toolbar.ui.state.selectedId, status: "cancelling" });
  assert.equal(toolbar.$("fileAnalysisLabel").textContent, "正在取消…");
  toolbar.push({ sessionId: toolbar.ui.state.selectedId, status: "failed", error: { code: "network_error" } });
  assert.equal(toolbar.$("fileAnalysisStartBtn").hidden, true);
  assert.equal(toolbar.$("fileAnalysisCancelBtn").hidden, true);
  assert.equal(toolbar.$("fileAnalysisRetryBtn").hidden, false);
  assert.equal(toolbar.$("fileAnalysisRetryBtn").disabled, false);
  toolbar.push({ sessionId: toolbar.ui.state.selectedId, status: "completed" });
  assert.equal(toolbar.$("fileAnalysisRetryBtn").hidden, true);
  assert.equal(toolbar.$("fileAnalysisStartBtn").hidden, false);
  assert.equal(toolbar.$("fileAnalysisStartBtn").textContent, "重新生成摘要");
  console.log("PASS independent desktop sidebars, saved view state, exclusive narrow drawers and unchanged file jobs");
}

async function importTitles() {
  const f = fixture();
  const rows = [{ id: "old-file", title: "以前的自定义标题", source: "import", hasArchive: true,
    status: "stopped", importMeta: { sourceFileName: "旧课程.mp4", mediaKind: "video" } }];
  f.handlers.meetingListSessions = () => ({ ok: true, sessions: rows });
  f.handlers.meetingProcessStatus = () => ({ ok: true, processing: { stage: "idle" } });
  const names = ["新讲座.mp4", "另一段音频.wav", "专题素材.mp3", "下一节课程.m4a"];
  let imports = 0;
  f.handlers.fileImportMedia = ({ title }) => {
    const sourceFileName = names[imports++];
    const id = `new-file-${imports}`;
    rows.unshift({ id, title: title || path.parse(sourceFileName).name, source: "import", hasArchive: true,
      status: "stopped", importMeta: { sourceFileName } });
    return { ok: true, sessionId: id, status: "stopped" };
  };
  await f.open();
  assert.equal(f.$("fileTitleInput").value, "", "a history title must never become a new import's draft");
  for (const title of ["新讲座", "另一段音频"]) {
    await f.ui.chooseFile();
    assert.equal(f.$("fileSelectedName").textContent, title);
    assert.equal(f.$("fileSelectedName").title, title);
    assert.equal(f.$("fileTitleInput").value, "");
  }
  f.$("fileTitleInput").value = "我的专题整理";
  await f.click("fileRefreshBtn");
  assert.equal(f.$("fileTitleInput").value, "我的专题整理", "list refresh preserves an explicit new import title");
  await f.ui.chooseFile();
  assert.equal(f.$("fileSelectedName").textContent, "我的专题整理");
  assert.equal(f.$("fileTitleInput").value, "", "accepted imports consume their title draft once");
  f.$("fileSessionList").children.at(-1).click();
  await f.click("fileRefreshBtn");
  assert.equal(f.$("fileSelectedName").textContent, "以前的自定义标题");
  assert.equal(f.$("fileTitleInput").value, "", "returning to history does not repopulate the draft");
  await f.ui.chooseFile();
  assert.equal(f.$("fileSelectedName").textContent, "下一节课程");
  assert.deepEqual(f.calls.filter(call => call.name === "fileImportMedia").map(call => call.payload.title),
    ["", "", "我的专题整理", ""]);
  assert.equal(rows.find(row => row.id === "old-file").title, "以前的自定义标题", "history records remain unchanged");

  const selected = f.ui.state.selectedId;
  f.$("fileTitleInput").value = "暂存的标题";
  f.handlers.fileImportMedia = () => ({ ok: true, cancelled: true });
  await f.ui.chooseFile();
  assert.equal(f.$("fileTitleInput").value, "暂存的标题");
  assert.equal(f.ui.state.selectedId, selected);
  f.handlers.fileImportMedia = () => ({ ok: false, error: { message: "模拟导入失败" } });
  await assert.rejects(f.ui.chooseFile(), /模拟导入失败/);
  assert.equal(f.$("fileTitleInput").value, "暂存的标题");
  assert.equal(f.ui.state.selectedId, selected);
  let finish;
  f.handlers.fileImportMedia = () => new Promise(resolve => { finish = resolve; });
  const pending = f.ui.chooseFile();
  f.$("fileTitleInput").value = "下一份文件的标题";
  finish({ ok: true, sessionId: selected, status: "stopped" });
  await pending;
  assert.equal(f.$("fileTitleInput").value, "下一份文件的标题", "late import acceptance preserves a newer draft");
  console.log("PASS sequential file titles, history isolation, one-use custom titles and cancelled/failed import drafts");
}

async function browserChecks() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const directory = path.resolve(__dirname, "../output/playwright/file-workspace");
  fs.mkdirSync(directory, { recursive: true });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const errors = await prepareBrowser(page);
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.evaluate(async () => {
      window.fileToolbarTest = {
        processing: { stage: "completed", transcription: { segmentCompleted: 6, segmentTotal: 6 } },
        summary: { status: "completed", summary: { schema: "meeting_summary_v2", markdown: "测试摘要内容。", sections: [] } }
      };
      window.mockApiOverrides = {
        getSettings: async () => ({ asrProvider: "qwen3-asr", asrModel: "qwen3-asr-flash",
          asrConnections: { aliyun: { apiKey: "test-only-asr-key" } },
          textSuppliers: [{ id: "preview-provider", name: "测试供应商", baseUrl: "https://example.invalid/v1" }],
          textSupplierCatalogs: { "preview-provider": { models: ["codex-auto-review", "custom-summary-model"] } },
          textModelSelections: { summary: { supplierId: "preview-provider", modelId: "codex-auto-review" } } }),
        meetingListSessions: async () => ({ ok: true, sessions: ["项目讨论录音", "课程音频"].map((title, index) => ({
          id: `file-${index}`, title, source: "import", hasArchive: true, hasRaw: true,
          status: "stopped", processing: { stage: "completed" }
        })) }),
        meetingScanSession: async id => ({ ok: true, session: { id, status: "stopped" } }),
        meetingProcessStatus: async () => ({ ok: true, processing: window.fileToolbarTest.processing }),
        meetingTranscriptGet: async ({ sessionId }) => ({ ok: true, transcript: { items: [{
          text: `${sessionId}：我们讨论了项目进展、下一步安排和需要确认的问题。\n\n`.repeat(80)
        }] } }),
        meetingFileSummaryStatus: async ({ sessionId }) => ({ ok: true, summary: { sessionId, ...window.fileToolbarTest.summary } })
      };
      window.applyWindowMode("file");
      await window.FileTranscriptionUi.openWorkspace({ fromModeEvent: true });
    });
    await page.waitForFunction(() => document.getElementById("fileSelectedName").textContent === "项目讨论录音");
    assert.equal(await page.locator(".file-main #fileSetupDetails").count(), 0);
    assert.equal(await page.locator("#fileSetupSidebar").isVisible(), true);
    const bounds = selector => page.locator(selector).boundingBox();
    const model = await bounds("#fileAsrModelSelect");
    const provider = await bounds("#fileAsrProviderSelect");
    assert(model.y >= provider.y + provider.height, "ASR settings run vertically");
    const withSetup = await bounds("#fileResultPane");
    async function dragSidebar(selector, delta) {
      const rect = await bounds(selector);
      await page.mouse.move(rect.x + rect.width / 2, rect.y + 90);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.width / 2 + delta, rect.y + 90, { steps: 5 });
      await page.mouse.up();
    }
    const setupBefore = (await bounds("#fileSetupSidebar")).width;
    await dragSidebar('#fileSetupSidebar [data-sidebar-resize="setup"]', 50);
    assert.equal((await bounds("#fileSetupSidebar")).width, setupBefore + 50, "dragging changes actual sidebar width");
    assert((await bounds("#fileResultPane")).width < withSetup.width - 45, "the result pane adapts to sidebar resizing");
    assert.equal(await page.locator("#fileSetupClose .sidebar-collapse-icon").evaluate(el => getComputedStyle(el).transform), "matrix(-1, 0, 0, -1, 0, 0)");
    await page.screenshot({ path: path.join(directory, "file-settings-sidebar.png") });
    await page.locator("#fileHistoryToggle").click();
    assert.equal(await page.locator("#fileHistorySidebar").isVisible(), true);
    const historyBefore = (await bounds("#fileHistorySidebar")).width;
    await page.locator('#fileHistorySidebar [data-sidebar-resize="history"]').focus();
    await page.keyboard.press("ArrowRight");
    assert.equal((await bounds("#fileHistorySidebar")).width, historyBefore + 16, "keyboard resizing is supported independently");
    await page.locator("#fileSessionList > button").nth(1).click();
    await page.waitForFunction(() => document.getElementById("fileSelectedName").textContent === "课程音频");
    await page.screenshot({ path: path.join(directory, "file-both-sidebars.png") });
    await page.locator("#fileSetupClose").click();
    assert.equal(await page.locator("#fileHistorySidebar").isVisible(), true);
    await page.locator("#fileHistoryClose").click();
    assert((await bounds("#fileResultPane")).width > withSetup.width + 240, "collapsed sidebars return width to the main results");
    assert.equal(await page.locator("#fileSelectedName").textContent(), "课程音频");
    assert.equal(await page.locator("#fileHint").isVisible(), true, "processing feedback stays in the main area when both sidebars are closed");
    const transcriptionGroup = await bounds(".file-transcription-controls");
    const summaryGroup = await bounds(".file-summary-controls");
    assert(Math.abs(transcriptionGroup.y + transcriptionGroup.height / 2 - summaryGroup.y - summaryGroup.height / 2) < 1,
      "complete workflow groups share one row when the workspace is wide enough");
    assert.equal(await page.locator("#fileProcessStartBtn").isVisible(), false);
    assert.equal(await page.locator("#fileAnalysisStartBtn").textContent(), "重新生成摘要");
    assert.equal(await page.locator("#fileSummaryModelSelect option:checked").textContent(), "codex-auto-review");
    assert.equal(await page.locator(".file-summary-model-field > span").isVisible(), true);
    assert.equal(await page.locator(".file-summary-controls").evaluate(el => getComputedStyle(el).justifyContent), "flex-start");
    assert.equal(await page.locator("#fileProcessLabel").textContent(), "已完成");
    assert.equal(await page.locator("#fileProcessProgress").textContent(), "6/6");
    const summaryHeading = await bounds(".file-summary-controls .file-operation-heading");
    const modelField = await bounds(".file-summary-model-field");
    const reviewField = await bounds(".file-summary-controls .file-check");
    const summaryAction = await bounds("#fileAnalysisStartBtn");
    assert.equal(modelField.y, reviewField.y, "summary model and review stay on one line at desktop width");
    assert.equal(modelField.y, summaryAction.y, "summary settings and the generate action stay on one line at desktop width");
    for (const [left, right] of [[summaryHeading, modelField], [modelField, reviewField], [reviewField, summaryAction]]) {
      assert(right.x - left.x - left.width < 14, "related controls stay adjacent instead of filling empty space");
    }
    await page.screenshot({ path: path.join(directory, "file-full-reading.png") });
    const toolbarBounds = await bounds(".file-process");
    await page.screenshot({ path: path.join(directory, "file-toolbar-completed.png"), clip: {
      x: toolbarBounds.x, y: toolbarBounds.y, height: Math.ceil(toolbarBounds.height),
      width: Math.ceil(summaryAction.x + summaryAction.width + 12 - toolbarBounds.x)
    } });
    await page.evaluate(() => {
      window.fileToolbarTest.processing = { stage: "idle" };
      window.fileToolbarTest.summary = { status: "idle" };
      window.importHintTest = { status: "importing", phase: "commit" };
      window.mockApiOverrides.fileImportMedia = async () => ({ ok: true, sessionId: "file-0", status: "importing" });
      window.mockApiOverrides.fileImportStatus = async () => ({ ...window.importHintTest });
      window.importHintTask = window.FileTranscriptionUi.chooseFile();
    });
    await page.waitForFunction(() => document.getElementById("fileHint").textContent === "保存文件…");
    assert.equal(await page.locator("#fileHint").getAttribute("data-kind"), "processing");
    assert.equal(await page.locator("#fileHint").getAttribute("aria-busy"), "true");
    for (const platform of ["win32", "darwin"]) {
      await page.evaluate(platform => document.documentElement.dataset.platform = platform, platform);
      for (const width of [1180, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.locator("#fileHint").screenshot({ path: path.join(directory, `file-status-saving-${platform}-${width}.png`) });
      }
    }
    assert.equal(await page.locator("#fileHint").evaluate(el => getComputedStyle(el, "::before").animationName), "none",
      "reduced motion keeps the loading indicator static");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await page.locator("#fileHint").evaluate(el => getComputedStyle(el, "::before").animationName), "file-status-spin");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(async () => {
      window.importHintTest = { status: "stopped" };
      await window.importHintTask;
    });
    assert.equal(await page.locator("#fileHint").getAttribute("data-kind"), "success");
    assert.equal(await page.locator("#fileHint").getAttribute("aria-busy"), "false");
    await page.locator("#fileHint").screenshot({ path: path.join(directory, "file-status-imported.png") });
    await page.evaluate(() => {
      window.mockApiOverrides.fileImportMedia = async () => ({ ok: false,
        error: { message: "无法读取所选文件，请检查文件权限和可用磁盘空间后重试。" } });
    });
    await page.locator("#fileChooseBtn").click();
    await page.waitForFunction(() => document.getElementById("fileHint").dataset.kind === "error");
    assert.equal(await page.locator("#fileHint").getAttribute("aria-busy"), "false");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.locator("#fileHint").screenshot({ path: path.join(directory, "file-status-error-narrow.png") });
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.evaluate(async () => {
      window.fileToolbarTest.processing = { stage: "completed", transcription: { segmentCompleted: 6, segmentTotal: 6 } };
      window.fileToolbarTest.summary = { status: "completed", summary: {
        schema: "meeting_summary_v2", markdown: "测试摘要内容。", sections: []
      } };
      await window.FileTranscriptionUi.openWorkspace({ fromModeEvent: true });
    });
    async function showToolbarState(processing, summary) {
      await page.evaluate(({ processing, summary }) => {
        window.fileToolbarTest.processing = processing;
        window.fileToolbarTest.summary = summary;
        window.FileTranscriptionUi.state.process = processing;
        window.mockHooks.onMeetingFileSummaryUpdate({ sessionId: window.FileTranscriptionUi.state.selectedId, ...summary });
      }, { processing, summary });
    }
    await showToolbarState({ stage: "transcribing", transcription: { segmentCompleted: 2, segmentTotal: 6 } }, { status: "idle" });
    assert.equal(await page.locator("#fileProcessCancelBtn").isEnabled(), true);
    assert.equal(await page.locator("#fileProcessCancelBtn").isVisible(), true);
    assert.equal(await page.locator("#fileProcessStartBtn").isVisible(), false);
    await page.locator(".file-process").screenshot({ path: path.join(directory, "file-toolbar-transcribing.png") });
    await showToolbarState({ stage: "completed" }, { status: "running", progress: { stage: "receiving", outputChars: 1200 } });
    assert.equal(await page.locator("#fileAnalysisCancelBtn").isVisible(), true);
    assert.equal(await page.locator("#fileAnalysisCancelBtn").isEnabled(), true);
    assert.equal(await page.locator("#fileAnalysisStartBtn").isVisible(), false);
    await page.locator(".file-process").screenshot({ path: path.join(directory, "file-toolbar-summarizing.png") });
    await showToolbarState({ stage: "failed" }, { status: "idle" });
    assert.equal(await page.locator("#fileProcessRetryBtn").isEnabled(), true);
    assert.equal(await page.locator("#fileProcessRetryBtn").isVisible(), true);
    assert.equal(await page.locator("#fileProcessStartBtn").isVisible(), false);
    await showToolbarState({ stage: "completed" }, { status: "failed", error: { code: "context_limit" } });
    assert.equal(await page.locator("#fileAnalysisRetryBtn").isVisible(), true);
    assert.equal(await page.locator("#fileAnalysisRetryBtn").isEnabled(), true);
    await page.locator(".file-process").screenshot({ path: path.join(directory, "file-toolbar-summary-failed.png") });
    await showToolbarState({ stage: "completed", transcription: { segmentCompleted: 6, segmentTotal: 6 } },
      { status: "completed", summary: { schema: "meeting_summary_v2", markdown: "测试摘要内容。", sections: [] } });
    await page.setViewportSize({ width: 720, height: 900 });
    const narrowTranscription = await bounds(".file-transcription-controls");
    const narrowSummary = await bounds(".file-summary-controls");
    assert(narrowSummary.y >= narrowTranscription.y + narrowTranscription.height, "narrow workspaces stack whole workflow groups");
    await page.locator(".file-process").screenshot({ path: path.join(directory, "file-toolbar-narrow.png") });
    await page.setViewportSize({ width: 1180, height: 900 });
    for (const platform of ["win32", "darwin"]) {
      await page.evaluate(platform => document.documentElement.dataset.platform = platform, platform);
      for (const width of [1440, 1180, 960, 720, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator("#fileSetupToggle").click();
        assert.equal(await page.locator("#fileSetupSidebar").isVisible(), true);
        const layout = await page.evaluate(() => {
          const controls = [...document.querySelectorAll("#filePanel button, #filePanel select, #filePanel input")]
            .filter(el => el.getClientRects().length);
          return {
            overflow: controls.filter(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map(el => el.id),
            pageOverflow: document.documentElement.scrollWidth > innerWidth + 1
          };
        });
        assert.deepEqual(layout.overflow, [], `${platform} controls fit at ${width}`);
        assert.equal(layout.pageOverflow, false);
        if (width === 390) await page.locator(".file-process").screenshot({ path: path.join(directory, `file-toolbar-small-${platform}.png`) });
        if (width <= 900) {
          await page.locator("#fileSetupClose").click();
          await page.locator("#fileHistoryToggle").click();
          assert.equal(await page.locator("#fileSetupSidebar").isVisible(), false);
          assert.equal(await page.locator("#fileSidebarBackdrop").isVisible(), true);
          if (width === 720) {
            await page.locator("#fileSessionList > button").first().click();
            await page.waitForFunction(() => document.getElementById("fileHistorySidebar").hidden);
            assert.equal(await page.locator("#fileSelectedName").textContent(), "项目讨论录音");
            await page.locator("#fileHistoryToggle").click();
          }
          if (width === 390) await page.screenshot({ path: path.join(directory, `file-history-drawer-${platform}.png`) });
          await page.keyboard.press("Escape");
          assert.equal(await page.locator("#fileHistorySidebar").isVisible(), false);
          assert.equal(await page.locator("#fileSidebarBackdrop").isVisible(), false);
        } else await page.locator("#fileSetupClose").click();
      }
    }
    assert.equal(await page.evaluate(() => window.mockCalls.filter(call => /^(meetingProcessStart|meetingFileSummaryStart|meetingFileSummaryCancel|fileChooseMedia)$/.test(call.name)).length), 0);
    await page.setViewportSize({ width: 1180, height: 900 });
    for (const platform of ["win32", "darwin"]) {
      await page.evaluate(async platform => {
        document.documentElement.dataset.platform = platform;
        const test = window.fileTitleBrowserTest = { imports: [], rows: [{ id: "title-old", title: "旧记录的自定义标题",
          source: "import", status: "stopped", hasArchive: true, importMeta: { sourceFileName: "旧录音.mp4" } }] };
        window.mockApiOverrides.meetingListSessions = async () => ({ ok: true, sessions: test.rows });
        window.mockApiOverrides.meetingProcessStatus = async () => ({ ok: true, processing: { stage: "idle" } });
        window.mockApiOverrides.meetingFileSummaryStatus = async ({ sessionId }) => ({ ok: true, summary: { sessionId, status: "idle" } });
        window.mockApiOverrides.fileImportMedia = async ({ title }) => {
          test.imports.push(title);
          const index = test.imports.length;
          const name = `新文件${index}`;
          const id = `title-new-${index}`;
          test.rows.unshift({ id, title: title || name, source: "import", status: "stopped", hasArchive: true,
            importMeta: { sourceFileName: `${name}.mp4`, mediaKind: "video" } });
          return { ok: true, sessionId: id, status: "importing" };
        };
        window.mockApiOverrides.fileImportStatus = async () => ({ status: "stopped" });
        await window.FileTranscriptionUi.openWorkspace({ fromModeEvent: true, sessionId: "title-old" });
      }, platform);
      assert.equal(await page.locator("#fileTitleInput").inputValue(), "");
      for (const index of [1, 2]) {
        await page.locator("#fileChooseBtn").click();
        await page.waitForFunction(index => document.getElementById("fileSelectedName").textContent === `新文件${index}`
          && !window.FileTranscriptionUi.state.importBusy, index);
        assert.match(await page.locator("#fileSelectedMeta").textContent(), new RegExp(`新文件${index}\\.mp4`));
        assert.equal(await page.locator("#fileSelectedName").getAttribute("title"), `新文件${index}`);
        assert.equal(await page.locator("#fileTitleInput").inputValue(), "");
      }
      assert.deepEqual(await page.evaluate(() => window.fileTitleBrowserTest.imports), ["", ""]);
      await page.locator(".file-current-heading").screenshot({ path: path.join(directory, `file-new-import-title-${platform}.png`) });
      await page.locator("#fileHistoryToggle").click();
      await page.locator("#fileSessionList > button").last().click();
      await page.waitForFunction(() => document.getElementById("fileSelectedName").textContent === "旧记录的自定义标题");
      assert.equal(await page.locator("#fileTitleInput").inputValue(), "");
      await page.locator("#fileHistoryClose").click();
    }
    await page.reload();
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.evaluate(async () => { window.applyWindowMode("file"); await window.FileTranscriptionUi.openWorkspace({ fromModeEvent: true }); });
    assert.equal(await page.locator("#fileSetupToggle").getAttribute("aria-expanded"), "true", "missing ASR credentials expand setup after re-entry");
    assert.equal(await page.locator("#fileHistoryToggle").getAttribute("aria-expanded"), "false");
    assert.equal((await bounds("#fileSetupSidebar")).width, setupBefore + 50, "sidebar width survives reload");
    assert.match(await page.locator("#fileAsrConfigStatus").textContent(), /API Key/);

    await page.evaluate(async () => {
      window.mockApiOverrides = { getSettings: async () => ({ asrModel: "qwen3-asr-flash", asrProvider: "qwen3-asr",
        asrConnections: { aliyun: { apiKey: "test-only-asr-key" }, mimo: { apiKey: "test-only-mimo-key" } } }) };
      window.applyWindowMode("meeting"); await window.MeetingLiveUi.open();
    });
    assert.equal(await page.locator("#liveSetupSidebar").isVisible(), true);
    const sidebarTools = await bounds(".live-sidebar-tools");
    const heading = await bounds(".live-heading");
    assert.equal(sidebarTools.x, heading.x, "left sidebar controls stay at the left edge of the main header");
    assert.equal(await page.locator(".live-heading-title").isVisible(), false, "the detailed workspace omits its duplicate meeting title");
    const meetingBefore = (await bounds("#liveSetupSidebar")).width;
    await dragSidebar('#liveSetupSidebar [data-sidebar-resize="setup"]', 40);
    assert.equal((await bounds("#liveSetupSidebar")).width, meetingBefore + 40);
    await page.locator("#liveHistoryToggle").click();
    assert.equal(await page.locator("#liveSetupSidebar").isVisible(), true);
    assert.equal(await page.locator("#liveHistoryBrowser").isVisible(), true);
    await dragSidebar('#liveHistoryBrowser [data-sidebar-resize="history"]', 20);
    assert((await bounds(".live-main")).width >= 320, "resizing reserves a usable meeting reading area");
    await page.screenshot({ path: path.join(directory, "meeting-sidebars-resized.png") });
    await page.locator("#liveSetupToggle").click();
    await page.locator("#liveHistoryClose").click();
    await page.evaluate(async () => { window.MeetingLiveUi.close(); await window.MeetingLiveUi.open(); });
    assert.equal(await page.locator("#liveSetupSidebar").isVisible(), false, "valid settings retain the closed preference on return");
    await page.locator("#liveSetupToggle").click();
    assert.equal((await bounds("#liveSetupSidebar")).width, meetingBefore + 40);
    for (const platform of ["win32", "darwin"]) {
      await page.evaluate(platform => document.documentElement.dataset.platform = platform, platform);
      for (const width of [960, 720, 390]) {
        await page.setViewportSize({ width, height: 900 });
        if (width <= 900) {
          assert.equal(await page.locator('#liveSetupSidebar [data-sidebar-resize="setup"]').isVisible(), false);
          await page.waitForFunction(() => document.getElementById("liveSidebarBackdrop").hidden === false);
          await page.keyboard.press("Escape");
          assert.equal(await page.locator("#liveSetupSidebar").isVisible(), false);
          await page.locator("#liveHistoryToggle").click();
          assert.equal(await page.locator("#liveSidebarBackdrop").isVisible(), true);
          await page.keyboard.press("Escape");
          await page.locator("#liveSetupToggle").click();
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      }
      await page.screenshot({ path: path.join(directory, `meeting-settings-drawer-${platform}.png`) });
    }
    await page.evaluate(() => window.mockPush({ status: "recording", recording: true, sessionId: "demo",
      previewText: "实时转录内容", window: { floating: true } }));
    assert.equal(await page.locator("#liveSetupSidebar").isVisible(), false);
    assert.equal(await page.locator("#liveHistoryBrowser").isVisible(), false);
    assert.equal(await page.locator("#liveSidebarBackdrop").isVisible(), false);
    assert.equal(await page.locator("#liveSetupToggle").isVisible(), false);
    assert.deepEqual(errors, []);
    console.log("PASS browser: file/meeting sidebar dragging, keyboard resizing, safe configuration expansion, persistence, Windows/macOS drawers and floating isolation");
  } finally { await browser.close(); }
}

if (require.main === module) (async () => {
  await contracts();
  await importTitles();
  if (process.argv.includes("--browser")) await browserChecks();
})().catch(error => { console.error(error); process.exitCode = 1; });
