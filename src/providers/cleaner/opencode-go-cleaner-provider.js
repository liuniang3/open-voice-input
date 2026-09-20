"use strict";

const { buildTextCleanupMessages, parseAndValidateCleanupResponse } = require("./text-cleanup-method");
const { createOpenCodeGoSessionId } = require("../opencode-go-client");

function createOpenCodeGoCleanerProvider({ client }) {
  async function clean({ rawText, shortContext }) {
    const response = await client.requestChat(
      buildTextCleanupMessages(rawText, shortContext),
      { maxTokens: 2048, sessionId: createOpenCodeGoSessionId("voice") }
    );
    return {
      provider: "opencode-go",
      text: parseAndValidateCleanupResponse(response.content, rawText),
      raw: response
    };
  }

  return { clean, id: "opencode-go" };
}

module.exports = { createOpenCodeGoCleanerProvider };
