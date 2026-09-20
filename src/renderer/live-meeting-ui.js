"use strict";

(function installLiveMeetingUi(root) {
  const DEFAULT_MODEL = "qwen-audio-3.0-asr-flash-streaming";
  const REVIEW_MODEL = "mimo-v2.5-asr";
  const BATCH_MODEL = "mimo-v2.5-asr";
  const LIVE_MODELS = [DEFAULT_MODEL, "fun-asr-realtime", BATCH_MODEL];
  const supportedModel = (model) => typeof model === "string" && model === model.trim()
    && (model === BATCH_MODEL || /^(?:qwen-audio-3\.0-asr-flash-streaming|fun-asr-realtime)(?:-\d{4}-\d{2}-\d{2})?$/.test(model));
  const batchModel = (model) => model === BATCH_MODEL;
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
    let windowFlags = { floating: false, compact: false, alwaysOnTop: false };
    let windowBusy = false;
    let windowRevision = 0;
    let summarySignature = "";
    let audioSignature = "";
    let historySignature = "";
    const busy = new Set();

    function selectedModel() {
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
      // Retain only model IDs and UI preferences, never connection profiles or credentials.
      const reviewers = new Set([REVIEW_MODEL]);
      for (const map of [settings.meetingFileAsrProfiles, settings.asrProfiles]) {
        for (const [id, profile] of Object.entries(map || {})) {
          if (/^mimo-.*asr/i.test(id) && (!profile?.provider || profile.provider === "mimo")) reviewers.add(id);
        }
      }
      // Credentials resolve in MAIN by exact model ID; only the explicit MiMo fallback may use batch transport here.
      const chosen = supportedModel(settings.meetingRealtimeModel) ? settings.meetingRealtimeModel : DEFAULT_MODEL;
      options($("liveModel"), [
        ...modelIds.map((id) => [id, id === DEFAULT_MODEL ? "阿里云 Qwen 实时语音"
          : id === BATCH_MODEL ? "MiMo V2.5 ASR（非实时分段备用）" : "阿里云 Fun-ASR 实时语音"]),
        ["__custom__", "自定义实时模型 ID"]
      ], chosen);
      setModel(active(dto) ? dto.modelId || chosen : chosen);
      const cleaner = String(settings.meetingAnalysisModel || settings.cleanerModel || "mimo-v2.5");
      const cleaners = [...new Set([cleaner, ...Object.keys(settings.cleanerProfiles || {}), ...Object.keys(settings.meetingAnalysisProfiles || {})])];
      options($("liveCleanerModel"), cleaners.map((id) => [id, id]), cleaner);
      options($("liveReviewModel"), [...reviewers].map((id) => [id, id]), REVIEW_MODEL);
      destination = String(settings.meetingRealtimeDestination || "");
      $("liveCaptureMode").value = ["system", "microphone", "dual"].includes(settings.meetingCaptureMode) ? settings.meetingCaptureMode : "dual";
      $("liveTranscriptionInterval").value = [10, 15, 20, 30].includes(Number(settings.meetingTranscriptionIntervalSeconds))
        ? String(settings.meetingTranscriptionIntervalSeconds) : "30";
      $("liveSaveInterval").value = [10, 15, 30, 60, 120].includes(Number(settings.meetingAutosaveIntervalSeconds))
        ? String(settings.meetingAutosaveIntervalSeconds) : "30";
      settingsReady = true;
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
      if (includeWindow && snapshot.window) acceptWindow(snapshot.window);
      loaded = true;
      if (active(dto) && dto.modelId) setModel(dto.modelId);
      if (active(dto) && dto.captureMode) $("liveCaptureMode").value = dto.captureMode;
      render();
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
      const changesSession = ["start", "stop", "pause", "retry", "recover", "cleanup", "summarize"].includes(name);
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

    function cleanedPath() {
      if (!dto.correctedText || dto.cleanupStatus !== "completed") return "";
      return dto.cleanedMarkdownPath || "";
    }

    function audioOutputs() {
      const paths = Array.isArray(dto.audioPaths) ? dto.audioPaths : Object.values(dto.audioPaths || {});
      return [...new Set(paths.filter((path) => typeof path === "string" && path))];
    }

    function acceptWindow(flags) {
      const previous = { ...windowFlags };
      for (const key of ["floating", "compact", "alwaysOnTop"]) {
        if (typeof flags[key] === "boolean") windowFlags[key] = flags[key];
      }
      if (!windowFlags.floating) windowFlags.compact = false;
      if (windowFlags.floating) showHistory(false);
      if (previous.floating !== windowFlags.floating || previous.compact !== windowFlags.compact) {
        $("liveMeetingPanel").scrollTop = 0;
      }
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
        section && typeof section.heading === "string" && Array.isArray(section.items)) : [];
      if (sections.length) {
        let itemsRemaining = 2000;
        for (const section of sections.slice(0, 200)) {
          add(detail, "h4", section.heading);
          const list = doc.createElement("ul");
          detail.appendChild(list);
          for (const item of section.items) {
            if (--itemsRemaining < 0) break;
            if (!item || typeof item.text !== "string") continue;
            const li = add(list, "li", item.text);
            annotations(li, item);
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
      $("liveStop").textContent = stopFailed ? "重试停止并保存" : busy.has("stop") || dto.status === "stopping" ? "正在停止并保存…" : "停止并保存";
      for (const id of ["liveTitle", "liveModel", "liveCustomModel", "liveCaptureMode", "liveTranscriptionInterval", "liveSaveInterval", "liveChooseDestination", "liveDefaultDestination"]) $(id).disabled = locked;
      $("liveChooseDestination").disabled ||= !can("meetingLiveChooseDestination");
      $("liveDefaultDestination").disabled ||= !destination;
      $("liveCustomModelField").hidden = $("liveModel").value !== "__custom__";
      $("liveTranscriptionIntervalField").hidden = !batchModel(selectedModel());
      $("liveTranscriptionInterval").disabled = locked || !batchModel(selectedModel());
      $("liveStatus").textContent = loaded ? isPaused ? "已暂停" : STATUS_LABELS[dto.status] : "等待连接";
      if (dto.status === "recording" && batchModel(dto.modelId || selectedModel())) $("liveStatus").textContent = "分段转录中";
      if (dto.status === "stopping" && !dto.recording) $("liveStatus").textContent = "录音已停止 · 识别收尾中";
      $("liveStatus").dataset.kind = isPaused ? "paused" : dto.status;
      $("liveSessionTitle").textContent = dto.title || "实时会议";
      $("meetingPanel").classList.toggle("live-floating", windowFlags.floating);
      $("meetingPanel").classList.toggle("live-compact", windowFlags.compact);
      $("liveFloat").hidden = windowFlags.floating || !isActive || dto.status === "starting";
      $("liveFloat").disabled = windowBusy || !can("meetingLiveWindow");
      for (const id of ["liveCompact", "liveDetail", "livePinField"]) $(id).hidden = !windowFlags.floating;
      for (const id of ["liveCompact", "liveDetail", "liveAlwaysOnTop"]) $(id).disabled = windowBusy || !can("meetingLiveWindow");
      $("liveAlwaysOnTop").checked = windowFlags.alwaysOnTop;
      $("liveCompact").setAttribute("aria-pressed", String(windowFlags.compact));
      $("liveCompact").textContent = windowFlags.compact ? "展开" : "精简";
      $("liveQueue").textContent = `待识别 ${pending} 段 · 失败 ${failed} 段`;
      $("liveRetry").disabled = !loaded || isActive || busy.size > 0 || isCleaning
        || !(pending || failed || dto.finalizationPending || dto.error?.code === "live_save_failed"
          || ["needs_retry", "interrupted", "failed"].includes(dto.status)) || !can("meetingLiveRetry");
      $("liveRecover").disabled = isActive || busy.size > 0 || isCleaning || !can("meetingLiveRecover");
      $("liveRecoverSession").disabled = $("liveRecover").disabled;
      const sessions = Array.isArray(dto.recoverableSessions) ? dto.recoverableSessions : [];
      const nextHistory = JSON.stringify(sessions);
      if (nextHistory !== historySignature) {
        historySignature = nextHistory;
        const selected = $("liveRecoverSession").value;
        options($("liveRecoverSession"), [["", "最近会话"], ...sessions.map((s) => [s.sessionId,
          `${s.title || s.sessionId} · ${STATUS_LABELS[s.status] || s.status} · ${timestamp(s.startedAtMs) ? new Date(timestamp(s.startedAtMs)).toLocaleString("zh-CN") : ""}`])],
        sessions.some((s) => s.sessionId === selected) ? selected : "");
      }
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
        paths.forEach((path, index) => {
          const button = doc.createElement("button");
          button.type = "button";
          button.textContent = `打开音频 ${index + 1}`;
          button.title = path;
          button.disabled = !can("meetingLiveOpenPath");
          button.addEventListener("click", () => action("open", () => invoke("meetingLiveOpenPath", { path })));
          $("liveAudioOutputs").appendChild(button);
        });
      }
      transcript("liveRaw", dto.rawText, "尚无转写内容");
      const isBatch = batchModel(selectedModel());
      transcript("livePreview", dto.previewText,
        isPaused ? "录制已暂停" : dto.status === "stopping" ? "正在确认末尾转写…" : isBatch
          ? "录音持续保存，每 " + $("liveTranscriptionInterval").value + " 秒提交一段 MiMo 转写…" : "正在聆听…");
      $("livePreviewSection").hidden = !isActive && !dto.previewText;
      $("livePreviewStatus").textContent = isPaused ? "已暂停" : isBatch ? "非实时分段转录"
        : ({ connecting: "实时连接中", listening: "正在聆听", streaming: "实时草稿", draft: "实时草稿", reconnecting: "正在重连", draining: "正在确认末尾转写", retrying: "正在补转写", needs_retry: "部分转写待重试", closed: "实时连接已关闭", failed: "实时连接失败", unavailable: "实时预览不可用", completed: "本段已确认" })[dto.previewStatus] || "实时草稿";
      $("livePreviewSection").dataset.kind = dto.previewStatus || "idle";
      transcript("liveCorrected", dto.correctedText, "尚无校订文本");
      transcript("liveReviewed", dto.reviewedText, "尚无复核文本");
      $("liveCorrectedSection").hidden = !dto.correctedText;
      $("liveReviewedSection").hidden = !dto.reviewedText;
      $("liveResults").classList.toggle("has-corrected", Boolean(dto.correctedText || dto.reviewedText));
      $("liveCleanupSection").hidden = isActive || !dto.sessionId || dto.status === "idle";
      $("liveCleanerModel").disabled = isCleaning || busy.size > 0;
      $("liveUseMimoReview").disabled = locked;
      $("liveReviewModel").disabled = locked || !$("liveUseMimoReview").checked;
      $("liveReviewModelField").hidden = !$("liveUseMimoReview").checked;
      const postprocessBlocked = locked || !dto.sessionId || pending > 0 || failed > 0 || dto.finalizationPending || dto.error?.code === "live_save_failed";
      $("liveCleanup").disabled = postprocessBlocked
        || !dto.rawText || !$("liveCleanerModel").value || !can("meetingLiveCleanup");
      $("liveSummarize").disabled = postprocessBlocked || !dto.rawText || !$("liveCleanerModel").value || !can("meetingLiveSummarize");
      $("liveCleanup").textContent = dto.cleanupStatus === "failed" ? "重试校订" : "校订原文";
      $("liveCleanupStatus").textContent = processing(dto.cleanupStatus) || busy.has("cleanup") ? `正在校订 ${count(dto.cleanupProgress?.completed)} / ${count(dto.cleanupProgress?.total)} 段`
        : ({ completed: "校订已另存", failed: "校订失败，原文保留" })[dto.cleanupStatus] || "未校订";
      const progress = dto.postprocessProgress;
      const operation = progress?.kind === "summary" ? "生成摘要" : progress?.kind === "reconcile" ? "校订" : "处理";
      $("livePostprocessStatus").textContent = ({ queued: "等待处理", running: `正在${operation}`, processing: `正在${operation}`, reviewing: "正在复核音频", cleaning: "正在校订", summarizing: "正在生成摘要", completed: "处理完成", needs_retry: "部分处理待重试", interrupted: "处理已中断，可重试", failed: "处理失败，可重试" })[dto.postprocessStatus]
        || (busy.has("summarize") ? "正在生成摘要" : "");
      if (processing(dto.postprocessStatus) && progress?.total) $("livePostprocessStatus").textContent += ` ${count(progress.completed)} / ${count(progress.total)}`;
      if (progress?.failed) $("livePostprocessStatus").textContent += ` · 失败 ${count(progress.failed)} 段`;
      $("liveOpenCleaned").disabled = !cleanedPath() || !can("meetingLiveOpenPath");
      $("liveCleanedPath").textContent = cleanedPath();
      for (const [id, path] of [["liveOpenReviewed", dto.reviewedMarkdownPath], ["liveOpenSummary", dto.summaryMarkdownPath]]) {
        $(id).disabled = !path || !can("meetingLiveOpenPath");
        $(id).title = path || "尚未生成";
      }
      renderSummary();
      renderClock();
    }

    function showHistory(history, focus = false) {
      $("liveMeetingPanel").hidden = history;
      $("meetingHistoryPanel").hidden = !history;
      for (const [id, selected] of [["liveMeetingTab", !history], ["liveHistoryTab", history]]) {
        $(id).setAttribute("aria-selected", String(selected));
        $(id).tabIndex = selected ? 0 : -1;
        if (focus && selected) $(id).focus();
      }
    }

    function open() {
      showHistory(false);
      if (openFlight) return openFlight;
      opened = true;
      loaded = false;
      settingsReady = false;
      render();
      const epoch = generation;
      if (!unsubscribe && typeof api.onMeetingLiveUpdate === "function") {
        unsubscribe = api.onMeetingLiveUpdate((snapshot) => {
          if (!opened || epoch !== generation || snapshot?.ok === false) return;
          revision += 1;
          accept(snapshot);
        });
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
      if (typeof unsubscribe === "function") unsubscribe();
      unsubscribe = null;
      if (timer) cancel(timer);
      timer = null;
      pollFlight = null;
      openFlight = null;
    }

    $("liveStart").addEventListener("click", () => {
      if ($("liveStart").disabled) return;
      void action("start", async () => {
        const modelId = selectedModel();
        const transcriptionIntervalSeconds = Number($("liveTranscriptionInterval").value) || 30;
        const saveIntervalSeconds = Number($("liveSaveInterval").value) || 30;
        await invoke("saveSettings", { meetingRealtimeModel: modelId,
          meetingTranscriptionIntervalSeconds: transcriptionIntervalSeconds,
          meetingAutosaveIntervalSeconds: saveIntervalSeconds });
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
      ["liveRecover", "recover", "meetingLiveRecover", () => $("liveRecoverSession").value ? { sessionId: $("liveRecoverSession").value } : undefined],
      ["liveCleanup", "cleanup", "meetingLiveCleanup", () => ({ sessionId: dto.sessionId, modelId: $("liveCleanerModel").value,
        useMimoReview: Boolean($("liveUseMimoReview").checked), reviewModelId: $("liveReviewModel").value })],
      ["liveSummarize", "summarize", "meetingLiveSummarize", () => ({ sessionId: dto.sessionId, modelId: $("liveCleanerModel").value })],
      ["liveOpenMarkdown", "open", "meetingLiveOpenPath", () => ({ path: dto.markdownPath })],
      ["liveOpenReviewed", "open", "meetingLiveOpenPath", () => ({ path: dto.reviewedMarkdownPath })],
      ["liveOpenSummary", "open", "meetingLiveOpenPath", () => ({ path: dto.summaryMarkdownPath })],
      ["liveOpenCleaned", "open", "meetingLiveOpenPath", () => ({ path: cleanedPath() })]
    ]) $(id).addEventListener("click", () => {
      if (!$(id).disabled) void action(name, () => invoke(method, payload()));
    });
    $("livePause").addEventListener("click", () => {
      if (!$("livePause").disabled) void action("pause", () => invoke(dto.paused || dto.status === "paused" ? "meetingLiveResume" : "meetingLivePause"));
    });
    $("liveFloat").addEventListener("click", () => {
      if (!$("liveFloat").disabled) void changeWindow({ floating: true, compact: false });
    });
    $("liveDetail").addEventListener("click", () => {
      if (!$("liveDetail").disabled) void changeWindow({ floating: false, compact: false });
    });
    $("liveCompact").addEventListener("click", () => {
      if (!$("liveCompact").disabled) void changeWindow({ compact: !windowFlags.compact });
    });
    $("liveAlwaysOnTop").addEventListener("change", () => {
      if (!$("liveAlwaysOnTop").disabled) void changeWindow({ alwaysOnTop: $("liveAlwaysOnTop").checked });
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
      if (!supportedModel(selectedModel()) || active(dto)) return;
      void action("model", () => invoke("saveSettings", { meetingRealtimeModel: selectedModel() }));
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
    $("liveRefresh").addEventListener("click", () => { void open(); });
    $("liveMeetingTab").addEventListener("click", () => showHistory(false));
    $("liveHistoryTab").addEventListener("click", () => showHistory(true));
    for (const id of ["liveMeetingTab", "liveHistoryTab"]) $(id).addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const history = event.key === "End" || (event.key !== "Home" && id === "liveMeetingTab");
      showHistory(history, true);
      $(history ? "liveHistoryTab" : "liveMeetingTab").click();
    });
    win.addEventListener("beforeunload", close);
    render();
    return { open, close };
  }

  if (typeof module === "object" && module.exports) module.exports = { createLiveMeetingUi };
  if (root?.document) root.MeetingLiveUi = createLiveMeetingUi(root);
})(typeof window === "undefined" ? null : window);
