"use strict";

const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { parseFile, preparePreview } = require("./hotword-import");

function createHotwordImporter({ getStore, chooseFile, parse = parseFile, now = Date.now }) {
  const pending = new WeakMap(), busy = new WeakSet();
  function clear(sender) {
    const previous = pending.get(sender);
    if (previous) clearTimeout(previous.timer);
    pending.delete(sender);
  }
  return {
    async preview(sender) {
      if (busy.has(sender)) throw new Error("hotwords_import_busy");
      busy.add(sender);
      clear(sender);
      try {
        const file = await chooseFile(sender);
        if (!file) return null;
        const values = await parse(file);
        const preview = preparePreview(values, await getStore().get());
        const token = randomUUID();
        const timer = setTimeout(() => clear(sender), 10 * 60 * 1000);
        timer.unref?.();
        pending.set(sender, { token, words: preview.words, expires: now() + 10 * 60 * 1000, timer });
        return { token, fileName: path.basename(file), ...preview };
      } finally { busy.delete(sender); }
    },
    async commit(sender, payload) {
      if (busy.has(sender)) throw new Error("hotwords_import_busy");
      const preview = pending.get(sender);
      if (!preview || preview.token !== payload?.token || preview.expires <= now()) throw new Error("hotwords_import_expired");
      // Reject concurrent submissions, but retain a failed preview for retry.
      busy.add(sender);
      try {
        const result = await getStore().importWords(preview.words);
        clear(sender);
        return result;
      } finally { busy.delete(sender); }
    }
  };
}

module.exports = { createHotwordImporter };
