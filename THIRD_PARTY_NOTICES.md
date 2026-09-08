# Third-Party Notices

## ffmpeg-static / FFmpeg binary

- **npm package (build-time only):** [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static) **5.3.0** (listed under `devDependencies`; not shipped inside `app.asar`)
- **Shipped binary path:** `resources/native/ffmpeg.exe` (copied at build via `npm run prepare:ffmpeg` → `native/ffmpeg/ffmpeg.exe` → electron-builder `extraResources`)
- **Bundled FFmpeg build (ffmpeg-static 5.3.0 Windows x64):** **FFmpeg 6.1.1** essentials build from **gyan.dev**, configured with **GPL** (`--enable-gpl` / version 3). License: **GPL-3.0-or-later**
- **Upstream project:** [FFmpeg](https://ffmpeg.org/)
- **Package / license files:** see `node_modules/ffmpeg-static/LICENSE` (copied into the app as `resources/licenses/FFMPEG-GPL-3.0.txt`) and the [ffmpeg-static repository](https://github.com/eugeneware/ffmpeg-static)
- **Source code:** Corresponding FFmpeg 6.1.1 sources are available from [FFmpeg downloads](https://ffmpeg.org/download.html) and the gyan.dev FFmpeg builds project; distributors must fulfill GPL source/offer obligations for the binary they ship
- **How this app uses it:** The application launches FFmpeg as a **separate process** with an argument array (`child_process.spawn`, no shell) to extract the first audio stream for meeting media import. The binary is **not** dynamically linked into the Electron main process
- **Aggregation:** Shipping a GPL-licensed FFmpeg executable alongside this MIT-licensed application is intended as **mere aggregation** of separate programs communicating at arm’s length via process execution
- **This document is not legal advice.** Publishers who distribute the installer/portable build that includes `ffmpeg.exe` should review GPL-3.0 obligations (including corresponding source offer) for their own release channel

## ali-oss

- **npm package:** [ali-oss](https://www.npmjs.com/package/ali-oss) **6.23.0** (`dependencies`; used by meeting enhanced-mode OSS publisher)
- **Upstream:** [ali-sdk/ali-oss](https://github.com/ali-sdk/ali-oss)
- **License:** MIT (see package `LICENSE` in the installed module / upstream repository)
- **How this app uses it:** Optional Aliyun Object Storage uploads for meeting system-track Fun-ASR diarization (private objects + timed signed GET URLs). Not required for default basic / no-bucket meeting transcription.
- **Secrets:** Access keys and signed URLs are runtime-only; this notice does not include credentials.

## Other runtime dependencies

See `package.json` / `package-lock.json` for additional open-source packages (e.g. Electron, `ws`).
