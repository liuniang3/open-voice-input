"use strict";

const RESERVED_WINDOWS = new Set([
  "CommandOrControl+C",
  "CommandOrControl+V",
  "CommandOrControl+X",
  "CommandOrControl+A",
  "CommandOrControl+Z",
  "CommandOrControl+Y",
  "CommandOrControl+S",
  "CommandOrControl+P",
  "CommandOrControl+N",
  "CommandOrControl+O",
  "CommandOrControl+W",
  "CommandOrControl+F",
  "CommandOrControl+H",
  "CommandOrControl+Tab",
  "Alt+Tab",
  "Alt+F4",
  "Alt+Esc",
  "Alt+Escape",
  "CommandOrControl+Alt+Delete",
  "CommandOrControl+Shift+Esc",
  "CommandOrControl+Shift+Escape",
  "CommandOrControl+Esc",
  "CommandOrControl+Escape",
  "Super",
  "Meta",
  "Win",
  "Super+L",
  "Super+D",
  "Super+E",
  "Super+R",
  "Super+I",
  "Super+X",
  "Super+Tab"
]);

const MODIFIER_TOKENS = new Set([
  "commandorcontrol",
  "cmdorctrl",
  "control",
  "ctrl",
  "alt",
  "option",
  "shift",
  "super",
  "meta",
  "win",
  "windows",
  "command",
  "cmd"
]);

function normalizeAccelerator(value, platform = process.platform) {
  const parts = String(value || "").split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return "";
  const modifiers = { control: false, command: false, alt: false, shift: false, super: false };
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "commandorcontrol" || lower === "cmdorctrl") {
      modifiers[platform === "darwin" ? "command" : "control"] = true;
    } else if (lower === "control" || lower === "ctrl") {
      modifiers.control = true;
    } else if (lower === "alt" || lower === "option") {
      modifiers.alt = true;
    } else if (lower === "shift") {
      modifiers.shift = true;
    } else if (lower === "super" || lower === "meta" || lower === "win" || lower === "windows" || lower === "command" || lower === "cmd") {
      modifiers[platform === "darwin" ? "command" : "super"] = true;
    } else {
      // Do not silently discard a second main key.
      if (key) return "";
      key = /^[a-z]$/i.test(part) ? part.toUpperCase() : part;
      if (/^(esc|escape)$/i.test(key)) key = "Escape";
    }
  }
  if (!key) return "";
  const mods = [];
  if (modifiers.control) mods.push(platform === "darwin" ? "Control" : "CommandOrControl");
  if (modifiers.command) mods.push("Command");
  if (modifiers.alt) mods.push("Alt");
  if (modifiers.shift) mods.push("Shift");
  if (modifiers.super) mods.push("Super");
  return [...mods, key].join("+");
}

function parseParts(accelerator) {
  return String(accelerator || "").split("+").map((part) => part.trim()).filter(Boolean);
}

function isValidFormat(accelerator) {
  const parts = parseParts(accelerator);
  if (parts.length < 2) return false;
  let keyCount = 0;
  let modCount = 0;
  for (const part of parts) {
    if (MODIFIER_TOKENS.has(part.toLowerCase())) modCount += 1;
    else keyCount += 1;
  }
  if (keyCount !== 1 || modCount < 1) return false;
  const key = parts[parts.length - 1];
  if (MODIFIER_TOKENS.has(key.toLowerCase())) return false;
  if (/^F([1-9]|1\d|2[0-4])$/i.test(key)) return true;
  if (/^[A-Z0-9]$/i.test(key)) return true;
  if (/^num[0-9]$/i.test(key)) return true;
  const allowed = new Set([
    "Space","Tab","Enter","Esc","Escape","Backspace","Delete","Insert",
    "Home","End","PageUp","PageDown","Up","Down","Left","Right","Plus",
    "+","-","=",",",".","/","\\",";","'","[","]","`"
  ]);
  return allowed.has(key);
}

function isReservedWindows(accelerator) {
  const normalized = normalizeAccelerator(accelerator, "win32");
  if (!normalized) return true;
  return RESERVED_WINDOWS.has(normalized);
}

const RESERVED_MAC = new Set([
  ...["C", "V", "X", "A", "Z", "S", "P", "N", "O", "W", "F", "H", "Q", "M", "Tab", "Space", ","].map((key) => `Command+${key}`),
  "Command+Shift+Z", "Command+Shift+Q", "Command+Alt+Escape", "Command+Alt+H",
  "Command+Alt+Space", "Command+Shift+3", "Command+Shift+4", "Command+Shift+5",
  "Control+Command+Q", "Control+Space", "Control+Up", "Control+Down", "Control+Left", "Control+Right"
]);

function validateHotkey(accelerator, opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const raw = String(accelerator || "").trim();
  if (!raw) {
    return { ok: false, code: "empty", accelerator: "", message: "快捷键不能为空" };
  }
  const normalized = normalizeAccelerator(raw, platform);
  if (!normalized || !isValidFormat(normalized)) {
    return {
      ok: false,
      code: "invalid_format",
      accelerator: normalized || raw,
      message: "快捷键格式无效，请使用修饰键 + 主键（例如 CommandOrControl+Alt+M）"
    };
  }
  if (platform === "darwin" ? RESERVED_MAC.has(normalized) : isReservedWindows(normalized)) {
    return { ok: false, code: "reserved", accelerator: normalized, message: "该组合是系统保留快捷键，请更换" };
  }
  const others = Array.isArray(opts.otherHotkeys) ? opts.otherHotkeys : [];
  for (const other of others) {
    if (normalizeAccelerator(other, platform) === normalized) {
      return { ok: false, code: "app_conflict", accelerator: normalized, message: "与应用内另一个快捷键冲突" };
    }
  }
  if (opts.registrationFailed === true || opts.isRegisteredOk === false) {
    return {
      ok: false,
      code: "already_taken",
      accelerator: normalized,
      message: "该快捷键已被系统或其他程序占用，无法全局注册"
    };
  }
  return { ok: true, code: "ok", accelerator: normalized, message: "快捷键可用" };
}

module.exports = {
  RESERVED_WINDOWS,
  RESERVED_MAC,
  normalizeAccelerator,
  isValidFormat,
  isReservedWindows,
  validateHotkey
};
