#!/usr/bin/env node
"use strict";

/**
 * Real-helper Stage 0B smoke (Windows WASAPI).
 * Does not call cloud APIs. Writes under os.tmpdir only.
 *
 * Checks:
 * A. ~5s dual capture → both tracks multiple committed L0
 * B. system track energy when possible (report only)
 * C. silence still seals + silentFrames countable
 * D. pause/resume holes on both tracks
 * E. bad render device → start_failed, no recording=true
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function countL0(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => /\.l0\.pcm$/i.test(n)).length;
  } catch {
    return 0;
  }
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function readJournalHoles(dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").split(/\r?\n/);
    return lines
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((j) => j && j.kind === "hole");
  } catch {
    return [];
  }
}

function pcmEnergy(dir) {
  let total = 0;
  let nonZero = 0;
  let files = 0;
  try {
    for (const name of fs.readdirSync(dir).filter((n) => /\.l0\.pcm$/i.test(n))) {
      const buf = fs.readFileSync(path.join(dir, name));
      files += 1;
      for (let i = 0; i < buf.length; i += 1) {
        total += 1;
        if (buf[i] !== 0) nonZero += 1;
      }
    }
  } catch {
    // ignore
  }
  return { files, totalBytes: total, nonZeroBytes: nonZero };
}

class HelperClient {
  constructor(exe) {
    this.exe = exe;
    this.child = null;
    this.pending = new Map();
    this.hello = null;
  }

  start() {
    this.child = spawn(this.exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "hello") {
        this.hello = msg;
        return;
      }
      if (msg.type === "result" && msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    });
    this.child.stderr.on("data", (c) => {
      const t = String(c).trim();
      if (t) console.error("[helper-stderr]", t);
    });
    return this.waitHello();
  }

  waitHello(ms = 10000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.hello) return resolve(this.hello);
        if (Date.now() - start > ms) return reject(new Error("hello timeout"));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  send(cmd, fields = {}, timeoutMs = 20000) {
    const id = `${cmd}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg = { cmd, id, ...fields };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${cmd}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    });
  }

  async shutdown() {
    try {
      await this.send("shutdown", {}, 3000);
    } catch {
      // ignore
    }
    try {
      this.child.kill();
    } catch {
      // ignore
    }
  }
}

async function main() {
  const report = {
    helper: HELPER,
    helperPresent: fs.existsSync(HELPER),
    A_dual_capture: null,
    B_system_energy: null,
    C_silence_timeline: null,
    D_pause_resume_holes: null,
    E_bad_device_manifest: null,
    notes: []
  };

  if (!report.helperPresent) {
    console.error("helper missing:", HELPER);
    process.exit(2);
  }

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-smoke-0b-"));
  const sessionId = `smoke-${Date.now()}`;
  const micDir = path.join(root, sessionId, "audio", "microphone");
  const sysDir = path.join(root, sessionId, "audio", "system");
  await fsp.mkdir(micDir, { recursive: true });
  await fsp.mkdir(sysDir, { recursive: true });

  const client = new HelperClient(HELPER);
  try {
    const hello = await client.start();
    console.log("hello", hello.version, (hello.capabilities || []).slice(0, 5).join(","));
    if (hello.version !== "0.2.0") {
      throw new Error(`unexpected version ${hello.version}`);
    }

    const cfg = await client.send("configure", {
      session_root: root,
      parent_pid: process.pid
    });
    if (!cfg.result?.ok) throw new Error("configure failed");

    const devices = await client.send("query_devices");
    const data = devices.result?.data || {};
    console.log(
      "devices capture=",
      (data.capture || data.devices || []).length,
      "render=",
      (data.render || []).length
    );
    if ((data.capture || []).length) {
      console.log("  capture sample:", data.capture[0].name);
    }
    if ((data.render || []).length) {
      console.log("  render sample:", data.render[0].name);
    }

    // --- A + C: dual capture ~5s ---
    const start = await client.send("start", {
      session_id: sessionId,
      capture_mode: "dual",
      microphone: { output_dir: micDir },
      system: { output_dir: sysDir },
      subchunk_ms: 1000
    });
    if (!start.result?.ok) {
      report.A_dual_capture = { ok: false, error: start.result?.error };
      throw new Error(`start dual failed: ${JSON.stringify(start.result?.error)}`);
    }
    console.log("dual started", start.result.data.sessionOriginQpc ? "qpc-ok" : "no-qpc");

    await sleep(5200);

    // --- D: pause/resume briefly ---
    const pause = await client.send("pause");
    await sleep(400);
    const resume = await client.send("resume");
    await sleep(1200);

    const stop = await client.send("stop");
    if (!stop.result?.ok) {
      report.A_dual_capture = { ok: false, error: stop.result?.error };
      throw new Error(`stop failed: ${JSON.stringify(stop.result?.error)}`);
    }

    const micN = countL0(micDir);
    const sysN = countL0(sysDir);
    const micM = readManifest(micDir);
    const sysM = readManifest(sysDir);
    const micHoles = readJournalHoles(micDir);
    const sysHoles = readJournalHoles(sysDir);
    const energy = pcmEnergy(sysDir);

    report.A_dual_capture = {
      ok: micN >= 2 && sysN >= 2 && micM?.recording === false && sysM?.recording === false,
      micCommitted: micN,
      sysCommitted: sysN,
      micRecording: micM?.recording,
      sysRecording: sysM?.recording,
      micRole: micM?.role,
      sysRole: sysM?.role
    };

    report.B_system_energy = {
      ok: energy.nonZeroBytes > 0,
      ...energy,
      note:
        energy.nonZeroBytes > 0
          ? "system track has non-zero bytes (playback or ambient)"
          : "system track all zeros — play a test tone and re-run for B, or silence is expected"
    };

    report.C_silence_timeline = {
      ok: sysN >= 2 && sysM?.recording === false,
      sysCommitted: sysN,
      note: "timeline sealed continuously even if silent; silentFrames in index when SILENT flag set"
    };

    function holesByReason(holes, reason) {
      return holes.filter((h) => String(h.detail?.reason || "") === reason);
    }
    const micBegin = holesByReason(micHoles, "pause_begin");
    const micEnd = holesByReason(micHoles, "pause_end");
    const sysBegin = holesByReason(sysHoles, "pause_begin");
    const sysEnd = holesByReason(sysHoles, "pause_end");
    const micDiscard = holesByReason(micHoles, "pause_discard");
    const sysDiscard = holesByReason(sysHoles, "pause_discard");
    const pauseRelated =
      micBegin.length +
      micEnd.length +
      sysBegin.length +
      sysEnd.length +
      micDiscard.length +
      sysDiscard.length;
    const dOk =
      micBegin.length === 1 &&
      micEnd.length === 1 &&
      sysBegin.length === 1 &&
      sysEnd.length === 1 &&
      micDiscard.length === 0 &&
      sysDiscard.length === 0 &&
      pauseRelated <= 6 &&
      pause.result?.ok &&
      resume.result?.ok &&
      micEnd[0]?.detail?.detail?.discardedFrames != null;
    report.D_pause_resume_holes = {
      ok: dOk,
      micBegin: micBegin.length,
      micEnd: micEnd.length,
      sysBegin: sysBegin.length,
      sysEnd: sysEnd.length,
      micDiscard: micDiscard.length,
      sysDiscard: sysDiscard.length,
      pauseRelated,
      pauseHoleQpc: pause.result?.data?.holeQpc,
      sampleMicEnd: micEnd[0] || null,
      sampleSysEnd: sysEnd[0] || null
    };

    // --- E: bad device ---
    const mic2 = path.join(root, "bad", "audio", "microphone");
    const sys2 = path.join(root, "bad", "audio", "system");
    await fsp.mkdir(mic2, { recursive: true });
    await fsp.mkdir(sys2, { recursive: true });
    const bad = await client.send("start", {
      session_id: "bad-device-sess",
      capture_mode: "dual",
      microphone: { output_dir: mic2 },
      system: { device_id: "{00000000-0000-0000-0000-000000000000}", output_dir: sys2 },
      subchunk_ms: 1000
    });
    const badOk = bad.result?.ok === false;
    const m2 = readManifest(mic2);
    const s2 = readManifest(sys2);
    const noFakeRecording =
      (!m2 || m2.recording !== true) && (!s2 || s2.recording !== true);
    report.E_bad_device_manifest = {
      ok: badOk && noFakeRecording,
      startOk: bad.result?.ok,
      error: bad.result?.error || null,
      micManifestRecording: m2?.recording ?? null,
      sysManifestRecording: s2?.recording ?? null
    };

    await client.shutdown();
  } catch (error) {
    report.notes.push(String(error && error.stack ? error.stack : error));
    try {
      await client.shutdown();
    } catch {
      // ignore
    }
  }

  const outPath = path.join(root, "smoke-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("\n=== Stage 0B smoke report ===");
  console.log(JSON.stringify(report, null, 2));
  console.log("report file:", outPath);

  const critical = ["A_dual_capture", "C_silence_timeline", "D_pause_resume_holes", "E_bad_device_manifest"];
  const failed = critical.filter((k) => report[k] && report[k].ok === false);
  if (failed.length || report.notes.length) {
    console.error("smoke incomplete/failed:", failed.join(", ") || "exception");
    process.exitCode = 1;
  } else {
    console.log("smoke critical checks passed (B energy may be zero if no playback).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
