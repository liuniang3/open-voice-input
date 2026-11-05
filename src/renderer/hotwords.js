"use strict";

(function (window) {
  const panels = new WeakMap();
  const errors = {
    hotword_invalid_term: "词条格式不符：含非 ASCII 字符时最多 15 个字符；纯 ASCII 最多 7 个词、80 个字符。",
    hotword_duplicate: "词条已存在，请编辑已有词条。",
    hotword_not_found: "词条或候选已被移除，请刷新后重试。",
    hotwords_limit: "词典已达上限，请删除词条后重试。",
    hotwords_unavailable: "热词服务暂不可用，请稍后刷新重试。"
  };

  function safeError(reason) {
    const code = Object.keys(errors).find(key => reason?.code === key
      || new RegExp(`\\b${key}\\b`).test(String(reason?.message || "")));
    return errors[code] || "保存失败，请重试。输入草稿已保留。";
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
      const unavailable = !snapshot || saving || destroyed;
      const full = snapshot && snapshot.entries.length >= snapshot.limit;
      for (const control of root.querySelectorAll("button, input")) control.disabled = unavailable;
      root.querySelector('[data-hotwords-action="refresh"]').disabled = saving || destroyed || !supported;
      $("observe").disabled = unavailable || !snapshot.observationAvailable || !snapshot.enabled;
      text.disabled = unavailable || (full && editingId === null);
      $("save").disabled = text.disabled || !text.value.trim();
      $("limit").hidden = !full;
      cancel.hidden = editingId === null;
      $("save").textContent = editingId === null ? "添加" : "保存";
      $("editor-label").textContent = editingId === null ? "添加词条" : "编辑词条";
      root.setAttribute("aria-busy", String(saving && !destroyed));
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
      $("observation-note").textContent = snapshot.observationAvailable
        ? (snapshot.enabled
          ? "开启后，最多观察 45 秒，仅处理本次输入范围内的词语替换。修正候选保存在本机，须手动确认；不支持的编辑器或边界修改会跳过。"
          : "词典已停用，修正观察已暂停；原有开关偏好保留。")
        : "当前平台不可用，仅 Windows 支持修正观察。热词词典仍可手动管理；修正记录保存在本机。";
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
        $("observation-note").textContent += ` ${observationLabels[snapshot.observationStatus]}`;
      }

      const entries = snapshot.entries.map(entry => {
        const row = node("li", "hotwords-row");
        const label = node("label", `switch-field hotwords-word${entry.enabled ? "" : " is-disabled"}`);
        const checkbox = node("input");
        checkbox.type = "checkbox";
        checkbox.checked = entry.enabled;
        checkbox.dataset.hotwordsAction = "toggle";
        checkbox.dataset.id = entry.id;
        checkbox.dataset.focusKey = `toggle:${entry.id}`;
        checkbox.setAttribute("aria-label", `启用词条：${entry.text}`);
        label.append(checkbox, node("span", "", entry.text));
        const actions = node("div", "hotwords-row-actions");
        actions.append(button("edit", entry.id, `编辑词条：${entry.text}`, "edit"),
          button("remove", entry.id, `删除词条：${entry.text}`, "close"));
        row.append(label, actions);
        return row;
      });
      $("entries").replaceChildren(...entries);
      $("entries-empty").hidden = entries.length !== 0;

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

    async function mutate(payload, message, clearEditor = false) {
      if (destroyed || saving || !snapshot) return;
      const focusKey = root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
      saving = true;
      ++generation; // Reads started before this write must never overwrite its result.
      error();
      $("status").textContent = "正在保存…";
      controls();
      try {
        const next = await api.updateHotwords(payload);
        if (destroyed) return;
        snapshot = next;
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
            if (clearEditor && !text.disabled) text.focus({ preventScroll: true });
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
      if (target === $("enabled")) {
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
