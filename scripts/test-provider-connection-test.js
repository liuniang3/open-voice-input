"use strict";

const assert = require("node:assert/strict");
const { testProviderConnection, textModelFor } = require("../src/providers/provider-connection-test");

function response(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

async function main() {
  assert.equal(textModelFor({ meetingAnalysisModel: "gpt-5.5" }, "openai"), "gpt-5.5");
  assert.equal(textModelFor({ cleanerModel: "mimo-v2.5-pro" }, "mimo"), "mimo-v2.5-pro");

  const calls = [];
  const openai = await testProviderConnection({
    provider: "openai",
    settings: {
      providerConnections: {
        openai: { apiKey: "fixture", baseUrl: "https://gateway.example/v1", apiStyle: "responses" }
      },
      meetingAnalysisModel: "gpt-5.5"
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        status: "completed",
        output: [{ content: [{ type: "output_text", text: "OK" }] }]
      });
    }
  });
  assert.equal(openai.ok, true);
  assert.equal(calls[0].url, "https://gateway.example/v1/responses");
  assert.equal(JSON.parse(calls[0].options.body).model, "gpt-5.5");

  calls.length = 0;
  await testProviderConnection({
    provider: "aliyun",
    settings: { providerConnections: { aliyun: { apiKey: "fixture", baseUrl: "https://dashscope.aliyuncs.com" } } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] });
    }
  });
  assert.equal(calls[0].url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(JSON.parse(calls[0].options.body).model, "qwen3-asr-flash");

  calls.length = 0;
  await testProviderConnection({
    provider: "mimo",
    settings: { providerConnections: { mimo: { apiKey: "fixture", baseUrl: "https://mimo-proxy.example/v1" } } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] });
    }
  });
  assert.equal(calls[0].url, "https://mimo-proxy.example/v1/chat/completions");

  calls.length = 0;
  await testProviderConnection({
    provider: "opencode-go",
    settings: {
      providerConnections: {
        "opencode-go": { apiKey: "fixture", baseUrl: "https://opencode.ai/zen/go/v1" }
      },
      cleanerModel: "opencode-go/glm-5.2",
      cleanerProfiles: {
        "opencode-go/glm-5.2": { provider: "opencode-go", providerFamily: "opencode-go" }
      }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] });
    }
  });
  assert.equal(calls[0].url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(JSON.parse(calls[0].options.body).model, "glm-5.2");
  assert.equal(JSON.parse(calls[0].options.body).max_completion_tokens, 128);
  assert.match(calls[0].options.headers["User-Agent"], /^open-voice-input\//);
  assert.match(calls[0].options.headers["x-opencode-session"], /^connection-test-/);

  await assert.rejects(
    () => testProviderConnection({ provider: "openai", settings: { providerConnections: { openai: {} } } }),
    error => error.code === "provider_credentials_missing"
  );
  await assert.rejects(
    () => testProviderConnection({ provider: "custom", settings: {} }),
    error => error.code === "provider_not_supported"
  );

  console.log("provider connection smoke tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
