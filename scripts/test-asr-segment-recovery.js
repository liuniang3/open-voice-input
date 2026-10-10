"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createOpenAiCompatibleClient } = require("../src/providers/openai-compatible-client");
const { createMimoClient } = require("../src/providers/mimo-client");
const { createQwen3AsrProvider } = require("../src/providers/asr/qwen3-asr-provider");
const { createMimoAsrProvider } = require("../src/providers/asr/mimo-asr-provider");
const { QWEN_NO_BUCKET, fileAsrLimits } = require("../src/meeting/transcription/constants");
const { prepareTrackSegments, segmentToDataUrl, splitPreparedSegment } = require("../src/meeting/transcription/segment-prep");
const { buildMonoPcm16WavHeader, parseWavHeader, readPcm16Frames } = require("../src/meeting/transcription/wav-reader");
const { createNoBucketMeetingTranscriptionService } = require("../src/meeting/transcription/no-bucket-service");
const { toTranscriptDto } = require("../src/meeting/processing/sanitize-ipc");
const { createFileSummaryService } = require("../src/meeting/processing/file-summary");
const { buildMarkdown, buildTxt, buildDocx } = require("../src/meeting/export/session-export");
const { fixture } = require("./test-summary-background");

const RATE = 16000;
const root = fs.mkdtemp(path.join(os.tmpdir(), "ovi-asr-recovery-"));
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
const tests = [];
const test = (name, run) => tests.push({ name, run });
const tick = async () => { for (let i = 0; i < 15; i++) await new Promise(setImmediate); };

async function archive(name, seconds, sample = i => Math.round(8000 * Math.sin(i / 7))) {
  const dir = path.join(await root, name);
  await fs.mkdir(dir, { recursive: true });
  const pcm = Buffer.alloc(Math.floor(seconds * RATE) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(sample(i), i * 2);
  const wav = Buffer.concat([buildMonoPcm16WavHeader(pcm.length, RATE), pcm]);
  const wavPath = path.join(dir, "original.wav");
  await fs.writeFile(wavPath, wav);
  const sidecar = { contentSha256: hash(wav), track: "microphone", role: "self",
    sessionOriginQpc: 0, qpcFrequency: 1000,
    chunks: [{ seq: 0, beginMs: 0, endMs: seconds * 1000, qpcStart: 0, qpcFrequency: 1000 }], gaps: [] };
  return { dir, pcm, wav, spec: { wavPath, sidecar } };
}

test("dedicated ASR omits undocumented LLM budgets and sampling, ordinary chat retains its budget", async () => {
  for (const kind of ["qwen3-asr", "mimo"]) {
    const calls = [];
    const fetchImpl = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "complete" } }] }) };
    };
    const client = kind === "mimo" ? createMimoClient({ getSettings: () => ({ apiKey: "test-only-key", model: "mimo-v2.5-asr" }), fetchImpl })
      : createOpenAiCompatibleClient({ apiKey: "test-only-key", model: "qwen3-asr-flash", fetchImpl });
    const create = kind === "mimo" ? createMimoAsrProvider : createQwen3AsrProvider;
    const provider = create({ client, cleanTranscript: t => t });
    await provider.transcribeMeetingSegment({ audioDataUrl: "data:audio/wav;base64,AA==" });
    for (const field of ["max_completion_tokens", "max_tokens", "temperature", "top_p"]) assert.equal(field in calls[0], false, `${kind} ${field}`);
    assert.equal(calls[0].messages.length, 1);
    await client.requestChat([{ role: "user", content: "test" }]);
    assert.equal(calls[1].max_completion_tokens, 1024);
    await client.requestChat([], { maxTokens: 16384 });
    assert.equal(calls[2].max_completion_tokens, 16384);
    await client.requestChat([], { stream: true, maxTokens: null });
    assert.equal("max_completion_tokens" in calls[3], false);
  }
});

test("both ASR providers reject length and missing terminal completion before cleaning", async () => {
  for (const create of [createMimoAsrProvider, createQwen3AsrProvider]) {
    for (const reason of ["length", "content_filter", null]) {
      let cleaned = false;
      const provider = create({ client: { requestChat: async () => ({ content: "partial", finishReason: reason }), responseText: r => r.content },
        cleanTranscript: () => { cleaned = true; } });
      await assert.rejects(provider.transcribeRaw({ audioDataUrl: "data:audio/wav;base64,AA==" }),
        e => e.code === (reason === "length" ? "asr_output_truncated" : "asr_response_incomplete"));
      assert.equal(cleaned, false);
    }
  }
});

test("pause cuts preserve every PCM frame, tail, upload budget and source hash", async () => {
  for (const provider of ["qwen3-asr", "mimo"]) {
    const a = await archive(`pause-${provider}`, 361.125, i => i >= RATE * 176.8 && i < RATE * 177.5 ? 0 : Math.round(8000 * Math.sin(i / 7)));
    const limits = fileAsrLimits(provider);
    const plan = await prepareTrackSegments({ ...a.spec, track: "microphone", outputDir: path.join(a.dir, "segments"), limits });
    assert.ok(plan.segments[0].durationSeconds > 176.8 && plan.segments[0].durationSeconds < 177.5);
    const all = [];
    let end = 0;
    for (const seg of plan.segments) {
      assert.equal(seg.artifactBeginMs, end);
      end = seg.artifactEndMs;
      const info = await parseWavHeader(seg.wavPath);
      all.push(await readPcm16Frames(info, 0, info.frameCount));
      const payload = await segmentToDataUrl(seg.wavPath, limits);
      assert.ok(payload.base64Length <= 9000000 && payload.durationSeconds <= 210);
    }
    assert.equal(end, 361125);
    assert.deepEqual(Buffer.concat(all), a.pcm);
    assert.equal(hash(await fs.readFile(a.spec.wavPath)), hash(a.wav));
    if (provider === "mimo") assert.equal(limits.documentedMaxDurationSeconds, null);
  }
});

test("continuous speech obeys byte cap before upload, preparation is cancellable", async () => {
  const a = await archive("byte-cap", 17.2);
  const limits = { ...QWEN_NO_BUCKET, targetSegmentSeconds: 180, maxBase64Chars: 160000, maxDataUriChars: 160064 };
  const plan = await prepareTrackSegments({ ...a.spec, track: "microphone", outputDir: path.join(a.dir, "parts"), limits });
  assert.ok(plan.segments.length >= 5);
  for (const seg of plan.segments) assert.ok((await segmentToDataUrl(seg.wavPath, limits)).base64Length <= 160000);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(prepareTrackSegments({ ...a.spec, track: "microphone", outputDir: path.join(a.dir, "cancel"), signal: ac.signal }), e => e.code === "aborted");
});

test("adaptive child timestamps map recording pauses through original sidecar chunks", async () => {
  const a = await archive("paused-timeline", 120);
  a.spec.sidecar.chunks = [
    { seq: 0, beginMs: 0, endMs: 60000, qpcStart: 0, qpcFrequency: 1000 },
    { seq: 1, beginMs: 60000, endMs: 120000, qpcStart: 960000, qpcFrequency: 1000 }
  ];
  const plan = await prepareTrackSegments({ ...a.spec, track: "microphone", outputDir: path.join(a.dir, "parts") });
  const children = await splitPreparedSegment(plan.segments[0], { outputDir: path.join(a.dir, "children"), nextSeq: 1 });
  assert.equal(children[0].artifactEndMs, 60000);
  assert.equal(children[0].sessionEndMs, 60000);
  assert.equal(children[1].sessionBeginMs, 960000);
  assert.equal(children[1].sessionEndMs, 1020000);
});

test("adaptive split plan survives failure/restart, reuses completed children and never caches length output", async () => {
  const a = await archive("recovery", 120.125);
  const counts = new Map();
  let fail = true, successes = 0;
  const transcribeSegment = async ({ audioDataUrl, seq }) => {
    counts.set(seq, (counts.get(seq) || 0) + 1);
    const frames = (Buffer.from(audioDataUrl.split(",")[1], "base64").length - 44) / 2;
    if (frames > 40 * RATE) return { text: "NEVER CACHE THIS PARTIAL OUTPUT", raw: { finishReason: "length" } };
    if (fail && successes === 1) throw Object.assign(new Error("temporary network failure"), { code: "network_error" });
    successes++;
    return { text: `complete-${seq}`, raw: { finishReason: "stop" } };
  };
  const service = () => createNoBucketMeetingTranscriptionService({ sessionDir: a.dir, sessionId: "recovery", transcribeSegment, maxAttempts: 1 });
  let svc = service();
  await svc.prepare({ microphone: a.spec, modelId: "qwen3-asr-flash" });
  await assert.rejects(svc.run(), e => e.code === "network_error");
  const partial = await svc.getTranscript();
  assert.equal(partial.complete, false);
  assert.equal(partial.segmentCompleted, 1);
  assert.ok(partial.missingRanges.length >= 1);
  assert.equal(await svc.store.readTranscript(), null);
  const dto = toTranscriptDto(partial);
  assert.equal(dto.complete, false);
  const exported = buildMarkdown({ transcript: partial, scope: "raw" });
  assert.match(exported, /转写尚未完成/);
  assert.match(buildTxt({ transcript: partial, scope: "raw" }), /未完成：/);
  assert.ok(buildDocx({ title: "partial", text: exported }).length > 0);
  const cachedSeq = partial.items[0].sourceIndex;
  svc = service(); fail = false;
  const preserved = await svc.prepare({ microphone: a.spec, modelId: "qwen3-asr-flash" });
  assert.ok(preserved.tracks.microphone.splitParents.length > 0);
  await svc.run();
  const full = await svc.getTranscript();
  assert.equal(full.complete, true);
  assert.equal(full.missingRanges.length, 0);
  assert.equal(full.items.length, 4);
  assert.equal(counts.get(cachedSeq), 1);
  const job = await svc.getStatus();
  const all = [];
  let end = 0;
  for (const seg of job.tracks.microphone.segments) {
    assert.equal(seg.artifactBeginMs, end); end = seg.artifactEndMs;
    const info = await parseWavHeader(seg.wavPath);
    all.push(await readPcm16Frames(info, 0, info.frameCount));
  }
  assert.equal(end, 120125);
  assert.deepEqual(Buffer.concat(all), a.pcm);
  for (const name of await fs.readdir(svc.store.resultsDir)) assert.ok(!(await fs.readFile(path.join(svc.store.resultsDir, name), "utf8")).includes("NEVER CACHE"));
  assert.equal(hash(await fs.readFile(a.spec.wavPath)), hash(a.wav));
});

test("cancel leaves completed text readable; retry does not bill completed ranges again", async () => {
  const a = await archive("cancel", 21);
  const signal = new AbortController(); const calls = [];
  const limits = { ...QWEN_NO_BUCKET, targetSegmentSeconds: 10, pauseSearchSeconds: 0, pauseLookaheadSeconds: 0 };
  const make = () => createNoBucketMeetingTranscriptionService({ sessionDir: a.dir, limits, transcribeSegment: async ({ seq }) => {
    calls.push(seq); if (calls.length === 2) signal.abort(); return { text: `part-${seq}` };
  }});
  let svc = make(); await svc.prepare({ microphone: a.spec, modelId: "m" });
  await assert.rejects(svc.run({ signal: signal.signal }), e => e.code === "aborted");
  assert.equal((await svc.getStatus()).status, "cancelled");
  const raw = await svc.getTranscript(); assert.equal(raw.complete, false); assert.equal(raw.segmentCompleted, 1);
  svc = make(); await svc.retryFailed(); await svc.run();
  assert.equal(calls.filter(seq => seq === 0).length, 1);
  assert.equal((await svc.getTranscript()).complete, true);
});

test("legacy completed plan is not repartitioned, stale canonical raw cannot feed summaries", async () => {
  const a = await archive("legacy", 15);
  const old = { ...QWEN_NO_BUCKET, targetSegmentSeconds: 7, pauseSearchSeconds: 0, pauseLookaheadSeconds: 0 };
  const make = limits => createNoBucketMeetingTranscriptionService({ sessionDir: a.dir, limits, transcribeSegment: async () => ({ text: "old complete" }) });
  const svc = make(old); await svc.prepare({ microphone: a.spec, modelId: "m" }); await svc.run();
  const before = await svc.getStatus();
  const upgraded = make(QWEN_NO_BUCKET); const after = await upgraded.prepare({ microphone: a.spec, modelId: "m" });
  assert.deepEqual(after.tracks, before.tracks);
  before.status = "running"; await svc.store.saveJob(before);
  const summary = createFileSummaryService({ sessionDir: a.dir, sessionId: "legacy",
    llm: async () => { throw new Error("Incomplete transcripts must not call LLM."); }, modelId: "m" });
  await assert.rejects(summary.summarize(), e => e.code === "postprocess_transcription_incomplete");
});

test("file view refreshes partial/failed results, keeps scroll and selected summary tab", async () => {
  const f = fixture();
  let completed = 1, stage = "transcribing";
  f.handlers.meetingProcessStatus = () => ({ ok: true, processing: { stage,
    transcription: { segmentCompleted: completed, segmentTotal: 3, jobGeneration: 1 } } });
  f.handlers.meetingTranscriptGet = () => ({ ok: true, transcript: { complete: false, items: [{ text: `parts-${completed}` }] } });
  await f.open();
  assert.match(f.$("fileResultContent").textContent, /parts-1/);
  f.$("fileResultPane").scrollTop = 42;
  completed = 2;
  for (const t of [...f.timers]) t(); await tick();
  assert.match(f.$("fileResultContent").textContent, /parts-2/);
  assert.equal(f.$("fileResultPane").scrollTop, 42);
  f.tabs[1].click(); await tick();
  completed = 3;
  for (const t of [...f.timers]) t(); await tick();
  assert.equal(f.ui.state.resultTab, "summary");
  f.tabs[0].click(); await tick();
  stage = "failed";
  for (const t of [...f.timers]) t(); await tick();
  assert.equal(f.ui.state.rawDoc.items[0].text, "parts-3");
  f.events.get("beforeunload")();
});

(async () => {
  for (const { name, run } of tests) { await run(); console.log(`PASS ${name}`); }
  console.log(`${tests.length} ASR recovery regressions passed (synthetic audio; no paid API calls).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
