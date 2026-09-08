# FFmpeg Media Import (Stage 4B-video)

## Overview

Meeting workbench can import local audio/video files, extract the **first audio stream** with a bundled FFmpeg binary, and commit a **canonical 16 kHz mono PCM16 archive + sidecar**. When FFmpeg already outputs that format, the extract work file is **moved** into `archive/` (no second resample). Transcription still requires an explicit **生成原文** and uses the existing Qwen no-bucket pipeline.

## Binary resolution

| Mode | Path |
|------|------|
| Development | `native/ffmpeg/ffmpeg.exe` (`npm run prepare:ffmpeg` from devDependency `ffmpeg-static@5.3.0`) |
| Packaged | **only** `resources/native/ffmpeg.exe` |

`ffmpeg-static` is a **devDependency** and is excluded from `app.asar` / unpacked node_modules so the install payload is not doubled (~80 MB once).

Scripts:

- `npm run prepare:ffmpeg` — copy npm binary → `native/ffmpeg/ffmpeg.exe` (gitignored)
- `npm run check:ffmpeg` — run `-version`
- `build:dir` / `dist` / `dist:portable` run prepare+check before electron-builder

## Extract + commit

1. Stream-copy source → `session/import/<safeName>` via `*.source.part` (abortable)
2. FFmpeg: no shell, `-map 0:a:0 -vn -ac 1 -ar 16000 -c:a pcm_s16le -f wav` → extract `*.wav.part`
3. `commitPreparedCanonicalWav`: validate 16k mono, write sidecar, quarantine old archive if reimport, **rename** extract part → live archive
4. Success leaves: original media copy + live archive (+ sidecar/hint). Extract part is **not** quarantined on success
5. Fail/cancel: parts → `import/quarantine`; source file never deleted

Default FFmpeg wall timeout: **6 hours** (still AbortSignal-killable). Import UI poll supports the same window.

## Supported extensions

`wav mp3 m4a aac flac ogg opus wma mp4 mkv webm mov avi m4v` — size cap **8 GiB**.

## Import role (UI)

| UI | Archive track | Speaker id |
|----|---------------|------------|
| 个人录音 | `microphone` | `self` |
| 会议/混音 | `system` | `remote_unknown` |

Default Qwen no-bucket does **not** invent multi-speaker diarization.

## Limits (explicit)

- **First audio stream only** (`0:a:0`)
- Not all codecs/containers verified; only short synthetic MP3/MP4 in automated tests
- Long real-world videos not claimed tested
- Installer/portable size grows by roughly **one** FFmpeg binary (~80 MB)

## License / GPL obligations

Bundled binary: **FFmpeg 6.1.1** gyan.dev essentials **GPL** build via ffmpeg-static 5.3.0. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and packaged `resources/licenses/`. **Not legal advice** — distributors must meet GPL source/offer duties for the binary they ship.
