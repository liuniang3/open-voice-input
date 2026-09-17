"use strict";

const assert = require("node:assert/strict");
const { getEventListeners } = require("node:events");
const { createOpenAiCompatibleClient, parseChatCompletionBody,
  parseServerSentEventChunks } = require("../src/providers/openai-compatible-client");
const { createMimoClient } = require("../src/providers/mimo-client");
const { createMimoAsrProvider } = require("../src/providers/asr/mimo-asr-provider");

globalThis.fetch = async () => { throw new Error("Regression tests must use injected fetch; network disabled."); };

const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const part = (content, finish_reason = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason }] });
const usage = { choices: [], usage: { completion_tokens: 7 } };
const sse = reason => frame(part("same same")) + frame(part(".", reason)) + frame(usage) + "data: [DONE]\n\n";
const json = reason => JSON.stringify({ choices: [{ message: { content: "same same." }, finish_reason: reason }] });
const response = text => ({ ok: true, text: async () => text });
const hasCode = code => error => error.code === code && !error.message.includes("PRIVATE_FIXTURE");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function clientFor(kind, fetchImpl, options = {}) {
  const settings = { apiKey: "test-only-placeholder", baseUrl: "https://example.invalid/v1",
    model: "mimo-v2.5-asr", requestTimeoutMs: 1000, ...options };
  return kind === "mimo" ? createMimoClient({ getSettings: () => settings, useEnvironmentFallback: false, fetchImpl }) :
    createOpenAiCompatibleClient({ ...settings, fetchImpl });
}

async function main() {
  let passed = 0;
  let failed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`not ok - ${name}`); console.error(error); }
  }

  await test("finish reasons survive usage tails, CRLF, compact SSE and JSON", () => {
    for (const reason of ["stop", "length", "content_filter", "tool_calls"]) {
      for (const body of [sse(reason), sse(reason).replace(/\n/g, "\r\n"), sse(reason).replace(/\n\n/g, "\n"), json(reason)]) {
        const parsed = parseChatCompletionBody(body);
        assert.equal(parsed.finishReason, reason);
        assert.equal(parsed.message.content, "same same.");
      }
    }
  });

  await test("SSE EOF without a terminal event cannot silently succeed", () => {
    for (const body of [frame(part("PRIVATE_FIXTURE partial")), frame(part("partial")) + frame(usage),
      frame({ choices: [{ delta: { reasoning_content: "PRIVATE_FIXTURE reasoning" } }] })]) {
      assert.throws(() => parseChatCompletionBody(body), hasCode("response_incomplete"));
    }
    assert.equal(parseChatCompletionBody(frame(part("finished", "stop"))).finishReason, "stop");
    assert.equal(parseChatCompletionBody(frame(part("legacy")) + "data: [DONE]").message.content, "legacy");
    assert.equal(parseChatCompletionBody(json(undefined)).finishReason, null);
  });

  await test("DONE terminates parsing and cannot let later data replace a truncation reason", () => {
    const body = sse("length") + frame(part("should be ignored", "stop")) + "data: PRIVATE_FIXTURE invalid JSON";
    const parsed = parseChatCompletionBody(body);
    assert.equal(parsed.finishReason, "length");
    assert.equal(parsed.message.content, "same same.");
    assert.equal(parseServerSentEventChunks("data: [DONE]\ndata: PRIVATE_FIXTURE").length, 0);
  });

  await test("other choice indices cannot replace choice zero text or finish reason", () => {
    const body = frame(part("first", "length")) + frame({ choices: [{ index: 1, delta: { content: "second" }, finish_reason: "stop" }] }) + "data: [DONE]";
    const parsed = parseChatCompletionBody(body);
    assert.equal(parsed.finishReason, "length");
    assert.equal(parsed.message.content, "first");
  });

  for (const kind of ["openai", "mimo"]) {
    await test(`${kind}: JSON and SSE finishReason reaches caller, including usage-only final event`, async () => {
      for (const reason of ["stop", "length", "content_filter", "tool_calls"]) {
        for (const body of [json(reason), sse(reason)]) {
          const client = clientFor(kind, async () => response(body));
          const result = await client.requestChat([], { stream: true });
          assert.equal(result.finishReason, reason);
          assert.equal(result.content, "same same.");
        }
      }
    });

    await test(`${kind}: truncated SSE never returns partial text`, async () => {
      const client = clientFor(kind, async () => response(frame(part("PRIVATE_FIXTURE partial"))));
      await assert.rejects(client.requestChat([]), hasCode("response_incomplete"));
      const malformed = clientFor(kind, async () => response(frame(part("partial")) + "data: {"));
      await assert.rejects(malformed.requestChat([]));
    });

    await test(`${kind}: pre-aborted request reads no configuration and makes no fetch`, async () => {
      const controller = new AbortController();
      controller.abort(new Error("PRIVATE_FIXTURE cancellation"));
      const unexpected = () => { throw new Error("configuration must not be read"); };
      let calls = 0;
      const fetchImpl = async () => { calls++; return response(json("stop")); };
      const client = kind === "mimo" ? createMimoClient({ getSettings: unexpected, fetchImpl }) :
        createOpenAiCompatibleClient({ apiKey: unexpected, baseUrl: unexpected, model: unexpected, fetchImpl });
      await assert.rejects(client.requestChat([], { signal: controller.signal }), hasCode("aborted"));
      await assert.rejects(clientFor(kind, fetchImpl, { apiKey: "" }).requestChat([], { signal: controller.signal }), hasCode("aborted"));
      assert.equal(calls, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });

    await test(`${kind}: abort during response read rejects even if fetch ignores the signal`, async () => {
      const controller = new AbortController();
      const client = clientFor(kind, async () => ({ ok: true, text: async () => {
        controller.abort(new Error("PRIVATE_FIXTURE cancellation"));
        return json("stop");
      } }));
      await assert.rejects(client.requestChat([], { signal: controller.signal }), hasCode("aborted"));
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });

    await test(`${kind}: caller abort remains distinct from timeout with delayed rejection`, async () => {
      const controller = new AbortController();
      const client = clientFor(kind, async (_url, { signal }) => {
        controller.abort();
        assert.equal(signal.aborted, true);
        await delay(35);
        throw Object.assign(new Error("PRIVATE_FIXTURE abort transport"), { code: "ABORT_ERR" });
      }, { requestTimeoutMs: 10 });
      await assert.rejects(client.requestChat([], { signal: controller.signal }), hasCode("aborted"));
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });

    await test(`${kind}: timeout covers body read and normalizes ABORT_ERR`, async () => {
      for (const ignoreAbort of [false, true]) {
        const controller = new AbortController();
        const client = clientFor(kind, async (_url, { signal }) => ({ ok: true, text: () => ignoreAbort ?
          delay(30).then(() => json("stop")) : new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("PRIVATE_FIXTURE"), { code: "ABORT_ERR" })), { once: true });
          }) }), { requestTimeoutMs: 10 });
        await assert.rejects(client.requestChat([], { signal: controller.signal }), hasCode("request_timeout"));
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      }
    });

    await test(`${kind}: successful response removes caller abort listener`, async () => {
      const controller = new AbortController();
      await clientFor(kind, async () => response(json("stop"))).requestChat([], { signal: controller.signal });
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });
  }

  for (const method of ["transcribeRaw", "transcribeFast", "transcribeMeetingSegment"]) {
    await test(`MiMo ${method}: length/filter/tool-call responses reject before cleanup`, async () => {
      let cleans = 0;
      for (const reason of ["length", "content_filter", "tool_calls"]) {
        for (const body of [sse(reason), json(reason)]) {
          const client = clientFor("mimo", async () => response(body));
          const provider = createMimoAsrProvider({ client, cleanTranscript: text => { cleans++; return text; } });
          await assert.rejects(provider[method]({ audioDataUrl: "data:audio/wav;base64,AA==" }), hasCode("asr_response_incomplete"));
        }
      }
      assert.equal(cleans, 0);
    });

    await test(`MiMo ${method}: pre-aborted cancellation precedes options and requests`, async () => {
      const controller = new AbortController(); controller.abort();
      const unexpected = () => { throw new Error("cancelled ASR must not start"); };
      const provider = createMimoAsrProvider({ client: { requestChat: unexpected }, getOptions: unexpected, cleanTranscript: unexpected });
      await assert.rejects(provider[method]({ audioDataUrl: "data:audio/wav;base64,AA==", signal: controller.signal }), hasCode("aborted"));
    });
  }

  await test("MiMo meeting raw text bypasses cleaner, short dictation still cleans; request stays audio-only", async () => {
    let cleans = 0;
    const calls = [];
    const client = clientFor("mimo", async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return response(sse("stop"));
    });
    const provider = createMimoAsrProvider({ client, cleanTranscript: () => { cleans++; return "short dictation"; } });
    const input = { audioDataUrl: "data:audio/wav;base64,AA==" };
    assert.equal((await provider.transcribeMeetingSegment(input)).text, "same same.");
    assert.equal(cleans, 0);
    assert.equal((await provider.transcribeRaw(input)).text, "short dictation");
    assert.equal(cleans, 1);
    for (const call of calls) {
      assert.deepEqual(call.messages, [{ role: "user", content: [{ type: "input_audio", input_audio: { data: input.audioDataUrl } }] }]);
      assert.equal(call.stream, true);
      assert.equal(call.model, "mimo-v2.5-asr");
      assert.equal(call.temperature, undefined);
    }
  });

  console.log(`Provider response regression: ${passed}/${passed + failed} passed.`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
