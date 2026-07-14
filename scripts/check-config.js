const key = process.env.MIMO_API_KEY || "";
const configuredMimoBaseUrl = process.env.MIMO_BASE_URL || "";
const baseUrl = key.startsWith("tp-")
  ? (configuredMimoBaseUrl || "https://token-plan-cn.xiaomimimo.com/v1")
  : (/token-plan/i.test(configuredMimoBaseUrl) ? "https://api.xiaomimimo.com/v1" : (configuredMimoBaseUrl || "https://api.xiaomimimo.com/v1"));
const providers = [
  ["MIMO_API_KEY", process.env.MIMO_API_KEY],
  ["DASHSCOPE_API_KEY", process.env.DASHSCOPE_API_KEY],
  ["QWEN_ASR_API_KEY", process.env.QWEN_ASR_API_KEY],
  ["FUN_ASR_API_KEY", process.env.FUN_ASR_API_KEY],
  ["CLEANER_API_KEY", process.env.CLEANER_API_KEY]
];
const hasAsrKey = Boolean(process.env.MIMO_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.QWEN_ASR_API_KEY || process.env.FUN_ASR_API_KEY);

console.log("Open Voice Input configuration");
for (const [name, value] of providers) {
  console.log(`${name}: ${value ? "configured" : "missing"}`);
}
console.log(`MIMO key kind: ${key.startsWith("tp-") ? "token-plan" : "regular-or-missing"}`);
console.log(`MIMO base URL: ${baseUrl}`);
console.log(`Cleaner base URL: ${process.env.CLEANER_BASE_URL || "not set"}`);
console.log(`Node: ${process.version}`);

if (!hasAsrKey) {
  process.exitCode = 1;
}
