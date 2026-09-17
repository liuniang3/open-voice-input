"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const h = await fs.open(temp, "wx", 0o600);
  try { await h.writeFile(content); await h.sync(); } finally { await h.close(); }
  await fs.rename(temp, file);
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function reserveMarkdown(destination, directory, id, { reuseExisting = false } = {}) {
  const file = destination ? path.resolve(destination) : path.join(directory, `${id}.md`);
  if (path.extname(file).toLowerCase() !== ".md") throw new Error("markdown_extension_required");
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const h = await fs.open(file, "wx", 0o600);
    await h.close();
    return file;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (reuseExisting && destination) {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("markdown_target_not_regular");
      return file;
    }
    // Preserve the selected existing note; session output goes beside it.
    const adjacent = `${file.slice(0, -3)}-${id}.md`;
    const h = await fs.open(adjacent, "wx", 0o600);
    await h.close();
    return adjacent;
  }
}

function timestamp(frames, rate = 16000) {
  const seconds = Math.floor(frames / rate);
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function markdown(state) {
  const lines = [`# ${String(state.title || "会议实时转录").replace(/[\r\n]/g, " ")}`, "",
    `<!-- open-voice-input:${state.sessionId} -->`, `开始：${new Date(state.startedAtMs).toISOString()}`,
    `状态：${state.status} · ASR：${state.modelId}`, "", "## 原始转录", ""];
  for (const segment of state.segments) {
    lines.push(`### ${timestamp(segment.startFrame)}–${timestamp(segment.endFrame)}`, "",
      segment.status === "completed" ? (segment.text || "（此段未识别到语音）") :
        segment.status === "failed" ? "（转写失败，音频已保留，可重试）" : "（音频已保留，等待转写）", "");
  }
  if (!state.segments.length) lines.push("（正在录音，等待第一个转写片段）", "");
  if (state.previewText) lines.push("## 尚未确认的实时文字", "", state.previewText, "");
  if (state.previewFailed) lines.push("实时识别有缺口，完整音频仍保留。可重试实时识别或停止后勾选 MiMo 音频核对。", "");
  if (state.preview?.windows) {
    for (const window of state.preview.windows.filter(item => item.status === "failed")) {
      lines.push(`- 待补转写：${timestamp(window.startFrame)}–${timestamp(window.endFrame)}`);
    }
    lines.push("");
  }
  lines.push("## 完整音频", "");
  for (const file of state.audioPaths) {
    const relative = path.relative(path.dirname(state.markdownPath), file).split(path.sep).join("/");
    lines.push(`- [${path.basename(file)}](<${relative}>)`);
  }
  if (state.error) lines.push("", `保存/处理提示：${state.error.message}`);
  return `${lines.join("\n")}\n`;
}

module.exports = { atomicWrite, readJson, reserveMarkdown, markdown };
