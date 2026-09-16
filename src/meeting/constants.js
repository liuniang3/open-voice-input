"use strict";

const HELPER_NAME = "audio-capture-helper";
const HELPER_VERSION = "0.2.0";
const PROTOCOL_VERSION = 1;
const DEFAULT_SUBCHUNK_MS = 1000;
const TRACK_MICROPHONE = "microphone";
const TRACK_SYSTEM = "system";
const CAPTURE_MODE_DUAL = "dual";
const CAPTURE_MODE_MICROPHONE = "microphone";

const REQUIRED_CAPABILITIES = Object.freeze([
  "dual_track",
  "system_loopback_shared",
  "dual_start_single_rpc",
  "query_devices_capture_and_render",
  "clock_qpc_ticks_iaudioclock",
  "pause_holes_shared_qpc",
  "durable_subchunk_seal_frame_aligned"
]);

const MACOS_REQUIRED_CAPABILITIES = Object.freeze([
  "dual_track",
  "system_audio_screencapturekit",
  "microphone_avaudioengine",
  "dual_start_single_rpc",
  "clock_mach_host_time",
  "pause_holes_shared_host_time",
  "durable_subchunk_seal_frame_aligned"
]);

function requiredCapabilitiesForPlatform(platform = process.platform) {
  // Keep the historical Windows constant for callers/tests of the WASAPI protocol.
  if (platform === "darwin") return MACOS_REQUIRED_CAPABILITIES;
  return REQUIRED_CAPABILITIES;
}

const COMMANDS = Object.freeze([
  "hello",
  "ping",
  "query_devices",
  "configure",
  "start",
  "pause",
  "resume",
  "stop",
  "shutdown",
  // test-only (fake helper); real helper returns unknown_cmd
  "inject_fault"
]);

const TARGET_L1_FORMAT = Object.freeze({
  sampleRate: 48000,
  channels: 1,
  bitsPerSample: 16,
  encoding: "s16le",
  layer: "L1",
  note: "future archive target; not produced in Stage 0B"
});

module.exports = {
  HELPER_NAME,
  HELPER_VERSION,
  PROTOCOL_VERSION,
  DEFAULT_SUBCHUNK_MS,
  TRACK_MICROPHONE,
  TRACK_SYSTEM,
  CAPTURE_MODE_DUAL,
  CAPTURE_MODE_MICROPHONE,
  REQUIRED_CAPABILITIES,
  MACOS_REQUIRED_CAPABILITIES,
  requiredCapabilitiesForPlatform,
  COMMANDS,
  TARGET_L1_FORMAT
};
