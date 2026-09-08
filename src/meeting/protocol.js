"use strict";

const {
  COMMANDS,
  HELPER_NAME,
  HELPER_VERSION,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES
} = require("./constants");

function createCommandId(prefix = "cmd") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildCommand(cmd, fields = {}) {
  if (!COMMANDS.includes(cmd)) {
    throw new Error(`unknown meeting helper command: ${cmd}`);
  }
  const id = fields.id || createCommandId(cmd);
  return { cmd, id, ...fields, id };
}

function parseHelperLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { type: "parse_error", message: error.message, raw: text };
  }
  if (!value || typeof value !== "object") {
    return { type: "parse_error", message: "helper line is not an object", raw: text };
  }
  return value;
}

function isAck(message, id) {
  return message && message.type === "ack" && (!id || message.id === id);
}

function isResult(message, id) {
  return message && message.type === "result" && (!id || message.id === id);
}

function resultOk(message) {
  return Boolean(message && message.result && message.result.ok);
}

function resultError(message) {
  if (!message || !message.result || message.result.ok) return null;
  return message.result.error || { code: "unknown", message: "helper result not ok" };
}

function assertHelloCompatible(
  hello,
  { requiredVersion = HELPER_VERSION, requiredCapabilities = REQUIRED_CAPABILITIES } = {}
) {
  if (!hello || hello.type !== "hello") {
    return { ok: false, code: "missing_hello", message: "helper did not emit hello" };
  }
  if (hello.name && hello.name !== HELPER_NAME) {
    return {
      ok: false,
      code: "helper_name_mismatch",
      message: `expected ${HELPER_NAME}, got ${hello.name}`
    };
  }
  if (Number(hello.protocol_version || hello.protocolVersion) !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "protocol_version_mismatch",
      message: `expected protocol ${PROTOCOL_VERSION}, got ${hello.protocol_version || hello.protocolVersion}`
    };
  }
  const version = String(hello.version || "");
  if (requiredVersion && version && version !== requiredVersion) {
    return {
      ok: false,
      code: "helper_version_mismatch",
      message: `expected helper ${requiredVersion}, got ${version}`
    };
  }
  const caps = Array.isArray(hello.capabilities) ? hello.capabilities.map(String) : [];
  const missing = (requiredCapabilities || []).filter((c) => !caps.includes(c));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "helper_capability_missing",
      message: `helper missing capabilities: ${missing.join(", ")}`,
      missing
    };
  }
  return { ok: true, version: version || requiredVersion, capabilities: caps };
}

function validateStartPathInput(outputDir) {
  const value = String(outputDir || "");
  if (!value.trim()) {
    return { ok: false, code: "path_empty", message: "output_dir is empty" };
  }
  if (value.includes("\0")) {
    return { ok: false, code: "path_denied", message: "output_dir contains NUL" };
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) {
    return { ok: false, code: "path_denied", message: "output_dir must not contain .." };
  }
  return { ok: true };
}

module.exports = {
  createCommandId,
  buildCommand,
  parseHelperLine,
  isAck,
  isResult,
  resultOk,
  resultError,
  assertHelloCompatible,
  validateStartPathInput
};
