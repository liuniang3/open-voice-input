# macOS capture helper

Native macOS 13+ Swift executable; AVAudioEngine microphone and ScreenCaptureKit
display-filter system audio, sharing the Mach host clock. No screen frames are
saved. System audio is not WASAPI and does not select a hardware output endpoint.

Build on macOS with Xcode command line tools: `npm run build:helper`.
`npm run check:helper` checks hello/ping/shutdown and Mach-O architecture.
`npm run test:platform` runs synthetic archive, EOF and parent-PID tests on macOS,
without requesting microphone or screen access. CI builds native x64 and arm64
hosts separately, including architecture-matching ffmpeg-static. An unsigned CI
ZIP is not a notarized release. Release distribution still requires a Developer
ID signing identity, notarization and permission tests on the final signed app.

## Protocol

stdin/stdout use one JSON object per line, protocol_version 1, helper version
0.2.0. stdout contains protocol only (except explicit utility CLI modes).
Every valid command emits ack followed by result. Supported commands: hello,
ping, configure, query_devices, start, pause, resume, stop, shutdown. Start takes
the existing microphone or single-RPC dual form. Error codes distinguish missing
permissions, invalid paths, unavailable devices and unsupported formats. A new
session must use empty track directories; existing recordings are never reused.

Microphone IDs are CoreAudio device IDs. Render IDs are `display:<CGDirectDisplayID>`;
an empty ID selects the first available display. `query_devices` never requests
Screen Recording access, returning no render entries until access is granted.
`start` requests missing permissions then returns a retryable error; it does not
claim capture started while a consent dialog is outstanding.

Track archives contain manifest.json, index.jsonl, journal.jsonl, frame-aligned
numbered .l0.pcm files, and at most one active current.part. Samples are native
float32 (planar channels are interleaved without resampling). ScreenCaptureKit
is configured for 48 kHz stereo and incoming formats are checked. AVAudioEngine
uses the selected microphone's actual rate/channels. No full-meeting buffer.
An exclusive ownership marker prevents concurrent writers from reusing a track.
On seal: fsync/F_FULLFSYNC PCM, rename, sync directory, append+sync index/journal,
then refresh manifest. A crash can leave a recoverable .part or orphan committed
PCM; index never intentionally references unpublished PCM. No cleanup deletes.

`frameStart/frameEnd` are cumulative source frames in the archive. `qpcStart`,
`qpcEnd`, `sessionOriginQpc`, `qpcFrequency` retain legacy field names but use Mach
host ticks, explicitly identified by `clockSource: mach_absolute_time`.
`sessionStartMs = (qpcStart - sessionOriginQpc) * 1000 / qpcFrequency`.
`sessionEndMs` is the exclusive sample-derived end. Chunk start offsets preserve
microphone/system startup skew. On Windows qpcEnd is a point sample, so portable
consumers should calculate chunk end from start + frames/sampleRate instead.
Pauses discard source frames but record paired shared-clock holes; discontinuities
seal the previous chunk and record metadata, never invent audio.

Stop drains callback/writer queues before sealing tails. Device changes, disk
failures or bounded writer backlog emit session_fault and stop both tracks.
EOF, SIGINT, SIGTERM and parent PID death finalize capture. An 8-second emergency
exit on parent loss bounds framework hangs, leaving disk recovery authoritative.

## Utilities and limitations

`--foreground-app` prints a numeric foreground PID without AppleScript/Automation.
`--paste-to-app PID` requires Accessibility trust, activates/verifies the target,
then posts Command+V. It never reads clipboard text. Electron owns clipboard and
permission settings. Both Electron and the helper include microphone usage text;
TCC attribution for the final signed bundle must be validated on macOS.

`requestScreenAccess()` first uses Electron desktopCapturer.getSources with zero
thumbnail size so the host application can appear in Screen Recording settings.
`--request-screen-access` invokes CGRequestScreenCaptureAccess and prints a boolean
as a native fallback. A grant may require relaunch. Development Terminal/Electron
and the helper can have distinct TCC identities. The helper independently checks
microphone/screen and AX trust; an Electron grant is not proof of helper trust.
Sign the host and nested helper consistently, then test the shipped bundle's
Screen Recording, Microphone and Accessibility entries. Paste fails closed if
the helper's AXIsProcessTrusted check disagrees with the host's preflight.

`--self-test-archive DIRECTORY` writes a deterministic 225-frame synthetic L0
fixture into an empty directory and exits. This is not a capture backend.

Not validated on the Windows development host: Swift SDK compilation, microphone
and system audio on Intel/Apple Silicon, TCC denial/regrant, device switching,
sleep/wake, long meetings, signing/notarization and foreground paste behavior.
Protected content may be silent. System output silence behavior and headless
display availability are determined by ScreenCaptureKit. No hardware or
long-duration reliability claim is made by the synthetic tests.
