const MIMO_ASR_MODEL = "mimo-v2.5-asr";

function normalizeMimoAsrModel(model) {
  const value = String(model || "").trim();
  if (!value || value === MIMO_ASR_MODEL) return MIMO_ASR_MODEL;
  if (value.startsWith("mimo-") && value.includes("asr")) return value;
  return MIMO_ASR_MODEL;
}

function createMimoAsrProvider({ client, cleanTranscript, getOptions = () => ({}) }) {
  async function transcribeRaw({ audioDataUrl }) {
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

  return {
    id: "mimo",
    kind: "dedicated-asr",
    model: MIMO_ASR_MODEL,
    transcribeFast,
    transcribeRaw
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
