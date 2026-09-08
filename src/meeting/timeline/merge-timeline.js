"use strict";

/**
 * Pure meeting timeline merger (Stage 1A).
 *
 * - microphone track → local speaker "self" (no diarization required)
 * - system track → remote mix with Fun-ASR speaker IDs
 * - map provider-relative sentence times through artifact sidecar onto shared session QPC
 * - sort by sessionBeginMs when available (correct across compacted pause holes)
 * - keep overlaps; do not merge mic+system audio before ASR
 */

const { mapArtifactTimeRange } = require("../archive/export-track-wav");

const SELF_SPEAKER_ID = "self";

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} args
 * @param {Array<{text, beginMs, endMs, speakerId?, confidence?, channelId?}>} [args.microphoneSentences]
 * @param {Array} [args.systemSentences]
 * @param {object|null} [args.microphoneSidecar]
 * @param {object|null} [args.systemSidecar]
 * @param {string} [args.sessionId]
 */
function mergeMeetingTimeline({
  microphoneSentences = [],
  systemSentences = [],
  microphoneSidecar = null,
  systemSidecar = null,
  sessionId = null
} = {}) {
  const items = [];

  function pushFrom(sentences, track, role, sidecar, speakerMode) {
    const list = Array.isArray(sentences) ? sentences : [];
    for (let i = 0; i < list.length; i += 1) {
      const s = list[i] || {};
      const text = String(s.text || "").trim();
      if (!text) continue;
      const providerBeginMs = numOrNull(s.beginMs ?? s.begin_time ?? s.startMs);
      const providerEndMs = numOrNull(s.endMs ?? s.end_time ?? s.stopMs);
      const mapped = sidecar
        ? mapArtifactTimeRange(sidecar, providerBeginMs, providerEndMs)
        : {
            artifactBeginMs: providerBeginMs,
            artifactEndMs: providerEndMs,
            beginMs: providerBeginMs,
            endMs: providerEndMs,
            qpcBegin: null,
            qpcEnd: null,
            sessionBeginMs: null,
            sessionEndMs: null,
            sessionOriginQpc: null,
            qpcFrequency: null,
            coveringSeqs: [],
            gapsOverlapping: []
          };

      let speakerId;
      let speakerLabel;
      if (speakerMode === "self") {
        speakerId = SELF_SPEAKER_ID;
        speakerLabel = "self";
      } else {
        const raw = s.speakerId ?? s.speaker_id ?? s.spk ?? s.speaker ?? null;
        speakerId =
          raw == null || raw === "" ? "remote_unknown" : `remote_${String(raw)}`;
        speakerLabel = raw == null || raw === "" ? "remote_unknown" : String(raw);
      }

      items.push({
        id: `${track}:${i}:${providerBeginMs ?? "x"}:${providerEndMs ?? "x"}`,
        track,
        role,
        speakerId,
        speakerLabel,
        text,
        // Artifact / provider-relative WAV timeline (pauses compacted per track)
        artifactBeginMs: mapped.artifactBeginMs ?? mapped.beginMs,
        artifactEndMs: mapped.artifactEndMs ?? mapped.endMs,
        beginMs: mapped.artifactBeginMs ?? mapped.beginMs,
        endMs: mapped.artifactEndMs ?? mapped.endMs,
        providerBeginMs,
        providerEndMs,
        // Shared session timeline
        sessionBeginMs: mapped.sessionBeginMs ?? null,
        sessionEndMs: mapped.sessionEndMs ?? null,
        qpcBegin: mapped.qpcBegin,
        qpcEnd: mapped.qpcEnd,
        sessionOriginQpc: mapped.sessionOriginQpc ?? sidecar?.sessionOriginQpc ?? null,
        qpcFrequency: mapped.qpcFrequency ?? sidecar?.qpcFrequency ?? null,
        coveringSeqs: mapped.coveringSeqs || [],
        gapsOverlapping: mapped.gapsOverlapping || [],
        confidence: s.confidence ?? s.sentiment_confidence ?? null,
        channelId: s.channelId ?? s.channel_id ?? null,
        sourceIndex: i
      });
    }
  }

  pushFrom(microphoneSentences, "microphone", "self", microphoneSidecar, "self");
  pushFrom(
    systemSentences,
    "system",
    "remote_mix_for_diarization",
    systemSidecar,
    "remote"
  );

  items.sort(compareTimelineItems);

  return {
    schema: "meeting_timeline_v1",
    sessionId,
    policy: {
      mergeAudioBeforeAsr: false,
      echoCancellation: false,
      keepOverlaps: true,
      microphoneSpeaker: SELF_SPEAKER_ID,
      systemSpeakerSource: "fun_asr_diarization",
      sortKey: "sessionBeginMs_then_artifactBeginMs"
    },
    count: items.length,
    items
  };
}

function compareTimelineItems(a, b) {
  // Prefer shared session timeline (correct across independently compacted pauses)
  const as = numOrNull(a.sessionBeginMs);
  const bs = numOrNull(b.sessionBeginMs);
  if (as != null && bs != null && as !== bs) return as - bs;
  if (as != null && bs == null) return -1;
  if (as == null && bs != null) return 1;

  const ab = numOrNull(a.artifactBeginMs ?? a.beginMs);
  const bb = numOrNull(b.artifactBeginMs ?? b.beginMs);
  if (ab != null && bb != null && ab !== bb) return ab - bb;
  if (ab != null && bb == null) return -1;
  if (ab == null && bb != null) return 1;

  // Same begin: microphone before system (deterministic cross-track overlap)
  const trackRank = (t) => (t === "microphone" ? 0 : t === "system" ? 1 : 2);
  const tr = trackRank(a.track) - trackRank(b.track);
  if (tr !== 0) return tr;

  const ase = numOrNull(a.sessionEndMs);
  const bse = numOrNull(b.sessionEndMs);
  if (ase != null && bse != null && ase !== bse) return ase - bse;

  const ae = numOrNull(a.artifactEndMs ?? a.endMs);
  const be = numOrNull(b.artifactEndMs ?? b.endMs);
  if (ae != null && be != null && ae !== be) return ae - be;

  const spkCmp = String(a.speakerId || "").localeCompare(String(b.speakerId || ""));
  if (spkCmp !== 0) return spkCmp;
  const si = (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0);
  if (si !== 0) return si;
  return String(a.text || "").localeCompare(String(b.text || ""));
}

module.exports = {
  SELF_SPEAKER_ID,
  mergeMeetingTimeline,
  compareTimelineItems
};
