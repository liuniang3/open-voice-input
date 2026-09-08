"use strict";

const { TEMPLATES } = require("./constants");

const MEETING_HINTS =
  /会议|议程|决议|行动项|deadline|action item|minutes|agenda|参会|投票|motion/i;
const PERSONAL_HINTS =
  /我觉得|我在想|随想|笔记|diary|journal|个人|自言自语|思考|idea/i;

function detectTemplate(rawItems) {
  const sample = (Array.isArray(rawItems) ? rawItems : [])
    .slice(0, 40)
    .map((i) => i.text || "")
    .join("\n");
  const m = (sample.match(MEETING_HINTS) || []).length;
  const p = (sample.match(PERSONAL_HINTS) || []).length;
  const speakers = new Set(
    (Array.isArray(rawItems) ? rawItems : []).map((i) => i.speakerId).filter(Boolean)
  );
  if (speakers.size >= 2 || m > p) return TEMPLATES.MEETING;
  if (p > m) return TEMPLATES.PERSONAL;
  return TEMPLATES.MEETING;
}

function resolveTemplate(requested, rawItems) {
  const req = String(requested || TEMPLATES.AUTO).toLowerCase();
  if (req === TEMPLATES.MEETING || req === TEMPLATES.PERSONAL) {
    return { template: req, templateSource: "manual" };
  }
  return { template: detectTemplate(rawItems), templateSource: "auto" };
}

module.exports = {
  detectTemplate,
  resolveTemplate
};
