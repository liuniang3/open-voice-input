"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { ensureConnectionProfiles } = require("../src/settings/connection-profiles");
const { validateHotkey, normalizeAccelerator } = require("../src/hotkeys/validate-hotkey");

const root = path.resolve(__dirname, "..");
const tick = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise(setImmediate);
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
};

// Reuse the shared main.js Electron harness with only the file-summary module stubbed.
const harnessSource = fs.readFileSync(path.join(__dirname, "test-settings-shortcuts.js"), "utf8");
const harnessSlice = harnessSource.slice(
  harnessSource.indexOf("function mainHarness("),
  harnessSource.indexOf("async function integrationTests(")
);
const anchor = '    "./platform/macos": mac';
assert.equal(harnessSlice.split(anchor).length - 1, 1, "harness stub anchor must stay unique");
// buildFileSummaryService resolves the summary LLM profile at construction, so
// the harness also needs the meeting provider adapters stubbed.
const providerStubs = {
  meetingTextProfile: (_settings, options = {}) => ({
    provider: "text-supplier",
    supplierId: options.supplierId || "stub-supplier",
    modelId: options.modelId || "stub-model",
    apiKey: "stub-key",
    baseUrl: "https://stub.example/v1",
    apiStyle: "chat-completions",
    requestTimeoutMs: 1000,
    maxOutputTokens: 256
  }),
  profileFor: (_settings, modelId) => ({ provider: "test", modelId, apiKey: "stub-key", baseUrl: "https://stub.example/v1" }),
  languageModel: () => async () => "stub",
  transcriber: () => async () => ({ text: "stub" })
};
const harnessCode = harnessSlice.replace(
  anchor,
  `${anchor},\n    "./meeting/processing/file-summary": fileSummaryStub,\n    "./meeting/realtime/providers": providerStubs`
);

const fileSummaryStub = {
  createFileSummaryService: () => { throw new Error("file summary service factory not configured"); },
  toFileSummaryDto: require("../src/meeting/processing/file-summary").toFileSummaryDto,
  readLatestSummaryResult: async () => null,
  segmentsFromTranscript: () => []
};

const mainHarness = vm.runInNewContext(`${harnessCode}\nmainHarness;`, {
  fs, path, vm, pathToFileURL, root, require,
  ensureConnectionProfiles, validateHotkey, normalizeAccelerator,
  fileSummaryStub, providerStubs, Buffer, URL, structuredClone, console
});

const createdServices = [];

function configureServiceFactory() {
  createdServices.length = 0;
  fileSummaryStub.createFileSummaryService = (options) => {
    const gate = deferred();
    const dto = {
      sessionId: options.sessionId,
      status: "running",
      progress: { completed: 0, failed: 0, total: 0 },
      modelId: options.modelId,
      useMimoReview: options.useMimoReview === true,
      title: "",
      summaryMarkdownPath: "",
      summary: null,
      error: null
    };
    const service = {
      options,
      gate,
      outcome: "completed",
      cancelCalls: 0,
      summarizeCalls: [],
      report(patch) {
        Object.assign(dto, patch);
        options.onUpdate?.(JSON.parse(JSON.stringify(dto)));
      },
      async summarize(payload) {
        this.summarizeCalls.push(payload);
        dto.status = "running";
        dto.error = null;
        await this.gate.promise;
        dto.status = this.outcome;
        return JSON.parse(JSON.stringify(dto));
      },
      async status() {
        return JSON.parse(JSON.stringify(dto));
      },
      cancel() {
        this.cancelCalls += 1;
        if (dto.status === "running") {
          this.outcome = "cancelled";
          this.gate.resolve();
        }
      },
      readLatest: async () => null
    };
    createdServices.push(service);
    return service;
  };
}

function makeHarness(platform = "darwin") {
  configureServiceFactory();
  const h = mainHarness(platform);
  h.run('getMeetingCapture().store.readSession = async (id) => ({ session: { id, source: "import" }, sessionDir: "D:/mock/sessions/" + id });');
  return h;
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

for (const platform of ["win32", "darwin"]) {
  test(`${platform}: file summary runs through navigation and publishes safe background results`, async () => {
    const h = makeHarness(platform);
    await h.invoke("meeting:file-summary:start", { sessionId: "s-background", modelId: "model-a" });
    await h.invoke("window:settings");
    await h.invoke("window:home");
    await h.invoke("window:file");
    await h.invoke("window:meeting");
    await h.invoke("window:settings");
    const service = createdServices[0];
    service.report({ progress: { stage: "receiving", outputChars: 1200 }, apiKey: "fixture-secret",
      responseBody: "fixture-private-response" });
    const update = h.controls.sent.filter(([channel]) => channel === "meeting:file-summary:update").at(-1)[1];
    assert.equal(update.sessionId, "s-background");
    assert.equal(update.progress.outputChars, 1200);
    assert.equal(update.apiKey, undefined);
    assert.equal(update.responseBody, undefined);
    service.report({ summary: { schema: "meeting_summary_v2", title: "Background article",
      markdown: "A completed article.", sections: [] } });
    service.gate.resolve();
    await tick();
    const final = h.controls.sent.filter(([channel]) => channel === "meeting:file-summary:update").at(-1)[1];
    assert.equal(final.status, "completed");
    assert.equal(final.summary.markdown, "A completed article.");
    assert.equal(service.cancelCalls, 0, "only the explicit cancel IPC may cancel a job");
    assert.equal(service.summarizeCalls.length, 1);
    assert.equal(h.run("windowMode"), "settings", "background completion never steals the current view");
    const readback = await h.invoke("meeting:file-summary:status", { sessionId: "s-background" });
    assert.equal(readback.summary.status, "completed");
    assert.equal(createdServices.length, 1);

    await h.invoke("meeting:file-summary:start", { sessionId: "s-background", modelId: "model-b" });
    const before = h.controls.sent.length;
    service.report({ progress: { outputChars: 9000 } });
    assert.equal(h.controls.sent.length, before, "obsolete jobs cannot publish into a new generation");
    await h.invoke("meeting:file-summary:cancel", { sessionId: "s-background" });
    assert.equal(createdServices[1].cancelCalls, 1);
  });
}

test("start deduplicates only while running; failure keeps status and permits retry", async () => {
  const h = makeHarness();
  const first = await h.invoke("meeting:file-summary:start", { sessionId: "s-lifecycle", modelId: "model-a" });
  assert.equal(first.ok, true);
  assert.equal(first.summary.status, "running");
  assert.equal(createdServices.length, 1);
  assert.equal(createdServices[0].summarizeCalls.length, 1);
  assert.equal(createdServices[0].summarizeCalls[0].retryFailed, true);

  // A second start while the run is in flight must dedupe (even with new options).
  const inflight = await h.invoke("meeting:file-summary:start", { sessionId: "s-lifecycle", modelId: "model-b" });
  assert.equal(inflight.summary.status, "running");
  assert.equal(createdServices.length, 1, "in-flight start is deduplicated");

  createdServices[0].outcome = "failed";
  createdServices[0].gate.resolve();
  await tick();
  const failed = await h.invoke("meeting:file-summary:status", { sessionId: "s-lifecycle" });
  assert.equal(failed.summary.status, "failed", "failed status stays readable in memory");
  assert.equal(createdServices.length, 1, "status reads never spawn services");

  // Retry after failure builds a fresh job with retryFailed semantics.
  const retry = await h.invoke("meeting:file-summary:retry", { sessionId: "s-lifecycle", modelId: "model-a" });
  assert.equal(retry.ok, true);
  assert.equal(retry.summary.status, "running");
  assert.equal(createdServices.length, 2, "retry after failure starts a new run");
  assert.equal(createdServices[1].summarizeCalls.length, 1);
  assert.equal(createdServices[1].summarizeCalls[0].retryFailed, true);

  createdServices[1].gate.resolve(); // outcome stays completed
  await tick();
  const done = await h.invoke("meeting:file-summary:status", { sessionId: "s-lifecycle" });
  assert.equal(done.summary.status, "completed");
});

test("regeneration after completion uses the new model and review selection", async () => {
  const h = makeHarness();
  await h.invoke("meeting:file-summary:start", { sessionId: "s-regen", modelId: "model-a" });
  assert.equal(createdServices.length, 1);
  createdServices[0].gate.resolve();
  await tick();
  const done = await h.invoke("meeting:file-summary:status", { sessionId: "s-regen" });
  assert.equal(done.summary.status, "completed");

  const regen = await h.invoke("meeting:file-summary:start", {
    sessionId: "s-regen", modelId: "model-b", useMimoReview: true, reviewModelId: "mimo-v2.5-asr"
  });
  assert.equal(regen.summary.status, "running");
  assert.equal(createdServices.length, 2, "completed job does not block regeneration");
  assert.equal(createdServices[1].options.modelId, "model-b");
  assert.equal(createdServices[1].options.reviewModelId, "mimo-v2.5-asr");
  assert.equal(createdServices[1].summarizeCalls[0].useMimoReview, true);

  createdServices[1].outcome = "failed";
  createdServices[1].gate.resolve();
  await tick();
  const failed = await h.invoke("meeting:file-summary:status", { sessionId: "s-regen" });
  assert.equal(failed.summary.status, "failed");
  // A further start with the original selection is allowed again.
  await h.invoke("meeting:file-summary:start", { sessionId: "s-regen", modelId: "model-a", useMimoReview: false });
  assert.equal(createdServices.length, 3, "failed regeneration does not latch the job");
});

test("cancel settles the in-flight run before answering status", async () => {
  const h = makeHarness();
  await h.invoke("meeting:file-summary:start", { sessionId: "s-cancel", modelId: "model-a" });
  assert.equal(createdServices.length, 1);
  const cancelled = await h.invoke("meeting:file-summary:cancel", { sessionId: "s-cancel" });
  assert.equal(cancelled.ok, true);
  assert.equal(createdServices[0].cancelCalls, 1);
  assert.equal(cancelled.summary.status, "cancelled", "status answers after the abort settles");
  // Cancelled jobs are not running: a new start must proceed.
  const restarted = await h.invoke("meeting:file-summary:start", { sessionId: "s-cancel", modelId: "model-a" });
  assert.equal(restarted.summary.status, "running");
  assert.equal(createdServices.length, 2);
});

test("start on a missing session reports session_not_found without spawning jobs", async () => {
  const h = makeHarness();
  h.run('getMeetingCapture().store.readSession = async () => (null);');
  const missing = await h.invoke("meeting:file-summary:start", { sessionId: "s-none", modelId: "model-a" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "session_not_found");
  assert.equal(createdServices.length, 0);
});

async function main() {
  for (const { name, run } of tests) {
    await run();
    console.log(`ok - ${name}`);
  }
  console.log(`${tests.length} file summary lifecycle tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
