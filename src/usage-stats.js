"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function localDay(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
}

function characterCount(text) {
  let count = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(String(text))) {
    if (segment.trim()) count++;
  }
  return count;
}

function sanitizeState(raw) {
  const days = {};
  for (const [day, value] of Object.entries(raw?.days || {})) {
    if (!DAY.test(day) || !value || !Number.isSafeInteger(value.count) || value.count < 0
      || !Number.isSafeInteger(value.characters) || value.characters < 0) continue;
    days[day] = { count: value.count, characters: value.characters };
  }
  const requests = {};
  for (const [id, day] of Object.entries(raw?.requests || {})) {
    if (REQUEST_ID.test(id) && DAY.test(day)) requests[id] = day;
  }
  return { version: 1, days, requests };
}

function createUsageStats({ directory, now = () => new Date(), fsImpl = fs } = {}) {
  const filename = path.join(directory, "voice-usage.json");
  let state = null;
  let tail = Promise.resolve();
  const run = (task) => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
  async function load() {
    if (state) return;
    try { state = sanitizeState(JSON.parse(await fsImpl.readFile(filename, "utf8"))); }
    catch (error) {
      if (error.code !== "ENOENT") throw Object.assign(new Error("usage_storage_unavailable"), { code: "usage_storage_unavailable" });
      state = sanitizeState(null);
    }
  }
  function summary() {
    const date = now();
    const today = localDay(date);
    const start = new Date(date);
    start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    const weekStart = localDay(start);
    const week = { count: 0, characters: 0 };
    for (const [day, value] of Object.entries(state.days)) {
      if (day >= weekStart && day <= today) {
        week.count += value.count; week.characters += value.characters;
      }
    }
    return { today: { count: 0, characters: 0, ...state.days[today] }, week, day: today, weekStart };
  }
  return {
    get: () => run(async () => { await load(); return summary(); }),
    record: ({ requestId, text } = {}) => run(async () => {
      if (!REQUEST_ID.test(String(requestId || "")) || typeof text !== "string" || !text.trim()) return { recorded: false };
      await load();
      if (state.requests[requestId]) return { recorded: false };
      const date = now();
      const day = localDay(date);
      const cutoff = new Date(date); cutoff.setDate(cutoff.getDate() - 400);
      const oldest = localDay(cutoff);
      const next = sanitizeState(state);
      for (const key of Object.keys(next.days)) if (key < oldest) delete next.days[key];
      for (const id of Object.keys(next.requests)) if (next.requests[id] < oldest) delete next.requests[id];
      const bucket = next.days[day] || { count: 0, characters: 0 };
      next.days[day] = { count: bucket.count + 1, characters: bucket.characters + characterCount(text) };
      next.requests[requestId] = day;
      await fsImpl.mkdir(directory, { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await fsImpl.writeFile(temporary, JSON.stringify(next), "utf8");
      await fsImpl.rename(temporary, filename);
      state = next;
      return { recorded: true };
    })
  };
}

module.exports = { createUsageStats, characterCount, localDay };
