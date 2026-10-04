"use strict";

// Named text-model supplier registry (stage 3A).
//
// Each entry is an isolated HTTPS Chat Completions / Responses compatible
// endpoint with its own Base URL, API key, API style, optional compatibility
// headers and a per-supplier model catalog cache. Identity is the
// (supplierId, modelId) pair: the same model ID offered by two suppliers never
// shares credentials, capabilities or the active selection, and lookups never
// infer a supplier from a model name. Legacy OpenCode Go settings migrate
// losslessly into generic entries. ASR connections are never consulted here.

const packageJson = require("../../package.json");
const { API_STYLES, DEFAULT_CONNECTIONS, connectionBaseUrl, normalizeApiStyle,
  providerFamilyFor, resolveProviderConnection } = require("./provider-connections");
const { resolveModelCapability } = require("./model-capabilities");

const SUPPLIER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UNSAFE_IDS = new Set(["__proto__", "prototype", "constructor"]);
const SECRET_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
const CAPABILITY_FIELDS = ["contextWindow", "maxOutput", "reasoning", "timeoutMs", "capabilitySource", "capabilityRevision", "capabilityManaged"];

const MAX_SUPPLIERS = 64;
const MAX_MODELS_PER_CATALOG = 1000;
const MAX_NAME_CHARS = 120;
const MAX_URL_CHARS = 2048;
const MAX_KEY_CHARS = 4096;
const MAX_HEADER_NAME_CHARS = 64;
const MAX_HEADER_VALUE_CHARS = 256;
const MAX_HEADERS = 16;
const MIGRATED_FROM_OPENCODE_GO = "opencode-go";

function trimStr(value) {
  return String(value ?? "").trim();
}

function sanitizeSupplierId(value) {
  const id = trimStr(value);
  return SUPPLIER_ID_RE.test(id) && !UNSAFE_IDS.has(id) ? id : "";
}

function isValidSupplierId(value) {
  return Boolean(sanitizeSupplierId(value));
}

function sanitizeModelId(value) {
  const id = trimStr(value).slice(0, 256);
  if (!id || UNSAFE_IDS.has(id) || /[\u0000-\u001f\u007f]/.test(id)) return "";
  return id;
}

function sanitizeHttpsBaseUrl(value) {
  const raw = trimStr(value).slice(0, MAX_URL_CHARS);
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  if (url.username || url.password) return "";
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function sanitizeRequestHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  let count = 0;
  for (const [rawName, rawValue] of Object.entries(value)) {
    if (count >= MAX_HEADERS) break;
    const name = trimStr(rawName).slice(0, MAX_HEADER_NAME_CHARS);
    if (!/^[A-Za-z0-9-]+$/.test(name)) continue;
    if (SECRET_HEADERS.has(name.toLowerCase())) continue;
    const headerValue = trimStr(rawValue).slice(0, MAX_HEADER_VALUE_CHARS);
    if (!headerValue || /[\u0000-\u001f\u007f]/.test(headerValue)) continue;
    out[name] = headerValue;
    count += 1;
  }
  return out;
}

function sanitizeApiKey(value) {
  return trimStr(value).slice(0, MAX_KEY_CHARS);
}

function supplierRequestHeaders(baseUrl, rawHeaders) {
  const headers = sanitizeRequestHeaders(rawHeaders);
  const url = new URL(baseUrl);
  if (url.host !== "opencode.ai" || url.pathname !== "/zen/go/v1") return headers;
  const names = new Set(Object.keys(headers).map(name => name.toLowerCase()));
  for (const [name, value] of Object.entries(openCodeGoCompatHeaders())) {
    if (!names.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

function normalizeTextSupplier(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = sanitizeSupplierId(raw.id);
  const baseUrl = sanitizeHttpsBaseUrl(raw.baseUrl);
  if (!id || !baseUrl) return null;
  const entry = {
    id,
    name: trimStr(raw.name).slice(0, MAX_NAME_CHARS) || id,
    baseUrl,
    apiStyle: normalizeApiStyle(raw.apiStyle, API_STYLES.CHAT_COMPLETIONS),
    authStyle: raw.authStyle === "api-key" ? "api-key" : "bearer",
    apiKey: sanitizeApiKey(raw.apiKey),
    requestHeaders: supplierRequestHeaders(baseUrl, raw.requestHeaders)
  };
  const migratedFrom = trimStr(raw.migratedFrom).slice(0, 64);
  if (migratedFrom) entry.migratedFrom = migratedFrom;
  return entry;
}

function normalizeTextModelSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const supplierId = sanitizeSupplierId(value.supplierId);
  const modelId = sanitizeModelId(value.modelId);
  return supplierId && modelId ? { supplierId, modelId } : null;
}

// Voice cleanup and meeting/file summary keep independent selections so the
// same model ID at two suppliers can never borrow the other's active pair.
const TEXT_MODEL_SELECTION_SLOTS = Object.freeze(["cleanup", "summary"]);

function normalizeTextModelSelections(value) {
  const out = {};
  for (const slot of TEXT_MODEL_SELECTION_SLOTS) {
    out[slot] = normalizeTextModelSelection(value && typeof value === "object" ? value[slot] : null);
  }
  return out;
}

function textModelSelectionFor(settings, slot) {
  if (!TEXT_MODEL_SELECTION_SLOTS.includes(slot)) return null;
  return normalizeTextModelSelection(settings?.textModelSelections?.[slot]);
}

function sanitizeCatalogModels(models) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(models)) return out;
  for (const raw of models) {
    if (out.length >= MAX_MODELS_PER_CATALOG) break;
    const id = sanitizeModelId(typeof raw === "string" ? raw : raw && (raw.id || raw.name));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sanitizeCapabilities(value, models) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const allowed = new Set(models);
  let count = 0;
  for (const [rawId, capability] of Object.entries(value)) {
    if (count >= MAX_MODELS_PER_CATALOG) break;
    const id = sanitizeModelId(rawId);
    if (!id || !allowed.has(id) || !capability || typeof capability !== "object" || Array.isArray(capability)) continue;
    const entry = {};
    for (const field of CAPABILITY_FIELDS) {
      const fieldValue = capability[field];
      if (field === "capabilityManaged" && typeof fieldValue === "boolean") {
        entry[field] = fieldValue;
      } else if (Number.isSafeInteger(fieldValue) && fieldValue > 0) {
        entry[field] = Math.floor(fieldValue);
      } else if (field === "reasoning" || field === "capabilitySource" || field === "capabilityRevision") {
        const text = trimStr(fieldValue).slice(0, 32);
        if (text) entry[field] = text;
      } else if (field !== "contextWindow" && field !== "maxOutput" && typeof fieldValue === "string") {
        const text = trimStr(fieldValue).slice(0, 32);
        if (text) entry[field] = text;
      }
    }
    if (Object.keys(entry).length) {
      out[id] = entry;
      count += 1;
    }
  }
  return out;
}

function normalizeCatalogEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const models = sanitizeCatalogModels(raw.models);
  const provided = sanitizeCapabilities(raw.capabilities, models);
  const capabilities = {};
  for (const model of models) {
    const capability = provided[model];
    if (capability?.capabilityManaged === false) {
      capabilities[model] = capability;
      continue;
    }
    capabilities[model] = {
      ...resolveModelCapability(model, capability),
      capabilityManaged: true
    };
  }
  return {
    models,
    capabilities,
    updatedAt: trimStr(raw.updatedAt).slice(0, 64)
  };
}

function catalogFor(settings, supplierId) {
  const id = sanitizeSupplierId(supplierId);
  const catalogs = settings?.textSupplierCatalogs;
  const entry = id && catalogs && typeof catalogs === "object"
    ? normalizeCatalogEntry(catalogs[id])
    : null;
  return entry || { models: [], capabilities: {}, updatedAt: "" };
}

function applySupplierCatalog(settings, supplierId, payload = {}) {
  const id = sanitizeSupplierId(supplierId);
  if (!id) return settings;
  const entry = normalizeCatalogEntry({
    models: payload.models,
    capabilities: payload.capabilities,
    updatedAt: trimStr(payload.updatedAt) || new Date().toISOString()
  });
  const current = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const catalogs = current.textSupplierCatalogs && typeof current.textSupplierCatalogs === "object"
    && !Array.isArray(current.textSupplierCatalogs) ? { ...current.textSupplierCatalogs } : {};
  const previous = normalizeCatalogEntry(catalogs[id]);
  if (previous) {
    for (const model of entry.models) {
      const previousCapability = previous.capabilities[model];
      if (previousCapability?.capabilityManaged === false) {
        entry.capabilities[model] = previousCapability;
      }
    }
  }
  catalogs[id] = entry;
  return { ...current, textSupplierCatalogs: catalogs };
}

function openCodeGoCompatHeaders() {
  return {
    "User-Agent": `open-voice-input/${packageJson.version}`,
    "x-opencode-session": "auto"
  };
}

// One-time, additive migration: legacy OpenCode Go connection + catalogs copy
// into a generic supplier entry. Legacy fields are never modified or removed.
function migrateTextSuppliers(settings) {
  const current = settings && typeof settings === "object" && !Array.isArray(settings) ? { ...settings } : {};
  const existing = Array.isArray(current.textSuppliers) ? current.textSuppliers : [];
  const alreadyMigrated = existing.some(raw => {
    const id = trimStr(raw && typeof raw === "object" ? raw.id : "");
    const from = trimStr(raw && typeof raw === "object" ? raw.migratedFrom : "");
    return id === MIGRATED_FROM_OPENCODE_GO || from === MIGRATED_FROM_OPENCODE_GO;
  });
  const legacyConnection = current.providerConnections && typeof current.providerConnections === "object"
    ? current.providerConnections[MIGRATED_FROM_OPENCODE_GO] : null;
  const legacyModels = sanitizeCatalogModels(current.openCodeGoModelCatalog);
  const legacyCapabilities = sanitizeCapabilities(current.openCodeGoModelCapabilities, legacyModels);
  const legacyUpdatedAt = trimStr(current.openCodeGoModelCatalogUpdatedAt).slice(0, 64);
  // A custom Base URL (or a key, or a cached catalog) is user intent. An
  // untouched default URL with an empty key stays unmigrated.
  const legacyBaseUrl = sanitizeHttpsBaseUrl(legacyConnection?.baseUrl);
  const defaultOpenCodeGoBase = sanitizeHttpsBaseUrl("https://opencode.ai/zen/go/v1");
  const hasCustomBaseUrl = Boolean(legacyBaseUrl) && legacyBaseUrl !== defaultOpenCodeGoBase;
  const hasLegacyData = Boolean(trimStr(legacyConnection?.apiKey)) || hasCustomBaseUrl || legacyModels.length > 0;
  const dismissed = Array.isArray(current.textSupplierDismissedMigrations)
    && current.textSupplierDismissedMigrations.includes(MIGRATED_FROM_OPENCODE_GO);
  if (!alreadyMigrated && !dismissed && hasLegacyData) {
    const entry = normalizeTextSupplier({
      id: MIGRATED_FROM_OPENCODE_GO,
      name: "OpenCode Go",
      baseUrl: legacyConnection?.baseUrl || "https://opencode.ai/zen/go/v1",
      apiKey: legacyConnection?.apiKey,
      apiStyle: legacyConnection?.apiStyle || API_STYLES.CHAT_COMPLETIONS,
      requestHeaders: openCodeGoCompatHeaders(),
      migratedFrom: MIGRATED_FROM_OPENCODE_GO
    });
    if (entry) {
      current.textSuppliers = [entry, ...existing];
      const catalogs = current.textSupplierCatalogs && typeof current.textSupplierCatalogs === "object"
        && !Array.isArray(current.textSupplierCatalogs) ? { ...current.textSupplierCatalogs } : {};
      if (!catalogs[entry.id] && legacyModels.length) {
        catalogs[entry.id] = {
          models: legacyModels,
          capabilities: legacyCapabilities,
          updatedAt: legacyUpdatedAt
        };
        current.textSupplierCatalogs = catalogs;
      }
    }
  }
  return current;
}

function migrateLegacyLanguageSuppliers(settings) {
  if (settings._languageSuppliersMigrated) return settings;
  const current = { ...settings };
  const suppliers = (Array.isArray(current.textSuppliers) ? current.textSuppliers : [])
    .map(normalizeTextSupplier).filter(Boolean);
  const catalogs = { ...(current.textSupplierCatalogs || {}) };
  const selections = normalizeTextModelSelections(current.textModelSelections);
  const oldPair = normalizeTextModelSelection(current.textModelSelection);
  const dismissed = new Set(current.textSupplierDismissedMigrations || []);
  const names = { mimo: "MiMo · 语言处理", aliyun: "阿里云 · 语言处理", openai: "OpenAI · 语言处理" };
  const groups = [
    { slot: "cleanup", model: current.cleanerModel, profiles: current.cleanerProfiles,
      fallback: { apiKey: current.cleanerApiKey, baseUrl: current.cleanerBaseUrl,
        apiStyle: current.cleanerApiStyle }, provider: current.cleanerProvider },
    { slot: "summary", model: current.meetingAnalysisModel, profiles: current.meetingAnalysisProfiles,
      fallback: { apiKey: current.meetingAnalysisApiKey, baseUrl: current.meetingAnalysisBaseUrl,
        apiStyle: current.meetingAnalysisApiStyle } }
  ];
  for (const group of groups) {
    for (const modelId of new Set([group.model, ...Object.keys(group.profiles || {})].filter(Boolean))) {
      if (!sanitizeModelId(modelId) || /(?:^|-)asr(?:-|$)/i.test(modelId)) continue;
      const profile = group.profiles?.[modelId] || group.fallback;
      const provider = profile.provider || profile.providerFamily || group.provider;
      const family = providerFamilyFor(modelId, provider);
      const connection = resolveProviderConnection(current, {
        modelId, provider, scope: "text", operation: "compatible", fallback: profile
      });
      const defaultUrl = family && connectionBaseUrl(family, DEFAULT_CONNECTIONS[family], "compatible");
      const baseUrl = sanitizeHttpsBaseUrl(connection.baseUrl);
      if (!baseUrl || (!connection.apiKey && baseUrl === defaultUrl)) continue;
      const marker = `language-${family || "custom"}`;
      if (dismissed.has(marker) || family === "opencode-go" && dismissed.has(MIGRATED_FROM_OPENCODE_GO)) continue;
      const authStyle = family === "mimo" ? "api-key" : "bearer";
      const headers = family === "opencode-go" ? openCodeGoCompatHeaders() : {};
      let entry = suppliers.find(item => item.baseUrl === baseUrl && item.apiKey === connection.apiKey
        && item.apiStyle === connection.apiStyle && (item.authStyle || "bearer") === authStyle
        && JSON.stringify(item.requestHeaders || {}) === JSON.stringify(headers));
      if (!entry && suppliers.length < MAX_SUPPLIERS) {
        const baseId = `legacy-text-${family || "custom"}`;
        let id = baseId;
        for (let n = 2; suppliers.some(item => item.id === id); n += 1) id = `${baseId}-${n}`;
        const baseName = names[family] || "旧语言处理连接";
        let name = baseName;
        for (let n = 2; suppliers.some(item => item.name === name); n += 1) name = `${baseName} ${n}`;
        entry = normalizeTextSupplier({ id, name, ...connection, baseUrl, authStyle,
          requestHeaders: headers, migratedFrom: marker });
        if (entry) suppliers.push(entry);
      }
      if (!entry) continue;
      const catalog = normalizeCatalogEntry(catalogs[entry.id]) || { models: [], capabilities: {}, updatedAt: "" };
      if (!catalog.models.includes(modelId)) catalog.models.push(modelId);
      for (const field of CAPABILITY_FIELDS) {
        if (profile[field] == null) continue;
        catalog.capabilities[modelId] = { ...(catalog.capabilities[modelId] || {}), [field]: profile[field] };
      }
      if (family === "openai") {
        catalog.models = sanitizeCatalogModels([...catalog.models, ...(current.openaiModelCatalog || [])]);
        catalog.capabilities = { ...(current.openaiModelCapabilities || {}), ...catalog.capabilities };
      }
      catalogs[entry.id] = catalog;
      if (modelId === group.model && !selections[group.slot] && !oldPair) {
        selections[group.slot] = { supplierId: entry.id, modelId };
      }
    }
  }
  return { ...current, textSuppliers: suppliers, textSupplierCatalogs: catalogs,
    textModelSelections: selections, _languageSuppliersMigrated: true };
}

function ensureTextSuppliers(settings) {
  const initial = migrateTextSuppliers(settings);
  // Preserve the formerly shared pair before seeding any legacy slot.
  if (!initial.textModelSelections && normalizeTextModelSelection(initial.textModelSelection)) {
    const pair = normalizeTextModelSelection(initial.textModelSelection);
    initial.textModelSelections = { cleanup: { ...pair }, summary: { ...pair } };
  }
  const migrated = migrateLegacyLanguageSuppliers(initial);
  const seen = new Set();
  const suppliers = [];
  for (const raw of Array.isArray(migrated.textSuppliers) ? migrated.textSuppliers : []) {
    const entry = normalizeTextSupplier(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    suppliers.push(entry);
    if (suppliers.length >= MAX_SUPPLIERS) break;
  }
  const catalogs = {};
  const rawCatalogs = migrated.textSupplierCatalogs && typeof migrated.textSupplierCatalogs === "object"
    && !Array.isArray(migrated.textSupplierCatalogs) ? migrated.textSupplierCatalogs : {};
  for (const [rawId, rawEntry] of Object.entries(rawCatalogs)) {
    const id = sanitizeSupplierId(rawId);
    if (!id) continue;
    const entry = normalizeCatalogEntry(rawEntry);
    if (entry) catalogs[id] = entry;
    if (Object.keys(catalogs).length >= MAX_SUPPLIERS) break;
  }
  const legacySelection = normalizeTextModelSelection(migrated.textModelSelection);
  const selections = normalizeTextModelSelections(migrated.textModelSelections);
  if (legacySelection && !migrated.textModelSelections) {
    // First 3B load: the formerly shared pair seeds both slots as independent
    // values; afterwards each slot evolves on its own.
    for (const slot of TEXT_MODEL_SELECTION_SLOTS) {
      if (!selections[slot]) selections[slot] = { ...legacySelection };
    }
  }
  return {
    ...migrated,
    textSuppliers: suppliers,
    textSupplierCatalogs: catalogs,
    textModelSelection: legacySelection,
    textModelSelections: selections
  };
}

function listTextSuppliers(settings) {
  return ensureTextSuppliers(settings).textSuppliers.map(toPublicTextSupplier);
}

// Key-free view for IPC / logs. Secrets never leave the registry.
function toPublicTextSupplier(entry) {
  const supplier = normalizeTextSupplier(entry);
  if (!supplier) return null;
  return {
    id: supplier.id,
    name: supplier.name,
    baseUrl: supplier.baseUrl,
    apiStyle: supplier.apiStyle,
    authStyle: supplier.authStyle,
    hasApiKey: Boolean(supplier.apiKey),
    requestHeaders: supplier.requestHeaders,
    ...(supplier.migratedFrom ? { migratedFrom: supplier.migratedFrom } : {})
  };
}

function resolveTextSupplier(settings, supplierId) {
  const id = sanitizeSupplierId(supplierId);
  if (!id) return null;
  const list = Array.isArray(settings?.textSuppliers) ? settings.textSuppliers : [];
  for (const raw of list) {
    const entry = normalizeTextSupplier(raw);
    if (entry && entry.id === id) return entry;
  }
  return null;
}

// Pair-addressed resolution: never infer the supplier from a model name, so
// identical model IDs at two suppliers stay credential- and catalog-isolated.
function resolveTextModel(settings, selection = {}) {
  const supplierId = sanitizeSupplierId(selection.supplierId);
  const modelId = sanitizeModelId(selection.modelId);
  if (!supplierId || !modelId) return null;
  const supplier = resolveTextSupplier(settings, supplierId);
  if (!supplier) return null;
  return {
    supplierId: supplier.id,
    modelId,
    name: supplier.name,
    baseUrl: supplier.baseUrl,
    apiKey: supplier.apiKey,
    apiStyle: supplier.apiStyle,
    authStyle: supplier.authStyle,
    requestHeaders: { ...supplier.requestHeaders }
  };
}

module.exports = {
  CAPABILITY_FIELDS,
  MIGRATED_FROM_OPENCODE_GO,
  TEXT_MODEL_SELECTION_SLOTS,
  MAX_MODELS_PER_CATALOG,
  MAX_SUPPLIERS,
  applySupplierCatalog,
  catalogFor,
  ensureTextSuppliers,
  isValidSupplierId,
  listTextSuppliers,
  migrateTextSuppliers,
  migrateLegacyLanguageSuppliers,
  normalizeCatalogEntry,
  normalizeTextModelSelection,
  normalizeTextModelSelections,
  normalizeTextSupplier,
  openCodeGoCompatHeaders,
  resolveTextModel,
  resolveTextSupplier,
  sanitizeApiKey,
  sanitizeCatalogModels,
  sanitizeHttpsBaseUrl,
  sanitizeModelId,
  sanitizeRequestHeaders,
  sanitizeSupplierId,
  textModelSelectionFor,
  toPublicTextSupplier
};
