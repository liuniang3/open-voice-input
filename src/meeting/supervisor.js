"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const {
  HELPER_VERSION,
  DEFAULT_SUBCHUNK_MS,
  TRACK_MICROPHONE,
  CAPTURE_MODE_DUAL,
  REQUIRED_CAPABILITIES
} = require("./constants");
const {
  assertHelperReady,
  assertPathInsideRoot,
  resolveHelperPath
} = require("./paths");
const {
  assertHelloCompatible,
  buildCommand,
  isAck,
  isResult,
  parseHelperLine,
  resultError,
  resultOk,
  validateStartPathInput
} = require("./protocol");

/**
 * Supervises the native audio-capture-helper process.
 * Isolated from short-voice getUserMedia / hotkey recording state.
 */
function createAudioCaptureSupervisor(options = {}) {
  const {
    helperPath: overrideHelperPath,
    isPackaged = false,
    resourcesPath = "",
    appRoot = process.cwd(),
    sessionRoot = "",
    parentPid = process.pid,
    requiredVersion = HELPER_VERSION,
    requiredCapabilities = REQUIRED_CAPABILITIES,
    spawnImpl = spawn,
    logger = () => {},
    commandTimeoutMs = 15000
  } = options;

  let child = null;
  let stdoutRl = null;
  let started = false;
  let configured = false;
  let hello = null;
  let activeSessionId = null;
  let activeOutputDir = null;
  let activeSystemOutputDir = null;
  let activeCaptureMode = null;
  let sessionFaulted = false;
  let dirty = false;
  let pending = new Map();
  let bufferHandlers = [];
  let faultHandlers = [];

  function log(message, detail) {
    try {
      logger(message, detail);
    } catch {
      // never throw from logger
    }
  }

  function helperPath() {
    return resolveHelperPath({
      isPackaged,
      resourcesPath,
      appRoot,
      overridePath: overrideHelperPath
    });
  }

  function ensureHelperBinary() {
    return assertHelperReady(helperPath(), { requiredVersion });
  }

  function rejectAllPending(error) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending = new Map();
  }

  function handleMessage(message) {
    if (!message) return;
    if (message.type === "hello" && !hello) {
      hello = message;
      return;
    }
    if (message.type === "parse_error") {
      log("meeting-helper: parse_error", message.message || "");
      return;
    }
    if (
      message.type === "progress" &&
      (message.event === "track_fault" || message.event === "session_fault")
    ) {
      sessionFaulted = true;
      if (message.event === "session_fault") {
        // Keep active ids until stop, but mark faulted so service can flip status.
      }
      for (const handler of faultHandlers) {
        try {
          handler(message);
        } catch {
          // ignore
        }
      }
      for (const handler of bufferHandlers) {
        try {
          handler(message);
        } catch {
          // ignore
        }
      }
      return;
    }
    const id = message.id;
    if (!id || !pending.has(id)) {
      for (const handler of bufferHandlers) {
        try {
          handler(message);
        } catch {
          // ignore
        }
      }
      return;
    }
    const entry = pending.get(id);
    if (isAck(message, id)) {
      entry.acked = true;
      entry.ackMessage = message;
      return;
    }
    if (isResult(message, id)) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.resolve({
        ack: entry.ackMessage || null,
        result: message,
        ok: resultOk(message),
        error: resultError(message)
      });
    }
  }

  function attachChild(proc) {
    child = proc;
    stdoutRl = readline.createInterface({ input: proc.stdout });
    stdoutRl.on("line", (line) => {
      handleMessage(parseHelperLine(line));
    });
    proc.stderr?.on("data", (chunk) => {
      const text = String(chunk || "").trim();
      if (text) log("meeting-helper:stderr", text);
    });
    proc.on("exit", (code, signal) => {
      log("meeting-helper:exit", `code=${code} signal=${signal}`);
      const err = new Error(`audio-capture-helper exited code=${code} signal=${signal}`);
      err.code = "helper_exited";
      rejectAllPending(err);
      child = null;
      stdoutRl = null;
      started = false;
      configured = false;
      hello = null;
      activeSessionId = null;
      activeOutputDir = null;
      activeSystemOutputDir = null;
      activeCaptureMode = null;
      sessionFaulted = false;
      dirty = false;
    });
  }

  async function recoverAfterStartFailure() {
    dirty = true;
    try {
      await sendCommand("stop", {}, { timeoutMs: 3000 });
    } catch {
      // ignore
    }
    activeSessionId = null;
    activeOutputDir = null;
    activeSystemOutputDir = null;
    activeCaptureMode = null;
    sessionFaulted = false;
    dirty = false;
  }

  async function waitForHello(timeoutMs = commandTimeoutMs) {
    const start = Date.now();
    while (!hello) {
      if (Date.now() - start > timeoutMs) {
        const error = new Error("timeout waiting for helper hello");
        error.code = "helper_hello_timeout";
        throw error;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    const check = assertHelloCompatible(hello, { requiredVersion, requiredCapabilities });
    if (!check.ok) {
      const error = new Error(check.message);
      error.code = check.code;
      error.missing = check.missing;
      throw error;
    }
    return hello;
  }

  function sendCommand(cmd, fields = {}, { timeoutMs = commandTimeoutMs } = {}) {
    if (!child || !child.stdin) {
      return Promise.reject(Object.assign(new Error("helper not running"), { code: "helper_not_running" }));
    }
    const message = buildCommand(cmd, fields);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        const error = new Error(`helper command timeout: ${cmd}`);
        error.code = "helper_command_timeout";
        error.commandId = message.id;
        reject(error);
      }, timeoutMs);
      pending.set(message.id, {
        resolve,
        reject,
        timer,
        acked: false,
        ackMessage: null,
        cmd
      });
      const line = `${JSON.stringify(message)}\n`;
      child.stdin.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          pending.delete(message.id);
          reject(err);
        }
      });
    });
  }

  async function start() {
    if (started && child) {
      return { started: true, idempotent: true, hello };
    }
    const ready = ensureHelperBinary();
    const proc = spawnImpl(ready.path, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    attachChild(proc);
    started = true;
    hello = null;
    await waitForHello();
    return { started: true, hello, helperPath: ready.path };
  }

  async function configure({ root = sessionRoot, pid = parentPid } = {}) {
    if (!root) {
      const error = new Error("sessionRoot is required for configure");
      error.code = "session_root_required";
      throw error;
    }
    if (!started) await start();
    const response = await sendCommand("configure", {
      session_root: root,
      parent_pid: pid
    });
    if (!response.ok) {
      const error = new Error(response.error?.message || "configure failed");
      error.code = response.error?.code || "configure_failed";
      throw error;
    }
    configured = true;
    return response;
  }

  async function queryDevices() {
    if (!started) await start();
    return sendCommand("query_devices");
  }

  /**
   * Dual-track start: single RPC with capture_mode dual + microphone + system.
   */
  async function startDualCapture({
    sessionId,
    microphoneOutputDir,
    systemOutputDir,
    microphoneDeviceId = null,
    systemDeviceId = null,
    subchunkMs = DEFAULT_SUBCHUNK_MS
  }) {
    if (!configured) {
      const error = new Error("configure session root before start");
      error.code = "not_configured";
      throw error;
    }
    for (const [label, dir] of [
      ["microphone", microphoneOutputDir],
      ["system", systemOutputDir]
    ]) {
      const pathCheck = validateStartPathInput(dir);
      if (!pathCheck.ok) {
        const error = new Error(`${label}: ${pathCheck.message}`);
        error.code = pathCheck.code;
        throw error;
      }
    }
    const safeMic = assertPathInsideRoot(sessionRoot || microphoneOutputDir, microphoneOutputDir);
    const safeSys = assertPathInsideRoot(sessionRoot || systemOutputDir, systemOutputDir);

    if (
      activeSessionId &&
      activeSessionId === sessionId &&
      activeCaptureMode === CAPTURE_MODE_DUAL &&
      activeOutputDir === safeMic &&
      activeSystemOutputDir === safeSys
    ) {
      return {
        ok: true,
        idempotent: true,
        result: {
          type: "result",
          result: {
            ok: true,
            data: { started: true, idempotent: true, sessionId, captureMode: "dual" }
          }
        },
        ack: { type: "ack", command: "start" }
      };
    }
    if (activeSessionId) {
      const error = new Error(`capture already active for session ${activeSessionId}`);
      error.code = "already_capturing";
      throw error;
    }

    let response;
    try {
      response = await sendCommand("start", {
        session_id: sessionId,
        capture_mode: CAPTURE_MODE_DUAL,
        microphone: {
          device_id: microphoneDeviceId || undefined,
          output_dir: safeMic
        },
        system: {
          device_id: systemDeviceId || undefined,
          output_dir: safeSys
        },
        subchunk_ms: subchunkMs
      });
    } catch (error) {
      // Timeout / disconnect: clear potential ghost session on helper
      await recoverAfterStartFailure();
      throw error;
    }
    if (!response.ok) {
      await recoverAfterStartFailure();
      const error = new Error(response.error?.message || "start dual failed");
      error.code = response.error?.code || "start_failed";
      error.helper = response;
      throw error;
    }
    activeSessionId = sessionId;
    activeOutputDir = safeMic;
    activeSystemOutputDir = safeSys;
    activeCaptureMode = CAPTURE_MODE_DUAL;
    sessionFaulted = false;
    dirty = false;
    return response;
  }

  /** Mic-only start (Stage 0A compat). */
  async function startCapture({
    sessionId,
    outputDir,
    deviceId = null,
    subchunkMs = DEFAULT_SUBCHUNK_MS,
    track = TRACK_MICROPHONE
  }) {
    if (!configured) {
      const error = new Error("configure session root before start");
      error.code = "not_configured";
      throw error;
    }
    const pathCheck = validateStartPathInput(outputDir);
    if (!pathCheck.ok) {
      const error = new Error(pathCheck.message);
      error.code = pathCheck.code;
      throw error;
    }
    const safeOutputDir = assertPathInsideRoot(sessionRoot || outputDir, outputDir);

    if (
      activeSessionId &&
      activeSessionId === sessionId &&
      activeCaptureMode !== CAPTURE_MODE_DUAL &&
      activeOutputDir === safeOutputDir
    ) {
      return {
        ok: true,
        idempotent: true,
        result: {
          type: "result",
          result: { ok: true, data: { started: true, idempotent: true, sessionId } }
        },
        ack: { type: "ack", command: "start" }
      };
    }
    if (activeSessionId && (activeSessionId !== sessionId || activeOutputDir !== safeOutputDir)) {
      const error = new Error(`capture already active for session ${activeSessionId}`);
      error.code = "already_capturing";
      throw error;
    }

    let response;
    try {
      response = await sendCommand("start", {
        session_id: sessionId,
        track,
        device_id: deviceId || undefined,
        output_dir: safeOutputDir,
        subchunk_ms: subchunkMs
      });
    } catch (error) {
      await recoverAfterStartFailure();
      throw error;
    }
    if (!response.ok) {
      await recoverAfterStartFailure();
      const error = new Error(response.error?.message || "start failed");
      error.code = response.error?.code || "start_failed";
      error.helper = response;
      throw error;
    }
    activeSessionId = sessionId;
    activeOutputDir = safeOutputDir;
    activeSystemOutputDir = null;
    activeCaptureMode = "microphone";
    sessionFaulted = false;
    dirty = false;
    return response;
  }

  async function pause() {
    return sendCommand("pause");
  }

  async function resume() {
    return sendCommand("resume");
  }

  async function stopCapture() {
    const response = await sendCommand("stop");
    activeSessionId = null;
    activeOutputDir = null;
    activeSystemOutputDir = null;
    activeCaptureMode = null;
    sessionFaulted = false;
    dirty = false;
    return response;
  }

  async function ping() {
    return sendCommand("ping");
  }

  async function shutdown() {
    if (!child) return { ok: true, idempotent: true };
    try {
      await sendCommand("shutdown", {}, { timeoutMs: 3000 });
    } catch {
      // fall through to kill
    }
    try {
      child.kill();
    } catch {
      // ignore
    }
    child = null;
    started = false;
    configured = false;
    activeSessionId = null;
    activeOutputDir = null;
    activeSystemOutputDir = null;
    activeCaptureMode = null;
    return { ok: true };
  }

  function getState() {
    return {
      started,
      configured,
      activeSessionId,
      activeOutputDir,
      activeSystemOutputDir,
      activeCaptureMode,
      sessionFaulted,
      dirty,
      helperPath: helperPath(),
      hello,
      pendingCount: pending.size
    };
  }

  function onMessage(handler) {
    bufferHandlers.push(handler);
    return () => {
      bufferHandlers = bufferHandlers.filter((h) => h !== handler);
    };
  }

  function onFault(handler) {
    faultHandlers.push(handler);
    return () => {
      faultHandlers = faultHandlers.filter((h) => h !== handler);
    };
  }

  return {
    start,
    configure,
    queryDevices,
    startCapture,
    startDualCapture,
    pause,
    resume,
    stopCapture,
    ping,
    shutdown,
    getState,
    onMessage,
    onFault,
    ensureHelperBinary,
    helperPath,
    sendCommand
  };
}

module.exports = {
  createAudioCaptureSupervisor
};
