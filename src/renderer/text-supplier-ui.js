"use strict";

// Pure helpers for the text-supplier settings UI (stage 3C). Browser script and
// Node tests share this module: no DOM access, no credentials handling beyond
// opaque strings, and pair identity is always (supplierId, modelId).

const LEGACY_SUPPLIER_ID = "__legacy__";
const CUSTOM_MODEL_VALUE = "__custom__";
const PAIR_SEPARATOR = "::";
const SUPPLIER_PRESETS = Object.freeze([
  { id: "custom", name: "自定义", mark: "+", category: "兼容服务", baseUrl: "", apiStyle: "chat-completions" },
  { id: "openai", name: "OpenAI", mark: "O", category: "官方", baseUrl: "https://api.openai.com/v1", apiStyle: "responses" },
  { id: "mimo", name: "MiMo", mark: "M", category: "官方", baseUrl: "https://api.xiaomimimo.com/v1", apiStyle: "chat-completions", authStyle: "api-key" },
  { id: "mimo-plan", name: "MiMo Token Plan", mark: "M", category: "订阅", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", apiStyle: "chat-completions", authStyle: "api-key" },
  { id: "aliyun", name: "阿里云百炼", mark: "A", category: "文本模型", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiStyle: "chat-completions" }
].map(preset => Object.freeze(preset)));

function uniqueSupplierId(name, settings) {
  const base = trim(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "provider";
  const used = new Set(listSuppliers(settings).map(item => item.id));
  let id = base;
  for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

function uniqueSupplierName(name, settings) {
  const used = new Set(listSuppliers(settings).map(item => item.name.toLowerCase()));
  let result = name;
  for (let suffix = 2; used.has(result.toLowerCase()); suffix += 1) result = `${name} ${suffix}`;
  return result;
}

function supplierEndpoint(baseUrl, apiStyle) {
  let url;
  try { url = new URL(trim(baseUrl)); } catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path || "/v1"}/${apiStyle === "responses" ? "responses" : "chat/completions"}`;
  return url.toString();
}

function supplierDraft(settings, draft, existingId = "") {
  const list = settings?.textSuppliers || [];
  const existing = list.find(item => item.id === existingId);
  if (existingId && !existing) throw new Error("此供应商已不存在，请重新打开配置。");
  const name = trim(draft.name);
  if (!name || name.length > 120) throw new Error("请填写供应商名称（不超过 120 字）。");
  if (list.some(item => item.id !== existingId && trim(item.name).toLowerCase() === name.toLowerCase())) throw new Error("已有同名供应商，请使用不同的名称。");
  const id = existingId || trim(draft.id) || uniqueSupplierId(name, settings);
  if (!supplierIdOf(id) || id === LEGACY_SUPPLIER_ID) throw new Error("内部标识只能包含英文字母、数字、点、横线和下划线。");
  if (!existingId && list.some(item => item.id === id)) throw new Error("内部标识已存在。");
  if (!existingId && list.length >= 64) throw new Error("最多可保存 64 个供应商。");
  const baseUrl = trim(draft.baseUrl).replace(/\/+$/, "");
  if (baseUrl.length > 2048 || !supplierEndpoint(baseUrl, draft.apiStyle)) throw new Error("请输入有效的 HTTPS Base URL，不包含账号、密码、查询参数或片段。");
  if (/\/(?:chat\/completions|responses|models)$/.test(new URL(baseUrl).pathname)) throw new Error("请填写基础地址（例如 /v1），不要填写完整请求路径。");
  if (!["chat-completions", "responses"].includes(draft.apiStyle)) throw new Error("请选择支持的 API 协议。");
  const apiKey = trim(draft.apiKey) || existing?.apiKey || "";
  if (apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new Error("API Key 格式无效。");
  return { ...existing, id, name, baseUrl, apiKey, apiStyle: draft.apiStyle, authStyle: draft.authStyle === "api-key" ? "api-key" : "bearer", requestHeaders: { ...(existing?.requestHeaders || {}) } };
}

function trim(value) {
  return String(value ?? "").trim();
}

function supplierIdOf(value) {
  const id = trim(value);
  return id === LEGACY_SUPPLIER_ID || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
    && !["__proto__", "prototype", "constructor"].includes(id) ? id : "";
}

function modelIdOf(value) {
  const id = trim(value).slice(0, 256);
  return id && !/[\u0000-\u001f\u007f]/.test(id) && id !== "__proto__" && id !== "prototype" && id !== "constructor"
    ? id : "";
}

function formatPair(supplierId, modelId) {
  return `${supplierIdOf(supplierId) || LEGACY_SUPPLIER_ID}${PAIR_SEPARATOR}${modelIdOf(modelId)}`;
}

function parsePair(value) {
  const raw = trim(value);
  const at = raw.indexOf(PAIR_SEPARATOR);
  if (at < 0) return { supplierId: "", modelId: modelIdOf(raw) };
  return {
    supplierId: supplierIdOf(raw.slice(0, at)),
    modelId: modelIdOf(raw.slice(at + PAIR_SEPARATOR.length))
  };
}

function publicSupplierView(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = supplierIdOf(entry.id);
  if (!id || id === LEGACY_SUPPLIER_ID) return null;
  const migratedFrom = trim(entry.migratedFrom).slice(0, 64);
  return {
    id,
    // Keep legacy migration visible as a normal generic connection instead of
    // advertising the retired provider-specific product entry.
    name: migratedFrom === "opencode-go" && entry.name === "OpenCode Go" ? "兼容旧供应商配置" : trim(entry.name).slice(0, 120) || id,
    baseUrl: trim(entry.baseUrl).slice(0, 2048),
    apiStyle: entry.apiStyle === "responses" ? "responses" : "chat-completions",
    hasApiKey: Boolean(trim(entry.apiKey)),
    migratedFrom,
    requestHeaders: entry.requestHeaders && typeof entry.requestHeaders === "object" ? entry.requestHeaders : {}
  };
}

function listSuppliers(settings) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(settings?.textSuppliers) ? settings.textSuppliers : []) {
    const view = publicSupplierView(entry);
    if (!view || seen.has(view.id)) continue;
    seen.add(view.id);
    out.push(view);
  }
  return out;
}

function catalogModels(settings, supplierId) {
  const id = supplierIdOf(supplierId);
  const entry = id && id !== LEGACY_SUPPLIER_ID ? settings?.textSupplierCatalogs?.[id] : null;
  const models = Array.isArray(entry?.models) ? entry.models : [];
  const out = [];
  const seen = new Set();
  for (const raw of models) {
    const model = modelIdOf(typeof raw === "string" ? raw : raw && (raw.id || raw.name));
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
    if (out.length >= 1000) break;
  }
  return out;
}

// Legacy text connections/profiles stay selectable so current users keep their
// working models without re-entering keys; they route through the old family
// fallback and never borrow a supplier's credentials.
function legacyModels(settings, slot) {
  if (settings?._languageSuppliersMigrated) return [];
  const out = [];
  const push = (value) => {
    const model = modelIdOf(value);
    if (model && !out.includes(model)) out.push(model);
  };
  const profiles = slot === "cleanup" ? settings?.cleanerProfiles : settings?.meetingAnalysisProfiles;
  for (const model of Object.keys(profiles || {})) push(model);
  if (slot === "cleanup") push(settings?.cleanerModel);
  else push(settings?.meetingAnalysisModel);
  for (const list of [settings?.openaiModelCatalog, settings?.openCodeGoModelCatalog]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) push(typeof entry === "string" ? entry : entry && (entry.id || entry.model));
  }
  return out;
}

function selectionFor(settings, slot) {
  const pair = settings?.textModelSelections?.[slot];
  const supplierId = supplierIdOf(pair?.supplierId);
  const modelId = modelIdOf(pair?.modelId);
  if (supplierId && supplierId !== LEGACY_SUPPLIER_ID && modelId) {
    return { supplierId, modelId, source: "supplier" };
  }
  if (settings?._languageSuppliersMigrated) return { supplierId: "", modelId: "", source: "" };
  const legacyModel = slot === "cleanup" ? settings?.cleanerModel : settings?.meetingAnalysisModel;
  const legacy = modelIdOf(legacyModel);
  return legacy
    ? { supplierId: LEGACY_SUPPLIER_ID, modelId: legacy, source: "legacy" }
    : { supplierId: "", modelId: "", source: "" };
}

// Persist an independent pair per slot. Supplier selections write
// textModelSelections[slot]; legacy selections clear the pair and keep the
// historical per-slot model field. Slots never share state.
function applySelection(settings, slot, selection) {
  const next = { ...(settings && typeof settings === "object" ? settings : {}) };
  const pairs = { ...(next.textModelSelections || {}) };
  const supplierId = supplierIdOf(selection?.supplierId);
  const modelId = modelIdOf(selection?.modelId);
  const legacyField = slot === "cleanup" ? "cleanerModel" : "meetingAnalysisModel";
  if (supplierId && supplierId !== LEGACY_SUPPLIER_ID && modelId) {
    pairs[slot] = { supplierId, modelId };
    // Mirror the model id for legacy readers; credentials stay untouched.
    next[legacyField] = modelId;
    if (slot === "summary") next.meetingAnalysisModel = modelId;
    if (slot === "cleanup") next.cleanerModel = modelId;
  } else if (modelId) {
    pairs[slot] = null;
    if (slot === "summary") next.meetingAnalysisModel = modelId;
    if (slot === "cleanup") next.cleanerModel = modelId;
  } else {
    pairs[slot] = null;
  }
  next.textModelSelections = pairs;
  return next;
}

// Option model for the model selects: groups per supplier (catalog models),
// one legacy group, and a custom entry for endpoints without /models.
function modelOptionGroups(settings, slot) {
  const groups = [];
  const selected = selectionFor(settings, slot);
  for (const supplier of listSuppliers(settings)) {
    groups.push({
      supplierId: supplier.id,
      label: supplier.name,
      models: catalogModels(settings, supplier.id)
    });
  }
  const legacy = legacyModels(settings, slot);
  if (legacy.length) {
    groups.push({ supplierId: LEGACY_SUPPLIER_ID, label: "旧语言处理配置（兼容）", models: legacy });
  }
  return { groups, selected, customValue: CUSTOM_MODEL_VALUE };
}

function supplierOptionLabel(supplier) {
  return supplier.hasApiKey ? supplier.name : `${supplier.name}（未配置 Key）`;
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    SUPPLIER_PRESETS,
    uniqueSupplierId,
    uniqueSupplierName,
    supplierEndpoint,
    supplierDraft,
    CUSTOM_MODEL_VALUE,
    LEGACY_SUPPLIER_ID,
    applySelection,
    catalogModels,
    formatPair,
    legacyModels,
    listSuppliers,
    modelOptionGroups,
    parsePair,
    selectionFor,
    supplierIdOf,
    supplierOptionLabel,
    modelIdOf
  };
}
if (typeof window !== "undefined") {
  window.TextSupplierUi = {
    SUPPLIER_PRESETS,
    uniqueSupplierId,
    uniqueSupplierName,
    supplierEndpoint,
    supplierDraft,
    CUSTOM_MODEL_VALUE,
    LEGACY_SUPPLIER_ID,
    applySelection,
    catalogModels,
    formatPair,
    legacyModels,
    listSuppliers,
    modelOptionGroups,
    parsePair,
    selectionFor,
    supplierIdOf,
    supplierOptionLabel,
    modelIdOf
  };
}
