"use strict";

/**
 * Runtime-only Aliyun OSS credentials for meeting enhanced upload.
 * Never persist resolved secrets into session/job/logs.
 */

function trimStr(v) {
  return String(v || "").trim();
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const s = trimStr(v);
    if (s) return s;
  }
  return "";
}

function sanitizePrefix(prefix) {
  let p = trimStr(prefix).replace(/\\/g, "/");
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");
  // block path traversal in prefix
  if (p.split("/").some((seg) => seg === ".." || seg === ".")) {
    const error = new Error("invalid OSS prefix");
    error.code = "meeting_oss_prefix_invalid";
    throw error;
  }
  return p;
}

/**
 * settings: meetingOssRegion, meetingOssEndpoint, meetingOssBucket,
 * meetingOssAccessKeyId, meetingOssAccessKeySecret, meetingOssPrefix
 */
function resolveMeetingOssCredentials({ env = process.env, settings = {} } = {}) {
  const s = settings && typeof settings === "object" ? settings : {};
  const region = firstNonEmpty(env.OVI_MEETING_OSS_REGION, s.meetingOssRegion);
  const bucket = firstNonEmpty(env.OVI_MEETING_OSS_BUCKET, s.meetingOssBucket);
  const accessKeyId = firstNonEmpty(
    env.OVI_MEETING_OSS_ACCESS_KEY_ID,
    s.meetingOssAccessKeyId
  );
  const accessKeySecret = firstNonEmpty(
    env.OVI_MEETING_OSS_ACCESS_KEY_SECRET,
    s.meetingOssAccessKeySecret
  );
  const endpoint = firstNonEmpty(env.OVI_MEETING_OSS_ENDPOINT, s.meetingOssEndpoint) || null;
  const prefix = sanitizePrefix(
    firstNonEmpty(env.OVI_MEETING_OSS_PREFIX, s.meetingOssPrefix, "meeting")
  );

  if (!region || !bucket || !accessKeyId || !accessKeySecret) {
    const error = new Error(
      "Meeting OSS not configured. Set OVI_MEETING_OSS_REGION/BUCKET/ACCESS_KEY_ID/ACCESS_KEY_SECRET " +
        "or meeting settings. Enhanced speaker separation requires object storage."
    );
    error.code = "meeting_oss_credentials_missing";
    throw error;
  }

  return {
    region,
    bucket,
    endpoint,
    accessKeyId,
    accessKeySecret,
    prefix,
    _sensitive: true
  };
}

module.exports = {
  sanitizePrefix,
  resolveMeetingOssCredentials
};
