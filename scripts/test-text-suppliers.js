"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  applySupplierCatalog,
  catalogFor,
  ensureTextSuppliers,
  listTextSuppliers,
  migrateTextSuppliers,
  normalizeTextSupplier,
  resolveTextModel,
  resolveTextSupplier,
  sanitizeHttpsBaseUrl,
  sanitizeSupplierId,
  toPublicTextSupplier
} = require("../src/settings/text-suppliers");
const {
  listProviderModels,
  refreshTextSupplierCatalog,
  expandSupplierHeaders
} = require("../src/providers/provider-model-catalog");
const { testProviderConnection } = require("../src/providers/provider-connection-test");

const root = path.resolve(__dirname, "..");
let passed = 0;
async function test(name, run) {
  await run(); passed++;
  console.log(`PASS ${name}`);
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

function legacyOpenCodeGoSettings() {
  return {
    providerConnections: {
      mimo: { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "sk-mimo-keep", apiStyle: "chat-completions" },
      "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "sk-go-migrate", apiStyle: "chat-completions" }
    },
    openCodeGoModelCatalog: ["glm-5.2", "grok-4.6"],
    openCodeGoModelCapabilities: {
      "glm-5.2": { contextWindow: 128000, maxOutput: 8192, reasoning: "high", capabilitySource: "provider", capabilityRevision: 3 }
    },
    openCodeGoModelCatalogUpdatedAt: "2026-09-20T00:00:00.000Z",
    meetingAnalysisModel: "glm-5.2",
    meetingAnalysisProfiles: { "glm-5.2": { provider: "opencode-go", apiKey: "sk-profile-keep" } }
  };
}

async function main() {
  await test("legacy OpenCode Go settings migrate once and stay lossless", () => {
    const legacy = legacyOpenCodeGoSettings();
    const snapshot = JSON.parse(JSON.stringify(legacy));
    const once = ensureTextSuppliers(legacy);
    const twice = ensureTextSuppliers(once);
    assert.equal(once.textSuppliers.length, 1);
    assert.equal(twice.textSuppliers.length, 1, "migration must be idempotent");
    assert.deepEqual(twice.textSuppliers, once.textSuppliers);
    assert.deepEqual(twice.textSupplierCatalogs, once.textSupplierCatalogs);
    assert.deepEqual(once.providerConnections, snapshot.providerConnections, "legacy connections stay intact");
    assert.deepEqual(once.openCodeGoModelCatalog, snapshot.openCodeGoModelCatalog);
    assert.deepEqual(once.openCodeGoModelCapabilities, snapshot.openCodeGoModelCapabilities);
    assert.deepEqual(once.meetingAnalysisProfiles, snapshot.meetingAnalysisProfiles);
    const entry = resolveTextSupplier(once, "opencode-go");
    assert.equal(entry.apiKey, "sk-go-migrate", "key copies without loss");
    assert.equal(entry.baseUrl, "https://opencode.ai/zen/go/v1");
    assert.equal(entry.apiStyle, "chat-completions");
    assert.equal(entry.migratedFrom, "opencode-go");
    assert.match(entry.requestHeaders["User-Agent"], /^open-voice-input\//);
    assert.equal(entry.requestHeaders["x-opencode-session"], "auto", "compat header marker is preserved");
    assert.deepEqual(catalogFor(once, "opencode-go").models, ["glm-5.2", "grok-4.6"]);
    assert.equal(catalogFor(once, "opencode-go").capabilities["glm-5.2"].contextWindow, 128000);
    // A manually created entry with the same id blocks a second migration.
    const manual = ensureTextSuppliers({
      providerConnections: legacy.providerConnections,
      textSuppliers: [{ id: "opencode-go", name: "Mine", baseUrl: "https://mine.example/v1", apiKey: "sk-mine" }]
    });
    assert.equal(manual.textSuppliers.length, 1);
    assert.equal(manual.textSuppliers[0].apiKey, "sk-mine");
  });

  await test("same model ID at two suppliers stays fully isolated", () => {
    const settings = ensureTextSuppliers({
      textSuppliers: [
        { id: "alpha", name: "Alpha", baseUrl: "https://alpha.example/v1", apiKey: "sk-alpha", apiStyle: "chat-completions" },
        { id: "beta", name: "Beta", baseUrl: "https://beta.example/v1", apiKey: "sk-beta", apiStyle: "responses" }
      ],
      textSupplierCatalogs: {
        alpha: { models: ["glm-5.2"], capabilities: { "glm-5.2": { contextWindow: 1000, maxOutput: 100 } } },
        beta: { models: ["glm-5.2"], capabilities: { "glm-5.2": { contextWindow: 2000, maxOutput: 200 } } }
      },
      textModelSelection: { supplierId: "alpha", modelId: "glm-5.2" }
    });
    const alpha = resolveTextModel(settings, { supplierId: "alpha", modelId: "glm-5.2" });
    const beta = resolveTextModel(settings, { supplierId: "beta", modelId: "glm-5.2" });
    assert.equal(alpha.apiKey, "sk-alpha");
    assert.equal(beta.apiKey, "sk-beta");
    assert.equal(alpha.baseUrl, "https://alpha.example/v1");
    assert.equal(beta.baseUrl, "https://beta.example/v1");
    assert.equal(catalogFor(settings, "alpha").capabilities["glm-5.2"].contextWindow, 1000);
    assert.equal(catalogFor(settings, "beta").capabilities["glm-5.2"].contextWindow, 2000);
    // The active selection is a pair; it resolves to exactly one supplier.
    const selected = resolveTextModel(settings, settings.textModelSelection);
    assert.equal(selected.supplierId, "alpha");
    assert.equal(selected.apiKey, "sk-alpha");
    // Model names never infer a supplier.
    assert.equal(resolveTextModel(settings, { modelId: "glm-5.2" }), null);
    assert.equal(resolveTextModel(settings, { supplierId: "gamma", modelId: "glm-5.2" }), null);
  });

  await test("chat-completions and responses styles normalize and survive resolution", () => {
    const settings = ensureTextSuppliers({
      textSuppliers: [
        { id: "chat-one", baseUrl: "https://chat.example/v1", apiKey: "sk-1", apiStyle: "chat_completions" },
        { id: "resp-one", baseUrl: "https://resp.example/v1", apiKey: "sk-2", apiStyle: "response" },
        { id: "odd-one", baseUrl: "https://odd.example/v1", apiKey: "sk-3", apiStyle: "bogus-style" }
      ]
    });
    assert.equal(resolveTextModel(settings, { supplierId: "chat-one", modelId: "m" }).apiStyle, "chat-completions");
    assert.equal(resolveTextModel(settings, { supplierId: "resp-one", modelId: "m" }).apiStyle, "responses");
    assert.equal(resolveTextModel(settings, { supplierId: "odd-one", modelId: "m" }).apiStyle, "chat-completions");
    assert.equal(normalizeTextSupplier({ id: "https-bad", baseUrl: "http://insecure.example/v1", apiKey: "k" }), null,
      "HTTPS Base URL is mandatory");
    assert.equal(sanitizeHttpsBaseUrl("ftp://x.example/v1"), "");
    assert.equal(sanitizeSupplierId("__proto__"), "");
    assert.equal(sanitizeSupplierId("bad id!"), "");
  });

  await test("failed catalog refresh leaves the previous catalog untouched", async () => {
    const base = ensureTextSuppliers({
      textSuppliers: [{ id: "keep", baseUrl: "https://keep.example/v1", apiKey: "sk-keep" }],
      textSupplierCatalogs: {
        keep: { models: ["model-old"], capabilities: { "model-old": { contextWindow: 4096 } }, updatedAt: "t0" }
      }
    });
    const before = JSON.parse(JSON.stringify(base.textSupplierCatalogs));
    await assert.rejects(refreshTextSupplierCatalog({
      settings: base,
      supplierId: "keep",
      fetchImpl: async () => { throw new Error("network down"); }
    }));
    assert.deepEqual(base.textSupplierCatalogs, before, "failure must not clear the cached catalog");
    await assert.rejects(
      refreshTextSupplierCatalog({
        settings: base,
        supplierId: "keep",
        fetchImpl: async () => jsonResponse({ data: [] })
      }),
      error => error.code === "provider_model_catalog_empty"
    );
    assert.deepEqual(base.textSupplierCatalogs, before);
    // Success replaces the cache and returns a new settings copy.
    const refreshed = await refreshTextSupplierCatalog({
      settings: base,
      supplierId: "keep",
      fetchImpl: async () => jsonResponse({ data: [{ id: "model-new", context_window: 8192 }] })
    });
    assert.deepEqual(refreshed.result.models, ["model-new"]);
    assert.deepEqual(refreshed.settings.textSupplierCatalogs.keep.models, ["model-new"]);
    assert.deepEqual(base.textSupplierCatalogs.keep.models, ["model-old"], "input settings stay immutable");
  });

  await test("catalog, connection test and public views never expose secrets", async () => {
    const secret = "sk-super-secret-value";
    const settings = ensureTextSuppliers({
      textSuppliers: [{ id: "sec", baseUrl: "https://sec.example/v1", apiKey: secret, apiStyle: "chat-completions" }],
      textSupplierCatalogs: { sec: { models: ["model-a"] } }
    });
    const catalog = await listProviderModels({
      settings,
      supplierId: "sec",
      fetchImpl: async () => jsonResponse({ data: [{ id: "model-a" }] })
    });
    assert.doesNotMatch(JSON.stringify(catalog), /sk-super-secret-value/);
    const tested = await testProviderConnection({
      settings,
      supplierId: "sec",
      modelId: "model-a",
      fetchImpl: async () => jsonResponse({
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
        output: []
      })
    });
    assert.doesNotMatch(JSON.stringify(tested), /sk-super-secret-value/);
    assert.deepEqual(Object.keys(tested).sort(), ["latencyMs", "modelId", "ok", "provider", "supplierId"]);
    const publicView = toPublicTextSupplier(resolveTextSupplier(settings, "sec"));
    assert.equal(publicView.hasApiKey, true);
    assert.equal(Object.hasOwn(publicView, "apiKey"), false);
    assert.doesNotMatch(JSON.stringify(listTextSuppliers(settings)), /sk-super-secret-value/);
  });

  await test("built-in OpenAI and OpenCode Go routes keep their behavior without supplierId", async () => {
    const settings = ensureTextSuppliers({
      providerConnections: {
        openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-openai-family", apiStyle: "responses" },
        "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "sk-go-family", apiStyle: "chat-completions" }
      }
    });
    const seen = [];
    const openaiCatalog = await listProviderModels({
      settings,
      provider: "openai",
      fetchImpl: async (url, init) => {
        seen.push({ url, auth: init.headers.Authorization, extra: init.headers });
        return jsonResponse({ data: [{ id: "gpt-5.5" }] });
      }
    });
    assert.deepEqual(openaiCatalog.models, ["gpt-5.5"]);
    assert.equal(openaiCatalog.provider, "openai");
    assert.equal(seen[0].auth, "Bearer sk-openai-family");
    assert.match(String(seen[0].url), /api\.openai\.com/);
    assert.equal(seen[0].extra["x-opencode-session"], undefined, "OpenAI path sends no Go headers");

    const goSeen = [];
    await testProviderConnection({
      settings,
      provider: "opencode-go",
      fetchImpl: async (url, init) => {
        goSeen.push({ url, headers: init.headers });
        return jsonResponse({
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
          output: []
        });
      }
    });
    assert.match(String(goSeen[0].url), /opencode\.ai/);
    assert.equal(goSeen[0].headers.Authorization, "Bearer sk-go-family");
    assert.match(String(goSeen[0].headers["x-opencode-session"] || ""), /^connection-test-/, "Go compat session header is sent");
    // Supplier-path catalog expansion resolves the "auto" marker per request.
    const headers = expandSupplierHeaders({ "User-Agent": "open-voice-input/x", "x-opencode-session": "auto" });
    assert.match(headers["x-opencode-session"], /^models-/);
    assert.equal(headers["User-Agent"], "open-voice-input/x");
  });

  await test("settings persistence keeps registry sanitization and main wiring", () => {
    const messy = ensureTextSuppliers({
      textSuppliers: [
        { id: "ok", baseUrl: "https://ok.example/v1", apiKey: " k1 " },
        { id: "ok", baseUrl: "https://dupe.example/v1", apiKey: "k2" },
        { id: "bad id", baseUrl: "https://bad.example/v1", apiKey: "k3" },
        { id: "insecure", baseUrl: "http://plain.example/v1", apiKey: "k4" }
      ],
      textSupplierCatalogs: {
        ok: { models: ["m1", "m1", "__proto__", { id: "m2" }], capabilities: { m1: { contextWindow: 100, maxOutput: -1 } } },
        "__proto__": { models: ["x"] }
      },
      textModelSelection: { supplierId: "ok", modelId: "m1" }
    });
    assert.equal(messy.textSuppliers.length, 1, "invalid and duplicate entries are sanitized out");
    assert.equal(messy.textSuppliers[0].apiKey, "k1", "keys are trimmed, never dropped");
    assert.deepEqual(messy.textSupplierCatalogs.ok.models, ["m1", "m2"], "unsafe and duplicate model ids are dropped");
    assert.equal(messy.textSupplierCatalogs.ok.capabilities.m1.maxOutput, undefined);
    assert.deepEqual(messy.textModelSelection, { supplierId: "ok", modelId: "m1" });
    const applied = applySupplierCatalog(messy, "ok", { models: ["m3"] });
    assert.deepEqual(applied.textSupplierCatalogs.ok.models, ["m3"]);
    assert.equal(catalogFor(messy, "ok").models[0], "m1", "applySupplierCatalog returns a new object");

    const mainSrc = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
    assert.match(mainSrc, /ensureTextSuppliers\(ensureConnectionProfiles/);
    assert.match(mainSrc, /refreshTextSupplierCatalog\(/);
    assert.match(mainSrc, /textSuppliers: \[\]/);
    assert.match(mainSrc, /payload\?\.supplierId/);
    // Migration is additive only.
    assert.match(String(migrateTextSuppliers.toString()), /textSuppliers/);
  });

  await test("URL-only OpenCode Go config with an empty key still migrates", () => {
    const urlOnly = ensureTextSuppliers({
      providerConnections: {
        "opencode-go": { baseUrl: "https://proxy.example/zen/go/v1", apiKey: "", apiStyle: "chat-completions" }
      }
    });
    assert.equal(urlOnly.textSuppliers.length, 1, "custom URL alone is user intent and must migrate");
    assert.equal(urlOnly.textSuppliers[0].apiKey, "");
    assert.equal(urlOnly.textSuppliers[0].baseUrl, "https://proxy.example/zen/go/v1");
    // Untouched default URL with empty key stays unmigrated.
    const untouched = ensureTextSuppliers({
      providerConnections: {
        "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "", apiStyle: "chat-completions" }
      }
    });
    assert.equal(untouched.textSuppliers.length, 0);
  });

  console.log(`${passed} text supplier registry tests passed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
