(function exposeAudioUtils(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OpenVoiceAudio = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  function flattenFloat32(chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  function resampleFloat32(input, sourceSampleRate, targetSampleRate) {
    if (!sourceSampleRate || !targetSampleRate || sourceSampleRate === targetSampleRate) return input;
    const ratio = sourceSampleRate / targetSampleRate;
    const outputLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i += 1) {
      const sourceIndex = i * ratio;
      const index = Math.floor(sourceIndex);
      const nextIndex = Math.min(index + 1, input.length - 1);
      const weight = sourceIndex - index;
      output[i] = input[index] * (1 - weight) + input[nextIndex] * weight;
    }
    return output;
  }

  function float32ToPcm16Bytes(samples) {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return bytes;
  }

  function float32ToPcm16Base64(input, sourceSampleRate, targetSampleRate = sourceSampleRate) {
    const samples = resampleFloat32(input, sourceSampleRate, targetSampleRate);
    return bytesToBase64(float32ToPcm16Bytes(samples));
  }

  function encodePcm16Wav(samples, sampleRate) {
    const pcm = float32ToPcm16Bytes(samples);
    const buffer = new ArrayBuffer(44 + pcm.byteLength);
    const view = new DataView(buffer);
    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + pcm.byteLength, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, "data");
    view.setUint32(40, pcm.byteLength, true);
    new Uint8Array(buffer, 44).set(pcm);
    return new Uint8Array(buffer);
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function buildAudioPayload(chunks, sourceSampleRate, targetSampleRate = 16000) {
    const source = flattenFloat32(chunks);
    const samples = resampleFloat32(source, sourceSampleRate, targetSampleRate);
    const wavBytes = encodePcm16Wav(samples, targetSampleRate);
    const pcmBytes = wavBytes.subarray(44);
    const wavBase64 = bytesToBase64(wavBytes);
    return {
      audioDataUrl: `data:audio/wav;base64,${wavBase64}`,
      pcm16Base64: bytesToBase64(pcmBytes),
      byteLength: wavBytes.byteLength,
      base64Length: wavBase64.length,
      durationSeconds: samples.length / targetSampleRate,
      sampleRate: targetSampleRate
    };
  }

  function buildAudioPayloads(chunks, sourceSampleRate, { maxSegmentSeconds = 210, targetSampleRate = 16000 } = {}) {
    const groups = splitChunksByDuration(chunks, sourceSampleRate, maxSegmentSeconds);
    return groups.map((group) => buildAudioPayload(group, sourceSampleRate, targetSampleRate));
  }

  function splitChunksByDuration(chunks, sampleRate, maxSegmentSeconds) {
    const maxSamples = Math.max(1, Math.floor(sampleRate * maxSegmentSeconds));
    const groups = [];
    let group = [];
    let groupSamples = 0;
    for (const chunk of chunks) {
      let offset = 0;
      while (offset < chunk.length) {
        const available = maxSamples - groupSamples;
        const take = Math.min(available, chunk.length - offset);
        group.push(chunk.subarray(offset, offset + take));
        groupSamples += take;
        offset += take;
        if (groupSamples >= maxSamples) {
          groups.push(group);
          group = [];
          groupSamples = 0;
        }
      }
    }
    if (groupSamples) groups.push(group);
    return groups;
  }

  function joinTranscriptSegments(parts) {
    let result = "";
    for (const part of parts) {
      const text = String(part || "").trim();
      if (!text) continue;
      if (!result) {
        result = text;
        continue;
      }
      const previous = result[result.length - 1] || "";
      const next = text[0] || "";
      const needsSpace = /[A-Za-z0-9.!?;:,]$/.test(previous) && /^[A-Za-z0-9]/.test(next);
      result += needsSpace ? ` ${text}` : text;
    }
    return result;
  }

  function writeString(view, offset, value) {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  }

  return {
    buildAudioPayload,
    buildAudioPayloads,
    encodePcm16Wav,
    flattenFloat32,
    float32ToPcm16Base64,
    float32ToPcm16Bytes,
    joinTranscriptSegments,
    resampleFloat32,
    splitChunksByDuration
  };
});
