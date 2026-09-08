"use strict";

const assert = require("node:assert/strict");

// Minimal document stub for DOM helpers
function makeEl(tag = "div") {
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    className: "",
    textContent: "",
    hidden: false,
    childNodes: children,
    get firstChild() {
      return children[0] || null;
    },
    appendChild(c) {
      children.push(c);
      return c;
    },
    removeChild(c) {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
      return c;
    },
    setAttribute() {},
    getAttribute() {
      return null;
    }
  };
  return el;
}

global.document = {
  createElement: (tag) => makeEl(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) })
};

const ui = require("../src/renderer/meeting-ui.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test("elapsed and clock formatting", () => {
  assert.equal(ui.formatElapsed(0), "00:00");
  assert.equal(ui.formatElapsed(65000), "01:05");
  assert.equal(ui.formatElapsed(3661000), "1:01:01");
  assert.equal(ui.formatClockMs(null), "--:--");
  assert.equal(ui.formatClockMs(125000), "02:05");
});

test("status labels", () => {
  assert.equal(ui.captureStatusLabel("recording"), "录音中");
  assert.equal(ui.processStageLabel("transcribing"), "识别");
  assert.equal(ui.processStageLabel("exporting", { phase: "uploading" }), "上传");
  assert.equal(ui.processStageLabel("transcribing", { phase: "merging" }), "合并");
  assert.equal(ui.analysisStageLabel("completed", "done"), "分析完成");
  assert.equal(ui.segmentProgressText(2, 5), "2/5");
  assert.equal(ui.segmentProgressText(0, 0), "—");
});

test("process mode bitrate payload and cleanup warn", () => {
  assert.equal(ui.normalizeProcessMode("enhanced_diarize"), "enhanced");
  assert.equal(ui.normalizeBitrateKbps(99), 48);
  assert.equal(ui.normalizeBitrateKbps(32), 32);
  assert.match(ui.bitrateOptionLabel(48), /48/);
  assert.match(ui.bitrateOptionLabel(48), /21/);
  const basic = ui.buildProcessPayload({ sessionId: "s1", mode: "basic", bitrateKbps: 64 });
  assert.equal(basic.mode, "basic");
  assert.equal(basic.bitrateKbps, undefined);
  const enh = ui.buildProcessPayload({
    sessionId: "s1",
    mode: "enhanced",
    bitrateKbps: 32,
    resetAttempts: true
  });
  assert.equal(enh.mode, "enhanced");
  assert.equal(enh.bitrateKbps, 32);
  assert.equal(enh.resetAttempts, true);
  assert.match(ui.remoteCleanupWarning("pending_retained"), /保留/);
  assert.match(ui.remoteCleanupWarning("delete_failed"), /删除失败/);
  assert.equal(ui.remoteCleanupWarning("deleted"), "");
  assert.equal(ui.canChangeProcessMode("transcribing"), false);
  assert.equal(ui.canChangeProcessMode("idle"), true);
  assert.equal(ui.isProcessRunningStage("uploading"), true);
  assert.equal(ui.isProcessRunningStage("merging"), true);
  const prog = ui.processProgressText({
    processMode: "enhanced",
    bitrateKbps: 48,
    remoteCleanup: "pending_retained",
    transcription: { segmentCompleted: 1, segmentTotal: 2 }
  });
  assert.match(prog, /1\/2/);
  assert.match(prog, /48kbps/);
  assert.match(prog, /保留/);
});

test("speaker select helpers", () => {
  assert.equal(ui.speakerDefaultLabel("self"), "我");
  assert.equal(ui.speakerDefaultLabel("remote_2"), "远端2");
  const list = ui.extractUniqueSpeakers([
    { items: [{ speakerId: "remote_1" }, { speakerId: "self" }, { speakerId: "self" }] },
    { items: [{ speakerId: "remote_1" }, { speakerId: "remote_3" }] }
  ]);
  assert.equal(list[0].id, "self");
  assert.equal(list.length, 3);
  assert.equal(
    ui.resolveSpeakerDisplayName("self", { speakers: { self: { displayName: "小明" } } }),
    "小明"
  );
  assert.equal(ui.resolveSpeakerDisplayName("remote_1", null), "远端1");
});

test("request token stale guard", () => {
  const tok = ui.createRequestToken();
  const a = tok.next();
  const b = tok.next();
  assert.equal(tok.isCurrent(a), false);
  assert.equal(tok.isCurrent(b), true);
});

test("independent channels: poll does not invalidate process", () => {
  const ch = ui.createWorkbenchChannels();
  const procTok = ch.process.next();
  ch.poll.next();
  ch.poll.next();
  ch.list.next();
  assert.equal(ch.process.isCurrent(procTok), true);
  assert.equal(ui.acceptChannelUpdate(ch.process, procTok, "s1", "s1"), true);
  const pollTok = ch.poll.next();
  assert.equal(ui.acceptChannelUpdate(ch.poll, pollTok, "s1", "s1"), true);
  assert.equal(ui.acceptChannelUpdate(ch.process, procTok, "s1", "s1"), true);
});

test("button enable transitions", () => {
  assert.equal(ui.canStartCapture("idle", "idle", "none"), true);
  assert.equal(ui.canStartCapture("recording", "idle", "none"), false);
  assert.equal(ui.canStartCapture("stopped", "transcribing", "none"), false);
  assert.equal(ui.canGenerateRaw("stopped", "idle", { hasSession: true }), true);
  assert.equal(ui.canGenerateRaw("recording", "idle", { hasSession: true }), false);
  assert.equal(ui.canGenerateRaw("idle", "idle", { hasSession: true }), false);
  assert.equal(ui.canGenerateRaw("stopped", "idle", { hasSession: false }), false);
  assert.equal(ui.canGenerateRaw("stopped", "exporting", { hasSession: true }), false);
  assert.equal(ui.canRunAnalysis("completed", "none", { hasSession: true, hasRaw: true }), true);
  assert.equal(ui.canRunAnalysis("idle", "none", { hasSession: true, hasRaw: false }), false);
  assert.equal(ui.canRunAnalysis("completed", "running", { hasSession: true, hasRaw: true }), false);
  assert.equal(ui.canCancelProcess("exporting"), true);
  assert.equal(ui.canCancelProcess("idle"), false);
  assert.equal(ui.canCancelAnalysis("running"), true);
  assert.equal(ui.canRetryProcess("stopped", "failed", { hasSession: true }), true);
  assert.equal(ui.canRetryAnalysis("completed", "failed", { hasSession: true }), true);
});

test("optimistic running disables starts and enables cancel", () => {
  const proc = ui.buildOptimisticProcessRunning({ stage: "idle" });
  assert.equal(proc.stage, "exporting");
  assert.equal(proc.optimistic, true);
  const ana = ui.buildOptimisticAnalysisRunning(null);
  assert.equal(ana.status, "running");
  assert.equal(ana.optimistic, true);

  const flags = ui.computeControlFlags({
    hasSession: true,
    lifecycleStatus: "stopped",
    processStage: proc.stage,
    analysisStatus: "none",
    hasRaw: false
  });
  assert.equal(flags.canGenerateRaw, false);
  assert.equal(flags.canCancelProcess, true);
  assert.equal(flags.canRunAnalysis, false);

  const flagsAna = ui.computeControlFlags({
    hasSession: true,
    lifecycleStatus: "stopped",
    processStage: "completed",
    analysisStatus: ana.status,
    hasRaw: true
  });
  assert.equal(flagsAna.canRunAnalysis, false);
  assert.equal(flagsAna.canCancelAnalysis, true);
  assert.equal(flagsAna.canGenerateRaw, false);
});

test("stale completion guard", () => {
  const tok = ui.createRequestToken();
  const a = tok.next();
  tok.next();
  assert.equal(
    ui.shouldAcceptRemoteUpdate({
      token: a,
      isCurrent: (t) => tok.isCurrent(t),
      selectedId: "s1",
      responseSessionId: "s1"
    }),
    false
  );
  const b = tok.value;
  assert.equal(
    ui.shouldAcceptRemoteUpdate({
      token: b,
      isCurrent: (t) => tok.isCurrent(t),
      selectedId: "s1",
      responseSessionId: "s2"
    }),
    false
  );
  assert.equal(
    ui.shouldAcceptRemoteUpdate({
      token: b,
      isCurrent: (t) => tok.isCurrent(t),
      selectedId: "s1",
      responseSessionId: "s1"
    }),
    true
  );
});

test("sanitize session title max 200", () => {
  assert.equal(ui.sanitizeSessionTitle("  周会\u0000  "), "周会");
  assert.equal(ui.sanitizeSessionTitle("x".repeat(250)).length, 200);
});

test("summary flatten and transcript blocks", () => {
  const sections = ui.flattenSummarySections({
    template: "meeting",
    executiveSummary: { text: "摘要" },
    decisions: [{ text: "决定A" }],
    actionItems: [{ text: "行动", owner: "张三" }],
    keyQuotes: [{ text: "原话", speakerId: "self" }]
  });
  assert.ok(sections.some((s) => s.title === "执行摘要"));
  assert.ok(sections.some((s) => s.lines.includes("决定A")));
  assert.ok(sections.find((s) => s.title === "行动项").lines[0].includes("张三"));

  const blocks = ui.formatTranscriptBlocks({
    items: [
      { id: "microphone:0", speakerId: "self", beginMs: 0, endMs: 1000, text: "你好<script>" }
    ]
  });
  assert.equal(blocks[0].text, "你好<script>");
  assert.ok(blocks[0].timeLabel.includes("00:00"));
});

test("safe DOM fill does not interpret HTML", () => {
  const el = makeEl("div");
  ui.fillTextElement(el, "<b>x</b>");
  assert.equal(el.childNodes.length, 1);
  assert.equal(el.childNodes[0].textContent, "<b>x</b>");

  const box = makeEl("div");
  ui.appendTranscriptBlocks(box, [
    { speakerId: "self", timeLabel: "00:00 – 00:01", text: "<img onerror=1>" }
  ]);
  assert.equal(box.childNodes.length, 1);
  const body = box.childNodes[0].childNodes[1];
  assert.equal(body.textContent, "<img onerror=1>");
});

test("session filter", () => {
  const list = [
    { id: "a1", title: "周会", status: "stopped" },
    { id: "b2", title: "访谈", status: "recording" }
  ];
  assert.equal(ui.filterSessions(list, "周").length, 1);
  assert.equal(ui.filterSessions(list, "b2").length, 1);
  assert.equal(ui.filterSessions(list, "").length, 2);
});

test("capture UI only when lifecycle session matches selected", () => {
  assert.equal(ui.shouldDriveCaptureUi({ status: "recording", sessionId: "A" }, "A"), true);
  assert.equal(ui.shouldDriveCaptureUi({ status: "recording", sessionId: "A" }, "B"), false);
  assert.equal(ui.shouldDriveCaptureUi({ status: "recording" }, "A"), false);
  assert.equal(
    ui.resolveCaptureStartedAt({
      lifecycle: { status: "recording", sessionId: "A", startedAtMs: 1000 },
      selectedId: "A",
      previousStartedAt: 50,
      now: 9999
    }),
    1000
  );
  assert.equal(
    ui.resolveCaptureStartedAt({
      lifecycle: { status: "recording", sessionId: "A", startedAtMs: 1000 },
      selectedId: "B",
      previousStartedAt: 50,
      now: 9999
    }),
    0
  );
  assert.equal(
    ui.resolveCaptureStartedAt({
      lifecycle: { status: "recording", sessionId: "A" },
      selectedId: "A",
      previousStartedAt: 42,
      now: 9999
    }),
    42
  );
});

test("poll merge: process completion invalidates raw and requests refresh", () => {
  const merged = ui.mergePollSnapshot(
    {
      selectedId: "A",
      process: { stage: "transcribing" },
      analysis: { status: "none" },
      lifecycle: { status: "stopped", sessionId: "A" },
      captureStartedAt: 0,
      rawDoc: { items: [{ id: "x" }] },
      correctedDoc: { items: [] },
      summaryDoc: { template: "meeting" }
    },
    {
      process: { stage: "completed" },
      analysis: { status: "none" },
      lifecycle: { status: "stopped", sessionId: "A" },
      selectedId: "A"
    }
  );
  assert.equal(merged.processJustCompleted, true);
  assert.equal(merged.refreshResult, true);
  assert.equal(merged.rawDoc, null);
  assert.ok(merged.summaryDoc);
});

test("poll merge: analysis completion invalidates corrected/summary", () => {
  const merged = ui.mergePollSnapshot(
    {
      selectedId: "A",
      process: { stage: "completed" },
      analysis: { status: "running", stage: "merge" },
      rawDoc: { items: [1] },
      correctedDoc: { items: [2] },
      summaryDoc: { template: "meeting" }
    },
    {
      process: { stage: "completed" },
      analysis: { status: "completed", stage: "done" },
      selectedId: "A"
    }
  );
  assert.equal(merged.analysisJustCompleted, true);
  assert.equal(merged.correctedDoc, null);
  assert.equal(merged.summaryDoc, null);
  assert.ok(merged.rawDoc);
  assert.equal(merged.refreshResult, true);
});

test("poll and process channels interleave without clobber", () => {
  const ch = ui.createWorkbenchChannels();
  const pTok = ch.process.next();
  // simulate concurrent poll ticks
  ch.poll.next();
  const pollTok = ch.poll.next();
  assert.equal(ui.acceptChannelUpdate(ch.process, pTok, "A", "A"), true);
  assert.equal(ui.acceptChannelUpdate(ch.poll, pollTok, "A", "A"), true);
  // A/B switch invalidates select but not an in-flight process for old sid
  ch.select.next();
  assert.equal(ui.acceptChannelUpdate(ch.process, pTok, "B", "A"), false);
  assert.equal(ui.acceptChannelUpdate(ch.process, pTok, "A", "A"), true);
});

test("cancel / clear optimistic when status fetch fails", () => {
  const cleared = ui.clearOptimisticProcess({ stage: "exporting", optimistic: true });
  assert.equal(cleared.optimistic, false);
  assert.equal(cleared.stage, "failed");
  const clearedA = ui.clearOptimisticAnalysis({ status: "running", optimistic: true });
  assert.equal(clearedA.status, "failed");
  assert.equal(ui.clearOptimisticProcess({ stage: "completed" }).stage, "completed");
});

test("needsMeetingPolling respects selected lifecycle only", () => {
  assert.equal(
    ui.needsMeetingPolling({
      lifecycle: { status: "recording", sessionId: "A" },
      process: { stage: "idle" },
      analysis: { status: "none" },
      selectedId: "A"
    }),
    true
  );
  assert.equal(
    ui.needsMeetingPolling({
      lifecycle: { status: "recording", sessionId: "A" },
      process: { stage: "idle" },
      analysis: { status: "none" },
      selectedId: "B"
    }),
    false
  );
  assert.equal(
    ui.needsMeetingPolling({
      lifecycle: { status: "stopped", sessionId: "A" },
      process: { stage: "transcribing" },
      analysis: { status: "none" },
      selectedId: "A"
    }),
    true
  );
});

test("single-flight open meeting", async () => {
  const flight = ui.createSingleFlight();
  let runs = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const p1 = flight.run(async () => {
    runs += 1;
    await gate;
    return "a";
  });
  const p2 = flight.run(async () => {
    runs += 1;
    return "b";
  });
  assert.equal(flight.pending, true);
  assert.equal(p1, p2);
  release();
  const out = await p1;
  assert.equal(out, "a");
  assert.equal(runs, 1);
  const p3 = await flight.run(async () => {
    runs += 1;
    return "c";
  });
  assert.equal(p3, "c");
  assert.equal(runs, 2);
});

test("meeting layout HTML structure (no outer scroll surfaces)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "../src/renderer/index.html"), "utf8");
  // sidebar short labels + title tooltips
  assert.match(html, /id="meetingNewSessionBtn"[^>]*title="新建会话"[^>]*>新建</);
  assert.match(html, /id="meetingRefreshSessionsBtn"[^>]*title="刷新列表"[^>]*>刷新</);
  // File import is a separate workspace, not a meeting sidebar action.
  assert.match(html, /id="filePanel" class="file-panel"/);
  assert.match(html, /id="fileChooseBtn"[^>]*>选择文件</);
  assert.match(html, /id="fileProcessStartBtn"[^>]*>开始转写</);
  assert.match(html, /id="fileAnalysisStartBtn"[^>]*>校订并总结</);
  assert.match(html, /data-file-tab="raw"/);
  assert.match(html, /data-file-tab="corrected"/);
  assert.match(html, /data-file-tab="summary"/);
  assert.match(html, /id="fileAsrProviderSelect"/);
  assert.match(html, /id="fileAsrModelSelect"/);
  assert.match(html, /id="fileExportFormatSelect"/);
  assert.match(html, /id="fileExportScopeSelect"/);
  assert.match(html, /id="fileExportBtn"/);
  assert.match(html, /id="minimizeBtn"/);
  assert.match(html, /id="maximizeBtn"/);
  assert.doesNotMatch(html, /id="meetingImportWavBtn"/);
  assert.doesNotMatch(html, /id="meetingImportRoleSelect"/);
  assert.doesNotMatch(html, /id="meetingImportCancelBtn"/);
  assert.doesNotMatch(html, /meeting-console-row">\s*<label class="field">\s*<span>导入角色<\/span>/);
  // capture actions + hint share footer
  assert.match(html, /meeting-console-footer[\s\S]*meeting-console-actions[\s\S]*meetingConsoleHint/);
  // process mode + bitrate controls
  assert.match(html, /id="meetingProcessModeBasicBtn"[^>]*>基础转写</);
  assert.match(html, /id="meetingProcessModeEnhancedBtn"[^>]*>说话人分离</);
  assert.match(html, /id="meetingProcessModeBasicBtn"[\s\S]*aria-pressed="true"/);
  assert.match(html, /id="meetingProcessModeEnhancedBtn"/);
  assert.match(html, /id="meetingBitrateGroup"[\s\S]*data-bitrate="32"[\s\S]*data-bitrate="48"[\s\S]*data-bitrate="64"/);
  // export format/scope + speaker select + name
  assert.match(
    html,
    /meeting-export-row[\s\S]*meetingExportFormatSelect[\s\S]*meetingExportScopeSelect[\s\S]*meetingSpeakerSelect[\s\S]*meetingSpeakerNameInput/
  );
  assert.doesNotMatch(html, /meeting-speaker-row/);
  assert.match(html, /id="meetingResultPane" class="meeting-result-pane"/);
  // settings 4C fields
  assert.match(html, /id="meetingFunAsrModelInput"/);
  assert.match(html, /id="meetingFunAsrBaseUrlInput"/);
  assert.match(html, /id="meetingFunAsrApiKeyInput"/);
  assert.match(html, /id="meetingOssRegionInput"/);
  assert.match(html, /id="meetingOssEndpointInput"/);
  assert.match(html, /id="meetingOssBucketInput"/);
  assert.match(html, /id="meetingOssAccessKeyIdInput"/);
  assert.match(html, /id="meetingOssAccessKeySecretInput"/);
  assert.match(html, /id="meetingOssPrefixInput"/);
  assert.match(html, /id="meetingUploadBitrateSelect"/);
  assert.match(html, /id="meetingFunTestBtn"/);
  assert.match(html, /id="meetingOssTestBtn"/);
  assert.match(html, /id="meetingFunTestResult"[^>]*aria-live="polite"/);
  assert.match(html, /id="meetingOssTestResult"[^>]*aria-live="polite"/);
  assert.match(html, /data-secret-toggle="meetingFunAsrApiKeyInput"/);
  assert.match(html, /data-secret-toggle="meetingOssAccessKeyIdInput"/);
  assert.match(html, /data-secret-toggle="meetingOssAccessKeySecretInput"/);
  assert.match(html, /data-secret-copy="meetingFunAsrApiKeyInput"/);
  assert.match(html, /基础：本地|零上传|不上传/);
  assert.match(html, /增强|上传/);
});

test("renderer wires process payload and settings fields", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const js = fs.readFileSync(path.join(__dirname, "../src/renderer/renderer.js"), "utf8");
  assert.match(js, /meetingProcessStart\([\s\S]*buildProcessPayload|meetingProcessStart\(payload\)/);
  assert.match(js, /meetingProcessRetry\([\s\S]*buildProcessPayload|meetingProcessRetry\(payload\)/);
  assert.match(js, /meetingProcessMode/);
  assert.match(js, /meetingUploadBitrateKbps/);
  assert.match(js, /meetingFunAsrModel/);
  assert.match(js, /meetingFunAsrBaseUrl/);
  assert.match(js, /meetingFunAsrApiKey/);
  assert.match(js, /meetingOssRegion/);
  assert.match(js, /meetingOssEndpoint/);
  assert.match(js, /meetingOssBucket/);
  assert.match(js, /meetingOssAccessKeyId/);
  assert.match(js, /meetingOssAccessKeySecret/);
  assert.match(js, /meetingOssPrefix/);
  assert.match(js, /meetingEnhancedTest/);
  assert.match(js, /meetingSpeakerSelect/);
  assert.match(js, /applyActiveSpeakerToForm/);
  assert.match(js, /refreshMeetingSpeakerSelect/);
  assert.match(js, /remoteCleanupWarning/);
  assert.match(js, /processStageLabel\?\.\(proc,\s*meetingState\.process\)/);
});

test("meeting layout CSS containment rules", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");
  assert.match(css, /body\.meeting-mode\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /body\.meeting-mode\s+\.shell\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.meeting-panel\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.meeting-main\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.meeting-session-list\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.meeting-result-pane\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.meeting-console,\s*\n\.meeting-strip\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(css, /\.meeting-playback\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(css, /\.meeting-results\s*\{[^}]*flex:\s*1\s+1\s+auto/s);
  // default result pane floor ~180; 960 floor pane ~100 / section ~130
  assert.match(css, /\.meeting-results\s*\{[^}]*min-height:\s*180px/s);
  assert.match(css, /\.meeting-result-pane\s*\{[^}]*min-height:\s*180px/s);
  assert.match(css, /@media\s*\(max-width:\s*980px\)[\s\S]*\.meeting-results\s*\{[^}]*min-height:\s*130px/s);
  assert.match(css, /@media\s*\(max-width:\s*980px\)[\s\S]*\.meeting-result-pane\s*\{[^}]*min-height:\s*100px/s);
  assert.match(css, /\.meeting-export-row\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.match(css, /\.meeting-export-select[^}]*max-width:\s*140px/s);
  assert.doesNotMatch(css, /meeting-speaker-row/);
  // glass / mica-ish blur, no decorative gradients on main surfaces
  assert.match(css, /backdrop-filter:\s*blur\(/);
  assert.match(css, /body\.meeting-mode\s+\.shell\s*\{[^}]*backdrop-filter:\s*blur/s);
  assert.match(css, /\.meeting-mode-btn/);
  assert.match(css, /\.meeting-bitrate-btn/);
  assert.match(css, /min-height:\s*34px/);
  assert.doesNotMatch(css, /body\.meeting-mode\s+\.shell\s*\{[^}]*linear-gradient/s);
  assert.doesNotMatch(css, /radial-gradient/);
  // no viewport-scaled font tricks
  assert.doesNotMatch(css, /font-size:\s*[^;]*vw/);
  assert.doesNotMatch(css, /font-size:\s*[^;]*vh/);
  // settings may scroll internally
  assert.match(css, /\.settings-tab-content\s*\{[^}]*overflow-y:\s*auto/s);
  // light theme: section titles must use tokens (not near-white on glass)
  assert.match(css, /\.section-title\s+strong\s*\{[^}]*color:\s*var\(--ovi-text\)/s);
  assert.match(css, /\.section-title\s+span\s*\{[^}]*color:\s*var\(--ovi-muted\)/s);
  assert.match(css, /\.settings-group\s*\{[^}]*border-bottom:\s*1px\s+solid\s+var\(--ovi-border\)/s);
  assert.match(css, /\.check-field\s*\{[^}]*color:\s*var\(--ovi-text\)/s);
  assert.doesNotMatch(css, /\.section-title\s+strong\s*\{[^}]*#f0f7f4/s);
  // translucent meeting body; settings use transparent corners and a rounded shell
  assert.match(css, /body\.meeting-mode\s*\{[^}]*background:\s*rgba\(/s);
  assert.match(css, /body\.settings-open\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /body\.settings-open\s+\.shell\s*\{[^}]*border-radius:\s*16px/s);
  assert.match(css, /body\.meeting-mode\s+\.shell\s*\{[^}]*border-radius:\s*0/s);
});

test("file workspace is an independent UI channel", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const fileUi = fs.readFileSync(path.join(__dirname, "../src/renderer/file-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");
  assert.match(fileUi, /const state = \{/);
  assert.match(fileUi, /meetingProcessStart/);
  assert.match(fileUi, /meetingAnalysisStart/);
  assert.doesNotMatch(fileUi, /meetingState/);
  assert.match(fileUi, /meetingListSessions\(\{ source: "import" \}\)/);
  assert.match(fileUi, /openFileWorkspace/);
  assert.match(fileUi, /saveFileAsrSelection/);
  assert.match(fileUi, /fileExportSave/);
  assert.match(fileUi, /loadAnalysisResults/);
  assert.match(fileUi, /force = !retry && state\.analysis\?\.status === "completed"/);
  assert.match(fileUi, /loadResult\("summary"/);
  assert.match(fileUi, /state\.selectedId = state\.sessions\[0\]\.id/);
  assert.match(css, /body\.file-mode\s+\.file-panel\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /\.file-result-pane\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.topbar\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(css, /body\.secondary-window-mode\s+\.window-control-btn/);
  assert.match(css, /#maximizeBtn\[data-maximized="true"\]::after\s*\{[^}]*width:\s*12px[^}]*border:\s*2px/s);
});

console.log(`\n${passed} tests passed`);
