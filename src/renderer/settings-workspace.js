"use strict";

(function (root) {
  const TABS = ["asr", "cleaner", "history", "updates"];
  const ALIASES = { general: "asr", "asr-connections": "asr", connections: "cleaner", meeting: "asr" };
  function settingsTab(value) {
    return TABS.includes(value) ? value : ALIASES[value] || "asr";
  }
  function nextSettingsTab(current, key) {
    if (key === "Home") return TABS[0];
    if (key === "End") return TABS.at(-1);
    const offset = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
    return TABS[(TABS.indexOf(settingsTab(current)) + offset + TABS.length) % TABS.length];
  }
  function releaseNotesText(notes, document) {
    if (typeof notes !== "string" || !notes.trim()) return "";
    if (!/<\/?[a-z][^>]*>/i.test(notes)) return notes.trim();
    // Template contents stay inert, including images; only text is rendered.
    const template = document.createElement("template");
    template.innerHTML = notes;
    const parsed = template.content;
    for (const node of parsed.querySelectorAll("script,style,iframe,object,img")) node.remove();
    for (const node of parsed.querySelectorAll("h1,h2,h3,h4,p,li,br")) {
      if (node.tagName === "LI") node.prepend("• ");
      node.append("\n");
    }
    return parsed.textContent.replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function renderRecognitionSettings(document, mode) {
    const $ = id => document.getElementById(id);
    const family = $("asrProviderSelect").value === "mimo" ? "mimo" : "aliyun";
    for (const group of document.querySelectorAll("[data-asr-connection]")) {
      group.hidden = group.dataset.asrConnection !== family;
    }
    const hasKey = Boolean($(family === "mimo" ? "mimoApiKeyInput" : "aliyunApiKeyInput").value.trim());
    $("asrConfigurationStatus").textContent = hasKey ? "已配置连接" : "尚未填写 API Key";
    $("asrConfigurationStatus").dataset.kind = hasKey ? "ready" : "missing";
    $("expressionModeNotice").textContent = mode === "fast"
      ? "当前为快速模式，语音输入不会执行表达整理；会议与文件摘要仍可独立使用。"
      : "当前为稳定模式，语音识别完成后使用下方模型进行表达整理。";
  }
  function setSupplierView(document, view) {
    const manager = view === "manager";
    for (const id of ["expressionModeNotice", "expressionModelSettings", "textSupplierOverview"]) {
      document.getElementById(id).hidden = manager;
    }
    document.getElementById("textSupplierManagerView").hidden = !manager;
    document.getElementById("textSupplierManage").setAttribute("aria-expanded", String(manager));
    return manager ? "manager" : "overview";
  }
  const exported = { TABS, settingsTab, nextSettingsTab, releaseNotesText, renderRecognitionSettings, setSupplierView };
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (root) root.SettingsWorkspace = exported;
})(typeof window === "undefined" ? null : window);
