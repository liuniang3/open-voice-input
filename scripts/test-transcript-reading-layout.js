"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

function contracts() {
  const css = fs.readFileSync(path.join(root, "src/renderer/reading-layout.css"), "utf8");
  assert.match(css, /\.meeting-block-body, \.summary-doc-paragraph, \.live-summary-detail p \{[^}]*max-width: none;[^}]*overflow: visible;[^}]*text-overflow: clip;/);
  const shared = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  assert.match(shared, /\np \{[^}]*max-width: 360px;/, "short status hints must keep their existing layout");
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  assert.ok(html.indexOf('href="./reading-layout.css"') > html.indexOf('href="./styles.css"'));
  console.log("PASS reading width overrides are scoped to transcript/summary prose and leave short hints unchanged");
}

async function verifyBrowser() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const output = path.join(root, "output/playwright/transcript-reading-layout");
  fs.mkdirSync(output, { recursive: true });
  const text = [
    "这是合成的转写测试内容。我们先验证中文、English 和 g mu nu 等混合表达是否按显示区域的实际宽度自然换行。".repeat(10),
    "这里保留原文中的分段，不增加或删除文字。",
    "https://example.invalid/" + "long_unbroken_identifier".repeat(20)
  ].join("\n\n");
  const summary = {
    schema: "meeting_summary_v2", title: "阅读布局测试",
    mindmap: { text: "布局", children: [{ text: "正文宽度" }, { text: "原始分段" }] },
    sections: [{ heading: "正文", paragraphs: [{ text, uncertain: false }], items: [] }]
  };
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const errors = await prepareBrowser(page);
    await page.waitForFunction(() => document.getElementById("homeTodayCount").textContent === "18");
    async function check(selector, label) {
      const state = await page.locator(selector).evaluate(paragraph => {
        const parent = paragraph.parentElement;
        const style = getComputedStyle(paragraph);
        const parentStyle = getComputedStyle(parent);
        return {
          width: paragraph.getBoundingClientRect().width,
          available: parent.clientWidth - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight),
          maxWidth: style.maxWidth, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow,
          text: paragraph.textContent,
          paragraphOverflow: paragraph.scrollWidth > paragraph.clientWidth + 1,
          documentOverflow: document.documentElement.scrollWidth > innerWidth + 1
        };
      });
      assert.ok(Math.abs(state.width - state.available) <= 1, `${label}: use the complete available reading width (${state.width}/${state.available})`);
      assert.equal(state.maxWidth, "none", label);
      assert.equal(state.whiteSpace, "pre-wrap", label);
      assert.equal(state.textOverflow, "clip", label);
      assert.equal(state.text, text, `${label}: presentation must not change transcript text or its line breaks`);
      assert.equal(state.paragraphOverflow, false, `${label}: long identifiers must wrap`);
      assert.equal(state.documentOverflow, false, `${label}: no horizontal window overflow`);
      return state;
    }
    for (const platform of ["win32", "darwin"]) {
      for (const width of [720, 1040, 1440]) {
        await page.setViewportSize({ width, height: 820 });
        await page.evaluate(({ platform, text }) => {
          document.documentElement.dataset.platform = platform;
          window.applyWindowMode("file");
          const content = document.getElementById("fileResultContent");
          content.hidden = false;
          document.getElementById("fileResultEmpty").hidden = true;
          window.MeetingUi.appendTranscriptBlocks(content, [{ speakerId: "self", timeLabel: "00:00 – 03:00", text }]);
        }, { platform, text });
        const raw = await check("#fileResultContent .meeting-block-body", `${platform} file raw ${width}`);
        if (width >= 1040) assert.ok(raw.width > 360, "wide panes must no longer stop at 360 pixels");
        if (width === 1040) await page.locator("#fileResultPane").screenshot({ path: path.join(output, `file-raw-${platform}-${width}.png`) });
        await page.evaluate(summary => window.MeetingUi.renderSummaryDocument(document.getElementById("fileResultContent"), summary), summary);
        const fileSummary = await check("#fileResultContent .summary-doc-paragraph", `${platform} file summary ${width}`);
        if (width === 1440) assert.ok(fileSummary.width > 360);
        await page.evaluate(async ({ text, summary }) => {
          window.applyWindowMode("meeting");
          await window.MeetingLiveUi.open();
          window.mockPush({ sessionId: "reading-layout-fixture", status: "completed", recording: false,
            rawText: text, summary, postprocessStatus: "completed", pendingSegments: 0, failedSegments: 0 });
        }, { text, summary });
        const liveSummary = await check("#liveSummaryDetail > p", `${platform} live summary ${width}`);
        if (width === 1440) assert.ok(liveSummary.width > 360);
        assert.equal(await page.locator("#liveRaw").textContent(), text);
        if (width === 1440) await page.locator("#liveSummarySection").screenshot({ path: path.join(output, `live-summary-${platform}-${width}.png`) });
      }
    }
    assert.deepEqual(errors, []);
    console.log("PASS browser: Windows/macOS reading styles at 720/1040/1440 pixels, full-width raw/summary prose, original paragraphs and long-word wrapping");
  } finally { await browser.close(); }
}

if (require.main === module) (async () => {
  contracts();
  if (process.argv.includes("--browser")) await verifyBrowser();
})().catch(error => { console.error(error); process.exitCode = 1; });
