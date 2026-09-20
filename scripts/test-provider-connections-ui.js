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

test("provider connection panel exposes one accessible connection per vendor", () => {
  assert.match(html, /data-settings-tab="connections"/);
  for (const family of ["mimo", "aliyun", "openai", "openCodeGo"]) {
    assert.equal((html.match(new RegExp(`id="${family}BaseUrlInput"`, "g")) || []).length, 1);
    assert.equal((html.match(new RegExp(`id="${family}ApiKeyInput"`, "g")) || []).length, 1);
    assert.match(html, new RegExp(`data-secret-toggle="${family}ApiKeyInput"`));
    assert.match(html, new RegExp(`data-secret-copy="${family}ApiKeyInput"`));
    const provider = family === "openCodeGo" ? "opencode-go" : family;
    assert.match(html, new RegExp(`data-provider-connection-test="${provider}"`));
  }
  assert.match(html, /id="openaiApiStyleSelect"[\s\S]*value="responses"[\s\S]*value="chat-completions"/);
  assert.equal((html.match(/data-provider-model-refresh="openai"/g) || []).length, 1);
  assert.equal((html.match(/data-provider-model-refresh="opencode-go"/g) || []).length, 1);
  assert.match(html, /data-provider-model-refresh="cleaner"/);
  assert.match(html, /data-provider-model-refresh="analysis"/);
  assert.match(html, /data-provider-model-status="openai"/);
  assert.match(html, /aria-describedby="mimoConnectionDescription"/);
  assert.match(html, /token-plan-cn[^<]+tp- Key/);
  assert.match(html, /aria-describedby="aliyunConnectionDescription"/);
  assert.match(html, /aria-describedby="openaiConnectionDescription"/);
  assert.match(html, /aria-describedby="openCodeGoConnectionDescription"/);
  assert.equal((html.match(/value="opencode-go">OpenCode Go（实验性）/g) || []).length, 2);
});

test("vendor model panels do not expose duplicate credentials", () => {
  assert.doesNotMatch(html, /id="asr(?:BaseUrl|ApiKey)Input"/);
  assert.doesNotMatch(html, /id="meeting(?:Qwen|FileAsr|FunAsr)(?:BaseUrl|ApiKey)Input"/);
  assert.match(html, /id="cleanerCustomConnectionFields"[^>]*hidden/);
  assert.match(html, /id="meetingAnalysisCustomConnectionFields"[^>]*hidden/);
  assert.match(html, /value="custom">自定义兼容接口/);
});

test("save payload writes the shared map and omits vendor credential duplicates", () => {
  const saveSource = source.slice(source.indexOf("async function saveAllSettings"), source.indexOf("async function runMeetingEnhancedTest"));
  assert.match(saveSource, /providerConnections:\s*collectProviderConnections\(\)/);
  assert.doesNotMatch(saveSource, /\n\s+asrBaseUrl:\s*|\n\s+asrApiKey:\s*/);
  assert.doesNotMatch(saveSource, /\n\s+meeting(?:Qwen|FileAsr|FunAsr)(?:BaseUrl|ApiKey):\s*/);
  assert.match(source, /providerFamily === "custom" \? \{[\s\S]*?baseUrl:[\s\S]*?apiKey:/);
  assert.match(source, /testProviderConnection\(\{ provider \}\)/);
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
  assert.match(main, /testProviderConnection\(\{ settings, provider \}\)/);
  assert.match(main, /sanitizeIpcError\(error\)/);
});

console.log("provider connection UI tests passed");
