"use strict";

(function installWorkspaceSidebars(win) {
  if (!win?.document) return;
  const minWidth = 200;
  const maxWidth = 440;
  for (const panel of win.document.querySelectorAll("[data-sidebar-workspace]")) {
    const key = `ovi-${panel.dataset.sidebarWorkspace}-sidebar-widths`;
    let saved;
    try { saved = JSON.parse(win.localStorage.getItem(key)); } catch { /* View preferences are optional. */ }
    const handles = [...panel.querySelectorAll("[data-sidebar-resize]")];
    const widths = {};
    for (const handle of handles) {
      const kind = handle.dataset.sidebarResize;
      const value = Number(saved?.[kind]);
      widths[kind] = Number.isFinite(value) && value >= minWidth ? Math.min(maxWidth, value)
        : kind === "history" ? 220 : 264;
    }
    let drag = null;
    const visible = handle => handle.parentElement.getClientRects().length > 0;
    const enabled = () => win.innerWidth > 900 && !panel.closest(".live-floating");
    function render() {
      if (drag && (!enabled() || !visible(drag.handle))) finish({ pointerId: drag.pointerId });
      const shown = handles.filter(visible);
      const available = Math.max(minWidth * shown.length, panel.clientWidth - 320);
      let extra = Math.max(0, shown.reduce((sum, handle) => sum + widths[handle.dataset.sidebarResize], 0) - available);
      for (const handle of handles) {
        const kind = handle.dataset.sidebarResize;
        const reduction = shown.includes(handle) ? Math.min(extra, widths[kind] - minWidth) : 0;
        extra -= reduction;
        const width = Math.round(widths[kind] - reduction);
        panel.style.setProperty(`--workspace-${kind}-size`, `${width}px`);
        handle.setAttribute("aria-valuenow", String(width));
        handle.setAttribute("aria-valuemin", String(minWidth));
        handle.setAttribute("aria-valuemax", String(maxWidth));
        handle.tabIndex = enabled() && visible(handle) ? 0 : -1;
      }
    }
    function setWidth(handle, value) {
      const other = handles.filter(item => item !== handle && visible(item))
        .reduce((sum, item) => sum + item.parentElement.getBoundingClientRect().width, 0);
      const limit = Math.max(minWidth, Math.min(maxWidth, panel.clientWidth - 320 - other));
      widths[handle.dataset.sidebarResize] = Math.round(Math.max(minWidth, Math.min(limit, value)));
      render();
    }
    function save() {
      try { win.localStorage.setItem(key, JSON.stringify(widths)); } catch { /* View preferences are optional. */ }
    }
    function finish(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const handle = drag.handle;
      drag = null;
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      win.document.body.classList.remove("workspace-sidebar-resizing");
      save();
    }
    for (const handle of handles) {
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0 || !enabled()) return;
        event.preventDefault();
        drag = { handle, pointerId: event.pointerId, x: event.clientX, width: handle.parentElement.getBoundingClientRect().width };
        handle.setPointerCapture(event.pointerId);
        win.document.body.classList.add("workspace-sidebar-resizing");
      });
      handle.addEventListener("pointermove", event => {
        if (drag?.handle === handle && drag.pointerId === event.pointerId) setWidth(handle, drag.width + event.clientX - drag.x);
      });
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(name, finish);
      handle.addEventListener("keydown", event => {
        if (!enabled() || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = handle.parentElement.getBoundingClientRect().width;
        setWidth(handle, event.key === "Home" ? minWidth : event.key === "End" ? maxWidth
          : current + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 40 : 16));
        save();
      });
    }
    new MutationObserver(render).observe(panel, { subtree: true, attributes: true, attributeFilter: ["hidden", "open", "class"] });
    win.addEventListener("resize", render);
    render();
  }
})(typeof window === "undefined" ? null : window);
