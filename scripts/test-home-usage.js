"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createUsageStats, characterCount } = require("../src/usage-stats");
const { createOnboardingState } = require("../src/onboarding-state");

function memoryFs() {
  const files = new Map();
  let failRename = false;
  return {
    files, failNextRename() { failRename = true; },
    async mkdir() {},
    async readFile(file) {
      if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(file);
    },
    async writeFile(file, content) { files.set(file, content); },
    async rename(from, to) {
      if (failRename) { failRename = false; throw new Error("write unavailable"); }
      assert(files.has(from)); files.set(to, files.get(from)); files.delete(from);
    }
  };
}

async function run() {
  let date = new Date(2026, 8, 27, 23, 59);
  const directory = path.resolve("mock-user-data");
  const fs = memoryFs();
  const stats = createUsageStats({ directory, fsImpl: fs, now: () => date });
  assert.equal(characterCount("a\u0301 \u4f60 \ud83d\udc69\u200d\ud83d\udcbb\n"), 3);
  assert.equal((await stats.get()).today.count, 0);
  const id = randomUUID();
  await stats.record({ requestId: id, text: "private transcription" });
  assert.equal((await stats.record({ requestId: id, text: "retry" })).recorded, false);
  assert.equal((await stats.record({ requestId: "invalid", text: "test" })).recorded, false);
  assert.equal((await stats.record({ requestId: randomUUID(), text: "  " })).recorded, false);
  const saved = fs.files.get(path.join(directory, "voice-usage.json"));
  assert(!saved.includes("private") && !saved.includes("transcription") && !saved.includes("apiKey"));
  date = new Date(2026, 8, 28, 0, 1);
  assert.equal((await stats.get()).week.count, 0, "Monday starts a new local week");
  await Promise.all(Array.from({ length: 20 }, () => stats.record({ requestId: randomUUID(), text: "abc" })));
  const summary = await stats.get();
  assert.equal(summary.today.count, 20); assert.equal(summary.week.characters, 60);
  const restored = createUsageStats({ directory, fsImpl: fs, now: () => date });
  assert.deepEqual(await restored.get(), summary);
  const failedId = randomUUID(); fs.failNextRename();
  await assert.rejects(stats.record({ requestId: failedId, text: "failure" }));
  assert.equal((await stats.get()).today.count, 20, "failed persistence cannot mutate counters");
  assert.equal((await stats.record({ requestId: failedId, text: "failure" })).recorded, true);
  date = new Date(2028, 8, 28);
  await stats.record({ requestId: randomUUID(), text: "new" });
  const pruned = JSON.parse(fs.files.get(path.join(directory, "voice-usage.json")));
  assert.equal(Object.keys(pruned.days).length, 1);
  fs.files.set(path.join(directory, "voice-usage.json"), "invalid json");
  const corrupted = createUsageStats({ directory, fsImpl: fs });
  await assert.rejects(corrupted.get(), { code: "usage_storage_unavailable" });
  assert.equal(fs.files.get(path.join(directory, "voice-usage.json")), "invalid json");

  const guideFs = memoryFs();
  const guide = createOnboardingState({ directory, fsImpl: guideFs, now: () => date });
  assert.equal((await guide.read()).status, "pending");
  await Promise.all([guide.finish("skipped"), guide.finish("completed")]);
  assert.equal((await guide.read()).status, "completed");
  assert.equal((await createOnboardingState({ directory, fsImpl: guideFs }).read()).status, "completed");
  await assert.rejects(guide.finish("pending"), /onboarding_status_invalid/);
  guideFs.failNextRename(); await assert.rejects(guide.finish("skipped"));
  assert.equal((await guide.read()).status, "completed");
  await guide.finish("skipped");
  const existingFs = memoryFs();
  const existing = createOnboardingState({ directory, fsImpl: existingFs });
  assert.equal((await existing.read({ existingUser: true })).status, "migrated");
  assert.equal((await createOnboardingState({ directory, fsImpl: existingFs }).read()).status, "migrated");
  console.log("Homepage usage privacy, atomic persistence, dedupe, date boundaries and onboarding tests passed.");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
