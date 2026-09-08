"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { resolveDisplayName } = require("../speaker-map");

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const DOCX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOCX_DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
</w:styles>`;

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildDocxDocument(title, text) {
  const lines = String(text || "").split(/\r?\n/);
  const paragraphs = lines
    .map((line, index) => {
      const style = index === 0 ? '<w:pPr><w:pStyle w:val="Title"/></w:pPr>' : "";
      return `<w:p>${style}<w:r><w:t xml:space="preserve">${xmlEscape(line || " ")}</w:t></w:r></w:p>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${xmlEscape(title)}</w:t></w:r></w:p>
    ${paragraphs}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;
}

function buildDocxCoreProperties(title) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>Open Voice Input</dc:creator>
  <cp:lastModifiedBy>Open Voice Input</cp:lastModifiedBy>
</cp:coreProperties>`;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* Minimal store-only ZIP writer keeps DOCX export dependency-free and portable. */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

function buildDocx({ title, text }) {
  return buildZip([
    { name: "[Content_Types].xml", data: DOCX_CONTENT_TYPES },
    { name: "_rels/.rels", data: DOCX_ROOT_RELS },
    { name: "word/document.xml", data: buildDocxDocument(title, text) },
    { name: "word/_rels/document.xml.rels", data: DOCX_DOCUMENT_RELS },
    { name: "word/styles.xml", data: DOCX_STYLES },
    { name: "docProps/core.xml", data: buildDocxCoreProperties(title) }
  ]);
}

function sanitizeSessionTitle(title, maxLen = 200) {
  const s = String(title ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const n = Math.max(1, Number(maxLen) || 200);
  return s.length > n ? s.slice(0, n) : s;
}

const FORBIDDEN_JSON_KEY_RE =
  /^(apiKey|api_key|authorization|password|token|secret|credential|path|wavPath|sidecarPath|sessionDir|sourcePath|absolutePath)$/i;
const PATH_LIKE_RE = /([A-Za-z]:\\|\\\\|\/(?:Users|home|tmp|var|opt)\/)/i;

function pickItemMs(item, { preferSource = false } = {}) {
  let begin;
  let end;
  if (preferSource) {
    begin = item.sourceBeginMs ?? item.sessionBeginMs ?? item.beginMs ?? item.artifactBeginMs ?? null;
    end = item.sourceEndMs ?? item.sessionEndMs ?? item.endMs ?? item.artifactEndMs ?? null;
  } else {
    begin = item.sessionBeginMs ?? item.beginMs ?? item.sourceBeginMs ?? item.artifactBeginMs ?? null;
    end = item.sessionEndMs ?? item.endMs ?? item.sourceEndMs ?? item.artifactEndMs ?? null;
  }
  const b = begin == null ? null : Number(begin);
  const e = end == null ? null : Number(end);
  return {
    beginMs: Number.isFinite(b) ? b : null,
    endMs: Number.isFinite(e) ? e : null
  };
}

function formatSrtTimestamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function itemText(item) {
  return String(item.text || item.correctedText || "").trim();
}

function speakerLabel(item, speakerMap) {
  return resolveDisplayName(speakerMap, item.speakerId, item.speakerLabel || item.speakerId || "unknown");
}

function normalizeScope(scope) {
  const s = String(scope || "all").toLowerCase();
  if (s === "raw" || s === "corrected" || s === "summary" || s === "all") return s;
  return "all";
}

function appendTranscriptSection(lines, title, transcript, speakerMap, { preferSource = false } = {}) {
  lines.push(`## ${title}`);
  lines.push("");
  const items = Array.isArray(transcript?.items) ? transcript.items : [];
  if (!items.length) {
    lines.push("_（无内容）_");
    lines.push("");
    return;
  }
  for (const it of items) {
    const { beginMs, endMs } = pickItemMs(it, { preferSource });
    const who = speakerLabel(it, speakerMap);
    const t =
      beginMs != null ? `[${formatClock(beginMs)}${endMs != null ? `–${formatClock(endMs)}` : ""}] ` : "";
    lines.push(`**${who}** ${t}`);
    lines.push("");
    lines.push(itemText(it) || "…");
    lines.push("");
  }
}

function appendSummarySection(lines, summary) {
  lines.push("## 结构化总结");
  lines.push("");
  if (!summary || typeof summary !== "object") {
    lines.push("_（无总结）_");
    lines.push("");
    return;
  }
  lines.push("```json");
  lines.push(JSON.stringify(sanitizeExportJson(summary), null, 2));
  lines.push("```");
  lines.push("");
}

function buildMarkdown({ session, transcript, corrected, summary, speakerMap, scope = "all" } = {}) {
  const sc = normalizeScope(scope);
  const title = sanitizeSessionTitle(session?.title || session?.id || "会议");
  const lines = [`# ${title}`, ""];
  if (session?.id) lines.push(`- 会话: ${session.id}`);
  if (session?.source) lines.push(`- 来源: ${session.source}`);
  if (session?.createdAt) lines.push(`- 创建: ${session.createdAt}`);
  lines.push(`- 导出范围: ${sc}`);
  lines.push("");
  if (sc === "all" || sc === "raw") {
    appendTranscriptSection(lines, "原文转写", transcript, speakerMap);
  }
  if (sc === "all" || sc === "corrected") {
    appendTranscriptSection(lines, "校订文本", corrected, speakerMap, { preferSource: true });
  }
  if (sc === "all" || sc === "summary") {
    appendSummarySection(lines, summary);
  }
  return `${lines.join("\n")}\n`;
}

function buildTxt({ transcript, corrected, summary, speakerMap, scope = "all" } = {}) {
  const sc = normalizeScope(scope);
  const parts = [];
  function pushDoc(label, doc, preferSource) {
    parts.push(`【${label}】`);
    const items = Array.isArray(doc?.items) ? doc.items : [];
    if (!items.length) {
      parts.push("（无）");
      return;
    }
    for (const it of items) {
      const who = speakerLabel(it, speakerMap);
      const { beginMs } = pickItemMs(it, { preferSource });
      const t = beginMs != null ? `[${formatClock(beginMs)}] ` : "";
      parts.push(`${who} ${t}${itemText(it)}`);
    }
  }
  if (sc === "all" || sc === "raw") pushDoc("原文转写", transcript, false);
  if (sc === "all" || sc === "corrected") pushDoc("校订文本", corrected, true);
  if (sc === "all" || sc === "summary") {
    parts.push("【结构化总结】");
    parts.push(summary ? JSON.stringify(sanitizeExportJson(summary), null, 2) : "（无）");
  }
  return `${parts.join("\n\n")}\n`;
}

function buildSrt({ transcript, corrected, speakerMap, scope = "all" } = {}) {
  const sc = normalizeScope(scope);
  let doc = transcript;
  let preferSource = false;
  let used = "raw";
  if (sc === "corrected") {
    doc = corrected;
    preferSource = true;
    used = "corrected";
  } else if (sc === "all") {
    if (corrected?.items?.length) {
      doc = corrected;
      preferSource = true;
      used = "corrected";
    } else {
      doc = transcript;
      used = "raw";
    }
  } else if (sc === "summary") {
    return {
      ok: false,
      code: "srt_scope_unsupported",
      skipped: 0,
      total: 0,
      content: null,
      used: null
    };
  } else {
    doc = transcript;
    used = "raw";
  }
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const cues = [];
  let skipped = 0;
  for (const it of items) {
    const { beginMs, endMs } = pickItemMs(it, { preferSource });
    const text = itemText(it);
    if (beginMs == null || endMs == null || endMs <= beginMs || !text) {
      skipped += 1;
      continue;
    }
    const who = speakerLabel(it, speakerMap);
    cues.push({ beginMs, endMs, text: `${who}: ${text}` });
  }
  if (!cues.length) {
    return {
      ok: false,
      code: "srt_no_timestamps",
      skipped,
      total: items.length,
      content: null,
      used
    };
  }
  const body = cues
    .map((c, i) => `${i + 1}\n${formatSrtTimestamp(c.beginMs)} --> ${formatSrtTimestamp(c.endMs)}\n${c.text}\n`)
    .join("\n");
  return { ok: true, skipped, total: items.length, content: body, used };
}

function sanitizeExportJson(value, depth = 0) {
  if (depth > 12) return null;
  if (value == null) return value;
  if (typeof value === "string") {
    if (PATH_LIKE_RE.test(value) && value.length > 8) return "[redacted-path]";
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeExportJson(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_JSON_KEY_RE.test(k)) continue;
      if (/path|Dir|credential|apiKey|secret/i.test(k) && typeof v === "string") continue;
      out[k] = sanitizeExportJson(v, depth + 1);
    }
    return out;
  }
  return null;
}

function buildJsonBundle({ session, transcript, summary, corrected, speakerMap, meta, scope = "all" }) {
  const sc = normalizeScope(scope);
  const bundle = {
    schema: "meeting_export_json_v1",
    exportedKind: "bundle",
    scope: sc,
    session: {
      id: session?.id || null,
      title: sanitizeSessionTitle(session?.title || ""),
      source: session?.source || null,
      status: session?.status || null,
      createdAt: session?.createdAt || null,
      updatedAt: session?.updatedAt || null
    },
    speakerMap: {
      schema: speakerMap?.schema || "meeting_speaker_map_v1",
      speakers: speakerMap?.speakers || {}
    },
    transcript: null,
    corrected: null,
    summary: null,
    meta: meta || null
  };
  if (sc === "all" || sc === "raw") {
    bundle.transcript = transcript
      ? {
          schema: transcript.schema || null,
          sessionId: transcript.sessionId || session?.id || null,
          items: (transcript.items || []).map((it) => {
            const { beginMs, endMs } = pickItemMs(it);
            return {
              id: it.id,
              speakerId: it.speakerId,
              speakerDisplayName: speakerLabel(it, speakerMap),
              beginMs,
              endMs,
              text: it.text || it.correctedText || ""
            };
          })
        }
      : null;
  }
  if (sc === "all" || sc === "corrected") {
    bundle.corrected = corrected
      ? {
          schema: corrected.schema || null,
          items: (corrected.items || []).map((it) => {
            const { beginMs, endMs } = pickItemMs(it, { preferSource: true });
            return {
              id: it.id,
              speakerId: it.speakerId,
              speakerDisplayName: speakerLabel(it, speakerMap),
              beginMs,
              endMs,
              text: it.text || it.correctedText || ""
            };
          })
        }
      : null;
  }
  if (sc === "all" || sc === "summary") {
    bundle.summary = summary || null;
  }
  return sanitizeExportJson(bundle);
}

async function writeExportFiles({
  outPath,
  format,
  scope = "all",
  session,
  transcript,
  summary,
  corrected,
  speakerMap
}) {
  const fmt = String(format || "markdown").toLowerCase();
  const sc = normalizeScope(scope);
  const report = {
    schema: "meeting_export_report_v1",
    format: fmt,
    scope: sc,
    ok: true,
    files: [],
    warnings: [],
    skippedSrt: false
  };

  if (fmt === "markdown" || fmt === "md") {
    const content = buildMarkdown({ session, transcript, corrected, summary, speakerMap, scope: sc });
    await fsp.writeFile(outPath, content, "utf8");
    report.files.push(path.basename(outPath));
    return report;
  }
  if (fmt === "txt" || fmt === "text") {
    const content = buildTxt({ transcript, corrected, summary, speakerMap, scope: sc });
    await fsp.writeFile(outPath, content, "utf8");
    report.files.push(path.basename(outPath));
    return report;
  }
  if (fmt === "docx" || fmt === "word") {
    const title = sanitizeSessionTitle(session?.title || session?.id || "语音转写");
    const content = buildTxt({ transcript, corrected, summary, speakerMap, scope: sc });
    await fsp.writeFile(outPath, buildDocx({ title, text: content }));
    report.files.push(path.basename(outPath));
    return report;
  }
  if (fmt === "json") {
    const bundle = buildJsonBundle({ session, transcript, summary, corrected, speakerMap, scope: sc });
    await fsp.writeFile(outPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    report.files.push(path.basename(outPath));
    return report;
  }
  if (fmt === "srt") {
    const srt = buildSrt({ transcript, corrected, speakerMap, scope: sc });
    if (!srt.ok) {
      report.ok = false;
      report.skippedSrt = true;
      report.warnings.push({
        code: srt.code,
        message:
          srt.code === "srt_scope_unsupported"
            ? "SRT 不支持仅导出总结"
            : "SRT skipped: no usable timestamps.",
        skipped: srt.skipped,
        total: srt.total,
        used: srt.used
      });
      const reportPath = outPath.endsWith(".srt")
        ? outPath.replace(/\.srt$/i, ".export-report.json")
        : `${outPath}.export-report.json`;
      await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      report.files.push(path.basename(reportPath));
      return report;
    }
    await fsp.writeFile(outPath, srt.content, "utf8");
    report.files.push(path.basename(outPath));
    report.used = srt.used;
    if (srt.skipped > 0) {
      report.warnings.push({
        code: "srt_partial_skip",
        skipped: srt.skipped,
        total: srt.total,
        used: srt.used
      });
    }
    return report;
  }
  const error = new Error(`unsupported export format: ${fmt}`);
  error.code = "export_format_unsupported";
  throw error;
}

module.exports = {
  pickItemMs,
  formatSrtTimestamp,
  buildMarkdown,
  buildTxt,
  buildDocx,
  buildSrt,
  buildJsonBundle,
  sanitizeExportJson,
  writeExportFiles,
  normalizeScope
};
