"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { term, LIBRARY_LIMIT } = require("./hotwords");
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 100000;
const HEADERS = /^(?:词条|词语|词汇|热词|关键词|词|word|words|term|terms|hotword|hotwords|vocabulary)$/i;

function decodeText(buffer) {
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(buffer.subarray(2));
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(buffer.subarray(2));
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { return new TextDecoder("gb18030", { fatal: true }).decode(buffer); }
  } catch { throw new Error("hotwords_import_encoding"); }
}

function tableWords(rows) {
  let column = 0, first = true;
  const words = [];
  for (const row of rows) {
    if (!row.some(cell => String(cell ?? "").trim())) continue;
    if (first) {
      first = false;
      const header = row.findIndex(cell => HEADERS.test(String(cell ?? "").trim()));
      if (header >= 0) { column = header; continue; }
    }
    const value = row[column];
    words.push(typeof value === "string" ? value.trim() : "");
    if (words.length > MAX_ROWS) throw new Error("hotwords_import_too_many_rows");
  }
  return words;
}

// Bound both declared and actual inflated ZIP bytes before parsing XML.
function checkWorkbookZip(buffer) {
  return new Promise((resolve, reject) => {
    require("yauzl").fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(new Error("hotwords_import_format"));
      let size = 0, actual = 0, count = 0;
      const fail = code => { zip.close(); reject(new Error(code)); };
      zip.on("error", () => fail("hotwords_import_format"));
      zip.on("end", resolve);
      zip.on("entry", entry => {
        size += entry.uncompressedSize;
        if (++count > 10000 || size > 64 * 1024 * 1024 || (entry.generalPurposeBitFlag & 1)) {
          fail("hotwords_import_workbook_limit"); return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { fail("hotwords_import_format"); return; }
          stream.on("error", () => fail("hotwords_import_format"));
          stream.on("data", chunk => {
            actual += chunk.length;
            if (actual > 64 * 1024 * 1024) { stream.destroy(); fail("hotwords_import_workbook_limit"); }
          });
          stream.on("end", () => zip.readEntry());
        });
      });
      zip.readEntry();
    });
  });
}

async function parseVocabulary(buffer, extension) {
  if (!buffer.length || buffer.length > MAX_BYTES) throw new Error("hotwords_import_size");
  let words;
  if (extension === ".bin") words = require("./sogou-vocabulary").parseSogou(buffer);
  else if (extension === ".txt") words = decodeText(buffer).split(/\r\n|\r|\n/).map(value => value.trim()).filter(Boolean);
  else if (extension === ".csv" || extension === ".tsv") {
    const rows = require("csv-parse/sync").parse(decodeText(buffer), {
      bom: true, delimiter: extension === ".tsv" ? "\t" : ",", skip_empty_lines: true,
      relax_column_count: true, max_record_size: 16384, to: MAX_ROWS + 2
    });
    if (rows.length > MAX_ROWS + 1) throw new Error("hotwords_import_too_many_rows");
    words = tableWords(rows);
  } else if (extension === ".xlsx") {
    await checkWorkbookZip(buffer);
    const sheets = await require("read-excel-file/node")(buffer);
    words = [];
    let rowsSeen = 0;
    for (const sheet of sheets) {
      rowsSeen += sheet.data.length;
      if (rowsSeen > MAX_ROWS || sheet.data.some(row => row.length > 256)) throw new Error("hotwords_import_too_many_rows");
      words.push(...tableWords(sheet.data));
    }
  } else throw new Error("hotwords_import_format");
  if (words.length > MAX_ROWS) throw new Error("hotwords_import_too_many_rows");
  return words;
}

function preparePreview(values, snapshot) {
  const seen = new Set(), existing = new Set(snapshot.entries.map(entry => entry.text.toLowerCase()));
  const words = [];
  const stats = { total: values.length, valid: 0, invalid: 0, duplicates: 0, existing: 0, available: LIBRARY_LIMIT - snapshot.entries.length };
  for (const value of values) {
    let text;
    try { text = term(value); } catch { stats.invalid++; continue; }
    const key = text.toLowerCase();
    if (seen.has(key)) { stats.duplicates++; continue; }
    seen.add(key);
    if (existing.has(key)) { stats.existing++; continue; }
    words.push(text);
  }
  stats.valid = words.length;
  return { words, stats };
}

function parseFile(filePath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { filePath }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(new Error(error)); else resolve(result);
    };
    const timer = setTimeout(() => finish("hotwords_import_timeout"), 30000);
    worker.once("message", message => finish(message.error, message.words));
    worker.once("error", () => finish("hotwords_import_format"));
    worker.once("exit", () => { if (!settled) finish("hotwords_import_format"); });
  });
}

if (!isMainThread && workerData?.filePath) {
  (async () => {
    const handle = await fs.open(workerData.filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw new Error("hotwords_import_size");
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) throw new Error("hotwords_import_format");
        offset += bytesRead;
      }
      parentPort.postMessage({ words: await parseVocabulary(buffer, path.extname(workerData.filePath).toLowerCase()) });
    } finally { await handle.close(); }
  })().catch(error => parentPort.postMessage({ error: /^hotwords_import_[a-z_]+$/.test(error?.message || "") ? error.message : "hotwords_import_format" }));
}

module.exports = { parseFile, parseVocabulary, preparePreview, tableWords, decodeText };
