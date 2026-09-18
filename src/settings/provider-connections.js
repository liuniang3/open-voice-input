"use strict";

const PROVIDER_FAMILIES = Object.freeze({
  MIMO: "mimo",
  ALIYUN: "aliyun",
  OPENAI: "openai"
});

const API_STYLES = Object.freeze({
  CHAT_COMPLETIONS: "chat-completions",
  RESPONSES: "responses"
});

const DEFAULT_CONNECTIONS = Object.freeze({
  mimo: Object.freeze({ baseUrl: "https://api.xiaomimimo.com/v1", apiStyle: API_STYLES.CHAT_COMPLETIONS }),
  aliyun: Object.freeze({ baseUrl: "https://dashscope.aliyuncs.com", apiStyle: API_STYLES.CHAT_COMPLETIONS }),
  openai: Object.freeze({ baseUrl: "https://api.openai.com/v1", apiStyle: API_STYLES.RESPONSES })
});

function trimStr(value) {
  return String(value || "").trim();
}

function normalizeApiStyle(value, fallback = API_STYLES.CHAT_COMPLETIONS) {
  const style = trimStr(value).toLowerCase().replace(/_/g, "-");
  if (["responses", "response", "openai-responses"].includes(style)) return API_STYLES.RESPONSES;
  if (["chat-completions", "chat-completion", "chat", "completions"].includes(style)) {
    return API_STYLES.CHAT_COMPLETIONS;
  }
  return fallback;
}

function apiStyleFrom(value, fallback = API_STYLES.CHAT_COMPLETIONS) {
  return normalizeApiStyle(value?.apiStyle ?? value?.wireApi ?? value?.wire_api, fallback);
}

function providerFamilyFor(modelId, provider = "") {
  const model = trimStr(modelId).toLowerCase();
  const kind = trimStr(provider).toLowerCase();
  if (["mimo", "mimo-asr"].includes(kind)) return PROVIDER_FAMILIES.MIMO;
  if (["aliyun", "dashscope", "qwen", "qwen3", "qwen3-asr", "fun", "fun-asr", "aliyun-streaming"].includes(kind)) {
    return PROVIDER_FAMILIES.ALIYUN;
  }
  if (["openai", "gpt"].includes(kind)) return PROVIDER_FAMILIES.OPENAI;
  if (/^mimo(?:-|$)/.test(model)) return PROVIDER_FAMILIES.MIMO;
  if (/(?:^|[-_.])(qwen3?|fun-asr)(?:[-_.]|$)/.test(model)) return PROVIDER_FAMILIES.ALIYUN;
  if (/^(?:gpt|chatgpt)(?:-|$)/.test(model) || /^o[134](?:-|$)/.test(model)) return PROVIDER_FAMILIES.OPENAI;
  return "";
}

function normalizeProviderBaseUrl(family, value) {
  const fallback = DEFAULT_CONNECTIONS[family]?.baseUrl || "";
  const raw = trimStr(value) || fallback;
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw.replace(/\/+$/, "");
  }
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (family === PROVIDER_FAMILIES.ALIYUN) {
    url.protocol = url.protocol === "wss:" ? "https:" : url.protocol;
    url.pathname = url.pathname.replace(
      /\/(?:compatible-mode\/v1|api\/v1|api-ws\/v1\/(?:inference|realtime))$/i,
      ""
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function connectionBaseUrl(family, connection, operation = "default") {
  const root = normalizeProviderBaseUrl(family, connection?.baseUrl);
  if (family !== PROVIDER_FAMILIES.ALIYUN) return root;
  const suffixes = {
    compatible: "/compatible-mode/v1",
    rest: "/api/v1",
    streaming: "/api-ws/v1/inference",
    realtime: "/api-ws/v1/realtime"
  };
  try {
    const path = new URL(root).pathname.replace(/\/+$/, "");
    // Unrecognized legacy proxy paths are already operation endpoints. Origins
    // and known Ali paths are normalized to roots and can be adapted safely.
    if (path) return root;
  } catch {
    return root;
  }
  return `${root}${suffixes[operation] || ""}`;
}

function normalizeProviderConnection(family, value = {}) {
  const defaults = DEFAULT_CONNECTIONS[family] || {};
  return {
    apiKey: trimStr(value.apiKey),
    baseUrl: normalizeProviderBaseUrl(family, value.baseUrl || defaults.baseUrl),
    apiStyle: apiStyleFrom(value, defaults.apiStyle)
  };
}

function mergeProviderConnections(current, updates) {
  const before = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const patch = updates && typeof updates === "object" && !Array.isArray(updates) ? updates : {};
  const merged = { ...before };
  for (const family of Object.values(PROVIDER_FAMILIES)) {
    if (!Object.hasOwn(patch, family)) continue;
    const existing = before[family] && typeof before[family] === "object" ? before[family] : {};
    const incoming = patch[family] && typeof patch[family] === "object" ? patch[family] : {};
    merged[family] = { ...existing, ...incoming };
  }
  return merged;
}

function resolveProviderConnection(settings, {
  modelId,
  provider,
  operation = "default",
  fallback = {}
} = {}) {
  const family = providerFamilyFor(modelId, provider);
  const shared = family && settings?.providerConnections?.[family];
  const hasSharedKey = Boolean(trimStr(shared?.apiKey));
  const source = hasSharedKey || !trimStr(fallback?.apiKey) ? shared : fallback;
  const useShared = source === shared && shared && typeof shared === "object";
  return {
    family,
    apiKey: trimStr(source?.apiKey || fallback?.apiKey),
    baseUrl: useShared && family
      ? connectionBaseUrl(family, source, operation)
      : trimStr(source?.baseUrl).replace(/\/+$/, ""),
    apiStyle: apiStyleFrom(source)
  };
}

module.exports = {
  API_STYLES,
  DEFAULT_CONNECTIONS,
  PROVIDER_FAMILIES,
  apiStyleFrom,
  connectionBaseUrl,
  mergeProviderConnections,
  normalizeApiStyle,
  normalizeProviderBaseUrl,
  normalizeProviderConnection,
  providerFamilyFor,
  resolveProviderConnection
};
