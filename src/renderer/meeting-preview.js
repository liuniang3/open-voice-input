"use strict";
(function () {
  const surface = document.getElementById("previewSurface"), text = document.getElementById("previewText");
  const font = document.getElementById("previewFont"), opacity = document.getElementById("previewOpacity");
  const api = window.meetingPreview;
  function render(value) {
    if (!value) return;
    if (text.textContent !== value.text) { text.textContent = value.text || ""; text.scrollTop = text.scrollHeight; }
    font.value = String(value.fontSize || 14); surface.style.setProperty("--font-size", `${font.value}px`);
    surface.classList.toggle("is-hovered", value.hovered === true);
  }
  api.onUpdate(render); api.ready().then(result => render(result.value)).catch(() => {});
  const quietly = operation => { operation.catch(() => {}); };
  document.getElementById("previewRestore").addEventListener("click", () => quietly(api.restore()));
  font.addEventListener("input", () => { surface.style.setProperty("--font-size", `${font.value}px`); quietly(api.presentation({ fontSize: Number(font.value) })); });
  opacity.addEventListener("input", () => quietly(api.presentation({ opacity: Number(opacity.value) / 100 })));
  for (const edge of document.querySelectorAll("[data-edge]")) {
    edge.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); edge.setPointerCapture(event.pointerId);
      quietly(api.resize({ edge: edge.dataset.edge, phase: "start" }));
      const move = () => quietly(api.resize({ edge: edge.dataset.edge, phase: "move" }));
      const end = () => { edge.removeEventListener("pointermove", move); edge.removeEventListener("lostpointercapture", end); quietly(api.resize({ edge: edge.dataset.edge, phase: "end" })); };
      edge.addEventListener("pointermove", move); edge.addEventListener("lostpointercapture", end);
    });
  }
})();
