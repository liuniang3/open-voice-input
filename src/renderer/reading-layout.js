"use strict";

(function installReadingLayout(win) {
  if (!win?.document) return;
  const doc = win.document;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  for (const grip of doc.querySelectorAll("[data-resize-target]")) {
    const pane = doc.getElementById(grip.dataset.resizeTarget);
    if (!pane) continue;
    const draft = grip.dataset.resizeAxis === "draft";
    const variable = draft ? "--draft-share" : "--reading-height";
    const min = draft ? 15 : pane.id === "fileResults" ? 200 : 160;
    const max = draft ? 75 : 1600;
    const key = `ovi-reading-${pane.id}-${draft ? "draft" : "height"}`;
    function set(value) {
      const bounded = Math.round(clamp(value, min, max));
      pane.style.setProperty(variable, `${bounded}${draft ? "%" : "px"}`);
      if (!draft) pane.dataset.userSized = "true";
      grip.setAttribute("aria-valuenow", String(bounded));
      try { win.localStorage.setItem(key, String(bounded)); } catch { /* Optional preference. */ }
    }
    function reset() {
      pane.style.removeProperty(variable); delete pane.dataset.userSized;
      try { win.localStorage.removeItem(key); } catch { /* Optional preference. */ }
    }
    try { const saved = Number(win.localStorage.getItem(key)); if (saved > 0) set(saved); } catch { /* Optional preference. */ }
    grip.setAttribute("aria-valuemin", String(min)); grip.setAttribute("aria-valuemax", String(max));
    grip.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = event.clientY;
      const height = pane.getBoundingClientRect().height;
      const initial = draft ? Number.parseFloat(pane.style.getPropertyValue(variable)) || 35 : height;
      grip.setPointerCapture(event.pointerId);
      const move = next => set(draft ? initial - (next.clientY - start) / Math.max(1, height) * 100 : initial + next.clientY - start);
      const stop = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("lostpointercapture", stop); };
      grip.addEventListener("pointermove", move); grip.addEventListener("lostpointercapture", stop);
    });
    grip.addEventListener("dblclick", reset);
    grip.addEventListener("keydown", event => {
      if (event.key === "Home") { event.preventDefault(); reset(); return; }
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const current = draft ? Number.parseFloat(pane.style.getPropertyValue(variable)) || 35 : pane.getBoundingClientRect().height;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      set(current + direction * (draft ? -5 : 24));
    });
  }
})(typeof window === "undefined" ? null : window);
