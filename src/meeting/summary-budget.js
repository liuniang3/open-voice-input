"use strict";

const { resolveModelCapability } = require("../settings/model-capabilities");

// A portable conservative estimate, not a provider tokenizer. Include escaped
// metadata, instructions and output reservation, plus a 20% context margin.
function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let ascii = 0, other = 0;
  for (const char of text) {
    const point = char.codePointAt(0);
    if (point <= 127) ascii++;
    else if (point >= 0x3400 && point <= 0x9fff) other += 2;
    else other += Buffer.byteLength(char, "utf8");
  }
  return Math.ceil(ascii / 3) + other;
}

function summaryBudget(profile = {}) {
  const defaults = resolveModelCapability(profile.modelId);
  const contextWindow = Math.max(4096, Math.floor(Number(profile.contextWindow) || defaults.contextWindow));
  const maxOutputTokens = Math.max(256, Math.floor(Math.min(Number(profile.maxOutputTokens) || defaults.maxOutput,
    32768, contextWindow / 4)));
  // An enormous context does not imply enormous output: detailed prose +
  // citations still need to fit. Oversized inputs use hierarchical compression.
  const inputTokenBudget = Math.floor(Math.min(contextWindow * 0.8 - maxOutputTokens, maxOutputTokens * 6));
  const maxInputChars = Math.max(4000, Math.min(1500000, inputTokenBudget * 3));
  return { maxOutputTokens, limits: {
    maxInputChars,
    maxOutputChars: Math.max(1000, Math.min(200000, maxOutputTokens * 2)),
    inputTokenBudget,
    fragmentChars: Math.min(2200, Math.floor(maxInputChars / 8)),
    contextChars: Math.min(2000, Math.floor(maxInputChars / 4)),
    paragraphChars: Math.min(3600, Math.max(1000, maxOutputTokens * 2))
  } };
}

function summaryInput(task, items, context, limits, sourceIncomplete, missingRangeCount) {
  return { items, outputSchema: task, sourceIncomplete, missingRangeCount,
    instruction: "Produce detailed notes as coherent prose paragraphs, but compress repeated material so subsequent reduction converges.",
    context, maxOutputChars: limits.maxOutputChars };
}

module.exports = { estimateTokens, summaryBudget, summaryInput };
