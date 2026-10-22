"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const yaml = require("js-yaml");
const { createClient } = require("electron-updater/out/providerFactory");
const { createUpdateService } = require("../src/updater");
const { MACOS_UPDATE_FEED } = require("../src/platform/macos-updates");
const { checkTag, prepareMacUpdateFeed } = require("./prepare-macos-update-feed");

const repository = "https://github.com/liuniang3/open-voice-input/releases";
const feed = `${repository}/download/macos-updates/`;

function updaterFor(platform, arch) {
  const updater = new EventEmitter();
  updater.setFeedURL = config => { updater.feed = config; };
  createUpdateService({ autoUpdater: updater, currentVersion: "0.4.25", isPackaged: true, platform, arch });
  updater.currentVersion = require("semver").parse("0.4.25");
  return updater;
}

async function test(name, fn) {
  await fn();
  console.log(`ok - ${name}`);
}

function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-mac-feed-"));
  const options = { directory, outputDirectory: path.join(directory, "feed"), tag: "macos-v0.4.26",
    version: "0.4.26", notes: "# Mac 版（macOS）v0.4.26\n\n修复会议暂停预览。\n" };
  try {
    for (const arch of ["x64", "arm64"]) {
      const files = ["zip", "dmg"].map(ext => {
        const name = `Open-Voice-Input-macOS-0.4.26-${arch}.${ext}`;
        const bytes = Buffer.from(`synthetic ${arch} ${ext}`);
        fs.writeFileSync(path.join(directory, name), bytes);
        if (ext === "zip") fs.writeFileSync(path.join(directory, `${name}.blockmap`), "synthetic blockmap");
        return { url: name, sha512: crypto.createHash("sha512").update(bytes).digest("base64"), size: bytes.length };
      });
      fs.writeFileSync(path.join(directory, `latest-${arch}-mac.yml`), yaml.dump({ version: options.version, files,
        path: files[0].url, sha512: files[0].sha512 }));
      fs.writeFileSync(path.join(directory, `macOS-${arch}-SHA256SUMS.txt`), files.map(file => {
        const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, file.url))).digest("hex");
        return `${hash}  ${file.url}\n`;
      }).join(""));
    }
    return run(options);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

(async () => {
  await test("only Mac packaging overrides the existing repository update source", () => {
    const config = require("../package.json").build;
    assert.deepEqual(config.mac.publish, MACOS_UPDATE_FEED);
    assert.deepEqual(config.publish, { provider: "github", owner: "liuniang3", repo: "open-voice-input" });
  });

  for (const arch of ["arm64", "x64"]) {
    await test(`macOS ${arch} ignores a newer Windows release and resolves its own package and notes`, async () => {
      const updater = updaterFor("darwin", arch);
      const urls = [];
      const file = `Open-Voice-Input-macOS-0.4.26-${arch}.zip`;
      const download = `${repository}/download/macos-v0.4.26/${file}`;
      const metadata = JSON.stringify({ version: "0.4.26", releaseName: "Mac 版（macOS）v0.4.26",
        releaseNotes: "恢复会议预览", files: [{ url: download, sha512: "synthetic-checksum" }] });
      const provider = createClient(updater.feed, updater, { platform: "darwin", executor: {
        request: async options => {
          const url = `https://${options.hostname}${options.path}`;
          urls.push(url);
          assert.equal(url, `${feed}latest-${arch}-mac.yml`, "Mac must never consult global latest or Windows metadata");
          return metadata;
        }
      } });
      const info = await provider.getLatestVersion();
      assert.equal(info.version, "0.4.26");
      assert.equal(info.releaseNotes, "恢复会议预览");
      assert.equal(provider.resolveFiles(info)[0].url.href, download);
      assert.equal(urls.length, 1);
      assert.equal(updater.allowDowngrade, false);
      assert.equal(updater.allowPrerelease, false);
    });
  }

  await test("the unchanged Windows provider ignores newer Mac-only releases", async () => {
    const updater = updaterFor("win32", "x64");
    const atom = `<feed>${["macos-v0.4.99", "macos-updates", "v0.4.26"].map(tag =>
      `<entry><title>${tag}</title><link href="${repository}/tag/${tag}"/><content>${tag} notes</content></entry>`).join("")}</feed>`;
    const provider = createClient(updater.feed, updater, { platform: "win32", executor: {
      request: async options => {
        const url = `https://${options.hostname}${options.path}`;
        if (url === `${repository}.atom`) return atom;
        if (url === `${repository}/latest`) return JSON.stringify({ tag_name: "v0.4.26" });
        assert.equal(url, `${repository}/download/v0.4.26/latest.yml`);
        return JSON.stringify({ version: "0.4.26", files: [{ url: "Open-Voice-Input-Setup-0.4.26-x64.exe", sha512: "synthetic-checksum" }] });
      }
    } });
    const info = await provider.getLatestVersion();
    assert.equal(info.version, "0.4.26");
    assert.equal(info.releaseName, "v0.4.26");
    assert.equal(info.releaseNotes, "v0.4.26 notes");
    assert.equal(provider.resolveFiles(info)[0].url.href, `${repository}/download/v0.4.26/Open-Voice-Input-Setup-0.4.26-x64.exe`);
  });

  await test("Mac feed generation preserves verified packages and embeds the Mac improvement notes", () => fixture(options => {
    const channels = prepareMacUpdateFeed(options);
    assert.equal(channels.length, 2);
    for (const arch of ["x64", "arm64"]) {
      const info = yaml.load(fs.readFileSync(path.join(options.outputDirectory, `latest-${arch}-mac.yml`), "utf8"));
      assert.equal(info.releaseNotes, options.notes);
      assert.equal(info.releaseName, "Open Voice Input Mac 版（macOS）v0.4.26");
      assert.equal(info.version, "0.4.26");
      for (const file of info.files) {
        assert.equal(file.url, `${repository}/download/macos-v0.4.26/Open-Voice-Input-macOS-0.4.26-${arch}.${file.url.endsWith(".zip") ? "zip" : "dmg"}`);
        assert.equal(file.sha512, crypto.createHash("sha512").update(fs.readFileSync(path.join(options.directory,
          new URL(file.url).pathname.split("/").pop()))).digest("base64"));
      }
      assert.equal(info.path, info.files[0].url);
      assert.equal(info.sha512, info.files[0].sha512);
    }
  }));

  await test("Mac release tags cannot trigger the existing v* release flow", () => {
    checkTag("macos-v0.4.26", "0.4.26");
    for (const tag of ["v0.4.26", "macos-v0.4.27", "macos-v0.4.26-beta.1"]) {
      assert.throws(() => checkTag(tag, "0.4.26"));
    }
    const workflow = yaml.load(fs.readFileSync(path.join(__dirname, "../.github/workflows/release-macos.yml"), "utf8"));
    assert.deepEqual(workflow.on.push.tags, ["macos-v*"]);
    assert.equal(workflow.jobs["build-macos"].strategy.matrix.include.every(item => item.runner.startsWith("macos-")), true);
  });

  for (const [name, mutate] of [
    ["incorrect architecture", info => { info.files[0].url = info.files[0].url.replace("arm64", "x64"); }],
    ["Windows package", info => { info.files[0].url = "Open-Voice-Input-Setup-0.4.26-x64.exe"; }],
    ["wrong version", info => { info.version = "0.4.99"; }],
    ["incorrect checksum", info => { info.files[0].sha512 = "invalid"; }],
    ["missing ZIP", info => { info.files = info.files.slice(1); }]
  ]) {
    await test(`Mac feed rejects ${name} before writing either architecture`, () => fixture(options => {
      const file = path.join(options.directory, "latest-arm64-mac.yml");
      const info = yaml.load(fs.readFileSync(file, "utf8"));
      mutate(info);
      fs.writeFileSync(file, yaml.dump(info));
      assert.throws(() => prepareMacUpdateFeed(options));
      assert.equal(fs.existsSync(options.outputDirectory), false);
    }));
  }

  await test("Mac package corruption and non-Mac release notes cannot advance the feed", () => fixture(options => {
    assert.throws(() => prepareMacUpdateFeed({ ...options, notes: "Windows release" }));
    fs.appendFileSync(path.join(options.directory, "Open-Voice-Input-macOS-0.4.26-arm64.zip"), "corrupted");
    assert.throws(() => prepareMacUpdateFeed(options), /SHA-256 mismatch/);
    assert.equal(fs.existsSync(options.outputDirectory), false);
  }));

  await test("a delayed or repeated Mac release cannot roll the feed backward or replace the same version", () => fixture(options => {
    const previousDirectory = path.join(options.directory, "previous");
    fs.mkdirSync(previousDirectory);
    for (const version of ["0.4.26", "0.4.27"]) {
      fs.writeFileSync(path.join(previousDirectory, "latest-x64-mac.yml"), yaml.dump({ version }));
      assert.throws(() => prepareMacUpdateFeed({ ...options, previousDirectory }), /must advance/);
    }
    for (const arch of ["x64", "arm64"]) {
      fs.writeFileSync(path.join(previousDirectory, `latest-${arch}-mac.yml`), yaml.dump({ version: "0.4.25" }));
    }
    assert.equal(prepareMacUpdateFeed({ ...options, previousDirectory }).length, 2);
  }));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
