# Changelog

All notable changes to this project are documented here.

## v0.4.8 - 2026-10-02

### Changed

- Split speech recognition and language processing into separate Settings pages and credential stores. Dictation, file ASR, realtime meetings and MiMo audio review use `asrConnections`; expression cleanup and summaries use named text suppliers. ASR connection tests send audio rather than a text-only prompt.
- Added one-time, non-destructive migration of legacy ASR connections, language connections, active model selections and model catalogs. ASR edits never update text credentials; clearing an ASR key cannot revive a stale shared/profile key. First-run setup also writes only ASR connections, and fast-mode setup does not require a language supplier.
- Reworked text supplier settings using the CC Switch-style preset-first add flow: a searchable preset grid, a dedicated in-app add/edit dialog, editable connection fields, a live request-path preview, and a pinned cancel/save footer. Advanced internal IDs are hidden by default; presets never include keys or fixed model names.
- Kept a searchable saved-supplier list separate from drafts, with selected-model connection tests, independent model synchronization, manual model registration and model-count/last-sync visibility. Cancel and Escape discard drafts only after confirmation; failed saves keep them for retry.
- New suppliers derive a stable internal ID from the full display name, duplicate names are rejected, keys are masked with icon-based visibility/copy controls, and an empty API Key field preserves the existing saved key when editing. Saving unrelated settings never saves an unfinished supplier draft.
- Added per-supplier Bearer/api-key authentication. MiMo presets use api-key for both model discovery and text requests; existing suppliers keep Bearer authentication by default.
- Removed the dedicated experimental OpenCode Go settings entry. Existing OpenCode Go data remains available through the generic supplier migration path without exposing a provider-specific product section.
- Blocked deletion of suppliers still used by cleanup/summary until their selections are changed, and prevented deleted migrated suppliers from being recreated from old settings.

### Tests

- Added provider-role migration, same-brand URL/key isolation, empty-key handling, missing-supplier fallback, audio-only connection-test and responsive split-page browser regression coverage with synthetic credentials and mocked responses.
- Updated the provider UI contract to require generic supplier cards/editor controls and to reject the retired experimental OpenCode Go entry.
- Added draft validation, preset identity, credential retention, request-path, auth-header and dismissed-migration regression tests, plus browser coverage for add/edit/cancel, selected-model tests, failed/successful model sync, deletion protection and responsive dialogs.
- All 52 shared regression scripts passed locally. The source CI matrix passed on Windows x64, macOS Intel x64, macOS Apple Silicon arm64 and Linux; browser interactions and isolated Windows Electron startup were also verified. Native Mac hardware capture, paste and gestures still require device validation.

## v0.4.7 - 2026-09-30

### Added

- Added a shared Windows/macOS Home view with the current dictation hotkey, local today/week input statistics, file/live-meeting entries, and recent records.
- Added optional first-run setup for ASR connectivity, text supplier/model discovery, microphone testing, and independently checked dictation/meeting hotkeys. Existing users retain their configuration and can reopen the guide manually.
- Added atomic local usage persistence with per-recording deduplication. Statistics never store transcripts, audio or credentials.
- Added arbitrary independent text suppliers with Chat Completions or Responses routing and model discovery for cleanup and summaries.

### Changed

- Added draggable, keyboard-accessible reading-height controls for file results, meeting transcripts and meeting summaries, plus a floating transcript/draft splitter.
- Meetings automatically enter one unified floating view after recording starts. The view remembers settled normal bounds, uses compact icon controls and red/yellow/green status lights, and exposes a font slider.
- Shrinking below the small-window threshold shows only current realtime text. Restore and font/opacity controls appear only while the pointer is inside, not from retained keyboard focus. Background opacity supports 0% and returns temporarily to the default 90% on hover without overwriting the saved preference.
- Windows uses an isolated transparent preview for the zero-background small view, with bounded resize controls and no access to credentials or capture APIs. The regular window retains its native resize frame.
- Removed the redundant global connection-test button from the Settings header; provider-specific tests remain available.
- Ali streaming-window rotation now receives the next interval while the old connection awaits final confirmation, preserving ordered final text and explicit failed-window retries.

- Normal app launch and idle tray double-click open Home instead of Settings; active recording windows are brought forward without interrupting capture.
- Redesigned app, file and meeting icons; added macOS template tray assets and a consistent light translucent shell for Home, Settings and onboarding.
- Unified file and live-meeting summary generation with optional MiMo full-audio review, a mindmap and coherent contextual paragraphs. Removed the separate correction action from the current UI while preserving old artifacts.
- Made setup collapsible and transcript/summary reading areas resizable.
- Opening Settings now enumerates microphones without automatically requesting capture permission; permission/device probes remain explicit actions.

### Tests

- Added usage privacy, retry deduplication, concurrent persistence, local week boundaries and onboarding migration tests.
- Added browser coverage for Home navigation, the full guide, narrow/minimum layouts and late microphone cleanup, using synthetic credentials and mocked provider responses.
- Added isolated Windows Electron checks for first launch, Home/Settings navigation and native window constraints without calling providers or touching user configuration.
- Passed all 50 shared regression scripts, browser reading/hover controls, and native Windows zero-background compositing and restore tests. Added simulated streaming coverage across the 20-minute boundary and independent failed-window replay.
- macOS capture, paste, permissions and gestures still require Mac builds and hardware validation; local Windows tests do not establish native macOS compatibility.

## v0.4.6 - 2026-09-20

### Fixed

- Enabled `mimo-v2.5-asr` meeting transcription and post-recording audio review with MiMo Token Plan connections, including `https://token-plan-cn.xiaomimimo.com/v1` and `tp-` keys.
- Removed the obsolete client-side rejection that prevented valid Token Plan requests from reaching MiMo.
- Updated the MiMo settings guidance and meeting documentation to describe regular and Token Plan credentials consistently.

### Tests

- Added request-contract coverage for the Token Plan endpoint, authentication header, model ID, and audio-only payload.
- Added a regression assertion that each meeting ASR request contains only its current audio segment and never previous transcript context.
- Verified the Token Plan route with a real API smoke test, the complete shared test suite, and the release secret scan without storing credentials or provider response bodies.

## v0.4.5 - 2026-09-20

### Added

- Integrated meeting history into the realtime meeting workspace. Previous sessions can be searched and reopened locally, then reviewed with MiMo, corrected, or summarized without starting a new recording.
- Added OpenCode Go as an isolated provider for Stable-mode cleanup and meeting summaries, including model discovery and independent credentials.
- Added capability presets for OpenCode Go and DeepSeek-family models, while retaining editable context-window and output-token values for custom models.

### Changed

- Unified MiMo, Alibaba, OpenAI-compatible, and OpenCode Go connections by provider family so every feature resolves the selected model through the same saved endpoint and credentials.
- Removed the separate legacy meeting-history entry and made the realtime meeting workspace the single home for current and previous sessions.
- Changed Stable-mode short-dictation cleanup from narrow filler deletion to context-aware organization into a clear, coherent paragraph, with local validation and raw-text fallback.
- Improved frameless-window drag and resize behavior, including non-selectable title regions and macOS three-finger window dragging compatibility.

### Fixed

- Prevented meeting cleanup and summary jobs from borrowing an unrelated provider's URL, key, or model settings.
- Hardened history reopening, concurrent post-processing, stale-result handling, and local-only session browsing.

## v0.3.0 - v0.4.4

### Cross-Platform Meeting Realtime Transcription

- Added a macOS native microphone/system audio helper, permission and paste handling, platform-aware hotkeys, and macOS build/CI configuration alongside Windows.
- Added a primary meeting realtime workspace: hotkey start, MiMo ASR by default, independent 30-second Markdown autosave, complete audio archives, persisted retries, and crash recovery.
- Meeting realtime recording never invokes cleanup or speaker diarization. Explicit post-recording cleanup uses a selected model and writes a separate Markdown result.
- Added tests for complete audio tails, stalled ASR, crash replay, note protection, model profile isolation, and cross-platform integration.
- Native macOS recording and paste require Mac hardware validation; Windows automation does not establish macOS runtime compatibility.

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
