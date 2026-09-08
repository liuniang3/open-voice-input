"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  sanitizeLogDetail,
  sanitizeLogMessage,
  formatLogLine,
  createRuntimeLogWriter,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES
} = require("../src/runtime-log");

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ovi-log-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  // Build fake credentials at runtime so the repository secret scanner does not
  // mistake test fixtures for credentials.
  const fakeSk = ["s", "k-", "abcdefghijklmnopqrstuvwxyz"].join("");
  const fakeTp = ["t", "p-", "1234567890abcdef"].join("");
  const fakeSkProj = ["s", "k-", "proj-AbCdEfGhIjKlMnOpQrStUvWx_yz-123456"].join("");

  await test("sanitize strips data-uri / long base64 and truncates", () => {
    const uri = sanitizeLogDetail(`prefix data:audio/wav;base64,${"A".repeat(400)} suffix`);
    assert.ok(uri.includes("[data-uri-omitted]"));
    assert.ok(!uri.includes("AAAA"));
    const b64 = sanitizeLogDetail(`x ${"B".repeat(300)}= y`);
    assert.ok(b64.includes("[base64-omitted]"));
    const long = sanitizeLogDetail("字".repeat(5000), 100);
    assert.ok(long.length < 200);
    assert.ok(long.includes("truncated"));
    assert.equal(sanitizeLogDetail(Buffer.from("abc")), "[buffer 3 bytes]");
  });

  await test("redacts sk-/tp-/Bearer in detail and message", () => {
    const d = sanitizeLogDetail(`key=${fakeSk} token Bearer abcdefghijklmnop`);
    assert.ok(d.includes("sk-[redacted]"));
    assert.ok(d.includes("Bearer [redacted]"));
    assert.ok(!d.includes("sk-abcdefghijklmnop"));
    assert.ok(!d.includes("Bearer abcdefghijklmnop"));
    const m = sanitizeLogMessage(`auth ${fakeTp} fail`);
    assert.ok(m.includes("tp-[redacted]"));
    assert.ok(!m.includes("tp-1234567890abcdef"));
    // ordinary transcript-like text kept
    const prose = sanitizeLogDetail("大家好，今天开会讨论 api 接口设计，不是密钥");
    assert.ok(prose.includes("大家好"));
    assert.ok(prose.includes("开会"));
  });

  await test("redacts sk-proj free text and accessKeyId/secret/token objects", () => {
    const free = sanitizeLogDetail(`using ${fakeSkProj} on client`);
    assert.ok(free.includes("sk-[redacted]"));
    assert.ok(!free.includes(fakeSkProj));
    // normal transcript with words like token/secret as language must survive when not key-shaped
    const talk = sanitizeLogDetail("他说 secret 其实是保密级别，不是 access key");
    assert.ok(talk.includes("保密级别"));
    assert.ok(talk.includes("access key") || talk.includes("access"));

    const fakeAkId = ["LTAI", "5tExampleAccessKeyIdValue"].join("");
    const obj = {
      note: "转写：明天继续讨论",
      accessKeyId: fakeAkId,
      access_key_secret: "verySecretAccessKeySecretValue99",
      accessKeySecret: "Another-Access-Key-Secret-Value",
      token: "session-token-value-should-hide",
      nested: { Token: "CamelTokenShouldHideToo-xxxxxx" }
    };
    const s = sanitizeLogDetail(obj);
    assert.ok(s.includes("转写"));
    assert.ok(s.includes("[redacted]"));
    assert.ok(!s.includes(fakeAkId));
    assert.ok(!s.includes("verySecretAccessKeySecretValue99"));
    assert.ok(!s.includes("Another-Access-Key-Secret-Value"));
    assert.ok(!s.includes("session-token-value-should-hide"));
    assert.ok(!s.includes("CamelTokenShouldHideToo"));
  });

  await test("JSON object recursive apiKey/authorization scrub + cycles", () => {
    const obj = {
      text: "会议纪要：通过了方案",
      apiKey: `${["s", "k-", "live-should-not-leak-xxxxxxxxxxxx"].join("")}`,
      nested: {
        authorization: "Bearer super-secret-token-value",
        api_key: "plain-secret-value-here",
        ok: true
      }
    };
    obj.self = obj;
    const s = sanitizeLogDetail(obj);
    assert.ok(s.includes("[redacted]"));
    assert.ok(s.includes("[circular]"));
    assert.ok(s.includes("会议纪要"));
    assert.ok(!s.includes("live-should-not-leak"));
    assert.ok(!s.includes("super-secret-token-value"));
    assert.ok(!s.includes("plain-secret-value-here"));
    // stringified JSON field form
    const rawKey = ["s", "k-", "abcdefghij0123456789"].join("");
    const raw = sanitizeLogDetail(`{"apiKey":"${rawKey}","msg":"hi"}`);
    assert.ok(raw.includes("[redacted]") || raw.includes("sk-[redacted]"));
    assert.ok(!raw.includes(rawKey));
  });

  await test("formatLogLine redacts secrets in message", () => {
    const lineKey = ["s", "k-", "zzzzzzzzzzzzzzzzzz"].join("");
    const line = formatLogLine("login Bearer secretvalue123456", `apiKey=${lineKey}`, {
      now: () => new Date("2020-01-02T03:04:05.000Z")
    });
    assert.ok(line.includes("Bearer [redacted]"));
    assert.ok(line.includes("sk-[redacted]") || line.includes("[redacted]"));
    assert.ok(!line.includes("secretvalue123456"));
    assert.ok(!line.includes(lineKey));
  });

  await test("formatLogLine is single line with timestamp", () => {
    const line = formatLogLine("hello", "world\nnext", {
      now: () => new Date("2020-01-02T03:04:05.000Z")
    });
    assert.equal(line.startsWith("[2020-01-02T03:04:05.000Z] hello world"), true);
    assert.equal(line.endsWith("\n"), true);
    assert.equal(line.includes("\nnext"), false);
  });

  await test("serial queue writes in order", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "app.log");
      const writer = createRuntimeLogWriter({ logFilePath: logPath, maxFileBytes: 1024 * 1024 });
      for (let i = 0; i < 20; i += 1) writer.enqueue(`msg-${i}`);
      await writer.flush();
      const body = await fsp.readFile(logPath, "utf8");
      const lines = body.trim().split("\n");
      assert.equal(lines.length, 20);
      for (let i = 0; i < 20; i += 1) {
        assert.ok(lines[i].includes(`msg-${i}`), lines[i]);
      }
      await writer.close();
    });
  });

  await test("close includes final message then rejects enqueue", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "app.log");
      const writer = createRuntimeLogWriter({ logFilePath: logPath, maxFileBytes: 1024 * 1024 });
      writer.enqueue("before-close");
      await writer.close("app: before-quit cleanup done");
      assert.equal(writer.closed, true);
      const rejected = writer.enqueue("after-close-should-drop");
      assert.equal(rejected, false);
      await writer.flush();
      const body = await fsp.readFile(logPath, "utf8");
      assert.ok(body.includes("before-close"));
      assert.ok(body.includes("app: before-quit cleanup done"));
      assert.equal(body.includes("after-close-should-drop"), false);
      // second close is safe
      await writer.close("ignored");
      const body2 = await fsp.readFile(logPath, "utf8");
      assert.equal(body2.includes("ignored"), false);
    });
  });

  await test("rotation keeps current + .1 + .2 and bounds size", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "app.log");
      const writer = createRuntimeLogWriter({
        logFilePath: logPath,
        maxFileBytes: 800,
        maxFiles: 3,
        maxDetailChars: 200,
        maxLineChars: 300
      });
      for (let i = 0; i < 80; i += 1) {
        writer.enqueue("rotate", `payload-${i}-${"x".repeat(120)}`);
      }
      await writer.flush();
      const st = await fsp.stat(logPath);
      assert.ok(st.size <= 800 + 400, `current too large: ${st.size}`);
      const names = await fsp.readdir(dir);
      assert.ok(names.includes("app.log"));
      assert.ok(names.includes("app.log.1"), names.join(","));
      assert.ok(names.includes("app.log.2"), names.join(","));
      assert.equal(names.includes("app.log.3"), false);
      await writer.close();
    });
  });

  await test("write failure does not reject enqueue / flush", async () => {
    let appendCalls = 0;
    const boomFs = {
      async mkdir() {},
      async stat() {
        const err = new Error("missing");
        err.code = "ENOENT";
        throw err;
      },
      async appendFile() {
        appendCalls += 1;
        throw new Error("disk full");
      },
      async rename() {
        throw new Error("nope");
      },
      async rm() {},
      async copyFile() {},
      async writeFile() {}
    };
    const writer = createRuntimeLogWriter({
      logFilePath: path.join(os.tmpdir(), "ovi-log-fail.log"),
      fsImpl: boomFs
    });
    writer.enqueue("a");
    writer.enqueue("b");
    await writer.flush();
    assert.ok(appendCalls >= 1);
    await writer.close();
  });

  await test("missing rotated peers during rename is ok", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "app.log");
      await fsp.writeFile(logPath, `${"y".repeat(500)}\n`, "utf8");
      const writer = createRuntimeLogWriter({
        logFilePath: logPath,
        maxFileBytes: 200,
        maxFiles: 3
      });
      writer.enqueue("force-rotate", "z".repeat(100));
      await writer.flush();
      const names = await fsp.readdir(dir);
      assert.ok(names.includes("app.log"));
      await writer.close();
    });
  });

  await test("default max file is 5 MiB per file (≈15 MiB with 3 files)", () => {
    assert.equal(DEFAULT_MAX_FILE_BYTES, 5 * 1024 * 1024);
    assert.equal(DEFAULT_MAX_FILES, 3);
  });

  console.log(`\n${passed} tests passed`);
}

main();
