"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseInputContext, readInputContext, dictationBounds } = require("../src/dictation-placement");
const { resolveHelperPath } = require("../src/meeting/paths");

const size = { width: 340, height: 116 };
const area = { x: 0, y: 0, width: 1000, height: 800 };
const screen = { getDisplayMatching: () => ({ workArea: area }),
  getDisplayNearestPoint: () => ({ workArea: area }), getCursorScreenPoint: () => ({ x: 100, y: 100 }) };
const context = rect => ({ target: "456", source: "caret", coordinateSpace: "dip", rect });

async function run() {
  assert.deepEqual(dictationBounds(context({ x: 300, y: 200, width: 0, height: 20 }), size, screen),
    { x: 290, y: 230, ...size });
  assert.deepEqual(dictationBounds(context({ x: 950, y: 760, width: 1, height: 20 }), size, screen),
    { x: 652, y: 634, ...size });
  assert.deepEqual(dictationBounds(null, size, screen), { x: 330, y: 342, ...size });
  assert.deepEqual(dictationBounds(context({ x: 3000, y: 800, width: 1, height: 20 }), size, screen),
    dictationBounds(null, size, screen), "off-screen stale caret cannot pin the popup to a random edge");
  const otherDisplay = { ...screen, getDisplayMatching: () => ({ workArea: { x: -1600, y: -200, width: 1600, height: 1000 } }) };
  assert.deepEqual(dictationBounds(context({ x: -1590, y: -190, width: 0, height: 20 }), size, otherDisplay),
    { x: -1592, y: -160, ...size }, "secondary displays can have negative coordinates");
  const mixedDpi = { ...otherDisplay, screenToDipRect: (_window, rect) => {
    assert.equal(rect.x, -2100); return { x: -1400, y: 120, width: 1, height: 20 };
  } };
  assert.deepEqual(dictationBounds({ ...context({ x: -2100, y: 180, width: 1, height: 30 }), coordinateSpace: "physical" }, size, mixedDpi),
    { x: -1410, y: 150, ...size }, "Electron performs physical-to-DIP conversion, including monitor origins");
  assert.deepEqual(dictationBounds({ ...context({ x: 300, y: 200, width: 0, height: 20 }), coordinateSpace: "physical" }, size, screen),
    dictationBounds(null, size, screen), "missing DPI conversion uses fallback, never guessed pixel positions");
  const wire = { type: "input-context", ...context({ x: 300, y: 200, width: 0, height: 20 }) };
  const early = { ...wire, source: null, rect: null, secret: "must-not-pass-through" };
  assert.equal(parseInputContext(`${JSON.stringify(early)}\n{"type":`).target, "456");
  assert.equal(parseInputContext(JSON.stringify(early)).secret, undefined);
  assert.equal(parseInputContext(`${JSON.stringify(early)}\n${JSON.stringify(wire)}`).rect.x, 300);
  assert.equal(parseInputContext(JSON.stringify({ ...wire, target: "invalid" })), null);
  assert.equal(parseInputContext(JSON.stringify({ ...wire, rect: { x: 1e9, y: 0, width: 1, height: 10 } })).rect, null);
  const timeoutResult = await readInputContext({ helperPath: "fixture", execFileImpl: (file, args, options, callback) => {
    assert.deepEqual(args, ["--input-context"]); assert.equal(options.timeout, 700);
    assert.equal(options.windowsHide, true); callback(new Error("timeout"), JSON.stringify(early));
  } });
  assert.equal(timeoutResult.target, "456", "a hung AX/UIA request retains the already captured paste target");
  assert.equal(await readInputContext({ execFileImpl: () => { throw new Error("missing helper"); } }), null);
  console.log("ok - caret/input placement, display clamping, mixed DPI and bounded native failures");

  if (["win32", "darwin"].includes(process.platform)) {
    const helperPath = resolveHelperPath({ platform: process.platform, appRoot: path.join(__dirname, "..") });
    if (fs.existsSync(helperPath)) {
      const native = spawnSync(helperPath, ["--input-context"], { encoding: "utf8", windowsHide: true,
        timeout: 1500, maxBuffer: 8192 });
      const nativeContext = parseInputContext(native.stdout);
      if (native.error) assert.equal(native.error.code, "ETIMEDOUT");
      else assert.equal(native.status, 0);
      if (native.stdout?.trim()) {
        assert.ok(nativeContext);
        for (const line of native.stdout.trim().split(/\r?\n/).filter(line => line.endsWith("}"))) {
          const keys = Object.keys(JSON.parse(line));
          assert.ok(keys.every(key => ["type", "target", "coordinateSpace", "rect", "windowRect", "source"].includes(key)),
            "native protocol exposes geometry only, never field contents");
        }
      }
      console.log("ok - native input-context CLI smoke (no claim of desktop-app compatibility or macOS hardware validation)");
    }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
