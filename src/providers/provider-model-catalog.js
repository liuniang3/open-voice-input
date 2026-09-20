"use strict";

const { PROVIDER_FAMILIES, normalizeProviderConnection } = require("../settings/provider-connections");
const { resolveModelCapability } = require("../settings/model-capabilities");
const {
  OPENCODE_GO_USER_AGENT,
  createOpenCodeGoSessionId
} = require("./opencode-go-client");

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 1000;
const UNSAFE_MODEL_IDS = new Set(["__proto__", "prototype", "constructor"]);

function modelCatalogEndpoint(baseUrl) {
  const raw = String(baseUrl || "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("供应商 Base URL 无效。"), { code: "provider_base_url_invalid" });
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw Object.assign(new Error("供应商 Base URL 必须使用 HTTP 或 HTTPS。"), { code: "provider_base_url_invalid" });
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

function modelRows(body) {
  return Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : [];
}

function valueAtPath(value, path) {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function firstPositiveInteger(row, paths) {
  for (const path of paths) {
    const parsed = Number(valueAtPath(row, path));
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function extractProviderCapability(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const contextWindow = firstPositiveInteger(row, [
    ["context_window"], ["context_length"], ["max_context_window"], ["max_model_len"],
    ["capabilities", "context_window"], ["capabilities", "context_length"],
    ["limits", "context_window"], ["limits", "context_length"],
    ["top_provider", "context_length"], ["architecture", "context_length"]
  ]);
  const maxOutput = firstPositiveInteger(row, [
    ["max_output_tokens"], ["max_completion_tokens"], ["output_token_limit"],
    ["capabilities", "max_output_tokens"], ["capabilities", "max_completion_tokens"],
    ["limits", "max_output_tokens"], ["limits", "max_completion_tokens"],
    ["top_provider", "max_completion_tokens"]
  ]);
  const reasoning = String(
    valueAtPath(row, ["default_reasoning_effort"])
      ?? valueAtPath(row, ["reasoning_effort"])
      ?? valueAtPath(row, ["capabilities", "reasoning", "default"])
      ?? ""
  ).trim();
  return contextWindow || maxOutput || reasoning ? { contextWindow, maxOutput, reasoning } : null;
}

function extractModelCatalog(body) {
  const rows = modelRows(body);
  const byId = new Map();
  for (const row of rows) {
    const raw = typeof row === "string" ? row : row?.id ?? row?.name;
    const id = String(raw || "").trim();
    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || UNSAFE_MODEL_IDS.has(id)) continue;
    const capability = extractProviderCapability(row);
    if (byId.has(id)) {
      if (!byId.get(id) && capability) byId.set(id, capability);
      continue;
    }
    byId.set(id, capability);
    if (byId.size >= MAX_MODELS) break;
  }
  const models = [...byId.keys()].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const capabilities = {};
  for (const id of models) capabilities[id] = resolveModelCapability(id, byId.get(id));
  return { models, capabilities };
}

function extractModelIds(body) {
  return extractModelCatalog(body).models;
}

async function listProviderModels({ settings, provider, fetchImpl = null } = {}) {
  if (![PROVIDER_FAMILIES.OPENAI, PROVIDER_FAMILIES.OPENCODE_GO].includes(provider)) {
    throw Object.assign(new Error("该供应商连接暂不支持自动获取模型列表。"), {
      code: "provider_model_catalog_not_supported"
    });
  }
  const connection = normalizeProviderConnection(provider, settings?.providerConnections?.[provider]);
  if (!connection.apiKey) {
    const label = provider === PROVIDER_FAMILIES.OPENCODE_GO ? "OpenCode Go" : "OpenAI";
    throw Object.assign(new Error(`请先保存 ${label} API Key。`), { code: "provider_credentials_missing" });
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
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        Accept: "application/json",
        ...(provider === PROVIDER_FAMILIES.OPENCODE_GO ? {
          "User-Agent": OPENCODE_GO_USER_AGENT,
          "x-opencode-session": createOpenCodeGoSessionId("models")
        } : {})
      }
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
    const { models, capabilities } = extractModelCatalog(body);
    if (!models.length) {
      throw Object.assign(new Error("接口已连接，但没有返回可用的模型 ID。"), {
        code: "provider_model_catalog_empty"
      });
    }
    return { ok: true, provider, models, capabilities, count: models.length, latencyMs: Date.now() - startedAt };
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
  UNSAFE_MODEL_IDS,
  extractModelCatalog,
  extractModelIds,
  extractProviderCapability,
  listProviderModels,
  modelCatalogEndpoint,
  readTextLimited
};
