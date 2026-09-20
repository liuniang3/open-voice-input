"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { RATE, HEADER_BYTES, normalizeChunk, ensureWave, writePcm, repairWave, readMixed } = require("./audio");
const { atomicWrite, readJson, reserveMarkdown, markdown } = require("./storage");
const {
  profileFor,
  transcriber,
  cleaner,
  previewProfileFor,
  meetingTransportFor,
  DEFAULT_LIVE_MODEL,
  MIMO_BATCH_MODEL,
  languageModel
} = require("./providers");
const { RAW_TRANSCRIPT_REL } = require("../analysis/constants");

function createRealtimeMeetingService({ captureService, getSettings = () => ({}), defaultDirectory,
  onUpdate = () => {}, transcribeImpl, cleanImpl, previewStreamImpl, reviewImpl, llmImpl, now = Date.now, pumpIntervalMs = 1000,
  saveIntervalMs = 30000, segmentSeconds = 30, retryBaseMs = 2000, maxAttempts = 3 } = {}) {
  if (!captureService?.store || !defaultDirectory) throw new Error("live_dependencies_missing");
  const store = captureService.store;
  const boundedInterval = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  const defaultTranscriptionIntervalSeconds = boundedInterval(segmentSeconds, 30, 1, 30);
  const defaultSaveIntervalSeconds = boundedInterval(saveIntervalMs / 1000, 30, 0.01, 300);
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
  let preview = null;
  let liveProfile = null;

  function isStreaming() { return state?.transport === "ali-streaming"; }
  function audioFrames(final = false) {
    const lengths = Object.values(state.tracks).map(t => t.frames);
    return final ? Math.max(0, ...lengths) : Math.max(0, Math.min(...lengths), Math.max(...lengths) - RATE * 2);
  }
  function syncPreview() {
    if (!preview || !isStreaming()) return;
    const snapshot = preview.snapshot();
    if (JSON.stringify(state.segments) !== JSON.stringify(snapshot.segments)
      && (state.correctedText || state.summary)) {
      // Retry can replace the source transcript. Previous exported files remain intact.
      state.correctedText = ""; state.reviewedText = "";
      state.cleanedMarkdownPath = ""; state.reviewedMarkdownPath = "";
      state.summary = null; state.summaryMarkdownPath = "";
      state.cleanupStatus = "idle"; state.postprocessStatus = "idle";
    }
    state.segments = snapshot.segments;
    state.previewText = snapshot.previewText;
    state.previewStatus = snapshot.status;
    state.previewFailed = snapshot.failedSegments || 0;
    state.previewPending = snapshot.pendingSegments || 0;
  }
  function createPreview() {
    const current = state;
    const { createMeetingPreview } = require("./preview");
    preview = createMeetingPreview({ state: current, now,
      readAudio: (start, end) => readMixed(current.audioPaths, start, end),
      createStream: (callbacks) => {
        const profile = liveProfile || previewProfileFor(getSettings(), current.modelId);
        const factory = previewStreamImpl || require("../../providers/asr/ali-meeting-stream").createAliMeetingStream;
        return factory({ ...profile, ...callbacks });
      },
      persist,
      onChange: () => {
        if (state !== current) return;
        syncPreview(); emit();
      }
    });
    syncPreview();
  }

  function safeError(error, fallback) {
    // Provider error bodies can contain credentials or transcript data. Never persist them.
    const allowed = new Set(["live_credentials_missing", "live_model_unsupported", "live_cleanup_validation_failed"]);
    return { code: allowed.has(error?.code) ? error.code : fallback,
      message: allowed.has(error?.code) ? error.message : {
        live_audio_failed: "音频归档暂时失败，原始录音片段仍保留。请检查磁盘空间并重试。",
        live_save_failed: "Markdown 保存失败，请检查目标目录权限或磁盘空间；本机会话记录仍保留。",
        live_asr_failed: "转写请求失败，音频已保留；请检查模型配置或网络并重试。",
        live_cleanup_failed: "清理失败，原始文本和音频未改变。可检查模型配置后重试。",
        live_summary_failed: "摘要生成失败，已有文本和音频未改变。可检查模型配置后重试。",
        live_capture_failed: "录音启动或采集失败，请检查麦克风、系统音频权限及音频设备。",
        live_stop_failed: "录音停止尚未确认，请再次停止；已保存的音频仍保留。"
      }[fallback] || "操作失败，已有录音与文本保留在本机会话目录。" };
  }

  function status() {
    if (!state) return { status: "idle", recording: false, rawText: "", correctedText: "", audioPaths: [], recoverableSessions: history };
    return {
      sessionId: state.sessionId, title: state.title, status: state.status, recording: state.recording,
      paused: Boolean(state.paused), previewText: state.previewText || "", previewStatus: state.previewStatus || "idle",
      finalizationPending: Boolean(state.finalizationPending),
      modelId: state.modelId, transport: state.transport, captureMode: state.captureMode, startedAtMs: state.startedAtMs,
      transcriptionIntervalSeconds: state.transcriptionIntervalSeconds,
      saveIntervalSeconds: state.saveIntervalSeconds,
      durationMs: Math.round(Math.max(0, ...Object.values(state.tracks).map(t => t.frames)) * 1000 / RATE),
      rawText: state.segments.filter(s => s.status === "completed").map(s => s.text).filter(Boolean).join("\n\n"),
      correctedText: state.correctedText || "", markdownPath: state.markdownPath,
      reviewedText: state.reviewedText || "", reviewedMarkdownPath: state.reviewedMarkdownPath || "",
      summary: state.summary || null, summaryMarkdownPath: state.summaryMarkdownPath || "",
      postprocessStatus: state.postprocessStatus || "idle", postprocessProgress: state.postprocessProgress || {},
      cleanedMarkdownPath: state.cleanedMarkdownPath || "", audioPaths: [...state.audioPaths],
      pendingSegments: isStreaming() ? state.previewPending || 0 : state.segments.filter(s => s.status === "pending" || s.status === "running").length,
      failedSegments: isStreaming() ? state.previewFailed || 0 : state.segments.filter(s => s.status === "failed").length,
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
          if (isStreaming()) preview?.invalidate(start, start + pcm.length / 2);
          await writePcm(t.path, pcm, start);
          // An endpoint can deliver late audio after we previewed its interval as
          // silence. Invalidate exactly those windows; never silently lose late speech.
          for (const segment of isStreaming() ? [] : state.segments) {
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
        if (isStreaming()) preview?.invalidate(t.frames, t.frames + pcm.length / 2);
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
        if (isStreaming()) preview?.invalidate(t.frames, t.frames + pcm.length / 2);
        await writePcm(t.path, pcm, t.frames);
        t.frames += pcm.length / 2;
        t.partRecovered = true;
      }
    }
  }

  function queueSegments(final) {
    if (isStreaming()) return;
    const segmentFrames = boundedInterval(
      state.transcriptionIntervalSeconds,
      defaultTranscriptionIntervalSeconds,
      1,
      30
    ) * RATE;
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
      if (isStreaming() && !final && !state.paused) preview?.kick(audioFrames());
      emit();
    })();
    try { await pumpPromise; } finally { pumpPromise = null; }
  }

  function settleStatus() {
    if (state.recording || state.status === "interrupted") return;
    if (state.finalizationPending) { state.status = "needs_retry"; return; }
    if (isStreaming()) {
      syncPreview();
      state.status = state.previewFailed ? "needs_retry" : "completed";
      return;
    }
    const pending = state.segments.some(s => s.status === "pending" || s.status === "running");
    state.status = pending ? "stopping" : state.segments.some(s => s.status === "failed") ? "needs_retry" : "completed";
  }

  function runWorker() {
    if (isStreaming()) return;
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
    const currentSaveIntervalMs = boundedInterval(
      state?.saveIntervalSeconds,
      defaultSaveIntervalSeconds,
      0.01,
      300
    ) * 1000;
    saveTimer = setInterval(() => { void saveMarkdown().catch(() => {}); }, currentSaveIntervalMs);
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
      const modelId = options.modelId || (transcribeImpl ? settings.meetingRealtimeModel || MIMO_BATCH_MODEL : settings.meetingRealtimeModel || DEFAULT_LIVE_MODEL);
      const transport = previewStreamImpl ? "ali-streaming"
        : transcribeImpl ? "mimo-batch" : meetingTransportFor(modelId);
      if (!transport) throw Object.assign(new Error("所选模型不支持会议转写"), { code: "live_model_unsupported" });
      const streaming = transport === "ali-streaming";
      const profile = streaming
        ? (previewStreamImpl ? { provider: "aliyun-streaming", model: modelId } : previewProfileFor(settings, modelId))
        : (transcribeImpl ? { provider: "mimo", modelId } : profileFor(settings, modelId));
      liveProfile = streaming ? profile : null;
      request = streaming ? null : transcribeImpl || transcriber(profile);
      await preview?.shutdown(); preview = null;
      closing = false;
      await store.init();
      const created = await captureService.createAndPrepareSession({ title: options.title || "会议实时转录" });
      const saved = await store.readSession(created.sessionId);
      sessionDir = saved.sessionDir;
      const markdownPath = await reserveMarkdown(options.destinationPath || settings.meetingRealtimeDestination,
        defaultDirectory, created.sessionId, { reuseExisting: true });
      state = { schema: "meeting_live_v1", sessionId: created.sessionId, title: options.title || "会议实时转录",
        startedAtMs: now(), status: "starting", recording: false, modelId, provider: profile.provider,
        transport, paused: false,
        transcriptionIntervalSeconds: boundedInterval(
          options.transcriptionIntervalSeconds ?? settings.meetingTranscriptionIntervalSeconds,
          defaultTranscriptionIntervalSeconds,
          1,
          30
        ),
        saveIntervalSeconds: boundedInterval(
          options.saveIntervalSeconds ?? settings.meetingAutosaveIntervalSeconds,
          defaultSaveIntervalSeconds,
          0.01,
          300
        ),
        captureMode: ["microphone", "system"].includes(options.captureMode) ? options.captureMode : "dual",
        markdownPath, audioPaths: [], tracks: {}, segments: [], error: null, cleanupStatus: "idle" };
      for (const track of state.captureMode === "dual" ? ["microphone", "system"] : [state.captureMode]) {
        const file = path.join(sessionDir, "realtime", `${track}-complete.wav`);
        await ensureWave(file);
        state.audioPaths.push(file);
        state.tracks[track] = { path: file, seq: 0, frames: 0, indexOffset: 0 };
      }
      await persist();
      if (streaming) createPreview();
      await saveMarkdown({ strict: true });
      try {
        const result = state.captureMode === "dual"
          ? await captureService.startDual(state.sessionId, { deviceId: settings.meetingMicrophoneDeviceId, systemDeviceId: settings.meetingSystemDeviceId })
          : state.captureMode === "system"
            ? await captureService.startSystem(state.sessionId, { systemDeviceId: settings.meetingSystemDeviceId })
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
      state.paused = false;
      await finalize(); runWorker(); emit(); return status();
    });
  }

  async function pause() {
    if (transitionPromise) await transitionPromise;
    return transition(async () => {
      if (!state?.recording || state.paused) return status();
      const result = await captureService.pause(state.sessionId);
      if (result?.ok === false) throw new Error("live_pause_failed");
      state.paused = true; state.status = "paused";
      await pump();
      if (preview) { await preview.drain(audioFrames(true)); syncPreview(); }
      await publishRaw(); await saveMarkdown({ strict: true }); emit();
      return status();
    });
  }

  async function resume() {
    if (transitionPromise) await transitionPromise;
    return transition(async () => {
      if (!state?.recording || !state.paused) return status();
      const result = await captureService.resume(state.sessionId);
      if (result?.ok === false) throw new Error("live_resume_failed");
      state.paused = false; state.status = "recording";
      await persist(); emit(); return status();
    });
  }

  async function finalize({ recovery = false } = {}) {
    state.finalizationPending = true;
    await persist();
    try {
      await pump(true);
      if (isStreaming() && preview) {
        if (recovery) await preview.recover(audioFrames(true));
        else await preview.drain(audioFrames(true));
        syncPreview();
      }
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
      if (s?.schema !== "meeting_live_v1") continue;
      const durationFrames = Math.max(0, ...Object.values(s.tracks || {}).map(track => Number(track?.frames) || 0));
      list.push({
        sessionId: name,
        title: String(s.title || "会议实时转录").slice(0, 200),
        status: s.recording ? "interrupted" : s.status,
        startedAtMs: Number(s.startedAtMs) || 0,
        durationMs: Math.round(durationFrames * 1000 / RATE),
        modelId: String(s.modelId || "").slice(0, 256),
        hasTranscript: Array.isArray(s.segments) && s.segments.some(segment => segment?.status === "completed" && String(segment.text || "").trim()),
        hasCorrection: Boolean(String(s.correctedText || "").trim()),
        hasSummary: Boolean(s.summary)
      });
    }
    history = list.sort((a, b) => b.startedAtMs - a.startedAtMs);
  }

  async function prepareSessionSwitch() {
    clearInterval(pumpTimer); clearInterval(saveTimer);
    if (pumpPromise) await pumpPromise;
    await saveTail.catch(() => {});
    await persistTail;
    await preview?.shutdown();
    preview = null;
    liveProfile = null;
  }

  async function loadHistorySession(id) {
    const saved = await store.readSession(id);
    sessionDir = saved.sessionDir;
    const loaded = await readJson(stateFile());
    if (loaded?.schema !== "meeting_live_v1" || !Array.isArray(loaded.segments)
      || !loaded.tracks || typeof loaded.tracks !== "object") throw new Error("live_session_invalid");
    state = loaded;
    state.sessionId = id;
    state.transport ||= meetingTransportFor(state.modelId) || "mimo-batch";
    state.transcriptionIntervalSeconds = boundedInterval(
      state.transcriptionIntervalSeconds,
      defaultTranscriptionIntervalSeconds,
      1,
      30
    );
    state.saveIntervalSeconds = boundedInterval(
      state.saveIntervalSeconds,
      defaultSaveIntervalSeconds,
      0.01,
      300
    );
    const interrupted = state.recording || ["starting", "stopping"].includes(state.status);
    state.recording = false;
    state.paused = false;
    if (interrupted) state.status = "interrupted";
    if (state.cleanupStatus === "running") state.cleanupStatus = "failed";
    if (state.postprocessStatus === "running") state.postprocessStatus = "failed";
    for (const segment of state.segments) if (segment.status === "running") segment.status = "pending";
    for (const [track, value] of Object.entries(state.tracks)) {
      if (!["microphone", "system"].includes(track)) throw new Error("live_track_invalid");
      value.path = path.join(sessionDir, "realtime", `${track}-complete.wav`);
      await ensureWave(value.path);
      await repairWave(value.path);
    }
    state.audioPaths = Object.values(state.tracks).map(track => track.path);
    request = null;
    if (isStreaming()) createPreview();
  }

  async function listHistory() {
    await refreshHistory();
    return status();
  }

  async function openHistory({ sessionId } = {}) {
    if (state?.recording || workerPromise || cleanupPromise || transitionPromise) return status();
    return transition(async () => {
      await prepareSessionSwitch();
      await refreshHistory();
      const id = String(sessionId || "");
      if (!id || !history.some(item => item.sessionId === id)) throw new Error("live_session_invalid");
      await loadHistorySession(id);
      emit();
      return status();
    });
  }

  async function recover({ sessionId } = {}) {
    if (state?.recording || workerPromise || cleanupPromise || transitionPromise) return status();
    return transition(async () => {
      await prepareSessionSwitch();
      await refreshHistory();
      const id = sessionId || history[0]?.sessionId;
      if (!id) return status();
      if (!history.some(s => s.sessionId === id)) throw new Error("live_session_invalid");
      await loadHistorySession(id);
      try { await finalize({ recovery: true }); } catch { /* Leave a visible recoverable finalization error. */ }
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
    if (isStreaming()) {
      workerPromise = (async () => {
        try { await preview.retry(); syncPreview(); await publishRaw(); }
        catch (error) { state.error = safeError(error, "live_asr_failed"); }
        finally { syncPreview(); settleStatus(); await persist(); await saveMarkdown(); emit(); }
      })().finally(() => { workerPromise = null; });
      return status();
    }
    if (state.segments.some(segment => segment.status !== "completed")) {
      try { request = transcribeImpl || transcriber(profileFor(getSettings(), state.modelId)); }
      catch (error) {
        state.status = "needs_retry"; state.error = safeError(error, "live_asr_failed");
        await persist(); emit(); return status();
      }
    }
    timers(); runWorker(); return status();
  }

  async function legacyCleanup({ sessionId, modelId } = {}) {
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

  async function runPostprocess(kind, options = {}) {
    if (options.sessionId && options.sessionId !== state?.sessionId) await recover(options);
    if (!state || state.recording || state.finalizationPending || workerPromise || cleanupPromise || transitionPromise) throw new Error("live_cleanup_not_ready");
    if (state.segments.some(s => ["running", "pending"].includes(s.status))) throw new Error("live_cleanup_not_ready");
    const current = state;
    const settings = structuredClone(getSettings());
    const modelId = options.modelId || settings.meetingAnalysisModel || settings.cleanerModel || "gpt-5.4-mini";
    const modelProfile = llmImpl ? { provider: "test", modelId } : profileFor(settings, modelId, true);
    const call = llmImpl || languageModel(modelProfile);
    const providerRequestTimeoutMs = Number.isFinite(Number(modelProfile.requestTimeoutMs))
      && Number(modelProfile.requestTimeoutMs) > 0
      ? Math.floor(Number(modelProfile.requestTimeoutMs))
      : 90000;
    const taskRequestTimeoutMs = providerRequestTimeoutMs + Math.max(5000, Math.ceil(providerRequestTimeoutMs * 0.05));
    const maxOutputTokens = Number.isFinite(Number(modelProfile.maxOutputTokens))
      && Number(modelProfile.maxOutputTokens) > 0
      ? Math.floor(Number(modelProfile.maxOutputTokens))
      : 8192;
    const failureCode = kind === "summary" ? "live_summary_failed" : "live_cleanup_failed";
    const useMimoReview = kind === "reconcile" && options.useMimoReview === true;
    const reviewModelId = options.reviewModelId || "mimo-v2.5-asr";
    if (useMimoReview && !/^mimo-.*asr/i.test(reviewModelId)) throw new Error("live_model_unsupported");
    const reviewProfile = useMimoReview && !reviewImpl ? profileFor(settings, reviewModelId) : null;
    const review = useMimoReview ? reviewImpl || transcriber(reviewProfile) : null;
    const { createMeetingPostprocessService } = require("./postprocess");
    const processor = createMeetingPostprocessService({ sessionDir, getState: () => current,
      audio: {
        readMixed: ({ startFrame, endFrame }) => readMixed(current.audioPaths, startFrame, endFrame),
        findPause: async ({ minFrame, endFrame }) => {
          const wav = await readMixed(current.audioPaths, minFrame, endFrame);
          // Select a quiet 300 ms interval near the boundary; never remove its samples.
          const block = Math.round(RATE * 0.3);
          let best = null, bestEnergy = 180;
          for (let frame = 0; frame + block <= endFrame - minFrame; frame += Math.round(RATE * 0.1)) {
            let sum = 0;
            for (let i = frame; i < frame + block; i++) sum += Math.abs(wav.readInt16LE(44 + i * 2));
            const mean = sum / block;
            if (mean <= bestEnergy) { bestEnergy = mean; best = minFrame + frame + Math.floor(block / 2); }
          }
          return best;
        }
      },
      asr: review ? { modelId: reviewModelId, revision: digest(JSON.stringify([reviewProfile?.provider, reviewProfile?.baseUrl])),
        limits: { maxSeconds: 30, maxBytes: 2 * 1024 * 1024 },
        transcribe: ({ audio, signal, segmentIndex }) => review({ audioDataUrl: `data:audio/wav;base64,${audio.toString("base64")}`, signal, segmentIndex }) } : null,
      llm: { modelId, revision: digest(JSON.stringify([modelProfile.provider, modelProfile.baseUrl])),
        complete: ({ messages, signal }) => call({ messages, signal, maxTokens: maxOutputTokens }) },
      limits: { maxRequestsPerRun: 1000, requestTimeoutMs: taskRequestTimeoutMs },
      onUpdate: (update) => {
        current.postprocessStatus = update.status;
        current.postprocessProgress = { ...update.progress, kind };
        if (kind === "reconcile") { current.cleanupStatus = update.status; current.cleanupProgress = update.progress; }
        emit();
      }
    });
    cleanupController = new AbortController();
    const signal = cleanupController.signal;
    current.cleanupModelId = modelId; current.postprocessStatus = "running";
    if (kind === "reconcile") current.cleanupStatus = "running";
    cleanupPromise = Promise.resolve().then(async () => {
      await persist(); emit();
      const outcome = kind === "reconcile"
        ? await processor.reconcile({ reviewAudio: useMimoReview, retryFailed: true, signal })
        : await processor.summarize({ source: current.cleanupStatus === "completed" ? "reconciled" : "original", retryFailed: true, signal });
      if (outcome.status !== "completed" || !outcome.result) {
        current.postprocessStatus = "failed";
        if (kind === "reconcile") current.cleanupStatus = "failed";
        current.error = safeError(null, failureCode);
        return;
      }
      const result = outcome.result;
      const writeResult = async (suffix, text) => {
        const destination = await reserveMarkdown(`${current.markdownPath.slice(0, -3)}.${suffix}.md`, defaultDirectory, `${current.sessionId}-${now()}`);
        await atomicWrite(destination, text);
        return destination;
      };
      if (kind === "reconcile") {
        current.correctedText = result.items.map(item => `${item.text}${item.uncertain ? "\n[待确认：请对照原文与音频]" : ""}`).join("\n\n");
        current.reviewedText = (result.review || []).map(r => r.text).join("\n\n");
        current.reviewedMarkdownPath = useMimoReview ? await writeResult("reviewed", result.reviewedMarkdown) : "";
        current.cleanedMarkdownPath = await writeResult("cleaned", result.markdown);
        current.cleanupStatus = "completed";
        current.summary = null; current.summaryMarkdownPath = "";
      } else {
        const sections = result.sections.map(section => `## ${section.heading}\n\n${section.items.map(item => `- ${item.text}${item.uncertain ? "（待确认）" : ""}`).join("\n")}\n`).join("\n");
        current.summary = { mindmap: result.mindmap, sections: result.sections, markdown: sections, title: result.title };
        current.summaryMarkdownPath = await writeResult("summary", result.markdown);
      }
      current.postprocessStatus = "completed"; current.error = null;
    }).catch(error => {
      current.postprocessStatus = "failed";
      if (kind === "reconcile") current.cleanupStatus = "failed";
      current.error = safeError(error, failureCode);
    }).finally(async () => {
      try { await persist(); } finally { cleanupPromise = null; cleanupController = null; emit(); }
    });
    return status();
  }

  function cleanup(options = {}) {
    return cleanImpl && !isStreaming() ? legacyCleanup(options) : runPostprocess("reconcile", options);
  }
  function summarize(options = {}) { return runPostprocess("summary", options); }

  async function shutdown() {
    closing = true;
    controller?.abort(); cleanupController?.abort();
    clearInterval(pumpTimer); clearInterval(saveTimer);
    if (transitionPromise) await transitionPromise;
    if (state?.recording || state?.finalizationPending) await stop();
    if (state?.recording) throw Object.assign(new Error("Capture stop not confirmed"), { code: "live_stop_failed" });
    if (workerPromise) await workerPromise;
    if (cleanupPromise) await cleanupPromise;
    await preview?.shutdown();
    await persistTail.catch(() => {});
    if (state) await saveMarkdown({ strict: true });
  }

  return { start, stop, pause, resume, retry, cleanup, summarize, status, recover, listHistory, openHistory, shutdown,
    // Deterministic timer-independent regression probes, no IPC exposure.
    flush: async () => { await pump(!state?.recording); await saveMarkdown(); runWorker(); },
    waitForIdle: async () => { await preview?.waitForIdle(); await workerPromise; await cleanupPromise; } };
}

module.exports = { createRealtimeMeetingService };
