"use strict";

const assert = require("node:assert/strict");
const {
  MAX_MODELS,
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
        text: async () => JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.4-mini" }] })
      };
    }
  });
  assert.deepEqual(result.models, ["gpt-5.4-mini", "gpt-5.5"]);
  assert.equal(result.count, 2);
  assert.equal(calls[0].url, "https://gateway.example/v1/models");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-secret");
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);

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
