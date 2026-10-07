"use strict";

const panel = document.getElementById("statusPanel"), detail = document.getElementById("statusDetail");
const spectrum = window.RecordingSpectrum.createRecordingSpectrum(window);
let followTail = true, scrollFrame = 0, showingPreview = false;
function update(value) {
  if (!value) return;
  if (!value.preview || !showingPreview) followTail = true;
  showingPreview = value.preview;
  panel.dataset.kind = value.kind; panel.dataset.preview = String(value.preview);
  document.getElementById("pulse").dataset.kind = value.kind;
  document.getElementById("statusTitle").textContent = value.title;
  detail.textContent = value.detail;
  if (value.kind !== "recording") spectrum.stop();
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (followTail) detail.scrollTop = detail.scrollHeight;
  });
}
detail.addEventListener("scroll", () => {
  if (!scrollFrame) followTail = detail.scrollHeight - detail.clientHeight - detail.scrollTop <= 2;
});
document.getElementById("recordingCancelBtn").addEventListener("click", () => window.dictationPreview.command("cancel"));
window.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); window.dictationPreview.command("stop"); }
  else if (["Escape", "Backspace", "Delete"].includes(event.key)) { event.preventDefault(); window.dictationPreview.command("cancel"); }
});
let receivedState = false;
window.dictationPreview.onState(value => { receivedState = true; update(value); });
window.dictationPreview.onSpectrum(levels => {
  if (panel.dataset.kind === "recording") spectrum.render(levels);
});
void window.dictationPreview.ready().then(value => { if (!receivedState) update(value); });
window.addEventListener("unload", () => { cancelAnimationFrame(scrollFrame); spectrum.dispose(); });
