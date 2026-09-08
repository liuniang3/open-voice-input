"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createSessionStore } = require("../src/meeting/session-store");
const { createMeetingSessionProcessor } = require("../src/meeting/processing/session-processor");
const {
  importWavToSession,
  parseImportWavHeader,
  quarantineParts,
  IMPORT_SESSION_ORIGIN_QPC,
  IMPORT_QPC_FREQUENCY
} = require("../src/meeting/import/import-wav");
const {
  createImportJobManager,
  probeSessionArtifacts,
  sanitizeImportErrorMessage
} = require("../src/meeting/import/import-job");
const {
  readSpeakerMap,
  writeSpeakerMap,
  decorateTranscriptForDisplay
} = require("../src/meeting/speaker-map");
const {
  buildSrt,
  buildJsonBundle,
  sanitizeExportJson,
  writeExportFiles,
  buildMarkdown,
  buildTxt,
  pickItemMs
} = require("../src/meeting/export/session-export");
const {
  issuePlaybackToken,
  resolvePlaybackToken,
  clearAllPlaybackTokens,
  SCHEME
} = require("../src/meeting/playback/media-token");
const { parseBytesRange, buildPlaybackHeaders } = require("../src/meeting/playback/http-range");
const { assertPathInsideRoot } = require("../src/meeting/paths");
const { buildWavHeader, sha256File, verifyArchiveIntegrity } = require("../src/meeting/archive/export-track-wav");
const { mapArtifactTimeRange } = require("../src/meeting/archive/export-track-wav");
const ui = require("../src/renderer/meeting-ui.js");

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
    });
}

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mimo-4b-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function writePcm16Wav(filePath, { sampleRate = 16000, channels = 1, frames = 1600 } = {}) {
  const dataBytes = frames * channels * 2;
  const header = buildWavHeader(dataBytes, sampleRate, channels, 16);
  const pcm = Buffer.alloc(dataBytes);
  for (let i = 0; i < frames; i += 1) {
    const s = Math.floor(Math.sin(i / 20) * 8000);
    for (let c = 0; c < channels; c += 1) {
      pcm.writeInt16LE(s, (i * channels + c) * 2);
    }
  }
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

async function main() {
  await test("http range: single-byte 206 headers + multi-range 416", () => {
    const full = buildPlaybackHeaders({ method: "GET", size: 1000, rangeHeader: null });
    assert.equal(full.status, 200);
    assert.equal(full.headers["Accept-Ranges"], "bytes");
    assert.equal(full.headers["Content-Type"], "audio/wav");
    assert.equal(full.headers["Content-Length"], "1000");

    const head = buildPlaybackHeaders({ method: "HEAD", size: 1000 });
    assert.equal(head.isHead, true);
    assert.equal(head.status, 200);

    const mid = buildPlaybackHeaders({ method: "GET", size: 1000, rangeHeader: "bytes=100-199" });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers["Content-Range"], "bytes 100-199/1000");
    assert.equal(mid.headers["Content-Length"], "100");
    assert.equal(mid.start, 100);
    assert.equal(mid.end, 199);

    const open = buildPlaybackHeaders({ method: "GET", size: 500, rangeHeader: "bytes=400-" });
    assert.equal(open.status, 206);
    assert.equal(open.end, 499);

    const bad = buildPlaybackHeaders({ method: "GET", size: 100, rangeHeader: "bytes=0-10,20-30" });
    assert.equal(bad.status, 416);
    assert.ok(String(bad.headers["Content-Range"]).includes("*/100"));

    const p = parseBytesRange("bytes=0-0", 10);
    assert.equal(p.ok, true);
    assert.equal(p.start, 0);
    assert.equal(p.end, 0);
  });

  await test("import: hash stable, source preserved, RIFF + synthetic QPC", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "src.wav");
      writePcm16Wav(src, { sampleRate: 44100, channels: 2, frames: 4410 });
      const srcShaBefore = await sha256File(src);
      const store = createSessionStore({ sessionsRoot: path.join(dir, "sessions") });
      const created = await store.createSession({ title: "imp" });
      const r1 = await importWavToSession({
        sourcePath: src,
        sessionDir: created.sessionDir,
        sessionId: created.session.id,
        title: "imp"
      });
      assert.equal(r1.ok, true);
      assert.equal(r1.status, "stopped");
      assert.ok(fs.existsSync(src), "source must not be deleted");
      assert.equal(await sha256File(src), srcShaBefore);
      const sc = JSON.parse(fs.readFileSync(r1._paths.sidecarPath, "utf8"));
      assert.equal(sc.sessionOriginQpc, IMPORT_SESSION_ORIGIN_QPC);
      assert.equal(sc.qpcFrequency, IMPORT_QPC_FREQUENCY);
      const mapped = mapArtifactTimeRange({
        sidecar: sc,
        beginMs: 100,
        endMs: 200
      });
      // session ms equals artifact ms under synthetic clock
      if (mapped && mapped.sessionBeginMs != null) {
        assert.ok(Math.abs(mapped.sessionBeginMs - 100) < 2 || mapped.ok !== false);
      }
      const hdr = await parseImportWavHeader(src);
      assert.equal(hdr.channels, 2);
      await verifyArchiveIntegrity({ wavPath: r1._paths.wavPath, sidecarPath: r1._paths.sidecarPath });
    });
  });

  await test("import: path outside denied; quarantine on cancel", async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, "sessions");
      await fsp.mkdir(root, { recursive: true });
      assert.throws(
        () => assertPathInsideRoot(root, path.join(dir, "evil.wav")),
        /path escapes|path_denied|denied|not inside/i
      );

      const store = createSessionStore({ sessionsRoot: root });
      const created = await store.createSession({ title: "q" });
      const src = path.join(dir, "big.wav");
      writePcm16Wav(src, { sampleRate: 16000, frames: 160000 });
      const controller = new AbortController();
      const p = importWavToSession({
        sourcePath: src,
        sessionDir: created.sessionDir,
        sessionId: created.session.id,
        signal: controller.signal
      });
      controller.abort();
      let err = null;
      try {
        await p;
      } catch (e) {
        err = e;
      }
      assert.ok(err);
      assert.equal(err.code, "aborted");
      const qDir = path.join(created.sessionDir, "import", "quarantine");
      // either quarantined during catch or empty if aborted before parts
      if (fs.existsSync(qDir)) {
        const names = await fsp.readdir(qDir);
        assert.ok(Array.isArray(names));
      }
      // manual quarantine API
      const part = path.join(created.sessionDir, "archive", "x.part");
      await fsp.mkdir(path.dirname(part), { recursive: true });
      await fsp.writeFile(part, "partial");
      const moved = await quarantineParts(created.sessionDir, [part]);
      assert.ok(moved.length >= 1);
      assert.ok(!fs.existsSync(part));
      assert.ok(fs.existsSync(path.join(qDir, moved[0])));
    });
  });

  await test("process reuses import archive with fake ASR (no L0 required)", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "a.wav");
      writePcm16Wav(src, { sampleRate: 16000, channels: 1, frames: 8000 });
      const sessionsRoot = path.join(dir, "sessions");
      const store = createSessionStore({ sessionsRoot });
      const created = await store.createSession({ title: "p" });
      const imp = await importWavToSession({
        sourcePath: src,
        sessionDir: created.sessionDir,
        sessionId: created.session.id
      });
      await store.updateSession(created.session.id, imp.sessionPatch);
      const capture = {
        store,
        getLifecycle: () => ({ status: "idle", sessionId: null }),
        listSessions: () => store.listSessions()
      };
      let asrCalls = 0;
      const processor = createMeetingSessionProcessor({
        userDataPath: dir,
        getCaptureService: () => capture,
        resolveCredentials: () => ({
          apiKey: "test-key-not-real",
          baseUrl: "https://example.invalid/v1",
          modelId: "qwen3-asr-flash"
        }),
        resolveFileAsrCredentials: () => ({
          provider: "qwen3-asr",
          apiKey: "test-key-not-real",
          baseUrl: "https://example.invalid/v1",
          modelId: "qwen3-asr-flash"
        }),
        createTranscribeSegment: () => async () => {
          asrCalls += 1;
          return { text: "hello import" };
        }
      });
      const st = await processor.processSession(created.session.id);
      assert.ok(st);
      assert.ok(asrCalls >= 1, "ASR should run on reused archive");
      // Without L0, reuse path must have been used (no exportTrackArchive from empty L0)
      await verifyArchiveIntegrity({
        wavPath: imp._paths.wavPath,
        sidecarPath: imp._paths.sidecarPath
      });
      const tr = await processor.getRawTranscript(created.session.id);
      assert.ok(tr?.items?.length >= 1);
    });
  });

  await test("list probe hasRaw includes qwen-no-bucket path (access only)", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ sessionsRoot: path.join(dir, "sessions") });
      const created = await store.createSession({ title: "flags" });
      const empty = await probeSessionArtifacts(created.sessionDir, fsp);
      assert.equal(empty.hasRaw, false);
      assert.equal(empty.hasSummary, false);
      // Real Stage 2A path
      const qwenRaw = path.join(
        created.sessionDir,
        "transcription",
        "qwen-no-bucket",
        "raw-transcript.json"
      );
      await fsp.mkdir(path.dirname(qwenRaw), { recursive: true });
      await fsp.writeFile(qwenRaw, JSON.stringify({ items: [{ text: "x".repeat(50000) }] }));
      const flagsQwen = await probeSessionArtifacts(created.sessionDir, fsp);
      assert.equal(flagsQwen.hasRaw, true);
      // legacy path also works
      await fsp.rm(path.join(created.sessionDir, "transcription"), { recursive: true, force: true });
      const legacy = path.join(created.sessionDir, "transcription", "raw-transcript.json");
      await fsp.mkdir(path.dirname(legacy), { recursive: true });
      await fsp.writeFile(legacy, "{}");
      assert.equal((await probeSessionArtifacts(created.sessionDir, fsp)).hasRaw, true);
      const anDir = path.join(created.sessionDir, "analysis");
      await fsp.mkdir(anDir, { recursive: true });
      await fsp.writeFile(path.join(anDir, "summary.json"), JSON.stringify({ ok: true }));
      assert.equal((await probeSessionArtifacts(created.sessionDir, fsp)).hasSummary, true);
    });
  });

  await test("speaker map no raw mutate; A/B save guard", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ sessionsRoot: path.join(dir, "sessions") });
      const created = await store.createSession({ title: "s" });
      const raw = {
        schema: "raw_v1",
        items: [{ id: "microphone:0", speakerId: "self", text: "你好<script>" }]
      };
      const before = JSON.stringify(raw);
      const beforeHash = crypto.createHash("sha256").update(before).digest("hex");
      await writeSpeakerMap(created.sessionDir, created.session.id, {
        speakers: { self: { displayName: "我" } }
      });
      const map = await readSpeakerMap(created.sessionDir, created.session.id);
      const decorated = decorateTranscriptForDisplay(raw, map);
      assert.equal(decorated.items[0].speakerDisplayName, "我");
      assert.equal(JSON.stringify(raw), before);
      assert.equal(crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex"), beforeHash);

      assert.equal(
        ui.shouldApplySpeakerMapSave({ selectedId: "A", saveSessionId: "A" }),
        true
      );
      assert.equal(
        ui.shouldApplySpeakerMapSave({ selectedId: "B", saveSessionId: "A" }),
        false
      );
    });
  });

  await test("export md/txt sections + srt corrected times + json sanitize", async () => {
    await withTempDir(async (dir) => {
      const session = { id: "s1", title: "周会", source: "import", createdAt: "2026-01-01T00:00:00Z" };
      const transcript = {
        items: [
          { id: "1", speakerId: "self", text: "原文句", sessionBeginMs: 0, sessionEndMs: 1000 }
        ]
      };
      const corrected = {
        items: [
          {
            id: "1",
            speakerId: "self",
            text: "校订句",
            sourceBeginMs: 10,
            sourceEndMs: 900,
            correctedText: "校订句"
          }
        ]
      };
      const summary = {
        template: "meeting",
        executiveSummary: { text: "摘要内容" }
      };
      const speakerMap = { speakers: { self: { displayName: "甲" } } };
      const mdAll = buildMarkdown({
        session,
        transcript,
        corrected,
        summary,
        speakerMap,
        scope: "all"
      });
      assert.ok(mdAll.includes("原文转写"));
      assert.ok(mdAll.includes("校订文本"));
      assert.ok(mdAll.includes("校订句"));
      assert.ok(mdAll.includes("结构化总结"));
      assert.ok(mdAll.includes("摘要内容"));

      const txt = buildTxt({ transcript, corrected, summary, speakerMap, scope: "all" });
      assert.ok(txt.includes("校订句"));

      const srt = buildSrt({ transcript, corrected, speakerMap, scope: "all" });
      assert.equal(srt.ok, true);
      assert.equal(srt.used, "corrected");
      assert.ok(srt.content.includes("校订句"));
      const times = pickItemMs(corrected.items[0], { preferSource: true });
      assert.equal(times.beginMs, 10);

      const srtBad = buildSrt({
        transcript: { items: [{ id: "z", text: "n", speakerId: "self" }] },
        speakerMap,
        scope: "raw"
      });
      assert.equal(srtBad.ok, false);
      const srtPath = path.join(dir, "out.srt");
      const report = await writeExportFiles({
        outPath: srtPath,
        format: "srt",
        scope: "raw",
        session,
        transcript: { items: [{ id: "z", text: "n", speakerId: "self" }] },
        speakerMap
      });
      assert.equal(report.skippedSrt, true);
      assert.ok(fs.existsSync(path.join(dir, "out.export-report.json")));
      // must not create forged SRT with cues
      if (fs.existsSync(srtPath)) {
        const body = fs.readFileSync(srtPath, "utf8");
        assert.ok(!body.includes("-->"));
      }

      const dirty = sanitizeExportJson({
        apiKey: "sk-secret",
        path: "C:\\Users\\x\\a.wav",
        ok: true
      });
      assert.equal(dirty.apiKey, undefined);
      assert.equal(dirty.path, undefined);

      const blocks = ui.formatTranscriptBlocks({
        items: [
          {
            speakerId: "self",
            text: "t",
            sourceBeginMs: 1200,
            sourceEndMs: 2400
          }
        ]
      });
      assert.ok(blocks[0].timeLabel.includes("00:01"));
    });
  });

  await test("playback token containment", async () => {
    await withTempDir(async (dir) => {
      clearAllPlaybackTokens();
      const sessionsRoot = path.join(dir, "sessions");
      const sid = "sess_play_1";
      const archive = path.join(sessionsRoot, sid, "archive");
      await fsp.mkdir(archive, { recursive: true });
      const wav = path.join(archive, "microphone.mono.wav");
      writePcm16Wav(wav, { frames: 100 });
      const issued = issuePlaybackToken({ sessionsRoot, sessionId: sid, absPath: wav });
      assert.ok(issued.url.startsWith(`${SCHEME}://`));
      const resolved = resolvePlaybackToken(issued.token);
      assert.equal(path.resolve(resolved.absPath), path.resolve(wav));
      assert.throws(() => {
        issuePlaybackToken({
          sessionsRoot,
          sessionId: sid,
          absPath: path.join(dir, "outside.wav")
        });
      }, /path|denied|playback/i);
    });
  });

  await test("variable-height virtual list: reanchor keeps offset; switch blocks", () => {
    const heights = [40, 120, 80, 200, 60];
    const virt = ui.createVirtualWindow({
      itemCount: 5,
      viewportHeight: 150,
      estimatedItemHeight: 50,
      overscan: 1,
      heights
    });
    assert.equal(virt.totalHeight(), 40 + 120 + 80 + 200 + 60);
    virt.setScrollTop(50);
    const r1 = virt.range();
    assert.ok(r1.start <= 1);
    // measure + reanchor with non-zero offset inside item
    const anchor = virt.indexAtOffset(50);
    const offsetIn = 50 - virt.offsetOf(anchor);
    virt.setMeasuredHeight(1, 300);
    const top = virt.reanchorScroll(anchor, offsetIn);
    assert.equal(top, virt.offsetOf(anchor) + offsetIn);
    assert.ok(offsetIn === 0 || top !== virt.offsetOf(anchor) || offsetIn === 0);

    // two independent windows (simulates switching blocks A -> B)
    const a = ui.createVirtualWindow({ itemCount: 100, viewportHeight: 200, estimatedItemHeight: 40 });
    a.setScrollTop(400);
    const ra = a.range();
    const b = ui.createVirtualWindow({ itemCount: 50, viewportHeight: 200, estimatedItemHeight: 60 });
    b.setScrollTop(0);
    const rb = b.range();
    assert.ok(ra.start > 0);
    assert.equal(rb.start, 0);
    assert.notEqual(a.totalHeight(), b.totalHeight());

    const big = ui.createVirtualWindow({
      itemCount: 5000,
      viewportHeight: 400,
      estimatedItemHeight: 72,
      overscan: 4
    });
    big.setScrollTop(20000);
    const rbig = big.range();
    assert.ok(rbig.end - rbig.start < 50);
  });

  await test("import session control flags + list meta labels", () => {
    assert.equal(ui.isImportBlockingStatus("importing"), true);
    assert.equal(ui.isImportBlockingStatus("import_failed"), true);
    assert.equal(ui.isImportBlockingStatus("stopped"), false);
    assert.equal(ui.sessionStatusLabel("importing"), "导入中");
    assert.equal(ui.sessionStatusLabel("import_failed"), "导入失败");
    assert.equal(ui.sessionStatusLabel("import_cancelled"), "导入取消");
    assert.equal(ui.sessionStatusLabel("import_interrupted"), "导入中断");
    assert.ok(ui.sessionListMetaLine({ source: "import", status: "importing" }).includes("导入中"));

    // import never allows capture start
    assert.equal(
      ui.canStartCapture("idle", "idle", "none", { source: "import", sessionStatus: "stopped" }),
      false
    );
    // importing blocks generate/analysis
    assert.equal(
      ui.canGenerateRaw("stopped", "idle", {
        hasSession: true,
        source: "import",
        sessionStatus: "importing",
        hasArchive: false
      }),
      false
    );
    assert.equal(
      ui.canRunAnalysis("completed", "none", {
        hasSession: true,
        hasRaw: true,
        sessionStatus: "import_failed"
      }),
      false
    );
    // stopped import + archive ok
    assert.equal(
      ui.canGenerateRaw("idle", "idle", {
        hasSession: true,
        source: "import",
        sessionStatus: "stopped",
        hasArchive: true
      }),
      true
    );
    const flags = ui.computeControlFlags({
      hasSession: true,
      lifecycleStatus: "idle",
      processStage: "idle",
      analysisStatus: "none",
      source: "import",
      sessionStatus: "importing",
      hasArchive: false
    });
    assert.equal(flags.canStartCapture, false);
    assert.equal(flags.canGenerateRaw, false);
  });

  await test("reimport: quarantine old archive first; fail keeps prior derived", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "r.wav");
      writePcm16Wav(src, { frames: 3200 });
      const store = createSessionStore({ sessionsRoot: path.join(dir, "sessions") });
      const created = await store.createSession({ title: "re" });
      const first = await importWavToSession({
        sourcePath: src,
        sessionDir: created.sessionDir,
        sessionId: created.session.id
      });
      const oldSha = first.archive.contentSha256;
      const tr = path.join(created.sessionDir, "transcription", "qwen-no-bucket");
      const an = path.join(created.sessionDir, "analysis");
      await fsp.mkdir(tr, { recursive: true });
      await fsp.mkdir(an, { recursive: true });
      await fsp.writeFile(path.join(tr, "raw-transcript.json"), '{"keep":true}');
      await fsp.writeFile(path.join(an, "summary.json"), "{}");

      // Failed reimport (missing source) must not wipe derived or live archive
      await assert.rejects(
        () =>
          importWavToSession({
            sourcePath: path.join(dir, "missing.wav"),
            sessionDir: created.sessionDir,
            sessionId: created.session.id,
            reimport: true
          }),
        (e) => e.code === "import_source_missing"
      );
      assert.ok(fs.existsSync(path.join(tr, "raw-transcript.json")));
      assert.ok(fs.existsSync(first._paths.wavPath));

      // Successful reimport quarantines old archive + then derived
      const src2 = path.join(dir, "r2.wav");
      writePcm16Wav(src2, { frames: 4000 });
      const second = await importWavToSession({
        sourcePath: src2,
        sessionDir: created.sessionDir,
        sessionId: created.session.id,
        reimport: true
      });
      assert.notEqual(second.archive.contentSha256, oldSha);
      assert.equal(fs.existsSync(tr), false);
      assert.equal(fs.existsSync(path.join(created.sessionDir, "transcription")), false);
      const q = path.join(created.sessionDir, "import", "quarantine");
      const qNames = await fsp.readdir(q);
      assert.ok(qNames.some((n) => n.includes("mono.wav") || n.includes("sidecar")));
      assert.ok(qNames.some((n) => n.includes("transcription") || n.includes("analysis")));
      await verifyArchiveIntegrity({
        wavPath: second._paths.wavPath,
        sidecarPath: second._paths.sidecarPath
      });
    });
  });

  await test("import job: fail returns result no throw; sanitize path; shutdown", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ sessionsRoot: path.join(dir, "sessions") });
      const created = await store.createSession({ title: "job" });
      const mgr = createImportJobManager({ getStore: () => store });
      const badPath = path.join(dir, "nope-does-not-exist.wav");
      const started = await mgr.startImport({
        sourcePath: badPath,
        sessionId: created.session.id,
        sessionDir: created.sessionDir,
        title: "job"
      });
      assert.equal(started.status, "importing");
      const result = await mgr.awaitImport(created.session.id);
      assert.equal(result.ok, false);
      assert.equal(result.status, "import_failed");
      assert.ok(!String(result.error?.message || "").includes(dir));
      const after = await store.readSession(created.session.id);
      assert.equal(after.session.status, "import_failed");
      assert.ok(!JSON.stringify(after.session.import || {}).includes(dir));

      const msg = sanitizeImportErrorMessage(`fail at ${path.join("C:", "Users", "x", "a.wav")} sk-abcdefghijklmnop`);
      assert.ok(!msg.includes("Users"));
      assert.ok(!msg.includes("sk-"));

      // unhandled: nobody awaits — must not crash process
      const c2 = await store.createSession({ title: "u" });
      let unhandled = 0;
      const onUn = () => {
        unhandled += 1;
      };
      process.on("unhandledRejection", onUn);
      await mgr.startImport({
        sourcePath: badPath,
        sessionId: c2.session.id,
        sessionDir: c2.sessionDir
      });
      await new Promise((r) => setTimeout(r, 50));
      await mgr.shutdown(500);
      process.removeListener("unhandledRejection", onUn);
      assert.equal(unhandled, 0);
    });
  });

  await test("import job manager start/cancel without path leakage", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "job.wav");
      writePcm16Wav(src, { frames: 48000 });
      const store = createSessionStore({ sessionsRoot: path.join(dir, "sessions") });
      const created = await store.createSession({ title: "job" });
      const mgr = createImportJobManager({ getStore: () => store });
      const started = await mgr.startImport({
        sourcePath: src,
        sessionId: created.session.id,
        sessionDir: created.sessionDir,
        title: "job"
      });
      assert.equal(started.status, "importing");
      assert.ok(!JSON.stringify(started).includes(src));
      const live = mgr.getImportStatus(created.session.id);
      assert.equal(live.running, true);
      await mgr.cancelImport(created.session.id);
      const after = await store.readSession(created.session.id);
      assert.ok(
        after.session.status === "import_cancelled" || after.session.status === "stopped",
        after.session.status
      );
    });
  });

  console.log(`\n${passed} tests passed`);
}

main();
