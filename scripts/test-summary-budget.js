"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { summaryBudget, estimateTokens } = require("../src/meeting/summary-budget");
const { createMeetingPostprocessService, DEFAULT_LIMITS } = require("../src/meeting/realtime/postprocess");

let passed = 0;
const test = async (name, run) => { await run(); console.log(`PASS ${name}`); passed++; };

function response(input) {
  const item = input.items[0];
  const claim = { text: item.text.slice(0, 50), evidence: [{ sourceId: item.id, quote: item.text.slice(0, 80) }], uncertain: false };
  return { title: "Budget fixture", mindmap: { ...claim, children: [] },
    sections: [{ heading: "正文", paragraphs: [claim], items: [] }] };
}

async function fixture({ profile, segments = 65, chars = 110, limits = {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ovi-summary-budget-"));
  const state = { sessionId: "fixture", status: "completed", recording: false, finalizationPending: false,
    sampleRate: 100, totalFrames: segments * 100, audioIdentity: "fixed", segments: Array.from({ length: segments }, (_, index) => ({
      index, startFrame: index * 100, endFrame: (index + 1) * 100, status: "completed",
      text: `${index}: ` + "This is substantive content about our recorded decision. ".repeat(20).slice(0, chars)
    })) };
  const budget = profile ? summaryBudget(profile) : null;
  const calls = [];
  let failFirst = false;
  const llm = { modelId: "unit", managesTransport: true, complete: async request => {
    calls.push(request);
    request.onProgress({ stage: "thinking", outputChars: 0 });
    if (failFirst) { failFirst = false; throw Object.assign(new Error("private gateway failure"), { code: "network_error" }); }
    return response(request.input);
  } };
  const create = extra => createMeetingPostprocessService({ sessionDir: directory, getState: () => state, llm,
    limits: { ...(budget?.limits || {}), ...limits, ...extra } });
  return { directory, state, budget, calls, create, failNext: () => { failFirst = true; } };
}

async function main() {
  await test("configured large context handles the former 65-fragment failure in one call", async () => {
    const old = await fixture();
    const oldResult = await old.create().summarize();
    assert.equal(oldResult.status, "completed");
    assert.ok(old.calls.length >= 3, "old plan requires map calls and reduction");
    const f = await fixture({ profile: { modelId: "gpt-5.6-sol", contextWindow: 272000, maxOutputTokens: 32768 } });
    const before = JSON.stringify(f.state);
    const result = await f.create().summarize();
    assert.equal(result.status, "completed"); assert.equal(result.result.levels, 1);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].input.items.length, 65);
    assert.equal(JSON.stringify(f.state), before);
    assert.ok(estimateTokens(f.calls[0].messages) <= f.budget.limits.inputTokenBudget);
  });
  await test("small context and output limits use bounded hierarchical reduction", async () => {
    const f = await fixture({ profile: { contextWindow: 8000, maxOutputTokens: 2048 }, segments: 100, chars: 220 });
    const result = await f.create().summarize();
    assert.equal(result.status, "completed"); assert.ok(result.result.levels > 1);
    assert.ok(f.calls.every(call => estimateTokens(call.messages) <= f.budget.limits.inputTokenBudget));
    assert.ok(f.calls.every(call => JSON.stringify(call.messages).length <= f.budget.limits.maxInputChars));
    assert.ok(result.result.mindmap.provenance.every(item => item.source === "live"));
    assert.equal(f.calls.filter(call => call.task === "summary_map").flatMap(call => call.input.items).length, 100);
  });
  await test("transport timeout and run budget changes do not invalidate completed paid tasks", async () => {
    const f = await fixture({ profile: { contextWindow: 272000, maxOutputTokens: 32768 } });
    const first = await f.create({ requestTimeoutMs: 100, maxRequestsPerRun: 100 }).summarize();
    const next = await f.create({ requestTimeoutMs: 500000, maxRequestsPerRun: 1 }).summarize({ retryFailed: true });
    assert.equal(first.resultPath, next.resultPath); assert.equal(next.status, "completed");
    assert.equal(f.calls.length, 1);
  });
  await test("failed tasks retain error cause and retries reuse successful map artifacts", async () => {
    const f = await fixture(); f.failNext();
    const first = await f.create({ requestTimeoutMs: 100 }).summarize();
    assert.equal(first.status, "needs_retry"); assert.equal(first.error.code, "postprocess_network_error");
    const mapCalls = f.calls.filter(call => call.task === "summary_map").length;
    const resumed = await f.create({ requestTimeoutMs: 600000 }).summarize({ retryFailed: true });
    assert.equal(resumed.status, "completed");
    assert.equal(f.calls.filter(call => call.task === "summary_map").length, mapCalls + 1);
    assert.ok(!JSON.stringify(resumed).includes("private gateway failure"));
  });
  await test("legacy cache adoption retains a durable semantic alias across later transport changes", async () => {
    const f = await fixture();
    const initial = await f.create({ requestTimeoutMs: 100 }).summarize();
    const directory = path.dirname(initial.resultPath);
    const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const identity = { version: 2, kind: "summary", state: { sessionId: f.state.sessionId, rate: f.state.sampleRate,
      totalFrames: f.state.totalFrames, records: f.state.segments.map(item => ({ id: `live:${item.index}`,
        source: "live", text: item.text, startFrame: item.startFrame, endFrame: item.endFrame, uncertain: false })), gaps: [] },
      context: "", llm: { modelId: "unit", revision: "" },
      configuration: { source: "original", useMimoReview: false, reconciliationDigest: null,
        presentation: "coherent-article-v2", asr: null } };
    const key = digest({ ...identity, limits: { ...DEFAULT_LIMITS, requestTimeoutMs: 100 } });
    const root = path.dirname(directory);
    const legacyDirectory = path.join(root, key);
    assert.ok(legacyDirectory.startsWith(f.directory + path.sep));
    await fs.rename(directory, legacyDirectory);
    const manifestPath = path.join(legacyDirectory, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.key = key; await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const adopted = await f.create({ requestTimeoutMs: 100 }).summarize({ retryFailed: true });
    assert.equal(path.dirname(adopted.resultPath), legacyDirectory);
    const afterTimeoutChange = await f.create({ requestTimeoutMs: 700000 }).summarize({ retryFailed: true });
    assert.equal(afterTimeoutChange.resultPath, adopted.resultPath);
    assert.equal(f.calls.length, 3, "adoption and subsequent transport edits reuse all three original tasks");
  });
  await test("managed streaming has no duplicate outer timeout and cancellation rejects late work", async () => {
    const f = await fixture({ limits: { requestTimeoutMs: 5 } });
    let signal;
    const service = createMeetingPostprocessService({ sessionDir: f.directory, getState: () => f.state,
      limits: { requestTimeoutMs: 5 }, llm: { modelId: "unit", managesTransport: true,
        complete: async request => { signal = request.signal; await new Promise(resolve => setTimeout(resolve, 30)); return response(request.input); } } });
    assert.equal((await service.summarize()).status, "completed");
    const controller = new AbortController();
    const fresh = await fixture();
    const cancelled = createMeetingPostprocessService({ sessionDir: fresh.directory, getState: () => fresh.state,
      llm: { modelId: "unit", managesTransport: true, complete: request => {
        signal = request.signal; return new Promise(resolve => setTimeout(() => resolve(response(request.input)), 70));
      } } });
    const running = cancelled.summarize({ signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await running;
    assert.equal(result.status, "cancelled"); assert.equal(signal.aborted, true);
    await new Promise(resolve => setTimeout(resolve, 90));
    await assert.rejects(fs.stat(path.join(fresh.directory, "realtime/postprocess/summary-latest.json")), { code: "ENOENT" });
  });
  await test("CJK, emoji and escaped metadata count toward budget; unknown models get a usable default", () => {
    assert.equal(estimateTokens("你好"), 4);
    assert.equal(estimateTokens("🎙"), 4);
    assert.ok(estimateTokens([{ text: "\\\"你好" }]) > estimateTokens("你好"));
    const unknown = summaryBudget({ modelId: "new-gateway-model" });
    assert.ok(unknown.limits.inputTokenBudget > 24000);
    assert.ok(unknown.maxOutputTokens <= 8192);
    const small = summaryBudget({ contextWindow: 4096, maxOutputTokens: 1024 });
    assert.ok(small.limits.contextChars <= small.limits.maxInputChars / 4);
    const outputLimited = summaryBudget({ contextWindow: 1000000, maxOutputTokens: 4096 });
    assert.equal(outputLimited.limits.inputTokenBudget, 4096 * 6);
  });
  console.log(`${passed} summary budget tests passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
