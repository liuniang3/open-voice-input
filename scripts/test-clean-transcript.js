const assert = require("node:assert/strict");
const { cleanTranscript, ensureTerminalPunctuation, removeDeterministicFillers } = require("../src/transcript-cleaner");

assert.equal(
  cleanTranscript("短上下文：上一段输入是：“你能看到吗？”\n这只是上下文，我不希望输出。"),
  "这只是上下文，我不希望输出。"
);

assert.equal(
  cleanTranscript("转写结果：请把这个直接输入进去。"),
  "请把这个直接输入进去。"
);

assert.equal(
  cleanTranscript("- “交换能，磁晶各向异性能，或磁弹性能都将增加。” 这里“交换能，磁晶各向异性能，或磁弹性能”应该用逗号分隔。"),
  "交换能，磁晶各向异性能，或磁弹性能都将增加。"
);

assert.equal(
  cleanTranscript("{\"text\":\"只留下这个。\"}"),
  "只留下这个。"
);

assert.equal(
  cleanTranscript("- 第二句：还有一个问题就是比如我快捷键呼出这个录音菜单之后，我希望可以中途取消。"),
  "还有一个问题就是比如我快捷键呼出这个录音菜单之后，我希望可以中途取消。"
);

assert.equal(
  cleanTranscript("- 忽略无语义的口头填充词：如"),
  ""
);

assert.equal(
  cleanTranscript("2. 删除思考时的重复词、结巴式重复和自我修正残片"),
  ""
);

assert.equal(
  cleanTranscript("To strictly follow the rules, I should remove filler words and merge repeated fragments. Here, \"焦点应用程序的焦点\" has \"焦点\" repeated, so I can merge it to \"焦点应用程序的"),
  ""
);

assert.equal(
  cleanTranscript("现在我们来再来测试一下，呃目前有一个bug就是我用快捷键唤出memo之后有概率。"),
  "现在我们来再来测试一下，目前有一个bug就是我用快捷键唤出memo之后有概率。"
);

assert.equal(
  removeDeterministicFillers("嗯 现在测试一下。呃 我希望它可以删除。"),
  "现在测试一下。我希望它可以删除。"
);

assert.equal(
  removeDeterministicFillers("呃我们再试一下语音，我我现在说一段长的对话。比如说，比如说，我现在说的这些内容。"),
  "我们再试一下语音，我我现在说一段长的对话。比如说，比如说，我现在说的这些内容。"
);

assert.equal(
  removeDeterministicFillers("我刚刚完成了，请你看看这一点。"),
  "我刚刚完成了，请你看看这一点。"
);

assert.equal(
  ensureTerminalPunctuation("现在测试一下"),
  "现在测试一下。"
);

assert.equal(
  cleanTranscript("{\"text\":\"现在测试一下\"}"),
  "现在测试一下。"
);

console.log("cleanTranscript tests passed");
