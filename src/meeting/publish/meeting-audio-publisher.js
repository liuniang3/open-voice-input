"use strict";

/**
 * MeetingAudioPublisher — narrow interface for making a local archive artifact
 * available to an async ASR provider.
 *
 * Implementations must not hold or require provider credentials.
 *
 * Contract:
 *   async publish({ localPath, contentType, track, sessionId, purpose })
 *     -> { kind: "local"|"remote_url", url?: string, localPath?: string, public: boolean, ... }
 *
 *   capabilities(): { canProvidePublicUrl: boolean, uploads: boolean, id: string }
 */

class MeetingPublisherError extends Error {
  constructor(message, code = "publisher_error", details = null) {
    super(message);
    this.name = "MeetingPublisherError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Default: export-only / offline. Never uploads. Never returns a public URL.
 */
function createOfflineMeetingAudioPublisher(options = {}) {
  const id = options.id || "offline-export-only";

  return {
    id,
    capabilities() {
      return {
        id,
        canProvidePublicUrl: false,
        uploads: false,
        kind: "offline"
      };
    },
    async publish({ localPath, contentType, track, sessionId, purpose } = {}) {
      const p = String(localPath || "").trim();
      if (!p) {
        throw new MeetingPublisherError("localPath required", "invalid_argument");
      }
      return {
        kind: "local",
        public: false,
        uploads: false,
        localPath: p,
        contentType: contentType || "audio/wav",
        track: track || null,
        sessionId: sessionId || null,
        purpose: purpose || "asr",
        url: null,
        note: "offline publisher does not upload; artifact remains local-only"
      };
    }
  };
}

/**
 * Testing / explicit remote adapter: caller supplies HTTPS URLs (or a resolver).
 * Never reads local paths into the network; never invents URLs from disk paths.
 */
function createRemoteUrlMeetingAudioPublisher(options = {}) {
  const id = options.id || "remote-url";
  const urlByKey = options.urlByKey || Object.create(null);
  const resolveUrl =
    typeof options.resolveUrl === "function"
      ? options.resolveUrl
      : async ({ track, sessionId, localPath, key }) => {
          if (key && urlByKey[key]) return urlByKey[key];
          const k2 = `${sessionId || ""}:${track || ""}`;
          if (urlByKey[k2]) return urlByKey[k2];
          if (localPath && urlByKey[localPath]) return urlByKey[localPath];
          return options.defaultUrl || null;
        };

  return {
    id,
    capabilities() {
      return {
        id,
        canProvidePublicUrl: true,
        uploads: false,
        kind: "remote_url_adapter",
        note: "caller-supplied HTTPS URLs only; does not upload local files"
      };
    },
    async publish({ localPath, contentType, track, sessionId, purpose, key } = {}) {
      const url = await resolveUrl({
        localPath,
        track,
        sessionId,
        purpose,
        key
      });
      const value = String(url || "").trim();
      if (!/^https:\/\//i.test(value)) {
        throw new MeetingPublisherError(
          "remote URL publisher requires a caller-supplied https:// URL (http not accepted for cloud ASR handoff)",
          "public_url_unavailable",
          { track, sessionId, hasLocalPath: Boolean(localPath) }
        );
      }
      return {
        kind: "remote_url",
        public: true,
        uploads: false,
        url: value,
        localPath: null,
        contentType: contentType || "audio/wav",
        track: track || null,
        sessionId: sessionId || null,
        purpose: purpose || "asr",
        note: "local path intentionally omitted from handoff payload"
      };
    }
  };
}

/**
 * Resolve a publisher that can satisfy cloud Fun-ASR file_urls, or throw actionable error.
 */
function requirePublicUrlPublisher(publisher) {
  const caps = publisher && typeof publisher.capabilities === "function" ? publisher.capabilities() : null;
  if (!publisher || !caps || !caps.canProvidePublicUrl) {
    throw new MeetingPublisherError(
      "Cloud Fun-ASR meeting transcription requires a MeetingAudioPublisher that can provide a public HTTPS URL. " +
        "Default offline publisher is export-only and never uploads. " +
        "Configure object storage / a remote-URL adapter (caller-supplied https URL), or keep processing offline. " +
        "Public object storage for meeting artifacts is not bundled in Stage 1A.",
      "meeting_publisher_public_url_required",
      {
        configured: publisher ? publisher.id || caps?.id || "unknown" : null,
        canProvidePublicUrl: Boolean(caps?.canProvidePublicUrl),
        uploads: Boolean(caps?.uploads),
        remediation: [
          "use createRemoteUrlMeetingAudioPublisher with explicit https URLs for tests",
          "or integrate a future object-storage publisher that returns https URLs without embedding credentials in this abstraction"
        ]
      }
    );
  }
  return publisher;
}

module.exports = {
  MeetingPublisherError,
  createOfflineMeetingAudioPublisher,
  createRemoteUrlMeetingAudioPublisher,
  requirePublicUrlPublisher
};
