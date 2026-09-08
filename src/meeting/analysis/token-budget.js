"use strict";

const { CHARS_PER_TOKEN, BUDGET_RATIO, ROLLING_STATE_BUDGET_FRACTION } = require("./constants");

function estimateTokens(text, charsPerToken = CHARS_PER_TOKEN) {
  const chars = String(text || "").length;
  const cpt = Number(charsPerToken) > 0 ? Number(charsPerToken) : CHARS_PER_TOKEN;
  return Math.max(1, Math.ceil(chars / cpt));
}

function computeInputBudget({
  contextWindowTokens,
  maxOutputTokens,
  systemPrompt = "",
  budgetRatio = BUDGET_RATIO,
  charsPerToken = CHARS_PER_TOKEN
} = {}) {
  const ctx = Number(contextWindowTokens) > 0 ? Number(contextWindowTokens) : 128000;
  const out = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : 8192;
  const ratio = Number(budgetRatio) > 0 && Number(budgetRatio) <= 1 ? Number(budgetRatio) : BUDGET_RATIO;
  const systemTokens = estimateTokens(systemPrompt, charsPerToken);
  const safety = Math.ceil(ctx * 0.05);
  const budget = Math.floor(ctx * ratio) - systemTokens - out - safety;
  if (budget < 256) {
    const error = new Error("analysis context budget too small for model profile");
    error.code = "analysis_budget_too_small";
    throw error;
  }
  return {
    inputBudget: budget,
    rollingCap: Math.max(64, Math.floor(budget * ROLLING_STATE_BUDGET_FRACTION)),
    systemTokens,
    contextWindowTokens: ctx,
    maxOutputTokens: out
  };
}

module.exports = {
  estimateTokens,
  computeInputBudget
};
