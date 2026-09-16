"use strict";

(function installLiveMeetingUi(root) {
  const DEFAULT_MODEL = "mimo-v2.5-asr";
  const STATUS_LABELS = {
    idle: "就绪", starting: "正在启动", recording: "实时转录中", stopping: "停止收尾中",
    completed: "已完成", needs_retry: "有待重试片段", interrupted: "会话已中断", failed: "会话失败"
  };
  const count = (value) => Array.isArray(value) ? value.length : Math.max(0, Number(value) || 0);
  const timestamp = (value) => value == null ? 0 : Number(value) || Date.parse(value) || 0;
  const active = (dto) => Boolean(dto.recording) || ["starting", "recording", "stopping"].includes(dto.status);
  const cleaning = (dto) => ["running", "queued", "processing"].includes(dto.cleanupStatus);

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
    let modelIds = [DEFAULT_MODEL];
    let providers = new Map([[DEFAULT_MODEL, "mimo"]]);
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

    function selectedProvider(model = selectedModel()) {
      return providers.get(model) || (/qwen/i.test(model) ? "qwen3-asr" : "mimo");
    }

    function supportedModel(model) {
      return Boolean(model) && !/fun[-_]?asr|realtime|filetrans/i.test(model);
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
      const models = new Set([DEFAULT_MODEL]);
      providers = new Map([[DEFAULT_MODEL, "mimo"]]);
      for (const map of [settings.meetingFileAsrProfiles, settings.asrProfiles]) {
        for (const [id, profile] of Object.entries(map || {})) {
          const provider = profile?.provider || (id.startsWith("mimo-") ? "mimo" : /qwen/i.test(id) ? "qwen3-asr" : "");
          if (["mimo", "qwen3-asr"].includes(provider) && supportedModel(id)) {
            models.add(id);
            if (!providers.has(id)) providers.set(id, provider);
          }
        }
      }
      const chosen = String(settings.meetingRealtimeModel || DEFAULT_MODEL);
      modelIds = [...models];
      options($("liveModel"), [
        ...modelIds.map((id) => [id, id === DEFAULT_MODEL ? "MiMo V2.5 ASR" : id]),
        ["__custom__", "自定义批量识别模型"]
      ], chosen);
      setModel(active(dto) ? dto.modelId || chosen : chosen);
      const cleaner = String(settings.meetingAnalysisModel || "gpt-5.4-mini");
      const cleaners = [...new Set([cleaner, ...Object.keys(settings.meetingAnalysisProfiles || {})])];
      options($("liveCleanerModel"), cleaners.map((id) => [id, id]), cleaner);
      destination = String(settings.meetingRealtimeDestination || "");
      $("liveCaptureMode").value = settings.meetingCaptureMode === "microphone" ? "microphone" : "dual";
      settingsReady = true;
    }

    async function invoke(method, payload) {
      if (typeof api[method] !== "function") throw new Error("会议实时接口尚未接入，请更新主进程后重试。");
      const result = payload === undefined ? await api[method]() : await api[method](payload);
      if (!result || result.ok === false) throw new Error(result?.error?.message || "操作失败，请重试。");
      return result;
    }

    function accept(snapshot) {
      if (!snapshot || snapshot.ok === false || !STATUS_LABELS[snapshot.status]) return;
      const sameSession = snapshot.sessionId === dto.sessionId;
      if (!sameSession) {
        observedAt = 0;
        observedElapsed = 0;
      }
      if (snapshot.recording || snapshot.status === "recording") {
        if (!observedAt) observedAt = now();
      } else if (observedAt) {
        observedElapsed = now() - observedAt;
        observedAt = 0;
      }
      // Contract updates are complete DTO snapshots. Never carry outputs into a new session.
      dto = snapshot;
      loaded = true;
      if (active(dto) && dto.modelId) setModel(dto.modelId);
      if (active(dto) && dto.captureMode) $("liveCaptureMode").value = dto.captureMode;
      render();
    }

    async function refresh() {
      if (pollFlight) return pollFlight;
      const epoch = generation;
      const atRevision = revision;
      const flight = (async () => {
        try {
          const result = await invoke("meetingLiveStatus");
          if (epoch !== generation || atRevision !== revision) return;
          errorText = "";
          accept(result);
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
      const atRevision = ++revision;
      const epoch = generation;
      render();
      try {
        const result = await task();
        if (atRevision === revision && result?.status) accept(result);
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

    function renderClock() {
      const started = timestamp(dto.startedAtMs || dto.startedAt);
      const elapsed = dto.durationMs != null ? Number(dto.durationMs) : dto.elapsedMs != null ? Number(dto.elapsedMs)
        : started ? (active(dto) ? now() : timestamp(dto.stoppedAtMs || dto.stoppedAt) || started) - started
          : observedAt ? now() - observedAt : observedElapsed;
      const seconds = Math.max(0, Math.floor(elapsed / 1000) || 0);
      $("liveElapsed").textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .slice(seconds >= 3600 ? 0 : 1).map((v) => String(v).padStart(2, "0")).join(":");
      $("liveElapsedLabel").textContent = started || dto.durationMs != null || dto.elapsedMs != null ? "录制时长" : "本页计时";
      const saved = timestamp(dto.lastSavedAt);
      const overdue = dto.recording && ((saved && now() - saved > 45000) || (!saved && observedAt && now() - observedAt > 45000));
      $("liveSaved").dataset.kind = overdue ? "warning" : saved ? "saved" : "idle";
      $("liveSaved").textContent = "每 30 秒自动保存 · " + (saved
        ? `最近保存 ${new Date(saved).toLocaleTimeString("zh-CN", { hour12: false })}` : "尚未保存")
        + (overdue ? " · 保存确认延迟" : "");
      $("liveSaved").title = saved ? new Date(saved).toLocaleString("zh-CN") : "等待后端保存确认";
    }

    function render() {
      const isActive = active(dto);
      const isCleaning = cleaning(dto) || busy.has("cleanup");
      const pending = count(dto.pendingSegments);
      const failed = count(dto.failedSegments);
      const locked = isActive || busy.size > 0 || isCleaning || !settingsReady;
      const can = (method) => typeof api[method] === "function";
      $("liveStart").disabled = !loaded || locked || !can("meetingLiveStart") || !supportedModel(selectedModel())
        || pending > 0 || failed > 0 || dto.finalizationPending || dto.error?.code === "live_save_failed";
      // Stopping remains available during a slow ASR retry or status request.
      const stopFailed = dto.error?.code === "live_stop_failed" && dto.recording;
      $("liveStop").disabled = !dto.recording || (dto.status === "stopping" && !stopFailed) || busy.has("stop") || !can("meetingLiveStop");
      $("liveStart").textContent = busy.has("start") ? "正在开始…" : "开始实时转录";
      $("liveStop").textContent = stopFailed ? "重试停止并保存" : busy.has("stop") || dto.status === "stopping" ? "正在停止并保存…" : "停止并保存";
      for (const id of ["liveTitle", "liveModel", "liveCustomModel", "liveCaptureMode", "liveChooseDestination", "liveDefaultDestination"]) $(id).disabled = locked;
      $("liveChooseDestination").disabled ||= !can("meetingLiveChooseDestination");
      $("liveDefaultDestination").disabled ||= !destination;
      $("liveCustomModelField").hidden = $("liveModel").value !== "__custom__";
      $("liveStatus").textContent = loaded ? STATUS_LABELS[dto.status] : "等待连接";
      if (dto.status === "stopping" && !dto.recording) $("liveStatus").textContent = "录音已停止 · 识别收尾中";
      $("liveStatus").dataset.kind = dto.status;
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
        || (!supportedModel(selectedModel()) && selectedModel() ? "仅支持 MiMo 或 Qwen 批量识别模型，不支持 Fun-ASR、realtime 或 filetrans。" : "");
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
      transcript("liveCorrected", dto.correctedText, "尚无校订文本");
      $("liveCorrectedSection").hidden = !dto.correctedText;
      $("liveResults").classList.toggle("has-corrected", Boolean(dto.correctedText));
      $("liveCleanupSection").hidden = isActive || !dto.sessionId || dto.status === "idle";
      $("liveCleanerModel").disabled = isCleaning || busy.size > 0;
      $("liveCleanup").disabled = locked || pending > 0 || failed > 0 || dto.finalizationPending
        || !dto.rawText || !$("liveCleanerModel").value || !can("meetingLiveCleanup");
      $("liveCleanup").textContent = dto.cleanupStatus === "failed" ? "重试校订" : "校订原文";
      $("liveCleanupStatus").textContent = isCleaning ? `正在校订 ${count(dto.cleanupProgress?.completed)} / ${count(dto.cleanupProgress?.total)} 段`
        : ({ completed: "校订已另存", failed: "校订失败，原文保留" })[dto.cleanupStatus] || "未校订";
      $("liveOpenCleaned").disabled = !cleanedPath() || !can("meetingLiveOpenPath");
      $("liveCleanedPath").textContent = cleanedPath();
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
        await invoke("saveSettings", { meetingRealtimeModel: modelId });
        if (active(dto)) return;
        return invoke("meetingLiveStart", {
          title: $("liveTitle").value.trim(), modelId, provider: selectedProvider(modelId),
          captureMode: $("liveCaptureMode").value,
          ...(destination ? { destinationPath: destination } : {})
        });
      });
    });
    for (const [id, name, method, payload] of [
      ["liveStop", "stop", "meetingLiveStop", () => undefined],
      ["liveRetry", "retry", "meetingLiveRetry", () => ({ sessionId: dto.sessionId })],
      ["liveRecover", "recover", "meetingLiveRecover", () => $("liveRecoverSession").value ? { sessionId: $("liveRecoverSession").value } : undefined],
      ["liveCleanup", "cleanup", "meetingLiveCleanup", () => ({ sessionId: dto.sessionId, modelId: $("liveCleanerModel").value })],
      ["liveOpenMarkdown", "open", "meetingLiveOpenPath", () => ({ path: dto.markdownPath })],
      ["liveOpenCleaned", "open", "meetingLiveOpenPath", () => ({ path: cleanedPath() })]
    ]) $(id).addEventListener("click", () => {
      if (!$(id).disabled) void action(name, () => invoke(method, payload()));
    });
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
    $("liveModel").addEventListener("change", saveModel);
    $("liveCustomModel").addEventListener("change", saveModel);
    $("liveCustomModel").addEventListener("input", render);
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
