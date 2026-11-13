"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { createHotwordStore, correctionCandidate, instantVocabulary, normalizeWords, term } = require("../src/hotwords");
const { createVoicePipeline } = require("../src/providers/voice-pipeline");

function memoryFs() {
  const files = new Map();
  return { files,
    stat: async file => { if (!files.has(file)) throw Object.assign(new Error(), { code: "ENOENT" }); return { size: Buffer.byteLength(files.get(file)) }; },
    readFile: async file => files.get(file),
    mkdir: async () => {},
    writeFile: async (file, value) => { files.set(file, value); },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); }
  };
}

async function main() {
  const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const teardown = mainSource.slice(mainSource.indexOf("function stopCorrectionObservation()"), mainSource.indexOf("function observeInsertedText("));
  const observerState = { correctionGeneration: 0, correctionObservation: { stop() { throw new Error("fixture"); } }, logEvent() {} };
  vm.runInNewContext(`${teardown}; stopCorrectionObservation();`, observerState);
  assert.equal(observerState.correctionObservation, null);
  assert.equal(observerState.correctionGeneration, 1, "teardown cannot block future dictation");
  const fsImpl = memoryFs();
  const store = createHotwordStore({ directory: "fixture", fsImpl, platform: "win32" });
  assert.deepEqual(store.words(), []);
  let data = await store.get();
  assert.equal(data.observeCorrections, false);
  assert.equal(store.canObserve(), false);
  await Promise.all(["MiMo", "祺元", "Visual Studio Code"].map(text => store.update({ action: "upsert", text })));
  assert.deepEqual(store.words(), ["MiMo", "祺元", "Visual Studio Code"]);
  await store.update({ action: "upsert", text: "mimo" });
  assert.equal(store.words().length, 3, "case-insensitive upserts do not multiply terms");
  const first = (await store.get()).entries[0];
  await store.update({ action: "upsert", id: first.id, text: "MiMo", enabled: false });
  assert.deepEqual(store.words(), ["祺元", "Visual Studio Code"]);
  await assert.rejects(store.update({ action: "upsert", id: first.id, text: "祺元" }), /duplicate/);
  await assert.rejects(store.update({ action: "upsert", text: "这是超过十五个中文字符的热词肯定不可以" }), /invalid_term/);
  await assert.rejects(store.update({ action: "upsert", text: "<instructions>" }), /invalid_term/);
  assert.throws(() => term("__proto__"));
  assert.throws(() => term("one two three four five six seven eight"));
  assert.equal(term("  C++  "), "C++");
  assert.deepEqual(normalizeWords(["MiMo", "mimo", "", "x\ny"]), ["MiMo"]);
  assert.deepEqual(instantVocabulary("qwen-audio-3.0-asr-flash-streaming", ["MiMo", "祺元"]), { MiMo: 4, 祺元: 4 });
  assert.equal(instantVocabulary("fun-asr-realtime", ["MiMo"]), undefined);
  assert.equal(instantVocabulary("qwen3-asr-flash-realtime", ["MiMo"]), undefined);
  assert.equal(instantVocabulary("qwen-audio-3.0-asr-flash-streaming", []), undefined);
  assert.equal(instantVocabulary("qwen-audio-3.0-asr-flash-streaming-2026-02-10", ["MiMo"]).MiMo, 4);

  const before = "请把米摩模型的报告发给项目负责人。";
  const after = "请把MiMo模型的报告发给项目负责人。";
  assert.deepEqual(correctionCandidate(before, after), { from: "米摩", to: "MiMo" });
  assert.deepEqual(correctionCandidate("接下来我们讨论祁元项目的详细实施方案。", "接下来我们讨论祺元项目的详细实施方案。"), { from: "祁元", to: "祺元" });
  for (const pair of [[before, before], [before, ""], [before, after + "再增加一个新的要求。"],
    ["请你使用旧模型分析这份报告。", "请你使用新模型分析这份报告。"],
    ["这个版本需要使用20秒超时。", "这个版本需要使用30秒超时。"],
    ["请保留这段完全正确的文字。", "请把整段改写成为另外的观点。"],
    ["请你删除这个要求然后重新开始。", "请你不要删除这个要求然后重新开始。"]]) {
    assert.equal(correctionCandidate(...pair), null);
  }
  assert.equal(await store.recordCorrection({ before, after }), false, "observation defaults off");
  await store.update({ action: "remove", id: first.id });
  await store.update({ action: "configure", observeCorrections: true });
  assert.equal(await store.recordCorrection({ before, after }), true);
  assert.equal(store.words().includes("MiMo"), false, "candidates are never sent to providers");
  const candidate = (await store.get()).candidates[0];
  await store.recordCorrection({ before, after });
  assert.equal((await store.get()).candidates[0].count, 2);
  const disk = fsImpl.files.get(path.join("fixture", "hotwords.json"));
  assert.ok(!disk.includes("项目负责人"), "full editor/transcript text is not persisted");
  await store.update({ action: "accept", id: candidate.id });
  assert.ok(store.words().includes("MiMo"));
  assert.equal((await store.get()).candidates.length, 0);
  await store.update({ action: "configure", enabled: false });
  assert.deepEqual(store.words(), []);
  assert.equal(store.canObserve(), false);
  await store.update({ action: "configure", enabled: true });
  const reloaded = createHotwordStore({ directory: "fixture", fsImpl, platform: "win32" });
  assert.deepEqual(await reloaded.get(), await store.get());
  data = await reloaded.get(); data.entries[0].text = "tampered";
  assert.ok(!reloaded.words().includes("tampered"));

  const other = { before: "请打开欧比西安查看今天的项目笔记。", after: "请打开Obsidian查看今天的项目笔记。" };
  assert.equal(await store.recordCorrection(other), true);
  await store.update({ action: "dismiss", id: (await store.get()).candidates[0].id });
  assert.equal(await store.recordCorrection(other), false, "dismissed pairs do not reappear");
  const mac = createHotwordStore({ directory: "fixture", fsImpl, platform: "darwin" });
  assert.equal((await mac.get()).observationAvailable, false);
  assert.equal(mac.canObserve(), false);
  assert.deepEqual(mac.words(), store.words(), "shared approved vocabulary remains portable");

  const brokenFs = memoryFs(); brokenFs.files.set(path.join("broken", "hotwords.json"), "invalid");
  const broken = createHotwordStore({ directory: "broken", fsImpl: brokenFs });
  await assert.rejects(broken.get(), /unavailable/);
  await assert.rejects(broken.update({ action: "upsert", text: "MiMo" }), /unavailable/);
  assert.equal(brokenFs.files.get(path.join("broken", "hotwords.json")), "invalid");

  const atomicFs = memoryFs();
  const atomic = createHotwordStore({ directory: "atomic", fsImpl: atomicFs });
  await atomic.update({ action: "upsert", text: "MiMo" });
  atomicFs.rename = async () => { throw new Error("disk_full"); };
  await assert.rejects(atomic.update({ action: "upsert", text: "Qwen" }));
  assert.deepEqual(atomic.words(), ["MiMo"], "failed writes do not publish unpersisted state");

  const contexts = [];
  const pipeline = createVoicePipeline({ getSettings: () => ({ asrProvider: "mimo", cleanerProvider: "mimo" }),
    getHotwords: () => store.words(), providerOverrides: {
      asrProviders: { mimo: { id: "fixture", transcribeFast: async () => ({ text: before }), transcribeRaw: async () => ({ text: before }) } },
      cleanerProviders: { mimo: { id: "fixture", clean: async args => { contexts.push(args.shortContext); return { text: after }; } } }
    } });
  await pipeline.transcribe({ audioDataUrl: "data:audio/wav;base64,fixture", transcriptionMode: "stable", shortContext: "本次术语" });
  assert.ok(contexts[0].includes("MiMo"));
  assert.ok(contexts[0].includes("本次术语"), "approved terms must not replace explicit request vocabulary");
  assert.ok(!contexts[0].includes("米摩"));
  assert.ok(!contexts[0].includes("负责人"));
  await store.update({ action: "configure", enabled: false });
  await pipeline.cleanText({ rawText: before });
  assert.equal(contexts[1], undefined, "turning vocabulary off stops later cleaner injection");
  await pipeline.transcribe({ audioDataUrl: "data:audio/wav;base64,fixture", transcriptionMode: "fast" });
  assert.equal(contexts.length, 2, "fast mode never calls the cleaner");
  console.log("Hotword persistence, candidate privacy, capability and pipeline tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
