"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src/renderer/renderer.js"), "utf8");
const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
const liveCss = fs.readFileSync(path.join(root, "src/renderer/live-meeting.css"), "utf8");

assert.match(main, /const isWindows = os\.platform\(\) === "win32"/);
assert.match(main, /thickFrame:\s*isWindows/);
assert.match(main, /transparent:\s*!isWindows/);
assert.match(main, /backgroundMaterial:\s*"acrylic"/);
assert.match(main, /RESIZABLE_WINDOW_MODES = new Set\(\["settings", "result", "meeting", "file"\]\)/);
assert.match(main, /RESIZABLE_WINDOW_MODES\.has\(mode\)/);
assert.doesNotMatch(main, /setWindowMessageResult|installNativeResizeHitTest|WM_NCHITTEST/);
assert.match(renderer, /\["settings", "result", "meeting", "file"\]\.includes\(mode\)/);
assert.match(css, /body\.secondary-window-mode \.shell[\s\S]*border-radius:\s*16px/);
assert.match(css, /html\[data-platform="win32"\] body\.secondary-window-mode \.shell[\s\S]*margin:\s*0/);
assert.match(css, /@media \(max-width: 760px\)[\s\S]*body\.settings-open \.settings-tabs/);
assert.doesNotMatch(renderer, /statusPanel\.scrollHeight \+ chromeHeight/);
assert.match(renderer, /const panelHeight = Math\.max\(76, titleHeight \+ detailHeight \+ meterHeight\)/);
assert.match(liveCss, /\.live-compact #liveRaw \{[^}]*flex:\s*1 1 0;[^}]*max-height:\s*none;/s);
assert.match(liveCss, /\.live-compact \.live-preview:not\(\[hidden\]\)[^}]*flex:\s*0 1 35%;/s);

console.log("window resize contract tests passed");

async function verifyResponsiveWindows() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const { verifyBrowser } = require("./test-meeting-live-ui");
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-window-layout-"));
  try {
    const page = await browser.newPage();
    await verifyBrowser(page);
    const cases = [
      { mode: "settings", width: 640, height: 480, open: () => page.evaluate(() => window.mockOpenSettings()) },
      { mode: "file", width: 720, height: 520, open: () => page.evaluate(() => window.applyWindowMode("file")) },
      { mode: "meeting", width: 720, height: 520, open: () => page.evaluate(async () => {
        window.applyWindowMode("meeting");
        await window.MeetingLiveUi.open();
      }) },
      { mode: "result", width: 420, height: 320, open: () => page.evaluate(() => window.applyWindowMode("result")) }
    ];
    for (const item of cases) {
      await page.setViewportSize({ width: item.width, height: item.height });
      await item.open();
      if (item.mode === "settings") {
        await page.evaluate(() => {
          const bridge = window.mimoInput;
          window.mimoInput = new Proxy(bridge, {
            get(target, name) {
              if (name === "listProviderModels") {
                return async () => ({ ok: true, models: ["gpt-5.4-mini", "openai/gpt-5.6", "o4-mini"], latencyMs: 12 });
              }
              return target[name];
            }
          });
        });
        await page.locator('[data-settings-tab="connections"]').click();
        await page.locator('.settings-tab-panel.is-active [data-provider-model-refresh="openai"]').click();
        await page.waitForFunction(() => [...document.querySelectorAll("#cleanerModelPresetSelect option")]
          .some(option => option.value === "openai/gpt-5.6"));
        await page.locator('[data-settings-tab="cleaner"]').click();
        await page.locator("#cleanerModelPresetSelect").selectOption("openai/gpt-5.6");
        assert.equal(await page.locator("#cleanerModelPresetSelect").inputValue(), "openai/gpt-5.6");
        assert.equal(await page.locator("#cleanerProviderSelect").inputValue(), "openai-compatible");
        await page.locator('[data-settings-tab="meeting"]').click();
        assert.equal(await page.locator('#meetingAnalysisModelPresetSelect option[value="openai/gpt-5.6"]').count(), 1);
        await page.locator("#meetingAnalysisModelPresetSelect").selectOption("openai/gpt-5.6");
        assert.equal(await page.locator("#meetingAnalysisModelPresetSelect").inputValue(), "openai/gpt-5.6");
        assert.equal(await page.locator("#meetingAnalysisProviderSelect").inputValue(), "openai-compatible");
        await page.locator('[data-settings-tab="cleaner"]').click();
        await page.locator("#cleanerModelPresetSelect").scrollIntoViewIfNeeded();
        await page.locator("#saveSettingsBtn").click();
        await page.waitForFunction(() => window.mockCalls.some(call => call.name === "saveSettings" && call.payload?.cleanerModel === "openai/gpt-5.6"));
        const savedProviders = await page.evaluate(() => {
          const call = window.mockCalls.filter(item => item.name === "saveSettings" && item.payload?.cleanerModel === "openai/gpt-5.6").at(-1);
          return {
            cleaner: call.payload.cleanerProfiles["openai/gpt-5.6"].provider,
            analysis: call.payload.meetingAnalysisProfiles["openai/gpt-5.6"].provider
          };
        });
        assert.deepEqual(savedProviders, { cleaner: "openai", analysis: "openai" });
      }
      const layout = await page.evaluate(() => {
        const shell = document.querySelector(".shell").getBoundingClientRect();
        const visible = [...document.querySelectorAll("button, input, select, textarea")]
          .filter(element => element.getClientRects().length > 0);
        const overflow = visible.filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.left < -1 || rect.right > innerWidth + 1;
        }).map(element => element.id || element.getAttribute("aria-label") || element.tagName);
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth,
          overflow,
          shell: { left: shell.left, top: shell.top, right: shell.right, bottom: shell.bottom }
        };
      });
      assert(layout.documentWidth <= layout.viewportWidth + 1, `${item.mode} document must not overflow horizontally`);
      assert.deepEqual(layout.overflow, [], `${item.mode} controls must stay inside the viewport`);
      assert(layout.shell.left >= 0 && layout.shell.top >= 0, `${item.mode} shell origin must stay visible`);
      assert(layout.shell.right <= item.width + 1 && layout.shell.bottom <= item.height + 1, `${item.mode} shell must fit`);
      await page.screenshot({ path: path.join(directory, `${item.mode}-${item.width}x${item.height}.png`) });
    }

    await page.setViewportSize({ width: 520, height: 420 });
    const recordingSizes = await page.evaluate(async () => {
      window.applyWindowMode("recording");
      const before = window.mockCalls.length;
      window.setStatus("recording", "实时结果", "这是一段用于验证窗口自适应的实时转写内容。".repeat(30));
      window.resizeRecordingWindowToContent();
      const expanded = window.mockCalls.slice(before).filter(call => call.name === "resizeRecordingWindow").at(-1)?.payload;
      window.setStatus("transcribing", "正在清理文本", "正在整理完整转写结果。");
      window.resizeRecordingWindowToContent();
      const compact = window.mockCalls.slice(before).filter(call => call.name === "resizeRecordingWindow").at(-1)?.payload;
      return { expanded, compact };
    });
    assert(recordingSizes.expanded.height > recordingSizes.compact.height,
      "the cleanup state must shrink after a long realtime transcript");
    assert.equal(recordingSizes.compact.width, 320);
    assert(recordingSizes.compact.height >= 132 && recordingSizes.compact.height <= 145,
      `cleanup state should return to its natural compact height (${recordingSizes.compact.height})`);

    await page.evaluate(async () => {
      window.applyWindowMode("meeting");
      await window.MeetingLiveUi.open();
      window.mockPush({ status: "recording", recording: true,
        rawText: "用于验证精简窗口可视区域随窗口增大的实时转写内容。\n".repeat(100),
        previewText: "当前实时草稿也应使用可用空间。".repeat(20), previewStatus: "streaming" });
      document.getElementById("meetingPanel").classList.add("live-floating", "live-compact");
    });
    await page.setViewportSize({ width: 420, height: 300 });
    const smallCompact = await page.locator("#liveRaw").evaluate(element => element.clientHeight);
    await page.screenshot({ path: path.join(directory, "meeting-compact-420x300.png") });
    await page.setViewportSize({ width: 620, height: 560 });
    const largeCompact = await page.locator("#liveRaw").evaluate(element => element.clientHeight);
    await page.screenshot({ path: path.join(directory, "meeting-compact-620x560.png") });
    assert(largeCompact > smallCompact + 100,
      `compact transcript must grow with the window (${smallCompact} -> ${largeCompact})`);
    console.log(`responsive window browser checks passed: ${directory}`);
  } finally {
    await browser.close();
  }
}

function probeWindowsResizeCursors(bounds) {
  const edgeOffsets = [-2, -1, 0, 1, 2, 3, 4, 5, 6];
  const tests = [];
  for (const offset of edgeOffsets) {
    tests.push(
      { edge: "left", offset, x: bounds.x + offset, y: bounds.y + Math.floor(bounds.height / 2), cursor: 32644 },
      { edge: "right", offset, x: bounds.x + bounds.width - 1 - offset, y: bounds.y + Math.floor(bounds.height / 2), cursor: 32644 },
      { edge: "top", offset, x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + offset, cursor: 32645 },
      { edge: "bottom", offset, x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + bounds.height - 1 - offset, cursor: 32645 }
    );
  }
  const psTests = tests.map(test => (
    `@{ edge='${test.edge}'; offset=${test.offset}; x=${test.x}; y=${test.y}; cursor=${test.cursor} }`
  )).join(",\r\n  ");
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OviCursorProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr instance, IntPtr cursorName);
}
'@
$old = New-Object OviCursorProbe+CURSORINFO
$old.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($old)
[void][OviCursorProbe]::GetCursorInfo([ref]$old)
$tests = @(
  ${psTests}
)
$result = @()
$forbidden = [OviCursorProbe]::LoadCursor([IntPtr]::Zero, [IntPtr]32648)
foreach ($test in $tests) {
  [void][OviCursorProbe]::SetCursorPos($test.x, $test.y)
  Start-Sleep -Milliseconds 140
  $info = New-Object OviCursorProbe+CURSORINFO
  $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
  [void][OviCursorProbe]::GetCursorInfo([ref]$info)
  $expected = [OviCursorProbe]::LoadCursor([IntPtr]::Zero, [IntPtr]$test.cursor)
  $result += @{ edge = $test.edge; offset = $test.offset; resize = $info.hCursor -eq $expected; forbidden = $info.hCursor -eq $forbidden }
}
[void][OviCursorProbe]::SetCursorPos($old.ptScreenPos.X, $old.ptScreenPos.Y)
$result | ConvertTo-Json -Compress
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000
  });
  if (result.status !== 0) throw new Error(result.stderr || "Windows cursor probe failed");
  return JSON.parse(result.stdout.trim());
}

async function verifyNativeElectronWindows() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-window-native-"));
  const application = await _electron.launch({
    executablePath: require("electron"),
    args: [`--user-data-dir=${userData}`, __filename, "--electron-fixture"]
  });
  try {
    const page = await application.firstWindow();
    await page.bringToFront();
    const readWindow = () => application.evaluate(() => {
      const win = globalThis.oviResizeWindow;
      const bounds = win.getBounds();
      const topLeft = globalThis.oviScreen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
      const bottomRight = globalThis.oviScreen.dipToScreenPoint({
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height
      });
      return {
        bounds,
        cursorBounds: {
          x: topLeft.x,
          y: topLeft.y,
          width: bottomRight.x - topLeft.x,
          height: bottomRight.y - topLeft.y
        },
        minimumSize: win.getMinimumSize(),
        resizable: win.isResizable()
      };
    });
    let state = await readWindow();
    assert.equal(state.resizable, true);
    assert.deepEqual(state.minimumSize, [640, 480]);
    if (process.platform === "win32") {
      const cursors = probeWindowsResizeCursors(state.cursorBounds);
      console.log(`native cursor probe: ${JSON.stringify(cursors)}`);
      for (const edge of ["left", "right", "top", "bottom"]) {
        const samples = cursors.filter(sample => sample.edge === edge);
        assert.equal(samples.some(sample => sample.forbidden), false, `${edge} edge must not expose the forbidden cursor`);
        assert.equal(
          samples.some(sample => sample.resize && Math.abs(sample.offset) <= 3),
          true,
          `${edge} edge must expose its native resize cursor near the visible boundary`
        );
      }
    }
    await application.evaluate(() => globalThis.oviResizeWindow.setMinimumSize(420, 320));
    state = await readWindow();
    assert.equal(state.resizable, true);
    assert.deepEqual(state.minimumSize, [420, 320]);
    console.log("native Electron resize checks passed");
  } finally {
    await application.close();
  }
}

async function runElectronFixture() {
  const { app, BrowserWindow, screen } = require("electron");
  await app.whenReady();
  const isWindows = process.platform === "win32";
  const win = new BrowserWindow({
    x: 240,
    y: 180,
    width: 640,
    height: 480,
    show: true,
    alwaysOnTop: true,
    frame: false,
    thickFrame: isWindows,
    transparent: !isWindows,
    backgroundColor: isWindows ? "#eef4f1" : "#00000000",
    ...(isWindows ? { backgroundMaterial: "acrylic" } : {}),
    resizable: true
  });
  win.setMinimumSize(640, 480);
  win.moveTop();
  globalThis.oviResizeWindow = win;
  globalThis.oviScreen = screen;
  await win.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><style>
    html,body{margin:0;width:100%;height:100%;background:transparent}
    main{box-sizing:border-box;width:100%;height:100%;margin:0;border:1px solid #8aa;border-radius:8px;background:rgba(247,251,249,.9);-webkit-app-region:no-drag}
    header{height:52px;padding:12px;-webkit-app-region:drag;font:16px sans-serif}
  </style><main><header>Open Voice Input resize fixture</header></main>`)}`);
}

if (process.argv.includes("--browser")) {
  verifyResponsiveWindows().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

if (process.argv.includes("--electron")) {
  verifyNativeElectronWindows().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

if (process.versions.electron && process.argv.includes("--electron-fixture")) {
  runElectronFixture().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
