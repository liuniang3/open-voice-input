"use strict";

(function installReadingLayout(win) {
  if (!win?.document) return;
  const doc = win.document;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  for (const grip of doc.querySelectorAll('[data-resize-axis="draft"][data-resize-target]')) {
    const pane = doc.getElementById(grip.dataset.resizeTarget);
    if (!pane) continue;
    const variable = "--draft-share";
    const min = 15;
    const max = 75;
    const key = `ovi-reading-${pane.id}-draft`;
    function set(value) {
      const bounded = Math.round(clamp(value, min, max));
      pane.style.setProperty(variable, `${bounded}%`);
      grip.setAttribute("aria-valuenow", String(bounded));
      try { win.localStorage.setItem(key, String(bounded)); } catch { /* Optional preference. */ }
    }
    function reset() {
      pane.style.removeProperty(variable);
      try { win.localStorage.removeItem(key); } catch { /* Optional preference. */ }
    }
    try { const saved = Number(win.localStorage.getItem(key)); if (saved > 0) set(saved); } catch { /* Optional preference. */ }
    grip.setAttribute("aria-valuemin", String(min)); grip.setAttribute("aria-valuemax", String(max));
    grip.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = event.clientY;
      const height = pane.getBoundingClientRect().height;
      const initial = Number.parseFloat(pane.style.getPropertyValue(variable)) || 35;
      grip.setPointerCapture(event.pointerId);
      const move = next => set(initial - (next.clientY - start) / Math.max(1, height) * 100);
      const stop = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("lostpointercapture", stop); };
      grip.addEventListener("pointermove", move); grip.addEventListener("lostpointercapture", stop);
    });
    grip.addEventListener("dblclick", reset);
    grip.addEventListener("keydown", event => {
      if (event.key === "Home") { event.preventDefault(); reset(); return; }
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const current = Number.parseFloat(pane.style.getPropertyValue(variable)) || 35;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      set(current - direction * 5);
    });
  }
})(typeof window === "undefined" ? null : window);
