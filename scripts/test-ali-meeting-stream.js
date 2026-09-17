"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  createAliMeetingStream, resolveAliMeetingUrl, isSupportedAliMeetingModel, ALI_MEETING_MODELS, ALI_MEETING_WS_URL
} = require("../src/providers/asr/ali-meeting-stream");

const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const code = expected => error => error.code === expected && !error.message.includes("PRIVATE_FIXTURE");

class FakeWebSocket extends EventEmitter {
  static instances = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.callbacks = [];
    this.terminations = 0;
    FakeWebSocket.instances.push(this);
  }
  open() { this.readyState = 1; this.emit("open"); }
  send(data, options, callback) {
    if (this.throwSend) throw new Error("PRIVATE_FIXTURE send exception");
    const value = options.binary ? Buffer.from(data) : JSON.parse(data);
    this.sent.push({ value, binary: options.binary });
    this.onSend?.(value, options);
    if (this.holdCallbacks) this.callbacks.push(callback);
    else callback(this.sendError ? new Error("PRIVATE_FIXTURE send callback") : undefined);
  }
  event(name, payload = {}, header = {}, representation = "buffer") {
    const json = JSON.stringify({ header: { event: name, task_id: this.taskId, ...header }, payload });
    const data = representation === "string" ? json : representation === "arraybuffer" ?
      Uint8Array.from(Buffer.from(json)).buffer : representation === "fragments" ?
        [Buffer.from(json.slice(0, 10)), Buffer.from(json.slice(10))] : Buffer.from(json);
    this.emit("message", data, false);
  }
  sentence(sentence, representation) {
    this.event("result-generated", { output: { sentence } }, {}, representation);
  }
  get taskId() { return this.sent.find(s => s.value.header?.action === "run-task")?.value.header.task_id; }
  disconnect() { this.readyState = 3; this.emit("close", 1006, Buffer.from("PRIVATE_FIXTURE close")); }
  close() {
    this.readyState = 2;
    if (!this.hangClose) this.disconnect();
  }
  terminate() {
    this.terminations++;
    if (!this.hangTerminate) this.disconnect();
  }
}

function setup(options = {}) {
  const sentences = [];
  const errors = [];
  const stream = createAliMeetingStream({
    apiKey: "test-only-placeholder",
    WebSocketImpl: FakeWebSocket,
    readyTimeoutMs: 1000,
    sendTimeoutMs: 1000,
    finishTimeoutMs: 1000,
    closeTimeoutMs: 20,
    backpressurePollMs: 2,
    onSentence: sentence => sentences.push(sentence),
    onError: error => errors.push(error),
    ...options
  });
  return { stream, ws: FakeWebSocket.instances.at(-1), sentences, errors };
}

async function start(x) {
  x.ws.open();
  x.ws.event("task-started");
  await x.stream.ready;
}

async function complete(x) {
  x.ws.onSend = value => {
    if (value.header?.action === "finish-task") x.ws.event("task-finished");
  };
  await x.stream.finish();
}

async function main() {
  let count = 0;
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on("unhandledRejection", listener);
  async function test(name, fn) {
    const firstSocket = FakeWebSocket.instances.length;
    try {
      await fn();
      await tick();
      assert.deepEqual(unhandled, [], "no unhandled promises");
      console.log(`ok - ${name}`);
      count++;
    } finally {
      for (const ws of FakeWebSocket.instances.slice(firstSocket)) ws.disconnect();
    }
  }

  try {
    await test("regional, workspace and explicit proxy routes preserve authority", async () => {
      assert.equal(resolveAliMeetingUrl(), ALI_MEETING_WS_URL);
      const bases = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com",
        "example-workspace.cn-beijing.maas.aliyuncs.com", "example-workspace.ap-southeast-1.maas.aliyuncs.com"];
      for (const host of bases) {
        for (const suffix of ["", "/", "/api/v1", "/api/v1/", "/compatible-mode/v1"])
          assert.equal(resolveAliMeetingUrl(`https://${host}${suffix}`), `wss://${host}/api-ws/v1/inference`);
      }
      const explicit = "wss://proxy.example:9443/workspaces/example/stream?workspace=example";
      assert.equal(resolveAliMeetingUrl(explicit), explicit);
      assert.equal(resolveAliMeetingUrl(explicit.replace("wss:", "https:")), explicit);
      const x = setup({ baseUrl: explicit });
      assert.equal(x.ws.url, explicit);
      assert.equal(x.ws.options.followRedirects, false);
      assert.equal(x.ws.options.headers.Authorization, "Bearer test-only-placeholder");
      assert.equal(x.ws.options.perMessageDeflate, false);
      await x.stream.close();
    });

    await test("unsafe or incompatible URLs and models fail before creating sockets", async () => {
      const initial = FakeWebSocket.instances.length;
      for (const baseUrl of ["http://example.com", "ws://example.com", "file:///tmp/socket",
        "wss://user:PRIVATE_FIXTURE@example.com/path", "https://example.com/#PRIVATE_FIXTURE",
        "https://example.com/?api_key=PRIVATE_FIXTURE", "https://example.com/?access_token=PRIVATE_FIXTURE",
        "", "PRIVATE_FIXTURE", "wss://example.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime"]) {
        assert.throws(() => setup({ baseUrl }), error => !error.message.includes("PRIVATE_FIXTURE"));
      }
      assert.throws(() => setup({ model: "qwen3-asr-flash-realtime" }), code("unsupported_model"));
      assert.throws(() => setup({ apiKey: "invalid\r\nvalue" }), code("invalid_api_key"));
      assert.throws(() => setup({ readyTimeoutMs: 0 }), code("invalid_limits"));
      assert.equal(FakeWebSocket.instances.length, initial);
    });

    await test("shared model guard allows only exact run-task families and YYYY-MM-DD versions", async () => {
      for (const base of ALI_MEETING_MODELS) {
        assert.equal(isSupportedAliMeetingModel(base), true);
        assert.equal(isSupportedAliMeetingModel(`${base}-2026-02-28`), true);
        for (const suffix of ["-latest", "-2026-2-28", "-2026-02-28-extra", "\n", "?model=other", "-2026-02-28\n"]) {
          assert.equal(isSupportedAliMeetingModel(base + suffix), false);
          assert.throws(() => setup({ model: base + suffix }), code("unsupported_model"));
        }
      }
      for (const model of [null, {}, 1, "qwen3-asr-flash-realtime-2026-02-10", "fun-asr", "other-fun-asr-realtime"])
        assert.equal(isSupportedAliMeetingModel(model), false);
    });

    for (const model of ALI_MEETING_MODELS.flatMap(base => [base, `${base}-2026-02-28`])) {
      await test(`${model}: handshake, PCM framing, raw partial/final identity and repeated sentences`, async () => {
        const x = setup({ model });
        const pcm = Buffer.alloc(3200, 17);
        const append = x.stream.appendPcm(pcm);
        x.ws.open();
        const run = x.ws.sent[0];
        assert.equal(run.binary, false);
        assert.deepEqual(run.value, {
          header: { action: "run-task", task_id: x.stream.taskId, streaming: "duplex" },
          payload: { task_group: "audio", task: "asr", function: "recognition", model,
            parameters: { format: "pcm", sample_rate: 16000 }, input: {} }
        });
        assert.match(x.stream.taskId, /^[a-f0-9]{32}$/);
        await tick();
        assert.equal(x.ws.sent.length, 1, "no audio before task-started");
        x.ws.event("task-started");
        await append;
        assert.deepEqual(x.ws.sent[1], { value: pcm, binary: true });
        x.ws.emit("message", Buffer.from("not JSON binary frame"), true);
        x.ws.sentence({ heartbeat: true });
        const raw = "  um, repeated repeated.\n";
        x.ws.sentence({ begin_time: 0, end_time: null, text: "  um,", sentence_end: false });
        x.ws.sentence({ begin_time: 0, end_time: null, text: raw, sentence_end: false }, "arraybuffer");
        x.ws.sentence({ begin_time: 0, end_time: 170, text: raw, sentence_end: true }, "fragments");
        x.ws.sentence({ begin_time: 200, end_time: 370, text: raw, sentence_end: true }, "string");
        assert.equal(x.sentences.length, 4);
        assert.equal(x.sentences[0].id, x.sentences[2].id);
        assert.equal(x.sentences[1].id, x.sentences[2].id);
        assert.notEqual(x.sentences[2].id, x.sentences[3].id);
        assert.deepEqual(x.sentences[2], { id: x.sentences[0].id, text: raw, beginMs: 0, endMs: 170, final: true });
        assert.equal(x.sentences[3].text, raw);
        await complete(x);
        assert.deepEqual(x.errors, []);
      });
    }

    await test("utterance IDs distinguish identical text and stabilize revised timestamps", async () => {
      const x = setup(); await start(x);
      x.ws.sentence({ utterance_id: 0, begin_time: 10, text: "same", sentence_end: false });
      x.ws.sentence({ utterance_id: 0, begin_time: 12, end_time: 90, text: "same", sentence_end: true });
      x.ws.sentence({ utterance_id: 1, begin_time: 100, end_time: 190, text: "same", sentence_end: true });
      x.ws.sentence({ begin_time: 200, text: "same", sentence_end: false });
      x.ws.sentence({ sentence_id: "late-id", begin_time: 200, end_time: 290, text: "same", sentence_end: true });
      x.ws.sentence({ sentence_id: "late-id", begin_time: 200, end_time: 290, text: "same", sentence_end: true });
      x.ws.sentence({ sentence_id: "no-timestamps", text: "same", sentence_end: true });
      assert.equal(x.sentences[0].id, x.sentences[1].id);
      assert.notEqual(x.sentences[1].id, x.sentences[2].id);
      assert.equal(x.sentences[3].id, x.sentences[4].id);
      assert.equal(x.sentences[4].id, x.sentences[5].id);
      assert.equal(x.sentences[6].beginMs, null);
      await complete(x);
    });

    await test("finish races, delayed finals, idempotence and no partial promotion", async () => {
      const x = setup(); await start(x);
      x.ws.sentence({ begin_time: 0, end_time: null, text: "partial", sentence_end: false });
      const finishing = x.stream.finish();
      assert.equal(x.stream.finish(), finishing);
      await tick();
      const finish = x.ws.sent.at(-1).value;
      assert.deepEqual(finish, {
        header: { action: "finish-task", task_id: x.stream.taskId, streaming: "duplex" }, payload: { input: {} }
      });
      let settled = false;
      finishing.then(() => { settled = true; });
      await tick(); assert.equal(settled, false);
      x.ws.sentence({ begin_time: 0, end_time: 100, text: "final", sentence_end: true });
      x.ws.sentence({ begin_time: 200, text: "unfinished", sentence_end: false });
      x.ws.event("task-finished");
      await finishing;
      assert.equal(x.sentences.at(-1).final, false);
      await assert.rejects(x.stream.appendPcm(Buffer.alloc(2)), code("not_accepting_audio"));
      await x.stream.close();
      assert.deepEqual(x.errors, []);
    });

    await test("synchronous final receipt wins even with missing send callback and immediate close", async () => {
      const x = setup(); await start(x);
      x.ws.holdCallbacks = true;
      x.ws.onSend = value => {
        if (value.header?.action === "finish-task") {
          x.ws.event("task-finished");
          x.ws.disconnect();
        }
      };
      await x.stream.finish();
      assert.deepEqual(x.errors, []);
    });

    await test("finish before ready drains the one accepted append first", async () => {
      const x = setup();
      const append = x.stream.appendPcm(Buffer.alloc(3200));
      const finishing = x.stream.finish();
      x.ws.onSend = value => {
        if (value.header?.action === "finish-task") x.ws.event("task-finished");
      };
      await start(x);
      await append; await finishing;
      assert.deepEqual(x.ws.sent.map(s => s.binary ? "pcm" : s.value.header.action), ["run-task", "pcm", "finish-task"]);
    });

    await test("bounded backpressure, no concurrent audio queue and send callback ordering", async () => {
      const x = setup({ maxBufferedBytes: 3200 }); await start(x);
      x.ws.bufferedAmount = 1;
      const append = x.stream.appendPcm(Buffer.alloc(3200));
      for (let i = 0; i < 20; i++)
        await assert.rejects(x.stream.appendPcm(Buffer.alloc(3200)), code("append_in_progress"));
      await delay(10);
      assert.equal(x.ws.sent.length, 1);
      x.ws.holdCallbacks = true;
      x.ws.bufferedAmount = 0;
      await delay(15);
      assert.equal(x.ws.sent.length, 2);
      let settled = false;
      append.then(() => { settled = true; });
      await tick(); assert.equal(settled, false);
      const finishing = x.stream.finish();
      await tick(); assert.equal(x.ws.sent.length, 2);
      x.ws.holdCallbacks = false;
      x.ws.onSend = value => { if (value.header?.action === "finish-task") x.ws.event("task-finished"); };
      x.ws.callbacks.shift()();
      await append; await finishing;
    });

    await test("chunk limits allow short tails and 8k PCM without truncating", async () => {
      const x = setup({ sampleRate: 8000 }); await start(x);
      assert.equal(x.ws.sent[0].value.payload.parameters.sample_rate, 8000);
      for (const chunk of ["base64", Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(1602)])
        await assert.rejects(x.stream.appendPcm(chunk), code("invalid_pcm_chunk"));
      await x.stream.appendPcm(Buffer.alloc(1600));
      await x.stream.appendPcm(Buffer.alloc(2));
      assert.deepEqual(x.ws.sent.filter(s => s.binary).map(s => s.value.length), [1600, 2]);
      await complete(x);
    });

    for (const mode of ["buffered", "callback", "throw", "callback-error"]) {
      await test(`send failure: ${mode}`, async () => {
        const x = setup({ sendTimeoutMs: 25 }); await start(x);
        if (mode === "buffered") x.ws.bufferedAmount = 65536;
        if (mode === "callback") x.ws.holdCallbacks = true;
        if (mode === "throw") x.ws.throwSend = true;
        if (mode === "callback-error") x.ws.sendError = true;
        const expected = ["buffered", "callback"].includes(mode) ? "send_timeout" : "send_failed";
        await assert.rejects(x.stream.appendPcm(Buffer.alloc(3200)), code(expected));
        await assert.rejects(x.stream.finish(), code(expected));
        assert.equal(x.errors.length, 1);
        await x.stream.close();
        for (const callback of x.ws.callbacks) callback(new Error("PRIVATE_FIXTURE late callback"));
      });
    }

    for (const phase of ["connecting", "ready", "finishing"]) {
      await test(`task failure rejects waiting operations: ${phase}`, async () => {
        const x = setup();
        x.ws.open();
        if (phase !== "connecting") { x.ws.event("task-started"); await x.stream.ready; }
        const finishing = phase === "finishing" ? x.stream.finish() : null;
        await tick();
        x.ws.event("task-failed", { private: "PRIVATE_FIXTURE payload" },
          { error_code: "PRIVATE_FIXTURE code", error_message: "PRIVATE_FIXTURE error" });
        if (phase === "connecting") await assert.rejects(x.stream.ready, code("task_failed"));
        await assert.rejects(finishing || x.stream.finish(), code("task_failed"));
        assert.equal(x.errors.length, 1);
        assert.deepEqual(Object.keys(x.errors[0]), ["code"]);
        assert.ok(!JSON.stringify(x.errors).includes("PRIVATE_FIXTURE"));
        await x.stream.close();
      });
    }

    for (const phase of ["connecting", "ready", "sending", "finishing"]) {
      await test(`unexpected close fails: ${phase}`, async () => {
        const x = setup();
        if (phase !== "connecting") await start(x);
        let pending;
        if (phase === "sending") { x.ws.holdCallbacks = true; pending = x.stream.appendPcm(Buffer.alloc(2)); }
        if (phase === "finishing") pending = x.stream.finish();
        await tick(); x.ws.disconnect();
        await assert.rejects(pending || x.stream.finish(), code("disconnected"));
        if (phase === "connecting") await assert.rejects(x.stream.ready, code("disconnected"));
        assert.equal(x.errors.length, 1);
      });
    }

    await test("ready and final deadlines explicitly reject; early ready rejection is observed", async () => {
      const unopened = setup({ readyTimeoutMs: 20 });
      await delay(40);
      await assert.rejects(unopened.stream.ready, code("ready_timeout"));
      assert.equal(unopened.ws.terminations, 1);
      const unstarted = setup({ readyTimeoutMs: 20 }); unstarted.ws.open();
      await assert.rejects(unstarted.stream.ready, code("ready_timeout"));
      const x = setup({ finishTimeoutMs: 20 }); await start(x);
      await assert.rejects(x.stream.finish(), code("finish_timeout"));
      assert.equal(x.errors.length, 1);
      const beforeReady = setup({ finishTimeoutMs: 20 });
      await assert.rejects(beforeReady.stream.finish(), code("finish_timeout"));
    });

    await test("bounded close/abort, signal cancellation, late errors and ignored promises", async () => {
      const x = setup(); await start(x);
      x.ws.hangClose = true; x.ws.hangTerminate = true;
      x.ws.holdCallbacks = true;
      const pending = x.stream.appendPcm(Buffer.alloc(2));
      await tick();
      const closed = x.stream.abort();
      assert.equal(x.stream.close(), closed);
      await closed;
      await assert.rejects(pending, code("aborted"));
      assert.equal(x.ws.terminations, 1);
      x.ws.emit("error", new Error("PRIVATE_FIXTURE late transport error"));
      const controller = new AbortController();
      const y = setup({ signal: controller.signal });
      controller.abort(new Error("PRIVATE_FIXTURE abort reason"));
      await assert.rejects(y.stream.ready, code("aborted"));
      const number = FakeWebSocket.instances.length;
      const z = setup({ signal: controller.signal });
      assert.equal(FakeWebSocket.instances.length, number);
      await assert.rejects(z.stream.ready, code("aborted"));
      z.stream.finish(); z.stream.appendPcm(Buffer.alloc(2));
      await z.stream.close();
    });

    await test("malformed events, foreign task, premature completion and callbacks fail safely", async () => {
      const cases = [
        x => x.ws.emit("message", Buffer.from("PRIVATE_FIXTURE malformed JSON"), false),
        x => x.ws.event("task-started", {}, { task_id: "other" }),
        x => x.ws.event("task-finished"),
        x => x.ws.sentence({ text: "PRIVATE_FIXTURE", sentence_end: true })
      ];
      for (const trigger of cases) {
        const x = setup(); await start(x); trigger(x);
        await assert.rejects(x.stream.finish(), error => !error.message.includes("PRIVATE_FIXTURE"));
        assert.equal(x.errors.length, 1);
        await x.stream.close();
      }
      const x = setup({
        onSentence: async () => { throw new Error("PRIVATE_FIXTURE callback"); },
        onError: async () => { throw new Error("PRIVATE_FIXTURE observer"); }
      });
      await start(x);
      x.ws.sentence({ begin_time: 0, text: "raw", sentence_end: false });
      await tick();
      await assert.rejects(x.stream.finish(), code("sentence_callback_failed"));
    });

    await test("constructor and socket errors expose only local error codes", async () => {
      const x = setup({ WebSocketImpl: class { constructor() { throw new Error("PRIVATE_FIXTURE constructor"); } } });
      await assert.rejects(x.stream.ready, code("connection_failed"));
      await x.stream.close();
      const y = setup(); y.ws.emit("error", new Error("PRIVATE_FIXTURE transport"));
      await assert.rejects(y.stream.ready, code("connection_failed"));
      await y.stream.close();
    });

    console.log(`Ali meeting stream: ${count} tests passed. Supported model IDs: ${ALI_MEETING_MODELS.join(", ")}`);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
