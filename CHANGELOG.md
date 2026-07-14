# Changelog

All notable changes to this project are documented here.

## Unreleased

## v0.2.0 - 2026-07-15

### Changed

- Renamed the project from MiMo Voice Input to Open Voice Input to reflect the new provider-agnostic direction.
- Updated README files, package metadata, app title, logs, and double-click launch script names.

### Added

- Added Windows NSIS installer and single-file portable build targets.
- Added a GitHub Actions release workflow with SHA-256 checksums.
- Added a pre-build secret scan that stops packaging when real-looking API keys are found.
- Added Fun-ASR as an ASR provider alongside MiMo and Qwen3-ASR.
- Added Fun-ASR realtime WebSocket support for local microphone recordings.
- Added Fun-ASR REST batch scaffolding for public audio URLs.
- Added OpenAI-compatible text cleanup as a separate second-stage cleaner option.

### Fixed

- Added a recording key fallback in the main process so `Enter` can stop recording even when the floating recording popup fails to receive keyboard focus.
- Added fallback handling for `Esc`, `Backspace`, and `Delete` to cancel recording without requiring popup focus.
- Increased focus retry attempts for the floating recording popup on Windows.
- Removed unused transcript state and now clear per-recording audio/context snapshots after each transcription, reducing the risk of carrying state between recordings.

## v0.1.0 - 2026-05-02

### Added

- Initial Windows voice input assistant MVP powered by Xiaomi MiMo V2.5 multimodal API.
- Global hotkey recording flow.
- Small floating recording indicator.
- Tray menu for settings, recording, hiding, and quitting.
- Configurable API key, base URL, global hotkey, microphone, and transcription mode.
- Token Plan URL auto-selection for `tp-` keys.
- Clipboard paste into the previously focused app.
- Two explicit transcription mode buttons:
  - `Stable`: raw audio transcription followed by text cleanup.
  - `Fast`: one MiMo call for lower latency.
- Per-recording transcription mode snapshot so changing modes while processing affects only the next recording.
- Separate settings window and compact recording popup.
- Chinese README and English README.
- Public GitHub release `v0.1.0 MVP`.

### Changed

- Split MiMo transcription paths internally into isolated fast and stable mode flows.
- Updated English README title and introduction to use English text.
- Removed duplicate Chinese launch scripts and kept the English double-click launch entries.

### Fixed

- Fixed custom hotkey registration so the previously configured default hotkey is not kept active after changing settings.
- Fixed tray `Hide` menu callback.
- Improved punctuation fallback in cleaned transcripts.
- Improved filler-word and repeated-fragment cleanup.

### Known Limits

- This is not a real Windows IME driver; it uses clipboard paste.
- MiMo multimodal chat is not a dedicated ASR endpoint, so occasional non-transcription responses can still happen.
- `Stable` mode uses two API calls, increasing latency and cost.
- Automatic updates and code signing are not configured yet; unsigned builds may trigger Windows SmartScreen.
