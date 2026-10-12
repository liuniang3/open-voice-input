"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createOpenAiCompatibleClient } = require("../src/providers/openai-compatible-client");
const { createTextSupplierChat } = require("../src/providers/text-supplier-llm");
const { summaryBudget, summaryTaskTokens } = require("../src/meeting/summary-budget");
const { createMeetingPostprocessService } = require("../src/meeting/realtime/postprocess");
const { capabilityForProfile } = require("../src/settings/model-capabilities");

let passed = 0;
const test = async (name, run) => { await run(); console.log(`PASS ${name}`); passed++; };
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const chat = (text, finish = null) => event({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] });
function response(text) { return new Response(text, { headers: { "content-type": "text/event-stream" } }); }
function client(fetchImpl, extra = {}) {
  return createOpenAiCompatibleClient({ apiKey: "fixture", baseUrl: "https://fixture.invalid/custom/v1", model: "fixture",
    fetchImpl, sleepImpl: async () => {}, requestTimeoutMs: 100, ...extra });
}
async function fixture(respond, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ovi-summary-stability-"));
  const state = { sessionId: "synthetic", recording: false, sampleRate: 100, totalFrames: 200,
    segments: [{ index: 0, status: "completed", startFrame: 0, endFrame: 100, text: "Cache remains 137MB and deployment is not approved." },
      { index: 1, status: "completed", startFrame: 100, endFrame: 200, text: "Keep full audio and independent thirty second saves." }] };
  const calls = [];
  const budget = summaryBudget({ modelId: "deepseek-v4.1-flash" });
  const service = createMeetingPostprocessService({ sessionDir: directory, getState: () => state,
    limits: budget.limits, llm: { modelId: "fixture", managesTransport: true, complete: async request => {
      calls.push(request); return respond(request, calls.length);
    } }, ...options });
  return { service, state, calls };
}
function compact(input) {
  const claim = { text: input.items[0].text, sourceIds: [input.items[0].id] };
  return { title: "Recorded plan", overview: claim,
    sections: [{ heading: "Constraints", paragraphs: [{ ...claim, sourceIds: [...claim.sourceIds] }],
      topics: [{ ...claim, sourceIds: [...claim.sourceIds], text: "Approval remains pending" }] }] };
}

async function main() {
  for (const transport of ["native", "sdk"]) {
    for (const style of ["chat-completions", "responses"]) {
      await test(`${transport} ${style}: completed content survives every partial usage boundary`, async () => {
        const wire = style === "responses"
          ? event({ type: "response.output_text.delta", delta: "complete" }) + event({ type: "response.completed", response: { status: "completed", output: [] } })
          : chat("complete", "stop");
        const usage = event({ choices: [], usage: { completion_tokens: 7 } });
        for (let end = 1; end <= usage.length; end++) {
          const result = await client(async () => response(wire + usage.slice(0, end)), { apiStyle: style, streamTransport: transport })
            .requestChat([], { stream: true, maxRetries: 0 });
          assert.equal(result.content, "complete");
        }
        const extra = await client(async () => response(wire + "data: broken-tail\n\n"), { apiStyle: style, streamTransport: transport })
          .requestChat([], { stream: true, maxRetries: 0 });
        assert.equal(extra.content, "complete");
      });
    }
    await test(`${transport}: incomplete, malformed and genuinely truncated streams fail closed`, async () => {
      for (const [wire, code] of [[chat("partial"), "response_incomplete"], ["data: broken\n\n", "stream_invalid_json"],
        [chat("partial", "length"), "response_output_limit"]]) {
        let attempts = 0;
        await assert.rejects(client(async () => { attempts++; return response(wire); }, { streamTransport: transport })
          .requestChat([], { stream: true, maxRetries: 0 }), error => error.code === code);
        assert.equal(attempts, 1);
      }
    });
    await test(`${transport}: classify output/context/format rejections without leaking provider messages`, async () => {
      for (const [details, code] of [
        [{ param: "max_output_tokens", message: "maximum output tokens allowed is 8192 PRIVATE" }, "request_output_limit"],
        [{ code: "context_length_exceeded", message: "PRIVATE" }, "request_context_limit"],
        [{ param: "response_format", message: "unsupported PRIVATE" }, "request_format_unsupported"],
        [{ message: "maximum tokens PRIVATE" }, "http_error"]
      ]) {
        await assert.rejects(client(async () => new Response(JSON.stringify({ error: details }), { status: 400 }), { streamTransport: transport })
          .requestChat([], { stream: true }), error => error.code === code && !error.message.includes("PRIVATE"));
      }
    });
  }
  await test("SDK streaming preserves custom authentication, JSON fallback and bounded retries", async () => {
    let calls = 0;
    const progress = [];
    const result = await client(async (url, init) => {
      calls++;
      assert.equal(url, "https://fixture.invalid/custom/v1/chat/completions");
      assert.equal(init.headers["api-key"], "fixture");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      assert.equal(new Headers(init.headers).get("content-type"), "application/json");
      assert.equal(new Headers(init.headers).get("accept"), "text/event-stream");
      if (calls === 1) throw new TypeError("private network details");
      return new Response(JSON.stringify({ choices: [{ message: { content: "valid" }, finish_reason: "stop" }] }),
        { headers: { "content-type": "application/json" } });
    }, { headerName: "api-key", headerValuePrefix: "", streamTransport: "sdk" })
      .requestChat([], { stream: true, onProgress: p => progress.push(p) });
    assert.equal(result.content, "valid"); assert.equal(calls, 2);
    assert.equal(progress.filter(p => p.stage === "retrying").length, 1);
  });
  await test("SDK idle deadlines and caller cancellation release stalled readers", async () => {
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      let released = false;
      const promise = client(async () => new Response(new ReadableStream({
        start(c) { c.enqueue(Buffer.from(": heartbeat\n\n")); }, cancel() { released = true; }
      }), { headers: { "content-type": "text/event-stream" } }), { streamTransport: "sdk" })
        .requestChat([], { stream: true, idleTimeoutMs: 20, signal: controller.signal, maxRetries: 0 });
      if (cancelled) setTimeout(() => controller.abort(), 10);
      await assert.rejects(promise, error => error.code === (cancelled ? "aborted" : "stream_idle_timeout"));
      assert.equal(released, true);
    }
  });
  await test("SDK requests never inherit another account's environment credentials or routing", async () => {
    const values = { OPENAI_API_KEY: "environment-only-key", OPENAI_ADMIN_KEY: "environment-only-admin",
      OPENAI_ORG_ID: "environment-only-org", OPENAI_PROJECT_ID: "environment-only-project",
      OPENAI_BASE_URL: "https://other-account.invalid/v1" };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, values);
      await client(async (url, init) => {
        const headers = new Headers(init.headers);
        assert.equal(url, "https://fixture.invalid/custom/v1/chat/completions");
        assert.equal(headers.get("authorization"), "Bearer fixture");
        assert.equal(headers.has("openai-organization"), false);
        assert.equal(headers.has("openai-project"), false);
        return response(chat("valid", "stop"));
      }, { streamTransport: "sdk" }).requestChat([], { stream: true });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  await test("compact results build chapter links and immutable provenance locally, then resume free", async () => {
    const f = await fixture(request => ({ ...compact(request.input), sourceIncomplete: false, missingRangeCount: 0 }));
    const before = JSON.stringify(f.state);
    const result = await f.service.summarize();
    assert.equal(result.status, "completed");
    assert.equal(result.result.mindmap.children[0].text, result.result.sections[0].heading);
    assert.equal(result.result.mindmap.children[0].children[0].sectionId, "section-1");
    assert.equal(result.result.sections[0].paragraphs[0].provenance[0].quote, f.state.segments[0].text);
    assert.equal(result.result.sections[0].paragraphs[0].uncertain, false);
    assert.equal(JSON.stringify(f.state), before);
    assert.equal(f.calls[0].maxTokens, 8192);
    assert.equal((await f.service.summarize({ retryFailed: true })).resultPath, result.resultPath);
    assert.equal(f.calls.length, 1);
  });
  await test("a missing source ID gets specific validation feedback; unsafe or unknown sources stay rejected", async () => {
    const f = await fixture((request, n) => {
      const result = compact(request.input);
      if (n === 1) result.sections[0].paragraphs[0].sourceIds = ["invented"];
      return result;
    });
    assert.equal((await f.service.summarize()).status, "completed");
    assert.match(f.calls[1].messages[0].content, /Repair field \$\.sections\[0\]\.paragraphs\[0\]\.sourceIds\[0\]/);
    assert.ok(!f.calls[1].messages[0].content.includes("invented"));
    for (const mode of ["unknown", "prototype", "wrong-type"]) {
      const bad = await fixture(request => {
        const value = compact(request.input);
        if (mode === "unknown") value.overview.sourceIds = ["invented"];
        if (mode === "wrong-type") value.sections[0].topics[0].children = "invalid";
        return mode === "prototype" ? JSON.stringify(value).replace('"title":', '"__proto__":{},"title":') : value;
      });
      assert.equal((await bad.service.summarize()).status, "needs_retry");
    }
  });
  await test("complete JSON over the old two-characters-per-token ceiling remains publishable", async () => {
    const f = await fixture(request => {
      const value = compact(request.input);
      value.sections[0].paragraphs = Array.from({ length: 6 }, () => ({ ...value.overview, text: "Recorded details remain pending. ".repeat(100) }));
      assert.ok(JSON.stringify(value).length > 8192 * 2);
      return value;
    });
    assert.equal((await f.service.summarize()).status, "completed");
  });
  await test("real context rejection splits only the failed batch and resumes completed children", async () => {
    let fail = true;
    const f = await fixture((request) => {
      if (request.task === "summary_map" && request.input.items.length > 2) {
        throw Object.assign(new Error("private capacity response"), { code: "request_context_limit" });
      }
      if (request.task === "summary_map" && request.input.items[0].startFrame >= 100 && fail) {
        fail = false; throw Object.assign(new Error("private network response"), { code: "network_error" });
      }
      const value = compact(request.input);
      value.overview.text = "Recorded plan remains pending.";
      value.sections[0].paragraphs[0].text = "Cache stays at 137MB; deployment is not approved.";
      return value;
    });
    f.state.segments.forEach(item => { item.text = item.text.repeat(70); });
    const first = await f.service.summarize();
    assert.equal(first.status, "needs_retry");
    const successfulBefore = f.calls.filter(c => c.task === "summary_map" && c.input.items.length <= 2 && c.input.items[0].startFrame < 100).length;
    assert.ok(successfulBefore > 0);
    const result = await f.service.summarize({ retryFailed: true });
    assert.equal(result.status, "completed"); assert.equal(result.progress.failed, 0);
    assert.equal(f.calls.filter(c => c.task === "summary_map" && c.input.items.length <= 2 && c.input.items[0].startFrame < 100).length, successfulBefore);
    assert.ok(result.result.sections[0].paragraphs[0].provenance.every(p => p.source === "live"));
  });
  await test("task budgets grow with source length and respect model/user capacity without a 2048 ceiling", () => {
    const short = { items: [{ text: "small synthetic input" }] };
    const dense = { items: [{ text: "dense content ".repeat(8000) }] };
    assert.equal(summaryTaskTokens(short, 128000), 8192);
    assert.ok(summaryTaskTokens(dense, 128000) > 32768);
    assert.equal(summaryTaskTokens(dense, 24000), 24000);
    assert.equal(capabilityForProfile("mimo-v2.6-flash", { capabilityManaged: false, contextWindow: 64000, maxOutput: 12000 }).maxOutput, 12000);
  });
  await test("extra valid source IDs and harmless empty leaf fields do not trigger paid regeneration", async () => {
    const f = await fixture(request => {
      const value = compact(request.input);
      value.overview.sourceIds = request.input.items.map(item => item.id);
      value.sections[0].paragraphs[0].children = [];
      return value;
    });
    f.state.segments = Array.from({ length: 24 }, (_, index) => ({ index, startFrame: index * 100, endFrame: (index + 1) * 100,
      status: "completed", text: `Project ${index} remains unapproved.` }));
    f.state.totalFrames = 2400;
    assert.equal((await f.service.summarize()).status, "completed");
    assert.equal(f.calls.length, 1);
  });
  await test("summary policy respects explicit reasoning and recovers only explicit format/output rejection", async () => {
    const seen = [];
    const profile = { provider: "text-supplier", modelId: "deepseek-v4.1-flash", maxOutputTokens: 384000,
      baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", apiStyle: "chat-completions", reasoning: "" };
    const call = createTextSupplierChat(profile, { sleepImpl: async () => {}, fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); seen.push(body);
      if (seen.length === 1) return new Response(JSON.stringify({ error: { param: "max_completion_tokens", message: "maximum output tokens allowed is 8192" } }), { status: 400 });
      if (seen.length === 2) return new Response(JSON.stringify({ error: { param: "response_format", message: "unsupported" } }), { status: 400 });
      return response(chat("complete", "stop"));
    } });
    assert.equal((await call([], { task: "summary_map", stream: true, maxTokens: 12000 })).content, "complete");
    assert.equal(seen.length, 3); assert.equal(seen[1].max_completion_tokens, 8192);
    assert.equal(seen[0].thinking.type, "disabled"); assert.equal(seen[2].response_format, undefined);
    const { summaryRequestBody } = require("../src/providers/summary-request-policy");
    assert.deepEqual(summaryRequestBody({ ...profile, reasoning: "high" }, { task: "summary_map", extraBody: { reasoning_effort: "high" } }).thinking, undefined);
    assert.equal(summaryRequestBody({ modelId: "gpt-6.1-sol", apiStyle: "responses" }, { task: "summary_map" }).reasoning_effort, "low");
    assert.deepEqual(summaryRequestBody(profile, { task: "reconcile" }), {});
  });
  console.log(`${passed} summary stability tests passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
