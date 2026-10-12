"use strict";

// Only stable categories and numeric limits may leave the request layer.
function classifyRequestError(payload, status) {
  let value = payload;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = { message: value.slice(0, 64000) }; }
  }
  const details = value?.error && typeof value.error === "object" ? value.error : value || {};
  const kind = String(details.code || details.type || "").toLowerCase();
  const param = String(details.param || "").toLowerCase();
  const message = String(details.message || "").slice(0, 64000);
  let code = "http_error";
  if (status === 400 && (param === "response_format" || /response_format.{0,40}(unsupported|not supported|invalid)/i.test(message))) {
    code = "request_format_unsupported";
  } else if (/context_length_exceeded|context_window_exceeded|input_too_long/.test(kind)) code = "request_context_limit";
  else if (/max_output_tokens|max_completion_tokens|max_tokens/.test(param)
    || /output.{0,20}(limit|tokens)|completion.{0,20}(limit|tokens)/i.test(kind)
    || /(?:maximum|max|allowed|limit).{0,40}(?:output|completion).{0,20}tokens|(?:output|completion).{0,25}tokens.{0,40}(?:maximum|limit|exceed|allowed)/i.test(message)) {
    code = "request_output_limit";
  } else if (/context.{0,30}(length|window|limit)|too many input tokens|input.{0,25}(too long|exceed)/i.test(message)) {
    code = "request_context_limit";
  }
  const error = Object.assign(new Error(`Model API returned HTTP ${status}.`), { code, status });
  if (code === "request_output_limit") {
    const match = /(?:maximum|max|allowed|limit)[^\d]{0,60}(\d[\d,]*)/i.exec(message);
    const limit = Number(match?.[1]?.replace(/,/g, ""));
    if (Number.isSafeInteger(limit) && limit >= 256 && limit <= 1000000) error.outputTokenLimit = limit;
  }
  return error;
}

module.exports = { classifyRequestError };
