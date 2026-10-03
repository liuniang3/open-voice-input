"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createFileSummaryService, toFileSummaryDto, readLatestSummaryResult, segmentsFromTranscript }
  = require("../src/meeting/processing/file-summary");

let passed = 0;
async function test(name, run) {
  await run(); passed++;
  console.log(`PASS ${name}`);
}

function makeWav(frames) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + frames * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(frames * 2, 40);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE((i % 31) + 1200, i * 2);
  return Buffer.concat([header, data]);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function evidence(item) {
  return { sourceId: item.id, quote: item.text.slice(0, 80) };
}

function correction(input) {
  return {
    text: input.target.text,
    evidence: input.items.filter(item => input.target.source === "live" || item.id === input.target.id).map(evidence),
    uncertain: false
  };
}

function summaryReply(input) {
  const item = input.items[0];
  const claim = { text: item.text.slice(0, 80), evidence: [evidence(item)], uncertain: Boolean(item.uncertain) };
  const paragraph = {
    text: `The file discussion covered ${item.text.slice(0, 40).replace(/\s+/g, " ").trim()}. `
      + "Connected prose keeps the recorded points readable without inventing facts.",
    evidence: [evidence(item)], uncertain: Boolean(item.uncertain)
  };
  return {
    title: "File meeting",
    mindmap: { ...claim, children: [] },
    sections: [{ heading: "正文", paragraphs: [paragraph], items: [] }]
  };
}

async function fixture({ frames = 32000, items, withLegacyAnalysis = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-file-summary-"));
  const sessionDir = path.join(root, "session");
  const archiveDir = path.join(sessionDir, "archive");
  const transcriptDir = path.join(sessionDir, "transcription", "qwen-no-bucket");
  await fsp.mkdir(archiveDir, { recursive: true });
  await fsp.mkdir(transcriptDir, { recursive: true });
  const wav = makeWav(frames);
  const wavPath = path.join(archiveDir, "microphone.mono.wav");
  await fsp.writeFile(wavPath, wav);
  const raw = {
    schema: "meeting_raw_transcript_v1",
    sessionId: "file-summary-test",
    provider: "mimo",
    modelId: "mimo-v2.5-asr",
    mode: "file",
    source: "import",
    items: items || [
      { id: "microphone:0", track: "microphone", text: "We will not spend 120. Repeat repeat this.", beginMs: 0, endMs: 1500 },
      { id: "microphone:1", track: "microphone", text: "The deadline remains 2026.", beginMs: 1500, endMs: 3000 }
    ]
  };
  const rawPath = path.join(transcriptDir, "raw-transcript.json");
  await fsp.writeFile(rawPath, JSON.stringify(raw), "utf8");
  const legacyPath = path.join(sessionDir, "analysis", "summary.json");
  if (withLegacyAnalysis) {
    await fsp.mkdir(path.dirname(legacyPath), { recursive: true });
    await fsp.writeFile(legacyPath, JSON.stringify({ legacy: true, title: "legacy summary", items: ["old"] }), "utf8");
  }
  const before = {
    wav: sha256(wav),
    raw: await fsp.readFile(rawPath, "utf8"),
    legacy: withLegacyAnalysis ? await fsp.readFile(legacyPath, "utf8") : null
  };
  const calls = { review: [], llm: [], reads: [] };
  const audio = require("../src/meeting/realtime/audio");
  const makeService = (options = {}) => createFileSummaryService({
    sessionDir,
    sessionId: "file-summary-test",
    modelId: "sum-model",
    modelProfile: options.modelProfile,
    reviewModelId: "mimo-v2.5-asr",
    readMixedFn: async (paths, start, end) => {
      calls.reads.push([start, end]);
      return audio.readMixed(paths, start, end);
    },
    review: async input => {
      calls.review.push(input);
      return { text: `MiMo review window ${calls.review.length}.` };
    },
    llm: async request => {
      calls.llm.push(request);
      const body = request.task === "reconcile" ? correction(request.input) : summaryReply(request.input);
      return { content: JSON.stringify(body), finishReason: "stop" };
    }
  });
  return { root, sessionDir, wavPath, rawPath, legacyPath, before, calls, makeService };
}

async function assertPreserved(f) {
  const wav = await fsp.readFile(f.wavPath);
  assert.equal(sha256(wav), f.before.wav, "imported archive audio must stay byte-identical");
  assert.equal(await fsp.readFile(f.rawPath, "utf8"), f.before.raw, "raw transcript must stay byte-identical");
  if (f.before.legacy != null) {
    assert.equal(await fsp.readFile(f.legacyPath, "utf8"), f.before.legacy, "legacy analysis artifact must stay byte-identical");
  }
}

async function main() {
  await test("file adapter uses the selected profile for streaming, output and context budgets", async () => {
    const f = await fixture({ items: Array.from({ length: 65 }, (_, index) => ({ id: `microphone:${index}`, track: "microphone",
      text: `Record ${index}: ` + "Substantive words remain part of this discussion. ".repeat(3), beginMs: index * 40, endMs: index * 40 + 40 })) });
    const result = await f.makeService({ modelProfile: { provider: "text-supplier", supplierId: "unit", baseUrl: "https://unit.example/v1",
      contextWindow: 272000, maxOutputTokens: 32768, requestTimeoutMs: 300000 } }).summarize();
    assert.equal(result.status, "completed"); assert.equal(f.calls.llm.length, 1);
    assert.equal(f.calls.llm[0].stream, true); assert.equal(f.calls.llm[0].maxTokens, 32768);
    assert.equal(typeof f.calls.llm[0].onProgress, "function");
    await assertPreserved(f);
  });
  await test("file summary without review summarizes immutable ASR text and never calls ASR or audio reads", async () => {
    const f = await fixture();
    const result = await f.makeService().summarize({ useMimoReview: false });
    assert.equal(result.status, "completed");
    assert.equal(result.useMimoReview, false);
    assert.equal(f.calls.review.length, 0);
    assert.equal(f.calls.reads.length, 0);
    assert.equal(f.calls.llm.filter(call => call.task === "reconcile").length, 0);
    assert.ok(result.summary.mindmap);
    assert.ok(result.summary.sections[0].paragraphs.length >= 1);
    assert.ok(result.summary.sections[0].paragraphs[0].provenance[0].sourceId.startsWith("live:"));
    assert.match(result.summary.markdown, /File meeting/);
    assert.ok(result.summaryMarkdownPath && path.isAbsolute(result.summaryMarkdownPath));
    await assertPreserved(f);
  });

  await test("file summary with review covers full archive audio in bounded chunks then compares evidence", async () => {
    const f = await fixture({ frames: 50 * 16000, items: [
      { id: "microphone:0", track: "microphone", text: "We will not spend 120. Repeat repeat this.", beginMs: 0, endMs: 1500 },
      { id: "microphone:1", track: "microphone", text: "The deadline remains 2026.", beginMs: 40000, endMs: 41500 }
    ] });
    const result = await f.makeService().summarize({ useMimoReview: true });
    assert.equal(result.status, "completed");
    assert.equal(result.useMimoReview, true);
    assert.ok(f.calls.review.length >= 2, "long audio must be reviewed in multiple bounded chunks");
    let covered = 0;
    for (const [start, end] of f.calls.reads) {
      assert.ok(end - start <= 30 * 16000, "review chunks must stay inside provider bounds");
      covered += end - start;
    }
    assert.ok(covered >= 50 * 16000 * 0.99, "review must cover the preserved full audio");
    assert.ok(f.calls.llm.some(call => call.task === "reconcile"), "file-ASR and MiMo evidence must be compared first");
    assert.ok(f.calls.llm.some(call => call.task === "summary_map"));
    assert.ok(result.summary.sections[0].paragraphs.length >= 1);
    const sources = new Set(result.summary.sections.flatMap(section => [...section.paragraphs, ...section.items])
      .flatMap(claim => claim.provenance.map(item => item.source)));
    assert.ok([...sources].some(source => source === "live" || source === "mimo"));
    await assertPreserved(f);
  });

  await test("file summary retry resumes checkpoints without repeating review or completed map work", async () => {
    const f = await fixture();
    let fail = true;
    const service = f.makeService();
    const failing = createFileSummaryService({
      sessionDir: f.sessionDir,
      sessionId: "file-summary-test",
      modelId: "sum-model",
      reviewModelId: "mimo-v2.5-asr",
      readMixedFn: async (paths, start, end) => {
        f.calls.reads.push([start, end]);
        return require("../src/meeting/realtime/audio").readMixed(paths, start, end);
      },
      review: async input => {
        f.calls.review.push(input);
        return { text: `MiMo review window ${f.calls.review.length}.` };
      },
      llm: async request => {
        f.calls.llm.push(request);
        if (fail && request.task === "summary_map") { fail = false; throw new Error("private response body"); }
        const body = request.task === "reconcile" ? correction(request.input) : summaryReply(request.input);
        return { content: JSON.stringify(body), finishReason: "stop" };
      }
    });
    const first = await failing.summarize({ useMimoReview: true });
    assert.equal(first.status, "needs_retry");
    const reviewCalls = f.calls.review.length;
    const compareCalls = f.calls.llm.filter(call => call.task === "reconcile").length;
    assert.ok(reviewCalls > 0 && compareCalls > 0);
    const second = await service.summarize({ useMimoReview: true, retryFailed: true });
    assert.equal(second.status, "completed");
    assert.equal(f.calls.review.length, reviewCalls, "retry must not repeat MiMo review chunks");
    assert.equal(f.calls.llm.filter(call => call.task === "reconcile").length, compareCalls,
      "retry must not repeat completed comparison work");
    await assertPreserved(f);
  });

  await test("summary paragraphs render as coherent prose in the shared markdown schema", async () => {
    const f = await fixture();
    const result = await f.makeService().summarize({ useMimoReview: false });
    const paragraphs = result.summary.sections.flatMap(section => section.paragraphs);
    assert.ok(paragraphs.length >= 1);
    assert.ok(paragraphs.every(item => item.text.trim().length > 40 && item.provenance.length >= 1));
    assert.ok(result.summary.markdown.includes("The file discussion covered"));
    const proseLines = result.summary.markdown.split("\n")
      .filter(line => line.trim() && !line.startsWith("#") && !line.startsWith("-") && !line.startsWith("Evidence:"));
    assert.ok(proseLines.length >= 1, "shared summary markdown must carry readable prose");
  });

  await test("old history stays readable: legacy artifacts intact, stored summary reloads without credentials", async () => {
    const f = await fixture({ withLegacyAnalysis: true });
    const completed = await f.makeService().summarize({ useMimoReview: false });
    assert.equal(completed.status, "completed");
    const stored = await readLatestSummaryResult(f.sessionDir);
    assert.ok(stored && stored.result.schema === "meeting_summary_v2");
    assert.equal(f.calls.review.length, 0);
    const historyService = createFileSummaryService({
      sessionDir: f.sessionDir,
      sessionId: "file-summary-test",
      modelId: "history-read",
      llm: async () => { throw new Error("history read must not call models"); }
    });
    const history = await historyService.status();
    assert.equal(history.status, "completed");
    assert.ok(history.summary.sections[0].paragraphs.length >= 1);
    assert.ok(history.summaryMarkdownPath && path.isAbsolute(history.summaryMarkdownPath));
    assert.equal(f.calls.review.length, 0);
    // Legacy items-only summary shapes remain mappable for old sessions.
    const legacyDto = toFileSummaryDto({
      sessionId: "old",
      status: "completed",
      summary: { title: "Old", markdown: "# Old", mindmap: { text: "Root", uncertain: false, provenance: [], children: [] },
        sections: [{ heading: "Details", items: [{ text: "Old bullet", uncertain: false, provenance: [] }] }] }
    });
    assert.equal(legacyDto.summary.sections[0].items[0].text, "Old bullet");
    assert.deepEqual(legacyDto.summary.sections[0].paragraphs, []);
    await assertPreserved(f);
  });

  await test("file summary IPC stays narrow while legacy analysis read IPC is preserved", async () => {
    const mainSrc = await fsp.readFile(path.join(__dirname, "../src/main.js"), "utf8");
    const preloadSrc = await fsp.readFile(path.join(__dirname, "../src/preload.js"), "utf8");
    for (const channel of ["meeting:file-summary:start", "meeting:file-summary:retry",
      "meeting:file-summary:status", "meeting:file-summary:cancel"]) {
      assert.ok(mainSrc.includes(channel), `main must register ${channel}`);
    }
    for (const method of ["meetingFileSummaryStart", "meetingFileSummaryRetry",
      "meetingFileSummaryStatus", "meetingFileSummaryCancel"]) {
      assert.ok(preloadSrc.includes(method), `preload must expose ${method}`);
    }
    assert.ok(mainSrc.includes('ipcMain.handle("meeting:analysis:summary"'), "legacy analysis read IPC must remain");
    assert.ok(preloadSrc.includes("meetingAnalysisSummary"), "legacy analysis read bridge must remain");
    assert.ok(mainSrc.includes("fileSummaryJobs"), "file summary jobs stay isolated from the legacy analyzer");
  });

  await test("segments clamp file-ASR timing onto the preserved audio timeline", async () => {
    const segments = segmentsFromTranscript({
      items: [
        { text: "first", beginMs: 0, endMs: 500 },
        { text: "second", beginMs: 500, endMs: 90000 },
        { text: "third", beginMs: null, endMs: null }
      ]
    }, 32000);
    assert.equal(segments[0].startFrame, 0);
    assert.equal(segments[0].endFrame, 8000);
    assert.equal(segments[1].endFrame, 32000);
    assert.equal(segments[2].startFrame, 32000);
    assert.ok(segments.every(segment => segment.endFrame <= 32000 && segment.endFrame >= segment.startFrame));
    assert.deepEqual(segments.map(segment => segment.status), ["completed", "completed", "completed"]);
  });

  await test("history readback rejects tampered digests and cross-session results", async () => {
    const f = await fixture();
    const completed = await f.makeService().summarize({ useMimoReview: false });
    assert.equal(completed.status, "completed");
    assert.ok(await readLatestSummaryResult(f.sessionDir, "file-summary-test"));
    assert.equal(await readLatestSummaryResult(f.sessionDir, "other-session"), null);
    const stored = await readLatestSummaryResult(f.sessionDir);
    const tampered = { ...stored.result, title: "rewritten" };
    await fsp.writeFile(stored.resultPath, JSON.stringify(tampered), "utf8");
    assert.equal(await readLatestSummaryResult(f.sessionDir, "file-summary-test"), null);
  });

  await test("file export prefers the validated shared summary over legacy artifacts", async () => {
    const mainSrc = await fsp.readFile(path.join(__dirname, "../src/main.js"), "utf8");
    const exportHandler = mainSrc.slice(mainSrc.indexOf('file:export:save'), mainSrc.indexOf("meeting:import:wav"));
    assert.ok(exportHandler.includes("readLatestSummaryResult"), "export must read the shared summary");
    assert.ok(exportHandler.indexOf("readLatestSummaryResult") < exportHandler.indexOf("analyzer.getSummary"),
      "shared summary wins before the legacy analyzer fallback");
    assert.match(exportHandler, /if \(!summary\) summary = await analyzer\.getSummary/);
    const exportModule = await fsp.readFile(path.join(__dirname, "../src/meeting/export/session-export.js"), "utf8");
    assert.match(exportModule, /isSharedSummary/);
    assert.match(exportModule, /renderSharedSummaryLines/);
  });

  await test("status and readLatest ignore stored summaries from a foreign session", async () => {
    const f = await fixture();
    const completed = await f.makeService().summarize({ useMimoReview: false });
    assert.equal(completed.status, "completed");
    const stored = await readLatestSummaryResult(f.sessionDir, "file-summary-test");
    assert.ok(stored, "fresh summary must be readable for its own session");
    // Rewrite the stored pointer to a foreign session and refresh its digest so
    // only the sessionId guard can reject it.
    const foreign = { ...stored.result, sessionId: "foreign-session" };
    await fsp.writeFile(stored.resultPath, JSON.stringify(foreign), "utf8");
    const latestPath = path.join(f.sessionDir, "realtime", "postprocess", "summary-latest.json");
    const latest = JSON.parse(await fsp.readFile(latestPath, "utf8"));
    latest.resultDigest = crypto.createHash("sha256").update(JSON.stringify(foreign)).digest("hex");
    await fsp.writeFile(latestPath, JSON.stringify(latest), "utf8");
    assert.equal(await readLatestSummaryResult(f.sessionDir, "file-summary-test"), null);
    const fresh = createFileSummaryService({
      sessionDir: f.sessionDir,
      sessionId: "file-summary-test",
      modelId: "history-read",
      llm: async () => { throw new Error("history read must not call models"); }
    });
    assert.equal(await fresh.readLatest(), null, "readLatest must pass the session id");
    const status = await fresh.status();
    assert.notEqual(status.status, "completed", "foreign summaries are never displayed as this session's");
  });

  console.log(`${passed} file summary tests passed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
