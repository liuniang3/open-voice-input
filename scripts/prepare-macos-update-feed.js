"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yaml = require("js-yaml");
const semver = require("semver");

function checkTag(tag, version) {
  if (!semver.valid(version) || semver.prerelease(version) || tag !== `macos-v${version}`) {
    throw new Error("Mac release tag must be macos-v followed by the stable package.json version");
  }
}

function prepareMacUpdateFeed({ directory, outputDirectory, tag, version, notes, previousDirectory }) {
  checkTag(tag, version);
  if (typeof notes !== "string" || !notes.includes("Mac 版（macOS）")) {
    throw new Error("Mac release notes must identify Mac 版（macOS） and describe the improvements");
  }
  const base = `https://github.com/liuniang3/open-voice-input/releases/download/${tag}/`;
  const pending = [];
  for (const arch of ["x64", "arm64"]) {
    const channel = `latest-${arch}-mac.yml`;
    const info = yaml.load(fs.readFileSync(path.join(directory, channel), "utf8"));
    if (info?.version !== version || !Array.isArray(info.files) || info.packages) {
      throw new Error(`Invalid Mac update metadata for ${arch}`);
    }
    const names = ["zip", "dmg"].map(ext => `Open-Voice-Input-macOS-${version}-${arch}.${ext}`);
    const verified = new Map();
    const checksumText = fs.readFileSync(path.join(directory, `macOS-${arch}-SHA256SUMS.txt`), "utf8");
    for (const name of names) {
      const bytes = fs.readFileSync(path.join(directory, name));
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (!checksumText.split(/\r?\n/).includes(`${sha256}  ${name}`)) {
        throw new Error(`Mac package SHA-256 mismatch: ${name}`);
      }
      verified.set(name, { sha512: crypto.createHash("sha512").update(bytes).digest("base64"), size: bytes.length });
    }
    fs.accessSync(path.join(directory, `${names[0]}.blockmap`));
    const seen = new Set();
    const files = info.files.map(file => {
      const expected = verified.get(file.url);
      if (!expected || seen.has(file.url) || file.sha512 !== expected.sha512 || file.size !== expected.size) {
        throw new Error(`Mac update file, architecture or checksum mismatch for ${arch}`);
      }
      seen.add(file.url);
      return { ...file, url: base + file.url };
    });
    if (!seen.has(names[0])) throw new Error(`Mac ZIP is required for ${arch} updates`);
    const result = { ...info, files, path: base + names[0], sha512: verified.get(names[0]).sha512,
      releaseName: `Open Voice Input Mac 版（macOS）v${version}`, releaseNotes: notes };
    if (previousDirectory) {
      const previous = yaml.load(fs.readFileSync(path.join(previousDirectory, channel), "utf8"));
      if (!semver.valid(previous?.version) || !semver.gt(version, previous.version)) {
        throw new Error(`Mac feed must advance beyond the published ${arch} version`);
      }
    }
    pending.push([channel, yaml.dump(result, { lineWidth: -1 })]);
  }
  // Validate both architectures before writing either channel.
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [name, contents] of pending) fs.writeFileSync(path.join(outputDirectory, name), contents);
  return pending.map(([name]) => name);
}

if (require.main === module) {
  try {
    const version = require("../package.json").version;
    const tag = process.env.GITHUB_REF_NAME || "";
    checkTag(tag, version);
    if (!process.argv.includes("--check-tag")) {
      const files = prepareMacUpdateFeed({ directory: "macos-artifacts", outputDirectory: "macos-feed", tag, version,
        notes: fs.readFileSync(`docs/releases/macOS-v${version}.md`, "utf8"),
        previousDirectory: fs.existsSync("macos-previous") ? "macos-previous" : undefined });
      console.log(`Verified Mac packages and prepared ${files.length} architecture channels.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkTag, prepareMacUpdateFeed };
