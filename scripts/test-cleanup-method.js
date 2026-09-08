const assert = require("node:assert/strict");
const {
  buildTextCleanupMessages,
  isSafeCleanup,
  parseAndValidateCleanupResponse
} = require("../src/providers/cleaner/text-cleanup-method");
const { createMimoCleanerProvider } = require("../src/providers/cleaner/mimo-cleaner-provider");

const messages = buildTextCleanupMessages("呃，我我现在开始。", "Obsidian");
assert.equal(messages.length, 2);
assert.match(messages[0].content, /deletion-span procedure/);
assert.match(messages[0].content, /If evidence is insufficient, delete nothing/);
assert.match(messages[1].content, /<raw_transcript>/);

assert.equal(isSafeCleanup("呃，我我现在开始。", "我现在开始。"), true);
assert.equal(isSafeCleanup("大家一步一步来。", "大家逐步来。"), false);
assert.equal(isSafeCleanup("这个功能不是不能用。", "这个功能可以用。"), false);
assert.equal(isSafeCleanup("我现在想的是把窗口缩小。", "把窗口缩小。"), true);
assert.equal(isSafeCleanup("请把这个完整而重要的技术结论保留下来。", "保留。"), false);

assert.equal(
  parseAndValidateCleanupResponse('{"text":"我现在开始。"}', "呃，我我现在开始。"),
  "我现在开始。"
);
assert.equal(
  parseAndValidateCleanupResponse('{"text":"大家逐步来。"}', "大家一步一步来。"),
  ""
);
assert.equal(parseAndValidateCleanupResponse("not json", "原文。"), "");

let requestedModel = "";
let requestedMaxTokens = 0;
const mimoProvider = createMimoCleanerProvider({
  client: {
    requestChat: async (_messages, options) => {
      requestedModel = options.model;
      requestedMaxTokens = options.maxTokens;
      return { content: '{"text":"清理结果。"}' };
    }
  },
  getModel: () => "mimo-v2.5-pro"
});

mimoProvider.clean({ rawText: "呃清理结果。", shortContext: "" })
  .then((result) => {
    assert.equal(requestedModel, "mimo-v2.5-pro");
    assert.equal(requestedMaxTokens, 2048);
    assert.equal(result.text, "清理结果。");
    console.log("cleanup method tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
