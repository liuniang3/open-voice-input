"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWindowMotion, DURATIONS } = require("../src/window-motion");
const root = path.resolve(__dirname, "..");

function fixture(platform = "win32", { unsupportedOpacity = false, prepareBubble } = {}) {
  let clock = 0;
  let id = 0;
  const timers = new Map();
  const calls = [];
  const win = {
    visible: false, destroyed: false, opacity: 1, bounds: { x: 290, y: 230, width: 340, height: 116 },
    webContents: { send: (...args) => calls.push(args) },
    getBounds() { return { ...this.bounds }; },
    setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; },
    setVibrancy(value) { this.vibrancy = value; },
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    show() { calls.push("show"); this.visible = true; },
    showInactive() { calls.push("showInactive"); this.visible = true; },
    hide() { calls.push("hide"); this.visible = false; },
    setOpacity(value) { if (unsupportedOpacity) throw new Error("unsupported"); this.opacity = value; }
  };
  const motion = createWindowMotion({ window: win, platform, prepareBubble, now: () => clock,
    schedule(fn, delay) { const key = ++id; timers.set(key, { fn, at: clock + delay }); return key; },
    cancel(key) { timers.delete(key); }
  });
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      clock = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    clock = until;
  }
  return { win, calls, motion, timers, advance };
}

async function run() {
  {
    const f = fixture("win32");
    assert.equal(f.motion.primeHiddenSurface(), true);
    assert.equal(f.win.opacity, 0, "initial compositor activation must remain invisible");
    assert.deepEqual(f.calls, ["showInactive"], "warming does not take keyboard focus");
    assert.equal(f.motion.primeHiddenSurface(), false, "do not warm an already shown surface");
    f.motion.setReducedMotion(false);
    const hidden = f.motion.hide();
    f.advance(32);
    assert.equal(f.win.opacity, 0, "cancelling during warmup never reveals an unprepared surface");
    f.advance(200);
    assert.equal(await hidden, true);
    assert.equal(f.win.visible, false);
    assert.equal(f.win.opacity, 1);
    console.log("PASS invisible native compositor initialization and cancellation without focus or a flash");
  }
  for (const platform of ["win32", "darwin"]) {
    const f = fixture(platform);
    f.motion.show();
    assert.equal(f.win.opacity, 1, "default to no native motion before the system preference arrives");
    await f.motion.hide();
    f.motion.setReducedMotion(false);
    f.motion.show();
    assert.equal(f.win.visible, true, "show never waits for an animation before focusing or recording");
    assert.equal(f.win.opacity, 0);
    f.advance(48);
    assert.ok(f.win.opacity > 0 && f.win.opacity < 1);
    const opacity = f.win.opacity;
    f.motion.show();
    assert.equal(f.win.opacity, opacity, "focus calls must not restart the entrance");
    f.advance(200);
    assert.equal(f.win.opacity, 1);
    assert.equal(f.timers.size, 0);
    let compact = false;
    const hidden = f.motion.hide(() => { compact = true; });
    assert.equal(f.motion.hide(), hidden, "duplicate hides share one completion");
    f.advance(48);
    assert.equal(compact, false, "do not resize to compact while fading");
    assert.equal(f.win.visible, true);
    assert.ok(f.win.opacity < 1 && f.win.opacity > 0);
    f.advance(100);
    assert.equal(await hidden, true);
    assert.equal(f.win.visible, false);
    assert.equal(f.win.opacity, 1, "hidden windows must not reopen at zero opacity");
    assert.equal(compact, true);
    assert.equal(f.timers.size, 0);

    f.motion.show(); f.advance(200);
    let staleHide = false;
    const cancelled = f.motion.hide(() => { staleHide = true; });
    f.advance(32);
    f.motion.show();
    assert.equal(await cancelled, false);
    f.advance(250);
    assert.equal(f.win.visible, true);
    assert.equal(f.win.opacity, 1);
    assert.equal(staleHide, false, "old hides cannot close or resize a reopened window");
    for (let i = 0; i < 30; i++) {
      const leaving = f.motion.hide(); f.advance(16); f.motion.show();
      assert.equal(await leaving, false);
    }
    f.advance(200);
    assert.equal(f.win.visible, true);
    assert.equal(f.win.opacity, 1);
    assert.equal(f.timers.size, 0);

    const reducedHide = f.motion.hide(); f.advance(16);
    f.motion.setReducedMotion(true);
    assert.equal(await reducedHide, true);
    assert.equal(f.win.visible, false);
    assert.equal(f.timers.size, 0);
    f.motion.show();
    assert.equal(f.win.opacity, 1);
    assert.equal(f.timers.size, 0, "Reduce Motion removes native timers");

    f.motion.setReducedMotion(false);
    const destroyedHide = f.motion.hide();
    f.win.destroyed = true;
    f.motion.dispose();
    assert.equal(await destroyedHide, false);
    assert.equal(f.timers.size, 0, "destroyed windows retain no fade timer");
    f.motion.show();
    console.log(`PASS ${platform}: immediate show, bounded fades, repeated focus, rapid reversal, reduced motion and disposal`);
  }
  for (const f of [fixture("linux"), fixture("win32", { unsupportedOpacity: true })]) {
    f.motion.setReducedMotion(false); f.motion.show();
    assert.equal(f.win.visible, true);
    assert.equal(await f.motion.hide(), true);
    assert.equal(f.win.visible, false);
    assert.equal(f.timers.size, 0, "visual capability failures never block show/hide");
  }
  assert.ok(DURATIONS.enter <= 180 && DURATIONS.leave <= 120);
  for (const platform of ["win32", "darwin"]) {
    let ready;
    const f = fixture(platform, { prepareBubble: () => new Promise(resolve => { ready = resolve; }) });
    f.motion.setReducedMotion(false);
    const shown = f.motion.show({ bubble: true, entrance: { origin: { x: 10, y: 0 }, offset: { x: 0, y: -20 } } });
    assert.equal(f.win.visible, false, "do not reveal the old full-size surface before the bubble's first frame is prepared");
    f.motion.show();
    assert.equal(f.win.visible, false, "focus cannot bypass first-frame preparation");
    ready(true);
    assert.equal(await shown, true);
    assert.equal(f.win.visible, true);
    f.advance(300);
    assert.equal(f.win.opacity, 1);
    console.log(`PASS ${platform}: delayed first-frame preparation stays hidden until ready`);
    for (const action of ["hide", "hideImmediately", "finishEntrance", "dispose"]) {
      let delayed;
      const cancelled = fixture(platform, { prepareBubble: () => new Promise(resolve => { delayed = resolve; }) });
      cancelled.motion.setReducedMotion(false);
      const pending = cancelled.motion.show({ bubble: true });
      await cancelled.motion[action]();
      assert.equal(await pending, false);
      delayed(true); await Promise.resolve();
      cancelled.advance(1000);
      assert.equal(cancelled.win.visible, false, `${action} must prevent late preparation from revealing a window`);
      assert.equal(cancelled.timers.size, 0);
    }
    let delayed;
    const fallback = fixture(platform, { prepareBubble: () => new Promise(resolve => { delayed = resolve; }) });
    fallback.motion.setReducedMotion(false);
    const pending = fallback.motion.show({ bubble: true });
    fallback.advance(DURATIONS.prepare + 32);
    assert.equal(await pending, true, "a stalled renderer cannot block native visibility indefinitely");
    const before = fallback.win.opacity;
    delayed(true); await Promise.resolve();
    assert.equal(fallback.calls.filter(call => call === "show").length, 1, "late preparation cannot restart native show after fallback");
    assert.equal(fallback.win.opacity, before);
    assert.equal(fallback.calls.some(call => call[0] === "dictation:entrance" && call[1]?.phase === "play"), false);
    fallback.advance(300);
    assert.equal(fallback.win.opacity, 1); assert.equal(fallback.timers.size, 0);
    for (const prepareBubble of [() => Promise.reject(new Error("renderer gone")), () => { throw new Error("renderer unavailable"); }]) {
      const failed = fixture(platform, { prepareBubble });
      failed.motion.setReducedMotion(false);
      assert.equal(await failed.motion.show({ bubble: true }), true);
      failed.advance(300);
      assert.equal(failed.win.opacity, 1); assert.equal(failed.timers.size, 0);
    }
    let reducedReady;
    const reduced = fixture(platform, { prepareBubble: () => new Promise(resolve => { reducedReady = resolve; }) });
    reduced.motion.setReducedMotion(false);
    const reducedShown = reduced.motion.show({ bubble: true });
    reduced.motion.setReducedMotion(true);
    assert.equal(await reducedShown, true);
    assert.equal(reduced.win.visible, true); assert.equal(reduced.win.opacity, 1);
    reducedReady(true); await Promise.resolve();
    assert.equal(reduced.calls.filter(call => call === "show").length, 1);
    assert.equal(reduced.timers.size, 0);
    console.log(`PASS ${platform}: pending cancellation, bounded failure, late timeout result and Reduce Motion cannot restart reveal`);
  }
  for (const platform of ["win32", "darwin"]) {
    const f = fixture(platform);
    f.motion.setReducedMotion(false);
    const final = { ...f.win.bounds };
    const entrance = { origin: { x: 10, y: 0 }, offset: { x: 0, y: -20 } };
    f.motion.show({ bubble: true, entrance });
    assert.equal(f.win.visible, true, "bubble animation never delays recording or keyboard availability");
    assert.equal(f.win.bounds.y, 210);
    assert.equal(f.win.bounds.width, 340); assert.equal(f.win.bounds.height, 116);
    assert.deepEqual(f.calls.find(call => call[0] === "dictation:entrance")[1], { origin: entrance.origin, duration: 240 });
    if (platform === "darwin") assert.equal(f.win.vibrancy, null);
    f.advance(80);
    assert.ok(f.win.bounds.y > 210 && f.win.bounds.y < 230);
    const midway = f.win.bounds.y;
    f.motion.show();
    assert.equal(f.win.bounds.y, midway, "repeated shortcut focus does not restart the bubble");
    f.advance(240);
    assert.deepEqual(f.win.bounds, final);
    assert.equal(f.win.opacity, 1); assert.equal(f.timers.size, 0);
    if (platform === "darwin") assert.equal(f.win.vibrancy, "under-window");
    f.motion.show({ bubble: true, entrance }); f.advance(32);
    f.win.setPosition(650, 500); f.advance(240);
    assert.equal(f.win.bounds.x, 650, "manual dragging owns the position immediately");
    assert.equal(f.win.bounds.y, 500);
    if (platform === "darwin") assert.equal(f.win.vibrancy, "under-window");
    f.motion.show({ bubble: true, entrance }); f.advance(32);
    const hiding = f.motion.hide(); f.advance(150); await hiding;
    assert.equal(f.win.visible, false); assert.equal(f.timers.size, 0);
    f.motion.show({ bubble: true, entrance }); f.advance(32);
    f.motion.setReducedMotion(true);
    assert.equal(f.motion.isBubbleEntering(), false); assert.equal(f.timers.size, 0);
    assert.equal(f.win.opacity, 1);
    f.motion.setReducedMotion(false); f.motion.show({ bubble: true, entrance });
    f.motion.finishEntrance();
    f.win.bounds = { x: 50, y: 60, width: 960, height: 760 };
    f.advance(300);
    assert.deepEqual(f.win.bounds, { x: 50, y: 60, width: 960, height: 760 }, "navigation leaves no stale position writer");
    console.log(`PASS ${platform}: caret-origin bubble, fixed viewport, final placement, immediate input, manual moves, cancellation, reduced motion and navigation`);
  }
  const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  assert.match(main, /Promise\.all\(\[hideWindow\(\), new Promise/);
  assert.match(main, /if \(focusRevision !== windowFocusRevision\) return/);
  assert.match(main, /isAppSender\(event\.sender, event\.senderFrame\?\.url\).*typeof reducedMotion !== "boolean"/);
  const css = fs.readFileSync(path.join(root, "src/renderer/app-shell.css"), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  console.log("PASS motion capability fallback, paste timing, local sender guard and stale focus protection");
}

async function verifyBrowser() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const output = path.join(root, "output/playwright/window-motion");
  fs.mkdirSync(output, { recursive: true });
  try {
    const page = await browser.newPage({ reducedMotion: "no-preference" });
    const errors = await prepareBrowser(page);
    await page.waitForFunction(() => document.getElementById("homeTodayCount").textContent === "18");
    for (const [mode, selector, width, height] of [
      ["settings", "#settingsPanel", 960, 760], ["home", "#homePanel", 960, 760],
      ["file", "#filePanel", 960, 760], ["meeting", "#meetingPanel", 960, 760],
      ["settings", "#settingsPanel", 640, 520], ["home", "#homePanel", 640, 520],
      ["recording", "#statusPanel", 400, 180]
    ]) {
      await page.setViewportSize({ width, height });
      const state = await page.evaluate(({ mode, selector }) => {
        if (mode === "settings") window.mockOpenSettings();
        else window.applyWindowMode(mode);
        if (mode === "recording") window.setStatus("recording", "正在录音", "正在显示本次语音的转写内容。");
        const target = document.querySelector(selector);
        const animation = target.getAnimations()[0];
        if (animation) { animation.pause(); animation.currentTime = 80; }
        return { name: animation?.animationName, duration: animation?.effect.getTiming().duration,
          opacity: Number(getComputedStyle(target).opacity),
          topbarTransform: getComputedStyle(document.querySelector(".topbar")).transform,
          focused: document.activeElement?.id };
      }, { mode, selector });
      if (mode === "recording") {
        assert.equal(state.name, undefined, "dictation content must not fade separately from its bubble");
        assert.equal(state.opacity, 1);
      } else {
        assert.equal(state.name, "workspace-enter");
        assert.ok(state.duration <= 180);
        assert.ok(state.opacity > 0 && state.opacity < 1);
      }
      assert.equal(state.topbarTransform, "none", "content animation must not move native drag regions");
      await page.screenshot({ path: path.join(output, `${mode}-${width}-midpoint.png`) });
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) {
          if (animation.effect.getTiming().iterations !== Infinity) animation.finish();
        }
      });
      const settled = await page.locator(selector).evaluate(target => ({
        opacity: getComputedStyle(target).opacity, transform: getComputedStyle(target).transform,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth
      }));
      assert.equal(settled.opacity, "1"); assert.equal(settled.transform, "none");
      assert.equal(settled.horizontalOverflow, false);
    }
    await page.evaluate(() => { window.mockOpenSettings(); window.setSettingsTab("cleaner"); });
    assert.equal(await page.locator("#settingsCleanerPanel").evaluate(el => getComputedStyle(el).animationName), "settings-content-enter");
    for (let i = 0; i < 15; i++) {
      await page.evaluate(i => { window.applyWindowMode("home"); window.mockOpenSettings(); window.setSettingsTab(i % 2 ? "cleaner" : "asr"); }, i);
    }
    await page.waitForFunction(() => document.getAnimations().every(a => a.effect.getTiming().iterations === Infinity));
    assert.equal(await page.locator("#settingsAsrPanel").isVisible(), true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => window.mockCalls.some(call => call.name === "setReducedMotion" && call.payload === true));
    await page.evaluate(() => { window.applyWindowMode("home"); window.mockOpenSettings(); window.setSettingsTab("cleaner"); });
    assert.equal(await page.locator("#settingsPanel").evaluate(el => getComputedStyle(el).animationName), "none");
    assert.equal(await page.locator("#settingsCleanerPanel").evaluate(el => getComputedStyle(el).animationName), "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => window.mockCalls.filter(call => call.name === "setReducedMotion").at(-1)?.payload === false);
    assert.deepEqual(errors, []);
    console.log("PASS browser: all workspace entrances, narrow sizes, recording, stable title bar, rapid switches and live Reduce Motion changes");
    await verifyBubble(browser, output);
  } finally { await browser.close(); }
}

async function verifyBubble(browser, output) {
  const { pathToFileURL } = require("node:url");
  const page = await browser.newPage({ viewport: { width: 340, height: 116 }, reducedMotion: "no-preference" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.dictationPreview = { ready: async () => ({ kind: "recording", title: "正在录音", detail: "", preview: false }),
      onState: callback => { window.updateFixture = callback; }, onSpectrum() {}, command() {},
      onDictationEntrance: callback => { window.bubbleFixture = callback; } };
  });
  await page.goto(pathToFileURL(path.join(root, "src/renderer/dictation-preview.html")).href);
  await page.evaluate(() => { document.documentElement.style.background = "#547785"; });
  for (const platform of ["win32", "darwin"]) {
    await page.evaluate(value => { document.documentElement.dataset.platform = value; }, platform);
    for (const origin of [{ x: 12, y: 0 }, { x: 320, y: 116 }]) {
      await page.evaluate(origin => {
        window.bubbleFixture({ origin, duration: 240 });
        window.pausedBubble = document.querySelector(".shell").getAnimations()[0];
        window.pausedBubble.pause(); window.pausedBubble.currentTime = 0;
      }, origin);
      const state = await page.evaluate(() => {
        const shell = document.querySelector(".shell"), rect = shell.getBoundingClientRect(), style = getComputedStyle(shell);
        return { origin: style.transformOrigin, width: rect.width, height: rect.height,
          viewport: [innerWidth, innerHeight], radius: style.borderRadius };
      });
      assert.equal(state.origin, `${origin.x}px ${origin.y}px`);
      assert.ok(state.width <= 13 && state.height <= 17, "first frame is a small bubble at the anchor, not the full popup");
      assert.deepEqual(state.viewport, [340, 116]);
      for (const time of [30, 90, 160, 230]) {
        await page.evaluate(time => {
          for (const animation of document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity)) {
            animation.pause(); animation.currentTime = time;
          }
          window.updateFixture({ kind: "recording", title: "", detail: "语音正在转写，气泡从输入位置轻轻展开。", preview: true });
        }, time);
        const midpoint = await page.locator(".shell").evaluate(node => {
          const r = node.getBoundingClientRect();
          return { width: r.width, height: r.height, radius: getComputedStyle(node).borderRadius };
        });
        assert.ok(midpoint.width > state.width && midpoint.width <= 340);
        assert.ok(midpoint.height > state.height && midpoint.height <= 116);
        await page.screenshot({ path: path.join(output, `bubble-${platform}-${origin.y ? "above" : "below"}-${time}.png`), animations: "allow" });
        assert.equal(await page.evaluate(() => window.pausedBubble.currentTime), time, "the captured screenshot retains the requested animation frame");
      }
      await page.evaluate(() => window.dictationMotion.cancel());
      assert.equal(await page.locator(".shell").evaluate(node => getComputedStyle(node).transform), "none");
      assert.equal(await page.locator(".shell").evaluate(node => getComputedStyle(node).borderRadius), "18px");
      assert.deepEqual(await page.locator(".status-panel").evaluate(node => ({
        opacity: getComputedStyle(node).opacity, animation: getComputedStyle(node).animationName,
        transform: getComputedStyle(node).transform
      })), { opacity: "1", animation: "none", transform: "none" },
      "finishing or cancelling a bubble must not dim and move the text for a second entrance");
    }
  }
  await page.evaluate(() => window.bubbleFixture({ origin: { x: 12, y: 0 }, duration: 240 }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => !document.body.classList.contains("dictation-entering"));
  await page.evaluate(() => window.bubbleFixture({ origin: { x: 12, y: 0 }, duration: 240 }));
  assert.equal(await page.locator(".shell").evaluate(node => node.getAnimations().length), 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    window.bubbleFixture({ origin: { x: NaN, y: 0 } });
    window.bubbleFixture({ origin: { x: 12, y: 0 }, duration: 240 });
    window.bubbleFixture({ origin: { x: 320, y: 116 }, duration: 240 });
  });
  await page.waitForFunction(() => !document.body.classList.contains("dictation-entering"));
  assert.equal(await page.locator(".shell").evaluate(node => node.getAnimations().length), 0);
  assert.deepEqual(errors, []);
  await page.close();
  console.log("PASS bubble frames: upward/downward Windows/macOS presentation, rounded transparency, full text during entrance, repeated entry and live reduced motion");
}

async function verifyNative() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const sandbox = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ovi-motion-native-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|MIMO|QWEN|DASHSCOPE|FUN_ASR|CLEANER|OSS|OVI_/i.test(key)));
  const application = await _electron.launch({ executablePath: require("electron"),
    args: [path.join(__dirname, "test-home-ui.js"), "--electron-app-fixture", sandbox], env });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(() => !document.getElementById("onboardingPanel").hidden);
    await page.locator("#guideSkip").click();
    assert.deepEqual(await page.evaluate(() => window.mimoInput.setReducedMotion(false)), { ok: true });
    assert.deepEqual(await page.evaluate(() => window.mimoInput.setReducedMotion("false")), { ok: false });
    const read = () => application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { visible: win.isVisible(), opacity: win.getOpacity(), bounds: win.getBounds(), focused: win.isFocused() };
    });
    await page.evaluate(() => { window.pendingMotionHide = window.mimoInput.hide(); });
    const during = await read();
    assert.equal(during.visible, true);
    assert.ok(during.bounds.width >= 640, "hiding must keep the workspace size until it is gone");
    await page.evaluate(() => window.mimoInput.openHome());
    assert.equal(await page.evaluate(() => window.pendingMotionHide), false);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 800)));
    let state = await read();
    assert.equal(state.visible, true); assert.equal(state.opacity, 1);
    assert.equal(state.focused, true, "native reopen must remain focusable");
    assert.equal(await page.evaluate(() => window.mimoInput.hide()), true);
    state = await read();
    assert.equal(state.visible, false); assert.equal(state.opacity, 1);
    await page.evaluate(() => window.mimoInput.openHome());
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)));
    state = await read();
    assert.equal(state.visible, true); assert.equal(state.opacity, 1);
    await page.evaluate(() => window.mimoInput.openMeetingWorkspace());
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
    assert.equal((await read()).visible, false);
    assert.equal(await page.evaluate(() => document.body.classList.contains("meeting-mode")), true,
      "native close-to-tray preserves the workspace instead of changing a live meeting to compact mode");
    await page.evaluate(() => window.mimoInput.openHome());
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.mimoInput.setReducedMotion(true));
    assert.equal(await page.evaluate(() => window.mimoInput.hide()), true);
    assert.equal((await read()).visible, false);
    console.log("PASS native Electron: fade reversal, no stale hide, original geometry, focus, opacity recovery and reduced motion; isolated settings, no API calls");
  } finally { await application.close(); }
}

if (require.main === module) (async () => {
  await run();
  if (process.argv.includes("--browser")) await verifyBrowser();
  if (process.argv.includes("--electron")) await verifyNative();
})().catch(error => { console.error(error); process.exitCode = 1; });
