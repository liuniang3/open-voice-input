"use strict";

const { estimateTokens } = require("./token-budget");

/**
 * Cap rolling state so serialized estimateTokens(JSON) <= rollingCap.
 * Trim oldest low-priority lists first while keeping evidence IDs where possible.
 */
function capRollingState(state, rollingCap, charsPerToken = 0.9) {
  const base = {
    schema: "analysis_rolling_state_v1",
    afterBatch: state?.afterBatch ?? 0,
    inputHash: state?.inputHash || null,
    confirmedFacts: [...(state?.confirmedFacts || [])],
    entities: [...(state?.entities || [])],
    decisions: [...(state?.decisions || [])],
    actionItems: [...(state?.actionItems || [])],
    openIssues: [...(state?.openIssues || [])],
    speakerPointIndex: state?.speakerPointIndex || {},
    evidenceIndex: { ...(state?.evidenceIndex || {}) },
    contentSha256: null
  };

  function sizeOf(obj) {
    return estimateTokens(JSON.stringify(obj), charsPerToken);
  }

  const priorityKeys = ["openIssues", "entities", "confirmedFacts", "actionItems", "decisions"];

  let guard = 0;
  while (sizeOf(base) > rollingCap && guard < 2000) {
    guard += 1;
    let trimmed = false;
    for (const key of priorityKeys) {
      if (Array.isArray(base[key]) && base[key].length > 0) {
        base[key].shift();
        trimmed = true;
        break;
      }
    }
    if (!trimmed) {
      const keys = Object.keys(base.evidenceIndex || {});
      if (keys.length) {
        delete base.evidenceIndex[keys[0]];
        trimmed = true;
      }
    }
    if (!trimmed) {
      // last resort: empty all arrays
      for (const key of priorityKeys) base[key] = [];
      base.evidenceIndex = {};
      base.speakerPointIndex = {};
      trimmed = true;
    }
    if (!trimmed) break;
  }

  // After hard empty, still over cap → minimal stub
  if (sizeOf(base) > rollingCap) {
    return {
      schema: "analysis_rolling_state_v1",
      afterBatch: base.afterBatch,
      truncated: true
    };
  }
  return base;
}

/**
 * Pack merge units under inputBudget; each unit is an array of payloads.
 * Fail if a single unit cannot fit.
 */
function planMergeGroups(units, { inputBudget, charsPerToken = 0.9, wrapKey = "batches" } = {}) {
  const list = Array.isArray(units) ? units : [];
  if (!list.length) return [];

  function unitTokens(u) {
    return estimateTokens(JSON.stringify(u), charsPerToken);
  }

  for (let i = 0; i < list.length; i += 1) {
    const t = unitTokens(list[i]);
    if (t > inputBudget) {
      const error = new Error(
        `single merge unit exceeds budget (${t} > ${inputBudget} tokens)`
      );
      error.code = "analysis_merge_over_budget";
      error.unitIndex = i;
      throw error;
    }
  }

  const groups = [];
  let cur = [];
  let curTok = 0;
  for (const u of list) {
    const t = unitTokens(u);
    // envelope overhead rough
    const next = curTok + t + 20;
    if (cur.length && next > inputBudget) {
      groups.push(cur);
      cur = [];
      curTok = 0;
    }
    cur.push(u);
    curTok += t + 20;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

module.exports = {
  capRollingState,
  planMergeGroups
};
