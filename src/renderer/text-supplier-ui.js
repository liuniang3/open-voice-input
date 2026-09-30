"use strict";

// Pure helpers for the text-supplier settings UI (stage 3C). Browser script and
// Node tests share this module: no DOM access, no credentials handling beyond
// opaque strings, and pair identity is always (supplierId, modelId).

const LEGACY_SUPPLIER_ID = "__legacy__";
const CUSTOM_MODEL_VALUE = "__custom__";
const PAIR_SEPARATOR = "::";

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
  return {
    id,
    name: trim(entry.name).slice(0, 120) || id,
    baseUrl: trim(entry.baseUrl).slice(0, 2048),
    apiStyle: entry.apiStyle === "responses" ? "responses" : "chat-completions",
    hasApiKey: Boolean(trim(entry.apiKey)),
    migratedFrom: trim(entry.migratedFrom).slice(0, 64),
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
    groups.push({ supplierId: LEGACY_SUPPLIER_ID, label: "已有连接（兼容）", models: legacy });
  }
  return { groups, selected, customValue: CUSTOM_MODEL_VALUE };
}

function supplierOptionLabel(supplier) {
  return supplier.hasApiKey ? supplier.name : `${supplier.name}（未配置 Key）`;
}

if (typeof module === "object" && module.exports) {
  module.exports = {
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
