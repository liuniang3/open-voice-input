"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { parseSogou } = require("../src/sogou-vocabulary");

// Synthetic tests run by default, including CI. Opt in to a local backup:
// node scripts/test-sogou-vocabulary.js --file <path>
// Private inputs are never printed, saved, uploaded or used in assertion diffs.

function fixture(words, { order = words.map((_, i) => i), padding = 8, gap = 4 } = {}) {
  const records = words.map(word => {
    const text = Buffer.from(word, "utf16le");
    const record = Buffer.alloc(19 + text.length);
    record.writeUInt16LE(4, 9); // Two pinyin IDs, expressed as a byte length.
    record.writeUInt16LE(1, 11);
    record.writeUInt16LE(2, 13);
    record.writeUInt16LE(text.length, 17);
    text.copy(record, 19);
    return record;
  });
  const indexStart = 140;
  const indexCapacity = order.length * 4 + padding;
  const dataStart = indexStart + indexCapacity;
  const dataUsed = records.reduce((size, record) => size + record.length + gap, 0);
  const buffer = Buffer.alloc(dataStart + dataUsed + padding, 0xa5);
  buffer.fill(0, 0, indexStart);
  buffer.write("SGPU", 0, "ascii");
  buffer.writeUInt32LE(indexStart, 0x38);
  buffer.writeUInt32LE(indexCapacity, 0x3c);
  buffer.writeUInt32LE(order.length, 0x40);
  buffer.writeUInt32LE(dataStart, 0x44);
  buffer.writeUInt32LE(dataUsed + padding, 0x48);
  buffer.writeUInt32LE(dataUsed, 0x4c);
  const offsets = [];
  let offset = 0;
  for (const record of records) {
    offsets.push(offset);
    record.copy(buffer, dataStart + offset);
    offset += record.length + gap;
  }
  order.forEach((recordIndex, i) => buffer.writeUInt32LE(offsets[recordIndex], indexStart + i * 4));
  return { buffer, indexStart, dataStart, dataUsed, offsets };
}

let rejected = 0;
function invalid(value) {
  assert.throws(() => parseSogou(value), error =>
    error instanceof Error && error.message === "hotwords_import_sogou_format" && !error.cause);
  rejected++;
}

function syntheticTests() {
  const words = ["\u6d4b\u8bd5", "SGPU", "\ud840\udc00", "\u6d4b\u8bd5", "\ufeffBOM"];
  const sample = fixture(words, { order: [4, 2, 0, 3, 1] });
  const { buffer, indexStart, dataStart, dataUsed, offsets } = sample;
  const expected = [words[4], words[2], words[0], words[3], words[1]];
  const before = Buffer.from(buffer);
  assert.deepEqual(parseSogou(buffer), expected);
  assert.deepEqual(buffer, before, "input must remain immutable");
  assert.deepEqual(parseSogou(Buffer.concat([Buffer.alloc(7), buffer]).subarray(7)), expected);
  assert.deepEqual(parseSogou(fixture([]).buffer), []);
  assert.deepEqual(parseSogou(fixture(["A"], { padding: 0, gap: 0 }).buffer), ["A"]);
  const empty = Buffer.alloc(80);
  empty.write("SGPU", 0, "ascii");
  empty.writeUInt32LE(80, 0x38);
  empty.writeUInt32LE(80, 0x44);
  assert.deepEqual(parseSogou(empty), []);
  const verbatim = [" A ", "\ufffd", "\u0100", "A\u0000B"];
  assert.deepEqual(parseSogou(fixture(verbatim).buffer), verbatim, "no normalization or term filtering");

  // Zero pinyin IDs is allowed; only words are returned.
  const noPinyin = fixture(["x"], { padding: 0, gap: 0 });
  noPinyin.buffer.writeUInt16LE(0, noPinyin.dataStart + 9);
  noPinyin.buffer.writeUInt16LE(2, noPinyin.dataStart + 13);
  noPinyin.buffer.writeUInt16LE(0x41, noPinyin.dataStart + 15);
  assert.deepEqual(parseSogou(noPinyin.buffer), ["A"]);

  for (const value of [undefined, null, 0, "SGPU", {}, [], new Uint8Array(buffer)]) invalid(value);
  for (let length = 0; length < buffer.length; length++) invalid(buffer.subarray(0, length));
  function mutate(edit) { const copy = Buffer.from(buffer); edit(copy); invalid(copy); }
  mutate(copy => copy.write("SCEL", 0, "ascii"));
  for (const [field, values] of [
    [0x38, [0, 79, 0xffffffff]],
    [0x3c, [1, 4, 0xffffffff]],
    [0x40, [100, 0xffffffff]],
    [0x44, [0, indexStart, dataStart - 1, 0xffffffff]],
    [0x48, [dataUsed - 1, 0xffffffff]],
    [0x4c, [0, 16, dataUsed + 9, 0xffffffff]]
  ]) {
    for (const value of values) mutate(copy => copy.writeUInt32LE(value, field));
  }
  for (const value of [dataUsed - 1, dataUsed, dataUsed + 1, 0xffffffff]) {
    mutate(copy => copy.writeUInt32LE(value, indexStart));
  }
  mutate(copy => copy.writeUInt32LE(copy.readUInt32LE(indexStart + 4), indexStart));
  for (const value of [1, 3, 0xfffe, 0xffff]) mutate(copy => copy.writeUInt16LE(value, dataStart + 9));
  for (const value of [0, 1, 3, 0xfffe, 0xffff]) mutate(copy => copy.writeUInt16LE(value, dataStart + 17));
  // A length crossing into another indexed record is invalid.
  mutate(copy => copy.writeUInt16LE(offsets[1] + 1, dataStart + 17));
  mutate(copy => { copy.writeUInt32LE(3, 0x40); copy.writeUInt32LE(34, 0x4c); });
  // A word may not consume allocated but unused data bytes.
  const lastStart = dataStart + offsets[offsets.length - 1];
  mutate(copy => copy.writeUInt16LE(dataStart + dataUsed - (lastStart + 19) + 2, lastStart + 17));
  for (const badText of ["\ud800", "\udc00", "\ud800A", "A\udc00"]) invalid(fixture([badText]).buffer);
  invalid(fixture([""]).buffer);
  assert.deepEqual(parseSogou(buffer), expected, "decoder recovers after invalid UTF-16");

  const hidden = fixture(["visible", "unindexed"], { order: [0] });
  assert.deepEqual(parseSogou(hidden.buffer), ["visible"], "unindexed strings must not be scanned");
  const many = Array.from({ length: 1000 }, (_, i) => `term${i}`);
  const reverse = many.map((_, i) => many.length - i - 1);
  assert.deepEqual(parseSogou(fixture(many, { order: reverse }).buffer), many.slice().reverse());
  console.log(`SGPU synthetic tests passed; malformed inputs rejected: ${rejected}`);
}

function localFileTest(filePath) {
  // Catch private-file failures below without printing assertions or paths.
  const buffer = fs.readFileSync(filePath);
  const words = parseSogou(buffer);
  const count = buffer.readUInt32LE(0x40);
  assert.equal(words.length, count);
  assert.ok(words.every(word => typeof word === "string" && word.length > 0));
  console.log(JSON.stringify({ format: "SGPU", bytes: buffer.length, records: count,
    parsed: words.length, unique: new Set(words).size,
    indexCapacity: buffer.readUInt32LE(0x3c), dataUsed: buffer.readUInt32LE(0x4c),
    dataCapacity: buffer.readUInt32LE(0x48) }));
}

syntheticTests();
if (process.argv.length > 2) {
  if (process.argv.length !== 4 || process.argv[2] !== "--file") {
    console.error("Usage: node scripts/test-sogou-vocabulary.js [--file <local-backup.bin>]");
    process.exitCode = 1;
  } else {
    try { localFileTest(process.argv[3]); }
    catch {
      console.error("SGPU local validation failed; file contents and path withheld.");
      process.exitCode = 1;
    }
  }
}
