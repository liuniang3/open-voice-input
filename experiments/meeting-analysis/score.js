"use strict";

/**
 * Scoring for meeting-analysis benchmark.
 * Prefer keyword-group hits + sourceItemId overlap over exact string match.
 */

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：""''（）()[\]【】《》<>]/g, "");
}

function collectClaimTexts(obj, path = "") {
  const out = [];
  if (obj == null) return out;
  if (typeof obj === "string") {
    out.push({ path, text: obj, sourceItemIds: [] });
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => out.push(...collectClaimTexts(item, `${path}[${i}]`)));
    return out;
  }
  if (typeof obj !== "object") return out;

  const text = obj.text || obj.label || obj.title || "";
  const ids = Array.isArray(obj.sourceItemIds)
    ? obj.sourceItemIds.map(String)
    : obj.sourceItemId != null
      ? [String(obj.sourceItemId)]
      : [];
  if (text) out.push({ path, text: String(text), sourceItemIds: ids, raw: obj });

  for (const [k, v] of Object.entries(obj)) {
    if (k === "text" || k === "label" || k === "title" || k === "sourceItemIds" || k === "sourceItemId") {
      continue;
    }
    if (v && typeof v === "object") {
      out.push(...collectClaimTexts(v, path ? `${path}.${k}` : k));
    }
  }
  return out;
}

function flattenModelBlob(modelOut) {
  if (!modelOut || typeof modelOut !== "object") return "";
  const parts = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === "string") {
      parts.push(v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(modelOut);
  return parts.join("\n");
}

/** Semantic user-facing strings only — excludes schema/template/ids/ops/structure. */
const SEMANTIC_STRING_KEYS = new Set([
  "correctedText",
  "text",
  "title",
  "label",
  "owner",
  "due",
  "reason",
  "content",
  "summary",
  "description",
  "point",
  "name"
]);

function collectSemanticTexts(modelOut) {
  if (!modelOut || typeof modelOut !== "object") return [];
  const parts = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string" && SEMANTIC_STRING_KEYS.has(k)) {
        parts.push(val);
      } else if (val && typeof val === "object") {
        walk(val);
      }
    }
  };
  walk(modelOut);
  return parts;
}

function semanticTextBlob(modelOut) {
  return collectSemanticTexts(modelOut).join("\n");
}

function groupHit(textNorm, group) {
  const alts = Array.isArray(group) ? group : [group];
  return alts.some((a) => {
    const n = normText(a);
    return n && textNorm.includes(n);
  });
}

/** Longer first so multi-char markers win over single 不/未/非. */
const NEGATION_MARKERS = [
  "并不是",
  "而不是",
  "并没有",
  "绝不是",
  "未采纳",
  "未决定",
  "不默认",
  "无需",
  "不必",
  "不应",
  "不能",
  "避免",
  "拒绝",
  "反对",
  "并非",
  "不是",
  "不要",
  "并未",
  "没有",
  "绝不",
  "并不",
  "否决",
  "说错了",
  "纠正",
  "别",
  "勿",
  "未",
  "非",
  "不",
  "否"
];

const NEGATION_MARKERS_NORM = NEGATION_MARKERS.map((m) => normText(m))
  .filter(Boolean)
  .sort((a, b) => b.length - a.length);

const LOCAL_NEG_WINDOW = 28;

function windowHasNegation(beforeNorm, afterNorm = "") {
  const b = String(beforeNorm || "");
  const a = String(afterNorm || "");
  return NEGATION_MARKERS_NORM.some((n) => {
    if (!n) return false;
    if (b.endsWith(n)) return true;
    if (b.length >= n.length && b.slice(-Math.min(b.length, LOCAL_NEG_WINDOW)).includes(n)) {
      return true;
    }
    if (a.startsWith(n)) return true;
    if (a.length >= n.length && a.slice(0, Math.min(a.length, LOCAL_NEG_WINDOW)).includes(n)) {
      return true;
    }
    return false;
  });
}

/**
 * True if phrase appears as a positive assertion (at least one non-negated mention).
 * Negated/corrected mentions (e.g. "不是百分之九十二", "无需默认上云端清理") do not count.
 * Local windows before and after the match are checked; no cross-field blob merge.
 */
function phraseAsserted(text, phrase) {
  const t = normText(text);
  const p = normText(phrase);
  if (!p || !t.includes(p)) return false;
  let from = 0;
  while (from <= t.length) {
    const idx = t.indexOf(p, from);
    if (idx < 0) break;
    const before = t.slice(Math.max(0, idx - LOCAL_NEG_WINDOW), idx);
    const after = t.slice(idx + p.length, idx + p.length + LOCAL_NEG_WINDOW);
    if (!windowHasNegation(before, after)) return true;
    from = idx + Math.max(1, p.length);
  }
  return false;
}

function groupAsserted(text, group) {
  const alts = Array.isArray(group) ? group : [group];
  return alts.some((a) => phraseAsserted(text, a));
}

function scoreKeywordClaim(claim, candidateTexts) {
  const groups = claim.keywordGroups || [];
  const minHits = claim.minGroupHits != null ? claim.minGroupHits : 1;
  let best = { hit: false, groupHits: 0, matchedPath: null, sourceOverlap: 0 };

  for (const cand of candidateTexts) {
    const t = normText(cand.text);
    let hits = 0;
    for (const g of groups) {
      if (groupHit(t, g)) hits += 1;
    }
    const goldIds = new Set((claim.sourceItemIds || []).map(String));
    const candIds = new Set((cand.sourceItemIds || []).map(String));
    let overlap = 0;
    for (const id of candIds) if (goldIds.has(id)) overlap += 1;
    const sourceOk =
      !claim.sourceOverlapMin || overlap >= claim.sourceOverlapMin || goldIds.size === 0;
    if (hits >= minHits && sourceOk) {
      if (hits > best.groupHits || (hits === best.groupHits && overlap > best.sourceOverlap)) {
        best = {
          hit: true,
          groupHits: hits,
          matchedPath: cand.path,
          sourceOverlap: overlap
        };
      }
    }
  }

  // Fallback: scan concatenated blob without requiring source ids (still counts recall loosely)
  if (!best.hit && candidateTexts.length) {
    const blob = normText(candidateTexts.map((c) => c.text).join("\n"));
    let hits = 0;
    for (const g of groups) {
      if (groupHit(blob, g)) hits += 1;
    }
    if (hits >= minHits) {
      best = {
        hit: true,
        groupHits: hits,
        matchedPath: "blob_fallback",
        sourceOverlap: 0,
        loose: true
      };
    }
  }
  return best;
}

/**
 * mustNot: independent claims only, no blob fallback, local negation protected.
 */
function scoreMustNotClaim(claim, candidateTexts) {
  const groups = claim.keywordGroups || [];
  const minHits = claim.minGroupHits != null ? claim.minGroupHits : 1;
  let best = { hit: false, groupHits: 0, matchedPath: null };

  for (const cand of candidateTexts) {
    let hits = 0;
    for (const g of groups) {
      if (groupAsserted(cand.text, g)) hits += 1;
    }
    if (hits >= minHits && hits > best.groupHits) {
      best = {
        hit: true,
        groupHits: hits,
        matchedPath: cand.path
      };
    }
  }
  return best;
}

function claimsFromPaths(modelOut, paths) {
  if (!modelOut) return [];
  if (!paths || !paths.length) return collectClaimTexts(modelOut);
  const out = [];
  for (const p of paths) {
    const node = getPath(modelOut, p);
    out.push(...collectClaimTexts(node, p));
  }
  return out;
}

function getPath(obj, path) {
  if (!path) return obj;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function allKnownIds(rawItems) {
  return new Set((rawItems || []).map((i) => String(i.id)));
}

function validateSourceIds(modelOut, knownIds) {
  const claims = collectClaimTexts(modelOut);
  let totalRefs = 0;
  let validRefs = 0;
  const invalid = [];
  for (const c of claims) {
    for (const id of c.sourceItemIds || []) {
      totalRefs += 1;
      if (knownIds.has(String(id))) validRefs += 1;
      else invalid.push({ path: c.path, id: String(id) });
    }
  }
  // also correctedItems.sourceItemId
  for (const it of modelOut?.correctedItems || []) {
    const id = String(it.sourceItemId || it.id || "");
    if (!id) continue;
    totalRefs += 1;
    if (knownIds.has(id)) validRefs += 1;
    else invalid.push({ path: "correctedItems", id });
  }
  return {
    totalRefs,
    validRefs,
    invalidCount: invalid.length,
    invalidSample: invalid.slice(0, 8),
    ratio: totalRefs ? validRefs / totalRefs : 1
  };
}

function scoreCorrectedCoverage(modelOut, rawItems) {
  const ids = (rawItems || []).map((i) => String(i.id));
  const got = new Set();
  for (const it of modelOut?.correctedItems || []) {
    const id = String(it.sourceItemId || it.id || "");
    if (id) got.add(id);
  }
  const missing = ids.filter((id) => !got.has(id));
  return {
    expected: ids.length,
    got: got.size,
    missing,
    ratio: ids.length ? (ids.length - missing.length) / ids.length : 1
  };
}

function scoreMustPreserve(modelOut, mustPreserve, rawItems) {
  const blob = normText(flattenModelBlob(modelOut));
  const results = [];
  let hit = 0;
  for (const mp of mustPreserve || []) {
    const alts = [mp.text, ...(mp.alts || [])].filter(Boolean);
    const ok = alts.some((a) => {
      const n = normText(a);
      return n && blob.includes(n);
    });
    if (ok) hit += 1;
    results.push({ id: mp.id, ok, text: mp.text });
  }
  return {
    total: (mustPreserve || []).length,
    hit,
    ratio: (mustPreserve || []).length ? hit / mustPreserve.length : 1,
    details: results
  };
}

const CN_DIGIT = {
  "\u96f6": 0,
  "\u3007": 0,
  "\u4e00": 1,
  "\u4e8c": 2,
  "\u4e24": 2,
  "\u4e09": 3,
  "\u56db": 4,
  "\u4e94": 5,
  "\u516d": 6,
  "\u4e03": 7,
  "\u516b": 8,
  "\u4e5d": 9
};

/** Parse simple Chinese numerals (incl. 十/百/千/万 and 点 decimals). */
function parseChineseNumeral(token) {
  const s = String(token || "").replace(/\s+/g, "");
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return s;
  if (s.includes("点")) {
    const [ip, fp] = s.split("点");
    const left = parseChineseNumeral(ip);
    if (left == null || fp == null || fp === "") return null;
    let frac = "";
    for (const ch of fp) {
      if (CN_DIGIT[ch] != null) frac += String(CN_DIGIT[ch]);
      else if (/\d/.test(ch)) frac += ch;
      else return null;
    }
    if (!frac) return null;
    return String(parseFloat(`${left}.${frac}`));
  }

  let total = 0;
  let section = 0;
  let number = 0;
  let has = false;
  for (const ch of s) {
    if (CN_DIGIT[ch] != null) {
      number = CN_DIGIT[ch];
      has = true;
      continue;
    }
    if (ch === "十") {
      section += (number || 1) * 10;
      number = 0;
      has = true;
      continue;
    }
    if (ch === "百") {
      section += (number || 1) * 100;
      number = 0;
      has = true;
      continue;
    }
    if (ch === "千") {
      section += (number || 1) * 1000;
      number = 0;
      has = true;
      continue;
    }
    if (ch === "万") {
      section = (section + number) * 10000;
      total += section;
      section = 0;
      number = 0;
      has = true;
      continue;
    }
    if (/\d/.test(ch)) {
      number = number * 10 + Number(ch);
      has = true;
      continue;
    }
    return null;
  }
  if (!has) return null;
  total += section + number;
  return String(total);
}

function extractArabicNumbers(text) {
  return String(text || "").match(/\d+(?:\.\d+)?/g) || [];
}

/** Arabic + Chinese numerals / 百分之… forms from free text. */
function extractAllNumbers(text) {
  const s = String(text || "");
  const out = new Set(extractArabicNumbers(s));

  const pctRe = /百分之([零〇○一二三四五六七八九十百千万两点\d]+)/g;
  let m;
  while ((m = pctRe.exec(s)) !== null) {
    const n = parseChineseNumeral(m[1]);
    if (n != null) out.add(n);
  }

  // Multi-char Chinese numerals only (avoid lone 五 in 周五 / 一 in 一下)
  const cnRe =
    /[零〇一二三四五六七八九十百千万两\d]{0,12}[十百千万][零〇一二三四五六七八九\d]{0,8}(?:点[零〇一二三四五六七八九\d]+)?|[一二三四五六七八九]点[零〇一二三四五六七八九\d]+/g;
  while ((m = cnRe.exec(s)) !== null) {
    const tok = m[0];
    if (tok.length < 2) continue;
    if (/^\d+(?:\.\d+)?$/.test(tok)) continue;
    const n = parseChineseNumeral(tok);
    if (n != null) out.add(n);
  }

  return [...out];
}

function extractNumbersAndEntities(text) {
  const s = String(text || "");
  const numbers = extractArabicNumbers(s);
  const idents = s.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) || [];
  return { numbers, idents };
}

function addNumbersToSet(set, text) {
  for (const n of extractAllNumbers(text)) set.add(String(n));
  for (const n of extractArabicNumbers(text)) set.add(String(n));
}

/**
 * Baseline numbers: raw semantic text + structural id/speakerId digits + mustPreserve text/alts whitelist.
 * Source-mentioned numbers (including under negation) are never treated as inventions.
 */
function collectBaselineNumbers(rawItems, mustPreserve) {
  const nums = new Set();
  for (const it of rawItems || []) {
    addNumbersToSet(nums, it.text || "");
    addNumbersToSet(nums, it.id || "");
    addNumbersToSet(nums, it.speakerId || "");
    if (it.beginMs != null) addNumbersToSet(nums, String(it.beginMs));
    if (it.endMs != null) addNumbersToSet(nums, String(it.endMs));
  }
  for (const mp of mustPreserve || []) {
    addNumbersToSet(nums, mp.text || "");
    for (const a of mp.alts || []) addNumbersToSet(nums, a);
  }
  return nums;
}

/** True if number token is positively asserted somewhere in text (negated-only mentions ignored). */
function numberAsserted(text, numStr) {
  const n = String(numStr || "");
  if (!n) return false;
  if (phraseAsserted(text, n)) return true;
  // Chinese surface forms that map to the same value
  const t = String(text || "");
  for (const cand of extractAllNumbers(t)) {
    if (String(cand) === n || Number(cand) === Number(n)) {
      // find a cn/arabic surface and check assertion via arabic digit form or original span
      if (phraseAsserted(t, n)) return true;
    }
  }
  // If the only mentions are Chinese and phraseAsserted on arabic fails, scan raw spans
  const surfaces = [];
  const re = new RegExp(n.replace(/\./g, "\\."), "g");
  if (re.test(normText(t)) && phraseAsserted(t, n)) return true;
  // percent chinese already handled via baseline; for assertion of novel check arabic form only
  return phraseAsserted(t, n);
}

/**
 * @param {object} modelOut
 * @param {array} rawItems
 * @param {array|object} mustPreserveOrOpts mustPreserve array, or { mustPreserve }
 */
function scoreForbiddenInvention(modelOut, rawItems, mustPreserveOrOpts = []) {
  const mustPreserve = Array.isArray(mustPreserveOrOpts)
    ? mustPreserveOrOpts
    : mustPreserveOrOpts && typeof mustPreserveOrOpts === "object"
      ? mustPreserveOrOpts.mustPreserve || []
      : [];

  const rawBlob = (rawItems || []).map((i) => i.text || "").join("\n");
  const baselineNums = collectBaselineNumbers(rawItems, mustPreserve);
  const rawIdents = new Set(
    extractNumbersAndEntities(rawBlob).idents.map((x) => x.toLowerCase())
  );

  const semanticParts = collectSemanticTexts(modelOut);
  const outBlob = semanticParts.join("\n");
  const outNumList = extractAllNumbers(outBlob);
  const outIdents = extractNumbersAndEntities(outBlob).idents;

  const novelNumbers = [];
  for (const n of outNumList) {
    const key = String(n);
    if (baselineNums.has(key)) continue;
    // numeric equality (87.50 vs 87.5)
    let known = false;
    for (const b of baselineNums) {
      if (b === key) {
        known = true;
        break;
      }
      if (!Number.isNaN(Number(b)) && !Number.isNaN(Number(key)) && Number(b) === Number(key)) {
        known = true;
        break;
      }
    }
    if (known) continue;
    // Per-field assertion: numbers only under local negation are not inventions
    const asserted = semanticParts.some((part) => numberAsserted(part, key));
    if (!asserted) continue;
    novelNumbers.push(key);
  }

  const novelIdents = [];
  for (const id of outIdents) {
    const low = id.toLowerCase();
    if (rawIdents.has(low)) continue;
    if (rawBlob.toLowerCase().includes(low)) continue;
    if (
      /^(schema|template|meeting|personal|text|source|item|id|null|true|false)$/i.test(id)
    ) {
      continue;
    }
    novelIdents.push(id);
  }

  return {
    novelNumbers: [...new Set(novelNumbers)].slice(0, 20),
    novelIdents: [...new Set(novelIdents)].slice(0, 20),
    novelNumberCount: new Set(novelNumbers).size,
    novelIdentCount: new Set(novelIdents).size
  };
}

function summaryOnlyOutput(modelOut) {
  if (!modelOut || typeof modelOut !== "object") return {};
  const skip = new Set(["correctedItems", "schema"]);
  const out = {};
  for (const [k, v] of Object.entries(modelOut)) {
    if (skip.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function scoreMustNot(modelOut, mustNotClaims) {
  const details = [];
  let triggered = 0;
  // Score summary claims only — correctedItems may still contain negated ASR residual
  // (e.g. "不是百分之九十二") which must not count as asserting the forbidden claim.
  const summary = summaryOnlyOutput(modelOut);
  for (const mn of mustNotClaims || []) {
    const paths = mn.paths && mn.paths.length ? mn.paths : null;
    // Independent claims on specified paths only — never concatenate into a blob.
    const cands = claimsFromPaths(summary, paths);
    const scored = scoreMustNotClaim(mn, cands);
    if (scored.hit) triggered += 1;
    details.push({
      id: mn.id,
      triggered: Boolean(scored.hit),
      matchedPath: scored.matchedPath || null
    });
  }
  return {
    total: (mustNotClaims || []).length,
    triggered,
    clean: triggered === 0,
    details
  };
}

function scoreGoldSection(modelOut, goldList, sectionPaths) {
  const list = goldList || [];
  if (!list.length) {
    return { total: 0, hit: 0, recall: 1, details: [] };
  }
  const cands = claimsFromPaths(modelOut, sectionPaths);
  const details = [];
  let hit = 0;
  for (const g of list) {
    const r = scoreKeywordClaim(g, cands);
    if (r.hit) hit += 1;
    details.push({ id: g.id, hit: r.hit, ...r });
  }
  return {
    total: list.length,
    hit,
    recall: list.length ? hit / list.length : 1,
    details
  };
}

function scoreEmptyExpectation(modelOut, expectEmpty) {
  const details = [];
  let ok = true;
  for (const [key, shouldEmpty] of Object.entries(expectEmpty || {})) {
    if (!shouldEmpty) continue;
    const arr = modelOut?.[key];
    const len = Array.isArray(arr) ? arr.length : arr ? 1 : 0;
    const empty = len === 0;
    if (!empty) ok = false;
    details.push({ key, expectedEmpty: true, actualCount: len, ok: empty });
  }
  return { ok, details };
}

function scoreSpanCoverage(modelOut, spanCoverage, rawItems) {
  const cited = new Set();
  for (const c of collectClaimTexts(modelOut)) {
    for (const id of c.sourceItemIds || []) cited.add(String(id));
  }
  for (const it of modelOut?.correctedItems || []) {
    const id = String(it.sourceItemId || it.id || "");
    if (id) cited.add(id);
  }

  function ratio(ids) {
    const list = ids || [];
    if (!list.length) return 1;
    const hit = list.filter((id) => cited.has(String(id))).length;
    return hit / list.length;
  }

  const early = ratio(spanCoverage?.earlyItemIds);
  const mid = ratio(spanCoverage?.midItemIds);
  const late = ratio(spanCoverage?.lateItemIds);
  return {
    early,
    mid,
    late,
    mean: (early + mid + late) / 3,
    citedCount: cited.size
  };
}

const CORRECTED_ITEM_WRONG_FIELDS = [
  "correctText",
  "corrected_text",
  "correctionText",
  "fixText",
  "fixedText"
];

function validateSchema(modelOut) {
  const errors = [];
  if (!modelOut || typeof modelOut !== "object" || Array.isArray(modelOut)) {
    return { ok: false, errors: ["root_not_object"] };
  }
  if (modelOut.template && !["meeting", "personal"].includes(modelOut.template)) {
    errors.push("invalid_template");
  }
  if (!Array.isArray(modelOut.correctedItems)) {
    errors.push("correctedItems_not_array");
  } else {
    modelOut.correctedItems.forEach((it, i) => {
      if (!it || typeof it !== "object" || Array.isArray(it)) {
        errors.push(`correctedItems[${i}]_not_object`);
        return;
      }
      const sid = it.sourceItemId;
      if (sid == null || String(sid).trim() === "") {
        errors.push(`correctedItems[${i}]_sourceItemId_empty`);
      }
      if (typeof it.correctedText !== "string") {
        errors.push(`correctedItems[${i}]_correctedText_not_string`);
      }
      for (const wf of CORRECTED_ITEM_WRONG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(it, wf)) {
          errors.push(`correctedItems[${i}]_wrong_field_${wf}`);
        }
      }
    });
  }
  if (Object.prototype.hasOwnProperty.call(modelOut, "flaggedUncertain")) {
    if (!Array.isArray(modelOut.flaggedUncertain)) {
      errors.push("flaggedUncertain_not_array");
    }
  }
  const meetingKeys = ["decisions", "actionItems", "executiveSummary"];
  const personalKeys = ["coreIdeas", "supportingPoints", "nextSteps"];
  const hasMeeting = meetingKeys.some((k) => modelOut[k] != null);
  const hasPersonal = personalKeys.some((k) => modelOut[k] != null);
  if (!hasMeeting && !hasPersonal && !modelOut.facts) {
    errors.push("no_summary_sections");
  }
  return { ok: errors.length === 0, errors };
}

const MEETING_DECISION_PATHS = ["decisions"];
const MEETING_ACTION_PATHS = ["actionItems"];
const MEETING_FACT_PATHS = [
  "facts",
  "executiveSummary",
  "timeline",
  "topicsOutline",
  "openIssues",
  "risks",
  "keyQuotes",
  "speakerPoints"
];
const PERSONAL_VIEW_PATHS = [
  "coreIdeas",
  "supportingPoints",
  "assumptions",
  "openQuestions",
  "nextSteps",
  "argumentOutline",
  "keyQuotes",
  "facts"
];

function scoreCase(caseData, modelOut, meta = {}) {
  const knownIds = allKnownIds(caseData.rawItems);
  const schema = validateSchema(modelOut);
  const coverage = scoreCorrectedCoverage(modelOut, caseData.rawItems);
  const preserve = scoreMustPreserve(modelOut, caseData.mustPreserve, caseData.rawItems);
  const invention = scoreForbiddenInvention(modelOut, caseData.rawItems, caseData.mustPreserve);
  const mustNot = scoreMustNot(modelOut, caseData.mustNotClaims);
  const sourceIds = validateSourceIds(modelOut, knownIds);
  const span = scoreSpanCoverage(modelOut, caseData.spanCoverage, caseData.rawItems);
  const emptyExp = scoreEmptyExpectation(modelOut, caseData.expectEmpty);

  const gold = caseData.goldClaims || {};
  const isPersonal = caseData.template === "personal";

  const decisions = scoreGoldSection(
    modelOut,
    gold.decisions,
    isPersonal ? PERSONAL_VIEW_PATHS : MEETING_DECISION_PATHS
  );
  const actionItems = scoreGoldSection(
    modelOut,
    gold.actionItems,
    isPersonal ? PERSONAL_VIEW_PATHS : MEETING_ACTION_PATHS
  );
  const viewpoints = scoreGoldSection(modelOut, gold.coreIdeas || gold.viewpoints, PERSONAL_VIEW_PATHS);
  const supporting = scoreGoldSection(modelOut, gold.supportingPoints, PERSONAL_VIEW_PATHS);
  const assumptions = scoreGoldSection(modelOut, gold.assumptions, PERSONAL_VIEW_PATHS);
  const openQuestions = scoreGoldSection(modelOut, gold.openQuestions, PERSONAL_VIEW_PATHS);
  const nextSteps = scoreGoldSection(modelOut, gold.nextSteps, PERSONAL_VIEW_PATHS);
  const openIssues = scoreGoldSection(
    modelOut,
    gold.openIssues,
    isPersonal ? PERSONAL_VIEW_PATHS : ["openIssues", "risks", "facts", "executiveSummary"]
  );
  const facts = scoreGoldSection(
    modelOut,
    gold.facts,
    isPersonal ? PERSONAL_VIEW_PATHS : MEETING_FACT_PATHS
  );

  // Aggregate claim recall
  const claimParts = [];
  if (!isPersonal) {
    claimParts.push(decisions, actionItems, openIssues, facts);
  } else {
    claimParts.push(viewpoints, supporting, assumptions, openQuestions, nextSteps, facts);
  }
  let claimTotal = 0;
  let claimHit = 0;
  for (const p of claimParts) {
    claimTotal += p.total;
    claimHit += p.hit;
  }
  const claimRecall = claimTotal ? claimHit / claimTotal : 1;

  const callOk = Boolean(meta.callOk);
  const jsonOk = Boolean(meta.jsonOk) && schema.ok;
  // Failed call/parse must not earn vacuous section passes (empty gold totals → recall 1).
  const gateOk = callOk && jsonOk;
  const effectiveClaimRecall = gateOk ? claimRecall : 0;
  const effectiveClaimHit = gateOk ? claimHit : 0;

  // Composite 0-100 style; callOk/jsonOk failure forces composite 0.
  let score = 0;
  if (gateOk) {
    const weights = {
      callOk: 10,
      jsonOk: 15,
      coverage: 15,
      preserve: 15,
      claimRecall: 25,
      mustNot: 10,
      sourceIds: 5,
      span: 5
    };
    score += weights.callOk;
    score += weights.jsonOk;
    score += weights.coverage * coverage.ratio;
    score += weights.preserve * preserve.ratio;
    score += weights.claimRecall * effectiveClaimRecall;
    score +=
      weights.mustNot *
      (mustNot.clean ? 1 : Math.max(0, 1 - mustNot.triggered / Math.max(1, mustNot.total)));
    score += weights.sourceIds * sourceIds.ratio;
    score += weights.span * span.mean;
    if (!emptyExp.ok) score *= 0.7;
    if (invention.novelNumberCount > 2) score *= 0.85;
  }

  return {
    callOk,
    jsonOk,
    schema,
    correctedCoverage: coverage,
    mustPreserve: preserve,
    invention,
    mustNot,
    sourceItemIds: sourceIds,
    spanCoverage: span,
    expectEmpty: emptyExp,
    claims: {
      decisions,
      actionItems,
      viewpoints,
      supporting,
      assumptions,
      openQuestions,
      nextSteps,
      openIssues,
      facts,
      recall: effectiveClaimRecall,
      hit: effectiveClaimHit,
      total: claimTotal
    },
    compositeScore: Math.round(score * 10) / 10
  };
}

function runSelfTest() {
  const failures = [];
  const caseLike = {
    template: "meeting",
    rawItems: [
      { id: "x1", speakerId: "S12", text: "决定只上快捷键，否决双入口" },
      { id: "x2", speakerId: "S3", text: "林晓负责 PRD，下周五" }
    ],
    mustPreserve: [{ id: "p1", text: "林晓", alts: [] }],
    goldClaims: {
      decisions: [
        {
          id: "d1",
          keywordGroups: [["快捷键"], ["否决", "双入口"]],
          minGroupHits: 2,
          sourceItemIds: ["x1"],
          sourceOverlapMin: 1
        }
      ],
      actionItems: [
        {
          id: "a1",
          keywordGroups: [["林晓"], ["PRD"]],
          minGroupHits: 2,
          sourceItemIds: ["x2"],
          sourceOverlapMin: 1
        }
      ]
    },
    mustNotClaims: [
      {
        id: "bad",
        keywordGroups: [["采用双入口"]],
        minGroupHits: 1,
        paths: ["decisions"]
      }
    ],
    spanCoverage: {
      earlyItemIds: ["x1"],
      midItemIds: ["x2"],
      lateItemIds: ["x2"]
    }
  };

  const good = {
    schema: "meeting_analysis_benchmark_output_v1",
    template: "meeting",
    correctedItems: [
      { sourceItemId: "x1", correctedText: "决定只上快捷键，否决双入口。" },
      { sourceItemId: "x2", correctedText: "林晓负责 PRD，下周五。" }
    ],
    decisions: [
      {
        text: "最终决定 Q3 只上快捷键，否决双入口",
        sourceItemIds: ["x1"]
      }
    ],
    actionItems: [{ text: "林晓写完 PRD", owner: "林晓", due: "下周五", sourceItemIds: ["x2"] }],
    executiveSummary: { text: "否决双入口，只上快捷键", sourceItemIds: ["x1"] }
  };

  const s1 = scoreCase(caseLike, good, { callOk: true, jsonOk: true });
  if (!s1.claims.decisions.hit) failures.push("good_decision_miss");
  if (!s1.claims.actionItems.hit) failures.push("good_action_miss");
  if (!s1.mustNot.clean) failures.push("good_mustnot_false_positive");
  if (s1.mustPreserve.hit < 1) failures.push("good_preserve_miss");
  if (s1.correctedCoverage.ratio < 1) failures.push("good_coverage");
  if (!(s1.compositeScore > 0)) failures.push("good_composite_zero");

  const bad = {
    template: "meeting",
    correctedItems: [{ sourceItemId: "x1", correctedText: "ok" }],
    decisions: [{ text: "采用双入口方案通过", sourceItemIds: ["ghost"] }],
    actionItems: [{ text: "预算五十万", sourceItemIds: ["x1"] }]
  };
  const s2 = scoreCase(caseLike, bad, { callOk: true, jsonOk: true });
  if (s2.mustNot.triggered < 1) failures.push("bad_mustnot_not_triggered");
  if (s2.sourceItemIds.invalidCount < 1) failures.push("bad_source_not_flagged");

  // call/json failure must force composite 0 (no vacuous pass on empty/partial output)
  const sFailCall = scoreCase(caseLike, {}, { callOk: false, jsonOk: false });
  if (sFailCall.compositeScore !== 0) failures.push("fail_call_composite_not_zero");
  if (sFailCall.claims.recall !== 0) failures.push("fail_call_recall_not_zero");

  const sFailJson = scoreCase(caseLike, good, { callOk: true, jsonOk: false });
  if (sFailJson.compositeScore !== 0) failures.push("fail_json_composite_not_zero");
  if (sFailJson.claims.recall !== 0) failures.push("fail_json_recall_not_zero");

  const sFailCallOnly = scoreCase(caseLike, good, { callOk: false, jsonOk: true });
  if (sFailCallOnly.compositeScore !== 0) failures.push("fail_call_only_composite_not_zero");

  // empty personal-ish
  const emptyScore = scoreKeywordClaim(
    { keywordGroups: [["快捷键"]], minGroupHits: 1 },
    [{ path: "t", text: "完全无关", sourceItemIds: [] }]
  );
  if (emptyScore.hit) failures.push("keyword_false_hit");

  // --- schema: correctedText required; correctText typo fails ---
  const typoOut = {
    template: "meeting",
    correctedItems: [{ sourceItemId: "x1", correctText: "typo field" }],
    decisions: [{ text: "只上快捷键", sourceItemIds: ["x1"] }]
  };
  const typoSchema = validateSchema(typoOut);
  if (typoSchema.ok) failures.push("schema_correctText_typo_not_fail");
  if (!typoSchema.errors.some((e) => e.includes("correctedText_not_string"))) {
    failures.push("schema_correctedText_type_not_flagged");
  }
  if (!typoSchema.errors.some((e) => e.includes("wrong_field_correctText"))) {
    failures.push("schema_wrong_field_correctText_not_flagged");
  }
  const emptyIdSchema = validateSchema({
    template: "meeting",
    correctedItems: [{ sourceItemId: "", correctedText: "ok" }],
    decisions: []
  });
  if (emptyIdSchema.ok || !emptyIdSchema.errors.some((e) => e.includes("sourceItemId_empty"))) {
    failures.push("schema_empty_sourceItemId_not_flagged");
  }
  const flaggedBad = validateSchema({
    template: "meeting",
    correctedItems: [{ sourceItemId: "x1", correctedText: "ok" }],
    decisions: [],
    flaggedUncertain: "nope"
  });
  if (flaggedBad.ok || !flaggedBad.errors.includes("flaggedUncertain_not_array")) {
    failures.push("schema_flaggedUncertain_not_array_miss");
  }

  // --- mustNot: path-local claims, no blob, negation protection ---
  const mustNotCase = {
    template: "personal",
    rawItems: [
      {
        id: "b1",
        text: "不是百分之九十二，是百分之八十七点五。不要默认上云端清理"
      }
    ],
    mustPreserve: [],
    goldClaims: {},
    mustNotClaims: [
      {
        id: "mn-acc-92",
        keywordGroups: [
          ["准确率是百分之九十二", "准确率是92%", "百分之九十二决定", "准确率92"]
        ],
        minGroupHits: 1,
        paths: ["coreIdeas", "supportingPoints", "facts", "nextSteps"]
      },
      {
        id: "mn-cloud",
        keywordGroups: [["决定默认上云清理", "默认上云端清理", "必须云端清理"]],
        minGroupHits: 1,
        paths: ["coreIdeas", "nextSteps", "assumptions", "supportingPoints"]
      }
    ]
  };

  const negOut = {
    schema: "meeting_analysis_benchmark_output_v1",
    template: "personal",
    correctedItems: [
      {
        sourceItemId: "b1",
        correctedText: "不是百分之九十二，是百分之八十七点五。不要默认上云端清理"
      }
    ],
    coreIdeas: [
      {
        text: "不是百分之九十二不要默认上云端清理，本地规则先兜底",
        sourceItemIds: ["b1"]
      }
    ],
    facts: [{ text: "准确率是百分之八十七点五", sourceItemIds: ["b1"] }],
    supportingPoints: [],
    nextSteps: []
  };
  const sNeg = scoreCase(mustNotCase, negOut, { callOk: true, jsonOk: true });
  if (!sNeg.mustNot.clean) failures.push("mustnot_negation_false_positive");
  if (sNeg.mustNot.details.some((d) => d.triggered)) {
    failures.push("mustnot_negation_detail_triggered");
  }

  // 无需 / 不必 / 不默认 — must not false-positive
  for (const phrase of ["无需默认上云端清理", "不必默认上云端清理", "不默认上云端清理", "不要默认上云端清理"]) {
    const o = {
      schema: "meeting_analysis_benchmark_output_v1",
      template: "personal",
      correctedItems: [{ sourceItemId: "b1", correctedText: "ok" }],
      coreIdeas: [{ text: phrase, sourceItemIds: ["b1"] }],
      nextSteps: []
    };
    const sn = scoreCase(mustNotCase, o, { callOk: true, jsonOk: true });
    const cloud = sn.mustNot.details.find((d) => d.id === "mn-cloud");
    if (cloud && cloud.triggered) failures.push(`mustnot_wuxu_false_positive:${phrase}`);
  }

  const posOut = {
    schema: "meeting_analysis_benchmark_output_v1",
    template: "personal",
    correctedItems: [{ sourceItemId: "b1", correctedText: "ok" }],
    coreIdeas: [{ text: "准确率是百分之九十二", sourceItemIds: ["b1"] }],
    nextSteps: [{ text: "决定默认上云清理", sourceItemIds: ["b1"] }]
  };
  const sPos = scoreCase(mustNotCase, posOut, { callOk: true, jsonOk: true });
  if (sPos.mustNot.triggered < 2) failures.push("mustnot_positive_assertion_miss");

  // Real positive "默认上云端清理" without negation must trigger
  const realCloud = {
    schema: "meeting_analysis_benchmark_output_v1",
    template: "personal",
    correctedItems: [{ sourceItemId: "b1", correctedText: "ok" }],
    coreIdeas: [{ text: "最终默认上云端清理", sourceItemIds: ["b1"] }],
    nextSteps: []
  };
  const sRealCloud = scoreCase(mustNotCase, realCloud, { callOk: true, jsonOk: true });
  if (!sRealCloud.mustNot.details.find((d) => d.id === "mn-cloud")?.triggered) {
    failures.push("mustnot_real_cloud_positive_miss");
  }

  // Cross-field fragments must not merge into a forbidden claim (no blob fallback)
  const crossOut = {
    schema: "meeting_analysis_benchmark_output_v1",
    template: "personal",
    correctedItems: [{ sourceItemId: "b1", correctedText: "ok" }],
    coreIdeas: [{ text: "提到了百分之", sourceItemIds: ["b1"] }],
    facts: [{ text: "九十二这个数字单独出现", sourceItemIds: ["b1"] }],
    supportingPoints: [{ text: "决定默认", sourceItemIds: ["b1"] }],
    nextSteps: [{ text: "上云清理另说", sourceItemIds: ["b1"] }]
  };
  const sCross = scoreCase(mustNotCase, crossOut, { callOk: true, jsonOk: true });
  if (!sCross.mustNot.clean) failures.push("mustnot_cross_field_blob_false_positive");

  // --- invention: structural ids/schema digits ignored; semantic budget flagged ---
  const structHeavy = {
    schema: "meeting_analysis_benchmark_output_v1",
    template: "meeting",
    correctedItems: [
      { sourceItemId: "x1", correctedText: "决定只上快捷键，否决双入口。", ops: [{ op: "fix", at: 0 }] },
      { sourceItemId: "x2", correctedText: "林晓负责 PRD，下周五。" }
    ],
    decisions: [
      {
        text: "最终决定只上快捷键，否决双入口",
        sourceItemIds: ["x1"],
        speakerId: "S12"
      }
    ],
    actionItems: [
      { text: "林晓写完 PRD", owner: "林晓", due: "下周五", sourceItemIds: ["x2"] }
    ],
    executiveSummary: { text: "否决双入口，只上快捷键", sourceItemIds: ["x1"] },
    flaggedUncertain: []
  };
  const invStruct = scoreForbiddenInvention(structHeavy, caseLike.rawItems, caseLike.mustPreserve);
  if (invStruct.novelNumberCount > 0) {
    failures.push(
      `invention_struct_ids_false_positive:${invStruct.novelNumbers.join(",")}`
    );
  }

  // speakerId / item id structural digits in baseline
  const invSpeaker = scoreForbiddenInvention(
    {
      template: "meeting",
      correctedItems: [{ sourceItemId: "x1", correctedText: "ok" }],
      decisions: [{ text: "引用说话人结构编号", sourceItemIds: ["x1"] }]
    },
    caseLike.rawItems,
    []
  );
  if (invSpeaker.novelNumbers.includes("12") || invSpeaker.novelNumbers.includes("3")) {
    failures.push(`invention_speaker_struct_fp:${invSpeaker.novelNumbers.join(",")}`);
  }

  const inventBudget = {
    schema: "meeting_analysis_benchmark_output_v1",
    template: "meeting",
    correctedItems: [
      { sourceItemId: "x1", correctedText: "决定只上快捷键，否决双入口。" },
      { sourceItemId: "x2", correctedText: "林晓负责 PRD，下周五。" }
    ],
    decisions: [{ text: "只上快捷键", sourceItemIds: ["x1"] }],
    actionItems: [{ text: "申请预算500000元", owner: "林晓", sourceItemIds: ["x2"] }]
  };
  const invSem = scoreForbiddenInvention(inventBudget, caseLike.rawItems, caseLike.mustPreserve);
  if (invSem.novelNumberCount < 1) failures.push("invention_semantic_budget_miss");
  if (!invSem.novelNumbers.some((n) => n === "500000" || n.includes("500000"))) {
    failures.push(`invention_semantic_budget_value:${invSem.novelNumbers.join(",")}`);
  }

  // number equivalence: 一百人/100, 二百八十/280 from raw + mustPreserve whitelist
  const numCaseRaw = [
    { id: "n1", speakerId: "S1", text: "灰度内部一百人，延迟二百八十毫秒峰值四百" }
  ];
  const numMp = [
    { id: "mp100", text: "一百人", alts: ["100人", "100"] },
    { id: "mp280", text: "280", alts: ["二百八十"] }
  ];
  const numOut = {
    template: "meeting",
    correctedItems: [{ sourceItemId: "n1", correctedText: "灰度100人，延迟280毫秒峰值400" }],
    facts: [{ text: "内部100人，平均280峰值400", sourceItemIds: ["n1"] }]
  };
  const invNumEq = scoreForbiddenInvention(numOut, numCaseRaw, numMp);
  if (invNumEq.novelNumberCount > 0) {
    failures.push(`invention_number_equiv_fp:${invNumEq.novelNumbers.join(",")}`);
  }

  // 92 only under negation is not invention; source-mentioned CN form covers 92
  const inv92neg = scoreForbiddenInvention(
    {
      template: "personal",
      correctedItems: [{ sourceItemId: "b1", correctedText: "不是92" }],
      facts: [{ text: "不是百分之九十二，是87.5", sourceItemIds: ["b1"] }]
    },
    mustNotCase.rawItems,
    [{ id: "mp875", text: "87.5", alts: ["百分之八十七点五"] }]
  );
  if (inv92neg.novelNumbers.includes("92")) {
    failures.push("invention_negated_92_false_positive");
  }
  if (inv92neg.novelNumbers.includes("87.5")) {
    failures.push("invention_875_whitelist_miss");
  }

  return {
    ok: failures.length === 0,
    failures,
    sampleGoodScore: s1.compositeScore,
    sampleFailCallScore: sFailCall.compositeScore,
    sampleFailJsonScore: sFailJson.compositeScore
  };
}

module.exports = {
  normText,
  collectClaimTexts,
  scoreCase,
  validateSchema,
  runSelfTest,
  flattenModelBlob,
  semanticTextBlob,
  scoreForbiddenInvention,
  scoreMustNot,
  phraseAsserted,
  collectBaselineNumbers,
  extractAllNumbers
};
