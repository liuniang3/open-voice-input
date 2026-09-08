"use strict";

const {
  PROMPT_REVISION,
  SCHEMA_REVISION,
  JOB_STATUS,
  STAGE,
  CHARS_PER_TOKEN,
  MAX_JSON_RETRIES
} = require("./constants");
const { computeInputBudget } = require("./token-budget");
const { planBatches } = require("./batching");
const { resolveTemplate } = require("./templates");
const {
  SYSTEM_PROMPT,
  buildCorrectUser,
  buildExtractUser,
  buildMergeUser
} = require("./prompts");
const { parseModelJson } = require("./json-extract");
const {
  normalizeCorrections,
  validateSummaryEvidence,
  buildItemIndex,
  markVerificationHardFail
} = require("./evidence");
const { capRollingState, planMergeGroups } = require("./rolling");

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error("aborted");
    err.code = "aborted";
    throw err;
  }
}

function createAnalysisPipeline({
  store,
  sessionId,
  requestChat,
  profile,
  templateRequest = "auto",
  forceRefresh = false,
  signal = null,
  logger = () => {}
}) {
  function log(event, detail = {}) {
    logger({ event, ...detail });
  }

  async function callModel(userContent, { stage, rawSha } = {}) {
    throwIfAborted(signal);
    await store.assertRawUnchanged(rawSha);
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt += 1) {
      throwIfAborted(signal);
      await store.assertRawUnchanged(rawSha);
      try {
        const extraBody = {};
        if (profile.reasoningEffort) {
          extraBody.reasoning_effort = profile.reasoningEffort;
        }
        const response = await requestChat(
          [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent }
          ],
          {
            maxTokens: profile.maxOutputTokens,
            signal,
            extraBody
          }
        );
        return parseModelJson(response?.content ?? "");
      } catch (error) {
        if (error?.code === "aborted") throw error;
        if (error?.code === "analysis_raw_changed") throw error;
        lastErr = error;
        log("model_call_failed", { stage, attempt, code: error.code || "error" });
        if (error?.code !== "analysis_json_invalid" || attempt >= MAX_JSON_RETRIES) {
          throw error;
        }
      }
    }
    throw lastErr;
  }

  async function hierarchicalMerge(allExtracts, template, budget, generation, rawSha) {
    let units = allExtracts.map((e, i) => ({
      kind: "batch_extract",
      key: e.outputSha256 || e.inputHash || String(i),
      payload: e
    }));

    let level = 0;
    for (;;) {
      throwIfAborted(signal);
      if (!units.length) {
        const error = new Error("no extracts to merge");
        error.code = "analysis_merge_over_budget";
        throw error;
      }

      // Always merge once when a single unit is a raw batch extract (normalize)
      const onlyDraft = units.length === 1 && units[0].kind === "merge_draft";
      if (onlyDraft) {
        return {
          draft: units[0].payload.draft,
          inputHash: units[0].payload.inputHash,
          outputSha256: units[0].key
        };
      }

      let groups = planMergeGroups(
        units.map((u) => u.payload),
        { inputBudget: budget.inputBudget, charsPerToken: CHARS_PER_TOKEN }
      );

      // If packer cannot combine any units, force binary pairs so the tree reduces.
      if (units.length > 1 && groups.every((g) => g.length === 1)) {
        groups = [];
        for (let i = 0; i < units.length; i += 2) {
          const pair = units.slice(i, i + 2).map((u) => u.payload);
          // still enforce each pair fits
          const tok = require("./token-budget").estimateTokens(
            JSON.stringify(pair),
            CHARS_PER_TOKEN
          );
          if (tok > budget.inputBudget && pair.length > 1) {
            const error = new Error(
              `merge pair exceeds budget (${tok} > ${budget.inputBudget}); cannot hierarchical-merge`
            );
            error.code = "analysis_merge_over_budget";
            throw error;
          }
          groups.push(pair);
        }
      }

      if (!groups.length) {
        const error = new Error("merge grouping failed");
        error.code = "analysis_merge_over_budget";
        throw error;
      }

      // Rebuild groups of units by matching payload identity order
      const nextUnits = [];
      let uIdx = 0;
      for (let g = 0; g < groups.length; g += 1) {
        const n = groups[g].length;
        const groupUnits = units.slice(uIdx, uIdx + n);
        uIdx += n;
        if (groupUnits.length !== n) {
          const error = new Error("merge group alignment failed");
          error.code = "analysis_merge_over_budget";
          throw error;
        }
        const groupPayloads = groupUnits.map((u) =>
          u.kind === "merge_draft" ? u.payload.draft : u.payload
        );
        const inputHash = store.sha256Text(
          JSON.stringify({ level, g, parts: groupUnits.map((u) => u.key) })
        );
        const artName = `merge/level_${level}_group_${String(g).padStart(3, "0")}.json`;
        let art = await store.readStageArtifact(generation, artName);
        if (!art || art.inputHash !== inputHash) {
          const modelOut = await callModel(buildMergeUser(groupPayloads, template), {
            stage: `merge_L${level}_G${g}`,
            rawSha
          });
          art = {
            schema: "analysis_merge_group_v1",
            level,
            group: g,
            inputHash,
            template,
            draft: modelOut
          };
          const written = await store.writeStageArtifact(generation, artName, art);
          art = written.doc;
        }
        nextUnits.push({
          kind: "merge_draft",
          key: art.outputSha256 || inputHash,
          payload: {
            draft: art.draft,
            outputSha256: art.outputSha256,
            inputHash: art.inputHash
          }
        });
      }

      if (nextUnits.length === 1) {
        return {
          draft: nextUnits[0].payload.draft,
          inputHash: nextUnits[0].payload.inputHash,
          outputSha256: nextUnits[0].key
        };
      }
      units = nextUnits;
      level += 1;
      if (level > 32) {
        const error = new Error("merge hierarchy too deep");
        error.code = "analysis_merge_over_budget";
        throw error;
      }
    }
  }

  async function run() {
    await store.init();
    const rawLoaded = await store.loadRawTranscript();
    const rawDoc = rawLoaded.doc;
    const rawItems = Array.isArray(rawDoc.items) ? rawDoc.items : [];
    if (!rawItems.length) {
      const error = new Error("raw transcript has no items");
      error.code = "analysis_raw_empty";
      throw error;
    }
    const rawSha = rawLoaded.sha;

    const { template, templateSource } = resolveTemplate(templateRequest, rawItems);
    const budget = computeInputBudget({
      contextWindowTokens: profile.contextWindowTokens,
      maxOutputTokens: profile.maxOutputTokens,
      systemPrompt: SYSTEM_PROMPT,
      budgetRatio: profile.budgetRatio,
      charsPerToken: CHARS_PER_TOKEN
    });

    let host = "";
    try {
      host = new URL(profile.baseUrl).host;
    } catch {
      host = "unknown";
    }

    const fpObj = {
      rawContentSha256: rawSha,
      rawItemCount: rawItems.length,
      rawGeneration: rawDoc.generation || 1,
      template,
      templateRequested: templateRequest || "auto",
      modelId: profile.modelId,
      baseUrlHost: host,
      promptRevision: PROMPT_REVISION,
      schemaRevision: SCHEMA_REVISION,
      budgetRatio: profile.budgetRatio,
      contextWindowTokens: profile.contextWindowTokens
    };
    const fingerprintSha256 = store.canonicalFingerprint(fpObj);

    let job = await store.loadJob();
    let generation = 1;
    if (job && forceRefresh) {
      generation = (job.generation || 0) + 1;
    } else if (job && job.fingerprintSha256 === fingerprintSha256) {
      generation = job.generation || 1;
      if (job.status === JOB_STATUS.COMPLETED) {
        const corrected = await store.readFinal("corrected-transcript.json");
        const summary = await store.readFinal("summary.json");
        if (corrected && summary) {
          await store.assertRawUnchanged(rawSha);
          return { job, corrected, summary, reused: true };
        }
      }
      if (job.status === JOB_STATUS.FAILED || job.status === JOB_STATUS.CANCELLED) {
        const error = new Error(
          "analysis failed/cancelled; call analysis:retry — will not silent reset"
        );
        error.code = "analysis_needs_retry";
        error.job = job;
        throw error;
      }
    } else if (job) {
      generation = (job.generation || 1) + 1;
    }

    job = {
      schema: "analysis_job_v1",
      version: 1,
      generation,
      activeGenerationDir: store.relativeGenerationDir(generation),
      sessionId,
      status: JOB_STATUS.RUNNING,
      stage: STAGE.FINGERPRINT,
      template,
      templateSource,
      templateRequested: templateRequest || "auto",
      modelId: profile.modelId,
      profile: {
        provider: "openai-compatible",
        modelId: profile.modelId,
        contextWindowTokens: profile.contextWindowTokens,
        maxOutputTokens: profile.maxOutputTokens,
        budgetRatio: profile.budgetRatio,
        reasoningEffort: profile.reasoningEffort || null
      },
      source: {
        rawTranscriptRel: "transcription/qwen-no-bucket/raw-transcript.json",
        rawContentSha256: rawSha,
        rawItemCount: rawItems.length,
        rawGeneration: rawDoc.generation || 1
      },
      fingerprintSha256,
      promptRevision: PROMPT_REVISION,
      schemaRevision: SCHEMA_REVISION,
      batches: { total: 0, completed: 0 },
      attempts: (job?.attempts || 0) + 1,
      lastError: null,
      createdAt: job?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await store.saveJob(job);
    await store.ensureGenerationDir(generation);
    await store.writeStageArtifact(generation, "fingerprint.json", {
      schema: "analysis_fingerprint_v1",
      fingerprint: fpObj,
      fingerprintSha256
    });

    job.stage = STAGE.PLAN_BATCHES;
    await store.saveJob(job);
    let batchesPlan = await store.readStageArtifact(generation, "batches_plan.json");
    if (!batchesPlan || batchesPlan.inputHash !== fingerprintSha256) {
      const planned = planBatches(rawItems, {
        inputBudget: budget.inputBudget,
        charsPerToken: CHARS_PER_TOKEN
      });
      batchesPlan = {
        schema: "analysis_batches_plan_v1",
        inputHash: fingerprintSha256,
        batches: planned.map((b) => ({ index: b.index, itemIds: b.itemIds }))
      };
      await store.writeStageArtifact(generation, "batches_plan.json", batchesPlan);
    }
    job.batches.total = batchesPlan.batches.length;
    await store.saveJob(job);

    const itemById = buildItemIndex(rawItems);
    const allCorrections = [];
    const allExtracts = [];
    let rollingState = null;

    for (const bmeta of batchesPlan.batches) {
      throwIfAborted(signal);
      await store.assertRawUnchanged(rawSha);
      const batchItems = bmeta.itemIds.map((id) => itemById.get(String(id))).filter(Boolean);
      const batchIndex = bmeta.index;
      const batchInputHash = store.sha256Text(
        JSON.stringify(batchItems.map((i) => ({ id: i.id, text: i.text, t: i.textSha256 })))
      );

      job.stage = STAGE.CORRECT;
      job.batches.completed = batchIndex;
      await store.saveJob(job);
      const correctName = `batches/batch_${String(batchIndex).padStart(3, "0")}.correct.json`;
      let correctArt = await store.readStageArtifact(generation, correctName);
      if (!correctArt || correctArt.inputHash !== batchInputHash) {
        const modelOut = await callModel(buildCorrectUser(batchItems), {
          stage: "correct",
          rawSha
        });
        const normalized = normalizeCorrections(modelOut.items || [], batchItems);
        correctArt = {
          schema: "analysis_batch_correct_v1",
          batchIndex,
          inputHash: batchInputHash,
          items: normalized
        };
        const w = await store.writeStageArtifact(generation, correctName, correctArt);
        correctArt = w.doc;
      }
      allCorrections.push(...(correctArt.items || []));

      job.stage = STAGE.EXTRACT;
      await store.saveJob(job);
      const extractName = `batches/batch_${String(batchIndex).padStart(3, "0")}.extract.json`;
      let extractArt = await store.readStageArtifact(generation, extractName);
      const extractItems = (correctArt.items || []).map((c) => {
        const raw = itemById.get(c.sourceItemIds[0]);
        return {
          id: c.sourceItemIds[0],
          speakerId: c.speakerId,
          beginMs: c.sourceBeginMs,
          endMs: c.sourceEndMs,
          text: c.correctedText,
          textSha256: raw?.textSha256
        };
      });
      const extractInputHash = store.sha256Text(
        JSON.stringify({
          batch: extractItems,
          rolling: rollingState?.contentSha256 || null,
          template
        })
      );
      if (!extractArt || extractArt.inputHash !== extractInputHash) {
        const modelOut = await callModel(buildExtractUser(extractItems, template, rollingState), {
          stage: "extract",
          rawSha
        });
        extractArt = {
          schema: "analysis_batch_extract_v1",
          batchIndex,
          inputHash: extractInputHash,
          inputItemIds: bmeta.itemIds,
          executiveSummary: modelOut.executiveSummary || null,
          topicsOutline: modelOut.topicsOutline || [],
          facts: modelOut.facts || [],
          entities: modelOut.entities || [],
          timeline: modelOut.timeline || [],
          decisions: modelOut.decisions || [],
          actionItems: modelOut.actionItems || [],
          openIssues: modelOut.openIssues || [],
          risks: modelOut.risks || [],
          speakerPoints: modelOut.speakerPoints || [],
          keyQuotes: modelOut.keyQuotes || [],
          coreIdeas: modelOut.coreIdeas || [],
          argumentOutline: modelOut.argumentOutline || [],
          supportingPoints: modelOut.supportingPoints || [],
          assumptions: modelOut.assumptions || [],
          openQuestions: modelOut.openQuestions || [],
          nextSteps: modelOut.nextSteps || [],
          flaggedUncertain: modelOut.flaggedUncertain || []
        };
        const w = await store.writeStageArtifact(generation, extractName, extractArt);
        extractArt = w.doc;
      }
      allExtracts.push(extractArt);

      job.stage = STAGE.ROLL;
      await store.saveJob(job);
      const rollName = `state/rolling_after_${String(batchIndex).padStart(3, "0")}.json`;
      let rollArt = await store.readStageArtifact(generation, rollName);
      const rollInputHash = store.sha256Text(
        JSON.stringify({
          prev: rollingState?.contentSha256 || null,
          extract: extractArt.outputSha256 || extractInputHash
        })
      );
      if (!rollArt || rollArt.inputHash !== rollInputHash) {
        const evidenceIndex = { ...(rollingState?.evidenceIndex || {}) };
        for (const id of bmeta.itemIds) {
          const it = itemById.get(String(id));
          if (it) {
            evidenceIndex[id] = {
              beginMs: it.sessionBeginMs ?? it.artifactBeginMs ?? it.beginMs ?? null,
              endMs: it.sessionEndMs ?? it.artifactEndMs ?? it.endMs ?? null
            };
          }
        }
        let built = {
          schema: "analysis_rolling_state_v1",
          afterBatch: batchIndex,
          inputHash: rollInputHash,
          confirmedFacts: [
            ...(rollingState?.confirmedFacts || []),
            ...(extractArt.facts || [])
          ],
          entities: [...(rollingState?.entities || []), ...(extractArt.entities || [])],
          decisions: [...(rollingState?.decisions || []), ...(extractArt.decisions || [])],
          actionItems: [
            ...(rollingState?.actionItems || []),
            ...(extractArt.actionItems || [])
          ],
          openIssues: [...(rollingState?.openIssues || []), ...(extractArt.openIssues || [])],
          evidenceIndex,
          contentSha256: null
        };
        built = capRollingState(built, budget.rollingCap, CHARS_PER_TOKEN);
        built.inputHash = rollInputHash;
        built.contentSha256 = store.sha256Text(
          JSON.stringify({ ...built, contentSha256: null, outputSha256: undefined })
        );
        const w = await store.writeStageArtifact(generation, rollName, built);
        rollArt = w.doc;
      }
      rollingState = rollArt;
      job.batches.completed = batchIndex + 1;
      await store.saveJob(job);
      await store.assertRawUnchanged(rawSha);
    }

    // Hierarchical MERGE
    job.stage = STAGE.MERGE;
    await store.saveJob(job);
    const mergeRoot = await hierarchicalMerge(
      allExtracts,
      template,
      budget,
      generation,
      rawSha
    );

    // Final merge pointer
    await store.writeStageArtifact(generation, "merge/merged_extract.json", {
      schema: "analysis_merge_v1",
      inputHash: mergeRoot.inputHash,
      template,
      draft: mergeRoot.draft
    });

    job.stage = STAGE.VERIFY;
    await store.saveJob(job);
    await store.assertRawUnchanged(rawSha);
    const draft = {
      ...(mergeRoot.draft || {}),
      template,
      sessionId,
      generation,
      sourceRawSha256: rawSha
    };
    let verified = validateSummaryEvidence(draft, rawItems);
    // Hard fail only if verification explicitly failed
    if (verified.verification && verified.verification.passed === false) {
      const error = new Error("analysis verification failed");
      error.code = "analysis_verification_failed";
      job.status = JOB_STATUS.FAILED;
      job.lastError = { code: "analysis_verification_failed", message: "verification.passed is false" };
      await store.saveJob(job);
      throw error;
    }
    await store.writeStageArtifact(generation, "merge/verified_extract.json", {
      schema: "analysis_verified_v1",
      inputHash: mergeRoot.outputSha256 || mergeRoot.inputHash,
      summary: verified
    });

    job.stage = STAGE.FINALIZE;
    await store.saveJob(job);
    await store.assertRawUnchanged(rawSha);
    const correctedDoc = {
      schema: "corrected_transcript_v1",
      sessionId,
      generation,
      sourceRawSha256: rawSha,
      template,
      policy: {
        rawImmutable: true,
        uncertainNotGuessed: true,
        timestampPrecision: rawDoc.timestampPrecision || "segment"
      },
      count: allCorrections.length,
      items: allCorrections
    };
    await store.writeFinal(generation, "corrected-transcript.json", correctedDoc);
    await store.writeFinal(generation, "summary.json", verified);
    await store.assertRawUnchanged(rawSha);

    job.status = JOB_STATUS.COMPLETED;
    job.stage = STAGE.DONE;
    job.lastError = null;
    job.batches.completed = job.batches.total;
    await store.saveJob(job);
    log("analysis_completed", { sessionId, generation, batches: job.batches.total });
    return { job, corrected: correctedDoc, summary: verified, reused: false };
  }

  return { run };
}

module.exports = {
  createAnalysisPipeline,
  SYSTEM_PROMPT
};
