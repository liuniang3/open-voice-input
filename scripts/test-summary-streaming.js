"use strict";

const assert = require("node:assert/strict");
const { createOpenAiCompatibleClient } = require("../src/providers/openai-compatible-client");
const { createSseDecoder } = require("../src/providers/llm-stream");
const { retryAfterMs, retryDelay, isRetryable } = require("../src/providers/request-retry");
const { resolveTextLlmProfile, createTextSupplierChat } = require("../src/providers/text-supplier-llm");
const { ensureTextSuppliers } = require("../src/settings/text-suppliers");
const { summaryProgressText, summaryErrorText } = require("../src/renderer/meeting-ui");
const { toFileSummaryDto } = require("../src/meeting/processing/file-summary");
const { languageModel } = require("../src/meeting/realtime/providers");

let passed = 0;
const test = async (name, run) => { await run(); console.log(`PASS ${name}`); passed++; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function event(data) { return `data: ${JSON.stringify(data)}\r\n\r\n`; }
function chat(text, finish = null) {
  return event({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] });
}
function reply(parts, interval = 0) {
  let cancelled = false;
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        for (const part of parts) {
          if (interval) await delay(interval);
          if (cancelled) return;
          controller.enqueue(typeof part === "string" ? Buffer.from(part) : part);
        }
        if (!cancelled) controller.close();
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
}
function client(fetchImpl, extra = {}) {
  return createOpenAiCompatibleClient({ apiKey: "fixture", baseUrl: "https://unit.example/v1", model: "unit-model",
    requestTimeoutMs: 100, sleepImpl: async () => {}, random: () => 0, fetchImpl, ...extra });
}

async function main() {
  await test("SSE decoder handles one-byte UTF-8, CRLF, multiline fields and comments", () => {
    const actual = [];
    const decoder = createSseDecoder((data, done) => actual.push(done ? "DONE" : data));
    const wire = ': ping\r\n\r\nevent: delta\r\ndata: {"text":\r\ndata: "你好，刚刚看看"}\r\n\r\ndata: [DONE]\r\n\r\n';
    for (const byte of Buffer.from(wire)) decoder.push(Buffer.from([byte]));
    decoder.finish();
    assert.deepEqual(actual, [{ text: "你好，刚刚看看" }, "DONE"]);
  });
  await test("Chat is parsed incrementally, ignores other choices and completes before EOF", async () => {
    const progress = [];
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(c) {
        c.enqueue(Buffer.from(event({ choices: [{ index: 1, delta: { content: "WRONG" } }, { index: 0, delta: { content: "你好" } }] })));
        c.enqueue(Buffer.from(chat("，世界。", "stop")));
        // Deliberately never close: terminal completion must release the socket.
      }, cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } });
    let body;
    const result = await client(async (_url, init) => { body = JSON.parse(init.body); return response; })
      .requestChat([{ role: "user", content: "fixture" }], { stream: true, onProgress: p => progress.push(p) });
    assert.equal(result.content, "你好，世界。");
    assert.equal(body.stream, true);
    assert.ok(progress.some(p => p.stage === "receiving" && p.outputChars === 2));
    assert.equal(cancelled, true);
  });
  await test("Responses handles reasoning separately and requires response.completed", async () => {
    const progress = [];
    let body;
    const result = await client(async (_url, init) => {
      body = JSON.parse(init.body);
      return reply([event({ type: "response.created" }), event({ type: "response.reasoning_summary_text.delta", delta: "think" }),
        event({ type: "response.output_text.delta", delta: '{"text":"完成"}' }),
        event({ type: "response.completed", response: { status: "completed", output: [] } })]);
    }, { apiStyle: "responses" }).requestChat([], { stream: true, extraBody: { reasoning_effort: "high" }, onProgress: p => progress.push(p) });
    assert.equal(result.content, '{"text":"完成"}');
    assert.equal(result.reasoningContent, "think");
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.equal(body.stream, true);
    assert.ok(progress.some(p => p.reasoningChars === 5 && p.stage === "thinking"));
  });
  await test("active generation outlives the former fixed overall timeout", async () => {
    const parts = Array.from({ length: 12 }, () => chat("a")); parts.push(chat("", "stop"));
    const result = await client(async () => reply(parts, 8), { requestTimeoutMs: 20 })
      .requestChat([], { stream: true, idleTimeoutMs: 35, progressTimeoutMs: 15 });
    assert.equal(result.content, "a".repeat(12));
  });
  await test("heartbeats keep transport alive but report no model progress", async () => {
    const progress = [];
    const parts = Array.from({ length: 10 }, () => ': heartbeat\n\n'); parts.push(chat("done", "stop"));
    const result = await client(async () => reply(parts, 8), { requestTimeoutMs: 20 })
      .requestChat([], { stream: true, idleTimeoutMs: 30, progressTimeoutMs: 15, onProgress: p => progress.push(p) });
    assert.equal(result.content, "done");
    assert.ok(progress.some(p => p.stage === "waiting"));
    assert.ok(!progress.some(p => p.stage === "retrying"));
  });
  await test("interrupted JSON restarts in a separate buffer, never concatenates attempts", async () => {
    let calls = 0; const progress = [];
    const result = await client(async () => ++calls === 1 ? reply([chat('{"text":"old')]) : reply([chat('{"text":"new"}', "stop")]))
      .requestChat([], { stream: true, onProgress: p => progress.push(p) });
    assert.equal(calls, 2); assert.equal(result.content, '{"text":"new"}');
    assert.ok(progress.some(p => p.stage === "retrying" && p.retry === 1));
  });
  await test("premature EOF and short network interruptions get at most five retries", async () => {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return reply([chat("partial")]); }).requestChat([], { stream: true, maxRetries: 100 }),
      e => e.code === "response_incomplete");
    assert.equal(calls, 6);
    calls = 0;
    const result = await client(async () => { if (++calls < 3) throw new TypeError("network private body"); return reply([chat("ok", "stop")]); })
      .requestChat([], { stream: true });
    assert.equal(calls, 3); assert.equal(result.content, "ok");
  });
  await test("stalled connection/stream retries are bounded and remain cancellable", async () => {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return new Promise(() => {}); }, { requestTimeoutMs: 10 })
      .requestChat([], { stream: true }), e => e.code === "connection_timeout");
    assert.equal(calls, 6);
    calls = 0;
    await assert.rejects(client(async () => {
      calls++;
      return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(': ping\n\n')); } }),
        { headers: { "content-type": "text/event-stream" } });
    }).requestChat([], { stream: true, idleTimeoutMs: 10 }), e => e.code === "stream_idle_timeout");
    assert.equal(calls, 6);
  });
  await test("401, context rejection, malformed JSON and output truncation do not retry", async () => {
    for (const [make, code] of [
      [() => new Response("SECRET", { status: 401 }), "http_error"],
      [() => new Response('{"error":{"message":"maximum context length exceeded SECRET"}}', { status: 400 }), "request_context_limit"],
      [() => reply(['data: not-json\n\n']), "stream_invalid_json"],
      [() => reply([chat("cut off", "length")]), "response_output_limit"]
    ]) {
      let calls = 0;
      await assert.rejects(client(async () => { calls++; return make(); }).requestChat([], { stream: true }), e => {
        assert.ok(!String(e.message).includes("SECRET")); return e.code === code;
      });
      assert.equal(calls, 1);
    }
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return reply([event({ type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } } })]); }, { apiStyle: "responses" })
      .requestChat([], { stream: true }), e => e.code === "response_output_limit");
    assert.equal(calls, 1);
  });
  await test("429 honors Retry-After and cancellation stops backoff immediately", async () => {
    const waits = []; let calls = 0;
    await client(async () => ++calls === 1 ? new Response("private", { status: 429, headers: { "retry-after": "3" } })
      : reply([chat("ok", "stop")]), { sleepImpl: async ms => waits.push(ms) }).requestChat([], { stream: true });
    assert.deepEqual(waits, [3000]);
    const controller = new AbortController(); calls = 0;
    await assert.rejects(client(async () => { calls++; return new Response("private", { status: 503 }); },
      { sleepImpl: () => new Promise(() => {}) }).requestChat([], { stream: true, signal: controller.signal,
        onProgress: p => { if (p.stage === "retrying") controller.abort(); } }), e => e.code === "aborted");
    assert.equal(calls, 1);
    assert.equal(retryAfterMs(new Headers({ "retry-after-ms": "250" })), 250);
    assert.equal(retryAfterMs(new Headers({ "retry-after": new Date(5000).toUTCString() }), 1000), 4000);
    assert.equal(retryDelay(5, {}, () => 1), 30000);
    assert.equal(isRetryable({ status: 403, code: "network_error" }), false);
  });
  await test("caller cancellation interrupts a live reader and ignores late events", async () => {
    const controller = new AbortController(); let calls = 0;
    const promise = client(async () => { calls++; return reply([chat("partial"), chat("late", "stop")], 20); })
      .requestChat([], { stream: true, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(promise, e => e.code === "aborted"); assert.equal(calls, 1);
  });
  await test("JSON gateways and SSE with missing content type remain compatible", async () => {
    const json = { choices: [{ message: { content: "json" }, finish_reason: "stop" }] };
    assert.equal((await client(async () => new Response(JSON.stringify(json))).requestChat([], { stream: true })).content, "json");
    assert.equal((await client(async () => new Response(chat("sse", "stop"))).requestChat([], { stream: true })).content, "sse");
  });
  await test("legacy MiMo summaries retain api-key auth and configured endpoints while streaming", async () => {
    for (const baseUrl of ["https://api.xiaomimimo.com/v1", "https://token-plan-cn.xiaomimimo.com/v1", "https://unit.example/custom/v1"]) {
      let requestedUrl, request;
      const complete = languageModel({ provider: "mimo", modelId: "mimo-v2.5", apiKey: "fixture", baseUrl,
        fetchImpl: async (url, init) => { requestedUrl = url; request = init; return reply([chat("summary", "stop")]); } });
      assert.equal(await complete({ messages: [], stream: true }), "summary");
      assert.equal(requestedUrl, `${baseUrl}/chat/completions`);
      assert.equal(request.headers["api-key"], "fixture");
      assert.equal(request.headers.Authorization, undefined);
      assert.equal(JSON.parse(request.body).stream, true);
      assert.equal(JSON.parse(request.body).model, "mimo-v2.5");
    }
  });
  await test("malformed JSON fallback never leaks provider text or retries invalid data", async () => {
    const privateText = '{"PRIVATE_PROVIDER_BODY": invalid}';
    for (const apiStyle of ["chat-completions", "responses"]) {
      for (const make of [() => new Response(privateText), () => ({ ok: true, text: async () => privateText })]) {
        let calls = 0;
        await assert.rejects(client(async () => { calls++; return make(); }, { apiStyle }).requestChat([], { stream: true }), error => {
          assert.equal(error.code, "stream_invalid_json");
          assert.equal(error.message, "Model response was not valid JSON.");
          assert.equal(error.cause, undefined);
          return true;
        });
        assert.equal(calls, 1);
      }
    }
  });
  await test("JSON without completion evidence is retried, never published; legacy SSE DONE remains valid", async () => {
    for (const make of [() => new Response(JSON.stringify({ choices: [{ message: { content: "PRIVATE partial" } }] })),
      () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "PRIVATE partial" } }] }) })]) {
      let calls = 0;
      await assert.rejects(client(async () => { calls++; return make(); }).requestChat([], { stream: true }),
        e => e.code === "response_incomplete" && !e.message.includes("PRIVATE"));
      assert.equal(calls, 6);
    }
    const wire = chat("finished") + "data: [DONE]\n\n" + chat("ignored", "stop");
    assert.equal((await client(async () => reply([wire])).requestChat([], { stream: true })).content, "finished");
    assert.equal((await client(async () => ({ ok: true, text: async () => wire })).requestChat([], { stream: true })).content, "finished");
  });
  await test("structured stream failures retry only explicit transient causes and never echo provider bodies", async () => {
    for (const [details, expectedCalls, code] of [
      [{ code: "rate_limit_exceeded" }, 6, "http_error"], [{ type: "server_error" }, 6, "http_error"],
      [{ status_code: 503 }, 6, "http_error"], [{ code: "invalid_api_key" }, 1, "http_error"],
      [{ code: "context_length_exceeded" }, 1, "request_context_limit"], [{ code: "unknown" }, 1, "response_failed"]
    ]) {
      let calls = 0;
      await assert.rejects(client(async () => { calls++; return reply([event({ type: "response.failed",
        response: { error: { ...details, message: "PRIVATE body" } } })]); }, { apiStyle: "responses" })
        .requestChat([], { stream: true }), e => e.code === code && !e.message.includes("PRIVATE"));
      assert.equal(calls, expectedCalls);
    }
  });
  await test("model timeouts persist and summary profiles keep their own limits", async () => {
    const settings = ensureTextSuppliers({ textSuppliers: [{ id: "unit", baseUrl: "https://unit.example/v1", apiKey: "fixture" }],
      textSupplierCatalogs: { unit: { models: ["gpt-5.6-sol"], capabilities: {
        "gpt-5.6-sol": { contextWindow: 272000, maxOutput: 32768, timeoutMs: 300000, reasoning: "high" }
      } } }, textModelSelections: { summary: { supplierId: "unit", modelId: "gpt-5.6-sol" } } });
    const profile = resolveTextLlmProfile(settings, { slot: "summary" });
    assert.equal(profile.requestTimeoutMs, 300000);
    assert.equal(profile.contextWindow, 272000);
    assert.equal(profile.reasoning, "high");
    assert.equal(resolveTextLlmProfile(settings, { slot: "summary", requestTimeoutMs: 210000 }).requestTimeoutMs, 210000);
    let body;
    await createTextSupplierChat(profile, { fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return reply([chat("ok", "stop")]); } })
      ([], { stream: true, maxTokens: 99999 });
    assert.equal(body.max_completion_tokens, 32768); assert.equal(body.reasoning_effort, "high");
  });
  await test("progress DTO and UI expose counters only, not partial JSON or private reasoning", () => {
    const dto = toFileSummaryDto({ progress: { stage: "receiving", outputChars: 200, reasoningChars: 30,
      content: "PRIVATE", apiKey: "PRIVATE", attempts: -10 }, error: { code: "postprocess_stream_idle", body: "PRIVATE" } });
    assert.equal(dto.progress.outputChars, 200); assert.ok(!JSON.stringify(dto).includes("PRIVATE"));
    assert.match(summaryProgressText(dto.progress), /200/);
    assert.ok(summaryProgressText({ stage: "waiting" }).includes("等待"));
    assert.ok(summaryProgressText({ stage: "retrying", retry: 2, maxRetries: 5 }).includes("2\/5"));
    assert.ok(summaryErrorText("postprocess_credentials_invalid").includes("认证"));
  });
  console.log(`${passed} summary streaming tests passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
