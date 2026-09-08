const assert = require("node:assert/strict");
const { resolveAsrAudioPolicy } = require("../src/audio-policy");
const {
  buildAudioPayload,
  buildAudioPayloads,
  joinTranscriptSegments
} = require("../src/audio-utils");

const oneSecondAt48k = new Float32Array(48000);
for (let i = 0; i < oneSecondAt48k.length; i += 1) {
  oneSecondAt48k[i] = Math.sin((i / 48000) * Math.PI * 2 * 440) * 0.25;
}

const optimized = buildAudioPayload([oneSecondAt48k], 48000, 16000);
assert.equal(optimized.sampleRate, 16000);
assert.equal(Math.round(optimized.durationSeconds), 1);
assert.equal(optimized.byteLength, 44 + 16000 * 2);
assert.ok(optimized.base64Length < 44000);

const safeHardSegment = buildAudioPayload([new Float32Array(16000 * 210)], 16000, 16000);
assert.ok(safeHardSegment.base64Length < 9 * 1024 * 1024);

const twoAndHalfSeconds = new Float32Array(16000 * 2.5);
const segments = buildAudioPayloads([twoAndHalfSeconds], 16000, {
  maxSegmentSeconds: 1,
  targetSampleRate: 16000
});
assert.equal(segments.length, 3);
assert.deepEqual(segments.map((segment) => segment.durationSeconds), [1, 1, 0.5]);

const mimoPolicy = resolveAsrAudioPolicy({ asrProvider: "mimo", asrMode: "realtime" });
assert.equal(mimoPolicy.documentedMaxBase64Chars, 10 * 1024 * 1024);
assert.equal(mimoPolicy.prefetchSegments, true);
assert.equal(mimoPolicy.hardSegmentSeconds, 210);

const qwenBatchPolicy = resolveAsrAudioPolicy({ asrProvider: "qwen3-asr", asrMode: "batch" });
assert.equal(qwenBatchPolicy.documentedMaxDurationSeconds, 300);
assert.equal(qwenBatchPolicy.prefetchSegments, true);

const qwenRealtimePolicy = resolveAsrAudioPolicy({ asrProvider: "qwen3-asr", asrMode: "realtime" });
assert.equal(qwenRealtimePolicy.streaming, true);
assert.equal(qwenRealtimePolicy.prefetchSegments, false);

const funPolicy = resolveAsrAudioPolicy({ asrProvider: "fun-asr", asrMode: "batch" });
assert.equal(funPolicy.documentedMaxFileBytes, 2 * 1024 * 1024 * 1024);
assert.equal(funPolicy.documentedMaxDurationSeconds, 12 * 60 * 60);

assert.equal(joinTranscriptSegments(["第一段。", "第二段。"]), "第一段。第二段。");
assert.equal(joinTranscriptSegments(["hello", "world"]), "hello world");
assert.equal(joinTranscriptSegments(["hello.", "world"]), "hello. world");

console.log("audio segmentation tests passed");
