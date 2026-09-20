# Open Voice Input

The current development version supports Windows/macOS and a **live meeting** workflow: Alibaba `qwen-audio-3.0-asr-flash-streaming` by default, or `fun-asr-realtime`, with separate provisional and confirmed text. When Alibaba is unavailable, `mimo-v2.5-asr` provides non-realtime segmented transcription as a fallback. Choose microphone, system audio, or both; use a floating window and pause/resume while keeping full local audio. Transcription and Markdown autosave intervals are configured independently. After stopping, optionally review the complete audio with MiMo, reconcile using an independently configured LLM, and separately generate detailed notes with a mindmap. See [meeting behavior, outputs and recovery](docs/MEETING_REALTIME.md).

macOS native capture uses AVAudioEngine for microphone audio and ScreenCaptureKit for system audio (macOS 13+). System-only capture neither opens the microphone nor requests microphone permission; screen/system-audio permission is still required. Accessibility permission applies to automatic paste. The frameless main header, short-dictation overlay, and floating meeting header expose native draggable regions compatible with macOS three-finger drag when enabled in System Settings. Apple Silicon and Intel build jobs are provided, but this update has no macOS hardware validation for capture, paste, or trackpad gestures. `npm run dist:mac` requires a Mac with Xcode Command Line Tools; Windows uses `npm run dist`.

Desktop voice input assistant with pluggable ASR providers and optional context-aware LLM rewriting.

Open Voice Input is an Electron MVP for global dictation and persistent meeting transcription. It is not a Windows IME driver. Short dictation records speech, transcribes it through the selected provider, optionally cleans the raw transcript, and pastes it into the previously focused app. Live meetings keep their own recording state, archives and results.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md)

## Current Release Highlights

- Live meetings default to Alibaba Streaming or Fun-ASR realtime and can switch to segmented non-realtime `mimo-v2.5-asr` when Alibaba is unavailable. Optional MiMo full-audio review, LLM reconciliation, and separate summary/mindmap generation run only after recording stops.
- Meeting navigation is unified under Live Meeting. Its searchable History browser reopens prior live sessions for MiMo review, reconciliation, or summary; browsing local history does not automatically call ASR.
- Meeting capture supports microphone-only, dual-track and genuine system-only modes, with floating/compact views, optional always-on-top, pause/resume, full WAV archives, and independently configurable transcription and Markdown autosave intervals.
- The first stage is now a pluggable ASR layer, tuned most heavily for the dedicated `mimo-v2.5-asr` model and also supporting Qwen3-ASR and Fun-ASR.
- Short-dictation Qwen preview now defaults to `qwen-audio-3.0-asr-flash-streaming`; Fun-ASR also provides WebSocket preview. MiMo uses periodic partial-audio preview, and a failed realtime stream falls back to non-realtime transcription of the complete recording.
- `Stable` mode sends raw ASR text to MiMo, OpenAI, an OpenAI-compatible endpoint, or the experimental OpenCode Go provider to turn it into a clear, coherent paragraph while preserving the speaker's intent. `Fast` mode performs ASR only.
- Settings now live in the frameless main UI, with a dedicated Provider Connections tab instead of a separate native Windows settings window.
- MiMo models share one MiMo connection, Qwen/Fun-ASR models share one Alibaba connection, GPT models share one OpenAI connection, and OpenCode Go has an isolated connection and model catalog. The OpenAI URL may be a custom gateway such as NowCoding and supports either Responses or Chat Completions.
- API key fields include local show/hide and copy controls. Keys remain in `%APPDATA%\\open-voice-input\\settings.json` and are excluded from builds and Git.
- Recordings are normalized to 16 kHz mono 16-bit PCM WAV. Long recordings are segmented according to the active ASR provider, transcribed and cached early, then joined in order when recording stops.
- An independent file transcription workspace can import audio or video, select its ASR model, generate corrected text and a structured summary, and export Markdown, TXT, or Word.
- Settings, meeting, and file workspaces provide custom minimize, maximize/restore, window dragging, and edge resizing controls.
- Windows x64 installer and single-file portable builds are available, with GitHub Release automation and SHA-256 checksums.
- Release builds check GitHub Releases and show download progress in-app without opening a browser. Windows and signed macOS builds restart into the installer; unsigned macOS builds open the verified ZIP for manual app replacement. Checks run after startup and every six hours by default and can be disabled in Settings.
- Release builds exclude `.env` and machine-local settings, and packaging stops if a real-looking API key is detected.

## Recommended Setup

For **live meetings**, normally select `qwen-audio-3.0-asr-flash-streaming` or `fun-asr-realtime` and configure the shared Alibaba root URL and key once. The app derives the required compatible, REST and `/api-ws/v1/inference` endpoints from that connection. If Alibaba is unavailable, select `mimo-v2.5-asr` for segmented non-realtime transcription through the shared regular MiMo connection. The reconciliation/summary model uses its own provider family connection.

For **short dictation**, the project is tuned most heavily around the dedicated `mimo-v2.5-asr` model and the regular MiMo API endpoint. Qwen3-ASR and Fun-ASR are also supported. This short-dictation recommendation does not change the live-meeting streaming default.

For the second-stage rewrite step, a small chat model is usually enough. GPT-5.4 mini or another low-cost OpenAI-compatible model can remove disfluencies and organize the raw transcript into a coherent paragraph without changing its intent.

## Features

- Global hotkey recording
- Small floating realtime transcript window
- Tray menu for settings
- Configurable microphone, two independent global hotkeys, shared vendor connections, and independent custom-model profiles
- ASR providers: MiMo-V2.5-ASR, Qwen3-ASR, and Fun-ASR
- Cleanup providers: MiMo, OpenAI-compatible, and experimental OpenCode Go chat cleanup
- `Fast` mode: ASR only, lower latency
- `Stable` mode: ASR first, then context-aware LLM rewriting for clear expression
- Clipboard paste into the previous focused app
- Provider-aware long-recording segmentation with one final cleanup pass after all ASR segments are joined
- Local validation and raw-transcript fallback for unsupported rewrites, prompt leaks, and provider failures
- **Independent file transcription**: open it from the tray or main UI, import audio/video, choose an ASR model, run raw transcript → correction → structured summary, and export Markdown, TXT, or Word.
- **Live meeting history**: search and reopen prior live sessions, including their transcript, full audio, review, reconciliation, and summary outputs. The legacy meeting workbench entry and speaker-diarization settings are currently unavailable.

**Media import limits:** first audio track only; not all codecs/containers are verified; long real-world videos are not claimed tested. The Windows installer/portable build includes **one** FFmpeg binary (~80 MB extra). FFmpeg is **FFmpeg 6.1.1** (gyan.dev essentials GPL build) via build-time `ffmpeg-static@5.3.0` — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [docs/FFMPEG_MEDIA_IMPORT.md](docs/FFMPEG_MEDIA_IMPORT.md).

## Audio Size And Provider Limits

The following segmentation and in-memory caching notes describe **short dictation**. Live meetings persist retry checkpoints and complete native/WAV archives. Optional full-audio review covers the entire recording through bounded requests; provider limits never shorten local audio. The current meeting MiMo review adapter limits each request to 30 seconds and 2 MiB, choosing a quiet boundary where possible.

The client uploads 16 kHz mono 16-bit PCM WAV. Its Base64 representation is approximately 2.6 MB per minute, about one third of a typical 48 kHz recording while retaining the speech bandwidth expected by ASR models.

- MiMo `mimo-v2.5-asr`: the official Base64 string limit is 10 MB. The client prefers a pause boundary after roughly 180 seconds and forces a segment by roughly 210 seconds.
- Qwen3-ASR-Flash: the official limit is 10 MB and 5 minutes per file. Batch mode uses the same conservative segment window; realtime mode continuously streams 16 kHz PCM.
- Fun-ASR: the asynchronous file API supports files up to 2 GB and 12 hours. Local microphone input in this project uses WebSocket streaming and a longer retry segmentation window.

Segment transcripts are cached only in process memory. `Fast` mode joins raw ASR segments directly. `Stable` mode joins every segment first and invokes the cleanup model once, avoiding per-segment rewriting.

Sources: [MiMo-V2.5-ASR Speech Recognition](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition), [Alibaba Cloud non-realtime ASR](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide), and [Alibaba Cloud realtime ASR](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide).

## Install

The recommended option is to download a Windows build from GitHub Releases:

- `Open Voice Input-Setup-<version>-x64.exe`: installer with Start Menu and desktop shortcuts.
- `Open Voice Input-Portable-<version>-x64.exe`: single-file portable build that can be copied to another Windows PC.

Release builds do not require Node.js, npm, or a separate Electron installation. If no usable API key is available on first launch, the settings window opens automatically.

Install version `0.4.0` or newer once from Releases to enable in-app updates. Because unsigned macOS builds through `0.4.3` do not yet have the local-package fallback, Mac users must manually install `0.4.4` once; later updates can be downloaded and opened in-app. Afterwards use `Settings > About & Updates` or the tray `Check for Updates` command. API settings, recordings and transcripts are never sent during update checks.

Both builds store machine-local settings in:

```text
%APPDATA%\open-voice-input\settings.json
```

Copying the portable executable to another PC therefore does not copy API keys from the original machine.

### Run From Source

Requirements:

- Windows, or macOS 13+ (native macOS capture/paste needs hardware validation)
- Node.js 20 or newer
- npm
- For native meeting capture: Rust 1.85.1 and MSVC C++ Build Tools on Windows, or Xcode Command Line Tools on macOS; run `npm run build:helper` and `npm run check:helper`.

Install dependencies:

```powershell
npm install
```

Optional environment setup:

```powershell
Copy-Item .env.example .env
```

For the desktop app, configure each model in its own profile. Provider-scoped environment variables remain available as fallbacks for empty Qwen, Fun-ASR, cleaner, and meeting profiles; a saved model profile takes precedence:

```text
DASHSCOPE_API_KEY
QWEN_ASR_API_KEY
FUN_ASR_API_KEY
CLEANER_API_KEY
CLEANER_BASE_URL
OVI_MEETING_QWEN_API_KEY
OVI_MEETING_FUN_ASR_API_KEY
OVI_MEETING_ANALYSIS_API_KEY
```

## Run

For a release build, launch the installed shortcut or the portable `.exe` directly.

When running from source, double-click without a console window:

```text
Start Open Voice Input.vbs
```

Double-click with a debug console:

```text
Start Open Voice Input.cmd
```

Command line:

```powershell
npm start
```

## Build Distributables

Build both the installer and portable executable:

```powershell
npm install
npm run dist
```

Artifacts are written to `dist/`. The build runs tests and a real-looking API key scan first. `.env` files, logs, recordings, and user settings are not included.

Pushing a `v*` tag runs `.github/workflows/release.yml`, builds Windows and macOS artifacts, generates `SHA256SUMS.txt`, and uploads the updater channel metadata and blockmaps required by `electron-updater`.

## Short Dictation Usage

1. Start the app.
2. Right-click the tray icon and open `Settings`.
3. Set ASR provider, cleanup provider, per-model credentials, microphone, and hotkeys.
4. Press the global hotkey.
5. Speak while the floating window shows recording or realtime text.
6. Press `Enter` to stop recording.
7. The final transcript is copied to the clipboard and pasted into the previous focused app.

Default short-dictation hotkey: `Ctrl+Alt+M`. Default long-form transcription hotkey: `Ctrl+Alt+Shift+M`; it opens and focuses the meeting workspace. The settings UI rejects app-level duplicates, reserved Windows combinations, malformed accelerators, and combinations already occupied by another application.

## Live Meeting Workflow

1. Configure the selected Alibaba streaming model, or configure `mimo-v2.5-asr` as a fallback, then open the meeting workspace and choose the audio source, Markdown destination, transcription interval and autosave interval.
2. Start recording. Alibaba mode shows revisable provisional text and ordered confirmed sentences; MiMo mode submits non-realtime segments at the selected interval. Markdown saves on its independent interval without waiting for ASR responses, and each selected track retains its complete audio.
3. Switch to the floating or compact view, optionally pin it on top, and return to the detailed view as needed. Pause/resume controls the same session; paused source frames are not saved as recorded speech. Pause markers remain in the native journal, and the session can be stopped while paused.
4. Stop and wait for audio finalization and completion of streaming or segmented tasks. Retry any reported transcription gaps from the retained archive. Stopping does not automatically invoke post-recording review or an LLM.
5. Optionally enable **MiMo audio review**, select its ASR profile, and run **reconciliation** with a separately selected LLM. Review covers the full saved audio in bounded segments. Without review, the LLM reconciles the live transcript alone. Meaningful repetition and unresolved disagreements must remain visible; originals are retained.
6. Separately run **Generate summary** for detailed notes and a hierarchical mindmap. It uses the completed reconciliation when available, otherwise the original transcript; reconciliation does not automatically generate a summary.

Outputs remain separate: original `.md`, optional `.reviewed.md`, reconciled `.cleaned.md`, and `.summary.md` with notes and a mindmap. Existing derived files are preserved by choosing another filename; use the actual paths shown in the app. Native PCM, full WAV files and retry checkpoints stay in the session directory. See [the full workflow](docs/MEETING_REALTIME.md) for recovery and permission details.

## Providers

ASR providers:

- `MiMo`: the official dedicated `mimo-v2.5-asr` model. It uses the regular MiMo API endpoint, supports streamed response parsing, and is currently the best-adapted first-stage speech backend in this project.
- `Qwen3-ASR`: dedicated ASR through DashScope-compatible configuration. Supports batch and realtime modes.
- `Fun-ASR`: dedicated DashScope ASR. Realtime recording uses the WebSocket API. Batch URL transcription uses the REST API when a public audio URL is provided.

Cleanup providers:

- `MiMo`: text cleanup through MiMo chat, with MiMo V2.5 and MiMo V2.5 Pro presets.
- `OpenAI-compatible`: text cleanup through any compatible chat endpoint, with GPT-5.4 mini and Grok 4.5 presets plus a custom model ID option.
- `OpenCode Go (experimental)`: an isolated Chat Completions connection at `https://opencode.ai/zen/go/v1`, with automatic model retrieval. It can be selected for Stable-mode cleanup and for meeting correction/summary. Requests include the required dedicated user agent and a stable session ID for each meeting analysis run.

GPT-5.4 mini is the current overall recommendation. MiMo ASR/cleanup/review models use the single MiMo connection; Qwen and Fun-ASR use the single Alibaba connection; GPT cleanup and analysis models use the single OpenAI connection. OpenCode Go credentials and its fetched model list never cross into those families, including when it exposes a model ID such as `mimo-v2.5` or `glm-5.2`. OpenCode Go officially targets coding-agent traffic, so non-code cleanup and meeting-summary requests may be rate-limited or rejected; the app keeps raw text and retry data when that happens.

## Short Dictation Modes

`Fast` mode performs ASR only. It has lower latency and is best when the ASR model already produces clean text.

`Stable` mode performs two steps:

1. ASR provider returns raw transcript text.
2. The rewrite model interprets the current transcript, removes fillers, stutters, false starts and accidental duplicates, and may improve punctuation, sentence order and phrasing to produce one coherent paragraph.

The model may paraphrase spoken language without reproducing every word, but it must preserve every substantive intention and must not add facts, answer a dictated question, or explain its work. A local validator checks source grounding, excessive deletion or expansion, numbers and technical identifiers, meta-responses, and strict JSON formatting. Invalid or unsafe results fall back to the raw ASR transcript instead of failing an already successful ASR result.

Each recording uses a settings snapshot captured at recording start, so changing settings while a recording is processing affects only the next recording.

In realtime mode, Qwen defaults to the `qwen-audio-3.0-asr-flash-streaming` WebSocket `run-task` protocol, while Fun-ASR uses its streaming endpoint. MiMo `mimo-v2.5-asr` still refreshes preview through periodic file-style requests. Qwen draft/final revisions are tracked by sentence identity rather than text deduplication; if connection, audio delivery, or final acknowledgement fails, the retained complete recording is transcribed through the non-realtime model. Stable mode then runs the second-stage text cleaner as usual.

## Privacy

The app sends selected-session audio to the configured ASR endpoint, and sends transcript evidence to the selected LLM only for explicit post-recording operations. Optional MiMo review uploads the complete saved recording through bounded requests. Clipboard content is not uploaded automatically. On macOS, ScreenCaptureKit requires screen/system-audio permission; video callbacks are discarded and screen frames are not archived.

API keys saved in settings are stored in Electron's user data folder and are not included in release builds. For public forks, demos, or shared machines, prefer environment variables or a local `.env` file that is not committed.

Runtime logs are written to:

```text
%APPDATA%\open-voice-input\open-voice-input.log
```

## Live meeting workflow (current)

Meeting features now share the [live meeting workflow](docs/MEETING_REALTIME.md). Native capture supports microphone, system-only and dual-track modes; Windows uses endpoint-mix WASAPI loopback and macOS uses ScreenCaptureKit display-filter audio. The live page includes searchable local history for reopening transcripts, full audio, and derived outputs. The former Meeting History/Workbench entry is no longer exposed.

**Implemented:** cross-platform native capture; Alibaba realtime or MiMo segmented transcription; complete audio, Markdown autosave, and retry checkpoints; local history browsing; explicit MiMo full-audio review, LLM reconciliation, structured summary, and mindmap generation. Opening history never reruns ASR automatically.

**Current limits:**

- Speaker diarization and speaker labels are currently not exposed; dual track distinguishes only microphone and system-audio sources.
- Media import belongs to the independent File Transcription workspace. It uses the **first audio track** only; not all codecs/long videos are claimed verified.
- **Not done:** AEC, process-level loopback isolation, real multi-hour Tencent Meeting coexistence gate, L1 HQ conversion.
- DRM may silence the system track; capture may include this app’s own audio.

```powershell
npm run build:helper
npm run check:helper
npm run test:meeting:live
npm run test:meeting:live:ui
npm run test:all
```

## Known Limits

- This is not a real Windows IME driver. It uses clipboard paste and may be blocked or delayed by some target apps.
- Focus restoration and paste behavior can vary by target app, elevated windows, remote desktops, browser security behavior, and Windows input policy.
- Realtime ASR quality depends on microphone choice, network latency, provider behavior, and model version.
- If the ASR step mishears speech, the rewrite step can only organize the mistaken text; it cannot recover unheard content.
- A rewrite model may still misunderstand references, ambiguity, or deliberate repetition. The local repetition regex is disabled, and the semantic-rewrite prompt plus output validator constrain omissions and unsupported expansion, but text alone cannot resolve every ambiguity.
- In-app updates are available in packaged builds. Windows releases remain unsigned and may trigger SmartScreen. macOS uses separate Intel/Apple Silicon channels. Current unsigned macOS builds download and open the verified ZIP inside the app for manual replacement in `Applications`, without sending the user to GitHub; Developer ID-signed and notarized builds automatically enable restart-and-install.
- Meeting: basic has no multi-speaker split; enhanced needs Fun+OSS; first-track import; no AEC / no multi-hour acceptance claim (see above and docs/MEETING_STAGE_4C.md).

## License

MIT
