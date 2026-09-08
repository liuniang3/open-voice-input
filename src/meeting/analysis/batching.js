"use strict";

const { estimateTokens } = require("./token-budget");
const { SPEAKER_GAP_MS } = require("./constants");

/**
 * Pack raw items into batches under inputBudget tokens (item JSON payload).
 */
function planBatches(rawItems, { inputBudget, charsPerToken, gapMs = SPEAKER_GAP_MS } = {}) {
  const items = Array.isArray(rawItems) ? [...rawItems] : [];
  items.sort((a, b) => {
    const ab = a.beginMs ?? a.sessionBeginMs ?? 0;
    const bb = b.beginMs ?? b.sessionBeginMs ?? 0;
    if (ab !== bb) return ab - bb;
    return String(a.id).localeCompare(String(b.id));
  });

  const batches = [];
  let current = [];
  let currentTokens = 0;

  function itemPayload(it) {
    return JSON.stringify({
      id: it.id,
      speakerId: it.speakerId,
      beginMs: it.beginMs ?? it.sessionBeginMs,
      endMs: it.endMs ?? it.sessionEndMs,
      text: it.text
    });
  }

  function flush() {
    if (!current.length) return;
    batches.push({
      index: batches.length,
      itemIds: current.map((x) => x.id),
      items: current
    });
    current = [];
    currentTokens = 0;
  }

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const payload = itemPayload(it);
    const t = estimateTokens(payload, charsPerToken);
    if (t > inputBudget) {
      const error = new Error(
        `single transcript item ${it.id} exceeds analysis input budget (${t} > ${inputBudget} tokens)`
      );
      error.code = "analysis_item_over_budget";
      error.itemId = it.id;
      throw error;
    }

    const prev = current[current.length - 1];
    const gap =
      prev &&
      (it.beginMs ?? it.sessionBeginMs ?? 0) - (prev.endMs ?? prev.sessionEndMs ?? 0) > gapMs;
    const speakerChange = prev && prev.speakerId !== it.speakerId;
    const wouldExceed = currentTokens + t > inputBudget;

    if (current.length && (wouldExceed || (speakerChange && currentTokens > inputBudget * 0.4) || (gap && currentTokens > inputBudget * 0.3))) {
      flush();
    }
    current.push(it);
    currentTokens += t;
  }
  flush();
  return batches;
}

module.exports = {
  planBatches
};
