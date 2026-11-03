"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMeetingPreview, createArchiveReader } = require("../src/meeting/realtime/preview");
const { RATE, wavHeader, ensureWave, writePcm } = require("../src/meeting/realtime/audio");

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function wave(start, end) {
  const pcm = Buffer.alloc((end - start) * 2);
  for (let i = 0; i < end - start; i++) pcm.writeInt16LE((start + i) % 30000, i * 2);
  return Buffer.concat([wavHeader(pcm.length, false), pcm]);
}

function quietWave(start, end, pauses = []) {
  const pcm = Buffer.alloc((end - start) * 2, Buffer.from([0xb0, 0x04]));
  for (const [a, b] of pauses) {
    const from = Math.max(start, a), to = Math.min(end, b);
    if (to > from) pcm.fill(0, (from - start) * 2, (to - start) * 2);
  }
  return Buffer.concat([wavHeader(pcm.length, false), pcm]);
}

function fixture(options = {}) {
  const state = options.state || {};
  const streams = [];
  const reads = [];
  let saves = 0;
  const api = createMeetingPreview({ state, paceMs: 0, reconnectDelayMs: 0, autoRetry: false, resultStallSeconds: 0,
    readAudio: async (start, end) => { reads.push([start, end]); return wave(start, end); },
    createStream: callbacks => {
      const stream = { callbacks, chunks: [], closed: 0, finishes: 0,
        ready: Promise.resolve(),
        appendPcm: async pcm => { stream.chunks.push(Buffer.from(pcm)); },
        finish: async () => {
          stream.finishes++;
          callbacks.onSentence({ id: "0", text: "Same words", beginMs: 0,
            endMs: Buffer.concat(stream.chunks).length / 2 / RATE * 1000, final: true });
        },
        close: () => { stream.closed++; }
      };
      streams.push(stream);
      options.configure?.(stream, streams.length);
      return stream;
    },
    persist: async () => { saves++; }, ...options });
  return { api, state, streams, reads, saves: () => saves };
}

async function main() {
  let count = 0;
  async function test(name, run) { await run(); count++; console.log(`ok - ${name}`); }

  await test("initial state, nonblocking kick, exact PCM tail and task-finished barrier", async () => {
    const ready = deferred();
    const finished = deferred();
    const x = fixture({ configure: s => {
      s.ready = ready.promise;
      const finish = s.finish;
      s.finish = async () => { await finished.promise; await finish(); };
    } });
    assert.deepEqual(x.state.preview.windows, []);
    assert.equal(x.api.kick(RATE + 123), undefined);
    await turn();
    assert.equal(x.streams[0].chunks.length, 0);
    ready.resolve();
    await x.api.waitForIdle();
    assert.deepEqual(Buffer.concat(x.streams[0].chunks), wave(0, RATE + 123).subarray(44));
    assert.ok(x.streams[0].chunks.every(b => b.length <= RATE / 10 * 2));
    let drained = false;
    const stopping = x.api.drain(RATE + 321).then(() => { drained = true; });
    await turn();
    assert.equal(drained, false);
    assert.deepEqual(Buffer.concat(x.streams[0].chunks), wave(0, RATE + 321).subarray(44));
    finished.resolve();
    await stopping;
    assert.equal(x.state.preview.windows[0].sentFrame, RATE + 321);
    assert.equal(x.state.preview.windows[0].status, "completed");
    assert.equal(x.api.snapshot().segments.length, 1);
    assert.equal(x.streams[0].closed, 1);
    await x.api.shutdown();
  });

  await test("pause closes socket, resume starts at next offset, repeated phrases survive", async () => {
    const x = fixture();
    await x.api.drain(RATE);
    x.api.kick(2 * RATE);
    await x.api.waitForIdle();
    await x.api.drain(2 * RATE + 100);
    assert.equal(x.streams.length, 2);
    assert.deepEqual(x.state.preview.windows.map(w => [w.startFrame, w.endFrame]), [[0, RATE], [RATE, 2 * RATE + 100]]);
    assert.deepEqual(Buffer.concat(x.streams[1].chunks), wave(RATE, 2 * RATE + 100).subarray(44));
    assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["Same words", "Same words"]);
    assert.equal(x.api.snapshot().segments[1].startFrame, RATE);
    await x.api.shutdown();
  });

  await test("only finals become segments; duplicate IDs and stale partials cannot replace them", async () => {
    const x = fixture();
    x.api.kick(RATE);
    await x.api.waitForIdle();
    const emit = x.streams[0].callbacks.onSentence;
    emit({ id: "2", text: "current draft", beginMs: 500, endMs: 600, final: false });
    emit({ id: "old-draft", text: "stale", beginMs: 0, endMs: 50, final: false });
    emit({ id: "1", text: "confirmed", beginMs: 100, endMs: 200, final: true });
    emit({ id: "1", text: "duplicate", beginMs: 100, endMs: 200, final: true });
    emit({ id: "1", text: "late partial", beginMs: 100, endMs: 250, final: false });
    emit({ id: "2", text: "regression", beginMs: 500, endMs: 550, final: false });
    assert.equal(x.api.snapshot().previewText, "current draft");
    assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["confirmed"]);
    emit({ id: "0", text: "earlier final", beginMs: 0, endMs: 90, final: true });
    assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["earlier final", "confirmed"]);
    emit({ id: "2", text: "last final", beginMs: 500, endMs: 650, final: true });
    assert.equal(x.api.snapshot().previewText, "");
    await x.api.shutdown();
    assert.equal(x.api.snapshot().segments.length, 3);
  });

  await test("first connect failure records complete gap and reconnect preserves failure for explicit retry", async () => {
    const x = fixture({ configure: (s, n) => { if (n === 1) s.ready = Promise.reject(new Error("key=DO_NOT_STORE transport body")); } });
    x.api.kick(RATE);
    await x.api.waitForIdle();
    assert.equal(x.state.preview.windows[0].startFrame, 0);
    assert.equal(x.state.preview.windows[0].endFrame, RATE);
    assert.equal(x.state.preview.windows[0].sentFrame, 0);
    assert.equal(x.api.snapshot().failedSegments, 1);
    x.api.kick(2 * RATE);
    await x.api.waitForIdle();
    await x.api.drain(2 * RATE);
    assert.equal(x.streams.length, 2);
    assert.equal(x.api.snapshot().failedSegments, 1);
    assert.equal(x.api.snapshot().segments[0].startFrame, RATE);
    assert.ok(!JSON.stringify(x.state).includes("DO_NOT_STORE"));
    const retry = x.api.retry();
    assert.equal(typeof retry?.then, "function");
    await retry;
    assert.equal(x.api.snapshot().failedSegments, 0);
    assert.equal(x.api.snapshot().segments.length, 2);
    assert.deepEqual(Buffer.concat(x.streams[2].chunks), wave(0, RATE).subarray(44));
    x.api.retry();
    await x.api.waitForIdle();
    assert.equal(x.streams.length, 3);
    await x.api.shutdown();
  });

  await test("midstream failure retains finals until successful failed-window replay", async () => {
    const x = fixture({ configure: (s, n) => {
      if (n !== 1) return;
      s.appendPcm = async pcm => {
        s.chunks.push(Buffer.from(pcm));
        if (s.chunks.length === 1) s.callbacks.onSentence({ id: "0", text: "keep final", beginMs: 0, endMs: 100, final: true });
        if (s.chunks.length === 3) s.callbacks.onError(new Error("secret"));
      };
    } });
    x.api.kick(RATE);
    await x.api.waitForIdle();
    assert.equal(x.api.snapshot().segments[0].text, "keep final");
    assert.equal(x.api.snapshot().failedSegments, 1);
    x.api.retry();
    await x.api.waitForIdle();
    assert.equal(x.api.snapshot().segments[0].text, "Same words");
    assert.equal(x.api.snapshot().failedSegments, 0);
    await x.api.shutdown();
  });

  await test("window rotation finishes each bounded task and uses scoped sentence IDs", async () => {
    const x = fixture({ windowSeconds: 0.2 });
    await x.api.drain(RATE * 0.55);
    assert.equal(x.streams.length, 3);
    assert.ok(x.state.preview.windows.every(w => w.endFrame - w.startFrame <= RATE * 0.2));
    assert.deepEqual(Buffer.concat(x.streams.flatMap(s => s.chunks)), wave(0, RATE * 0.55).subarray(44));
    assert.equal(x.api.snapshot().segments.length, 3);
    assert.ok(x.streams.every(s => s.finishes === 1 && s.closed === 1));
    await x.api.shutdown();
  });

  await test("readMixed reader caps every request at 40 seconds even with huge backlog", async () => {
    const x = fixture({ readSeconds: 1000 });
    await x.api.drain(RATE * 81);
    assert.ok(x.reads.every(([start, end]) => end - start <= RATE * 40));
    assert.deepEqual(x.reads, [[0, RATE * 40], [RATE * 40, RATE * 80], [RATE * 80, RATE * 81]]);
    assert.equal(x.state.preview.windows[0].sentFrame, RATE * 81);
    await x.api.shutdown();
  });

  await test("live and retry sends are paced, including fractional tail", async () => {
    let time = 0;
    const delays = [];
    let broken = true;
    const x = fixture({ now: () => time, paceMs: 90,
      sleep: async ms => { delays.push(ms); time += ms; },
      configure: s => { if (broken) s.ready = Promise.reject(new Error("offline")); }
    });
    await x.api.drain(RATE * 0.25);
    broken = false;
    x.api.retry();
    await x.api.waitForIdle();
    assert.deepEqual(delays, [90, 90, 45]);
    assert.equal(x.api.snapshot().failedSegments, 0);
    await x.api.shutdown();
  });

  await test("drain deadline closes a hung connection and checkpoints all unsent spans", async () => {
    const x = fixture({ drainTimeoutMs: 20, windowSeconds: 0.2,
      configure: s => { s.ready = new Promise(() => {}); } });
    const started = Date.now();
    await x.api.drain(RATE);
    assert.ok(Date.now() - started < 1000);
    assert.equal(x.api.snapshot().failedSegments, 5);
    assert.equal(x.state.preview.cursorFrame, RATE);
    assert.equal(x.api.snapshot().segments.length, 0);
    assert.equal(x.streams[0].closed, 1);
    await x.api.shutdown();
  });

  await test("finish timeout preserves finals, reports missing completion, sanitizes errors", async () => {
    const x = fixture({ finishTimeoutMs: 10, configure: s => {
      const finish = s.finish;
      s.finish = async () => { await finish(); await new Promise(() => {}); };
    } });
    await x.api.drain(RATE / 10);
    assert.equal(x.api.snapshot().failedSegments, 1);
    assert.equal(x.api.snapshot().segments.length, 1);
    assert.equal(x.state.preview.windows[0].error.code, "preview_finish_timeout");
    await x.api.shutdown();
  });

  await test("offline recovery marks interrupted windows and unassigned archive tail without connecting", async () => {
    const state = { preview: { cursorFrame: RATE, windows: [
      { id: "a", startFrame: 0, endFrame: RATE, sentFrame: RATE / 2, status: "streaming",
        sentences: [{ id: "0", text: "saved", beginMs: 0, endMs: 100, final: true },
          { id: "1", text: "draft", beginMs: 100, endMs: 200, final: false }] }
    ] } };
    let connects = 0;
    const x = fixture({ state, createStream: () => { connects++; throw new Error("credentials not loaded"); } });
    await x.api.recover(RATE * 2);
    assert.equal(connects, 0);
    assert.equal(x.api.snapshot().failedSegments, 2);
    assert.equal(x.api.snapshot().previewText, "");
    assert.equal(x.api.snapshot().segments[0].text, "saved");
    assert.ok(x.saves() > 0);
    await x.api.shutdown();
    const offline = createMeetingPreview({ state: {} });
    await offline.drain(RATE);
    assert.equal(offline.snapshot().failedSegments, 1);
    await offline.shutdown();
  });

  await test("drain propagates sanitized persistence failure, never provider errors", async () => {
    const x = fixture({ persist: async () => { throw new Error("local secret path"); } });
    await assert.rejects(x.api.drain(160), error => error.code === "preview_checkpoint_failed" && !error.message.includes("secret"));
    assert.equal(x.api.snapshot().segments.length, 1);
    await assert.rejects(x.api.shutdown(), { code: "preview_checkpoint_failed" });
  });

  await test("slow checkpoints and throwing UI do not block archive reads or audio sends", async () => {
    const disk = deferred();
    const x = fixture({ persist: () => disk.promise, onChange: () => { throw new Error("UI unavailable"); } });
    x.api.kick(RATE);
    await x.api.waitForIdle();
    assert.equal(x.state.preview.windows[0].sentFrame, RATE);
    let stopped = false;
    const stop = x.api.drain(RATE).then(() => { stopped = true; });
    await turn();
    assert.equal(stopped, false);
    disk.resolve();
    await stop;
    await x.api.shutdown();
  });

  await test("abort cancels hung reads; late factory results close without reviving state", async () => {
    const factory = deferred();
    const x = fixture({ createStream: () => factory.promise });
    x.api.kick(RATE);
    await turn();
    await x.api.shutdown();
    let closed = 0;
    factory.resolve({ close: () => { closed++; } });
    await turn();
    assert.equal(closed, 1);
    assert.equal(x.api.snapshot().failedSegments, 1);
    const y = fixture({ readAudio: () => new Promise(() => {}) });
    y.api.kick(RATE);
    await turn();
    y.api.abort();
    await y.api.waitForIdle();
    assert.equal(y.api.snapshot().failedSegments, 1);
    await y.api.shutdown();
  });

  await test("durable archive reader mixes complete WAVs without modifying native audio", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ovi-preview-test-"));
    const files = [path.join(root, "mic.wav"), path.join(root, "system.wav")];
    for (const file of files) {
      await ensureWave(file);
      const pcm = Buffer.alloc(RATE * 2);
      for (let i = 0; i < RATE; i++) pcm.writeInt16LE(1200, i * 2);
      await writePcm(file, pcm, 0);
    }
    const before = await Promise.all(files.map(file => fs.readFile(file)));
    const x = fixture({ readAudio: createArchiveReader(() => files) });
    await x.api.drain(RATE);
    const output = Buffer.concat(x.streams[0].chunks);
    assert.equal(output.length, RATE * 2);
    assert.equal(output.readInt16LE(0), 1200);
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before);
    await x.api.shutdown();
  });

  await test("malformed upload WAV fails explicitly instead of sending header or truncated audio", async () => {
    const x = fixture({ readAudio: async () => Buffer.alloc(44) });
    await x.api.drain(RATE);
    assert.equal(x.api.snapshot().failedSegments, 1);
    assert.equal(x.streams[0].chunks.length, 0);
    assert.equal(x.state.preview.windows[0].error.code, "preview_audio_invalid");
    await x.api.shutdown();
  });

  await test("task-prefixed Ali sentence IDs retain window-local identity on retry", async () => {
    const x = fixture({ configure: (s, n) => {
      const id = `${String(n).repeat(32)}:utterance:0`;
      if (n === 1) {
        s.appendPcm = async pcm => {
          s.chunks.push(Buffer.from(pcm));
          s.callbacks.onSentence({ id, text: "preserved", beginMs: 0, endMs: 100, final: true });
          s.callbacks.onError(new Error("offline"));
        };
      } else s.finish = async () => {
        s.callbacks.onSentence({ id, text: "replayed", beginMs: 0, endMs: 100, final: true });
        s.callbacks.onSentence({ id: `${String(n).repeat(32)}:utterance:1`, text: "new tail", beginMs: 100, endMs: 200, final: true });
      };
    } });
    await x.api.drain(RATE / 5);
    await x.api.retry();
    assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["replayed", "new tail"]);
    assert.equal(x.api.snapshot().failedSegments, 0);
    await x.api.shutdown();
  });

  await test("failed retry rolls back staged same-ID finals", async () => {
    const x = fixture({ configure: (s, n) => {
      const id = `${String(n).repeat(32)}:utterance:0`;
      if (n === 1) {
        s.appendPcm = async pcm => {
          s.chunks.push(Buffer.from(pcm));
          s.callbacks.onSentence({ id, text: "preserved", beginMs: 0, endMs: 100, final: true });
          s.callbacks.onError(new Error("offline"));
        };
      } else s.finish = async () => {
        s.callbacks.onSentence({ id, text: "must roll back", beginMs: 0, endMs: 100, final: true });
        throw new Error("finish failed");
      };
    } });
    await x.api.drain(RATE / 5);
    await x.api.retry();
    assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["preserved"]);
    assert.equal(x.api.snapshot().failedSegments, 1);
    await x.api.shutdown();
  });

  await test("in-flight retry staging stays private across invalidation and recovery", async () => {
    const staged = deferred();
    const append = deferred();
    const x = fixture({ configure: (s, n) => {
      const id = `${String(n).repeat(32)}:utterance:0`;
      if (n === 1) {
        s.appendPcm = async pcm => {
          s.chunks.push(Buffer.from(pcm));
          s.callbacks.onSentence({ id, text: "preserved", beginMs: 0, endMs: 100, final: true });
          s.callbacks.onError(new Error("offline"));
        };
      } else {
        s.appendPcm = async pcm => {
          s.chunks.push(Buffer.from(pcm));
          s.callbacks.onSentence({ id, text: "uncommitted", beginMs: 0, endMs: 100, final: true });
          staged.resolve();
          await append.promise;
        };
      }
    } });
    await x.api.drain(RATE / 5);
    const retry = x.api.retry();
    await staged.promise;
    assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["preserved"]);
    assert.deepEqual(x.state.preview.windows[0].sentences.map(s => s.text), ["preserved"]);

    const recoveredState = structuredClone(x.state);
    let recoveryConnects = 0;
    const recovered = createMeetingPreview({ state: recoveredState,
      createStream: () => { recoveryConnects++; throw new Error("must stay offline"); } });
    await recovered.recover(RATE / 5);
    assert.equal(recoveryConnects, 0);
    assert.deepEqual(recovered.snapshot().segments.map(s => s.text), ["preserved"]);
    assert.equal(recovered.snapshot().failedSegments, 1);
    await recovered.shutdown();

    assert.equal(x.api.invalidate(0, RATE / 5), 1);
    await retry;
    assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["preserved"]);
    assert.equal(x.state.preview.windows[0].error.code, "preview_audio_changed");
    x.streams[1].callbacks.onSentence({ id: `${"2".repeat(32)}:utterance:0`,
      text: "obsolete", beginMs: 0, endMs: 100, final: true });
    assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["preserved"]);
    append.resolve();
    await x.api.shutdown();
  });

  await test("many kicks under backpressure keep one live sender and the final available frame", async () => {
    const send = deferred();
    const x = fixture({ configure: s => {
      const append = s.appendPcm;
      s.appendPcm = async pcm => { await send.promise; await append(pcm); };
    } });
    x.api.kick(RATE / 10);
    await turn();
    for (let i = 2; i <= 100; i++) x.api.kick(i * RATE / 10);
    await turn();
    assert.equal(x.streams.length, 1);
    assert.equal(x.reads.length, 1);
    send.resolve();
    await x.api.drain(10 * RATE + 13);
    assert.deepEqual(Buffer.concat(x.streams[0].chunks), wave(0, 10 * RATE + 13).subarray(44));
    await x.api.shutdown();
  });

  await test("drain deadline during send preserves acknowledged progress and marks the remaining span", async () => {
    const x = fixture({ drainTimeoutMs: 15, configure: s => {
      const append = s.appendPcm;
      s.appendPcm = async pcm => {
        if (s.chunks.length === 1) await new Promise(() => {});
        await append(pcm);
      };
    } });
    await x.api.drain(RATE);
    assert.equal(x.state.preview.windows[0].sentFrame, RATE / 10);
    assert.equal(x.state.preview.windows[0].endFrame, RATE);
    assert.equal(x.api.snapshot().failedSegments, 1);
    assert.equal(x.api.snapshot().pendingSegments, 0);
    await x.api.shutdown();
  });

  await test("pause cancels active and queued retries, and ignores obsolete callbacks", async () => {
    let hang = false;
    const x = fixture({ windowSeconds: 0.2, configure: s => {
      if (hang) s.ready = new Promise(() => {});
      else s.ready = Promise.reject(new Error("offline"));
    } });
    await x.api.drain(RATE);
    hang = true;
    const retry = x.api.retry();
    await turn();
    assert.equal(x.api.snapshot().pendingSegments, 5);
    await x.api.drain(RATE);
    await retry;
    assert.equal(x.streams.length, 2);
    assert.equal(x.api.snapshot().failedSegments, 5);
    x.streams[1].callbacks.onSentence({ id: "0", text: "obsolete", beginMs: 0, endMs: 100, final: true });
    assert.equal(x.api.snapshot().segments.length, 0);
    await x.api.shutdown();
  });

  await test("explicit window limit is respected without imposing a ten-minute default", async () => {
    const state = {};
    const api = createMeetingPreview({ state, windowSeconds: 3600 });
    await api.recover(RATE * 1250);
    assert.deepEqual(state.preview.windows.map(w => w.endFrame - w.startFrame), [RATE * 1250]);
    await api.shutdown();
    assert.throws(() => createMeetingPreview({ state: {}, windowSeconds: NaN }), { code: "preview_limits_invalid" });
  });

  await test("new live audio and drafts continue while the old rotation awaits its final receipt", async () => {
    const receipt = deferred();
    const x = fixture({ windowSeconds: .2, configure: (stream, number) => {
      if (number === 1) {
        const finish = stream.finish;
        stream.finish = async () => { await receipt.promise; await finish(); };
      } else {
        const append = stream.appendPcm;
        stream.appendPcm = async pcm => { await append(pcm); stream.callbacks.onSentence({
          id: "draft", text: "next live window", beginMs: 0, endMs: 50, final: false
        }); };
      }
    } });
    x.api.kick(RATE * .3);
    for (let i = 0; i < 10 && x.streams.length < 2; i++) await turn();
    assert.equal(x.streams.length, 2, "the new socket must open before the old final receipt");
    assert.equal(x.api.snapshot().previewText, "next live window");
    assert.equal(x.state.preview.windows[0].status, "finishing");
    assert.deepEqual(Buffer.concat(x.streams[1].chunks), wave(RATE * .2, RATE * .3).subarray(44));
    receipt.resolve(); await x.api.waitForIdle();
    await x.api.drain(RATE * .3);
    assert.equal(x.api.snapshot().failedSegments, 0);
    assert.deepEqual(x.state.preview.windows.map(w => [w.startFrame, w.endFrame]), [[0, RATE * .2], [RATE * .2, RATE * .3]]);
    await x.api.shutdown();
  });

  await test("twenty-minute rotation keeps exact ordered coverage, bounded sockets and a recoverable retiring failure", async () => {
    let opened = 0; let openCount = 0; let maxOpen = 0; const states = [];
    const state = {};
    const api = createMeetingPreview({ state, paceMs: 0, reconnectDelayMs: 0, windowSeconds: 600, autoRetry: false,
      readAudio: async (start, end) => quietWave(start, end),
      createStream: ({ onSentence }) => {
        const id = ++opened; openCount++; maxOpen = Math.max(maxOpen, openCount);
        let samples = 0; let closed = false;
        return { ready: Promise.resolve(), appendPcm: async pcm => {
          samples += pcm.length / 2;
          onSentence({ id: "current", text: `window ${id}`, beginMs: 0, endMs: samples / RATE * 1000, final: false });
        }, finish: async () => {
          onSentence({ id: "current", text: `window ${id}`, beginMs: 0, endMs: samples / RATE * 1000, final: true });
          if (id === 2) throw new Error("provider error body is not persisted");
        }, close: () => { if (!closed) { closed = true; openCount--; } } };
      }, onChange: value => { if (value.previewText) states.push(value.previewText); } });
    api.kick(RATE * 1250);
    await api.waitForIdle(); await api.drain(RATE * 1250);
    assert.equal(opened, 3); assert(maxOpen <= 2);
    assert(states.includes("window 3"), "preview must continue beyond twenty minutes despite the old receipt failure");
    assert.deepEqual(state.preview.windows.map(w => [w.startFrame, w.endFrame]), [[0, RATE * 600], [RATE * 600, RATE * 1200], [RATE * 1200, RATE * 1250]]);
    assert.equal(api.snapshot().failedSegments, 1);
    assert.deepEqual(api.snapshot().segments.map(s => s.text), ["window 1", "window 2", "window 3"]);
    assert(!JSON.stringify(state).includes("provider error body"));
    await api.retry();
    assert.equal(api.snapshot().failedSegments, 0); assert.equal(opened, 4, "only the failed interval is replayed");
    await api.shutdown();
  });

  await test("archive invalidation targets overlapping windows and retains their finals until explicit retry", async () => {
    const x = fixture({ windowSeconds: 0.2 });
    await x.api.drain(RATE * 0.4);
    const finals = x.api.snapshot().segments;
    assert.equal(x.api.invalidate(0, RATE * 0.2), 1);
    assert.equal(x.api.invalidate(RATE * 0.4, RATE), 0);
    assert.equal(x.api.invalidate(-1, RATE), 0);
    assert.equal(x.api.invalidate(5, 5), 0);
    assert.deepEqual(x.api.snapshot().segments, finals);
    assert.equal(x.state.preview.windows.find(w => w.repair).error.code, "preview_audio_changed");
    assert.equal(x.state.preview.windows[1].status, "completed");
    await x.api.waitForIdle();
    assert.equal(x.streams.length, 2, "invalidation never starts a replay");
    await x.api.retry();
    assert.equal(x.streams.length, 3);
    assert.deepEqual(Buffer.concat(x.streams[2].chunks), wave(0, RATE * 0.2).subarray(44));
    assert.equal(x.api.snapshot().failedSegments, 0);
    assert.deepEqual(x.api.snapshot().segments, finals);
    await x.api.shutdown();
  });

  await test("late unsent audio refreshes read-ahead without closing the live task", async () => {
    const send = deferred();
    let changedAudio = false;
    const x = fixture({ readAudio: async (start, end) => {
      const wav = wave(start, end);
      if (changedAudio) for (let f = Math.max(start, RATE / 2); f < end; f++) wav.writeInt16LE(777, 44 + (f - start) * 2);
      return wav;
    }, configure: (s, n) => {
      if (n !== 1) return;
      s.appendPcm = async buffer => {
        s.chunks.push(Buffer.from(buffer));
        s.callbacks.onSentence({ id: "0", text: "retained final", beginMs: 0, endMs: 100, final: true });
        s.callbacks.onSentence({ id: "1", text: "invalid draft", beginMs: 100, endMs: 150, final: false });
        await send.promise;
      };
    } });
    x.api.kick(RATE);
    await turn();
    assert.equal(x.streams[0].chunks.length, 1);
    changedAudio = true;
    const affected = x.api.invalidate(RATE / 2, RATE);
    send.resolve();
    await x.api.waitForIdle();
    assert.equal(affected, 0, "unsubmitted samples need a cache refresh, not an ASR replay");
    assert.equal(x.streams[0].closed, 0);
    assert.equal(x.streams.length, 1);
    assert.equal(x.api.snapshot().segments[0].text, "retained final");
    assert.equal(Buffer.concat(x.streams[0].chunks).readInt16LE(RATE), 777, "the original socket receives the updated durable samples");
    assert.equal(x.api.snapshot().failedSegments, 0);
    await x.api.shutdown();
  });

  await test("invalidation cancels an in-flight retry and removes affected queued retries", async () => {
    const x = fixture({ windowSeconds: 0.2,
      configure: (s, n) => { s.ready = n === 1 ? Promise.reject(new Error("offline")) : new Promise(() => {}); } });
    await x.api.drain(RATE * 0.4);
    const retry = x.api.retry();
    await turn();
    assert.equal(x.api.invalidate(0, RATE * 0.4), 2);
    await retry;
    assert.equal(x.api.snapshot().failedSegments, 2);
    assert.equal(x.api.snapshot().pendingSegments, 0);
    assert.equal(x.streams.length, 2, "queued invalidated task waits for a new explicit retry");
    await x.api.shutdown();
  });

  await test("pause rotation releases read-ahead exactly once while the old receipt waits", async () => {
    const receipt = deferred();
    const nextAudio = deferred();
    const readAudio = async (start, end) => quietWave(start, end, [[RATE * 2.7, RATE * 3.3]]);
    const x = fixture({ windowSeconds: 4, pauseBeforeSeconds: 1, readAudio,
      configure: (stream, n) => {
        if (n === 1) {
          const finish = stream.finish;
          stream.finish = async () => { await receipt.promise; await finish(); };
        } else {
          const append = stream.appendPcm;
          stream.appendPcm = async pcm => { await append(pcm); nextAudio.resolve(); };
        }
      } });
    try {
      x.api.kick(RATE * 5 + 37);
      await nextAudio.promise;
      const first = x.state.preview.windows[0];
      assert.equal(first.endFrame, RATE * 3);
      assert.equal(first.sentFrame, first.endFrame);
      assert.equal(first.rotationBoundary, "pause");
      assert.equal(x.state.preview.windows[1].startFrame, first.endFrame);
      receipt.resolve();
      await x.api.waitForIdle();
      await x.api.drain(RATE * 5 + 37);
      assert.deepEqual(Buffer.concat(x.streams.flatMap(s => s.chunks)), (await readAudio(0, RATE * 5 + 37)).subarray(44));
      assert.equal(x.state.preview.cursorFrame, RATE * 5 + 37);
      assert.equal(x.api.snapshot().failedSegments, 0);
    } finally { receipt.resolve(); await x.api.shutdown(); }
  });

  await test("pause detector spans separate kicks and drain retains the exact short tail", async () => {
    const readAudio = async (start, end) => quietWave(start, end, [[RATE * 2.85, RATE * 3.4]]);
    const x = fixture({ windowSeconds: 4, pauseBeforeSeconds: 1, readAudio });
    try {
      for (const end of [RATE * 2.9, RATE * 3.05]) {
        x.api.kick(end); await x.api.waitForIdle();
        assert.equal(x.streams.length, 1, "a short quiet interval must not rotate");
      }
      x.api.kick(RATE * 3.4); await x.api.waitForIdle();
      const cut = x.state.preview.windows[0].endFrame;
      assert.ok(cut >= RATE * 3.15 && cut <= RATE * 3.4);
      assert.equal(x.streams.length, 2);
      await x.api.drain(RATE * 3.4 + 13);
      assert.deepEqual(Buffer.concat(x.streams.flatMap(s => s.chunks)), (await readAudio(0, RATE * 3.4 + 13)).subarray(44));
    } finally { await x.api.shutdown(); }
  });

  await test("failed pause window retries its sealed range without repartitioning or replaying success", async () => {
    const readAudio = async (start, end) => quietWave(start, end, [[RATE * 2.7, RATE * 3.3]]);
    const x = fixture({ windowSeconds: 4, pauseBeforeSeconds: 1, readAudio,
      configure: (stream, n) => { if (n === 1) stream.finish = async () => { throw new Error("private response"); }; } });
    try {
      x.api.kick(RATE * 5); await x.api.waitForIdle(); await x.api.drain(RATE * 5);
      assert.equal(x.api.snapshot().failedSegments, 1);
      assert.deepEqual(x.state.preview.windows.map(w => [w.startFrame, w.endFrame]), [[0, RATE * 3], [RATE * 3, RATE * 5]]);
      await x.api.retry();
      assert.equal(x.streams.length, 3);
      assert.deepEqual(Buffer.concat(x.streams[2].chunks), (await readAudio(0, RATE * 3)).subarray(44));
      assert.equal(x.api.snapshot().failedSegments, 0);
      assert(!JSON.stringify(x.state).includes("private response"));
    } finally { await x.api.shutdown(); }
  });

  await test("explicit bounded pause rotation checkpoints the released suffix", async () => {
    const state = {};
    let sealed;
    const x = fixture({ state, windowSeconds: 600, readAudio: async (start, end) => quietWave(start, end, [[0, RATE * 615]]),
      onChange: () => {
        if (!sealed && state.preview.windows.length === 1 && state.preview.windows[0].rotationBoundary === "pause") {
          sealed = structuredClone(state);
        }
      } });
    try {
      x.api.kick(RATE * 615); await x.api.waitForIdle(); await x.api.drain(RATE * 615);
      assert.deepEqual(state.preview.windows.map(w => [w.startFrame, w.endFrame]), [[0, RATE * 570], [RATE * 570, RATE * 615]]);
      assert.equal(sealed.preview.cursorFrame, RATE * 570);
      assert.equal(x.streams.flatMap(s => s.chunks).reduce((bytes, b) => bytes + b.length, 0), RATE * 615 * 2);
      const restored = fixture({ state: sealed });
      try {
        await restored.api.recover(RATE * 615);
        assert.equal(restored.streams.length, 0);
        assert.deepEqual(sealed.preview.windows.map(w => [w.startFrame, w.endFrame]), [[0, RATE * 570], [RATE * 570, RATE * 615]]);
        assert.equal(restored.api.snapshot().failedSegments, 2);
      } finally { await restored.api.shutdown(); }
    } finally { await x.api.shutdown(); }
  });

  await test("one healthy task keeps language context through thirty minutes and saving intervals", async () => {
    const state = {}, updates = [];
    let opened = 0, frames = 0, finished = 0;
    const api = createMeetingPreview({ state, paceMs: 0, readSeconds: 40,
      readAudio: async (a, b) => {
        assert(b - a <= RATE * 40);
        return quietWave(a, b);
      }, createStream: ({ onSentence }) => {
        opened++;
        return { ready: Promise.resolve(), appendPcm: async pcm => {
          frames += pcm.length / 2;
          onSentence({ id: "continuous", text: "Continuous draft", beginMs: 0, endMs: frames * 1000 / RATE, final: false });
        }, finish: async () => {
          finished++;
          onSentence({ id: "continuous", text: "Complete continuous speech", beginMs: 0, endMs: frames * 1000 / RATE, final: true });
        }, close() {} };
      }, onChange: value => { if (value.previewText) updates.push(value.previewText); } });
    try {
      for (const seconds of [30, 60, 600, 1200, 1801]) {
        api.kick(RATE * seconds);
        await api.waitForIdle();
        assert.equal(opened, 1);
        assert.equal(finished, 0);
        assert.equal(frames, RATE * seconds);
      }
      assert(updates.length > 0);
      await api.drain(RATE * 1801 + 17);
      assert.equal(finished, 1);
      assert.equal(frames, RATE * 1801 + 17);
      assert.equal(state.preview.windows.length, 1);
      assert.equal(api.snapshot().segments[0].text, "Complete continuous speech");
    } finally { await api.shutdown(); }
  });

  await test("late submitted audio repairs only affected sentences while live drafts continue", async () => {
    let time = 0;
    const x = fixture({ now: () => time, autoRetry: true, configure: (s, n) => {
      if (n === 1) s.finish = async () => {};
      else s.finish = async () => s.callbacks.onSentence({ id: "fixed", text: "Repaired middle", beginMs: 0, endMs: 600, final: true });
    } });
    try {
      x.api.kick(RATE); await x.api.waitForIdle();
      const emit = x.streams[0].callbacks.onSentence;
      emit({ id: "before", text: "Keep before", beginMs: 0, endMs: 200, final: true });
      emit({ id: "middle", text: "Old middle", beginMs: 200, endMs: 800, final: true });
      emit({ id: "after", text: "Keep after", beginMs: 800, endMs: 1000, final: true });
      assert.equal(x.api.invalidate(RATE * .4, RATE * .6), 1);
      assert.equal(x.streams[0].closed, 0);
      assert.equal(x.state.preview.windows[0].status, "streaming");
      assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["Keep before", "Old middle", "Keep after"]);
      time = 3000;
      x.api.kick(RATE * 2); await x.api.waitForIdle();
      emit({ id: "new", text: "Still live", beginMs: 1000, endMs: 2000, final: false });
      assert.equal(x.api.snapshot().previewText, "Still live");
      assert.equal(x.streams[0].closed, 0);
      assert.equal(x.streams.length, 2);
      assert.deepEqual(Buffer.concat(x.streams[1].chunks), wave(RATE * .2, RATE * .8).subarray(44));
      assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["Keep before", "Repaired middle", "Keep after"]);
      assert.equal(x.api.snapshot().failedSegments, 0);
      const restored = fixture({ state: structuredClone(x.state) });
      try {
        await restored.api.recover(RATE * 2);
        assert.deepEqual(restored.api.snapshot().segments.map(s => s.text), ["Keep before", "Repaired middle", "Keep after"]);
        assert.equal(restored.streams.length, 0);
      } finally { await restored.api.shutdown(); }
    } finally { await x.api.shutdown(); }
  });

  await test("automatic disconnect recovery preserves confirmed text and replays only its tail", async () => {
    let time = 0;
    const x = fixture({ autoRetry: true, now: () => time, reconnectDelayMs: 100,
      configure: (s, n) => {
        if (n !== 1) return;
        const append = s.appendPcm;
        s.appendPcm = async pcm => {
          await append(pcm);
          if (s.chunks.length === 1) s.callbacks.onSentence({ id: "0", text: "Keep confirmed", beginMs: 0, endMs: 100, final: true });
          if (s.chunks.length === 3) s.callbacks.onError(new Error("private transport body"));
        };
      } });
    try {
      x.api.kick(RATE); await x.api.waitForIdle();
      time = 1000;
      x.api.kick(RATE * 2); await x.api.waitForIdle();
      const replay = x.streams.find(s => s !== x.streams[0] && s.chunks[0]?.readInt16LE(0) === wave(RATE / 10, RATE / 10 + 1).readInt16LE(44));
      assert(replay);
      assert.deepEqual(Buffer.concat(replay.chunks), wave(RATE / 10, RATE).subarray(44));
      assert.equal(x.api.snapshot().segments[0].text, "Keep confirmed");
      assert.equal(x.api.snapshot().failedSegments, 0);
      await x.api.drain(RATE * 2);
      assert.deepEqual(x.api.snapshot().segments.map(s => s.text), ["Keep confirmed", "Same words", "Same words"]);
      assert(!JSON.stringify(x.state).includes("private transport body"));
    } finally { await x.api.shutdown(); }
  });

  await test("automatic retries stop after five attempts and remain manually recoverable", async () => {
    let time = 0, offline = true;
    const x = fixture({ autoRetry: true, now: () => time, configure: s => {
      if (offline) s.ready = Promise.reject(new Error("offline"));
    } });
    try {
      x.api.kick(RATE); await x.api.waitForIdle();
      for (let i = 0; i < 8; i++) { time += 100000; x.api.kick(RATE); await x.api.waitForIdle(); }
      assert.equal(x.streams.length, 6);
      assert.equal(x.state.preview.windows[0].autoAttempts, 5);
      assert.equal(x.api.snapshot().failedSegments, 1);
      offline = false;
      await x.api.retry();
      assert.equal(x.api.snapshot().failedSegments, 0);
    } finally { await x.api.shutdown(); }
  });

  await test("voiced audio without any results is detected; silence and progressing drafts are safe", async () => {
    const stuck = fixture({ resultStallSeconds: .3, readAudio: async (a, b) => quietWave(a, b) });
    try {
      stuck.api.kick(RATE); await stuck.api.waitForIdle();
      assert.equal(stuck.state.preview.windows[0].error.code, "preview_result_timeout");
      assert.equal(stuck.streams[0].closed, 1);
    } finally { await stuck.api.shutdown(); }
    for (const mode of ["silence", "drafts", "stale"]) {
      const x = fixture({ resultStallSeconds: .3,
        readAudio: async (a, b) => quietWave(a, b, mode === "silence" ? [[0, RATE * 2]] : []),
        configure: s => {
          if (mode === "silence") return;
          const append = s.appendPcm;
          s.appendPcm = async pcm => {
            await append(pcm);
            s.callbacks.onSentence({ id: "draft", text: "Listening", beginMs: 0,
              endMs: mode === "stale" ? 100 : s.chunks.length * 100, final: false });
          };
        } });
      try {
        x.api.kick(RATE * 2); await x.api.waitForIdle();
        assert.equal(x.api.snapshot().failedSegments, mode === "stale" ? 1 : 0);
        assert.equal(x.streams.length, 1);
      } finally { await x.api.shutdown(); }
    }
  });

  await test("a nine-minute pause does not queue paced silence before resumed speech", async () => {
    const resumedAt = RATE * 563;
    let time = 0;
    const x = fixture({ now: () => time, paceMs: 90, sleep: async ms => { time += ms; },
      readAudio: async (a, b) => quietWave(a, b, [[RATE, resumedAt]]),
      configure: s => {
        const append = s.appendPcm;
        s.appendPcm = async pcm => {
          await append(pcm);
          s.callbacks.onSentence({ id: "current", text: "Resumed speech", beginMs: 0, endMs: 50, final: false });
        };
      } });
    try {
      x.api.kick(RATE); await x.api.waitForIdle(); await x.api.drain(RATE);
      const before = time;
      x.api.kick(resumedAt + 1733); await x.api.waitForIdle();
      assert.equal(x.streams.length, 2);
      assert.equal(x.api.snapshot().previewText, "Resumed speech");
      assert(time - before < 1000, "pause duration must not become ASR backlog");
      assert.deepEqual(Buffer.concat(x.streams[1].chunks), quietWave(resumedAt, resumedAt + 1733).subarray(44));
      const skipped = x.state.preview.windows.find(w => w.skipped);
      assert.deepEqual([skipped.startFrame, skipped.endFrame, skipped.sentFrame], [RATE, resumedAt, RATE]);
      await x.api.drain(resumedAt + 1733);
      assert.equal(x.api.snapshot().segments.at(-1).startFrame, resumedAt);
      assert.equal(x.api.snapshot().failedSegments, 0);
    } finally { await x.api.shutdown(); }
  });

  await test("pause-gap skipping never discards quiet nonzero speech or loses late source audio", async () => {
    let late = false;
    const x = fixture({ readAudio: async (a, b) => {
      const wav = quietWave(a, b, late ? [] : [[RATE, RATE * 4]]);
      if (a <= RATE * 4 && b > RATE * 4) wav.writeInt16LE(1, 44 + (RATE * 4 - a) * 2);
      return wav;
    } });
    try {
      x.api.kick(RATE); await x.api.waitForIdle(); await x.api.drain(RATE);
      for (const end of [RATE * 2, RATE * 3]) { x.api.kick(end); await x.api.waitForIdle(); assert.equal(x.streams.length, 1); }
      x.api.kick(RATE * 5); await x.api.waitForIdle();
      assert.equal(x.streams.length, 2);
      assert.equal(x.streams[1].chunks[0].readInt16LE(0), 1);
      late = true;
      assert.equal(x.api.invalidate(RATE, RATE * 2), 1);
      await x.api.retry();
      assert.equal(x.api.snapshot().failedSegments, 0);
      assert.deepEqual(Buffer.concat(x.streams[2].chunks), quietWave(RATE, RATE * 2).subarray(44));
    } finally { await x.api.shutdown(); }
  });

  await test("late source audio cannot publish an obsolete retiring task as completed", async () => {
    const receipt = deferred();
    const x = fixture({ windowSeconds: .2, configure: (s, n) => {
      if (n !== 1) return;
      const finish = s.finish;
      s.finish = async () => { await receipt.promise; await finish(); };
    } });
    try {
      x.api.kick(RATE * .3);
      for (let i = 0; i < 20 && x.streams.length < 2; i++) await turn();
      assert.equal(x.state.preview.windows[0].status, "finishing");
      assert.equal(x.api.invalidate(0, RATE * .1), 1);
      receipt.resolve();
      await x.api.waitForIdle();
      assert.equal(x.state.preview.windows[0].status, "failed");
      assert.equal(x.state.preview.windows[0].error.code, "preview_audio_changed");
      assert.equal(x.streams[1].closed, 0, "the newer live connection keeps running");
      await x.api.retry();
      assert.equal(x.api.snapshot().failedSegments, 0);
    } finally { receipt.resolve(); await x.api.shutdown(); }
  });

  console.log(`Meeting preview: ${count} tests passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
