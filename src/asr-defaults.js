"use strict";

(function installAsrDefaults(root) {
  const FOLLOW_DICTATION = "__dictation__";
  const QWEN_BATCH = "qwen3-asr-flash";
  const QWEN_STREAM = "qwen-audio-3.0-asr-flash-streaming";
  const trim = value => String(value || "").trim();

  function dictationSelection(settings = {}, purpose = "file") {
    const model = trim(settings.asrModel) || QWEN_BATCH;
    const profile = settings.asrProfiles?.[model] || {};
    const provider = trim(profile.provider || settings.asrProvider)
      || (/^mimo/i.test(model) ? "mimo" : /^fun-asr/i.test(model) ? "fun-asr" : "qwen3-asr");
    if (provider === "mimo") return { provider, modelId: model };
    const realtime = trim(profile.realtimeModel || settings.asrRealtimeModel);
    if (purpose === "live") {
      const pattern = provider === "fun-asr" ? /^fun-asr-realtime(?:-\d{4}-\d{2}-\d{2})?$/
        : /^qwen-audio-3\.0-asr-flash-streaming(?:-\d{4}-\d{2}-\d{2})?$/;
      return { provider, modelId: pattern.test(realtime) ? realtime : pattern.test(model) ? model
        : provider === "fun-asr" ? "fun-asr-realtime" : QWEN_STREAM };
    }
    return { provider, modelId: /(?:realtime|streaming)/i.test(model)
      ? provider === "fun-asr" ? "fun-asr" : QWEN_BATCH : model };
  }

  function workspaceSelection(settings = {}, purpose = "file") {
    const live = purpose === "live";
    const flag = live ? "meetingRealtimeFollowDictation" : "meetingFileAsrFollowDictation";
    const stored = trim(live ? settings.meetingRealtimeModel || settings.meetingQwenModel : settings.meetingFileAsrModel);
    const followsDictation = settings[flag] === true || !stored || stored === FOLLOW_DICTATION;
    if (followsDictation) return { ...dictationSelection(settings, purpose), followsDictation: true };
    const profile = live ? settings.meetingRealtimeProfiles?.[stored] || settings.meetingQwenProfiles?.[stored]
      : settings.meetingFileAsrProfiles?.[stored];
    const provider = trim(profile?.provider || (!live && settings.meetingFileAsrProvider))
      || (/^mimo/i.test(stored) ? "mimo" : /^fun-asr/i.test(stored) ? "fun-asr" : "qwen3-asr");
    return { provider, modelId: stored, followsDictation: false };
  }

  function savedFollowPreferences(settings = {}) {
    return {
      meetingRealtimeFollowDictation: typeof settings.meetingRealtimeFollowDictation === "boolean"
        ? settings.meetingRealtimeFollowDictation : !trim(settings.meetingRealtimeModel || settings.meetingQwenModel),
      meetingFileAsrFollowDictation: typeof settings.meetingFileAsrFollowDictation === "boolean"
        ? settings.meetingFileAsrFollowDictation : !trim(settings.meetingFileAsrModel)
    };
  }

  function workspaceReadiness(settings = {}, purpose = "file", selection = workspaceSelection(settings, purpose)) {
    const { provider, modelId } = selection;
    const live = purpose === "live";
    const compatible = live
      ? modelId === "mimo-v2.5-asr" || /^(?:qwen-audio-3\.0-asr-flash-streaming|fun-asr-realtime)(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)
      : provider === "mimo" ? /^mimo-/i.test(modelId)
        : provider === "qwen3-asr" && /^qwen3-asr-/i.test(modelId) && !/(?:realtime|streaming)/i.test(modelId);
    if (!compatible) return { ready: false, message: "请选择与当前转录方式兼容的 ASR 模型。" };
    const family = /^mimo/i.test(modelId) ? "mimo" : "aliyun";
    const profiles = (live ? [settings.meetingRealtimeProfiles, settings.meetingQwenProfiles, settings.asrProfiles]
      : [settings.meetingFileAsrProfiles, settings.asrProfiles]).map(map => map?.[modelId]).filter(Boolean);
    let profile = profiles.find(entry => trim(entry.apiKey)) || profiles[0] || {};
    for (const prefix of live ? ["meetingQwen", "asr"] : ["meetingFileAsr", "asr"]) {
      if (!trim(profile.apiKey) && settings[`${prefix}Model`] === modelId && trim(settings[`${prefix}ApiKey`])) {
        profile = { apiKey: settings[`${prefix}ApiKey`], baseUrl: settings[`${prefix}BaseUrl`] };
      }
    }
    // Migrated ASR connections are authoritative, including a deliberately cleared key.
    const migrated = settings.asrConnections && typeof settings.asrConnections === "object";
    const shared = (migrated ? settings.asrConnections : settings.providerConnections)?.[family];
    const source = migrated || trim(shared?.apiKey) ? shared || {} : profile;
    const key = trim(source.apiKey) || (!migrated ? trim(live ? settings.meetingRealtimeApiKey : settings.meetingFileAsrApiKey) : "");
    if (!key) return { ready: false, message: "尚未配置当前 ASR 的 API Key，请在语音识别设置中添加供应商。" };
    const address = trim(source.baseUrl) || (family === "mimo" ? "https://api.xiaomimimo.com/v1" : "https://dashscope.aliyuncs.com");
    try {
      const url = new URL(address);
      if (url.protocol !== "https:" && !(live && family === "aliyun" && url.protocol === "wss:")) throw new Error();
      if (!migrated && !live && family === "aliyun" && /\/api\/v1\/?$/i.test(url.pathname)) throw new Error();
    } catch { return { ready: false, message: "当前 ASR 的 API 地址无效，请检查语音识别供应商设置。" }; }
    return { ready: true, message: "" };
  }

  const api = { FOLLOW_DICTATION, dictationSelection, workspaceSelection, savedFollowPreferences, workspaceReadiness };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AsrDefaults = api;
})(typeof window === "undefined" ? null : window);
