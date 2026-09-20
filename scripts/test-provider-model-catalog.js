"use strict";

const assert = require("node:assert/strict");
const {
  MAX_MODELS,
  extractModelCatalog,
  extractModelIds,
  listProviderModels,
  modelCatalogEndpoint
} = require("../src/providers/provider-model-catalog");

assert.equal(modelCatalogEndpoint("https://gateway.example"), "https://gateway.example/v1/models");
assert.equal(modelCatalogEndpoint("https://gateway.example/v1/"), "https://gateway.example/v1/models");
assert.deepEqual(extractModelIds({ data: [{ id: "gpt-5.5" }, { id: "openai/gpt-5.4-mini" }] }), [
  "gpt-5.5",
  "openai/gpt-5.4-mini"
]);
assert.deepEqual(extractModelIds({ models: [{ name: "model-b" }, "model-a", { id: "model-a" }] }), [
  "model-a",
  "model-b"
]);
assert.equal(extractModelIds(Array.from({ length: MAX_MODELS + 10 }, (_, index) => `m-${index}`)).length, MAX_MODELS);
assert.deepEqual(extractModelIds({ data: [{ id: "__proto__" }, { id: "safe-model" }] }), ["safe-model"]);
const catalog = extractModelCatalog({ data: [
  { id: "provider-model", context_window: 256000, max_output_tokens: 24000 },
  { id: "grok-4.5" },
  "unknown-model"
] });
assert.equal(catalog.capabilities["provider-model"].contextWindow, 256000);
assert.equal(catalog.capabilities["provider-model"].maxOutput, 24000);
assert.equal(catalog.capabilities["provider-model"].capabilitySource, "provider");
assert.equal(catalog.capabilities["grok-4.5"].contextWindow, 500000);
assert.equal(catalog.capabilities["unknown-model"].contextWindow, 128000);

async function main() {
  const calls = [];
  const result = await listProviderModels({
    provider: "openai",
    settings: {
      providerConnections: {
        openai: { apiKey: "fixture-secret", baseUrl: "https://gateway.example/v1", apiStyle: "responses" }
      }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          data: [
            { id: "gpt-5.5" },
            { id: "gpt-5.4-mini", context_length: 260000, top_provider: { max_completion_tokens: 30000 } }
          ]
        })
      };
    }
  });
  assert.deepEqual(result.models, ["gpt-5.4-mini", "gpt-5.5"]);
  assert.equal(result.count, 2);
  assert.equal(result.capabilities["gpt-5.4-mini"].contextWindow, 260000);
  assert.equal(result.capabilities["gpt-5.4-mini"].maxOutput, 30000);
  assert.equal(calls[0].url, "https://gateway.example/v1/models");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-secret");
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);

  calls.length = 0;
  const goResult = await listProviderModels({
    provider: "opencode-go",
    settings: {
      providerConnections: {
        "opencode-go": { apiKey: "fixture-go", baseUrl: "https://opencode.ai/zen/go/v1" }
      }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ data: [
          { id: "glm-5.2" },
          { id: "mimo-v2.5" },
          { id: "deepseek-v4-pro" },
          { id: "deepseek-v4.1-flash" }
        ] })
      };
    }
  });
  assert.deepEqual(goResult.models, ["deepseek-v4-pro", "deepseek-v4.1-flash", "glm-5.2", "mimo-v2.5"]);
  assert.equal(goResult.capabilities["deepseek-v4-pro"].contextWindow, 1000000);
  assert.equal(goResult.capabilities["deepseek-v4-pro"].maxOutput, 384000);
  assert.equal(goResult.capabilities["deepseek-v4.1-flash"].maxOutput, 384000);
  assert.equal(calls[0].url, "https://opencode.ai/zen/go/v1/models");
  assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-go");
  assert.match(calls[0].options.headers["User-Agent"], /^open-voice-input\//);
  assert.match(calls[0].options.headers["x-opencode-session"], /^models-/);

  await assert.rejects(
    () => listProviderModels({ provider: "openai", settings: { providerConnections: { openai: {} } } }),
    error => error.code === "provider_credentials_missing"
  );
  await assert.rejects(
    () => listProviderModels({
      provider: "openai",
      settings: { providerConnections: { openai: { apiKey: "fixture", baseUrl: "https://gateway.example/v1" } } },
      fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null } })
    }),
    error => error.code === "provider_model_catalog_http_error" && !/fixture/.test(error.message)
  );

  console.log("provider model catalog tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
