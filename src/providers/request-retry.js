"use strict";

const MAX_RETRIES = 5;

function abortError() {
  return Object.assign(new Error("aborted"), { code: "aborted" });
}

function retryAfterMs(headers, now = Date.now()) {
  const milliseconds = headers?.get?.("retry-after-ms");
  if (milliseconds != null && milliseconds !== "" && Number.isFinite(Number(milliseconds))) {
    return Math.max(0, Math.min(2147483647, Number(milliseconds)));
  }
  const value = headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(2147483647, Math.ceil(delay))) : null;
}

function isRetryable(error) {
  if (error?.status != null) return [408, 409, 425, 429].includes(error.status) || error.status >= 500;
  return ["network_error", "connection_timeout", "stream_idle_timeout", "response_incomplete"].includes(error?.code);
}

function retryDelay(retry, error, random = Math.random) {
  if (Number.isFinite(error?.retryAfterMs)) return error.retryAfterMs;
  const base = Math.min(30000, 2000 * 2 ** (retry - 1));
  return Math.min(30000, Math.ceil(base * (1 + random() * 0.25)));
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function sleep(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function withRetries(run, { signal, maxRetries = MAX_RETRIES, onRetry, sleepImpl = sleep, random } = {}) {
  const retries = Math.min(MAX_RETRIES, Math.max(0, Math.floor(maxRetries) || 0));
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortError();
    try { return await run(attempt); }
    catch (error) {
      if (signal?.aborted) throw abortError();
      if (attempt > retries || !isRetryable(error)) throw error;
      const delayMs = retryDelay(attempt, error, random);
      onRetry?.({ retry: attempt, maxRetries: retries, delayMs, code: error.code });
      await abortable(sleepImpl(delayMs, signal), signal);
    }
  }
}

module.exports = { MAX_RETRIES, abortError, abortable, isRetryable, retryAfterMs, retryDelay, sleep, withRetries };
