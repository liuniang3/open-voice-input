# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- Added an independent file transcription workspace with per-file ASR selection, transcript correction, structured summarization, and Markdown/TXT/DOCX export.
- Added a separate tray entry for file transcription and reusable analysis generations for explicitly regenerating corrected text and summaries.
- Meeting Stage 4C UI: workbench basic/enhanced process mode, 32/48/64 kbps quality chips, Fun-ASR + OSS settings with secret show/copy and connection tests, speaker select + rename, phase/cleanup status mapping.
- Added provider-aware audio policies for MiMo, Qwen3-ASR, and Fun-ASR, including documented size and duration limits.
- Added in-recording ASR segment prefetch and in-memory transcript caching for long MiMo/Qwen batch recordings.
- Added automatic ordered segment joining with a single final cleanup pass in Stable mode.
- Added in-app settings tabs, API key show/copy controls, and independent ASR model connection profiles.
- Saved custom ASR and cleanup models now appear directly in their model selectors.
- Added cleanup model presets for GPT-5.4 mini, Grok 4.5, MiMo V2.5, and MiMo V2.5 Pro while retaining custom model IDs.
- Added a repeatable cleaner model/prompt benchmark with quality, preservation, cleanup, JSON compliance, reliability, and latency scoring.

### Changed

- Meeting workbench visual refresh: light translucent glass surface, green primary / coral record / amber warn accents, frameless containment at 960×640 and 1180×760.
- Normalized microphone uploads to 16 kHz mono 16-bit PCM WAV instead of preserving oversized device sample rates.
- Realtime Qwen/Fun recordings now use the completed streaming transcript instead of uploading the complete WAV again.
- Audio retry payloads now carry only the representation required by the selected provider, avoiding duplicate WAV and PCM Base64 copies.
- Replaced the separate native Windows settings window with the frameless main application window.
- Replaced the broad cleanup prompt with the benchmarked conservative deletion-span method.
- Added local cleanup output validation and raw-transcript fallback for paraphrased, expanded, over-deleted, or malformed model responses.
- Made MiMo cleanup use its selected cleanup model and independent cleanup credentials instead of silently reusing the primary model field.
- Added per-model cleanup connection profiles so switching between GPT, Grok, MiMo, and custom models restores the matching provider, Base URL, and API key.

### Fixed

- Fixed file analysis results being discarded when compatible models returned supported `claim` or `statement` fields instead of `text`.
- Fixed stale analysis artifacts being reused during regeneration and made the file workspace reveal the completed structured summary automatically.
- Fixed frameless secondary-window minimize, maximize, restore, drag, and resize controls.
- Disabled the local repeated-fragment regex to avoid mechanically collapsing valid Chinese reduplication.
- Connection testing now verifies the selected Stable-mode cleanup model independently from ASR.
- Cleanup network failures now fall back to the successful raw ASR transcript, while ASR failures are reported separately with their underlying network cause.

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
