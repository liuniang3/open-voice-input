"use strict";

function assertAsrComplete(response) {
  const reason = response?.finishReason ?? response?.raw?.finishReason;
  if (reason === "length") {
    throw Object.assign(new Error("ASR output was truncated; retry with shorter audio."), {
      code: "asr_output_truncated"
    });
  }
  if ((reason && reason !== "stop") || (!reason && !response?.completed)) {
    throw Object.assign(new Error("ASR response ended before completion."), {
      code: "asr_response_incomplete"
    });
  }
  return response;
}

module.exports = { assertAsrComplete };
