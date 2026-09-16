"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawn, spawnSync } = require("node:child_process");
const { MACOS_REQUIRED_CAPABILITIES, REQUIRED_CAPABILITIES, requiredCapabilitiesForPlatform } = require("../src/meeting/constants");
const { assertHelloCompatible } = require("../src/meeting/protocol");
const { resolveHelperPath, assertPathInsideRoot, normalizePathForCompare } = require("../src/meeting/paths");
const { resolveFfmpegPath } = require("../src/meeting/import/resolve-ffmpeg");
const { createAudioCaptureSupervisor } = require("../src/meeting/supervisor");
const { createMacOSUtilities } = require("../src/platform/macos");
const { resolveL0SampleEncoding } = require("../src/meeting/archive/l0-format");

const ROOT = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-platform-"));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }
const hello = capabilities => ({ type: "hello", name: "audio-capture-helper", version: "0.2.0", protocol_version: 1, capabilities });

function nativeJSON(args, input = "") {
  const helper = resolveHelperPath({ appRoot: ROOT, platform: "darwin" });
  const result = spawnSync(helper, args, { input, encoding: "utf8", timeout: 12000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function run() {
  await test("native capability selection never claims WASAPI on macOS", () => {
    assert.deepEqual(requiredCapabilitiesForPlatform("win32"), REQUIRED_CAPABILITIES);
    assert.deepEqual(requiredCapabilitiesForPlatform("darwin"), MACOS_REQUIRED_CAPABILITIES);
    assert.equal(assertHelloCompatible(hello(MACOS_REQUIRED_CAPABILITIES), { platform: "darwin" }).ok, true);
    assert.equal(assertHelloCompatible(hello(REQUIRED_CAPABILITIES), { platform: "darwin" }).ok, false);
    assert.equal(assertHelloCompatible(hello(MACOS_REQUIRED_CAPABILITIES), { platform: "win32" }).ok, false);
    assert.ok(!MACOS_REQUIRED_CAPABILITIES.some(cap => /qpc|iaudioclock|loopback_shared/.test(cap)));
  });

  await test("helper/resource paths select executable suffix and platform build", () => {
    assert.equal(resolveHelperPath({ platform: "darwin", isPackaged: true, resourcesPath: temp }), path.join(temp, "native", "audio-capture-helper"));
    assert.equal(resolveHelperPath({ platform: "win32", isPackaged: true, resourcesPath: temp }), path.join(temp, "native", "audio-capture-helper.exe"));
    assert.match(resolveHelperPath({ platform: "darwin", appRoot: ROOT }), /macos-audio-capture-helper/);
    assert.throws(() => resolveHelperPath({ platform: "linux", appRoot: ROOT }), { code: "platform_unsupported" });
    fs.mkdirSync(path.join(temp, "native"));
    for (const name of ["ffmpeg", "ffmpeg.exe"]) fs.writeFileSync(path.join(temp, "native", name), "fixture", { flag: "wx" });
    for (const platform of ["darwin", "win32"]) {
      const result = resolveFfmpegPath({ platform, isPackaged: true, resourcesPath: temp });
      assert.equal(path.basename(result), platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    }
  });

  await test("POSIX normalization preserves case; containment rejects siblings and symlinks", () => {
    const upper = path.join(temp, "CaseSensitive");
    assert.notEqual(normalizePathForCompare(upper, "darwin"), normalizePathForCompare(upper.toLowerCase(), "darwin"));
    const root = path.join(temp, "root");
    const outside = path.join(temp, "root-other");
    fs.mkdirSync(root); fs.mkdirSync(outside);
    assert.equal(assertPathInsideRoot(root, path.join(root, "new")), path.join(root, "new"));
    assert.throws(() => assertPathInsideRoot(root, outside), { code: "path_denied" });
    assert.throws(() => assertPathInsideRoot(root, "../outside"), { code: "path_denied" });
    fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => assertPathInsideRoot(root, path.join(root, "escape", "new")), { code: "path_denied" });
  });

  await test("mac utility interface uses native PID/keyboard helper, validates input and permissions", async () => {
    let trusted = true;
    let opened = "";
    let foregroundArgs;
    let pasteArgs;
    const utilities = createMacOSUtilities({ platform: "darwin", helperPath: "/fixture/helper",
      electron: { systemPreferences: { getMediaAccessStatus: kind => kind === "screen" ? "denied" : "granted",
        isTrustedAccessibilityClient: () => trusted, askForMediaAccess: async kind => kind === "microphone" },
      shell: { openExternal: async url => { opened = url; } } },
      execFileSyncImpl: (file, args) => { foregroundArgs = args; return "1234\n"; },
      execFileImpl: (file, args, options, callback) => { pasteArgs = args; callback(null, "", ""); } });
    assert.equal(utilities.getForegroundApp(), "1234");
    assert.deepEqual(foregroundArgs, ["--foreground-app"]);
    assert.deepEqual(utilities.getPermissionStatus(), { microphone: "granted", screen: "denied", accessibility: "granted" });
    assert.equal(await utilities.requestMicrophoneAccess(), true);
    assert.equal(await utilities.pasteToApp("1234"), true);
    assert.deepEqual(pasteArgs, ["--paste-to-app", "1234"]);
    await assert.rejects(utilities.pasteToApp("1;do shell script"), { code: "invalid_pid" });
    trusted = false;
    await assert.rejects(utilities.pasteToApp("1234"), { code: "accessibility_denied" });
    await utilities.openPermissionSettings("screen");
    assert.equal(opened, "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    await assert.rejects(utilities.openPermissionSettings("https://invalid"), { code: "invalid_permission" });
    assert.throws(() => createMacOSUtilities({ platform: "win32" }).getPermissionStatus(), { code: "platform_unsupported" });
  });

  await test("screen consent requests run in the host identity with a native fallback", async () => {
    let options;
    const host = createMacOSUtilities({ platform: "darwin", electron: {
      systemPreferences: { getMediaAccessStatus: () => "not-determined" },
      desktopCapturer: { getSources: async value => { options = value; return [{ id: "screen:0" }]; } }
    } });
    assert.equal(await host.requestScreenAccess(), true);
    assert.deepEqual(options, { types: ["screen"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const fallback = createMacOSUtilities({ platform: "darwin", helperPath: "/fixture/helper",
      electron: { systemPreferences: { getMediaAccessStatus: () => "denied" } },
      execFileImpl: (file, args, opts, callback) => { assert.deepEqual(args, ["--request-screen-access"]); callback(null, "false\n"); } });
    assert.equal(await fallback.requestScreenAccess(), false);
  });

  await test("existing supervisor facade accepts Darwin hello and JSONL commands", async () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.kill = () => { proc.emit("exit", 0, null); };
    const commands = [];
    proc.stdin.on("data", data => {
      for (const line of String(data).trim().split("\n")) {
        const command = JSON.parse(line); commands.push(command);
        proc.stdout.write(`${JSON.stringify({ type: "ack", id: command.id, command: command.cmd })}\n`);
        proc.stdout.write(`${JSON.stringify({ type: "result", id: command.id, result: { ok: true, data: {} } })}\n`);
      }
    });
    const sup = createAudioCaptureSupervisor({ platform: "darwin", helperPath: __filename,
      sessionRoot: temp, spawnImpl: () => { setImmediate(() => proc.stdout.write(`${JSON.stringify(hello(MACOS_REQUIRED_CAPABILITIES))}\n`)); return proc; } });
    await sup.start(); await sup.configure();
    await sup.startDualCapture({ sessionId: "test", microphoneOutputDir: path.join(temp, "mic"), systemOutputDir: path.join(temp, "sys") });
    assert.equal(sup.getState().activeCaptureMode, "dual");
    await sup.stopCapture(); await sup.shutdown();
    assert.deepEqual(commands.map(item => item.cmd), ["configure", "start", "stop", "shutdown"]);
    assert.equal(commands[1].capture_mode, "dual");
  });

  await test("packaging separates platform binaries and retains realtime script entries", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.scripts["test:meeting:live"], "node scripts/test-meeting-realtime.js");
    assert.equal(pkg.scripts["test:meeting:live:ui"], "node scripts/test-meeting-live-ui.js");
    assert.ok(!pkg.build.extraResources.some(item => /\.exe|\.ps1/.test(item.from)));
    assert.ok(pkg.build.win.extraResources.some(item => item.to === "native/audio-capture-helper.exe"));
    assert.ok(pkg.build.mac.extraResources.some(item => item.to === "native/audio-capture-helper"));
    assert.equal(pkg.build.mac.minimumSystemVersion, "13.0");
    assert.ok(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription);
    const source = fs.readFileSync(path.join(ROOT, "native/macos-audio-capture-helper/Sources/Archive.swift"), "utf8");
    for (const field of ["qpcStart", "qpcEnd", "sessionOriginQpc", "qpcFrequency", "sessionStartMs", "sessionEndMs", "clockSource"]) assert.ok(source.includes(`"${field}"`));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[""].version, pkg.version);
    assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
    assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
  });

  if (process.platform === "darwin") {
    await test("real Swift helper hello/ack/result and parent EOF exit (no capture permission)", () => {
      const messages = nativeJSON([], '{"cmd":"ping","id":"probe"}\n');
      assert.equal(assertHelloCompatible(messages.find(item => item.type === "hello")).ok, true);
      assert.ok(messages.some(item => item.type === "ack" && item.id === "probe"));
      assert.ok(messages.some(item => item.type === "result" && item.id === "probe" && item.result.ok));
    });
    await test("Swift durable writer self-test is readable by existing L0 schema (not a hardware test)", () => {
      const directory = path.join(temp, "native-writer");
      const messages = nativeJSON(["--self-test-archive", directory]);
      assert.equal(messages[0].result.ok, true);
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
      assert.equal(manifest.recording, false); assert.equal(manifest.state, "finished");
      assert.equal(manifest.totalFrames, 225);
      assert.equal(resolveL0SampleEncoding(manifest.actualL0Format).kind, "float32");
      const entries = fs.readFileSync(path.join(directory, "index.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.deepEqual(entries.map(item => item.frames), [100, 100, 25]);
      assert.equal(entries[0].frameStart, 0);
      assert.ok(Math.abs(entries[0].sessionStartMs - 250) < 0.001);
      assert.ok(Math.abs(entries[2].sessionEndMs - 475) < 0.001);
      for (const entry of entries) {
        assert.equal(entry.schema, "l0_chunk_v1");
        assert.equal(entry.clockSource, "mach_absolute_time");
        const pcm = fs.readFileSync(path.join(directory, entry.file));
        assert.equal(pcm.length, entry.frames * 4);
        assert.equal(pcm.readFloatLE(0), 0.25);
      }
      assert.equal(fs.existsSync(path.join(directory, "current.part")), false);
    });
    await test("native parent PID watcher terminates an orphan with stdin still open", async () => {
      const child = spawn(resolveHelperPath({ platform: "darwin", appRoot: ROOT }), [], { stdio: ["pipe", "pipe", "pipe"] });
      let timer;
      const exited = new Promise((resolve, reject) => {
        timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("parent watcher did not exit")); }, 12000);
        child.on("error", reject);
        child.on("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`helper exit ${code}`)); });
      });
      child.stdin.write(`${JSON.stringify({ cmd: "configure", id: "orphan", session_root: path.join(temp, "orphan"), parent_pid: 2147483647 })}\n`);
      await exited;
    });
  } else {
    console.log("skip - real Swift compilation, native writer and macOS permissions/capture unavailable on this host");
  }
  console.log(`${passed} platform tests passed. Test fixtures preserved: ${temp}`);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
