"use strict";

/* The file workspace owns its view state; durable summary jobs belong to MAIN.
 * Progress subscriptions survive navigation independently of view polling. */
(function createFileTranscriptionUi() {
  const panel = document.getElementById("filePanel");
  if (!panel) return;

  const ui = window.MeetingUi || {};
  const asrDefaults = window.AsrDefaults;
  const $ = (id) => document.getElementById(id);
  const channels = {
    list: ui.createRequestToken?.() || { next: () => 1, isCurrent: () => true },
    select: ui.createRequestToken?.() || { next: () => 1, isCurrent: () => true },
    poll: ui.createRequestToken?.() || { next: () => 1, isCurrent: () => true },
    import: ui.createRequestToken?.() || { next: () => 1, isCurrent: () => true },
    process: ui.createRequestToken?.() || { next: () => 1, isCurrent: () => true },
    analysis: ui.createRequestToken?.() || { next: () => 1, isCurrent: () => true },
    result: ui.createRequestToken?.() || { next: () => 1, isCurrent: () => true }
  };

  const state = {
    sessions: [],
    selectedId: null,
    process: null,
    analysis: null,
    resultTab: "raw",
    rawDoc: null,
    rawRevision: null,
    summaryDoc: null,
    summaryJob: null,
    summaryPath: "",
    summaryModel: "",
    setupCollapsedOnBusy: false,
    importBusy: false,
    importSessionId: null,
    pollTimer: null,
    settings: {}
  };
  let openPromise = null;
  let summaryRevision = 0;
  let unsubscribeSummary = null;
  const sidebarPreferenceKey = "ovi-file-sidebars";

  function syncSidebars() {
    const details = $("fileSetupDetails");
    const history = $("fileHistorySidebar");
    if (!details || !history) return;
    if (window.innerWidth <= 900 && details.open) history.hidden = true;
    $("fileSetupToggle")?.setAttribute("aria-expanded", String(details.open));
    $("fileHistoryToggle")?.setAttribute("aria-expanded", String(!history.hidden));
    const backdrop = $("fileSidebarBackdrop");
    if (backdrop) backdrop.hidden = window.innerWidth > 900 || (!details.open && history.hidden);
  }

  function saveSidebars() {
    try {
      window.localStorage.setItem(sidebarPreferenceKey, JSON.stringify({
        setup: Boolean($("fileSetupDetails")?.open), history: !$("fileHistorySidebar")?.hidden
      }));
    } catch { /* Optional local view preference. */ }
  }

  function setSidebar(kind, open, focus = false) {
    const details = $("fileSetupDetails");
    const history = $("fileHistorySidebar");
    if (!details || !history) return;
    if (kind === "setup") {
      details.open = open;
      if (open && window.innerWidth <= 900) history.hidden = true;
    } else {
      history.hidden = !open;
      if (open && window.innerWidth <= 900) details.open = false;
    }
    syncSidebars(); saveSidebars();
    if (focus) {
      let target = kind === "setup" ? "fileSetupToggle" : "fileHistoryToggle";
      if (open) target = kind === "setup" ? "fileAsrProviderSelect" : "fileSessionSearch";
      $(target)?.focus?.();
    }
  }

  function restoreSidebars() {
    const details = $("fileSetupDetails");
    const history = $("fileHistorySidebar");
    if (!details || !history) return;
    let preference;
    try { preference = JSON.parse(window.localStorage.getItem(sidebarPreferenceKey)); } catch { /* Defaults also work without storage. */ }
    details.open = typeof preference?.setup === "boolean" ? preference.setup : true;
    history.hidden = preference?.history !== true;
    if (window.innerWidth <= 900 && !history.hidden) details.open = false;
    syncSidebars();
  }

  const FILE_ASR_MODELS = [
    { provider: "mimo", value: "mimo-v2.5-asr", label: "MiMo V2.5 ASR" },
    { provider: "qwen3-asr", value: "qwen3-asr-flash", label: "Qwen3-ASR Flash" },
    { provider: "qwen3-asr", value: "qwen3-asr-flash-filetrans", label: "Qwen3-ASR Flash FileTrans" }
  ];

  function els() {
    return {
      list: $("fileSessionList"),
      search: $("fileSessionSearch"),
      title: $("fileTitleInput"),
      name: $("fileSelectedName"),
      meta: $("fileSelectedMeta"),
      importStatus: $("fileImportStatus"),
      model: $("fileAsrModelLabel"),
      providerSelect: $("fileAsrProviderSelect"),
      modelSelect: $("fileAsrModelSelect"),
      customModel: $("fileAsrCustomModelInput"),
      configStatus: $("fileAsrConfigStatus"),
      hint: $("fileHint"),
      processLabel: $("fileProcessLabel"),
      processProgress: $("fileProcessProgress"),
      processStart: $("fileProcessStartBtn"),
      processRetry: $("fileProcessRetryBtn"),
      processCancel: $("fileProcessCancelBtn"),
      analysisLabel: $("fileAnalysisLabel"),
      mimoReview: $("fileAnalysisMimoReview"),
      summaryModelSelect: $("fileSummaryModelSelect"),
      analysisStart: $("fileAnalysisStartBtn"),
      analysisRetry: $("fileAnalysisRetryBtn"),
      analysisCancel: $("fileAnalysisCancelBtn"),
      resultEmpty: $("fileResultEmpty"),
      resultContent: $("fileResultContent"),
      exportFormat: $("fileExportFormatSelect"),
      exportScope: $("fileExportScopeSelect"),
      export: $("fileExportBtn"),
      setupDetails: $("fileSetupDetails"),
      setupSummaryMeta: $("fileSetupSummaryMeta")
    };
  }

  function currentFileAsrModel() {
    const e = els();
    if (e.modelSelect?.value === asrDefaults.FOLLOW_DICTATION) return asrDefaults.dictationSelection(state.settings, "file").modelId;
    return e.modelSelect?.value === "__custom__"
      ? String(e.customModel?.value || "").trim()
      : String(e.modelSelect?.value || asrDefaults.workspaceSelection(state.settings, "file").modelId).trim();
  }

  function currentFileAsrProvider(model = currentFileAsrModel()) {
    const e = els();
    if (e.providerSelect?.value === asrDefaults.FOLLOW_DICTATION) return asrDefaults.dictationSelection(state.settings, "file").provider;
    const selected = String(e.providerSelect?.value || asrDefaults.workspaceSelection(state.settings, "file").provider).trim();
    if (selected) return selected;
    return FILE_ASR_MODELS.find((item) => item.value === model)?.provider || "mimo";
  }

  function renderFileAsrSelector() {
    const e = els();
    if (!e.providerSelect || !e.modelSelect) return;
    const { provider, modelId: model, followsDictation } = asrDefaults.workspaceSelection(state.settings, "file");
    const dictation = asrDefaults.dictationSelection(state.settings, "file");
    for (const select of [e.providerSelect, e.modelSelect]) {
      const option = [...select.options].find(item => item.value === asrDefaults.FOLLOW_DICTATION);
      if (option) option.textContent = `跟随语音输入法 · ${select === e.providerSelect ? dictation.provider : dictation.modelId}`;
    }
    e.providerSelect.value = followsDictation ? asrDefaults.FOLLOW_DICTATION : provider === "mimo" ? "mimo" : "qwen3-asr";
    const preset = followsDictation ? asrDefaults.FOLLOW_DICTATION : FILE_ASR_MODELS.some((item) => item.value === model) ? model : "__custom__";
    e.modelSelect.value = preset;
    if (e.customModel) {
      e.customModel.hidden = preset !== "__custom__";
      e.customModel.value = preset === "__custom__" ? model : "";
    }
    const readiness = asrDefaults.workspaceReadiness(state.settings, "file");
    if (e.configStatus) {
      e.configStatus.textContent = [`${provider} / ${model}`, readiness.message].filter(Boolean).join(" · ");
      e.configStatus.dataset.ready = String(readiness.ready);
    }
  }

  function expandUnconfiguredSetup() {
    if (!asrDefaults.workspaceReadiness(state.settings, "file").ready) setSidebar("setup", true);
  }

  async function saveFileAsrSelection() {
    const model = currentFileAsrModel();
    if (!model) throw new Error("请填写文件 ASR 模型 ID。");
    const provider = currentFileAsrProvider(model);
    const followsDictation = els().modelSelect?.value === asrDefaults.FOLLOW_DICTATION;
    state.settings = (await window.mimoInput.saveSettings({
      meetingFileAsrFollowDictation: followsDictation,
      meetingFileAsrProvider: provider,
      meetingFileAsrModel: model
    })) || { ...state.settings, meetingFileAsrFollowDictation: followsDictation, meetingFileAsrProvider: provider, meetingFileAsrModel: model };
    renderFileAsrSelector();
    expandUnconfiguredSetup();
    renderSelected();
    setHint(`文件 ASR 已切换为 ${provider} / ${model}。`);
    return { provider, model };
  }

  function currentRow() {
    return state.sessions.find((row) => row.id === state.selectedId) || null;
  }

  function accept(channel, token, sessionId = null) {
    if (ui.acceptChannelUpdate) {
      return ui.acceptChannelUpdate(channel, token, state.selectedId, sessionId);
    }
    return channel?.isCurrent?.(token) && (!sessionId || sessionId === state.selectedId);
  }

  function setHint(text, kind = "info") {
    const el = els().hint;
    if (el) {
      el.textContent = String(text || "");
      el.dataset.kind = kind;
      el.setAttribute("aria-busy", String(kind === "processing"));
    }
  }

  function setPill(el, kind, text) {
    if (!el) return;
    el.dataset.kind = kind || "idle";
    el.textContent = text || "";
  }

  function isRunningProcess(stage) {
    return ui.isProcessRunningStage?.(stage) || [
      "exporting",
      "preparing",
      "uploading",
      "transcribing",
      "merging",
      "cancelling"
    ].includes(String(stage || ""));
  }

  function isRunningAnalysis(status) {
    return status === "running" || status === "cancelling";
  }

  function acceptSummaryJob(job) {
    if (!job || job.sessionId !== state.selectedId) return false;
    summaryRevision += 1;
    state.summaryJob = job;
    state.summaryPath = job.summaryMarkdownPath || "";
    if (job.summary) state.summaryDoc = job.summary;
    return true;
  }

  function hasArchive(row) {
    return Boolean(
      row?.hasArchive ||
        (Array.isArray(row?.archiveTracks) && row.archiveTracks.length > 0)
    );
  }

  function resetResultView(message = "选择文件并开始转写后，结果会显示在这里。") {
    const { resultEmpty, resultContent } = els();
    if (resultEmpty) {
      resultEmpty.hidden = false;
      resultEmpty.textContent = message;
    }
    if (resultContent) {
      resultContent.hidden = true;
      while (resultContent.firstChild) resultContent.removeChild(resultContent.firstChild);
    }
  }

  function clearSelection() {
    state.selectedId = null;
    state.process = null;
    state.summaryJob = null;
    state.summaryPath = "";
    state.rawDoc = null;
    state.summaryDoc = null;
    state.importSessionId = null;
    state.importBusy = false;
    const e = els();
    if (e.name) e.name.textContent = "还没有选择文件";
    if (e.meta) e.meta.textContent = "支持音频和视频；视频会先提取音轨。";
    if (e.model) e.model.textContent = "当前 ASR：—";
    setPill(e.importStatus, "idle", "未选择");
    resetResultView();
    renderControls();
  }

  function renderList() {
    const e = els();
    if (!e.list) return;
    const query = String(e.search?.value || "").trim().toLowerCase();
    const rows = state.sessions.filter((row) => {
      if (!query) return true;
      return [row.title, row.id, row.createdAt, row.updatedAt, row.importMeta?.sourceFileName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
    while (e.list.firstChild) e.list.removeChild(e.list.firstChild);
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "file-empty";
      empty.textContent = state.sessions.length ? "没有匹配的文件" : "还没有文件记录";
      e.list.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-session-row";
      button.dataset.sessionId = row.id;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(row.id === state.selectedId));
      if (row.id === state.selectedId) button.classList.add("is-selected");
      const title = document.createElement("strong");
      title.textContent = row.title || row.importMeta?.sourceFileName || "未命名文件";
      const meta = document.createElement("span");
      const process = row.processing?.stage
        ? ui.processStageLabel?.(row.processing.stage, row.processing) || row.processing.stage
        : "未转写";
      meta.textContent = [process, row.updatedAt || row.createdAt || ""].filter(Boolean).join(" · ");
      button.appendChild(title);
      button.appendChild(meta);
      button.addEventListener("click", () => selectSession(row.id).then(() => {
        if (window.innerWidth <= 900) setSidebar("history", false, true);
      }).catch((error) => setHint(error.message, "error")));
      e.list.appendChild(button);
    }
  }

  function renderSummaryModelOptions() {
    const e = els();
    if (!e.summaryModelSelect) return;
    const picker = window.TextSupplierUi;
    const { groups, selected: configured } = picker.modelOptionGroups(state.settings, "summary");
    const selected = state.summaryModel || picker.formatPair(configured.supplierId, configured.modelId);
    const available = new Set();
    e.summaryModelSelect.replaceChildren();
    for (const group of groups) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const modelId of group.models) {
        const value = picker.formatPair(group.supplierId, modelId);
        const option = document.createElement("option");
        option.value = value;
        option.textContent = modelId;
        optgroup.appendChild(option);
        available.add(value);
      }
      if (optgroup.children.length) e.summaryModelSelect.appendChild(optgroup);
    }
    if (selected && !available.has(selected)) {
      const pair = picker.parsePair(selected);
      if (pair.modelId) {
        const option = document.createElement("option");
        option.value = selected;
        option.textContent = `${pair.supplierId || "已有连接"} / ${pair.modelId}（手动配置）`;
        e.summaryModelSelect.appendChild(option);
      }
    }
    e.summaryModelSelect.value = selected && [...e.summaryModelSelect.options].some(option => option.value === selected)
      ? selected : e.summaryModelSelect.options[0]?.value || "";
    state.summaryModel = e.summaryModelSelect.value;
  }

  function renderSetupSummary() {
    const e = els();
    if (!e.setupSummaryMeta) return;
    const row = currentRow();
    const model = asrDefaults.workspaceSelection(state.settings, "file").modelId;
    e.setupSummaryMeta.textContent = row ? `${row.title || row.id} · ${model}` : `未选择文件 · ${model}`;
  }

  function renderSelected() {
    const row = currentRow();
    const e = els();
    renderSetupSummary();
    if (!row) {
      clearSelection();
      return;
    }
    const fileName = row.importMeta?.sourceFileName || row.title || row.id;
    if (e.name) e.name.title = e.name.textContent = row.title || fileName;
    if (e.meta) {
      const kind = row.importMeta?.mediaKind || "音频";
      const status = row.status === "importing" ? "正在导入" : row.status === "stopped" ? "已导入" : row.status || "待处理";
      e.meta.textContent = `${fileName} · ${kind} · ${status}`;
      e.meta.title = e.meta.textContent;
    }
    const { provider, modelId: model } = asrDefaults.workspaceSelection(state.settings, "file");
    if (e.model) e.model.textContent = `当前 ASR：${provider} / ${model}`;
    renderFileAsrSelector();
    renderList();
  }

  function renderControls() {
    const row = currentRow();
    const proc = state.process?.stage || "idle";
    const ana = state.summaryJob?.status || "none";
    const imported = Boolean(row && hasArchive(row));
    const processRunning = isRunningProcess(proc);
    const analysisRunning = isRunningAnalysis(ana);
    const canStart = Boolean(row && imported && !state.importBusy && !processRunning && !analysisRunning && proc !== "completed");
    const canRetry = Boolean(row && imported && !state.importBusy && !processRunning && !analysisRunning && (proc === "failed" || proc === "cancelled"));
    const canCancel = Boolean(row && processRunning);
    const canAnalyze = Boolean(
      row && proc === "completed" && !analysisRunning && !processRunning && !state.importBusy &&
      ["none", "idle", "completed"].includes(ana)
    );
    const canRetryAnalysis = Boolean(row && proc === "completed" && !analysisRunning &&
      ["failed", "cancelled", "needs_retry"].includes(ana));
    const canCancelAnalysis = Boolean(row && analysisRunning);
    const e = els();
    const busyNow = processRunning || analysisRunning || Boolean(state.importBusy);
    if (e.setupDetails) {
      // Collapse setup once when processing starts so results keep the space.
      if (busyNow && !state.setupCollapsedOnBusy) {
        setSidebar("setup", false);
        state.setupCollapsedOnBusy = true;
      }
      if (!busyNow) state.setupCollapsedOnBusy = false;
    }
    if (e.processStart) {
      e.processStart.disabled = !canStart;
      e.processStart.hidden = proc === "completed" || processRunning || canRetry;
    }
    if (e.processRetry) {
      e.processRetry.disabled = !canRetry;
      e.processRetry.hidden = !canRetry;
    }
    if (e.processCancel) {
      e.processCancel.disabled = !canCancel;
      e.processCancel.hidden = !canCancel;
    }
    if (e.analysisStart) {
      e.analysisStart.disabled = !canAnalyze;
      e.analysisStart.hidden = analysisRunning || canRetryAnalysis;
      e.analysisStart.textContent = ana === "completed" ? "重新生成摘要" : "生成摘要";
    }
    if (e.analysisRetry) {
      e.analysisRetry.disabled = !canRetryAnalysis;
      e.analysisRetry.hidden = !canRetryAnalysis;
    }
    if (e.analysisCancel) {
      e.analysisCancel.disabled = !canCancelAnalysis;
      e.analysisCancel.hidden = !canCancelAnalysis;
    }
    const processLabel = proc === "completed" ? "已完成"
      : ui.processStageLabel?.(proc, state.process) || (proc === "idle" ? "尚未开始" : proc);
    const processKind = proc === "completed" ? "ok" : proc === "failed" ? "error" : processRunning ? "processing" : "idle";
    setPill(e.importStatus, state.importBusy ? "processing" : row ? (hasArchive(row) ? "ok" : "warn") : "idle", state.importBusy ? "导入中" : row ? (hasArchive(row) ? "已导入" : "待导入") : "未选择");
    if (e.processLabel) e.processLabel.textContent = processLabel;
    if (e.processProgress) {
      const progress = ui.processProgressText?.(state.process) || "";
      e.processProgress.textContent = progress;
      e.processProgress.hidden = !progress || progress === "—";
    }
    let analysisLabel = ana === "running" ? ui.summaryProgressText?.(state.summaryJob?.progress) || "正在生成摘要…"
      : ana === "cancelling" ? "正在取消…"
      : ana === "completed" ? (state.summaryJob?.legacy ? "历史摘要（只读）" : "已生成")
      : ana === "failed" ? "摘要失败，原文保留"
      : ana === "needs_retry" ? "摘要未完成，可重试"
      : ana === "cancelled" ? "摘要已取消"
      : proc === "completed" ? "未生成" : "待转写完成";
    const reason = ui.summaryErrorText?.(state.summaryJob?.error?.code);
    if (reason && ["failed", "needs_retry"].includes(ana)) analysisLabel += ` · ${reason}`;
    if (e.analysisLabel) e.analysisLabel.textContent = analysisLabel;
    if (e.processLabel) e.processLabel.dataset.kind = processKind;
    if (e.analysisLabel) e.analysisLabel.dataset.kind = ana === "completed" ? "ok"
      : ["failed", "needs_retry", "cancelled"].includes(ana) ? "error"
      : isRunningAnalysis(ana) ? "processing" : "idle";
  }

  async function loadSettings() {
    try {
      state.settings = (await window.mimoInput.getSettings?.()) || {};
    } catch {
      state.settings = {};
    }
    renderSummaryModelOptions();
    renderFileAsrSelector();
    expandUnconfiguredSetup();
    renderSelected();
  }

  async function refreshSessions() {
    const token = channels.list.next();
    const res = await window.mimoInput.meetingListSessions({ source: "import" });
    if (!accept(channels.list, token)) return;
    if (!res?.ok) throw new Error(res?.error?.message || "文件列表加载失败");
    state.sessions = (res.sessions || [])
      .filter((row) => row.source === "import" || row.importMeta)
      .map((row) => ({
        ...row,
        title: ui.sanitizeSessionTitle?.(row.title) || row.title || row.id
      }));
    if (state.selectedId && !state.sessions.some((row) => row.id === state.selectedId)) {
      clearSelection();
    }
    renderList();
    renderSelected();
    renderControls();
  }

  async function selectSession(sessionId) {
    if (!sessionId) return;
    stopPolling();
    channels.poll.next();
    channels.result.next();
    channels.analysis.next();
    sessionId = String(sessionId);
    state.selectedId = sessionId;
    const atSummaryRevision = ++summaryRevision;
    state.process = null;
    state.summaryJob = null;
    state.summaryPath = "";
    state.rawDoc = null;
    state.summaryDoc = null;
    resetResultView();
    renderSelected();
    renderControls();
    const token = channels.select.next();
    const [scan, process, job] = await Promise.all([
      window.mimoInput.meetingScanSession(sessionId),
      window.mimoInput.meetingProcessStatus({ sessionId }),
      typeof window.mimoInput.meetingFileSummaryStatus === "function"
        ? window.mimoInput.meetingFileSummaryStatus({ sessionId })
        : Promise.resolve(null)
    ]);
    if (!accept(channels.select, token, sessionId)) return;
    const row = currentRow();
    if (row && scan?.ok) {
      row.status = scan.session?.status || row.status;
      row.hasArchive = Boolean(row.hasArchive || scan.session?.tracks?.microphone || scan.session?.tracks?.system);
    }
    state.process = process?.ok ? process.processing : null;
    if (atSummaryRevision === summaryRevision && job?.ok) acceptSummaryJob(job.summary);
    renderSelected();
    renderControls();
    if (state.process?.stage === "completed" || row?.hasRaw || state.process?.transcription?.segmentCompleted > 0) {
      await loadResult(state.resultTab, { expectedSessionId: state.selectedId });
    } else {
      resetResultView("文件已导入，开始转写后结果会显示在这里。");
    }
    // History readback: durable summary status plus legacy summaries stay visible.
    loadSummaryResults(state.selectedId)
      .then(() => {
        renderControls();
        if (state.resultTab !== "raw") {
          return loadResult(state.resultTab, { expectedSessionId: state.selectedId });
        }
        return null;
      })
      .catch((error) => setHint(error.message || "摘要读取失败，请重试。", "error"));
    if (state.selectedId) ensurePolling();
  }

  async function importFile() {
    if (state.importBusy) return;
    state.importBusy = true;
    renderControls();
    setHint("选择音频或视频文件…", "processing");
    try {
      const titleInput = els().title;
      const title = titleInput?.value?.trim() || "";
      const api = window.mimoInput.fileImportMedia || window.mimoInput.meetingImportMedia;
      const res = await api({ title, track: "microphone", role: "self" });
      if (res?.cancelled) {
        setHint("已取消选择文件");
        return;
      }
      if (!res?.ok) throw new Error(res?.error?.message || "导入启动失败");
      // Consume only this import's draft, preserving edits made while choosing a file.
      if (titleInput && titleInput.value.trim() === title) titleInput.value = "";
      await refreshSessions();
      if (res.sessionId) {
        state.selectedId = res.sessionId;
        await refreshSessions();
        await selectSession(res.sessionId);
        if (res.status === "importing") await pollImport(res.sessionId);
      }
    } finally {
      state.importBusy = false;
      renderControls();
    }
  }

  async function pollImport(sessionId) {
    state.importBusy = true;
    state.importSessionId = sessionId;
    const token = channels.import.next();
    renderControls();
    try {
      for (let i = 0; i < 54000; i += 1) {
        const api = window.mimoInput.fileImportStatus || window.mimoInput.meetingImportStatus;
        const res = await api({ sessionId });
        if (!accept(channels.import, token, sessionId)) return;
        const status = res?.status || "";
        if (status === "stopped") {
          await refreshSessions();
          if (state.selectedId === sessionId) await selectSession(sessionId);
          setHint("文件已导入，可以开始转写。", "success");
          return;
        }
        if (["import_failed", "import_cancelled", "import_interrupted"].includes(status)) {
          await refreshSessions();
          if (state.selectedId === sessionId) renderSelected();
          setHint(res?.import?.message || (status === "import_cancelled" ? "文件导入已取消。" : "文件导入失败，请重试。"),
            status === "import_cancelled" ? "warning" : "error");
          return;
        }
        if (i % 2 === 0) {
          const phase = res?.phase || res?.import?.phase || "running";
          const phaseLabel = phase === "extract" ? "抽取音轨" : phase === "commit" ? "保存文件" : "导入中";
          const progress = res?.progress?.total > 0
            ? ` ${Math.min(100, Math.round((100 * (res.progress.bytes || 0)) / res.progress.total))}%`
            : "";
          setHint(`${phaseLabel}${progress}…`, "processing");
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      setHint("文件导入超时，请刷新列表后重试。", "error");
    } finally {
      if (state.importSessionId === sessionId) state.importSessionId = null;
      state.importBusy = false;
      renderControls();
    }
  }

  async function cancelImport() {
    const sessionId = state.importSessionId;
    if (!sessionId) return;
    const api = window.mimoInput.fileImportCancel || window.mimoInput.meetingImportCancel;
    const res = await api({ sessionId });
    setHint(res?.cancelled ? "正在取消文件导入…" : "当前没有正在导入的文件。", res?.cancelled ? "processing" : "info");
  }

  async function processStart({ retry = false } = {}) {
    const sessionId = state.selectedId;
    if (!sessionId) return;
    const token = channels.process.next();
    state.process = { ...(state.process || {}), stage: "exporting", status: "running", processMode: "file", mode: "file", optimistic: true };
    state.rawDoc = null;
    state.summaryDoc = null;
    state.summaryJob = null;
    state.summaryPath = "";
    renderControls();
    ensurePolling();
    try {
      await saveFileAsrSelection();
      const api = retry ? window.mimoInput.meetingProcessRetry : window.mimoInput.meetingProcessStart;
      const res = await api({ sessionId, mode: "file", processMode: "file", ...(retry ? { resetAttempts: true } : {}) });
      if (!accept(channels.process, token, sessionId)) return;
      if (!res?.ok) throw new Error(res?.error?.message || "文件转写失败");
      state.process = res.processing || res.process || state.process;
      renderControls();
      await loadResult("raw", { expectedSessionId: sessionId });
      ensurePolling();
    } catch (error) {
      state.process = { stage: "failed", status: "failed", lastError: { message: error.message || String(error) } };
      renderControls();
      setHint(error.message || String(error), "error");
      throw error;
    }
  }

  async function processCancel() {
    if (!state.selectedId) return;
    const res = await window.mimoInput.meetingProcessCancel({ sessionId: state.selectedId });
    if (!res?.ok) throw new Error(res?.error?.message || "取消转写失败");
    state.process = res.processing;
    renderControls();
  }

  async function summaryStart({ retry = false } = {}) {
    const sessionId = state.selectedId;
    if (!sessionId) return;
    const token = channels.analysis.next();
    const atSummaryRevision = ++summaryRevision;
    state.summaryJob = { sessionId, status: "running" };
    state.summaryDoc = null;
    state.summaryPath = "";
    if (state.resultTab !== "raw") {
      resetResultView(retry ? "正在重试摘要…" : "正在生成摘要…");
    }
    renderControls();
    ensurePolling();
    try {
      const api = retry ? window.mimoInput.meetingFileSummaryRetry : window.mimoInput.meetingFileSummaryStart;
      const selected = window.TextSupplierUi.parsePair(state.summaryModel || els().summaryModelSelect?.value || "");
      const res = await api({
        sessionId,
        supplierId: selected.supplierId || window.TextSupplierUi.LEGACY_SUPPLIER_ID,
        modelId: selected.modelId,
        useMimoReview: Boolean(els().mimoReview?.checked)
      });
      if (!accept(channels.analysis, token, sessionId) || atSummaryRevision !== summaryRevision) return;
      if (!res?.ok) throw new Error(res?.error?.message || "摘要生成失败");
      acceptSummaryJob(res.summary || { sessionId, status: "running" });
      renderControls();
      if (state.summaryJob.status !== "running" && state.summaryJob.summary) {
        await loadResult("summary", { expectedSessionId: sessionId });
        setHint("摘要已完成。", "success");
      } else if (state.summaryJob.status !== "running") {
        setHint("摘要未完成，可重试。", "warning");
      }
      ensurePolling();
    } catch (error) {
      if (!accept(channels.analysis, token, sessionId) || atSummaryRevision !== summaryRevision) return;
      acceptSummaryJob({ sessionId, status: "failed" });
      renderControls();
      setHint(error.message || String(error), "error");
      throw error;
    }
  }

  async function summaryCancel() {
    if (!state.selectedId) return;
    const sessionId = state.selectedId;
    const res = await window.mimoInput.meetingFileSummaryCancel({ sessionId });
    if (sessionId !== state.selectedId) return;
    if (!res?.ok) throw new Error(res?.error?.message || "取消摘要失败");
    acceptSummaryJob(res.summary || { sessionId, status: "cancelled" });
    renderControls();
  }

  function rawRevision() {
    const t = state.process?.transcription || {};
    return [state.process?.stage, t.jobGeneration, t.segmentCompleted, t.segmentTotal].join(":");
  }

  async function loadResult(tab, { expectedSessionId = null, refreshRaw = false } = {}) {
    if (!state.selectedId || (expectedSessionId && expectedSessionId !== state.selectedId)) return;
    state.resultTab = tab === "summary" ? "summary" : "raw";
    for (const button of panel.querySelectorAll("[data-file-tab]")) {
      const active = button.dataset.fileTab === state.resultTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    const sessionId = state.selectedId;
    const token = channels.result.next();
    const e = els();
    const scroll = $("fileResultPane")?.scrollTop || 0;
    if (!refreshRaw) {
      if (e.resultEmpty) e.resultEmpty.hidden = false;
      if (e.resultContent) e.resultContent.hidden = true;
    }
    try {
      if (state.resultTab === "raw") {
        if (!state.rawDoc || refreshRaw || state.rawRevision !== rawRevision()) {
          const revision = rawRevision();
          const res = await window.mimoInput.meetingTranscriptGet({ sessionId });
          if (!accept(channels.result, token, sessionId) || state.selectedId !== sessionId) return;
          state.rawDoc = res?.ok ? res.transcript : null;
          state.rawRevision = revision;
        }
        if (!accept(channels.result, token, sessionId)) return;
        const blocks = ui.formatTranscriptBlocks?.(state.rawDoc) || [];
        if (e.resultEmpty) {
          e.resultEmpty.hidden = blocks.length > 0;
          if (!blocks.length) e.resultEmpty.textContent = "暂无原始转写。";
        }
        if (e.resultContent) {
          e.resultContent.hidden = blocks.length === 0;
          ui.appendTranscriptBlocks?.(e.resultContent, blocks);
        }
        if (refreshRaw && $("fileResultPane")) $("fileResultPane").scrollTop = scroll;
      } else {
        if (!state.summaryDoc) await loadSummaryResults(sessionId);
        if (!accept(channels.result, token, sessionId) || state.selectedId !== sessionId) return;
        const summary = state.summaryDoc;
        const empty = !summary || (!summary.markdown && ui.flattenSummarySections?.(summary).length === 0
          && !(Array.isArray(summary.sections) && summary.sections.length));
        if (e.resultEmpty) {
          e.resultEmpty.hidden = !empty;
          if (empty) e.resultEmpty.textContent = "暂无摘要。点击“生成摘要”创建。";
        }
        if (e.resultContent) {
          e.resultContent.hidden = empty;
          if (!empty) ui.renderSummaryDocument?.(e.resultContent, summary);
        }
      }
    } catch (error) {
      if (!accept(channels.result, token, sessionId)) return;
      resetResultView(error.message || "结果加载失败");
    }
  }

  async function loadSummaryResults(sessionId) {
    if (!sessionId || sessionId !== state.selectedId) return;
    const atSummaryRevision = summaryRevision;
    // Durable readback of the shared summary engine (including history sessions).
    if (typeof window.mimoInput.meetingFileSummaryStatus === "function") {
      const res = await window.mimoInput.meetingFileSummaryStatus({ sessionId });
      if (sessionId !== state.selectedId || atSummaryRevision !== summaryRevision) return;
      if (res?.ok && res.summary) {
        acceptSummaryJob(res.summary);
        if (res.summary.summary) {
          state.summaryDoc = res.summary.summary;
          return;
        }
      }
    }
    if (["running", "completed", "needs_retry", "failed", "cancelled"].includes(state.summaryJob?.status)
      && !state.summaryJob?.legacy) return;
    // Legacy histories stay read-only: old analysis summaries still render.
    const atLegacyRevision = summaryRevision;
    const legacy = await window.mimoInput.meetingAnalysisSummary?.({ sessionId });
    if (sessionId !== state.selectedId || atLegacyRevision !== summaryRevision) return;
    if (legacy?.ok && legacy.summary) {
      state.summaryDoc = legacy.summary;
      state.summaryJob = { status: "completed", legacy: true };
      state.summaryPath = "";
    }
  }

  async function refreshLive() {
    if (!state.selectedId || document.body.classList.contains("file-mode") === false) return;
    const sessionId = state.selectedId;
    const token = channels.poll.next();
    const atSummaryRevision = summaryRevision;
    const [process, job] = await Promise.all([
      window.mimoInput.meetingProcessStatus({ sessionId }),
      typeof window.mimoInput.meetingFileSummaryStatus === "function"
        ? window.mimoInput.meetingFileSummaryStatus({ sessionId })
        : Promise.resolve(null)
    ]);
    if (!accept(channels.poll, token, sessionId)) return;
    if (process?.ok) state.process = process.processing;
    if (atSummaryRevision === summaryRevision && job?.ok) acceptSummaryJob(job.summary);
    renderControls();
    if (state.resultTab === "raw" && (state.process?.transcription?.segmentCompleted > 0 || state.process?.stage === "completed")
      && (!state.rawDoc || state.rawRevision !== rawRevision())) {
      await loadResult("raw", { expectedSessionId: sessionId, refreshRaw: true });
    }
    if (state.summaryJob?.summary && state.resultTab !== "raw") {
      await loadResult(state.resultTab, { expectedSessionId: sessionId });
    }
    const doneProcess = ["completed", "failed", "cancelled", "idle"].includes(state.process?.stage);
    const doneAnalysis = ["completed", "failed", "cancelled", "none", "idle", "needs_retry"].includes(
      state.summaryJob?.status || "none"
    );
    if (doneProcess && doneAnalysis) stopPolling();
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function ensurePolling() {
    stopPolling();
    if (!state.selectedId || !document.body.classList.contains("file-mode")) return;
    const processBusy = isRunningProcess(state.process?.stage);
    const analysisBusy = isRunningAnalysis(state.summaryJob?.status);
    if (!processBusy && !analysisBusy) return;
    state.pollTimer = setInterval(() => refreshLive().catch(() => {}), 1200);
  }

  function copyCurrent() {
    let text = "";
    if (state.resultTab === "summary") {
      text = ui.summaryToPlainText?.(state.summaryDoc) || "";
      if (!text) {
        const sections = ui.flattenSummarySections?.(state.summaryDoc) || [];
        text = sections.map((section) => `${section.title}\n${section.lines.map((line) => `· ${line}`).join("\n")}`).join("\n\n");
      }
    } else {
      const blocks = ui.formatTranscriptBlocks?.(state.rawDoc) || [];
      text = blocks.map((block) => block.text).filter(Boolean).join("\n\n");
    }
    if (text) window.mimoInput.copyText(text);
  }

  async function exportCurrent() {
    const sessionId = state.selectedId;
    if (!sessionId) return;
    const e = els();
    const res = await window.mimoInput.fileExportSave({
      sessionId,
      format: e.exportFormat?.value || "markdown",
      scope: e.exportScope?.value || "all"
    });
    if (res?.cancelled) return;
    if (!res?.ok) throw new Error(res?.error?.message || "导出失败");
    setHint(`已导出 ${res.files?.join("、") || "文件结果"}。`, "success");
  }

  async function openWorkspace({ fromModeEvent = false, sessionId = null } = {}) {
    if (openPromise) return openPromise;
    openPromise = (async () => {
      if (!fromModeEvent) await window.mimoInput.openFileWorkspace?.();
      if (typeof window.applyWindowMode === "function") window.applyWindowMode("file");
      panel.hidden = false;
      await loadSettings();
      await refreshSessions();
      if (sessionId && state.sessions.some(row => row.id === sessionId)) state.selectedId = sessionId;
      if (!state.selectedId && state.sessions.length) {
        state.selectedId = state.sessions[0].id;
      }
      if (state.selectedId) await selectSession(state.selectedId);
      setHint(state.selectedId ? "文件转写记录已加载。" : "选择一个音频或视频文件开始处理。");
      ensurePolling();
    })();
    try {
      return await openPromise;
    } finally {
      openPromise = null;
    }
  }

  function bind() {
    restoreSidebars();
    $("fileHistoryToggle")?.addEventListener("click", () => setSidebar("history", Boolean($("fileHistorySidebar")?.hidden), true));
    $("fileSetupToggle")?.addEventListener("click", () => setSidebar("setup", !$("fileSetupDetails")?.open, true));
    $("fileHistoryClose")?.addEventListener("click", () => setSidebar("history", false, true));
    $("fileSetupClose")?.addEventListener("click", event => {
      event.preventDefault(); setSidebar("setup", false, true);
    });
    $("fileSetupDetails")?.addEventListener("toggle", () => {
      syncSidebars(); saveSidebars();
      if (!$("fileSetupDetails").open && $("fileSetupSidebar")?.contains?.(document.activeElement)) $("fileSetupToggle")?.focus?.();
    });
    const closeSidebars = () => { setSidebar("setup", false); setSidebar("history", false); $("fileSetupToggle")?.focus?.(); };
    $("fileSidebarBackdrop")?.addEventListener("click", closeSidebars);
    window.addEventListener("resize", () => {
      if (document.body.classList.contains("file-mode")) syncSidebars();
    });
    window.addEventListener("keydown", event => {
      if (event.key === "Escape" && document.body.classList.contains("file-mode") && $("fileSidebarBackdrop")?.hidden === false) {
        event.preventDefault(); closeSidebars();
      }
    });
    unsubscribeSummary = window.mimoInput.onMeetingFileSummaryUpdate?.((job) => {
      if (!acceptSummaryJob(job)) return;
      // Update state even off-screen, without switching views or starting a job.
      if (document.body.classList.contains("file-mode")) {
        renderControls();
        if (job.summary && state.resultTab === "summary") {
          void loadResult("summary", { expectedSessionId: job.sessionId }).catch(() => {});
        }
        ensurePolling();
      }
    });
    window.addEventListener("beforeunload", () => {
      unsubscribeSummary?.();
      unsubscribeSummary = null;
      stopPolling();
    });
    $("fileBtn")?.addEventListener("click", () => openWorkspace().catch((error) => setHint(error.message, "error")));
    $("fileChooseBtn")?.addEventListener("click", () => importFile().catch((error) => setHint(error.message, "error")));
    $("fileChooseInlineBtn")?.addEventListener("click", () => importFile().catch((error) => setHint(error.message, "error")));
    $("fileRefreshBtn")?.addEventListener("click", () => refreshSessions().catch((error) => setHint(error.message, "error")));
    $("fileSessionSearch")?.addEventListener("input", renderList);
    $("fileProcessStartBtn")?.addEventListener("click", () => processStart().catch(() => {}));
    $("fileProcessRetryBtn")?.addEventListener("click", () => processStart({ retry: true }).catch(() => {}));
    $("fileProcessCancelBtn")?.addEventListener("click", () => processCancel().catch((error) => setHint(error.message, "error")));
    $("fileAnalysisStartBtn")?.addEventListener("click", () => summaryStart().catch(() => {}));
    $("fileAnalysisRetryBtn")?.addEventListener("click", () => summaryStart({ retry: true }).catch(() => {}));
    $("fileAnalysisCancelBtn")?.addEventListener("click", () => summaryCancel().catch((error) => setHint(error.message, "error")));
    $("fileAnalysisMimoReview")?.addEventListener("change", renderControls);
    $("fileSummaryModelSelect")?.addEventListener("change", () => {
      state.summaryModel = String(els().summaryModelSelect?.value || "").trim();
      renderControls();
    });
    $("fileAsrProviderSelect")?.addEventListener("change", () => {
      const provider = els().providerSelect.value;
      if (provider === asrDefaults.FOLLOW_DICTATION) {
        els().modelSelect.value = asrDefaults.FOLLOW_DICTATION;
        saveFileAsrSelection().catch((error) => setHint(error.message, "error"));
        return;
      }
      const current = currentFileAsrModel();
      const compatible = FILE_ASR_MODELS.find((item) => item.provider === provider && (provider === "mimo" || item.value === current));
      if (els().modelSelect) els().modelSelect.value = compatible?.value || (provider === "qwen3-asr" ? "qwen3-asr-flash" : "mimo-v2.5-asr");
      els().customModel && (els().customModel.hidden = true);
      saveFileAsrSelection().catch((error) => setHint(error.message, "error"));
    });
    $("fileAsrModelSelect")?.addEventListener("change", () => {
      const custom = els().modelSelect.value === "__custom__";
      if (els().modelSelect.value === asrDefaults.FOLLOW_DICTATION) els().providerSelect.value = asrDefaults.FOLLOW_DICTATION;
      else if (els().providerSelect.value === asrDefaults.FOLLOW_DICTATION) {
        els().providerSelect.value = asrDefaults.dictationSelection(state.settings, "file").provider === "mimo" ? "mimo" : "qwen3-asr";
      }
      const preset = FILE_ASR_MODELS.find((item) => item.value === els().modelSelect.value);
      if (preset && els().providerSelect) els().providerSelect.value = preset.provider;
      if (els().customModel) els().customModel.hidden = !custom;
      if (!custom) saveFileAsrSelection().catch((error) => setHint(error.message, "error"));
    });
    $("fileAsrCustomModelInput")?.addEventListener("change", () => saveFileAsrSelection().catch((error) => setHint(error.message, "error")));
    $("fileExportBtn")?.addEventListener("click", () => exportCurrent().catch((error) => setHint(error.message, "error")));
    $("fileCopyResultBtn")?.addEventListener("click", copyCurrent);
    for (const button of panel.querySelectorAll("[data-file-tab]")) {
      button.addEventListener("click", () => loadResult(button.dataset.fileTab).catch(() => {}));
    }
    window.mimoInput.onOpenFile?.(() => openWorkspace({ fromModeEvent: true }).catch((error) => setHint(error.message, "error")));
    window.mimoInput.onWindowMode?.((mode) => {
      if (mode !== "file") stopPolling();
      else syncSidebars();
    });
  }

  window.FileTranscriptionUi = {
    state,
    openWorkspace,
    stopPolling,
    refreshSessions,
    chooseFile: importFile
  };
  bind();
})();
