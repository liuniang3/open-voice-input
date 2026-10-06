"use strict";

(function installHomeUi(root) {
  function shortcutKeys(value, platform) {
    const mac = platform === "darwin";
    return String(value || "CommandOrControl+Alt+M").split("+").map(key => ({
      CommandOrControl: mac ? "⌘" : "Ctrl", CmdOrCtrl: mac ? "⌘" : "Ctrl",
      Command: "⌘", Control: mac ? "⌃" : "Ctrl", Alt: mac ? "⌥" : "Alt",
      Shift: mac ? "⇧" : "Shift", Super: "Win", Plus: "+"
    })[key] || key).filter(Boolean);
  }

  function createHomeUi(win) {
    const doc = win.document;
    const $ = id => doc.getElementById(id);
    if (!$("homePanel")) return null;
    const api = win.mimoInput;
    let active = false;
    let revision = 0;
    let timer;
    let flight;
    let refreshPending = false;
    let snapshot;
    const number = value => Number(value || 0).toLocaleString("zh-CN");
    function error(message = "") {
      $("homeError").textContent = message;
      $("homeError").hidden = !message;
    }
    function badge(id, label, ready) {
      $(id).textContent = label;
      $(id).dataset.state = ready ? "ready" : "warning";
    }
    function recordDate(value) {
      const node = doc.createElement("time");
      const parsed = new Date(value);
      if (Number.isFinite(parsed.getTime())) {
        node.dateTime = parsed.toISOString();
        node.textContent = new Intl.DateTimeFormat("zh-CN", {
          month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
        }).format(parsed);
      } else node.textContent = "—";
      return node;
    }
    async function openVoiceHistory(requestId) {
      await api.openSettings();
      await win.setSettingsTab?.("history", { requestId });
    }
    function render(value) {
      snapshot = value;
      const usable = value.asrConfigured && value.hotkeyRegistered;
      const needsCleaner = value.transcriptionMode === "stable" && !value.cleanerConfigured;
      badge("homeReadyBadge", value.meetingRecording ? "会议录制中" : !value.asrConfigured ? "待配置"
        : !value.hotkeyRegistered ? "快捷键不可用" : needsCleaner ? "待配置表达整理" : "就绪", usable && !needsCleaner);
      badge("homeAsrConnection", value.asrConfigured ? "语音识别已配置" : "语音识别未配置", value.asrConfigured);
      badge("homeCleanerConnection", value.cleanerConfigured ? "表达整理已配置" : "表达整理未配置", value.cleanerConfigured);
      $("homeModeLabel").textContent = value.transcriptionMode === "stable" ? "稳定模式 · 识别后整理" : "快速模式 · 仅语音识别";
      $("homeSetupNotice").hidden = Boolean(value.asrConfigured);
      $("homeHotkeyKeys").replaceChildren();
      for (const key of shortcutKeys(value.hotkey, value.platform)) {
        const node = doc.createElement("kbd"); node.textContent = key; $("homeHotkeyKeys").appendChild(node);
      }
      for (const [id, period, field] of [["homeTodayCount", "today", "count"], ["homeTodayChars", "today", "characters"],
        ["homeWeekCount", "week", "count"], ["homeWeekChars", "week", "characters"]]) {
        $(id).textContent = value.usage ? number(value.usage[period]?.[field]) : "—";
      }
      $("homeMeetingOpen").setAttribute("aria-label", value.meetingRecording ? "返回实时会议转录页面" : "打开实时会议转录页面");
      $("homeRecentList").replaceChildren();
      const recent = value.recent || [];
      $("homeRecentEmpty").hidden = recent.length > 0;
      for (const record of recent) {
        const button = doc.createElement("button"); button.type = "button"; button.className = "home-recent-row";
        const icon = doc.createElement("img"); icon.src = `./brand/${record.kind === "file" ? "file" : "meeting"}.svg`; icon.alt = "";
        const title = doc.createElement("strong"); title.textContent = record.title;
        const kind = doc.createElement("span"); kind.textContent = record.kind === "file" ? "文件转写" : "实时会议";
        const meta = doc.createElement("span"); meta.className = "home-record-meta";
        meta.append(kind, recordDate(record.date));
        const arrow = doc.createElement("span"); arrow.className = "ui-icon icon-chevron"; arrow.setAttribute("aria-hidden", "true");
        button.append(icon, title, meta, arrow);
        button.disabled = value.meetingRecording && record.kind === "meeting";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            if (record.kind === "file") await win.FileTranscriptionUi.openWorkspace({ sessionId: record.id });
            else {
              await api.openMeetingWorkspace();
              await win.MeetingLiveUi.open();
              await win.MeetingLiveUi.openSession(record.id);
            }
          } catch { error("这条记录暂时无法打开，请在对应工作区刷新后重试。"); }
          finally { button.disabled = false; }
        });
        $("homeRecentList").appendChild(button);
      }
      $("homeVoiceRecentList").replaceChildren();
      const voiceRecent = value.voiceRecent || [];
      $("homeVoiceRecentEmpty").hidden = voiceRecent.length > 0;
      $("homeVoiceRecentEmpty").textContent = value.voiceHistoryUnavailable
        ? "语音记录暂时无法读取，点击刷新重试。" : "暂无语音输入记录";
      for (const record of voiceRecent) {
        const button = doc.createElement("button"); button.type = "button"; button.className = "home-recent-row";
        const icon = doc.createElement("span"); icon.className = "ui-icon icon-mic home-record-icon"; icon.setAttribute("aria-hidden", "true");
        const title = doc.createElement("strong"); title.textContent = record.preview;
        const mode = doc.createElement("span"); mode.textContent = record.transcriptionMode === "fast" ? "快速模式"
          : record.cleanupApplied ? "已整理" : "识别原文";
        const meta = doc.createElement("span"); meta.className = "home-record-meta";
        meta.append(mode, recordDate(record.createdAt));
        const arrow = doc.createElement("span"); arrow.className = "ui-icon icon-chevron"; arrow.setAttribute("aria-hidden", "true");
        button.append(icon, title, meta, arrow);
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await openVoiceHistory(record.requestId); }
          catch { error("语音记录暂时无法打开，请稍后重试。"); }
          finally { button.disabled = false; }
        });
        $("homeVoiceRecentList").appendChild(button);
      }
      error(value.usage ? "" : "使用统计暂时无法读取；转写功能不受影响。");
    }
    async function refresh() {
      if (!active || typeof api.getHomeOverview !== "function") return;
      if (flight) return flight;
      const epoch = revision;
      const request = Promise.resolve().then(async () => {
        try {
          const [value, history] = await Promise.all([
            api.getHomeOverview(),
            Promise.resolve().then(() => api.listVoiceHistory({ limit: 6 })).catch(() => ({ ok: false }))
          ]);
          if (active && epoch === revision) {
            if (!value?.ok) throw new Error("unavailable");
            render({ ...value, voiceRecent: history?.ok ? history.entries : [], voiceHistoryUnavailable: !history?.ok });
            if (value.onboarding?.status === "pending" && !win.OnboardingUi?.isOpen()) {
              await win.OnboardingUi?.open({ automatic: true });
            }
          }
        } catch { if (active && epoch === revision) error("主页数据暂时无法加载，点击刷新重试。"); }
        finally {
          if (flight === request) {
            flight = null;
            if (active && epoch === revision && refreshPending) {
              refreshPending = false;
              void refresh();
            }
          }
        }
      });
      flight = request;
      return request;
    }
    async function open() {
      if (!active) { active = true; revision++; timer = win.setInterval(() => { void refresh(); }, 60000); }
      await refresh();
    }
    function close() { active = false; revision++; flight = null; refreshPending = false; win.clearInterval(timer); }
    function requestRefresh() {
      if (!active) return;
      if (flight) refreshPending = true;
      else void refresh();
    }
    $("homeRefresh").addEventListener("click", requestRefresh);
    $("homeVoiceHistoryOpen").addEventListener("click", async () => {
      try { await openVoiceHistory(); }
      catch { error("语音记录暂时无法打开，请稍后重试。"); }
    });
    $("homeHotkeyEdit").addEventListener("click", async () => {
      await api.openSettings();
      win.setSettingsTab?.("asr");
      $("hotkeyInput").focus();
    });
    for (const id of ["homeGuideOpen", "homeSetupStart", "settingsGuideOpen"]) {
      $(id)?.addEventListener("click", () => { void win.OnboardingUi.open(); });
    }
    $("homeFileOpen").addEventListener("click", async () => {
      try { await win.FileTranscriptionUi.openWorkspace(); }
      catch { error("文件转写页面暂时无法打开，请稍后重试。"); }
    });
    $("homeMeetingOpen").addEventListener("click", async () => {
      try { await api.openMeetingWorkspace(); }
      catch { error("实时会议转录页面暂时无法打开，请稍后重试。"); }
    });
    api.onUsageUpdated?.(requestRefresh);
    api.onVoiceHistoryUpdated?.(requestRefresh);
    return { open, close, refresh, getSnapshot: () => snapshot };
  }

  if (typeof module === "object" && module.exports) module.exports = { createHomeUi, shortcutKeys };
  if (root?.document) root.HomeUi = createHomeUi(root);
})(typeof window === "undefined" ? null : window);
