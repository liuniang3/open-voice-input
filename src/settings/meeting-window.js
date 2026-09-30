"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const DEFAULT_PRESENTATION = Object.freeze({ fontSize: 14, opacity: 0.9, normalBounds: null });

function minimalBounds(bounds) {
  return bounds.width < 420 || bounds.height < 260;
}

function normalizePresentation(value = {}) {
  const bounds = value.normalBounds;
  const opacity = Number(value.opacity ?? DEFAULT_PRESENTATION.opacity);
  const normalBounds = bounds && ["x", "y", "width", "height"].every(key => Number.isFinite(bounds[key]))
    && bounds.width >= 420 && bounds.height >= 260 && bounds.width <= 6000 && bounds.height <= 4000
    ? Object.fromEntries(["x", "y", "width", "height"].map(key => [key, Math.round(bounds[key])])) : null;
  return { fontSize: Math.min(28, Math.max(12, Number(value.fontSize) || 14)),
    opacity: Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : DEFAULT_PRESENTATION.opacity)), normalBounds };
}

function visibleBounds(bounds, area) {
  if (!area) return bounds;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return { width, height, x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)) };
}

function createMeetingWindowStore(directory, fsImpl = fs) {
  const filename = path.join(directory, "meeting-window.json");
  let tail = Promise.resolve();
  return {
    async read() {
      try { return normalizePresentation(JSON.parse(await fsImpl.readFile(filename, "utf8"))); }
      catch { return { ...DEFAULT_PRESENTATION }; }
    },
    write(value) {
      const snapshot = normalizePresentation(value);
      const next = tail.then(async () => {
        await fsImpl.mkdir(directory, { recursive: true });
        const temporary = `${filename}.${randomUUID()}.tmp`;
        await fsImpl.writeFile(temporary, JSON.stringify(snapshot), "utf8");
        await fsImpl.rename(temporary, filename);
      });
      tail = next.catch(() => {});
      return next;
    },
    flush: () => tail
  };
}

module.exports = { DEFAULT_PRESENTATION, normalizePresentation, minimalBounds, visibleBounds, createMeetingWindowStore };
