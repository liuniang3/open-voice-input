"use strict";

(function installOnboardingUi(root) {
  const ASR = {
    mimo: { family: "mimo", model: "mimo-v2.5-asr", realtimeModel: "mimo-v2.5-asr", url: "https://api.xiaomimimo.com/v1" },
    "qwen3-asr": { family: "aliyun", model: "qwen3-asr-flash", realtimeModel: "qwen-audio-3.0-asr-flash-streaming", url: "https://dashscope.aliyuncs.com" }
  };
  function validateUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("请填写有效的 HTTPS API 地址。"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("API 地址必须使用 HTTPS，不能包含凭据、查询参数或片段。");
    }
    return String(value).trim().replace(/\/+$/, "");
  }

  function createOnboardingUi(win) {
    const doc = win.document;
    const $ = id => doc.getElementById(id);
    if (!$("onboardingPanel")) return null;
    const api = win.mimoInput;
    const picker = win.TextSupplierUi;
    let settings = {};
    let step = 0;
    let opened = false;
    let opening;
    let busy = false;
    let epoch = 0;
    let captureInput;
    let captureReady = false;
    let probe;
    let probePending = false;

    function ensureActive(token) {
      if (!opened || token !== epoch) throw new Error("引导已关闭");
    }

    function error(message = "") { $("guideError").textContent = message; $("guideError").hidden = !message; }
    function render() {
      $("onboardingProgress").textContent = `${step + 1} / 3`;
      for (const item of doc.querySelectorAll("[data-guide-step]")) {
        item.classList.toggle("is-current", Number(item.dataset.guideStep) === step);
        item.classList.toggle("is-complete", Number(item.dataset.guideStep) < step);
        item.setAttribute("aria-current", Number(item.dataset.guideStep) === step ? "step" : "false");
      }
      for (const panel of doc.querySelectorAll("[data-guide-panel]")) panel.hidden = Number(panel.dataset.guidePanel) !== step;
      $("guideBack").hidden = step === 0;
      $("guideNext").firstChild.textContent = step === 2 ? "完成设置" : "下一步";
      for (const button of $("onboardingPanel").querySelectorAll("button")) {
        button.disabled = busy || probePending || (["guideCleanerFetch", "guideCleanerSave"].includes(button.id) && $("guideCleanerSupplier").value === "__legacy__");
      }
      for (const field of $("onboardingPanel").querySelectorAll("input, select")) {
        field.disabled = busy || probePending || ($("guideCleanerSupplier").value === "__legacy__"
          && ["guideCleanerName", "guideCleanerUrl", "guideCleanerKey", "guideCleanerStyle", "guideCleanerAuthStyle", "guideCleanerModel"].includes(field.id));
      }
      $("guideCleanerFields").hidden = !$("guideCleanupEnabled").checked;
      $("guideCleanerNote").hidden = $("guideCleanupEnabled").checked;
    }
    async function action(task) {
      if (busy) return;
      busy = true; const token = epoch; error(); render();
      try { await task(token); }
      catch (failure) { if (opened && epoch === token) error(failure.message || "操作未完成，请重试。"); }
      finally { if (epoch === token) { busy = false; if (opened) render(); } }
    }
    function options(select, entries, selected) {
      select.replaceChildren();
      for (const [value, label] of entries) {
        const item = doc.createElement("option"); item.value = value; item.textContent = label; select.appendChild(item);
      }
      if (selected !== undefined) select.value = selected;
    }
    function fillAsr() {
      const provider = $("guideAsrProvider").value;
      const preset = ASR[provider];
      const model = win.AsrProviderInfo.supplierId(settings.asrProvider) === provider ? settings.asrModel || preset.model : preset.model;
      const profile = settings.asrProfiles?.[model] || {};
      const connections = settings.asrConnections || settings.providerConnections;
      const connection = connections?.[preset.family];
      $("guideAsrUrl").value = connection?.baseUrl || profile.baseUrl || preset.url;
      $("guideAsrKey").value = settings.asrConnections ? connection?.apiKey || "" : connection?.apiKey || profile.apiKey || "";
      $("guideAsrModel").value = model;
      $("guideAsrMode").value = profile.mode || (model === settings.asrModel ? settings.asrMode : "") || "realtime";
      options($("guideAsrPresets"), [...new Set([preset.model, ...Object.keys(settings.asrProfiles || {}).filter(id => win.AsrProviderInfo.supplierId(settings.asrProfiles[id].provider) === provider)])].map(id => [id, id]));
      const info = win.AsrProviderInfo.consoleInfo(provider);
      $("guideAsrConsoleLabel").textContent = info.label;
      $("guideAsrConsole").title = `打开 ${info.label}，获取 API Key`;
      $("guideAsrTestStatus").textContent = "尚未测试";
    }
    function legacyCleaner() {
      if (settings._languageSuppliersMigrated) return {};
      const profile = settings.cleanerProfiles?.[settings.cleanerModel] || {};
      const family = settings.cleanerProviderFamily || profile.providerFamily || profile.provider || settings.cleanerProvider;
      const connection = family === "custom" ? profile : settings.providerConnections?.[family === "mimo" ? "mimo" : family === "opencode-go" ? "opencode-go" : "openai"] || profile;
      return { name: "当前配置（兼容）", baseUrl: connection.baseUrl || profile.baseUrl || "",
        apiKey: connection.apiKey || profile.apiKey || "", apiStyle: connection.apiStyle || "chat-completions" };
    }
    function fillCleaner() {
      const id = $("guideCleanerSupplier").value;
      const entry = id === "__legacy__" ? legacyCleaner() : settings.textSuppliers?.find(item => item.id === id);
      $("guideCleanerName").value = entry?.name || "我的文本供应商";
      $("guideCleanerUrl").value = entry?.baseUrl || "";
      $("guideCleanerKey").value = entry?.apiKey || "";
      $("guideCleanerStyle").value = entry?.apiStyle || "chat-completions";
      $("guideCleanerAuthStyle").value = entry?.authStyle || "bearer";
      $("guideCleanerPresetField").hidden = id !== "__new__";
      $("guideCleanerSaveLabel").textContent = id === "__new__" ? "添加供应商" : "保存连接";
      $("guideCleanerSaveStatus").textContent = "";
      const model = settings.textModelSelections?.cleanup?.supplierId === id ? settings.textModelSelections.cleanup.modelId
        : id === "__legacy__" ? settings.cleanerModel : picker.catalogModels(settings, id)[0] || "";
      $("guideCleanerModel").value = model;
      options($("guideCleanerModels"), picker.catalogModels(settings, id).map(value => [value, value]));
      for (const field of ["guideCleanerName", "guideCleanerUrl", "guideCleanerKey", "guideCleanerStyle", "guideCleanerAuthStyle", "guideCleanerModel", "guideCleanerFetch", "guideCleanerSave"]) $(field).disabled = id === "__legacy__";
      if (id === "__new__") applyCleanerPreset();
    }
    function applyCleanerPreset() {
      const preset = picker.SUPPLIER_PRESETS.find(item => item.id === $("guideCleanerPreset").value) || picker.SUPPLIER_PRESETS[0];
      $("guideCleanerName").value = picker.uniqueSupplierName(preset.id === "custom" ? "我的文本供应商" : preset.name, settings);
      $("guideCleanerUrl").value = preset.baseUrl;
      $("guideCleanerKey").value = "";
      $("guideCleanerStyle").value = preset.apiStyle;
      $("guideCleanerAuthStyle").value = preset.authStyle || "bearer";
      $("guideCleanerSaveStatus").textContent = "";
    }
    function fillSupplierList(selected) {
      const entries = picker.listSuppliers(settings).map(item => [item.id, item.name]);
      if (legacyCleaner().apiKey && settings.cleanerModel) entries.unshift(["__legacy__", "当前配置（兼容）"]);
      entries.push(["__new__", "添加文本供应商"]);
      options($("guideCleanerSupplier"), entries, entries.some(([id]) => id === selected) ? selected : "__new__");
      fillCleaner();
    }
    async function saveAsr() {
      const token = epoch;
      const supplier = $("guideAsrProvider").value;
      const family = ASR[supplier].family;
      const baseUrl = validateUrl($("guideAsrUrl").value.trim());
      const apiKey = $("guideAsrKey").value.trim();
      const requestedModel = picker.modelIdOf($("guideAsrModel").value);
      const streamingModel = supplier !== "mimo" && /(?:realtime|streaming)/i.test(requestedModel);
      const model = streamingModel ? ASR[supplier].model : requestedModel;
      const provider = win.AsrProviderInfo.transportProvider(supplier, model);
      if (!apiKey || !model) throw new Error("请填写 API Key 和语音识别模型。");
      const mode = $("guideAsrMode").value === "batch" ? "batch" : "realtime";
      const realtimeModel = streamingModel ? requestedModel : settings.asrProfiles?.[model]?.realtimeModel || ASR[supplier].realtimeModel;
      const saved = await api.saveSettings({
        asrConnections: { ...settings.asrConnections, [family]: { ...settings.asrConnections?.[family], baseUrl, apiKey } },
        asrProvider: provider, asrModel: model, asrMode: mode, asrRealtimeModel: realtimeModel,
        asrProfiles: { ...settings.asrProfiles, [model]: { ...settings.asrProfiles?.[model], provider, baseUrl, apiKey, mode, realtimeModel } }
      });
      ensureActive(token); settings = saved;
    }
    async function saveCleanerConnection() {
      const token = epoch;
      let id = $("guideCleanerSupplier").value;
      if (id === "__legacy__") return id;
      const existingId = id === "__new__" ? "" : id;
      const entry = picker.supplierDraft(settings, {
        name: $("guideCleanerName").value, baseUrl: $("guideCleanerUrl").value,
        apiKey: $("guideCleanerKey").value, apiStyle: $("guideCleanerStyle").value,
        authStyle: $("guideCleanerAuthStyle").value
      }, existingId);
      if (!entry.apiKey) throw new Error("请填写文本供应商 API Key。");
      id = entry.id;
      const modelDraft = $("guideCleanerModel").value;
      const saved = await api.saveSettings({ textSuppliers: [...(settings.textSuppliers || []).filter(item => item.id !== id), entry] });
      ensureActive(token); settings = saved;
      fillSupplierList(id); $("guideCleanerModel").value = modelDraft;
      $("guideCleanerSaveStatus").textContent = "供应商已保存";
      return id;
    }
    async function saveCleaner() {
      if (!$("guideCleanupEnabled").checked) { settings = await api.saveSettings({ transcriptionMode: "fast" }); return; }
      const modelId = picker.modelIdOf($("guideCleanerModel").value);
      if (!modelId) throw new Error("请选择或填写表达整理模型。");
      const id = await saveCleanerConnection();
      const selected = picker.applySelection(settings, "cleanup", { supplierId: id, modelId });
      const catalog = settings.textSupplierCatalogs?.[id] || {};
      settings = await api.saveSettings({ transcriptionMode: "stable", cleanerModel: selected.cleanerModel,
        textModelSelections: selected.textModelSelections,
        ...(id !== "__legacy__" ? { textSupplierCatalogs: { ...settings.textSupplierCatalogs,
          [id]: { ...catalog, models: [...new Set([...picker.catalogModels(settings, id), modelId])] } } } : {})
      });
    }
    async function stopProbe() {
      const current = probe;
      if (!current) return;
      current.cancelled = true;
      current.stop?.();
      await current.done.catch(() => {});
    }
    function startProbe(listen) {
      if (probe) return probe.done;
      const token = epoch;
      const current = { cancelled: false, reserved: false };
      probe = current; probePending = true; render();
      current.done = (async () => {
        try {
          const reserve = await api.onboardingMicrophoneProbe(true);
          if (!reserve?.ok) throw new Error(reserve?.error?.message || "麦克风正在使用中。");
          current.reserved = true;
          if (current.cancelled || !opened || token !== epoch) return;
          const selected = $("guideMicrophone").value;
          current.stream = await win.navigator.mediaDevices.getUserMedia({ audio: selected ? { deviceId: { exact: selected } } : true });
          if (current.cancelled || !opened || token !== epoch || !listen) return;
          current.context = new win.AudioContext();
          const source = current.context.createMediaStreamSource(current.stream);
          const analyzer = current.context.createAnalyser(); analyzer.fftSize = 256; source.connect(analyzer);
          const samples = new Uint8Array(analyzer.fftSize);
          let peak = 0;
          const update = () => {
            if (current.cancelled || !opened || token !== epoch) return;
            analyzer.getByteTimeDomainData(samples);
            let sum = 0; for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
            const level = Math.min(1, Math.sqrt(sum / samples.length) * 8); peak = Math.max(peak, level);
            $("guideMeterFill").style.width = `${level * 100}%`;
            current.frame = win.requestAnimationFrame(update);
          };
          update(); $("guideMicrophoneStatus").textContent = "正在检测音量…";
          await new Promise(resolve => { current.stop = resolve; current.timer = win.setTimeout(resolve, 5000); });
          if (!current.cancelled && opened && token === epoch) {
            $("guideMicrophoneStatus").textContent = peak > 0.03 ? "麦克风正常" : "未检测到明显音量，请检查输入设备";
          }
        } finally {
          win.clearTimeout(current.timer); win.cancelAnimationFrame(current.frame);
          current.stream?.getTracks().forEach(track => track.stop());
          await current.context?.close().catch(() => {});
          if (current.reserved) await api.onboardingMicrophoneProbe(false).catch(() => {});
          if (probe === current) {
            probe = null; probePending = false; $("guideMeterFill").style.width = "0%";
            if (opened) render();
          }
        }
      })();
      return current.done;
    }
    async function microphones(ask = false) {
      const token = epoch;
      if (ask) await startProbe(false);
      const devices = await win.navigator.mediaDevices.enumerateDevices();
      if (!opened || token !== epoch) return;
      const selected = $("guideMicrophone").value || settings.microphoneDeviceId || "";
      options($("guideMicrophone"), [["", "系统默认麦克风"], ...devices.filter(device => device.kind === "audioinput")
        .map((device, index) => [device.deviceId, device.label || `麦克风 ${index + 1}`])], selected);
      if (!$("guideMicrophone").value) $("guideMicrophone").value = "";
    }
    async function testMicrophone() {
      if (busy || probePending) return;
      const token = epoch;
      try {
        await startProbe(true);
      } catch {
        if (opened && token === epoch) $("guideMicrophoneStatus").textContent = "无法访问麦克风，请检查系统权限";
      }
    }
    async function endCapture() {
      captureInput = null; captureReady = false;
      await api.endHotkeyCapture?.().catch(() => {});
    }
    async function captureKey(event, kind) {
      event.preventDefault(); event.stopPropagation();
      const input = event.currentTarget;
      if (event.key === "Escape") { input.blur(); return; }
      if (!captureReady) return;
      const accelerator = win.formatShortcutEvent?.(event);
      if (!accelerator) return;
      const status = $(kind === "meeting" ? "guideMeetingHotkeyStatus" : "guideHotkeyStatus");
      const old = input.value;
      status.textContent = "正在检查是否冲突…";
      const token = epoch;
      try {
        const check = await api.checkHotkey({ kind, accelerator });
        if (!opened || token !== epoch) return;
        if (!check?.ok) throw new Error(check?.message || "此快捷键不可用。");
        input.value = check.accelerator || accelerator; status.textContent = "快捷键可用";
      } catch (failure) { input.value = old; status.textContent = failure.message; }
      finally { await endCapture(); input.blur(); }
    }
    function open() {
      if (opened) return;
      if (opening) return opening;
      const token = ++epoch;
      const request = Promise.resolve().then(async () => {
      await stopProbe();
      const response = await api.openHome();
      if (response?.ok === false) throw new Error(response.error?.message || "请先结束当前录制。");
      if (token !== epoch) return;
      win.applyWindowMode?.("home");
      const loaded = await api.getSettings();
      if (token !== epoch) return;
      settings = loaded;
      opened = true; step = 0; error();
      options($("guideCleanerPreset"), picker.SUPPLIER_PRESETS.map(item => [item.id, item.name]), "custom");
      $("guideAsrProvider").value = win.AsrProviderInfo.supplierId(settings.asrProvider) || "mimo"; fillAsr();
      const selected = settings.textModelSelections?.cleanup?.supplierId || (legacyCleaner().apiKey ? "__legacy__" : "__new__");
      $("guideCleanupEnabled").checked = settings.transcriptionMode === "stable" && selected !== "__new__";
      fillSupplierList(selected);
      $("guideHotkey").value = settings.hotkey || "CommandOrControl+Alt+M";
      $("guideMeetingHotkey").value = settings.meetingHotkey || "CommandOrControl+Alt+Shift+M";
      $("homePanel").hidden = true; $("onboardingPanel").hidden = false;
      doc.body.classList.add("onboarding-open"); render();
      await microphones().catch(() => {});
      if (opened && token === epoch) $("guideAsrProvider").focus();
      }).catch(() => {
        if (token === epoch) {
          $("homePanel").hidden = false;
          $("homeError").hidden = false; $("homeError").textContent = "快速上手暂时无法打开，请稍后重试。";
        }
      }).finally(() => { if (opening === request) opening = null; });
      opening = request;
      return request;
    }
    function close() {
      opened = false; epoch++; opening = null; busy = false;
      $("onboardingPanel").hidden = true; doc.body.classList.remove("onboarding-open");
      $("guideAsrKey").value = ""; $("guideCleanerKey").value = "";
      for (const id of ["guideAsrKey", "guideCleanerKey"]) {
        $(id).type = "password";
        const toggle = doc.querySelector(`[data-secret-toggle="${id}"]`);
        if (toggle) toggle.textContent = "显示";
      }
      void stopProbe(); void endCapture();
    }
    async function finish(skipped) {
      const token = epoch;
      await stopProbe(); await endCapture();
      const result = await api.finishOnboarding({ skipped });
      ensureActive(token);
      if (!result?.ok) throw new Error("无法保存引导状态，请重试。");
      close(); $("homePanel").hidden = false;
      await win.HomeUi?.refresh();
    }
    $("guideNext").addEventListener("click", () => { void action(async (token) => {
      if (step === 0) await saveAsr();
      else if (step === 1) await saveCleaner();
      else {
        await stopProbe(); await endCapture();
        const [short, meeting] = await Promise.all([
          api.checkHotkey({ kind: "short", accelerator: $("guideHotkey").value }),
          api.checkHotkey({ kind: "meeting", accelerator: $("guideMeetingHotkey").value })
        ]);
        ensureActive(token);
        if (!short?.ok || !meeting?.ok) throw new Error(short?.message || meeting?.message || "请换一个可用的快捷键。");
        await api.saveSettings({ microphoneDeviceId: $("guideMicrophone").value,
          hotkey: short.accelerator || $("guideHotkey").value, meetingHotkey: meeting.accelerator || $("guideMeetingHotkey").value });
        ensureActive(token);
        await finish(false); return;
      }
      await stopProbe(); ensureActive(token); step++; render();
    }); });
    $("guideBack").addEventListener("click", () => { void action(async (token) => { await stopProbe(); await endCapture(); ensureActive(token); step = Math.max(0, step - 1); }); });
    $("guideSkip").addEventListener("click", () => { void action(() => finish(true)); });
    $("guideAsrProvider").addEventListener("change", fillAsr);
    $("guideAsrConsole").addEventListener("click", () => { void action(async token => {
      const result = await api.openAsrConsole($("guideAsrProvider").value);
      ensureActive(token);
      if (!result?.ok) throw new Error("无法打开 API 控制台，请检查默认浏览器后重试。");
    }); });
    $("guideCleanupEnabled").addEventListener("change", render);
    $("guideCleanerSupplier").addEventListener("change", fillCleaner);
    $("guideCleanerPreset").addEventListener("change", applyCleanerPreset);
    $("guideCleanerSave").addEventListener("click", () => { void action(() => saveCleanerConnection()); });
    $("guideAsrTest").addEventListener("click", () => { void action(async (token) => {
      $("guideAsrTestStatus").textContent = "正在测试…"; await saveAsr();
      const result = await api.testOnboardingAsr();
      ensureActive(token);
      if (!result?.ok) { $("guideAsrTestStatus").textContent = "连接未成功"; throw new Error(result?.error?.message || "连接未成功，请检查配置。"); }
      $("guideAsrTestStatus").textContent = `连接成功 · ${result.latencyMs || 0}ms`;
    }); });
    $("guideCleanerFetch").addEventListener("click", () => { void action(async (token) => {
      const supplierId = await saveCleanerConnection();
      const result = await api.listProviderModels({ supplierId });
      ensureActive(token);
      if (!result?.ok) throw new Error(result?.error?.message || "获取模型失败，可以手动填写模型 ID。");
      const loaded = await api.getSettings(); ensureActive(token); settings = loaded;
      const models = picker.catalogModels(settings, supplierId);
      options($("guideCleanerModels"), models.map(model => [model, model]));
      if (!$("guideCleanerModel").value) $("guideCleanerModel").value = models[0] || "";
    }); });
    $("guideMicrophoneRefresh").addEventListener("click", () => { void action(() => microphones(true)); });
    $("guideMicrophoneTest").addEventListener("click", () => { void testMicrophone(); });
    for (const [id, kind] of [["guideHotkey", "short"], ["guideMeetingHotkey", "meeting"]]) {
      $(id).addEventListener("focus", async () => {
        captureInput = $(id); captureReady = false;
        try { await api.startHotkeyCapture(); if (captureInput === $(id)) captureReady = true; }
        catch { error("无法暂停快捷键，请结束当前录制后重试。"); }
      });
      $(id).addEventListener("blur", () => { if (captureInput === $(id)) void endCapture(); });
      $(id).addEventListener("keydown", event => { void captureKey(event, kind); });
    }
    return { open, close, isOpen: () => opened || Boolean(opening) };
  }
  if (typeof module === "object" && module.exports) module.exports = { createOnboardingUi, validateUrl };
  if (root?.document) root.OnboardingUi = createOnboardingUi(root);
})(typeof window === "undefined" ? null : window);
