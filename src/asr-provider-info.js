"use strict";

(function (root) {
  const CONSOLES = Object.freeze({
    mimo: Object.freeze({ label: "MiMo API 控制台", url: "https://platform.xiaomimimo.com/console/api-keys" }),
    "qwen3-asr": Object.freeze({ label: "Qwen API 控制台", url: "https://bailian.console.aliyun.com/?tab=globalset#/efm/api_key" })
  });
  function supplierId(provider) {
    if (provider === "mimo") return "mimo";
    if (provider === "qwen3-asr" || provider === "fun-asr") return "qwen3-asr";
    return "";
  }
  function transportProvider(provider, model) {
    const supplier = supplierId(provider);
    if (supplier === "qwen3-asr" && /^fun-asr(?:-|$)/i.test(String(model || "").trim())) return "fun-asr";
    return supplier;
  }
  function consoleInfo(provider) {
    const id = supplierId(provider);
    return CONSOLES[id] || null;
  }
  async function openConsole(provider, { authorized, openExternal }) {
    const info = consoleInfo(provider);
    if (!authorized || !info) return { ok: false };
    try { await openExternal(info.url); return { ok: true }; }
    catch { return { ok: false }; }
  }
  const exported = { supplierId, transportProvider, consoleInfo, openConsole };
  if (typeof module === "object" && module.exports) module.exports = exported;
  if (root) root.AsrProviderInfo = exported;
})(typeof window === "undefined" ? null : window);
