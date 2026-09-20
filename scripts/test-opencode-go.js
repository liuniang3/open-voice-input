"use strict";

const assert = require("node:assert/strict");
const {
  createOpenCodeGoClient,
  normalizeOpenCodeGoModel
} = require("../src/providers/opencode-go-client");
const { createVoicePipeline } = require("../src/providers/voice-pipeline");
const { languageModel } = require("../src/meeting/realtime/providers");

function chatResponse(content = "OK") {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content } }]
    })
  };
}

async function main() {
  assert.equal(normalizeOpenCodeGoModel("opencode-go/glm-5.2"), "glm-5.2");
  assert.equal(normalizeOpenCodeGoModel("mimo-v2.5"), "mimo-v2.5");

  const calls = [];
  const client = createOpenCodeGoClient({
    apiKey: "fixture-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    model: "opencode-go/glm-5.2",
    sessionId: "meeting-session-fixture",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return chatResponse();
    }
  });
  await client.requestChat([{ role: "user", content: "one" }]);
  await client.requestChat([{ role: "user", content: "two" }]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "https://opencode.ai/zen/go/v1/chat/completions");
    assert.equal(call.options.headers.Authorization, "Bearer fixture-go");
    assert.match(call.options.headers["User-Agent"], /^open-voice-input\//);
    assert.equal(call.options.headers["x-opencode-session"], "meeting-session-fixture");
    assert.equal(JSON.parse(call.options.body).model, "glm-5.2");
  }

  const meetingCalls = [];
  const callMeetingModel = languageModel({
    provider: "opencode-go",
    apiKey: "fixture-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    modelId: "glm-5.2",
    fetchImpl: async (url, options) => {
      meetingCalls.push({ url, options });
      return chatResponse("meeting result");
    }
  });
  assert.equal(await callMeetingModel({ messages: [{ role: "user", content: "one" }] }), "meeting result");
  assert.equal(await callMeetingModel({ messages: [{ role: "user", content: "two" }] }), "meeting result");
  assert.equal(meetingCalls.length, 2);
  assert.equal(
    meetingCalls[0].options.headers["x-opencode-session"],
    meetingCalls[1].options.headers["x-opencode-session"]
  );
  assert.match(meetingCalls[0].options.headers["x-opencode-session"], /^meeting-live-/);

  const pipeline = createVoicePipeline({
    getSettings: () => ({
      asrProvider: "mimo",
      cleanerProvider: "opencode-go",
      cleanerModel: "glm-5.2",
      transcriptionMode: "stable"
    }),
    providerOverrides: {
      asrProviders: {
        mimo: {
          id: "fixture-asr",
          transcribeRaw: async () => ({ text: "raw transcript" })
        }
      },
      cleanerProviders: {
        "opencode-go": {
          id: "opencode-go",
          clean: async ({ rawText }) => ({ text: `${rawText} cleaned` })
        }
      }
    }
  });
  assert.equal(await pipeline.transcribe({ audioDataUrl: "data:audio/wav;base64,x" }), "raw transcript cleaned");

  const fallback = createVoicePipeline({
    getSettings: () => ({
      asrProvider: "mimo",
      cleanerProvider: "opencode-go",
      cleanerModel: "glm-5.2",
      transcriptionMode: "stable"
    }),
    providerOverrides: {
      asrProviders: {
        mimo: {
          id: "fixture-asr",
          transcribeRaw: async () => ({ text: "preserved raw transcript" })
        }
      },
      cleanerProviders: {
        "opencode-go": {
          id: "opencode-go",
          clean: async () => { throw new Error("fixture provider rejection"); }
        }
      }
    }
  });
  assert.equal(
    await fallback.transcribe({ audioDataUrl: "data:audio/wav;base64,x" }),
    "preserved raw transcript"
  );

  console.log("OpenCode Go provider tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
