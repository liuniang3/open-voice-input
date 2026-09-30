"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createOnboardingState({ directory, now = () => new Date(), fsImpl = fs } = {}) {
  const filename = path.join(directory, "onboarding-state.json");
  let state;
  let tail = Promise.resolve();
  const run = (task) => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };
  async function load({ existingUser = false } = {}) {
    if (state) return { ...state };
    try {
      const saved = JSON.parse(await fsImpl.readFile(filename, "utf8"));
      if (saved.version !== 1 || !["completed", "skipped", "migrated"].includes(saved.status)) throw new Error("invalid");
      state = { version: 1, status: saved.status };
    } catch {
      state = { version: 1, status: existingUser ? "migrated" : "pending" };
      if (existingUser) await persist("migrated");
    }
    return { ...state };
  }
  async function persist(status) {
    if (!["completed", "skipped", "migrated"].includes(status)) throw new Error("onboarding_status_invalid");
    const next = { version: 1, status, updatedAt: now().toISOString() };
    await fsImpl.mkdir(directory, { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await fsImpl.writeFile(temporary, JSON.stringify(next), "utf8");
    await fsImpl.rename(temporary, filename);
    state = { version: 1, status };
    return { ...state };
  }
  return { read: (options) => run(() => load(options)), finish: (status) => run(() => persist(status)) };
}

module.exports = { createOnboardingState };
