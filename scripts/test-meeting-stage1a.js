"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  exportTrackArchive,
  verifyArchiveIntegrity,
  downmixInterleavedToMonoPcm16,
  buildWavHeader,
  mapArtifactTimeRange,
  findChunkForArtifactMs,
  parseJournalGapsFromEntries,
  PAUSE_HOLE_POLICY,
  MAX_WAV_DATA_BYTES,
  assertWavDataSize,
  sha256File
} = require("../src/meeting/archive/export-track-wav");
const { resolveL0SampleEncoding } = require("../src/meeting/archive/l0-format");
const {
  createOfflineMeetingAudioPublisher,
  createRemoteUrlMeetingAudioPublisher,
  requirePublicUrlPublisher,
  MeetingPublisherError
} = require("../src/meeting/publish/meeting-audio-publisher");
const { mergeMeetingTimeline, SELF_SPEAKER_ID } = require("../src/meeting/timeline/merge-timeline");
const {
  createFunAsrProvider,
  parseStructuredSentences,
  isTransientError
} = require("../src/providers/asr/fun-asr-provider");

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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-meeting-1a-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function writePcm16Stereo(frames, left, right) {
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    buf.writeInt16LE(left, i * 4);
    buf.writeInt16LE(right, i * 4 + 2);
  }
  return buf;
}

function writeFloat32Stereo(frames, left, right) {
  const buf = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i += 1) {
    buf.writeFloatLE(left, i * 8);
    buf.writeFloatLE(right, i * 8 + 4);
  }
  return buf;
}

function writePcm16Mono(frames, sample) {
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/** Exact Rust helper journal hole shape from append_journal("hole", {...}). */
function rustHoleRecord({ reason, holeQpc, pauseGen, discardedFrames = 0, track, role, sessionOriginQpc, qpcFrequency, t = Date.now() }) {
  return {
    t,
    kind: "hole",
    detail: {
      reason,
      detail: {
        holeQpc,
        sessionOriginQpc,
        qpcFrequency,
        discardedFrames,
        pauseGen
      },
      track,
      role,
      at: t
    }
  };
}

async function seedTrack(trackDir, {
  kind = "pcm16",
  channels = 2,
  sampleRate = 16000,
  chunks = [],
  /** @type {Array<object>|null} raw journal objects (preferred) */
  journalRecords = null,
  /** @type {Array<object>} simplified hole specs → Rust begin/end pairs */
  holes = [],
  sessionId = "mtg-test",
  track = "microphone",
  role = "self",
  origin = 1000000,
  freq = 10000000,
  /** optional per-chunk qpc override: [{ qpcStart, qpcEnd }] */
  chunkQpc = null
} = {}) {
  await fsp.mkdir(trackDir, { recursive: true });
  const bitsPerSample = kind === "pcm16" ? 16 : 32;
  const blockAlign = channels * (bitsPerSample / 8);
  const format = {
    sampleRate,
    channels,
    bitsPerSample,
    blockAlign,
    formatTag: kind === "pcm16" ? 1 : 3,
    subFormat: kind === "pcm16" ? "WAVE_FORMAT_PCM" : "WAVE_FORMAT_IEEE_FLOAT",
    layer: "L0"
  };

  const indexLines = [];
  let frameCursor = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const seq = i + 1;
    const name = `${String(seq).padStart(6, "0")}.l0.pcm`;
    const payload = chunks[i];
    await fsp.writeFile(path.join(trackDir, name), payload);
    const frames = Math.floor(payload.length / blockAlign);
    const frameStart = frameCursor;
    const frameEnd = frameCursor + frames;
    frameCursor = frameEnd;
    const qpcOverride = chunkQpc && chunkQpc[i] ? chunkQpc[i] : null;
    const qpcStart =
      qpcOverride?.qpcStart ?? origin + Math.round((frameStart / sampleRate) * freq);
    const qpcEnd =
      qpcOverride?.qpcEnd ?? origin + Math.round((frameEnd / sampleRate) * freq);
    indexLines.push(
      JSON.stringify({
        schema: "l0_chunk_v1",
        seq,
        file: name,
        bytes: payload.length,
        frames,
        frameStart,
        frameEnd,
        devicePosStart: frameStart,
        devicePosEnd: frameEnd,
        qpcStart,
        qpcEnd,
        sessionOriginQpc: origin,
        qpcFrequency: freq,
        silentFrames: 0,
        track,
        role,
        format
      })
    );
  }

  await fsp.writeFile(path.join(trackDir, "index.jsonl"), `${indexLines.join("\n")}\n`, "utf8");

  let journal = journalRecords;
  if (!journal) {
    journal = [];
    for (const hole of holes) {
      if (hole.beginQpc != null || hole.reason === "pause_begin" || hole.pauseGen != null) {
        const gen = hole.pauseGen ?? 1;
        journal.push(
          rustHoleRecord({
            reason: "pause_begin",
            holeQpc: hole.beginQpc ?? hole.holeQpc ?? 12345,
            pauseGen: gen,
            discardedFrames: 0,
            track,
            role,
            sessionOriginQpc: origin,
            qpcFrequency: freq
          })
        );
        if (hole.endQpc != null || hole.includeEnd !== false) {
          journal.push(
            rustHoleRecord({
              reason: "pause_end",
              holeQpc: hole.endQpc ?? (hole.beginQpc ?? hole.holeQpc ?? 12345) + 1000,
              pauseGen: gen,
              discardedFrames: hole.discardedFrames ?? 48000,
              track,
              role,
              sessionOriginQpc: origin,
              qpcFrequency: freq
            })
          );
        }
      } else {
        // legacy single-shot
        journal.push({
          op: "hole",
          reason: hole.reason || "pause",
          track,
          role,
          detail: { holeQpc: hole.holeQpc ?? 12345 },
          at: Date.now()
        });
      }
    }
  }
  if (journal.length) {
    await fsp.writeFile(
      path.join(trackDir, "journal.jsonl"),
      `${journal.map((j) => JSON.stringify(j)).join("\n")}\n`,
      "utf8"
    );
  }

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

  return { format, origin, freq };
}

function readWavPcm16Mono(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const dataSize = buf.readUInt32LE(40);
  const pcm = buf.subarray(44, 44 + dataSize);
  return { channels, sampleRate, bits, pcm, dataSize };
}

async function run() {
  await test("l0-format: pcm16 and float32 resolve; unsupported rejected", () => {
    const p = resolveL0SampleEncoding({
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 16,
      blockAlign: 4,
      formatTag: 1,
      subFormat: "WAVE_FORMAT_PCM"
    });
    assert.equal(p.kind, "pcm16");
    const f = resolveL0SampleEncoding({
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 32,
      blockAlign: 8,
      formatTag: 3,
      subFormat: "WAVE_FORMAT_IEEE_FLOAT"
    });
    assert.equal(f.kind, "float32");
    assert.throws(
      () =>
        resolveL0SampleEncoding({
          sampleRate: 48000,
          channels: 2,
          bitsPerSample: 24,
          blockAlign: 6,
          formatTag: 1,
          subFormat: "WAVE_FORMAT_PCM"
        }),
      (err) => err.code === "l0_format_unsupported"
    );
  });

  await test("downmix: pcm16 stereo average with clip", () => {
    const enc = resolveL0SampleEncoding({
      sampleRate: 16000,
      channels: 2,
      bitsPerSample: 16,
      blockAlign: 4,
      formatTag: 1,
      subFormat: "WAVE_FORMAT_PCM"
    });
    const input = writePcm16Stereo(2, 1000, 3000);
    const out = downmixInterleavedToMonoPcm16(input, enc);
    assert.equal(out.length, 4);
    assert.equal(out.readInt16LE(0), 2000);
    assert.equal(out.readInt16LE(2), 2000);
  });

  await test("downmix: float32 stereo to mono pcm16", () => {
    const enc = resolveL0SampleEncoding({
      sampleRate: 16000,
      channels: 2,
      bitsPerSample: 32,
      blockAlign: 8,
      formatTag: 3,
      subFormat: "WAVE_FORMAT_IEEE_FLOAT"
    });
    const input = writeFloat32Stereo(1, 0.5, 0.5);
    const out = downmixInterleavedToMonoPcm16(input, enc);
    assert.equal(out.length, 2);
    const s = out.readInt16LE(0);
    assert.ok(s > 16000 && s < 17000);
  });

  await test("journal: Rust kind:hole pause_begin/end paired by pauseGen", () => {
    const origin = 1_000_000;
    const freq = 10_000_000;
    const entries = [
      rustHoleRecord({
        reason: "pause_begin",
        holeQpc: 2_000_000,
        pauseGen: 3,
        track: "microphone",
        role: "self",
        sessionOriginQpc: origin,
        qpcFrequency: freq
      }),
      rustHoleRecord({
        reason: "pause_end",
        holeQpc: 5_000_000,
        pauseGen: 3,
        discardedFrames: 48000,
        track: "microphone",
        role: "self",
        sessionOriginQpc: origin,
        qpcFrequency: freq
      }),
      // unmatched begin
      rustHoleRecord({
        reason: "pause_begin",
        holeQpc: 9_000_000,
        pauseGen: 4,
        track: "microphone",
        role: "self",
        sessionOriginQpc: origin,
        qpcFrequency: freq
      }),
      // legacy shape still accepted
      {
        op: "hole",
        reason: "pause",
        detail: { holeQpc: 111 },
        track: "system"
      }
    ];
    const gaps = parseJournalGapsFromEntries(entries);
    assert.equal(gaps.length, 3);
    const paired = gaps.find((g) => g.pauseGen === 3);
    assert.ok(paired);
    assert.equal(paired.qpcBegin, 2_000_000);
    assert.equal(paired.qpcEnd, 5_000_000);
    assert.equal(paired.discardedFrames, 48000);
    assert.equal(paired.phase, "interval");
    const beginOnly = gaps.find((g) => g.pauseGen === 4);
    assert.equal(beginOnly.phase, "begin_only");
    assert.equal(beginOnly.qpcBegin, 9_000_000);
    const legacy = gaps.find((g) => g.holeQpc === 111);
    assert.ok(legacy);
  });

  await test("journal: Rust discontinuity point gap keeps nested qpc", () => {
    const record = {
      kind: "hole",
      detail: {
        reason: "discontinuity",
        detail: {
          qpc: 999991229975,
          qpcFrequency: 10000000,
          sessionOriginQpc: 999991364584,
          packetFlag: true,
          flags: 1,
          devicePosition: 123,
          clockPos: 456
        },
        track: "microphone",
        role: "self"
      }
    };
    const gaps = parseJournalGapsFromEntries([record]);
    assert.equal(gaps.length, 1);
    const g = gaps[0];
    assert.equal(g.reason, "discontinuity");
    assert.equal(g.phase, "point");
    assert.equal(g.qpcBegin, 999991229975);
    assert.equal(g.qpcEnd, 999991229975);
    assert.equal(g.holeQpc, 999991229975);
    assert.equal(g.qpcFrequency, 10000000);
    assert.equal(g.sessionOriginQpc, 999991364584);
    assert.equal(g.track, "microphone");
    assert.equal(g.role, "self");
    assert.equal(g.pauseGen, null);

    // discontinuity must not pair with surrounding pause events
    const mixed = parseJournalGapsFromEntries([
      {
        kind: "hole",
        detail: {
          reason: "pause_begin",
          detail: { holeQpc: 100, pauseGen: 1, qpcFrequency: 10000000, sessionOriginQpc: 0 },
          track: "microphone",
          role: "self"
        }
      },
      record,
      {
        kind: "hole",
        detail: {
          reason: "pause_end",
          detail: { holeQpc: 500, pauseGen: 1, discardedFrames: 10, qpcFrequency: 10000000, sessionOriginQpc: 0 },
          track: "microphone",
          role: "self"
        }
      }
    ]);
    assert.equal(mixed.length, 2);
    const pause = mixed.find((x) => x.phase === "interval");
    const disc = mixed.find((x) => x.reason === "discontinuity");
    assert.ok(pause);
    assert.equal(pause.qpcBegin, 100);
    assert.equal(pause.qpcEnd, 500);
    assert.ok(disc);
    assert.equal(disc.phase, "point");
    assert.equal(disc.qpcBegin, 999991229975);
  });

  await test("export: pcm16 L0 + Rust journal gaps + contentSha256", async () => {
    await withTempDir(async (dir) => {
      const trackDir = path.join(dir, "audio", "microphone");
      const c1 = writePcm16Stereo(100, 1000, 1000);
      const c2 = writePcm16Stereo(50, 2000, 0);
      await seedTrack(trackDir, {
        kind: "pcm16",
        channels: 2,
        sampleRate: 16000,
        chunks: [c1, c2],
        holes: [{ beginQpc: 999888, endQpc: 1999888, pauseGen: 1, discardedFrames: 16000 }],
        track: "microphone",
        role: "self"
      });
      const outDir = path.join(dir, "archive");
      const result = await exportTrackArchive({
        trackDir,
        track: "microphone",
        role: "self",
        sessionId: "mtg-test",
        outputDir: outDir
      });
      assert.equal(result.ok, true);
      assert.equal(result.gapCount, 1);
      assert.ok(result.contentSha256);
      assert.equal(result.contentSha256.length, 64);
      const wav = readWavPcm16Mono(result.wavPath);
      assert.equal(wav.pcm.length, 150 * 2);
      const sidecar = JSON.parse(fs.readFileSync(result.sidecarPath, "utf8"));
      assert.equal(sidecar.contentSha256, result.contentSha256);
      assert.equal(sidecar.commit.twoFileAtomic, false);
      assert.equal(sidecar.gaps[0].qpcBegin, 999888);
      assert.equal(sidecar.gaps[0].qpcEnd, 1999888);
      assert.equal(sidecar.gaps[0].discardedFrames, 16000);
      const fileHash = crypto.createHash("sha256").update(fs.readFileSync(result.wavPath)).digest("hex");
      assert.equal(fileHash, sidecar.contentSha256);
      assert.equal(PAUSE_HOLE_POLICY.insertSilenceInWav, false);
    });
  });

  await test("export: float32 L0 + idempotent re-run", async () => {
    await withTempDir(async (dir) => {
      const trackDir = path.join(dir, "audio", "system");
      const c1 = writeFloat32Stereo(80, 0.25, -0.25);
      await seedTrack(trackDir, {
        kind: "float32",
        channels: 2,
        sampleRate: 48000,
        chunks: [c1],
        track: "system",
        role: "remote_mix_for_diarization"
      });
      const outDir = path.join(dir, "archive");
      const r1 = await exportTrackArchive({
        trackDir,
        track: "system",
        role: "remote_mix_for_diarization",
        outputDir: outDir,
        artifactBaseName: "system.mono"
      });
      const body1 = fs.readFileSync(r1.wavPath);
      const r2 = await exportTrackArchive({
        trackDir,
        track: "system",
        role: "remote_mix_for_diarization",
        outputDir: outDir,
        artifactBaseName: "system.mono"
      });
      assert.equal(body1.equals(fs.readFileSync(r2.wavPath)), true);
      assert.equal(r1.contentSha256, r2.contentSha256);
    });
  });

  await test("export: unsupported format rejected", async () => {
    await withTempDir(async (dir) => {
      const trackDir = path.join(dir, "audio", "microphone");
      await fsp.mkdir(trackDir, { recursive: true });
      await fsp.writeFile(path.join(trackDir, "000001.l0.pcm"), Buffer.alloc(24));
      await fsp.writeFile(
        path.join(trackDir, "manifest.json"),
        JSON.stringify({
          track: "microphone",
          role: "self",
          actualL0Format: {
            sampleRate: 48000,
            channels: 2,
            bitsPerSample: 24,
            blockAlign: 6,
            formatTag: 1,
            subFormat: "WAVE_FORMAT_PCM"
          }
        }),
        "utf8"
      );
      await assert.rejects(
        () => exportTrackArchive({ trackDir, outputDir: path.join(dir, "archive") }),
        (err) => err.code === "l0_format_unsupported"
      );
    });
  });

  await test("export: chunk format mismatch rejected", async () => {
    await withTempDir(async (dir) => {
      const trackDir = path.join(dir, "audio", "microphone");
      await fsp.mkdir(trackDir, { recursive: true });
      const payload = writePcm16Stereo(10, 1, 1);
      await fsp.writeFile(path.join(trackDir, "000001.l0.pcm"), payload);
      await fsp.writeFile(
        path.join(trackDir, "manifest.json"),
        JSON.stringify({
          track: "microphone",
          role: "self",
          actualL0Format: {
            sampleRate: 16000,
            channels: 2,
            bitsPerSample: 16,
            blockAlign: 4,
            formatTag: 1,
            subFormat: "WAVE_FORMAT_PCM"
          }
        }),
        "utf8"
      );
      await fsp.writeFile(
        path.join(trackDir, "index.jsonl"),
        `${JSON.stringify({
          seq: 1,
          file: "000001.l0.pcm",
          format: {
            sampleRate: 48000,
            channels: 2,
            bitsPerSample: 32,
            blockAlign: 8,
            formatTag: 3,
            subFormat: "WAVE_FORMAT_IEEE_FLOAT"
          }
        })}\n`,
        "utf8"
      );
      await assert.rejects(
        () => exportTrackArchive({ trackDir, outputDir: path.join(dir, "archive") }),
        (err) => err.code === "l0_format_mismatch"
      );
    });
  });

  await test("wav: riff overflow guard", () => {
    assert.throws(() => assertWavDataSize(MAX_WAV_DATA_BYTES + 1), (err) => err.code === "wav_riff_overflow");
    assert.doesNotThrow(() => buildWavHeader(100, 16000, 1, 16));
  });

  await test("publisher: offline never public; requirePublicUrl fails", async () => {
    const offline = createOfflineMeetingAudioPublisher();
    assert.equal(offline.capabilities().canProvidePublicUrl, false);
    const pub = await offline.publish({ localPath: "C:\\\\tmp\\\\a.wav", track: "system" });
    assert.equal(pub.public, false);
    assert.equal(pub.url, null);
    assert.throws(() => requirePublicUrlPublisher(offline), (err) => {
      return err instanceof MeetingPublisherError && err.code === "meeting_publisher_public_url_required";
    });
  });

  await test("publisher: remote URL adapter accepts https only", async () => {
    const remote = createRemoteUrlMeetingAudioPublisher({
      resolveUrl: async () => "https://example.com/meeting/test.wav"
    });
    requirePublicUrlPublisher(remote);
    const pub = await remote.publish({ localPath: "D:\\\\secret\\\\path.wav", track: "system", sessionId: "s1" });
    assert.equal(pub.public, true);
    assert.equal(pub.localPath, null);
    const bad = createRemoteUrlMeetingAudioPublisher({
      resolveUrl: async () => "http://insecure.example/a.wav"
    });
    await assert.rejects(() => bad.publish({ localPath: "x" }), (err) => err.code === "public_url_unavailable");
  });

  await test("fun-asr: diarization field only when requested; mono validation", async () => {
    const provider = createFunAsrProvider({
      apiKey: "test-key-not-real",
      cleanTranscript: (t) => t,
      getOptions: () => ({})
    });
    assert.equal(provider._buildBatchParameters().diarization_enabled, undefined);
    assert.equal(provider._buildBatchParameters({ diarizationEnabled: true }).diarization_enabled, true);
    await assert.rejects(
      () =>
        provider.transcribeMeetingStructured({
          audioUrl: "https://example.com/a.wav",
          diarizationEnabled: true,
          mono: false
        }),
      (err) => err.code === "diarization_requires_mono"
    );
  });

  await test("fun-asr: structured sentence parse", () => {
    const sentences = parseStructuredSentences({
      transcripts: [
        {
          channel_id: 0,
          sentences: [
            { text: "你好", begin_time: 100, end_time: 800, speaker_id: 1, confidence: 0.91 },
            { text: "世界", begin_time: 900, end_time: 1500, speaker_id: 2 }
          ]
        }
      ]
    });
    assert.equal(sentences.length, 2);
    assert.equal(sentences[0].speakerId, 1);
    assert.equal(sentences[0].confidence, 0.91);
  });

  await test("fun-asr: GET poll + raw meeting text + short-voice clean unchanged", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({
        url: String(url),
        method: String(init?.method || "GET").toUpperCase(),
        headers: init?.headers || {},
        body: init?.body
      });
      if (String(url).includes("/services/audio/asr/transcription")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ output: { task_id: "task-abc" } })
        };
      }
      if (String(url).includes("/tasks/")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              output: {
                task_status: "SUCCEEDED",
                results: [
                  {
                    subtask_status: "SUCCEEDED",
                    transcription_url: "https://example.com/result.json"
                  }
                ]
              }
            })
        };
      }
      if (String(url).includes("result.json")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              transcripts: [
                {
                  sentences: [
                    { text: "远端甲", begin_time: 0, end_time: 500, speaker_id: 0 },
                    { text: "远端乙", begin_time: 600, end_time: 1200, speaker_id: 1 }
                  ]
                }
              ]
            })
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const provider = createFunAsrProvider({
      apiKey: "test-key-not-real",
      cleanTranscript: (t) => `[clean]${t}`,
      getOptions: () => ({}),
      fetchImpl,
      requestTimeoutMs: 5000,
      meetingPollTimeoutMs: 5000,
      backoffMsImpl: () => 0
    });

    const meeting = await provider.transcribeMeetingStructured({
      audioUrl: "https://cdn.example.com/sys.wav",
      diarizationEnabled: true,
      mono: true,
      channels: 1
    });
    assert.equal(meeting.text, "远端甲远端乙");
    assert.equal(meeting.cleanedText, "[clean]远端甲远端乙");
    assert.notEqual(meeting.text, meeting.cleanedText);

    const pollCall = calls.find((c) => c.url.includes("/tasks/"));
    assert.ok(pollCall);
    assert.equal(pollCall.method, "GET");
    assert.ok(pollCall.headers.Authorization);
    assert.equal(pollCall.headers["Content-Type"], "application/json");
    assert.equal(pollCall.headers["X-DashScope-Async"], undefined);

    const submitCall = calls.find((c) => c.url.includes("/transcription"));
    assert.equal(submitCall.method, "POST");
    assert.equal(submitCall.headers["X-DashScope-Async"], "enable");

    const short = await provider.transcribeRaw({
      audioDataUrl: "https://cdn.example.com/short.wav"
    });
    assert.equal(short.text, "[clean]远端甲远端乙");
  });

  await test("fun-asr: request_timeout is transient; aborted is not", () => {
    assert.equal(isTransientError({ code: "request_timeout" }), true);
    assert.equal(isTransientError({ code: "aborted" }), false);
    assert.equal(isTransientError({ status: 503 }), true);
  });

  await test("fun-asr: caller abort stops immediately without retry storm", async () => {
    let fetches = 0;
    const ac = new AbortController();
    const fetchImpl = async () => {
      fetches += 1;
      ac.abort();
      const err = new Error("aborted by caller");
      err.name = "AbortError";
      throw err;
    };
    const provider = createFunAsrProvider({
      apiKey: "test-key-not-real",
      cleanTranscript: (t) => t,
      getOptions: () => ({}),
      fetchImpl,
      requestTimeoutMs: 5000,
      backoffMsImpl: () => 0
    });
    await assert.rejects(
      () =>
        provider.transcribeMeetingStructured({
          audioUrl: "https://cdn.example.com/a.wav",
          signal: ac.signal
        }),
      (err) => err.code === "aborted"
    );
    assert.ok(fetches <= 2);
  });

  await test("mapArtifactTimeRange: qpcStart+offset; gaps filter by interval", () => {
    const origin = 0;
    const freq = 1000; // 1 qpc = 1 ms
    const sidecar = {
      sessionOriginQpc: origin,
      qpcFrequency: freq,
      chunks: [
        { seq: 1, beginMs: 0, endMs: 1000, qpcStart: 0, qpcEnd: 999999, qpcFrequency: freq },
        { seq: 2, beginMs: 1000, endMs: 2000, qpcStart: 5000, qpcEnd: 999999, qpcFrequency: freq }
      ],
      gaps: [
        { qpcBegin: 100, qpcEnd: 200, holeQpc: 100 },
        { qpcBegin: 5200, qpcEnd: 5300, holeQpc: 5200 },
        { qpcBegin: 9000, qpcEnd: 9100, holeQpc: 9000 }
      ]
    };
    // 1200 ms → chunk2 qpcStart 5000 + 200ms * 1000 = 5200
    const mapped = mapArtifactTimeRange(sidecar, 1200, 1500);
    assert.deepEqual(mapped.coveringSeqs, [2]);
    assert.equal(mapped.qpcBegin, 5200);
    assert.equal(mapped.qpcEnd, 5500);
    assert.equal(mapped.sessionBeginMs, 5200);
    assert.equal(mapped.sessionEndMs, 5500);
    assert.equal(mapped.gapsOverlapping.length, 1);
    assert.equal(mapped.gapsOverlapping[0].qpcBegin, 5200);
    assert.ok(mapped.qpcBegin < 10000);
  });

  await test("mapArtifactTimeRange: boundary begin→next chunk, end→prev chunk after pause gap", () => {
    const origin = 0;
    const freq = 1000;
    // Compact-adjacent artifact chunks with large QPC pause between them
    const sidecar = {
      sessionOriginQpc: origin,
      qpcFrequency: freq,
      chunks: [
        { seq: 1, beginMs: 0, endMs: 1000, qpcStart: 0, qpcFrequency: freq },
        // after pause: artifact continues at 1000ms but session QPC jumps to 10000
        { seq: 2, beginMs: 1000, endMs: 2000, qpcStart: 10000, qpcFrequency: freq }
      ],
      gaps: [{ qpcBegin: 1000, qpcEnd: 10000, phase: "interval" }]
    };
    const boundary = 1000;
    assert.equal(findChunkForArtifactMs(sidecar.chunks, boundary, "begin").seq, 2);
    assert.equal(findChunkForArtifactMs(sidecar.chunks, boundary, "end").seq, 1);

    // Sentence beginning exactly at chunk2.beginMs
    const beginOnly = mapArtifactTimeRange(sidecar, boundary, boundary + 100);
    assert.equal(beginOnly.beginChunkSeq, 2);
    assert.equal(beginOnly.qpcBegin, 10000);
    assert.equal(beginOnly.sessionBeginMs, 10000);

    // Sentence ending exactly at the same boundary maps to chunk1 end approx
    const endAtBoundary = mapArtifactTimeRange(sidecar, 900, boundary);
    assert.equal(endAtBoundary.endChunkSeq, 1);
    assert.equal(endAtBoundary.qpcEnd, 1000); // qpcStart0 + 1000ms
    assert.equal(endAtBoundary.sessionEndMs, 1000);
    assert.ok(endAtBoundary.qpcEnd < beginOnly.qpcBegin);
  });

  await test("timeline: shared session QPC orders across compacted pause", () => {
    const origin = 0;
    const freq = 1000;
    // Mic: no pause; artifact 100ms == session 100ms
    const micSidecar = {
      sessionOriginQpc: origin,
      qpcFrequency: freq,
      chunks: [{ seq: 1, beginMs: 0, endMs: 5000, qpcStart: 0, qpcFrequency: freq }],
      gaps: []
    };
    // System: pause compacted out. After pause, artifact 100ms is actually session ~2100ms
    // chunk1: 0-1000ms artifact @ qpc 0
    // pause discarded wall time
    // chunk2: 1000-3000ms artifact @ qpcStart 3000 (session 3000ms)
    const sysSidecar = {
      sessionOriginQpc: origin,
      qpcFrequency: freq,
      chunks: [
        { seq: 1, beginMs: 0, endMs: 1000, qpcStart: 0, qpcFrequency: freq },
        { seq: 2, beginMs: 1000, endMs: 3000, qpcStart: 3000, qpcFrequency: freq }
      ],
      gaps: [{ qpcBegin: 1000, qpcEnd: 3000, discardedFrames: 1000, phase: "interval" }]
    };

    // Equal artifact-relative timestamps (100ms) map to different session times:
    // mic sessionBeginMs=100; system sentence at artifact 1100 → session 3100
    const merged = mergeMeetingTimeline({
      sessionId: "pause-order",
      microphoneSidecar: micSidecar,
      systemSidecar: sysSidecar,
      microphoneSentences: [
        { text: "mic-early", beginMs: 100, endMs: 200 },
        { text: "mic-late", beginMs: 2500, endMs: 2600 }
      ],
      systemSentences: [
        // artifact 1100 → qpc 3000+100 = 3100 session ms — after mic-early, before/after mic-late
        { text: "sys-after-pause", beginMs: 1100, endMs: 1200, speakerId: 1 },
        // artifact 50 → session 50 — before mic-early
        { text: "sys-before-pause", beginMs: 50, endMs: 80, speakerId: 2 }
      ]
    });

    const texts = merged.items.map((i) => i.text);
    assert.deepEqual(texts, ["sys-before-pause", "mic-early", "mic-late", "sys-after-pause"]);
    const sysAfter = merged.items.find((i) => i.text === "sys-after-pause");
    const micEarly = merged.items.find((i) => i.text === "mic-early");
    assert.equal(sysAfter.artifactBeginMs, 1100);
    assert.equal(micEarly.artifactBeginMs, 100);
    assert.ok(sysAfter.sessionBeginMs > micEarly.sessionBeginMs);
    assert.ok(sysAfter.sessionBeginMs > 3000);
    // If sorted only by artifact ms, sys-after-pause (1100) would incorrectly precede mic-late (2500)
    // but follow mic-early — session sort places it after mic-late (2500 session).
    assert.equal(merged.policy.sortKey, "sessionBeginMs_then_artifactBeginMs");
  });

  await test("timeline: merge self + remote overlap tie-break", () => {
    const origin = 1000;
    const freq = 1000;
    const micSidecar = {
      sessionOriginQpc: origin,
      qpcFrequency: freq,
      chunks: [{ seq: 1, beginMs: 0, endMs: 2000, qpcStart: 1000, qpcFrequency: freq }],
      gaps: []
    };
    const sysSidecar = {
      sessionOriginQpc: origin,
      qpcFrequency: freq,
      chunks: [{ seq: 1, beginMs: 0, endMs: 3000, qpcStart: 1000, qpcFrequency: freq }],
      gaps: []
    };
    const merged = mergeMeetingTimeline({
      sessionId: "s1",
      microphoneSidecar: micSidecar,
      systemSidecar: sysSidecar,
      microphoneSentences: [{ text: "我先说", beginMs: 100, endMs: 400 }],
      systemSentences: [{ text: "对方B", beginMs: 100, endMs: 300, speakerId: 2 }]
    });
    assert.equal(merged.items[0].speakerId, SELF_SPEAKER_ID);
    assert.equal(merged.items[1].speakerId, "remote_2");
    assert.equal(merged.policy.keepOverlaps, true);
  });

  await test("export mono pcm16 input remains mono", async () => {
    await withTempDir(async (dir) => {
      const trackDir = path.join(dir, "audio", "microphone");
      const c1 = writePcm16Mono(40, 1234);
      await seedTrack(trackDir, {
        kind: "pcm16",
        channels: 1,
        sampleRate: 16000,
        chunks: [c1],
        track: "microphone",
        role: "self"
      });
      const result = await exportTrackArchive({
        trackDir,
        outputDir: path.join(dir, "archive")
      });
      const wav = readWavPcm16Mono(result.wavPath);
      assert.equal(wav.pcm.readInt16LE(0), 1234);
      assert.equal(result.mono, true);
      const h = await sha256File(result.wavPath);
      assert.equal(h, result.contentSha256);
    });
  });

  await test("export: track/role from manifest; no microphone default for system", async () => {
    await withTempDir(async (dir) => {
      const trackDir = path.join(dir, "audio", "system");
      const c1 = writePcm16Mono(20, 100);
      await seedTrack(trackDir, {
        kind: "pcm16",
        channels: 1,
        sampleRate: 16000,
        chunks: [c1],
        track: "system",
        role: "remote_mix_for_diarization"
      });
      // Omit track/role — must come from manifest
      const result = await exportTrackArchive({
        trackDir,
        outputDir: path.join(dir, "archive")
      });
      assert.equal(result.track, "system");
      assert.equal(result.role, "remote_mix_for_diarization");
      assert.ok(result.wavPath.includes("system.mono"));

      // Explicit override still wins
      const over = await exportTrackArchive({
        trackDir,
        track: "custom",
        role: "override",
        outputDir: path.join(dir, "archive2"),
        artifactBaseName: "custom.mono"
      });
      assert.equal(over.track, "custom");
      assert.equal(over.role, "override");
    });
  });

  await test("export: deterministic sidecar deep equality on re-export", async () => {
    await withTempDir(async (dir) => {
      const trackDir = path.join(dir, "audio", "microphone");
      await seedTrack(trackDir, {
        kind: "pcm16",
        channels: 1,
        sampleRate: 16000,
        chunks: [writePcm16Mono(30, 42)],
        holes: [{ beginQpc: 100, endQpc: 200, pauseGen: 1, discardedFrames: 10 }],
        track: "microphone",
        role: "self"
      });
      const outDir = path.join(dir, "archive");
      const r1 = await exportTrackArchive({ trackDir, outputDir: outDir, artifactBaseName: "mic.mono" });
      const s1 = JSON.parse(fs.readFileSync(r1.sidecarPath, "utf8"));
      const r2 = await exportTrackArchive({ trackDir, outputDir: outDir, artifactBaseName: "mic.mono" });
      const s2 = JSON.parse(fs.readFileSync(r2.sidecarPath, "utf8"));
      assert.equal(s1.createdAt, undefined);
      assert.deepEqual(s1, s2);
      assert.equal(r1.contentSha256, r2.contentSha256);
    });
  });

  await test("verifyArchiveIntegrity: ok and tampered wav", async () => {
    await withTempDir(async (dir) => {
      const trackDir = path.join(dir, "audio", "microphone");
      await seedTrack(trackDir, {
        kind: "pcm16",
        channels: 1,
        sampleRate: 16000,
        chunks: [writePcm16Mono(16, 7)],
        track: "microphone",
        role: "self"
      });
      const result = await exportTrackArchive({
        trackDir,
        outputDir: path.join(dir, "archive")
      });
      const ok = await verifyArchiveIntegrity({
        wavPath: result.wavPath,
        sidecarPath: result.sidecarPath
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.contentSha256, result.contentSha256);

      // Tamper WAV
      const buf = fs.readFileSync(result.wavPath);
      buf[buf.length - 1] ^= 0xff;
      fs.writeFileSync(result.wavPath, buf);
      await assert.rejects(
        () =>
          verifyArchiveIntegrity({
            wavPath: result.wavPath,
            sidecarPath: result.sidecarPath
          }),
        (err) => err.code === "content_sha256_mismatch"
      );
    });
  });

  await test("fun-asr: downloadJson timeout vs caller abort; no Authorization", async () => {
    let downloadCalls = 0;
    const hanging = new Map();
    const fetchImpl = async (url, init) => {
      if (String(url).includes("result-hang.json")) {
        downloadCalls += 1;
        // Assert no Authorization on result download
        assert.equal(init?.headers?.Authorization, undefined);
        return new Promise((resolve, reject) => {
          const signal = init?.signal;
          hanging.set(downloadCalls, { resolve, reject });
          if (signal) {
            signal.addEventListener(
              "abort",
              () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              },
              { once: true }
            );
          }
        });
      }
      if (String(url).includes("/transcription")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ output: { task_id: "t1" } })
        };
      }
      if (String(url).includes("/tasks/")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              output: {
                task_status: "SUCCEEDED",
                results: [
                  {
                    subtask_status: "SUCCEEDED",
                    transcription_url: "https://example.com/result-hang.json"
                  }
                ]
              }
            })
        };
      }
      throw new Error(`unexpected ${url}`);
    };

    // Timeout path: short requestTimeoutMs, fixed backoff 0
    const providerTimeout = createFunAsrProvider({
      apiKey: "test-key-not-real",
      cleanTranscript: (t) => t,
      getOptions: () => ({}),
      fetchImpl,
      requestTimeoutMs: 30,
      meetingPollTimeoutMs: 5000,
      backoffMsImpl: () => 0
    });
    await assert.rejects(
      () =>
        providerTimeout.transcribeMeetingStructured({
          audioUrl: "https://cdn.example.com/a.wav",
          mono: true
        }),
      (err) => err.code === "request_timeout"
    );
    assert.ok(downloadCalls >= 2, "timeout should retry");

    // Caller abort: abort during download, no retry storm
    downloadCalls = 0;
    const ac = new AbortController();
    const fetchAbort = async (url, init) => {
      if (String(url).includes("result-hang.json")) {
        downloadCalls += 1;
        assert.equal(init?.headers?.Authorization, undefined);
        ac.abort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      if (String(url).includes("/transcription")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ output: { task_id: "t2" } })
        };
      }
      if (String(url).includes("/tasks/")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              output: {
                task_status: "SUCCEEDED",
                results: [
                  {
                    subtask_status: "SUCCEEDED",
                    transcription_url: "https://example.com/result-hang.json"
                  }
                ]
              }
            })
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const providerAbort = createFunAsrProvider({
      apiKey: "test-key-not-real",
      cleanTranscript: (t) => t,
      getOptions: () => ({}),
      fetchImpl: fetchAbort,
      requestTimeoutMs: 5000,
      backoffMsImpl: () => 0
    });
    await assert.rejects(
      () =>
        providerAbort.transcribeMeetingStructured({
          audioUrl: "https://cdn.example.com/b.wav",
          signal: ac.signal,
          mono: true
        }),
      (err) => err.code === "aborted"
    );
    assert.ok(downloadCalls <= 2);
  });

  console.log(`\n${passed} tests passed`);
}

run().catch(() => {
  process.exitCode = 1;
});
