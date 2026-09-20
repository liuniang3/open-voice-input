"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture, tick, deferred, completed, verifyBrowser } = require("./test-meeting-live-ui");
const tests = [];
const test = (name, run) => tests.push({ name, run });
const recording = (patch = {}) => completed({ status: "recording", recording: true, ...patch });
const allText = (node) => [node.textContent, ...node.children.map(allText)].join("\n");

test("streaming preset, meeting profiles and independent cleaner/reviewer IDs carry no credentials", async () => {
  const f = fixture();
  const model = "qwen-audio-3.0-asr-flash-streaming";
  f.setSettings({ meetingRealtimeModel: undefined, meetingCaptureMode: "system",
    meetingRealtimeProfiles: { "qwen-audio-3.0-asr-flash-streaming-test": { provider: "aliyun-streaming", apiKey: "not-a-real-secret" } },
    meetingQwenProfiles: { [model]: { provider: "qwen3-asr", apiKey: "not-a-real-secret" } },
    cleanerModel: "cleaner-special", cleanerProfiles: { "cleaner-special": { apiKey: "not-a-real-secret" }, "cleaner-second": {} }
  });
  await f.ui.open();
  assert.equal(f.$("liveModel").value, model);
  assert(!f.$("liveModel").children.some(o => o.value === "qwen-audio-3.0-asr-flash-streaming-test"));
  assert.equal(f.$("liveCleanerModel").value, "analysis-a");
  assert(f.$("liveCleanerModel").children.some(o => o.value === "cleaner-second"));
  assert.equal(f.$("liveReviewModel").value, "mimo-v2.5-asr");
  await f.click("liveStart");
  assert.equal(f.last("meetingLiveStart").args[0].captureMode, "system");
  assert.equal(f.last("meetingLiveStart").args[0].modelId, model);
  assert(!JSON.stringify(f.calls).includes("not-a-real-secret"));
  f.push(completed());
  f.$("liveUseMimoReview").checked = true;
  f.$("liveUseMimoReview").dispatch("change");
  assert.equal(f.$("liveReviewModelField").hidden, false);
  await f.click("liveCleanup");
  assert.deepEqual(f.last("meetingLiveCleanup").args[0], { sessionId: "s1", modelId: "analysis-a", useMimoReview: true, reviewModelId: "mimo-v2.5-asr" });
  assert.equal(f.count("meetingLiveSummarize"), 0);
});

test("MiMo batch fallback stays selectable; meeting analysis takes priority over dictation cleanup", async () => {
  const f = fixture();
  f.setSettings({ meetingRealtimeModel: "mimo-v2.5-asr", cleanerModel: "dictation-cleaner",
    meetingAnalysisModel: "meeting-analysis", meetingRealtimeProfiles: { "mimo-only-live-asr": { provider: "mimo" } },
    asrProfiles: { "mimo-custom-asr": { provider: "mimo" }, "mimo-chat": { provider: "mimo" }, "qwen3-asr-flash": { provider: "qwen3-asr" } },
    meetingFileAsrProfiles: { "mimo-file-asr": { provider: "mimo" } }
  });
  await f.ui.open();
  assert.equal(f.$("liveModel").value, "mimo-v2.5-asr");
  assert.deepEqual(f.$("liveModel").children.map(o => o.value),
    ["qwen-audio-3.0-asr-flash-streaming", "fun-asr-realtime", "mimo-v2.5-asr", "__custom__"]);
  assert.equal(f.$("liveTranscriptionIntervalField").hidden, false);
  assert.deepEqual(f.$("liveReviewModel").children.map(o => o.value), ["mimo-v2.5-asr", "mimo-file-asr", "mimo-custom-asr"]);
  assert.equal(f.$("liveCleanerModel").value, "meeting-analysis");
});

test("draft replacement never mutates confirmed text; pause freezes clock and can stop", async () => {
  const f = fixture();
  await f.ui.open();
  f.push(recording({ previewText: "partial one", previewStatus: "streaming" }));
  f.advance(2000);
  f.push(recording({ previewText: "partial two", previewStatus: "streaming" }));
  assert.equal(f.$("liveRaw").textContent, "原始转写文本");
  assert.equal(f.$("livePreview").textContent, "partial two");
  await f.click("livePause");
  assert.equal(f.$("livePause").textContent, "继续录制");
  const elapsed = f.$("liveElapsed").textContent;
  f.advance(60000);
  assert.equal(f.$("liveElapsed").textContent, elapsed);
  assert.equal(f.$("liveCleanupSection").hidden, true);
  assert.equal(f.$("liveStart").disabled, true);
  await f.click("livePause");
  assert.equal(f.count("meetingLiveResume"), 1);
  f.push(recording({ status: "paused", recording: false, paused: true }));
  assert.equal(f.$("liveStop").disabled, false);
  await f.click("liveStop");
  assert.equal(f.count("meetingLiveStop"), 1);
});

test("window IPC is confirmed, reversible and independent from capture and stale responses", async () => {
  const f = fixture();
  await f.ui.open();
  assert.equal(f.$("liveFloat").hidden, true);
  f.push(recording());
  const windowCall = deferred();
  f.handlers.meetingLiveWindow = () => windowCall.promise;
  await f.click("liveFloat");
  assert.equal(f.$("meetingPanel").classList.contains("live-floating"), false);
  const stop = deferred();
  f.handlers.meetingLiveStop = () => stop.promise;
  await f.click("liveStop");
  windowCall.resolve({ ok: true, floating: true, compact: false, alwaysOnTop: true });
  await tick();
  stop.resolve({ ok: true, ...completed() });
  await tick();
  assert.equal(f.$("liveStatus").textContent, "已完成");
  assert.equal(f.$("liveAlwaysOnTop").checked, true);
  f.handlers.meetingLiveWindow = flags => ({ ok: true, ...flags });
  await f.click("liveCompact");
  assert.equal(f.$("meetingPanel").classList.contains("live-compact"), true);
  await f.click("liveDetail");
  assert.equal(f.$("meetingPanel").classList.contains("live-floating"), false);
  assert.equal(f.count("meetingLiveStart"), 0);
  assert.equal(f.count("meetingLiveStop"), 1);
  f.push(recording());
  f.handlers.meetingLiveWindow = () => ({ ok: false, error: { message: "Window unavailable" } });
  await f.click("liveFloat");
  assert.equal(f.$("meetingPanel").classList.contains("live-floating"), false);
  assert.match(f.$("liveError").textContent, /Window unavailable/);
  assert.equal(f.$("liveStop").disabled, false);
});

test("summary is explicit, waits for drain/save and renders structured untrusted text safely", async () => {
  const f = fixture();
  await f.ui.open();
  for (const state of [recording(), completed({ pendingSegments: 1 }), completed({ failedSegments: 1 }), completed({ finalizationPending: true }), completed({ error: { code: "live_save_failed" } })]) {
    f.push(state);
    await f.click("liveSummarize");
  }
  assert.equal(f.count("meetingLiveSummarize"), 0);
  f.push(completed());
  f.$("liveCleanerModel").value = "analysis-b";
  await f.click("liveSummarize");
  assert.deepEqual(f.last("meetingLiveSummarize").args[0], { sessionId: "s1", modelId: "analysis-b" });
  assert.equal(f.count("meetingLiveCleanup"), 0);
  assert.equal(f.$("liveCleanup").disabled, true);
  f.push(completed({ postprocessStatus: "running", postprocessProgress: { kind: "summary", completed: 2, total: 4, failed: 1 } }));
  assert.match(f.$("livePostprocessStatus").textContent, /生成摘要 2 \/ 4.*失败 1/);
  assert.equal(f.$("liveCleanerModel").disabled, true);
  const malicious = '<img src=x onerror="window.pwned=true">';
  const outputs = { reviewedMarkdownPath: "C:/mock/reviewed.md", summaryMarkdownPath: "C:/mock/summary.md" };
  f.push(completed({ ...outputs, reviewedText: malicious, postprocessStatus: "completed",
    summary: { title: "Summary title", mindmap: { text: malicious, provenance: [], children: [{ text: "Decisions", uncertain: true, provenance: [{ quote: malicious }], children: [{ text: "Ship" }] }] },
      sections: [{ heading: "Decisions", items: [{ text: malicious, uncertain: true, provenance: [{ sourceId: "internal-id", quote: "An exact quote" }] }] }], markdown: "# export-only duplicate\n" + malicious }
  }));
  assert.equal(f.$("liveSummarySection").hidden, false);
  assert.match(allText(f.$("liveMindmap")), /Decisions[\s\S]*Ship/);
  assert.match(allText(f.$("liveMindmap")), /待确认/);
  assert(!allText(f.$("liveMindmap")).includes("[]"));
  assert(allText(f.$("liveSummaryDetail")).includes(malicious));
  assert(!/export-only|Summary title|sourceId|internal-id|provenance/.test(allText(f.$("liveSummaryDetail"))));
  assert.match(allText(f.$("liveSummaryDetail")), /Decisions[\s\S]*待确认[\s\S]*An exact quote/);
  assert.equal(f.$("liveSummaryDetail").children[0].tagName, "H4");
  assert.equal(f.$("liveSummaryDetail").children[1].tagName, "UL");
  assert.equal(f.$("liveReviewed").textContent, malicious);
  function safeTags(node) {
    assert(["DIV", "UL", "LI", "SPAN", "H4", "STRONG", "P", "SMALL"].includes(node.tagName), node.tagName);
    node.children.forEach(safeTags);
  }
  safeTags(f.$("liveMindmap"));
  safeTags(f.$("liveSummaryDetail"));
  await f.click("liveOpenSummary");
  assert.equal(f.last("meetingLiveOpenPath").args[0].path, outputs.summaryMarkdownPath);
  await f.click("liveOpenReviewed");
  assert.equal(f.last("meetingLiveOpenPath").args[0].path, outputs.reviewedMarkdownPath);
  f.push(recording({ sessionId: "s2" }));
  assert.equal(f.$("liveSummarySection").hidden, true);
  assert.equal(f.$("liveReviewedSection").hidden, true);
  assert.equal(f.$("liveOpenSummary").disabled, true);
});

test("older Markdown summaries use semantic blocks and never reveal unknown DTO fields", async () => {
  const f = fixture();
  await f.ui.open();
  f.push(completed({ summary: { title: "Meeting", markdown: "# Meeting\n## Decisions\n- Ship\n\nDetails", secretMetadata: "must not display" } }));
  assert.equal(f.$("liveSummaryHeading").textContent, "会议摘要 · Meeting");
  assert.deepEqual(f.$("liveSummaryDetail").children.map(node => node.tagName), ["H4", "UL", "P"]);
  assert(!/#|secretMetadata|must not display|Meeting/.test(allText(f.$("liveSummaryDetail"))));
});

test("late status poll cannot roll back a confirmed floating window transition", async () => {
  const f = fixture();
  await f.ui.open();
  f.push(recording());
  const stale = deferred();
  f.handlers.meetingLiveStatus = () => stale.promise;
  for (let i = 0; i < 5; i++) f.advance(1000);
  await f.click("liveFloat");
  stale.resolve({ ok: true, ...recording(), window: { floating: false, compact: false, alwaysOnTop: false } });
  await tick();
  assert.equal(f.$("meetingPanel").classList.contains("live-floating"), true);
  assert.equal(f.$("liveStop").disabled, false);
});

test("backend capability rejection and absent new bridge leave recording recoverable", async () => {
  const f = fixture();
  await f.ui.open();
  f.handlers.meetingLiveStart = () => ({ ok: false, error: { message: "Model does not support streaming" } });
  await f.click("liveStart");
  assert.match(f.$("liveError").textContent, /does not support streaming/);
  delete f.api.meetingLivePause;
  delete f.api.meetingLiveWindow;
  f.push(recording());
  assert.equal(f.$("livePause").disabled, true);
  assert.equal(f.$("liveFloat").disabled, true);
  assert.equal(f.$("liveStop").disabled, false);
});

async function verifyUpgradeBrowser(page, directory) {
  await verifyBrowser(page, directory);
  await page.evaluate(async () => { window.applyWindowMode("meeting"); await window.MeetingLiveUi.open(); });
  await page.evaluate(() => window.mockPush({ status: "recording", recording: true, paused: false, previewText: "正在讨论下一阶段的交付计划。", previewStatus: "streaming" }));
  await page.locator("#liveFloat").click();
  assert.equal(await page.locator("#meetingPanel.live-floating").count(), 1);
  await page.setViewportSize({ width: 480, height: 360 });
  await page.locator("#liveCompact").click();
  await page.locator("#livePause").click();
  assert.equal(await page.locator("#livePause").textContent(), "继续录制");
  await page.locator("#liveAlwaysOnTop").check();
  assert.equal(await page.locator("#liveAlwaysOnTop").isChecked(), true);
  for (const size of [{ width: 480, height: 360 }, { width: 420, height: 300 }, { width: 360, height: 240 }]) {
    await page.setViewportSize(size);
    const stop = await page.locator("#liveStop").boundingBox();
    assert(stop.y >= 0 && stop.y + stop.height <= size.height, "stop visible in compact window");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.screenshot({ path: path.join(directory, "meeting-live-compact.png") });
  await page.locator("#liveDetail").click();
  assert.equal(await page.locator("#meetingPanel.live-floating").count(), 0);
  await page.evaluate(() => window.mockPush({ status: "completed", recording: false, paused: false, previewText: "", postprocessStatus: "completed", reviewedText: "复核后的文本。",
    summary: { title: "产品研发周会", mindmap: { text: "产品研发周会", uncertain: false, provenance: [], children: [
      { text: "本周进展", children: [{ text: "接口联调完成" }, { text: "恢复与导出测试" }] },
      { text: "下一步", children: [{ text: "项目组开展双平台验收" }, { text: "周五目标，时间待确认", uncertain: true }] }
    ] }, sections: [
      { heading: "本周进展", items: [{ text: "已完成会议接口联调，原文、音频与恢复检查点均独立保存。", uncertain: false, provenance: [{ sourceId: "s1", quote: "这周接口已经联调完成，三个输出都单独保存。" }] }] },
      { heading: "行动事项", items: [{ text: "项目组继续验证恢复与导出，并分别执行 Windows 和 macOS 验收。", uncertain: false, provenance: [] }] },
      { heading: "待确认事项", items: [{ text: "以周五为验收目标，最终时间待硬件验证结果确认。", uncertain: true, provenance: [{ sourceId: "s2", quote: "先争取周五，具体还要看硬件验证。" }] }] }
    ], markdown: "## Export duplicate\nDo not render when sections exist." }
  }));
  for (const size of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.locator("#liveSummarySection").scrollIntoViewIfNeeded();
    assert.equal(await page.locator("#liveSummaryDetail img").count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.pwned)), false);
    assert.equal(await page.locator("#liveSummaryDetail h4").count(), 3);
    assert.equal(await page.locator("#liveSummaryDetail li").count(), 3);
    assert(!/##|Export duplicate|sourceId|provenance/.test(await page.locator("#liveSummaryDetail").textContent()));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(directory, `meeting-summary-${size.width}.png`) });
  }
  await page.evaluate(() => window.mockPush({ summary: { sections: [{ heading: "<script>window.pwned=true</script>", items: [{ text: "<img src=x onerror='window.pwned=true'>", uncertain: true, provenance: [{ quote: "<svg onload=alert(1)>" }] }] }] } }));
  assert.equal(await page.locator("#liveSummaryDetail img, #liveSummaryDetail script, #liveSummaryDetail svg").count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.pwned)), false);
  await page.evaluate(() => window.MeetingLiveUi.close());
  await page.evaluate(() => window.mockOpenSettings());
  await page.locator('[data-settings-tab="meeting"]').click();
  const settingsModels = await page.locator("#meetingQwenModelPresetSelect option").evaluateAll(options => options.map(option => option.value));
  assert.deepEqual(settingsModels, ["qwen-audio-3.0-asr-flash-streaming", "fun-asr-realtime", "fun-asr-realtime-2026-09-18", "__custom__"]);
  assert(!settingsModels.includes("qwen3-asr-flash"));
  assert.equal(await page.locator("#meetingQwenModelPresetSelect").inputValue(), "qwen-audio-3.0-asr-flash-streaming");
  await page.locator('[data-settings-tab="connections"]').click();
  assert.equal(await page.locator("#aliyunApiKeyInput").inputValue(), "test-only-live-key");
  await page.locator("#openaiBaseUrlInput").fill("https://nowcoding.example/v1");
  await page.locator("#openaiApiStyleSelect").selectOption("chat-completions");
  await page.locator('[data-settings-tab="meeting"]').click();
  await page.locator("#meetingQwenModelPresetSelect").selectOption("fun-asr-realtime-2026-09-18");
  assert.equal(await page.locator("#meetingQwenApiKeyInput").count(), 0);
  await page.locator("#meetingQwenModelPresetSelect").selectOption("__custom__");
  await page.locator("#meetingQwenModelInput").fill("fun-asr-realtime-latest");
  await page.locator('[data-settings-tab="connections"]').click();
  assert.equal(await page.locator("#aliyunApiKeyInput").inputValue(), "test-only-live-key");
  assert.equal(await page.locator("#openaiBaseUrlInput").inputValue(), "https://nowcoding.example/v1");
  assert.equal(await page.locator("#openaiApiStyleSelect").inputValue(), "chat-completions");
  await page.locator('[data-settings-tab="meeting"]').click();
  await page.locator("#meetingAnalysisModelPresetSelect").selectOption("grok-4.5");
  assert.equal(await page.locator("#meetingAnalysisProviderSelect").inputValue(), "custom");
  assert.equal(await page.locator("#meetingAnalysisCustomConnectionFields").isVisible(), true);
  await page.locator("#meetingAnalysisBaseUrlInput").fill("https://grok.example/v1");
  await page.locator("#meetingAnalysisApiKeyInput").fill("custom-grok-key");
  await page.locator("#meetingAnalysisModelPresetSelect").selectOption("gpt-5.5");
  assert.equal(await page.locator("#meetingAnalysisProviderSelect").inputValue(), "openai-compatible");
  assert.equal(await page.locator("#meetingAnalysisCustomConnectionFields").isHidden(), true);
  await page.locator("#meetingAnalysisModelPresetSelect").selectOption("grok-4.5");
  assert.equal(await page.locator("#meetingAnalysisBaseUrlInput").inputValue(), "https://grok.example/v1");
  assert.equal(await page.locator("#meetingAnalysisApiKeyInput").inputValue(), "custom-grok-key");
  await page.screenshot({ path: path.join(directory, "meeting-settings-live-models.png") });
}

async function run() {
  for (const { name, run: check } of tests) {
    try { await check(); console.log(`ok - ${name}`); }
    catch (error) { console.error(`not ok - ${name}\n${error.stack}`); process.exitCode = 1; }
  }
  if (!process.exitCode && process.argv.includes("--browser")) {
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
    try {
      const output = path.resolve(__dirname, "../output/playwright");
      fs.mkdirSync(output, { recursive: true });
      const directory = fs.mkdtempSync(path.join(output, "meeting-upgrade-ui-"));
      await verifyUpgradeBrowser(await browser.newPage(), directory);
      console.log(`Browser checks passed; diagnostic screenshots: ${directory}`);
    } finally { await browser.close(); }
  }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verifyUpgradeBrowser };
