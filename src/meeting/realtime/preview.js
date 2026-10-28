"use strict";

const { RATE, readMixed } = require("./audio");
const { createQuietDetector } = require("../audio-boundaries");

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
  windowSeconds = null, readSeconds = 40, connectTimeoutMs = 10000,
  finishTimeoutMs = 10000, appendTimeoutMs = 10000, drainTimeoutMs = 15000,
  reconnectDelayMs = 2000, pauseBeforeSeconds = 30, autoRetry = true, maxAutoAttempts = 5,
  resultStallSeconds = 45 } = {}) {
  if (!state) throw failure("preview_dependencies_missing");
  if ((windowSeconds != null && (!Number.isFinite(windowSeconds) || windowSeconds <= 0))
    || !Number.isSafeInteger(maxAutoAttempts) || maxAutoAttempts < 0
    || ![chunkMs, readSeconds, connectTimeoutMs, finishTimeoutMs,
    appendTimeoutMs, drainTimeoutMs].every(value => Number.isFinite(value) && value > 0)
    || ![paceMs, reconnectDelayMs, pauseBeforeSeconds, resultStallSeconds].every(value => Number.isFinite(value) && value >= 0)) {
    throw failure("preview_limits_invalid");
  }
  readAudio ||= createArchiveReader(() => state.audioPaths || []);
  // Archive reads and recovery jobs stay bounded; the healthy live ASR task
  // does not restart at Markdown saves or an arbitrary ten-minute boundary.
  const limit = windowSeconds == null ? Infinity : Math.max(1, Math.floor(windowSeconds * RATE));
  const softLimit = limit - Math.floor(Math.min(pauseBeforeSeconds * RATE, limit / 2));
  const readLimit = Math.max(1, Math.floor(Math.min(40, Math.max(0.001, readSeconds)) * RATE));
  const chunkFrames = Math.max(1, Math.floor(Math.min(100, Math.max(0.001, chunkMs)) * RATE / 1000));
  const preview = state.preview ||= { version: 1, cursorFrame: 0, windows: [] };
  preview.windows ||= [];
  let cursor = Math.max(frame(preview.cursorFrame), ...preview.windows.filter(w => !w.repair).map(w => frame(w.endFrame)));
  let available = cursor;
  let active = null;
  const retiring = new Map();
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
    const repairs = preview.windows.filter(w => w.repair && (w.status === "completed" || w.hasResult));
    for (const w of preview.windows) {
      for (const s of w.sentences) {
        const startFrame = Math.min(w.endFrame, w.startFrame + Math.round(s.beginMs * RATE / 1000));
        const endFrame = Math.min(w.endFrame, w.startFrame + Math.round(s.endMs * RATE / 1000));
        if (repairs.some(r => r !== w && (!w.repair ? r.targetWindowIds.includes(w.id)
          : preview.windows.indexOf(r) > preview.windows.indexOf(w))
          && startFrame >= (r.resultStartFrame ?? r.startFrame)
          && endFrame <= (r.resultEndFrame ?? r.endFrame))) continue;
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
      status: closed ? "closed" : draining ? "draining" : active && !active.dead
        ? active.window.status === "connecting" ? "connecting" : "streaming"
        : retryWorker ? "retrying" : retiring.size ? "rotating" : failedSegments ? "needs_retry" : terminalStatus,
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
    if (ctx.retry || ctx.dead || ctx.rotationReady) return;
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
    ctx.window.nextAutoAttemptAt = now() + Math.max(0, reconnectDelayMs) * Math.min(16, 2 ** (ctx.window.autoAttempts || 0));
    if (!ctx.retry && !ctx.retiring) nextConnectAt = now() + Math.max(0, reconnectDelayMs);
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
    const offsetMs = (ctx.baseFrame - w.startFrame) * 1000 / RATE;
    const begin = Number(input.beginMs ?? input.begin_time ?? 0) + offsetMs;
    const end = Number(input.endMs ?? input.end_time ?? input.beginMs ?? input.begin_time ?? 0) + offsetMs;
    if (!Number.isFinite(begin) || !Number.isFinite(end) || begin < 0 || end < begin) return;
    const localId = sentenceId(input.id ?? input.sentence_id ?? begin);
    const id = ctx.baseFrame === w.startFrame ? localId : "resume:" + ctx.baseFrame + ":" + localId;
    const final = input.final === true || input.sentence_end === true;
    const prior = sentences.find(s => s.id === id);
    if (prior?.final) return;
    const latestFinal = Math.max(-1, ...sentences.filter(s => s.final).map(s => s.beginMs));
    const latestDraft = sentences.find(s => !s.final);
    if (!final && (begin < latestFinal || (latestDraft && begin < latestDraft.beginMs)
      || (prior && end < prior.endMs))) return;
    if (prior && prior.text === input.text && prior.endMs === end && prior.final === final) return;
    if (input.text.trim()) { ctx.voicedWithoutResult = 0; ctx.resultRevision++; }
    const next = { id, text: input.text, beginMs: begin, endMs: end, final };
    const updated = sentences.filter(s => s.id !== id && (s.final || (final && s.beginMs > begin)));
    updated.push(next);
    if (ctx.retry) ctx.stagedSentences = updated;
    else w.sentences = updated;
    if (final && !ctx.retry) {
      const a = w.startFrame + Math.round(begin * RATE / 1000);
      const b = w.startFrame + Math.round(end * RATE / 1000);
      const partialRepair = preview.windows.find(r => r.repair && r.targetWindowIds.includes(w.id)
        && r.startFrame < b && r.endFrame > a && (r.startFrame > a || r.endFrame < b));
      if (partialRepair) invalidate(a, b);
    }
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
    return { window: w, retry, baseFrame: w.startFrame, audioRevision: 0,
      voicedWithoutResult: 0, resultRevision: 0,
      readingStart: w.startFrame, readingEnd: w.startFrame, inflightEndFrame: w.startFrame,
      stagedSentences: retry ? [] : null,
      quiet: createQuietDetector(RATE), rotationReady: false,
      dead: false, stream: null, controller: new AbortController() };
  }

  async function readPcm(ctx, start, end) {
    const wav = await wait(ctx, () => readAudio(start, end), appendTimeoutMs, "preview_audio_timeout");
    if (!Buffer.isBuffer(wav) || wav.length !== 44 + (end - start) * 2
      || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
      || wav.toString("ascii", 36, 40) !== "data" || wav.readUInt32LE(24) !== RATE
      || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16) {
      throw failure("preview_audio_invalid");
    }
    return wav.subarray(44);
  }

  // Preserve archive timestamps and full WAVs without pacing minutes of pause
  // zeros. Only exact digital zero after an explicit pause is skipped.
  async function skipPausedSilence(ctx) {
    if (!preview.skipPausedSilence || ctx.retry) return false;
    const w = ctx.window;
    let start = w.startFrame;
    while (start < w.endFrame) {
      const end = Math.min(w.endFrame, start + readLimit);
      const revision = ctx.audioRevision;
      ctx.readingStart = start; ctx.readingEnd = end;
      const pcm = await readPcm(ctx, start, end);
      if (revision !== ctx.audioRevision) continue;
      let offset = 0;
      while (offset < pcm.length && pcm.readInt16LE(offset) === 0) offset += 2;
      start += offset / 2;
      ctx.skippedThroughFrame = start;
      if (offset < pcm.length) { preview.skipPausedSilence = false; break; }
    }
    if (start === w.startFrame) return false;
    w.endFrame = start;
    w.status = "completed";
    w.skipped = "paused_silence";
    cursor = start; preview.cursorFrame = cursor;
    ctx.dead = true;
    changed();
    return true;
  }

  async function send(ctx) {
    const w = ctx.window;
    while (!ctx.dead) {
      extend(ctx);
      if (ctx.rotationReady || w.sentFrame >= w.endFrame) return;
      const end = Math.min(w.endFrame, w.sentFrame + readLimit);
      const start = w.sentFrame;
      const revision = ctx.audioRevision;
      ctx.readingStart = start; ctx.readingEnd = end;
      const pcm = await readPcm(ctx, start, end);
      for (let sent = start; sent < end;) {
        // A late track can change cached mixed PCM. Re-read unsent samples
        // instead of discarding the healthy task and its language context.
        if (revision !== ctx.audioRevision) break;
        const next = Math.min(end, sent + chunkFrames);
        const count = next - sent;
        const started = now();
        const packet = pcm.subarray((sent - start) * 2, (next - start) * 2);
        const resultRevision = ctx.resultRevision;
        ctx.inflightEndFrame = next;
        await wait(ctx, () => ctx.stream.appendPcm(packet),
          appendTimeoutMs, "preview_append_timeout");
        w.sentFrame = next;
        sent = next;
        const quiet = ctx.quiet.append(packet);
        if (resultStallSeconds && !draining && ctx.resultRevision === resultRevision) {
          let energy = 0;
          for (let i = 0; i < packet.length; i += 2) energy += (packet.readInt16LE(i) / 32768) ** 2;
          if (energy / count > 0.006 ** 2) ctx.voicedWithoutResult += count;
          if (ctx.voicedWithoutResult >= resultStallSeconds * RATE) throw failure("preview_result_timeout");
        }
        if (!ctx.retry && !draining && pauseBeforeSeconds > 0 && quiet && next - w.startFrame >= softLimit) {
          // Only cut at acknowledged PCM. Release the reserved/read-ahead suffix
          // so the next task sends it exactly once, even after a restart.
          ctx.rotationReady = true;
          w.endFrame = next;
          w.rotationBoundary = "pause";
          cursor = next; preview.cursorFrame = cursor;
          changed();
          return;
        }
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
    if (ctx.window.repair) {
      ctx.window.hasResult = true;
      ctx.window.resultStartFrame = ctx.window.startFrame;
      ctx.window.resultEndFrame = ctx.window.endFrame;
    }
    ctx.window.status = "completed";
    ctx.window.sentences = ctx.window.sentences.filter(s => s.final);
    ctx.dead = true;
    closeStream(ctx.stream);
    changed();
  }

  function retire(ctx) {
    // A completed upload can wait for its final receipt while the next socket
    // receives new audio. At most one old socket and one live socket coexist.
    ctx.retiring = true;
    const done = Promise.resolve().then(() => finish(ctx)).catch(error => {
      fail(ctx, error?.code === "preview_finish_timeout" ? error.code : "preview_stream_failed");
    }).finally(() => { retiring.delete(ctx); notify(); });
    retiring.set(ctx, done);
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
          if (!ctx.stream) {
            if (await skipPausedSilence(ctx)) { active = null; continue; }
            await connect(ctx);
          }
          await send(ctx);
          if (draining) {
            await finish(ctx);
            active = null;
          } else if (ctx.rotationReady || ctx.window.endFrame - ctx.window.startFrame >= limit) {
            if (retiring.size) await Promise.all(retiring.values());
            if (ctx.dead || closed) continue;
            retire(ctx);
            active = null;
          } else break;
        } catch (error) {
          const allowed = ["preview_connect_timeout", "preview_finish_timeout", "preview_append_timeout",
            "preview_audio_timeout", "preview_audio_invalid", "preview_result_timeout"];
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
    if (autoRetry) void retry({ automatic: true }).catch(() => {});
  }

  function invalidate(startFrame, endFrame) {
    if (closed || !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)
      || startFrame < 0 || endFrame <= startFrame) return 0;
    let affected = 0;
    for (const w of [...preview.windows]) {
      if (w.repair || w.startFrame >= endFrame || w.endFrame <= startFrame) continue;
      const ctx = active?.window === w && !active.dead ? active : null;
      if (ctx && startFrame < ctx.readingEnd && endFrame > ctx.readingStart) ctx.audioRevision++;
      const replaying = retryActive?.window === w || retryQueue.includes(w);
      const exposedEnd = replaying || w.skipped ? w.endFrame : Math.max(w.sentFrame,
        ctx?.inflightEndFrame || w.startFrame, ctx?.skippedThroughFrame || w.startFrame);
      if (startFrame >= exposedEnd) continue;
      affected++;
      // Explicitly replaying a historical failed task is transactional: cancel
      // stale staged results. Live capture uses a separate bounded repair below.
      if (!ctx && w.status !== "completed") {
        for (const retiringContext of retiring.keys()) {
          if (retiringContext.window === w) fail(retiringContext, "preview_audio_changed");
        }
        if (retryActive?.window === w) fail(retryActive, "preview_audio_changed");
        const queued = retryQueue.indexOf(w);
        if (queued >= 0) retryQueue.splice(queued, 1);
        w.status = "failed"; w.error = { code: "preview_audio_changed" };
        w.sentences = w.sentences.filter(s => s.final);
        continue;
      }
      let from = Math.max(w.startFrame, startFrame);
      let to = Math.min(exposedEnd, endFrame);
      // Replace complete confirmed sentences, never discard the unaffected
      // words on either side of a patch through a sentence.
      for (const s of w.sentences) {
        const a = w.startFrame + Math.round(s.beginMs * RATE / 1000);
        const b = w.startFrame + Math.round(s.endMs * RATE / 1000);
        if (s.final && a < to && b > from) { from = Math.min(from, a); to = Math.max(to, b); }
      }
      let repair = preview.windows.find(r => r.repair && r.targetWindowIds.includes(w.id)
        && ((r.status !== "completed" && r.startFrame < to && r.endFrame > from)
          || (r.startFrame === from && r.endFrame === to)));
      if (!repair) {
        repair = { id: "repair-" + (++nextId), repair: true, targetWindowIds: [w.id],
          startFrame: from, endFrame: to, sentFrame: from, sentences: [] };
        preview.windows.push(repair); preview.nextWindowId = nextId;
      } else {
        if (retryActive?.window === repair) fail(retryActive, "preview_audio_changed");
        const queued = retryQueue.indexOf(repair);
        if (queued >= 0) retryQueue.splice(queued, 1);
        const newStart = Math.min(repair.startFrame, from);
        const shiftMs = (repair.startFrame - newStart) * 1000 / RATE;
        repair.sentences = repair.sentences.map(s => ({ ...s, beginMs: s.beginMs + shiftMs, endMs: s.endMs + shiftMs }));
        repair.startFrame = newStart; repair.endFrame = Math.max(repair.endFrame, to);
      }
      repair.status = "failed"; repair.error = { code: "preview_audio_changed" };
      repair.autoAttempts = 0;
      repair.nextAutoAttemptAt = Math.min(repair.nextAutoAttemptAt ?? Infinity,
        now() + Math.max(reconnectDelayMs, 2000));
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
    if (!autoRetry) cancelRetries();
    let expired = false;
    draining = Promise.resolve().then(async () => {
      const timer = setTimeout(() => {
        expired = true;
        fail(active, "preview_drain_timeout");
        for (const ctx of retiring.keys()) fail(ctx, "preview_drain_timeout");
        cancelRetries();
        markUnsent("preview_drain_timeout");
      }, Math.max(1, drainTimeoutMs));
      try {
        await startWorker();
        // A worker can have observed idle just before drain was requested.
        if (active && !active.dead) await startWorker();
        await Promise.all(retiring.values());
        markUnsent("preview_unsent");
        if (retryWorker) await retryWorker;
        // Final receipts can widen a late-audio repair to the complete sentence.
        // Finish those repairs under the same bounded stop deadline, without
        // starting a wholesale replay of old network failures.
        if (autoRetry && !expired) await retry({ automatic: true, drainingRepairs: true });
      } finally { clearTimeout(timer); }
      active = null;
      preview.skipPausedSilence = true;
      terminalStatus = "completed";
      changed();
      await durable();
    }).finally(() => { draining = null; notify(); });
    return draining.then(() => snapshot());
  }

  function retry({ automatic = false, drainingRepairs = false } = {}) {
    if (closed || (draining && !drainingRepairs) || typeof createStream !== "function") return Promise.resolve(snapshot());
    for (const w of preview.windows) {
      if (w.status !== "failed" || retryQueue.includes(w) || retryActive?.window === w) continue;
      if (drainingRepairs && !w.repair) continue;
      if (automatic && ((w.autoAttempts || 0) >= maxAutoAttempts || (!drainingRepairs && now() < (w.nextAutoAttemptAt || 0))
        || !["preview_stream_failed", "preview_connect_timeout", "preview_append_timeout",
          "preview_finish_timeout", "preview_audio_changed", "preview_result_timeout"].includes(w.error?.code))) continue;
      if (automatic) w.autoAttempts = (w.autoAttempts || 0) + 1;
      else w.autoAttempts = 0;
      w.automaticReplay = automatic && w.error?.code !== "preview_audio_changed";
      w.status = "pending";
      retryQueue.push(w);
    }
    if (!retryWorker && !retryQueue.length) return Promise.resolve(snapshot());
    if (!retryWorker && retryQueue.length) {
      retryWorker = Promise.resolve().then(async () => {
        while (retryQueue.length && !closed) {
          const w = retryQueue.shift();
          const ctx = context(w, true);
          retryActive = ctx;
          if (w.automaticReplay && !w.repair) {
            // Already confirmed sentences survive a transient disconnect. Replay
            // only its unconfirmed tail, with timestamps translated to the archive.
            ctx.baseFrame = Math.min(w.endFrame, Math.max(w.startFrame, ...w.sentences
              .filter(s => s.final).map(s => w.startFrame + Math.round(s.endMs * RATE / 1000))));
            ctx.stagedSentences = w.sentences.filter(s => s.final);
          }
          w.sentFrame = ctx.baseFrame;
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
    while (worker || retryWorker || retiring.size) await Promise.all([worker, retryWorker, ...retiring.values()]);
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
    for (const ctx of retiring.keys()) fail(ctx, "preview_interrupted");
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
