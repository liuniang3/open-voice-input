const MIMO_ASR_MODEL = "mimo-v2.5-asr";

function normalizeMimoAsrModel(model) {
  const value = String(model || "").trim();
  if (!value || value === MIMO_ASR_MODEL) return MIMO_ASR_MODEL;
  if (value.startsWith("mimo-") && value.includes("asr")) return value;
  return MIMO_ASR_MODEL;
}

function createMimoAsrProvider({ client, cleanTranscript, getOptions = () => ({}) }) {
  async function transcribeRaw({ audioDataUrl, signal = null }) {
    const options = getOptions();
    const response = await client.requestChat(
      [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: audioDataUrl
              }
            }
          ]
        }
      ],
      {
        extraBody: {
          asr_options: {
            language: normalizeLanguage(options.language)
          }
        },
        includeSampling: false,
        maxTokens: 2048,
        model: normalizeMimoAsrModel(options.model),
        signal: signal || undefined,
        stream: true
      }
    );

    return {
      provider: "mimo",
      text: cleanTranscript(client.responseText(response)),
      raw: response
    };
  }

  async function transcribeFast(payload) {
    return transcribeRaw(payload);
  }

  /**
   * File/meeting segment path. The current audio segment is the only input;
   * no prior transcript or cleanup instruction is sent to MiMo.
   */
  async function transcribeMeetingSegment({ audioDataUrl, signal = null } = {}) {
    const result = await transcribeRaw({ audioDataUrl, signal });
    return {
      provider: "mimo",
      transport: "meeting-segment-base64",
      mode: "file",
      diarization: false,
      text: String(result?.text || "").trim(),
      raw: result?.raw,
      timestampPrecision: "none",
      speakerIds: null
    };
  }

  return {
    id: "mimo",
    kind: "dedicated-asr",
    model: MIMO_ASR_MODEL,
    transcribeFast,
    transcribeRaw,
    transcribeMeetingSegment
  };
}

function normalizeLanguage(language) {
  const value = String(language || "").trim().toLowerCase();
  return value === "zh" || value === "en" ? value : "auto";
}

module.exports = {
  createMimoAsrProvider,
  MIMO_ASR_MODEL,
  normalizeMimoAsrModel
};
