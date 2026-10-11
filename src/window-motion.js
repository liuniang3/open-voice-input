"use strict";

const DURATIONS = Object.freeze({ enter: 160, bubble: 240, leave: 110 });

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
      settleEntrance(previous);
      previous.resolve?.(false);
    }
  }

  function sendEntrance(value) {
    try { if (alive()) win.webContents?.send("dictation:entrance", value); } catch {}
  }

  function ownsPosition(entrance) {
    const bounds = win.getBounds();
    return bounds.x === entrance.last.x && bounds.y === entrance.last.y &&
      bounds.width === entrance.bounds.width && bounds.height === entrance.bounds.height;
  }

  function settleEntrance(current) {
    if (!current.entrance || !alive()) return;
    try {
      if (ownsPosition(current.entrance)) win.setPosition(current.entrance.bounds.x, current.entrance.bounds.y, false);
      if (platform === "darwin") win.setVibrancy?.("under-window");
    } catch {}
    sendEntrance(null);
    current.entrance = null;
  }

  function prepareEntrance(value) {
    try {
      const bounds = win.getBounds();
      const origin = value?.origin || { x: bounds.width / 2, y: bounds.height / 2 };
      const offset = value?.offset || { x: 0, y: 0 };
      if (![origin.x, origin.y, offset.x, offset.y].every(Number.isFinite) ||
          origin.x < 0 || origin.x > bounds.width || origin.y < 0 || origin.y > bounds.height ||
          Math.abs(offset.x) > 48 || Math.abs(offset.y) > 48) return null;
      const last = { x: Math.round(bounds.x + offset.x), y: Math.round(bounds.y + offset.y) };
      win.setPosition(last.x, last.y, false);
      // A native rectangular material cannot shrink with the rounded CSS bubble.
      if (platform === "darwin") {
        try { win.setVibrancy?.(null); } catch {}
      }
      sendEntrance({ origin, duration: DURATIONS.bubble });
      return { bounds, last, origin };
    } catch { return null; }
  }

  function complete(current) {
    if (transition !== current) return;
    transition = null;
    cancel(current.timer);
    if (!alive()) { current.resolve?.(false); return; }
    settleEntrance(current);
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
    if (current.entrance) {
      try {
        if (ownsPosition(current.entrance)) {
          const { bounds, start } = current.entrance;
          const last = { x: Math.round(start.x + (bounds.x - start.x) * eased),
            y: Math.round(start.y + (bounds.y - start.y) * eased) };
          win.setPosition(last.x, last.y, false);
          current.entrance.last = last;
        } else settleEntrance(current);
      } catch { settleEntrance(current); }
    }
    if (!writeOpacity(current.from + (current.to - current.from) * eased) || progress === 1) {
      complete(current);
    } else current.timer = schedule(() => step(current), 16);
  }

  function show({ bubble = false, entrance = null } = {}) {
    if (!alive()) return;
    const reversing = transition?.kind === "hide";
    if (reversing) cancelTransition();
    if (win.isVisible() && !reversing && !bubble) { win.show(); return; }
    cancelTransition();
    const from = reversing ? opacity : 0;
    const animate = enabled() && writeOpacity(from);
    if (!animate) writeOpacity(1);
    const geometry = animate && bubble ? prepareEntrance(entrance) : null;
    if (geometry) geometry.start = { ...geometry.last };
    else if (bubble) sendEntrance(null);
    win.show();
    if (animate) {
      transition = { kind: "show", from, to: 1, entrance: geometry,
        started: now(), duration: geometry ? DURATIONS.bubble : DURATIONS.enter };
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

  return { show, hide, setReducedMotion, dispose,
    isBubbleEntering: () => Boolean(transition?.entrance),
    finishEntrance: () => { if (transition?.kind === "show") complete(transition); } };
}

module.exports = { createWindowMotion, DURATIONS };
