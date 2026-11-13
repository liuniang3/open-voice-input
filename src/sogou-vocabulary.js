"use strict";

const { TextDecoder } = require("node:util");

// SGPU format reference: studyzy/imewlconverter, SougouBinParser.NewParser.
// https://github.com/studyzy/imewlconverter/blob/6fda92c20a9d14f890b6a9f074ec069f38a29899/src/ImeWlConverter.Formats/SougouBin/SougouBinParser.cs
// Upstream credits nopdan/rose (SGPU) and h4x3rotab (older encrypted format),
// with their copyright and GNU GPL v3.0 notices. This independently implements
// the binary layout without including upstream code or pinyin tables.
// Only SGPU is supported; unknown metadata and reserved space remain opaque.

const FORMAT_ERROR = "hotwords_import_sogou_format";
const HEADER_SIZE = 0x50;
const MIN_RECORD_SIZE = 17; // 15 fixed bytes plus one UTF-16 code unit.
const decoder = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true });

function requireFormat(condition) {
  if (!condition) throw new Error(FORMAT_ERROR);
}

/** Return one word per SGPU index entry, preserving order and duplicates. */
function parseSogou(buffer) {
  requireFormat(Buffer.isBuffer(buffer) && buffer.length >= HEADER_SIZE);
  requireFormat(buffer.readUInt32LE(0) === 0x55504753);
  const indexStart = buffer.readUInt32LE(0x38);
  const indexCapacity = buffer.readUInt32LE(0x3c);
  const count = buffer.readUInt32LE(0x40);
  const dataStart = buffer.readUInt32LE(0x44);
  const dataCapacity = buffer.readUInt32LE(0x48);
  const dataUsed = buffer.readUInt32LE(0x4c);

  // Capacities include spare space; only count entries and dataUsed are live.
  requireFormat(indexStart >= HEADER_SIZE && indexStart <= buffer.length);
  requireFormat(indexCapacity % 4 === 0 && indexCapacity <= buffer.length - indexStart);
  requireFormat(count <= indexCapacity / 4);
  requireFormat(dataStart >= indexStart + indexCapacity && dataStart <= buffer.length);
  requireFormat(dataCapacity <= buffer.length - dataStart && dataUsed <= dataCapacity);
  requireFormat(count <= Math.floor(dataUsed / MIN_RECORD_SIZE));

  const dataEnd = dataStart + dataUsed;
  const records = [];
  for (let i = 0; i < count; i++) {
    const relative = buffer.readUInt32LE(indexStart + i * 4);
    requireFormat(relative <= dataUsed - MIN_RECORD_SIZE);
    const start = dataStart + relative;
    const pinyinBytes = buffer.readUInt16LE(start + 9);
    requireFormat(pinyinBytes % 2 === 0 && pinyinBytes <= dataEnd - start - MIN_RECORD_SIZE);
    const wordStart = start + 15 + pinyinBytes;
    const wordBytes = buffer.readUInt16LE(wordStart - 2);
    requireFormat(wordBytes > 0 && wordBytes % 2 === 0 && wordBytes <= dataEnd - wordStart);
    records.push({ start, wordStart, end: wordStart + wordBytes });
  }

  // Validate unordered spans before decoding, bounding work for bad pointers.
  const physicalOrder = records.slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < physicalOrder.length; i++) {
    requireFormat(physicalOrder[i].start >= physicalOrder[i - 1].end);
  }
  const words = [];
  for (const record of records) {
    try {
      words.push(decoder.decode(buffer.subarray(record.wordStart, record.end)));
    } catch {
      // Do not expose source bytes or decoder exceptions to callers.
      throw new Error(FORMAT_ERROR);
    }
  }
  return words;
}

module.exports = { parseSogou };
