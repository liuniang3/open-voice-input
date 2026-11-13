"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { parseVocabulary, preparePreview, decodeText, parseFile } = require("../src/hotword-import");
const { createHotwordImporter } = require("../src/hotword-import-session");
const { createHotwordStore } = require("../src/hotwords");

function memoryFs() {
  const files = new Map();
  return { files, mkdir: async () => {}, stat: async file => {
    if (!files.has(file)) throw Object.assign(new Error(), { code: "ENOENT" });
    return { size: Buffer.byteLength(files.get(file)) };
  }, readFile: async file => files.get(file), writeFile: async (file, value) => files.set(file, value),
  rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); } };
}

function workbook() {
  const { zipSync, strToU8 } = require("fflate");
  const files = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Words" sheetId="1" r:id="rId1"/><sheet name="More" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>序号</t></is></c><c r="B1" t="inlineStr"><is><t>词条</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>量子光学</t></is></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>MiMo</t></is></c></row></sheetData></worksheet>'
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)]))));
}

(async () => {
  assert.deepEqual(await parseVocabulary(Buffer.from('\ufeff量子光学\r\nMiMo\n\n'), ".txt"), ["量子光学", "MiMo"]);
  assert.equal(decodeText(Buffer.concat([Buffer.from([255, 254]), Buffer.from("量子光学", "utf16le")])), "量子光学");
  assert.equal(decodeText(Buffer.from([0xc8, 0xc8, 0xb4, 0xca])), "热词");
  assert.deepEqual(await parseVocabulary(Buffer.from('序号,热词,频率\n1,"量子光学",5\n2,MiMo,4'), ".csv"), ["量子光学", "MiMo"]);
  assert.deepEqual(await parseVocabulary(Buffer.from('MiMo\t4\nQwen\t3'), ".tsv"), ["MiMo", "Qwen"]);
  assert.deepEqual(await parseVocabulary(workbook(), ".xlsx"), ["量子光学", "MiMo"]);
  await assert.rejects(parseVocabulary(Buffer.alloc(0), ".txt"), /import_size/);
  await assert.rejects(parseVocabulary(Buffer.alloc(16 * 1024 * 1024 + 1), ".txt"), /import_size/);
  await assert.rejects(parseVocabulary(Buffer.from('not a zip'), ".xlsx"), /import_format/);
  const declaredBomb = workbook();
  const central = declaredBomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  declaredBomb.writeUInt32LE(65 * 1024 * 1024, central + 24);
  await assert.rejects(parseVocabulary(declaredBomb, ".xlsx"), /import_workbook_limit/);
  await assert.rejects(parseVocabulary(Buffer.from('not a workbook'), ".xls"), /import_format/);
  await assert.rejects(parseVocabulary(Buffer.from("word\n".repeat(100001)), ".txt"), /too_many_rows/);
  await assert.rejects(parseVocabulary(Buffer.from("word\n".repeat(100003)), ".csv"), /too_many_rows/);
  const preview = preparePreview(["MiMo", "mimo", "量子光学", "123", "<tag>", "Qwen"], { entries: [{ text: "Qwen" }] });
  assert.deepEqual(preview.words, ["MiMo", "量子光学"]);
  assert.deepEqual(preview.stats, { total: 6, valid: 2, invalid: 2, duplicates: 1, existing: 1, available: 99999 });
  assert.equal(preparePreview(["a".repeat(16 * 1024 * 1024)], { entries: [] }).stats.invalid, 1);

  const fs = memoryFs(), store = createHotwordStore({ directory: "fixture", fsImpl: fs });
  const imported = await store.importWords(Array.from({ length: 1000 }, (_, index) => `Term${index}`));
  assert.equal(imported.entries.length, 1000);
  assert.equal(imported.entries.filter(entry => entry.enabled).length, 100);
  assert.equal(store.words().length, 100);
  assert.equal(imported.limit, 100000);
  await assert.rejects(store.update({ action: "upsert", id: imported.entries[100].id, text: "Term100" }), /active_limit/);
  await store.update({ action: "upsert", id: imported.entries[0].id, text: "Term0", enabled: false });
  await store.update({ action: "upsert", id: imported.entries[100].id, text: "Term100" });
  await store.importWords(["TERM0", "Term1"]);
  assert.equal((await store.get()).entries.length, 1000, "dedupe preserves disabled entries");
  await store.update({ action: "removeMany", ids: [imported.entries[0].id, imported.entries[1].id] });
  assert.equal((await store.get()).entries.length, 998);
  await assert.rejects(store.update({ action: "removeMany", ids: ["bad"] }), /invalid_action/);
  await assert.rejects(store.importWords(["ValidWord", "<bad>"]));
  assert.equal((await store.get()).entries.length, 998, "invalid bulk import is atomic");
  const reloaded = createHotwordStore({ directory: "fixture", fsImpl: fs });
  assert.deepEqual(await reloaded.get(), await store.get());
  const before = fs.files.get(path.join("fixture", "hotwords.json"));
  fs.rename = async () => { throw new Error("disk-full"); };
  await assert.rejects(store.importWords(["NewWord"]));
  assert.equal(fs.files.get(path.join("fixture", "hotwords.json")), before);
  const full = createHotwordStore({ directory: "full", fsImpl: memoryFs() });
  await full.importWords(Array.from({ length: 100000 }, (_, index) => `Term${index}`));
  await assert.rejects(full.importWords(["OneTooMany"]), /hotwords_limit/);
  assert.equal((await full.get()).entries.length, 100000, "capacity failures never partially import");

  let time = 100, imports = 0;
  const sender = {}, other = {};
  const sessions = createHotwordImporter({ now: () => time, chooseFile: async () => "synthetic.txt", parse: async () => ["MiMo"],
    getStore: () => ({ get: async () => ({ entries: [] }), importWords: async words => { imports++; return words; } }) });
  const staged = await sessions.preview(sender);
  assert.equal(imports, 0, "preview never writes");
  await assert.rejects(sessions.commit(other, { token: staged.token }), /expired/);
  assert.deepEqual(await sessions.commit(sender, { token: staged.token, words: ["malicious"] }), ["MiMo"]);
  await assert.rejects(sessions.commit(sender, { token: staged.token }), /expired/);
  const expired = await sessions.preview(sender); time += 600001;
  await assert.rejects(sessions.commit(sender, { token: expired.token }), /expired/);
  assert.equal(imports, 1);
  let failSave = true, release;
  const retrySession = createHotwordImporter({ chooseFile: async () => "synthetic.txt", parse: async () => ["MiMo"],
    getStore: () => ({ get: async () => ({ entries: [] }), importWords: async words => {
      if (failSave) throw new Error("disk-full");
      await new Promise(resolve => { release = resolve; }); return words;
    } }) });
  const retryPreview = await retrySession.preview(sender);
  await assert.rejects(retrySession.commit(sender, retryPreview), /disk-full/);
  failSave = false;
  const retrying = retrySession.commit(sender, retryPreview);
  await assert.rejects(retrySession.commit(sender, retryPreview), /import_busy/);
  await assert.rejects(retrySession.preview(sender), /import_busy/);
  release();
  assert.deepEqual(await retrying, ["MiMo"], "failed saves keep the preview retryable");
  await assert.rejects(retrySession.commit(sender, retryPreview), /import_expired/);
  assert.equal(await createHotwordImporter({ chooseFile: async () => null }).preview({}), null);
  // Exercise worker isolation with a checked-in, non-personal source file.
  await assert.rejects(parseFile(__filename), /import_format/);
  console.log("Hotword text/table import, bounded worker, atomic storage, bulk deletion and preview-token isolation passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
