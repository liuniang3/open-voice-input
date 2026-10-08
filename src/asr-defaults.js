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

  const api = { FOLLOW_DICTATION, dictationSelection, workspaceSelection, savedFollowPreferences };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AsrDefaults = api;
})(typeof window === "undefined" ? null : window);
