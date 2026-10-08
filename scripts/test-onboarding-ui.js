"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { createOnboardingUi } = require("../src/renderer/onboarding-ui");
const TextSupplierUi = require("../src/renderer/text-supplier-ui");
const AsrProviderInfo = require("../src/asr-provider-info");
const { ensureConnectionProfiles } = require("../src/settings/connection-profiles");
const { ensureTextSuppliers } = require("../src/settings/text-suppliers");
const html = fs.readFileSync(path.join(__dirname, "../src/renderer/index.html"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

function node(id, tag = "div") {
  return { id, tag, value: "", checked: false, children: [], firstChild: {}, dataset: {}, listeners: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, focus() {}, addEventListener(name, handler) { this.listeners[name] = handler; },
    replaceChildren() { this.children = []; if (this.tag === "select") this.value = ""; },
    appendChild(item) { this.children.push(item); if (this.tag === "select" && this.children.length === 1) this.value = item.value; }
  };
}

function fixture(patch = {}) {
  let settings = ensureTextSuppliers(ensureConnectionProfiles({ asrProvider: "mimo", asrModel: "mimo-v2.5-asr",
    asrMode: "realtime", transcriptionMode: "fast", textSuppliers: [], ...patch }));
  const nodes = new Map([...html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(m => [m[2], node(m[2], m[1])]));
  const $ = id => nodes.get(id);
  $("onboardingPanel").querySelectorAll = selector => [...nodes.values()].filter(item => selector === "button"
    ? item.tag === "button" : ["input", "select"].includes(item.tag));
  let failSave = false;
  const api = { openHome: async () => ({ ok: true }), getSettings: async () => structuredClone(settings),
    endHotkeyCapture: async () => {}, saveSettings: async patch => {
      if (failSave) throw new Error("fixture save unavailable");
      settings = ensureTextSuppliers(ensureConnectionProfiles({ ...settings, ...patch }));
      return structuredClone(settings);
    }, listProviderModels: async () => ({ ok: false, error: { message: "模型目录暂时不可用" } })
  };
  const ui = createOnboardingUi({ document: { getElementById: $, createElement: tag => node("", tag),
    querySelectorAll: () => [], querySelector: () => null, body: { classList: { add() {}, remove() {} } } },
    mimoInput: api, TextSupplierUi, AsrProviderInfo, navigator: { mediaDevices: { enumerateDevices: async () => [] } } });
  return { $, ui, settings: () => settings, failSave: value => { failSave = value; },
    async click(id) { $(id).listeners.click(); await tick(); },
    change(id, value) { $(id).value = value; $(id).listeners.change(); }
  };
}

async function cleanerStep(f) {
  await f.ui.open(); f.change("guideAsrProvider", "mimo"); f.$("guideAsrKey").value = "test-only-asr";
  await f.click("guideNext");
  assert.equal(f.$("onboardingProgress").textContent, "2 / 3");
  f.$("guideCleanupEnabled").checked = true;
  f.$("guideCleanupEnabled").listeners.change();
}

(async () => {
  const fresh = fixture();
  await fresh.ui.open();
  assert.equal(fresh.$("guideAsrProvider").value, "qwen3-asr");
  assert.equal(fresh.$("guideAsrModel").value, "qwen3-asr-flash");
  assert.equal(fresh.$("guideAsrMode").value, "realtime");
  assert.equal(fresh.$("guideAsrUrl").value, "https://dashscope.aliyuncs.com");
  assert.equal(fresh.$("guideAsrKey").value, "");
  assert.equal(fresh.$("guideAsrConsoleLabel").textContent, "Qwen API 控制台");
  assert.equal(fresh.settings().asrProvider, "mimo", "opening setup must not overwrite saved settings");

  const textOnly = fixture({ asrConnections: {}, providerConnections: { mimo: { apiKey: "test-only-text-key" } } });
  await textOnly.ui.open();
  assert.equal(textOnly.$("guideAsrProvider").value, "qwen3-asr", "a language-model key is not an ASR configuration");
  assert.equal(textOnly.$("guideAsrKey").value, "");

  const batch = fixture({ asrMode: "batch", asrApiKey: "test-only-saved-mimo" });
  await batch.ui.open();
  assert.equal(batch.$("guideAsrProvider").value, "mimo", "configured MiMo remains selected");
  assert.equal(batch.$("guideAsrMode").value, "batch");
  batch.$("guideAsrMode").value = "realtime"; batch.$("guideAsrKey").value = "test-only-mode-key";
  await batch.click("guideNext");
  assert.equal(batch.settings().asrMode, "realtime");
  assert.equal(batch.settings().asrProfiles["mimo-v2.5-asr"].mode, "realtime");

  for (const provider of ["qwen3-asr", "fun-asr"]) {
    const model = provider === "fun-asr" ? "fun-asr-realtime" : "qwen3-asr-flash-custom";
    const saved = fixture({ asrProvider: provider, asrModel: model, asrMode: "batch",
      asrApiKey: "test-only-saved-ali", asrBaseUrl: "https://example.invalid/custom" });
    await saved.ui.open();
    assert.equal(saved.$("guideAsrProvider").value, "qwen3-asr");
    assert.equal(saved.$("guideAsrModel").value, model);
    assert.equal(saved.$("guideAsrMode").value, "batch");
    assert.equal(saved.$("guideAsrKey").value, "test-only-saved-ali");
    assert.match(saved.$("guideAsrUrl").value, /^https:\/\/example\.invalid\/custom/);
  }
  console.log("PASS fresh onboarding defaults to Qwen without changing configured suppliers, custom models or credentials");

  for (const model of ["qwen3-asr-flash", "qwen-audio-3.0-asr-flash-streaming-2026-09-18"]) {
    const f = fixture(); await f.ui.open(); f.change("guideAsrProvider", "qwen3-asr");
    assert.equal(f.$("guideAsrMode").value, "realtime");
    f.$("guideAsrModel").value = model; f.$("guideAsrKey").value = "test-only-ali";
    await f.click("guideNext");
    assert.equal(f.settings().asrModel, "qwen3-asr-flash");
    assert.equal(f.settings().asrMode, "realtime");
    assert.equal(f.settings().asrRealtimeModel, model.includes("streaming") ? model : "qwen-audio-3.0-asr-flash-streaming");
  }
  console.log("PASS MiMo/Qwen realtime defaults, explicit batch preservation and matching profile persistence");

  const f = fixture({ textModelSelections: { summary: { supplierId: "other", modelId: "other-model" } } });
  await cleanerStep(f);
  f.change("guideCleanerPreset", "opencode-go");
  assert.equal(f.$("guideCleanerUrl").value, "https://opencode.ai/zen/go/v1");
  f.$("guideCleanerKey").value = "test-only-go";
  f.failSave(true); await f.click("guideCleanerSave");
  assert.equal(f.settings().textSuppliers.length, 0);
  assert.match(f.$("guideError").textContent, /unavailable/);
  assert.equal(f.$("guideCleanerSave").disabled, false);
  f.failSave(false); await f.click("guideCleanerSave");
  const id = f.$("guideCleanerSupplier").value;
  assert.notEqual(id, "__new__");
  assert.equal(f.$("guideCleanerSaveStatus").textContent, "供应商已保存");
  assert.equal(f.settings().textSuppliers.length, 1);
  assert.equal(f.settings().textSuppliers[0].authStyle, "bearer");
  await f.click("guideCleanerSave");
  assert.equal(f.settings().textSuppliers.length, 1, "saving an existing entry cannot create a duplicate");
  await f.click("guideCleanerFetch");
  assert.match(f.$("guideError").textContent, /模型目录暂时不可用/);
  f.$("guideCleanerModel").value = "my-fast-model";
  await f.click("guideNext");
  assert.equal(f.$("onboardingProgress").textContent, "3 / 3");
  assert.deepEqual(f.settings().textModelSelections.cleanup, { supplierId: id, modelId: "my-fast-model" });
  assert.deepEqual(f.settings().textModelSelections.summary, { supplierId: "other", modelId: "other-model" });
  assert.equal(f.settings().cleanerModel, "my-fast-model");
  assert.deepEqual(f.settings().textSupplierCatalogs[id].models, ["my-fast-model"]);
  assert.equal(f.settings().asrConnections.mimo.apiKey, "test-only-asr");
  console.log("PASS explicit supplier save, retry, no duplicate, unavailable catalogs and isolated manual model selection");

  const mimo = fixture(); await cleanerStep(mimo);
  mimo.change("guideCleanerPreset", "mimo-plan");
  assert.equal(mimo.$("guideCleanerAuthStyle").value, "api-key");
  assert.equal(mimo.$("guideCleanerUrl").value, "https://token-plan-cn.xiaomimimo.com/v1");
  mimo.$("guideCleanerKey").value = "test-only-mimo"; await mimo.click("guideCleanerSave");
  assert.equal(mimo.settings().textSuppliers[0].authStyle, "api-key");
  mimo.change("guideCleanerSupplier", "__new__");
  assert.equal(mimo.$("guideCleanerKey").value, "", "new suppliers cannot inherit another supplier key");
  mimo.$("guideCleanerName").value = "MiMo Token Plan";
  mimo.$("guideCleanerKey").value = "test-only-second"; await mimo.click("guideCleanerSave");
  assert.match(mimo.$("guideError").textContent, /同名/);
  assert.equal(mimo.settings().textSuppliers.length, 1);
  console.log("PASS shared presets, API-Key authentication, duplicate validation and credential isolation");
})().catch(error => { console.error(error); process.exitCode = 1; });
