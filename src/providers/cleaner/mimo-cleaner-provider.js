const { buildTextCleanupMessages, parseAndValidateCleanupResponse } = require("./text-cleanup-method");

function createMimoCleanerProvider({ client, getModel = () => "mimo-v2.5" }) {
  async function clean({ rawText, shortContext }) {
    const response = await client.requestChat(
      buildTextCleanupMessages(rawText, shortContext),
      { maxTokens: 2048, model: getModel() }
    );
    return {
      provider: "mimo",
      text: parseAndValidateCleanupResponse(response.content, rawText),
      raw: response
    };
  }

  return {
    clean,
    id: "mimo"
  };
}

module.exports = { createMimoCleanerProvider };
