"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { frequencyBands, createRecordingSpectrum, BAR_COUNT } = require("../src/renderer/recording-spectrum");
const root = path.resolve(__dirname, "..");

function eventTarget() {
  const listeners = new Map();
  return { addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); }, emit(name) { listeners.get(name)?.(); }, listeners };
}

function fixture(options) {
  const context = { clearRect() {}, setTransform() {}, beginPath() {}, fill() {}, bars: [],
    roundRect(x, y, width, height) { this.bars.push({ x, y, width, height }); } };
  const canvas = { hidden: true, width: 0, height: 0, getContext: () => context,
    getBoundingClientRect: () => ({ width: 520, height: 82 }) };
  const preference = { ...eventTarget(), matches: false };
  const document = { ...eventTarget(), hidden: false, getElementById: () => canvas };
  const frames = new Map();
  const timers = new Map();
  let id = 0, clock = 0;
  const win = { ...eventTarget(), document, devicePixelRatio: 2, matchMedia: () => preference,
    performance: { now: () => clock },
    setTimeout(fn, delay) { timers.set(++id, { fn, at: clock + delay }); return id; },
    clearTimeout(key) { timers.delete(key); },
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; }, cancelAnimationFrame(key) { frames.delete(key); } };
  const analyser = { context: { sampleRate: 16000 }, fftSize: 1024, frequencyBinCount: 512,
    getByteFrequencyData(bytes) { bytes.fill(0); bytes[20] = 240; bytes[140] = 180; } };
  const spectrum = createRecordingSpectrum(win, options);
  function step(time) { const fn = [...frames.values()][0]; frames.clear(); fn?.(time); }
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      clock = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    clock = until;
  }
  return { spectrum, context, canvas, preference, document, win, frames, timers, analyser, step, advance };
}

function unitTests() {
  const silent = new Uint8Array(512);
  assert.equal(frequencyBands(silent, 16000, 1024).every(value => value === 0), true);
  const low = new Uint8Array(512); low[13] = 255;
  const high = new Uint8Array(512); high[200] = 255;
  const lowBands = frequencyBands(low, 16000, 1024);
  const highBands = frequencyBands(high, 16000, 1024);
  assert.ok(lowBands.indexOf(Math.max(...lowBands)) < highBands.indexOf(Math.max(...highBands)), "different frequencies activate different horizontal bars");
  assert.ok([...lowBands, ...highBands].every(value => value >= 0 && value <= 1));
  const f = fixture();
  f.spectrum.start(f.analyser);
  assert.equal(f.canvas.hidden, false);
  assert.equal(f.canvas.width, 1040); assert.equal(f.canvas.height, 164);
  assert.equal(f.frames.size, 1);
  f.context.bars = []; f.step(40);
  assert.equal(f.context.bars.length, BAR_COUNT);
  assert.ok(new Set(f.context.bars.map(bar => bar.height)).size > 1, "real bands, not a uniform volume progress bar");
  f.context.bars = []; f.step(48);
  assert.equal(f.context.bars.length, 0, "paint frequency stays bounded instead of processing every animation frame");
  f.preference.matches = true; f.preference.emit("change");
  assert.equal(f.frames.size, 0, "Reduce Motion cancels the decorative rendering loop");
  assert.equal(f.context.bars.slice(-BAR_COUNT).every(bar => bar.height === 2), true);
  f.preference.matches = false; f.preference.emit("change");
  assert.equal(f.frames.size, 1);
  f.document.hidden = true; f.document.emit("visibilitychange");
  assert.equal(f.frames.size, 0);
  f.document.hidden = false; f.document.emit("visibilitychange");
  assert.equal(f.frames.size, 1);
  for (let i = 0; i < 20; i++) { f.spectrum.stop(); assert.equal(f.frames.size, 0); f.spectrum.start(f.analyser); }
  f.analyser.getByteFrequencyData = () => { throw new Error("closed context"); };
  f.step(100);
  assert.equal(f.frames.size, 0); assert.equal(f.canvas.hidden, true);
  f.spectrum.dispose();
  assert.equal(f.preference.listeners.size + f.document.listeners.size + f.win.listeners.size, 0);
  const noCanvas = createRecordingSpectrum({ document: { getElementById: () => null } });
  noCanvas.start(f.analyser); noCanvas.stop(); noCanvas.dispose();
  const remote = fixture();
  remote.spectrum.render(Array(BAR_COUNT).fill(0.8));
  assert.equal(remote.canvas.hidden, false); assert.equal(remote.frames.size, 0);
  assert.equal(remote.timers.size, 1);
  remote.advance(241);
  assert.equal(remote.context.bars.slice(-BAR_COUNT).every(bar => bar.height === 2), true,
    "interrupted spectrum delivery settles to silence instead of holding the last bars");
  remote.spectrum.render(Array(BAR_COUNT).fill(0.8));
  const remoteBars = remote.context.bars.length;
  remote.spectrum.render(Array(BAR_COUNT).fill(NaN));
  assert.equal(remote.context.bars.length, remoteBars);
  remote.preference.matches = true; remote.preference.emit("change");
  assert.equal(remote.context.bars.slice(-BAR_COUNT).every(bar => bar.height === 2), true);
  assert.equal(remote.timers.size, 0);
  remote.spectrum.dispose();
  assert.equal(remote.timers.size, 0);

  const emitted = [], producer = fixture({ onFrame: values => emitted.push(values) });
  producer.document.hidden = true;
  producer.spectrum.start(producer.analyser);
  assert.equal(producer.frames.size, 0, "a mirrored spectrum never relies on compositor animation frames");
  assert.equal(producer.timers.size, 1);
  producer.advance(320);
  assert.equal(emitted.length, 10, "hidden recording samples remain bounded at about 30fps");
  const lowBand = emitted.at(-1).indexOf(Math.max(...emitted.at(-1)));
  producer.analyser.getByteFrequencyData = bytes => { bytes.fill(0); bytes[200] = 255; };
  producer.advance(320);
  assert.ok(emitted.at(-1).indexOf(Math.max(...emitted.at(-1))) > lowBand + 3);
  producer.analyser.getByteFrequencyData = bytes => bytes.fill(0);
  producer.advance(1500);
  assert.ok(Math.max(...emitted.at(-1)) < 0.01, "silence decays while the recorder remains hidden");
  for (let i = 0; i < 20; i++) {
    producer.document.hidden = !producer.document.hidden; producer.document.emit("visibilitychange");
    producer.win.emit("resize");
    assert.equal(producer.timers.size, 1, "visibility/size changes cannot duplicate sampler timers");
    assert.equal(producer.frames.size, 0);
  }
  producer.preference.matches = true; producer.preference.emit("change");
  assert.equal(producer.timers.size, 0);
  producer.preference.matches = false; producer.preference.emit("change");
  assert.equal(producer.timers.size, 1);
  producer.spectrum.stop();
  const samplesBeforeStop = emitted.length; producer.advance(500);
  assert.equal(emitted.length, samplesBeforeStop);
  assert.equal(producer.timers.size, 0);
  producer.spectrum.dispose();

  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  assert.match(html, /Enter 输入 · Esc 取消/);
  assert.match(html, /id="recordingCancelBtn"[^>]*><span class="ui-icon icon-close"/);
  assert.doesNotMatch(html, /id="levelMeter"|id="levelFill"/);
  const renderer = fs.readFileSync(path.join(root, "src/renderer/renderer.js"), "utf8");
  assert.match(renderer, /sourceNode\.connect\(spectrumAnalyser\)/);
  assert.match(renderer, /sourceNode\.connect\(processorNode\)/);
  assert.match(renderer, /function stopRecordingSpectrum\(\)/);
  assert.match(renderer, /recordingSpectrum\.dispose\(\)/);
  console.log("PASS true frequency bands, bounded painting, timer-driven hidden producer, silence, stale-frame reset, Reduce Motion, restart/disposal and independent PCM capture");
}

async function verifyBrowser() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const output = path.join(root, "output/playwright/recording-spectrum");
  fs.mkdirSync(output, { recursive: true });
  try {
    const page = await browser.newPage({ reducedMotion: "no-preference" });
    const errors = await prepareBrowser(page);
    await page.waitForFunction(() => document.getElementById("homeTodayCount").textContent === "18");
    await page.evaluate(async () => {
      window.applyWindowMode("recording");
      window.setStatus("recording", "正在录音", "");
      const audio = new AudioContext({ sampleRate: 16000 });
      const analyser = audio.createAnalyser(); analyser.fftSize = 1024;
      analyser.minDecibels = -80; analyser.maxDecibels = -20;
      const signal = audio.createGain(); signal.gain.value = 0.12;
      const mute = audio.createGain(); mute.gain.value = 0;
      signal.connect(analyser); analyser.connect(mute); mute.connect(audio.destination);
      const tones = [220, 820, 2500].map(frequency => {
        const oscillator = audio.createOscillator(); oscillator.frequency.value = frequency;
        oscillator.connect(signal); oscillator.start(); return oscillator;
      });
      await audio.resume();
      window.spectrumFixture = { audio, analyser, tones };
      recordingSpectrum.start(analyser);
    });
    function pixels() {
      return page.locator("#recordingSpectrum").evaluate(canvas => {
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let colored = 0; let checksum = 0;
        for (let i = 3; i < data.length; i += 4) { if (data[i]) colored++; checksum = (checksum + data[i] * i) >>> 0; }
        return { colored, checksum, width: canvas.width, height: canvas.height };
      });
    }
    await page.waitForTimeout(180);
    const first = await pixels(); assert.ok(first.colored > 100);
    await page.evaluate(() => { window.spectrumFixture.tones[0].frequency.value = 1500; window.spectrumFixture.tones[2].frequency.value = 5100; });
    await page.waitForTimeout(180);
    assert.notEqual((await pixels()).checksum, first.checksum, "actual Web Audio frequency changes move different bars");
    for (const platform of ["win32", "darwin"]) {
      for (const [width, height, detail] of [[320, 116, ""], [340, 116, "这是一段实时转写内容，文字保持清晰，淡色频谱显示在背景里。"], [420, 116, "这是一段合成的实时转写内容，用来检查长文本、背景频谱和取消按钮之间没有遮挡。".repeat(5)], [340, 116, "这是用于检查固定浮窗的合成文本，先前内容仍然完整保留，可以向上滚动查看。".repeat(30) + "最新一句显示在窗口内，窗口不会随着文字增多而变大。"]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(({ platform, detail }) => {
          document.documentElement.dataset.platform = platform;
          if (detail) window.setRecordingPreview(detail);
          else window.setStatus("recording", "正在录音", "");
        }, { platform, detail });
        await page.waitForTimeout(100);
        const layout = await page.evaluate(() => {
          const canvas = document.getElementById("recordingSpectrum");
          const cancel = document.getElementById("recordingCancelBtn");
          const bounds = cancel.getBoundingClientRect();
          const icon = cancel.querySelector(".ui-icon");
          return { pointerEvents: getComputedStyle(canvas).pointerEvents, chromeHeight: document.getElementById("recordingChrome").getBoundingClientRect().height,
            buttonWidth: bounds.width, buttonHeight: bounds.height, buttonRight: bounds.right, buttonTop: bounds.top,
            iconMask: getComputedStyle(icon).maskImage, shadow: getComputedStyle(cancel).boxShadow,
            overflow: document.documentElement.scrollWidth > innerWidth, focusRegion: getComputedStyle(cancel).webkitAppRegion };
        });
        assert.equal(layout.pointerEvents, "none");
        assert.equal(layout.shadow, "none"); assert.equal(layout.buttonWidth, 22); assert.equal(layout.buttonHeight, 22);
        assert.ok(layout.buttonRight <= width && layout.buttonTop >= 0 && layout.chromeHeight <= 28);
        assert.notEqual(layout.iconMask, "none"); assert.equal(layout.focusRegion, "no-drag"); assert.equal(layout.overflow, false);
        assert.ok((await pixels()).colored > 0);
        await page.screenshot({ path: path.join(output, `recording-${platform}-${width}${detail.length > 1000 ? "-long" : ""}.png`) });
      }
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(70);
    const staticPixels = await pixels();
    await page.waitForTimeout(80);
    assert.deepEqual(await pixels(), staticPixels, "Reduce Motion freezes decorative frequency motion");
    await page.evaluate(() => { recordingSpectrum.stop(); });
    assert.equal(await page.locator("#recordingSpectrum").isVisible(), false);
    assert.equal((await pixels()).colored, 0, "stop clears the previous recording's visual data");
    await page.evaluate(() => {
      recordingSpectrum.start(window.spectrumFixture.analyser);
      window.applyWindowMode("home");
    });
    assert.equal(await page.locator("#recordingSpectrum").isVisible(), false, "navigation cannot leak a live spectrum into another page");
    await page.evaluate(async () => {
      window.spectrumFixture.tones.forEach(tone => tone.stop());
      await window.spectrumFixture.audio.close();
    });
    await verifyRecordingIntegration(page);
    assert.deepEqual(errors, []);
    console.log("PASS browser: real Web Audio canvas pixels, frequency response, Windows/macOS compact layouts at 320/340/420, clear transcript, quiet cancel icon and visual cleanup; no microphone/API access");
  } finally { await browser.close(); }
}

async function verifyRecordingIntegration(page) {
  const completeText = "请检查真实频谱与录音互不影响，并完整输入这一段话。".repeat(20) + "最后一句也必须保留，不能省略。";
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(completeText => {
    window.generatedMicrophones = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext({ sampleRate: 16000 });
      const destination = audio.createMediaStreamDestination();
      const gain = audio.createGain(); gain.gain.value = 0.16;
      const tone = audio.createOscillator(); tone.frequency.value = 820;
      tone.connect(gain); gain.connect(destination); tone.start();
      await audio.resume();
      window.generatedMicrophones.push({ audio, tone, stream: destination.stream });
      return destination.stream;
    };
    window.mockApiOverrides = {
      startRealtimeAsr: async () => ({ enabled: true }),
      finishRealtimeAsr: async () => completeText,
      transcribeSegment: async payload => { window.mockCalls.push({ name: "transcribeSegment", payload }); return completeText; },
      cleanText: async payload => { window.mockCalls.push({ name: "cleanText", payload }); return completeText; }
    };
  }, completeText);
  for (const asrMode of ["batch", "realtime"]) {
    for (const transcriptionMode of ["fast", "stable"]) {
      await page.evaluate(async ({ asrMode, transcriptionMode }) => {
        Object.assign(window.mockSettings(), { asrProvider: "qwen3-asr", asrModel: "qwen3-asr-flash",
          asrRealtimeModel: "qwen-audio-3.0-asr-flash-streaming", asrMode, transcriptionMode });
        window.applyWindowMode("recording");
        window.mockCalls.length = 0;
        await window.startRecording({ autoSend: true });
      }, { asrMode, transcriptionMode });
      await page.waitForFunction(() => recordingSampleCount >= recordingSampleRate * 0.65);
      await page.evaluate(completeText => window.mockHooks.onPartialTranscript(completeText), completeText);
      const recording = await page.evaluate(() => ({ samples: recordingSampleCount, peak: recordingPeak,
        visible: !document.getElementById("recordingSpectrum").hidden }));
      assert.ok(recording.samples > 0 && recording.peak > 0.03 && recording.visible,
        "the real renderer must retain PCM capture while displaying its spectrum");
      const frequency = await page.evaluate(() => {
        const data = new Uint8Array(spectrumAnalyser.frequencyBinCount);
        spectrumAnalyser.getByteFrequencyData(data);
        return Math.max(...data);
      });
      assert.ok(frequency > 100, "the analyser must receive data in the actual microphone graph, without a separate output connection");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !isRecording && !isTranscribing);
      const result = await page.evaluate(() => ({ text: resultText.value,
        injected: window.mockCalls.filter(call => call.name === "injectText").map(call => call.payload),
        cleaned: window.mockCalls.filter(call => call.name === "cleanText").map(call => call.payload.rawText),
        uploads: window.mockCalls.filter(call => call.name === "transcribeSegment").map(call => call.payload.byteLength),
        hidden: document.getElementById("recordingSpectrum").hidden,
        ended: window.generatedMicrophones.at(-1).stream.getTracks().every(track => track.readyState === "ended"),
        closed: audioContext.state === "closed" }));
      assert.equal(result.text, completeText);
      assert.deepEqual(result.injected, [completeText], "Enter must send all text, including the last sentence, to the paste interface");
      assert.deepEqual(result.cleaned, transcriptionMode === "stable" ? [completeText] : []);
      if (asrMode === "batch") assert.ok(result.uploads.every(bytes => bytes > 44) && result.uploads.length > 0);
      assert.equal(result.hidden && result.ended && result.closed, true, "finish clears the spectrum and releases recording resources");
    }
  }
  await page.evaluate(async () => { window.applyWindowMode("recording"); window.mockCalls.length = 0; await window.startRecording(); });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !isRecording && document.getElementById("recordingSpectrum").hidden);
  assert.equal(await page.evaluate(() => window.mockCalls.some(call => call.name === "injectText" || call.name === "transcribeSegment")), false,
    "Escape must cancel without transcription or paste");
  await page.evaluate(async () => {
    for (const microphone of window.generatedMicrophones) { microphone.tone.stop(); await microphone.audio.close(); }
  });
  console.log("PASS renderer integration: synthetic microphone PCM and real spectrum in batch/realtime Fast/Stable, complete Enter paste and Escape resource cleanup; no real microphone/API");
}

if (require.main === module) (async () => {
  unitTests();
  if (process.argv.includes("--browser")) await verifyBrowser();
})().catch(error => { console.error(error); process.exitCode = 1; });
