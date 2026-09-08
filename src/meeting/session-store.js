"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { TARGET_L1_FORMAT } = require("./constants");
const {
  assertPathInsideRoot,
  getMeetingSessionsRoot,
  getMicrophoneTrackDir,
  getSystemTrackDir,
  getSessionDir
} = require("./paths");

function nowIso() {
  return new Date().toISOString();
}

function createSessionId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `mtg-${stamp}-${rand}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(tmp, body, "utf8");
  await fsp.rename(tmp, filePath);
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Parse JSONL index; tolerate a corrupted trailing line.
 * Directory scan of committed files is authoritative for recovery.
 */
function parseIndexJsonl(text) {
  const lines = String(text || "").split(/\r?\n/);
  const entries = [];
  const errors = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      errors.push({ line: i + 1, message: error.message, raw: line.slice(0, 200) });
      if (i >= lines.length - 2) break;
    }
  }
  return { entries, errors };
}

async function scanTrackDirectory(trackDir) {
  const result = {
    trackDir,
    committed: [],
    partFile: null,
    index: { entries: [], errors: [] },
    journalExists: false,
    manifest: null
  };
  let names = [];
  try {
    names = await fsp.readdir(trackDir);
  } catch {
    return result;
  }

  const partName = names.find((n) => n === "current.part" || n.endsWith(".part"));
  if (partName) {
    const partPath = path.join(trackDir, partName);
    try {
      const st = await fsp.stat(partPath);
      result.partFile = {
        name: partName,
        path: partPath,
        bytes: st.size,
        incomplete: true
      };
    } catch {
      result.partFile = { name: partName, path: partPath, incomplete: true };
    }
  }

  for (const name of names) {
    if (!/\.l0\.pcm$/i.test(name) && !/^\d{6}\./.test(name)) continue;
    if (name.endsWith(".part")) continue;
    const filePath = path.join(trackDir, name);
    try {
      const st = await fsp.stat(filePath);
      if (!st.isFile()) continue;
      const seqMatch = name.match(/^(\d+)/);
      result.committed.push({
        name,
        path: filePath,
        bytes: st.size,
        seq: seqMatch ? Number(seqMatch[1]) : null,
        mtimeMs: st.mtimeMs
      });
    } catch {
      // skip unreadable
    }
  }
  result.committed.sort((a, b) => {
    if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq;
    return a.name.localeCompare(b.name);
  });

  const indexPath = path.join(trackDir, "index.jsonl");
  try {
    const raw = await fsp.readFile(indexPath, "utf8");
    result.index = parseIndexJsonl(raw);
  } catch {
    result.index = { entries: [], errors: [] };
  }

  result.journalExists = names.includes("journal.jsonl");
  result.manifest = await readJsonIfExists(path.join(trackDir, "manifest.json"));
  return result;
}

/**
 * Recovery authority: committed files on disk win over a damaged index tail.
 */
function buildRecoveryView(scan) {
  const committedNames = new Set(scan.committed.map((c) => c.name));
  const indexNames = new Set(
    (scan.index.entries || [])
      .map((e) => e && (e.file || e.name))
      .filter(Boolean)
  );
  const inIndexMissingOnDisk = [...indexNames].filter((n) => !committedNames.has(n));
  const onDiskMissingInIndex = scan.committed
    .map((c) => c.name)
    .filter((n) => !indexNames.has(n));

  return {
    authoritativeCommitted: scan.committed,
    partFile: scan.partFile,
    indexEntryCount: scan.index.entries.length,
    indexTailErrors: scan.index.errors,
    inIndexMissingOnDisk,
    onDiskMissingInIndex,
    archivePending: Boolean(scan.manifest?.archivePending ?? true),
    actualL0Format: scan.manifest?.actualL0Format || null,
    targetL1Format: scan.manifest?.targetL1Format || TARGET_L1_FORMAT,
    role: scan.manifest?.role || null,
    track: scan.manifest?.track || null,
    recording: Boolean(scan.manifest?.recording),
    recoverable: scan.committed.length > 0 || Boolean(scan.partFile)
  };
}

function mergeDualRecovery(micRecovery, sysRecovery) {
  const micOk = Boolean(micRecovery?.recoverable);
  const sysOk = Boolean(sysRecovery?.recoverable);
  return {
    dual: true,
    recoverable: micOk || sysOk,
    microphone: micRecovery,
    system: sysRecovery,
    committedCount:
      (micRecovery?.authoritativeCommitted?.length || 0) +
      (sysRecovery?.authoritativeCommitted?.length || 0),
    archivePending: Boolean(
      micRecovery?.archivePending !== false || sysRecovery?.archivePending !== false
    )
  };
}

function createSessionStore({ userDataPath, sessionsRoot: overrideRoot } = {}) {
  if (!userDataPath && !overrideRoot) {
    throw new Error("session store requires userDataPath or sessionsRoot");
  }
  const sessionsRoot = overrideRoot || getMeetingSessionsRoot(userDataPath);

  async function init() {
    await ensureDir(sessionsRoot);
    return sessionsRoot;
  }

  async function createSession({ title = "" } = {}) {
    await init();
    const sessionId = createSessionId();
    const sessionDir = getSessionDir(sessionsRoot, sessionId);
    const micDir = getMicrophoneTrackDir(sessionDir);
    const sysDir = getSystemTrackDir(sessionDir);
    await ensureDir(micDir);
    await ensureDir(sysDir);
    const session = {
      id: sessionId,
      title: String(title || ""),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "created",
      tracks: {
        microphone: {
          relativeDir: path.join("audio", "microphone"),
          status: "idle",
          role: "self"
        },
        system: {
          relativeDir: path.join("audio", "system"),
          status: "idle",
          role: "remote_mix_for_diarization"
        }
      },
      stage: "0B",
      capabilities: {
        microphone: true,
        systemLoopback: true,
        dualTrack: true,
        asr: false,
        summary: false,
        processLoopback: false
      },
      notes: [
        "Stage 0B dual-track mic + endpoint mix loopback",
        "system capture is full render endpoint mix (includes this app if playing)",
        "DRM may silence loopback; no process isolation; no ASR; no 2h claim"
      ]
    };
    await writeJsonAtomic(path.join(sessionDir, "session.json"), session);
    return { session, sessionDir, micDir, sysDir, sessionsRoot };
  }

  async function readSession(sessionId) {
    const sessionDir = getSessionDir(sessionsRoot, sessionId);
    const session = await readJsonIfExists(path.join(sessionDir, "session.json"));
    if (!session) return null;
    return { session, sessionDir };
  }

  async function updateSession(sessionId, patch) {
    const current = await readSession(sessionId);
    if (!current) {
      const error = new Error(`session not found: ${sessionId}`);
      error.code = "session_not_found";
      throw error;
    }
    const next = {
      ...current.session,
      ...patch,
      updatedAt: nowIso()
    };
    await writeJsonAtomic(path.join(current.sessionDir, "session.json"), next);
    return next;
  }

  async function scanSession(sessionId) {
    const current = await readSession(sessionId);
    if (!current) return null;
    const micDir = getMicrophoneTrackDir(current.sessionDir);
    const sysDir = getSystemTrackDir(current.sessionDir);
    const micScan = await scanTrackDirectory(micDir);
    const sysScan = await scanTrackDirectory(sysDir);
    const micRecovery = buildRecoveryView(micScan);
    const sysRecovery = buildRecoveryView(sysScan);
    const recovery = mergeDualRecovery(micRecovery, sysRecovery);
    // 0A compat: top-level recovery still reflects microphone when only mic exists
    const legacyRecovery =
      sysRecovery.authoritativeCommitted.length === 0 && !sysRecovery.partFile
        ? micRecovery
        : {
            ...recovery,
            authoritativeCommitted: [
              ...micRecovery.authoritativeCommitted,
              ...sysRecovery.authoritativeCommitted
            ],
            partFile: micRecovery.partFile || sysRecovery.partFile,
            indexTailErrors: [
              ...(micRecovery.indexTailErrors || []),
              ...(sysRecovery.indexTailErrors || [])
            ],
            actualL0Format: micRecovery.actualL0Format || sysRecovery.actualL0Format
          };
    return {
      session: current.session,
      sessionDir: current.sessionDir,
      microphone: micScan,
      system: sysScan,
      recovery: legacyRecovery,
      dualRecovery: recovery
    };
  }

  async function listSessions() {
    await init();
    let names = [];
    try {
      names = await fsp.readdir(sessionsRoot);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const sessionPath = path.join(sessionsRoot, name, "session.json");
      const session = await readJsonIfExists(sessionPath);
      if (!session) continue;
      const scanned = await scanSession(session.id || name);
      const rawTitle = session.title == null ? "" : String(session.title);
      const title = rawTitle.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
      out.push({
        id: session.id || name,
        title,
        status: session.status,
        source: session.source || (session.import ? "import" : "capture"),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        import: session.import
          ? {
              sourceFileName: session.import.sourceFileName || null,
              durationMs: session.import.durationMs ?? null,
              track: session.import.track || null,
              mediaKind: session.import.mediaKind || null,
              extension: session.import.extension || null,
              importer: session.import.importer || null
            }
          : null,
        recovery: scanned?.recovery || null,
        dualRecovery: scanned?.dualRecovery || null
      });
    }
    out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return out;
  }

  function resolveUnderSessions(candidate) {
    return assertPathInsideRoot(sessionsRoot, candidate);
  }

  return {
    sessionsRoot,
    init,
    createSession,
    readSession,
    updateSession,
    scanSession,
    listSessions,
    resolveUnderSessions,
    getMicrophoneTrackDir: (sessionDir) => getMicrophoneTrackDir(sessionDir),
    getSystemTrackDir: (sessionDir) => getSystemTrackDir(sessionDir),
    parseIndexJsonl,
    scanTrackDirectory,
    buildRecoveryView
  };
}

module.exports = {
  createSessionStore,
  parseIndexJsonl,
  scanTrackDirectory,
  buildRecoveryView,
  createSessionId
};
