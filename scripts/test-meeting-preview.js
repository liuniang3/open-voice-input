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

function fixture(options = {}) {
  const state = options.state || {};
  const streams = [];
  const reads = [];
  let saves = 0;
  const api = createMeetingPreview({ state, paceMs: 0, reconnectDelayMs: 0,
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

  await test("default windows never exceed ten minutes and invalid options cannot lose spans", async () => {
    const state = {};
    const api = createMeetingPreview({ state, windowSeconds: 3600 });
    await api.recover(RATE * 1250);
    assert.deepEqual(state.preview.windows.map(w => w.endFrame - w.startFrame), [RATE * 600, RATE * 600, RATE * 50]);
    await api.shutdown();
    assert.throws(() => createMeetingPreview({ state: {}, windowSeconds: NaN }), { code: "preview_limits_invalid" });
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
    assert.equal(x.state.preview.windows[0].error.code, "preview_audio_changed");
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

  await test("late audio cancels active read-ahead, drops draft and rejects stale socket callbacks", async () => {
    const send = deferred();
    let changedAudio = false;
    const x = fixture({ readAudio: async (start, end) => {
      const wav = wave(start, end);
      if (changedAudio) wav.writeInt16LE(777, 44);
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
    assert.equal(x.api.invalidate(RATE / 2, RATE), 1, "also invalidate stale read-ahead not yet sent");
    await x.api.waitForIdle();
    assert.equal(x.streams[0].closed, 1);
    assert.equal(x.api.snapshot().previewText, "");
    assert.equal(x.api.snapshot().segments[0].text, "retained final");
    x.streams[0].callbacks.onSentence({ id: "1", text: "obsolete", beginMs: 100, endMs: 200, final: true });
    assert.equal(x.api.snapshot().segments.length, 1);
    await x.api.retry();
    assert.equal(x.streams[1].chunks[0].readInt16LE(0), 777, "retry rereads changed durable audio");
    assert.equal(x.api.snapshot().failedSegments, 0);
    send.resolve();
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

  console.log(`Meeting preview: ${count} tests passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
