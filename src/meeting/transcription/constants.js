"use strict";

const MIB = 1024 * 1024;

/** Stage 2A default: Qwen3-ASR-Flash no-bucket local/Base64 path */
const QWEN_NO_BUCKET = Object.freeze({
  id: "qwen-no-bucket-v2",
  provider: "qwen3-asr",
  mode: "no_bucket",
  targetSampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  /** Conservative default under documented 5 min / 10 MB limits */
  targetSegmentSeconds: 180,
  hardSegmentSeconds: 210,
  documentedMaxDurationSeconds: 300,
  /** Final Base64/data-URI payload budget (chars ≈ bytes for b64 alphabet) */
  maxBase64Chars: 9000000,
  maxDataUriChars: 9000064,
  pauseSearchSeconds: 12,
  pauseLookaheadSeconds: 8,
  minSplitSeconds: 5,
  maxSplitDepth: 6,
  /** Operational hard cap; encoded-size preflight can reduce this further. */
  effectivePcmDurationCapSeconds: 210,
  /** Work dir relative to session root */
  workDirName: "transcription/qwen-no-bucket",
  schema: "meeting_qwen_no_bucket_job_v1",
  transcriptSchema: "meeting_raw_transcript_v1",
  timestampPrecision: "segment",
  diarization: false,
  remoteSpeakerId: "remote_unknown",
  selfSpeakerId: "self",
  note:
    "No-bucket mode uses Qwen3-ASR-Flash Base64 segments only. No remote diarization. Fun-ASR+public URL is optional later."
});

// MiMo has its own operational budget; undocumented duration/output limits are not inferred from Qwen.
const MIMO_FILE_ASR = Object.freeze({
  ...QWEN_NO_BUCKET,
  id: "mimo-file-asr-v2",
  provider: "mimo",
  mode: "file",
  documentedMaxDurationSeconds: null,
  note: "MiMo audio-only ASR; bounded Base64 uploads and adaptive recovery of truncated output."
});

function fileAsrLimits(provider) {
  return provider === "mimo" ? MIMO_FILE_ASR : QWEN_NO_BUCKET;
}

const JOB_STATUS = Object.freeze({
  PREPARING: "preparing",
  READY: "ready",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

const SEGMENT_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed"
});

module.exports = {
  MIB,
  QWEN_NO_BUCKET,
  MIMO_FILE_ASR,
  fileAsrLimits,
  JOB_STATUS,
  SEGMENT_STATUS
};
