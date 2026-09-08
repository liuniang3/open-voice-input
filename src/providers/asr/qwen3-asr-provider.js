function buildAsrUserContent({ audioDataUrl }) {
  return [
    {
      type: "input_audio",
      input_audio: {
        data: audioDataUrl
      }
    }
  ];
}

function createQwen3AsrProvider({ client, cleanTranscript, getOptions = () => ({}) }) {
  async function requestAsr(audioDataUrl, { signal = null } = {}) {
    const options = getOptions();
    const asrOptions = {};
    if (options.language) asrOptions.language = options.language;
    if (typeof options.enableItn === "boolean") asrOptions.enable_itn = options.enableItn;

    return client.requestChat(
      [
        {
          role: "user",
          content: buildAsrUserContent({ audioDataUrl })
        }
      ],
      {
        extraBody: Object.keys(asrOptions).length ? { asr_options: asrOptions } : {},
        maxTokens: 2048,
        signal: signal || undefined
      }
    );
  }

  async function transcribeRaw({ audioDataUrl, signal = null }) {
    const response = await requestAsr(audioDataUrl, { signal });
    return {
      provider: "qwen3-asr",
      text: cleanTranscript(response.content),
      raw: response
    };
  }

  /**
   * Meeting-only segment path. Authoritative raw text — no cleanTranscript.
   * Single user message with current audio only; no history/prior context.
   */
  async function transcribeMeetingSegment({ audioDataUrl, signal = null } = {}) {
    const value = String(audioDataUrl || "").trim();
    if (!value.startsWith("data:audio/")) {
      const error = new Error("Qwen meeting segment requires a data:audio/... URL (no-bucket Base64 path).");
      error.code = "meeting_segment_data_url_required";
      throw error;
    }
    const response = await requestAsr(value, { signal });
    const text = String(response?.content ?? "").trim();
    return {
      provider: "qwen3-asr",
      transport: "meeting-segment-base64",
      mode: "no_bucket",
      diarization: false,
      text,
      raw: response,
      timestampPrecision: "none",
      speakerIds: null
    };
  }

  return {
    id: "qwen3-asr",
    kind: "dedicated-asr",
    transcribeFast: transcribeRaw,
    transcribeRaw,
    transcribeMeetingSegment
  };
}

module.exports = { createQwen3AsrProvider, buildAsrUserContent };
