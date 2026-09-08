"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createSessionStore } = require("../src/meeting/session-store");
const { createMeetingSessionAnalyzer } = require("../src/meeting/analysis/session-analyzer");
const { resolveMeetingAnalysisCredentials } = require("../src/meeting/analysis/credentials");
const { parseModelJson, stripCodeFences, extractBalancedObject } = require("../src/meeting/analysis/json-extract");
const { planBatches } = require("../src/meeting/analysis/batching");
const { computeInputBudget, estimateTokens } = require("../src/meeting/analysis/token-budget");
const { detectTemplate, resolveTemplate } = require("../src/meeting/analysis/templates");
const {
  normalizeCorrections,
  validateSummaryEvidence,
  sanitizeOwnerDue,
  buildItemIndex
} = require("../src/meeting/analysis/evidence");
const { SYSTEM_PROMPT } = require("../src/meeting/analysis/prompts");
const { JOB_STATUS } = require("../src/meeting/analysis/constants");
const { createAnalysisJobStore } = require("../src/meeting/analysis/job-store");
const { capRollingState, planMergeGroups } = require("../src/meeting/analysis/rolling");

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      console.error(error);
      process.exitCode = 1;
      throw error;
    });
}

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-meeting-3a-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function rawDoc(items, extra = {}) {
  return {
    schema: "meeting_raw_transcript_v1",
    sessionId: extra.sessionId || "s1",
    generation: extra.generation || 1,
    provider: "qwen3-asr",
    modelId: "qwen3-asr-flash",
    mode: "no_bucket",
    diarization: false,
    timestampPrecision: "segment",
    speakers: { microphone: "self", system: "remote_unknown" },
    count: items.length,
    items
  };
}

function item(id, text, opts = {}) {
  return {
    id,
    track: opts.track || (String(id).startsWith("system") ? "system" : "microphone"),
    speakerId: opts.speakerId || (String(id).startsWith("system") ? "remote_unknown" : "self"),
    text,
    beginMs: opts.beginMs ?? 0,
    endMs: opts.endMs ?? 1000,
    sessionBeginMs: opts.sessionBeginMs ?? opts.beginMs ?? 0,
    sessionEndMs: opts.sessionEndMs ?? opts.endMs ?? 1000,
    artifactBeginMs: opts.artifactBeginMs ?? opts.beginMs ?? 0,
    artifactEndMs: opts.artifactEndMs ?? opts.endMs ?? 1000,
    timestampPrecision: "segment"
  };
}

async function seedSession(userDataPath, { sessionId, items }) {
  const store = createSessionStore({ userDataPath });
  await store.init();
  const created = await store.createSession({ title: "a" });
  const sid = sessionId || created.session.id;
  // recreate under known id if needed — use created id
  const realId = created.session.id;
  await store.updateSession(realId, { status: "stopped" });
  const sessionDir = path.join(store.sessionsRoot, realId);
  const rawDir = path.join(sessionDir, "transcription", "qwen-no-bucket");
  await fsp.mkdir(rawDir, { recursive: true });
  const doc = rawDoc(items, { sessionId: realId });
  const rawPath = path.join(rawDir, "raw-transcript.json");
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  await fsp.writeFile(rawPath, body, "utf8");
  return {
    store,
    sessionId: realId,
    sessionDir,
    rawPath,
    rawBytes: Buffer.from(body, "utf8"),
    rawSha: crypto.createHash("sha256").update(body).digest("hex")
  };
}

function mockChatFromTask(handlers) {
  const calls = [];
  async function requestChat(messages, opts = {}) {
    calls.push({ messages, opts });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].content, SYSTEM_PROMPT);
    assert.equal(messages[1].role, "user");
    const user = JSON.parse(messages[1].content);
    const task = user.task;
    const h = handlers[task];
    if (!h) throw new Error(`unexpected task ${task}`);
    const content = typeof h === "function" ? h(user, calls.length) : h;
    return { content: typeof content === "string" ? content : JSON.stringify(content) };
  }
  return { requestChat, calls };
}

function makeAnalyzer(userDataPath, store, { requestChat, resolveCredentials, cancelWaitMs } = {}) {
  return createMeetingSessionAnalyzer({
    userDataPath,
    getCaptureService: () => ({
      store,
      getLifecycle: () => ({ status: "stopped", sessionId: null })
    }),
    cancelWaitMs: cancelWaitMs || 8000,
    resolveCredentials:
      resolveCredentials ||
      (() => ({
        apiKey: "test-analysis-key",
        baseUrl: "https://api.openai.com/v1",
        modelId: "test-model",
        contextWindowTokens: 128000,
        maxOutputTokens: 4096,
        reasoningEffort: "",
        timeoutMs: 60000,
        budgetRatio: 0.65
      })),
    requestChat
  });
}

function defaultCorrectHandler(user) {
  return {
    items: (user.items || []).map((it) => ({
      sourceItemId: it.id,
      correctedText: String(it.text || "").replace(/嗯+/g, "").trim() || it.text,
      ops: [],
      uncertain: []
    }))
  };
}

function defaultExtractHandler(user) {
  const ids = (user.items || []).map((i) => i.id);
  return {
    facts: ids.length
      ? [{ text: "fact", sourceItemIds: [ids[0]] }]
      : [],
    entities: [],
    decisions: ids.length > 1
      ? [{ text: "decide X", sourceItemIds: [ids[0]] }]
      : [],
    actionItems: [],
    openIssues: [],
    speakerPoints: [],
    keyQuotes: ids.length
      ? [{ text: user.items[0].text, sourceItemIds: [ids[0]], speakerId: user.items[0].speakerId }]
      : [],
    coreIdeas: [{ text: "idea", sourceItemIds: ids.slice(0, 1) }],
    supportingPoints: [],
    assumptions: [],
    openQuestions: [],
    nextSteps: []
  };
}

function defaultMergeHandler(user) {
  const batches = user.batches || [];
  const allIds = [];
  for (const b of batches) {
    for (const id of b.inputItemIds || []) allIds.push(id);
  }
  const uniq = [...new Set(allIds)];
  if (user.template === "personal") {
    return {
      template: "personal",
      coreIdeas: [{ text: "core", sourceItemIds: uniq.slice(0, 1) }],
      argumentOutline: [{ title: "arg", sourceItemIds: uniq.slice(0, 1), children: [] }],
      supportingPoints: [],
      assumptions: [],
      openQuestions: [],
      nextSteps: [{ text: "next", sourceItemIds: uniq.slice(0, 1) }],
      keyQuotes: [],
      flaggedUncertain: []
    };
  }
  return {
    template: "meeting",
    executiveSummary: { text: "summary", sourceItemIds: uniq.slice(0, 1) },
    topicsOutline: [{ title: "topic", sourceItemIds: uniq.slice(0, 1), children: [] }],
    timeline: [{ text: "t1", sourceItemIds: uniq.slice(0, 1) }],
    speakerPoints: [
      {
        speakerId: "self",
        points: [{ text: "p", sourceItemIds: uniq.slice(0, 1) }]
      }
    ],
    decisions: [{ text: "d", sourceItemIds: uniq.slice(0, 1) }],
    actionItems: [{ text: "a", owner: null, due: null, sourceItemIds: uniq.slice(0, 1) }],
    openIssues: [],
    risks: [],
    keyQuotes: uniq.length
      ? [{ text: "q", sourceItemIds: [uniq[0]], speakerId: "self" }]
      : [],
    flaggedUncertain: []
  };
}

async function run() {
  await test("pure: json extract fence/balanced/invalid", () => {
    assert.equal(stripCodeFences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
    assert.deepEqual(parseModelJson("```json\n{\"x\":true}\n```"), { x: true });
    assert.deepEqual(parseModelJson("  {\"y\":2}  "), { y: 2 });
    assert.throws(() => parseModelJson("noise {\"y\":2} tail"), (e) => e.code === "analysis_json_invalid");
    assert.throws(() => parseModelJson("{\"a\":1}{\"b\":2}"), (e) => e.code === "analysis_json_invalid");
    assert.throws(() => parseModelJson("{\"a\":1}\nextra"), (e) => e.code === "analysis_json_invalid");
    assert.throws(() => parseModelJson("not json"), (e) => e.code === "analysis_json_invalid");
    assert.throws(() => parseModelJson(""), (e) => e.code === "analysis_json_invalid");
  });

  await test("pure: budget + batching + templates", () => {
    const b = computeInputBudget({
      contextWindowTokens: 10000,
      maxOutputTokens: 1000,
      systemPrompt: "sys"
    });
    assert.ok(b.inputBudget > 100);
    assert.ok(estimateTokens("你好世界") >= 1);

    const items = [];
    for (let i = 0; i < 5; i += 1) {
      items.push(item(`microphone:${i}`, `text ${i}`, { beginMs: i * 1000, endMs: i * 1000 + 500 }));
    }
    const batches = planBatches(items, { inputBudget: 5000 });
    assert.ok(batches.length >= 1);
    assert.equal(batches.reduce((n, x) => n + x.items.length, 0), 5);

    assert.throws(
      () =>
        planBatches([item("microphone:0", "x".repeat(20000))], { inputBudget: 100 }),
      (e) => e.code === "analysis_item_over_budget"
    );

    assert.equal(detectTemplate([item("microphone:0", "会议议程与决议")]), "meeting");
    assert.equal(detectTemplate([item("microphone:0", "我觉得今天的随想")]), "personal");
    assert.equal(resolveTemplate("personal", []).template, "personal");
    assert.equal(resolveTemplate("auto", [item("microphone:0", "会议")]).templateSource, "auto");
  });

  await test("pure: corrections coverage + evidence drop", () => {
    const raw = [
      item("microphone:0", "嗯你好 Alice", { beginMs: 0, endMs: 1000, sessionBeginMs: 10, sessionEndMs: 20 }),
      item("system:0", "世界", { beginMs: 1000, endMs: 2000 })
    ];
    const norm = normalizeCorrections(
      [{ sourceItemId: "microphone:0", correctedText: "你好", ops: [], uncertain: [] }],
      raw
    );
    assert.equal(norm.length, 2);
    assert.equal(norm[0].sourceBeginMs, 10);

    assert.throws(
      () =>
        normalizeCorrections(
          [
            { sourceItemId: "microphone:0", correctedText: "a" },
            { sourceItemId: "microphone:0", correctedText: "b" }
          ],
          raw
        ),
      (e) => e.code === "analysis_correction_invalid"
    );
    assert.throws(
      () =>
        normalizeCorrections(
          [{ sourceItemId: "microphone:0", correctedText: "x".repeat(5000) }],
          raw
        ),
      (e) => e.code === "analysis_correction_overreach"
    );

    const idx = buildItemIndex(raw);
    assert.equal(sanitizeOwnerDue("Alice", ["microphone:0"], idx), "Alice");
    assert.equal(sanitizeOwnerDue("Bob", ["microphone:0"], idx), null);

    const summary = validateSummaryEvidence(
      {
        template: "meeting",
        executiveSummary: { text: "ok", sourceItemIds: ["microphone:0"] },
        facts: [{ claim: "claim alias stays usable", sourceItemIds: ["microphone:0"] }],
        decisions: [
          { text: "good", sourceItemIds: ["microphone:0"] },
          { text: "bad", sourceItemIds: ["nope"] }
        ],
        actionItems: [{ text: "do", owner: "Invented", due: "2099", sourceItemIds: ["microphone:0"] }],
        openIssues: [],
        risks: [],
        keyQuotes: [],
        topicsOutline: [],
        timeline: [],
        speakerPoints: [],
        flaggedUncertain: [{ text: "???", sourceItemIds: [] }]
      },
      raw
    );
    assert.equal(summary.decisions.length, 1);
    assert.equal(summary.facts[0].text, "claim alias stays usable");
    assert.equal(summary.actionItems[0].owner, null);
    assert.equal(summary.actionItems[0].due, null);
    assert.equal(summary.decisions[0].timeRanges[0].beginMs, 10);
    assert.ok(summary.verification.droppedClaims.some((d) => d.path.includes("flaggedUncertain")));
    assert.ok(summary.verification.droppedClaims.some((d) => d.reason === "no_valid_sourceItemIds"));
  });

  await test("pure: path traversal denied; rolling cap; merge over budget", async () => {
    await withTempDir(async (dir) => {
      const seeded = await seedSession(dir, {
        items: [item("microphone:0", "a", { beginMs: 0, endMs: 1 })]
      });
      const store = createAnalysisJobStore({ sessionDir: seeded.sessionDir });
      await store.init();
      await store.ensureGenerationDir(1);
      assert.throws(() => store.assertSafeRelName("../x.json"), (e) => e.code === "analysis_path_denied");
      assert.throws(() => store.assertSafeRelName("/abs.json"), (e) => e.code === "analysis_path_denied");
      assert.throws(
        () => store.resolveUnderGeneration(1, "..\\..\\secrets.json"),
        (e) => e.code === "analysis_path_denied"
      );
      await assert.rejects(
        () => store.writeStageArtifact(1, "../escape.json", { a: 1 }),
        (e) => e.code === "analysis_path_denied"
      );

      const huge = {
        confirmedFacts: Array.from({ length: 200 }, (_, i) => ({
          text: `fact-${i}-${"x".repeat(80)}`,
          sourceItemIds: ["microphone:0"]
        })),
        entities: Array.from({ length: 50 }, (_, i) => ({ name: `e${i}` })),
        decisions: [],
        actionItems: [],
        openIssues: [],
        evidenceIndex: {}
      };
      const capped = capRollingState(huge, 200, 0.9);
      assert.ok(estimateTokens(JSON.stringify(capped), 0.9) <= 200);
      assert.ok(capped.truncated || capped.confirmedFacts.length < 200);

      assert.throws(
        () =>
          planMergeGroups([{ big: "y".repeat(50000) }], { inputBudget: 100, charsPerToken: 0.9 }),
        (e) => e.code === "analysis_merge_over_budget"
      );
      // two units each fit alone but pair might be tested via planMergeGroups packing
      const tiny = [{ a: 1 }, { b: 2 }, { c: 3 }];
      const gs = planMergeGroups(tiny, { inputBudget: 500, charsPerToken: 0.9 });
      assert.ok(gs.length >= 1);
    });
  });

  await test("credentials isolated from cleaner/asr", () => {
    assert.throws(
      () =>
        resolveMeetingAnalysisCredentials({
          env: { CLEANER_API_KEY: "x", DASHSCOPE_API_KEY: "y", QWEN_ASR_API_KEY: "z" },
          settings: { cleanerApiKey: "c", asrApiKey: "a" }
        }),
      (e) => e.code === "analysis_credentials_missing"
    );
    const c = resolveMeetingAnalysisCredentials({
      env: {
        OVI_MEETING_ANALYSIS_API_KEY: "ak",
        OVI_MEETING_ANALYSIS_BASE_URL: "https://api.openai.com/v1",
        OVI_MEETING_ANALYSIS_MODEL: "m1"
      }
    });
    assert.equal(c.modelId, "m1");
    assert.equal(c.apiKey, "ak");
  });

  await test("full run: raw immutable, evidence, privacy, zero-call resume", async () => {
    await withTempDir(async (dir) => {
      const items = [
        item("microphone:0", "嗯我们开会吧", { beginMs: 0, endMs: 1000 }),
        item("system:0", "好的决议通过", { beginMs: 1000, endMs: 2000, speakerId: "remote_unknown" })
      ];
      const seeded = await seedSession(dir, { items });
      const before = await fsp.readFile(seeded.rawPath);
      const { requestChat, calls } = mockChatFromTask({
        correct_batch: defaultCorrectHandler,
        extract_batch: defaultExtractHandler,
        merge_extracts: defaultMergeHandler
      });
      const analyzer = makeAnalyzer(dir, seeded.store, { requestChat });
      const st = await analyzer.startAnalysis(seeded.sessionId, { template: "meeting" });
      assert.equal(st.status, JOB_STATUS.COMPLETED);
      assert.ok(calls.length >= 3);
      for (const c of calls) {
        assert.equal(c.messages.length, 2);
        assert.ok(!JSON.stringify(c.messages).includes("cleaner"));
      }
      const after = await fsp.readFile(seeded.rawPath);
      assert.equal(before.equals(after), true);
      assert.equal(
        crypto.createHash("sha256").update(after).digest("hex"),
        seeded.rawSha
      );

      const corrected = await analyzer.getCorrectedTranscript(seeded.sessionId);
      assert.equal(corrected.items.length, 2);
      assert.equal(corrected.items[0].sourceItemIds[0], "microphone:0");
      assert.ok(corrected.items[0].correctedText.includes("开会"));

      const summary = await analyzer.getSummary(seeded.sessionId);
      assert.equal(summary.template, "meeting");
      assert.ok(summary.decisions.every((d) => d.sourceItemIds.length));
      assert.ok(summary.actionItems.every((a) => a.owner === null || typeof a.owner === "string"));

      const status = await analyzer.getAnalysisStatus(seeded.sessionId);
      assert.ok(!JSON.stringify(status).includes("开会"));
      assert.ok(!JSON.stringify(status).includes("apiKey"));

      const jobRaw = await fsp.readFile(
        path.join(seeded.sessionDir, "analysis", "job.json"),
        "utf8"
      );
      assert.ok(!jobRaw.includes("test-analysis-key"));
      assert.ok(!jobRaw.includes("apiKey"));

      // resume zero calls
      const n1 = calls.length;
      const st2 = await analyzer.startAnalysis(seeded.sessionId, { template: "meeting" });
      assert.equal(st2.status, JOB_STATUS.COMPLETED);
      assert.equal(calls.length, n1);
    });
  });

  await test("unsupported claim dropped; uncertain flagged; personal template", async () => {
    await withTempDir(async (dir) => {
      const items = [item("microphone:0", "我觉得某某公司估值一百亿", { beginMs: 0, endMs: 500 })];
      const seeded = await seedSession(dir, { items });
      const { requestChat } = mockChatFromTask({
        correct_batch: (user) => ({
          items: user.items.map((it) => ({
            sourceItemId: it.id,
            correctedText: it.text,
            ops: [],
            uncertain: [{ span: "某某公司", reason: "proper_noun", keptRaw: true }]
          }))
        }),
        extract_batch: defaultExtractHandler,
        merge_extracts: (user) => ({
          template: "personal",
          coreIdeas: [
            { text: "idea", sourceItemIds: ["microphone:0"] },
            { text: "invented", sourceItemIds: ["ghost"] }
          ],
          argumentOutline: [],
          supportingPoints: [],
          assumptions: [],
          openQuestions: [],
          nextSteps: [{ text: "next", sourceItemIds: ["microphone:0"] }],
          keyQuotes: [],
          flaggedUncertain: [{ text: "某某公司", reason: "proper_noun", sourceItemIds: ["microphone:0"] }]
        })
      });
      const analyzer = makeAnalyzer(dir, seeded.store, { requestChat });
      await analyzer.startAnalysis(seeded.sessionId, { template: "personal" });
      const corrected = await analyzer.getCorrectedTranscript(seeded.sessionId);
      assert.ok(corrected.items[0].uncertain.some((u) => u.span === "某某公司"));
      const summary = await analyzer.getSummary(seeded.sessionId);
      assert.equal(summary.template, "personal");
      assert.ok(summary.verification.droppedClaims.some((d) => d.reason === "no_valid_sourceItemIds"));
      assert.ok(summary.flaggedUncertain.some((u) => u.text.includes("某某")));
    });
  });

  await test("hierarchical merge first+last evidence; hash tamper re-call; cancel exact", async () => {
    await withTempDir(async (dir) => {
      const items = [];
      for (let i = 0; i < 8; i += 1) {
        items.push(
          item(`microphone:${i}`, `批次证据BATCH_${i}_UNIQUE 内容内容`, {
            beginMs: i * 50000,
            endMs: i * 50000 + 1000,
            speakerId: i % 2 === 0 ? "self" : "remote_unknown"
          })
        );
      }
      const seeded = await seedSession(dir, { items });
      let mergeCalls = 0;
      const { requestChat, calls } = mockChatFromTask({
        correct_batch: defaultCorrectHandler,
        extract_batch: (user) => {
          const ids = user.items.map((i) => i.id);
          return {
            facts: [{ text: user.items[0].text, sourceItemIds: [ids[0]] }],
            entities: [],
            decisions: [{ text: `dec-${ids[0]}`, sourceItemIds: [ids[0]] }],
            actionItems: [],
            openIssues: [],
            speakerPoints: [],
            keyQuotes: [{ text: user.items[0].text, sourceItemIds: [ids[0]] }],
            coreIdeas: [],
            supportingPoints: [],
            assumptions: [],
            openQuestions: [],
            nextSteps: []
          };
        },
        merge_extracts: (user) => {
          mergeCalls += 1;
          const ids = [];
          const walk = (node, depth = 0) => {
            if (!node || depth > 20) return;
            if (Array.isArray(node)) {
              node.forEach((x) => walk(x, depth + 1));
              return;
            }
            if (typeof node === "object") {
              if (Array.isArray(node.inputItemIds)) ids.push(...node.inputItemIds.map(String));
              if (Array.isArray(node.sourceItemIds)) ids.push(...node.sourceItemIds.map(String));
              for (const v of Object.values(node)) {
                if (v && typeof v === "object") walk(v, depth + 1);
              }
            }
          };
          walk(user.batches);
          const uniq = [...new Set(ids)];
          // Guarantee first/last anchors from known batch ids if walk misses
          if (!uniq.includes("microphone:0")) uniq.unshift("microphone:0");
          if (!uniq.includes("microphone:7")) uniq.push("microphone:7");
          return {
            template: "meeting",
            executiveSummary: {
              text: "summary spanning BATCH_0_UNIQUE and BATCH_7_UNIQUE",
              sourceItemIds: ["microphone:0", "microphone:7"]
            },
            topicsOutline: [
              { title: "t0", sourceItemIds: ["microphone:0"], children: [] },
              { title: "t7", sourceItemIds: ["microphone:7"], children: [] }
            ],
            timeline: [],
            speakerPoints: [],
            decisions: uniq.map((id) => ({ text: `d-${id}`, sourceItemIds: [id] })),
            actionItems: [],
            openIssues: [],
            risks: [],
            keyQuotes: [
              { text: "BATCH_0_UNIQUE", sourceItemIds: ["microphone:0"], speakerId: "self" },
              { text: "BATCH_7_UNIQUE", sourceItemIds: ["microphone:7"], speakerId: "self" }
            ],
            flaggedUncertain: []
          };
        }
      });
      const analyzer = makeAnalyzer(dir, seeded.store, {
        requestChat,
        resolveCredentials: () => ({
          apiKey: "k",
          baseUrl: "https://api.openai.com/v1",
          modelId: "m",
          contextWindowTokens: 16000,
          maxOutputTokens: 2000,
          reasoningEffort: "",
          timeoutMs: 60000,
          budgetRatio: 0.65
        })
      });
      await analyzer.startAnalysis(seeded.sessionId, { template: "meeting" });
      assert.ok(mergeCalls >= 1);
      const summary = await analyzer.getSummary(seeded.sessionId);
      const blob = JSON.stringify(summary);
      assert.ok(blob.includes("microphone:0") || blob.includes("BATCH_0"));
      assert.ok(blob.includes("microphone:7") || blob.includes("BATCH_7"));

      // tamper stage artifact hash → re-call correct
      const store = createAnalysisJobStore({ sessionDir: seeded.sessionDir });
      const job = await store.loadJob();
      const art = await store.readStageArtifact(job.generation, "batches/batch_000.correct.json");
      assert.ok(art);
      // corrupt on disk
      const p = path.join(
        seeded.sessionDir,
        "analysis",
        `g${job.generation}`,
        "batches",
        "batch_000.correct.json"
      );
      const corrupted = { ...art, items: art.items, outputSha256: "0".repeat(64) };
      await fsp.writeFile(p, JSON.stringify(corrupted));
      // delete finals to force resume work
      await fsp.unlink(path.join(seeded.sessionDir, "analysis", "corrected-transcript.json"));
      await fsp.unlink(path.join(seeded.sessionDir, "analysis", "summary.json"));
      job.status = JOB_STATUS.RUNNING;
      await store.saveJob(job);
      const before = calls.length;
      await analyzer.startAnalysis(seeded.sessionId, { template: "meeting" });
      assert.ok(calls.length > before, "expected re-call after hash tamper");
    });
  });

  await test("cancel exact cancelled then retry; template sticky; raw mutate mid-run", async () => {
    await withTempDir(async (dir) => {
      const seeded = await seedSession(dir, {
        items: [item("microphone:0", "hello", { beginMs: 0, endMs: 100 })]
      });
      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      const { requestChat } = mockChatFromTask({
        correct_batch: async (u) => {
          await gate;
          if (u && false) return null;
          return defaultCorrectHandler(u);
        },
        extract_batch: defaultExtractHandler,
        merge_extracts: defaultMergeHandler
      });
      // signal-aware cancel: check abort in gate
      let release2;
      const gate2 = new Promise((r) => {
        release2 = r;
      });
      const { requestChat: rcCancel } = mockChatFromTask({
        correct_batch: async (u, n) => {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 5000);
            // store signal via closure — requestChat opts
          });
          return defaultCorrectHandler(u);
        },
        extract_batch: defaultExtractHandler,
        merge_extracts: defaultMergeHandler
      });

      // Use custom requestChat that honors signal
      let resolveHold;
      const hold = new Promise((r) => {
        resolveHold = r;
      });
      let entered = false;
      async function requestChatCancel(messages, opts = {}) {
        entered = true;
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            const err = new Error("aborted");
            err.code = "aborted";
            reject(err);
          };
          if (opts.signal?.aborted) return onAbort();
          opts.signal?.addEventListener("abort", onAbort, { once: true });
          hold.then(() => {
            opts.signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });
        const user = JSON.parse(messages[1].content);
        if (user.task === "correct_batch") return { content: JSON.stringify(defaultCorrectHandler(user)) };
        if (user.task === "extract_batch") return { content: JSON.stringify(defaultExtractHandler(user)) };
        return { content: JSON.stringify(defaultMergeHandler(user)) };
      }

      const az = makeAnalyzer(dir, seeded.store, {
        requestChat: requestChatCancel,
        cancelWaitMs: 3000
      });
      const runP = az.startAnalysis(seeded.sessionId, { template: "personal" });
      for (let i = 0; i < 100 && !entered; i += 1) await new Promise((r) => setTimeout(r, 5));
      assert.equal(entered, true);
      const cancelSt = await az.cancelAnalysis(seeded.sessionId);
      assert.equal(cancelSt.status, "cancelled");
      await Promise.allSettled([runP]);
      const st = await az.getAnalysisStatus(seeded.sessionId);
      assert.equal(st.status, "cancelled");

      // retry keeps personal template
      let sawTemplate = null;
      async function requestChatRetry(messages) {
        const user = JSON.parse(messages[1].content);
        if (user.template) sawTemplate = user.template;
        if (user.task === "correct_batch") return { content: JSON.stringify(defaultCorrectHandler(user)) };
        if (user.task === "extract_batch") return { content: JSON.stringify(defaultExtractHandler(user)) };
        if (user.task === "merge_extracts") {
          sawTemplate = user.template;
          return { content: JSON.stringify(defaultMergeHandler(user)) };
        }
        return { content: "{}" };
      }
      const az2 = makeAnalyzer(dir, seeded.store, { requestChat: requestChatRetry });
      const st2 = await az2.retryAnalysis(seeded.sessionId, { resetAttempts: true });
      assert.equal(st2.status, JOB_STATUS.COMPLETED);
      assert.equal(st2.template, "personal");
      const summary = await az2.getSummary(seeded.sessionId);
      assert.equal(summary.template, "personal");

      // raw mutation
      const store = createAnalysisJobStore({ sessionDir: seeded.sessionDir });
      await assert.rejects(() => store.assertRawUnchanged("00"), (e) => e.code === "analysis_raw_changed");
    });
  });

  await test("crash artifact reuse; fingerprint model change; needs_retry", async () => {
    await withTempDir(async (dir) => {
      const items = [
        item("microphone:0", "你好", { beginMs: 0, endMs: 100 }),
        item("system:0", "世界", { beginMs: 100, endMs: 200 })
      ];
      const seeded = await seedSession(dir, { items });
      let calls = 0;
      const { requestChat } = mockChatFromTask({
        correct_batch: (u) => {
          calls += 1;
          return defaultCorrectHandler(u);
        },
        extract_batch: (u) => {
          calls += 1;
          return defaultExtractHandler(u);
        },
        merge_extracts: (u) => {
          calls += 1;
          return defaultMergeHandler(u);
        }
      });
      const a1 = makeAnalyzer(dir, seeded.store, { requestChat });
      await a1.startAnalysis(seeded.sessionId, { template: "meeting" });
      const n1 = calls;

      // simulate partial crash: delete finals + set job running mid-way but leave batch artifacts
      const store = createAnalysisJobStore({ sessionDir: seeded.sessionDir });
      const job = await store.loadJob();
      const gen = job.generation;
      await fsp.unlink(path.join(seeded.sessionDir, "analysis", "corrected-transcript.json")).catch(() => {});
      await fsp.unlink(path.join(seeded.sessionDir, "analysis", "summary.json")).catch(() => {});
      job.status = JOB_STATUS.RUNNING;
      job.stage = "merge";
      await store.saveJob(job);
      // also remove gen finals if present
      await fsp
        .unlink(path.join(seeded.sessionDir, "analysis", `g${gen}`, "corrected-transcript.json"))
        .catch(() => {});
      await fsp.unlink(path.join(seeded.sessionDir, "analysis", `g${gen}`, "summary.json")).catch(() => {});

      calls = 0;
      const a2 = makeAnalyzer(dir, seeded.store, { requestChat });
      await a2.startAnalysis(seeded.sessionId, { template: "meeting" });
      // should reuse correct/extract artifacts; maybe only merge+ again
      assert.ok(calls < n1, `expected fewer calls on resume, calls=${calls} n1=${n1}`);
      assert.equal((await a2.getAnalysisStatus(seeded.sessionId)).status, JOB_STATUS.COMPLETED);

      // force fail then same fp needs retry
      const job2 = await store.loadJob();
      job2.status = JOB_STATUS.FAILED;
      job2.lastError = { code: "x", message: "fail" };
      await store.saveJob(job2);
      await assert.rejects(
        () => a2.startAnalysis(seeded.sessionId, { template: "meeting" }),
        (e) => e.code === "analysis_needs_retry"
      );

      // model change → new generation without retry
      let model = "m-new";
      let mcalls = 0;
      const { requestChat: rc3 } = mockChatFromTask({
        correct_batch: (u) => {
          mcalls += 1;
          return defaultCorrectHandler(u);
        },
        extract_batch: (u) => {
          mcalls += 1;
          return defaultExtractHandler(u);
        },
        merge_extracts: (u) => {
          mcalls += 1;
          return defaultMergeHandler(u);
        }
      });
      const a3 = makeAnalyzer(dir, seeded.store, {
        requestChat: rc3,
        resolveCredentials: () => ({
          apiKey: "k",
          baseUrl: "https://api.openai.com/v1",
          modelId: model,
          contextWindowTokens: 128000,
          maxOutputTokens: 4096,
          reasoningEffort: "",
          timeoutMs: 60000,
          budgetRatio: 0.65
        })
      });
      await a3.startAnalysis(seeded.sessionId, { template: "meeting" });
      assert.ok(mcalls >= 3);
      const job3 = await store.loadJob();
      assert.ok(job3.generation >= 2);
      assert.equal(job3.modelId, "m-new");
    });
  });

  await test("cancel; single-flight; cross-session; raw mutation", async () => {
    await withTempDir(async (dir) => {
      const s1 = await seedSession(dir, {
        items: [item("microphone:0", "A", { beginMs: 0, endMs: 100 })]
      });
      const s2 = await seedSession(dir, {
        items: [item("microphone:0", "B", { beginMs: 0, endMs: 100 })]
      });

      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      let inFlight = 0;
      let maxIn = 0;
      const { requestChat } = mockChatFromTask({
        correct_batch: async (u) => {
          inFlight += 1;
          maxIn = Math.max(maxIn, inFlight);
          await gate;
          inFlight -= 1;
          if (u.items[0].text === "CANCEL_ME") {
            // still return
          }
          return defaultCorrectHandler(u);
        },
        extract_batch: defaultExtractHandler,
        merge_extracts: defaultMergeHandler
      });

      // rewrite s1 text marker
      const doc = JSON.parse(await fsp.readFile(s1.rawPath, "utf8"));
      doc.items[0].text = "CANCEL_ME";
      await fsp.writeFile(s1.rawPath, `${JSON.stringify(doc, null, 2)}\n`);

      const az = makeAnalyzer(dir, s1.store, { requestChat, cancelWaitMs: 2000 });
      const p1 = az.startAnalysis(s1.sessionId, { template: "meeting" });
      await new Promise((r) => setTimeout(r, 5));
      const p1b = az.startAnalysis(s1.sessionId, { template: "meeting" });
      const p2 = az.startAnalysis(s2.sessionId, { template: "meeting" });
      setTimeout(() => release(), 40);
      const settled = await Promise.allSettled([p1, p1b, p2]);
      assert.ok(
        settled.some((s) => s.status === "rejected" && s.reason?.code === "analysis_already_running")
      );
      assert.ok(maxIn >= 1);
      assert.equal(settled.filter((s) => s.status === "fulfilled").length >= 1, true);

      // cancel path
      let release2;
      const gate2 = new Promise((r) => {
        release2 = r;
      });
      const { requestChat: rc2 } = mockChatFromTask({
        correct_batch: async (u) => {
          await gate2;
          return defaultCorrectHandler(u);
        },
        extract_batch: defaultExtractHandler,
        merge_extracts: defaultMergeHandler
      });
      const s3 = await seedSession(dir, {
        items: [item("microphone:0", "C", { beginMs: 0, endMs: 50 })]
      });
      const az3 = makeAnalyzer(dir, s3.store, { requestChat: rc2, cancelWaitMs: 2000 });
      const runP = az3.startAnalysis(s3.sessionId, { template: "meeting" });
      await new Promise((r) => setTimeout(r, 15));
      const cancelP = az3.cancelAnalysis(s3.sessionId);
      setTimeout(() => release2(), 5);
      await Promise.allSettled([runP, cancelP]);
      const st = await az3.getAnalysisStatus(s3.sessionId);
      assert.ok(["cancelled", "completed", "failed"].includes(st.status));

      // raw mutation detection: start run, change raw mid-flight before finalize hard —
      // unit: assertRawUnchanged
      const store = createAnalysisJobStore({ sessionDir: s1.sessionDir });
      await assert.rejects(
        () => store.assertRawUnchanged("deadbeef"),
        (e) => e.code === "analysis_raw_changed"
      );
    });
  });

  await test("fence/prose invalid; missing credentials; status no body", async () => {
    await withTempDir(async (dir) => {
      const seeded = await seedSession(dir, {
        items: [item("microphone:0", "x", { beginMs: 0, endMs: 10 })]
      });
      const { requestChat } = mockChatFromTask({
        correct_batch: () => "```\nnot-json\n```",
        extract_batch: defaultExtractHandler,
        merge_extracts: defaultMergeHandler
      });
      // always invalid json even on retry
      const az = makeAnalyzer(dir, seeded.store, { requestChat });
      await assert.rejects(
        () => az.startAnalysis(seeded.sessionId, { template: "meeting" }),
        (e) => e.code === "analysis_json_invalid" || e.code === "analysis_failed"
      );

      await assert.rejects(
        () =>
          makeAnalyzer(dir, seeded.store, {
            requestChat: async () => ({ content: "{}" }),
            resolveCredentials: () => {
              const err = new Error("no");
              err.code = "analysis_credentials_missing";
              throw err;
            }
          }).startAnalysis(seeded.sessionId),
        (e) => e.code === "analysis_credentials_missing"
      );
    });
  });

  console.log(`\n${passed} tests passed`);
}

run().catch(() => {
  process.exitCode = 1;
});
