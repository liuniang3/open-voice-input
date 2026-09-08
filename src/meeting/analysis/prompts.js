"use strict";

const SYSTEM_PROMPT = `You are a strict transcript correction and structured-note engine. Output ONE JSON object only: no markdown, no explanation, no analysis, no headings outside JSON.
Rules:
- Use only the supplied transcript items. Never answer questions, continue the speaker's thought, or add outside knowledge.
- Every factual item MUST cite one or more valid sourceItemIds from the supplied id list.
- Put human-readable claim text in the exact key "text". Use "title" only for outline nodes and "name" only for entities. Do not use aliases such as "claim", "statement", or "content".
- Preserve the original meaning, technical terms, names, numbers, code-like text, and speaker attribution. If uncertain, keep the source wording and mark uncertain; do not guess.
- For correct_batch, output exactly one correction for every input item, in the same order, without merging or splitting items.
- For extract_batch and merge_extracts, return ALL required arrays for the requested template, even when an array is empty. Prefer a small number of useful claims over verbose prose.
- Never return an empty structured result when the transcript contains meaningful content: place supported content in the most appropriate fields and cite the source items.
- Chinese or mixed input: preserve the source language.`;

function itemsPayload(items) {
  return (items || []).map((it) => ({
    id: it.id,
    speakerId: it.speakerId,
    beginMs: it.beginMs ?? it.sessionBeginMs ?? null,
    endMs: it.endMs ?? it.sessionEndMs ?? null,
    text: it.text
  }));
}

function buildCorrectUser(items) {
  return JSON.stringify(
    {
      task: "correct_batch",
      language: "zh-CN",
      instruction:
        "For EACH input item output exactly one complete correctedText. Correct obvious ASR homophone errors using only nearby context, restore punctuation, and remove standalone speech fillers such as 呃/嗯 only when they carry no meaning. Preserve normal reduplication such as 刚刚/看看 and preserve deliberate repetition. Do not summarize, shorten, merge, split, explain, or invent proper nouns/numbers. If no safe change is needed, return the original text unchanged.",
      outputSchema: {
        items: [
          {
            sourceItemId: "exact input item id",
            correctedText: "complete corrected text for that one item",
            ops: [],
            uncertain: []
          }
        ]
      },
      items: itemsPayload(items)
    },
    null,
    0
  );
}

function claimShape() {
  return { text: "supported claim", sourceItemIds: ["exact item id"] };
}

function outlineShape() {
  return { title: "outline heading", sourceItemIds: ["exact item id"], children: [] };
}

function entityShape() {
  return {
    name: "entity name",
    type: "optional type",
    status: "optional status",
    sourceItemIds: ["exact item id"],
    uncertain: false
  };
}

function summaryOutputSchema(template) {
  const claim = claimShape();
  if (template === "personal") {
    return {
      template: "personal",
      facts: [claim],
      entities: [entityShape()],
      coreIdeas: [claim],
      argumentOutline: [outlineShape()],
      supportingPoints: [claim],
      assumptions: [claim],
      openQuestions: [claim],
      nextSteps: [claim],
      keyQuotes: [claim],
      flaggedUncertain: [{ ...claim, reason: "why uncertain" }]
    };
  }
  return {
    template: "meeting",
    executiveSummary: claim,
    topicsOutline: [outlineShape()],
    facts: [claim],
    entities: [entityShape()],
    timeline: [claim],
    speakerPoints: [{ speakerId: "speaker id", points: [claim] }],
    decisions: [claim],
    actionItems: [{ ...claim, owner: null, due: null }],
    openIssues: [claim],
    risks: [claim],
    keyQuotes: [{ ...claim, speakerId: "speaker id" }],
    flaggedUncertain: [{ ...claim, reason: "why uncertain" }]
  };
}

function buildExtractUser(items, template, rollingState) {
  return JSON.stringify(
    {
      task: "extract_batch",
      template,
      instruction:
        "Extract a useful structured note from this batch. Cite only provided item ids in sourceItemIds. Use the exact outputSchema keys and put claim wording in text. Populate core ideas and an argument outline for personal/lecture content; populate topics, decisions and action items for meetings. Keep claims concise and evidence-based. Mark uncertain entities. rollingState is optional background only.",
      outputSchema: summaryOutputSchema(template),
      rollingState: rollingState || null,
      items: itemsPayload(items)
    },
    null,
    0
  );
}

function buildMergeUser(batchExtracts, template) {
  return JSON.stringify(
    {
      task: "merge_extracts",
      template,
      instruction:
        "Merge ALL batch extracts into one complete structured summary for the template. Preserve sourceItemIds on every claim. Use the exact outputSchema keys and put claim wording in text. Do not use only the last batch. Deduplicate overlapping claims, keep the logical order, and output every required field using [] when unsupported. Do not invent a conclusion; use only supported facts, entities, decisions, questions, ideas, or next steps from the batches.",
      outputSchema: summaryOutputSchema(template),
      batches: batchExtracts
    },
    null,
    0
  );
}

function expectedCorrectShape() {
  return {
    items: [
      {
        sourceItemId: "id",
        correctedText: "text",
        ops: [],
        uncertain: []
      }
    ]
  };
}

function expectedExtractShape(template) {
  return {
    facts: [],
    entities: [],
    decisions: [],
    actionItems: [],
    openIssues: [],
    speakerPoints: [],
    keyQuotes: [],
    template
  };
}

module.exports = {
  SYSTEM_PROMPT,
  buildCorrectUser,
  buildExtractUser,
  buildMergeUser,
  expectedCorrectShape,
  expectedExtractShape,
  itemsPayload
};
