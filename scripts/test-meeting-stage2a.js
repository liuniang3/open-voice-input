"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { parseWavHeader } = require("../src/meeting/transcription/wav-reader");
const { createLinearPcm16Resampler } = require("../src/meeting/transcription/resample");
const {
  prepareTrackSegments,
  segmentToDataUrl,
  assertSegmentPreflight,
  estimateDataUriChars,
  createPcmAccumulator,
  EFFECTIVE_PCM_DURATION_CAP_SECONDS
} = require("../src/meeting/transcription/segment-prep");
const {
  createNoBucketMeetingTranscriptionService
} = require("../src/meeting/transcription/no-bucket-service");
const { QWEN_NO_BUCKET, JOB_STATUS, SEGMENT_STATUS } = require("../src/meeting/transcription/constants");
const { createQwen3AsrProvider } = require("../src/providers/asr/qwen3-asr-provider");
const { createOpenAiCompatibleClient } = require("../src/providers/openai-compatible-client");
const { SELF_SPEAKER_ID } = require("../src/meeting/timeline/merge-timeline");
const { sha256Text, sanitizeForPersist, pickSafeProfile } = require("../src/meeting/transcription/sanitize");

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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-meeting-2a-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function writeMonoPcm16(frames, sampleFn) {
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const s = typeof sampleFn === "function" ? sampleFn(i) : sampleFn;
    buf.writeInt16LE(s, i * 2);
  }
  return buf;
}

function buildWavWithExtraChunk(pcm, sampleRate, { extraChunk = true } = {}) {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);

  let mid = Buffer.alloc(0);
  if (extraChunk) {
    const listBody = Buffer.from("INFOISFT\0test\0", "ascii");
    mid = Buffer.alloc(8 + listBody.length + (listBody.length % 2));
    mid.write("LIST", 0, "ascii");
    mid.writeUInt32LE(listBody.length, 4);
    listBody.copy(mid, 8);
  }

  const data = Buffer.alloc(8 + pcm.length);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(pcm.length, 4);
  pcm.copy(data, 8);

  const riffSize = 4 + fmt.length + mid.length + data.length;
  const out = Buffer.alloc(8 + riffSize);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(riffSize, 4);
  out.write("WAVE", 8, "ascii");
  fmt.copy(out, 12);
  mid.copy(out, 12 + fmt.length);
  data.copy(out, 12 + fmt.length + mid.length);
  return out;
}

async function seedArchiveFromWav(dir, track, wavBuf, {
  role,
  origin = 0,
  freq = 1000,
  chunks = null
} = {}) {
  const archiveDir = path.join(dir, "archive");
  await fsp.mkdir(archiveDir, { recursive: true });
  const wavPath = path.join(archiveDir, `${track}.mono.wav`);
  await fsp.writeFile(wavPath, wavBuf);
  const info = await parseWavHeader(wavPath);
  const contentSha256 = crypto.createHash("sha256").update(wavBuf).digest("hex");
  const sidecar = {
    schema: "meeting_archive_sidecar_v1",
    track,
    role,
    contentSha256,
    sessionOriginQpc: origin,
    qpcFrequency: freq,
    chunks: chunks || [
      {
        seq: 1,
        beginMs: 0,
        endMs: info.durationMs,
        qpcStart: origin,
        qpcFrequency: freq
      }
    ],
    gaps: []
  };
  const sidecarPath = path.join(archiveDir, `${track}.mono.wav.sidecar.json`);
  await fsp.writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  return { wavPath, sidecarPath, sidecar, info };
}

async function run() {
  await test("wav-reader: RIFF LIST + duration via parse not offset 24/40", async () => {
    await withTempDir(async (dir) => {
      const pcm = writeMonoPcm16(16000, 100); // 1s @16k
      const wav = buildWavWithExtraChunk(pcm, 16000, { extraChunk: true });
      const p = path.join(dir, "x.wav");
      await fsp.writeFile(p, wav);
      const info = await parseWavHeader(p);
      assert.equal(info.sampleRate, 16000);
      assert.ok(info.dataOffset > 44);
      assert.ok(Math.abs(info.durationMs - 1000) < 1);
      const uri = await segmentToDataUrl(p);
      assert.ok(Math.abs(uri.durationSeconds - 1) < 0.01);
    });
  });

  await test("resampler: odd-byte carry + 44.1k arbitrary chunk sizes", () => {
    const frames = 4410; // 0.1s
    const pcm = writeMonoPcm16(frames, (i) => ((i * 17) % 6000) - 3000);
    const sr1 = createLinearPcm16Resampler(44100, 16000);
    const once = Buffer.concat([sr1.push(pcm), sr1.flush()]);

    const sr2 = createLinearPcm16Resampler(44100, 16000);
    const parts = [];
    const sizes = [1, 3, 111, 7, 512, 2];
    let off = 0;
    let si = 0;
    while (off < pcm.length) {
      const n = sizes[si % sizes.length];
      si += 1;
      parts.push(sr2.push(pcm.subarray(off, Math.min(pcm.length, off + n))));
      off += n;
    }
    parts.push(sr2.flush());
    const multi = Buffer.concat(parts.filter((p) => p.length));
    assert.equal(once.equals(multi), true);

    // identity odd carry
    const id = createLinearPcm16Resampler(16000, 16000);
    const a = id.push(Buffer.from([0x01]));
    assert.equal(a.length, 0);
    const b = id.push(Buffer.from([0x02, 0x03, 0x04]));
    assert.equal(b.length, 4);
    assert.equal(b.readInt16LE(0), 0x0201);
    const fl = id.flush();
    assert.equal(fl.danglingOddByte, false);
  });

  await test("pcm accumulator take is bounded O(n)", () => {
    const acc = createPcmAccumulator();
    for (let i = 0; i < 100; i += 1) acc.push(Buffer.alloc(100, i));
    assert.equal(acc.length, 10000);
    const t = acc.take(2500);
    assert.equal(t.length, 2500);
    assert.equal(acc.length, 7500);
    acc.clear();
    assert.equal(acc.length, 0);
  });

  await test("segment-prep: 48k + 44.1k multi-seg idempotent", async () => {
    await withTempDir(async (dir) => {
      const pcm48 = writeMonoPcm16(24000, 500);
      const a48 = await seedArchiveFromWav(dir, "microphone", buildWavWithExtraChunk(pcm48, 48000), {
        role: "self"
      });
      const r1 = await prepareTrackSegments({
        wavPath: a48.wavPath,
        sidecarPath: a48.sidecarPath,
        track: "microphone",
        role: "self",
        outputDir: path.join(dir, "s48"),
        targetSegmentSeconds: 180
      });
      assert.equal(r1.segmentCount, 1);

      const pcm44 = writeMonoPcm16(Math.floor(44100 * 0.6), (i) => i % 1000);
      const a44 = await seedArchiveFromWav(dir, "system", buildWavWithExtraChunk(pcm44, 44100), {
        role: "remote_mix_for_diarization"
      });
      const r2 = await prepareTrackSegments({
        wavPath: a44.wavPath,
        sidecarPath: a44.sidecarPath,
        track: "system",
        role: "remote_mix_for_diarization",
        outputDir: path.join(dir, "s44"),
        targetSegmentSeconds: 0.25
      });
      assert.ok(r2.segmentCount >= 2);
      const r3 = await prepareTrackSegments({
        wavPath: a44.wavPath,
        sidecarPath: a44.sidecarPath,
        track: "system",
        role: "remote_mix_for_diarization",
        outputDir: path.join(dir, "s44"),
        targetSegmentSeconds: 0.25
      });
      assert.ok(r3.segments.every((s) => s.reused));
    });
  });

  await test("preflight: 300s PCM fails size before network", () => {
    assert.throws(() => assertSegmentPreflight(1000, 301), (e) => e.code === "segment_duration_exceeded");
    // 300s @16k mono pcm16 wav ≈ 300*16000*2+44 bytes → Base64 >> 10MiB
    const bytes300s = 44 + 300 * 16000 * 2;
    assert.throws(() => assertSegmentPreflight(bytes300s, 300), (e) => e.code === "segment_size_exceeded");
    assert.ok(EFFECTIVE_PCM_DURATION_CAP_SECONDS < 300);
    assert.ok(estimateDataUriChars(12 * 1024 * 1024) > QWEN_NO_BUCKET.maxBase64Chars);
  });

  await test("openai client: caller abort vs timeout", async () => {
    let seenSignal = null;
    const hangFetch = async (_url, init) => {
      seenSignal = init.signal;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true }
        );
      });
    };
    const client = createOpenAiCompatibleClient({
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "m",
      requestTimeoutMs: 60_000,
      fetchImpl: hangFetch
    });
    const ac = new AbortController();
    const p = client.requestChat([{ role: "user", content: "x" }], { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(() => p, (e) => e.code === "aborted");
    assert.ok(seenSignal);
    assert.equal(seenSignal.aborted, true);

    const timeoutClient = createOpenAiCompatibleClient({
      apiKey: "test-key",
      baseUrl: "https://example.com/v1",
      model: "m",
      requestTimeoutMs: 30,
      fetchImpl: hangFetch
    });
    await assert.rejects(
      () => timeoutClient.requestChat([{ role: "user", content: "x" }]),
      (e) => e.code === "request_timeout"
    );
  });

  await test("qwen: meeting signal + raw; short-voice cleans; single user msg", async () => {
    const calls = [];
    const client = {
      async requestChat(messages, opts) {
        calls.push({ messages, opts });
        return { content: "  hi  ", body: {} };
      }
    };
    const provider = createQwen3AsrProvider({
      client,
      cleanTranscript: (t) => `[c]${t.trim()}`
    });
    const ac = new AbortController();
    const m = await provider.transcribeMeetingSegment({
      audioDataUrl: "data:audio/wav;base64,AA==",
      signal: ac.signal
    });
    assert.equal(m.text, "hi");
    assert.equal(calls[0].opts.signal, ac.signal);
    assert.equal(calls[0].messages.length, 1);
    assert.equal(calls[0].messages[0].role, "user");
    assert.ok(calls[0].messages[0].content[0].input_audio);

    const s = await provider.transcribeRaw({ audioDataUrl: "data:audio/wav;base64,AA==" });
    assert.equal(s.text, "[c]hi");
  });

  await test("sanitize: profile allowlist + secret redaction", () => {
    const p = pickSafeProfile({
      provider: "qwen3-asr",
      apiKey: "sk-secret",
      targetSegmentSeconds: 180,
      evil: "nope"
    });
    assert.equal(p.apiKey, undefined);
    assert.equal(p.evil, undefined);
    assert.equal(p.targetSegmentSeconds, 180);
    const poisoned = sanitizeForPersist({
      nested: { authorization: "Bearer abc", note: "ok", token: "x" },
      msg: "data:audio/wav;base64,AAAA"
    });
    assert.equal(poisoned.nested.authorization, undefined);
    assert.equal(poisoned.nested.token, undefined);
    assert.equal(poisoned.msg, "[redacted]");
    assert.equal(poisoned.nested.note, "ok");
  });

  await test("service: speakers, no context leak, transcript session times", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "session");
      await fsp.mkdir(sessionDir, { recursive: true });
      const pcm = writeMonoPcm16(8000, 100);
      // Compacted pause sidecar: artifact 0-500ms @qpc0, 500-1000 @qpc 5000
      const chunks = [
        { seq: 1, beginMs: 0, endMs: 250, qpcStart: 0, qpcFrequency: 1000 },
        { seq: 2, beginMs: 250, endMs: 500, qpcStart: 5000, qpcFrequency: 1000 }
      ];
      const mic = await seedArchiveFromWav(
        sessionDir,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self", origin: 0, freq: 1000, chunks }
      );
      const sys = await seedArchiveFromWav(
        sessionDir,
        "system",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "remote_mix_for_diarization", origin: 0, freq: 1000 }
      );

      const logs = [];
      const requests = [];
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        sessionId: "mtg",
        maxAttempts: 2,
        retryBackoffMs: 1,
        logger: (e) => logs.push(e),
        transcribeSegment: async ({ audioDataUrl, track, seq }) => {
          requests.push({
            track,
            seq,
            // inspect as if Qwen messages
            messages: [
              {
                role: "user",
                content: [{ type: "input_audio", input_audio: { data: audioDataUrl } }]
              }
            ]
          });
          return { text: `T-${track}-${seq}`, provider: "qwen3-asr" };
        }
      });

      await service.prepare({
        microphone: { wavPath: mic.wavPath, sidecarPath: mic.sidecarPath },
        system: { wavPath: sys.wavPath, sidecarPath: sys.sidecarPath },
        modelId: "qwen3-asr-flash"
      });
      await service.run();
      const tr = await service.getTranscript();
      assert.equal(tr.diarization, false);
      assert.ok(tr.items.every((i) => i.providerBeginMs === null && i.providerEndMs === null));
      assert.ok(tr.items.every((i) => i.timestampPrecision === "segment"));
      assert.ok(tr.items.filter((i) => i.track === "microphone").every((i) => i.speakerId === SELF_SPEAKER_ID));
      assert.ok(tr.items.filter((i) => i.track === "system").every((i) => i.speakerId === "remote_unknown"));

      for (const r of requests) {
        assert.equal(r.messages.length, 1);
        assert.equal(r.messages[0].role, "user");
        const c = r.messages[0].content;
        assert.equal(c.length, 1);
        assert.equal(c[0].type, "input_audio");
        assert.ok(String(c[0].input_audio.data).startsWith("data:audio/"));
        // no prior transcript text in request
        assert.ok(!JSON.stringify(r.messages).includes("T-microphone"));
      }

      const jobRaw = await fsp.readFile(service.store.jobPath, "utf8");
      assert.ok(!jobRaw.includes("sk-"));
      assert.ok(!jobRaw.includes("Bearer "));
      assert.ok(!logs.some((l) => JSON.stringify(l).includes("data:audio")));
    });
  });

  await test("service: single-flight + getStatus pure", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "sf");
      await fsp.mkdir(sessionDir, { recursive: true });
      const pcm = writeMonoPcm16(4000, 1);
      const arch = await seedArchiveFromWav(
        sessionDir,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      let calls = 0;
      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 1,
        transcribeSegment: async () => {
          calls += 1;
          await gate;
          return { text: "ok" };
        }
      });
      await service.prepare({ microphone: { wavPath: arch.wavPath, sidecarPath: arch.sidecarPath } });
      const runP = service.run();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(service.isRunActive, true);
      const st = await service.getStatus();
      assert.equal(st.status, JOB_STATUS.RUNNING);
      // getStatus must not recover/mutate to ready
      assert.equal((await service.getStatus()).status, JOB_STATUS.RUNNING);

      await assert.rejects(() => service.run(), (e) => e.code === "job_already_running");
      await assert.rejects(
        () => service.prepare({ microphone: { wavPath: arch.wavPath, sidecarPath: arch.sidecarPath } }),
        (e) => e.code === "job_already_running"
      );
      release();
      await runP;
      assert.equal(calls, 1);
    });
  });

  await test("service: result integrity skip vs tamper retranscribe", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "int");
      await fsp.mkdir(sessionDir, { recursive: true });
      const pcm = writeMonoPcm16(4000, 2);
      const arch = await seedArchiveFromWav(
        sessionDir,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      let calls = 0;
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 2,
        retryBackoffMs: 1,
        transcribeSegment: async () => {
          calls += 1;
          return { text: `v${calls}` };
        }
      });
      await service.prepare({ microphone: { wavPath: arch.wavPath, sidecarPath: arch.sidecarPath } });
      await service.run();
      assert.equal(calls, 1);
      // second run skips
      await service.run();
      assert.equal(calls, 1);

      // tamper result text without updating hash
      const job = await service.getStatus();
      const seq = job.tracks.microphone.segments[0].seq;
      const rp = path.join(service.store.resultsDir, `microphone_seg_${String(seq).padStart(4, "0")}.json`);
      const body = JSON.parse(await fsp.readFile(rp, "utf8"));
      body.text = "TAMPERED";
      // leave textSha256 stale
      await fsp.writeFile(rp, JSON.stringify(body));
      await service.run();
      assert.equal(calls, 2);
      const tr = await service.getTranscript();
      assert.ok(tr.items.some((i) => i.text === "v2"));
    });
  });

  await test("service: crash window RUNNING with valid result → zero ASR", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "crash");
      await fsp.mkdir(sessionDir, { recursive: true });
      const pcm = writeMonoPcm16(4000, 3);
      const arch = await seedArchiveFromWav(
        sessionDir,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      let calls = 0;
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 2,
        retryBackoffMs: 1,
        transcribeSegment: async () => {
          calls += 1;
          return { text: "authoritative-exact" };
        }
      });
      await service.prepare({ microphone: { wavPath: arch.wavPath, sidecarPath: arch.sidecarPath } });
      await service.run();
      assert.equal(calls, 1);
      const job = await service.store.loadJob();
      const seg = job.tracks.microphone.segments[0];
      // Simulate crash: valid result on disk, segment left RUNNING/PENDING
      seg.status = SEGMENT_STATUS.RUNNING;
      seg.attempts = 1;
      job.status = JOB_STATUS.RUNNING;
      await service.store.saveJob(job);

      calls = 0;
      const service2 = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 2,
        retryBackoffMs: 1,
        transcribeSegment: async () => {
          calls += 1;
          return { text: "SHOULD-NOT-RUN" };
        }
      });
      await service2.run();
      assert.equal(calls, 0);
      assert.equal((await service2.getStatus()).status, JOB_STATUS.COMPLETED);
      const tr = await service2.getTranscript();
      assert.equal(tr.items[0].text, "authoritative-exact");
    });
  });

  await test("service: failed exhausted no silent complete; retryFailed", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "fail");
      await fsp.mkdir(sessionDir, { recursive: true });
      const pcm = writeMonoPcm16(4000, 3);
      const arch = await seedArchiveFromWav(
        sessionDir,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      let calls = 0;
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 2,
        retryBackoffMs: 1,
        transcribeSegment: async () => {
          calls += 1;
          const err = new Error("boom");
          err.code = "upstream";
          throw err;
        }
      });
      await service.prepare({ microphone: { wavPath: arch.wavPath, sidecarPath: arch.sidecarPath } });
      await assert.rejects(() => service.run(), (e) => e.code === "upstream");
      assert.equal(calls, 2);
      const st1 = await service.getStatus();
      assert.equal(st1.status, JOB_STATUS.FAILED);

      // rerun without reset — no more ASR, still failed
      await assert.rejects(() => service.run(), (e) => e.code === "job_failed_exhausted");
      assert.equal(calls, 2);
      assert.equal((await service.getStatus()).status, JOB_STATUS.FAILED);

      // explicit reset
      let okCalls = 0;
      const service2 = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 2,
        retryBackoffMs: 1,
        transcribeSegment: async () => {
          okCalls += 1;
          return { text: "recovered" };
        }
      });
      await service2.retryFailed({ resetAttempts: true });
      await service2.run();
      assert.equal(okCalls, 1);
      assert.equal((await service2.getStatus()).status, JOB_STATUS.COMPLETED);
    });
  });

  await test("service: crash recovery + abort cancel", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "rec");
      await fsp.mkdir(sessionDir, { recursive: true });
      const pcm = writeMonoPcm16(16000, 4);
      const arch = await seedArchiveFromWav(
        sessionDir,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 1,
        limits: { ...QWEN_NO_BUCKET, targetSegmentSeconds: 0.4 },
        transcribeSegment: async ({ seq }) => ({ text: `seg-${seq}` })
      });
      await service.prepare({ microphone: { wavPath: arch.wavPath, sidecarPath: arch.sidecarPath } });
      let job = await service.store.loadJob();
      const segs = job.tracks.microphone.segments;
      assert.ok(segs.length >= 2);
      await service.store.writeSegmentResult({
        track: "microphone",
        seq: segs[0].seq,
        text: "seg-0-saved",
        segmentContentSha256: segs[0].contentSha256,
        generation: job.generation || 1
      });
      segs[0].status = SEGMENT_STATUS.COMPLETED;
      segs[0].hasResult = true;
      segs[1].status = SEGMENT_STATUS.RUNNING;
      job.status = JOB_STATUS.RUNNING;
      await service.store.saveJob(job);

      // getStatus pure — still running on disk
      assert.equal((await service.getStatus()).status, JOB_STATUS.RUNNING);
      // run recovers
      const calls = [];
      const service2 = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 1,
        limits: { ...QWEN_NO_BUCKET, targetSegmentSeconds: 0.4 },
        transcribeSegment: async ({ seq }) => {
          calls.push(seq);
          return { text: `seg-${seq}` };
        }
      });
      await service2.run();
      assert.ok(!calls.includes(segs[0].seq));

      // abort
      const sessionDir2 = path.join(dir, "ab");
      await fsp.mkdir(sessionDir2, { recursive: true });
      const arch2 = await seedArchiveFromWav(
        sessionDir2,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      const ac = new AbortController();
      const s3 = createNoBucketMeetingTranscriptionService({
        sessionDir: sessionDir2,
        maxAttempts: 1,
        transcribeSegment: async () => {
          ac.abort();
          const err = new Error("aborted");
          err.code = "aborted";
          throw err;
        }
      });
      await s3.prepare({ microphone: { wavPath: arch2.wavPath, sidecarPath: arch2.sidecarPath } });
      await assert.rejects(() => s3.run({ signal: ac.signal }), (e) => e.code === "aborted");
      assert.equal((await s3.getStatus()).status, JOB_STATUS.CANCELLED);
      await assert.rejects(() => s3.run(), (e) => e.code === "job_cancelled");
    });
  });

  await test("job_corrupt vs missing; poisoned profile not persisted", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "c");
      await fsp.mkdir(sessionDir, { recursive: true });
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        transcribeSegment: async () => ({ text: "x" })
      });
      await service.store.init();
      assert.equal(await service.getStatus(), null);
      await fsp.writeFile(service.store.jobPath, "{not json");
      await assert.rejects(() => service.getStatus(), (e) => e.code === "job_corrupt");
      assert.ok(fs.existsSync(service.store.jobPath));

      const pcm = writeMonoPcm16(2000, 1);
      const arch = await seedArchiveFromWav(
        sessionDir,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      // overwrite corrupt with prepare after delete
      await fsp.unlink(service.store.jobPath);
      await service.prepare({
        microphone: { wavPath: arch.wavPath, sidecarPath: arch.sidecarPath },
        modelId: "m",
        // if someone passes secrets in future API — createJob allowlists
      });
      // manually try save poisoned
      const job = await service.store.loadJob();
      job.profile = { apiKey: "sk-leaked", provider: "qwen3-asr", targetSegmentSeconds: 180 };
      job.lastError = { message: "Bearer secret-token data:audio/wav;base64,AAAA" };
      await service.store.saveJob(job);
      const raw = await fsp.readFile(service.store.jobPath, "utf8");
      assert.ok(!raw.includes("sk-leaked"));
      assert.ok(!raw.includes("Bearer secret"));
      assert.ok(!raw.includes("data:audio"));
    });
  });

  await test("no real fetch default path with inject", async () => {
    let fetched = false;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      fetched = true;
      throw new Error("no net");
    };
    try {
      const p = createQwen3AsrProvider({
        client: { requestChat: async () => ({ content: "local" }) },
        cleanTranscript: (t) => t
      });
      assert.equal((await p.transcribeMeetingSegment({ audioDataUrl: "data:audio/wav;base64,AA==" })).text, "local");
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  await test("transcript text >500 chars preserved exactly", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "long");
      await fsp.mkdir(sessionDir, { recursive: true });
      const pcm = writeMonoPcm16(4000, 7);
      const arch = await seedArchiveFromWav(
        sessionDir,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      const longText = `前缀${"汉".repeat(600)}后缀-END`;
      assert.ok(longText.length > 500);
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 1,
        transcribeSegment: async () => ({ text: longText })
      });
      await service.prepare({ microphone: { wavPath: arch.wavPath, sidecarPath: arch.sidecarPath } });
      await service.run();
      const tr = await service.getTranscript();
      assert.equal(tr.items.length, 1);
      assert.equal(tr.items[0].text, longText);
      assert.equal(tr.items[0].text.length, longText.length);
      // disk bytes round-trip
      const disk = JSON.parse(await fsp.readFile(service.store.transcriptPath, "utf8"));
      assert.equal(disk.items[0].text, longText);
    });
  });

  await test("expected generation rejects missing generation", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "gen");
      await fsp.mkdir(sessionDir, { recursive: true });
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        transcribeSegment: async () => ({ text: "x" })
      });
      await service.store.init();
      const rp = path.join(service.store.resultsDir, "microphone_seg_0000.json");
      await fsp.mkdir(service.store.resultsDir, { recursive: true });
      const text = "hello";
      // omit generation field entirely
      await fsp.writeFile(
        rp,
        JSON.stringify({
          schema: "meeting_qwen_segment_result_v1",
          track: "microphone",
          seq: 0,
          text,
          textSha256: sha256Text(text),
          segmentContentSha256: "abc"
        })
      );
      const missing = await service.store.readValidatedSegmentResult("microphone", 0, "abc", 1);
      assert.equal(missing.ok, false);
      assert.equal(missing.code, "result_generation_missing");

      // wrong generation
      await fsp.writeFile(
        rp,
        JSON.stringify({
          schema: "meeting_qwen_segment_result_v1",
          track: "microphone",
          seq: 0,
          generation: 2,
          text,
          textSha256: sha256Text(text),
          segmentContentSha256: "abc"
        })
      );
      const mismatch = await service.store.readValidatedSegmentResult("microphone", 0, "abc", 1);
      assert.equal(mismatch.ok, false);
      assert.equal(mismatch.code, "result_generation_mismatch");
    });
  });

  await test("same-tick dual run: one ASR, one job_already_running", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "race");
      await fsp.mkdir(sessionDir, { recursive: true });
      const pcm = writeMonoPcm16(4000, 8);
      const arch = await seedArchiveFromWav(
        sessionDir,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      let calls = 0;
      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 1,
        transcribeSegment: async () => {
          calls += 1;
          await gate;
          return { text: "once" };
        }
      });
      await service.prepare({ microphone: { wavPath: arch.wavPath, sidecarPath: arch.sidecarPath } });
      // Start both without awaiting either (same-tick race)
      const p1 = service.run();
      const p2 = service.run();
      // Release ASR gate after microtasks so the winner can finish
      setTimeout(() => release(), 5);
      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].reason.code, "job_already_running");
      assert.equal(calls, 1);
      assert.equal((await service.getStatus()).status, JOB_STATUS.COMPLETED);
    });
  });

  await test("retryFailed rejects completed job", async () => {
    await withTempDir(async (dir) => {
      const sessionDir = path.join(dir, "rt");
      await fsp.mkdir(sessionDir, { recursive: true });
      const pcm = writeMonoPcm16(4000, 9);
      const arch = await seedArchiveFromWav(
        sessionDir,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      const service = createNoBucketMeetingTranscriptionService({
        sessionDir,
        maxAttempts: 1,
        transcribeSegment: async () => ({ text: "done" })
      });
      await service.prepare({ microphone: { wavPath: arch.wavPath, sidecarPath: arch.sidecarPath } });
      await service.run();
      assert.equal((await service.getStatus()).status, JOB_STATUS.COMPLETED);
      await assert.rejects(() => service.retryFailed({ resetAttempts: true }), (e) => {
        return e.code === "retry_not_applicable";
      });
      // fresh READY without failures also rejected
      const sessionDir2 = path.join(dir, "rt2");
      await fsp.mkdir(sessionDir2, { recursive: true });
      const arch2 = await seedArchiveFromWav(
        sessionDir2,
        "microphone",
        buildWavWithExtraChunk(pcm, 16000, { extraChunk: false }),
        { role: "self" }
      );
      const s2 = createNoBucketMeetingTranscriptionService({
        sessionDir: sessionDir2,
        transcribeSegment: async () => ({ text: "x" })
      });
      await s2.prepare({ microphone: { wavPath: arch2.wavPath, sidecarPath: arch2.sidecarPath } });
      assert.equal((await s2.getStatus()).status, JOB_STATUS.READY);
      await assert.rejects(() => s2.retryFailed(), (e) => e.code === "retry_not_applicable");
    });
  });

  console.log(`\n${passed} tests passed`);
}

run().catch(() => {
  process.exitCode = 1;
});
