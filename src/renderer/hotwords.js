"use strict";

(function (window) {
  const panels = new WeakMap();
  const PAGE_SIZE = 100;
  const errors = {
    hotword_invalid_term: "词条格式不符：含非 ASCII 字符时最多 15 个字符；纯 ASCII 最多 7 个词、80 个字符。",
    hotword_duplicate: "词条已存在，请编辑已有词条。",
    hotword_not_found: "词条或候选已被移除，请刷新后重试。",
    hotwords_limit: "词典已达上限，请删除词条后重试。",
    hotwords_unavailable: "热词服务暂不可用，请稍后刷新重试。",
    hotwords_active_limit: "最多启用 100 个词条，请先停用其他词条。",
    hotwords_import_encoding: "无法识别文件编码，请使用 UTF-8、带 BOM 的 UTF-16 或 GB18030 文本。",
    hotwords_import_size: "文件为空或超过 16 MiB，请选择非空且不超过 16 MiB 的文件。",
    hotwords_import_too_many_rows: "文件超过 10 万行或表格列数过多，请拆分或精简后重试。",
    hotwords_import_workbook_limit: "工作簿展开后过大或内容过多，请精简后重试。",
    hotwords_import_format: "文件格式无法读取，请选择支持的词库文件。",
    hotwords_import_sogou_format: "仅支持搜狗 SGPU .bin 词库；此文件版本不受支持或文件已损坏。",
    hotwords_import_timeout: "解析文件超时，请缩小文件后重试。",
    hotwords_import_busy: "已有词库正在导入，请稍后重试。",
    hotwords_import_expired: "导入预览已过期，请取消后重新选择文件。"
  };

  function safeError(reason, fallback = "保存失败，请重试。输入草稿已保留。") {
    const code = Object.keys(errors).find(key => reason?.code === key
      || new RegExp(`\\b${key}\\b`).test(String(reason?.message || "")));
    return errors[code] || fallback;
  }

  function validTerm(value) {
    if (!value) return false;
    return /[^\x00-\x7f]/.test(value) ? [...value].length <= 15
      : value.length <= 80 && value.split(/\s+/).length <= 7;
  }

  function create({ root, api }) {
    if (panels.has(root)) return panels.get(root);
    const document = root.ownerDocument;
    const $ = name => root.querySelector(`[data-hotwords="${name}"]`);
    const editor = $("editor");
    const text = $("text");
    const cancel = root.querySelector('[data-hotwords-action="cancel"]');
    let snapshot = null;
    let editingId = null;
    let saving = false;
    let destroyed = false;
    let composing = false;
    let generation = 0;
    let refreshAfterSave = false;
    let unsubscribe = null;
    let subscriptionFailed = false;
    let page = 0;
    let visibleEntries = [];
    let filteredCount = 0;
    const selected = new Set();
    let preview = null;
    let previewPage = 0;
    let deleting = false;
    let choosingImport = false;
    const actionButton = action => root.querySelector(`[data-hotwords-action="${action}"]`);
    const supported = ["getHotwords", "updateHotwords", "onHotwordsUpdated"]
      .every(name => typeof api?.[name] === "function");

    function error(message = "") {
      $("error").textContent = message;
      $("error").hidden = !message;
    }

    function node(tag, className, content) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (content !== undefined) element.textContent = content;
      return element;
    }

    function button(action, id, label, icon) {
      const element = node("button", icon ? "icon-btn" : "", icon ? undefined : label);
      element.type = "button";
      element.dataset.hotwordsAction = action;
      element.dataset.id = id;
      element.dataset.focusKey = `${action}:${id}`;
      element.title = label;
      element.setAttribute("aria-label", label);
      if (icon) {
        const image = node("span", `ui-icon icon-${icon}`);
        image.setAttribute("aria-hidden", "true");
        element.append(image);
      }
      return element;
    }

    function controls() {
      const busy = !snapshot || saving || destroyed;
      const unavailable = busy || Boolean(preview) || deleting;
      const full = snapshot && snapshot.entries.length >= snapshot.limit;
      for (const control of root.querySelectorAll("button, input")) control.disabled = unavailable;
      actionButton("refresh").disabled = saving || destroyed || !supported || Boolean(preview) || deleting;
      actionButton("import").disabled = unavailable || typeof api?.previewHotwordImport !== "function"
        || typeof api?.commitHotwordImport !== "function";
      actionButton("import").textContent = choosingImport ? "正在预览…" : "导入词库";
      actionButton("import-confirm").textContent = saving && preview ? "正在导入…" : "确认全部导入";
      actionButton("prev").disabled = unavailable || page === 0;
      actionButton("next").disabled = unavailable || (page + 1) * PAGE_SIZE >= filteredCount;
      actionButton("clear-selection").disabled = unavailable || !selected.size;
      actionButton("select-results").disabled = unavailable || !filteredCount;
      actionButton("remove-many").disabled = unavailable || !selected.size;
      $("select-page").disabled = unavailable || !visibleEntries.length;
      for (const action of ["import-cancel", "import-prev", "import-next", "import-confirm"]) {
        actionButton(action).disabled = busy || !preview;
      }
      if (preview) {
        actionButton("import-prev").disabled ||= previewPage === 0;
        actionButton("import-next").disabled ||= (previewPage + 1) * PAGE_SIZE >= preview.words.length;
        actionButton("import-confirm").disabled ||= !preview.words.length || preview.words.length > importCapacity();
      }
      actionButton("delete-cancel").disabled = busy || !deleting;
      actionButton("delete-confirm").disabled = busy || !deleting || !selected.size;
      $("observe").disabled = unavailable || !snapshot.observationAvailable || !snapshot.enabled;
      text.disabled = unavailable || (full && editingId === null);
      $("save").disabled = text.disabled || !text.value.trim();
      $("limit").hidden = !full;
      cancel.hidden = editingId === null;
      $("save").textContent = editingId === null ? "添加" : "保存";
      $("editor-label").textContent = editingId === null ? "添加词条" : "编辑词条";
      root.setAttribute("aria-busy", String(saving && !destroyed));
    }

    function renderSelection() {
      const count = visibleEntries.filter(entry => selected.has(entry.id)).length;
      $("select-page").checked = count > 0 && count === visibleEntries.length;
      $("select-page").indeterminate = count > 0 && count < visibleEntries.length;
      $("selection").textContent = `已选 ${selected.size} 条（本页 ${count} 条）`;
      $("delete-confirmation").hidden = !deleting;
      $("delete-message").textContent = `确认删除已选的 ${selected.size} 个词条？包含其他页及搜索结果之外的选择，删除后无法撤销。`;
      for (const checkbox of $("entries").querySelectorAll('[data-hotwords-action="select"]')) {
        checkbox.checked = selected.has(checkbox.dataset.id);
      }
    }

    function renderPreview() {
      $("import-preview").hidden = !preview;
      if (!preview) { $("import-words").replaceChildren(); return; }
      const { stats, words } = preview;
      $("import-file").textContent = `导入预览：${preview.fileName}`;
      $("import-stats").textContent = `共 ${stats.total} 条 · 新有效 ${stats.valid} 条 · 无效 ${stats.invalid} 条 · 文件内重复 ${stats.duplicates} 条 · 已存在 ${stats.existing} 条 · 剩余容量 ${importCapacity()} 条。确认将导入全部 ${words.length} 条。`;
      $("import-words").replaceChildren(...words.slice(previewPage * PAGE_SIZE, (previewPage + 1) * PAGE_SIZE)
        .map(word => node("li", "hotwords-row", word)));
      $("import-page").textContent = `第 ${previewPage + 1} / ${Math.max(1, Math.ceil(words.length / PAGE_SIZE))} 页 · 每页 ${PAGE_SIZE} 条`;
      $("import-capacity").hidden = words.length <= importCapacity();
      $("import-capacity").textContent = `需要 ${words.length} 条容量，当前剩余 ${importCapacity()} 条，无法全部导入。请取消后删除词条或缩小文件再重试。`;
    }

    function importCapacity() {
      return Math.max(0, Math.min(preview.stats.available, snapshot.limit - snapshot.entries.length));
    }

    function resetEditor() {
      editingId = null;
      text.value = "";
      text.removeAttribute("aria-invalid");
    }

    function restoreFocus(key) {
      if (!key) return;
      const replacement = [...root.querySelectorAll("[data-focus-key]")]
        .find(element => element.dataset.focusKey === key);
      (replacement || root.querySelector('[data-hotwords-action="refresh"]')).focus({ preventScroll: true });
    }

    function render() {
      if (!snapshot || destroyed) return;
      const focusKey = root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
      $("enabled").checked = snapshot.enabled;
      $("observe").checked = snapshot.observationAvailable && snapshot.observeCorrections;
      $("summary").textContent = snapshot.enabled ? "已启用" : "已停用";
      $("pending").textContent = `待确认 ${snapshot.candidates.length}`;
      $("count").textContent = `${snapshot.entries.length} / ${snapshot.limit}`;
      const enabledCount = snapshot.entries.filter(entry => entry.enabled).length;
      $("request-limit").textContent = `每次最多使用 ${snapshot.requestLimit || 100} 个启用词条，当前启用 ${enabledCount} 条；导入超出部分禁用。`;
      $("observation-note").textContent = snapshot.observationAvailable
        ? (snapshot.enabled
          ? (snapshot.observeCorrections ? "修正观察已开启，等待语音输入。" : "修正观察已关闭。")
          : "词典已停用，修正观察已暂停。")
        : "当前平台不可用；可手动管理词条。";
      const observationLabels = {
        observing: "正在观察本次输入。",
        candidate: "已收集候选，请在下方确认。",
        corrected: "已检查本次修正；符合词语规则时才生成候选。",
        unsupported: "上次输入框无法可靠跟踪，请手动添加词条。",
        "range-invalidated": "上次输入的文本范围发生变化，已停止收集；可手动添加词条。",
        "focus-changed": "已离开原输入窗口或控件，本次观察结束。",
        timeout: "本次观察已到时。",
        "spawn-error": "观察器未能启动，请重新启动程序后重试。",
        "helper-error": "观察器暂不可用，语音输入不受影响。",
        "protocol-error": "观察器暂不可用，语音输入不受影响。"
      };
      if (snapshot.observationAvailable && snapshot.enabled && snapshot.observeCorrections && observationLabels[snapshot.observationStatus]) {
        $("observation-note").textContent = observationLabels[snapshot.observationStatus];
      }

      const ids = new Set(snapshot.entries.map(entry => entry.id));
      for (const id of selected) if (!ids.has(id)) selected.delete(id);
      const query = $("search").value.trim().toLocaleLowerCase();
      const filtered = query ? snapshot.entries.filter(entry => entry.text.toLocaleLowerCase().includes(query)) : snapshot.entries;
      filteredCount = filtered.length;
      page = Math.min(page, Math.max(0, Math.ceil(filteredCount / PAGE_SIZE) - 1));
      visibleEntries = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      $("page").textContent = `第 ${page + 1} / ${Math.max(1, Math.ceil(filteredCount / PAGE_SIZE))} 页 · 共 ${filteredCount} 条 · 每页 ${PAGE_SIZE} 条`;
      const entries = visibleEntries.map(entry => {
        const row = node("li", "hotwords-row");
        const select = node("input", "hotwords-select");
        select.type = "checkbox";
        select.dataset.hotwordsAction = "select";
        select.dataset.id = entry.id;
        select.dataset.focusKey = `select:${entry.id}`;
        select.setAttribute("aria-label", `选择词条：${entry.text}`);
        select.title = `选择词条：${entry.text}`;
        const word = node("div", `hotwords-word${entry.enabled ? "" : " is-disabled"}`);
        word.append(node("span", "", entry.text));
        const enabled = node("label", "switch-field hotwords-entry-toggle");
        const checkbox = node("input");
        checkbox.type = "checkbox";
        checkbox.checked = entry.enabled;
        checkbox.dataset.hotwordsAction = "toggle";
        checkbox.dataset.id = entry.id;
        checkbox.dataset.focusKey = `toggle:${entry.id}`;
        checkbox.setAttribute("aria-label", `启用词条：${entry.text}`);
        checkbox.title = `启用词条：${entry.text}`;
        enabled.append(checkbox, node("span", "", "启用"));
        const actions = node("div", "hotwords-row-actions");
        actions.append(enabled, button("edit", entry.id, `编辑词条：${entry.text}`, "edit"),
          button("remove", entry.id, `删除词条：${entry.text}`, "close"));
        row.append(select, word, actions);
        return row;
      });
      $("entries").replaceChildren(...entries);
      $("entries-empty").hidden = entries.length !== 0;
      $("entries-empty").textContent = query ? "没有匹配的词条。" : "还没有词条。";
      renderSelection();
      renderPreview();

      const candidates = snapshot.candidates.map(candidate => {
        const row = node("li", "hotwords-row hotwords-candidate");
        const correction = node("div", "hotwords-correction");
        const arrow = node("span", "", "→");
        arrow.setAttribute("aria-label", "修正为");
        correction.append(node("span", "", candidate.from), arrow, node("span", "", candidate.to),
          node("small", "", `${candidate.count} 次`));
        const actions = node("div", "hotwords-row-actions");
        const accept = button("accept", candidate.id, "确认");
        accept.setAttribute("aria-label", `确认修正：${candidate.from} → ${candidate.to}`);
        actions.append(accept, button("dismiss", candidate.id, `忽略修正：${candidate.from} → ${candidate.to}`, "close"));
        row.append(correction, actions);
        return row;
      });
      $("candidates").replaceChildren(...candidates);
      $("candidates-empty").hidden = candidates.length !== 0;
      if (editingId !== null && !snapshot.entries.some(entry => entry.id === editingId)) {
        // Preserve the draft if another window removes the entry being edited.
        editingId = null;
        $("status").textContent = "正在编辑的词条已移除；草稿已保留，可重新添加。";
      }
      controls();
      restoreFocus(focusKey);
    }

    function subscribe() {
      if (unsubscribe) return;
      try {
        unsubscribe = api.onHotwordsUpdated(() => { void refresh(true); });
        subscriptionFailed = typeof unsubscribe !== "function";
      } catch {
        subscriptionFailed = true;
      }
    }

    async function refresh(preserveFeedback = false) {
      if (destroyed) return;
      if (!supported) {
        $("summary").textContent = "暂不可用";
        $("status").textContent = "";
        error("热词服务暂不可用，请更新或重新启动应用。");
        controls();
        return;
      }
      if (saving) { refreshAfterSave = true; return; }
      const request = ++generation;
      subscribe();
      try {
        const next = await api.getHotwords();
        if (destroyed || request !== generation) return;
        snapshot = next;
        if (!preserveFeedback) {
          error(subscriptionFailed ? "自动更新暂不可用，可使用刷新按钮重试。" : "");
          $("status").textContent = snapshot.enabled ? "修改即时保存。" : "词典已停用，词条保留；修改即时保存。";
        }
        render();
      } catch {
        if (destroyed || request !== generation) return;
        if (!snapshot) $("summary").textContent = "读取失败";
        $("status").textContent = "";
        error("无法读取热词词典，请使用刷新按钮重试。");
        controls();
      }
    }

    async function mutate(payload, message, clearEditor = false, importing = false) {
      if (destroyed || saving || !snapshot) return;
      const focusKey = root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
      saving = true;
      ++generation; // Reads started before this write must never overwrite its result.
      error();
      $("status").textContent = "正在保存…";
      controls();
      try {
        const next = await (importing ? api.commitHotwordImport(payload) : api.updateHotwords(payload));
        if (destroyed) return;
        snapshot = next;
        if (importing) preview = null;
        if (payload.action === "removeMany") { selected.clear(); deleting = false; }
        if (clearEditor) resetEditor();
        $("status").textContent = message;
      } catch (reason) {
        if (destroyed) return;
        $("status").textContent = "未保存，可重试。";
        error(safeError(reason));
      } finally {
        saving = false;
        if (!destroyed) {
          const mayFocus = document.activeElement === document.body || root.contains(document.activeElement);
          render();
          if (mayFocus) {
            restoreFocus(focusKey);
            if (importing && !preview) actionButton("import").focus({ preventScroll: true });
            if (payload.action === "removeMany" && !deleting) $("search").focus({ preventScroll: true });
            if (clearEditor && !text.disabled) text.focus({ preventScroll: true });
          }
          if (refreshAfterSave) { refreshAfterSave = false; void refresh(true); }
        }
      }
    }

    async function previewImport() {
      if (destroyed || saving || preview || !snapshot) return;
      choosingImport = true;
      saving = true;
      ++generation;
      error();
      $("status").textContent = "请选择词库文件，正在准备导入预览…";
      controls();
      try {
        const result = await api.previewHotwordImport();
        if (destroyed) return;
        preview = result;
        previewPage = 0;
        $("status").textContent = result ? "请核对预览，确认后导入全部有效词条。" : "已取消导入。";
      } catch (reason) {
        if (destroyed) return;
        $("status").textContent = "未导入。";
        error(safeError(reason, "无法预览词库文件，请检查文件后重新导入。输入草稿已保留。"));
      } finally {
        choosingImport = false;
        saving = false;
        if (!destroyed) {
          render();
          if (root.contains(document.activeElement) || document.activeElement === document.body) {
            actionButton(preview ? "import-cancel" : "import").focus({ preventScroll: true });
          }
          if (refreshAfterSave) { refreshAfterSave = false; void refresh(true); }
        }
      }
    }

    function click(event) {
      const target = event.target.closest("[data-hotwords-action]");
      if (!target || !root.contains(target) || target.disabled || destroyed) return;
      const action = target.dataset.hotwordsAction;
      const id = target.dataset.id;
      if (action === "refresh") { void refresh(); return; }
      if (saving || !snapshot) return;
      if (action === "import") { void previewImport(); return; }
      if (action === "import-cancel") {
        preview = null; error(); $("status").textContent = "已取消导入。";
        render(); actionButton("import").focus(); return;
      }
      if (action === "import-confirm" && preview) {
        void mutate({ token: preview.token }, `已导入 ${preview.words.length} 个词条。`, false, true); return;
      }
      if (action === "import-prev" || action === "import-next") {
        previewPage += action === "import-next" ? 1 : -1;
        renderPreview(); controls(); return;
      }
      if (action === "prev" || action === "next") {
        page += action === "next" ? 1 : -1;
        render(); $("entries").scrollTop = 0; return;
      }
      if (action === "clear-selection") { selected.clear(); renderSelection(); controls(); return; }
      if (action === "select-results") {
        const query = $("search").value.trim().toLocaleLowerCase();
        for (const entry of snapshot.entries) {
          if (!query || entry.text.toLocaleLowerCase().includes(query)) selected.add(entry.id);
        }
        renderSelection(); controls(); return;
      }
      if (action === "remove-many") {
        deleting = true; renderSelection(); controls(); actionButton("delete-cancel").focus(); return;
      }
      if (action === "delete-cancel") {
        deleting = false; error(); renderSelection(); controls(); actionButton("remove-many").focus(); return;
      }
      if (action === "delete-confirm") {
        void mutate({ action: "removeMany", ids: [...selected] }, `已删除 ${selected.size} 个词条。`); return;
      }
      if (action === "cancel") { resetEditor(); controls(); text.focus(); return; }
      if (action === "edit") {
        const entry = snapshot.entries.find(item => item.id === id);
        if (!entry) return;
        editingId = id;
        text.value = entry.text;
        text.removeAttribute("aria-invalid");
        controls();
        text.focus();
        return;
      }
      const messages = { remove: "词条已删除。", accept: "修正已确认，已加入词典。", dismiss: "已忽略该修正。" };
      if (messages[action]) void mutate({ action, id }, messages[action]);
    }

    function change(event) {
      const target = event.target;
      if (saving || destroyed || !snapshot || preview || deleting) return;
      if (target === $("select-page")) {
        for (const entry of visibleEntries) {
          if (target.checked) selected.add(entry.id); else selected.delete(entry.id);
        }
        renderSelection(); controls();
      } else if (target.dataset.hotwordsAction === "select") {
        if (target.checked) selected.add(target.dataset.id); else selected.delete(target.dataset.id);
        renderSelection(); controls();
      } else if (target === $("enabled")) {
        void mutate({ action: "configure", enabled: target.checked }, target.checked ? "词典已启用。" : "词典已停用，词条保留。");
      } else if (target === $("observe") && snapshot?.observationAvailable) {
        void mutate({ action: "configure", observeCorrections: target.checked }, target.checked ? "修正观察已开启。" : "修正观察已关闭。");
      } else if (target.dataset.hotwordsAction === "toggle") {
        const entry = snapshot?.entries.find(item => item.id === target.dataset.id);
        if (entry) void mutate({ action: "upsert", id: entry.id, text: entry.text, enabled: target.checked }, "词条状态已保存。");
      }
    }

    function submit(event) {
      event.preventDefault();
      if (composing || text.disabled) return;
      const value = text.value.trim();
      if (!validTerm(value)) {
        text.setAttribute("aria-invalid", "true");
        error(value ? errors.hotword_invalid_term : "请输入词条。");
        text.focus();
        return;
      }
      const entry = snapshot.entries.find(item => item.id === editingId);
      const payload = entry ? { action: "upsert", id: entry.id, text: value, enabled: entry.enabled }
        : { action: "upsert", text: value };
      void mutate(payload, entry ? "词条已更新。" : "词条已添加。", true);
    }

    function input() { text.removeAttribute("aria-invalid"); controls(); }
    function search() { page = 0; render(); $("entries").scrollTop = 0; }
    function composition(event) { composing = event.type === "compositionstart"; }
    function keydown(event) {
      if (composing || event.isComposing || event.keyCode === 229) {
        if (event.key === "Enter") event.preventDefault();
      } else if (event.key === "Escape" && !saving && editingId !== null) {
        event.preventDefault(); resetEditor(); controls(); text.focus();
      }
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      ++generation;
      try { if (typeof unsubscribe === "function") unsubscribe(); } catch { /* The host may already be closing. */ }
      root.removeEventListener("click", click);
      root.removeEventListener("change", change);
      editor.removeEventListener("submit", submit);
      editor.removeEventListener("keydown", keydown);
      text.removeEventListener("input", input);
      $("search").removeEventListener("input", search);
      text.removeEventListener("compositionstart", composition);
      text.removeEventListener("compositionend", composition);
      window.removeEventListener("pagehide", destroy);
      panels.delete(root);
      controls();
    }
    const panel = { refresh, destroy };
    panels.set(root, panel);
    root.addEventListener("click", click);
    root.addEventListener("change", change);
    editor.addEventListener("submit", submit);
    editor.addEventListener("keydown", keydown);
    text.addEventListener("input", input);
    $("search").addEventListener("input", search);
    text.addEventListener("compositionstart", composition);
    text.addEventListener("compositionend", composition);
    window.addEventListener("pagehide", destroy);
    controls();
    void refresh();
    return panel;
  }

  window.HotwordsPanel = { create };
  function init() {
    const root = window.document.getElementById("hotwordsPanel");
    if (root) create({ root, api: window.mimoInput });
  }
  if (window.document.readyState === "loading") window.document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})(window);
