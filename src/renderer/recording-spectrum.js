"use strict";

(function (root) {
  const BAR_COUNT = 36;
  const SAMPLE_INTERVAL_MS = 32;
  const STALE_FRAME_MS = 240;

  function frequencyBands(bytes, sampleRate, fftSize, count = BAR_COUNT) {
    const values = new Float32Array(count);
    const hzPerBin = sampleRate / fftSize;
    const lower = Math.max(hzPerBin, 80);
    const upper = Math.min(sampleRate / 2, 6500);
    for (let i = 0; i < count; i++) {
      const start = Math.max(1, Math.floor(lower * Math.pow(upper / lower, i / count) / hzPerBin));
      const end = Math.min(bytes.length, Math.max(start + 1,
        Math.ceil(lower * Math.pow(upper / lower, (i + 1) / count) / hzPerBin)));
      let peak = 0;
      for (let bin = start; bin < end; bin++) peak = Math.max(peak, bytes[bin]);
      values[i] = Math.pow(Math.max(0, (peak - 40) / 215), 1.5);
    }
    return values;
  }

  function createRecordingSpectrum(win, { onFrame } = {}) {
    const canvas = win.document.getElementById("recordingSpectrum");
    let context;
    try { context = canvas?.getContext("2d"); } catch {}
    if (!context) return { start() {}, stop() {}, dispose() {}, render() {} };
    const preference = win.matchMedia("(prefers-reduced-motion: reduce)");
    let analyser = null;
    let bytes;
    let active = false;
    let remote = false;
    let frame = null;
    let sampleTimer = null;
    let staleTimer = null;
    let lastDraw = -Infinity;
    const levels = new Float32Array(BAR_COUNT);

    function paint() {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const ratio = Math.min(2, win.devicePixelRatio || 1);
      const width = Math.round(bounds.width * ratio);
      const height = Math.round(bounds.height * ratio);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      const slot = bounds.width / BAR_COUNT;
      const barWidth = Math.max(2, Math.min(8, slot * 0.58));
      for (let i = 0; i < BAR_COUNT; i++) {
        const level = preference.matches ? 0 : levels[i];
        const barHeight = 2 + level * (bounds.height - 8);
        context.fillStyle = `rgba(17, 134, 123, ${0.11 + level * 0.1})`;
        context.beginPath();
        context.roundRect(i * slot + (slot - barWidth) / 2, bounds.height - barHeight - 2,
          barWidth, barHeight, Math.min(3, barHeight / 2));
        context.fill();
      }
    }

    function tick(time) {
      frame = null;
      sampleTimer = null;
      if (!active || preference.matches || (win.document.hidden && !onFrame)) return;
      if (onFrame || time - lastDraw >= SAMPLE_INTERVAL_MS) {
        lastDraw = time;
        try {
          analyser.getByteFrequencyData(bytes);
          const next = frequencyBands(bytes, analyser.context.sampleRate, analyser.fftSize);
          for (let i = 0; i < BAR_COUNT; i++) levels[i] += (next[i] - levels[i]) * (next[i] > levels[i] ? 0.65 : 0.16);
          if (!win.document.hidden) paint();
          onFrame?.(Array.from(levels));
        } catch { stop(); return; }
      }
      scheduleSample();
    }

    function cancelSample() {
      if (frame !== null) win.cancelAnimationFrame(frame);
      if (sampleTimer !== null) win.clearTimeout(sampleTimer);
      frame = null;
      sampleTimer = null;
    }

    function scheduleSample() {
      if (remote || preference.matches || (!onFrame && win.document.hidden)) return;
      // The recorder may be hidden behind a separate display. Sampling must
      // not depend on its compositor issuing animation frames.
      if (onFrame) sampleTimer = win.setTimeout(() => tick(win.performance.now()), SAMPLE_INTERVAL_MS);
      else frame = win.requestAnimationFrame(tick);
    }

    function refresh() {
      cancelSample();
      if (!active) return;
      try { paint(); } catch { stop(); return; }
      scheduleSample();
      if (preference.matches && staleTimer !== null) { win.clearTimeout(staleTimer); staleTimer = null; }
    }

    function stop() {
      cancelSample();
      if (staleTimer !== null) win.clearTimeout(staleTimer);
      staleTimer = null;
      active = false;
      remote = false;
      analyser = null;
      bytes = null;
      levels.fill(0);
      canvas.hidden = true;
      context.clearRect(0, 0, canvas.width, canvas.height);
    }

    function start(node) {
      stop();
      if (!node) return;
      analyser = node;
      try { bytes = new Uint8Array(node.frequencyBinCount); } catch { stop(); return; }
      active = true;
      lastDraw = -Infinity;
      canvas.hidden = false;
      refresh();
    }

    preference.addEventListener("change", refresh);
    win.addEventListener("resize", refresh);
    win.document.addEventListener("visibilitychange", refresh);
    function dispose() {
      stop();
      preference.removeEventListener("change", refresh);
      win.removeEventListener("resize", refresh);
      win.document.removeEventListener("visibilitychange", refresh);
    }
    function render(values) {
      if (!Array.isArray(values) || values.length !== BAR_COUNT
        || values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return;
      cancelSample();
      if (staleTimer !== null) win.clearTimeout(staleTimer);
      staleTimer = null;
      remote = true; active = true;
      levels.set(values); canvas.hidden = false; paint();
      if (!preference.matches) staleTimer = win.setTimeout(() => {
        staleTimer = null;
        levels.fill(0);
        if (active && remote && !win.document.hidden) paint();
      }, STALE_FRAME_MS);
    }
    return { start, stop, dispose, render };
  }

  const exported = { frequencyBands, createRecordingSpectrum, BAR_COUNT };
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (root) root.RecordingSpectrum = exported;
})(typeof window === "undefined" ? null : window);
