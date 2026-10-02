"use strict";

// Drafts stay inside this editor. Only explicit saves touch persisted settings.
(function (root) {
  function createTextSupplierManager({ document, api, ui, getSettings, onSettings }) {
    const $ = id => document.getElementById(id);
    const dialog = $("textSupplierDialog");
    if (!dialog) return { render() {} };
    let selectedId = "";
    let editingId = "";
    let selectedPreset = "custom";
    let dirty = false;
    let saving = false;
    let requestBusy = false;
    let idManuallyEdited = false;
    let lastFocus = null;
    const messages = new Map();
    const editable = ["textSupplierName", "textSupplierBaseUrl", "textSupplierApiKey", "textSupplierApiStyle", "textSupplierAuthStyle", "textSupplierId", "textSupplierInitialModel"];

    function option(select, value) {
      const node = document.createElement("option");
      node.value = value; node.textContent = value;
      select.append(node);
    }
    function usedBy(settings, id) {
      return [["cleanup", "语音表达整理"], ["summary", "会议与文件摘要"]]
        .filter(([slot]) => settings.textModelSelections?.[slot]?.supplierId === id).map(([, label]) => label);
    }
    function setStatus(id, message, kind = "idle") {
      messages.set(id, { message, kind });
      if (id === selectedId) {
        $("textSupplierStatus").textContent = message;
        $("textSupplierStatus").dataset.kind = kind;
      }
    }
    function resetDelete() {
      delete $("textSupplierDelete").dataset.confirm;
      $("textSupplierDelete").classList.remove("is-confirming");
      $("textSupplierDelete").title = "删除供应商";
    }
    function render(preferredId = selectedId) {
      const settings = getSettings();
      const suppliers = ui.listSuppliers(settings);
      selectedId = suppliers.some(item => item.id === preferredId) ? preferredId : suppliers[0]?.id || "";
      const entry = suppliers.find(item => item.id === selectedId);
      $("textSupplierCount").textContent = `${suppliers.length} 个供应商`;
      const query = $("textSupplierSearch").value.trim().toLowerCase();
      const visible = suppliers.filter(item => `${item.name} ${item.baseUrl}`.toLowerCase().includes(query));
      $("textSupplierEmpty").hidden = visible.length > 0;
      $("textSupplierEmpty").textContent = suppliers.length ? "没有匹配的供应商" : "尚未添加文本供应商";
      $("textSupplierCards").replaceChildren();
      for (const supplier of visible) {
        const card = document.createElement("button");
        card.type = "button"; card.className = "text-supplier-card";
        card.classList.toggle("is-active", supplier.id === selectedId);
        card.dataset.supplierId = supplier.id;
        card.setAttribute("role", "option"); card.setAttribute("aria-selected", String(supplier.id === selectedId));
        const heading = document.createElement("strong"); heading.textContent = supplier.name;
        const url = document.createElement("span"); url.className = "text-supplier-card-url"; url.textContent = supplier.baseUrl;
        const meta = document.createElement("span"); meta.className = "text-supplier-card-meta";
        meta.textContent = `${supplier.hasApiKey ? "已配置 Key" : "未配置 Key"} · ${ui.catalogModels(settings, supplier.id).length} 个模型`;
        card.append(heading, url, meta);
        card.addEventListener("click", () => render(supplier.id));
        $("textSupplierCards").append(card);
      }
      $("textSupplierEditorMode").textContent = entry?.name || "选择或添加供应商";
      $("textSupplierUrlLabel").textContent = entry?.baseUrl || "未配置";
      $("textSupplierProtocolLabel").textContent = entry ? entry.apiStyle === "responses" ? "Responses" : "Chat Completions" : "—";
      $("textSupplierKeyLabel").textContent = entry?.hasApiKey ? "已配置 · 本机保存" : "未配置";
      $("textSupplierUsageLabel").textContent = entry ? usedBy(settings, entry.id).join("、") || "未分配" : "—";
      const models = ui.catalogModels(settings, selectedId);
      const catalog = settings.textSupplierCatalogs?.[selectedId];
      const date = new Date(catalog?.updatedAt || "");
      $("textSupplierCatalogMeta").textContent = `${models.length} 个模型${Number.isNaN(date.getTime()) ? "" : ` · ${date.toLocaleString()}`}`;
      $("textSupplierModelPreview").replaceChildren();
      for (const model of models) {
        const span = document.createElement("span"); span.textContent = model;
        $("textSupplierModelPreview").append(span);
      }
      if (!models.length) $("textSupplierModelPreview").textContent = "暂无模型";
      const testSelect = $("textSupplierTestModel");
      const previous = testSelect.value;
      testSelect.replaceChildren();
      for (const model of models) option(testSelect, model);
      for (const pair of Object.values(settings.textModelSelections || {})) {
        if (pair?.supplierId === selectedId && pair.modelId && !models.includes(pair.modelId)) option(testSelect, pair.modelId);
      }
      if ([...testSelect.options].some(item => item.value === previous)) testSelect.value = previous;
      if (!testSelect.options.length) option(testSelect, "请选择或添加模型");
      testSelect.disabled = !entry || requestBusy;
      for (const id of ["textSupplierEdit", "textSupplierDelete", "textSupplierRefresh", "textSupplierModelAdd"]) $(id).disabled = !entry || requestBusy;
      $("textSupplierManualModel").disabled = !entry || requestBusy;
      $("textSupplierTest").disabled = !entry || requestBusy || !testSelect.options.length || testSelect.value === "请选择或添加模型";
      resetDelete();
      const status = messages.get(selectedId);
      $("textSupplierStatus").textContent = status?.message || "";
      $("textSupplierStatus").dataset.kind = status?.kind || "idle";
    }

    function renderPresets() {
      const query = $("supplierPresetSearch").value.trim().toLowerCase();
      const presets = ui.SUPPLIER_PRESETS.filter(preset => `${preset.name} ${preset.category}`.toLowerCase().includes(query));
      $("supplierPresetGrid").replaceChildren();
      $("supplierPresetEmpty").hidden = presets.length > 0;
      for (const preset of presets) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "supplier-preset"; button.dataset.preset = preset.id;
        button.dataset.category = preset.id; button.setAttribute("role", "radio");
        button.setAttribute("aria-checked", String(preset.id === selectedPreset));
        const mark = document.createElement("span"); mark.className = "supplier-preset-mark"; mark.textContent = preset.mark;
        const text = document.createElement("span");
        const name = document.createElement("strong"); name.textContent = preset.name;
        const category = document.createElement("small"); category.textContent = preset.category;
        text.append(name, category); button.append(mark, text);
        button.addEventListener("click", () => {
          selectedPreset = preset.id;
          $("textSupplierName").value = preset.id === "custom" ? "" : ui.uniqueSupplierName(preset.name, getSettings());
          $("textSupplierBaseUrl").value = preset.baseUrl;
          $("textSupplierApiStyle").value = preset.apiStyle;
          $("textSupplierAuthStyle").value = preset.authStyle || "bearer";
          // A new preset never clears or borrows the key typed for this draft.
          dirty = true; idManuallyEdited = false; updateDraft(); renderPresets();
        });
        $("supplierPresetGrid").append(button);
      }
    }
    function updateDraft() {
      if (!editingId && !idManuallyEdited) $("textSupplierId").value = ui.uniqueSupplierId($("textSupplierName").value, getSettings());
      const endpoint = ui.supplierEndpoint($("textSupplierBaseUrl").value, $("textSupplierApiStyle").value);
      $("supplierEndpointPreview").textContent = endpoint ? `POST ${endpoint}` : "";
      $("supplierDraftStatus").textContent = "";
      $("supplierDiscardConfirm").hidden = true;
    }
    function open(id = "") {
      if (requestBusy || saving || dialog.open) return;
      lastFocus = document.activeElement;
      const settings = getSettings();
      const entry = settings.textSuppliers?.find(item => item.id === id);
      if (id && !entry) return;
      editingId = entry?.id || ""; selectedPreset = "custom"; dirty = false; idManuallyEdited = false;
      $("supplierPresetSection").hidden = Boolean(entry);
      $("supplierPresetSearch").value = "";
      $("supplierDialogTitle").textContent = entry ? "编辑供应商" : "添加供应商";
      $("textSupplierSave").textContent = entry ? "保存修改" : "添加供应商";
      $("textSupplierName").value = entry?.name || "";
      $("textSupplierBaseUrl").value = entry?.baseUrl || "";
      $("textSupplierApiStyle").value = entry?.apiStyle || "chat-completions";
      $("textSupplierAuthStyle").value = entry?.authStyle || "bearer";
      $("textSupplierApiKey").value = entry?.apiKey || "";
      $("textSupplierApiKey").type = "password";
      const toggle = document.querySelector('[data-secret-toggle="textSupplierApiKey"]');
      toggle?.setAttribute("aria-label", "显示 API Key"); toggle?.setAttribute("aria-pressed", "false");
      $("textSupplierInitialModel").value = "";
      $("textSupplierId").value = entry?.id || "";
      $("textSupplierId").readOnly = Boolean(entry);
      $("supplierAdvancedDetails").open = false;
      renderPresets(); updateDraft(); dialog.showModal(); $("textSupplierName").focus();
    }
    function close(force = false) {
      if (saving) return;
      if (dirty && !force) {
        $("supplierDiscardConfirm").hidden = false;
        $("supplierDiscardKeep").focus(); return;
      }
      dirty = false; dialog.close(); $("textSupplierApiKey").value = "";
      lastFocus?.focus();
    }
    async function save(event) {
      event.preventDefault();
      if (saving) return;
      try {
        const settings = getSettings();
        const entry = ui.supplierDraft(settings, {
          id: $("textSupplierId").value, name: $("textSupplierName").value, baseUrl: $("textSupplierBaseUrl").value,
          apiKey: $("textSupplierApiKey").value, apiStyle: $("textSupplierApiStyle").value, authStyle: $("textSupplierAuthStyle").value
        }, editingId);
        const initialModel = $("textSupplierInitialModel").value.trim();
        if (initialModel && !ui.modelIdOf(initialModel)) throw new Error("模型 ID 无效。");
        const next = { textSuppliers: settings.textSuppliers?.map(item => item.id === entry.id ? entry : item) || [] };
        if (!editingId) next.textSuppliers.push(entry);
        if (initialModel) {
          const catalog = settings.textSupplierCatalogs?.[entry.id] || { models: [], capabilities: {}, updatedAt: "" };
          next.textSupplierCatalogs = { ...settings.textSupplierCatalogs, [entry.id]: {
            ...catalog, models: [...new Set([...ui.catalogModels(settings, entry.id), initialModel])]
          } };
        }
        saving = true;
        document.querySelector(".supplier-dialog-body").inert = true;
        for (const id of [...editable, "textSupplierSave", "textSupplierCancel", "textSupplierClose"]) $(id).disabled = true;
        $("supplierDraftStatus").textContent = "正在保存…";
        const saved = await api.saveSettings(next);
        onSettings(saved); saving = false; dirty = false; close(true);
        setStatus(entry.id, "供应商已保存。", "success"); render(entry.id);
      } catch (error) {
        $("supplierDraftStatus").textContent = error.message || "保存失败，请重试。";
      } finally {
        saving = false;
        document.querySelector(".supplier-dialog-body").inert = false;
        for (const id of [...editable, "textSupplierSave", "textSupplierCancel", "textSupplierClose"]) $(id).disabled = false;
      }
    }
    async function runRequest(kind) {
      if (requestBusy || dialog.open || !selectedId) return;
      const id = selectedId;
      const settings = getSettings();
      const entry = settings.textSuppliers?.find(item => item.id === id);
      if (!entry?.apiKey) { setStatus(id, "请先编辑此供应商并填写 API Key。", "error"); return; }
      const modelId = $("textSupplierTestModel").value;
      requestBusy = true; render(id);
      setStatus(id, kind === "refresh" ? "正在获取模型…" : "正在测试所选模型…");
      try {
        const result = kind === "refresh" ? await api.listProviderModels({ supplierId: id }) : await api.testProviderConnection({ supplierId: id, modelId });
        if (!result?.ok || result.supplierId !== id) throw new Error(result?.error?.message || "供应商请求失败或返回结果不匹配。");
        if (kind === "refresh") {
          onSettings(await api.getSettings());
          setStatus(id, `已获取 ${result.count || result.models?.length || 0} 个模型。`, "success");
        } else setStatus(id, `模型 ${modelId} 连接可用 · ${result.latencyMs || 0} ms`, "success");
      } catch (error) {
        setStatus(id, `${error.message || "请求失败。"}${kind === "refresh" ? " 原有模型目录已保留，可手动添加模型。" : ""}`, "error");
      } finally { requestBusy = false; render(selectedId); }
    }
    async function addModel() {
      if (requestBusy || !selectedId) return;
      const id = selectedId;
      const model = ui.modelIdOf($("textSupplierManualModel").value);
      if (!model) { setStatus(id, "请填写有效模型 ID。", "error"); return; }
      const settings = getSettings();
      const models = ui.catalogModels(settings, id);
      if (models.includes(model)) { setStatus(id, "模型已存在。", "error"); return; }
      if (models.length >= 1000) { setStatus(id, "模型数量已达到 1000 个上限。", "error"); return; }
      requestBusy = true; render(id);
      try {
        const catalog = settings.textSupplierCatalogs?.[id] || { models: [], capabilities: {}, updatedAt: "" };
        onSettings(await api.saveSettings({ textSupplierCatalogs: { ...settings.textSupplierCatalogs, [id]: { ...catalog, models: [...models, model] } } }));
        $("textSupplierManualModel").value = ""; setStatus(id, "模型已添加。", "success");
      } catch { setStatus(id, "添加模型失败，请重试。", "error"); }
      finally { requestBusy = false; render(selectedId); }
    }
    async function remove() {
      if (!selectedId || requestBusy) return;
      const id = selectedId;
      const settings = getSettings();
      const uses = usedBy(settings, id);
      if (uses.length) { setStatus(id, `此供应商正用于${uses.join("、")}。请先切换这些功能的模型并保存，再删除。`, "error"); return; }
      const button = $("textSupplierDelete");
      if (button.dataset.confirm !== id) {
        button.dataset.confirm = id; button.classList.add("is-confirming"); button.title = "再次点击确认删除";
        setStatus(id, "再次点击删除图标确认。已生成的内容不受影响。", "warning"); return;
      }
      requestBusy = true; render(id);
      try {
        const catalogs = { ...settings.textSupplierCatalogs }; delete catalogs[id];
        const entry = settings.textSuppliers.find(item => item.id === id);
        const dismissed = [...new Set([...(settings.textSupplierDismissedMigrations || []), ...(entry?.migratedFrom ? [entry.migratedFrom] : [])])];
        onSettings(await api.saveSettings({ textSuppliers: settings.textSuppliers.filter(item => item.id !== id), textSupplierCatalogs: catalogs, textSupplierDismissedMigrations: dismissed }));
      } catch { setStatus(id, "删除失败，请重试。", "error"); }
      finally { requestBusy = false; render(selectedId); }
    }

    $("textSupplierAdd").addEventListener("click", () => open());
    $("textSupplierEdit").addEventListener("click", () => open(selectedId));
    $("textSupplierSearch").addEventListener("input", () => render());
    $("supplierPresetSearch").addEventListener("input", renderPresets);
    $("supplierPresetGrid").addEventListener("keydown", event => {
      const buttons = [...$("supplierPresetGrid").querySelectorAll("button")];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].click(); buttons[next].focus();
    });
    $("textSupplierForm").addEventListener("submit", save);
    $("textSupplierDelete").addEventListener("click", remove);
    $("textSupplierRefresh").addEventListener("click", () => runRequest("refresh"));
    $("textSupplierTest").addEventListener("click", () => runRequest("test"));
    $("textSupplierModelAdd").addEventListener("click", addModel);
    $("textSupplierManualModel").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void addModel(); } });
    $("textSupplierCancel").addEventListener("click", () => close());
    $("textSupplierClose").addEventListener("click", () => close());
    $("supplierDiscardKeep").addEventListener("click", () => { $("supplierDiscardConfirm").hidden = true; $("textSupplierName").focus(); });
    $("supplierDiscardAccept").addEventListener("click", () => close(true));
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    for (const id of editable) $(id).addEventListener("input", () => {
      dirty = true; if (id === "textSupplierId") idManuallyEdited = true; updateDraft();
    });
    return { render, open, close, isOpen: () => dialog.open };
  }
  if (typeof module === "object" && module.exports) module.exports = { createTextSupplierManager };
  root.TextSupplierManager = { createTextSupplierManager };
})(typeof window === "object" ? window : globalThis);
