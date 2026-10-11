"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { timestamp } = require("../src/renderer/summary-reader");
const { renderSummaryDocument, summaryToPlainText } = require("../src/renderer/meeting-ui");
const root = path.resolve(__dirname, "..");

function fixture() {
  const topics = ["明确目标", "实施与验证", "后续改进"];
  const prose = [
    "这次发布先解决已有用户的使用问题，再考虑增加功能。界面调整应围绕常见操作展开，同时保留高级设置，避免用户反复寻找入口。",
    "实施时需要先完成共享逻辑，再分别检查 Windows 和 macOS。验证覆盖模型请求、记录恢复与界面交互；出现失败时保留已经完成的内容，不让用户从头重来。",
    "后续优先改善阅读体验和更新流程。长内容整理应保留细节，导图用于浏览主题，正文用于完整回顾；遇到有争议的识别内容，应能返回原始录音核对。"
  ];
  const claim = (text, i) => ({ text, uncertain: false, provenance: [{
    sourceId: `live:${i}:0`, source: "live", quote: prose[i], startFrame: i * 60 * 16000, endFrame: (i * 60 + 50) * 16000
  }] });
  return {
    schema: "meeting_summary_v3", sampleRate: 16000, title: "软件发布复盘",
    overview: claim("本次讨论围绕发布目标、实施验证和后续改进展开。核心是先解决常见操作的问题，再通过可靠的记录与验证流程保证用户体验。", 0),
    mindmap: { ...claim("软件发布复盘", 0), children: topics.map((text, i) => ({ ...claim(text, i), sectionId: `section-${i + 1}`,
      children: ["实施要点", "验证与回顾"].map(label => ({ ...claim(label, i), sectionId: `section-${i + 1}`,
        children: [{ ...claim(i ? "可追溯的依据" : "常见操作优先", i), sectionId: `section-${i + 1}`, children: [] }] })) })) },
    sections: topics.map((heading, i) => ({ id: `section-${i + 1}`, heading, paragraphs: [claim(prose[i], i)], items: [] }))
  };
}

function contracts() {
  assert.equal(timestamp(0), "00:00");
  assert.equal(timestamp(61.7), "01:01");
  assert.equal(timestamp(3661), "01:01:01");
  assert.equal(timestamp(-1), "00:00");
  const summary = fixture();
  let invocation = null;
  const doc = { defaultView: { SummaryReader: { render(...args) { invocation = args; return "controller"; } } } };
  const container = {};
  const options = { sessionId: "synthetic-file" };
  assert.equal(renderSummaryDocument(container, summary, doc, options), "controller");
  assert.deepEqual(invocation, [container, summary, options]);
  const copied = summaryToPlainText(summary);
  assert.ok(copied.includes(summary.overview.text));
  for (const section of summary.sections) {
    assert.ok(copied.includes(`## ${section.heading}`));
    assert.ok(copied.includes(section.paragraphs[0].text));
  }
  assert.ok(fs.existsSync(path.join(root, "node_modules/d3-hierarchy/dist/d3-hierarchy.min.js")));
  console.log("PASS v3 shared reader delegation, overview/chapter copy and source timestamp formatting");
}

async function browserChecks() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const output = path.join(root, "output/playwright/summary-reader");
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const errors = await prepareBrowser(page);
    await page.waitForFunction(() => document.getElementById("homeTodayCount").textContent === "18");
    const summary = fixture();
    for (const platform of ["win32", "darwin"]) {
      for (const width of [720, 1040, 1440]) {
        await page.setViewportSize({ width, height: 880 });
        await page.evaluate(({ platform, summary }) => {
          document.documentElement.dataset.platform = platform;
          window.applyWindowMode("file");
          document.getElementById("fileSetupDetails").open = false;
          document.getElementById("fileHistorySidebar").hidden = true;
          const target = document.getElementById("fileResultContent");
          target.hidden = false;
          document.getElementById("fileResultEmpty").hidden = true;
          window.MeetingUi.renderSummaryDocument(target, summary, document, { sessionId: "synthetic-file", api: window.mimoInput });
        }, { platform, summary });
        const reader = page.locator("#fileResultContent .summary-reader");
        if (await reader.getByRole("tab", { name: "内容脉络", exact: true }).isVisible()) await reader.getByRole("tab", { name: "内容脉络", exact: true }).click();
        const layout = await reader.evaluate(element => {
          const map = element.querySelector(".summary-map-canvas");
          const nodes = [...map.querySelectorAll(".summary-map-node")];
          return { width: element.clientWidth, mapWidth: map.clientWidth, mapHeight: map.clientHeight, nodes: nodes.length,
            scrollWidth: document.documentElement.scrollWidth, innerWidth, prose: element.querySelector(".summary-reader-article").scrollHeight };
        });
        assert.ok(layout.nodes >= 4 && layout.mapWidth > 200 && layout.mapHeight > 200, `${platform}/${width}: nonblank map`);
        assert.ok(layout.scrollWidth <= layout.innerWidth + 1, `${platform}/${width}: no window overflow`);
        const scaleBefore = await reader.locator(".summary-map-scale").textContent();
        await reader.getByRole("button", { name: "放大", exact: true }).click();
        assert.notEqual(await reader.locator(".summary-map-scale").textContent(), scaleBefore);
        await reader.getByRole("button", { name: "适合窗口", exact: true }).click();
        const transformBefore = await reader.locator(".summary-map-canvas > svg > g").getAttribute("transform");
        const mapBounds = await reader.locator(".summary-map-canvas").boundingBox();
        await page.mouse.move(mapBounds.x + 10, mapBounds.y + 10);
        await page.mouse.down();
        await page.mouse.move(mapBounds.x + 44, mapBounds.y + 30);
        await page.mouse.up();
        assert.notEqual(await reader.locator(".summary-map-canvas > svg > g").getAttribute("transform"), transformBefore, "drag pans the map");
        await reader.getByRole("button", { name: "适合窗口", exact: true }).click();
        const count = await reader.locator(".summary-map-node").count();
        await reader.locator('.summary-map-node[data-node-id="root-0"]').getByRole("button", { name: "展开分支" }).click();
        assert.ok(await reader.locator(".summary-map-node").count() > count);
        if (platform === "win32" && width === 1440) await reader.screenshot({ path: path.join(output, "expanded-map.png") });
        await reader.locator('.summary-map-node[data-node-id="root-0"]').getByRole("button", { name: "收起分支" }).click();
        assert.equal(await reader.locator(".summary-map-node").count(), count);
        const expand = reader.locator('.summary-map-node[data-node-id="root-0"]').getByRole("button", { name: "展开分支" });
        await expand.focus();
        await page.keyboard.press("Enter");
        assert.ok(await reader.locator(".summary-map-node").count() > count, "keyboard activates the branch toggle without chapter navigation");
        await page.keyboard.press("ArrowLeft");
        assert.equal(await reader.locator(".summary-map-node").count(), count);
        await reader.locator('.summary-map-node[data-node-id="root-1"] > rect').click();
        assert.equal(await reader.locator(".summary-chapter-active").getAttribute("data-section-id"), "section-2");
        assert.ok(await reader.locator(".summary-reader-article").isVisible());
        assert.equal(await reader.locator(".summary-reader-article").getAttribute("aria-label"), "整理正文");
        if (width === 1440) await reader.screenshot({ path: path.join(output, `file-${platform}-${width}.png`) });
        await page.evaluate(async summary => {
          window.applyWindowMode("meeting");
          await window.MeetingLiveUi.open();
          window.mockPush({ sessionId: "synthetic-meeting", status: "completed", recording: false, rawText: "合成的会议原文。",
            summary, postprocessStatus: "completed", pendingSegments: 0, failedSegments: 0 });
          document.getElementById("liveSetupDetails").open = false;
        }, summary);
        const live = page.locator("#liveSummaryReader .summary-reader");
        assert.equal(await live.count(), 1);
        assert.equal(await live.locator(".summary-reader-chapter").count(), 3);
        assert.ok(await live.locator(".summary-map-canvas").evaluate(e => e.clientHeight > 200));
        assert.equal(await page.locator("#liveSummarySection .live-summary-layout").isVisible(), false);
        if (width === 1440) await page.locator("#liveSummarySection").screenshot({ path: path.join(output, `meeting-${platform}-${width}.png`) });
        await page.evaluate(() => { window.MeetingLiveUi.close(); });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async summary => {
      window.applyWindowMode("meeting"); await window.MeetingLiveUi.open();
      window.mockPush({ sessionId: "synthetic-playback", status: "completed", recording: false, summary });
      document.getElementById("liveSetupDetails").open = false;
      window.mockApiOverrides = { meetingPlaybackToken: async args => { window.playbackArgs = args; return {
        ok: true, url: "mimo-meeting://play/" + "a".repeat(48), expiresAt: Date.now() + 60000
      }; } };
      HTMLMediaElement.prototype.play = async function () { window.audioPlayed = true; };
      HTMLMediaElement.prototype.load = function () {};
    }, summary);
    const live = page.locator("#liveSummaryReader .summary-reader");
    // Bring the prose into view on narrow containers, then expose exact evidence.
    if (await live.getByRole("tab", { name: "整理正文", exact: true }).isVisible()) await live.getByRole("tab", { name: "整理正文", exact: true }).click();
    await live.locator('[data-section-id="section-2"] .summary-source-evidence > summary').click();
    await live.locator('[data-section-id="section-2"] .summary-source-seek').click();
    assert.deepEqual(await page.evaluate(() => window.playbackArgs), { sessionId: "synthetic-playback", track: "auto" });
    await page.evaluate(() => {
      const audio = document.querySelector("#liveSummaryReader audio");
      Object.defineProperty(audio, "duration", { value: 180 });
      audio.dispatchEvent(new Event("loadedmetadata"));
    });
    assert.equal(await live.locator("audio").evaluate(audio => audio.currentTime), 60);
    assert.equal(await page.evaluate(() => window.audioPlayed), true);
    const hostile = fixture();
    hostile.title = "<img src=x onerror=alert(1)>";
    hostile.overview.text = "<script>window.compromised=true</script>";
    hostile.sections[0].paragraphs[0].text = "<svg onload=alert(1)>";
    await page.evaluate(summary => window.mockPush({ summary }), hostile);
    assert.equal(await live.locator("script, img").count(), 0);
    assert.equal(await page.evaluate(() => window.compromised), undefined);
    assert.ok(await live.textContent().then(text => text.includes(hostile.overview.text)));
    await page.evaluate(summary => {
      const target = document.getElementById("liveSummaryReader");
      window.deferredToken = null;
      const api = { meetingPlaybackToken: () => new Promise(resolve => { window.deferredToken = resolve; }) };
      window.SummaryReader.render(target, summary, { sessionId: "old-session", api });
    }, summary);
    await live.locator('[data-section-id="section-2"] .summary-source-evidence > summary').click();
    await live.locator('[data-section-id="section-2"] .summary-source-seek').click();
    await page.evaluate(summary => {
      const target = document.getElementById("liveSummaryReader");
      window.SummaryReader.render(target, summary, { sessionId: "new-session" });
      window.deferredToken({ ok: true, url: "mimo-meeting://play/" + "b".repeat(48), expiresAt: Date.now() + 60000 });
    }, summary);
    assert.equal(await live.locator("audio").count(), 0, "late playback token cannot cross session boundaries");
    assert.deepEqual(errors, []);
    console.log("PASS browser: file/meeting shared map, zoom/collapse/chapter navigation, source seek, hostile text, stale playback and Windows/macOS layouts at 720/1040/1440");
  } finally { await browser.close(); }
}

async function electronChecks() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const sandbox = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ovi-summary-native-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|TOKEN|SECRET|MIMO|QWEN|DASHSCOPE|FUN_ASR|CLEANER|OSS|OVI_|ELECTRON_RUN_AS_NODE/i.test(key)));
  const application = await _electron.launch({ executablePath: require("electron"),
    args: [path.join(__dirname, "test-home-ui.js"), "--electron-app-fixture", sandbox], env });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(() => !document.getElementById("onboardingPanel").hidden);
    await page.locator("#guideSkip").click();
    const userDataPath = await application.evaluate(({ app }) => app.getPath("userData"));
    const { createSessionStore } = require("../src/meeting/session-store");
    const { wavHeader, RATE } = require("../src/meeting/realtime/audio");
    const store = createSessionStore({ userDataPath });
    const found = await store.createSession({ title: "Synthetic summary playback" });
    const dir = path.join(found.sessionDir, "realtime");
    fs.mkdirSync(dir, { recursive: true });
    const pcm = Buffer.alloc(RATE * 4 * 2);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / RATE) * 1000), i * 2);
    fs.writeFileSync(path.join(dir, "microphone-complete.wav"), Buffer.concat([wavHeader(pcm.length), pcm]));
    await store.updateSession(found.session.id, { status: "stopped" });
    const sessionId = found.session.id;
    const summary = fixture();
    for (const claim of [summary.overview, ...summary.sections.flatMap(section => section.paragraphs)]) {
      claim.provenance[0].startFrame = 8000;
      claim.provenance[0].endFrame = 24000;
    }
    await page.evaluate(({ summary, sessionId }) => {
      window.applyWindowMode("file");
      document.getElementById("fileSetupDetails").open = false;
      document.getElementById("fileHistorySidebar").hidden = true;
      document.getElementById("fileResultEmpty").hidden = true;
      const target = document.getElementById("fileResultContent");
      target.hidden = false;
      window.MeetingUi.renderSummaryDocument(target, summary, document, { sessionId, api: window.mimoInput });
      target.addEventListener("play", event => { event.target.muted = true; }, true);
    }, { summary, sessionId });
    assert.equal(await page.evaluate(() => typeof window.d3?.tree), "function", "D3 browser asset loads through Electron file URL");
    const reader = page.locator("#fileResultContent .summary-reader");
    assert.equal(await reader.locator(".summary-map-node").count(), 4);
    if (await reader.getByRole("tab", { name: "整理正文", exact: true }).isVisible()) await reader.getByRole("tab", { name: "整理正文", exact: true }).click();
    await reader.locator('[data-section-id="section-1"] .summary-source-evidence > summary').click();
    await reader.locator('[data-section-id="section-1"] .summary-source-seek').click();
    await page.waitForFunction(() => {
      const audio = document.querySelector("#fileResultContent audio");
      return audio?.readyState >= 2 && audio.duration === 4 && audio.currentTime >= 0.5;
    });
    await reader.locator("audio").evaluate(audio => audio.pause());
    const response = await reader.locator("audio").evaluate(async audio => {
      const response = await fetch(audio.src, { headers: { Range: "bytes=0-79" } });
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength, range: response.headers.get("content-range") };
    });
    assert.equal(response.status, 206);
    assert.equal(response.bytes, 80);
    assert.match(response.range, /^bytes 0-79\//);
    const output = path.join(root, "output/playwright/summary-reader");
    fs.mkdirSync(output, { recursive: true });
    await reader.screenshot({ path: path.join(output, "electron-source-playback.png") });
    console.log("PASS native Electron: local D3 asset, complete realtime WAV token, actual metadata/playback seek and protocol byte ranges; isolated synthetic data, no API calls");
  } finally { await application.close(); }
}

if (require.main === module) (async () => {
  contracts();
  if (process.argv.includes("--browser")) await browserChecks();
  if (process.argv.includes("--electron")) await electronChecks();
})().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fixture };
