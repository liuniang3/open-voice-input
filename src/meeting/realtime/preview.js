"use strict";

const { RATE, readMixed } = require("./audio");

const frame = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const failure = code => Object.assign(new Error(code), { code });
// Ali's IDs include a fresh task UUID. Window-local identity survives replay;
// two different windows may still contain the same ID and identical text.
const sentenceId = value => String(value).replace(/^[a-f0-9]{32}:(?=(?:utterance|time):)/i, "");

// readMixed produces a canonical 44-byte upload header, unlike the archive's
// extensible header. The archive remains authoritative; no PCM queue is kept.
function createArchiveReader(paths) {
  return (start, end) => readMixed(typeof paths === "function" ? paths() : paths, start, end);
}

/**
 * readAudio(startFrame, endFrame): canonical mono PCM16/16kHz WAV, <=40s.
 * createStream({onSentence,onError}): {ready,appendPcm,finish,close}; finish
 * resolves only after task-finished. Sentence times are relative to the window.
 * kick is synchronous; drain/retry/recover/shutdown return completion promises.
 * Drain closes the task without closing this scheduler; the next kick resumes.
 * Recovery and a missing createStream only checkpoint gaps, never contact ASR.
 */
function createMeetingPreview({ state, readAudio, createStream, onChange = () => {},
  persist = () => {}, now = Date.now, sleep, chunkMs = 100, paceMs = 90,
  windowSeconds = 600, readSeconds = 40, connectTimeoutMs = 10000,
  finishTimeoutMs = 10000, appendTimeoutMs = 10000, drainTimeoutMs = 15000,
  reconnectDelayMs = 2000 } = {}) {
  if (!state) throw failure("preview_dependencies_missing");
  if (![chunkMs, windowSeconds, readSeconds, connectTimeoutMs, finishTimeoutMs,
    appendTimeoutMs, drainTimeoutMs].every(value => Number.isFinite(value) && value > 0)
    || ![paceMs, reconnectDelayMs].every(value => Number.isFinite(value) && value >= 0)) {
    throw failure("preview_limits_invalid");
  }
  readAudio ||= createArchiveReader(() => state.audioPaths || []);
  const limit = Math.max(1, Math.floor(Math.min(600, Math.max(0.001, windowSeconds)) * RATE));
  const readLimit = Math.max(1, Math.floor(Math.min(40, Math.max(0.001, readSeconds)) * RATE));
  const chunkFrames = Math.max(1, Math.floor(Math.min(100, Math.max(0.001, chunkMs)) * RATE / 1000));
  const preview = state.preview ||= { version: 1, cursorFrame: 0, windows: [] };
  preview.windows ||= [];
  let cursor = Math.max(frame(preview.cursorFrame), ...preview.windows.map(w => frame(w.endFrame)));
  let available = cursor;
  let active = null;
  let retryActive = null;
  let worker = null;
  let retryWorker = null;
  let draining = null;
  let paused = false;
  let closed = false;
  let nextConnectAt = 0;
  let nextId = Math.max(frame(preview.nextWindowId), preview.windows.length);
  let checkpoint = null;
  let checkpointDirty = false;
  let checkpointFailed = false;
  let terminalStatus = "idle";
  const retryQueue = [];

  for (const w of preview.windows) {
    // An interrupted task cannot be resumed on a new socket. Retain its finals
    // and replay only on explicit request, using the same archive interval.
    w.sentences = (w.sentences || []).filter(s => s.final).map(s => ({
      id: sentenceId(s.id), text: String(s.text || ""), beginMs: s.beginMs,
      endMs: s.endMs, final: true
    }));
    if (w.status !== "completed" && w.status !== "failed") {
      w.status = "failed";
      w.error = { code: "preview_interrupted" };
    } else if (w.error) w.error = { code: "preview_stream_failed" };
  }
  preview.cursorFrame = cursor;

  function snapshot() {
    const ordered = [];
    let draft = null;
    for (const w of preview.windows) {
      for (const s of w.sentences) {
        const startFrame = Math.min(w.endFrame, w.startFrame + Math.round(s.beginMs * RATE / 1000));
        const endFrame = Math.min(w.endFrame, w.startFrame + Math.round(s.endMs * RATE / 1000));
        if (s.final) ordered.push({ startFrame, endFrame, text: s.text, status: "completed" });
        else if (w.status !== "failed" && w.status !== "completed" && (!draft || startFrame >= draft.startFrame)) {
          draft = { startFrame, text: s.text };
        }
      }
    }
    ordered.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
    const failedSegments = preview.windows.filter(w => w.status === "failed").length;
    const pendingSegments = preview.windows.filter(w => w.status !== "failed" && w.status !== "completed").length;
    return {
      segments: ordered.map((s, index) => ({ index, ...s })),
      previewText: draft?.text || "", failedSegments, pendingSegments,
      failed: failedSegments,
      status: closed ? "closed" : draining ? "draining" : retryWorker ? "retrying"
        : active && !active.dead ? "streaming" : failedSegments ? "needs_retry" : terminalStatus,
      error: checkpointFailed ? { code: "preview_checkpoint_failed" } : null
    };
  }

  function notify() { try { onChange(snapshot()); } catch { /* UI must not interrupt audio. */ } }

  function save() {
    checkpointDirty = true;
    if (!checkpoint) {
      checkpoint = Promise.resolve().then(async () => {
        while (checkpointDirty) {
          checkpointDirty = false;
          try { await persist(); checkpointFailed = false; }
          catch { checkpointFailed = true; }
        }
      }).finally(() => { checkpoint = null; });
    }
    return checkpoint;
  }

  function changed() { notify(); void save(); }

  function allocate(start, end, status = "pending") {
    let id;
    do { id = `preview-${++nextId}`; } while (preview.windows.some(w => w.id === id));
    const w = { id, startFrame: start, endFrame: end, sentFrame: start, status, sentences: [] };
    preview.windows.push(w);
    preview.nextWindowId = nextId;
    cursor = end;
    preview.cursorFrame = cursor;
    return w;
  }

  function extend(ctx) {
    if (ctx.retry || ctx.dead) return;
    ctx.window.endFrame = Math.max(ctx.window.endFrame, Math.min(available, ctx.window.startFrame + limit));
    cursor = Math.max(cursor, ctx.window.endFrame);
    preview.cursorFrame = cursor;
  }

  function closeStream(stream) {
    try { Promise.resolve(stream?.close()).catch(() => {}); } catch { /* Already closed. */ }
  }

  function fail(ctx, code = "preview_stream_failed") {
    if (!ctx || ctx.dead) return;
    extend(ctx);
    ctx.dead = true;
    ctx.window.status = "failed";
    ctx.window.error = { code };
    if (!ctx.retry) ctx.window.sentences = ctx.window.sentences.filter(s => s.final);
    ctx.controller.abort();
    closeStream(ctx.stream);
    if (!ctx.retry) nextConnectAt = now() + Math.max(0, reconnectDelayMs);
    changed();
  }

  // Race every external wait against cancellation, including reads and factory
  // promises. A disconnected provider cannot hold stop or shutdown indefinitely.
  function wait(ctx, operation, timeoutMs, code) {
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.controller.signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(value);
      };
      const aborted = () => done(failure("preview_aborted"));
      if (ctx.controller.signal.aborted) { aborted(); return; }
      ctx.controller.signal.addEventListener("abort", aborted, { once: true });
      if (timeoutMs != null) timer = setTimeout(() => done(failure(code)), Math.max(1, timeoutMs));
      Promise.resolve().then(() => {
        if (ctx.controller.signal.aborted) throw failure("preview_aborted");
        return operation();
      }).then(value => done(null, value), error => done(error));
    });
  }

  function pace(ctx, milliseconds) {
    if (milliseconds <= 0) return Promise.resolve();
    if (sleep) return wait(ctx, () => sleep(milliseconds), null);
    return new Promise((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(failure("preview_aborted")); };
      const timer = setTimeout(() => {
        ctx.controller.signal.removeEventListener("abort", aborted);
        resolve();
      }, milliseconds);
      if (ctx.dead) aborted();
      else ctx.controller.signal.addEventListener("abort", aborted, { once: true });
    });
  }

  function sentence(ctx, input) {
    if (ctx.dead || !input || typeof input.text !== "string") return;
    const w = ctx.window;
    const sentences = ctx.retry ? ctx.stagedSentences : w.sentences;
    const begin = Number(input.beginMs ?? input.begin_time ?? 0);
    const end = Number(input.endMs ?? input.end_time ?? begin);
    if (!Number.isFinite(begin) || !Number.isFinite(end) || begin < 0 || end < begin) return;
    const id = sentenceId(input.id ?? input.sentence_id ?? begin);
    const final = input.final === true || input.sentence_end === true;
    const prior = sentences.find(s => s.id === id);
    if (prior?.final) return;
    const latestFinal = Math.max(-1, ...sentences.filter(s => s.final).map(s => s.beginMs));
    const latestDraft = sentences.find(s => !s.final);
    if (!final && (begin < latestFinal || (latestDraft && begin < latestDraft.beginMs)
      || (prior && end < prior.endMs))) return;
    const next = { id, text: input.text, beginMs: begin, endMs: end, final };
    const updated = sentences.filter(s => s.id !== id && (s.final || (final && s.beginMs > begin)));
    updated.push(next);
    if (ctx.retry) ctx.stagedSentences = updated;
    else w.sentences = updated;
    changed();
  }

  async function connect(ctx) {
    const w = ctx.window;
    w.status = "connecting";
    delete w.error;
    w.attempts = (w.attempts || 0) + 1;
    changed();
    const created = Promise.resolve().then(() => {
      if (ctx.dead) throw failure("preview_aborted");
      return createStream({ onSentence: s => sentence(ctx, s), onError: () => fail(ctx) });
    });
    // An async factory may resolve after stop's deadline has already expired.
    created.then(stream => { if (ctx.dead) closeStream(stream); }, () => {});
    ctx.stream = await wait(ctx, () => created, connectTimeoutMs, "preview_connect_timeout");
    await wait(ctx, () => typeof ctx.stream.ready === "function" ? ctx.stream.ready() : ctx.stream.ready,
      connectTimeoutMs, "preview_connect_timeout");
    w.status = "streaming";
    changed();
  }

  function context(w, retry = false) {
    return { window: w, retry, stagedSentences: retry ? [] : null,
      dead: false, stream: null, controller: new AbortController() };
  }

  async function send(ctx) {
    const w = ctx.window;
    while (!ctx.dead) {
      extend(ctx);
      if (w.sentFrame >= w.endFrame) return;
      const end = Math.min(w.endFrame, w.sentFrame + readLimit);
      const start = w.sentFrame;
      const wav = await wait(ctx, () => readAudio(start, end), appendTimeoutMs, "preview_audio_timeout");
      if (!Buffer.isBuffer(wav) || wav.length !== 44 + (end - start) * 2
        || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
        || wav.toString("ascii", 36, 40) !== "data" || wav.readUInt32LE(24) !== RATE
        || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16) {
        throw failure("preview_audio_invalid");
      }
      const pcm = wav.subarray(44);
      for (let sent = start; sent < end;) {
        const next = Math.min(end, sent + chunkFrames);
        const count = next - sent;
        const started = now();
        await wait(ctx, () => ctx.stream.appendPcm(pcm.subarray((sent - start) * 2, (next - start) * 2)),
          appendTimeoutMs, "preview_append_timeout");
        w.sentFrame = next;
        sent = next;
        // Pacing is proportional for sub-100ms tails and accounts for backpressure.
        await pace(ctx, Math.max(0, paceMs * count / chunkFrames - (now() - started)));
      }
      changed();
    }
  }

  async function finish(ctx) {
    ctx.window.status = "finishing";
    changed();
    await wait(ctx, () => ctx.stream.finish(), finishTimeoutMs, "preview_finish_timeout");
    if (ctx.dead) throw failure("preview_aborted");
    if (ctx.retry) ctx.window.sentences = ctx.stagedSentences.filter(s => s.final);
    ctx.window.status = "completed";
    ctx.window.sentences = ctx.window.sentences.filter(s => s.final);
    ctx.dead = true;
    closeStream(ctx.stream);
    changed();
  }

  function startWorker() {
    if (worker || closed || typeof createStream !== "function" || (paused && !draining)) return worker;
    worker = Promise.resolve().then(async () => {
      while (!closed && (!paused || draining)) {
        if (active?.dead) active = null;
        if (!active) {
          if (cursor >= available || (!draining && now() < nextConnectAt)) break;
          active = context(allocate(cursor, Math.min(available, cursor + limit)));
        }
        const ctx = active;
        try {
          if (!ctx.stream) await connect(ctx);
          await send(ctx);
          if (draining || ctx.window.endFrame - ctx.window.startFrame >= limit) {
            await finish(ctx);
            active = null;
          } else break;
        } catch (error) {
          const allowed = ["preview_connect_timeout", "preview_finish_timeout", "preview_append_timeout",
            "preview_audio_timeout", "preview_audio_invalid"];
          fail(ctx, allowed.includes(error?.code) ? error.code : "preview_stream_failed");
          active = null;
          break;
        }
      }
    }).finally(() => { worker = null; });
    return worker;
  }

  function kick(availableFrames) {
    if (closed || draining) return;
    available = Math.max(available, frame(availableFrames));
    paused = false;
    terminalStatus = "idle";
    void startWorker();
  }

  function invalidate(startFrame, endFrame) {
    if (closed || !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)
      || startFrame < 0 || endFrame <= startFrame) return 0;
    let affected = 0;
    for (const w of preview.windows) {
      if (w.startFrame >= endFrame || w.endFrame <= startFrame) continue;
      affected++;
      // Include reserved/read-ahead audio, not just acknowledged sends. A late
      // track can otherwise change the archive while stale mixed PCM is queued.
      if (active?.window === w) fail(active, "preview_audio_changed");
      if (retryActive?.window === w) fail(retryActive, "preview_audio_changed");
      const queued = retryQueue.indexOf(w);
      if (queued >= 0) retryQueue.splice(queued, 1);
      w.status = "failed";
      w.error = { code: "preview_audio_changed" };
      w.revision = (w.revision || 0) + 1;
      w.sentences = w.sentences.filter(s => s.final);
    }
    if (affected) changed();
    return affected;
  }

  function markUnsent(code) {
    while (cursor < available) {
      const w = allocate(cursor, Math.min(available, cursor + limit), "failed");
      w.error = { code };
    }
  }

  async function durable() {
    await save();
    if (checkpointFailed) throw failure("preview_checkpoint_failed");
  }

  function drain(availableFrames = available) {
    if (draining) return draining.then(() => snapshot());
    if (closed) return Promise.resolve(snapshot());
    available = Math.max(available, frame(availableFrames));
    paused = true;
    cancelRetries();
    draining = Promise.resolve().then(async () => {
      const timer = setTimeout(() => {
        fail(active, "preview_drain_timeout");
        fail(retryActive, "preview_drain_timeout");
        markUnsent("preview_drain_timeout");
      }, Math.max(1, drainTimeoutMs));
      try {
        await startWorker();
        // A worker can have observed idle just before drain was requested.
        if (active && !active.dead) await startWorker();
        markUnsent("preview_unsent");
      } finally { clearTimeout(timer); }
      active = null;
      terminalStatus = "completed";
      changed();
      await durable();
    }).finally(() => { draining = null; notify(); });
    return draining.then(() => snapshot());
  }

  function retry() {
    if (closed || draining || typeof createStream !== "function") return Promise.resolve(snapshot());
    for (const w of preview.windows) {
      if (w.status !== "failed" || retryQueue.includes(w) || retryActive?.window === w) continue;
      w.status = "pending";
      retryQueue.push(w);
    }
    if (!retryWorker && retryQueue.length) {
      retryWorker = Promise.resolve().then(async () => {
        while (retryQueue.length && !closed) {
          const w = retryQueue.shift();
          const ctx = context(w, true);
          retryActive = ctx;
          w.sentFrame = w.startFrame;
          try { await connect(ctx); await send(ctx); await finish(ctx); }
          catch { fail(ctx); }
          retryActive = null;
        }
        if (paused) terminalStatus = "completed";
        await durable();
      }).finally(() => { retryWorker = null; notify(); });
      // Callers may launch a retry without awaiting it. The returned promise
      // still exposes persistence failures to callers which do await it.
      retryWorker.catch(() => {});
    }
    changed();
    return retryWorker || Promise.resolve(snapshot());
  }

  async function waitForIdle() {
    while (worker || retryWorker) await Promise.all([worker, retryWorker]);
  }

  function cancelRetries() {
    fail(retryActive, "preview_interrupted");
    for (const w of retryQueue.splice(0)) {
      w.status = "failed";
      w.error = { code: "preview_interrupted" };
    }
  }

  function abort(availableFrames = available) {
    available = Math.max(available, frame(availableFrames));
    paused = true;
    fail(active, "preview_interrupted");
    cancelRetries();
    markUnsent("preview_interrupted");
    terminalStatus = "paused";
    changed();
  }

  async function recover(availableFrames = available) {
    abort(availableFrames);
    await waitForIdle();
    await durable();
    return snapshot();
  }

  async function shutdown(availableFrames = available) {
    closed = true;
    abort(availableFrames);
    await waitForIdle();
    await durable();
    return snapshot();
  }

  return { kick, drain, retry, snapshot, waitForIdle, recover, invalidate, abort, shutdown };
}

module.exports = { createMeetingPreview, createArchiveReader };
