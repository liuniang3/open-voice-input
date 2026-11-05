"use strict";
const assert = require("node:assert/strict");
const { mainHarness } = require("./test-settings-shortcuts");

(async () => {
  let enabled = false, recorded = 0, stopped = 0;
  const observers = [];
  const store = {
    ready: async () => {}, words: () => ["MiMo"], canObserve: () => enabled,
    get: async () => ({ enabled }),
    update: async payload => {
      if (payload.action === "fail") throw new Error("private-provider-body");
      enabled = payload.observeCorrections;
      return { enabled };
    },
    recordCorrection: async () => { recorded++; return true; }
  };
  const h = mainHarness("win32", {
    "./hotwords": { createHotwordStore: () => store },
    "./platform/windows-correction-observer": { startCorrectionObservation(options) {
      observers.push(options); return { stop() { stopped++; } };
    } }
  });
  assert.equal((await h.invoke("hotwords:get")).enabled, false);
  const evil = { sender: { getURL: () => "https://untrusted.invalid" }, senderFrame: { url: "https://untrusted.invalid" } };
  await assert.rejects(h.invoke("hotwords:get", {}, evil), /hotwords_unavailable/);
  await assert.rejects(h.invoke("hotwords:update", { action: "configure", observeCorrections: true }, evil), /hotwords_unavailable/);
  assert.equal(enabled, false);
  h.run('observeInsertedText("123", "Only this synthetic text.")');
  assert.equal(observers.length, 0, "default-off never spawns a reader");
  await h.invoke("hotwords:update", { action: "configure", observeCorrections: true });
  h.run('observeInsertedText("123", "Only this synthetic text.")');
  assert.equal(observers.length, 1);
  assert.equal(observers[0].target, "123");
  h.run('observeInsertedText("456", "Another synthetic text.")');
  assert.equal(stopped, 1);
  await observers[0].onCorrection({ before: "old", after: "stale" });
  assert.equal(recorded, 0, "stale observer callbacks never persist");
  await observers[1].onCorrection({ before: "new", after: "current" });
  assert.equal(recorded, 1);
  assert.ok(h.controls.sent.some(([name]) => name === "hotwords:updated"));
  observers[0].onStatus({ status: "helper-exit" });
  assert.ok(h.run("correctionObservation"), "old helper termination cannot release the current observer");
  await h.invoke("hotwords:update", { action: "configure", observeCorrections: false });
  assert.equal(stopped, 2);
  await observers[1].onCorrection({ before: "new", after: "late" });
  assert.equal(recorded, 1);
  await h.invoke("hotwords:update", { action: "configure", observeCorrections: true });
  h.run('observeInsertedText("789", "Only this final synthetic text.")');
  observers[2].onStatus({ status: "corrected" });
  assert.equal(h.run("correctionObservation"), null, "completed observations release their input buffers");
  await assert.rejects(h.invoke("hotwords:update", { action: "fail" }), error => error.message === "hotwords_unavailable");
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/main.js"), "utf8");
  const inject = source.slice(source.indexOf("async function injectText(text)"), source.indexOf("function getForegroundWindowHandle()"));
  assert.match(inject, /await sendTextKeystrokes\(text\);\s*observeInsertedText\(targetWindowHandle, text\)/);
  console.log("Hotword IPC sender isolation, opt-in, notifications and stale observer cancellation passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
