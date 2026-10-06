"use strict";

(function (root) {
  function createVoiceHistoryUi({ document, api, onSettings = () => {} }) {
    const $ = id => document.getElementById(id);
    let opened = false;
    let revision = 0;
    let detailRevision = 0;
    let rows = [];
    let total = 0;
    let selected = null;
    let timer;
    function status(text, kind = "idle") {
      $("voiceHistoryStatus").textContent = text;
      $("voiceHistoryStatus").dataset.kind = kind;
    }
    const date = value => new Date(value).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    function renderList() {
      $("voiceHistoryList").replaceChildren();
      for (const row of rows) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "voice-history-row";
        button.classList.toggle("is-active", selected?.requestId === row.requestId);
        button.setAttribute("aria-pressed", String(selected?.requestId === row.requestId));
        const time = document.createElement("time"); time.dateTime = row.createdAt; time.textContent = date(row.createdAt);
        const preview = document.createElement("span"); preview.textContent = row.preview;
        button.append(time, preview);
        button.addEventListener("click", () => { void select(row.requestId); });
        $("voiceHistoryList").append(button);
      }
      $("voiceHistoryMore").hidden = rows.length >= total;
    }
    async function select(id) {
      const version = ++detailRevision;
      try {
        const result = await api.getVoiceHistory({ requestId: id });
        if (!opened || version !== detailRevision) return;
        if (!result?.ok || !result.entry) throw new Error("history unavailable");
        selected = result.entry;
        $("voiceHistoryDate").textContent = new Date(selected.createdAt).toLocaleString();
        $("voiceHistoryMeta").textContent = [selected.transcriptionMode === "fast" ? "快速模式" : selected.cleanupApplied ? "稳定模式 · 已整理" : "稳定模式 · 原文回退",
          selected.durationMs ? `${Math.round(selected.durationMs / 1000)} 秒` : "", selected.asrModel, selected.cleanupApplied ? selected.cleanerModel : ""].filter(Boolean).join(" · ");
        $("voiceHistoryRaw").textContent = selected.rawText;
        $("voiceHistoryResult").textContent = selected.text;
        $("voiceHistoryResultBlock").hidden = !selected.cleanupApplied;
        $("voiceHistoryDetail").hidden = false;
        renderList();
      } catch {
        if (opened && version === detailRevision) status("无法读取这条记录，请刷新后重试。", "error");
      }
    }
    async function load(more = false, requestId) {
      const version = ++revision;
      if (!more) detailRevision++;
      $("voiceHistoryMore").disabled = true;
      status("正在读取本机记录…");
      try {
        const result = await api.listVoiceHistory({ query: $("voiceHistorySearch").value.trim(), offset: more ? rows.length : 0 });
        if (!opened || version !== revision) return;
        if (!result?.ok) throw new Error("history unavailable");
        rows = more ? rows.concat(result.entries) : result.entries;
        total = result.total;
        status(total ? `共 ${total} 条记录` : $("voiceHistorySearch").value.trim() ? "没有匹配的记录。" : "还没有记录。新的语音输入完成后会显示在这里；旧版本未保存的记录无法补回。");
        if (!rows.some(row => row.requestId === selected?.requestId)) {
          selected = null; $("voiceHistoryDetail").hidden = true;
        }
        renderList();
        if (requestId) await select(requestId);
        else if (!selected && rows.length) await select(rows[0].requestId);
      } catch {
        if (opened && version === revision) status("历史记录暂时无法读取，语音输入不受影响。", "error");
      } finally {
        if (version === revision) $("voiceHistoryMore").disabled = false;
      }
    }
    async function copy(field) {
      if (!selected?.[field]) return;
      try {
        const result = await api.copyText(selected[field]);
        if (result?.ok === false) throw new Error("copy failed");
        status("已复制到剪贴板。");
      } catch { status("复制失败，请稍后重试。", "error"); }
    }
    $("voiceHistorySearch").addEventListener("input", () => {
      revision++; detailRevision++;
      clearTimeout(timer); timer = setTimeout(() => { if (opened) void load(); }, 250);
    });
    $("voiceHistoryRefresh").addEventListener("click", () => { void load(); });
    $("voiceHistoryMore").addEventListener("click", () => { void load(true); });
    $("voiceHistoryCopyRaw").addEventListener("click", () => { void copy("rawText"); });
    $("voiceHistoryCopyResult").addEventListener("click", () => { void copy("text"); });
    $("voiceHistoryEnabled").addEventListener("change", async () => {
      const checkbox = $("voiceHistoryEnabled"); checkbox.disabled = true;
      const enabled = checkbox.checked;
      try {
        const saved = await api.saveSettings({ voiceHistoryEnabled: enabled });
        onSettings(saved); status(enabled ? "已开启记录保存。" : "不再保存新的记录，已有记录仍可查看。");
      } catch { checkbox.checked = !enabled; status("设置保存失败，请重试。", "error"); }
      finally { checkbox.disabled = false; }
    });
    api.onVoiceHistoryUpdated?.(() => { if (opened) void load(); });
    return {
      open(settings, { requestId } = {}) {
        opened = true;
        if (requestId) {
          clearTimeout(timer);
          $("voiceHistorySearch").value = "";
          selected = null; $("voiceHistoryDetail").hidden = true;
        }
        $("voiceHistoryEnabled").checked = settings?.voiceHistoryEnabled !== false;
        return load(false, requestId);
      },
      close() { opened = false; revision++; detailRevision++; clearTimeout(timer); }
    };
  }
  if (typeof module === "object" && module.exports) module.exports = { createVoiceHistoryUi };
  if (root) root.VoiceHistoryUi = { createVoiceHistoryUi };
})(typeof window === "undefined" ? null : window);
