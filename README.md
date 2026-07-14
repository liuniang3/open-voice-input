# Open Voice Input

Windows voice input assistant with pluggable ASR providers and optional LLM text cleanup.

Open Voice Input is an Electron MVP for global dictation on Windows. It is not a Windows IME driver. It records speech, transcribes it through a selected ASR provider, optionally cleans the raw transcript with a text model, writes the result to the clipboard, and pastes it into the previously focused app.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md)

## Current Release Highlights

- The first stage is now a pluggable ASR layer, tuned most heavily for the dedicated `mimo-v2.5-asr` model and also supporting Qwen3-ASR and Fun-ASR.
- Qwen3-ASR and Fun-ASR provide WebSocket realtime preview. MiMo uses periodic partial-audio preview, while the final transcript is always regenerated from the complete recording.
- `Stable` mode sends raw ASR text to a MiMo or OpenAI-compatible small model for filler removal, repetition cleanup, and punctuation. `Fast` mode performs ASR only.
- The settings window is reorganized around workflow, input devices, ASR, text cleanup, and shared credentials, with configurable microphone, models, endpoints, and hotkey.
- Windows x64 installer and single-file portable builds are available, with GitHub Release automation and SHA-256 checksums.
- Release builds exclude `.env` and machine-local settings, and packaging stops if a real-looking API key is detected.

## Recommended Setup

The current project is best adapted to the Xiaomi MiMo V2.5 family. If you are choosing the first-stage speech backend, the recommended option is the dedicated `mimo-v2.5-asr` model. The app also supports Qwen3-ASR and Fun-ASR, but the regular MiMo API endpoint, streamed response parsing, request flow, and local fallback cleanup rules are currently tuned most heavily around MiMo.

For the second-stage text cleanup step, a small chat model is usually enough. GPT-5.4 mini or another low-cost OpenAI-compatible small model is a good fit for removing filler words, merging repeated fragments, and adding punctuation after the raw transcript has already been produced.

## Features

- Global hotkey recording
- Small floating realtime transcript window
- Tray menu for settings
- Configurable microphone, hotkey, API keys, base URLs, providers, and models
- ASR providers: MiMo-V2.5-ASR, Qwen3-ASR, and Fun-ASR
- Cleanup providers: MiMo chat cleanup and OpenAI-compatible chat cleanup
- `Fast` mode: ASR only, lower latency
- `Stable` mode: ASR first, then LLM cleanup for filler words, repeated fragments, and punctuation
- Clipboard paste into the previous focused app
- Local cleanup fallback for common filler words, repeated fragments, and prompt-leak style outputs

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

You can configure keys in the settings panel, or provide them with environment variables:

```text
MIMO_API_KEY
MIMO_BASE_URL
DASHSCOPE_API_KEY
QWEN_ASR_API_KEY
FUN_ASR_API_KEY
CLEANER_API_KEY
CLEANER_BASE_URL
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
3. Set ASR provider, cleanup provider, credentials, microphone, and global hotkey.
4. Press the global hotkey.
5. Speak while the floating window shows recording or realtime text.
6. Press `Enter` to stop recording.
7. The final transcript is copied to the clipboard and pasted into the previous focused app.

Default global hotkey: `Ctrl+Alt+M`.

## Providers

ASR providers:

- `MiMo`: the official dedicated `mimo-v2.5-asr` model. It uses the regular MiMo API endpoint, supports streamed response parsing, and is currently the best-adapted first-stage speech backend in this project.
- `Qwen3-ASR`: dedicated ASR through DashScope-compatible configuration. Supports batch and realtime modes.
- `Fun-ASR`: dedicated DashScope ASR. Realtime recording uses the WebSocket API. Batch URL transcription uses the REST API when a public audio URL is provided.

Cleanup providers:

- `MiMo`: text cleanup through MiMo chat.
- `OpenAI-compatible`: text cleanup through any compatible chat endpoint. GPT-5.4 mini or another small model is recommended for this second step.

## Transcription Modes

`Fast` mode performs ASR only. It has lower latency and is best when the ASR model already produces clean text.

`Stable` mode performs two steps:

1. ASR provider returns raw transcript text.
2. Cleanup provider removes filler words, merges repeated fragments, and adds punctuation.

Each recording uses a settings snapshot captured at recording start, so changing settings while a recording is processing affects only the next recording.

Realtime text is treated as preview only. Qwen3-ASR and Fun-ASR use provider WebSocket realtime APIs; MiMo `mimo-v2.5-asr` currently uses the official file-style API for periodic partial-audio preview, not true low-latency WebSocket realtime recognition. When you press `Enter`, the app submits the full captured recording again to produce the final transcript; in `Stable` mode, that final transcript still flows into the second-stage cleanup model. This reduces the chance that realtime segmentation, brief pauses, or provider-side provisional punctuation become the final inserted text.

## Privacy

The app uploads only the current recording and optional user-entered short context to the configured provider endpoints. It does not read the screen and does not automatically upload clipboard content.

API keys saved in settings are stored in Electron's user data folder and are not included in release builds. For public forks, demos, or shared machines, prefer environment variables or a local `.env` file that is not committed.

Runtime logs are written to:

```text
%APPDATA%\open-voice-input\open-voice-input.log
```

## Known Limits

- This is not a real Windows IME driver. It uses clipboard paste and may be blocked or delayed by some target apps.
- Focus restoration and paste behavior can vary by target app, elevated windows, remote desktops, browser security behavior, and Windows input policy.
- Realtime ASR quality depends on microphone choice, network latency, provider behavior, and model version.
- If the ASR step mishears speech, the cleanup step can only clean the mistaken text; it cannot recover unheard content.
- Filler-word and repetition cleanup is partly heuristic. It may miss some fillers or remove words that were intentionally repeated.
- Automatic updates and code signing are not configured yet. Unsigned builds may trigger Windows SmartScreen and require manual confirmation.

## License

MIT
