"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
const sizes = vm.runInNewContext(`(${main.match(/const WINDOW_SIZES = (\{[\s\S]*?\n\});/)[1]})`);
const geometry = main.slice(main.indexOf("function enforceWindowGeometry("), main.indexOf("function clamp("));

function verifyGeometry(win, platform = process.platform) {
  const context = { mainWindow: win, liveWindowRestore: null, windowMode: "recording", WINDOW_SIZES: sizes,
    os: { platform: () => platform },
    RESIZABLE_WINDOW_MODES: new Set(["settings", "result", "meeting", "file", "home"]),
    setWindowAlwaysOnTop: (window, topmost) => window.setAlwaysOnTop(topmost), logEvent() {} };
  vm.runInNewContext(geometry, context);
  context.enforceWindowGeometry(win, "recording", true);
  return context;
}

function unitTests() {
  for (const platform of ["win32", "darwin"]) {
    let bounds = { x: 25, y: 30, width: 1180, height: 760 };
    const calls = [];
    const win = { isDestroyed: () => false, isMaximized: () => false, isVisible: () => true,
      setMinimumSize(...value) { calls.push(["minimum", value]); }, setResizable(value) { calls.push(["resizable", value]); },
      setBackgroundColor(value) { calls.push(["background", value]); }, setVibrancy(value) { calls.push(["vibrancy", value]); },
      setAlwaysOnTop() {}, setContentSize(width, height) { bounds = { ...bounds, width, height }; },
      getBounds: () => bounds, setBounds(value) { bounds = value; } };
    const context = verifyGeometry(win, platform);
    for (let i = 0; i < 20; i++) context.enforceWindowGeometry(win, "recording");
    assert.deepEqual([bounds.width, bounds.height], [340, 116]);
    assert.equal(calls.filter(call => call[0] === "resizable").every(call => call[1] === false), true);
    assert.equal(calls.filter(call => call[0] === "background").every(call => call[1] === "#00000000"), true);
    assert.equal(calls.filter(call => call[0] === "vibrancy").length, platform === "darwin" ? 21 : 0);
    if (platform === "darwin") assert.equal(calls.filter(call => call[0] === "vibrancy").every(call => call[1] === "under-window"), true);
    context.enforceWindowGeometry(win, "settings", true);
    assert.equal(calls.filter(call => call[0] === "background").at(-1)[1], platform === "win32" ? "#eef4f1" : "#00000000");
    if (platform === "darwin") {
      assert.equal(calls.filter(call => call[0] === "vibrancy").at(-1)[1], null, "leaving dictation restores the ordinary workspace backdrop");
      win.setVibrancy = () => { throw new Error("material unavailable"); };
      context.enforceWindowGeometry(win, "recording", true);
      assert.deepEqual([bounds.width, bounds.height], [340, 116], "visual effects must not prevent recording window display");
    }
    console.log(`PASS ${platform}: fixed 340x116 dictation, native backdrop/restore and unchanged window position`);
  }
  const renderer = fs.readFileSync(path.join(root, "src/renderer/renderer.js"), "utf8");
  assert.doesNotMatch(renderer, /resizeRecordingWindow|resizeRecordingWindowToContent|scheduleRecordingResize/);
  assert.doesNotMatch(renderer, /setStatus\("recording", "实时结果"|setStatus\("recording", "MiMo 实时预览"/);
  assert.match(renderer, /setRecordingPreview\(visibleText\)/);
  assert.match(renderer, /setRecordingPreview\(text\)/);
  assert.doesNotMatch(main, /window:recording-resize|recordingMax/);
}

async function verifyPage(page, directory) {
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const errors = await prepareBrowser(page);
  await page.setViewportSize({ width: 340, height: 116 });
  await page.waitForFunction(() => document.getElementById("homeTodayCount").textContent === "18");
  for (const platform of ["win32", "darwin"]) {
    await page.evaluate(platform => {
      document.documentElement.dataset.platform = platform;
      window.applyWindowMode("recording"); isRecording = true;
    }, platform);
    const source = Array.from({ length: 80 }, (_, i) => `第${i + 1}句：这是完整保留的合成转写内容，窗口尺寸不随文本长度变化。`).join("\n");
    for (const text of ["这是短文本。", source, source + "\n最后一句也完整保留。", source.slice(0, 850)]) {
      await page.evaluate(text => {
        window.mockHooks.onPartialTranscript(text);
        statusDetail.dispatchEvent(new Event("scroll"));
      }, text);
      await page.waitForFunction(() => recordingScrollFrame === 0);
      const view = await page.evaluate(() => ({ titleHidden: getComputedStyle(statusTitle).display === "none",
        text: statusDetail.textContent, result: resultText.value, width: innerWidth, height: innerHeight,
        atEnd: statusDetail.scrollHeight - statusDetail.clientHeight - statusDetail.scrollTop <= 1,
        overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
        panelBottom: statusPanel.getBoundingClientRect().bottom, fontSize: getComputedStyle(statusDetail).fontSize,
        scrollbarWidth: getComputedStyle(statusDetail).scrollbarWidth,
        scrollbarDisplay: getComputedStyle(statusDetail, "::-webkit-scrollbar").display,
        background: getComputedStyle(document.querySelector(".shell")).backgroundColor,
        border: getComputedStyle(document.querySelector(".shell")).borderTopWidth,
        shadow: getComputedStyle(document.querySelector(".shell")).boxShadow,
        textShadow: getComputedStyle(statusDetail).textShadow,
        titleShadow: getComputedStyle(statusTitle).textShadow,
        lineHeight: parseFloat(getComputedStyle(statusDetail).lineHeight),
        previewHeight: statusDetail.getBoundingClientRect().height,
        radius: getComputedStyle(document.querySelector(".shell")).borderTopLeftRadius,
        blur: getComputedStyle(document.querySelector(".shell")).backdropFilter,
        resizeCalls: window.mockCalls.filter(call => call.name === "resizeRecordingWindow").length }));
      assert.equal(view.text, text); assert.equal(view.result, text, "scrolling never truncates the authoritative text");
      assert.equal(view.titleHidden, true, "the preview has no redundant title");
      assert.equal(view.atEnd, true, `preview of ${text.length} characters must follow its latest line`);
      assert.equal(view.overflow, false);
      assert.deepEqual([view.width, view.height], [340, 116]); assert.ok(view.panelBottom <= 116);
      assert.equal(view.fontSize, "12px");
      assert.equal(view.scrollbarWidth, "none"); assert.equal(view.scrollbarDisplay, "none");
      assert.equal(view.background, "rgba(255, 255, 255, 0.8)");
      if (platform === "win32") assert.equal(view.blur, "none");
      else assert.match(view.blur, /blur\(24px\)/);
      assert.equal(view.border, "0px"); assert.equal(view.shadow, "none");
      assert.equal(view.textShadow, "none"); assert.equal(view.titleShadow, "none");
      assert.equal(view.previewHeight % view.lineHeight, 0, "tail scrolling cannot expose only a sliver of the previous line");
      assert.equal(view.radius, "18px");
      assert.equal(view.resizeCalls, 0);
    }
    async function checkIndicatorAlignment() {
      const offset = await page.evaluate(() => {
        const firstLine = getComputedStyle(statusTitle).display === "none" ? statusDetail : statusTitle;
        const text = firstLine.getBoundingClientRect(), dot = document.getElementById("pulse").getBoundingClientRect();
        return Math.abs(dot.top + dot.height / 2 - text.top - parseFloat(getComputedStyle(firstLine).lineHeight) / 2);
      });
      assert.ok(offset < 0.5, `recording indicator must center on the first text line (${offset})`);
    }
    await page.evaluate(() => window.mockHooks.onPartialTranscript("第一行文字与录音指示点对齐。"));
    await page.waitForFunction(() => recordingScrollFrame === 0);
    await checkIndicatorAlignment();
    await page.evaluate(source => window.mockHooks.onPartialTranscript(source), source);
    await page.waitForFunction(() => recordingScrollFrame === 0);
    await page.locator("#statusDetail").evaluate(el => { el.scrollTop = 0; });
    await page.waitForFunction(() => !recordingFollowTail);
    await page.locator("#statusDetail").hover();
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => statusDetail.scrollTop > 0);
    await page.locator("#statusDetail").evaluate(el => { el.scrollTop = 0; });
    await page.waitForFunction(() => !recordingFollowTail);
    await page.evaluate(source => window.mockHooks.onPartialTranscript(source + "\n新增内容。"), source);
    assert.equal(await page.locator("#statusDetail").evaluate(el => el.scrollTop), 0, "updates respect manual upward scrolling");
    await page.locator("#statusDetail").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(() => recordingFollowTail);
    await page.evaluate(source => window.mockHooks.onPartialTranscript(source + "\n返回末尾后继续跟随最新内容。"), source);
    await page.waitForFunction(() => recordingScrollFrame === 0);
    assert.equal(await page.locator("#statusDetail").evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop <= 1), true);
    if (directory) await page.screenshot({ path: path.join(directory, `dictation-${platform}-long.png`) });
    const mimoPreview = await page.evaluate(async text => {
      appSettings = { ...window.mockSettings(), asrProvider: "mimo", asrMode: "realtime" };
      recordingAsrMode = "realtime"; recordingSampleRate = 16000; recordingSampleCount = 32000;
      recordingChunks = [new Float32Array(32000)]; recordingSegmentState = null; mimoPreviewLastSampleCount = 0;
      window.mockApiOverrides = { transcribe: async () => text };
      await window.runMimoPreviewTick(mimoPreviewRunId);
      return { preview: statusPanel.dataset.preview, text: statusDetail.textContent, result: resultText.value, title: statusTitle.textContent };
    }, source);
    assert.deepEqual(mimoPreview, { preview: "true", text: source, result: source, title: "" }, "MiMo polling shares the same full-text, title-free preview");
    await page.evaluate(() => window.mockHooks.onPartialTranscript(""));
    assert.equal(await page.locator("#statusDetail").textContent(), "", "empty drafts clear previous display text");
    assert.equal(await page.locator("#statusTitle").isVisible(), true);
    await checkIndicatorAlignment();
    for (const [kind, title] of [["transcribing", "正在清理文本"], ["warning", "实时连接失败"], ["error", "请求失败"]]) {
      await page.evaluate(({ kind, title }) => window.setStatus(kind, title, "这是可恢复的状态提示。"), { kind, title });
      assert.equal(await page.locator("#statusTitle").isVisible(), true);
      assert.equal(await page.locator("#statusTitle").textContent(), title);
      await checkIndicatorAlignment();
    }
    await page.evaluate(() => { window.setRecordingPreview("待滚动内容。".repeat(100)); window.applyWindowMode("home"); isRecording = false; });
    assert.equal(await page.evaluate(() => recordingScrollFrame), 0, "navigation cancels pending preview scrolling");
  }
  assert.deepEqual(errors, []);
  console.log("PASS browser: light glass, 18px corners, first-line indicator alignment, 12px text, hidden scrollbar, complete previews, tail-follow/manual scroll, status recovery and navigation; Windows/macOS styles");
}

async function verifyDesktopGlass(application, page) {
  if (process.platform !== "win32") return;
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "win32";
    if (window.applyWindowMode) {
      window.applyWindowMode("recording"); window.setStatus("recording", "", "");
    } else window.update({ kind: "recording", title: "", detail: "第一行文字没有白色阴影，背景透出下层窗口。", preview: true });
    document.getElementById("recordingSpectrum").style.visibility = "hidden";
  });
  try {
    await application.evaluate(async ({ BrowserWindow, screen }) => {
      const win = globalThis.fixtureDictationWindow, area = screen.getPrimaryDisplay().workArea;
      const bounds = { x: area.x + Math.max(0, Math.floor((area.width - 500) / 2)),
        y: area.y + Math.max(0, Math.floor((area.height - 276) / 2)), width: 500, height: 276 };
      const backdrop = new BrowserWindow({ ...bounds, frame: false, show: false, skipTaskbar: true,
        focusable: false, hasShadow: false, backgroundColor: "#dc4060", webPreferences: { sandbox: true } });
      globalThis.fixtureGlassBackdrop = backdrop;
      await backdrop.loadURL("data:text/html," + encodeURIComponent('<html style="height:100%;background:#dc4060"><body style="margin:0;height:100%;display:flex"><div id="left" style="width:50%;background:#dc4060"></div><div id="right" style="width:50%;background:#248cd0"></div><div style="position:absolute;left:100px;top:138px;width:96px;height:20px;background:repeating-linear-gradient(90deg,#182228 0px 8px,#ffffff 8px 16px)"></div></body></html>'));
      backdrop.setAlwaysOnTop(true, "screen-saver"); backdrop.showInactive();
      win.setBounds({ x: bounds.x + 80, y: bounds.y + 80, width: 340, height: 116 });
      win.setAlwaysOnTop(false); win.setAlwaysOnTop(true, "screen-saver");
      win.show(); win.moveTop(); win.focus();
    });
    async function capture() {
      return application.evaluate(async ({ desktopCapturer, screen }) => {
        const bounds = globalThis.fixtureDictationWindow.getBounds(), display = screen.getDisplayMatching(bounds);
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: {
          width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) } });
        const source = sources.find(item => item.display_id === String(display.id));
        if (!source) throw new Error("fixture_screen_unavailable");
        const size = source.thumbnail.getSize(), sx = size.width / display.bounds.width, sy = size.height / display.bounds.height;
        // Only persist a crop wholly inside the synthetic backdrop, never the user's desktop.
        const crop = source.thumbnail.crop({ x: Math.round((bounds.x - display.bounds.x - 30) * sx),
          y: Math.round((bounds.y - display.bounds.y - 30) * sy), width: Math.round((bounds.width + 60) * sx),
          height: Math.round((bounds.height + 60) * sy) });
        const pixels = crop.toBitmap(), width = crop.getSize().width;
        function pixel(x, y) {
          const offset = (Math.round((y + 30) * sy) * width + Math.round((x + 30) * sx)) * 4;
          return Array.from(pixels.subarray(offset, offset + 4));
        }
        return { left: pixel(60, 90), right: pixel(280, 90),
          backgroundLeft: pixel(-10, 90), backgroundRight: pixel(350, 90),
          corners: [pixel(1, 1), pixel(338, 1), pixel(1, 114), pixel(338, 114)],
          roundedCutouts: [pixel(3, 3), pixel(336, 3), pixel(3, 112), pixel(336, 112)],
          stripeDark: pixel(24, 63), stripeLight: pixel(32, 63),
          png: crop.toPNG().toString("base64") };
      });
    }
    const signal = pixel => pixel[2] - pixel[0];
    async function waitForColors(reversed, fading = false) {
      let last;
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 150));
        const image = await capture();
        last = image;
        const difference = signal(image.left) - signal(image.right);
        const transmission = Math.abs(difference / (signal(image.backgroundLeft) - signal(image.backgroundRight)));
        if ((reversed ? difference < -20 : difference > 20)
          && (fading ? transmission >= 0.14 && transmission < 0.94 : Math.abs(transmission - 0.2) <= 0.06)) return image;
        if (attempt === 3) await application.evaluate(() => {
          const win = globalThis.fixtureDictationWindow;
          win.setAlwaysOnTop(false); win.setAlwaysOnTop(true, "screen-saver"); win.moveTop();
        });
      }
      assert.fail(`underlying colors must remain visible; synthetic samples: ${JSON.stringify({
        left: last.left, right: last.right, backgroundLeft: last.backgroundLeft, backgroundRight: last.backgroundRight })}`);
    }
    const initial = await waitForColors(false);
    function verifyAlphaAndCorners(image, fading = false) {
      const underlyingContrast = Math.abs(signal(image.backgroundLeft) - signal(image.backgroundRight));
      const visibleContrast = Math.abs(signal(image.left) - signal(image.right));
      const transmission = visibleContrast / underlyingContrast;
      assert.ok(fading ? transmission >= 0.14 : Math.abs(transmission - 0.2) <= 0.06,
        fading ? "fading must not make the surface more opaque than its configured 80% tint"
          : `underlying contrast must match the 80%-opaque white surface: ${transmission.toFixed(3)}; synthetic samples ${JSON.stringify({ left: image.left, right: image.right, backgroundLeft: image.backgroundLeft, backgroundRight: image.backgroundRight })}`);
      for (let i = 0; i < 4; i++) {
        const expected = i % 2 ? image.backgroundRight : image.backgroundLeft;
        for (const actual of [image.corners[i], image.roundedCutouts[i]])
          assert.ok(actual.slice(0, 3).every((value, channel) => Math.abs(value - expected[channel]) <= 2),
            `corner ${i + 1} must be exactly the underlying desktop, with no square native backing: ${actual} vs ${expected}`);
      }
      assert.ok(image.stripeLight.slice(0, 3).every((value, i) => value - image.stripeDark[i] >= 30),
        "small underlying details must remain visible rather than being erased by heavy native blur");
    }
    verifyAlphaAndCorners(initial);
    await application.evaluate(() => {
      const win = globalThis.fixtureDictationWindow, backdrop = globalThis.fixtureGlassBackdrop;
      win.setFocusable(false); backdrop.setFocusable(true); backdrop.focus(); win.moveTop();
      win.setAlwaysOnTop(false); win.setAlwaysOnTop(true, "screen-saver");
    });
    for (let i = 0; i < 20 && await application.evaluate(() => globalThis.fixtureDictationWindow.isFocused()); i++)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await application.evaluate(() => globalThis.fixtureDictationWindow.isFocused()), false,
      "the regression must actually deactivate the dictation window");
    const inactive = await waitForColors(false);
    verifyAlphaAndCorners(inactive);
    assert.ok(Math.abs(signal(initial.left) - signal(inactive.left)) < 20,
      "inactive glass retains the backdrop instead of switching to opaque gray");
    await application.evaluate(() => globalThis.fixtureGlassBackdrop.webContents.executeJavaScript(
      'document.getElementById("left").style.background="#248cd0";document.getElementById("right").style.background="#dc4060";'));
    const reversed = await waitForColors(true);
    verifyAlphaAndCorners(reversed);
    assert.ok(Math.abs(signal(initial.left) - signal(reversed.left)) > 20,
      "changing the underlying window changes the recording-window appearance");
    await application.evaluate(async () => {
      const win = globalThis.fixtureDictationWindow;
      win.hide(); win.setOpacity(0); win.show(); win.setOpacity(0.5);
    });
    const fading = await waitForColors(true, true);
    verifyAlphaAndCorners(fading, true);
    await application.evaluate(() => globalThis.fixtureDictationWindow.setOpacity(1));
    const reopened = await waitForColors(true);
    verifyAlphaAndCorners(reopened);
    await application.evaluate(() => globalThis.fixtureDictationWindow.setFocusable(true));
    const directory = path.join(root, "output/playwright/dictation-window"); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "native-glass-composite.png"), Buffer.from(initial.png, "base64"));
    fs.writeFileSync(path.join(directory, "native-glass-inactive.png"), Buffer.from(inactive.png, "base64"));
    console.log("PASS Windows desktop composition: focused/unfocused/reopened/fading per-pixel transparency, all four empty rounded cutouts, visible underlying details and changed backdrop; synthetic crop only");
  } finally {
    await page.evaluate(() => { document.getElementById("recordingSpectrum").style.visibility = ""; });
    await application.evaluate(() => {
      globalThis.fixtureDictationWindow.setFocusable(true);
      globalThis.fixtureGlassBackdrop?.destroy(); globalThis.fixtureGlassBackdrop = null;
    });
  }
}

async function verifyNative() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const sandbox = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ovi-dictation-window-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|MIMO|QWEN|DASHSCOPE|FUN_ASR|CLEANER|OSS|OVI_/i.test(key)));
  const application = await _electron.launch({ executablePath: require("electron"), args: [__filename, "--electron-fixture", sandbox], env });
  try {
    const page = await application.firstWindow();
    const before = await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { bounds: win.getBounds(), resizable: win.isResizable(), background: win.getBackgroundColor() };
    });
    assert.deepEqual([before.bounds.width, before.bounds.height], [340, 116]); assert.equal(before.resizable, false);
    // Electron's native getter deliberately omits the alpha channel.
    assert.equal(before.background, "#000000");
    await verifyPage(page);
    await page.evaluate(() => { window.applyWindowMode("recording"); window.setStatus("recording", "正在录音", ""); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const glassPixel = await application.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].capturePage();
      const { width, height } = image.getSize();
      const pixels = image.toBitmap();
      const offset = (Math.floor(height * 0.75) * width + Math.floor(width * 0.5)) * 4;
      return Array.from(pixels.subarray(offset, offset + 4));
    });
    if (process.platform === "win32") {
      assert.ok(glassPixel[3] >= 199 && glassPixel[3] <= 209,
        "native recording surface uses 80% opacity without an opaque backing");
    }
    const after = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    assert.deepEqual(after, before.bounds, "native geometry remains fixed through every transcript and processing state");
    await verifyDesktopGlass(application, page);
    console.log("PASS native Electron: fixed-size geometry, transparent rounded recording surface and scrolling renderer; isolated configuration, no microphone/API");
  } finally { await application.close(); }
}

if (process.versions.electron && process.argv.includes("--electron-fixture")) {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.argv[process.argv.indexOf("--electron-fixture") + 1]);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 640, height: 480, frame: false, resizable: true, useContentSize: true,
      transparent: true, thickFrame: false, hasShadow: false, backgroundColor: "#00000000",
      backgroundMaterial: process.platform === "win32" ? "none" : undefined, roundedCorners: false,
      webPreferences: { contextIsolation: false, nodeIntegration: false } });
    globalThis.fixtureDictationWindow = win;
    verifyGeometry(win);
    await win.loadURL("about:blank");
  }).catch(error => { console.error(error); app.exit(1); });
} else if (require.main === module) (async () => {
  unitTests();
  if (process.argv.includes("--browser")) {
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
    const directory = path.join(root, "output/playwright/dictation-window"); fs.mkdirSync(directory, { recursive: true });
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try { await verifyPage(await browser.newPage(), directory); } finally { await browser.close(); }
  }
  if (process.argv.includes("--electron")) await verifyNative();
})().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { verifyDesktopGlass };
