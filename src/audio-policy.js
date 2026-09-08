const MIB = 1024 * 1024;

function resolveAsrAudioPolicy(settings = {}) {
  const provider = settings.asrProvider || "mimo";
  const realtime = settings.asrMode === "realtime";
  const common = {
    channels: 1,
    sampleRate: 16000,
    bitsPerSample: 16
  };

  if (provider === "qwen3-asr") {
    return {
      ...common,
      id: realtime ? "qwen-realtime" : "qwen-batch",
      provider,
      streaming: realtime,
      prefetchSegments: !realtime,
      targetSegmentSeconds: 180,
      hardSegmentSeconds: 210,
      documentedMaxBase64Chars: 10 * MIB,
      documentedMaxDurationSeconds: 5 * 60
    };
  }

  if (provider === "fun-asr") {
    return {
      ...common,
      id: realtime ? "fun-realtime" : "fun-local-stream",
      provider,
      streaming: true,
      prefetchSegments: !realtime,
      targetSegmentSeconds: 10 * 60,
      hardSegmentSeconds: 12 * 60,
      documentedMaxFileBytes: 2 * 1024 * MIB,
      documentedMaxDurationSeconds: 12 * 60 * 60
    };
  }

  return {
    ...common,
    id: "mimo-base64",
    provider: "mimo",
    streaming: false,
    prefetchSegments: true,
    targetSegmentSeconds: 180,
    hardSegmentSeconds: 210,
    documentedMaxBase64Chars: 10 * MIB
  };
}

module.exports = {
  MIB,
  resolveAsrAudioPolicy
};
