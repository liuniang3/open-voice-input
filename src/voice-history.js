"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_TEXT = 250000;
function historyRecord(payload, previous, date) {
  if (typeof payload?.requestId !== "string" || !REQUEST_ID.test(payload.requestId)) throw new Error("history_invalid_record");
  const rawText = typeof payload.rawText === "string" ? payload.rawText.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!rawText || !text || rawText.length > MAX_TEXT || text.length > MAX_TEXT) throw new Error("history_invalid_record");
  const model = value => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256) : "";
  return {
    version: 1, requestId: payload.requestId, createdAt: previous?.createdAt || date.toISOString(),
    updatedAt: date.toISOString(), rawText, text,
    transcriptionMode: payload.transcriptionMode === "fast" ? "fast" : "stable",
    cleanupApplied: payload.cleanupApplied === true,
    asrModel: model(payload.asrModel), cleanerModel: model(payload.cleanerModel),
    durationMs: Math.max(0, Math.min(86400000, Math.round(Number(payload.durationMs) || 0)))
  };
}

function createVoiceHistory({ directory, fsImpl = fs, now = () => new Date() } = {}) {
  const folder = path.join(directory, "voice-history");
  let tail = Promise.resolve();
  const run = task => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
  function filename(id) {
    if (typeof id !== "string" || !REQUEST_ID.test(id)) throw new Error("history_invalid_record");
    return path.join(folder, `${id}.json`);
  }
  async function read(id) {
    try {
      const file = filename(id);
      const stat = await fsImpl.stat(file);
      if (stat.size > 4 * 1024 * 1024) throw new Error("history_invalid_record");
      const value = JSON.parse(await fsImpl.readFile(file, "utf8"));
      if (value.requestId !== id || value.version !== 1 || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("history_invalid_record");
      return historyRecord(value, value, new Date(value.updatedAt));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  return {
    record: payload => run(async () => {
      const previous = await read(payload?.requestId);
      const entry = historyRecord(payload, previous, now());
      await fsImpl.mkdir(folder, { recursive: true });
      const temporary = path.join(folder, `${entry.requestId}.${randomUUID()}.tmp`);
      await fsImpl.writeFile(temporary, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
      await fsImpl.rename(temporary, filename(entry.requestId));
      return { recorded: true };
    }),
    get: id => run(() => read(id)),
    list: ({ query = "", offset = 0, limit = 40 } = {}) => run(async () => {
      let names;
      try { names = await fsImpl.readdir(folder); }
      catch (error) { if (error.code === "ENOENT") return { entries: [], total: 0 }; throw error; }
      const needle = String(query).slice(0, 500).toLocaleLowerCase();
      const entries = [];
      for (const name of names) {
        const id = name.slice(0, -5);
        if (!name.endsWith(".json") || !REQUEST_ID.test(id)) continue;
        let row;
        try { row = await read(id); } catch { continue; }
        if (!row || needle && !`${row.rawText}\n${row.text}`.toLocaleLowerCase().includes(needle)) continue;
        entries.push({ requestId: id, createdAt: row.createdAt, updatedAt: row.updatedAt,
          transcriptionMode: row.transcriptionMode, cleanupApplied: row.cleanupApplied,
          durationMs: row.durationMs, preview: row.text.slice(0, 160) });
      }
      entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.requestId.localeCompare(b.requestId));
      const start = Math.max(0, Math.floor(Number(offset) || 0));
      const count = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
      return { entries: entries.slice(start, start + count), total: entries.length };
    })
  };
}

module.exports = { createVoiceHistory, historyRecord };
