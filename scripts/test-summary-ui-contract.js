"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { renderSummaryDocument, summaryToPlainText, flattenSummarySections } = require("../src/renderer/meeting-ui");
const supplierUi = require("../src/renderer/text-supplier-ui");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const fileUi = fs.readFileSync(path.join(root, "src/renderer/file-ui.js"), "utf8");
const liveUi = fs.readFileSync(path.join(root, "src/renderer/live-meeting-ui.js"), "utf8");
const meetingUi = fs.readFileSync(path.join(root, "src/renderer/meeting-ui.js"), "utf8");

let passed = 0;
async function test(name, run) {
  await run(); passed++;
  console.log(`PASS ${name}`);
}

// Minimal element tree for the shared summary renderer (offline, no browser).
function element(tag = "div") {
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(),
    className: "",
    textContent: "",
    children: [],
    classList: { add(name) { classes.add(name); }, contains: (name) => classes.has(name) },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; }
  };
}

function allText(node) {
  return [node.textContent, ...node.children.map(allText)].join("\n");
}

async function main() {
  await test("summary model selection belongs to file and meeting workspaces, never expression settings", () => {
    const cleaner = html.slice(html.indexOf('id="settingsCleanerPanel"'), html.indexOf('id="legacySummarySettings"'));
    assert.doesNotMatch(cleaner, /summarySupplierSelect|summaryModelSelect|meetingAnalysisContextInput|meetingAnalysisMaxOutputInput/);
    assert.match(html, /id="fileSummaryModelSelect"/);
    assert.match(html, /id="liveCleanerModel"/);
    const renderer = fs.readFileSync(path.join(root, "src/renderer/renderer.js"), "utf8");
    const save = renderer.slice(renderer.indexOf("async function saveAllSettings()"), renderer.indexOf("async function runMeetingEnhancedTest"));
    assert.doesNotMatch(save, /selectedTextModel\("summary"|meetingAnalysisContextInput|meetingAnalysisMaxOutputInput/);
    assert.match(save, /\.\.\.appSettings\.textModelSelections/);
  });
  await test("supplier picker rejects IDs the settings service cannot persist", () => {
    for (const id of ["__proto__", "prototype", "constructor"]) assert.equal(supplierUi.supplierIdOf(id), "");
    assert.equal(supplierUi.supplierIdOf("my-provider"), "my-provider");
  });
  await test("live Generate Summary passes the MiMo review option; separate cleanup action is gone", () => {
    assert.match(liveUi, /meetingLiveSummarize[\s\S]{0,400}supplierId: selected\.supplierId[\s\S]{0,160}useMimoReview: Boolean\(\$\("liveUseMimoReview"\)\.checked\)/);
    assert.match(liveUi, /reviewModelId: \$\("liveReviewModel"\)\.value/);
    assert.doesNotMatch(liveUi, /meetingLiveCleanup/);
    assert.doesNotMatch(html, /id="liveCleanup"|id="liveOpenCleaned"|id="liveOpenReviewed"|id="liveCorrected"|id="liveReviewed"/);
    assert.match(html, /id="liveSummarize"[^>]*>生成摘要</);
  });

  await test("MiMo review toggles default off and stay accessible in both workspaces", () => {
    assert.match(html, /id="liveUseMimoReview" type="checkbox" \/>/);
    assert.doesNotMatch(html, /id="liveUseMimoReview" type="checkbox" checked/);
    assert.match(html, /id="fileAnalysisMimoReview" type="checkbox"/);
    assert.doesNotMatch(html, /id="fileAnalysisMimoReview" type="checkbox"[^>]*checked/);
    assert.match(liveUi, /\$\("liveUseMimoReview"\)\.addEventListener\("change", render\)/);
    assert.match(fileUi, /\$\("fileAnalysisMimoReview"\)\?\.\addEventListener\("change", renderControls\)/);
  });

  await test("file Generate Summary uses the shared summary IPC, never legacy start/corrected", () => {
    assert.match(fileUi, /meetingFileSummaryStart/);
    assert.match(fileUi, /meetingFileSummaryRetry/);
    assert.match(fileUi, /meetingFileSummaryStatus/);
    assert.match(fileUi, /meetingFileSummaryCancel/);
    assert.doesNotMatch(fileUi, /meetingAnalysisStart|meetingAnalysisRetry|meetingAnalysisCorrected/);
    assert.match(fileUi, /useMimoReview: Boolean\(els\(\)\.mimoReview\?\.checked\)/);
    assert.match(html, /id="fileAnalysisStartBtn"[^>]*>生成摘要</);
    // The visible file workspace never offers the removed cleanup action or view.
    const filePanelHtml = html.slice(html.indexOf('id="filePanel"'), html.indexOf('id="meetingPanel"'));
    assert.doesNotMatch(filePanelHtml, /data-file-tab="corrected"|校订并总结/);
    const liveHtml = html.slice(html.indexOf('id="liveMeetingPanel"'), html.indexOf("legacyMeetingHistoryPanel"));
    assert.doesNotMatch(liveHtml, /校订并总结|校订原文|liveCorrected/);
  });

  await test("summary reading layout renders mindmap left and coherent paragraphs right", () => {
    const container = element("div");
    const summary = {
      title: "会议摘要",
      mindmap: { text: "根节点", uncertain: false, provenance: [], children: [{ text: "分支", uncertain: true, provenance: [{ quote: "引用" }], children: [] }] },
      sections: [{
        heading: "详情",
        paragraphs: [{ text: "这是一段连贯的摘要散文，保留语境并去除口水词。", uncertain: false, provenance: [{ quote: "原话" }] }],
        items: [{ text: "行动项一", uncertain: true, provenance: [{ quote: "另一句" }] }]
      }]
    };
    renderSummaryDocument(container, summary, { createElement: element });
    assert.equal(container.children.length, 1);
    const layout = container.children[0];
    assert.ok(layout.classList.contains("has-mindmap"));
    assert.equal(layout.children[0].tagName, "ASIDE");
    assert.equal(layout.children[1].tagName, "DIV");
    assert.match(allText(layout.children[0]), /根节点[\s\S]*分支/);
    const prose = layout.children[1];
    assert.equal(prose.children[0].tagName, "SECTION");
    assert.equal(prose.children[0].children[0].tagName, "H3");
    assert.equal(prose.children[0].children[1].tagName, "P");
    assert.match(prose.children[0].children[1].textContent, /这是一段连贯的摘要散文/);
    assert.equal(prose.children[0].children[2].tagName, "UL");
    assert.match(prose.children[0].children[2].children[0].textContent, /行动项一/);
    assert.match(allText(prose), /待确认/);
  });

  await test("new article summary keeps mindmap citations but shows only clean prose on the right", () => {
    const container = element("div");
    const summary = {
      schema: "meeting_summary_v2", title: "主题",
      mindmap: { text: "主题脉络", uncertain: false, provenance: [{ quote: "原文证据" }], children: [] },
      sections: [{ heading: "正文", paragraphs: [
        { text: "第一段，清晰表达原本的想法。", uncertain: false, provenance: [{ quote: "第一段原话" }] },
        { text: "第二段，在前文基础上自然展开。", uncertain: true, provenance: [{ quote: "第二段原话" }] }
      ], items: [] }]
    };
    renderSummaryDocument(container, summary, { createElement: element });
    const [tree, article] = container.children[0].children;
    assert.match(allText(tree), /主题脉络[\s\S]*原文证据/);
    assert.deepEqual(article.children.map(child => child.tagName), ["H3", "P", "P"]);
    assert.match(allText(article), /第一段[\s\S]*第二段/);
    assert.doesNotMatch(allText(article), /来源：|原话|行动项|详细纪要/);
    assert.match(allText(article.children[2]), /待确认/);
    assert.match(summaryToPlainText(summary), /第一段[\s\S]*第二段/);
  });

  await test("old summaries with only items or markdown still render", () => {
    const itemsOnly = element("div");
    renderSummaryDocument(itemsOnly, {
      title: "Old",
      mindmap: { text: "Root", uncertain: false, provenance: [], children: [] },
      sections: [{ heading: "Details", items: [{ text: "Old bullet", uncertain: false, provenance: [] }] }]
    }, { createElement: element });
    const itemsProse = itemsOnly.children[0].children[1];
    assert.equal(itemsProse.children[0].children[1].tagName, "UL");
    assert.match(allText(itemsProse), /Old bullet/);

    const markdownOnly = element("div");
    renderSummaryDocument(markdownOnly, { title: "Legacy", markdown: "# Legacy\n## Decisions\n- Ship\n\nDetails paragraph" }, { createElement: element });
    assert.match(allText(markdownOnly), /Decisions[\s\S]*Ship[\s\S]*Details paragraph/);

    const stage3a = element("div");
    renderSummaryDocument(stage3a, { decisions: [{ text: "旧版决定" }] }, { createElement: element });
    assert.match(allText(stage3a), /旧版决定/);
    assert.deepEqual(flattenSummarySections({ decisions: [{ text: "旧版决定" }] }).map(section => section.title).length > 0, true);
  });

  await test("file summary model select is compact, defaults to the active model and survives file changes", () => {
    assert.match(html, /id="fileSummaryModelSelect"/);
    const filePanelHtml = html.slice(html.indexOf('id="filePanel"'), html.indexOf('id="meetingPanel"'));
    assert.match(filePanelHtml, /id="fileSummaryModelSelect"/);
    assert.match(fileUi, /modelOptionGroups\(state\.settings, "summary"\)/);
    assert.match(fileUi, /picker\.formatPair\(group\.supplierId, modelId\)/);
    assert.match(fileUi, /state\.summaryModel = String\(els\(\)\.summaryModelSelect\?\.value \|\| ""\)\.trim\(\)/);
    assert.match(fileUi, /supplierId: selected\.supplierId/);
    assert.match(fileUi, /modelId: selected\.modelId/);
    // Selection is module state: file switches and resets never clear it.
    assert.doesNotMatch(fileUi, /state\.summaryModel = ""/);
  });

  await test("file export scope no longer offers corrected while legacy scope stays supported", () => {
    const filePanelHtml = html.slice(html.indexOf('id="filePanel"'), html.indexOf('id="meetingPanel"'));
    const scopeHtml = filePanelHtml.slice(filePanelHtml.indexOf("fileExportScopeSelect"));
    assert.match(scopeHtml, /value="all"/);
    assert.match(scopeHtml, /value="raw"/);
    assert.match(scopeHtml, /value="summary"/);
    assert.doesNotMatch(scopeHtml, /value="corrected"/);
    const exportModule = fs.readFileSync(path.join(root, "src/meeting/export/session-export.js"), "utf8");
    assert.match(exportModule, /s === "corrected" \|\| s === "summary" \|\| s === "all"/);
  });

  await test("summary copy text prefers prose paragraphs and keeps action items discrete", () => {
    const text = summaryToPlainText({
      title: "会议摘要",
      mindmap: { text: "根", uncertain: true, provenance: [], children: [] },
      sections: [{
        heading: "详情",
        paragraphs: [{ text: "连贯散文第一段。", uncertain: false, provenance: [] }],
        items: [{ text: "行动项", uncertain: true, provenance: [] }]
      }]
    });
    assert.match(text, /会议摘要/);
    assert.match(text, /连贯散文第一段。/);
    assert.match(text, /- 行动项（待确认）/);
    assert.match(summaryToPlainText({ markdown: "# Fallback\n- Line" }), /Fallback[\s\S]*Line/);
  });

  console.log(`${passed} summary UI contract tests passed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
