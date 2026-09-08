"use strict";

const path = require("node:path");
const { prepareTrackSegments, segmentToDataUrl } = require("./segment-prep");
const { createJobStore } = require("./job-store");
const { QWEN_NO_BUCKET, JOB_STATUS, SEGMENT_STATUS } = require("./constants");
const { SELF_SPEAKER_ID } = require("../timeline/merge-timeline");
const { verifyArchiveIntegrity } = require("../archive/export-track-wav");
const {
  sanitizeErrorMessage,
  sanitizeLogDetail,
  pickSafeProfile
} = require("./sanitize");

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("aborted");
    err.code = "aborted";
    throw err;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.code = "aborted";
      reject(err);
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      const err = new Error("aborted");
      err.code = "aborted";
      reject(err);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Build raw transcript. Qwen has no provider timestamps:
 * providerBeginMs/EndMs = null; artifact* preserved; begin/end prefer session time.
 */
function buildRawTranscriptFromJob(job, { resultsByKey = {}, limits = QWEN_NO_BUCKET, transcriptMeta = {} } = {}) {
  const meta = transcriptMeta && typeof transcriptMeta === "object" ? transcriptMeta : {};
  const remoteSpeakerId = limits.remoteSpeakerId || QWEN_NO_BUCKET.remoteSpeakerId;
  const items = [];
  for (const track of ["microphone", "system"]) {
    const segs = job.tracks?.[track]?.segments || [];
    for (const seg of segs) {
      if (seg.status !== SEGMENT_STATUS.COMPLETED) continue;
      const key = `${track}:${seg.seq}`;
      const result = resultsByKey[key];
      const text = String(result?.text ?? "").trim();
      if (!text) continue;
      const speakerId =
        track === "microphone" ? SELF_SPEAKER_ID : remoteSpeakerId;
      const sessionBegin = seg.sessionBeginMs ?? null;
      const sessionEnd = seg.sessionEndMs ?? null;
      const artifactBegin = seg.artifactBeginMs ?? null;
      const artifactEnd = seg.artifactEndMs ?? null;
      items.push({
        id: key,
        track,
        role: seg.role || (track === "microphone" ? "self" : "remote_mix_for_diarization"),
        speakerId,
        speakerLabel: speakerId,
        text,
        providerBeginMs: null,
        providerEndMs: null,
        artifactBeginMs: artifactBegin,
        artifactEndMs: artifactEnd,
        sessionBeginMs: sessionBegin,
        sessionEndMs: sessionEnd,
        // Shared session timeline preferred for ordering/display
        beginMs: sessionBegin ?? artifactBegin,
        endMs: sessionEnd ?? artifactEnd,
        qpcBegin: seg.qpcBegin ?? null,
        qpcEnd: seg.qpcEnd ?? null,
        timestampPrecision: "segment",
        timeline: "session_preferred_artifact_fallback",
        contentSha256: seg.contentSha256 || null,
        textSha256: result?.textSha256 || null,
        sourceIndex: seg.seq
      });
    }
  }

  items.sort((a, b) => {
    const as = a.sessionBeginMs ?? a.artifactBeginMs ?? 0;
    const bs = b.sessionBeginMs ?? b.artifactBeginMs ?? 0;
    if (as !== bs) return as - bs;
    if (a.track !== b.track) return a.track === "microphone" ? -1 : 1;
    return (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0);
  });

  return {
    schema: limits.transcriptSchema || QWEN_NO_BUCKET.transcriptSchema,
    sessionId: job.sessionId,
    generation: job.generation || 1,
    provider: job.provider || limits.provider,
    modelId: job.modelId,
    mode: meta.mode || limits.mode || "no_bucket",
    source: meta.source || null,
    sourceFileName: meta.sourceFileName || null,
    mediaKind: meta.mediaKind || null,
    importer: meta.importer || null,
    diarization: false,
    timestampPrecision: "segment",
    speakers: {
      microphone: SELF_SPEAKER_ID,
      system: remoteSpeakerId
    },
    policy: {
      remoteDiarization: false,
      providerTimestamps: false,
      timeline: "session_preferred_artifact_fallback",
      note:
        meta.note ||
        "No-bucket segment path has no remote speaker diarization and no provider word/sentence timestamps. System track is a single remote_unknown mix. Single-flight is in-process only (no cross-process lock).",
      ...meta
    },
    count: items.length,
    items
  };
}

function sourceFingerprint(sourceArtifacts, modelId, mode = "no_bucket", provider = null) {
  return JSON.stringify({
    mode: mode || "no_bucket",
    provider: provider || null,
    modelId: modelId || null,
    mic: sourceArtifacts?.microphone?.sourceWavSha256 || null,
    sys: sourceArtifacts?.system?.sourceWavSha256 || null,
    hasMic: Boolean(sourceArtifacts?.microphone),
    hasSys: Boolean(sourceArtifacts?.system)
  });
}

function createNoBucketMeetingTranscriptionService({
  sessionDir,
  sessionId = null,
  transcribeSegment,
  maxAttempts = 3,
  retryBackoffMs = 50,
  logger = () => {},
  limits = QWEN_NO_BUCKET,
  provider = limits.provider || QWEN_NO_BUCKET.provider,
  transcriptMeta = {},
  /** When true, run() still builds transcript in memory but does not write raw-transcript.json */
  skipTranscriptWrite = false
} = {}) {
  if (!sessionDir) {
    const error = new Error("sessionDir required");
    error.code = "invalid_argument";
    throw error;
  }
  if (typeof transcribeSegment !== "function") {
    const error = new Error("transcribeSegment function required");
    error.code = "invalid_argument";
    throw error;
  }

  const store = createJobStore({ sessionDir, workDirName: limits.workDirName });
  let paused = false;
  let runActive = false;

  function log(event, detail = {}) {
    logger({ event, ...sanitizeLogDetail(detail) });
  }

  async function prepare({ microphone, system, modelId = null, fingerprintMode = null } = {}) {
    if (runActive) {
      const error = new Error("cannot prepare while a run is active (in-process)");
      error.code = "job_already_running";
      throw error;
    }
    await store.init();

    const sourceArtifacts = {};
    const prepared = {};
    const fpMode =
      fingerprintMode || (skipTranscriptWrite ? "enhanced_mic" : "no_bucket");

    for (const [track, spec] of [
      ["microphone", microphone],
      ["system", system]
    ]) {
      if (!spec?.wavPath) continue;
      // Strict Stage 1A integrity — require contentSha256
      await verifyArchiveIntegrity({
        wavPath: spec.wavPath,
        sidecarPath: spec.sidecarPath,
        sidecar: spec.sidecar
      });

      const outDir = path.join(store.segmentsDir, track);
      const result = await prepareTrackSegments({
        wavPath: spec.wavPath,
        sidecarPath: spec.sidecarPath,
        sidecar: spec.sidecar,
        track,
        role: spec.role || (track === "microphone" ? "self" : "remote_mix_for_diarization"),
        outputDir: outDir,
        targetSegmentSeconds: limits.targetSegmentSeconds,
        targetSampleRate: limits.targetSampleRate,
        limits
      });
      sourceArtifacts[track] = {
        wavPath: spec.wavPath,
        sourceWavSha256: result.sourceWavSha256,
        segmentCount: result.segmentCount
      };
      prepared[track] = result.segments.map((s) => ({
        seq: s.seq,
        status: SEGMENT_STATUS.PENDING,
        wavPath: s.wavPath,
        metaPath: s.metaPath,
        contentSha256: s.contentSha256,
        artifactBeginMs: s.artifactBeginMs,
        artifactEndMs: s.artifactEndMs,
        sessionBeginMs: s.sessionBeginMs,
        sessionEndMs: s.sessionEndMs,
        qpcBegin: s.qpcBegin,
        qpcEnd: s.qpcEnd,
        role: s.role,
        durationSeconds: s.durationSeconds,
        attempts: 0,
        lastError: null,
        reusedPrep: Boolean(s.reused)
      }));
    }

    const existing = await store.loadJob();
    const fp = sourceFingerprint(sourceArtifacts, modelId, fpMode, provider);
    const prevMode = existing?.fingerprintMode
      || (existing?.transcriptDeferred ? "enhanced_mic" : "no_bucket");
    const prevFp = existing
      ? sourceFingerprint(existing.sourceArtifacts || {}, existing.modelId, prevMode, existing.provider)
      : null;
    let generation = existing?.generation || 1;
    const sourceChanged = existing && prevFp !== fp;
    if (sourceChanged) {
      generation = (existing.generation || 1) + 1;
    }

    // If completed with same source — keep completed (run will validate)
    if (
      existing &&
      existing.status === JOB_STATUS.COMPLETED &&
      !sourceChanged
    ) {
      return existing;
    }

    let job = await store.createJob({
      sessionId: sessionId || existing?.sessionId,
      provider,
      modelId,
      sourceArtifacts,
      generation,
      profile: pickSafeProfile({
        targetSegmentSeconds: limits.targetSegmentSeconds,
        maxBase64Chars: limits.maxBase64Chars,
        modelId
      })
    });

    job.tracks = job.tracks || {};
    for (const track of ["microphone", "system"]) {
      if (!prepared[track]) {
        job.tracks[track] = { segments: [], status: SEGMENT_STATUS.PENDING };
        continue;
      }
      const prevBySeq = new Map(
        !sourceChanged ? (existing?.tracks?.[track]?.segments || []).map((s) => [s.seq, s]) : []
      );
      job.tracks[track] = {
        status: SEGMENT_STATUS.PENDING,
        segments: prepared[track].map((seg) => {
          const prev = prevBySeq.get(seg.seq);
          if (
            prev &&
            prev.status === SEGMENT_STATUS.COMPLETED &&
            prev.contentSha256 === seg.contentSha256
          ) {
            return {
              ...seg,
              status: SEGMENT_STATUS.COMPLETED,
              attempts: prev.attempts || 0,
              hasResult: true
            };
          }
          return seg;
        })
      };
    }
    job.status = JOB_STATUS.READY;
    job.lastError = null;
    job.generation = generation;
    job.modelId = modelId || job.modelId;
    job.fingerprintMode = fpMode;
    job.transcriptMeta = transcriptMeta;
    job.transcriptDeferred = Boolean(skipTranscriptWrite);
    job = await store.saveJob(job);
    log("prepare_done", { sessionId, generation, tracks: Object.keys(prepared) });
    return job;
  }

  async function validateCompletedJob(job) {
    if (!job || job.status !== JOB_STATUS.COMPLETED) return { ok: false, code: "not_completed" };
    // Enhanced path defers authoritative raw-transcript.json; segment results still validate.
    if (!(skipTranscriptWrite || job.transcriptDeferred)) {
      const tr = await store.readTranscript().catch(() => null);
      if (!tr || !Array.isArray(tr.items)) {
        return { ok: false, code: "transcript_invalid" };
      }
    }
    for (const track of ["microphone", "system"]) {
      for (const seg of job.tracks?.[track]?.segments || []) {
        if (seg.status !== SEGMENT_STATUS.COMPLETED) continue;
        const v = await store.readValidatedSegmentResult(
          track,
          seg.seq,
          seg.contentSha256,
          job.generation
        );
        if (!v.ok) return { ok: false, code: v.code || "result_invalid", track, seq: seg.seq };
      }
    }
    return { ok: true };
  }

  async function run({ signal = null } = {}) {
    throwIfAborted(signal);
    if (runActive) {
      const error = new Error("job already running in this process");
      error.code = "job_already_running";
      throw error;
    }
    // Claim single-flight synchronously before any await (same-tick race).
    runActive = true;
    paused = false;
    try {
      // Recovery only when no other in-process run holds the flag
      let job = await store.recoverJob();
      if (!job) job = await store.loadJob();
      if (!job) {
        const error = new Error("no job — call prepare() first");
        error.code = "job_missing";
        throw error;
      }

      if (job.status === JOB_STATUS.COMPLETED) {
        const v = await validateCompletedJob(job);
        if (v.ok) return job;
        // Invalidate stale completed — demote bad segments then continue run
        for (const track of ["microphone", "system"]) {
          for (const seg of job.tracks?.[track]?.segments || []) {
            if (seg.status !== SEGMENT_STATUS.COMPLETED) continue;
            const vr = await store.readValidatedSegmentResult(
              track,
              seg.seq,
              seg.contentSha256,
              job.generation ?? 1
            );
            if (!vr.ok) {
              seg.status = SEGMENT_STATUS.PENDING;
              seg.hasResult = false;
              seg.attempts = 0;
              delete seg.recoveredFromRunning;
              seg.lastError = {
                code: vr.code || "result_invalid",
                message: sanitizeErrorMessage(`invalid result on completed check: ${vr.code}`)
              };
              log("segment_requeue_invalid_result", { track, seq: seg.seq, code: vr.code });
            }
          }
        }
        job.status = JOB_STATUS.READY;
        job.lastError = {
          code: v.code || "completed_invalid",
          message: sanitizeErrorMessage(`completed job failed validation: ${v.code}`)
        };
        job = await store.saveJob(job);
      }

      if (job.status === JOB_STATUS.CANCELLED) {
        const error = new Error(
          "job cancelled; call retryFailed({ resetAttempts: true }) before re-run"
        );
        error.code = "job_cancelled";
        throw error;
      }

      if (job.status === JOB_STATUS.FAILED) {
        const exhausted = hasExhaustedFailures(job, maxAttempts);
        if (exhausted) {
          const error = new Error(
            "job failed with exhausted attempts; call retryFailed({ resetAttempts: true }) to rebill"
          );
          error.code = "job_failed_exhausted";
          error.job = job;
          throw error;
        }
      }

      job.status = JOB_STATUS.RUNNING;
      job.attempts = (job.attempts || 0) + 1;
      job = await store.saveJob(job);

      for (const track of ["microphone", "system"]) {
        throwIfAborted(signal);
        while (paused) {
          throwIfAborted(signal);
          await sleep(20, signal);
        }
        const tstate = job.tracks[track];
        if (!tstate?.segments?.length) continue;

        for (const seg of tstate.segments) {
          throwIfAborted(signal);
          while (paused) {
            job.status = JOB_STATUS.PAUSED;
            job = await store.saveJob(job);
            await sleep(20, signal);
            if (!paused && job.status === JOB_STATUS.PAUSED) {
              job.status = JOB_STATUS.RUNNING;
              job = await store.saveJob(job);
            }
          }

          if (seg.status === SEGMENT_STATUS.COMPLETED) {
            const v = await store.readValidatedSegmentResult(
              track,
              seg.seq,
              seg.contentSha256,
              job.generation ?? 1
            );
            if (v.ok) continue;
            seg.status = SEGMENT_STATUS.PENDING;
            seg.hasResult = false;
            seg.attempts = 0;
            delete seg.recoveredFromRunning;
            seg.lastError = {
              code: v.code || "result_invalid",
              message: sanitizeErrorMessage(`invalid completed result: ${v.code}`)
            };
            log("segment_requeue_invalid_result", { track, seq: seg.seq, code: v.code });
          }

          if (seg.status === SEGMENT_STATUS.FAILED) {
            if ((seg.attempts || 0) >= maxAttempts) {
              continue;
            }
            seg.status = SEGMENT_STATUS.PENDING;
          }

          if (seg.status !== SEGMENT_STATUS.PENDING) {
            continue;
          }

          // Crash window: valid on-disk result must not rebill ASR
          {
            const preexisting = await store.readValidatedSegmentResult(
              track,
              seg.seq,
              seg.contentSha256,
              job.generation ?? 1
            );
            if (preexisting.ok) {
              seg.status = SEGMENT_STATUS.COMPLETED;
              seg.hasResult = true;
              seg.lastError = null;
              job = await store.saveJob(job);
              log("segment_reused_valid_result", { track, seq: seg.seq });
              continue;
            }
          }

          let attempt = seg.attempts || 0;
          let lastErr = null;
          while (attempt < maxAttempts) {
            throwIfAborted(signal);
            attempt += 1;
            seg.attempts = attempt;
            seg.status = SEGMENT_STATUS.RUNNING;
            job = await store.saveJob(job);
            try {
              const { audioDataUrl } = await segmentToDataUrl(seg.wavPath, limits);
              const result = await transcribeSegment({
                audioDataUrl,
                signal,
                track,
                seq: seg.seq
              });
              const text = String(result?.text ?? "");
              await store.writeSegmentResult({
                track,
                seq: seg.seq,
                text,
                segmentContentSha256: seg.contentSha256,
                generation: job.generation || 1,
                rawMeta: {
                  provider: result?.provider || limits.provider,
                  model: result?.model || job.modelId
                }
              });
              seg.status = SEGMENT_STATUS.COMPLETED;
              seg.lastError = null;
              seg.hasResult = true;
              job = await store.saveJob(job);
              log("segment_completed", { track, seq: seg.seq, attempts: attempt });
              lastErr = null;
              break;
            } catch (error) {
              if (error?.code === "aborted") throw error;
              lastErr = {
                code: error.code || "transcribe_failed",
                message: sanitizeErrorMessage(error.message || error)
              };
              seg.lastError = lastErr;
              seg.status = SEGMENT_STATUS.FAILED;
              job = await store.saveJob(job);
              log("segment_failed", { track, seq: seg.seq, attempts: attempt, code: lastErr.code });
              if (attempt < maxAttempts) {
                await sleep(retryBackoffMs * attempt, signal);
                seg.status = SEGMENT_STATUS.PENDING;
              }
            }
          }
          if (lastErr) {
            job.status = JOB_STATUS.FAILED;
            job.lastError = {
              ...lastErr,
              track,
              seq: seg.seq,
              hint:
                "No-bucket mode uses Qwen3-ASR without remote diarization. For multi-speaker remote IDs configure Fun-ASR with a public HTTPS URL publisher (not included in Stage 2A). Exhausted failures require retryFailed({ resetAttempts: true })."
            };
            job = await store.saveJob(job);
            const err = new Error(lastErr.message);
            err.code = lastErr.code;
            err.job = job;
            throw err;
          }
          // Guard: pending must not fall through as success
          if (seg.status !== SEGMENT_STATUS.COMPLETED) {
            const err = new Error(`segment ${track}:${seg.seq} left status=${seg.status}`);
            err.code = "segment_incomplete";
            throw err;
          }
        }
        // Track complete only if all segments completed
        const allDone = (tstate.segments || []).every(
          (s) => s.status === SEGMENT_STATUS.COMPLETED || !(s.wavPath)
        );
        const anyFailed = (tstate.segments || []).some((s) => s.status === SEGMENT_STATUS.FAILED);
        tstate.status = anyFailed
          ? SEGMENT_STATUS.FAILED
          : allDone
            ? SEGMENT_STATUS.COMPLETED
            : SEGMENT_STATUS.PENDING;
        job = await store.saveJob(job);
      }

      // Require every segment completed before marking job completed
      for (const track of ["microphone", "system"]) {
        for (const seg of job.tracks?.[track]?.segments || []) {
          if (!seg.wavPath) continue;
          if (seg.status !== SEGMENT_STATUS.COMPLETED) {
            job.status = JOB_STATUS.FAILED;
            job.lastError = {
              code: "job_incomplete",
              message: sanitizeErrorMessage(
                `segment ${track}:${seg.seq} status=${seg.status} at finalize`
              ),
              track,
              seq: seg.seq
            };
            job = await store.saveJob(job);
            const err = new Error(job.lastError.message);
            err.code = "job_incomplete";
            err.job = job;
            throw err;
          }
          const vr = await store.readValidatedSegmentResult(
            track,
            seg.seq,
            seg.contentSha256,
            job.generation ?? 1
          );
          if (!vr.ok) {
            job.status = JOB_STATUS.FAILED;
            job.lastError = {
              code: vr.code || "result_invalid",
              message: sanitizeErrorMessage(`finalize validation failed: ${vr.code}`),
              track,
              seq: seg.seq
            };
            job = await store.saveJob(job);
            const err = new Error(job.lastError.message);
            err.code = job.lastError.code;
            err.job = job;
            throw err;
          }
        }
      }

      if (hasExhaustedFailures(job, maxAttempts)) {
        job.status = JOB_STATUS.FAILED;
        job.lastError = job.lastError || {
          code: "job_failed_exhausted",
          message: "one or more segments exhausted retries"
        };
        job = await store.saveJob(job);
        const err = new Error(job.lastError.message);
        err.code = "job_failed_exhausted";
        err.job = job;
        throw err;
      }

      const resultsByKey = {};
      for (const track of ["microphone", "system"]) {
        for (const seg of job.tracks[track]?.segments || []) {
          if (seg.status !== SEGMENT_STATUS.COMPLETED) continue;
          const v = await store.readValidatedSegmentResult(
            track,
            seg.seq,
            seg.contentSha256,
            job.generation ?? 1
          );
          if (v.ok) resultsByKey[`${track}:${seg.seq}`] = v.result;
        }
      }
      const transcript = buildRawTranscriptFromJob(job, {
        resultsByKey,
        limits,
        transcriptMeta: job.transcriptMeta || transcriptMeta
      });
      if (!skipTranscriptWrite) {
        await store.writeTranscript(transcript);
        job.transcriptPath = store.transcriptPath;
      } else {
        job.transcriptPath = null;
        job.transcriptDeferred = true;
      }
      job.status = JOB_STATUS.COMPLETED;
      job.lastError = null;
      job = await store.saveJob(job);
      log("job_completed", {
        sessionId: job.sessionId,
        items: transcript.count,
        transcriptWritten: !skipTranscriptWrite
      });
      // Attach in-memory transcript for enhanced merge (not persisted when deferred)
      job._transcript = transcript;
      return job;
    } catch (error) {
      if (error?.code === "aborted") {
        const j = await store.loadJob();
        if (j) {
          j.status = JOB_STATUS.CANCELLED;
          j.lastError = { code: "aborted", message: "cancelled" };
          await store.saveJob(j);
        }
      }
      throw error;
    } finally {
      runActive = false;
    }
  }

  /**
   * Explicit user intent to retry failed/cancelled work.
   * Allowed: FAILED, CANCELLED, or READY with failed/exhausted segments.
   * Rejected: COMPLETED, fresh READY (no failed segments), RUNNING, etc.
   */
  async function retryFailed({ resetAttempts = true } = {}) {
    if (runActive) {
      const error = new Error("cannot reset while run active");
      error.code = "job_already_running";
      throw error;
    }
    let job = await store.loadJob();
    if (!job) {
      const error = new Error("no job");
      error.code = "job_missing";
      throw error;
    }

    if (job.status === JOB_STATUS.COMPLETED) {
      const error = new Error("cannot retryFailed on a completed job");
      error.code = "retry_not_applicable";
      throw error;
    }
    if (job.status === JOB_STATUS.RUNNING || job.status === JOB_STATUS.PAUSED) {
      const error = new Error(`cannot retryFailed while job status is ${job.status}`);
      error.code = "retry_not_applicable";
      throw error;
    }
    if (job.status === JOB_STATUS.PREPARING) {
      const error = new Error("cannot retryFailed while job is preparing");
      error.code = "retry_not_applicable";
      throw error;
    }

    const hasFailedSegs = hasAnyFailedSegments(job);
    const isFailed = job.status === JOB_STATUS.FAILED;
    const isCancelled = job.status === JOB_STATUS.CANCELLED;
    const isPartialReady = job.status === JOB_STATUS.READY && hasFailedSegs;

    if (!isFailed && !isCancelled && !isPartialReady) {
      const error = new Error(
        `retryFailed not applicable for status=${job.status} without failed segments`
      );
      error.code = "retry_not_applicable";
      throw error;
    }

    for (const track of ["microphone", "system"]) {
      for (const seg of job.tracks?.[track]?.segments || []) {
        if (
          seg.status === SEGMENT_STATUS.FAILED ||
          (isCancelled && seg.status !== SEGMENT_STATUS.COMPLETED)
        ) {
          seg.status = SEGMENT_STATUS.PENDING;
          if (resetAttempts) seg.attempts = 0;
          seg.lastError = null;
        }
      }
      if (job.tracks?.[track]) job.tracks[track].status = SEGMENT_STATUS.PENDING;
    }
    job.status = JOB_STATUS.READY;
    job.lastError = null;
    job = await store.saveJob(job);
    log("retry_failed_reset", { resetAttempts });
    return job;
  }

  function pause() {
    paused = true;
  }

  function resume() {
    paused = false;
  }

  /** Pure load — never mutates disk. */
  async function getStatus() {
    return store.loadJob();
  }

  async function getTranscript() {
    return store.readTranscript();
  }

  return {
    store,
    prepare,
    run,
    retryFailed,
    pause,
    resume,
    getStatus,
    getTranscript,
    limits,
    buildRawTranscriptFromJob,
    get isRunActive() {
      return runActive;
    }
  };
}

function hasExhaustedFailures(job, maxAttempts) {
  for (const track of ["microphone", "system"]) {
    for (const seg of job.tracks?.[track]?.segments || []) {
      if (seg.status === SEGMENT_STATUS.FAILED && (seg.attempts || 0) >= maxAttempts) {
        return true;
      }
    }
  }
  return false;
}

function hasAnyFailedSegments(job) {
  for (const track of ["microphone", "system"]) {
    for (const seg of job.tracks?.[track]?.segments || []) {
      if (seg.status === SEGMENT_STATUS.FAILED) return true;
    }
  }
  return false;
}

module.exports = {
  createNoBucketMeetingTranscriptionService,
  buildRawTranscriptFromJob
};
