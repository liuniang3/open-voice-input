"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ensureTextSuppliers, textModelSelectionFor } = require("../src/settings/text-suppliers");
const {
  createTextSupplierChat,
  resolveTextLlmProfile
} = require("../src/providers/text-supplier-llm");
const { meetingTextProfile, languageModel } = require("../src/meeting/realtime/providers");
const { createVoicePipeline } = require("../src/providers/voice-pipeline");

const root = path.resolve(__dirname, "..");
const snapshotSource = fs.readFileSync(path.join(root, "src/renderer/voice-settings-snapshot.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "src/renderer/renderer.js"), "utf8");
const snapshotFunctions = rendererSource.slice(rendererSource.indexOf("function createSettingsSnapshot()"),
  rendererSource.indexOf("function normalizeTranscriptionMode("));

function recordingSnapshot(settings) {
  // Execute the same browser export and recording snapshot wrapper as the UI,
  // rather than supplying the pipeline with a complete settings fixture.
  const context = { window: {}, structuredClone, appSettings: settings, normalizeAsrMode: value => value };
  vm.runInNewContext(snapshotSource, context);
  vm.runInNewContext(snapshotFunctions, context);
  return context.createFinalTranscriptionSnapshot();
}

let passed = 0;
async function test(name, run) {
  await run(); passed++;
  console.log(`PASS ${name}`);
}

function okResponse(content = "OK") {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      status: "completed",
      output_text: content,
      output: [{ type: "message", content: [{ type: "output_text", text: content }] }]
    })
  };
}

async function withMockFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function baseSettings(extra = {}) {
  return ensureTextSuppliers({
    textSuppliers: [
      { id: "alpha", name: "Alpha", baseUrl: "https://alpha.example/v1", apiKey: "sk-alpha", apiStyle: "chat-completions",
        requestHeaders: { "User-Agent": "ovi-test/1", "x-opencode-session": "auto" } },
      { id: "beta", name: "Beta", baseUrl: "https://beta.example/v1", apiKey: "sk-beta", apiStyle: "responses" }
    ],
    textSupplierCatalogs: {
      alpha: { models: ["glm-5.2"], capabilities: { "glm-5.2": { contextWindow: 128000, maxOutput: 4096 } } },
      beta: { models: ["glm-5.2"], capabilities: { "glm-5.2": { contextWindow: 200000, maxOutput: 8192 } } }
    },
    ...extra
  });
}

async function main() {
  await test("browser recording snapshot keeps canonical routing and deep-copies model settings", () => {
    const settings = baseSettings({
      asrMode: "realtime",
      asrConnections: { mimo: { apiKey: "", baseUrl: "https://asr.example/v1" } },
      textModelSelections: { cleanup: { supplierId: "alpha", modelId: "glm-5.2" } },
      meetingOssAccessKeySecret: "fixture-private-meeting-setting",
      meetingRealtimeDestination: "fixture-private-note"
    });
    const snapshot = recordingSnapshot(settings);
    assert.equal(snapshot.asrMode, "batch");
    assert.equal(settings.asrMode, "realtime", "snapshot must not modify the UI settings");
    assert.equal(snapshot._languageSuppliersMigrated, true);
    assert.deepEqual(snapshot.textModelSelections, settings.textModelSelections);
    assert.deepEqual(snapshot.asrConnections, settings.asrConnections);
    assert.equal(Object.hasOwn(snapshot, "meetingOssAccessKeySecret"), false);
    assert.equal(Object.hasOwn(snapshot, "meetingRealtimeDestination"), false);
    settings.textSuppliers[0].apiKey = "changed-after-recording";
    settings.textSupplierCatalogs.alpha.capabilities["glm-5.2"].maxOutput = 256;
    settings.textModelSelections.cleanup.supplierId = "beta";
    assert.equal(snapshot.textSuppliers[0].apiKey, "sk-alpha");
    assert.equal(snapshot.textSupplierCatalogs.alpha.capabilities["glm-5.2"].maxOutput, 4096);
    assert.equal(snapshot.textModelSelections.cleanup.supplierId, "alpha");
    const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
    const helperAt = html.indexOf('src="./voice-settings-snapshot.js"');
    assert.ok(helperAt >= 0 && helperAt < html.indexOf('src="./renderer.js"'), "helper must load before renderer");
  });

  for (const apiStyle of ["chat-completions", "responses"]) {
    await test(`${apiStyle}: recorded and retried cleanup stays on Go despite stale MiMo settings`, async () => {
      const modelId = apiStyle === "chat-completions" ? "mimo-v2.6-flash" : "deepseek-v4.1-flash";
      const settings = baseSettings({
        asrProvider: "mimo", asrMode: "realtime", transcriptionMode: "stable",
        cleanerProvider: "opencode-go", cleanerModel: modelId,
        cleanerApiKey: "fixture-stale-mimo-key", cleanerBaseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        providerConnections: { mimo: { apiKey: "fixture-stale-mimo-key", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" } },
        textSuppliers: [{ id: "opencode-go1", name: "OpenCode Go1", apiKey: "fixture-selected-go-key",
          baseUrl: "https://opencode.ai/zen/go/v1", apiStyle }],
        textSupplierCatalogs: { "opencode-go1": { models: [modelId],
          capabilities: { [modelId]: { contextWindow: 1000000, maxOutput: 384000 } } } },
        textModelSelections: { cleanup: { supplierId: "opencode-go1", modelId } }
      });
      const snapshot = recordingSnapshot(settings);
      const logs = [];
      const pipeline = createVoicePipeline({
        getSettings: () => settings,
        logEvent: (message, detail) => logs.push(`${message} ${detail || ""}`),
        providerOverrides: { asrProviders: { mimo: { id: "asr", transcribeRaw: async () => ({ text: "呃，请把窗口缩小。" }) } } }
      });
      const seen = [];
      await withMockFetch(async (url, init) => {
        seen.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
        return okResponse('{"text":"请缩小窗口。"}');
      }, async () => {
        // Realtime final text, segmented batch transcription and retry must all
        // route through the frozen frontend snapshot, even after a UI switch.
        assert.equal(await pipeline.cleanText({ rawText: "呃，请把窗口缩小。", settingsSnapshot: snapshot }), "请缩小窗口。");
        settings.textModelSelections.cleanup = { supplierId: "deleted-after-recording", modelId: "other" };
        assert.equal(await pipeline.transcribe({ audioDataUrl: "data:audio/wav;base64,fixture", settingsSnapshot: snapshot }), "请缩小窗口。");
        assert.equal(await pipeline.cleanText({ rawText: "呃，请把窗口缩小。", settingsSnapshot: snapshot }), "请缩小窗口。");
      });
      assert.equal(seen.length, 3);
      for (const call of seen) {
        assert.equal(call.url, `https://opencode.ai/zen/go/v1/${apiStyle === "responses" ? "responses" : "chat/completions"}`);
        assert.equal(call.auth, "Bearer fixture-selected-go-key");
        assert.equal(call.body.model, modelId);
        assert.equal(call.body[apiStyle === "responses" ? "max_output_tokens" : "max_completion_tokens"], 384000);
      }
      assert.ok(logs.some(line => line.includes(`text-supplier:opencode-go1:${modelId}`)));
      assert.ok(logs.every(line => !line.includes("fixture-selected-go-key") && !line.includes("fixture-stale-mimo-key")));
    });
  }

  await test("same model ID at two suppliers routes to each supplier's own endpoint and key", async () => {
    const settings = baseSettings({
      textModelSelections: {
        cleanup: { supplierId: "alpha", modelId: "glm-5.2" },
        summary: { supplierId: "beta", modelId: "glm-5.2" }
      }
    });
    const seen = [];
    await withMockFetch(async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization, session: init.headers["x-opencode-session"] });
      return okResponse();
    }, async () => {
      const cleanup = resolveTextLlmProfile(settings, { slot: "cleanup" });
      const summary = resolveTextLlmProfile(settings, { slot: "summary" });
      assert.equal(cleanup.supplierId, "alpha");
      assert.equal(summary.supplierId, "beta");
      assert.equal(cleanup.apiKey, "sk-alpha");
      assert.equal(summary.apiKey, "sk-beta");
      await createTextSupplierChat(cleanup)([{ role: "user", content: "ok" }], { maxTokens: 16 });
      await languageModel(summary)([{ role: "user", content: "ok" }], { maxTokens: 16 });
    });
    assert.match(String(seen[0].url), /^https:\/\/alpha\.example\/v1\/chat\/completions$/);
    assert.equal(seen[0].auth, "Bearer sk-alpha");
    assert.match(String(seen[1].url), /^https:\/\/beta\.example\/v1\/responses$/);
    assert.equal(seen[1].auth, "Bearer sk-beta");
    assert.match(String(seen[0].session || ""), /^models-|^ovi-|^[a-z]+-/, "compat session header expands per request");
    assert.equal(seen[0].session !== seen[1].session, true);
  });

  await test("both API styles hit their own endpoints with bounded output tokens", async () => {
    const settings = baseSettings();
    const bodies = [];
    await withMockFetch(async (url, init) => {
      bodies.push({ url: String(url), body: JSON.parse(init.body) });
      return okResponse();
    }, async () => {
      await createTextSupplierChat(resolveTextLlmProfile(settings, { supplierId: "alpha", modelId: "glm-5.2" }))(
        [{ role: "user", content: "ok" }], { maxTokens: 99999 });
      await createTextSupplierChat(resolveTextLlmProfile(settings, { supplierId: "beta", modelId: "glm-5.2" }))(
        [{ role: "user", content: "ok" }], { maxTokens: 32 });
    });
    assert.match(bodies[0].url, /\/chat\/completions$/);
    assert.equal(bodies[0].body.max_completion_tokens, 4096, "catalog maxOutput caps the request");
    assert.match(bodies[1].url, /\/responses$/);
    assert.equal(bodies[1].body.max_output_tokens, 32);
    const limits = resolveTextLlmProfile(settings, { supplierId: "alpha", modelId: "glm-5.2" });
    assert.equal(limits.contextWindow, 128000);
    assert.equal(limits.maxOutputTokens, 4096);
    assert.equal(limits.apiStyle, "chat-completions");
  });

  await test("cleanup and summary selections stay independent", () => {
    let settings = baseSettings({
      textModelSelections: {
        cleanup: { supplierId: "alpha", modelId: "glm-5.2" },
        summary: { supplierId: "beta", modelId: "glm-5.2" }
      }
    });
    assert.equal(resolveTextLlmProfile(settings, { slot: "cleanup" }).supplierId, "alpha");
    assert.equal(resolveTextLlmProfile(settings, { slot: "summary" }).supplierId, "beta");
    settings = ensureTextSuppliers({
      ...settings,
      textModelSelections: {
        cleanup: { supplierId: "beta", modelId: "glm-5.2" },
        summary: { supplierId: "beta", modelId: "glm-5.2" }
      }
    });
    assert.equal(resolveTextLlmProfile(settings, { slot: "cleanup" }).supplierId, "beta");
    assert.equal(textModelSelectionFor(settings, "summary").supplierId, "beta");
    // Explicit pair in a call overrides the stored slot without touching the other slot.
    assert.equal(resolveTextLlmProfile(settings, { slot: "summary", supplierId: "alpha", modelId: "glm-5.2" }).supplierId, "alpha");
  });

  await test("legacy settings migrate into language suppliers without changing endpoint or key", async () => {
    const legacy = ensureTextSuppliers({
      cleanerProvider: "openai-compatible",
      cleanerModel: "gpt-5.4-mini",
      cleanerProfiles: { "gpt-5.4-mini": { provider: "openai-compatible", apiKey: "sk-legacy", baseUrl: "https://legacy.example/v1" } },
      meetingAnalysisModel: "gpt-5.4-mini",
      meetingAnalysisProfiles: { "gpt-5.4-mini": { provider: "openai-compatible", apiKey: "sk-legacy", baseUrl: "https://legacy.example/v1" } }
    });
    assert.equal(resolveTextLlmProfile(legacy, { slot: "summary" }).apiKey, "sk-legacy");
    assert.equal(resolveTextLlmProfile(legacy, { slot: "cleanup" }).baseUrl, "https://legacy.example/v1");
    const profile = meetingTextProfile(legacy, { modelId: "gpt-5.4-mini" });
    assert.equal(profile.provider, "text-supplier");
    assert.equal(profile.apiKey, "sk-legacy");
    assert.equal(profile.baseUrl, "https://legacy.example/v1");

    // Unmigrated snapshots still support old jobs; migrated requests use pairs.
    const calls = [];
    const pipeline = createVoicePipeline({
      getSettings: () => ({ ...legacy, _languageSuppliersMigrated: false, textModelSelections: {}, transcriptionMode: "stable" }),
      logEvent: (message) => calls.push(message),
      providerOverrides: {
        asrProviders: { mimo: { id: "asr", transcribeRaw: async () => ({ text: "raw text" }) } },
        cleanerProviders: {
          "openai-compatible": { id: "legacy-cleaner", clean: async ({ rawText }) => ({ text: `${rawText}!` }) }
        }
      }
    });
    assert.equal(await pipeline.cleanText({ rawText: "hello" }), "hello!");
  });

  await test("voice cleanup uses the selected supplier model output budget", async () => {
    const settings = baseSettings({
      textModelSelections: { cleanup: { supplierId: "alpha", modelId: "glm-5.2" } }
    });
    const bodies = [];
    const pipeline = createVoicePipeline({
      getSettings: () => ({ ...settings, transcriptionMode: "stable" }),
      logEvent: () => {},
      providerOverrides: {
        asrProviders: { mimo: { id: "asr", transcribeRaw: async () => ({ text: "raw" }) } }
      }
    });
    await withMockFetch(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return okResponse('{"text":"窗口"}');
    }, async () => {
      assert.equal(await pipeline.cleanText({ rawText: "呃 窗口" }), "窗口。");
    });
    assert.equal(bodies[0].max_completion_tokens, 4096);
  });

  await test("live and file summaries share the same routing adapter", async () => {
    const settings = baseSettings({
      textModelSelections: { summary: { supplierId: "alpha", modelId: "glm-5.2" } }
    });
    const seen = [];
    await withMockFetch(async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization });
      return okResponse('"done"');
    }, async () => {
      // Both call sites resolve through meetingTextProfile + languageModel.
      const liveProfile = meetingTextProfile(settings, { slot: "summary", modelId: "ignored-legacy-name" });
      const fileProfile = meetingTextProfile(settings, { slot: "summary", modelId: "ignored-legacy-name" });
      assert.equal(liveProfile.modelId, "glm-5.2");
      assert.equal(fileProfile.modelId, "glm-5.2");
      const liveCall = languageModel(liveProfile);
      const fileCall = languageModel(fileProfile);
      await liveCall([{ role: "user", content: "live" }], { maxTokens: 16 });
      await fileCall([{ role: "user", content: "file" }], { maxTokens: 16 });
    });
    assert.equal(seen.length, 2);
    for (const call of seen) {
      assert.match(String(call.url), /^https:\/\/alpha\.example\/v1\//);
      assert.equal(call.auth, "Bearer sk-alpha");
    }
    const fs = require("node:fs");
    const liveSrc = fs.readFileSync(path.join(root, "src/meeting/realtime/index.js"), "utf8");
    const mainSrc = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
    assert.match(liveSrc, /meetingTextProfile\(settings, \{ slot: "summary", supplierId: options\.supplierId, modelId: requestedModel \}\)/);
    assert.match(mainSrc, /meetingTextProfile\(snapshot, \{ slot: "summary", supplierId, modelId \}\)/);
  });

  await test("missing or deleted suppliers fail cleanly without sending elsewhere", async () => {
    const settings = baseSettings({
      textModelSelections: {
        cleanup: { supplierId: "ghost", modelId: "glm-5.2" },
        summary: { supplierId: "ghost", modelId: "glm-5.2" }
      }
    });
    assert.throws(() => resolveTextLlmProfile(settings, { slot: "summary" }),
      error => error.code === "supplier_not_found");
    assert.throws(() => meetingTextProfile(settings, { modelId: "gpt-5.4-mini" }),
      error => error.code === "supplier_not_found");
    let requests = 0;
    const pipeline = createVoicePipeline({
      getSettings: () => ({ ...settings, transcriptionMode: "stable" }),
      logEvent: () => {},
      providerOverrides: {
        asrProviders: { mimo: { id: "asr", transcribeRaw: async () => ({ text: "raw text" }) } },
        cleanerProviders: {
          mimo: { id: "family-cleaner", clean: async () => { throw new Error("must not route to another supplier"); } }
        }
      }
    });
    await withMockFetch(async () => {
      requests += 1;
      return okResponse();
    }, async () => {
      assert.equal(await pipeline.cleanText({ rawText: "hello" }), "hello");
    });
    assert.equal(requests, 0, "deleted supplier must not fall through to another endpoint");
  });

  await test("no secret values leak into errors, logs or returned shapes", async () => {
    const settings = baseSettings({
      textModelSelections: {
        cleanup: { supplierId: "alpha", modelId: "glm-5.2" },
        summary: { supplierId: "alpha", modelId: "glm-5.2" }
      }
    });
    const logs = [];
    const pipeline = createVoicePipeline({
      getSettings: () => ({ ...settings, transcriptionMode: "stable" }),
      logEvent: (message, detail) => logs.push(`${message} ${detail || ""}`),
      providerOverrides: {
        asrProviders: { mimo: { id: "asr", transcribeRaw: async () => ({ text: "raw text" }) } }
      }
    });
    await withMockFetch(async () => okResponse("{\"text\":\"ok\"}"), async () => {
      await pipeline.cleanText({ rawText: "hello" });
    });
    assert.ok(logs.some(line => /cleaner start/.test(line)), "logs record the route");
    for (const line of logs) assert.doesNotMatch(line, /sk-alpha|sk-beta/);
    try {
      resolveTextLlmProfile(settings, { supplierId: "alpha" });
      assert.fail("missing model must throw");
    } catch (error) {
      assert.doesNotMatch(String(error.message), /sk-alpha/);
    }
    const profile = resolveTextLlmProfile(settings, { slot: "summary" });
    assert.doesNotMatch(JSON.stringify({ id: profile.supplierId, model: profile.modelId }), /sk-alpha/);
  });

  await test("concurrent cleanText calls keep their own settings snapshots", async () => {
    const makeSettings = (supplierId, key) => ensureTextSuppliers({
      textSuppliers: [{ id: supplierId, baseUrl: `https://${supplierId}.example/v1`, apiKey: key, apiStyle: "chat-completions" }],
      textModelSelections: { cleanup: { supplierId, modelId: "shared-model" } }
    });
    const snapA = makeSettings("one", "sk-one");
    const snapB = makeSettings("two", "sk-two");
    const seen = [];
    const pipeline = createVoicePipeline({
      getSettings: () => ({}),
      logEvent: () => {},
      providerOverrides: {
        asrProviders: { mimo: { id: "asr", transcribeRaw: async () => ({ text: "raw text" }) } }
      }
    });
    await withMockFetch(async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization });
      await new Promise(resolve => setTimeout(resolve, 5));
      return okResponse("{\"text\":\"ok\"}");
    }, async () => {
      await Promise.all([
        pipeline.cleanText({ rawText: "hello one", settingsSnapshot: snapA }),
        pipeline.cleanText({ rawText: "hello two", settingsSnapshot: snapB })
      ]);
    });
    const auths = new Set(seen.map(call => call.auth));
    assert.deepEqual([...auths].sort(), ["Bearer sk-one", "Bearer sk-two"],
      "each concurrent request keeps its own snapshot credentials");
    assert.equal(new Set(seen.map(call => call.url)).size, 2, "each snapshot routes to its own supplier");
  });

  console.log(`${passed} text supplier routing tests passed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
