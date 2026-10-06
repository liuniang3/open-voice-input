"use strict";

(function (root) {
  const VOICE_SETTING_FIELDS = Object.freeze([
    "model", "asrProvider", "asrMode", "asrModel", "asrRealtimeModel",
    "asrApiKey", "asrBaseUrl", "asrLanguage", "asrEnableItn", "asrConnections",
    "cleanerProvider", "cleanerModel", "cleanerApiKey", "cleanerBaseUrl", "cleanerApiStyle",
    "providerConnections", "textSuppliers", "textSupplierCatalogs", "textModelSelections",
    "_languageSuppliersMigrated", "transcriptionMode", "requestTimeoutMs"
  ]);

  function createVoiceSettingsSnapshot(settings = {}) {
    // Freeze routing and nested model capabilities for this recording/retry.
    // Do not carry unrelated meeting, OSS or transcript settings into dictation.
    return structuredClone(Object.fromEntries(VOICE_SETTING_FIELDS
      .filter(field => Object.hasOwn(settings, field))
      .map(field => [field, settings[field]])));
  }

  const api = { createVoiceSettingsSnapshot };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VoiceSettingsSnapshot = api;
})(typeof window !== "undefined" ? window : globalThis);
