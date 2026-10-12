"use strict";

function summaryRequestBody(profile, options) {
  const extra = { ...options.extraBody };
  if (!/^summary_(?:map|reduce)$/.test(options.task || "")) return extra;
  const id = String(profile.modelId || "").split("/").pop();
  const explicitReasoning = profile.reasoning || extra.reasoning_effort || extra.reasoning?.effort;
  if (!explicitReasoning) {
    if (/^(?:deepseek|mimo)-/i.test(id) && profile.apiStyle !== "responses") extra.thinking ||= { type: "disabled" };
    else if (/^(?:gpt-[56]|o[134])(?:[.-]|$)/i.test(id)) extra.reasoning_effort = "low";
  }
  if (profile.apiStyle !== "responses" && /^(?:deepseek|mimo)-/i.test(id)) {
    extra.response_format ||= { type: "json_object" };
  }
  return extra;
}

// Recovery keeps the selected supplier/model and never mutates saved limits.
async function requestSummary(chat, profile, options) {
  const extraBody = summaryRequestBody(profile, options);
  let maxTokens = options.maxTokens;
  let formatAdjusted = false, outputAdjusted = false;
  for (;;) {
    try { return await chat({ ...options, maxTokens, extraBody }); }
    catch (error) {
      if (!/^summary_(?:map|reduce)$/.test(options.task || "")) throw error;
      if (!formatAdjusted && error.code === "request_format_unsupported" && extraBody.response_format) {
        formatAdjusted = true; delete extraBody.response_format;
      } else if (!outputAdjusted && error.code === "request_output_limit"
        && Number.isSafeInteger(error.outputTokenLimit) && error.outputTokenLimit < maxTokens) {
        outputAdjusted = true; maxTokens = error.outputTokenLimit;
      } else throw error;
    }
  }
}

module.exports = { summaryRequestBody, requestSummary };
