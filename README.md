# Open Voice Input

Windows voice input assistant with pluggable ASR providers and optional LLM text cleanup.

Open Voice Input is an Electron MVP for global dictation on Windows. It is not a Windows IME driver. It records speech, transcribes it through a selected ASR provider, optionally cleans the raw transcript with a text model, writes the result to the clipboard, and pastes it into the previously focused app.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md)

## Current Release Highlights

- The first stage is now a pluggable ASR layer, tuned most heavily for the dedicated `mimo-v2.5-asr` model and also supporting Qwen3-ASR and Fun-ASR.
- Qwen3-ASR and Fun-ASR provide WebSocket realtime preview. MiMo uses periodic partial-audio preview, while the final transcript is always regenerated from the complete recording.
- `Stable` mode sends raw ASR text to a MiMo or OpenAI-compatible small model for filler removal, repetition cleanup, and punctuation. `Fast` mode performs ASR only.
- Settings now live in the frameless main UI, organized into General, Speech Recognition, Text Cleanup, and Shared Credentials tabs instead of a separate native Windows settings window.
- Every ASR and cleanup model keeps its own Base URL and API key profile. Switching models restores that profile, including saved custom model IDs.
- API key fields include local show/hide and copy controls. Keys remain in `%APPDATA%\\open-voice-input\\settings.json` and are excluded from builds and Git.
- Recordings are normalized to 16 kHz mono 16-bit PCM WAV. Long recordings are segmented according to the active ASR provider, transcribed and cached early, then joined in order when recording stops.
- An independent file transcription workspace can import audio or video, select its ASR model, generate corrected text and a structured summary, and export Markdown, TXT, or Word.
- Settings, meeting, and file workspaces provide custom minimize, maximize/restore, window dragging, and edge resizing controls.
- Windows x64 installer and single-file portable builds are available, with GitHub Release automation and SHA-256 checksums.
- Release builds exclude `.env` and machine-local settings, and packaging stops if a real-looking API key is detected.

## Recommended Setup

The current project is best adapted to the Xiaomi MiMo V2.5 family. If you are choosing the first-stage speech backend, the recommended option is the dedicated `mimo-v2.5-asr` model. The app also supports Qwen3-ASR and Fun-ASR, but the regular MiMo API endpoint, streamed response parsing, request flow, and local fallback cleanup rules are currently tuned most heavily around MiMo.

For the second-stage text cleanup step, a small chat model is usually enough. GPT-5.4 mini or another low-cost OpenAI-compatible small model is a good fit for removing filler words, merging repeated fragments, and adding punctuation after the raw transcript has already been produced.

## Features

- Global hotkey recording
- Small floating realtime transcript window
- Tray menu for settings
- Configurable microphone, two independent global hotkeys, and per-model API profiles
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

Both builds store machine-local settings in:

```text
%APPDATA%\open-voice-input\settings.json
```

Copying the portable executable to another PC therefore does not copy API keys from the original machine.

### Run From Source

Requirements:

- Windows
- Node.js 20 or newer
- npm

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

Pushing a `v*` tag runs `.github/workflows/release.yml`, builds both Windows executables, generates `SHA256SUMS.txt`, and attaches them to a GitHub Release.

## Usage

1. Start the app.
2. Right-click the tray icon and open `Settings`.
3. Set ASR provider, cleanup provider, per-model credentials, microphone, and hotkeys.
4. Press the global hotkey.
5. Speak while the floating window shows recording or realtime text.
6. Press `Enter` to stop recording.
7. The final transcript is copied to the clipboard and pasted into the previous focused app.

Default short-dictation hotkey: `Ctrl+Alt+M`. Default long-form transcription hotkey: `Ctrl+Alt+Shift+M`; it opens and focuses the meeting workspace. The settings UI rejects app-level duplicates, reserved Windows combinations, malformed accelerators, and combinations already occupied by another application.

## Providers

ASR providers:

- `MiMo`: the official dedicated `mimo-v2.5-asr` model. It uses the regular MiMo API endpoint, supports streamed response parsing, and is currently the best-adapted first-stage speech backend in this project.
- `Qwen3-ASR`: dedicated ASR through DashScope-compatible configuration. Supports batch and realtime modes.
- `Fun-ASR`: dedicated DashScope ASR. Realtime recording uses the WebSocket API. Batch URL transcription uses the REST API when a public audio URL is provided.

Cleanup providers:

- `MiMo`: text cleanup through MiMo chat, with MiMo V2.5 and MiMo V2.5 Pro presets.
- `OpenAI-compatible`: text cleanup through any compatible chat endpoint, with GPT-5.4 mini and Grok 4.5 presets plus a custom model ID option.

GPT-5.4 mini is the current overall recommendation. Selecting a GPT or Grok preset switches to the OpenAI-compatible cleaner; selecting a MiMo preset switches to the MiMo cleaner. Short ASR, cleanup, meeting Qwen, meeting Fun-ASR, and meeting analysis each keep separate profiles per model ID, including custom models, so switching models does not reuse another model's URL or key.

## Transcription Modes

`Fast` mode performs ASR only. It has lower latency and is best when the ASR model already produces clean text.

`Stable` mode performs two steps:

1. ASR provider returns raw transcript text.
2. Cleanup provider uses a conservative deletion-span method to remove only clear fillers, stutters, false starts, and accidental duplicates, then adjusts punctuation.

The cleaner is forbidden from paraphrasing, expanding, reordering, or summarizing. A local validator also requires the cleaned content to follow the original character order and retain enough of the source. Invalid JSON, unsafe edits, or cleanup request failures fall back to the raw ASR transcript instead of failing an already successful ASR result.

Each recording uses a settings snapshot captured at recording start, so changing settings while a recording is processing affects only the next recording.

Realtime text is treated as preview only. Qwen3-ASR and Fun-ASR use provider WebSocket realtime APIs; MiMo `mimo-v2.5-asr` currently uses the official file-style API for periodic partial-audio preview, not true low-latency WebSocket realtime recognition. When you press `Enter`, the app submits the full captured recording again to produce the final transcript; in `Stable` mode, that final transcript still flows into the second-stage cleanup model. This reduces the chance that realtime segmentation, brief pauses, or provider-side provisional punctuation become the final inserted text.

## Privacy

The app uploads only the current recording and optional user-entered short context to the configured provider endpoints. It does not read the screen and does not automatically upload clipboard content.

API keys saved in settings are stored in Electron's user data folder and are not included in release builds. For public forks, demos, or shared machines, prefer environment variables or a local `.env` file that is not committed.

Runtime logs are written to:

```text
%APPDATA%\open-voice-input\open-voice-input.log
```

## Meeting workbench (current)

Dual-track capture (mic + system endpoint-mix loopback) plus post-meeting transcription, analysis, import/export, and workbench UI. Capture details: [docs/MEETING_STAGE_0B.md](docs/MEETING_STAGE_0B.md). Enhanced diarization: [docs/MEETING_STAGE_4C.md](docs/MEETING_STAGE_4C.md).

**Implemented:** dual-track L0 capture and session recovery; **basic** transcript (Qwen no-bucket, zero upload); optional **speaker separation** (system track → private OSS + Fun-ASR); correct/summary; media import (first audio track); export/playback/speaker display names; Settings Fun/OSS fields and connection tests.

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
- Automatic updates and code signing are not configured yet. Unsigned builds may trigger Windows SmartScreen and require manual confirmation.
- Meeting: basic has no multi-speaker split; enhanced needs Fun+OSS; first-track import; no AEC / no multi-hour acceptance claim (see above and docs/MEETING_STAGE_4C.md).

## License

MIT
