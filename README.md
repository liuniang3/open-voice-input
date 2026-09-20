# Open Voice Input

The current development version supports Windows/macOS and a **live meeting** workflow: Alibaba `qwen-audio-3.0-asr-flash-streaming` by default, or `fun-asr-realtime`, with separate provisional and confirmed text. When Alibaba is unavailable, `mimo-v2.5-asr` provides non-realtime segmented transcription as a fallback. Choose microphone, system audio, or both; use a floating window and pause/resume while keeping full local audio. Transcription and Markdown autosave intervals are configured independently. After stopping, optionally review the complete audio with MiMo, reconcile using an independently configured LLM, and separately generate detailed notes with a mindmap. See [meeting behavior, outputs and recovery](docs/MEETING_REALTIME.md).

macOS native capture uses AVAudioEngine for microphone audio and ScreenCaptureKit for system audio (macOS 13+). System-only capture neither opens the microphone nor requests microphone permission; screen/system-audio permission is still required. Accessibility permission applies to automatic paste. Apple Silicon and Intel build jobs are provided, but this update has no macOS hardware-validation claim. `npm run dist:mac` requires a Mac with Xcode Command Line Tools; Windows uses `npm run dist`.

Desktop voice input assistant with pluggable ASR providers and optional LLM text cleanup.

Open Voice Input is an Electron MVP for global dictation and persistent meeting transcription. It is not a Windows IME driver. Short dictation records speech, transcribes it through the selected provider, optionally cleans the raw transcript, and pastes it into the previously focused app. Live meetings keep their own recording state, archives and results.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md)

## Current Release Highlights

- Live meetings default to Alibaba Streaming or Fun-ASR realtime and can switch to segmented non-realtime `mimo-v2.5-asr` when Alibaba is unavailable. Optional MiMo full-audio review, LLM reconciliation, and separate summary/mindmap generation run only after recording stops.
- Meeting capture supports microphone-only, dual-track and genuine system-only modes, with floating/compact views, optional always-on-top, pause/resume, full WAV archives, and independently configurable transcription and Markdown autosave intervals.
- The first stage is now a pluggable ASR layer, tuned most heavily for the dedicated `mimo-v2.5-asr` model and also supporting Qwen3-ASR and Fun-ASR.
- Short-dictation Qwen preview now defaults to `qwen-audio-3.0-asr-flash-streaming`; Fun-ASR also provides WebSocket preview. MiMo uses periodic partial-audio preview, and a failed realtime stream falls back to non-realtime transcription of the complete recording.
- `Stable` mode sends raw ASR text to a MiMo or OpenAI-compatible small model for filler removal, repetition cleanup, and punctuation. `Fast` mode performs ASR only.
- Settings now live in the frameless main UI, with a dedicated Provider Connections tab instead of a separate native Windows settings window.
- MiMo models share one MiMo connection, Qwen/Fun-ASR models share one Alibaba connection, and GPT models share one OpenAI connection. The OpenAI URL may be a custom gateway such as NowCoding and supports either Responses or Chat Completions. Unrelated providers such as Grok or GLM retain independent model connections.
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

For the second-stage text cleanup step, a small chat model is usually enough. GPT-5.4 mini or another low-cost OpenAI-compatible small model is a good fit for removing filler words, merging repeated fragments, and adding punctuation after the raw transcript has already been produced.

## Features

- Global hotkey recording
- Small floating realtime transcript window
- Tray menu for settings
- Configurable microphone, two independent global hotkeys, shared vendor connections, and independent custom-model profiles
- ASR providers: MiMo-V2.5-ASR, Qwen3-ASR, and Fun-ASR
- Cleanup providers: MiMo chat cleanup and OpenAI-compatible chat cleanup
- `Fast` mode: ASR only, lower latency
- `Stable` mode: ASR first, then LLM cleanup for filler words, repeated fragments, and punctuation
- Clipboard paste into the previous focused app
- Provider-aware long-recording segmentation with one final cleanup pass after all ASR segments are joined
- Local cleanup fallback for common filler words, repeated fragments, and prompt-leak style outputs
- **Independent file transcription**: open it from the tray or main UI, import audio/video, choose an ASR model, run raw transcript → correction → structured summary, and export Markdown, TXT, or Word.
- **Meeting workbench media import** (WAV and common audio/video via bundled FFmpeg): stream-copies the source only, extracts the **first audio stream**, builds a local 16 kHz mono archive, and requires an explicit “generate transcript” step. **Basic mode needs no OSS.** Default Qwen no-bucket ASR does **not** invent multi-speaker diarization.
- **Optional enhanced meeting transcription**: workbench “enhanced” mode uploads the system track to private OSS and runs Fun-ASR diarization (32/48/64 kbps); Settings configure Fun/OSS with separate connection tests. See [docs/MEETING_STAGE_4C.md](docs/MEETING_STAGE_4C.md).

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

GPT-5.4 mini is the current overall recommendation. MiMo ASR/cleanup/review models use the single MiMo connection; Qwen and Fun-ASR use the single Alibaba connection; GPT cleanup and analysis models use the single OpenAI connection. The OpenAI connection can point at the official service or a compatible gateway and can use Responses or Chat Completions. Grok, GLM and other unrelated compatible models keep independent URL/key profiles so credentials never cross provider families.

## Short Dictation Modes

`Fast` mode performs ASR only. It has lower latency and is best when the ASR model already produces clean text.

`Stable` mode performs two steps:

1. ASR provider returns raw transcript text.
2. Cleanup provider uses a conservative deletion-span method to remove only clear fillers, stutters, false starts, and accidental duplicates, then adjusts punctuation.

The cleaner is forbidden from paraphrasing, expanding, reordering, or summarizing. A local validator also requires the cleaned content to follow the original character order and retain enough of the source. Invalid JSON, unsafe edits, or cleanup request failures fall back to the raw ASR transcript instead of failing an already successful ASR result.

Each recording uses a settings snapshot captured at recording start, so changing settings while a recording is processing affects only the next recording.

In realtime mode, Qwen defaults to the `qwen-audio-3.0-asr-flash-streaming` WebSocket `run-task` protocol, while Fun-ASR uses its streaming endpoint. MiMo `mimo-v2.5-asr` still refreshes preview through periodic file-style requests. Qwen draft/final revisions are tracked by sentence identity rather than text deduplication; if connection, audio delivery, or final acknowledgement fails, the retained complete recording is transcribed through the non-realtime model. Stable mode then runs the second-stage text cleaner as usual.

## Privacy

The app sends selected-session audio to the configured ASR endpoint, and sends transcript evidence to the selected LLM only for explicit post-recording operations. Optional MiMo review uploads the complete saved recording through bounded requests. Clipboard content is not uploaded automatically. On macOS, ScreenCaptureKit requires screen/system-audio permission; video callbacks are discarded and screen frames are not archived.

API keys saved in settings are stored in Electron's user data folder and are not included in release builds. For public forks, demos, or shared machines, prefer environment variables or a local `.env` file that is not committed.

Runtime logs are written to:

```text
%APPDATA%\open-voice-input\open-voice-input.log
```

## Meeting workbench (current)

The historical workbench remains available alongside the [live meeting workflow](docs/MEETING_REALTIME.md). Native capture supports microphone, system-only and dual-track modes; Windows uses endpoint-mix WASAPI loopback and macOS uses ScreenCaptureKit display-filter audio. Capture details: [docs/MEETING_STAGE_0B.md](docs/MEETING_STAGE_0B.md). Enhanced diarization: [docs/MEETING_STAGE_4C.md](docs/MEETING_STAGE_4C.md).

**Implemented:** L0 capture and session recovery; **basic** transcription (Qwen no-bucket, without OSS; audio still goes to ASR); optional **speaker separation** (system track → private OSS + Fun-ASR); correction/summary; media import (first audio track); export/playback/speaker display names; Settings Fun/OSS fields and connection tests. Live `fun-asr-realtime` does not require this OSS workflow and does not add speaker labels.

**Current limits:**

- **Basic** does not multi-speaker diarize (system side is often `remote_unknown`).
- **Speaker separation** needs Fun-ASR + OSS; only the system track uses Fun; mic stays on Qwen.
- Media import uses the **first audio track** only; not all codecs/long videos are claimed verified.
- **Not done:** AEC, process-level loopback isolation, real multi-hour Tencent Meeting coexistence gate, L1 HQ conversion.
- DRM may silence the system track; capture may include this app’s own audio.

```powershell
npm run build:helper
npm run check:helper
npm run test:meeting
npm run test:meeting:ui
npm run test:meeting:4c
```

## Known Limits

- This is not a real Windows IME driver. It uses clipboard paste and may be blocked or delayed by some target apps.
- Focus restoration and paste behavior can vary by target app, elevated windows, remote desktops, browser security behavior, and Windows input policy.
- Realtime ASR quality depends on microphone choice, network latency, provider behavior, and model version.
- If the ASR step mishears speech, the cleanup step can only clean the mistaken text; it cannot recover unheard content.
- A cleanup model may still confuse meaningful repetition with a stutter or conservatively retain a self-correction. The local repetition regex is disabled, and the minimal-edit prompt plus output validator reduce damage, but text alone cannot resolve every semantic ambiguity.
- In-app updates are available in packaged builds. Windows releases remain unsigned and may trigger SmartScreen. macOS uses separate Intel/Apple Silicon channels. Current unsigned macOS builds download and open the verified ZIP inside the app for manual replacement in `Applications`, without sending the user to GitHub; Developer ID-signed and notarized builds automatically enable restart-and-install.
- Meeting: basic has no multi-speaker split; enhanced needs Fun+OSS; first-track import; no AEC / no multi-hour acceptance claim (see above and docs/MEETING_STAGE_4C.md).

## License

MIT
