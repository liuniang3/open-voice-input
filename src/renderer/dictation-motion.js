"use strict";

(function (root) {
  function createDictationMotion(win = root) {
    const doc = win.document, preference = win.matchMedia("(prefers-reduced-motion: reduce)");
    let active = null;
    function cancel() {
      const previous = active;
      active = null;
      previous?.forEach(animation => animation.cancel());
      doc.body.classList.remove("dictation-entering");
    }
    function enter(value) {
      cancel();
      const shell = doc.querySelector(".shell"), origin = value?.origin;
      if (!shell || !value || preference.matches || !doc.body.classList.contains("recording-mode") ||
          ![origin?.x, origin?.y].every(Number.isFinite) ||
          origin.x < 0 || origin.x > win.innerWidth || origin.y < 0 || origin.y > win.innerHeight) return;
      doc.body.classList.add("dictation-entering");
      const options = { duration: 240, easing: "cubic-bezier(0.33, 1, 0.68, 1)", fill: "both" };
      const pivot = `${origin.x}px ${origin.y}px`;
      try {
        active = [];
        active.push(shell.animate([
          { transform: "scale(0.035, 0.14)", transformOrigin: pivot, borderRadius: "58px" },
          { transform: "none", transformOrigin: pivot, borderRadius: "18px" }
        ], options));
        for (const content of shell.querySelectorAll(".recording-chrome, .status-panel")) {
          active.push(content.animate([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], options));
        }
        const animations = active;
        void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
          if (active === animations) cancel();
        });
      } catch { cancel(); }
    }
    const onPreference = () => { if (preference.matches) cancel(); };
    preference.addEventListener("change", onPreference);
    return { enter, cancel, dispose() { cancel(); preference.removeEventListener("change", onPreference); } };
  }
  root.DictationMotion = { createDictationMotion };
  root.dictationMotion = createDictationMotion();
  (root.dictationPreview || root.mimoInput)?.onDictationEntrance?.(value => root.dictationMotion.enter(value));
  root.addEventListener("unload", () => root.dictationMotion.dispose());
})(window);
