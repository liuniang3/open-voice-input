"use strict";

const { PROVIDER_FAMILIES, normalizeProviderConnection } = require("../settings/provider-connections");

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 1000;

function modelCatalogEndpoint(baseUrl) {
  const raw = String(baseUrl || "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("OpenAI Base URL 无效。"), { code: "provider_base_url_invalid" });
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw Object.assign(new Error("OpenAI Base URL 必须使用 HTTP 或 HTTPS。"), { code: "provider_base_url_invalid" });
  }
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path || "/v1"}/models`.replace(/\/{2,}/g, "/");
  return url.toString();
}

async function readTextLimited(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw Object.assign(new Error("模型列表响应过大。"), { code: "provider_model_catalog_too_large" });
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw Object.assign(new Error("模型列表响应过大。"), { code: "provider_model_catalog_too_large" });
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw Object.assign(new Error("模型列表响应过大。"), { code: "provider_model_catalog_too_large" });
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
}

function extractModelIds(body) {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : [];
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    const raw = typeof row === "string" ? row : row?.id ?? row?.name;
    const id = String(raw || "").trim();
    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_MODELS) break;
  }
  return ids.sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

async function listProviderModels({ settings, provider, fetchImpl = null } = {}) {
  if (provider !== PROVIDER_FAMILIES.OPENAI) {
    throw Object.assign(new Error("仅 OpenAI 兼容连接支持自动获取模型列表。"), {
      code: "provider_model_catalog_not_supported"
    });
  }
  const connection = normalizeProviderConnection(provider, settings?.providerConnections?.[provider]);
  if (!connection.apiKey) {
    throw Object.assign(new Error("请先保存 OpenAI API Key。"), { code: "provider_credentials_missing" });
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await (fetchImpl || globalThis.fetch.bind(globalThis))(modelCatalogEndpoint(connection.baseUrl), {
      method: "GET",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" }
    });
    if (!response.ok) {
      throw Object.assign(new Error(`获取模型列表失败（HTTP ${response.status}）。`), {
        code: "provider_model_catalog_http_error"
      });
    }
    const text = await readTextLimited(response);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("模型列表接口未返回有效 JSON。"), {
        code: "provider_model_catalog_invalid_json"
      });
    }
    const models = extractModelIds(body);
    if (!models.length) {
      throw Object.assign(new Error("接口已连接，但没有返回可用的模型 ID。"), {
        code: "provider_model_catalog_empty"
      });
    }
    return { ok: true, provider, models, count: models.length, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (timedOut) {
      throw Object.assign(new Error("获取模型列表超时（30 秒）。"), { code: "provider_model_catalog_timeout" });
    }
    if (error?.name === "AbortError") {
      throw Object.assign(new Error("获取模型列表已取消。"), { code: "provider_model_catalog_aborted" });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  MAX_MODELS,
  MAX_RESPONSE_BYTES,
  extractModelIds,
  listProviderModels,
  modelCatalogEndpoint,
  readTextLimited
};
