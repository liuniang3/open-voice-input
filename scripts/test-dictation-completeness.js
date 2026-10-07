"use strict";

const assert = require("node:assert/strict");
const { buildTextCleanupMessages, parseAndValidateCleanupResponse } = require("../src/providers/cleaner/text-cleanup-method");
const { createVoicePipeline } = require("../src/providers/voice-pipeline");
const { createMimoCleanerProvider } = require("../src/providers/cleaner/mimo-cleaner-provider");
const { createOpenAiCompatibleCleanerProvider } = require("../src/providers/cleaner/openai-compatible-cleaner-provider");
const { createOpenCodeGoCleanerProvider } = require("../src/providers/cleaner/opencode-go-cleaner-provider");

const raw = "请美化录音窗口，使用真实的背景频谱，取消按钮不要突兀。最后还要确保完整输入全部内容，不能遗漏末尾的要求。";
const complete = "请用真实背景频谱美化录音窗口，并弱化取消按钮。请确保完整输入全部内容，不遗漏末尾的要求。";

async function run() {
  const prompt = buildTextCleanupMessages(raw)[0].content;
  assert.match(prompt, /从原始转写的第一句开始，连续整理到最后一句/);
  assert.match(prompt, /返回 JSON 前，请确认整理结果已经明确写出原文的全部主要内容/);
  assert.match(prompt, /原文没有省略号时，整理结果也保持没有省略号/);
  for (const ending of ["…", "……", "...", ". . .", "⋯", "…。", "…\"", "...)"]) {
    assert.equal(parseAndValidateCleanupResponse(JSON.stringify({ text: "请美化录音窗口，并弱化取消按钮" + ending }), raw), "", ending);
  }
  assert.equal(parseAndValidateCleanupResponse(JSON.stringify({ text: complete }), raw, { finishReason: "stop" }), complete);
  assert.equal(parseAndValidateCleanupResponse(JSON.stringify({ text: "我还需要再想想……" }), "嗯，我还需要再想想……"), "我还需要再想想……", "genuine ellipsis in source remains supported");
  assert.equal(parseAndValidateCleanupResponse(JSON.stringify({ text: "刚刚看到的内容，请你看看。" }), "刚刚看到的内容，请你看看。"), "刚刚看到的内容，请你看看。", "normal reduplication remains intact");
  for (const finishReason of ["length", "max_tokens", "max_output_tokens", "incomplete", "content_filter", "failed", "error"]) {
    assert.equal(parseAndValidateCleanupResponse(JSON.stringify({ text: complete }), raw, { finishReason }), "", finishReason);
  }
  assert.equal(parseAndValidateCleanupResponse(JSON.stringify({ text: complete }), raw, { status: "incomplete" }), "");
  assert.equal(parseAndValidateCleanupResponse(JSON.stringify({ text: complete }), raw), complete, "legacy endpoints without a finish marker remain compatible");
  for (const create of [createMimoCleanerProvider, createOpenAiCompatibleCleanerProvider, createOpenCodeGoCleanerProvider]) {
    const provider = create({ client: { requestChat: async () => ({ content: JSON.stringify({ text: complete }), finishReason: "length" }) } });
    assert.equal((await provider.clean({ rawText: raw })).text, "", "legacy provider completion metadata reaches validation");
  }
  const oldFetch = globalThis.fetch;
  try {
    for (const apiStyle of ["chat-completions", "responses"]) {
      for (const failure of ["ellipsis", "output-limit"]) {
        const records = [];
        const requests = [];
        const settings = {
          asrProvider: "mimo", asrModel: "mimo-v2.5-asr", transcriptionMode: "stable", _languageSuppliersMigrated: true,
          textSuppliers: [{ id: "voice-cleaner", name: "Test cleaner", baseUrl: "https://fixture.invalid/v1", apiKey: "test-only-cleaner", apiStyle }],
          textSupplierCatalogs: { "voice-cleaner": { models: ["deepseek-v4.1-flash"], capabilities: { "deepseek-v4.1-flash": { maxOutput: 32768, contextWindow: 1000000 } } } },
          textModelSelections: { cleanup: { supplierId: "voice-cleaner", modelId: "deepseek-v4.1-flash" } }
        };
        globalThis.fetch = async (url, init) => {
          requests.push({ url, body: JSON.parse(init.body) });
          const text = JSON.stringify({ text: failure === "ellipsis" ? "请美化录音窗口，并弱化取消按钮……" : complete });
          const body = apiStyle === "responses" ? {
            status: failure === "output-limit" ? "incomplete" : "completed", output_text: text,
            incomplete_details: failure === "output-limit" ? { reason: "max_output_tokens" } : undefined,
            output: [{ type: "message", content: [{ type: "output_text", text }] }]
          } : { choices: [{ message: { content: text }, finish_reason: failure === "output-limit" ? "length" : "stop" }] };
          return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) };
        };
        const pipeline = createVoicePipeline({ getSettings: () => settings, onTranscript: value => { records.push(value); },
          providerOverrides: { asrProviders: { mimo: { id: "test-asr", transcribeRaw: async () => ({ text: raw }) } } } });
        const history = { requestId: "00000000-0000-4000-a000-000000000001", durationMs: 106000 };
        for (const action of [
          () => pipeline.cleanText({ rawText: raw, history }),
          () => pipeline.transcribe({ audioDataUrl: "data:audio/wav;base64,test", history })
        ]) assert.equal(await action(), raw, "unsafe cleanup returns the full transcription including the last requirement");
        assert.equal(records.length, 2);
        assert.equal(requests.length, 2, "do not silently spend another request or switch providers");
        for (const record of records) { assert.equal(record.rawText, raw); assert.equal(record.text, raw); assert.equal(record.cleanupApplied, false); }
        for (const request of requests) {
          assert.equal(request.body[apiStyle === "responses" ? "max_output_tokens" : "max_completion_tokens"], 32768, "keep the user model output budget; never impose a fixed 2048 cap");
        }
      }
    }
  } finally { globalThis.fetch = oldFetch; }
  console.log("PASS dictation completeness: generated trailing ellipses, transport truncation, genuine source punctuation, normal repeated words, every cleaner provider, both API styles and full-text fallback with unchanged output budgets");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
