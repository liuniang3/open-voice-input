"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const media = require("../src/meeting/playback/media-token");
const meetingPaths = require("../src/meeting/paths");
const { buildPlaybackHeaders } = require("../src/meeting/playback/http-range");
const { wavHeader } = require("../src/meeting/realtime/audio");
const root = path.resolve(__dirname, "..");
let passed = 0;
async function test(name, run) { media.clearAllPlaybackTokens(); await run(); passed++; console.log(`ok - ${name}`); }

async function fixture() {
  const dir = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-playback-safe-")));
  const sessionsRoot = path.join(dir, "meeting-sessions");
  const sessionId = "playback-test";
  const sessionDir = path.join(sessionsRoot, sessionId);
  await fsp.mkdir(path.join(sessionDir, "archive"), { recursive: true });
  await fsp.mkdir(path.join(sessionDir, "realtime"), { recursive: true });
  const bytes = Buffer.concat([wavHeader(8), Buffer.alloc(16, 42)]);
  const put = async relative => { const file = path.join(sessionDir, relative); await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, bytes); return file; };
  return { dir, sessionsRoot, sessionId, sessionDir, bytes, put,
    issue: absPath => media.issuePlaybackToken({ sessionsRoot, sessionId, absPath }) };
}

function ipcHarness(f, platform) {
  const handlers = new Map();
  const source = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const fields = source.slice(source.indexOf("function pickMeetingFields("), source.indexOf("function registerLiveIpc("));
  const handler = source.slice(source.indexOf('ipcMain.handle("meeting:playback:token"'), source.indexOf("// registerSchemesAsPrivileged must run"));
  const context = vm.createContext({ path, fs: fsp, fssync: fs, meetingPaths, meetingMediaToken: media,
    buildPlaybackHeaders, Readable, URL, Response, platform,
    app: { getPath: () => f.dir }, getMeetingCapture: () => ({ store: { readSession: async id => id === f.sessionId
      ? { sessionDir: f.sessionDir, session: { id: f.sessionId } } : null } }),
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    protocol: { handle: (_scheme, fn) => handlers.set("protocol", fn) },
    meetingIpcError: error => ({ ok: false, error: { code: error.code } }), logEvent: () => {}
  });
  vm.runInContext(`${fields}\n${handler}\nattachMeetingPlaybackProtocolHandler();`, context);
  return { invoke: payload => handlers.get("meeting:playback:token")({}, payload),
    serve: (url, method = "GET", range) => handlers.get("protocol")({ url, method,
      headers: new Headers(range ? { range } : {}) }) };
}

async function main() {
  await test("tokens allow archive WAVs and exactly two complete realtime WAV names", async () => {
    const f = await fixture();
    for (const relative of ["archive/microphone.mono.wav", "archive/system.mono.wav", "archive/nested/old.wav",
      "realtime/microphone-complete.wav", "realtime/system-complete.wav"]) {
      const file = await f.put(relative);
      const issued = f.issue(file);
      assert.equal(media.resolvePlaybackToken(issued.token).absPath, fs.realpathSync.native(file));
      assert.match(issued.url, /^mimo-meeting:\/\/play\/[a-f0-9]{48}$/);
    }
    for (const relative of ["realtime/arbitrary.wav", "realtime/segment-1.wav", "realtime/nested/microphone-complete.wav",
      "realtime/microphone-complete.wav.json", "archive/private.json", "audio/microphone-complete.wav"]) {
      assert.throws(() => f.issue(path.join(f.sessionDir, relative)), { code: "playback_denied" });
    }
    assert.throws(() => f.issue(path.join(f.dir, "outside.wav")), { code: "playback_denied" });
    assert.throws(() => f.issue(`${f.sessionDir}${path.sep}realtime${path.sep}..${path.sep}archive${path.sep}old.wav`), { code: "playback_denied" });
    for (const sessionId of ["", ".", "..", "../playback-test", "playback-test\n", `${f.sessionId}/../${f.sessionId}`]) {
      assert.throws(() => media.issuePlaybackToken({ sessionsRoot: f.sessionsRoot, sessionId,
        absPath: path.join(f.sessionDir, "realtime/microphone-complete.wav") }), { code: "playback_denied" });
    }
    assert.throws(() => f.issue(path.join(f.sessionDir, "archive/audio.wav:private.wav")), { code: "playback_denied" });
  });

  await test("token resolution rejects replacement files and returns an immutable entry copy", async () => {
    const f = await fixture();
    const wav = await f.put("realtime/microphone-complete.wav");
    const issued = f.issue(wav);
    media.resolvePlaybackToken(issued.token).absPath = path.join(f.dir, "outside.wav");
    assert.equal(media.resolvePlaybackToken(issued.token).absPath, fs.realpathSync.native(wav));
    await fsp.rename(wav, `${wav}.preserved`);
    await fsp.writeFile(wav, f.bytes);
    assert.throws(() => media.resolvePlaybackToken(issued.token), { code: "playback_denied" });
    assert.throws(() => media.resolvePlaybackToken(issued.token), { code: "playback_token_invalid" });
  });

  await test("issuance and resolution reject directory symlinks/junctions inside or outside the session", async () => {
    const f = await fixture();
    const wav = await f.put("realtime/microphone-complete.wav");
    const issued = f.issue(wav);
    await fsp.rename(path.join(f.sessionDir, "realtime"), path.join(f.sessionDir, "preserved-realtime"));
    await fsp.symlink(path.join(f.sessionDir, "preserved-realtime"), path.join(f.sessionDir, "realtime"),
      process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => f.issue(wav), { code: "playback_denied" });
    assert.throws(() => media.resolvePlaybackToken(issued.token), { code: "playback_denied" });
    const outside = path.join(f.dir, "outside");
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, "outside.wav"), f.bytes);
    await fsp.symlink(outside, path.join(f.sessionDir, "archive/alias"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => f.issue(path.join(f.sessionDir, "archive/alias/outside.wav")), { code: "playback_denied" });
    await fsp.symlink(f.sessionDir, path.join(f.sessionsRoot, "alias-session"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => media.issuePlaybackToken({ sessionsRoot: f.sessionsRoot, sessionId: "alias-session",
      absPath: path.join(f.sessionsRoot, "alias-session/archive/alias/outside.wav") }), { code: "playback_denied" });
  });

  await test("leaf symlinks are denied when the host permits creating them", async () => {
    const f = await fixture();
    const target = await f.put("archive/preserved.wav");
    const wav = path.join(f.sessionDir, "realtime/system-complete.wav");
    try { await fsp.symlink(target, wav, "file"); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
        console.log("SKIP leaf symlink creation: Windows host lacks permission; junction races remain covered"); return;
      }
      throw error;
    }
    assert.throws(() => f.issue(wav), { code: "playback_denied" });
  });

  await test("a directory swap between validation and open is denied and closes the opened descriptor", async () => {
    const f = await fixture();
    const wav = await f.put("realtime/microphone-complete.wav");
    const outside = path.join(f.dir, "outside");
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, "microphone-complete.wav"), Buffer.from("unrelated bytes"));
    const issued = f.issue(wav);
    const originalOpen = fs.openSync;
    let opened;
    fs.openSync = (file, ...args) => {
      if (file === wav && typeof args[0] === "number") {
        fs.renameSync(path.join(f.sessionDir, "realtime"), path.join(f.sessionDir, "preserved-realtime"));
        fs.symlinkSync(outside, path.join(f.sessionDir, "realtime"), process.platform === "win32" ? "junction" : "dir");
      }
      opened = originalOpen(file, ...args); return opened;
    };
    try { assert.throws(() => media.openPlaybackToken(issued.token), { code: "playback_denied" }); }
    finally { fs.openSync = originalOpen; }
    assert.throws(() => fs.fstatSync(opened), { code: "EBADF" });
  });

  await test("post-open path revalidation denies an in-root alias even when the inode matches", async () => {
    const f = await fixture();
    const wav = await f.put("realtime/microphone-complete.wav");
    const issued = f.issue(wav);
    const originalOpen = fs.openSync;
    let opened;
    fs.openSync = (file, ...args) => {
      const descriptor = originalOpen(file, ...args);
      if (file !== wav || typeof args[0] !== "number") return descriptor;
      opened = descriptor;
      const preserved = path.join(f.sessionDir, "preserved-realtime");
      try {
        fs.renameSync(path.join(f.sessionDir, "realtime"), preserved);
        fs.symlinkSync(preserved, path.join(f.sessionDir, "realtime"), process.platform === "win32" ? "junction" : "dir");
      } catch (error) { fs.closeSync(descriptor); throw error; }
      return opened;
    };
    try { assert.throws(() => media.openPlaybackToken(issued.token), { code: "playback_denied" }); }
    finally { fs.openSync = originalOpen; }
    assert.throws(() => fs.fstatSync(opened), { code: "EBADF" });
  });

  for (const platform of ["win32", "darwin"]) {
    await test(`${platform} IPC prefers archive and falls back to complete realtime tracks`, async () => {
      const f = await fixture();
      const realtime = await f.put("realtime/microphone-complete.wav");
      await f.put("realtime/system-complete.wav");
      const h = ipcHarness(f, platform);
      const payload = { sessionId: f.sessionId, track: "microphone", path: path.join(f.dir, "outside.wav") };
      const fallback = await h.invoke(payload);
      assert.equal(fallback.ok, true); assert.equal(fallback.track, "microphone");
      assert.equal(media.resolvePlaybackToken(fallback.url.split("/").at(-1)).absPath, fs.realpathSync.native(realtime));
      const archive = await f.put("archive/microphone.mono.wav");
      const preferred = await h.invoke(payload);
      assert.equal(media.resolvePlaybackToken(preferred.url.split("/").at(-1)).absPath, fs.realpathSync.native(archive));
      const system = await h.invoke({ sessionId: f.sessionId, track: "system" });
      assert.equal(system.ok, true); assert.equal(system.track, "system");
      const res = await h.serve(system.url, "GET", "bytes=0-9");
      assert.equal(res.status, 206);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), f.bytes.subarray(0, 10));
      assert.equal((await h.serve(system.url, "HEAD")).status, 200);
      assert.equal((await h.serve(system.url, "GET", "bytes=999-1000")).status, 416);
      assert.equal((await h.invoke({ sessionId: "missing" })).error.code, "session_not_found");
    });
  }

  await test("IPC refuses arbitrary realtime files and unsafe complete-file aliases", async () => {
    const f = await fixture();
    await f.put("realtime/random.wav");
    const h = ipcHarness(f);
    assert.equal((await h.invoke({ sessionId: f.sessionId })).error.code, "archive_missing");
    const outside = path.join(f.dir, "outside");
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, "microphone-complete.wav"), f.bytes);
    await fsp.rename(path.join(f.sessionDir, "realtime"), path.join(f.sessionDir, "preserved-realtime"));
    await fsp.symlink(outside, path.join(f.sessionDir, "realtime"), process.platform === "win32" ? "junction" : "dir");
    assert.equal((await h.invoke({ sessionId: f.sessionId })).error.code, "archive_missing");
  });

  await test("protocol revalidates tokens and serves the opened file instead of reopening a changed path", async () => {
    const f = await fixture();
    const wav = await f.put("realtime/microphone-complete.wav");
    const h = ipcHarness(f);
    const issued = await h.invoke({ sessionId: f.sessionId });
    const originalOpen = media.openPlaybackToken;
    media.openPlaybackToken = token => {
      const opened = originalOpen(token);
      fs.renameSync(wav, `${wav}.preserved`);
      fs.writeFileSync(wav, Buffer.from("unrelated bytes"));
      return opened;
    };
    let response;
    try { response = await h.serve(issued.url); }
    finally { media.openPlaybackToken = originalOpen; }
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
    assert.equal((await h.serve(issued.url)).status, 403);
    assert.equal((await h.serve("mimo-meeting://play/invalid")).status, 403);
  });

  await test("token count, revocation and expiry remain bounded", async () => {
    const f = await fixture();
    const wav = await f.put("archive/microphone.mono.wav");
    const oldest = f.issue(wav);
    for (let i = 0; i < 64; i++) f.issue(wav);
    assert.throws(() => media.resolvePlaybackToken(oldest.token), { code: "playback_token_invalid" });
    const revoked = f.issue(wav); media.revokePlaybackToken(revoked.token);
    assert.throws(() => media.resolvePlaybackToken(revoked.token), { code: "playback_token_invalid" });
    const expiring = f.issue(wav);
    const originalNow = Date.now;
    Date.now = () => expiring.expiresAt + 1;
    try { assert.throws(() => media.resolvePlaybackToken(expiring.token), { code: "playback_token_invalid" }); }
    finally { Date.now = originalNow; }
  });
  console.log(`${passed} playback token tests passed`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => media.clearAllPlaybackTokens());
