"use strict";

/* The file workspace intentionally owns its state and polling lifecycle.
 * It reuses the meeting processing IPC contract, but never reuses the meeting workbench state. */
(function createFileTranscriptionUi() {
  const panel = document.getElementById("filePanel");
  if (!panel) return;

  const ui = window.MeetingUi || {};
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
    correctedDoc: null,
    summaryDoc: null,
    importBusy: false,
    importSessionId: null,
    pollTimer: null,
    settings: {}
  };
  let openPromise = null;

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
      analysisTemplate: $("fileAnalysisTemplateSelect"),
      analysisStart: $("fileAnalysisStartBtn"),
      analysisRetry: $("fileAnalysisRetryBtn"),
      analysisCancel: $("fileAnalysisCancelBtn"),
      resultEmpty: $("fileResultEmpty"),
      resultContent: $("fileResultContent"),
      exportFormat: $("fileExportFormatSelect"),
      exportScope: $("fileExportScopeSelect"),
      export: $("fileExportBtn")
    };
  }

  function currentFileAsrModel() {
    const e = els();
    return e.modelSelect?.value === "__custom__"
      ? String(e.customModel?.value || "").trim()
      : String(e.modelSelect?.value || state.settings.meetingFileAsrModel || "mimo-v2.5-asr").trim();
  }

  function currentFileAsrProvider(model = currentFileAsrModel()) {
    const e = els();
    const selected = String(e.providerSelect?.value || state.settings.meetingFileAsrProvider || "mimo").trim();
    if (selected) return selected;
    return FILE_ASR_MODELS.find((item) => item.value === model)?.provider || "mimo";
  }

  function renderFileAsrSelector() {
    const e = els();
    if (!e.providerSelect || !e.modelSelect) return;
    const provider = String(state.settings.meetingFileAsrProvider || "mimo");
    const model = String(state.settings.meetingFileAsrModel || "mimo-v2.5-asr");
    e.providerSelect.value = provider === "qwen3-asr" ? "qwen3-asr" : "mimo";
    const preset = FILE_ASR_MODELS.some((item) => item.value === model) ? model : "__custom__";
    e.modelSelect.value = preset;
    if (e.customModel) {
      e.customModel.hidden = preset !== "__custom__";
      e.customModel.value = preset === "__custom__" ? model : "";
    }
    if (e.configStatus) e.configStatus.textContent = `${provider} / ${model}`;
  }

  async function saveFileAsrSelection() {
    const model = currentFileAsrModel();
    if (!model) throw new Error("请填写文件 ASR 模型 ID。");
    const provider = currentFileAsrProvider(model);
    state.settings = (await window.mimoInput.saveSettings({
      meetingFileAsrProvider: provider,
      meetingFileAsrModel: model
    })) || { ...state.settings, meetingFileAsrProvider: provider, meetingFileAsrModel: model };
    renderFileAsrSelector();
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

  function setHint(text) {
    const el = els().hint;
    if (el) el.textContent = String(text || "");
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
    state.analysis = null;
    state.rawDoc = null;
    state.correctedDoc = null;
    state.summaryDoc = null;
    state.importSessionId = null;
    state.importBusy = false;
    const e = els();
    if (e.title) e.title.value = "";
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
      button.addEventListener("click", () => selectSession(row.id).catch((error) => setHint(error.message)));
      e.list.appendChild(button);
    }
  }

  function renderSelected() {
    const row = currentRow();
    const e = els();
    if (!row) {
      clearSelection();
      return;
    }
    const fileName = row.importMeta?.sourceFileName || row.title || row.id;
    if (e.name) e.name.textContent = row.title || fileName;
    if (e.title) e.title.value = row.title && row.title !== fileName ? row.title : "";
    if (e.meta) {
      const kind = row.importMeta?.mediaKind || "音频";
      const status = row.status === "importing" ? "正在导入" : row.status === "stopped" ? "已导入" : row.status || "待处理";
      e.meta.textContent = `${fileName} · ${kind} · ${status}`;
    }
    const provider = state.settings.meetingFileAsrProvider || "mimo";
    const model = state.settings.meetingFileAsrModel || "mimo-v2.5-asr";
    if (e.model) e.model.textContent = `当前 ASR：${provider} / ${model}`;
    renderFileAsrSelector();
    renderList();
  }

  function renderControls() {
    const row = currentRow();
    const proc = state.process?.stage || "idle";
    const ana = state.analysis?.status || "none";
    const imported = Boolean(row && hasArchive(row));
    const processRunning = isRunningProcess(proc);
    const analysisRunning = isRunningAnalysis(ana);
    const canStart = Boolean(row && imported && !state.importBusy && !processRunning && !analysisRunning && proc !== "completed");
    const canRetry = Boolean(row && imported && !state.importBusy && !processRunning && !analysisRunning && (proc === "failed" || proc === "cancelled"));
    const canCancel = Boolean(row && processRunning);
    const canAnalyze = Boolean(
      row && proc === "completed" && !analysisRunning && !processRunning &&
      (ana === "none" || ana === "completed")
    );
    const canRetryAnalysis = Boolean(row && proc === "completed" && !analysisRunning && (ana === "failed" || ana === "cancelled"));
    const canCancelAnalysis = Boolean(row && analysisRunning);
    const e = els();
    if (e.processStart) e.processStart.disabled = !canStart;
    if (e.processRetry) e.processRetry.disabled = !canRetry;
    if (e.processCancel) e.processCancel.disabled = !canCancel;
    if (e.analysisStart) e.analysisStart.disabled = !canAnalyze;
    if (e.analysisStart) {
      e.analysisStart.textContent = ana === "completed" ? "重新生成结果" : "校订并总结";
    }
    if (e.analysisRetry) e.analysisRetry.disabled = !canRetryAnalysis;
    if (e.analysisCancel) e.analysisCancel.disabled = !canCancelAnalysis;

    const processLabel = ui.processStageLabel?.(proc, state.process) || (proc === "idle" ? "尚未开始" : proc);
    const processKind = proc === "completed" ? "ok" : proc === "failed" ? "error" : processRunning ? "processing" : "idle";
    setPill(e.importStatus, state.importBusy ? "processing" : row ? (hasArchive(row) ? "ok" : "warn") : "idle", state.importBusy ? "导入中" : row ? (hasArchive(row) ? "已导入" : "待导入") : "未选择");
    if (e.processLabel) e.processLabel.textContent = processLabel;
    if (e.processProgress) e.processProgress.textContent = ui.processProgressText?.(state.process) || "—";
    const analysisLabel = ui.analysisStageLabel?.(ana, state.analysis?.stage) || (ana === "none" ? "尚未开始" : ana);
    if (e.analysisLabel) e.analysisLabel.textContent = analysisLabel;
    if (e.processLabel) e.processLabel.dataset.kind = processKind;
    if (e.analysisLabel) e.analysisLabel.dataset.kind = ana === "completed" ? "ok" : ana === "failed" ? "error" : isRunningAnalysis(ana) ? "processing" : "idle";
  }

  async function loadSettings() {
    try {
      state.settings = (await window.mimoInput.getSettings?.()) || {};
    } catch {
      state.settings = {};
    }
    renderFileAsrSelector();
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
    state.selectedId = String(sessionId);
    state.process = null;
    state.analysis = null;
    state.rawDoc = null;
    state.correctedDoc = null;
    state.summaryDoc = null;
    resetResultView();
    renderSelected();
    renderControls();
    const token = channels.select.next();
    const [scan, process, analysis] = await Promise.all([
      window.mimoInput.meetingScanSession(state.selectedId),
      window.mimoInput.meetingProcessStatus({ sessionId: state.selectedId }),
      window.mimoInput.meetingAnalysisStatus({ sessionId: state.selectedId })
    ]);
    if (!accept(channels.select, token, state.selectedId)) return;
    const row = currentRow();
    if (row && scan?.ok) {
      row.status = scan.session?.status || row.status;
      row.hasArchive = Boolean(row.hasArchive || scan.session?.tracks?.microphone || scan.session?.tracks?.system);
    }
    state.process = process?.ok ? process.processing : null;
    state.analysis = analysis?.ok ? analysis.analysis : null;
    renderSelected();
    renderControls();
    if (state.process?.stage === "completed" || row?.hasRaw) {
      await loadResult(state.resultTab, { expectedSessionId: state.selectedId });
    } else {
      resetResultView("文件已导入，开始转写后结果会显示在这里。");
    }
    if (state.analysis?.status === "completed") {
      loadAnalysisResults(state.selectedId)
        .then(() => {
          if (state.resultTab !== "raw") {
            return loadResult(state.resultTab, { expectedSessionId: state.selectedId });
          }
          return null;
        })
        .catch((error) => setHint(error.message || "分析结果读取失败，请重试分析。"));
    }
    if (state.selectedId) ensurePolling();
  }

  async function importFile() {
    if (state.importBusy) return;
    state.importBusy = true;
    renderControls();
    setHint("选择音频或视频文件…");
    try {
      const title = els().title?.value?.trim() || "";
      const api = window.mimoInput.fileImportMedia || window.mimoInput.meetingImportMedia;
      const res = await api({ title, track: "microphone", role: "self" });
      if (res?.cancelled) {
        setHint("已取消选择文件");
        return;
      }
      if (!res?.ok) throw new Error(res?.error?.message || "导入启动失败");
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
          setHint("文件已导入，可以开始转写。");
          return;
        }
        if (["import_failed", "import_cancelled", "import_interrupted"].includes(status)) {
          await refreshSessions();
          if (state.selectedId === sessionId) renderSelected();
          setHint(res?.import?.message || (status === "import_cancelled" ? "文件导入已取消。" : "文件导入失败，请重试。"));
          return;
        }
        if (i % 2 === 0) {
          const phase = res?.phase || res?.import?.phase || "running";
          const phaseLabel = phase === "extract" ? "抽取音轨" : phase === "commit" ? "保存文件" : "导入中";
          const progress = res?.progress?.total > 0
            ? ` ${Math.min(100, Math.round((100 * (res.progress.bytes || 0)) / res.progress.total))}%`
            : "";
          setHint(`${phaseLabel}${progress}…`);
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      setHint("文件导入超时，请刷新列表后重试。");
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
    setHint(res?.cancelled ? "正在取消文件导入…" : "当前没有正在导入的文件。");
  }

  async function processStart({ retry = false } = {}) {
    const sessionId = state.selectedId;
    if (!sessionId) return;
    const token = channels.process.next();
    state.process = { ...(state.process || {}), stage: "exporting", status: "running", processMode: "file", mode: "file", optimistic: true };
    state.rawDoc = null;
    state.correctedDoc = null;
    state.summaryDoc = null;
    state.analysis = null;
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
      setHint(error.message || String(error));
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

  async function analysisStart({ retry = false } = {}) {
    const sessionId = state.selectedId;
    if (!sessionId) return;
    const force = !retry && state.analysis?.status === "completed";
    const token = channels.analysis.next();
    state.analysis = { ...(state.analysis || {}), status: "running", stage: "fingerprint", optimistic: true };
    state.correctedDoc = null;
    state.summaryDoc = null;
    if (state.resultTab !== "raw") {
      resetResultView(force ? "正在重新生成校订与总结…" : "正在生成校订与总结…");
    }
    renderControls();
    ensurePolling();
    try {
      const api = retry ? window.mimoInput.meetingAnalysisRetry : window.mimoInput.meetingAnalysisStart;
      const res = await api({
        sessionId,
        template: els().analysisTemplate?.value || "auto",
        ...(!retry ? { force } : {}),
        ...(retry ? { resetAttempts: true } : {})
      });
      if (!accept(channels.analysis, token, sessionId)) return;
      if (!res?.ok) throw new Error(res?.error?.message || "校订与总结失败");
      state.analysis = res.analysis;
      renderControls();
      try {
        await loadAnalysisResults(sessionId);
        await loadResult("summary", { expectedSessionId: sessionId });
        setHint("校订与总结已完成，已显示结构化总结。");
      } catch (error) {
        // Keep the backend's completed state visible; a result read failure must not
        // turn a successful analysis job into a false failed state in the UI.
        setHint(error.message || "分析已完成，但结果读取失败，请切换页签或重试分析。");
      }
      ensurePolling();
    } catch (error) {
      state.analysis = { status: "failed", stage: "failed" };
      renderControls();
      setHint(error.message || String(error));
      throw error;
    }
  }

  async function analysisCancel() {
    if (!state.selectedId) return;
    const res = await window.mimoInput.meetingAnalysisCancel({ sessionId: state.selectedId });
    if (!res?.ok) throw new Error(res?.error?.message || "取消分析失败");
    state.analysis = res.analysis;
    renderControls();
  }

  async function loadResult(tab, { expectedSessionId = null } = {}) {
    if (!state.selectedId || (expectedSessionId && expectedSessionId !== state.selectedId)) return;
    state.resultTab = tab === "corrected" || tab === "summary" ? tab : "raw";
    for (const button of panel.querySelectorAll("[data-file-tab]")) {
      const active = button.dataset.fileTab === state.resultTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    const sessionId = state.selectedId;
    const token = channels.result.next();
    const e = els();
    if (e.resultEmpty) e.resultEmpty.hidden = false;
    if (e.resultContent) e.resultContent.hidden = true;
    try {
      if (state.resultTab === "raw") {
        if (!state.rawDoc) {
          const res = await window.mimoInput.meetingTranscriptGet({ sessionId });
          if (!accept(channels.result, token, sessionId) || state.selectedId !== sessionId) return;
          state.rawDoc = res?.ok ? res.transcript : null;
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
      } else if (state.resultTab === "corrected") {
        if (!state.correctedDoc) {
          const res = await window.mimoInput.meetingAnalysisCorrected({ sessionId });
          if (!accept(channels.result, token, sessionId) || state.selectedId !== sessionId) return;
          state.correctedDoc = res?.ok ? res.corrected : null;
        }
        const blocks = ui.formatTranscriptBlocks?.(state.correctedDoc) || [];
        if (e.resultEmpty) {
          e.resultEmpty.hidden = blocks.length > 0;
          if (!blocks.length) e.resultEmpty.textContent = "暂无校订文本。";
        }
        if (e.resultContent) {
          e.resultContent.hidden = blocks.length === 0;
          ui.appendTranscriptBlocks?.(e.resultContent, blocks);
        }
      } else {
        if (!state.summaryDoc) {
          const res = await window.mimoInput.meetingAnalysisSummary({ sessionId });
          if (!accept(channels.result, token, sessionId) || state.selectedId !== sessionId) return;
          state.summaryDoc = res?.ok ? res.summary : null;
        }
        const sections = ui.flattenSummarySections?.(state.summaryDoc) || [];
        if (e.resultEmpty) {
          e.resultEmpty.hidden = sections.length > 0;
          if (!sections.length) e.resultEmpty.textContent = "暂无结构化总结。";
        }
        if (e.resultContent) {
          e.resultContent.hidden = sections.length === 0;
          ui.appendSummarySections?.(e.resultContent, sections);
        }
      }
    } catch (error) {
      if (!accept(channels.result, token, sessionId)) return;
      resetResultView(error.message || "结果加载失败");
    }
  }

  async function loadAnalysisResults(sessionId) {
    if (!sessionId || sessionId !== state.selectedId) return;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function readArtifact(api, field, label) {
      let lastMessage = `${label}结果不可用`;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await api({ sessionId });
        if (res?.ok && res[field]) return res[field];
        lastMessage = res?.error?.message || lastMessage;
        if (attempt < 4) await wait(220 * (attempt + 1));
      }
      const error = new Error(lastMessage);
      error.code = field === "corrected" ? "analysis_corrected_missing" : "analysis_summary_missing";
      throw error;
    }
    const corrected = await readArtifact(
      window.mimoInput.meetingAnalysisCorrected,
      "corrected",
      "校订"
    );
    const summary = await readArtifact(
      window.mimoInput.meetingAnalysisSummary,
      "summary",
      "结构化总结"
    );
    if (state.selectedId !== sessionId) return;
    state.correctedDoc = corrected;
    state.summaryDoc = summary;
  }

  async function refreshLive() {
    if (!state.selectedId || document.body.classList.contains("file-mode") === false) return;
    const sessionId = state.selectedId;
    const token = channels.poll.next();
    const [process, analysis] = await Promise.all([
      window.mimoInput.meetingProcessStatus({ sessionId }),
      window.mimoInput.meetingAnalysisStatus({ sessionId })
    ]);
    if (!accept(channels.poll, token, sessionId)) return;
    if (process?.ok) state.process = process.processing;
    if (analysis?.ok) state.analysis = analysis.analysis;
    renderControls();
    if (state.process?.stage === "completed" && !state.rawDoc) {
      await loadResult("raw", { expectedSessionId: sessionId });
    }
    if (state.analysis?.status === "completed" && state.resultTab !== "raw") {
      await loadResult(state.resultTab, { expectedSessionId: sessionId });
    }
    if (state.analysis?.status === "completed" && (!state.correctedDoc || !state.summaryDoc)) {
      await loadAnalysisResults(sessionId).catch((error) => setHint(error.message || "分析结果读取失败，请重试分析。"));
    }
    const doneProcess = ["completed", "failed", "cancelled", "idle"].includes(state.process?.stage);
    const doneAnalysis = ["completed", "failed", "cancelled", "none"].includes(state.analysis?.status);
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
    const analysisBusy = isRunningAnalysis(state.analysis?.status);
    if (!processBusy && !analysisBusy) return;
    state.pollTimer = setInterval(() => refreshLive().catch(() => {}), 1200);
  }

  function copyCurrent() {
    let text = "";
    if (state.resultTab === "summary") {
      const sections = ui.flattenSummarySections?.(state.summaryDoc) || [];
      text = sections.map((section) => `${section.title}\n${section.lines.map((line) => `· ${line}`).join("\n")}`).join("\n\n");
    } else {
      const doc = state.resultTab === "corrected" ? state.correctedDoc : state.rawDoc;
      const blocks = ui.formatTranscriptBlocks?.(doc) || [];
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
    setHint(`已导出 ${res.files?.join("、") || "文件结果"}。`);
  }

  async function openWorkspace({ fromModeEvent = false } = {}) {
    if (openPromise) return openPromise;
    openPromise = (async () => {
      if (!fromModeEvent) await window.mimoInput.openFileWorkspace?.();
      if (typeof window.applyWindowMode === "function") window.applyWindowMode("file");
      panel.hidden = false;
      await loadSettings();
      await refreshSessions();
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
    $("fileBtn")?.addEventListener("click", () => openWorkspace().catch((error) => setHint(error.message)));
    $("fileChooseBtn")?.addEventListener("click", () => importFile().catch((error) => setHint(error.message)));
    $("fileChooseInlineBtn")?.addEventListener("click", () => importFile().catch((error) => setHint(error.message)));
    $("fileRefreshBtn")?.addEventListener("click", () => refreshSessions().catch((error) => setHint(error.message)));
    $("fileSessionSearch")?.addEventListener("input", renderList);
    $("fileProcessStartBtn")?.addEventListener("click", () => processStart().catch(() => {}));
    $("fileProcessRetryBtn")?.addEventListener("click", () => processStart({ retry: true }).catch(() => {}));
    $("fileProcessCancelBtn")?.addEventListener("click", () => processCancel().catch((error) => setHint(error.message)));
    $("fileAnalysisStartBtn")?.addEventListener("click", () => analysisStart().catch(() => {}));
    $("fileAnalysisRetryBtn")?.addEventListener("click", () => analysisStart({ retry: true }).catch(() => {}));
    $("fileAnalysisCancelBtn")?.addEventListener("click", () => analysisCancel().catch((error) => setHint(error.message)));
    $("fileAsrProviderSelect")?.addEventListener("change", () => {
      const provider = els().providerSelect.value;
      const current = currentFileAsrModel();
      const compatible = FILE_ASR_MODELS.find((item) => item.provider === provider && (provider === "mimo" || item.value === current));
      if (els().modelSelect) els().modelSelect.value = compatible?.value || (provider === "qwen3-asr" ? "qwen3-asr-flash" : "mimo-v2.5-asr");
      els().customModel && (els().customModel.hidden = true);
      saveFileAsrSelection().catch((error) => setHint(error.message));
    });
    $("fileAsrModelSelect")?.addEventListener("change", () => {
      const custom = els().modelSelect.value === "__custom__";
      const preset = FILE_ASR_MODELS.find((item) => item.value === els().modelSelect.value);
      if (preset && els().providerSelect) els().providerSelect.value = preset.provider;
      if (els().customModel) els().customModel.hidden = !custom;
      if (!custom) saveFileAsrSelection().catch((error) => setHint(error.message));
    });
    $("fileAsrCustomModelInput")?.addEventListener("change", () => saveFileAsrSelection().catch((error) => setHint(error.message)));
    $("fileExportBtn")?.addEventListener("click", () => exportCurrent().catch((error) => setHint(error.message)));
    $("fileCopyResultBtn")?.addEventListener("click", copyCurrent);
    for (const button of panel.querySelectorAll("[data-file-tab]")) {
      button.addEventListener("click", () => loadResult(button.dataset.fileTab).catch(() => {}));
    }
    window.mimoInput.onOpenFile?.(() => openWorkspace({ fromModeEvent: true }).catch((error) => setHint(error.message)));
    window.mimoInput.onWindowMode?.((mode) => {
      if (mode !== "file") stopPolling();
    });
  }

  window.FileTranscriptionUi = {
    state,
    openWorkspace,
    stopPolling,
    refreshSessions
  };
  bind();
})();
