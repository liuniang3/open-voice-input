"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { createSessionStore } = require("../src/meeting/session-store");
const {
  createMeetingSessionProcessor,
  normalizeProcessMode
} = require("../src/meeting/processing/session-processor");
const {
  resolveMeetingOssCredentials
} = require("../src/meeting/processing/oss-credentials");
const {
  resolveMeetingFunAsrCredentials
} = require("../src/meeting/processing/fun-asr-credentials");
const {
  toProcessStatusDto,
  scrubString,
  stripForbiddenKeys
} = require("../src/meeting/processing/sanitize-ipc");
const {
  buildObjectKey,
  createAliyunOssMeetingAudioPublisher,
  DEFAULT_URL_EXPIRES_SEC
} = require("../src/meeting/publish/aliyun-oss-publisher");
const {
  normalizeBitrateKbps,
  DEFAULT_BITRATE_KBPS,
  ALLOWED_BITRATES,
  buildUploadMp3Args
} = require("../src/meeting/transcription/encode-upload-mp3");
const {
  enhancedFingerprint,
  buildEnhancedRawTranscript,
  atomicWriteAuthoritativeRawTranscript,
  createFunAsrDiarizeService,
  qwenItemsToMicSentences,
  sanitizeFunJobForDisk,
  scrubPersistedErrorMessage,
  PHASES: FUN_PHASES
} = require("../src/meeting/transcription/fun-asr-diarize-service");
const { mergeMeetingTimeline } = require("../src/meeting/timeline/merge-timeline");
const { createFunAsrProvider } = require("../src/providers/asr/fun-asr-provider");
const { QWEN_NO_BUCKET } = require("../src/meeting/transcription/constants");

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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-meeting-4c-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function writePcm16Mono(frames, sample) {
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) buf.writeInt16LE(sample, i * 2);
  return buf;
}

async function seedL0Track(
  trackDir,
  { track, role, frames = 16000, sampleRate = 16000, sessionId = "mtg" } = {}
) {
  await fsp.mkdir(trackDir, { recursive: true });
  const format = {
    sampleRate,
    channels: 1,
    bitsPerSample: 16,
    blockAlign: 2,
    formatTag: 1,
    subFormat: "WAVE_FORMAT_PCM",
    layer: "L0"
  };
  const payload = writePcm16Mono(frames, 100);
  const name = "000001.l0.pcm";
  await fsp.writeFile(path.join(trackDir, name), payload);
  await fsp.writeFile(
    path.join(trackDir, "index.jsonl"),
    `${JSON.stringify({
      schema: "l0_chunk_v1",
      seq: 1,
      file: name,
      bytes: payload.length,
      frames,
      frameStart: 0,
      frameEnd: frames,
      qpcStart: 0,
      qpcEnd: frames,
      sessionOriginQpc: 0,
      qpcFrequency: 1000,
      track,
      role,
      format
    })}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(trackDir, "manifest.json"),
    JSON.stringify({
      schema: "l0_track_manifest_v1",
      sessionId,
      track,
      role,
      recording: false,
      archivePending: true,
      actualL0Format: format
    }),
    "utf8"
  );
}

function makeFakeCapture({ store, lifecycle = { status: "stopped", sessionId: null } }) {
  let life = { ...lifecycle };
  return {
    store,
    getLifecycle: () => ({ ...life }),
    setLifecycle: (l) => {
      life = { ...life, ...l };
    },
    listSessions: () => store.listSessions(),
    scanSession: (id) => store.scanSession(id)
  };
}

function makeMockOssPublisher({ deleted = [] } = {}) {
  const objects = new Map();
  let puts = 0;
  return {
    id: "mock-oss",
    capabilities() {
      return {
        id: "mock-oss",
        canProvidePublicUrl: true,
        uploads: true,
        deletes: true,
        privateObjects: true,
        urlExpiresSec: DEFAULT_URL_EXPIRES_SEC
      };
    },
    async publish({ localPath, sessionId, track, contentSha256, generation }) {
      puts += 1;
      const objectKey = buildObjectKey({
        sessionId,
        track,
        contentSha256,
        generation,
        ext: "mp3"
      });
      objects.set(objectKey, localPath);
      return {
        kind: "remote_url",
        public: true,
        uploads: true,
        url: `https://example-bucket.oss-cn-hangzhou.aliyuncs.com/${objectKey}?Expires=3600&Signature=mock`,
        objectKey,
        bucket: "example-bucket",
        region: "cn-hangzhou",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        _ephemeralUrl: true
      };
    },
    async deleteObject({ objectKey }) {
      deleted.push(objectKey);
      objects.delete(objectKey);
      return { ok: true, objectKey };
    },
    _stats: () => ({ puts, objects, deleted })
  };
}

function makeFunProvider({ submitCount, pollCount, taskId = "task-persist-1" } = {}) {
  const counters = {
    submit: 0,
    poll: 0,
    ...(submitCount || {}),
    ...(pollCount || {})
  };
  return {
    counters,
    async transcribeMeetingStructured({
      audioUrl,
      existingTaskId,
      diarizationEnabled,
      onTaskId
    }) {
      assert.equal(diarizationEnabled, true);
      let tid = existingTaskId;
      if (!tid) {
        assert.ok(/^https:\/\//i.test(String(audioUrl || "")));
        counters.submit += 1;
        tid = taskId;
        if (typeof onTaskId === "function") await onTaskId(tid);
      } else {
        counters.poll += 1;
      }
      return {
        provider: "fun-asr",
        taskId: tid,
        text: "remote hello",
        sentences: [
          {
            text: "remote hello",
            beginMs: 0,
            endMs: 500,
            speakerId: "A"
          },
          {
            text: "remote two",
            beginMs: 600,
            endMs: 900,
            speakerId: "B"
          }
        ]
      };
    }
  };
}

function makeFakeEncodeMp3() {
  return async ({ outputDir, bitrateKbps = 48, sessionDir, inputWavPath }) => {
    const fsp = require("node:fs/promises");
    const path = require("node:path");
    await fsp.mkdir(outputDir, { recursive: true });
    const mp3Path = path.join(outputDir, `system.upload.${bitrateKbps}k.mp3`);
    await fsp.writeFile(mp3Path, Buffer.from("ID3fake-mp3-content-for-test--------"));
    return {
      mp3Path,
      bitrateKbps,
      bytes: 40,
      durationSec: 0.5,
      sourceDurationSec: 0.5,
      inputWavPath: inputWavPath || null,
      sessionDir: sessionDir || null
    };
  };
}

function makeProcessor(dir, capture, opts = {}) {
  const deleted = [];
  const publisher = opts.publisher || makeMockOssPublisher({ deleted });
  const funImpl = opts.funProvider || makeFunProvider();
  return {
    processor: createMeetingSessionProcessor({
      userDataPath: dir,
      getCaptureService: () => capture,
      resolveCredentials:
        opts.resolveCredentials ||
        (() => ({
          apiKey: "test-qwen-key",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          modelId: "qwen3-asr-flash"
        })),
      resolveFunAsrCredentials:
        opts.resolveFunAsrCredentials ||
        (() => ({
          apiKey: "test-fun-key",
          baseUrl: "https://dashscope.aliyuncs.com/api/v1",
          modelId: "fun-asr"
        })),
      resolveOssCredentials:
        opts.resolveOssCredentials ||
        (() => ({
          region: "cn-hangzhou",
          bucket: "example-bucket",
          accessKeyId: "test-ak",
          accessKeySecret: "test-sk",
          prefix: "meeting"
        })),
      createPublisher: () => publisher,
      createFunAsrProviderImpl: () => funImpl,
      encodeMp3: opts.encodeMp3 || makeFakeEncodeMp3(),
      createTranscribeSegment:
        opts.createTranscribeSegment ||
        (() => async ({ track }) => ({
          text: track === "system" ? "should-not-qwen-system" : "mic self text",
          model: "qwen3-asr-flash"
        })),
      ffmpegOptions: null,
      ...(opts.processorOpts || {})
    }),
    publisher,
    funImpl,
    deleted
  };
}

async function run() {
  await test("bitrate defaults and allowlist", () => {
    assert.equal(DEFAULT_BITRATE_KBPS, 48);
    assert.deepEqual(ALLOWED_BITRATES, [32, 48, 64]);
    assert.equal(normalizeBitrateKbps(32), 32);
    assert.equal(normalizeBitrateKbps(48), 48);
    assert.equal(normalizeBitrateKbps(64), 64);
    assert.equal(normalizeBitrateKbps(96), 48);
    assert.equal(normalizeBitrateKbps("nope"), 48);
    assert.equal(normalizeProcessMode("enhanced"), "enhanced");
    assert.equal(normalizeProcessMode("basic"), "basic");
    assert.equal(normalizeProcessMode(undefined), "basic");
    const args = buildUploadMp3Args({
      inputPath: "in.wav",
      outputPath: "out.mp3",
      bitrateKbps: 48
    });
    assert.ok(args.includes("libmp3lame"));
    assert.ok(args.includes("48k"));
    assert.ok(args.includes("16000"));
  });

  await test("OSS credentials missing; Fun-ASR does not use Qwen key", () => {
    assert.throws(
      () => resolveMeetingOssCredentials({ env: {}, settings: {} }),
      (e) => e.code === "meeting_oss_credentials_missing"
    );
    assert.throws(
      () =>
        resolveMeetingFunAsrCredentials({
          env: {},
          settings: { meetingQwenApiKey: "should-not-use" }
        }),
      (e) => e.code === "meeting_fun_asr_credentials_missing"
    );
    const fun = resolveMeetingFunAsrCredentials({
      env: { OVI_MEETING_FUN_ASR_API_KEY: "fun-only" }
    });
    assert.equal(fun.apiKey, "fun-only");
  });

  await test("object key stable; OSS mock private signed url expires >= 60min", async () => {
    assert.equal(DEFAULT_URL_EXPIRES_SEC, 3600);
    const k1 = buildObjectKey({
      sessionId: "s1",
      generation: 2,
      track: "system",
      contentSha256: "abc",
      ext: "mp3"
    });
    const k2 = buildObjectKey({
      sessionId: "s1",
      generation: 2,
      track: "system",
      contentSha256: "abc",
      ext: "mp3"
    });
    assert.equal(k1, k2);
    assert.ok(!k1.startsWith("/"));
    const puts = [];
    const client = {
      async put(key, file, opts) {
        puts.push({ key, file, opts });
      },
      signatureUrl(key, opts) {
        assert.ok(opts.expires >= 3600);
        return `https://bucket.oss-cn-hangzhou.aliyuncs.com/${key}?e=${opts.expires}`;
      },
      async delete() {
        return {};
      }
    };
    const pub = createAliyunOssMeetingAudioPublisher({
      credentials: {
        accessKeyId: "ak",
        accessKeySecret: "sk",
        bucket: "b",
        region: "cn-hangzhou",
        prefix: "meeting"
      },
      client,
      urlExpiresSec: 3600
    });
    const part = path.join(os.tmpdir(), `ovi-oss-${process.pid}.mp3`);
    await fsp.writeFile(part, Buffer.alloc(64, 1));
    try {
      const r = await pub.publish({
        localPath: part,
        contentType: "audio/mpeg",
        track: "system",
        sessionId: "sess",
        contentSha256: "deadbeef",
        generation: 1
      });
      assert.ok(r.url.startsWith("https://"));
      assert.equal(r._ephemeralUrl, true);
      assert.ok(r.objectKey);
    } finally {
      await fsp.unlink(part).catch(() => {});
    }
  });

  await test("sanitize strips urls secrets LTAI paths", () => {
    // Construct fake AK at runtime so check-secrets does not flag the test source.
    const fakeAk = ["LTAI", "5tTestKeyValue123456"].join("");
    const s = scrubString(`Bearer sk-abc1234567890 ${fakeAk} path D:\\x\\y`);
    assert.ok(!s.includes("Bearer"));
    assert.ok(!s.includes(fakeAk));
    assert.ok(!s.includes("LTAI"));
    const dto = toProcessStatusDto({
      stage: "completed",
      mode: "enhanced",
      processMode: "enhanced",
      bitrateKbps: 48,
      remoteCleanup: "deleted",
      url: "https://secret.example/x",
      apiKey: "nope",
      transcription: { status: "completed", segmentCompleted: 1, segmentTotal: 1 }
    });
    assert.equal(dto.processMode, "enhanced");
    assert.equal(dto.bitrateKbps, 48);
    assert.equal(dto.remoteCleanup, "deleted");
    assert.equal(dto.url, undefined);
    assert.equal(dto.apiKey, undefined);
    const stripped = stripForbiddenKeys({
      accessKeySecret: "x",
      signedUrl: "https://a",
      ok: true
    });
    assert.equal(stripped.accessKeySecret, undefined);
    assert.equal(stripped.signedUrl, undefined);
    assert.equal(stripped.ok, true);
  });

  await test("timeline merge + enhanced raw + atomic write", async () => {
    await withTempDir(async (dir) => {
      const merged = mergeMeetingTimeline({
        sessionId: "s",
        microphoneSentences: [{ text: "me", beginMs: 0, endMs: 100 }],
        systemSentences: [
          { text: "them", beginMs: 50, endMs: 150, speakerId: "1" }
        ]
      });
      assert.ok(merged.items.length >= 2);
      const raw = buildEnhancedRawTranscript({
        sessionId: "s",
        generation: 1,
        merged,
        qwenModelId: "qwen3-asr-flash",
        funModelId: "fun-asr",
        bitrateKbps: 48,
        fingerprint: "fp"
      });
      assert.equal(raw.mode, "enhanced_diarize");
      assert.equal(raw.diarization, true);
      assert.ok(raw.items.some((i) => i.speakerId === "self"));
      assert.ok(raw.items.some((i) => String(i.speakerId).startsWith("remote_")));
      const p = await atomicWriteAuthoritativeRawTranscript(dir, raw);
      const disk = JSON.parse(await fsp.readFile(p, "utf8"));
      assert.equal(disk.count, raw.count);
      assert.ok(p.includes(path.join("transcription", "qwen-no-bucket")));
    });
  });

  await test("basic dual: zero OSS upload; system remote_unknown", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const created = await store.createSession({ title: "basic" });
      const sid = created.session.id;
      await store.updateSession(sid, { status: "stopped" });
      await seedL0Track(created.micDir, {
        track: "microphone",
        role: "self",
        sessionId: sid
      });
      await seedL0Track(created.sysDir, {
        track: "system",
        role: "remote_mix_for_diarization",
        sessionId: sid
      });
      let ossPuts = 0;
      const capture = makeFakeCapture({ store });
      const { processor } = makeProcessor(dir, capture, {
        publisher: {
          capabilities: () => ({ canProvidePublicUrl: true, uploads: true }),
          publish: async () => {
            ossPuts += 1;
            throw new Error("basic must not upload");
          },
          deleteObject: async () => ({ ok: true })
        },
        createTranscribeSegment: () => async ({ track }) => ({
          text: track === "microphone" ? "hello mic" : "hello sys"
        })
      });
      const st = await processor.processSession(sid, { mode: "basic" });
      assert.equal(st.stage, "completed");
      assert.equal(st.processMode, "basic");
      assert.equal(ossPuts, 0);
      const tr = await processor.getRawTranscript(sid);
      assert.equal(tr.diarization, false);
      assert.ok(tr.items.some((i) => i.speakerId === "self"));
      assert.ok(tr.items.some((i) => i.speakerId === "remote_unknown"));
      // job disk must not contain https urls
      const sessionDir = path.join(store.sessionsRoot, sid);
      const jobRaw = await fsp.readFile(
        path.join(sessionDir, QWEN_NO_BUCKET.workDirName, "job.json"),
        "utf8"
      );
      assert.ok(!/https:\/\//i.test(jobRaw));
    });
  });

  await test("enhanced dual: mic Qwen only; system Fun; one atomic raw; OSS cleaned", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const created = await store.createSession({ title: "enh" });
      const sid = created.session.id;
      await store.updateSession(sid, { status: "stopped" });
      await seedL0Track(created.micDir, {
        track: "microphone",
        role: "self",
        sessionId: sid,
        frames: 8000
      });
      await seedL0Track(created.sysDir, {
        track: "system",
        role: "remote_mix_for_diarization",
        sessionId: sid,
        frames: 8000
      });

      const qwenTracks = [];
      const deleted = [];
      const publisher = makeMockOssPublisher({ deleted });
      const funImpl = makeFunProvider({ taskId: "task-e1" });
      const capture = makeFakeCapture({ store });
      const { processor } = makeProcessor(dir, capture, {
        publisher,
        funProvider: funImpl,
        createTranscribeSegment: () => async ({ track }) => {
          qwenTracks.push(track);
          return { text: "mic only", model: "qwen3-asr-flash" };
        }
      });

      const st = await processor.processSession(sid, {
        mode: "enhanced",
        bitrateKbps: 48
      });
      assert.equal(st.stage, "completed");
      assert.equal(st.processMode, "enhanced");
      assert.equal(st.bitrateKbps, 48);
      assert.equal(st.remoteCleanup, "deleted");
      assert.ok(qwenTracks.every((t) => t === "microphone"));
      assert.ok(qwenTracks.length >= 1);
      assert.equal(funImpl.counters.submit, 1);
      assert.ok(publisher._stats().puts >= 1);
      assert.ok(deleted.length >= 1);

      const tr = await processor.getRawTranscript(sid);
      assert.equal(tr.mode, "enhanced_diarize");
      assert.equal(tr.diarization, true);
      assert.ok(tr.items.some((i) => i.speakerId === "self"));
      assert.ok(tr.items.some((i) => i.speakerId === "remote_A"));
      assert.ok(tr.items.some((i) => i.speakerId === "remote_B"));

      const sessionDir = path.join(store.sessionsRoot, sid);
      const rawPath = path.join(
        sessionDir,
        QWEN_NO_BUCKET.workDirName,
        "raw-transcript.json"
      );
      const raw = JSON.parse(await fsp.readFile(rawPath, "utf8"));
      assert.equal(raw.diarization, true);
      const funJob = JSON.parse(
        await fsp.readFile(
          path.join(sessionDir, "transcription", "fun-asr-diarize", "job.json"),
          "utf8"
        )
      );
      assert.equal(funJob.funTaskId, "task-e1");
      assert.ok(!funJob.url && !funJob.signedUrl);
      const diskBlob = JSON.stringify(funJob) + JSON.stringify(raw);
      assert.ok(!/Signature=mock/i.test(diskBlob));
      assert.ok(!/accessKeySecret/i.test(diskBlob));
    });
  });

  await test("enhanced system-only and mic-only lazy resolvers", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const c1 = await store.createSession({ title: "sys" });
      await store.updateSession(c1.session.id, { status: "stopped" });
      await seedL0Track(c1.sysDir, {
        track: "system",
        role: "remote_mix_for_diarization",
        sessionId: c1.session.id
      });
      let qwenResolve = 0;
      let qwenAsr = 0;
      const capture = makeFakeCapture({ store });
      const { processor: sysProc } = makeProcessor(dir, capture, {
        resolveCredentials: () => {
          qwenResolve += 1;
          const e = new Error("qwen must not resolve for system-only");
          e.code = "qwen_should_not_resolve";
          throw e;
        },
        createTranscribeSegment: () => async () => {
          qwenAsr += 1;
          return { text: "no" };
        }
      });
      const st1 = await sysProc.processSession(c1.session.id, { mode: "enhanced" });
      assert.equal(st1.stage, "completed");
      assert.equal(qwenResolve, 0);
      assert.equal(qwenAsr, 0);
      const tr1 = await sysProc.getRawTranscript(c1.session.id);
      assert.ok(tr1.items.every((i) => i.track === "system"));
      assert.equal(tr1.modelId?.microphone ?? null, null);

      const c2 = await store.createSession({ title: "mic" });
      await store.updateSession(c2.session.id, { status: "stopped" });
      await seedL0Track(c2.micDir, {
        track: "microphone",
        role: "self",
        sessionId: c2.session.id
      });
      let funResolve = 0;
      let ossResolve = 0;
      let pubCreate = 0;
      const { processor: micProc } = makeProcessor(dir, capture, {
        resolveFunAsrCredentials: () => {
          funResolve += 1;
          const e = new Error("fun must not resolve for mic-only");
          e.code = "fun_should_not_resolve";
          throw e;
        },
        resolveOssCredentials: () => {
          ossResolve += 1;
          const e = new Error("oss must not resolve for mic-only");
          e.code = "oss_should_not_resolve";
          throw e;
        },
        createTranscribeSegment: () => async () => {
          qwenAsr += 1;
          return { text: "mic" };
        }
      });
      // Override createPublisher via processorOpts is already default mock —
      // wrap by custom processor that throws if createPublisher called.
      const micOnly = createMeetingSessionProcessor({
        userDataPath: dir,
        getCaptureService: () => capture,
        resolveCredentials: () => ({
          apiKey: "k",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          modelId: "qwen3-asr-flash"
        }),
        resolveFunAsrCredentials: () => {
          funResolve += 1;
          throw Object.assign(new Error("fun"), { code: "fun_should_not_resolve" });
        },
        resolveOssCredentials: () => {
          ossResolve += 1;
          throw Object.assign(new Error("oss"), { code: "oss_should_not_resolve" });
        },
        createPublisher: () => {
          pubCreate += 1;
          throw Object.assign(new Error("pub"), { code: "pub_should_not_create" });
        },
        createTranscribeSegment: () => async () => {
          qwenAsr += 1;
          return { text: "mic" };
        },
        encodeMp3: makeFakeEncodeMp3()
      });
      const st2 = await micOnly.processSession(c2.session.id, { mode: "enhanced" });
      assert.equal(st2.stage, "completed");
      assert.equal(funResolve, 0);
      assert.equal(ossResolve, 0);
      assert.equal(pubCreate, 0);
      assert.ok(qwenAsr >= 1);
      void micProc;
    });
  });

  await test("enhanced without OSS fails before upload; fun taskId resume no resubmit", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const created = await store.createSession({ title: "nooss" });
      const sid = created.session.id;
      await store.updateSession(sid, { status: "stopped" });
      await seedL0Track(created.sysDir, {
        track: "system",
        role: "remote_mix_for_diarization",
        sessionId: sid
      });
      const capture = makeFakeCapture({ store });
      const bad = createMeetingSessionProcessor({
        userDataPath: dir,
        getCaptureService: () => capture,
        resolveCredentials: () => ({
          apiKey: "k",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          modelId: "qwen3-asr-flash"
        }),
        resolveFunAsrCredentials: () => ({
          apiKey: "f",
          baseUrl: "https://dashscope.aliyuncs.com/api/v1",
          modelId: "fun-asr"
        }),
        resolveOssCredentials: () => {
          const e = new Error("no oss");
          e.code = "meeting_oss_credentials_missing";
          throw e;
        },
        createTranscribeSegment: () => async () => ({ text: "x" })
      });
      await assert.rejects(
        () => bad.processSession(sid, { mode: "enhanced" }),
        (e) => e.code === "meeting_oss_credentials_missing"
      );

      const sessionDir = path.join(store.sessionsRoot, sid);
      await fsp.mkdir(path.join(sessionDir, "archive"), { recursive: true });
      const wavPath = path.join(sessionDir, "archive", "system.mono.wav");
      await fsp.writeFile(wavPath, Buffer.alloc(100));
      const funImpl = makeFunProvider({ taskId: "resume-me" });
      const pub = makeMockOssPublisher();
      const svc = createFunAsrDiarizeService({
        sessionDir,
        sessionId: sid,
        funAsrProvider: funImpl,
        publisher: pub,
        encodeMp3: makeFakeEncodeMp3()
      });
      const fp = enhancedFingerprint({
        sysSha: crypto.createHash("sha256").update("x").digest("hex"),
        funModelId: "fun-asr",
        bitrateKbps: 48
      });
      const r1 = await svc.runSystemDiarization({
        systemWavPath: wavPath,
        systemContentSha256: crypto.createHash("sha256").update("x").digest("hex"),
        bitrateKbps: 48,
        fingerprint: fp
      });
      assert.equal(r1.resumedTask, false);
      assert.equal(funImpl.counters.submit, 1);
      const r2 = await svc.runSystemDiarization({
        systemWavPath: wavPath,
        systemContentSha256: crypto.createHash("sha256").update("x").digest("hex"),
        bitrateKbps: 48,
        fingerprint: fp
      });
      assert.equal(r2.resumedTask, true);
      assert.equal(funImpl.counters.submit, 1);
      assert.ok(funImpl.counters.poll >= 1);
    });
  });

  await test("mode switch fingerprint isolation basic↔enhanced", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const created = await store.createSession({ title: "switch" });
      const sid = created.session.id;
      await store.updateSession(sid, { status: "stopped" });
      await seedL0Track(created.micDir, {
        track: "microphone",
        role: "self",
        sessionId: sid
      });
      await seedL0Track(created.sysDir, {
        track: "system",
        role: "remote_mix_for_diarization",
        sessionId: sid
      });
      const capture = makeFakeCapture({ store });
      const { processor } = makeProcessor(dir, capture, {
        createTranscribeSegment: () => async ({ track }) => ({
          text: `t-${track}`
        })
      });
      const b = await processor.processSession(sid, { mode: "basic" });
      assert.equal(b.processMode, "basic");
      const trB = await processor.getRawTranscript(sid);
      assert.equal(trB.diarization, false);

      const e = await processor.processSession(sid, { mode: "enhanced" });
      assert.equal(e.processMode, "enhanced");
      const trE = await processor.getRawTranscript(sid);
      assert.equal(trE.diarization, true);

      const b2 = await processor.processSession(sid, { mode: "basic" });
      assert.equal(b2.processMode, "basic");
      const trB2 = await processor.getRawTranscript(sid);
      assert.equal(trB2.diarization, false);
      assert.equal(trB2.mode, "no_bucket");
    });
  });

  await test("fun-asr existingTaskId skips submit", async () => {
    let posts = 0;
    let gets = 0;
    const fetchImpl = async (url, init) => {
      if (String(init?.method || "GET").toUpperCase() === "POST") {
        posts += 1;
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ output: { task_id: "new-task" } });
          }
        };
      }
      gets += 1;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            output: {
              task_status: "SUCCEEDED",
              results: [
                {
                  subtask_status: "SUCCEEDED",
                  transcription_url: "https://example.com/tr.json"
                }
              ]
            }
          });
        }
      };
    };
    const downloadBodies = {
      "https://example.com/tr.json": {
        transcripts: [
          {
            sentences: [{ text: "hi", begin_time: 0, end_time: 1, speaker_id: "1" }]
          }
        ]
      }
    };
    const provider = createFunAsrProvider({
      apiKey: "k",
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      model: "fun-asr",
      cleanTranscript: (t) => t,
      getOptions: () => ({}),
      fetchImpl: async (url, init) => {
        if (String(url).includes("example.com/tr.json")) {
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify(downloadBodies[url]);
            }
          };
        }
        return fetchImpl(url, init);
      }
    });
    const r = await provider.transcribeMeetingStructured({
      existingTaskId: "already",
      diarizationEnabled: true,
      mono: true
    });
    assert.equal(r.taskId, "already");
    assert.equal(posts, 0);
    assert.ok(gets >= 1);
    assert.ok(r.sentences.length >= 1);
  });

  await test("qwenItemsToMicSentences filters mic", () => {
    const s = qwenItemsToMicSentences([
      { track: "microphone", text: "a", artifactBeginMs: 0, artifactEndMs: 1 },
      { track: "system", text: "b", artifactBeginMs: 0, artifactEndMs: 1 }
    ]);
    assert.equal(s.length, 1);
    assert.equal(s[0].text, "a");
  });

  await test("failed fun task: start needs retry; retryProcess resubmits", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const created = await store.createSession({ title: "fail-retry" });
      const sid = created.session.id;
      await store.updateSession(sid, { status: "stopped" });
      await seedL0Track(created.sysDir, {
        track: "system",
        role: "remote_mix_for_diarization",
        sessionId: sid
      });
      const capture = makeFakeCapture({ store });
      let submits = 0;
      const funImpl = {
        counters: { submit: 0, poll: 0 },
        async transcribeMeetingStructured({ existingTaskId, onTaskId, audioUrl }) {
          if (existingTaskId) {
            funImpl.counters.poll += 1;
            const e = new Error("stale failed task");
            e.code = "fun_task_failed";
            throw e;
          }
          submits += 1;
          funImpl.counters.submit += 1;
          const tid = `task-new-${submits}`;
          if (typeof onTaskId === "function") await onTaskId(tid);
          if (submits === 1) {
            const e = new Error("first submit fails after task id");
            e.code = "fun_asr_failed";
            throw e;
          }
          assert.ok(/^https:\/\//i.test(String(audioUrl || "")));
          return {
            taskId: tid,
            text: "ok",
            sentences: [{ text: "ok", beginMs: 0, endMs: 100, speakerId: "A" }]
          };
        }
      };
      const { processor } = makeProcessor(dir, capture, { funProvider: funImpl });
      await assert.rejects(
        () => processor.processSession(sid, { mode: "enhanced" }),
        (e) => e.code === "fun_asr_failed" || e.code === "process_failed"
      );
      const sessionDir = path.join(store.sessionsRoot, sid);
      const funJob1 = JSON.parse(
        await fsp.readFile(
          path.join(sessionDir, "transcription", "fun-asr-diarize", "job.json"),
          "utf8"
        )
      );
      assert.equal(funJob1.phase, FUN_PHASES.failed);
      assert.equal(funJob1.remoteCleanup, "pending_retained");
      assert.equal(submits, 1);

      await assert.rejects(
        () => processor.processSession(sid, { mode: "enhanced" }),
        (e) => e.code === "process_needs_retry"
      );
      assert.equal(submits, 1);

      const st = await processor.retryProcess(sid, { mode: "enhanced" });
      assert.equal(st.stage, "completed");
      assert.equal(submits, 2);
      assert.equal(funImpl.counters.poll, 0);
    });
  });

  await test("completed same fp short-circuit: no second poll/put/raw rewrite", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const created = await store.createSession({ title: "idem" });
      const sid = created.session.id;
      await store.updateSession(sid, { status: "stopped" });
      await seedL0Track(created.micDir, {
        track: "microphone",
        role: "self",
        sessionId: sid
      });
      await seedL0Track(created.sysDir, {
        track: "system",
        role: "remote_mix_for_diarization",
        sessionId: sid
      });
      let qwen = 0;
      const deleted = [];
      const publisher = makeMockOssPublisher({ deleted });
      const funImpl = makeFunProvider({ taskId: "task-once" });
      const capture = makeFakeCapture({ store });
      const { processor } = makeProcessor(dir, capture, {
        publisher,
        funProvider: funImpl,
        createTranscribeSegment: () => async () => {
          qwen += 1;
          return { text: "m" };
        }
      });
      const st1 = await processor.processSession(sid, { mode: "enhanced" });
      assert.equal(st1.stage, "completed");
      const puts1 = publisher._stats().puts;
      const qwen1 = qwen;
      const submit1 = funImpl.counters.submit;
      const sessionDir = path.join(store.sessionsRoot, sid);
      const rawPath = path.join(sessionDir, QWEN_NO_BUCKET.workDirName, "raw-transcript.json");
      const rawBefore = await fsp.readFile(rawPath);
      const hashBefore = crypto.createHash("sha256").update(rawBefore).digest("hex");

      const st2 = await processor.processSession(sid, { mode: "enhanced" });
      assert.equal(st2.stage, "completed");
      assert.equal(publisher._stats().puts, puts1);
      assert.equal(qwen, qwen1);
      assert.equal(funImpl.counters.submit, submit1);
      const hashAfter = crypto
        .createHash("sha256")
        .update(await fsp.readFile(rawPath))
        .digest("hex");
      assert.equal(hashAfter, hashBefore);
    });
  });

  await test("fun job whitelist + lastError scrub nested secrets and signed urls", async () => {
    const fakeAk = ["LTAI", "5tNestedSecretKeyXX"].join("");
    const dirty = {
      schema: "meeting_fun_asr_diarize_job_v1",
      sessionId: "s",
      phase: "failed",
      funTaskId: "t1",
      objectKey: "k",
      url: "https://bucket.oss.aliyuncs.com/k?Expires=1&Signature=abc",
      signedUrl: "https://evil/signed",
      apiKey: "sk-should-not",
      accessKeyId: fakeAk,
      accessKeySecret: "secret-value",
      authorization: "Bearer xyz",
      lastError: {
        code: "x",
        message: `fail Bearer tok ${fakeAk} https://bucket.oss.aliyuncs.com/obj?Signature=zz&Expires=9`
      },
      nestedLeak: { apiKey: "nope" }
    };
    const safe = sanitizeFunJobForDisk(dirty);
    assert.equal(safe.url, undefined);
    assert.equal(safe.signedUrl, undefined);
    assert.equal(safe.apiKey, undefined);
    assert.equal(safe.accessKeyId, undefined);
    assert.equal(safe.accessKeySecret, undefined);
    assert.equal(safe.authorization, undefined);
    assert.equal(safe.nestedLeak, undefined);
    assert.equal(safe.funTaskId, "t1");
    assert.ok(!String(safe.lastError.message).includes("Bearer"));
    assert.ok(!String(safe.lastError.message).includes(fakeAk));
    assert.ok(!String(safe.lastError.message).includes("Signature="));
    assert.ok(
      String(safe.lastError.message).includes("https://bucket.oss.aliyuncs.com/obj") ||
        String(safe.lastError.message).includes("[redacted-url]")
    );
    const scrubbed = scrubPersistedErrorMessage(
      "see https://x.example/a?Signature=1&Expires=2 end"
    );
    assert.ok(!scrubbed.includes("Signature="));
  });

  await test("OSS publish abort during delayed put cancels and deletes", async () => {
    const rejections = [];
    const onUnhandled = (reason) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let deleted = [];
    let cancelCalls = 0;
    let putEntered = false;
    const client = {
      cancel() {
        cancelCalls += 1;
      },
      async put(key) {
        putEntered = true;
        await new Promise((r) => setTimeout(r, 400));
        // Late reject after abort race must not become unhandledRejection
        const err = new Error("put cancelled late");
        err.code = "RequestError";
        throw err;
      },
      signatureUrl(key) {
        return `https://b.oss-cn-hangzhou.aliyuncs.com/${key}?e=3600&Signature=late`;
      },
      async delete(key) {
        deleted.push(key);
        return {};
      }
    };
    const pub = createAliyunOssMeetingAudioPublisher({
      credentials: {
        accessKeyId: "ak",
        accessKeySecret: "sk",
        bucket: "b",
        region: "cn-hangzhou"
      },
      client
    });
    const part = path.join(os.tmpdir(), `ovi-oss-abort-${process.pid}.mp3`);
    await fsp.writeFile(part, Buffer.alloc(64, 1));
    try {
      const ac = new AbortController();
      const p = pub.publish({
        localPath: part,
        track: "system",
        sessionId: "s",
        contentSha256: "ab",
        generation: 1,
        signal: ac.signal
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(putEntered, true);
      ac.abort();
      await assert.rejects(() => p, (e) => e.code === "aborted");
      assert.ok(cancelCalls >= 1);
      assert.ok(deleted.length >= 1);
      // Allow late put settlement
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(rejections.length, 0, `unhandledRejection count=${rejections.length}`);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      await fsp.unlink(part).catch(() => {});
    }
  });

  await test("sanitize strips https URL query/hash from errors", () => {
    const { sanitizeErrorMessage } = require("../src/meeting/transcription/sanitize");
    const msg = sanitizeErrorMessage(
      "OSS fail https://bucket.oss-cn-hangzhou.aliyuncs.com/obj?Expires=9&Signature=abc#frag"
    );
    assert.ok(!msg.includes("Signature="));
    assert.ok(!msg.includes("Expires="));
    assert.ok(!msg.includes("#frag"));
    assert.ok(msg.includes("https://bucket.oss-cn-hangzhou.aliyuncs.com/obj"));
    const scrubbed = scrubString(
      "err https://x.example/a?Signature=1&Expires=2 path"
    );
    assert.ok(!scrubbed.includes("Signature="));
    assert.ok(scrubbed.includes("https://x.example/a"));
  });

  await test("enhanced:test DTO has no bucket region url key", async () => {
    await withTempDir(async (dir) => {
      const store = createSessionStore({ userDataPath: dir });
      await store.init();
      const capture = makeFakeCapture({ store });
      let funTest = 0;
      let ossTest = 0;
      const processor = createMeetingSessionProcessor({
        userDataPath: dir,
        getCaptureService: () => capture,
        resolveCredentials: () => {
          throw new Error("unused");
        },
        resolveFunAsrCredentials: () => ({
          apiKey: "f",
          baseUrl: "https://dashscope.aliyuncs.com/api/v1",
          modelId: "fun-asr"
        }),
        resolveOssCredentials: () => ({
          region: "cn-hangzhou",
          bucket: "secret-bucket",
          accessKeyId: "ak",
          accessKeySecret: "sk",
          prefix: "meeting"
        }),
        createFunAsrProviderImpl: () => ({
          async testConnection() {
            funTest += 1;
          }
        }),
        createPublisher: () => ({
          capabilities: () => ({ canProvidePublicUrl: true, uploads: true }),
          async testConnection() {
            ossTest += 1;
            return { ok: true, bucket: "secret-bucket", region: "cn-hangzhou", signed: true };
          }
        }),
        createTranscribeSegment: () => async () => ({ text: "x" })
      });
      const r = await processor.testEnhancedConnection({ target: "all" });
      assert.equal(r.ok, true);
      assert.equal(funTest, 1);
      assert.equal(ossTest, 1);
      const s = JSON.stringify(r);
      assert.ok(!s.includes("secret-bucket"));
      assert.ok(!s.includes("cn-hangzhou"));
      assert.ok(!s.includes("accessKey"));
      assert.ok(!s.includes("https://"));
      assert.ok(r.results.every((x) => x.latencyMs >= 0 && x.target));
    });
  });

  console.log(`\n${passed} tests passed (stage 4c)`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
