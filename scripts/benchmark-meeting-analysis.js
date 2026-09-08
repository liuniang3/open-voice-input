#!/usr/bin/env node
"use strict";

/**
 * Meeting analysis + correction benchmark via local opencode CLI.
 * No API keys in args, fixtures, or reports.
 */

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { scoreCase, runSelfTest, validateSchema } = require("../experiments/meeting-analysis/score.js");

/** Relative path under global npm root for Windows opencode-ai package binary. */
const WIN_OPENCODE_REL = path.join("opencode-ai", "bin", "opencode.exe");

const ROOT = path.resolve(__dirname, "..");
const CASES_DIR = path.join(ROOT, "experiments", "meeting-analysis", "cases");
const SCHEMA_PATH = path.join(ROOT, "experiments", "meeting-analysis", "output-schema.json");
const RESULTS_ROOT = path.join(ROOT, "experiments", "results", "meeting-analysis");

function printHelp() {
  const text = `
meeting-analysis benchmark (opencode CLI)

Usage:
  node scripts/benchmark-meeting-analysis.js [options]
  npm run benchmark:meeting-analysis -- [options]

Options:
  --models <list>     Comma-separated provider/model ids (required unless --self-test / --dry-run / --rescore)
  --repeats <n>       Repeats per case/model (default 1)
  --variant <name>    opencode --variant (e.g. high, max, minimal)
  --case <ids>        Comma-separated case ids: A,B,C (default all)
  --timeout <ms>      Per-call timeout ms (default 300000)
  --dry-run           Build prompts and score a fixture output; no model calls
  --self-test         Run offline scorer unit checks and exit
  --rescore <dirs>    Re-score existing run dirs (comma-separated run ids or relative paths under results root); no model calls
  --help              Show this help

Examples:
  node scripts/benchmark-meeting-analysis.js --self-test
  node scripts/benchmark-meeting-analysis.js --dry-run --case A
  node scripts/benchmark-meeting-analysis.js --models opencode/grok-4.5 --repeats 1 --case A,C
  node scripts/benchmark-meeting-analysis.js --rescore 20260720-214503468-22640,20260720-214503493-53136

Notes:
  - Invokes: opencode run -m <provider/model> [--variant ...] <prompt>
  - Windows: resolves opencode via %APPDATA%/npm/node_modules/opencode-ai/bin/opencode.exe
    or npm.cmd root -g + opencode-ai/bin/opencode.exe (no shell, prompt is argv only).
  - Prompt asks for one strict JSON object only.
  - Results: experiments/results/meeting-analysis/<run-id>/
  - --rescore reloads modelOutput from per-attempt JSON, rewrites scores + summary; keeps latency/model meta.
  - Never writes keys, env, settings, or absolute user paths into reports.
`.trim();
  console.log(text);
}

/**
 * Resolve opencode CLI binary without shell:true and without embedding prompts.
 * Windows: APPDATA npm global path, then npm.cmd root -g + relative package bin.
 * Non-Windows: bare "opencode" (PATH).
 * @returns {{ command: string, argsPrefix: string[], resolvedFrom: string, exists: boolean }}
 */
function resolveOpencodeCommand() {
  if (process.platform === "win32") {
    const candidates = [];

    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push({
        command: path.join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
        resolvedFrom: "APPDATA/npm/node_modules/opencode-ai/bin/opencode.exe"
      });
    }

    try {
      const npmRoot = String(
        execFileSync("npm.cmd", ["root", "-g"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 1024 * 1024
        })
      ).trim();
      if (npmRoot) {
        candidates.push({
          command: path.join(npmRoot, WIN_OPENCODE_REL),
          resolvedFrom: "npm.cmd root -g + opencode-ai/bin/opencode.exe"
        });
      }
    } catch {
      /* npm.cmd unavailable — try other candidates */
    }

    for (const c of candidates) {
      if (c.command && fs.existsSync(c.command)) {
        return {
          command: c.command,
          argsPrefix: [],
          resolvedFrom: c.resolvedFrom,
          exists: true
        };
      }
    }

    return {
      command: null,
      argsPrefix: [],
      resolvedFrom: "unresolved",
      exists: false,
      tried: candidates.map((c) => sanitizeForReport(c.command || ""))
    };
  }

  return {
    command: "opencode",
    argsPrefix: [],
    resolvedFrom: "PATH",
    exists: true
  };
}

function requireOpencodeCommand() {
  const resolved = resolveOpencodeCommand();
  if (!resolved.exists || !resolved.command) {
    const tried =
      Array.isArray(resolved.tried) && resolved.tried.length
        ? ` Tried: ${resolved.tried.join("; ")}`
        : "";
    throw new Error(
      "opencode CLI not found. On Windows install the global package (opencode-ai) so " +
        "opencode.exe exists under the npm global node_modules, or ensure APPDATA/npm layout is standard." +
        tried
    );
  }
  return resolved;
}

function parseArgs(argv) {
  const out = {
    models: [],
    repeats: 1,
    variant: null,
    cases: null,
    timeout: 300000,
    dryRun: false,
    selfTest: false,
    rescore: null,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--models") out.models = splitCsv(next());
    else if (a === "--repeats") out.repeats = Math.max(1, parseInt(next(), 10) || 1);
    else if (a === "--variant") out.variant = String(next() || "").trim() || null;
    else if (a === "--case" || a === "--cases") out.cases = splitCsv(next());
    else if (a === "--timeout") out.timeout = Math.max(1000, parseInt(next(), 10) || 300000);
    else if (a === "--rescore") out.rescore = splitCsv(next());
    else if (a.startsWith("--models=")) out.models = splitCsv(a.slice(9));
    else if (a.startsWith("--repeats=")) out.repeats = Math.max(1, parseInt(a.slice(10), 10) || 1);
    else if (a.startsWith("--variant=")) out.variant = a.slice(10).trim() || null;
    else if (a.startsWith("--case=")) out.cases = splitCsv(a.slice(7));
    else if (a.startsWith("--timeout=")) out.timeout = Math.max(1000, parseInt(a.slice(10), 10) || 300000);
    else if (a.startsWith("--rescore=")) out.rescore = splitCsv(a.slice(10));
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function splitCsv(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function relPosix(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

function loadCases(filterIds) {
  const files = fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const cases = files.map((f) => {
    const full = path.join(CASES_DIR, f);
    const data = JSON.parse(fs.readFileSync(full, "utf8"));
    data._file = relPosix(full);
    return data;
  });
  if (!filterIds || !filterIds.length) return cases;
  const wanted = new Set(filterIds.map((x) => x.toUpperCase()));
  const selected = cases.filter((c) => wanted.has(String(c.id).toUpperCase()));
  const found = new Set(selected.map((c) => String(c.id).toUpperCase()));
  for (const w of wanted) {
    if (!found.has(w)) throw new Error(`Unknown case id: ${w}`);
  }
  return selected;
}

function loadSchemaHint() {
  try {
    return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  } catch {
    return null;
  }
}

function buildPrompt(caseData, schemaHint) {
  const template = caseData.template === "personal" ? "personal" : "meeting";
  const items = (caseData.rawItems || []).map((it) => ({
    id: it.id,
    speakerId: it.speakerId || null,
    beginMs: it.beginMs ?? null,
    endMs: it.endMs ?? null,
    text: it.text
  }));

  const meetingExtra =
    template === "meeting"
      ? `
Meeting fields (use empty arrays when truly absent — do NOT invent decisions or action items):
- executiveSummary: { text, sourceItemIds }
- topicsOutline: [{ title, sourceItemIds, children? }]
- timeline: [{ text|label, sourceItemIds }]
- speakerPoints: [{ speakerId, points: [{ text, sourceItemIds }] }]
- decisions: [{ text, sourceItemIds }]
- actionItems: [{ text, owner?, due?, sourceItemIds }]
- openIssues: [{ text, sourceItemIds }]
- risks: [{ text, sourceItemIds }]
- keyQuotes: [{ text, speakerId?, sourceItemIds }]
- facts: [{ text, sourceItemIds }]  (optional explicit facts)
`
      : `
Personal fields:
- coreIdeas: [{ text, sourceItemIds }]
- argumentOutline: [{ title, sourceItemIds, children? }]
- supportingPoints: [{ text, sourceItemIds }]
- assumptions: [{ text, sourceItemIds }]
- openQuestions: [{ text, sourceItemIds }]
- nextSteps: [{ text, sourceItemIds }]
- keyQuotes: [{ text, sourceItemIds }]
- facts: [{ text, sourceItemIds }]
`;

  return `You are a meeting-analysis benchmark engine. Output ONE JSON object only.
No markdown fences, no prose before or after the JSON.

Rules:
- Use only the provided transcript items. No outside knowledge as fact.
- Every claim needs sourceItemIds drawn only from the provided id list.
- Uncertain names/numbers/terms: keep raw wording and list in flaggedUncertain; do not invent.
- Do not add facts absent from items. Do not drop required keys listed below.
- Preserve language of source (Chinese / mixed).
- For EACH input item output exactly one correctedItems entry. Fix obvious ASR errors, punctuation, fillers. Do not merge/split items. Do not invent proper nouns or numbers.
- Rejected or merely discussed ideas must NOT appear as decisions or actionItems.
- If the transcript states there is no decision / no action item, keep those arrays empty.

Required top-level keys:
- schema: "meeting_analysis_benchmark_output_v1"
- template: "${template}"
- correctedItems: [{ sourceItemId, correctedText, ops?, uncertain? }]
- flaggedUncertain: [{ text, reason, sourceItemIds }]
${meetingExtra}

Input:
${JSON.stringify(
  {
    task: "correct_and_summarize",
    language: "zh-CN",
    template,
    caseId: caseData.id,
    items
  },
  null,
  0
)}

Return the JSON object now.`;
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    const err = new Error("empty_model_output");
    err.code = "empty_model_output";
    throw err;
  }
  // strip fences
  let s = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    // find outermost object
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = s.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (e) {
      const err = new Error("json_parse_failed");
      err.code = "json_parse_failed";
      err.causeMessage = e.message;
      throw err;
    }
  }
  const err = new Error("json_not_found");
  err.code = "json_not_found";
  throw err;
}

function runOpencode({ model, variant, prompt, timeoutMs, command, argsPrefix }) {
  return new Promise((resolve) => {
    const args = [...(argsPrefix || []), "run", "-m", model, "--format", "default"];
    if (variant) {
      args.push("--variant", variant);
    }
    // message as positional argv — never shell:true, never string-concat prompt
    args.push(prompt);

    const started = Date.now();
    let settled = false;
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      shell: false,
      // close stdin so non-interactive CLIs do not wait for more input
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const maxCap = 2 * 1024 * 1024;
    child.stdout.on("data", (buf) => {
      if (stdout.length < maxCap) stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (buf) => {
      if (stderr.length < maxCap) stderr += buf.toString("utf8");
    });

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      settled = true;
      resolve({
        ok: false,
        code: null,
        signal: "timeout",
        stdout,
        stderr: stderr.slice(0, 4000),
        ms: Date.now() - started,
        error: "timeout"
      });
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        signal: null,
        stdout,
        stderr: String(error.message || error).slice(0, 4000),
        ms: Date.now() - started,
        error: "spawn_error"
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        signal,
        stdout,
        stderr: stderr.slice(0, 4000),
        ms: Date.now() - started,
        error: code === 0 ? null : "exit_nonzero"
      });
    });
  });
}

function sanitizeForReport(value) {
  // strip absolute windows/unix user paths and obvious secrets
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, "<user-home>")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "<user-home>")
    .replace(/(api[_-]?key|authorization|token|secret)\s*[:=]\s*["']?[^\s"',}]+/gi, "$1=<redacted>")
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+\b/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z0-9_-]{20,}={0,2}\b/g, (m) => {
      // long opaque tokens (base64-ish) — keep short identifiers
      if (/^[A-Za-z0-9._-]+$/.test(m) && m.length >= 32) return "<redacted>";
      return m;
    });
}

/**
 * Offline checks for CLI resolution logic (no live model call).
 * Does not print absolute user paths.
 */
function runCliResolutionSelfTest() {
  const failures = [];
  const r = resolveOpencodeCommand();

  if (process.platform === "win32") {
    if (typeof r.exists !== "boolean") failures.push("cli_exists_not_boolean");
    if (r.exists) {
      if (!r.command || typeof r.command !== "string") failures.push("cli_command_missing");
      else if (!r.command.toLowerCase().endsWith("opencode.exe")) failures.push("cli_not_opencode_exe");
      else if (!fs.existsSync(r.command)) failures.push("cli_path_missing_on_disk");
      if (!r.resolvedFrom || r.resolvedFrom === "unresolved") failures.push("cli_resolvedFrom_empty");
      // must not use shell-style command lines
      if (/\s/.test(path.basename(r.command || ""))) failures.push("cli_basename_has_space");
    } else {
      if (r.command != null) failures.push("cli_missing_should_null_command");
      // requireOpencodeCommand must throw a clear error
      let threw = false;
      try {
        requireOpencodeCommand();
      } catch (e) {
        threw = true;
        const msg = String(e.message || e);
        if (!/opencode CLI not found/i.test(msg)) failures.push("cli_error_message_unclear");
        if (/[A-Za-z]:\\Users\\/i.test(msg) && !/<user-home>/.test(sanitizeForReport(msg))) {
          // error may include tried paths — ensure sanitize covers them in reports
        }
        const sanitized = sanitizeForReport(msg);
        if (/[A-Za-z]:\\Users\\[^\\\s]+/i.test(sanitized)) failures.push("cli_error_leaks_user_path");
      }
      if (!threw) failures.push("cli_require_did_not_throw");
    }
  } else {
    if (r.command !== "opencode") failures.push("cli_nonwin_not_opencode");
    if (!r.exists) failures.push("cli_nonwin_exists_false");
    if (r.resolvedFrom !== "PATH") failures.push("cli_nonwin_resolvedFrom");
  }

  // sanitize must redact user homes in previews
  const sample = "C:\\Users\\someone\\AppData\\Roaming\\npm\\x and /Users/foo/bar sk-abcdefghijklmnop Bearer tok.en.value";
  const cleaned = sanitizeForReport(sample);
  if (/Users\\someone/i.test(cleaned) || /\/Users\/foo/.test(cleaned)) failures.push("sanitize_user_path");
  if (/sk-abcdefghijklmnop/.test(cleaned)) failures.push("sanitize_sk");
  if (/Bearer tok\.en\.value/i.test(cleaned)) failures.push("sanitize_bearer");

  // spawn contract: shell must be false (static check via function source, ignore comments)
  const src = runOpencode
    .toString()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  if (/shell\s*:\s*true/.test(src)) failures.push("runOpencode_shell_true");
  if (!/shell\s*:\s*false/.test(src)) failures.push("runOpencode_shell_false_missing");

  return {
    ok: failures.length === 0,
    failures,
    platform: process.platform,
    resolvedFrom: r.resolvedFrom,
    exists: r.exists
  };
}

function runFullSelfTest() {
  const score = runSelfTest();
  const cli = runCliResolutionSelfTest();
  const runId = runMakeRunIdSelfTest();
  const failures = [
    ...(score.failures || []),
    ...(cli.failures || []).map((f) => `cli:${f}`),
    ...(runId.failures || []).map((f) => `runId:${f}`)
  ];
  return {
    ok: failures.length === 0 && score.ok && cli.ok && runId.ok,
    failures,
    score: {
      ok: score.ok,
      sampleGoodScore: score.sampleGoodScore,
      sampleFailCallScore: score.sampleFailCallScore,
      sampleFailJsonScore: score.sampleFailJsonScore
    },
    cli: {
      ok: cli.ok,
      platform: cli.platform,
      resolvedFrom: cli.resolvedFrom,
      exists: cli.exists
    },
    runId: {
      ok: runId.ok,
      sample: runId.sample,
      uniqueCount: runId.uniqueCount
    }
  };
}

let _runIdSeq = 0;

/** Windows-safe run dir id: date-time-ms-pid[-seq] so parallel runners never share a folder. */
function makeRunId(now = new Date(), pid = process.pid) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const ms = p(d.getMilliseconds(), 3);
  const safePid = String(pid).replace(/[^0-9]/g, "") || "0";
  const seq = _runIdSeq++;
  const base =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${ms}` +
    `-${safePid}`;
  return seq === 0 ? base : `${base}-${seq}`;
}

function runMakeRunIdSelfTest() {
  const failures = [];
  const re = /^\d{8}-\d{9}-\d+(-\d+)?$/;
  const saved = _runIdSeq;
  _runIdSeq = 0;
  const a = makeRunId(new Date(2026, 6, 20, 12, 34, 56, 789), 12345);
  if (a !== "20260720-123456789-12345") failures.push(`format expected 20260720-123456789-12345 got ${a}`);
  if (!re.test(a)) failures.push(`regex fail: ${a}`);
  if (/[<>:"/\\|?*\x00-\x1f]/.test(a)) failures.push(`unsafe filename chars: ${a}`);

  _runIdSeq = 0;
  const b = makeRunId(new Date(2026, 6, 20, 12, 34, 56, 789), 99999);
  if (a === b) failures.push("same timestamp different pid must differ");
  if (!b.endsWith("-99999")) failures.push(`pid suffix missing: ${b}`);

  _runIdSeq = 0;
  const c = makeRunId(new Date(2026, 6, 20, 12, 34, 56, 790), 12345);
  if (a === c) failures.push("same second different ms must differ");

  _runIdSeq = 0;
  const burst = [];
  for (let i = 0; i < 40; i += 1) burst.push(makeRunId(new Date(2026, 6, 20, 12, 34, 56, 789), 4242));
  const unique = new Set(burst);
  if (unique.size !== burst.length) {
    failures.push(`consecutive makeRunId collisions: ${burst.length - unique.size} dupes`);
  }
  if (burst[0] !== "20260720-123456789-4242") failures.push(`burst[0] bad: ${burst[0]}`);
  if (burst[1] !== "20260720-123456789-4242-1") failures.push(`burst[1] seq missing: ${burst[1]}`);
  for (const id of burst) {
    if (!re.test(id)) failures.push(`burst id regex fail: ${id}`);
    if (/[<>:"/\\|?*\x00-\x1f]/.test(id)) failures.push(`unsafe: ${id}`);
  }

  _runIdSeq = saved;
  return {
    ok: failures.length === 0,
    failures,
    sample: a,
    uniqueCount: unique.size
  };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(file, obj) {
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

function fixtureModelOutput(caseData) {
  // Deterministic offline fixture for dry-run scoring paths
  const correctedItems = (caseData.rawItems || []).map((it) => ({
    sourceItemId: it.id,
    correctedText: String(it.text || "").replace(/呃|嗯/g, "").replace(/\s+/g, " ").trim()
  }));
  if (caseData.template === "personal") {
    return {
      schema: "meeting_analysis_benchmark_output_v1",
      template: "personal",
      correctedItems,
      coreIdeas: [
        { text: "核心是插入焦点稳定，不是识别率", sourceItemIds: ["b01"] },
        { text: "延迟感比绝对准确更重要", sourceItemIds: ["b02"] }
      ],
      supportingPoints: [
        { text: "保留 SendInput、input_audio、gpt-5.4-mini", sourceItemIds: ["b03"] },
        { text: "本地规则先兜底，不要上云端默认清理", sourceItemIds: ["b05"] }
      ],
      assumptions: [{ text: "代码编辑器中 4096 与 8787 不可改写", sourceItemIds: ["b07"] }],
      openQuestions: [{ text: "会议与个人模式是否共用 prompt", sourceItemIds: ["b08"] }],
      nextSteps: [{ text: "对比表：准确率百分之八十七点五与三百毫秒", sourceItemIds: ["b09"] }],
      facts: [
        { text: "准确率百分之八十七点五", sourceItemIds: ["b04"] },
        { text: "延迟目标三百毫秒", sourceItemIds: ["b09"] }
      ],
      flaggedUncertain: []
    };
  }
  if (caseData.id === "C") {
    return {
      schema: "meeting_analysis_benchmark_output_v1",
      template: "meeting",
      correctedItems,
      executiveSummary: {
        text: "头脑风暴，不做最终决定，无行动项",
        sourceItemIds: ["c01", "c08"]
      },
      decisions: [],
      actionItems: [],
      openIssues: [
        { text: "是否做盲测对比仍是开放问题", sourceItemIds: ["c09"] },
        { text: "风险是范围蔓延", sourceItemIds: ["c06"] }
      ],
      risks: [{ text: "范围蔓延", sourceItemIds: ["c06"] }],
      facts: [
        { text: "讨论过全量重写但未拍板", sourceItemIds: ["c02"] },
        { text: "去掉本地只走云端被讨论未采纳", sourceItemIds: ["c07"] },
        { text: "商业 SDK 报价据说二十万仅聊聊", sourceItemIds: ["c03"] }
      ],
      flaggedUncertain: []
    };
  }
  // case A-like
  return {
    schema: "meeting_analysis_benchmark_output_v1",
    template: "meeting",
    correctedItems,
    executiveSummary: {
      text: "否决双入口，Q3 只上线快捷键语音入口",
      sourceItemIds: ["a03", "a04"]
    },
    decisions: [
      {
        text: "最终决定：Q3 只上线快捷键，否决双入口方案",
        sourceItemIds: ["a04", "a03"]
      }
    ],
    actionItems: [
      {
        text: "林晓负责快捷键入口 PRD",
        owner: "林晓",
        due: "下周五",
        sourceItemIds: ["a06"]
      }
    ],
    facts: [
      { text: "排期讨论 Q3 语音入口", sourceItemIds: ["a01"] },
      { text: "延迟平均二百八十毫秒峰值四百", sourceItemIds: ["a05"] },
      { text: "灰度内部一百人", sourceItemIds: ["a08"] },
      { text: "下周一同步进度", sourceItemIds: ["a09"] }
    ],
    openIssues: [],
    flaggedUncertain: [
      { text: "柯林斯塔/科林斯塔", reason: "uncertain proper name", sourceItemIds: ["a07"] }
    ]
  };
}

function summarizeRuns(runs) {
  const byModel = {};
  for (const r of runs) {
    const key = r.model;
    if (!byModel[key]) {
      byModel[key] = {
        model: key,
        variant: r.variant,
        n: 0,
        callOk: 0,
        jsonOk: 0,
        validRuns: 0,
        compositeSum: 0,
        claimRecallSum: 0,
        mustNotClean: 0,
        preserveSum: 0,
        coverageSum: 0,
        latencyMs: []
      };
    }
    const b = byModel[key];
    b.n += 1;
    if (r.scores?.callOk) b.callOk += 1;
    if (r.scores?.jsonOk) b.jsonOk += 1;
    // composite / recall / preserve / coverage: failed runs count as 0
    b.compositeSum += r.scores?.compositeScore || 0;
    b.claimRecallSum += r.scores?.claims?.recall || 0;
    b.preserveSum += r.scores?.mustPreserve?.ratio || 0;
    b.coverageSum += r.scores?.correctedCoverage?.ratio || 0;
    // mustNotCleanRate: only over callOk+jsonOk valid results
    if (r.scores?.callOk && r.scores?.jsonOk) {
      b.validRuns += 1;
      if (r.scores?.mustNot?.clean) b.mustNotClean += 1;
    }
    if (typeof r.latencyMs === "number") b.latencyMs.push(r.latencyMs);
  }

  const models = Object.values(byModel).map((b) => {
    const med = median(b.latencyMs);
    return {
      model: b.model,
      variant: b.variant,
      runs: b.n,
      validRuns: b.validRuns,
      callSuccessRate: b.n ? b.callOk / b.n : 0,
      jsonSchemaRate: b.n ? b.jsonOk / b.n : 0,
      meanComposite: b.n ? round(b.compositeSum / b.n) : 0,
      meanClaimRecall: b.n ? round(b.claimRecallSum / b.n) : 0,
      mustNotCleanRate: b.validRuns ? round(b.mustNotClean / b.validRuns) : 0,
      meanPreserve: b.n ? round(b.preserveSum / b.n) : 0,
      meanCoverage: b.n ? round(b.coverageSum / b.n) : 0,
      medianLatencyMs: med
    };
  });

  return {
    totalRuns: runs.length,
    models,
    byCase: aggregateByCase(runs)
  };
}

function aggregateByCase(runs) {
  const map = {};
  for (const r of runs) {
    const k = r.caseId;
    if (!map[k]) map[k] = { caseId: k, n: 0, meanComposite: 0, meanRecall: 0 };
    map[k].n += 1;
    map[k].meanComposite += r.scores?.compositeScore || 0;
    map[k].meanRecall += r.scores?.claims?.recall || 0;
  }
  return Object.values(map).map((x) => ({
    caseId: x.caseId,
    runs: x.n,
    meanComposite: x.n ? round(x.meanComposite / x.n) : 0,
    meanClaimRecall: x.n ? round(x.meanRecall / x.n) : 0
  }));
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function renderMarkdown(summary, meta) {
  const lines = [];
  lines.push(`# Meeting analysis benchmark`);
  lines.push("");
  lines.push(`- runId: \`${meta.runId}\``);
  lines.push(`- cases: ${meta.caseIds.join(", ")}`);
  lines.push(`- models: ${meta.models.join(", ") || "(dry-run)"}`);
  lines.push(`- variant: ${meta.variant || "(none)"}`);
  lines.push(`- repeats: ${meta.repeats}`);
  lines.push(`- mode: ${meta.mode}`);
  lines.push("");
  lines.push(`## Limitations`);
  lines.push("");
  lines.push(
    "Synthetic short/medium context smoke evaluation only. Not equivalent to multi-hour real meetings, and not a full production pipeline score (batching, rolling merge, evidence scrub, UI export are out of scope)."
  );
  lines.push("");
  lines.push(`## Model summary`);
  lines.push("");
  lines.push(
    "| model | runs | valid | call_ok | json_ok | composite | claim_recall | must_not_clean | preserve | coverage | median_ms |"
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const m of summary.models) {
    lines.push(
      `| ${m.model} | ${m.runs} | ${m.validRuns ?? 0} | ${pct(m.callSuccessRate)} | ${pct(m.jsonSchemaRate)} | ${m.meanComposite} | ${pct(m.meanClaimRecall)} | ${pct(m.mustNotCleanRate)} | ${pct(m.meanPreserve)} | ${pct(m.meanCoverage)} | ${m.medianLatencyMs ?? "-"} |`
    );
  }
  lines.push("");
  lines.push(`## By case`);
  lines.push("");
  lines.push("| case | runs | mean_composite | mean_claim_recall |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const c of summary.byCase) {
    lines.push(`| ${c.caseId} | ${c.runs} | ${c.meanComposite} | ${pct(c.meanClaimRecall)} |`);
  }
  lines.push("");
  lines.push(`## Metrics legend`);
  lines.push("");
  lines.push(
    "- claim recall: gold keyword-groups + optional sourceItemId overlap (not exact string match)"
  );
  lines.push(
    "- must_not_clean: share of callOk+jsonOk runs with no mustNotClaims hit (invalid runs excluded; 0 if validRuns=0)"
  );
  lines.push("- valid: callOk && jsonOk run count used as must_not_clean denominator");
  lines.push("- preserve: required numbers/terms still present in model JSON");
  lines.push("- coverage: correctedItems covers every input id");
  lines.push("- source ids: cited ids exist in the case");
  lines.push("- span: early/mid/late source id coverage");
  lines.push(
    "- merging multi-run dirs by model: pool same model only; report n and validRuns; do not average must_not_clean across unequal valid denominators without weighting"
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function pct(x) {
  if (x == null || Number.isNaN(x)) return "-";
  return `${Math.round(x * 1000) / 10}%`;
}

/**
 * Resolve a run dir under RESULTS_ROOT. Rejects path escape outside results root.
 * Accepts bare run id or relative path under results root. Never returns abs paths in errors to caller logs.
 */
function resolveRescoreDir(spec) {
  const raw = String(spec || "").trim();
  if (!raw) throw new Error("empty_rescore_dir");
  if (/[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\")) {
    throw new Error(`rescore_path_outside_results: absolute paths rejected`);
  }
  const cleaned = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const underRoot = cleaned.startsWith("experiments/results/meeting-analysis/")
    ? cleaned.slice("experiments/results/meeting-analysis/".length)
    : cleaned.startsWith("meeting-analysis/")
      ? cleaned.slice("meeting-analysis/".length)
      : cleaned;
  if (!underRoot || underRoot.includes("..")) {
    throw new Error(`rescore_path_outside_results: ${sanitizeForReport(raw)}`);
  }
  const target = path.resolve(RESULTS_ROOT, underRoot);
  const rootResolved = path.resolve(RESULTS_ROOT);
  const rel = path.relative(rootResolved, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`rescore_path_outside_results: ${sanitizeForReport(raw)}`);
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`rescore_dir_missing: ${relPosix(target)}`);
  }
  return { abs: target, relId: rel.split(path.sep).join("/") };
}

function loadCaseById(caseId) {
  const all = loadCases(null);
  const hit = all.find((c) => String(c.id).toUpperCase() === String(caseId).toUpperCase());
  if (!hit) throw new Error(`unknown_case_for_rescore: ${caseId}`);
  return hit;
}

function isAttemptResultFile(name) {
  if (!name.endsWith(".json")) return false;
  if (name === "summary.json") return false;
  return true;
}

/**
 * Re-score existing attempt JSONs in run dirs. No model calls.
 * Overwrites per-attempt scores and regenerates summary.json/summary.md.
 */
function rescoreRunDirs(dirSpecs) {
  const casesById = {};
  for (const c of loadCases(null)) casesById[String(c.id).toUpperCase()] = c;

  const reports = [];
  for (const spec of dirSpecs) {
    const { abs, relId } = resolveRescoreDir(spec);
    const names = fs.readdirSync(abs).filter(isAttemptResultFile).sort();
    const runs = [];
    let previousMeta = null;
    const summaryPath = path.join(abs, "summary.json");
    if (fs.existsSync(summaryPath)) {
      try {
        previousMeta = JSON.parse(fs.readFileSync(summaryPath, "utf8")).meta || null;
      } catch {
        previousMeta = null;
      }
    }

    for (const name of names) {
      const filePath = path.join(abs, name);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch (e) {
        throw new Error(`rescore_read_fail: ${relId}/${name}`);
      }
      if (!data || typeof data !== "object" || data.caseId == null) {
        // skip non-attempt json
        continue;
      }
      const caseData = casesById[String(data.caseId).toUpperCase()];
      if (!caseData) throw new Error(`unknown_case_for_rescore: ${data.caseId}`);

      const callOk = data.callOk != null ? Boolean(data.callOk) : Boolean(data.scores?.callOk);
      const jsonOk = data.jsonOk != null ? Boolean(data.jsonOk) : Boolean(data.scores?.jsonOk);
      const modelOut = data.modelOutput && typeof data.modelOutput === "object" ? data.modelOutput : {};
      const scores = scoreCase(caseData, modelOut, { callOk, jsonOk });

      data.scores = scores;
      data.callOk = callOk;
      data.jsonOk = jsonOk;
      writeJson(filePath, data);
      runs.push(data);
    }

    if (!runs.length) throw new Error(`rescore_no_attempts: ${relId}`);

    const summary = summarizeRuns(runs);
    const models = [...new Set(runs.map((r) => r.model).filter(Boolean))];
    const caseIds = [...new Set(runs.map((r) => r.caseId).filter(Boolean))];
    const variants = [...new Set(runs.map((r) => r.variant).filter((v) => v != null && v !== ""))];
    const meta = {
      runId: (previousMeta && previousMeta.runId) || relId,
      mode: "rescore",
      caseIds: previousMeta?.caseIds || caseIds,
      models: previousMeta?.models || models,
      variant: previousMeta?.variant != null ? previousMeta.variant : variants[0] || null,
      repeats: previousMeta?.repeats != null ? previousMeta.repeats : 1,
      createdAt: previousMeta?.createdAt || null,
      rescoredAt: new Date().toISOString(),
      tool: "scripts/benchmark-meeting-analysis.js",
      opencodeResolvedFrom: previousMeta?.opencodeResolvedFrom || null,
      notes:
        previousMeta?.notes ||
        "Synthetic short/medium context; not a multi-hour meeting eval; keys/env/settings/abs paths excluded."
    };

    const summaryObj = { meta, summary, runs: runs.map(compactRun) };
    writeJson(path.join(abs, "summary.json"), summaryObj);
    fs.writeFileSync(path.join(abs, "summary.md"), renderMarkdown(summary, meta), "utf8");

    reports.push({
      runId: meta.runId,
      path: relPosix(abs),
      attempts: runs.length,
      summary
    });
  }
  return reports;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message || e);
    printHelp();
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.selfTest) {
    const r = runFullSelfTest();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  if (args.rescore && args.rescore.length) {
    try {
      const reports = rescoreRunDirs(args.rescore);
      for (const rep of reports) {
        console.log(`Rescored ${rep.path} attempts=${rep.attempts}`);
        console.log(
          renderMarkdown(rep.summary, {
            runId: rep.runId,
            caseIds: rep.summary.byCase.map((c) => c.caseId),
            models: rep.summary.models.map((m) => m.model),
            variant: rep.summary.models[0]?.variant || null,
            repeats: 1,
            mode: "rescore"
          })
        );
      }
      process.exit(0);
    } catch (e) {
      console.error(sanitizeForReport(String(e.message || e)));
      process.exit(2);
    }
  }

  const cases = loadCases(args.cases);
  const schemaHint = loadSchemaHint();
  const runId = makeRunId();
  const outDir = path.join(RESULTS_ROOT, runId);
  ensureDir(outDir);

  const mode = args.dryRun ? "dry-run" : "opencode";
  if (!args.dryRun && !args.models.length) {
    console.error("ERROR: --models is required unless --dry-run, --self-test, or --rescore");
    printHelp();
    process.exit(2);
  }

  let opencodeCmd = null;
  if (!args.dryRun) {
    try {
      opencodeCmd = requireOpencodeCommand();
      process.stderr.write(
        `opencode CLI: resolvedFrom=${opencodeCmd.resolvedFrom} exists=true\n`
      );
    } catch (e) {
      console.error(sanitizeForReport(String(e.message || e)));
      process.exit(2);
    }
  }

  const models = args.dryRun ? ["fixture/dry-run"] : args.models;
  const runs = [];
  let idx = 0;

  for (const model of models) {
    for (const caseData of cases) {
      for (let rep = 1; rep <= args.repeats; rep += 1) {
        idx += 1;
        const tag = `${caseData.id}_r${rep}_${slug(model)}`;
        const prompt = buildPrompt(caseData, schemaHint);
        const promptFile = path.join(outDir, `${tag}.prompt.txt`);
        fs.writeFileSync(promptFile, prompt, "utf8");

        let call = {
          ok: true,
          ms: 0,
          stdout: "",
          stderr: "",
          error: null,
          code: 0
        };
        let modelOut = null;
        let jsonOk = false;
        let parseError = null;

        if (args.dryRun) {
          modelOut = fixtureModelOutput(caseData);
          jsonOk = validateSchema(modelOut).ok;
          call = { ok: true, ms: 0, stdout: JSON.stringify(modelOut), stderr: "", error: null, code: 0 };
        } else {
          process.stderr.write(`[${idx}] ${model} case=${caseData.id} rep=${rep} ... `);
          try {
            call = await runOpencode({
              model,
              variant: args.variant,
              prompt,
              timeoutMs: args.timeout,
              command: opencodeCmd.command,
              argsPrefix: opencodeCmd.argsPrefix
            });
          } catch (e) {
            call = {
              ok: false,
              ms: 0,
              stdout: "",
              stderr: sanitizeForReport(String(e.message || e)),
              error: "runner_exception",
              code: null
            };
          }
          try {
            modelOut = extractJsonObject(call.stdout);
            jsonOk = validateSchema(modelOut).ok;
          } catch (e) {
            parseError = e.code || e.message || "parse_error";
            jsonOk = false;
            modelOut = null;
          }
          process.stderr.write(
            `${call.ok ? "call_ok" : "call_fail"} json=${jsonOk ? "ok" : "fail"} ${call.ms}ms\n`
          );
        }

        const scores = scoreCase(caseData, modelOut || {}, {
          callOk: Boolean(call.ok),
          jsonOk: Boolean(call.ok) && jsonOk
        });

        const result = {
          runId,
          caseId: caseData.id,
          caseName: caseData.name,
          caseFile: caseData._file,
          template: caseData.template,
          model,
          variant: args.variant,
          repeat: rep,
          latencyMs: call.ms,
          callOk: Boolean(call.ok),
          exitCode: call.code,
          callError: call.error,
          jsonOk: Boolean(call.ok) && jsonOk,
          parseError,
          scores,
          modelOutput: modelOut,
          stdoutPreview: sanitizeForReport(String(call.stdout || "").slice(0, 2000)),
          stderrPreview: sanitizeForReport(String(call.stderr || "").slice(0, 1000))
        };

        const resultPath = path.join(outDir, `${tag}.json`);
        writeJson(resultPath, result);
        runs.push(result);
      }
    }
  }

  const summary = summarizeRuns(runs);
  const meta = {
    runId,
    mode,
    caseIds: cases.map((c) => c.id),
    models: args.dryRun ? [] : models,
    variant: args.variant,
    repeats: args.repeats,
    createdAt: new Date().toISOString(),
    tool: "scripts/benchmark-meeting-analysis.js",
    opencodeResolvedFrom: opencodeCmd ? opencodeCmd.resolvedFrom : null,
    notes:
      "Synthetic short/medium context; not a multi-hour meeting eval; keys/env/settings/abs paths excluded."
  };

  const summaryObj = { meta, summary, runs: runs.map(compactRun) };
  writeJson(path.join(outDir, "summary.json"), summaryObj);
  fs.writeFileSync(path.join(outDir, "summary.md"), renderMarkdown(summary, meta), "utf8");

  console.log(`Wrote ${relPosix(outDir)}`);
  console.log(renderMarkdown(summary, meta));
}

function compactRun(r) {
  return {
    caseId: r.caseId,
    model: r.model,
    variant: r.variant,
    repeat: r.repeat,
    latencyMs: r.latencyMs,
    callOk: r.callOk,
    jsonOk: r.jsonOk,
    parseError: r.parseError,
    compositeScore: r.scores?.compositeScore,
    claimRecall: r.scores?.claims?.recall,
    mustNotClean: r.scores?.mustNot?.clean,
    preserveRatio: r.scores?.mustPreserve?.ratio,
    coverageRatio: r.scores?.correctedCoverage?.ratio,
    sourceIdRatio: r.scores?.sourceItemIds?.ratio,
    spanMean: r.scores?.spanCoverage?.mean,
    resultFile: `${r.caseId}_r${r.repeat}_${slug(r.model)}.json`
  };
}

function slug(model) {
  return String(model)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

main().catch((e) => {
  console.error(sanitizeForReport(String(e && e.stack ? e.stack : e)));
  process.exit(1);
});
