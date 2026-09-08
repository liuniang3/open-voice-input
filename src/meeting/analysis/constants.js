"use strict";

const ANALYSIS_ROOT = "analysis";
const RAW_TRANSCRIPT_REL = "transcription/qwen-no-bucket/raw-transcript.json";

const PROMPT_REVISION = "analysis_prompts_v2";
const SCHEMA_REVISION = "analysis_job_v1";
const BUDGET_RATIO = 0.65;
const CHARS_PER_TOKEN = 0.9;
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_OUTPUT = 8192;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_JSON_RETRIES = 1;
const SPEAKER_GAP_MS = 30000;
const ROLLING_STATE_BUDGET_FRACTION = 0.15;

const JOB_STATUS = Object.freeze({
  PREPARING: "preparing",
  READY: "ready",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

const STAGE = Object.freeze({
  IDLE: "idle",
  FINGERPRINT: "fingerprint",
  PLAN_BATCHES: "plan_batches",
  CORRECT: "correct",
  EXTRACT: "extract",
  ROLL: "roll",
  MERGE: "merge",
  VERIFY: "verify",
  FINALIZE: "finalize",
  DONE: "done"
});

const TEMPLATES = Object.freeze({
  AUTO: "auto",
  MEETING: "meeting",
  PERSONAL: "personal"
});

module.exports = {
  ANALYSIS_ROOT,
  RAW_TRANSCRIPT_REL,
  PROMPT_REVISION,
  SCHEMA_REVISION,
  BUDGET_RATIO,
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  DEFAULT_TIMEOUT_MS,
  MAX_JSON_RETRIES,
  SPEAKER_GAP_MS,
  ROLLING_STATE_BUDGET_FRACTION,
  JOB_STATUS,
  STAGE,
  TEMPLATES
};
