"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { MeetingPublisherError } = require("./meeting-audio-publisher");

const DEFAULT_URL_EXPIRES_SEC = 60 * 60; // 60 minutes minimum product requirement

function buildObjectKey({
  prefix = "meeting",
  sessionId,
  generation = 1,
  track = "system",
  contentSha256,
  ext = "mp3"
} = {}) {
  const sid = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  const tr = String(track || "system").replace(/[^A-Za-z0-9._-]/g, "_");
  const sha = String(contentSha256 || crypto.randomBytes(16).toString("hex")).replace(
    /[^a-fA-F0-9]/g,
    ""
  );
  const gen = Number(generation) || 1;
  const e = String(ext || "mp3").replace(/^\./, "");
  const pre = String(prefix || "meeting").replace(/^\/+|\/+$/g, "");
  // No absolute paths; stable key for idempotent retry
  return `${pre}/${sid}/g${gen}/${tr}/${sha || "nosha"}.${e}`;
}

/**
 * Aliyun OSS publisher using official ali-oss.
 * Private objects + timed GET signature. Secrets never returned in publish result
 * beyond ephemeral signed URL for in-memory Fun-ASR handoff.
 *
 * @param {object} options
 * @param {object} options.credentials - from resolveMeetingOssCredentials
 * @param {function} [options.OSS] - injectable OSS constructor for tests
 * @param {number} [options.urlExpiresSec]
 */
function createAliyunOssMeetingAudioPublisher(options = {}) {
  const id = options.id || "aliyun-oss-v1";
  const creds = options.credentials;
  if (!creds?.accessKeyId || !creds?.accessKeySecret || !creds?.bucket || !creds?.region) {
    throw new MeetingPublisherError(
      "OSS credentials incomplete",
      "meeting_oss_credentials_missing"
    );
  }
  const urlExpiresSec = Math.max(
    DEFAULT_URL_EXPIRES_SEC,
    Number(options.urlExpiresSec) || DEFAULT_URL_EXPIRES_SEC
  );
  const OSS = options.OSS || require("ali-oss");
  const clientOpts = {
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    bucket: creds.bucket,
    region: creds.region.startsWith("oss-") ? creds.region : `oss-${creds.region}`,
    secure: true,
    timeout: options.timeoutMs || 120000
  };
  if (creds.endpoint) {
    clientOpts.endpoint = creds.endpoint;
    clientOpts.cname = Boolean(options.cname);
  }
  const client = options.client || new OSS(clientOpts);
  const prefix = creds.prefix || "meeting";

  /** @type {Map<string, { objectKey: string, bucket: string }>} */
  const lastBySessionTrack = new Map();

  return {
    id,
    capabilities() {
      return {
        id,
        canProvidePublicUrl: true,
        uploads: true,
        kind: "aliyun_oss",
        deletes: true,
        privateObjects: true,
        urlExpiresSec
      };
    },
    buildObjectKey(args) {
      return buildObjectKey({ prefix, ...args });
    },
    async publish({
      localPath,
      contentType,
      track,
      sessionId,
      purpose,
      contentSha256 = null,
      generation = 1,
      signal = null
    } = {}) {
      if (signal?.aborted) {
        throw new MeetingPublisherError("aborted", "aborted");
      }
      const p = String(localPath || "").trim();
      if (!p) throw new MeetingPublisherError("localPath required", "invalid_argument");
      const objectKey = buildObjectKey({
        prefix,
        sessionId,
        generation,
        track,
        contentSha256,
        ext: path.extname(p).replace(/^\./, "") || "mp3"
      });
      const headers = {
        "Content-Type": contentType || "audio/mpeg"
      };
      const putOpts = {
        headers,
        // private by default on bucket; do not set public-read
        meta: {
          session: String(sessionId || "").slice(0, 64),
          track: String(track || "").slice(0, 32),
          purpose: String(purpose || "asr").slice(0, 32)
        }
      };

      let abortedDuringPut = false;
      /** @type {(() => void)|null} */
      let onAbortCancel = null;
      /** @type {(() => void)|null} */
      let onAbortRace = null;

      const removeAbortListeners = () => {
        if (!signal) return;
        if (onAbortCancel) {
          try {
            signal.removeEventListener("abort", onAbortCancel);
          } catch {
            /* ignore */
          }
          onAbortCancel = null;
        }
        if (onAbortRace) {
          try {
            signal.removeEventListener("abort", onAbortRace);
          } catch {
            /* ignore */
          }
          onAbortRace = null;
        }
      };

      const bestEffortDelete = async () => {
        try {
          await client.delete(objectKey);
        } catch {
          /* ignore */
        }
      };

      if (signal) {
        if (signal.aborted) {
          throw new MeetingPublisherError("aborted", "aborted");
        }
        onAbortCancel = () => {
          abortedDuringPut = true;
          try {
            if (typeof client.cancel === "function") client.cancel();
          } catch {
            /* ignore */
          }
        };
        signal.addEventListener("abort", onAbortCancel);
      }

      // Always attach a settlement handler so a late put reject after abort race
      // cannot become an unhandledRejection; also delete if put finished after abort.
      const putPromise = Promise.resolve()
        .then(() => client.put(objectKey, p, putOpts))
        .then(
          (value) => {
            if (abortedDuringPut || signal?.aborted) {
              return bestEffortDelete().then(() => {
                throw new MeetingPublisherError("aborted", "aborted");
              });
            }
            return value;
          },
          (error) => {
            if (abortedDuringPut || signal?.aborted || error?.code === "aborted") {
              return bestEffortDelete().then(() => {
                throw new MeetingPublisherError("aborted", "aborted");
              });
            }
            throw error;
          }
        );

      try {
        if (signal) {
          const abortPromise = new Promise((_, reject) => {
            if (signal.aborted) {
              reject(new MeetingPublisherError("aborted", "aborted"));
              return;
            }
            onAbortRace = () => {
              abortedDuringPut = true;
              reject(new MeetingPublisherError("aborted", "aborted"));
            };
            signal.addEventListener("abort", onAbortRace);
          });
          await Promise.race([putPromise, abortPromise]);
        } else {
          await putPromise;
        }
      } catch (error) {
        if (signal?.aborted || abortedDuringPut || error?.code === "aborted") {
          await bestEffortDelete();
          throw new MeetingPublisherError("aborted", "aborted");
        }
        throw error;
      } finally {
        removeAbortListeners();
        // Keep putPromise observed forever (no orphan finally chain).
        putPromise.catch(() => {});
      }

      if (signal?.aborted || abortedDuringPut) {
        await bestEffortDelete();
        throw new MeetingPublisherError("aborted", "aborted");
      }

      const url = client.signatureUrl(objectKey, {
        expires: urlExpiresSec,
        method: "GET"
      });
      if (!/^https:\/\//i.test(String(url || ""))) {
        throw new MeetingPublisherError(
          "OSS signatureUrl did not return https URL",
          "public_url_unavailable"
        );
      }
      const meta = {
        objectKey,
        bucket: creds.bucket,
        region: creds.region,
        expiresAt: new Date(Date.now() + urlExpiresSec * 1000).toISOString()
      };
      lastBySessionTrack.set(`${sessionId}:${track}`, meta);
      // Ephemeral signed URL for caller memory only — do not persist
      return {
        kind: "remote_url",
        public: true,
        uploads: true,
        url: String(url),
        localPath: null,
        contentType: contentType || "audio/mpeg",
        track: track || null,
        sessionId: sessionId || null,
        purpose: purpose || "asr",
        objectKey,
        bucket: creds.bucket,
        region: creds.region,
        expiresAt: meta.expiresAt,
        // mark so serializers can strip
        _ephemeralUrl: true
      };
    },
    async deleteObject({ objectKey, sessionId, track } = {}) {
      let key = objectKey;
      if (!key && sessionId) {
        key = lastBySessionTrack.get(`${sessionId}:${track || "system"}`)?.objectKey;
      }
      if (!key) return { ok: false, code: "object_key_missing" };
      try {
        await client.delete(key);
        return { ok: true, objectKey: key };
      } catch (error) {
        return {
          ok: false,
          code: error?.code || "oss_delete_failed",
          message: String(error?.message || error).slice(0, 200)
        };
      }
    },
    /** Test connectivity without leaving permanent objects when possible */
    async testConnection() {
      const probeKey = buildObjectKey({
        prefix,
        sessionId: "_probe",
        generation: 0,
        track: "probe",
        contentSha256: crypto.randomBytes(16).toString("hex"),
        ext: "txt"
      });
      const body = Buffer.from("ovi-meeting-oss-probe");
      await client.put(probeKey, body, {
        headers: { "Content-Type": "text/plain" }
      });
      const url = client.signatureUrl(probeKey, { expires: 120, method: "GET" });
      await client.delete(probeKey);
      return {
        ok: true,
        bucket: creds.bucket,
        region: creds.region,
        signed: Boolean(url && /^https:\/\//i.test(url))
      };
    }
  };
}

module.exports = {
  DEFAULT_URL_EXPIRES_SEC,
  buildObjectKey,
  createAliyunOssMeetingAudioPublisher
};
