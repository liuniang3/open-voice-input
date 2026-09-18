"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMeetingPostprocessService, createMeetingPostprocessor } = require("../src/meeting/realtime/postprocess");

let passed = 0;
async function test(name, run) {
  await run(); passed++;
  console.log(`PASS ${name}`);
}
function evidence(item) { return { sourceId: item.id, quote: item.text.slice(0, 80) }; }
function correction(input) {
  return { text: input.target.text, evidence: input.items.filter(item =>
    input.target.source === "live" || item.id === input.target.id).map(evidence), uncertain: false };
}
function summary(input) {
  const item = input.items[0];
  const claim = { text: item.text.slice(0, 80), evidence: [evidence(item)], uncertain: Boolean(item.uncertain) };
  return { title: "Meeting", mindmap: { ...claim, children: [] }, sections: [{ heading: "Details", items: [claim] }] };
}
async function fixture(options = {}) {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-postprocess-test-"));
  const state = { sessionId: "fixture", status: "completed", recording: false, finalizationPending: false,
    sampleRate: 100, totalFrames: 6500, segments: [
      { index: 0, startFrame: 0, endFrame: 3000, text: "We will not spend 120. Repeat repeat this.", status: "completed" },
      { index: 1, startFrame: 3000, endFrame: 6500, text: "The deadline remains 2026.", status: "completed" }
    ], ...options.state };
  const calls = { asr: [], llm: [], reads: [], pauses: [] };
  let byte = 1;
  const audio = { readMixed: async range => {
    calls.reads.push([range.startFrame, range.endFrame]);
    return Buffer.alloc(44 + (range.endFrame - range.startFrame) * 2, range.startFrame === 0 ? byte : 1);
  }, ...options.audio };
  const asr = { modelId: "mimo-test", limits: { maxSeconds: 30, maxBytes: 10000 },
    transcribe: async input => { calls.asr.push(input.segmentIndex); return `Review window ${input.segmentIndex}.`; }, ...options.asr };
  const llm = { modelId: "independent-llm", complete: async request => {
    calls.llm.push(request);
    return request.task === "reconcile" ? correction(request.input) : summary(request.input);
  }, ...options.llm };
  const create = (extra = {}) => createMeetingPostprocessService({ sessionDir, getState: () => state,
    audio, asr, llm, limits: options.limits, ...extra });
  return { sessionDir, state, calls, audio, asr, llm, create, service: create(), mutateAudio: () => { byte++; } };
}

async function main() {
  await test("post-recording gates include final drain and pending ASR, without mutating state", async () => {
    const f = await fixture();
    for (const change of [{ recording: true }, { finalizationPending: true }, { status: "stopping" }]) {
      const before = { ...f.state }; Object.assign(f.state, change);
      await assert.rejects(f.service.reconcile(), error => error.code === "postprocess_recording_not_finalized");
      Object.assign(f.state, before);
    }
    f.state.segments[0].status = "pending";
    await assert.rejects(f.service.summarize(), error => error.code === "postprocess_transcription_pending");
    assert.equal(f.calls.llm.length, 0); assert.equal(f.calls.reads.length, 0);
  });
  await test("live-only correction batches consecutive sentences and never calls audio/ASR", async () => {
    const segments = Array.from({ length: 100 }, (_, index) => ({ index, startFrame: index * 10,
      endFrame: (index + 1) * 10, text: `Sentence ${index} has content.`, status: "completed" }));
    const f = await fixture({ state: { segments, totalFrames: 1000 } });
    const before = JSON.stringify(f.state);
    const result = await f.service.reconcile();
    assert.equal(result.status, "completed");
    assert.ok(f.calls.llm.length <= 3);
    assert.equal(result.result.text.replace(/\n+/g, "\n"), segments.map(item => item.text).join("\n"));
    assert.equal(JSON.stringify(f.state), before);
    assert.equal(f.calls.asr.length, 0); assert.equal(f.calls.reads.length, 0);
    assert.ok(result.result.items.every(item => item.provenance.length > 0));
  });
  await test("review uses byte/duration bounded pause windows with contiguous full coverage", async () => {
    const f = await fixture();
    f.audio.findPause = async range => { f.calls.pauses.push(range); return range.endFrame - 500; };
    const result = await f.service.reconcile({ reviewAudio: true });
    assert.equal(result.status, "completed");
    assert.deepEqual(f.calls.reads, [[0, 2500], [2500, 5000], [5000, 6500]]);
    assert.deepEqual(f.calls.asr, [0, 1, 2]);
    assert.equal(f.calls.llm.length, 3);
    assert.equal(new Set(f.calls.llm.map(call => call.input.target.id)).size, 3);
    assert.ok(f.calls.llm.every(call => call.input.ownership.includes("exactly once")));
    assert.ok(result.result.items.some(item => item.boundaryAmbiguity));
    assert.ok(result.result.review.every(item => /^[a-f0-9]{64}$/.test(item.audioHash)));
    const bytes = await fixture({ asr: { limits: { maxSeconds: 30, maxBytes: 1044 } } });
    await bytes.service.reconcile({ reviewAudio: true });
    assert.ok(bytes.calls.reads.every(([a, b]) => b - a <= 500));
    assert.equal(bytes.calls.reads.at(-1)[1], bytes.state.totalFrames);
  });
  await test("partial Ali overlap cannot discard reviewed words or duplicate MiMo targets", async () => {
    const f = await fixture({ state: { segments: [{ index: 0, startFrame: 1000, endFrame: 1100,
      text: "A short Ali sentence.", status: "completed" }] } });
    const result = await f.service.reconcile({ reviewAudio: true });
    assert.equal(result.result.items.length, 3);
    for (let i = 0; i < 3; i++) assert.equal(result.result.text.split(`Review window ${i}.`).length - 1, 1);
  });
  await test("ASR retry after fresh service resumes failures only; originals and errors remain isolated", async () => {
    const f = await fixture(); let fail = true;
    f.asr.transcribe = async input => {
      f.calls.asr.push(input.segmentIndex);
      if (fail && input.segmentIndex === 1) throw new Error("DO_NOT_STORE secret response body");
      return { text: `Review window ${input.segmentIndex}.` };
    };
    assert.equal((await f.service.reconcile({ reviewAudio: true })).status, "needs_retry");
    assert.deepEqual(f.calls.asr, [0, 1, 2]); assert.equal(f.calls.llm.length, 0);
    await f.create().reconcile({ reviewAudio: true });
    assert.deepEqual(f.calls.asr, [0, 1, 2]);
    fail = false;
    const result = await f.create().reconcile({ reviewAudio: true, retryFailed: true });
    assert.equal(result.status, "completed"); assert.deepEqual(f.calls.asr, [0, 1, 2, 1]);
    const manifest = await fs.readFile(path.join(path.dirname(result.resultPath), "manifest.json"), "utf8");
    assert.ok(!manifest.includes("DO_NOT_STORE"));
  });
  await test("audio content changes invalidate only changed successful ASR windows", async () => {
    const f = await fixture();
    const a = await f.service.reconcile({ reviewAudio: true });
    f.mutateAudio();
    const b = await f.create().reconcile({ reviewAudio: true });
    assert.deepEqual(f.calls.asr, [0, 1, 2, 0]);
    assert.notEqual(a.result.review[0].audioHash, b.result.review[0].audioHash);
    assert.equal(a.result.review[1].audioHash, b.result.review[1].audioHash);
  });
  await test("request budget persists pending tasks, then resumes without resending success", async () => {
    const f = await fixture({ limits: { maxRequestsPerRun: 2 } });
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await f.create().reconcile({ reviewAudio: true }));
      if (results.at(-1).status === "completed") break;
    }
    assert.equal(results[0].status, "paused"); assert.equal(results.at(-1).status, "completed");
    assert.deepEqual(f.calls.asr, [0, 1, 2]); assert.equal(f.calls.llm.length, 3);
  });
  await test("invalid model evidence fails closed and only failed LLM tasks retry", async () => {
    const f = await fixture(); let fail = true;
    f.llm.complete = async request => {
      f.calls.llm.push(request);
      const result = correction(request.input);
      if (fail && request.input.target.id.startsWith("mimo:1:")) result.evidence = [{ sourceId: "invented", quote: "invented" }];
      return result;
    };
    assert.equal((await f.service.reconcile({ reviewAudio: true })).status, "needs_retry");
    fail = false;
    const result = await f.create().reconcile({ reviewAudio: true, retryFailed: true });
    assert.equal(result.status, "completed"); assert.equal(f.calls.llm.length, 4); assert.equal(f.calls.asr.length, 3);
  });
  await test("numbers, negation and genuine repetition survive a lossy cleaner", async () => {
    const f = await fixture();
    f.llm.complete = async request => ({ ...correction(request.input), text: "We spend. Repeat this. The deadline remains." });
    const result = await f.service.reconcile();
    assert.equal(result.result.items[0].validation, "original_preserved");
    assert.equal(result.result.items[0].uncertain, true);
    assert.ok(result.result.text.includes("not spend 120"));
    assert.ok(result.result.text.includes("Repeat repeat"));
  });
  await test("cancellation and timeout checkpoint failed tasks without accepting late results", async () => {
    const f = await fixture({ limits: { requestTimeoutMs: 20 } });
    f.llm.complete = () => new Promise(() => {});
    const timed = await f.service.reconcile();
    assert.equal(timed.status, "needs_retry");
    const controller = new AbortController();
    f.llm.complete = async request => {
      controller.abort();
      return correction(request.input);
    };
    const cancelled = await f.create().reconcile({ retryFailed: true, signal: controller.signal });
    assert.equal(cancelled.status, "cancelled");
    const recovered = await f.create({ llm: { modelId: f.llm.modelId, complete: async request => correction(request.input) } })
      .reconcile({ retryFailed: true });
    assert.equal(recovered.status, "completed");
  });
  await test("same-session concurrent service instances cannot overwrite checkpoints", async () => {
    const f = await fixture(); let release;
    const ready = new Promise(resolve => {
      f.llm.complete = request => new Promise(done => { release = () => done(correction(request.input)); resolve(); });
    });
    const running = f.service.reconcile(); await ready;
    await assert.rejects(f.create().summarize(), error => error.code === "postprocess_busy");
    release(); await running;
  });
  await test("independent summary produces structured tree, detailed claims and raw provenance", async () => {
    const f = await fixture();
    const result = await f.service.summarize({ source: "original" });
    assert.equal(result.status, "completed"); assert.equal(f.calls.asr.length, 0);
    assert.ok(result.result.sections[0].items[0].provenance[0].sourceId.startsWith("live:"));
    assert.equal(result.result.mindmap.children.length, 0);
    const resumed = await f.create().summarize();
    assert.equal(resumed.status, "completed"); assert.equal(f.calls.llm.length, 1);
  });
  await test("long summaries reduce hierarchically within bounds and retain original citations", async () => {
    const segments = Array.from({ length: 35 }, (_, index) => ({ index, startFrame: index * 100,
      endFrame: (index + 1) * 100, text: `Evidence ${index}. ` + "Detailed discussion. ".repeat(90), status: "completed" }));
    const f = await fixture({ state: { segments, totalFrames: 3500 } });
    const result = await f.service.summarize();
    assert.equal(result.status, "completed"); assert.ok(result.result.levels > 1);
    assert.ok(f.calls.llm.some(call => call.task === "summary_reduce"));
    assert.ok(f.calls.llm.every(call => JSON.stringify(call.messages).length <= 24000));
    assert.ok(result.result.sections[0].items[0].provenance.every(p => p.sourceId.startsWith("live:")));
  });
  await test("summary accepts validated echoed source metadata but discards it from results", async () => {
    const f = await fixture();
    f.llm.complete = async request => ({
      ...summary(request.input),
      sourceIncomplete: Boolean(request.input.sourceIncomplete),
      missingRangeCount: Number(request.input.missingRangeCount) || 0
    });
    const result = await f.service.summarize();
    assert.equal(result.status, "completed");
    assert.equal(Object.hasOwn(result.result, "sourceIncomplete"), false);
    assert.equal(Object.hasOwn(result.result, "missingRangeCount"), false);
  });
  await test("summary aligns a near-exact model quote back to immutable source text", async () => {
    const f = await fixture();
    f.llm.complete = async request => {
      const result = summary(request.input);
      result.sections[0].items[0].evidence[0].quote = result.sections[0].items[0].evidence[0].quote.replace("120", "121");
      return result;
    };
    const result = await f.service.summarize();
    assert.equal(result.status, "completed");
    const quote = result.result.sections[0].items[0].provenance[0].quote;
    assert.equal(quote.includes("120"), true);
    assert.equal(f.state.segments[0].text.includes(quote), true);
  });
  await test("summary falls back to exact source evidence and marks unmatched quotes uncertain", async () => {
    const f = await fixture();
    f.llm.complete = async request => {
      const result = summary(request.input);
      result.sections[0].items[0].evidence[0].quote = "not in source";
      return result;
    };
    const result = await f.service.summarize();
    assert.equal(result.status, "completed");
    const item = result.result.sections[0].items[0];
    assert.equal(item.uncertain, true);
    assert.equal(item.provenance[0].quote, f.state.segments[0].text);
  });
  await test("summary validates source IDs, unknown keys, prototype keys and depth", async () => {
    for (const mode of ["source", "unknown", "prototype", "depth", "oversize"]) {
      const f = await fixture();
      f.llm.complete = async request => {
        const result = summary(request.input);
        if (mode === "source") result.sections[0].items[0].evidence[0].sourceId = "invented";
        if (mode === "unknown") result.script = "bad";
        if (mode === "prototype") return '{"__proto__":{"polluted":true}}';
        if (mode === "depth") {
          let node = result.mindmap;
          for (let i = 0; i < 10; i++) { node.children = [{ ...result.mindmap, children: [] }]; node = node.children[0]; }
        }
        if (mode === "oversize") result.title = "x".repeat(13000);
        return result;
      };
      assert.equal((await f.service.summarize()).status, "needs_retry", mode);
      assert.equal({}.polluted, undefined);
    }
  });
  await test("render data escapes model/source markup and uncertainty survives reduction", async () => {
    const f = await fixture({ state: { segments: [{ index: 0, startFrame: 0, endFrame: 100,
      text: '<script>alert("x")</script>', status: "failed" }] } });
    const result = await f.service.summarize();
    assert.ok(!JSON.stringify(result.result.renderData).includes("<script>"));
    assert.ok(result.result.renderData.mindmap.text.includes("&lt;script&gt;"));
    assert.equal(result.result.mindmap.uncertain, true);
  });
  await test("summary of correction requires matching snapshot and preserves original citations", async () => {
    const f = await fixture();
    await assert.rejects(f.service.summarize({ source: "reconciled" }), error => error.code === "postprocess_reconciliation_required");
    await f.service.reconcile();
    const result = await f.service.summarize({ source: "reconciled" });
    assert.ok(result.result.sections[0].items[0].provenance[0].sourceId.startsWith("live:"));
    f.state.segments[0].text = "Updated original";
    await assert.rejects(f.service.summarize({ source: "reconciled" }), error => error.code === "postprocess_reconciliation_required");
  });
  await test("integration adapter exports separate markdown and preserves externally edited exports", async () => {
    const f = await fixture({ state: { sampleRate: 16000, totalFrames: 16000,
      audioPaths: [], segments: [{ index: 0, startFrame: 0, endFrame: 16000, text: "An original sentence.", status: "completed" }] } });
    const calls = [];
    const processor = createMeetingPostprocessor({ sessionDir: f.sessionDir, getState: () => f.state,
      readMixed: async (_paths, start, end) => Buffer.alloc(44 + (end - start) * 2),
      review: async input => { assert.ok(input.audioDataUrl.startsWith("data:audio/wav;base64,")); return { text: "A reviewed sentence." }; },
      llm: async input => {
        calls.push(input); const body = JSON.parse(input.messages[1].content);
        return { content: JSON.stringify(body.target ? correction(body) : summary(body)), finishReason: "stop" };
      } });
    const result = await processor.reconcile({ modelId: "llm", useMimoReview: true });
    assert.equal(result.reviewedText, "A reviewed sentence.");
    assert.ok(result.correctedText.includes("A reviewed sentence."));
    assert.ok(result.correctedText.includes("An original sentence."));
    assert.ok(result.paths.reviewedMarkdownPath.endsWith(".reviewed.md"));
    assert.ok(result.paths.cleanedMarkdownPath.endsWith(".cleaned.md"));
    await fs.writeFile(result.paths.cleanedMarkdownPath, "User edited note", "utf8");
    const resumed = await processor.reconcile({ modelId: "llm", useMimoReview: true });
    assert.notEqual(resumed.paths.cleanedMarkdownPath, result.paths.cleanedMarkdownPath);
    assert.equal(await fs.readFile(result.paths.cleanedMarkdownPath, "utf8"), "User edited note");
    const notes = await processor.summarize({ modelId: "llm", source: "reconciled" });
    assert.ok(notes.summary.markdown.includes("Evidence:"));
    assert.ok(notes.paths.summaryMarkdownPath.endsWith(".summary.md"));
    assert.equal(calls.length, 2);
  });
  await test("integration adapter scans only final ten seconds and retains silent audio", async () => {
    const f = await fixture({ state: { sampleRate: 16000, totalFrames: 65 * 16000,
      segments: [], audioPaths: [] } });
    const ranges = []; const sizes = [];
    const p = createMeetingPostprocessor({ sessionDir: f.sessionDir, getState: () => f.state,
      readMixed: async (_paths, start, end) => { ranges.push([start, end]); return Buffer.alloc(44 + (end - start) * 2); },
      review: async input => { sizes.push(Buffer.from(input.audioDataUrl.split(",")[1], "base64").length); return { text: "Speech" }; },
      llm: async input => JSON.stringify(correction(JSON.parse(input.messages[1].content))) });
    const result = await p.reconcile({ modelId: "llm", useMimoReview: true });
    assert.equal(result.status, "completed");
    assert.ok(ranges.every(([a, b]) => b - a <= 30 * 16000));
    assert.equal(sizes.reduce((sum, size) => sum + (size - 44) / 2, 0), 65 * 16000);
    assert.equal(ranges[0][0], 20 * 16000);
  });
  await test("all-silent recognition completes review without inventing a transcript", async () => {
    const f = await fixture({ state: { segments: [] }, asr: { transcribe: async () => ({ text: "" }) } });
    const result = await f.service.reconcile({ reviewAudio: true });
    assert.equal(result.status, "completed");
    assert.equal(result.result.text, ""); assert.equal(result.result.review.length, 3);
    assert.equal(f.calls.llm.length, 0);
  });
  await test("interrupted running checkpoints require explicit failed-only retry", async () => {
    const f = await fixture();
    const completed = await f.service.reconcile();
    const file = path.join(path.dirname(completed.resultPath), "manifest.json");
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    Object.values(manifest.tasks)[0].status = "running";
    await fs.writeFile(file, JSON.stringify(manifest));
    assert.equal((await f.create().reconcile()).status, "needs_retry");
    assert.equal(f.calls.llm.length, 1);
    assert.equal((await f.create().reconcile({ retryFailed: true })).status, "completed");
    assert.equal(f.calls.llm.length, 2);
  });
  await test("dense Ali overlap is bounded and explicitly marked as partial review", async () => {
    const segments = Array.from({ length: 300 }, (_, index) => ({ index, startFrame: index * 10,
      endFrame: (index + 1) * 10, text: `Word ${index}`, status: "completed" }));
    const f = await fixture({ state: { segments, totalFrames: 3000 } });
    const result = await f.service.reconcile({ reviewAudio: true });
    assert.equal(result.status, "completed");
    assert.equal(f.calls.llm.filter(call => call.input.target.source === "mimo").length, 1);
    assert.equal(f.calls.llm[0].input.partialReview, true);
    assert.equal(result.result.items[0].uncertain, true);
  });
  await test("provider-truncated output never publishes a summary", async () => {
    const f = await fixture();
    const p = createMeetingPostprocessor({ sessionDir: f.sessionDir, getState: () => f.state,
      llm: async input => ({ content: JSON.stringify(summary(JSON.parse(input.messages[1].content))), finishReason: "length" }) });
    const result = await p.summarize({ modelId: "llm" });
    assert.equal(result.status, "needs_retry"); assert.equal(result.summary, undefined);
  });
  await test("summary refuses stale reviewed audio even when state and file metadata are unchanged", async () => {
    const f = await fixture();
    await f.service.reconcile({ reviewAudio: true });
    f.mutateAudio();
    await assert.rejects(f.create().summarize({ source: "reconciled" }), error => error.code === "postprocess_reconciliation_required");
    assert.equal(f.calls.asr.length, 3);
  });
  await test("hierarchical summary resumes only failed map calls after restart", async () => {
    const segments = Array.from({ length: 20 }, (_, index) => ({ index, startFrame: index * 100,
      endFrame: (index + 1) * 100, text: `Point ${index}. ` + "Supporting details. ".repeat(90), status: "completed" }));
    const f = await fixture({ state: { segments, totalFrames: 2000 } });
    let fail = true; const counts = new Map();
    f.llm.complete = async request => {
      const id = `${request.task}:${request.input.items[0].id}`;
      counts.set(id, (counts.get(id) || 0) + 1);
      if (fail && id === "summary_map:live:0:0") throw new Error("private response body");
      return summary(request.input);
    };
    assert.equal((await f.service.summarize()).status, "needs_retry");
    const first = new Map(counts); fail = false;
    const result = await f.create().summarize({ retryFailed: true });
    assert.equal(result.status, "completed");
    for (const [id, count] of first) assert.equal(counts.get(id), count + (id === "summary_map:live:0:0" ? 1 : 0));
  });
  await test("Ali sentence crossing two empty MiMo windows has exactly one fallback owner", async () => {
    const original = "Keep the entire crossing sentence, not just the first half.";
    const f = await fixture({ state: { totalFrames: 6000, segments: [{ index: 0, startFrame: 2500,
      endFrame: 3500, text: original, status: "completed" }] }, asr: { transcribe: async () => "" } });
    const result = await f.service.reconcile({ reviewAudio: true });
    assert.equal(result.status, "completed");
    assert.equal(result.result.text.split(original).length - 1, 1);
    assert.equal(f.calls.llm.length, 1); assert.equal(result.result.items[0].uncertain, true);
  });
  await test("nonempty MiMo omission retains owned Ali content with provenance exactly once", async () => {
    const original = "The omitted launch detail needs written approval from the board.";
    const f = await fixture({ state: { totalFrames: 6000, segments: [{ index: 0, startFrame: 2500,
      endFrame: 3500, text: original, status: "completed" }] } });
    const result = await f.service.reconcile({ reviewAudio: true });
    assert.equal(result.result.text.split(original).length - 1, 1);
    assert.equal(result.result.items[0].validation, "omitted_original_preserved");
    assert.ok(result.result.items[0].provenance.some(p => p.sourceId === "live:0:0"));
    assert.equal(result.result.text.split("Review window 0.").length - 1, 1);
    assert.equal(result.result.text.split("Review window 1.").length - 1, 1);
  });
  await test("failed preview windows expose missing ranges; full MiMo review resolves coverage", async () => {
    const f = await fixture({ state: { preview: { windows: [{ id: "w0", startFrame: 0, endFrame: 6500, status: "failed" }] } } });
    const original = await f.service.summarize();
    assert.equal(original.result.incomplete, true);
    assert.equal(original.result.uncertain, true);
    assert.equal(original.result.mindmap.uncertain, true);
    assert.equal(original.result.gaps[0].reason, "preview_failed");
    assert.ok(original.result.markdown.includes("Incomplete source transcript"));
    assert.equal(f.calls.llm[0].input.sourceIncomplete, true);
    const reviewed = await f.service.reconcile({ reviewAudio: true });
    assert.equal(reviewed.result.gaps[0].resolvedByReview, true);
    const fused = await f.service.summarize({ source: "reconciled" });
    assert.equal(fused.result.incomplete, false);
    assert.equal(fused.result.gaps[0].resolvedByReview, true);
    const before = f.calls.llm.length;
    f.state.preview.windows[0].status = "streaming";
    await assert.rejects(f.service.summarize(), error => error.code === "postprocess_transcription_pending");
    assert.equal(f.calls.llm.length, before);
  });
  await test("filler-heavy cleanup may shrink safely while separated genuine repetitions remain", async () => {
    const f = await fixture({ state: { segments: [{ index: 0, startFrame: 0, endFrame: 100,
      text: "um um um uh uh uh Keep 120, not 12.", status: "completed" }] } });
    f.llm.complete = async request => ({ ...correction(request.input), text: "Keep 120, not 12." });
    const cleaned = await f.service.reconcile();
    assert.equal(cleaned.result.text, "Keep 120, not 12.");
    f.state.segments[0].text = "Ship this. Discuss the plan and review its timing. Ship this.";
    f.llm.complete = async request => ({ ...correction(request.input), text: "Ship this. Discuss the plan and review its timing." });
    const protectedResult = await f.service.reconcile();
    assert.equal(protectedResult.result.text, f.state.segments[0].text);
    assert.equal(protectedResult.result.items[0].validation, "original_preserved");
  });
  console.log(`${passed} meeting postprocess tests passed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
