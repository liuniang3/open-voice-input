"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const LIMIT = 100;
const LIBRARY_LIMIT = 100000;
const MAX_TERM = 80;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /(?:\b(?:sk|tp|ghp|github_pat)[-_][\w-]{12,}|\bLTAI\w{12,})/i;
const GENERIC = /^(?:不|没|没有|可以|不能|不要|需要|应该|这个|那个|我们|你们|他们|然后|就是|今天|明天|同意|不同意|是|不是|true|false|yes|no)$/i;

function term(value) {
  if (typeof value !== "string" || value.length > MAX_TERM * 2 || /[\r\n\x00-\x1f\x7f<>]/.test(value)) throw new Error("hotword_invalid_term");
  const text = value.normalize("NFC").trim().replace(/ +/g, " ");
  if (!text || [...text].length > MAX_TERM || KEY.test(text) || !/^[\p{L}\p{N} .+#_&'’()/-]+$/u.test(text) || !/\p{L}/u.test(text)) {
    throw new Error("hotword_invalid_term");
  }
  if (/[^\x00-\x7f]/.test(text) ? [...text].length > 15 : text.split(" ").length > 7) throw new Error("hotword_invalid_term");
  if (["__proto__", "prototype", "constructor"].includes(text.toLowerCase())) throw new Error("hotword_invalid_term");
  return text;
}

function normalizeWords(words) {
  if (!Array.isArray(words)) return [];
  const seen = new Set();
  const result = [];
  for (const value of words.slice(0, LIMIT)) {
    try {
      const text = term(value);
      const key = text.toLowerCase();
      if (!seen.has(key)) { seen.add(key); result.push(text); }
    } catch { /* Unsupported terms never become provider parameters. */ }
  }
  return result;
}

function instantVocabulary(model, words, baseUrl = "") {
  if (!/^qwen-audio-3\.0-asr-flash-streaming(?:-\d{4}-\d{2}-\d{2})?$/.test(String(model))) return undefined;
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname;
      if (host === "dashscope-us.aliyuncs.com" || /\.us-east-1\.maas\.aliyuncs\.com$/.test(host) ||
          /\.ap-southeast-1\.maas\.aliyuncs\.com$/.test(host)) return undefined;
    } catch { return undefined; }
  }
  const terms = normalizeWords(words);
  return terms.length ? Object.fromEntries(terms.map(text => [text, 4])) : undefined;
}

// Persist only a short substitution candidate, never the observed input field.
function correctionCandidate(before, after) {
  if (typeof before !== "string" || typeof after !== "string" || before === after ||
      before.length > 8000 || after.length > 8000 || before.length < 8 || after.length < 8 ||
      KEY.test(before) || KEY.test(after)) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  if (!start || !tail || before.length === start + tail || after.length === start + tail) return null;
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const segments = value => [...segmenter.segment(value)].filter(part => part.isWordLike);
  const left = segments(before), right = segments(after);
  const starts = [left, right].map(parts => parts.find(part => part.index <= start && start < part.index + part.segment.length)?.index ?? start);
  start = Math.min(...starts);
  const tails = [[left, before], [right, after]].map(([parts, value]) => {
    const end = value.length - tail;
    const part = parts.find(part => part.index < end && end <= part.index + part.segment.length);
    return part ? value.length - part.index - part.segment.length : tail;
  });
  tail = Math.min(...tails);
  // Segmenters split unfamiliar Chinese names into single characters. Extend
  // only a shared adjacent one-character token; never learn a lone character.
  if (before.length - start - tail === 1 && after.length - start - tail === 1) {
    const a = left.find(part => part.index === before.length - tail);
    const b = right.find(part => part.index === after.length - tail);
    if (a && b && a.segment === b.segment && /^\p{Script=Han}$/u.test(a.segment) &&
        !/^[的了是在与和或不没吗啊呀着过地得]$/.test(a.segment)) tail--;
  }
  if (start + tail < 6) return null;
  const from = before.slice(start, before.length - tail);
  const to = after.slice(start, after.length - tail);
  if (Math.min([...from].length, [...to].length) < 2 || Math.max(from.length, to.length) > 24 || Math.max(from.length, to.length) > Math.max(before.length, after.length) * 0.4 ||
      /\d/.test(from + to) || GENERIC.test(from) || GENERIC.test(to) || from.trim() !== from || to.trim() !== to) return null;
  try {
    if (term(from) !== from || term(to) !== to || segments(to).length > 4 || segments(from).length > 4) return null;
  } catch { return null; }
  return { from, to };
}

function createHotwordStore({ directory, fsImpl = fs, platform = process.platform } = {}) {
  const file = path.join(directory, "hotwords.json");
  let state = { version: 1, enabled: true, observeCorrections: false, entries: [], candidates: [], dismissed: [] };
  let loaded;
  let tail = Promise.resolve();
  function validate(data) {
    if (!data || data.version !== 1 || typeof data.enabled !== "boolean" || typeof data.observeCorrections !== "boolean" ||
        !Array.isArray(data.entries) || !Array.isArray(data.candidates) || !Array.isArray(data.dismissed) ||
        data.entries.length > LIBRARY_LIMIT || data.candidates.length > LIMIT || data.dismissed.length > 200) throw new Error("hotwords_invalid_store");
    for (const entry of data.entries) {
      if (!ID.test(entry.id) || term(entry.text) !== entry.text || typeof entry.enabled !== "boolean") throw new Error("hotwords_invalid_store");
    }
    for (const item of data.candidates) {
      if (!ID.test(item.id) || term(item.from) !== item.from || term(item.to) !== item.to || !Number.isSafeInteger(item.count) || item.count < 1) throw new Error("hotwords_invalid_store");
    }
    if (new Set(data.entries.map(entry => entry.id)).size !== data.entries.length ||
        new Set(data.entries.map(entry => entry.text.toLowerCase())).size !== data.entries.length ||
        new Set(data.candidates.map(item => item.id)).size !== data.candidates.length) throw new Error("hotwords_invalid_store");
    if (data.dismissed.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error("hotwords_invalid_store");
    // Drop unknown fields on load as well as on write.
    return { version: 1, enabled: data.enabled, observeCorrections: data.observeCorrections,
      entries: data.entries.map(({ id, text, enabled }) => ({ id, text, enabled })),
      candidates: data.candidates.map(({ id, from, to, count }) => ({ id, from, to, count })), dismissed: [...data.dismissed] };
  }
  function ready() {
    return loaded ||= (async () => {
      try {
        if ((await fsImpl.stat(file)).size > 32 * 1024 * 1024) throw new Error("hotwords_invalid_store");
        state = validate(JSON.parse(await fsImpl.readFile(file, "utf8")));
      } catch (error) {
        if (error.code !== "ENOENT") { state.enabled = false; throw new Error("hotwords_unavailable"); }
      }
    })();
  }
  const observationAvailable = platform === "win32";
  const snapshot = () => ({ enabled: state.enabled, observeCorrections: state.observeCorrections && observationAvailable,
    observationAvailable, limit: LIBRARY_LIMIT, requestLimit: LIMIT, entries: state.entries.map(entry => ({ ...entry })), candidates: state.candidates.map(item => ({ ...item })) });
  const pairHash = ({ from, to }) => createHash("sha256").update(JSON.stringify([from, to])).digest("hex");
  function run(task) {
    const next = tail.then(async () => { await ready(); return task(); });
    tail = next.catch(() => {});
    return next;
  }
  async function save(next) {
    const data = validate(next);
    await fsImpl.mkdir(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fsImpl.writeFile(temporary, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    await fsImpl.rename(temporary, file);
    state = data;
  }
  function upsert(next, payload) {
    const text = term(payload.text);
    const existing = payload.id ? next.entries.find(entry => entry.id === payload.id) : next.entries.find(entry => entry.text.toLowerCase() === text.toLowerCase());
    if (payload.id && !existing) throw new Error("hotword_not_found");
    if (next.entries.some(entry => entry.id !== existing?.id && entry.text.toLowerCase() === text.toLowerCase())) throw new Error("hotword_duplicate");
    if (payload.enabled !== false && !existing?.enabled && next.entries.filter(entry => entry.enabled).length >= LIMIT) throw new Error("hotwords_active_limit");
    if (existing) { existing.text = text; existing.enabled = payload.enabled !== false; }
    else {
      if (next.entries.length >= LIBRARY_LIMIT) throw new Error("hotwords_limit");
      next.entries.push({ id: randomUUID(), text, enabled: payload.enabled !== false });
    }
  }
  return {
    ready,
    get: () => run(() => snapshot()),
    words: () => state.enabled ? state.entries.filter(entry => entry.enabled).slice(0, LIMIT).map(entry => entry.text) : [],
    canObserve: () => observationAvailable && state.enabled && state.observeCorrections,
    update: payload => run(async () => {
      const next = structuredClone(state);
      if (payload?.action === "configure") {
        for (const key of ["enabled", "observeCorrections"]) {
          if (payload[key] !== undefined) {
            if (typeof payload[key] !== "boolean") throw new Error("hotwords_invalid_action");
            next[key] = payload[key];
          }
        }
        if (!observationAvailable) next.observeCorrections = false;
      } else if (payload?.action === "upsert") upsert(next, payload);
      else if (payload?.action === "remove") {
        if (!next.entries.some(entry => entry.id === payload.id)) throw new Error("hotword_not_found");
        next.entries = next.entries.filter(entry => entry.id !== payload.id);
      } else if (payload?.action === "removeMany") {
        if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > LIBRARY_LIMIT || payload.ids.some(id => typeof id !== "string" || !ID.test(id))) throw new Error("hotwords_invalid_action");
        const ids = new Set(payload.ids);
        next.entries = next.entries.filter(entry => !ids.has(entry.id));
      } else if (payload?.action === "accept" || payload?.action === "dismiss") {
        const candidate = next.candidates.find(item => item.id === payload.id);
        if (!candidate) throw new Error("hotword_not_found");
        if (payload.action === "accept") upsert(next, { text: candidate.to });
        else next.dismissed = [...new Set([...next.dismissed, pairHash(candidate)])].slice(-200);
        next.candidates = next.candidates.filter(item => item.id !== payload.id);
      } else throw new Error("hotwords_invalid_action");
      await save(next);
      return snapshot();
    }),
    importWords: words => run(async () => {
      if (!Array.isArray(words) || words.length > LIBRARY_LIMIT) throw new Error("hotwords_limit");
      const seen = new Set(state.entries.map(entry => entry.text.toLowerCase()));
      const additions = [];
      for (const value of words) {
        const text = term(value), key = text.toLowerCase();
        if (!seen.has(key)) { seen.add(key); additions.push(text); }
      }
      if (state.entries.length + additions.length > LIBRARY_LIMIT) throw new Error("hotwords_limit");
      const next = structuredClone(state);
      let enabled = next.entries.filter(entry => entry.enabled).length;
      for (const text of additions) next.entries.push({ id: randomUUID(), text, enabled: enabled++ < LIMIT });
      await save(next);
      return snapshot();
    }),
    recordCorrection: ({ before, after }) => run(async () => {
      if (!observationAvailable || !state.enabled || !state.observeCorrections) return false;
      const pair = correctionCandidate(before, after);
      if (!pair || state.dismissed.includes(pairHash(pair)) || state.entries.some(entry => entry.text.toLowerCase() === pair.to.toLowerCase())) return false;
      const next = structuredClone(state);
      const existing = next.candidates.find(item => item.from === pair.from && item.to === pair.to);
      if (existing) existing.count = Math.min(existing.count + 1, 999);
      else {
        if (next.candidates.length >= LIMIT) return false;
        next.candidates.push({ id: randomUUID(), ...pair, count: 1 });
      }
      await save(next);
      return true;
    })
  };
}

module.exports = { createHotwordStore, correctionCandidate, instantVocabulary, normalizeWords, term, LIBRARY_LIMIT };
