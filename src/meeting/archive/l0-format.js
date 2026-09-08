"use strict";

/** WAVE format tags (mmreg.h) */
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

const PCM_SUBFORMAT_HINTS = [
  "WAVE_FORMAT_PCM",
  "pcm",
  "00000001-0000-0010-8000-00aa00389b71"
];

const FLOAT_SUBFORMAT_HINTS = [
  "WAVE_FORMAT_IEEE_FLOAT",
  "ieee_float",
  "float",
  "00000003-0000-0010-8000-00aa00389b71"
];

/**
 * Resolve device L0 sample encoding from manifest/index format fields.
 * @returns {{ kind: "pcm16"|"float32", sampleRate: number, channels: number, bitsPerSample: number, blockAlign: number, formatTag: number, subFormat: string }}
 */
function resolveL0SampleEncoding(format) {
  if (!format || typeof format !== "object") {
    const error = new Error("L0 format missing");
    error.code = "l0_format_missing";
    throw error;
  }

  const sampleRate = Number(format.sampleRate);
  const channels = Number(format.channels);
  const bitsPerSample = Number(format.bitsPerSample);
  const formatTag = Number(format.formatTag != null ? format.formatTag : 0);
  const subFormat = String(format.subFormat || "");
  const blockAlignDeclared = Number(format.blockAlign);

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    const error = new Error(`unsupported L0 sampleRate: ${format.sampleRate}`);
    error.code = "l0_format_unsupported";
    throw error;
  }
  if (!Number.isFinite(channels) || channels < 1 || channels > 32) {
    const error = new Error(`unsupported L0 channels: ${format.channels}`);
    error.code = "l0_format_unsupported";
    throw error;
  }

  const subLower = subFormat.toLowerCase();
  const looksPcm =
    formatTag === WAVE_FORMAT_PCM ||
    PCM_SUBFORMAT_HINTS.some((h) => subLower.includes(h.toLowerCase()));
  const looksFloat =
    formatTag === WAVE_FORMAT_IEEE_FLOAT ||
    FLOAT_SUBFORMAT_HINTS.some((h) => subLower.includes(h.toLowerCase()));
  const looksExtensible = formatTag === WAVE_FORMAT_EXTENSIBLE;

  let kind = null;
  if (bitsPerSample === 16 && (looksPcm || (looksExtensible && looksPcm) || (!looksFloat && looksPcm))) {
    kind = "pcm16";
  } else if (bitsPerSample === 32 && (looksFloat || (looksExtensible && looksFloat))) {
    kind = "float32";
  } else if (bitsPerSample === 16 && !looksFloat && (formatTag === 0 || looksExtensible || looksPcm)) {
    // Common device PCM when formatTag omitted in partial fake manifests
    kind = "pcm16";
  } else if (bitsPerSample === 32 && !looksPcm && (formatTag === 0 || looksExtensible || looksFloat)) {
    kind = "float32";
  }

  if (!kind) {
    const error = new Error(
      `unsupported L0 format: tag=${formatTag} bits=${bitsPerSample} sub=${subFormat || "(none)"}`
    );
    error.code = "l0_format_unsupported";
    error.format = format;
    throw error;
  }

  const bytesPerSample = kind === "pcm16" ? 2 : 4;
  const expectedBlock = channels * bytesPerSample;
  const blockAlign =
    Number.isFinite(blockAlignDeclared) && blockAlignDeclared > 0
      ? blockAlignDeclared
      : expectedBlock;

  if (blockAlign !== expectedBlock) {
    const error = new Error(
      `L0 blockAlign mismatch: declared=${blockAlign} expected=${expectedBlock} for ${kind} x${channels}`
    );
    error.code = "l0_format_unsupported";
    throw error;
  }

  return {
    kind,
    sampleRate,
    channels,
    bitsPerSample,
    blockAlign,
    formatTag: formatTag || (kind === "pcm16" ? WAVE_FORMAT_PCM : WAVE_FORMAT_IEEE_FLOAT),
    subFormat
  };
}

function isMonoEncoding(encoding) {
  return encoding && Number(encoding.channels) === 1;
}

module.exports = {
  WAVE_FORMAT_PCM,
  WAVE_FORMAT_IEEE_FLOAT,
  WAVE_FORMAT_EXTENSIBLE,
  resolveL0SampleEncoding,
  isMonoEncoding
};
