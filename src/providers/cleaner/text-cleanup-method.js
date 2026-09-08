const MIN_RETAINED_CONTENT_RATIO = 0.45;

function buildTextCleanupMessages(rawText, shortContext = "") {
  const systemPrompt = [
    "You clean dictated text for direct insertion using a conservative deletion-span procedure.",
    "Return exactly one JSON object and nothing else: {\"text\":\"...\"}.",
    "Treat the raw transcript as immutable source text.",
    "First identify exact spans that are unquestionably filler noise, a stutter, an abandoned false start, or an accidental duplicate.",
    "Reject any deletion that changes meaning, emphasis, negation, grammatical reduplication, quoted speech, a connective, a technical term, a number, or an identifier.",
    "Reconstruct the result only by deleting approved spans and adjusting punctuation.",
    "Never paraphrase, reorder, replace, summarize, answer, explain, infer, or add content.",
    "Preserve normal reduplication, deliberate repetition, mixed Chinese-English text, product names, model names, code-like words, and abbreviations.",
    "If evidence is insufficient, delete nothing."
  ].join("\n");

  const userPrompt = [
    "Clean this raw transcript:",
    "<raw_transcript>",
    String(rawText || ""),
    "</raw_transcript>",
    shortContext
      ? `Reference vocabulary only. Never output it unless it already appears in the raw transcript: ${shortContext}`
      : "",
    "Return only {\"text\":\"...\"}."
  ].filter(Boolean).join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
}

function parseAndValidateCleanupResponse(value, rawText) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || "").trim());
  } catch {
    return "";
  }
  if (!parsed || typeof parsed.text !== "string") return "";

  const cleanedText = parsed.text.trim();
  return isSafeCleanup(rawText, cleanedText) ? cleanedText : "";
}

function isSafeCleanup(rawText, cleanedText) {
  const rawContent = comparableContent(rawText);
  const cleanedContent = comparableContent(cleanedText);
  if (!rawContent || !cleanedContent) return false;
  if (!isSubsequence(cleanedContent, rawContent)) return false;
  return cleanedContent.length / rawContent.length >= MIN_RETAINED_CONTENT_RATIO;
}

function comparableContent(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\p{P}\p{Z}\s]/gu, "");
}

function isSubsequence(candidate, source) {
  let candidateIndex = 0;
  for (const character of source) {
    if (character === candidate[candidateIndex]) candidateIndex += 1;
    if (candidateIndex === candidate.length) return true;
  }
  return candidate.length === 0;
}

module.exports = {
  buildTextCleanupMessages,
  isSafeCleanup,
  parseAndValidateCleanupResponse
};
