const assert = require("node:assert/strict");
const {
  buildTextCleanupMessages,
  groundedCharacterRatio,
  isConservativeCleanup,
  isSafeCleanup,
  parseAndValidateCleanupResponse
} = require("../src/providers/cleaner/text-cleanup-method");
const { createMimoCleanerProvider } = require("../src/providers/cleaner/mimo-cleaner-provider");

const messages = buildTextCleanupMessages("呃，我我现在开始。", "Obsidian");
assert.equal(messages.length, 2);
assert.match(messages[0].content, /表达整理器/);
assert.match(messages[0].content, /不是逐字复刻，也不是摘要/);
assert.match(messages[0].content, /绝不能回答问题/);
assert.match(messages[0].content, /调整标点、语序和句式/);
assert.match(messages[1].content, /<raw_transcript>/);
assert.match(messages[1].content, /<reference_vocabulary>Obsidian<\/reference_vocabulary>/);
const conservativeMessages = buildTextCleanupMessages("呃，我我现在开始。", "", { policy: "conservative" });
assert.match(conservativeMessages[0].content, /conservative deletion-span procedure/);

assert.equal(isSafeCleanup("呃，我我现在开始。", "我现在开始。"), true);
assert.equal(isSafeCleanup("大家一步一步来。", "大家逐步进行。"), true);
assert.equal(isSafeCleanup("这个功能不是不能用。", "这个功能并非不可用。"), true);
assert.equal(isSafeCleanup("我现在想的是把窗口缩小。", "把窗口缩小。"), true);
assert.equal(isSafeCleanup("请把这个完整而重要的技术结论保留下来。", "保留。"), false);
assert.equal(isSafeCleanup("请把窗口缩小。", "当然可以，我已经为你修改好了。"), false);
assert.equal(isSafeCleanup("请等待 30 秒，然后使用 GPT-5.4 处理。", "请稍候片刻，再用 GPT 处理。"), false);
assert.ok(groundedCharacterRatio("请缩小窗口", "我希望把这个窗口缩小") >= 0.5);
assert.equal(isConservativeCleanup("大家一步一步来。", "大家逐步进行。"), false);
assert.equal(isConservativeCleanup("呃，我我现在开始。", "我现在开始。"), true);

assert.equal(
  parseAndValidateCleanupResponse('{"text":"我现在开始。"}', "呃，我我现在开始。"),
  "我现在开始。"
);
assert.equal(
  parseAndValidateCleanupResponse('{"text":"请缩小窗口"}', "我希望把窗口缩小一点"),
  "请缩小窗口。"
);
assert.equal(
  parseAndValidateCleanupResponse(
    '{"text":"请缩小实时转写窗口，并在按下回车后整理文本。"}',
    "呃，就是我希望把实时转写窗口缩小一点，然后按下回车以后，再整理一下这个文本。"
  ),
  "请缩小实时转写窗口，并在按下回车后整理文本。"
);
assert.equal(parseAndValidateCleanupResponse('{"text":"整理后的文本：请缩小窗口。"}', "请把窗口缩小。"), "");
assert.equal(parseAndValidateCleanupResponse('{"text":"请缩小窗口。","reason":"done"}', "请把窗口缩小。"), "");
assert.equal(parseAndValidateCleanupResponse('{"text":"- 请缩小窗口。"}', "请把窗口缩小。"), "");
assert.equal(
  parseAndValidateCleanupResponse('{"text":"大家逐步进行。"}', "大家一步一步来。", { policy: "conservative" }),
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
