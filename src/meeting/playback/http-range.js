"use strict";

/**
 * Pure HTTP Range helpers for single-byte-range WAV playback.
 * Spec: one contiguous range only; multi-range → 416.
 */

function parseBytesRange(rangeHeader, size) {
  const total = Math.max(0, Math.floor(Number(size) || 0));
  if (!rangeHeader || typeof rangeHeader !== "string") {
    return { ok: true, full: true, start: 0, end: total > 0 ? total - 1 : 0, total };
  }
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(rangeHeader.trim());
  if (!m) {
    // multi-range or unit other than bytes
    if (/,/.test(rangeHeader) || !/bytes/i.test(rangeHeader)) {
      return { ok: false, code: 416, total };
    }
    return { ok: false, code: 416, total };
  }
  const startRaw = m[1];
  const endRaw = m[2];
  if (total <= 0) {
    return { ok: false, code: 416, total: 0 };
  }
  let start;
  let end;
  if (startRaw === "" && endRaw === "") {
    return { ok: false, code: 416, total };
  }
  if (startRaw === "") {
    // suffix: bytes=-N
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return { ok: false, code: 416, total };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? total - 1 : Number(endRaw);
    if (!Number.isFinite(start) || start < 0) return { ok: false, code: 416, total };
    if (!Number.isFinite(end) || end < start) return { ok: false, code: 416, total };
    if (start >= total) return { ok: false, code: 416, total };
    end = Math.min(end, total - 1);
  }
  return { ok: true, full: false, start, end, total };
}

function contentRangeHeader(start, end, total) {
  return `bytes ${start}-${end}/${total}`;
}

function buildPlaybackHeaders({ method = "GET", size, rangeHeader = null, contentType = "audio/wav" } = {}) {
  const total = Math.max(0, Math.floor(Number(size) || 0));
  const base = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  };
  const isHead = String(method || "GET").toUpperCase() === "HEAD";

  if (!rangeHeader) {
    return {
      status: 200,
      headers: {
        ...base,
        "Content-Length": String(total)
      },
      start: 0,
      end: total > 0 ? total - 1 : 0,
      length: total,
      isHead
    };
  }

  const parsed = parseBytesRange(rangeHeader, total);
  if (!parsed.ok) {
    return {
      status: 416,
      headers: {
        ...base,
        "Content-Range": `bytes */${total}`,
        "Content-Length": "0"
      },
      start: 0,
      end: -1,
      length: 0,
      isHead
    };
  }
  if (parsed.full) {
    return {
      status: 200,
      headers: {
        ...base,
        "Content-Length": String(total)
      },
      start: 0,
      end: total > 0 ? total - 1 : 0,
      length: total,
      isHead
    };
  }
  const length = parsed.end - parsed.start + 1;
  return {
    status: 206,
    headers: {
      ...base,
      "Content-Range": contentRangeHeader(parsed.start, parsed.end, parsed.total),
      "Content-Length": String(length)
    },
    start: parsed.start,
    end: parsed.end,
    length,
    isHead
  };
}

module.exports = {
  parseBytesRange,
  contentRangeHeader,
  buildPlaybackHeaders
};
