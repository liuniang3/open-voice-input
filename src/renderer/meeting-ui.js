"use strict";

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatClockMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "--:--";
  return formatElapsed(ms);
}

function captureStatusLabel(status) {
  const s = String(status || "idle");
  const map = {
    idle: "空闲",
    prepared: "已准备",
    recording: "录音中",
    paused: "已暂停",
    stopped: "已停止",
    faulted: "故障",
    created: "已创建"
  };
  return map[s] || s;
}

const PROCESS_BITRATES = Object.freeze([32, 48, 64]);
const BITRATE_MB_PER_HOUR = Object.freeze({ 32: 14, 48: 21, 64: 28 });

function normalizeProcessMode(mode) {
  const m = String(mode || "basic").toLowerCase();
  if (m === "file" || m === "import" || m === "file_transcription" || m === "file-asr") return "file";
  return m === "enhanced" || m === "enhanced_diarize" ? "enhanced" : "basic";
}

function normalizeBitrateKbps(value, fallback = 48) {
  const n = Number(value);
  if (PROCESS_BITRATES.includes(n)) return n;
  const fb = Number(fallback);
  return PROCESS_BITRATES.includes(fb) ? fb : 48;
}

function bitrateSizeHint(kbps) {
  const br = normalizeBitrateKbps(kbps);
  const mb = BITRATE_MB_PER_HOUR[br] || 21;
  return `约${mb} MB/小时`;
}

function bitrateOptionLabel(kbps) {
  const br = normalizeBitrateKbps(kbps);
  return `${br} kbps · ${bitrateSizeHint(br)}`;
}

function processStageLabel(stage, process = null) {
  const phase = process && typeof process === "object" ? process.phase : null;
  const p = String(phase || "").toLowerCase();
  if (p === "preparing" || p === "preparing_audio" || p === "compressing") return "压缩";
  if (p === "uploading") return "上传";
  if (p === "submitted" || p === "polling") return "识别";
  if (p === "merging") return "合并";
  if (p === "cleanup" || p === "cleaning") return "清理";

  const s = String(stage || "idle");
  const map = {
    idle: "未处理",
    exporting: "压缩",
    preparing: "压缩",
    uploading: "上传",
    transcribing: "识别",
    merging: "合并",
    completed: "原文完成",
    failed: "原文失败",
    cancelled: "已取消",
    cancelling: "取消中"
  };
  return map[s] || s;
}

function remoteCleanupWarning(remoteCleanup) {
  const c = String(remoteCleanup || "");
  if (c === "pending_retained") return "远端对象仍保留，可重试后清理";
  if (c === "delete_failed") return "远端删除失败，请检查 OSS 后重试";
  return "";
}

function processProgressText(process) {
  if (!process || typeof process !== "object") return "—";
  const warn = remoteCleanupWarning(process.remoteCleanup);
  const seg = segmentProgressText(
    process.transcription?.segmentCompleted,
    process.transcription?.segmentTotal
  );
  const bits = [];
  if (seg && seg !== "—") bits.push(seg);
  if (process.processMode === "enhanced" || process.mode === "enhanced") {
    const br = process.bitrateKbps != null ? `${normalizeBitrateKbps(process.bitrateKbps)}kbps` : "";
    if (br) bits.push(br);
  }
  if (warn) bits.push(warn);
  return bits.length ? bits.join(" · ") : "—";
}

function buildProcessPayload({
  sessionId,
  mode = "basic",
  bitrateKbps = 48,
  resetAttempts = false,
  forceResubmit = false
} = {}) {
  const processMode = normalizeProcessMode(mode);
  const payload = {
    sessionId,
    mode: processMode
  };
  if (processMode === "enhanced") {
    payload.bitrateKbps = normalizeBitrateKbps(bitrateKbps);
  }
  if (resetAttempts) payload.resetAttempts = true;
  if (forceResubmit) payload.forceResubmit = true;
  return payload;
}

function speakerDefaultLabel(speakerId) {
  const id = String(speakerId || "unknown");
  if (id === "self") return "我";
  const m = /^remote_(\d+)$/i.exec(id);
  if (m) return `远端${m[1]}`;
  if (id === "remote_unknown" || id === "remote") return "远端";
  return id;
}

function extractUniqueSpeakers(docs = []) {
  const seen = new Set();
  const out = [];
  for (const doc of docs) {
    const items = Array.isArray(doc?.items) ? doc.items : [];
    for (const it of items) {
      const id = String(it?.speakerId || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: speakerDefaultLabel(id)
      });
    }
  }
  out.sort((a, b) => {
    if (a.id === "self") return -1;
    if (b.id === "self") return 1;
    return a.id.localeCompare(b.id, "zh");
  });
  return out;
}

function resolveSpeakerDisplayName(speakerId, speakerMap = null) {
  const id = String(speakerId || "unknown");
  const mapped =
    speakerMap?.speakers?.[id]?.displayName ||
    speakerMap?.speakers?.[String(id)]?.displayName ||
    "";
  const name = String(mapped || "").trim();
  return name || speakerDefaultLabel(id);
}

function analysisStageLabel(status, stage) {
  const st = String(status || "none");
  if (st === "completed") return "分析完成";
  if (st === "failed") return "分析失败";
  if (st === "cancelled") return "分析已取消";
  if (st === "cancelling") return "分析取消中";
  if (st === "running") return "分析进行中";
  const map = {
    idle: "未分析",
    fingerprint: "准备分析",
    plan_batches: "分批",
    correct: "校订中",
    extract: "提取中",
    merge: "合并中",
    verify: "校验中",
    finalize: "收尾",
    done: "完成"
  };
  return map[String(stage || "idle")] || st;
}

function segmentProgressText(done, total) {
  const d = Number(done) || 0;
  const t = Number(total) || 0;
  if (t <= 0) return "—";
  return `${d}/${t}`;
}

/**
 * Stale-response guard: only accept if token still current.
 */
function createRequestToken() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
    get value() {
      return current;
    }
  };
}

/** Independent channels so poll never invalidates process/analysis writes. */
function createWorkbenchChannels() {
  return {
    select: createRequestToken(),
    list: createRequestToken(),
    poll: createRequestToken(),
    process: createRequestToken(),
    analysis: createRequestToken(),
    result: createRequestToken()
  };
}

function acceptChannelUpdate(channel, token, selectedId, responseSessionId = null) {
  if (!channel) return false;
  return shouldAcceptRemoteUpdate({
    token,
    isCurrent: (t) => channel.isCurrent(t),
    selectedId,
    responseSessionId
  });
}

function shouldDriveCaptureUi(lifecycle, selectedId) {
  if (!selectedId || !lifecycle) return false;
  if (lifecycle.sessionId == null || lifecycle.sessionId === "") return false;
  return String(lifecycle.sessionId) === String(selectedId);
}

/**
 * Resolve wall-clock capture start for the selected session.
 * Prefers backend lifecycle.startedAtMs; never uses foreign session clocks.
 */
function resolveCaptureStartedAt({
  lifecycle = null,
  selectedId = null,
  previousStartedAt = 0,
  now = Date.now()
} = {}) {
  if (!shouldDriveCaptureUi(lifecycle, selectedId)) return 0;
  const fromBackend = Number(lifecycle.startedAtMs);
  if (Number.isFinite(fromBackend) && fromBackend > 0) return fromBackend;
  if (isBusyCapture(lifecycle.status)) {
    const prev = Number(previousStartedAt);
    if (Number.isFinite(prev) && prev > 0) return prev;
    return now;
  }
  return 0;
}

function needsMeetingPolling({ lifecycle = null, process = null, analysis = null, selectedId = null } = {}) {
  const life = shouldDriveCaptureUi(lifecycle, selectedId) ? lifecycle?.status : null;
  const proc = process?.stage;
  const ana = analysis?.status;
  return (
    life === "recording" ||
    life === "paused" ||
    isProcessRunningStage(proc) ||
    isAnalysisRunningStatus(ana)
  );
}

function clearOptimisticProcess(process) {
  if (!process || !process.optimistic) return process || null;
  return {
    ...process,
    stage: "failed",
    status: "failed",
    optimistic: false
  };
}

function clearOptimisticAnalysis(analysis) {
  if (!analysis || !analysis.optimistic) return analysis || null;
  return {
    ...analysis,
    status: "failed",
    stage: analysis.stage || "idle",
    optimistic: false
  };
}

/**
 * Pure poll merge: detect completion transitions and request cache invalidation.
 * Does not touch DOM. response must already be session-guarded by caller.
 */
function mergePollSnapshot(state, { process = null, analysis = null, lifecycle = null, selectedId = null } = {}) {
  const prev = state && typeof state === "object" ? state : {};
  const prevProcStage = prev.process?.stage || "idle";
  const prevAnaStatus = prev.analysis?.status || "none";
  const nextProcess = process != null ? process : prev.process;
  const nextAnalysis = analysis != null ? analysis : prev.analysis;
  const nextLife = lifecycle != null ? lifecycle : prev.lifecycle;
  const nextProcStage = nextProcess?.stage || "idle";
  const nextAnaStatus = nextAnalysis?.status || "none";

  const processJustCompleted =
    nextProcStage === "completed" && prevProcStage !== "completed";
  const analysisJustCompleted =
    nextAnaStatus === "completed" && prevAnaStatus !== "completed";

  return {
    ...prev,
    selectedId: selectedId != null ? selectedId : prev.selectedId,
    process: nextProcess,
    analysis: nextAnalysis,
    lifecycle: nextLife,
    captureStartedAt: resolveCaptureStartedAt({
      lifecycle: nextLife,
      selectedId: selectedId != null ? selectedId : prev.selectedId,
      previousStartedAt: prev.captureStartedAt || 0
    }),
    rawDoc: processJustCompleted ? null : prev.rawDoc,
    correctedDoc: analysisJustCompleted ? null : prev.correctedDoc,
    summaryDoc: analysisJustCompleted ? null : prev.summaryDoc,
    refreshResult: processJustCompleted || analysisJustCompleted,
    processJustCompleted,
    analysisJustCompleted
  };
}

/**
 * Lightweight single-flight gate for open-meeting dual entrypoints.
 */
function createSingleFlight() {
  let inflight = null;
  return {
    run(fn) {
      if (inflight) return inflight;
      inflight = Promise.resolve()
        .then(fn)
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    get pending() {
      return Boolean(inflight);
    }
  };
}

function isBusyCapture(status) {
  return status === "recording" || status === "paused";
}

function canStartCapture(lifecycleStatus, processStage, analysisStatus, opts = {}) {
  if (opts.source === "import") return false;
  if (isImportBlockingStatus(opts.sessionStatus)) return false;
  if (isBusyCapture(lifecycleStatus)) return false;
  if (isProcessRunningStage(processStage)) return false;
  if (analysisStatus === "running" || analysisStatus === "cancelling") return false;
  return true;
}

function isImportBlockingStatus(status) {
  const s = String(status || "");
  return (
    s === "importing" ||
    s === "import_failed" ||
    s === "import_cancelled" ||
    s === "import_interrupted"
  );
}

function isImportSessionReady(sessionStatus, { hasArchive = false } = {}) {
  return sessionStatus === "stopped" && hasArchive;
}

function sanitizeSessionTitle(title, maxLen = 200) {
  const s = String(title ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const n = Math.max(1, Number(maxLen) || 200);
  return s.length > n ? s.slice(0, n) : s;
}

function isProcessRunningStage(stage) {
  const s = String(stage || "");
  return (
    s === "exporting" ||
    s === "preparing" ||
    s === "uploading" ||
    s === "transcribing" ||
    s === "merging" ||
    s === "cancelling"
  );
}

function canChangeProcessMode(processStage) {
  return !isProcessRunningStage(processStage);
}

function isAnalysisRunningStatus(status) {
  return status === "running" || status === "cancelling";
}

function canGenerateRaw(
  lifecycleStatus,
  processStage,
  {
    hasSession = true,
    analysisStatus = "none",
    source = null,
    sessionStatus = null,
    hasArchive = false
  } = {}
) {
  if (!hasSession) return false;
  if (isImportBlockingStatus(sessionStatus)) return false;
  if (isBusyCapture(lifecycleStatus)) return false;
  if (isProcessRunningStage(processStage)) return false;
  if (isAnalysisRunningStatus(analysisStatus)) return false;
  if (source === "import") {
    return isImportSessionReady(sessionStatus, { hasArchive });
  }
  // Capture path: require stopped (or faulted) before starting ASR.
  return lifecycleStatus === "stopped" || lifecycleStatus === "faulted";
}

function canRetryProcess(
  lifecycleStatus,
  processStage,
  {
    hasSession = true,
    analysisStatus = "none",
    source = null,
    sessionStatus = null,
    hasArchive = false
  } = {}
) {
  if (!hasSession) return false;
  if (isImportBlockingStatus(sessionStatus)) return false;
  if (isBusyCapture(lifecycleStatus)) return false;
  if (isProcessRunningStage(processStage)) return false;
  if (isAnalysisRunningStatus(analysisStatus)) return false;
  if (!(processStage === "failed" || processStage === "cancelled")) return false;
  if (source === "import") {
    return isImportSessionReady(sessionStatus, { hasArchive }) || sessionStatus === "stopped";
  }
  return true;
}

function canCancelProcess(processStage) {
  return isProcessRunningStage(processStage);
}

function canRunAnalysis(
  processStage,
  analysisStatus,
  { hasSession = true, hasRaw = true, sessionStatus = null } = {}
) {
  if (!hasSession) return false;
  if (isImportBlockingStatus(sessionStatus)) return false;
  if (!hasRaw && processStage !== "completed") return false;
  if (processStage !== "completed") return false;
  if (isAnalysisRunningStatus(analysisStatus)) return false;
  return true;
}

function canRetryAnalysis(processStage, analysisStatus, { hasSession = true, sessionStatus = null } = {}) {
  if (!hasSession) return false;
  if (isImportBlockingStatus(sessionStatus)) return false;
  if (processStage !== "completed") return false;
  if (isAnalysisRunningStatus(analysisStatus)) return false;
  return analysisStatus === "failed" || analysisStatus === "cancelled";
}

function canCancelAnalysis(analysisStatus) {
  return isAnalysisRunningStatus(analysisStatus);
}

/** Immediate UI state while process IPC is still pending. */
function buildOptimisticProcessRunning(prev = null) {
  const base = prev && typeof prev === "object" ? { ...prev } : {};
  return {
    ...base,
    stage: "exporting",
    status: "running",
    optimistic: true
  };
}

/** Immediate UI state while analysis IPC is still pending. */
function buildOptimisticAnalysisRunning(prev = null) {
  const base = prev && typeof prev === "object" ? { ...prev } : {};
  return {
    ...base,
    status: "running",
    stage: base.stage && base.stage !== "done" ? base.stage : "fingerprint",
    optimistic: true
  };
}

/**
 * Accept a late IPC/status payload only when token + selected session still match.
 * responseSessionId may be omitted (then only token is checked).
 */
function shouldAcceptRemoteUpdate({
  token,
  isCurrent,
  selectedId,
  responseSessionId = null
} = {}) {
  if (typeof isCurrent === "function") {
    if (!isCurrent(token)) return false;
  }
  if (responseSessionId != null && responseSessionId !== "" && selectedId != null && selectedId !== "") {
    if (String(responseSessionId) !== String(selectedId)) return false;
  }
  return true;
}

function computeControlFlags({
  hasSession = false,
  lifecycleStatus = "idle",
  processStage = "idle",
  analysisStatus = "none",
  hasRaw = false,
  source = null,
  sessionStatus = null,
  hasArchive = false
} = {}) {
  const ctx = { hasSession, analysisStatus, source, sessionStatus, hasArchive };
  return {
    canStartCapture:
      hasSession && canStartCapture(lifecycleStatus, processStage, analysisStatus, { source, sessionStatus }),
    canGenerateRaw: canGenerateRaw(lifecycleStatus, processStage, ctx),
    canRetryProcess: canRetryProcess(lifecycleStatus, processStage, ctx),
    canCancelProcess: canCancelProcess(processStage),
    canRunAnalysis: canRunAnalysis(processStage, analysisStatus, {
      hasSession,
      hasRaw,
      sessionStatus
    }),
    canRetryAnalysis: canRetryAnalysis(processStage, analysisStatus, { hasSession, sessionStatus }),
    canCancelAnalysis: canCancelAnalysis(analysisStatus)
  };
}

function flattenSummarySections(summary) {
  if (!summary || typeof summary !== "object") return [];
  const sections = [];
  const template = summary.template === "personal" ? "personal" : "meeting";

  function push(title, lines) {
    const clean = (lines || []).map((l) => String(l || "").trim()).filter(Boolean);
    if (clean.length) sections.push({ title, lines: clean });
  }

  if (template === "meeting") {
    if (summary.executiveSummary?.text) {
      push("执行摘要", [summary.executiveSummary.text]);
    }
    push(
      "议题大纲",
      (summary.topicsOutline || []).map((t) => t.title || t.text)
    );
    push("事实", (summary.facts || []).map((x) => x.text || x.label));
    push(
      "关键实体",
      (summary.entities || []).map((x) => {
        const detail = [x.type, x.status].filter(Boolean).join(" · ");
        return [x.text || x.label || x.name, detail].filter(Boolean).join(" · ");
      })
    );
    push(
      "决定",
      (summary.decisions || []).map((d) => d.text)
    );
    push(
      "行动项",
      (summary.actionItems || []).map((a) => {
        const bits = [a.text];
        if (a.owner) bits.push(`负责人: ${a.owner}`);
        if (a.due) bits.push(`截止: ${a.due}`);
        return bits.filter(Boolean).join(" · ");
      })
    );
    push(
      "未决问题",
      (summary.openIssues || []).map((x) => x.text)
    );
    push(
      "风险",
      (summary.risks || []).map((x) => x.text)
    );
    push(
      "关键原话",
      (summary.keyQuotes || []).map((q) => {
        const who = q.speakerId ? `[${q.speakerId}] ` : "";
        return `${who}${q.text}`;
      })
    );
  } else {
    push("事实", (summary.facts || []).map((x) => x.text || x.label));
    push(
      "关键实体",
      (summary.entities || []).map((x) => {
        const detail = [x.type, x.status].filter(Boolean).join(" · ");
        return [x.text || x.label || x.name, detail].filter(Boolean).join(" · ");
      })
    );
    push(
      "核心想法",
      (summary.coreIdeas || []).map((x) => x.text)
    );
    push(
      "论述框架",
      (summary.argumentOutline || []).map((t) => t.title || t.text)
    );
    push(
      "支撑点",
      (summary.supportingPoints || []).map((x) => x.text)
    );
    push(
      "假设",
      (summary.assumptions || []).map((x) => x.text)
    );
    push(
      "未展开问题",
      (summary.openQuestions || []).map((x) => x.text)
    );
    push(
      "下一步",
      (summary.nextSteps || []).map((x) => x.text)
    );
  }
  push(
    "待确认",
    (summary.flaggedUncertain || []).map((u) => `${u.text}${u.reason ? ` (${u.reason})` : ""}`)
  );
  return sections;
}

function pickBlockTimes(it) {
  const begin =
    it.sessionBeginMs ?? it.beginMs ?? it.sourceBeginMs ?? it.artifactBeginMs ?? null;
  const end = it.sessionEndMs ?? it.endMs ?? it.sourceEndMs ?? it.artifactEndMs ?? null;
  return { beginMs: begin, endMs: end };
}

function formatTranscriptBlocks(doc) {
  const items = Array.isArray(doc?.items) ? doc.items : [];
  return items.map((it) => {
    const { beginMs, endMs } = pickBlockTimes(it);
    return {
      id: it.id,
      speakerId: it.speakerId || "unknown",
      beginMs,
      endMs,
      artifactBeginMs: it.artifactBeginMs,
      sessionBeginMs: it.sessionBeginMs,
      sourceBeginMs: it.sourceBeginMs,
      timeLabel: `${formatClockMs(beginMs)} – ${formatClockMs(endMs)}`,
      text: String(it.text || it.correctedText || "")
    };
  });
}

/**
 * Clear element and append safe text nodes / structure (no innerHTML of untrusted).
 */
function fillTextElement(el, text) {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(document.createTextNode(String(text ?? "")));
}

function appendTranscriptBlocks(container, blocks) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!blocks.length) {
    const empty = document.createElement("p");
    empty.className = "meeting-empty";
    empty.textContent = "暂无内容";
    container.appendChild(empty);
    return;
  }
  for (const b of blocks) {
    const block = document.createElement("article");
    block.className = "meeting-block";
    const head = document.createElement("header");
    head.className = "meeting-block-head";
    const sp = document.createElement("strong");
    sp.textContent = b.speakerId || "unknown";
    const tm = document.createElement("span");
    tm.textContent = b.timeLabel || "";
    head.appendChild(sp);
    head.appendChild(tm);
    const body = document.createElement("p");
    body.className = "meeting-block-body";
    body.textContent = b.text || "";
    block.appendChild(head);
    block.appendChild(body);
    container.appendChild(block);
  }
}

function appendSummarySections(container, sections) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!sections.length) {
    const empty = document.createElement("p");
    empty.className = "meeting-empty";
    empty.textContent = "暂无总结";
    container.appendChild(empty);
    return;
  }
  for (const sec of sections) {
    const section = document.createElement("section");
    section.className = "meeting-summary-section";
    const h = document.createElement("h3");
    h.textContent = sec.title;
    section.appendChild(h);
    const ul = document.createElement("ul");
    for (const line of sec.lines) {
      const li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    }
    section.appendChild(ul);
    container.appendChild(section);
  }
}

function filterSessions(sessions, query) {
  const q = String(query || "").trim().toLowerCase();
  const list = Array.isArray(sessions) ? sessions : [];
  if (!q) return list;
  return list.filter((s) => {
    const dateBits = `${s.createdAt || ""} ${s.updatedAt || ""}`;
    const src = s.source || "";
    const blob = `${s.id || ""} ${s.title || ""} ${s.status || ""} ${src} ${dateBits} ${
      s.importMeta?.sourceFileName || ""
    }`.toLowerCase();
    return blob.includes(q);
  });
}

function sessionStatusLabel(status, source) {
  const st = String(status || "");
  if (st === "importing") return "导入中";
  if (st === "import_failed") return "导入失败";
  if (st === "import_cancelled") return "导入取消";
  if (st === "import_interrupted") return "导入中断";
  if (source === "import" && st === "stopped") return "已导入";
  return captureStatusLabel(st);
}

function sessionListMetaLine(s) {
  const src = s.source === "import" ? "导入" : "录制";
  const stLabel = sessionStatusLabel(s.status, s.source);
  const date = String(s.updatedAt || s.createdAt || "").slice(0, 16).replace("T", " ");
  const flags = [];
  if (s.hasRaw) flags.push("原文");
  if (s.hasSummary) flags.push("总结");
  return [src, stLabel, date, flags.join("+")].filter(Boolean).join(" · ");
}

/**
 * Variable-height virtual list with height cache + prefix sums + binary search.
 * After measure, call setMeasuredHeight(i, h) and optionally reanchorScroll.
 */
function createVirtualWindow({
  itemCount = 0,
  viewportHeight = 400,
  estimatedItemHeight = 88,
  overscan = 6,
  heights = null
} = {}) {
  const count = Math.max(0, Number(itemCount) || 0);
  const vh = Math.max(40, Number(viewportHeight) || 400);
  const est = Math.max(24, Number(estimatedItemHeight) || 88);
  const ov = Math.max(0, Number(overscan) || 0);
  const h = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const v = heights && Number(heights[i]);
    h[i] = Number.isFinite(v) && v > 0 ? v : est;
  }
  let scrollTop = 0;
  let prefix = null;

  function rebuildPrefix() {
    prefix = new Array(count + 1);
    prefix[0] = 0;
    for (let i = 0; i < count; i += 1) prefix[i + 1] = prefix[i] + h[i];
  }
  rebuildPrefix();

  function totalHeight() {
    return prefix[count] || 0;
  }

  function offsetOf(index) {
    const i = Math.max(0, Math.min(count, index | 0));
    return prefix[i] || 0;
  }

  function indexAtOffset(y) {
    if (count <= 0) return 0;
    const target = Math.max(0, Number(y) || 0);
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (prefix[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function setScrollTop(y) {
    const max = Math.max(0, totalHeight() - vh);
    scrollTop = Math.max(0, Math.min(max, Number(y) || 0));
  }

  function setMeasuredHeight(index, heightPx) {
    const i = index | 0;
    if (i < 0 || i >= count) return false;
    const next = Math.max(24, Math.ceil(Number(heightPx) || est));
    if (h[i] === next) return false;
    h[i] = next;
    rebuildPrefix();
    return true;
  }

  /**
   * Keep the same pixel offset within the anchor item after height changes.
   * anchorOffsetInItem = scrollTop - offsetOf(anchor) before measure.
   * Returns suggested scrollTop (does not jump to segment start when offset > 0).
   */
  function reanchorScroll(anchorIndex, anchorOffsetInItem = 0) {
    const top = offsetOf(anchorIndex) + Math.max(0, Number(anchorOffsetInItem) || 0);
    setScrollTop(top);
    return scrollTop;
  }

  function range() {
    if (count <= 0) {
      return { start: 0, end: 0, offsetY: 0, totalHeight: 0, scrollTop };
    }
    const start = Math.max(0, indexAtOffset(scrollTop) - ov);
    let end = start;
    const limit = scrollTop + vh;
    while (end < count && offsetOf(end) < limit) end += 1;
    end = Math.min(count, end + ov);
    return {
      start,
      end,
      offsetY: offsetOf(start),
      totalHeight: totalHeight(),
      scrollTop,
      heights: h.slice()
    };
  }

  return {
    get itemCount() {
      return count;
    },
    get estimatedItemHeight() {
      return est;
    },
    get heights() {
      return h.slice();
    },
    setScrollTop,
    setMeasuredHeight,
    reanchorScroll,
    offsetOf,
    indexAtOffset,
    totalHeight,
    range
  };
}

/** Pure guard for speaker-map save against session switch. */
function shouldApplySpeakerMapSave({ token, isCurrent, selectedId, saveSessionId } = {}) {
  return shouldAcceptRemoteUpdate({
    token,
    isCurrent,
    selectedId,
    responseSessionId: saveSessionId
  });
}

function seekMsFromTranscriptItem(item) {
  if (!item || typeof item !== "object") return null;
  const candidates = [
    item.artifactBeginMs,
    item.beginMs,
    item.sessionBeginMs,
    item.sourceBeginMs
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

// Node + browser
const api = {
  formatElapsed,
  formatClockMs,
  captureStatusLabel,
  processStageLabel,
  analysisStageLabel,
  segmentProgressText,
  processProgressText,
  remoteCleanupWarning,
  PROCESS_BITRATES,
  BITRATE_MB_PER_HOUR,
  normalizeProcessMode,
  normalizeBitrateKbps,
  bitrateSizeHint,
  bitrateOptionLabel,
  buildProcessPayload,
  speakerDefaultLabel,
  extractUniqueSpeakers,
  resolveSpeakerDisplayName,
  createRequestToken,
  createWorkbenchChannels,
  acceptChannelUpdate,
  shouldDriveCaptureUi,
  resolveCaptureStartedAt,
  needsMeetingPolling,
  clearOptimisticProcess,
  clearOptimisticAnalysis,
  mergePollSnapshot,
  createSingleFlight,
  isBusyCapture,
  isProcessRunningStage,
  canChangeProcessMode,
  isAnalysisRunningStatus,
  isImportBlockingStatus,
  isImportSessionReady,
  sessionStatusLabel,
  sanitizeSessionTitle,
  canStartCapture,
  canGenerateRaw,
  canRetryProcess,
  canCancelProcess,
  canRunAnalysis,
  canRetryAnalysis,
  canCancelAnalysis,
  buildOptimisticProcessRunning,
  buildOptimisticAnalysisRunning,
  shouldAcceptRemoteUpdate,
  computeControlFlags,
  flattenSummarySections,
  formatTranscriptBlocks,
  fillTextElement,
  appendTranscriptBlocks,
  appendSummarySections,
  filterSessions,
  sessionListMetaLine,
  createVirtualWindow,
  seekMsFromTranscriptItem,
  pickBlockTimes,
  shouldApplySpeakerMapSave
};

if (typeof module === "object" && module.exports) {
  module.exports = api;
}
if (typeof window !== "undefined") {
  window.MeetingUi = api;
}
