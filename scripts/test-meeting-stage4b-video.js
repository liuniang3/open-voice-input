"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { buildExtractArgs, runFfmpegExtract, scrubFfmpegText, DEFAULT_TIMEOUT_MS } = require("../src/meeting/import/ffmpeg-runner");
const { resolveFfmpegPath } = require("../src/meeting/import/resolve-ffmpeg");
const { importMediaToSession, assertSupportedMedia, MEDIA_EXTS } = require("../src/meeting/import/import-media");
const { createSessionStore } = require("../src/meeting/session-store");
const { createMeetingSessionProcessor } = require("../src/meeting/processing/session-processor");
const { verifyArchiveIntegrity } = require("../src/meeting/archive/export-track-wav");
const { probeSessionArtifacts } = require("../src/meeting/import/import-job");
const { IMPORT_SESSION_ORIGIN_QPC, IMPORT_QPC_FREQUENCY } = require("../src/meeting/import/import-wav");
const ui = require("../src/renderer/meeting-ui.js");

const ROOT = path.resolve(__dirname, "..");
const PREPARED = path.join(ROOT, "native", "ffmpeg", "ffmpeg.exe");

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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mimo-4bv-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function ensurePreparedFfmpeg() {
  if (fs.existsSync(PREPARED)) return PREPARED;
  const prep = spawnSync(process.execPath, [path.join(ROOT, "scripts", "prepare-ffmpeg.js")], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  });
  if (prep.status !== 0) {
    throw new Error(`prepare-ffmpeg failed: ${prep.stderr || prep.stdout}`);
  }
  assert.ok(fs.existsSync(PREPARED), "prepared ffmpeg missing after prepare");
  return PREPARED;
}

function shaFile(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

async function main() {
  await test("ffmpeg args + 6h default timeout + scrub", () => {
    const args = buildExtractArgs({ inputPath: "IN", outputPath: "OUT" });
    assert.ok(args.includes("-nostdin"));
    assert.ok(args.includes("0:a:0"));
    assert.equal(args[args.indexOf("-ar") + 1], "16000");
    assert.ok(DEFAULT_TIMEOUT_MS >= 6 * 60 * 60 * 1000);
    assert.ok(!scrubFfmpegText("err C:\\Users\\x\\a.mp4").includes("Users"));
  });

  await test("resolve ffmpeg: dev prepared path", () => {
    ensurePreparedFfmpeg();
    const p = resolveFfmpegPath({ isPackaged: false, appRoot: ROOT });
    assert.ok(fs.existsSync(p));
  });

  await test("media extensions allowlist + 8GiB guard", () => {
    assert.ok(MEDIA_EXTS.has("mp4"));
    assert.throws(() => assertSupportedMedia("x.xyz", 100), /unsupported/i);
    assert.throws(() => assertSupportedMedia("x.mp3", 9 * 1024 * 1024 * 1024), /8 GiB|too_large/i);
  });

  await test("ffmpeg abort kills process", async () => {
    const bin = ensurePreparedFfmpeg();
    await withTempDir(async (dir) => {
      const wav = path.join(dir, "s.wav");
      const gen = spawnSync(
        bin,
        ["-nostdin", "-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "1", wav],
        { windowsHide: true, encoding: "utf8", timeout: 30000 }
      );
      assert.equal(gen.status, 0, gen.stderr || "gen failed");
      const out = path.join(dir, "o.wav");
      const ac = new AbortController();
      const p = runFfmpegExtract({
        ffmpegPath: bin,
        inputPath: wav,
        outputPath: out,
        signal: ac.signal,
        timeoutMs: 60000
      });
      ac.abort();
      await assert.rejects(p, (e) => e.code === "aborted" || e.code === "ffmpeg_failed");
    });
  });

  const bin = ensurePreparedFfmpeg();

  await test("real mp3 import: archive + no extract quarantine leftover", async () => {
    await withTempDir(async (dir) => {
      const mp3 = path.join(dir, "clip.mp3");
      const gen = spawnSync(
        bin,
        [
          "-nostdin",
          "-hide_banner",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=0.35",
          "-ac",
          "1",
          "-ar",
          "22050",
          mp3
        ],
        { windowsHide: true, encoding: "utf8", timeout: 30000 }
      );
      assert.equal(gen.status, 0, gen.stderr || "mp3 gen failed");
      const srcSha = shaFile(mp3);
      const store = createSessionStore({ sessionsRoot: path.join(dir, "sessions") });
      const created = await store.createSession({ title: "mp3" });
      const phases = [];
      const result = await importMediaToSession({
        sourcePath: mp3,
        sessionDir: created.sessionDir,
        sessionId: created.session.id,
        title: "mp3",
        track: "microphone",
        ffmpegPath: bin,
        appRoot: ROOT,
        onProgress: (p) => phases.push(p.phase)
      });
      assert.equal(result.ok, true);
      assert.ok(fs.existsSync(mp3));
      assert.equal(shaFile(mp3), srcSha);
      assert.ok(phases.includes("copy"));
      assert.ok(phases.includes("extract"));
      assert.ok(phases.includes("commit"));
      await verifyArchiveIntegrity({
        wavPath: result._paths.wavPath,
        sidecarPath: result._paths.sidecarPath
      });
      // Success: media copy + live archive; no extract*.wav.part in quarantine
      const qDir = path.join(created.sessionDir, "import", "quarantine");
      if (fs.existsSync(qDir)) {
        const names = await fsp.readdir(qDir);
        assert.ok(!names.some((n) => /extract.*\.wav\.part/i.test(n)), names.join(","));
      }
      const importDir = path.join(created.sessionDir, "import");
      const leftovers = (await fsp.readdir(importDir)).filter((n) => n.includes("extract") && n.endsWith(".part"));
      assert.equal(leftovers.length, 0, leftovers.join(","));
    });
  });

  await test("real short mp4 (mpeg4+aac) → system archive + process reuse + source kept", async () => {
    await withTempDir(async (dir) => {
      const mp4 = path.join(dir, "clip.mp4");
      // video + aac audio; import maps 0:a:0
      const gen = spawnSync(
        bin,
        [
          "-nostdin",
          "-hide_banner",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=160x120:d=0.4",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=880:duration=0.4",
          "-c:v",
          "mpeg4",
          "-c:a",
          "aac",
          "-shortest",
          mp4
        ],
        { windowsHide: true, encoding: "utf8", timeout: 60000 }
      );
      assert.equal(gen.status, 0, gen.stderr || "mp4 gen failed");
      assert.ok(fs.existsSync(mp4));
      const srcSha = shaFile(mp4);

      const store = createSessionStore({ sessionsRoot: path.join(dir, "sessions") });
      const created = await store.createSession({ title: "mp4" });
      const result = await importMediaToSession({
        sourcePath: mp4,
        sessionDir: created.sessionDir,
        sessionId: created.session.id,
        title: "mp4",
        track: "system",
        role: "remote_unknown",
        ffmpegPath: bin,
        appRoot: ROOT
      });
      assert.equal(result.ok, true);
      assert.equal(result.archive.track, "system");
      assert.equal(result.import.mediaKind, "video");
      assert.equal(result.import.extension, "mp4");
      assert.ok(fs.existsSync(mp4));
      assert.equal(shaFile(mp4), srcSha);
      assert.ok(!JSON.stringify(result.sessionPatch).includes(dir));

      const sc = JSON.parse(fs.readFileSync(result._paths.sidecarPath, "utf8"));
      assert.equal(sc.sessionOriginQpc, IMPORT_SESSION_ORIGIN_QPC);
      assert.equal(sc.qpcFrequency, IMPORT_QPC_FREQUENCY);
      assert.equal(sc.track, "system");
      await verifyArchiveIntegrity({
        wavPath: result._paths.wavPath,
        sidecarPath: result._paths.sidecarPath
      });

      const flags = await probeSessionArtifacts(created.sessionDir, fsp);
      assert.equal(flags.hasArchive, true);
      assert.ok(flags.archiveTracks.includes("system"));

      await store.updateSession(created.session.id, result.sessionPatch);
      const capture = {
        store,
        getLifecycle: () => ({ status: "idle", sessionId: null }),
        listSessions: () => store.listSessions()
      };
      let asr = 0;
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
          asr += 1;
          return { text: "mp4 audio" };
        }
      });
      await processor.processSession(created.session.id);
      assert.ok(asr >= 1);
    });
  });

  await test("controls + package single binary / notices resources declared", () => {
    assert.equal(
      ui.canGenerateRaw("idle", "idle", {
        hasSession: true,
        source: "import",
        sessionStatus: "stopped",
        hasArchive: true
      }),
      true
    );
    ensurePreparedFfmpeg();
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.devDependencies["ffmpeg-static"], "5.3.0");
    assert.equal(pkg.dependencies["ffmpeg-static"], undefined);
    const resources = pkg.build?.extraResources || [];
    assert.ok(resources.some((r) => String(r.to || "").replace(/\\/g, "/") === "native/ffmpeg.exe"));
    assert.ok(resources.some((r) => String(r.to || "").includes("THIRD_PARTY_NOTICES")));
    assert.ok(resources.some((r) => String(r.to || "").includes("FFMPEG-GPL-3.0")));
    assert.ok(pkg.build.files.some((f) => String(f).includes("ffmpeg-static")));
    assert.ok(fs.existsSync(PREPARED));
    // only one prepared binary path under native/ffmpeg
    const ffDir = path.join(ROOT, "native", "ffmpeg");
    const exes = fs.readdirSync(ffDir).filter((n) => n.toLowerCase().endsWith(".exe"));
    assert.equal(exes.length, 1);
    assert.ok(fs.existsSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md")));
    assert.ok(fs.existsSync(path.join(ROOT, "node_modules", "ffmpeg-static", "LICENSE")));
  });

  console.log(`\n${passed} tests passed`);
}

main();
