"use strict";

/**
 * Extract and parse a single JSON object from model content.
 * Rejects trailing non-whitespace after the one object (and dual objects).
 */
function stripCodeFences(text) {
  let s = String(text || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(s);
  if (fence) return fence[1].trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "");
    const end = s.lastIndexOf("```");
    if (end >= 0) {
      const after = s.slice(end + 3).trim();
      if (after) {
        const error = new Error("trailing content after fenced JSON");
        error.code = "analysis_json_invalid";
        throw error;
      }
      s = s.slice(0, end);
    }
  }
  return s.trim();
}

function extractBalancedObjectWithEnd(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return { json: s.slice(start, i + 1), end: i + 1, start };
      }
    }
  }
  return null;
}

function extractBalancedObject(text) {
  const hit = extractBalancedObjectWithEnd(text);
  return hit ? hit.json : null;
}

function parseModelJson(content) {
  const raw = String(content || "").trim();
  if (!raw) {
    const error = new Error("empty model content");
    error.code = "analysis_json_invalid";
    throw error;
  }

  let stripped;
  try {
    stripped = stripCodeFences(raw);
  } catch (error) {
    if (error.code === "analysis_json_invalid") throw error;
    stripped = raw;
  }

  // Prefer whole-string parse when valid
  try {
    const obj = JSON.parse(stripped);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {
    // fall through
  }

  const hit = extractBalancedObjectWithEnd(stripped);
  if (!hit) {
    const error = new Error("analysis JSON invalid: no object");
    error.code = "analysis_json_invalid";
    throw error;
  }

  // Reject leading non-whitespace before object
  const before = stripped.slice(0, hit.start);
  if (before.trim()) {
    const error = new Error("analysis JSON invalid: leading content before object");
    error.code = "analysis_json_invalid";
    throw error;
  }
  // Reject trailing non-whitespace after object (catches second object / prose)
  const after = stripped.slice(hit.end);
  if (after.trim()) {
    const error = new Error("analysis JSON invalid: trailing content after object");
    error.code = "analysis_json_invalid";
    throw error;
  }

  try {
    const obj = JSON.parse(hit.json);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      const error = new Error("JSON root must be object");
      error.code = "analysis_json_invalid";
      throw error;
    }
    return obj;
  } catch (e) {
    if (e.code === "analysis_json_invalid") throw e;
    const error = new Error(`analysis JSON invalid: ${e.message || "parse failed"}`);
    error.code = "analysis_json_invalid";
    throw error;
  }
}

module.exports = {
  stripCodeFences,
  extractBalancedObject,
  extractBalancedObjectWithEnd,
  parseModelJson
};
