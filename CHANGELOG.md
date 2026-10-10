# Changelog

All notable changes to this project are documented here.

## Unreleased

### Fixed

- Dedicated Qwen and MiMo ASR omit the arbitrary 2048-token output cap and language-model sampling parameters. Ordinary cleanup/summary budgets remain unchanged. Require a normal completion marker and reject truncated or interrupted ASR output before publishing it.
- File ASR prefers pauses near the 180-second target and enforces actual encoded-size budgets before upload. Qwen's documented five-minute limit is distinct from the app's 210-second / 9 MB Base64 safety budget; MiMo has an independent policy without assuming an undocumented duration/output maximum.
- On explicit output truncation or an oversized legacy upload, split only the affected audio range into shorter requests. Persist the child plan before sending, reuse successful checkpoints after cancellation/restart and preserve exact audio coverage, ordered text and the complete original recording.
- Display completed file-transcription ranges while remaining requests run or fail. Show missing ranges, preserve reading position, refresh when returning from the summary view and label partial Markdown/text/Word/JSON exports. Incomplete or stale original transcripts cannot be used as complete summary sources.
- Live Alibaba transcription now prefers a sustained 300ms quiet boundary in the last 30 seconds of each ten-minute connection window. Release unsent read-ahead to the next connection without replaying or skipping PCM; continuous speech still rotates at the hard limit. Existing failed-window replay retains its exact saved boundaries.
- Live MiMo fallback transcription searches for a 200ms pause near each configured interval boundary without extending the interval. Explicit output truncation persists a bounded, recursive child-range plan before retrying shorter requests; completed siblings survive failures, cancellation and restart. Raw text remains chronological even when task IDs change, and truncated partial output is never published as complete.

### Validation

- Regression coverage uses synthetic audio and simulated provider responses for pause boundaries, exact frame coverage, encoded-size limits, truncation recovery, cancellation, checkpoint reuse, legacy plans, partial exports and view updates. No real user recordings or provider credentials are included.
- Live-meeting regressions cover pause detection across scheduler kicks, read-ahead handoff, waiting final receipts, the default 9m30s rotation threshold, restart coverage, durable child plans, minimum split limits, ordered source IDs and late-arriving audio invalidation.
- Shared local regression suite passed: `68/68` scripts, including `32` live-preview cases and `28` live-meeting service cases. Native macOS recording, permissions and paste still require hardware validation.

## v0.4.19 - 2026-10-10

### Changed

- File transcription and live meetings now have independent, collapsible history and vertical transcription-model settings sidebars. Collapse arrows point left; drag the sidebar edge to resize or adjust it with the keyboard. Remember widths and visibility locally, while reserving usable space for the results. Narrow windows use one dismissible drawer at a time; floating meetings hide both sidebars.
- Rename file settings to transcription-model settings. Expand model settings on workspace entry or model selection when local ASR credentials, endpoint or model compatibility checks fail. Show a specific configuration hint without network requests or exposing credentials; routine status updates respect manual collapse.
- Place live-meeting history and model-sidebar controls at the left edge of the main header, next to the sidebars they control; omit the duplicate meeting title in the detailed workspace. Keep the session title and window controls in the floating view.
- Group file transcription and summary actions into a compact horizontal toolbar on wide workspaces, with a subtle separator and adjacent status, labelled model selection, MiMo review and action. Hide unavailable retry/cancel controls and the completed transcription's disabled start button; stack complete workflow groups in narrow reading areas without spreading controls across empty space.
- Make file-workspace status feedback more visible with a full-width tinted strip, stronger text and an information/loading icon. Distinguish processing, success, warning and failure; wrap long messages and honor reduced motion.
- New file imports default to their own filename instead of inheriting a selected history record's title. Keep optional import titles separate from history readback, consume each title after import acceptance and preserve the draft when selection is cancelled or fails.
- File and live-meeting transcript/summary panes grow and shrink with the workspace window. Remove independent height handles and ignore old saved pixel heights; long content scrolls inside the reading area. Preserve the floating meeting's draft/history split control.
- Move live-meeting setup and save options into the vertical model sidebar. Keep the floating-window entry to the left above the transcript and Markdown opening beside refresh/retry. Name complete microphone and system recordings by their source instead of audio numbers.

### Verification

- Shared local regression suite passed: `67/67` scripts. Browser checks cover Windows/macOS interface styles, sidebar persistence, history selection, narrow drawers, adaptive reading and summaries continuing through navigation.
- Secret scan and diff checks passed. Release CI builds and tests Windows x64, macOS Intel x64 and Apple Silicon arm64. Native macOS capture, permissions, paste and appearance still require hardware validation.

## v0.4.18 - 2026-10-08

### Changed

- Unconfigured first-run onboarding selects Qwen / Qwen3-ASR Flash with realtime previews and the matching Aliyun API console. Existing configured MiMo/Qwen suppliers, custom model IDs, URLs, credentials and explicitly saved batch preferences remain unchanged; opening setup alone does not modify saved settings.
- File transcription and live meetings default to a shared "Follow dictation" selection instead of unrelated hard-coded models. Changing dictation ASR updates the derived model; streaming and file endpoints use the appropriate companion within that supplier. Explicit workspace model selections remain independent, and users can switch back to following dictation. ASR credentials remain isolated from language suppliers.

### Fixed

- First-run onboarding now offers the existing language supplier presets, an explicit add/save action and authentication selection. It reuses the settings editor's supplier validation, keeps saved credentials isolated, and adds manually entered cleanup models to that supplier's catalog. Errors remain visible above the navigation controls instead of falling below the form's scroll area.
- Focused workspace windows handle their configured shortcuts through a shared Windows/macOS key-matching fallback. Shortcut capture, active recording and startup guards prevent stale shortcuts and duplicate recording starts; leaving shortcut settings ends the keyboard capture session.
- Fresh installations default to realtime dictation previews. Onboarding saves the chosen mode in both the active settings and model profile, keeps MiMo polling available, and selects the Qwen streaming companion without using a streaming model as the batch fallback. Existing explicitly saved batch preferences remain unchanged.

### Verification

- Shared local regression suite passed: `66/66` scripts. Browser onboarding/live-workspace checks and isolated native Windows Electron checks cover supplier persistence, Qwen defaults, model following, dictation previews, complete paste payloads and responsive layouts.
- Release workflows build and test Windows x64, macOS Intel x64 and Apple Silicon arm64. Native macOS recording, permissions, paste and appearance still require hardware validation.
- Secret scan and diff checks passed. No user credentials, local settings, recordings, transcripts or diagnostic screenshots are included.

## v0.4.17 - 2026-10-08

### Changed

- Dictation uses a compact fixed 340-by-116 floating window throughout recording and processing, with tighter padding, 12-pixel preview text, 18-pixel surface corners and a borderless 80%-opacity white tint for stronger text readability. Only the background tint changes; text stays fully opaque and corner cutouts stay clear. Windows uses an isolated per-pixel transparent display with native background materials disabled, preserving underlying details and fully transparent corner cutouts even when inactive; this is translucency, not native desktop blur. The workspace's native resize hit-testing remains unchanged, and recording, ASR, cleanup and paste stay in the existing trusted renderer. macOS keeps recording-only, active vibrancy and restores the normal workspace material on exit. Realtime previews omit the redundant title and scroll inside their pane without a visible scrollbar, following the newest text unless the user scrolls up to read earlier content. Returning to the bottom resumes follow mode; Qwen streaming and MiMo polling share this presentation without truncating the stored or pasted transcript.

### Fixed

- Mirrored dictation spectrum samples use an independent 32-millisecond timer instead of relying on animation frames from the hidden recording page. Frequency changes and silence continue reaching the visible popup even if the recorder's compositor stops issuing frames. A 240-millisecond stale-frame reset prevents disconnected delivery from leaving frozen bars; late frames cannot revive the spectrum during text processing. Stop, cancel and Reduce Motion clear visual timers without changing PCM capture or ASR uploads.
- Dictation's Windows display no longer uses the experimental native accent/Acrylic backdrop, which could obscure underlying content and paint square corner remnants outside the CSS radius. Only the rounded surface has a translucent white fill; all four corner cutouts stay clear. The display has no surface border, inset white highlight, white text shadow or white indicator halo. Preview panes use complete line heights so automatic tail scrolling does not leave clipped fragments of the preceding line above the text.
- The isolated dictation display is created only when needed, exposes no settings or credential API, forwards Enter/Escape/cancel to the existing recorder, and falls back to the existing recording window if its renderer fails. Showing dictation no longer launches a native background-effect helper or waits for a PowerShell material operation.
- Dictation's recording indicator centers on the first text line using that state's line height, including title-free realtime previews and processing/status titles. Its pulse animation no longer relies on a fixed top offset for alignment.
- Dictation cleanup rejects provider-truncated responses and newly introduced trailing ellipses instead of pasting incomplete text. Failed validation retains the complete ASR transcript; model output budgets and the disabled regex duplicate-removal policy are unchanged.
- Dictation cleanup prompts now use a positive completeness instruction: process the transcript from the first sentence through the final sentence, explicitly preserve the ending, and verify full coverage before returning JSON. Defensive validation and complete-ASR fallback remain in place.
- File-transcription paragraphs and file/live-meeting summary prose now use their reading pane's available width instead of inheriting the global 360-pixel hint-text limit. Preserve original line breaks and wrap long words without changing transcript content, timestamp layout or short status hints.

### Added

- Dictation recording uses a subdued, microphone-driven frequency spectrum in the floating window background instead of the old level progress bar. The cancel action uses a quiet icon button and the keyboard hint reads Enter Input / Esc Cancel. Visual processing is isolated from PCM recording and ASR uploads, stops on completion/cancellation and honors Reduce Motion.
- Subtle shared desktop motion: native window fade-in/fade-out, short dictation entrance, workspace transitions and settings-content fades. Title-bar drag regions, resize geometry and recording start are not delayed by page animations.
- Follow the system Reduce Motion preference, including live preference changes. Window fade cancellation prevents a delayed hide from closing a reopened window, and stale focus retries cannot reactivate a dismissed window.
- Dictation paste waits for fade-out and the existing focus-settling delay concurrently; animation does not add a separate paste delay.

### Verification

- Shared regression suite: `64/64` scripts passed locally, including isolated dictation-display security and lifecycle, fixed dictation-window geometry and scrolling, dictation-completeness validation, microphone-spectrum lifecycle, scoped reading-width contracts, Windows/macOS motion-controller and background-summary navigation tests.
- Spectrum browser checks cover actual Web Audio frequency response, canvas pixels and Windows/macOS layouts at 320/340/420 pixels. Hidden-producer regressions cover timer-only sampling, frequency changes, silent decay, stale-frame reset, repeated visibility/resize events and disposal. Actual Windows app tests deliberately suspend the recorder's animation frames, change a synthetic microphone's frequency, mute it and restore it, confirming the popup continues to update. Synthetic-microphone integration also covers batch/realtime Fast/Stable recording, complete Enter paste-interface payloads and Escape resource cleanup without accessing real microphones or APIs.
- Cleanup completeness tests cover generated trailing ellipses, provider output-limit metadata, Chat/Responses protocols and full-text fallback. Existing source ellipses, normal repeated words and user-configured output budgets remain supported.
- Fixed-window browser tests cover Windows/macOS styles, borderless surfaces without white glyph shadows, first-line indicator alignment, long/revised/empty previews, exact text retention, manual scroll and resumed tail following, plus Qwen and MiMo preview paths. Native Windows desktop-composition checks now verify all four corner cutouts against the actual underlying pixels, retained contrast and small underlying details in focused, genuinely unfocused, reopened and fading states. These checks would reject the old rectangular accent material, even if its center passed a color-transmission check. The actual application also records synthetic microphone PCM and forwards its spectrum while its main window is hidden; Stable-mode Enter retains the full paste payload, Escape cancels without paste, and returning Home restores the ordinary resizable window. Diagnostic crops contain only the synthetic fixture; macOS native compositing still requires hardware verification.
- Reading-width browser checks passed at 720/1040/1440 pixels with Windows and macOS styles, preserving raw text and explicit paragraphs while wrapping long identifiers and using the complete transcript/summary pane width.
- Browser motion, homepage, settings and responsive-window tests passed. Native Windows Electron checks cover interrupted fades, focus, opacity restoration and system Reduce Motion preferences; macOS native appearance still needs a build and hardware check.


## v0.4.16 - 2026-10-07

### Changed

- Home file-transcription and live-meeting entries are now full-card buttons with mouse and keyboard activation. They open their workspaces only; Home no longer triggers the file picker or starts a recording.
- Expression Organization settings recommend Flash/fast models to reduce dictation cleanup latency. The guidance is accessible from the model picker and does not change the selected model or its configuration.

### Verification

- Shared regression suite passed locally: `58/58` scripts. Homepage/settings browser checks passed, covering card navigation, keyboard activation, model recommendations and responsive layouts.
- Windows Electron navigation checks use isolated test settings and confirm that Home navigation does not open the file picker or start recording.
- Secret scan and `git diff --check` passed before publication; no user credentials, settings, recordings, transcripts or diagnostic screenshots are committed.
- Windows and Intel/Apple Silicon macOS CI build the same shared UI. Native macOS recording, permissions and paste behavior still require hardware verification.


## v0.4.15 - 2026-10-07

### Added

- Speech-recognition supplier selectors in Settings and first-run setup now show MiMo and Qwen only. Fun-ASR remains an Aliyun model/transport, and existing Fun model choices, connection URLs and keys are preserved rather than silently changed to the Qwen protocol.
- Added a supplier-aware API console shortcut in Settings and first-run setup. Only fixed official MiMo/API Key and Aliyun Bailian/API Key destinations can open in the system browser; the IPC validates local app senders and never accepts a custom URL or sends saved credentials.
- Home recent records are split into independent meeting/file transcription and voice-input groups, with a side-by-side desktop layout and stacked groups in narrow windows. Voice entries show a local text preview, timestamp and organization status, and open the exact history entry; the group also links to all voice-input history.
- Home refreshes when voice history changes, coalescing updates received during an in-flight refresh. History read failures remain isolated from meeting/file records, and viewing history never starts transcription or changes usage counts.

### Changed

- The speech-recognition model picker now recommends Qwen3-ASR Flash instead of MiMo V2.5 ASR. This label change preserves existing model selections, credentials and realtime-preview settings.

## v0.4.14 - 2026-10-06

### Changed

- Expression Organization settings now show the selected dictation supplier/model and a compact supplier overview. Connection details, model discovery, testing and per-model capabilities live in an in-app supplier management subpage with Back/Escape navigation.
- Model capability settings are collapsed by default. The shared Windows/macOS layout adapts to narrow windows without expanding the expression settings overview into a full supplier editor.
- Removed duplicate meeting/file summary model selectors and capability fields from Expression Organization. Summary models remain selectable within each workspace, and saving dictation settings preserves existing summary selections, credentials and capabilities.

### Verification

- Shared regression tests, browser settings tests, supplier-management tests and window-layout tests pass locally.
- Secret scan and `git diff --check` pass.
- Known limitation: the Windows native edge-resize cursor probe is still not fully passing on all sampled edges; native resize behavior was not expanded in this release.

## v0.4.13 - 2026-10-06

### Fixed

- Stabilized the managed-stream cancellation regression test on slower Windows CI runners by waiting until the simulated provider request is active before asserting abort propagation. This keeps the release gate meaningful without weakening cancellation coverage.

### Release Notes

- This patch release supersedes `v0.4.12` with the same settings and local voice-history feature set, plus a complete cross-platform release build.

## v0.4.12 - 2026-10-06

### Added

- Local short-dictation history with searchable original/organized text, timestamps, model labels and copy actions. Recording retries update the same entry; realtime previews, individual upload chunks, cancelled recordings and history copies do not create extra records or inflate usage statistics. Saving new records can be disabled without losing existing history.
- About & Updates shows the detected release's notes in-app, retaining them through download progress. Release HTML is converted to inert plain text, never embedded as active markup.

### Changed

- Settings use four vertical navigation items: Speech Recognition, Expression Organization, Speech History, and About & Updates. Recording mode, microphone, shortcuts, ASR connection and model settings now share one page. Language supplier management and both expression/summary model selections share the organization page.
- Keep ASR and language credentials isolated, preserve existing settings and translate old settings deep links to the new pages. A missing organization model no longer prevents configuring ASR first. Update-check preferences save directly on the updates page.
- Shared Windows/macOS UI includes responsive sidebar layouts and keyboard tab navigation. Local history persistence errors never stop dictation, and stored history never becomes model context.

## v0.4.11 - 2026-10-06

### Fixed

- Dictation recording snapshots now include the selected language supplier, model catalog capabilities, migration state and canonical ASR/provider connections. Realtime completion, batch transcription and retries no longer fall back to stale legacy MiMo endpoints when an OpenCode Go or other named supplier is selected.
- Deep-copy nested routing settings at recording start so subsequent supplier/model edits cannot change an in-flight dictation or its retry. Unrelated meeting paths and OSS settings are excluded from the snapshot.
- Retain the selected supplier model's configured maximum output for dictation expression cleanup; no fixed 2048-token override is imposed on the named-supplier route.
- Supplier name checks use the same visible names as the settings list, preventing legacy migrated OpenCode Go entries from blocking a new visible OpenCode Go supplier.
- Reject additional explanation-style cleanup responses without inserting model commentary into the dictated text.

### Tests

- Added browser-export and actual renderer snapshot tests, including Chat Completions/Responses routing, stale MiMo endpoint isolation, recording/retry immutability and model-specific output budgets.
- Live cleanup checks through the same recording snapshot and production pipeline succeeded with an existing local OpenCode Go connection using `mimo-v2.6-flash` and `deepseek-v4.1-flash`. No keys, local settings, transcripts or provider response bodies are stored in the repository.

## v0.4.10 - 2026-10-04

### Added

- Added model capability presets for common MiMo, GLM, Grok, GPT, Gemini, Claude, Qwen, DeepSeek and Kimi model families.
- Added automatic text-supplier model discovery through the supplier's `/models` endpoint after a new API key is saved.
- Added editable per-model context length, maximum output and timeout capabilities, with conservative defaults for unknown models.

### Changed

- Model catalog capabilities now take precedence over built-in presets, while manually edited model capabilities remain stable across catalog refreshes.
- Removed the visible standalone Meeting settings tab and moved meeting/file summary model selection into the shared expression and summary settings area.
- Summary planning now uses the selected model's actual context and output capabilities, preferring whole-input processing and using hierarchical compression only when the input exceeds the calculated budget.
- Improved voice-expression cleanup handling for strict JSON, Markdown-wrapped JSON, explanatory prefixes and extra response fields.

### Fixed

- Voice-expression cleanup now rejects explanatory, list-like or likely-expanding model responses and safely falls back to the original transcription when the result cannot be validated.
- Relaxed overly strict grounding checks for natural Chinese rewrites so valid contextual cleanup is not discarded unnecessarily.

### Tests

- Shared regression coverage passed locally, including model capability presets, supplier model discovery, manual capability overrides, summary budgeting and voice-expression cleanup.
- Secret scanning passed with no API keys, local settings, user audio, transcripts or provider response bodies included in the repository.
- The existing browser-level checks remain dependent on the local Playwright installation; the non-browser regression suite passed.

## v0.4.9 - 2026-10-03

### Changed

- File and live-meeting summary generation continues in the main process when switching to Home, Settings or another workspace. Background progress and final results stay synchronized without reopening the source page or stealing focus; returning to it restores the latest state without starting another request.
- File and live-meeting summaries now generate a single evidence-grounded article alongside the existing hierarchical mindmap. The right pane presents connected prose instead of minutes sections, bullet items and inline source quotations. Provenance remains stored and visible in the mindmap; old summaries retain their legacy rendering. A new summary fingerprint prevents reusing prior minutes as a newly generated article.
- Added an OpenCode Go preset to the general language-supplier add flow. It pre-fills the official URL/protocol/authentication, accepts a key, and attempts model discovery after saving; failed discovery keeps the saved connection.
- Supplier deletion now uses an in-app confirmation showing affected cleanup/summary selections and clears only those selections. Unrelated suppliers and generated content remain intact, and deleted migrated entries stay dismissed.
- File and live-meeting summaries now request incremental Chat Completions or Responses streams. Active generation is no longer stopped by a fixed overall deadline; model-specific connection limits, network inactivity checks and visible waiting states remain.
- Transient network errors, early EOF, rate limits and explicit temporary server failures receive up to five cancellable retries after the initial attempt, with exponential backoff, jitter and provider retry-delay hints. Every retry uses a fresh output buffer; compatible requests restart generation rather than resume a remote task.
- Summary planning uses the selected supplier/model's context and output capabilities, counting instructions, serialized source metadata and output reservations. Whole-input requests are preferred; bounded hierarchical compression is used only when the input exceeds the estimated budget. Unknown models keep a 128k-context/8192-output fallback instead of assuming every gateway provides a 250k context.
- Completed paid tasks remain reusable when transport timeouts change. Compatible legacy cache layouts are adopted through a durable alias; changed models, reasoning, source content or planning budgets still produce separate generations.

### Fixed

- Existing generic entries for the official OpenCode Go endpoint now get the app's own User-Agent and per-conversation session header without replacing their saved key or adding Go headers to other URLs.
- Propagate model-specific timeouts into supplier routing and avoid an additional fixed timeout around transport-managed summary requests.
- Reject unfinished JSON/SSE, output-limit responses and malformed results instead of saving partial content as a completed summary. Structured error classifications never expose provider bodies or credentials.
- Preserve legacy MiMo api-key authentication and custom endpoints for streamed summaries, including Token Plan routes. Malformed JSON fallback responses are sanitized without exposing the provider payload.
- Show connection, thinking, received-character, waiting and retry states in file/live-meeting views. Add live-summary cancellation with session validation, immediate UI updates and protection against late responses. Original transcripts and full audio remain unchanged.

### Tests

- Added background-summary lifecycle and navigation regressions for file/live views, including Windows/macOS IPC harnesses, late start/status responses, per-file result isolation, explicit cancellation and listener disposal. Real-browser mock tests cover generation, Settings/Home navigation, off-screen completion and reopening with one start and no cancellation. New file summaries can start from the engine's idle state.
- Added offline streaming, completion, retry, cancellation, model-budget and durable-cache tests, plus live service/IPC/UI integration coverage. Updated browser checks for progress and cancellation.
- These changes use shared Windows/macOS services and UI and are included in the existing desktop CI matrix. Local tests do not establish macOS native or real-provider verification; no paid API requests are required by these regression tests.
- Local validation passed all 55 shared regression scripts, the package secret scan and responsive browser checks. Streaming regression cases include legacy MiMo authentication and sanitized JSON fallbacks.
- OpenCode Go preset, automatic model discovery, active-supplier deletion/cancellation and narrow-window confirmation were checked in browser fixtures; an existing locally configured Go connection passed a minimal live `deepseek-v4.1-flash` check without exposing credentials or response content.
- The new article summary was exercised against a configured official OpenCode Go endpoint with a short synthetic transcript; the completed result contained prose, mindmap and verified provenance. This is a smoke test, not a quality evaluation of long recordings or macOS native capture.

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
