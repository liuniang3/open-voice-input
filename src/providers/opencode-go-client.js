"use strict";

const crypto = require("node:crypto");
const packageJson = require("../../package.json");
const { createOpenAiCompatibleClient } = require("./openai-compatible-client");

const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_USER_AGENT = `open-voice-input/${packageJson.version}`;

function resolveMaybeFunction(value) {
  return typeof value === "function" ? value() : value;
}

function normalizeOpenCodeGoModel(model) {
  return String(model || "").trim().replace(/^opencode-go\//i, "");
}

function createOpenCodeGoSessionId(prefix = "ovi") {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createOpenCodeGoClient({
  apiKey,
  baseUrl = OPENCODE_GO_BASE_URL,
  model,
  requestTimeoutMs = 60000,
  sessionId = null,
  fetchImpl = null
} = {}) {
  const client = createOpenAiCompatibleClient({
    apiKey,
    baseUrl,
    model: () => normalizeOpenCodeGoModel(resolveMaybeFunction(model)),
    apiStyle: "chat-completions",
    requestTimeoutMs,
    fetchImpl
  });

  async function requestChat(messages, options = {}) {
    const requestedSession = String(options.sessionId || resolveMaybeFunction(sessionId) || "").trim();
    const activeSession = requestedSession || createOpenCodeGoSessionId();
    const { sessionId: _ignored, requestHeaders, ...requestOptions } = options;
    return client.requestChat(messages, {
      ...requestOptions,
      requestHeaders: {
        ...(requestHeaders && typeof requestHeaders === "object" ? requestHeaders : {}),
        "User-Agent": OPENCODE_GO_USER_AGENT,
        "x-opencode-session": activeSession
      }
    });
  }

  return {
    ...client,
    requestChat,
    resolveModel: () => normalizeOpenCodeGoModel(resolveMaybeFunction(model))
  };
}

module.exports = {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_USER_AGENT,
  createOpenCodeGoClient,
  createOpenCodeGoSessionId,
  normalizeOpenCodeGoModel
};
