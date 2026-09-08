# Meeting Stage 1A — Archive Export, Publisher Boundary, Fun-ASR Structured, Timeline Merge

Status: **foundation only** (no meeting UI, no real cloud upload, no object storage)

Date: 2026-07-20 (Codex review fixes applied)

## What Stage 1A implements

### A. Meeting archive / audio export (`src/meeting/archive/`)

- Consume **committed** L0 chunks (`*.l0.pcm`) + `index.jsonl` + `manifest.json` + optional `journal.jsonl`.
- Stream each chunk (do not concatenate whole meetings in memory).
- Produce deterministic **mono PCM16 WAV** per track at the **device sample rate** (no HQ resample / no L1 claim).
- Supported input encodings:
  - PCM16 interleaved (`formatTag` 1 / PCM subformat)
  - IEEE float32 interleaved (`formatTag` 3 / float subformat)
- Multi-channel → mono by equal average with int16 clipping.
- Unsupported formats (e.g. 24-bit) are **rejected** with `l0_format_unsupported`.
- Per-chunk index `format` must be compatible with the selected manifest encoding (`l0_format_mismatch` otherwise).
- Sidecar `*.wav.sidecar.json` maps output frame/time ranges back to:
  - chunk `seq`, source file name
  - devicePos / QPC point samples / `sessionOriginQpc` / `qpcFrequency`
  - pause **gaps** from journal holes (Rust `kind:"hole"` + legacy shapes)
  - session / track / role (from args or **manifest**; no silent microphone default)
  - **`contentSha256`**: SHA-256 of the complete WAV bytes (streamed; not whole-file buffered during PCM write)
- Canonical sidecar is **deterministic** for unchanged inputs (no `createdAt` / wall-clock fields). Noncanonical `exportedAt` may appear only on the function return value.
- Write path: unique `*.{pid}.{timestamp}.{rand}.part` → ordered rename (WAV then sidecar). **Not** a single two-file atomic commit.
  - On failure, `.part` files are **kept** for diagnosis (not deleted). Retry uses a new part name so prior diagnostic parts are not truncated.
  - `verifyArchiveIntegrity({ wavPath, sidecarPath|sidecar })` streams SHA-256 and compares `contentSha256` (`content_sha256_mismatch` on tamper).
- RIFF uint32 size guard: `wav_riff_overflow` if data would exceed max WAV payload.
- `FileHandle.write` uses a write-all loop (partial writes handled).

#### Pause-hole policy (explicit)

| Policy | Value |
| --- | --- |
| id | `explicit_metadata_no_wav_silence` |
| invent speech | **no** |
| insert silence into WAV for pause | **no** |
| representation | `sidecar.gaps[]` only |

**Rust journal shapes** (actual helper):

```json
{"t":...,"kind":"hole","detail":{"reason":"pause_begin|pause_end","detail":{"holeQpc":...,"sessionOriginQpc":...,"qpcFrequency":...,"discardedFrames":...,"pauseGen":...},"track":...,"role":...,"at":...}}
```

```json
{"kind":"hole","detail":{"reason":"discontinuity","detail":{"qpc":...,"qpcFrequency":...,"sessionOriginQpc":...,"packetFlag":true,"flags":1,"devicePosition":...,"clockPos":...},"track":...,"role":...}}
```

Parser pairs `pause_begin` + `pause_end` with the same `pauseGen` into intervals (`qpcBegin`/`qpcEnd`, `discardedFrames`, track, role). Unmatched begin/end are tolerated (`begin_only` / `end_only`). Non-pause holes such as **`discontinuity`** use nested `qpc` (fallback after `holeQpc`/`sharedHoleQpc`) and become **`phase: "point"`** with `qpcBegin = qpcEnd`; they never pair with pause events. Legacy `op:"hole"` mock shapes still parse.

Device capture already omits discarded pause frames from sealed L0. Stage 1A does **not** bridge holes with invented audio.

#### QPC mapping policy (approximation)

| Policy | Value |
| --- | --- |
| id | `qpc_start_plus_sample_offset` |
| interpolates qpcStart..qpcEnd | **no** |

Capture docs: `qpcStart` / `qpcEnd` are **point samples**, not frame-interpolated ends.

Artifact-relative ms (provider / WAV timeline) → shared QPC:

```text
qpc ≈ chunk.qpcStart + round((artifactMs - chunk.beginMs) / 1000 * qpcFrequency)
```

Begin and end pick containing chunks **independently with edge-aware rules** (critical after compacted pauses):

| Edge | Interval | Exact shared boundary `ms === chunk1.endMs === chunk2.beginMs` |
| --- | --- | --- |
| begin | half-open `[beginMs, endMs)` | → **next** chunk (`chunk2`) |
| end | `(beginMs, endMs]` | → **previous** chunk (`chunk1`) |

Clamp only outside the overall artifact range. Then:

```text
sessionBeginMs = (qpcBegin - sessionOriginQpc) / qpcFrequency * 1000
sessionEndMs   = (qpcEnd   - sessionOriginQpc) / qpcFrequency * 1000
```

`gapsOverlapping` filters gaps whose QPC interval intersects the mapped range (not “all gaps”).

### B. Pluggable `MeetingAudioPublisher` (`src/meeting/publish/`)

Narrow interface:

```text
publish({ localPath, contentType, track, sessionId, purpose })
  -> { kind, url?, localPath?, public, uploads, ... }
capabilities() -> { canProvidePublicUrl, uploads, id }
```

| Implementation | Public URL | Uploads | Use |
| --- | --- | --- | --- |
| `createOfflineMeetingAudioPublisher` | no | never | default / export-only |
| `createRemoteUrlMeetingAudioPublisher` | yes (caller-supplied `https://` only) | never | tests / external handoff |

- Credentials stay **out** of this abstraction.
- `requirePublicUrlPublisher()` throws actionable `meeting_publisher_public_url_required` when cloud Fun-ASR needs a public URL but only offline publisher is configured.

### C. Fun-ASR structured meeting path (`src/providers/asr/fun-asr-provider.js`)

Backwards-compatible extension:

- Existing `transcribeRaw` / `transcribeFast` / realtime-local short-voice path **unchanged** (plain `{ text }` still runs `cleanTranscript`).
- New `transcribeMeetingStructured(...)`:
  - requires `https://` URL
  - sets `diarization_enabled: true` **only** when explicitly requested
  - validates mono before diarization request construction
  - longer configurable meeting poll timeout (default 30 minutes)
  - **`text` is raw** joined sentence text (authoritative; not cleaned)
  - optional separate `cleanedText` if a cleaner is configured (never replaces `text`)
  - `AbortSignal` cancellation → `code=aborted` (stops immediately, not retryable)
  - internal HTTP timer → `code=request_timeout` (transient; poll loop owns retries)
  - `transcription_url` download: bounded per-attempt timeout (`requestTimeoutMs`), **no** provider `Authorization` header, same abort vs timeout codes
  - returns structured `sentences[]`: `text`, `beginMs`, `endMs`, `speakerId`, `confidence`, `channelId` when present

#### Official task polling

Per [Aliyun non-realtime ASR guide](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide):

| Step | Method | Headers |
| --- | --- | --- |
| Submit transcription | `POST /services/audio/asr/transcription` | `Authorization`, `Content-Type`, **`X-DashScope-Async: enable`** |
| Poll task | **`GET /tasks/{task_id}`** | `Authorization`, `Content-Type` only (no async header) |

Retry ownership: **poll loop only** (bounded `MAX_TRANSIENT_RETRIES`). `requestJson` does not nested-retry when called from poll.

### D. Timeline merge (`src/meeting/timeline/merge-timeline.js`)

Pure function `mergeMeetingTimeline`:

- microphone → speaker identity **`self`**
- system → `remote_<speakerId>` from Fun-ASR diarization
- map provider-relative ms through artifact sidecar → `sessionBeginMs` / `qpcBegin` / etc.
- **sort by `sessionBeginMs`** when available (required after independently compacted pauses); fallback to artifact `beginMs`
- keep separate fields: `providerBeginMs`, `artifactBeginMs`, `sessionBeginMs`, QPC
- **keeps overlaps**; does **not** merge mic+system audio before ASR; no echo cancellation

## Privacy boundary

- Default path is **local export only**. No automatic upload of meeting audio.
- Cloud Fun-ASR filetrans still needs a **public HTTPS object URL**. Stage 1A does **not** ship object storage.
- Unresolved product requirement: user-configured OSS/S3 (or equivalent) publisher.
- Tests use mocked `fetch`; no real cloud calls; no real recordings uploaded.

## Explicit limitations

- No meeting UI.
- No L1 48 kHz HQ archive (sample rate stays device L0 rate; mono PCM16 container only).
- No process-loopback isolation; system track remains endpoint mix semantics from Stage 0B.
- No echo / double-talk suppression between mic and system transcripts.
- No persistent ASR job queue / billing idempotency store (later stage).
- QPC mapping is an **approximation** anchored on point-sample `qpcStart` + sample-time offset.
- WAV+sidecar publish is **ordered rename**, not multi-file atomic; use `contentSha256`.
- Short-voice hotkey path is independent.

## Tests

```powershell
npm run test:meeting:1a
npm run test:meeting
npm run test:pipeline
```

Coverage includes: PCM16/float32 export, unsupported/mismatch format, Rust journal gaps, contentSha256, pause-compacted cross-track session ordering, GET poll method/headers, raw meeting text vs cleaned short-voice, timeout vs abort codes, offline publisher failure, mono validation.

## Module map

```text
src/meeting/archive/l0-format.js
src/meeting/archive/export-track-wav.js
src/meeting/publish/meeting-audio-publisher.js
src/meeting/timeline/merge-timeline.js
src/providers/asr/fun-asr-provider.js   # extended
scripts/test-meeting-stage1a.js
docs/MEETING_STAGE_1A.md               # this file
```

## Related

- [MEETING_STAGE_0A.md](./MEETING_STAGE_0A.md)
- [MEETING_STAGE_0B.md](./MEETING_STAGE_0B.md)
- [MEETING_SYSTEM_REQUIREMENTS.md](../MEETING_SYSTEM_REQUIREMENTS.md)
