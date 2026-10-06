"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "src/renderer/renderer.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "src/preload.js"), "utf8");
const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");

function test(name, run) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("ASR and language supplier panels expose separate connections and controls", () => {
  assert.match(html, /data-settings-tab="asr"/);
  assert.match(html, /data-settings-tab="cleaner"/);
  const textPanel = html.slice(html.indexOf('data-settings-panel="cleaner"'), html.indexOf('id="legacyMeetingSettings"'));
  const asrPanel = html.slice(html.indexOf('data-settings-panel="asr"'), html.indexOf('data-settings-panel="cleaner"'));
  assert.match(textPanel, /id="textSupplierCards"/);
  assert.doesNotMatch(textPanel, /id="(?:mimo|aliyun)ApiKeyInput"/);
  assert.doesNotMatch(asrPanel, /id="textSupplier/);
  for (const family of ["mimo", "aliyun"]) {
    assert.equal((html.match(new RegExp(`id="${family}BaseUrlInput"`, "g")) || []).length, 1);
    assert.equal((html.match(new RegExp(`id="${family}ApiKeyInput"`, "g")) || []).length, 1);
    assert.match(html, new RegExp(`data-secret-toggle="${family}ApiKeyInput"`));
    assert.match(html, new RegExp(`data-secret-copy="${family}ApiKeyInput"`));
    assert.match(html, new RegExp(`data-provider-connection-test="${family}"`));
  }
  assert.doesNotMatch(html, /id="openai(?:BaseUrl|ApiKey)Input"/);
  assert.match(html, /id="textSupplierApiStyle"[\s\S]*value="chat-completions"[\s\S]*value="responses"/);
  assert.match(html, /data-provider-model-refresh="cleaner"/);
  assert.match(html, /data-provider-model-refresh="analysis"/);
  assert.match(html, /id="textSupplierCards"/);
  assert.match(html, /id="textSupplierEditor"/);
  assert.match(html, /id="textSupplierCancel"/);
  assert.match(html, /id="textSupplierRefresh"/);
  assert.match(html, /aria-describedby="mimoConnectionDescription"/);
  assert.match(html, /token-plan-cn[^<]+tp- Key/);
  assert.match(html, /aria-describedby="aliyunConnectionDescription"/);
  assert.doesNotMatch(html, /OpenCode Go（实验性）/);
  assert.doesNotMatch(html, /data-provider-connection-test="opencode-go"/);
});

test("vendor model panels do not expose duplicate credentials", () => {
  assert.doesNotMatch(html, /id="asr(?:BaseUrl|ApiKey)Input"/);
  assert.doesNotMatch(html, /id="meeting(?:Qwen|FileAsr|FunAsr)(?:BaseUrl|ApiKey)Input"/);
  assert.match(html, /id="cleanerCustomConnectionFields"[^>]*hidden/);
  assert.match(html, /id="meetingAnalysisCustomConnectionFields"[^>]*hidden/);
  assert.match(html, /value="custom">自定义兼容接口/);
});

test("save payload writes only the ASR map and omits vendor credential duplicates", () => {
  const saveSource = source.slice(source.indexOf("async function saveAllSettings"), source.indexOf("async function runMeetingEnhancedTest"));
  assert.match(saveSource, /asrConnections:\s*collectAsrConnections\(\)/);
  assert.doesNotMatch(saveSource, /providerConnections:\s*collectProviderConnections\(\)/);
  assert.doesNotMatch(saveSource, /\n\s+asrBaseUrl:\s*|\n\s+asrApiKey:\s*/);
  assert.doesNotMatch(saveSource, /\n\s+meeting(?:Qwen|FileAsr|FunAsr)(?:BaseUrl|ApiKey):\s*/);
  assert.match(source, /providerFamily === "custom" \? \{[\s\S]*?baseUrl:[\s\S]*?apiKey:/);
  assert.match(source, /testProviderConnection\(\{ provider, scope: "asr" \}\)/);
});

test("shared OpenAI values override stale GPT profiles and preserve protocol", () => {
  const code = source.slice(source.indexOf("const OPENAI_API_STYLES"), source.indexOf("let audioContext"));
  const context = vm.createContext({ input: {
    providerConnections: {
      openai: { baseUrl: "https://shared.example/v1", apiKey: "shared-key", apiStyle: "chat-completions" }
    },
    meetingAnalysisProfiles: {
      "gpt-5.5": { baseUrl: "https://api.openai.com/v1", apiKey: "stale-key" }
    }
  } });
  vm.runInContext(code, context);
  const actual = JSON.parse(JSON.stringify(vm.runInContext("providerConnectionsForSettings(input).openai", context)));
  assert.deepEqual(actual, {
    baseUrl: "https://shared.example/v1",
    apiKey: "shared-key",
    apiStyle: "chat-completions"
  });
});

test("OpenCode Go UI connection stays independent from OpenAI and overlapping model names", () => {
  const code = source.slice(source.indexOf("const OPENAI_API_STYLES"), source.indexOf("let audioContext"));
  const context = vm.createContext({ input: {
    providerConnections: {
      openai: { baseUrl: "https://openai.example/v1", apiKey: "openai-key", apiStyle: "responses" },
      "opencode-go": { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "go-key", apiStyle: "chat-completions" }
    },
    cleanerProfiles: {
      "mimo-v2.5": { provider: "opencode-go", providerFamily: "opencode-go" }
    }
  } });
  vm.runInContext(code, context);
  const connections = JSON.parse(JSON.stringify(vm.runInContext("providerConnectionsForSettings(input)", context)));
  assert.equal(connections.openai.apiKey, "openai-key");
  assert.equal(connections["opencode-go"].apiKey, "go-key");
  assert.equal(connections["opencode-go"].baseUrl, "https://opencode.ai/zen/go/v1");
});

test("provider tests cross a restricted preload and main-process bridge", () => {
  assert.match(preload, /testProviderConnection:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\("provider:test-connection", payload\)/);
  assert.match(preload, /listProviderModels:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\("provider:list-models", payload\)/);
  assert.match(main, /ipcMain\.handle\("provider:test-connection"/);
  assert.match(main, /ipcMain\.handle\("provider:list-models"/);
  assert.match(main, /testProviderConnection\(\{ settings, provider, supplierId, modelId, scope \}\)/);
  assert.match(main, /refreshTextSupplierCatalog\(\{ settings, supplierId: id \}\)/);
  assert.match(main, /sanitizeIpcError\(error\)/);
});

console.log("provider connection UI tests passed");
