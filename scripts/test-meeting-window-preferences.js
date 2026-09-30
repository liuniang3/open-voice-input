"use strict";

const assert = require("node:assert/strict");
const { normalizePresentation, minimalBounds, visibleBounds, createMeetingWindowStore } = require("../src/settings/meeting-window");

async function run() {
  assert.equal(minimalBounds({ width: 420, height: 260 }), false);
  assert.equal(minimalBounds({ width: 419, height: 560 }), true);
  assert.equal(minimalBounds({ width: 640, height: 259 }), true);
  assert.deepEqual(normalizePresentation({ fontSize: 999, opacity: .1, normalBounds: { width: 300, height: 150 } }), { fontSize: 28, opacity: .1, normalBounds: null });
  assert.equal(normalizePresentation({ opacity: 0 }).opacity, 0);
  assert.equal(normalizePresentation({ opacity: -1 }).opacity, 0);
  assert.equal(normalizePresentation({ opacity: NaN }).opacity, .9);
  assert.deepEqual(visibleBounds({ x: 5000, y: -50, width: 640, height: 560 }, { x: -1920, y: 0, width: 1920, height: 1080 }), { x: -640, y: 0, width: 640, height: 560 });
  const files = new Map(); let reject = false;
  const store = createMeetingWindowStore("local-test", {
    async mkdir() {}, async readFile(file) { if (!files.has(file)) throw new Error("missing"); return files.get(file); },
    async writeFile(file, value) { files.set(file, value); }, async rename(from, to) {
      if (reject) { reject = false; throw new Error("disk unavailable"); }
      files.set(to, files.get(from)); files.delete(from);
    }
  });
  assert.equal((await store.read()).normalBounds, null);
  const value = { fontSize: 20, opacity: .65, normalBounds: { x: 400, y: 300, width: 720, height: 580 }, apiKey: "not-saved", transcript: "not-saved" };
  await Promise.all([store.write({ fontSize: 18 }), store.write(value)]);
  assert.deepEqual(await store.read(), normalizePresentation(value));
  assert(![...files.values()].some(text => /apiKey|transcript|not-saved/.test(text)));
  reject = true; await assert.rejects(store.write({ fontSize: 24 }));
  await store.write(value); await store.flush();
  await store.write({ opacity: 0 });
  assert.equal((await store.read()).opacity, 0, "zero opacity survives reload, not replaced by the default");
  console.log("Meeting window preferences privacy, atomic persistence and screen placement tests passed.");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
