"use strict";

const { execFile } = require("node:child_process");

function validRect(rect) {
  return rect && ["x", "y", "width", "height"].every(key => Number.isFinite(rect[key])) &&
    Math.abs(rect.x) < 200000 && Math.abs(rect.y) < 200000 &&
    rect.width >= 0 && rect.height > 0 && rect.width < 200000 && rect.height < 200000;
}

function parseInputContext(stdout) {
  let result = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value.type !== "input-context" || !/^[1-9]\d{0,19}$/.test(value.target) ||
          !["physical", "dip"].includes(value.coordinateSpace)) continue;
      if (result && result.target !== value.target) continue;
      result = { target: value.target, coordinateSpace: value.coordinateSpace,
        rect: validRect(value.rect) ? value.rect : null,
        windowRect: validRect(value.windowRect) ? value.windowRect : null,
        source: ["caret", "input"].includes(value.source) ? value.source : null };
    } catch { /* A timed-out helper may leave its final JSON line incomplete. */ }
  }
  return result;
}

// The first flushed line preserves the paste target even if an accessibility provider hangs.
function readInputContext({ helperPath, execFileImpl = execFile, timeout = 700 } = {}) {
  return new Promise(resolve => {
    try {
      execFileImpl(helperPath, ["--input-context"], {
        encoding: "utf8", windowsHide: true, timeout, maxBuffer: 8192
      }, (_error, stdout) => resolve(parseInputContext(stdout)));
    } catch { resolve(null); }
  });
}

function toDip(rect, context, screen) {
  if (!validRect(rect)) return null;
  if (context.coordinateSpace !== "physical") return rect;
  try {
    const rounded = Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value)]));
    rounded.width = Math.max(1, rounded.width);
    rounded.height = Math.max(1, rounded.height);
    const converted = screen.screenToDipRect(null, rounded);
    return validRect(converted) ? converted : null;
  } catch { return null; }
}

function dictationBounds(context, size, screen) {
  let anchor = context?.source ? toDip(context.rect, context, screen) : null;
  const windowRect = context ? toDip(context.windowRect, context, screen) : null;
  if (anchor && windowRect && (anchor.x + anchor.width < windowRect.x ||
      anchor.y + anchor.height < windowRect.y || anchor.x > windowRect.x + windowRect.width ||
      anchor.y > windowRect.y + windowRect.height)) anchor = null;
  let display;
  if (anchor) {
    display = screen.getDisplayMatching({ x: Math.round(anchor.x), y: Math.round(anchor.y),
      width: Math.max(1, Math.round(anchor.width)), height: Math.max(1, Math.round(anchor.height)) });
    const area = display.workArea;
    if (anchor.x + anchor.width < area.x || anchor.y + anchor.height < area.y ||
        anchor.x > area.x + area.width || anchor.y > area.y + area.height) anchor = null;
  }
  if (!anchor) display = windowRect ? screen.getDisplayMatching(windowRect)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const width = size.width;
  const height = size.height;
  const gap = 10;
  const margin = 8;
  const clamp = (value, start, available, extent) =>
    Math.round(Math.max(start + margin, Math.min(value, start + available - extent - margin)));
  let x = area.x + (area.width - width) / 2;
  let y = area.y + (area.height - height) / 2;
  if (anchor) {
    x = anchor.x - gap;
    const below = anchor.y + anchor.height + gap;
    const above = anchor.y - height - gap;
    y = below + height <= area.y + area.height - margin ? below : above;
  }
  return { x: clamp(x, area.x, area.width, width), y: clamp(y, area.y, area.height, height), width, height };
}

module.exports = { readInputContext, parseInputContext, dictationBounds };
