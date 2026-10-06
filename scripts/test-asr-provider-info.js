"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { supplierId, transportProvider, consoleInfo, openConsole } = require("../src/asr-provider-info");
const root = path.resolve(__dirname, "..");

async function run() {
  assert.equal(supplierId("mimo"), "mimo");
  assert.equal(supplierId("qwen3-asr"), "qwen3-asr");
  assert.equal(supplierId("fun-asr"), "qwen3-asr", "legacy Fun profiles display under Qwen without credential migration");
  assert.equal(transportProvider("qwen3-asr", "fun-asr"), "fun-asr");
  assert.equal(transportProvider("qwen3-asr", "fun-asr-realtime-2026-02-28"), "fun-asr");
  assert.equal(transportProvider("fun-asr", "fun-asr-mtl"), "fun-asr");
  assert.equal(transportProvider("qwen3-asr", "qwen3-asr-flash"), "qwen3-asr");
  assert.equal(transportProvider("mimo", "mimo-v2.5-asr"), "mimo");
  const calls = [];
  const openExternal = async url => calls.push(url);
  for (const provider of ["mimo", "qwen3-asr", "fun-asr"]) {
    const info = consoleInfo(provider);
    assert.equal(new URL(info.url).protocol, "https:");
    assert.deepEqual(await openConsole(provider, { authorized: true, openExternal }), { ok: true });
    assert.equal(calls.at(-1), info.url);
  }
  assert.equal(calls[0], "https://platform.xiaomimimo.com/console/api-keys");
  assert.equal(calls[1], "https://bailian.console.aliyun.com/?tab=globalset#/efm/api_key");
  const count = calls.length;
  for (const value of ["https://example.invalid", "javascript:alert(1)", "file:///settings.json", "__proto__", "constructor", { url: calls[0] }, null]) {
    assert.equal(consoleInfo(value), null);
    assert.deepEqual(await openConsole(value, { authorized: true, openExternal }), { ok: false });
  }
  assert.deepEqual(await openConsole("mimo", { authorized: false, openExternal }), { ok: false });
  assert.equal(calls.length, count, "untrusted senders and arbitrary URLs never reach the OS browser");
  assert.deepEqual(await openConsole("mimo", { authorized: true, openExternal: async () => { throw new Error("private browser failure"); } }), { ok: false });
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  for (const id of ["asrProviderSelect", "guideAsrProvider"]) {
    const select = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))[1];
    assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ["mimo", "qwen3-asr"]);
  }
  assert.match(html, /src="\.\.\/asr-provider-info\.js"/);
  const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  assert.match(main, /ipcMain\.handle\("asr:console:open",[\s\S]*?authorized: isAppSender\(event\.sender, event\.senderFrame\?\.url\)/);
  const preload = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
  assert.match(preload, /openAsrConsole: \(provider\) => ipcRenderer\.invoke\("asr:console:open", provider\)/);
  console.log("ASR supplier display, legacy Fun transport, official console allowlist, sender guard and privacy tests passed.");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
