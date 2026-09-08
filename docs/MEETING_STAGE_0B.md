# Meeting Stage 0B — Dual-Track WASAPI Capture

Status: **mic shared + device-level render loopback dual-track helper + Node supervisor**

Date: 2026-07-19

## What Stage 0B implements

- Rust helper `native/audio-capture-helper` **0.2.0**, protocol **v1**.
- **Dual-track** capture in one `start` RPC:
  - `capture_mode: "dual"`
  - `microphone: { device_id?, output_dir }`
  - `system: { device_id?, output_dir }`
- **Microphone**: WASAPI `eCapture`, `AUDCLNT_SHAREMODE_SHARED`, `EVENTCALLBACK`.
- **System**: WASAPI `eRender` + `AUDCLNT_SHAREMODE_SHARED` + `LOOPBACK | EVENTCALLBACK`, `periodicity = 0`, capture scope **endpoint_mix** (full render endpoint mix).
- **TwoPhaseDualSession**: Prepare barrier (both `Initialize` OK) → shared `sessionOriginQpc` + `qpcFrequency` → Start barrier (both `IAudioClient::Start` OK) → then emit started and set `recording=true`. Any prepare/start failure aborts peer, `abort_preparing`, **no residual `recording=true`**.
- COM/audio objects stay on each track **worker thread** only: `CoInitializeEx(MTA)` → Activate → Initialize → Start → GetBuffer/ReleaseBuffer → Stop → Drop → `CoUninitialize`.
- **QPC**: GetBuffer / IAudioClock QPC values are **QPC ticks**. `Initialize` `REFERENCE_TIME` is **100 ns** only. No unit mixing; no realtime drift correction.
- **TrackWriter**: parameterized `track` + `role` (`self` / `remote_mix_for_diarization`); states preparing/recording/finished/faulted; frame-aligned seal (`frames = floor(sampleRate*ms/1000)`, `bytes = frames*blockAlign`); index schema **`l0_chunk_v1`**.
- **query_devices**: returns `capture` + `render` and keeps `devices = capture` for 0A compat. Real `PKEY_Device_FriendlyName`. Default role and open use **`eMultimedia`**.
- Silent loopback: write zeros, count `silentFrames`, keep timeline continuous.
- Single-track unrecoverable fault → session fault, stop other track, keep sealed chunks.
- **pause** broadcasts both tracks; clients keep running; holes include shared `holeQpc`; **resume** continues seq.
- Node `src/meeting`: dual directories, dual scan/recovery, supervisor single dual RPC, `startDual`; main/preload whitelist adds `systemDeviceId` / `captureMode` only (no absolute paths to renderer).
- Capability gate on hello (see below). Mic-only `start` remains for 0A compat.

## Hello capabilities (required)

- `dual_track`
- `system_loopback_shared`
- `dual_start_single_rpc`
- `query_devices_capture_and_render`
- `clock_qpc_ticks_iaudioclock`
- `pause_holes_shared_qpc`
- `durable_subchunk_seal_frame_aligned`

## Fun-ASR field reservation (no API calls)

| Track | `role` | Intent |
| --- | --- | --- |
| microphone | `self` | Local user; candidate “me” without diarization |
| system | `remote_mix_for_diarization` | Remote mix for later speaker diarization |

No ASR, no echo cancellation, no cloud calls in Stage 0B.

## Explicit limitations (honest)

- **Endpoint full mix**, not process isolation — includes this app’s playback if any.
- **DRM** protected content may appear as silence on loopback.
- **No process loopback**, no cpal, no L1 HQ resample, no ASR, no meeting UI.
- **No 2-hour reliability claim** and no Tencent Meeting coexistence gate in this stage.
- Dual start uses **bounded** prepare/start/commit gates (timeout + abort); no unbounded barrier wait.
- Pause journal is **one begin + one end per track** (discarded frames accumulated in memory only).
- Index `clockPos`/`qpc` end fields are **point samples**, not interpolated frame ends; `devicePos` is frame-exact.
- Short-voice `getUserMedia` + hotkey path is unchanged and independent.

## Explicitly NOT implemented

- Process loopback / per-app capture
- Realtime drift correction between tracks
- ASR / cleanup / summary
- Meeting UI
- L1 archive conversion
- 2h soak / production long-recording certification

## Build

```powershell
npm run build:helper
npm run check:helper
cargo test   # in native/audio-capture-helper with MSVC env, or via build wrapper
npm run test:meeting
```

Pinned: Rust **1.85.1**, `Cargo.lock` + `--locked`.

## Packaging

- Dev: `native/audio-capture-helper/target/release/audio-capture-helper.exe`
- Packaged: `process.resourcesPath/native/audio-capture-helper.exe`
- Version or capability mismatch on hello → supervisor refuses to run

## Manual smoke checklist

A. ~5 s dual capture → both mic and system dirs have multiple committed `*.l0.pcm`  
B. Play audible Windows test tone → system track not all zeros  
C. Silence → system still seals timeline and counts silent frames  
D. pause/resume → both tracks record holes with shared `holeQpc`  
E. Bad render device on start → failure and no `recording=true` fake manifest  

## Related

- Stage 0A mic-only notes: [MEETING_STAGE_0A.md](./MEETING_STAGE_0A.md)
- Product requirements: [MEETING_SYSTEM_REQUIREMENTS.md](../MEETING_SYSTEM_REQUIREMENTS.md)
