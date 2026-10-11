"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { toFileSummaryDto, createFileSummaryService, readLatestSummaryResult } = require("../src/meeting/processing/file-summary");
const { buildMarkdown, buildTxt, buildJsonBundle, writeExportFiles } = require("../src/meeting/export/session-export");
const { createSessionStore } = require("../src/meeting/session-store");
const { RATE } = require("../src/meeting/realtime/audio");
const root = path.resolve(__dirname, "..");
const plain = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`ok - ${name}`); }

function claim(text, uncertain = false) {
  return { text, uncertain, provenance: [{ sourceId: "live:0", quote: "source text", source: "live", startFrame: 8000, endFrame: 16000 }] };
}

function summaryFixture(schema = "meeting_summary_v3") {
  return { schema, title: "Integration meeting", sampleRate: 16000, overview: claim("Overview & supported context", true),
    markdown: "# Integration meeting\n\nOverview & supported context\n",
    mindmap: { ...claim("Root"), children: [
      { ...claim("First chapter"), sectionId: "section-1", children: [{ ...claim("First child"), children: [] }] },
      { ...claim("Second chapter"), sectionId: "section-2", children: [] }
    ] }, sections: [
      { id: "section-1", heading: "First chapter", paragraphs: [claim("First paragraph & detail")], items: [] },
      { id: "section-2", heading: "Second chapter", paragraphs: [claim("Second paragraph", true)], items: [claim("Follow up", true)] }
    ] };
}

function liveDtoFactory() {
  const source = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const dtoCode = source.slice(source.indexOf("function liveSectionIdDto("), source.indexOf("function publishLiveUpdate("));
  const fieldsCode = source.slice(source.indexOf("function pickMeetingFields("), source.indexOf("function registerLiveIpc("));
  return vm.runInNewContext(`${fieldsCode}\n${dtoCode}\nliveDto;`, {
    path, liveWindowSnapshot: () => ({}), liveOutputPaths: new Set()
  });
}

function loadWithPostprocessor(relative, stub) {
  const file = path.join(root, relative);
  const localRequire = createRequire(file);
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { module: mod, exports: mod.exports,
    require: id => /(?:\.\/postprocess|\.\.\/realtime\/postprocess)$/.test(id) ? stub : localRequire(id),
    Buffer, structuredClone, AbortController, setTimeout, clearTimeout, setInterval, clearInterval
  }, { filename: file });
  return mod.exports;
}

async function storeSummary(sessionDir, result) {
  const key = digest(JSON.stringify(result));
  const dir = path.join(sessionDir, "realtime/postprocess", key);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "result.json"), JSON.stringify(result));
  await fsp.writeFile(path.join(dir, "meeting.summary.md"), result.markdown);
  await fsp.writeFile(path.join(sessionDir, "realtime/postprocess/summary-latest.json"),
    JSON.stringify({ key, resultDigest: key }));
}

async function main() {
  const liveDto = liveDtoFactory();
  for (const [label, convert, maxNodes] of [
    ["file", value => toFileSummaryDto(value), 500], ["live", value => plain(liveDto(value)), 1000]
  ]) {
    await test(`${label} DTO preserves v3 chapter order, overview evidence and inherited local IDs`, () => {
      const summary = summaryFixture();
      summary.apiKey = "hidden-fixture";
      summary.overview.apiKey = "hidden-fixture";
      summary.overview.children = [{ text: "hidden-fixture" }];
      summary.overview.provenance[0].providerResponse = "hidden-fixture";
      summary.mindmap.children[0].children[0].sectionId = "section-2";
      summary.sections[0].providerResponse = "hidden-fixture";
      const dto = convert({ sessionId: "test", summary, apiKey: "hidden-fixture" });
      assert.equal(dto.summary.schema, "meeting_summary_v3");
      assert.equal(dto.summary.sampleRate, 16000);
      assert.equal(dto.summary.overview.text, summary.overview.text);
      assert.equal(dto.summary.overview.uncertain, true);
      assert.equal(dto.summary.overview.provenance[0].startFrame, 8000);
      assert.deepEqual(dto.summary.sections.map(s => s.id), ["section-1", "section-2"]);
      assert.deepEqual(dto.summary.mindmap.children.map(n => n.sectionId), dto.summary.sections.map(s => s.id));
      assert.equal(dto.summary.mindmap.children[0].children[0].sectionId, "section-1");
      assert.doesNotMatch(JSON.stringify(dto), /hidden-fixture|apiKey|providerResponse/);
      assert.equal(summary.mindmap.children[0].children[0].sectionId, "section-2", "DTO must not mutate stored input");
    });
    await test(`${label} DTO drops nonlocal IDs, malformed fields and invalid sample rates`, () => {
      for (const id of ["../section-1", "section-0", "section-01", "https://unit.invalid", "section-1\n", 1, {}, "section-" + "1".repeat(201)]) {
        const summary = summaryFixture();
        summary.mindmap.children[0].sectionId = id;
        summary.sections[0].id = id;
        summary.sampleRate = Infinity;
        summary.overview = { text: { apiKey: "hidden-fixture" } };
        summary.sections.push(null, [], { heading: { apiKey: "hidden-fixture" } });
        const dto = convert({ summary });
        assert.equal(dto.summary.mindmap.children[0].sectionId, undefined);
        assert.equal(dto.summary.sections[0].id, undefined);
        assert.equal(dto.summary.sampleRate, undefined);
        assert.equal(dto.summary.overview, null);
        assert.equal(dto.summary.sections.length, 2);
        assert.doesNotMatch(JSON.stringify(dto), /hidden-fixture/);
      }
      for (const sampleRate of [0, -1, "16000", 1.5, NaN, 768001, { apiKey: "hidden-fixture" }]) {
        assert.equal(convert({ summary: { ...summaryFixture(), sampleRate } }).summary.sampleRate, undefined);
      }
    });
    await test(`${label} DTO bounds cyclic trees, provenance, text and the total claim count`, () => {
      const node = { ...claim("x".repeat(5000)), sectionId: "section-1" };
      node.children = [node];
      const summary = summaryFixture();
      summary.mindmap = node;
      summary.overview.provenance = Array.from({ length: 1000 }, () => ({ quote: "q".repeat(3000) }));
      const section = { id: "section-1", heading: "Chapter", items: [],
        paragraphs: Array.from({ length: 1100 }, () => claim("bounded paragraph")) };
      summary.sections = Array.from({ length: 1200 }, () => section);
      const dto = convert({ summary });
      assert.equal(dto.summary.mindmap.text.length, 4000);
      assert.ok(dto.summary.overview.provenance.length <= 32);
      assert.ok(dto.summary.overview.provenance[0].quote.length <= 2000);
      let count = 0;
      const walk = n => { if (!n) return; count++; for (const c of n.children || []) walk(c); };
      walk(dto.summary.overview); walk(dto.summary.mindmap);
      for (const s of dto.summary.sections) for (const c of [...(s.paragraphs || []), ...s.items]) walk(c);
      assert.ok(count <= maxNodes);
    });
    await test(`${label} DTO retains v1 and v2 readback`, () => {
      for (const schema of ["meeting_summary_v1", "meeting_summary_v2"]) {
        const summary = summaryFixture(schema);
        delete summary.overview; delete summary.sampleRate;
        const dto = convert({ summary });
        assert.equal(dto.summary.schema, schema);
        assert.equal(dto.summary.sections[1].items[0].text, "Follow up");
        assert.equal(dto.summary.sections[0].paragraphs[0].text, "First paragraph & detail");
      }
    });
    await test(`${label} DTO retains full 3600-character engine paragraphs with bounded evidence quotes`, () => {
      const summary = summaryFixture();
      summary.sections[0].paragraphs[0].text = "p".repeat(3600);
      summary.sections[0].paragraphs[0].provenance[0].quote = "q".repeat(2200);
      const dto = convert({ summary });
      assert.equal(dto.summary.sections[0].paragraphs[0].text.length, 3600);
      assert.equal(dto.summary.sections[0].paragraphs[0].provenance[0].quote.length, 2000);
    });
  }

  await test("file history accepts digest-validated v1/v2/v3 and retains v3 fields without model calls", async () => {
    const sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-v3-history-"));
    for (const schema of ["meeting_summary_v1", "meeting_summary_v2", "meeting_summary_v3"]) {
      const result = { ...summaryFixture(schema), sessionId: "history-test", apiKey: "hidden-fixture" };
      await storeSummary(sessionDir, result);
      const read = await readLatestSummaryResult(sessionDir, "history-test");
      assert.equal(read.result.schema, schema);
      assert.equal(await readLatestSummaryResult(sessionDir, "other-session"), null);
      const service = createFileSummaryService({ sessionDir, sessionId: "history-test", modelId: "test",
        llm: () => assert.fail("history read cannot call a model") });
      const status = await service.status();
      assert.equal(status.summary.sampleRate, 16000);
      assert.equal(status.summary.overview.text, result.overview.text);
      assert.equal(status.summary.sections[1].id, "section-2");
      assert.doesNotMatch(JSON.stringify(status), /hidden-fixture/);
      await fsp.writeFile(read.resultPath, JSON.stringify({ ...result, title: "tampered" }));
      assert.equal(await readLatestSummaryResult(sessionDir, "history-test"), null);
    }
  });

  await test("file service adopts v3 from the durable result even with a legacy outcome DTO", async () => {
    const sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-v3-adopt-"));
    const result = { ...summaryFixture(), sessionId: "adopt-test", providerResponse: "hidden-fixture" };
    const { createFileSummaryService: factory } = loadWithPostprocessor("src/meeting/processing/file-summary.js", {
      createMeetingPostprocessor: () => ({ summarize: async () => ({ status: "completed", result,
        summary: { schema: "meeting_summary_v2", title: "stale" }, paths: { summaryMarkdownPath: path.join(sessionDir, "summary.md") } }),
        getStatus: () => ({ status: "idle" }) })
    });
    const service = factory({ sessionDir, sessionId: "adopt-test", modelId: "test", llm: async () => {} });
    const dto = plain(await service.summarize());
    assert.equal(dto.summary.schema, "meeting_summary_v3");
    assert.equal(dto.summary.title, result.title);
    assert.equal(dto.summary.overview.text, result.overview.text);
    assert.equal(dto.summary.sampleRate, result.sampleRate);
    assert.equal(dto.summary.sections[0].id, "section-1");
    assert.doesNotMatch(JSON.stringify(dto), /hidden-fixture/);
  });

  await test("live service adopts and persists v3 without changing raw text or complete audio", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-v3-live-"));
    const store = createSessionStore({ sessionsRoot: path.join(dir, "sessions") });
    const result = summaryFixture();
    const { createRealtimeMeetingService } = loadWithPostprocessor("src/meeting/realtime/index.js", {
      createMeetingPostprocessService: () => ({ summarize: async () => ({ status: "completed", result }) })
    });
    const capture = { store, getLifecycle: () => ({ status: "idle" }),
      createAndPrepareSession: async ({ title }) => ({ sessionId: (await store.createSession({ title })).session.id }),
      startMicrophone: async () => ({ ok: true }), stop: async () => ({ ok: true }) };
    const service = createRealtimeMeetingService({ captureService: capture, defaultDirectory: path.join(dir, "notes"),
      pumpIntervalMs: 60000, saveIntervalMs: 60000, transcribeImpl: async () => ({ text: "Immutable raw text." }), llmImpl: async () => {} });
    try {
      await service.start({ captureMode: "microphone", modelId: "mimo-v2.5-asr" });
      const sessionDir = path.join(store.sessionsRoot, service.status().sessionId);
      const trackDir = path.join(sessionDir, "audio/microphone");
      const format = { sampleRate: RATE, channels: 1, bitsPerSample: 16, formatTag: 1, blockAlign: 2 };
      await fsp.writeFile(path.join(trackDir, "manifest.json"), JSON.stringify({ actualL0Format: format }));
      await fsp.writeFile(path.join(trackDir, "000001.l0.pcm"), Buffer.alloc(RATE * 2));
      await fsp.writeFile(path.join(trackDir, "index.jsonl"), JSON.stringify({ seq: 1, file: "000001.l0.pcm", format, frameStart: 0 }) + "\n");
      await service.stop(); await service.waitForIdle();
      const before = service.status();
      const audio = digest(await fsp.readFile(before.audioPaths[0]));
      const raw = await fsp.readFile(before.markdownPath, "utf8");
      await service.summarize(); await service.waitForIdle();
      const dto = service.status();
      assert.equal(dto.postprocessStatus, "completed");
      assert.equal(dto.summary.overview.text, result.overview.text);
      assert.equal(dto.summary.sampleRate, result.sampleRate);
      assert.equal(dto.summary.sections[0].id, "section-1");
      const saved = JSON.parse(await fsp.readFile(path.join(sessionDir, "realtime/state.json"), "utf8"));
      assert.equal(saved.summary.overview.text, result.overview.text);
      assert.equal(saved.summary.sampleRate, 16000);
      assert.equal(dto.rawText, before.rawText);
      assert.equal(await fsp.readFile(before.markdownPath, "utf8"), raw);
      assert.equal(digest(await fsp.readFile(before.audioPaths[0])), audio);
    } finally { await service.shutdown(); }
  });

  await test("v3 MD/TXT/Word export includes overview and ordered chapters with safe local anchors", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-v3-export-"));
    const summary = summaryFixture();
    const base = { summary, scope: "summary", session: { id: "export", title: "Export" } };
    const md = buildMarkdown(base);
    const txt = buildTxt(base);
    for (const text of [md, txt]) {
      assert.ok(text.includes(summary.overview.text));
      assert.ok(text.indexOf(summary.overview.text) < text.indexOf("First paragraph & detail"));
      assert.ok(text.indexOf("First paragraph & detail") < text.indexOf("Second paragraph"));
      assert.match(text, /Follow up/);
      assert.doesNotMatch(text, /```json|"provenance"/);
    }
    assert.match(md, /\[First chapter\]\(#section-1\)/);
    assert.match(md, /<a id="section-1"><\/a>/);
    assert.match(md, /### First chapter/);
    assert.doesNotMatch(txt, /<a id=|\]\(#section/);
    const outPath = path.join(dir, "summary.docx");
    await writeExportFiles({ ...base, outPath, format: "word" });
    const bytes = await fsp.readFile(outPath);
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.ok(bytes.includes(Buffer.from("Overview &amp; supported context")));
    assert.ok(bytes.includes(Buffer.from('<w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">First chapter')));
    assert.ok(bytes.indexOf(Buffer.from("First paragraph &amp; detail")) < bytes.indexOf(Buffer.from("Second paragraph")));
    const json = buildJsonBundle({ ...base, summary: { ...summary, apiKey: "hidden-fixture" } });
    assert.equal(json.summary.overview.text, summary.overview.text);
    assert.equal(json.summary.sections[0].id, "section-1");
    assert.equal(json.summary.sampleRate, 16000);
    assert.doesNotMatch(JSON.stringify(json), /hidden-fixture/);
    summary.sections[0].id = 'section-1" onclick="hidden-fixture';
    summary.mindmap.children[0].sectionId = "https://hidden-fixture.invalid";
    assert.doesNotMatch(buildMarkdown(base), /hidden-fixture/);
    console.log(`DOCX fixture: ${outPath}`);
  });

  await test("file export IPC forwards allowlisted v3 data and removes nested provider bodies", async () => {
    const sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-v3-export-ipc-"));
    const result = { ...summaryFixture(), sessionId: "export-ipc" };
    result.overview.apiKey = "hidden-fixture";
    result.overview.provenance[0].providerResponse = "hidden-fixture";
    result.sections[0].paragraphs[0].providerResponse = "hidden-fixture";
    await storeSummary(sessionDir, result);
    const outPath = path.join(sessionDir, "export.json");
    const source = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
    const fields = source.slice(source.indexOf("function pickMeetingFields("), source.indexOf("function registerLiveIpc("));
    const code = source.slice(source.indexOf('ipcMain.handle("file:export:save"'), source.indexOf('ipcMain.handle("meeting:import:wav"'));
    let handler;
    vm.runInNewContext(`${fields}\n${code}`, { path, require: createRequire(path.join(root, "src/main.js")),
      ipcMain: { handle: (_channel, fn) => { handler = fn; } },
      getMeetingCapture: () => ({ store: { readSession: async () => ({ sessionDir,
        session: { id: result.sessionId, source: "import", title: "Export" } }) } }),
      getMeetingProcessor: () => ({ getRawTranscript: async () => null }),
      getMeetingAnalyzer: () => ({ getCorrectedTranscript: async () => null,
        getSummary: async () => assert.fail("validated shared summary must win over legacy artifacts") }),
      BrowserWindow: { getFocusedWindow: () => null }, mainWindow: null,
      dialog: { showSaveDialog: async () => ({ filePath: outPath, canceled: false }) },
      meetingSpeakerMap: { readSpeakerMap: async () => ({ speakers: {} }) },
      meetingSessionExport: require("../src/meeting/export/session-export"),
      meetingIpcError: error => { throw error; }
    });
    assert.equal((await handler({}, { sessionId: result.sessionId, format: "json", scope: "summary" })).ok, true);
    const json = JSON.parse(await fsp.readFile(outPath, "utf8"));
    assert.equal(json.summary.schema, "meeting_summary_v3");
    assert.equal(json.summary.overview.text, result.overview.text);
    assert.equal(json.summary.sampleRate, result.sampleRate);
    assert.deepEqual(json.summary.sections.map(s => s.id), ["section-1", "section-2"]);
    assert.doesNotMatch(JSON.stringify(json), /hidden-fixture|providerResponse|apiKey/);
  });

  await test("legacy v1 items and v2 continuous prose keep their export behavior", () => {
    const v1 = summaryFixture("meeting_summary_v1");
    const v2 = summaryFixture("meeting_summary_v2");
    delete v1.overview; delete v2.overview;
    assert.match(buildMarkdown({ summary: v1, scope: "summary" }), /### First chapter/);
    const md = buildMarkdown({ summary: v2, scope: "summary" });
    assert.match(md, /整理正文/);
    assert.match(md, /First paragraph & detail/);
    assert.doesNotMatch(md, /### First chapter|Follow up|<a id=/);
    assert.doesNotMatch(buildMarkdown({ summary: v1, scope: "raw" }), /First paragraph|Follow up/);
  });
  console.log(`${passed} summary v3 integration tests passed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
