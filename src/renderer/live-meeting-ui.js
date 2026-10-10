"use strict";

(function installLiveMeetingUi(root) {
  const DEFAULT_MODEL = "qwen-audio-3.0-asr-flash-streaming";
  const REVIEW_MODEL = "mimo-v2.5-asr";
  const BATCH_MODEL = "mimo-v2.5-asr";
  const LIVE_MODELS = [DEFAULT_MODEL, "fun-asr-realtime", BATCH_MODEL];
  const supportedModel = (model) => typeof model === "string" && model === model.trim()
    && (model === BATCH_MODEL || /^(?:qwen-audio-3\.0-asr-flash-streaming|fun-asr-realtime)(?:-\d{4}-\d{2}-\d{2})?$/.test(model));
  const batchModel = (model) => model === BATCH_MODEL;
  const asrDefaults = typeof module === "object" && module.exports ? require("../asr-defaults") : root.AsrDefaults;
  const STATUS_LABELS = {
    idle: "就绪", starting: "正在启动", recording: "实时转录中", stopping: "停止收尾中",
    paused: "已暂停", completed: "已完成", needs_retry: "有待重试片段", interrupted: "会话已中断", failed: "会话失败"
  };
  const count = (value) => Array.isArray(value) ? value.length : Math.max(0, Number(value) || 0);
  const timestamp = (value) => value == null ? 0 : Number(value) || Date.parse(value) || 0;
  const active = (dto) => Boolean(dto.recording || dto.paused) || ["starting", "recording", "paused", "stopping"].includes(dto.status);
  const processing = (status) => ["running", "queued", "processing", "reviewing", "cleaning", "summarizing"].includes(status);
  const cleaning = (dto) => processing(dto.cleanupStatus) || processing(dto.postprocessStatus);

  function createLiveMeetingUi(win, { now = Date.now, every = setInterval, cancel = clearInterval } = {}) {
    const doc = win.document;
    const $ = (id) => doc.getElementById(id);
    if (!$("liveMeetingPanel")) return null;
    const api = win.mimoInput || {};
    let dto = { status: "idle", recording: false };
    let opened = false;
    let loaded = false;
    let settingsReady = false;
    let asrSettings = {};
    let generation = 0;
    let revision = 0;
    let pollFlight = null;
    let openFlight = null;
    let unsubscribe = null;
    let timer = null;
    let ticks = 0;
    let errorText = "";
    let destination = "";
    let observedAt = 0;
    let observedElapsed = 0;
    const modelIds = LIVE_MODELS;
    let windowFlags = { floating: false, minimal: false, alwaysOnTop: false, fontSize: 14, opacity: 0.9 };
    let unsubscribeWindow;
    let styleTimer;
    let stylePatch = {};
    let latestDraft = "";
    let windowBusy = false;
    let windowRevision = 0;
    let summarySignature = "";
    let audioSignature = "";
    let historySignature = "";
    let historyItems = [];
    let historyOpen = false;
    let historyLoading = false;
    let setupCollapsedOnActive = false;
    let asrReadiness = new Map();
    const sidebarPreferenceKey = "ovi-live-sidebars";
    try {
      const preference = JSON.parse(win.localStorage?.getItem(sidebarPreferenceKey));
      $("liveSetupDetails").open = preference?.setup !== false;
      historyOpen = preference?.history === true;
    } catch { $("liveSetupDetails").open = true; }
    const busy = new Set();

    function saveSidebars() {
      try { win.localStorage?.setItem(sidebarPreferenceKey, JSON.stringify({ setup: Boolean($("liveSetupDetails").open), history: historyOpen })); } catch { /* Optional view preference. */ }
    }

    function syncSidebars() {
      const details = $("liveSetupDetails");
      if (win.innerWidth <= 900 && details.open) historyOpen = false;
      const setupOpen = Boolean(details.open) && !windowFlags.floating;
      $("liveSetupToggle")?.setAttribute("aria-expanded", String(setupOpen));
      $("liveHistoryBrowser").hidden = !historyOpen || windowFlags.floating;
      $("liveHistoryToggle").setAttribute("aria-expanded", String(historyOpen && !windowFlags.floating));
      const backdrop = $("liveSidebarBackdrop");
      if (backdrop) backdrop.hidden = windowFlags.floating || win.innerWidth > 900 || (!setupOpen && !historyOpen);
    }

    function setSetupOpen(value) {
      $("liveSetupDetails").open = Boolean(value);
      if (value && win.innerWidth <= 900) historyOpen = false;
      syncSidebars(); saveSidebars();
    }

    function updateAsrReadiness(settings) {
      const chosen = asrDefaults.workspaceSelection(settings, "live").modelId;
      asrReadiness = new Map([...new Set([...modelIds, chosen, ...Object.keys(settings.meetingRealtimeProfiles || {})])]
        .map(modelId => [modelId, asrDefaults.workspaceReadiness(settings, "live", {
          modelId, provider: batchModel(modelId) ? "mimo" : /^fun-asr/.test(modelId) ? "fun-asr" : "qwen3-asr"
        })]));
    }

    function currentAsrReadiness() {
      const model = selectedModel();
      if (!supportedModel(model)) return { ready: false, message: "请选择与会议转录兼容的 ASR 模型。" };
      return asrReadiness.get(model) || asrReadiness.get(/^fun-asr/.test(model) ? "fun-asr-realtime" : DEFAULT_MODEL)
        || { ready: false, message: "请先在语音识别设置中配置当前 ASR 供应商。" };
    }

    function expandUnconfiguredSetup() {
      if (settingsReady && !active(dto) && !currentAsrReadiness().ready) setSetupOpen(true);
    }

    function selectedModel() {
      if ($("liveModel").value === asrDefaults.FOLLOW_DICTATION) return asrDefaults.dictationSelection(asrSettings, "live").modelId;
      return $("liveModel").value === "__custom__"
        ? $("liveCustomModel").value.trim() : $("liveModel").value;
    }

    function setModel(model) {
      $("liveModel").value = modelIds.includes(model) ? model : "__custom__";
      $("liveCustomModel").value = modelIds.includes(model) ? "" : model;
      $("liveCustomModelField").hidden = $("liveModel").value !== "__custom__";
    }

    function options(element, values, selected) {
      element.replaceChildren();
      for (const [value, label] of values) {
        const option = doc.createElement("option");
        option.value = value;
        option.textContent = label;
        element.appendChild(option);
      }
      element.value = selected;
    }

    function loadSettings(settings) {
      const selection = asrDefaults.workspaceSelection(settings, "live");
      asrSettings = {
        meetingRealtimeFollowDictation: selection.followsDictation,
        meetingRealtimeModel: selection.modelId,
        asrModel: settings.asrModel, asrProvider: settings.asrProvider,
        asrRealtimeModel: settings.asrProfiles?.[settings.asrModel]?.realtimeModel || settings.asrRealtimeModel
      };
      // Retain only model IDs and UI preferences, never connection profiles or credentials.
      const reviewers = new Set([REVIEW_MODEL]);
      for (const map of [settings.meetingFileAsrProfiles, settings.asrProfiles]) {
        for (const [id, profile] of Object.entries(map || {})) {
          if (/^mimo-.*asr/i.test(id) && (!profile?.provider || profile.provider === "mimo")) reviewers.add(id);
        }
      }
      // Credentials resolve in MAIN by exact model ID; only the explicit MiMo fallback may use batch transport here.
      const chosen = selection.modelId;
      options($("liveModel"), [
        [asrDefaults.FOLLOW_DICTATION, `跟随语音输入法 · ${asrDefaults.dictationSelection(settings, "live").modelId}`],
        ...modelIds.map((id) => [id, id === DEFAULT_MODEL ? "阿里云 Qwen 实时语音"
          : id === BATCH_MODEL ? "MiMo V2.5 ASR（非实时分段备用）" : "阿里云 Fun-ASR 实时语音"]),
        ["__custom__", "自定义实时模型 ID"]
      ], chosen);
      setModel(active(dto) ? dto.modelId || chosen : chosen);
      if (!active(dto) && selection.followsDictation) {
        $("liveModel").value = asrDefaults.FOLLOW_DICTATION;
        $("liveCustomModelField").hidden = true;
      }
      const picker = win.TextSupplierUi;
      const summaryOptions = picker.modelOptionGroups(settings, "summary");
      const selectedSummary = picker.formatPair(summaryOptions.selected.supplierId, summaryOptions.selected.modelId);
      const cleaners = summaryOptions.groups.flatMap(group => group.models.map(modelId => [
        picker.formatPair(group.supplierId, modelId), `${group.label} / ${modelId}`
      ]));
      if (summaryOptions.selected.modelId && !cleaners.some(([value]) => value === selectedSummary)) {
        cleaners.push([selectedSummary, `${summaryOptions.selected.supplierId} / ${summaryOptions.selected.modelId}（手动配置）`]);
      }
      options($("liveCleanerModel"), cleaners, selectedSummary);
      options($("liveReviewModel"), [...reviewers].map((id) => [id, id]), REVIEW_MODEL);
      destination = String(settings.meetingRealtimeDestination || "");
      $("liveCaptureMode").value = ["system", "microphone", "dual"].includes(settings.meetingCaptureMode) ? settings.meetingCaptureMode : "dual";
      $("liveTranscriptionInterval").value = [10, 15, 20, 30].includes(Number(settings.meetingTranscriptionIntervalSeconds))
        ? String(settings.meetingTranscriptionIntervalSeconds) : "30";
      $("liveSaveInterval").value = [10, 15, 30, 60, 120].includes(Number(settings.meetingAutosaveIntervalSeconds))
        ? String(settings.meetingAutosaveIntervalSeconds) : "30";
      settingsReady = true;
      updateAsrReadiness(settings);
      expandUnconfiguredSetup();
    }

    async function invoke(method, payload) {
      if (typeof api[method] !== "function") throw new Error("会议实时接口尚未接入，请更新主进程后重试。");
      const result = payload === undefined ? await api[method]() : await api[method](payload);
      if (!result || result.ok === false) throw new Error(result?.error?.message || "操作失败，请重试。");
      return result;
    }

    function accept(snapshot, { includeWindow = true } = {}) {
      if (!snapshot || snapshot.ok === false || !STATUS_LABELS[snapshot.status]) return;
      const sameSession = snapshot.sessionId === dto.sessionId;
      if (!sameSession) {
        latestDraft = "";
        observedAt = 0;
        observedElapsed = 0;
      }
      if ((snapshot.recording || snapshot.status === "recording") && !snapshot.paused && snapshot.status !== "paused") {
        if (!observedAt) observedAt = now();
      } else if (observedAt) {
        observedElapsed += now() - observedAt;
        observedAt = 0;
      }
      // Contract updates are complete DTO snapshots. Never carry outputs into a new session.
      dto = snapshot;
      if (dto.previewText) latestDraft = dto.previewText;
      else if (dto.rawText) latestDraft = String(dto.rawText).split(/\n+/).filter(Boolean).at(-1) || latestDraft;
      if (active(dto)) historyOpen = false;
      if (Array.isArray(snapshot.recoverableSessions)) historyItems = snapshot.recoverableSessions;
      if (includeWindow && snapshot.window) acceptWindow(snapshot.window);
      loaded = true;
      if (active(dto) && dto.modelId) {
        setModel(dto.modelId);
        if (asrSettings.meetingRealtimeFollowDictation && dto.modelId === asrDefaults.dictationSelection(asrSettings, "live").modelId) {
          $("liveModel").value = asrDefaults.FOLLOW_DICTATION;
          $("liveCustomModelField").hidden = true;
        }
      }
      if (active(dto) && dto.captureMode) $("liveCaptureMode").value = dto.captureMode;
      if (opened) render();
    }

    async function refresh() {
      if (pollFlight) return pollFlight;
      const epoch = generation;
      const atRevision = revision;
      const atWindowRevision = windowRevision;
      const flight = (async () => {
        try {
          const result = await invoke("meetingLiveStatus");
          if (epoch !== generation || atRevision !== revision) return;
          errorText = "";
          accept(result, { includeWindow: atWindowRevision === windowRevision && !windowBusy });
        } catch (error) {
          if (epoch === generation && atRevision === revision) {
            errorText = error.message;
            render();
          }
        }
      })();
      pollFlight = flight;
      try { await flight; } finally { if (pollFlight === flight) pollFlight = null; }
    }

    async function action(name, task) {
      if (busy.has(name)) return;
      busy.add(name);
      errorText = "";
      // Invalidates status reads that began before this user action.
      const changesSession = ["start", "stop", "pause", "retry", "history", "cleanup", "summarize", "cancelSummary"].includes(name);
      const atRevision = changesSession ? ++revision : revision;
      const atWindowRevision = windowRevision;
      const epoch = generation;
      render();
      try {
        const result = await task();
        if (changesSession && epoch === generation && atRevision === revision && result?.status) accept(result, { includeWindow: atWindowRevision === windowRevision && !windowBusy });
      } catch (error) {
        if (epoch === generation) errorText = error.message;
      } finally {
        busy.delete(name);
        render();
      }
    }

    function transcript(id, text, empty) {
      const pane = $(id);
      const next = String(text || empty);
      if (pane.textContent === next) return;
      const atBottom = pane.scrollHeight - pane.clientHeight - pane.scrollTop < 48;
      const previousTop = pane.scrollTop;
      pane.textContent = next;
      pane.scrollTop = atBottom ? pane.scrollHeight : previousTop;
    }

    function audioOutputs() {
      const entries = Array.isArray(dto.audioPaths) ? dto.audioPaths.map(path => ["", path]) : Object.entries(dto.audioPaths || {});
      const labels = { microphone: "打开麦克风录音", system: "打开系统声音录音", mixed: "打开混合录音" };
      const seen = new Set();
      return entries.filter(([, path]) => {
        if (typeof path !== "string" || !path || seen.has(path)) return false;
        seen.add(path);
        return true;
      }).map(([track, path], index, paths) => {
        const filename = path.split(/[\\/]/).pop();
        const source = labels[track] ? track : /^(microphone|system|mixed)-complete\.wav$/i.exec(filename)?.[1]?.toLowerCase();
        return { path, label: labels[source] || (paths.length === 1 ? "打开完整录音" : `打开录音文件 ${index + 1}`) };
      });
    }

    function acceptWindow(flags) {
      const previous = { ...windowFlags };
      for (const key of ["floating", "minimal", "alwaysOnTop"]) {
        if (typeof flags[key] === "boolean") windowFlags[key] = flags[key];
      }
      for (const [key, min, max] of [["fontSize", 12, 28], ["opacity", 0, 1]]) {
        if (Number.isFinite(flags[key])) windowFlags[key] = Math.min(max, Math.max(min, flags[key]));
      }
      if (!windowFlags.floating) windowFlags.minimal = false;
      else if (Number.isFinite(win.innerWidth) && Number.isFinite(win.innerHeight)) {
        windowFlags.minimal = win.innerWidth < 420 || win.innerHeight < 260;
      }
      if (windowFlags.floating) setHistoryOpen(false);
      if (previous.floating !== windowFlags.floating || previous.minimal !== windowFlags.minimal) {
        $("liveMeetingPanel").scrollTop = 0;
      }
    }

    function presentation(patch) {
      Object.assign(windowFlags, patch); Object.assign(stylePatch, patch); render();
      win.clearTimeout(styleTimer);
      styleTimer = win.setTimeout(() => { void flushPresentation(); }, 160);
    }

    async function flushPresentation() {
      const patch = stylePatch; stylePatch = {};
      if (!Object.keys(patch).length) return;
      try { await invoke("meetingLiveWindow", patch); }
      catch (error) { if (opened) { errorText = error.message; render(); } }
    }

    // Window changes never participate in capture revisions or mutate the session.
    async function changeWindow(patch) {
      if (windowBusy) return;
      windowBusy = true;
      windowRevision += 1;
      errorText = "";
      const epoch = generation;
      render();
      try {
        // Omitted flags let MAIN apply its entry defaults and restore the saved window.
        const result = await invoke("meetingLiveWindow", patch);
        if (epoch === generation) acceptWindow(result);
      } catch (error) {
        if (epoch === generation) errorText = error.message;
      } finally {
        windowBusy = false;
        render();
      }
    }

    function renderSummary() {
      const summary = dto.summary;
      $("liveSummarySection").hidden = !summary;
      const signature = JSON.stringify(summary || null);
      if (signature === summarySignature) return;
      summarySignature = signature;
      $("liveMindmap").replaceChildren();
      $("liveSummaryDetail").replaceChildren();
      $("liveDetailHeading").textContent = summary?.schema === "meeting_summary_v2" ? "整理正文" : "详细纪要";
      $("liveSummaryHeading").textContent = summary?.title ? `会议摘要 · ${summary.title}` : "会议摘要";
      if (!summary) return;
      const add = (parent, tag, value) => {
        const child = doc.createElement(tag);
        child.textContent = String(value);
        parent.appendChild(child);
        return child;
      };
      function annotations(parent, value) {
        if (value.uncertain === true) add(parent, "small", "待确认");
        for (const source of Array.isArray(value.provenance) ? value.provenance.slice(0, 16) : []) {
          if (typeof source?.quote === "string" && source.quote) add(parent, "small", `来源：${source.quote}`);
        }
      }
      // Render only DOM text nodes. Model-produced Markdown/HTML is never executed.
      let remaining = 1000;
      function branches(parent, value, depth = 0) {
        if (value == null || depth > 12 || --remaining < 0) return;
        if (typeof value !== "object") { add(parent, "span", value); return; }
        const nodes = Array.isArray(value) ? value : [value];
        const list = doc.createElement("ul");
        parent.appendChild(list);
        for (const node of nodes) {
          if (remaining <= 0) break;
          const item = doc.createElement("li");
          list.appendChild(item);
          if (node && typeof node === "object" && !Array.isArray(node)) {
            add(item, "span", node.title || node.label || node.text || node.topic || "议题");
            annotations(item, node);
            branches(item, node.children || node.branches || node.items || node.points, depth + 1);
            remaining -= 1;
          } else branches(item, node, depth + 1);
        }
      }
      branches($("liveMindmap"), summary.mindmap);
      const detail = $("liveSummaryDetail");
      const sections = Array.isArray(summary.sections) ? summary.sections.filter(section =>
        section && typeof section.heading === "string"
        && (Array.isArray(section.items) || Array.isArray(section.paragraphs))) : [];
      if (summary.schema === "meeting_summary_v2" && sections.length) {
        let remaining = 2000;
        for (const section of sections) {
          for (const paragraph of section.paragraphs || []) {
            if (--remaining < 0) break;
            if (!paragraph || typeof paragraph.text !== "string") continue;
            const prose = add(detail, "p", paragraph.text);
            if (paragraph.uncertain === true) add(prose, "small", "待确认，请核对原文");
          }
        }
        return;
      }
      if (sections.length) {
        let itemsRemaining = 2000;
        for (const section of sections.slice(0, 200)) {
          add(detail, "h4", section.heading);
          // Coherent prose paragraphs are the primary reading form of the shared
          // summary schema; discrete bullet items stay available for action lists.
          for (const paragraph of (section.paragraphs || [])) {
            if (--itemsRemaining < 0) break;
            if (!paragraph || typeof paragraph.text !== "string") continue;
            const prose = add(detail, "p", paragraph.text);
            annotations(prose, paragraph);
          }
          const items = (section.items || []).filter(item => item && typeof item.text === "string");
          if (items.length) {
            const list = doc.createElement("ul");
            detail.appendChild(list);
            for (const item of items) {
              if (--itemsRemaining < 0) break;
              const li = add(list, "li", item.text);
              annotations(li, item);
            }
          }
        }
        return;
      }
      // Older sessions may contain only Markdown. Support block headings and lists as text.
      let paragraph = [];
      let list = null;
      const flush = () => { if (paragraph.length) add(detail, "p", paragraph.join("\n")); paragraph = []; };
      for (const line of String(summary.markdown || "").split(/\r?\n/)) {
        const heading = /^#{1,6}\s+(.+)$/.exec(line);
        const bullet = /^\s*(?:[-*+] |\d+\. )(.+)$/.exec(line);
        if (heading || bullet || !line.trim()) flush();
        if (heading) {
          list = null;
          if (heading[1] !== summary.title) add(detail, "h4", heading[1]);
        } else if (bullet) {
          if (!list) { list = doc.createElement("ul"); detail.appendChild(list); }
          add(list, "li", bullet[1]);
        } else {
          list = null;
          if (line.trim()) paragraph.push(line);
        }
      }
      flush();
    }

    function renderClock() {
      const started = timestamp(dto.startedAtMs || dto.startedAt);
      const elapsed = dto.durationMs != null ? Number(dto.durationMs) : dto.elapsedMs != null ? Number(dto.elapsedMs)
        : started && !dto.paused && dto.status !== "paused" ? (active(dto) ? now() : timestamp(dto.stoppedAtMs || dto.stoppedAt) || started) - started
          : observedElapsed + (observedAt ? now() - observedAt : 0);
      const seconds = Math.max(0, Math.floor(elapsed / 1000) || 0);
      $("liveElapsed").textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .slice(seconds >= 3600 ? 0 : 1).map((v) => String(v).padStart(2, "0")).join(":");
      $("liveElapsedLabel").textContent = started || dto.durationMs != null || dto.elapsedMs != null ? "录制时长" : "本页计时";
      const saved = timestamp(dto.lastSavedAt);
      const saveInterval = Number(dto.saveIntervalSeconds) || Number($("liveSaveInterval").value) || 30;
      const overdueAfterMs = Math.max(15000, saveInterval * 1500);
      const overdue = dto.recording && ((saved && now() - saved > overdueAfterMs) || (!saved && observedAt && now() - observedAt > overdueAfterMs));
      $("liveSaved").dataset.kind = overdue ? "warning" : saved ? "saved" : "idle";
      const saveLabel = saveInterval >= 60 && saveInterval % 60 === 0 ? (saveInterval / 60) + " 分钟" : saveInterval + " 秒";
      $("liveSaved").textContent = "每 " + saveLabel + " 自动保存 · " + (saved
        ? `最近保存 ${new Date(saved).toLocaleTimeString("zh-CN", { hour12: false })}` : "尚未保存")
        + (overdue ? " · 保存确认延迟" : "");
      $("liveSaved").title = saved ? new Date(saved).toLocaleString("zh-CN") : "等待后端保存确认";
    }

    function formatDuration(value) {
      const seconds = Math.max(0, Math.round((Number(value) || 0) / 1000));
      if (!seconds) return "不足 1 分钟";
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor(seconds / 60) % 60;
      return hours ? `${hours} 小时 ${minutes} 分钟` : `${Math.max(1, minutes)} 分钟`;
    }

    function renderHistory() {
      $("liveHistoryBrowser").hidden = !historyOpen || windowFlags.floating;
      $("liveHistoryToggle").setAttribute("aria-expanded", String(historyOpen && !windowFlags.floating));
      $("liveHistoryCount").textContent = String(historyItems.length);
      const query = $("liveHistorySearch").value.trim().toLocaleLowerCase("zh-CN");
      const visible = historyItems.filter((item) => {
        const date = timestamp(item.startedAtMs) ? new Date(timestamp(item.startedAtMs)).toLocaleString("zh-CN") : "";
        return !query || [item.title, item.modelId, item.status, date].some(value => String(value || "").toLocaleLowerCase("zh-CN").includes(query));
      });
      const signature = JSON.stringify([visible, dto.sessionId, historyLoading, active(dto), busy.size]);
      if (signature !== historySignature) {
        historySignature = signature;
        $("liveHistoryList").replaceChildren();
        for (const item of visible) {
          const button = doc.createElement("button");
          button.type = "button";
          button.className = "live-history-item";
          button.setAttribute("role", "option");
          button.setAttribute("aria-selected", String(item.sessionId === dto.sessionId));
          button.disabled = active(dto) || historyLoading || busy.size > 0;
          const head = doc.createElement("span");
          head.className = "live-history-item-head";
          const title = doc.createElement("strong");
          title.textContent = item.title || "未命名会议";
          const date = doc.createElement("time");
          date.textContent = timestamp(item.startedAtMs) ? new Date(timestamp(item.startedAtMs)).toLocaleString("zh-CN", { hour12: false }) : "时间未知";
          head.appendChild(title); head.appendChild(date);
          const meta = doc.createElement("span");
          meta.className = "live-history-item-meta";
          meta.textContent = `${formatDuration(item.durationMs)} · ${item.modelId || "模型未知"}`;
          const states = doc.createElement("span");
          states.className = "live-history-item-states";
          states.textContent = [item.hasTranscript ? "有原文" : "无原文", item.hasCorrection ? "已校订" : "未校订", item.hasSummary ? "有摘要" : "无摘要"].join(" · ");
          button.appendChild(head); button.appendChild(meta); button.appendChild(states);
          button.addEventListener("click", () => {
            if (button.disabled || item.sessionId === dto.sessionId) { setHistoryOpen(false); return; }
            void action("history", async () => {
              const result = await invoke("meetingLiveOpenSession", { sessionId: item.sessionId });
              setHistoryOpen(false);
              return result;
            });
          });
          $("liveHistoryList").appendChild(button);
        }
      }
      $("liveHistoryEmpty").hidden = historyLoading || visible.length > 0;
      $("liveHistoryEmpty").textContent = query ? "没有符合条件的历史记录。" : "暂无实时会议记录。";
      $("liveHistoryRefresh").disabled = historyLoading || active(dto) || busy.size > 0;
    }

    function setHistoryOpen(value) {
      historyOpen = Boolean(value) && !windowFlags.floating;
      if (historyOpen && win.innerWidth <= 900) $("liveSetupDetails").open = false;
      syncSidebars(); saveSidebars();
      renderHistory();
      if (historyOpen && !historyLoading) void refreshHistory();
    }

    async function refreshHistory() {
      if (historyLoading || active(dto)) return;
      historyLoading = true;
      errorText = "";
      renderHistory();
      try {
        const result = await invoke("meetingLiveHistory");
        historyItems = Array.isArray(result.recoverableSessions) ? result.recoverableSessions : [];
        dto = { ...dto, recoverableSessions: historyItems };
      } catch (error) {
        errorText = error.message;
      } finally {
        historyLoading = false;
        render();
      }
    }

    function render() {
      const isActive = active(dto);
      const isCleaning = cleaning(dto) || busy.has("cleanup") || busy.has("summarize");
      const isPaused = Boolean(dto.paused || dto.status === "paused");
      const pending = count(dto.pendingSegments);
      const failed = count(dto.failedSegments);
      const locked = isActive || busy.size > 0 || isCleaning || !settingsReady;
      const can = (method) => typeof api[method] === "function";
      $("liveStart").disabled = !loaded || locked || !can("meetingLiveStart") || !supportedModel(selectedModel())
        || pending > 0 || failed > 0 || dto.finalizationPending || dto.error?.code === "live_save_failed";
      // Stopping remains available during a slow ASR retry or status request.
      const stopFailed = dto.error?.code === "live_stop_failed" && (dto.recording || isPaused);
      $("liveStop").disabled = !(dto.recording || isPaused) || (dto.status === "stopping" && !stopFailed) || busy.has("stop") || !can("meetingLiveStop");
      $("livePause").hidden = !isActive;
      $("livePause").disabled = !(dto.recording || isPaused) || ["starting", "stopping"].includes(dto.status)
        || busy.has("pause") || busy.has("stop") || !can(isPaused ? "meetingLiveResume" : "meetingLivePause");
      $("livePause").textContent = busy.has("pause") ? "正在切换…" : isPaused ? "继续录制" : "暂停";
      $("liveStart").textContent = busy.has("start") ? "正在开始…"
        : batchModel(selectedModel()) ? "开始分段转录" : "开始实时转录";
      const setupDetails = $("liveSetupDetails");
      if (setupDetails) {
        // Collapse setup once when a capture becomes active so the transcript keeps the space.
        if (isActive && !setupCollapsedOnActive) {
          setSetupOpen(false);
          setupCollapsedOnActive = true;
        }
        if (!isActive) setupCollapsedOnActive = false;
      }
      const setupMeta = $("liveSetupSummaryMeta");
      if (setupMeta) {
        const modelLabel = $("liveModel").selectedOptions?.[0]?.textContent || selectedModel() || "";
        setupMeta.textContent = [dto.title || "未命名会议", modelLabel].filter(Boolean).join(" · ");
      }
      const readiness = currentAsrReadiness();
      if ($("liveAsrConfigStatus")) {
        $("liveAsrConfigStatus").textContent = readiness.message;
        $("liveAsrConfigStatus").hidden = readiness.ready;
        $("liveAsrConfigStatus").dataset.ready = String(readiness.ready);
      }
      $("liveStop").textContent = stopFailed ? "重试停止并保存" : busy.has("stop") || dto.status === "stopping" ? "正在停止并保存…" : "停止并保存";
      for (const id of ["liveTitle", "liveModel", "liveCustomModel", "liveCaptureMode", "liveTranscriptionInterval", "liveSaveInterval", "liveChooseDestination", "liveDefaultDestination"]) $(id).disabled = locked;
      $("liveChooseDestination").disabled ||= !can("meetingLiveChooseDestination");
      $("liveDefaultDestination").disabled ||= !destination;
      $("liveCustomModelField").hidden = $("liveModel").value !== "__custom__";
      $("liveTranscriptionIntervalField").hidden = !batchModel(selectedModel());
      $("liveTranscriptionInterval").disabled = locked || !batchModel(selectedModel());
      const stateLabel = dto.status === "stopping" && !dto.recording ? "录音已停止 · 识别收尾中"
        : loaded ? isPaused ? "已暂停" : STATUS_LABELS[dto.status] : "等待连接";
      $("liveStatus").textContent = "";
      $("liveStatus").title = stateLabel;
      $("liveStatus").setAttribute("aria-label", stateLabel);
      const connectionProblem = ["failed", "needs_retry", "unavailable"].includes(dto.previewStatus) || Boolean(dto.error);
      $("liveStatus").dataset.light = connectionProblem || ["failed", "interrupted", "needs_retry"].includes(dto.status) ? "red"
        : !loaded || isPaused || ["starting", "stopping"].includes(dto.status) || ["connecting", "reconnecting", "rotating", "retrying"].includes(dto.previewStatus) ? "yellow" : "green";
      $("liveStatus").dataset.kind = isPaused ? "paused" : dto.status;
      $("liveSessionTitle").textContent = dto.title || "实时会议";
      $("meetingPanel").classList.toggle("live-floating", windowFlags.floating);
      $("meetingPanel").classList.toggle("live-minimal", windowFlags.floating && windowFlags.minimal);
      $("meetingPanel").classList.toggle("live-background-clear", windowFlags.opacity === 0);
      const shell = doc.querySelector?.(".shell");
      if (shell?.style) {
        shell.style.setProperty("--live-opacity", String(windowFlags.opacity));
        shell.style.setProperty("--live-font-size", `${windowFlags.fontSize}px`);
      }
      $("liveFloat").hidden = windowFlags.floating || !dto.sessionId || dto.status === "starting";
      $("liveFloat").disabled = windowBusy || !can("meetingLiveWindow");
      for (const id of ["liveDetail", "liveAlwaysOnTop", "liveFontControl"]) $(id).hidden = !windowFlags.floating;
      for (const id of ["liveDetail", "liveAlwaysOnTop", "liveRestoreNormal"]) $(id).disabled = windowBusy || !can("meetingLiveWindow");
      $("liveAlwaysOnTop").setAttribute("aria-pressed", String(windowFlags.alwaysOnTop));
      $("liveAlwaysOnTop").title = windowFlags.alwaysOnTop ? "取消置顶" : "置顶显示";
      $("liveRestoreNormal").hidden = !(windowFlags.floating && windowFlags.minimal);
      $("liveMinimalControls").hidden = !(windowFlags.floating && windowFlags.minimal);
      for (const id of ["liveFontSize", "liveMinimalFontSize"]) $(id).value = String(windowFlags.fontSize);
      $("liveFontValue").textContent = String(windowFlags.fontSize);
      $("liveOpacity").value = String(Math.round(windowFlags.opacity * 100));
      $("liveQueue").textContent = `待识别 ${pending} 段 · 失败 ${failed} 段`;
      $("liveRetry").disabled = !loaded || isActive || busy.size > 0 || isCleaning
        || !(pending || failed || dto.finalizationPending || dto.error?.code === "live_save_failed"
          || ["needs_retry", "interrupted", "failed"].includes(dto.status)) || !can("meetingLiveRetry");
      $("liveHistoryToggle").hidden = windowFlags.floating;
      $("liveHistoryToggle").disabled = isActive || busy.size > 0 || isCleaning || !can("meetingLiveHistory") || !can("meetingLiveOpenSession");
      $("liveRefresh").disabled = busy.size > 0;
      $("liveError").textContent = errorText || dto.error?.message || (typeof dto.error === "string" ? dto.error : "")
        || (!supportedModel(selectedModel()) && selectedModel() ? "不支持此模型，请选择会议识别模型。" : "");
      $("liveError").hidden = !$("liveError").textContent;
      $("liveDestination").textContent = dto.markdownPath || destination || "文稿 / Open Voice Input / Meetings（自动新建）";
      if (dto.markdownPath && destination && dto.markdownPath !== destination) $("liveDestination").textContent += "\n已另存至上述实际路径，未覆盖所选文件。";
      // When a finished session remains visible, keep the next destination explicit.
      if (!isActive && dto.markdownPath) $("liveDestination").textContent += `\n下次：${destination || "默认位置（自动新建）"}`;
      $("liveOpenMarkdown").disabled = !dto.markdownPath || !can("meetingLiveOpenPath");
      $("liveOpenMarkdown").title = dto.markdownPath || "尚无原文文件";
      const paths = audioOutputs();
      const signature = JSON.stringify([paths, can("meetingLiveOpenPath")]);
      if (signature !== audioSignature) {
        audioSignature = signature;
        $("liveAudioOutputs").replaceChildren();
        paths.forEach(({ path, label }) => {
          const button = doc.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.title = path;
          button.disabled = !can("meetingLiveOpenPath");
          button.addEventListener("click", () => action("open", () => invoke("meetingLiveOpenPath", { path })));
          $("liveAudioOutputs").appendChild(button);
        });
      }
      transcript("liveRaw", dto.rawText, "尚无转写内容");
      const isBatch = batchModel(selectedModel());
      transcript("livePreview", dto.previewText || (windowFlags.minimal ? latestDraft : ""), windowFlags.floating ? "" :
        isPaused ? "录制已暂停" : dto.status === "stopping" ? "正在确认末尾转写…" : isBatch
          ? "录音持续保存，每 " + $("liveTranscriptionInterval").value + " 秒提交一段 MiMo 转写…" : "正在聆听…");
      $("livePreviewSection").hidden = !windowFlags.minimal && !isActive && !dto.previewText;
      $("liveDraftResize").hidden = !windowFlags.floating || windowFlags.minimal || $("livePreviewSection").hidden;
      $("livePreviewStatus").textContent = isPaused ? "已暂停" : isBatch ? "非实时分段转录"
        : ({ connecting: "实时连接中", listening: "正在聆听", streaming: "实时草稿", draft: "实时草稿", reconnecting: "正在重连", draining: "正在确认末尾转写", retrying: "正在补转写", needs_retry: "部分转写待重试", closed: "实时连接已关闭", failed: "实时连接失败", unavailable: "实时预览不可用", completed: "本段已确认" })[dto.previewStatus] || "实时草稿";
      $("livePreviewSection").dataset.kind = dto.previewStatus || "idle";
      $("liveCleanupSection").hidden = isActive || !dto.sessionId || dto.status === "idle";
      $("liveCleanerModel").disabled = isCleaning || busy.size > 0;
      $("liveUseMimoReview").disabled = locked;
      $("liveReviewModel").disabled = locked || !$("liveUseMimoReview").checked;
      $("liveReviewModelField").hidden = !$("liveUseMimoReview").checked;
      const canReviewAudio = $("liveUseMimoReview").checked && audioOutputs().length > 0;
      const postprocessBlocked = locked || !dto.sessionId || pending > 0 || (failed > 0 && !canReviewAudio)
        || dto.finalizationPending || dto.error?.code === "live_save_failed";
      $("liveSummarize").disabled = postprocessBlocked || (!dto.rawText && !canReviewAudio)
        || !$("liveCleanerModel").value || !can("meetingLiveSummarize");
      $("liveSummarize").textContent = busy.has("summarize") ? "正在生成摘要…"
        : dto.summary ? "重新生成摘要" : "生成摘要";
      if ($("liveCancelSummary")) $("liveCancelSummary").disabled = !processing(dto.postprocessStatus) || !can("meetingLiveCancelSummary");
      $("liveCleanupStatus").textContent = dto.summary ? "摘要已生成"
        : processing(dto.postprocessStatus) || busy.has("summarize") ? "正在生成摘要"
        : dto.postprocessStatus === "failed" ? "摘要失败，原文保留"
        : dto.postprocessStatus === "needs_retry" ? "摘要未完成，可重试"
        : dto.postprocessStatus === "cancelled" ? "已取消生成，原文保留"
        : "未生成摘要";
      const progress = dto.postprocessProgress;
      const operation = progress?.kind === "summary" ? "生成摘要" : progress?.kind === "reconcile" ? "校订" : "处理";
      $("livePostprocessStatus").textContent = ({ queued: "等待处理", running: `正在${operation}`, processing: `正在${operation}`, reviewing: "正在复核音频", cleaning: "正在校订", summarizing: "正在生成摘要", completed: "处理完成", cancelled: "已取消生成，可重新生成", needs_retry: "部分处理待重试", interrupted: "处理已中断，可重试", failed: "处理失败，可重试" })[dto.postprocessStatus]
        || (busy.has("summarize") ? "正在生成摘要" : "");
      const streamProgress = win.MeetingUi?.summaryProgressText?.(progress);
      if (processing(dto.postprocessStatus) && streamProgress) $("livePostprocessStatus").textContent = streamProgress;
      const failure = win.MeetingUi?.summaryErrorText?.(progress?.failureCode);
      if (failure && ["failed", "needs_retry"].includes(dto.postprocessStatus)) $("livePostprocessStatus").textContent += ` · ${failure}`;
      if (processing(dto.postprocessStatus) && progress?.total) $("livePostprocessStatus").textContent += ` ${count(progress.completed)} / ${count(progress.total)}`;
      if (progress?.failed) $("livePostprocessStatus").textContent += ` · 失败 ${count(progress.failed)} 段`;
      for (const [id, path] of [["liveOpenSummary", dto.summaryMarkdownPath]]) {
        $(id).disabled = !path || !can("meetingLiveOpenPath");
        $(id).title = path || "尚未生成";
      }
      renderSummary();
      renderClock();
      renderHistory();
      syncSidebars();
    }

    function open() {
      if (openFlight) return openFlight;
      opened = true;
      loaded = false;
      settingsReady = false;
      render();
      const epoch = generation;
      if (!unsubscribe && typeof api.onMeetingLiveUpdate === "function") {
        unsubscribe = api.onMeetingLiveUpdate((snapshot) => {
          if (snapshot?.ok === false) return;
          revision += 1;
          accept(snapshot);
        });
      }
      if (!unsubscribeWindow && typeof api.onMeetingLiveWindowChanged === "function") {
        unsubscribeWindow = api.onMeetingLiveWindowChanged(flags => { if (opened) { windowRevision++; acceptWindow(flags); render(); } });
      }
      if (!timer) timer = every(() => {
        renderClock();
        if (++ticks % 5 === 0 && !busy.size) void refresh();
      }, 1000);
      const flight = (async () => {
        await Promise.all([refresh(), (async () => {
          try {
            const settings = await invoke("getSettings");
            if (epoch === generation) {
              loadSettings(settings);
              if (active(dto) && dto.captureMode) $("liveCaptureMode").value = dto.captureMode;
              if (historyOpen) void refreshHistory();
            }
          } catch (error) {
            if (epoch === generation) errorText = error.message;
          }
        })()]);
        if (epoch === generation) render();
      })();
      openFlight = flight;
      void flight.finally(() => { if (openFlight === flight) openFlight = null; });
      return flight;
    }

    function close() {
      opened = false;
      generation += 1;
      revision += 1;
      // Leaving the view suspends rendering/polling, not the main-process task
      // or its state subscription. Completed results remain available on return.
      unsubscribeWindow?.(); unsubscribeWindow = null;
      win.clearTimeout?.(styleTimer); void flushPresentation();
      if (timer) cancel(timer);
      timer = null;
      pollFlight = null;
      openFlight = null;
    }

    function destroy() {
      close();
      unsubscribe?.();
      unsubscribe = null;
    }

    $("liveStart").addEventListener("click", () => {
      if ($("liveStart").disabled) return;
      void action("start", async () => {
        const modelId = selectedModel();
        const transcriptionIntervalSeconds = Number($("liveTranscriptionInterval").value) || 30;
        const saveIntervalSeconds = Number($("liveSaveInterval").value) || 30;
        await invoke("saveSettings", { meetingRealtimeModel: modelId,
          meetingRealtimeFollowDictation: $("liveModel").value === asrDefaults.FOLLOW_DICTATION,
          meetingTranscriptionIntervalSeconds: transcriptionIntervalSeconds,
          meetingAutosaveIntervalSeconds: saveIntervalSeconds });
        asrSettings.meetingRealtimeFollowDictation = $("liveModel").value === asrDefaults.FOLLOW_DICTATION;
        if (active(dto)) return;
        return invoke("meetingLiveStart", {
          title: $("liveTitle").value.trim(), modelId,
          provider: batchModel(modelId) ? "mimo" : "aliyun-streaming",
          transcriptionIntervalSeconds, saveIntervalSeconds,
          captureMode: $("liveCaptureMode").value,
          ...(destination ? { destinationPath: destination } : {})
        });
      });
    });
    for (const [id, name, method, payload] of [
      ["liveStop", "stop", "meetingLiveStop", () => undefined],
      ["liveRetry", "retry", "meetingLiveRetry", () => ({ sessionId: dto.sessionId })],
      ["liveCancelSummary", "cancelSummary", "meetingLiveCancelSummary", () => ({ sessionId: dto.sessionId })],
      ["liveSummarize", "summarize", "meetingLiveSummarize", () => {
        const selected = win.TextSupplierUi.parsePair($("liveCleanerModel").value);
        return { sessionId: dto.sessionId, supplierId: selected.supplierId || win.TextSupplierUi.LEGACY_SUPPLIER_ID,
          modelId: selected.modelId, useMimoReview: Boolean($("liveUseMimoReview").checked),
          reviewModelId: $("liveReviewModel").value };
      }],
      ["liveOpenMarkdown", "open", "meetingLiveOpenPath", () => ({ path: dto.markdownPath })],
      ["liveOpenSummary", "open", "meetingLiveOpenPath", () => ({ path: dto.summaryMarkdownPath })]
    ]) $(id)?.addEventListener("click", () => {
      if (!$(id).disabled) void action(name, () => invoke(method, payload()));
    });
    $("livePause").addEventListener("click", () => {
      if (!$("livePause").disabled) void action("pause", () => invoke(dto.paused || dto.status === "paused" ? "meetingLiveResume" : "meetingLivePause"));
    });
    $("liveFloat").addEventListener("click", () => {
      if (!$("liveFloat").disabled) void changeWindow({ floating: true });
    });
    $("liveDetail").addEventListener("click", () => {
      if (!$("liveDetail").disabled) void changeWindow({ floating: false });
    });
    $("liveAlwaysOnTop").addEventListener("click", () => {
      if (!$("liveAlwaysOnTop").disabled) void changeWindow({ alwaysOnTop: !windowFlags.alwaysOnTop });
    });
    $("liveRestoreNormal").addEventListener("click", () => { if (!windowBusy) void changeWindow({ restoreNormal: true }); });
    for (const id of ["liveFontSize", "liveMinimalFontSize"]) $(id).addEventListener("input", () => presentation({ fontSize: Number($(id).value) }));
    $("liveOpacity").addEventListener("input", () => presentation({ opacity: Number($("liveOpacity").value) / 100 }));
    win.addEventListener("resize", () => {
      if (!windowFlags.floating) { syncSidebars(); return; }
      const minimal = win.innerWidth < 420 || win.innerHeight < 260;
      if (minimal !== windowFlags.minimal) { windowFlags.minimal = minimal; render(); }
    });
    $("liveUseMimoReview").addEventListener("change", render);
    $("liveCleanerModel").addEventListener("change", render);
    $("liveChooseDestination").addEventListener("click", () => {
      if ($("liveChooseDestination").disabled) return;
      void action("destination", async () => {
        const result = await invoke("meetingLiveChooseDestination");
        if (result.cancelled) return;
        // The chooser owns persistence; only an explicit default reset writes settings here.
        const path = result.destinationPath || result.filePath || result.path;
        if (typeof path !== "string" || !path) throw new Error("未收到保存路径，请重新选择。");
        destination = path;
      });
    });
    $("liveDefaultDestination").addEventListener("click", () => {
      if ($("liveDefaultDestination").disabled) return;
      void action("destination", async () => {
        await invoke("saveSettings", { meetingRealtimeDestination: "" });
        destination = "";
      });
    });
    function saveModel() {
      render();
      expandUnconfiguredSetup();
      if (!supportedModel(selectedModel()) || active(dto)) return;
      const modelId = selectedModel();
      const followsDictation = $("liveModel").value === asrDefaults.FOLLOW_DICTATION;
      void action("model", async () => {
        const settings = await invoke("saveSettings", { meetingRealtimeModel: modelId, meetingRealtimeFollowDictation: followsDictation });
        asrSettings.meetingRealtimeFollowDictation = followsDictation;
        updateAsrReadiness(settings);
        expandUnconfiguredSetup();
      });
    }
    function saveIntervals() {
      if (!settingsReady || active(dto)) return;
      void invoke("saveSettings", {
        meetingTranscriptionIntervalSeconds: Number($("liveTranscriptionInterval").value) || 30,
        meetingAutosaveIntervalSeconds: Number($("liveSaveInterval").value) || 30
      }).catch(error => { errorText = error.message; render(); });
    }
    $("liveModel").addEventListener("change", saveModel);
    $("liveCustomModel").addEventListener("change", saveModel);
    $("liveCustomModel").addEventListener("input", render);
    $("liveTranscriptionInterval").addEventListener("change", saveIntervals);
    $("liveSaveInterval").addEventListener("change", saveIntervals);
    $("liveRefresh").addEventListener("click", () => { void refresh(); });
    $("liveHistoryToggle").addEventListener("click", () => setHistoryOpen(!historyOpen));
    $("liveHistoryClose").addEventListener("click", () => setHistoryOpen(false));
    $("liveHistoryRefresh").addEventListener("click", () => { void refreshHistory(); });
    $("liveHistorySearch").addEventListener("input", renderHistory);
    $("liveSetupToggle")?.addEventListener("click", () => setSetupOpen(!$("liveSetupDetails").open));
    $("liveSetupDetails")?.addEventListener("toggle", () => { syncSidebars(); saveSidebars(); });
    const closeSidebars = () => { setSetupOpen(false); setHistoryOpen(false); $("liveSetupToggle")?.focus?.(); };
    $("liveSidebarBackdrop")?.addEventListener("click", closeSidebars);
    win.addEventListener("keydown", event => {
      if (opened && event.key === "Escape" && $("liveSidebarBackdrop")?.hidden === false) { event.preventDefault(); closeSidebars(); }
    });
    $("liveHistoryBrowser").addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); setHistoryOpen(false); $("liveHistoryToggle").focus(); }
    });
    win.addEventListener("beforeunload", destroy);
    render();
    return { open, close, destroy, openSession: sessionId => action("history", () => invoke("meetingLiveOpenSession", { sessionId })) };
  }

  if (typeof module === "object" && module.exports) module.exports = { createLiveMeetingUi };
  if (root?.document) root.MeetingLiveUi = createLiveMeetingUi(root);
})(typeof window === "undefined" ? null : window);
