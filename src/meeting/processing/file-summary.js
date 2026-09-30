"use strict";

// File Generate Summary adapter (stage 2B): runs the realtime postprocess summary
// engine (src/meeting/realtime/postprocess.js) over an imported file session.
// Contract: summarize({ useMimoReview }) is one user-level operation.
//   useMimoReview=false -> summarize the immutable file-ASR raw transcript with
//     zero extra audio ASR and no audio reads;
//   useMimoReview=true  -> review the preserved full archive audio in bounded MiMo
//     ASR chunks, compare file-ASR vs review evidence, then produce the shared
//     mindmap + coherent-paragraph summary schema.
// Import archives, raw transcripts and legacy analysis artifacts are read-only
// here; results live under the engine's own realtime/postprocess/ checkpoint tree.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { createMeetingPostprocessor } = require("../realtime/postprocess");
const audioUtils = require("../realtime/audio");
const { assertPathInsideRoot } = require("../paths");

const SAMPLE_RATE = audioUtils.RATE;
const HEADER_BYTES = 44;
const MAX_DTO_NODES = 500;
const MAX_DTO_DEPTH = 16;
const MAX_DTO_PROVENANCE = 32;

function fault(code) {
  return Object.assign(new Error(code), { code });
}

async function readRawTranscript(sessionDir) {
  const base = path.join(sessionDir, "transcription");
  let names = [];
  try {
    names = await fs.readdir(base);
  } catch {
    return null;
  }
  const candidates = [
    path.join(base, "qwen-no-bucket", "raw-transcript.json"),
    path.join(base, "raw-transcript.json"),
    ...names.filter(name => name !== "qwen-no-bucket").sort()
      .map(name => path.join(base, name, "raw-transcript.json"))
  ];
  for (const file of candidates) {
    try {
      assertPathInsideRoot(sessionDir, file);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      if (raw && Array.isArray(raw.items)) return { file, transcript: raw };
    } catch {
      /* missing or corrupt candidate; keep scanning */
    }
  }
  return null;
}

async function resolveArchiveAudio(sessionDir) {
  // Read-only discovery of preserved import archives; never rewrite or truncate them.
  const archiveDir = path.join(sessionDir, "archive");
  const audioPaths = [];
  let totalFrames = 0;
  for (const track of ["microphone", "system"]) {
    const wav = path.join(archiveDir, `${track}.mono.wav`);
    try {
      assertPathInsideRoot(sessionDir, wav);
      const stat = await fs.stat(wav);
      const frames = Math.max(0, Math.floor((stat.size - HEADER_BYTES) / 2));
      if (frames > 0) {
        audioPaths.push(wav);
        totalFrames = Math.max(totalFrames, frames);
      }
    } catch {
      /* track absent */
    }
  }
  return { audioPaths, totalFrames };
}

function framesFromMs(value, fallback) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.round((ms * SAMPLE_RATE) / 1000) : fallback;
}

function segmentsFromTranscript(transcript, totalFrames) {
  const items = Array.isArray(transcript?.items) ? transcript.items : [];
  const segments = [];
  let sourceChars = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index] || {};
    const text = typeof item.text === "string" ? item.text : "";
    sourceChars += text.length;
    if (sourceChars > 12000000) throw fault("postprocess_source_limit");
    const previousEnd = segments.length ? segments[segments.length - 1].endFrame : 0;
    const startFrame = Math.min(totalFrames, Math.max(previousEnd, framesFromMs(
      item.beginMs ?? item.sessionBeginMs ?? item.artifactBeginMs, previousEnd)));
    const nextStart = index + 1 < items.length
      ? framesFromMs(items[index + 1]?.beginMs ?? items[index + 1]?.sessionBeginMs, NaN)
      : NaN;
    const endFrame = Math.min(totalFrames, Math.max(startFrame,
      framesFromMs(item.endMs ?? item.sessionEndMs ?? item.artifactEndMs,
        Number.isFinite(nextStart) ? nextStart : Math.max(startFrame, totalFrames))));
    segments.push({ index, startFrame, endFrame, text, status: "completed" });
  }
  return segments;
}

function resultDigestOf(result) {
  return crypto.createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

// History readback only returns a summary whose stored digest matches its bytes
// and whose session matches the caller. Truncated, rewritten or cross-session
// results are ignored instead of leaking into the UI or exports.
async function readLatestSummaryResult(sessionDir, sessionId = null) {
  const root = path.join(path.resolve(sessionDir), "realtime", "postprocess");
  try {
    assertPathInsideRoot(sessionDir, path.join(root, "summary-latest.json"));
    const latest = JSON.parse(await fs.readFile(path.join(root, "summary-latest.json"), "utf8"));
    if (!latest || !/^[a-f0-9]{64}$/.test(String(latest.key || ""))) return null;
    if (latest.resultDigest && !/^[a-f0-9]{64}$/.test(String(latest.resultDigest))) return null;
    const resultPath = path.join(root, latest.key, "result.json");
    assertPathInsideRoot(sessionDir, resultPath);
    const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
    if (!result || result.schema !== "meeting_summary_v1") return null;
    if (sessionId != null && result.sessionId !== sessionId) return null;
    if (latest.resultDigest && resultDigestOf(result) !== latest.resultDigest) return null;
    return { result, resultPath, markdownPath: path.join(root, latest.key, "meeting.summary.md") };
  } catch {
    return null;
  }
}

function claimDto(node, depth, remaining) {
  if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.text !== "string") return null;
  if (depth > MAX_DTO_DEPTH || remaining.count <= 0) return null;
  remaining.count -= 1;
  const provenance = Array.isArray(node.provenance) ? node.provenance.slice(0, MAX_DTO_PROVENANCE) : [];
  const dto = {
    text: node.text.slice(0, 4000),
    uncertain: node.uncertain === true,
    provenance: provenance.map(item => ({
      sourceId: String(item?.sourceId || "").slice(0, 200),
      quote: String(item?.quote || "").slice(0, 2000),
      source: ["live", "mimo", "summary"].includes(item?.source) ? item.source : "live",
      startFrame: Number.isFinite(item?.startFrame) ? item.startFrame : null,
      endFrame: Number.isFinite(item?.endFrame) ? item.endFrame : null
    }))
  };
  if (Array.isArray(node.children)) {
    dto.children = node.children.slice(0, 200).map(child => claimDto(child, depth + 1, remaining)).filter(Boolean);
  }
  return dto;
}

// Narrow, provider-safe DTO for the file UI: statuses, claims, markdown and
// absolute output paths only. Never forwards credentials or provider response bodies.
function toFileSummaryDto(value = {}) {
  const remaining = { count: MAX_DTO_NODES };
  const summary = value.summary || null;
  const dto = {
    sessionId: typeof value.sessionId === "string" ? value.sessionId.slice(0, 256) : "",
    status: typeof value.status === "string" ? value.status : "idle",
    kind: "summary",
    progress: {
      completed: Number.isFinite(value.progress?.completed) ? value.progress.completed : 0,
      failed: Number.isFinite(value.progress?.failed) ? value.progress.failed : 0,
      total: Number.isFinite(value.progress?.total) ? value.progress.total : 0
    },
    modelId: typeof value.modelId === "string" ? value.modelId.slice(0, 200) : "",
    useMimoReview: value.useMimoReview === true,
    title: typeof value.title === "string" ? value.title.slice(0, 300) : "",
    summaryMarkdownPath: typeof value.summaryMarkdownPath === "string" && path.isAbsolute(value.summaryMarkdownPath)
      ? value.summaryMarkdownPath : "",
    summary: null,
    error: value.error?.code ? { code: String(value.error.code).slice(0, 100) } : null
  };
  if (summary && typeof summary === "object") {
    dto.summary = {
      title: typeof summary.title === "string" ? summary.title.slice(0, 300) : "",
      markdown: typeof summary.markdown === "string" ? summary.markdown.slice(0, 200000) : "",
      mindmap: claimDto(summary.mindmap, 0, remaining),
      sections: Array.isArray(summary.sections) ? summary.sections.slice(0, 100).map(section => ({
        heading: String(section?.heading || "").slice(0, 200),
        paragraphs: Array.isArray(section?.paragraphs)
          ? section.paragraphs.slice(0, 100).map(item => claimDto(item, 0, remaining)).filter(Boolean) : [],
        items: Array.isArray(section?.items)
          ? section.items.slice(0, 100).map(item => claimDto(item, 0, remaining)).filter(Boolean) : []
      })) : [],
      incomplete: summary.incomplete === true,
      uncertain: summary.uncertain === true
    };
  }
  return dto;
}

function createFileSummaryService({
  sessionDir,
  sessionId,
  readMixedFn = audioUtils.readMixed,
  review,
  llm,
  modelId,
  reviewModelId = "mimo-v2.5-asr",
  onUpdate
} = {}) {
  if (typeof sessionDir !== "string" || !sessionDir || typeof sessionId !== "string" || !sessionId) {
    throw fault("file_summary_dependencies_missing");
  }
  if (typeof llm !== "function") throw fault("postprocess_llm_missing");
  const root = path.resolve(sessionDir);
  let lastDto = toFileSummaryDto({ sessionId, status: "idle", modelId, useMimoReview: false });

  const processor = createMeetingPostprocessor({
    sessionDir: root,
    getState: async () => {
      const found = await readRawTranscript(root);
      const { audioPaths, totalFrames } = await resolveArchiveAudio(root);
      const segments = found ? segmentsFromTranscript(found.transcript, totalFrames) : [];
      return {
        sessionId,
        status: "completed",
        recording: false,
        finalizationPending: false,
        sampleRate: SAMPLE_RATE,
        totalFrames,
        segments,
        audioPaths
      };
    },
    readMixed: (paths, start, end) => readMixedFn(paths, start, end),
    review: review
      ? (input) => review(input)
      : async () => { throw fault("postprocess_asr_missing"); },
    llm: (input) => llm(input),
    modelId,
    reviewModelId,
    onUpdate: (state) => {
      lastDto = toFileSummaryDto({ ...state, sessionId, modelId, useMimoReview: lastDto.useMimoReview });
      try { onUpdate?.(lastDto); } catch { /* observers cannot break durable work */ }
    }
  });

  function adopt(outcome, useMimoReview) {
    const title = outcome?.result?.title || "";
    const base = {
      ...outcome,
      sessionId,
      modelId: outcome?.result?.modelId || modelId,
      useMimoReview,
      title,
      summaryMarkdownPath: outcome?.paths?.summaryMarkdownPath || "",
      summary: outcome?.summary ? { title, ...outcome.summary } : null
    };
    lastDto = toFileSummaryDto(base);
    return lastDto;
  }

  return {
    async summarize(options = {}) {
      const useMimoReview = options.useMimoReview === true;
      lastDto = toFileSummaryDto({
        sessionId, status: "running", modelId, useMimoReview, title: lastDto.title,
        summaryMarkdownPath: lastDto.summaryMarkdownPath, summary: lastDto.summary
      });
      try {
        const outcome = await processor.summarize({
          useMimoReview,
          retryFailed: options.retryFailed !== false,
          signal: options.signal
        });
        return adopt(outcome, useMimoReview);
      } catch (error) {
        const code = /^postprocess_[a-z_]+$/.test(error?.code || "") ? error.code : "file_summary_failed";
        const failed = toFileSummaryDto({
          ...processor.getStatus(), sessionId, modelId, useMimoReview,
          title: lastDto.title, summaryMarkdownPath: lastDto.summaryMarkdownPath, summary: lastDto.summary,
          error: { code }
        });
        lastDto = failed;
        throw Object.assign(new Error(code), { code });
      }
    },
    async status() {
      const live = processor.getStatus();
      if (["running", "failed", "cancelled", "needs_retry"].includes(live.status)
        || (lastDto.status === "completed" && live.status !== "completed")) {
        lastDto = toFileSummaryDto({
          ...live, sessionId, modelId,
          useMimoReview: lastDto.useMimoReview,
          title: lastDto.title,
          summaryMarkdownPath: lastDto.summaryMarkdownPath,
          summary: lastDto.summary
        });
      }
      if (["idle", "completed"].includes(lastDto.status)) {
        const stored = await readLatestSummaryResult(root, sessionId);
        if (stored) {
          lastDto = toFileSummaryDto({
            sessionId,
            status: "completed",
            progress: lastDto.progress,
            modelId: stored.result.modelId || modelId,
            useMimoReview: stored.result.useMimoReview === true,
            title: stored.result.title || "",
            summary: {
              title: stored.result.title || "",
              markdown: stored.result.markdown || "",
              mindmap: stored.result.mindmap,
              sections: stored.result.sections,
              incomplete: stored.result.incomplete === true,
              uncertain: stored.result.uncertain === true
            },
            summaryMarkdownPath: await markdownPathFor(stored)
          });
        }
      }
      return toFileSummaryDto(lastDto);
    },
    cancel: () => processor.cancel(),
    readLatest: () => readLatestSummaryResult(root, sessionId)
  };
}

async function markdownPathFor(stored) {
  try {
    await fs.stat(stored.markdownPath);
    return stored.markdownPath;
  } catch {
    return stored.resultPath ? path.join(path.dirname(stored.resultPath), "meeting.summary.md") : "";
  }
}

module.exports = {
  createFileSummaryService,
  toFileSummaryDto,
  readLatestSummaryResult,
  segmentsFromTranscript
};
