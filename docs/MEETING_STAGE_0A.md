# Meeting Stage 0A — Mic Capture Prototype

Status: **verified mic-only helper + Node supervisor** (not production long-recording)

Date: 2026-07-19

## What Stage 0A implements

- Independent Rust crate `native/audio-capture-helper`: **microphone only**, WASAPI **shared mode** (`AUDCLNT_SHAREMODE_SHARED`).
- Device format negotiation via `GetMixFormat` + `IsFormatSupported` (no hard-coded 48 kHz mono on the device side).
- JSONL stdin/stdout protocol: `hello`, `ping`, `query_devices`, `configure`, `start`, `pause`, `resume`, `stop`, `shutdown`.
- Session root whitelist + `..` / canonical / junction-aware path deny on `start` (Node + helper). Helper does **not** create directories outside root before the check.
- Parent death: **stdin EOF + parent PID polling**. Job Object parent bind is **disabled** (`jobObject: false`, `parentWatcher: true`).
- Durable subchunk **seal**: ~1s flush + `FlushFileBuffers` + rename to `NNNNNN.l0.pcm` + index/journal; `finish` commits the tail.
- L0 = actual device format; L1 48 kHz s16le mono is a **future** archive target. Manifests mark `archivePending` and keep L0 raw bypass (no HQ resample; do not reuse `audio-utils` linear resampler).
- Capture worker: COM on worker thread; `GetBuffer` always paired with `ReleaseBuffer`.
- start idempotent only for **same** `session_id` + `output_dir`; otherwise `already_capturing`.
- Node `src/meeting/` + narrow main/preload IPC (`create` / `start` / `pause` / `resume` / `stop` / status / scan). No meeting UI.
- Lifecycle separates `implemented` vs `available` (missing EXE ⇒ not available).
- Packaging: `npm run build:helper` then `check:helper` before electron-builder; helper is `extraResources` outside asar.

## Verified on this machine (smoke)

Toolchain: Rust **1.85.1** + VS 2022 Build Tools (MSVC x64).

| Check | Result |
| --- | --- |
| `cargo test` (helper crate) | **4 passed** |
| `cargo build --release` / `npm run build:helper` | success → `audio-capture-helper.exe` |
| JSONL `hello` + `query_devices` | success; **6** capture endpoints enumerated |
| ~**3.4 s** default mic shared capture | success; **4** committed `*.l0.pcm` (~1s + 1s + 1s + tail); manifest `recording=false`, `archivePending=true` |
| `npm run check:helper` | pass when release EXE present |

This is **not** a Tencent Meeting coexistence gate and **not** a 2-hour reliability gate.

## Explicitly NOT implemented

- System loopback / process loopback
- Dual-track capture or drift correction claims
- ASR, cleanup, summary for meetings
- Full meeting UI / console
- 2-hour reliability gate / Tencent Meeting mic coexistence proof
- Device sleep / full device-loss recovery (must not silently fake success)
- High-quality resample to L1
- Real device friendly names (Stage 0A still returns placeholder `"Microphone"`)

## Build requirements

Release packaging **builds** the helper first (`npm run build:helper` → `scripts/build-audio-capture-helper.js`):

1. Finds `cargo` on PATH or `%USERPROFILE%\.cargo\bin\cargo.exe`
2. Finds VS `VsDevCmd.bat` (vswhere or common BuildTools/Community paths)
3. Runs `cmd /c call VsDevCmd -arch=x64 && cargo +1.85.1 build --release --locked`

Pinned toolchain: `native/audio-capture-helper/rust-toolchain.toml` → **1.85.1** (minimal profile).  
Dependency lockfile: `native/audio-capture-helper/Cargo.lock` is committed; `--locked` fails if it drifts.

If cargo or MSVC is missing, the build **fails with a clear message**. It does not auto-install toolchains and does not ship a fake EXE.

CI (`.github/workflows/release.yml`) installs Rust 1.85.1 via `dtolnay/rust-toolchain@1.85.1` before `npm run dist`.

Short-voice hotkey + renderer `getUserMedia` remains the supported dictation path and is independent of the helper.

## Packaging paths

- Dev: `native/audio-capture-helper/target/release/audio-capture-helper.exe`
- Packaged: `process.resourcesPath/native/audio-capture-helper.exe` (extraResources, outside asar)
- Rust `target/` is not in the Electron app `files` glob
- Helper version mismatch on hello → supervisor refuses to run

## Loss window (honest)

Target durable window is about **1s sealed subchunk + journal flush**. This is **not** a promise of zero loss on hard power failure.

## Manual follow-ups

1. Confirm Tencent Meeting (or another app) can still open the mic while helper captures (shared mode)
2. Long-run / 2h gate when dual-track work begins
3. Parent kill → helper exit via watcher / stdin EOF
4. Real device friendly names + L1 HQ archive path (later stages)
