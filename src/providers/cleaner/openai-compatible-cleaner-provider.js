const { buildTextCleanupMessages, parseAndValidateCleanupResponse } = require("./text-cleanup-method");

function createOpenAiCompatibleCleanerProvider({ client }) {
  async function clean({ rawText, shortContext }) {
    const response = await client.requestChat(buildTextCleanupMessages(rawText, shortContext));
    return {
      provider: "openai-compatible",
      text: parseAndValidateCleanupResponse(response.content, rawText),
      raw: response
    };
  }

  return {
    clean,
    id: "openai-compatible"
  };
}

module.exports = { createOpenAiCompatibleCleanerProvider };
