"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { RATE, HEADER_BYTES, normalizeChunk, ensureWave, writePcm, repairWave, readMixed } = require("./audio");
const { atomicWrite, readJson, reserveMarkdown, markdown } = require("./storage");
const { profileFor, transcriber, cleaner } = require("./providers");
const { RAW_TRANSCRIPT_REL } = require("../analysis/constants");

function createRealtimeMeetingService({ captureService, getSettings = () => ({}), defaultDirectory,
  onUpdate = () => {}, transcribeImpl, cleanImpl, now = Date.now, pumpIntervalMs = 1000,
  saveIntervalMs = 30000, segmentSeconds = 30, retryBaseMs = 2000, maxAttempts = 3 } = {}) {
  if (!captureService?.store || !defaultDirectory) throw new Error("live_dependencies_missing");
  const store = captureService.store;
  const segmentFrames = Math.min(30, Math.max(1, segmentSeconds)) * RATE;
  let state = null;
  let sessionDir = "";
  let request = null;
  let pumpTimer = null;
  let saveTimer = null;
  let pumpPromise = null;
  let workerPromise = null;
  let cleanupPromise = null;
  let transitionPromise = null;
  let persistTail = Promise.resolve();
  let saveTail = Promise.resolve();
  let controller = null;
  let cleanupController = null;
  let closing = false;
  let history = [];

  function safeError(error, fallback) {
    // Provider error bodies can contain credentials or transcript data. Never persist them.
    const allowed = new Set(["live_credentials_missing", "live_model_unsupported", "live_asr_token_plan_unsupported", "live_cleanup_validation_failed"]);
    return { code: allowed.has(error?.code) ? error.code : fallback,
      message: allowed.has(error?.code) ? error.message : {
        live_audio_failed: "音频归档暂时失败，原始录音片段仍保留。请检查磁盘空间并重试。",
        live_save_failed: "Markdown 保存失败，请检查目标目录权限或磁盘空间；本机会话记录仍保留。",
        live_asr_failed: "转写请求失败，音频已保留；请检查模型配置或网络并重试。",
        live_cleanup_failed: "清理失败，原始文本和音频未改变。可检查模型配置后重试。",
        live_capture_failed: "录音启动或采集失败，请检查麦克风、系统音频权限及音频设备。",
        live_stop_failed: "录音停止尚未确认，请再次停止；已保存的音频仍保留。"
      }[fallback] || "操作失败，已有录音与文本保留在本机会话目录。" };
  }

  function status() {
    if (!state) return { status: "idle", recording: false, rawText: "", correctedText: "", audioPaths: [], recoverableSessions: history };
    return {
      sessionId: state.sessionId, title: state.title, status: state.status, recording: state.recording,
      finalizationPending: Boolean(state.finalizationPending),
      modelId: state.modelId, captureMode: state.captureMode, startedAtMs: state.startedAtMs,
      durationMs: Math.round(Math.max(0, ...Object.values(state.tracks).map(t => t.frames)) * 1000 / RATE),
      rawText: state.segments.filter(s => s.status === "completed").map(s => s.text).filter(Boolean).join("\n\n"),
      correctedText: state.correctedText || "", markdownPath: state.markdownPath,
      cleanedMarkdownPath: state.cleanedMarkdownPath || "", audioPaths: [...state.audioPaths],
      pendingSegments: state.segments.filter(s => s.status === "pending" || s.status === "running").length,
      failedSegments: state.segments.filter(s => s.status === "failed").length,
      lastSavedAt: state.lastSavedAt || null, error: state.error || null,
      cleanupStatus: state.cleanupStatus || "idle", cleanupModelId: state.cleanupModelId || "",
      cleanupProgress: state.cleanupProgress || { completed: 0, total: 0 }, recoverableSessions: history
    };
  }

  function emit() { try { onUpdate(status()); } catch { /* renderer must not interrupt capture */ } }
  function stateFile() { return path.join(sessionDir, "realtime", "state.json"); }
  function persist() {
    const target = stateFile();
    const content = JSON.stringify(state, null, 2);
    const task = persistTail.catch(() => {}).then(() => atomicWrite(target, content));
    persistTail = task;
    return task;
  }

  async function saveMarkdown({ strict = false } = {}) {
    if (!state) return;
    const current = state;
    const body = markdown(current);
    const target = current.markdownPath;
    const task = saveTail.catch(() => {}).then(async () => {
      let failure = null;
      try {
        // Own only this session's marked block; external edits elsewhere are retained.
        const previous = await fs.readFile(target, "utf8");
        const startMarker = `<!-- open-voice-input:${current.sessionId}:start -->`;
        const endMarker = `<!-- open-voice-input:${current.sessionId}:end -->`;
        const begin = previous.indexOf(startMarker);
        const end = previous.indexOf(endMarker, begin);
        let next;
        const block = `${startMarker}\n${body}${endMarker}`;
        if (begin >= 0 && end >= begin) {
          const oldBlock = previous.slice(begin, end + endMarker.length);
          if (current.markdownBlockDigest && digest(oldBlock) !== current.markdownBlockDigest) throw new Error("markdown_changed_externally");
          next = previous.slice(0, begin) + block + previous.slice(end + endMarker.length);
        } else {
          if (begin >= 0 || end >= 0 || current.markdownBlockDigest) throw new Error("markdown_block_removed");
          if (current.markdownDigest) {
            if (digest(previous) !== current.markdownDigest) throw new Error("markdown_changed_externally");
            next = `${block}\n`;
          } else next = `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${previous ? "\n" : ""}${block}\n`;
        }
        // Detect an editor writing during the read/prepare phase before replacement.
        if (await fs.readFile(target, "utf8") !== previous) throw new Error("markdown_changed_externally");
        await atomicWrite(target, next);
        current.markdownDigest = null;
        current.markdownBlockDigest = digest(block);
        current.lastSavedAt = new Date(now()).toISOString();
        if (current.error?.code === "live_save_failed") current.error = null;
      } catch (error) { failure = safeError(error, "live_save_failed"); current.error = failure; }
      await persist();
      emit();
      if (strict && failure) throw Object.assign(new Error(failure.message), { code: failure.code });
    });
    saveTail = task;
    return task;
  }

  function digest(text) { return require("node:crypto").createHash("sha256").update(text).digest("hex"); }

  async function publishRaw() {
    const items = state.segments.filter(s => s.status === "completed").map(s => ({
      id: `live:${s.index}`, text: s.text, speakerId: "unknown", track: "mixed", sourceIndex: s.index,
      beginMs: s.startFrame * 1000 / RATE, endMs: s.endFrame * 1000 / RATE,
      sessionBeginMs: s.startFrame * 1000 / RATE, sessionEndMs: s.endFrame * 1000 / RATE,
      timestampPrecision: "segment"
    }));
    await atomicWrite(path.join(sessionDir, RAW_TRANSCRIPT_REL), JSON.stringify({
      schema: "raw_transcript_v1", sessionId: state.sessionId, generation: 1,
      provider: state.provider, modelId: state.modelId, mode: "meeting_realtime", diarization: false,
      count: items.length, items
    }, null, 2));
  }

  async function ingestTrack(track, final = false) {
    const t = state.tracks[track];
    const root = path.join(sessionDir, "audio", track);
    const manifest = await readJson(path.join(root, "manifest.json"));
    if (!manifest?.actualL0Format) return;
    const format = manifest.actualL0Format;
    const file = path.join(root, "index.jsonl");
    let h;
    try { h = await fs.open(file, "r"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try {
      // Read bounded index pages; the committed offset advances only after durable WAV writes.
      while (h) {
        const page = Buffer.alloc(1024 * 1024);
        const { bytesRead } = await h.read(page, 0, page.length, t.indexOffset);
        const lastNewline = page.subarray(0, bytesRead).lastIndexOf(10);
        if (lastNewline < 0) break;
        const text = page.subarray(0, lastNewline + 1).toString("utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line);
          if (!/^\d+\.l0\.pcm$/.test(entry.file || "")) throw new Error("live_index_path_invalid");
          if (Number(entry.seq) <= t.seq) continue;
          const pcmFile = path.join(root, entry.file);
          const st = await fs.stat(pcmFile);
          if (st.size > 32 * 1024 * 1024) throw new Error("live_chunk_too_large");
          const pcm = normalizeChunk(await fs.readFile(pcmFile), entry.format || format);
          // Native helpers commit sequential source frames. Preserve every sample; no silence deletion.
          const frameStart = Number(entry.frameStart);
          const rate = Number((entry.format || format).sampleRate);
          const sourceStart = Number.isFinite(frameStart) && rate > 0 ? Math.round(frameStart * RATE / rate) : t.frames;
          const elapsed = (Number(entry.qpcStart) - Number(entry.sessionOriginQpc)) / Number(entry.qpcFrequency);
          const clockStart = Number.isFinite(elapsed) && elapsed >= 0 && elapsed < (now() - state.startedAtMs) / 1000 + 60
            ? Math.round(elapsed * RATE) : null;
          if (t.originOffset == null) t.originOffset = clockStart == null ? 0 : Math.max(0, clockStart - sourceStart);
          // Preserve native gaps (e.g. a silent loopback endpoint) on the shared session timeline.
          const expectedStart = sourceStart + t.originOffset;
          const start = Math.max(t.frames, clockStart != null && clockStart - expectedStart > RATE / 4 ? clockStart : expectedStart);
          await writePcm(t.path, pcm, start);
          // An endpoint can deliver late audio after we previewed its interval as
          // silence. Invalidate exactly those windows; never silently lose late speech.
          for (const segment of state.segments) {
            if (start < segment.endFrame && start + pcm.length / 2 > segment.startFrame) {
              segment.revision = (segment.revision || 0) + 1;
              if (segment.status !== "running") segment.status = "pending";
              segment.text = ""; segment.attempts = 0; segment.nextAttempt = 0;
            }
          }
          // Use the logical end, not physical file size: a crash may have left later
          // uncheckpointed chunks on disk, which must be replayed at their original offsets.
          t.frames = Math.max(t.frames, start + pcm.length / 2);
          t.seq = Number(entry.seq);
        }
        t.indexOffset += lastNewline + 1;
        if (bytesRead < page.length) break;
      }
    } finally { await h?.close(); }
    if (final) {
      // A crash can occur after the chunk rename but before the index append.
      const names = (await fs.readdir(root)).filter(n => /^\d+\.l0\.pcm$/.test(n)).sort();
      for (const name of names) {
        const seq = Number(name.split(".")[0]);
        if (seq <= t.seq) continue;
        const fullPath = path.join(root, name);
        if ((await fs.stat(fullPath)).size > 32 * 1024 * 1024) throw new Error("live_chunk_too_large");
        const raw = await fs.readFile(fullPath);
        const pcm = normalizeChunk(raw, format);
        await writePcm(t.path, pcm, t.frames);
        t.frames += pcm.length / 2;
        t.seq = seq;
      }
      // Keep and archive an aligned unfinished tail after an interrupted process.
      const part = path.join(root, "current.part");
      const info = await fs.stat(part).catch(() => null);
      if (info?.size && !t.partRecovered) {
        if (info.size > 32 * 1024 * 1024) throw new Error("live_partial_too_large");
        const pcm = normalizeChunk(await fs.readFile(part), format);
        await writePcm(t.path, pcm, t.frames);
        t.frames += pcm.length / 2;
        t.partRecovered = true;
      }
    }
  }

  function queueSegments(final) {
    const lengths = Object.values(state.tracks).map(t => t.frames);
    // A silent system endpoint may produce no buffers. Allow a two-second arrival margin,
    // then mix absent source samples as silence so microphone ASR continues to progress.
    const available = final ? Math.max(...lengths) : Math.max(Math.min(...lengths), Math.max(...lengths) - RATE * 2);
    let from = state.segments.at(-1)?.endFrame || 0;
    while (available - from >= segmentFrames || final && available > from) {
      const end = Math.min(from + segmentFrames, available);
      state.segments.push({ index: state.segments.length, startFrame: from, endFrame: end,
        status: "pending", attempts: 0, nextAttempt: 0, text: "" });
      from = end;
    }
  }

  async function pump(final = false) {
    if (pumpPromise) { await pumpPromise; if (!final) return; }
    if (!state) return;
    pumpPromise = (async () => {
      for (const track of Object.keys(state.tracks)) await ingestTrack(track, final);
      queueSegments(final);
      await persist();
      emit();
    })();
    try { await pumpPromise; } finally { pumpPromise = null; }
  }

  function settleStatus() {
    if (state.recording || state.status === "interrupted") return;
    if (state.finalizationPending) { state.status = "needs_retry"; return; }
    const pending = state.segments.some(s => s.status === "pending" || s.status === "running");
    state.status = pending ? "stopping" : state.segments.some(s => s.status === "failed") ? "needs_retry" : "completed";
  }

  function runWorker() {
    if (workerPromise || !state || closing || !request) return;
    if (!state.segments.some(s => s.status === "pending" && s.nextAttempt <= now())) return;
    const current = state;
    workerPromise = (async () => {
      while (!closing && current === state) {
        const segment = current.segments.find(s => s.status === "pending" && s.nextAttempt <= now());
        if (!segment) break;
        segment.status = "running";
        segment.attempts++;
        await persist();
        emit();
        controller = new AbortController();
        const revision = segment.revision || 0;
        try {
          const wav = await readMixed(current.audioPaths, segment.startFrame, segment.endFrame);
          let energy = 0;
          for (let i = 44; i < wav.length; i += 2) energy += Math.abs(wav.readInt16LE(i));
          const result = energy === 0 ? { text: "" } : await request({
            audioDataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
            signal: controller.signal, segmentIndex: segment.index
          });
          if (closing) throw new Error("shutdown");
          const text = typeof result === "string" ? result : result?.text;
          if (typeof text !== "string" || text.length > 30000) throw new Error("live_response_invalid");
          segment.text = revision === (segment.revision || 0) ? text.trim() : "";
          segment.status = revision === (segment.revision || 0) ? "completed" : "pending";
          if (current.error?.code === "live_asr_failed") current.error = null;
        } catch (error) {
          segment.status = closing || segment.attempts < maxAttempts ? "pending" : "failed";
          segment.nextAttempt = now() + retryBaseMs * 2 ** Math.min(segment.attempts - 1, 5);
          current.error = safeError(error, "live_asr_failed");
        } finally { controller = null; }
        settleStatus();
        await persist();
        await publishRaw();
        emit();
      }
      settleStatus();
      await persist();
      if (!current.recording) await saveMarkdown();
    })().catch(error => { if (state) { state.error = safeError(error, "live_audio_failed"); emit(); } })
      .finally(() => { workerPromise = null; });
  }

  function timers() {
    clearInterval(pumpTimer); clearInterval(saveTimer);
    pumpTimer = setInterval(() => {
      if (state?.recording) {
        pump().then(() => runWorker()).catch(error => { state.error = safeError(error, "live_audio_failed"); emit(); });
        const lifecycle = captureService.getLifecycle?.();
        if (lifecycle?.status === "faulted") void stop().catch(() => {});
      } else runWorker();
    }, pumpIntervalMs);
    saveTimer = setInterval(() => { void saveMarkdown().catch(() => {}); }, saveIntervalMs);
    pumpTimer.unref?.(); saveTimer.unref?.();
  }

  function transition(fn) {
    if (transitionPromise) return transitionPromise;
    transitionPromise = fn().finally(() => { transitionPromise = null; });
    return transitionPromise;
  }

  async function start(options = {}) {
    return transition(async () => {
      if (state?.recording) return status();
      if (workerPromise || cleanupPromise || state?.status === "stopping" || state?.finalizationPending
        || state?.error?.code === "live_save_failed") throw new Error("live_busy");
      if (["recording", "paused"].includes(captureService.getLifecycle?.()?.status)) throw new Error("capture_already_running");
      clearInterval(pumpTimer); clearInterval(saveTimer);
      if (pumpPromise) await pumpPromise;
      await saveTail.catch(() => {});
      await persistTail;
      const settings = structuredClone(getSettings());
      const modelId = options.modelId || settings.meetingRealtimeModel || "mimo-v2.5-asr";
      const profile = transcribeImpl ? { provider: "mimo", modelId } : profileFor(settings, modelId);
      request = transcribeImpl || transcriber(profile);
      closing = false;
      await store.init();
      const created = await captureService.createAndPrepareSession({ title: options.title || "会议实时转录" });
      const saved = await store.readSession(created.sessionId);
      sessionDir = saved.sessionDir;
      const markdownPath = await reserveMarkdown(options.destinationPath || settings.meetingRealtimeDestination,
        defaultDirectory, created.sessionId, { reuseExisting: true });
      state = { schema: "meeting_live_v1", sessionId: created.sessionId, title: options.title || "会议实时转录",
        startedAtMs: now(), status: "starting", recording: false, modelId, provider: profile.provider,
        captureMode: options.captureMode === "microphone" ? "microphone" : "dual",
        markdownPath, audioPaths: [], tracks: {}, segments: [], error: null, cleanupStatus: "idle" };
      for (const track of state.captureMode === "dual" ? ["microphone", "system"] : ["microphone"]) {
        const file = path.join(sessionDir, "realtime", `${track}-complete.wav`);
        await ensureWave(file);
        state.audioPaths.push(file);
        state.tracks[track] = { path: file, seq: 0, frames: 0, indexOffset: 0 };
      }
      await persist();
      await saveMarkdown({ strict: true });
      try {
        const result = state.captureMode === "dual"
          ? await captureService.startDual(state.sessionId, { deviceId: settings.meetingMicrophoneDeviceId, systemDeviceId: settings.meetingSystemDeviceId })
          : await captureService.startMicrophone(state.sessionId, { deviceId: settings.meetingMicrophoneDeviceId });
        if (result?.ok === false) throw new Error("capture_failed");
        state.recording = true; state.status = "recording";
        await store.updateSession(state.sessionId, { mode: "meeting_realtime" });
        await persist(); timers(); emit(); return status();
      } catch (error) {
        state.status = "failed"; state.error = safeError(error, "live_capture_failed");
        await persist(); emit(); throw Object.assign(new Error(state.error.message), { code: state.error.code });
      }
    });
  }

  async function stop() {
    // A stop pressed during permission/start waits and then stops the newly started capture.
    if (transitionPromise) await transitionPromise;
    return transition(async () => {
      if (!state || !state.recording && !state.finalizationPending) return status();
      state.status = "stopping"; emit();
      const result = state.recording ? await captureService.stop(state.sessionId).catch(error => ({ ok: false, error })) : { ok: true };
      if (result?.ok === false) {
        if (captureService.getLifecycle?.()?.status === "faulted") {
          // The native helper has stopped delivering audio. Drain its committed
          // files only after shutdown, so unfinished tails are no longer being written.
          await captureService.shutdown();
          state.error = safeError(result.error, "live_capture_failed");
        } else {
          state.error = safeError(result.error, "live_stop_failed"); await persist(); emit(); return status();
        }
      }
      state.recording = false;
      await finalize(); runWorker(); emit(); return status();
    });
  }

  async function finalize() {
    state.finalizationPending = true;
    await persist();
    try {
      await pump(true);
      await publishRaw();
      if (["live_audio_failed", "live_stop_failed"].includes(state.error?.code)) state.error = null;
      state.finalizationPending = false;
      settleStatus();
      await saveMarkdown({ strict: true });
      await persist();
    } catch (error) {
      state.finalizationPending = true;
      state.status = "needs_retry";
      state.error = error.code === "live_save_failed" ? safeError(error, "live_save_failed") : safeError(error, "live_audio_failed");
      await persist(); emit();
      throw Object.assign(new Error(state.error.message), { code: state.error.code });
    }
  }

  async function refreshHistory() {
    await store.init();
    const names = await fs.readdir(store.sessionsRoot);
    const list = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
      const s = await readJson(path.join(store.sessionsRoot, name, "realtime", "state.json")).catch(() => null);
      if (s?.schema === "meeting_live_v1") list.push({ sessionId: name, title: s.title, status: s.recording ? "interrupted" : s.status, startedAtMs: s.startedAtMs });
    }
    history = list.sort((a, b) => b.startedAtMs - a.startedAtMs);
  }

  async function recover({ sessionId } = {}) {
    if (state?.recording || workerPromise || cleanupPromise || transitionPromise) return status();
    return transition(async () => {
      clearInterval(pumpTimer); clearInterval(saveTimer);
      if (pumpPromise) await pumpPromise;
      await saveTail.catch(() => {});
      await persistTail;
      await refreshHistory();
      const id = sessionId || history[0]?.sessionId;
      if (!id) return status();
      if (!history.some(s => s.sessionId === id)) throw new Error("live_session_invalid");
      const saved = await store.readSession(id);
      sessionDir = saved.sessionDir;
      state = await readJson(stateFile());
      const interrupted = state.recording || ["starting", "stopping"].includes(state.status);
      state.recording = false;
      if (interrupted) state.status = "interrupted";
      if (state.cleanupStatus === "running") state.cleanupStatus = "failed";
      for (const segment of state.segments) if (segment.status === "running") segment.status = "pending";
      for (const [track, t] of Object.entries(state.tracks)) {
        if (!["microphone", "system"].includes(track)) throw new Error("live_track_invalid");
        t.path = path.join(sessionDir, "realtime", `${track}-complete.wav`);
        await ensureWave(t.path);
        await repairWave(t.path);
      }
      state.audioPaths = Object.values(state.tracks).map(t => t.path);
      request = null;
      try { await finalize(); } catch { /* Leave a visible recoverable finalization error. */ }
      emit(); return status();
    });
  }

  async function retry(options = {}) {
    if (options.sessionId && options.sessionId !== state?.sessionId) await recover(options);
    if (!state || state.recording || workerPromise || cleanupPromise) return status();
    if (state.error?.code === "live_save_failed") {
      // Explicit retry may use a new default output when an external edit, a
      // disconnected volume or permissions prevent updating the selected note.
      state.markdownPath = await reserveMarkdown(null, defaultDirectory, `${state.sessionId}-recovered-${now()}`);
      state.markdownDigest = null;
      state.markdownBlockDigest = null;
    }
    for (const segment of state.segments) {
      if (segment.status !== "completed") { segment.status = "pending"; segment.attempts = 0; segment.nextAttempt = 0; }
    }
    state.error = null; state.status = "stopping"; closing = false;
    await finalize();
    if (state.segments.some(segment => segment.status !== "completed")) {
      try { request = transcribeImpl || transcriber(profileFor(getSettings(), state.modelId)); }
      catch (error) {
        state.status = "needs_retry"; state.error = safeError(error, "live_asr_failed");
        await persist(); emit(); return status();
      }
    }
    timers(); runWorker(); return status();
  }

  async function cleanup({ sessionId, modelId } = {}) {
    if (sessionId && sessionId !== state?.sessionId) await recover({ sessionId });
    if (!state || state.recording || state.finalizationPending || workerPromise || cleanupPromise || state.segments.some(s => s.status !== "completed")) throw new Error("live_cleanup_not_ready");
    const settings = structuredClone(getSettings());
    const model = modelId || settings.meetingAnalysisModel || settings.cleanerModel || "gpt-5.4-mini";
    const cleanProfile = cleanImpl ? { provider: "test", baseUrl: "" } : profileFor(settings, model, true);
    const clean = cleanImpl || cleaner(cleanProfile);
    const chunks = [];
    let text = "";
    for (const s of state.segments) {
      for (let offset = 0; offset < s.text.length; offset += 3000) {
        const part = s.text.slice(offset, offset + 3000);
        if (text.length + part.length > 3000) { chunks.push(text); text = ""; }
        text += `${text ? "\n\n" : ""}${part}`;
      }
    }
    if (text) chunks.push(text);
    if (!chunks.length) throw new Error("live_no_text");
    state.cleanupModelId = model; state.cleanupStatus = "running";
    state.cleanupProgress = { completed: 0, total: chunks.length };
    state.correctedText = "";
    cleanupController = new AbortController();
    await persist(); emit();
    cleanupPromise = (async () => {
      const results = [];
      for (let i = 0; i < chunks.length; i++) {
        const key = digest(JSON.stringify(["live_cleanup_v1", cleanProfile.provider, cleanProfile.baseUrl, model, chunks[i]]));
        const cachePath = path.join(sessionDir, "realtime", "cleanup", `${key}.json`);
        const cache = await readJson(cachePath);
        const cleaned = cache?.text ?? await clean(chunks[i], cleanupController.signal);
        if (cleanupController.signal.aborted) throw new Error("cleanup_cancelled");
        await atomicWrite(cachePath, JSON.stringify({ text: cleaned }));
        results.push(cleaned);
        state.correctedText = results.join("\n\n");
        state.cleanupProgress.completed = i + 1;
        await persist(); emit();
      }
      const preferred = `${state.markdownPath.slice(0, -3)}.cleaned.md`;
      const destination = await reserveMarkdown(preferred, defaultDirectory, `${state.sessionId}-${now()}`);
      await atomicWrite(destination, `# ${state.title} · 清理文本\n\n${state.correctedText}\n`);
      state.cleanedMarkdownPath = destination;
      state.cleanupStatus = "completed"; state.error = null;
    })().catch(error => { state.cleanupStatus = "failed"; state.error = safeError(error, "live_cleanup_failed"); })
      .finally(async () => { await persist(); emit(); cleanupPromise = null; cleanupController = null; });
    return status();
  }

  async function shutdown() {
    closing = true;
    controller?.abort(); cleanupController?.abort();
    clearInterval(pumpTimer); clearInterval(saveTimer);
    if (transitionPromise) await transitionPromise;
    if (state?.recording || state?.finalizationPending) await stop();
    if (state?.recording) throw Object.assign(new Error("Capture stop not confirmed"), { code: "live_stop_failed" });
    if (workerPromise) await workerPromise;
    if (cleanupPromise) await cleanupPromise;
    await persistTail.catch(() => {});
    if (state) await saveMarkdown({ strict: true });
  }

  return { start, stop, retry, cleanup, status, recover, shutdown,
    // Deterministic timer-independent regression probes, no IPC exposure.
    flush: async () => { await pump(!state?.recording); await saveMarkdown(); runWorker(); },
    waitForIdle: async () => { await workerPromise; await cleanupPromise; } };
}

module.exports = { createRealtimeMeetingService };
