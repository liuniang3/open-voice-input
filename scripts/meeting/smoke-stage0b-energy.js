#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const ROOT = path.resolve(__dirname, "../..");
const HELPER = path.join(
  ROOT,
  "native",
  "audio-capture-helper",
  "target",
  "release",
  "audio-capture-helper.exe"
);
const WAV =
  process.env.SMOKE_WAV ||
  path.join(os.tmpdir(), "ovi-beep-test.wav");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!fs.existsSync(HELPER)) {
    console.error("helper missing");
    process.exit(2);
  }
  if (!fs.existsSync(WAV)) {
    console.error("wav missing:", WAV);
    process.exit(2);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-smoke-energy-"));
  const mic = path.join(root, "m");
  const sys = path.join(root, "s");
  fs.mkdirSync(mic, { recursive: true });
  fs.mkdirSync(sys, { recursive: true });

  const child = spawn(HELPER, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let hello = null;
  const pending = new Map();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "hello") hello = msg;
    if (msg.type === "result" && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  });
  child.stderr.on("data", (c) => {
    const t = String(c).trim();
    if (t) console.error("[stderr]", t);
  });

  function send(cmd, fields = {}, timeoutMs = 20000) {
    const id = `${cmd}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout ${cmd}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ cmd, id, ...fields })}\n`);
    });
  }

  while (!hello) await sleep(20);
  await send("configure", { session_root: root, parent_pid: process.pid });
  const dev = await send("query_devices");
  const renders = dev.result?.data?.render || [];
  let pick =
    renders.find((d) => d.is_default && !/virtual|audiorelay|cable|vb-audio/i.test(d.name)) ||
    renders.find((d) => !/virtual|audiorelay|cable|vb-audio/i.test(d.name)) ||
    renders.find((d) => d.is_default) ||
    renders[0];
  console.log("render pick:", pick?.name);

  const start = await send("start", {
    session_id: "energy",
    capture_mode: "dual",
    microphone: { output_dir: mic },
    system: { device_id: pick?.id, output_dir: sys },
    subchunk_ms: 1000
  });
  if (!start.result?.ok) {
    console.error("start failed", start.result?.error);
    process.exit(1);
  }

  const ps = `
$sp = New-Object System.Media.SoundPlayer -ArgumentList @('${WAV.replace(/'/g, "''")}')
$sp.PlaySync()
`.trim();
  const player = spawn("powershell.exe", ["-NoProfile", "-Command", ps], {
    windowsHide: true,
    stdio: "ignore"
  });
  await new Promise((resolve) => player.on("exit", resolve));
  await sleep(800);
  await send("stop");

  let nz = 0;
  let tot = 0;
  const files = fs.readdirSync(sys).filter((n) => n.endsWith(".l0.pcm"));
  for (const f of files) {
    const b = fs.readFileSync(path.join(sys, f));
    tot += b.length;
    for (let i = 0; i < b.length; i += 1) if (b[i] !== 0) nz += 1;
  }
  const report = {
    render: pick?.name,
    sysFiles: files.length,
    totalBytes: tot,
    nonZeroBytes: nz,
    ok: nz > 0
  };
  console.log(JSON.stringify(report, null, 2));
  try {
    await send("shutdown", {}, 2000);
  } catch {
    // ignore
  }
  try {
    child.kill();
  } catch {
    // ignore
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
