"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ui = require("../src/renderer/text-supplier-ui");
const { ensureTextSuppliers, resolveTextModel } = require("../src/settings/text-suppliers");
const { resolveTextLlmProfile, createTextSupplierChat } = require("../src/providers/text-supplier-llm");
const { listProviderModels } = require("../src/providers/provider-model-catalog");
const root = path.resolve(__dirname, "..");

async function run() {
  const settings = { textSuppliers: [{ id: "first", name: "我的服务", baseUrl: "https://first.invalid/v1", apiKey: "test-only-key", apiStyle: "responses", requestHeaders: { "X-Client": "demo" } }] };
  const draft = { name: "备用服务", baseUrl: "https://second.invalid/v1/", apiStyle: "chat-completions", apiKey: "" };
  const next = ui.supplierDraft(settings, draft);
  assert.equal(next.id, "provider"); assert.equal(next.baseUrl, "https://second.invalid/v1");
  assert.equal(ui.uniqueSupplierId("Custom provider", { textSuppliers: [{ id: "custom-provider" }, { id: "custom-provider-2" }] }), "custom-provider-3");
  assert.equal(ui.uniqueSupplierName("我的服务", settings), "我的服务 2");
  const edited = ui.supplierDraft(settings, { ...draft, name: "改名", authStyle: "api-key" }, "first");
  assert.equal(edited.apiKey, settings.textSuppliers[0].apiKey);
  assert.equal(edited.id, "first"); assert.deepEqual(edited.requestHeaders, { "X-Client": "demo" });
  assert.throws(() => ui.supplierDraft(settings, { ...draft, name: "我的服务" }));
  assert.throws(() => ui.supplierDraft(settings, { ...draft, id: "first" }));
  assert.throws(() => ui.supplierDraft(settings, draft, "deleted"));
  for (const baseUrl of ["http://bad.invalid/v1", "https://user:secret@bad.invalid/v1", "https://bad.invalid/v1?key=secret", "https://bad.invalid/v1#bad", "invalid", "https://bad.invalid/v1/chat/completions"]) {
    assert.throws(() => ui.supplierDraft(settings, { ...draft, baseUrl }));
  }
  assert.equal(ui.supplierEndpoint("https://demo.invalid", "responses"), "https://demo.invalid/v1/responses");
  assert.equal(ui.supplierEndpoint("https://demo.invalid/prefix/v1/", "chat-completions"), "https://demo.invalid/prefix/v1/chat/completions");
  const presets = ui.SUPPLIER_PRESETS;
  assert.equal(new Set(presets.map(item => item.id)).size, presets.length);
  assert(presets.every(preset => !preset.apiKey && !preset.modelId), "presets must not carry keys or fixed model IDs");
  assert.equal(presets.find(item => item.id === "mimo-plan").authStyle, "api-key");
  const go = presets.find(item => item.id === "opencode-go");
  assert.deepEqual([go.baseUrl, go.apiStyle, go.authStyle, go.autoDiscoverModels],
    ["https://opencode.ai/zen/go/v1", "chat-completions", "bearer", true]);
  const legacy = { providerConnections: { "opencode-go": { baseUrl: "https://legacy.invalid/v1", apiKey: "test-only-legacy" } } };
  assert.equal(ensureTextSuppliers(legacy).textSuppliers.length, 1);
  assert.equal(ensureTextSuppliers({ ...legacy, textSupplierDismissedMigrations: ["opencode-go"] }).textSuppliers.length, 0, "deleted legacy supplier must not reappear");
  const removable = ensureTextSuppliers({ ...legacy, textSuppliers: [
    { id: "opencode-go", name: "Go", baseUrl: go.baseUrl, apiKey: "fixture-go", migratedFrom: "opencode-go" },
    { id: "keep", name: "Keep", baseUrl: "https://other.invalid/v1", apiKey: "fixture-other" }
  ], textSupplierCatalogs: { "opencode-go": { models: ["first"] }, keep: { models: ["second"] } },
  textModelSelection: { supplierId: "opencode-go", modelId: "first" },
  textModelSelections: { cleanup: { supplierId: "keep", modelId: "second" }, summary: { supplierId: "opencode-go", modelId: "first" } } });
  const removed = ui.supplierRemovalPatch(removable, "opencode-go");
  assert.equal(removed.textModelSelection, null);
  assert.equal(removed.textModelSelections.summary, null);
  assert.deepEqual(removed.textModelSelections.cleanup, removable.textModelSelections.cleanup);
  assert.deepEqual(Object.keys(removed.textSupplierCatalogs), ["keep"]);
  assert.equal(ensureTextSuppliers({ ...removable, ...removed }).textSuppliers.length, 1, "legacy Go must stay deleted");
  assert.throws(() => ui.supplierRemovalPatch(removable, "missing"));
  const authSettings = ensureTextSuppliers({ textSuppliers: [{ ...edited, id: "mimo", authStyle: "api-key" }] });
  assert.equal(resolveTextModel(authSettings, { supplierId: "mimo", modelId: "same-model" }).authStyle, "api-key");
  const profile = resolveTextLlmProfile(authSettings, { supplierId: "mimo", modelId: "same-model" });
  await createTextSupplierChat(profile, { fetchImpl: async (_url, options) => {
    assert.equal(options.headers["api-key"], edited.apiKey); assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
  } })([{ role: "user", content: "test" }]);
  await listProviderModels({ settings: authSettings, supplierId: "mimo", fetchImpl: async (_url, options) => {
    assert.equal(options.headers["api-key"], edited.apiKey); assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify({ data: [{ id: "same-model" }] }), { status: 200 });
  } });
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "src/renderer/renderer.js"), "utf8");
  assert.match(html, /<dialog id="textSupplierDialog"/);
  assert.match(html, /id="supplierPresetGrid"/);
  assert.match(html, /id="textSupplierDeleteDialog"/);
  assert.match(html, /id="textSupplierAuthStyle"/);
  assert.doesNotMatch(html, /OpenCode Go（实验性）/);
  assert.match(renderer, /if \(textSupplierManager\?\.isOpen\(\)\) return/);
  assert.doesNotMatch(renderer, /if \(textSupplierDraftDirty\) await saveTextSupplierDraft/);
  console.log("Supplier presets, draft validation, credential retention, auth routing and dismissed migration tests passed.");
}

async function verifySupplierBrowser(page, output) {
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const errors = await prepareBrowser(page);
  await page.evaluate(async () => { await window.mimoInput.saveSettings({ _languageSuppliersMigrated: true }); window.mockOpenSettings(); });
  await page.locator('[data-settings-tab="connections"]').click();
  await page.locator("#textSupplierAdd").click();
  assert(await page.locator("#textSupplierDialog").isVisible());
  await page.locator('[data-preset="mimo-plan"]').click();
  assert.equal(await page.locator("#textSupplierBaseUrl").inputValue(), "https://token-plan-cn.xiaomimimo.com/v1");
  assert.equal(await page.locator("#textSupplierAuthStyle").inputValue(), "api-key");
  assert.equal(await page.locator("#textSupplierApiKey").inputValue(), "");
  await page.locator("#supplierPresetSearch").fill("OpenAI");
  assert.equal(await page.locator("#supplierPresetGrid button").count(), 1);
  await page.locator("#supplierPresetSearch").fill("");
  await page.locator('[data-preset="custom"]').click();
  await page.locator("#textSupplierName").fill("演示网关");
  await page.locator("#textSupplierBaseUrl").fill("https://demo.example/v1");
  await page.locator("#textSupplierApiKey").fill("test-only-not-a-real-key");
  await page.locator("#textSupplierInitialModel").fill("demo-text-model");
  const before = await page.evaluate(() => window.mockCalls.filter(call => call.name === "saveSettings").length);
  for (const size of [{ width: 1180, height: 800 }, { width: 640, height: 480 }, { width: 390, height: 660 }]) {
    await page.setViewportSize(size);
    assert(await page.locator("#textSupplierSave").isVisible());
    const overflow = await page.locator("#textSupplierDialog").evaluate(el => ({ width: el.scrollWidth, client: el.clientWidth, rect: el.getBoundingClientRect().toJSON() }));
    assert(overflow.width <= overflow.client + 1, `dialog content overflow at ${size.width}`);
    assert(overflow.rect.left >= 0 && overflow.rect.right <= size.width, "dialog must fit viewport");
    assert(overflow.rect.bottom <= size.height, "footer must stay onscreen");
    await page.screenshot({ path: path.join(output, `supplier-add-${size.width}.png`) });
  }
  await page.locator("#textSupplierCancel").click();
  assert(await page.locator("#supplierDiscardConfirm").isVisible());
  await page.locator("#supplierDiscardKeep").click();
  await page.keyboard.press("Escape");
  assert(await page.locator("#supplierDiscardConfirm").isVisible());
  await page.locator("#supplierDiscardAccept").click();
  assert.equal(await page.locator("#textSupplierDialog").isVisible(), false);
  assert.equal(await page.evaluate(() => window.mockCalls.filter(call => call.name === "saveSettings").length), before, "cancel must never persist draft");
  assert.equal(await page.locator("#textSupplierApiKey").inputValue(), "", "close clears the secret draft");
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.locator("#textSupplierAdd").click();
  await page.locator("#textSupplierName").fill("演示网关");
  await page.locator("#textSupplierBaseUrl").fill("https://demo.example/v1");
  await page.locator("#textSupplierApiKey").fill("test-only-not-a-real-key");
  await page.locator("#textSupplierInitialModel").fill("demo-text-model");
  await page.locator("#textSupplierSave").click();
  await page.waitForFunction(() => !document.getElementById("textSupplierDialog").open);
  assert.equal(await page.locator("#textSupplierCards button").count(), 1);
  assert.equal(await page.locator("#textSupplierTestModel").inputValue(), "demo-text-model");
  await page.locator("#textSupplierEdit").click();
  assert.equal(await page.locator("#textSupplierApiKey").getAttribute("type"), "password");
  await page.locator('[data-secret-toggle="textSupplierApiKey"]').click();
  assert.equal(await page.locator("#textSupplierApiKey").getAttribute("type"), "text");
  assert.equal(await page.locator('[data-secret-toggle="textSupplierApiKey"] .ui-icon').count(), 1);
  await page.locator("#textSupplierApiKey").fill("");
  await page.locator("#textSupplierName").fill("演示网关（已编辑）");
  await page.locator("#textSupplierSave").click();
  await page.waitForFunction(() => !document.getElementById("textSupplierDialog").open);
  assert.equal(await page.evaluate(() => window.mockSettings().textSuppliers[0].apiKey), "test-only-not-a-real-key");
  await page.evaluate(() => {
    const original = window.mimoInput;
    window.supplierRequestMode = "failure";
    window.mockApiOverrides = {
      listProviderModels: async payload => {
        if (window.supplierRequestMode === "failure") return { ok: false, error: { message: "接口暂不可用" } };
        await original.saveSettings({ textSupplierCatalogs: { ...window.mockSettings().textSupplierCatalogs,
          [payload.supplierId]: { models: ["demo-text-model", "demo-fast-model"], updatedAt: "2026-10-02T01:00:00Z" } } });
        return { ok: true, supplierId: payload.supplierId, models: ["demo-text-model", "demo-fast-model"], count: 2 };
      },
      testProviderConnection: async payload => { window.supplierTestPayload = payload; return { ok: true, supplierId: payload.supplierId, latencyMs: 75 }; }
    };
  });
  await page.locator("#textSupplierRefresh").click();
  await page.waitForFunction(() => document.getElementById("textSupplierStatus").textContent.includes("原有模型目录已保留"));
  assert.equal(await page.locator("#textSupplierTestModel").inputValue(), "demo-text-model");
  await page.evaluate(() => { window.supplierRequestMode = "success"; });
  await page.locator("#textSupplierRefresh").click();
  await page.waitForFunction(() => document.getElementById("textSupplierStatus").textContent.includes("已获取 2"));
  await page.locator("#textSupplierTestModel").selectOption("demo-fast-model");
  await page.locator("#textSupplierTest").click();
  await page.waitForFunction(() => document.getElementById("textSupplierStatus").textContent.includes("连接可用"));
  assert.deepEqual(await page.evaluate(() => window.supplierTestPayload), { supplierId: "provider", modelId: "demo-fast-model" });
  await page.locator("#textSupplierManualModel").fill("manual-model");
  await page.locator("#textSupplierModelAdd").click();
  await page.waitForFunction(() => document.getElementById("textSupplierStatus").textContent.includes("模型已添加"));
  await page.locator("#textSupplierAdd").click();
  await page.locator('[data-preset="openai"]').click();
  await page.locator("#textSupplierName").fill("备用网关");
  await page.locator("#textSupplierBaseUrl").fill("https://backup.example/v1");
  await page.locator("#textSupplierApiKey").fill("test-only-backup-key");
  await page.locator("#textSupplierInitialModel").fill("demo-text-model");
  await page.locator("#textSupplierSave").click();
  await page.waitForFunction(() => !document.getElementById("textSupplierDialog").open);
  const ids = await page.evaluate(() => window.mockSettings().textSuppliers.map(item => item.id));
  assert.deepEqual(ids, ["provider", "provider-2"]);
  for (const size of [{ width: 1180, height: 800 }, { width: 640, height: 480 }, { width: 390, height: 660 }]) {
    await page.setViewportSize(size);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `supplier-list-${size.width}.png`) });
  }
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.evaluate(async () => {
    await window.mimoInput.saveSettings({ textModelSelections: {
      cleanup: { supplierId: "provider-2", modelId: "demo-text-model" },
      summary: { supplierId: "provider", modelId: "demo-text-model" }
    } });
    window.mockOpenSettings();
  });
  await page.locator('[data-settings-tab="connections"]').click();
  await page.locator('[data-supplier-id="provider-2"]').click();
  await page.locator("#textSupplierDelete").click();
  assert(await page.locator("#textSupplierDeleteDialog").isVisible());
  assert((await page.locator("#textSupplierDeleteUsage").textContent()).includes("语音表达整理"));
  await page.screenshot({ path: path.join(output, "supplier-delete-confirm.png") });
  await page.setViewportSize({ width: 390, height: 660 });
  assert.equal(await page.locator("#textSupplierDeleteMessage").evaluate(el => getComputedStyle(el).whiteSpace), "normal");
  await page.screenshot({ path: path.join(output, "supplier-delete-confirm-390.png") });
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.locator("#textSupplierDeleteCancel").click();
  assert.equal(await page.locator("#textSupplierCards button").count(), 2);
  await page.evaluate(() => {
    const save = window.mimoInput.saveSettings;
    window.mockApiOverrides.saveSettings = patch => {
      if (window.rejectSupplierDelete && patch.textSuppliers?.length === 1) throw new Error("fixture failure");
      return save(patch);
    };
    window.rejectSupplierDelete = true;
  });
  await page.locator('[data-supplier-id="provider-2"]').click();
  await page.locator("#textSupplierDelete").click();
  await page.locator("#textSupplierDeleteConfirm").click();
  await page.waitForFunction(() => document.getElementById("textSupplierDeleteError").textContent.includes("删除失败"));
  assert.equal(await page.locator("#textSupplierCards button").count(), 2);
  await page.evaluate(() => { window.rejectSupplierDelete = false; });
  await page.locator("#textSupplierDeleteConfirm").click();
  await page.waitForFunction(() => window.mockSettings().textSuppliers.length === 1);
  assert.equal(await page.locator("#textSupplierCards button").count(), 1);
  assert.deepEqual(await page.evaluate(() => window.mockSettings().textModelSelections), {
    cleanup: null, summary: { supplierId: "provider", modelId: "demo-text-model" }
  });
  assert.equal(await page.locator("#cleanupSupplierSelect").inputValue(), "");
  await page.locator("#textSupplierAdd").click();
  await page.locator('[data-preset="opencode-go"]').click();
  assert.equal(await page.locator("#textSupplierBaseUrl").inputValue(), "https://opencode.ai/zen/go/v1");
  assert.equal(await page.locator("#textSupplierApiStyle").inputValue(), "chat-completions");
  assert.equal(await page.locator("#textSupplierApiKey").inputValue(), "");
  await page.locator("#textSupplierApiKey").fill("fixture-go-only");
  await page.locator("#textSupplierSave").click();
  await page.waitForFunction(() => window.mockSettings().textSupplierCatalogs?.["opencode-go"]?.models?.length === 2);
  assert.equal(await page.locator("#textSupplierModelPreview span").count(), 2);
  assert.equal(await page.locator("#textSupplierStatus").textContent(), "已获取 2 个模型。");
  assert.deepEqual(errors, [], "no browser runtime errors");
  console.log(`Supplier add/edit/cancel, preset, resize, key visibility, sync/test and deletion browser checks passed: ${output}`);
}

if (require.main === module) run().then(async () => {
  if (!process.argv.includes("--browser")) return;
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
  const output = path.join(root, "output/playwright/supplier-cc-switch");
  fs.mkdirSync(output, { recursive: true });
  try { await verifySupplierBrowser(await browser.newPage(), output); } finally { await browser.close(); }
}).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verifySupplierBrowser };
