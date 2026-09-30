"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "src/renderer/live-meeting.css"), "utf8");
assert.doesNotMatch(html, /id="(?:testConnectionBtn|liveCompact)"/);
assert.match(html, /data-resize-target="fileResults"/);
assert.match(html, /data-resize-target="liveResults"/);
assert.match(html, /data-resize-target="liveSummarySection"/);
assert.match(css, /\.live-floating #livePreviewStatus/);
assert.match(css, /\.live-minimal #liveRaw/);
console.log("Meeting reading, icon controls, preview-only view and removed settings button contracts passed.");

async function verifyReadingBrowser(page, directory) {
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const errors = await prepareBrowser(page);
  await page.setViewportSize({ width: 1180, height: 1000 });
  await page.evaluate(async () => {
    window.applyWindowMode("meeting"); await window.MeetingLiveUi.open();
    window.mockPush({ sessionId: "demo", status: "recording", recording: true, title: "项目进展讨论",
      startedAtMs: Date.now(), rawText: "本周完成了桌面端的主要流程。\n\n接下来验证会议录制与文件转写。\n\n".repeat(30),
      previewText: "我们还需要检查跨平台的窗口位置和阅读体验。", previewStatus: "streaming", window: { floating: false, alwaysOnTop: false } });
  });
  const grip = page.locator('[data-resize-target="liveResults"]:not([data-resize-axis])');
  await grip.scrollIntoViewIfNeeded();
  const before = await page.locator("#liveResults").evaluate(el => el.getBoundingClientRect().height);
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 110, { steps: 8 }); await page.mouse.up();
  const shorter = await page.locator("#liveResults").evaluate(el => el.getBoundingClientRect().height);
  assert(shorter < before - 80, "pointer drag must change the actual transcript region, not only a CSS value");
  await grip.focus(); await grip.press("ArrowDown");
  const taller = await page.locator("#liveResults").evaluate(el => el.getBoundingClientRect().height);
  assert(taller > shorter + 20, "keyboard resizing remains accessible");
  const floatBox = await page.locator("#liveFloat").boundingBox();
  const resultsBox = await page.locator("#liveResults").boundingBox();
  assert(floatBox.y + floatBox.height <= resultsBox.y, "floating entry is directly above the reading pane");
  await page.evaluate(() => window.mockPush({ window: { floating: true, alwaysOnTop: true, fontSize: 14, opacity: .9 } }));
  await page.setViewportSize({ width: 640, height: 560 });
  for (const id of ["liveRawHeading", "livePreviewStatus", "liveQueue", "liveSaved"]) assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} is absent from floating view`);
  assert.equal(await page.locator("#liveStatus").textContent(), "");
  assert.equal(await page.locator("#liveStatus").getAttribute("data-light"), "green");
  assert((await page.locator(".live-heading").boundingBox()).height <= 32);
  const smallRaw = await page.locator("#liveRaw").evaluate(el => el.clientHeight);
  await page.setViewportSize({ width: 760, height: 700 });
  assert((await page.locator("#liveRaw").evaluate(el => el.clientHeight)) > smallRaw + 75);
  const font = page.locator("#liveFontSize");
  await font.fill("20");
  await page.waitForFunction(() => getComputedStyle(document.getElementById("liveRaw")).fontSize === "20px");
  assert.equal(await page.locator("#liveMinimalFontSize").inputValue(), "20");
  const split = page.locator("#liveDraftResize");
  const shareBefore = await page.locator("#livePreviewSection").evaluate(el => el.clientHeight);
  await split.focus(); await split.press("ArrowUp");
  assert((await page.locator("#livePreviewSection").evaluate(el => el.clientHeight)) > shareBefore, "draft/history split is user adjustable");
  if (directory) await page.screenshot({ path: path.join(directory, "floating-760.png") });

  await page.evaluate(() => window.mockPush({ paused: true, status: "paused" }));
  assert.equal(await page.locator("#liveStatus").getAttribute("data-light"), "yellow");
  await page.evaluate(() => window.mockPush({ paused: false, status: "recording", previewStatus: "failed", error: { message: "模拟断线，原文与音频保留" } }));
  assert.equal(await page.locator("#liveStatus").getAttribute("data-light"), "red");
  await page.evaluate(() => window.mockPush({ previewStatus: "streaming", error: null }));
  await page.setViewportSize({ width: 300, height: 150 });
  await page.waitForFunction(() => document.getElementById("meetingPanel").classList.contains("live-minimal"));
  await page.mouse.move(-10, -10);
  assert.equal(await page.locator("#livePreview").isVisible(), true);
  assert.equal(await page.locator("#liveRestoreNormal").isVisible(), false);
  assert.equal(await page.locator("#liveOpacity").isVisible(), false);
  for (const id of ["liveRaw", "liveStop", "livePause", "liveSessionTitle", "liveAlwaysOnTop"]) assert.equal(await page.locator(`#${id}`).isVisible(), false);
  await page.locator("#livePreview").hover();
  assert.equal(await page.locator("#liveRestoreNormal").isVisible(), true);
  assert.equal(await page.locator("#liveOpacity").isVisible(), true);
  await page.locator("#liveOpacity").fill("60");
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".shell")).backgroundColor.endsWith("0.9)"));
  await page.mouse.move(-10, -10);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".shell")).backgroundColor.endsWith("0.6)"));
  assert.equal(await page.locator("#liveOpacity").isVisible(), false, "focused slider must hide when the mouse leaves");
  assert.equal(await page.locator("#liveRestoreNormal").isVisible(), false);
  await page.locator("#livePreview").hover();
  await page.locator("#liveOpacity").fill("0");
  await page.locator("#liveOpacity").focus();
  await page.mouse.move(-10, -10);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".shell")).backgroundColor.endsWith("0)"));
  assert.equal(await page.locator("#liveOpacity").isVisible(), false);
  assert.equal(await page.locator("#liveRestoreNormal").isVisible(), false);
  const clear = await page.locator(".shell").evaluate(el => ({ border: getComputedStyle(el).borderTopColor,
    blur: getComputedStyle(el).backdropFilter, foreground: getComputedStyle(document.getElementById("livePreview")).opacity }));
  assert(clear.border.endsWith("0)")); assert.equal(clear.blur, "none"); assert.equal(clear.foreground, "1");
  assert((await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).endsWith("0)"), "the page backdrop must also be fully clear");
  if (directory) await page.screenshot({ path: path.join(directory, "floating-preview-only-clear-idle.png"), omitBackground: true });
  await page.locator("#livePreview").hover();
  assert((await page.locator(".shell").evaluate(el => getComputedStyle(el).backgroundColor)).endsWith("0.9)"));
  assert.equal(await page.locator("#liveOpacity").inputValue(), "0", "temporary hover background must not overwrite the user's opacity");
  await page.locator("#liveMinimalFontSize").fill("18");
  assert.equal(await page.locator("#livePreview").evaluate(el => getComputedStyle(el).fontSize), "18px");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (directory) await page.screenshot({ path: path.join(directory, "floating-preview-only-300.png") });
  await page.setViewportSize({ width: 640, height: 560 });
  await page.waitForFunction(() => !document.getElementById("meetingPanel").classList.contains("live-minimal"));
  assert.equal(await page.locator("#liveStop").isVisible(), true);
  await page.evaluate(() => window.mockPush({ status: "completed", recording: false, previewText: "", window: { floating: false, alwaysOnTop: false },
    summary: { title: "项目进展", mindmap: { text: "项目", children: [{ text: "进展" }] }, sections: [{ heading: "当前进展", paragraphs: [{ text: "本周已完成桌面端主要流程，接下来将验证录制、转写和跨平台体验。".repeat(30) }], items: [] }] } }));
  await page.setViewportSize({ width: 1180, height: 1000 });
  const summaryGrip = page.locator("#liveSummaryResize");
  await summaryGrip.scrollIntoViewIfNeeded(); await summaryGrip.focus(); await summaryGrip.press("ArrowDown");
  assert.equal(await page.locator("#liveSummarySection").getAttribute("data-user-sized"), "true");
  await page.evaluate(() => window.applyWindowMode("file"));
  const fileGrip = page.locator('[data-resize-target="fileResults"]');
  await fileGrip.scrollIntoViewIfNeeded(); await fileGrip.focus(); await fileGrip.press("ArrowUp");
  assert.equal(await page.locator("#fileResults").getAttribute("data-user-sized"), "true");
  const fileBefore = await page.locator("#fileResultPane").evaluate(el => el.clientHeight);
  await fileGrip.press("ArrowDown");
  assert((await page.locator("#fileResultPane").evaluate(el => el.clientHeight)) > fileBefore + 20);
  assert.deepEqual(errors, []);
  console.log("Real browser pointer/keyboard reading resize, responsive float, light states, font and opacity controls passed.");
}
module.exports = { verifyReadingBrowser };
if (require.main === module && process.argv.includes("--browser")) (async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const directory = path.join(root, "output/playwright/meeting-floating-2026-09-30"); fs.mkdirSync(directory, { recursive: true });
  try { await verifyReadingBrowser(await browser.newPage(), directory); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
