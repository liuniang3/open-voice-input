"use strict";

const DURATIONS = Object.freeze({ enter: 160, leave: 110 });

function createWindowMotion({ window: win, platform = process.platform,
  now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout }) {
  // Stay still until the renderer has reported the system accessibility setting.
  let reducedMotion = true;
  let disposed = false;
  let transition = null;
  let opacity = 1;
  const alive = () => !disposed && !win.isDestroyed();
  const enabled = () => !reducedMotion && ["win32", "darwin"].includes(platform);

  function writeOpacity(value) {
    if (!alive()) return false;
    opacity = value;
    try { win.setOpacity(value); return true; } catch { return false; }
  }

  function cancelTransition() {
    const previous = transition;
    transition = null;
    if (previous) {
      cancel(previous.timer);
      previous.resolve?.(false);
    }
  }

  function complete(current) {
    if (transition !== current) return;
    transition = null;
    cancel(current.timer);
    if (!alive()) { current.resolve?.(false); return; }
    if (current.kind === "hide") {
      win.hide();
      writeOpacity(1);
      try { current.onHidden?.(); } finally { current.resolve(true); }
    } else writeOpacity(1);
  }

  function step(current) {
    if (transition !== current) return;
    if (!alive()) { cancelTransition(); return; }
    const progress = Math.min(1, Math.max(0, (now() - current.started) / current.duration));
    const eased = 1 - Math.pow(1 - progress, 3);
    if (!writeOpacity(current.from + (current.to - current.from) * eased) || progress === 1) {
      complete(current);
    } else current.timer = schedule(() => step(current), 16);
  }

  function show() {
    if (!alive()) return;
    const reversing = transition?.kind === "hide";
    if (reversing) cancelTransition();
    if (win.isVisible() && !reversing) { win.show(); return; }
    cancelTransition();
    const from = reversing ? opacity : 0;
    const animate = enabled() && writeOpacity(from);
    if (!animate) writeOpacity(1);
    win.show();
    if (animate) {
      transition = { kind: "show", from, to: 1, started: now(), duration: DURATIONS.enter };
      step(transition);
    }
  }

  function hide(onHidden) {
    if (!alive()) return Promise.resolve(false);
    if (transition?.kind === "hide") return transition.promise;
    cancelTransition();
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const current = { kind: "hide", from: opacity, to: 0, started: now(),
      duration: DURATIONS.leave, promise, resolve, onHidden };
    transition = current;
    if (!win.isVisible() || !enabled()) complete(current);
    else step(current);
    return promise;
  }

  function setReducedMotion(value) {
    reducedMotion = value !== false;
    if (reducedMotion && transition) complete(transition);
  }

  function dispose() {
    cancelTransition();
    writeOpacity(1);
    disposed = true;
  }

  return { show, hide, setReducedMotion, dispose };
}

module.exports = { createWindowMotion, DURATIONS };
