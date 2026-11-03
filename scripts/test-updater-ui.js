"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const html = read("src/renderer/index.html");
const renderer = read("src/renderer/renderer.js");
const preload = read("src/preload.js");
const main = read("src/main.js");
const updater = read("src/updater.js");
const workflow = read(".github/workflows/release.yml");
const pkg = JSON.parse(read("package.json"));
const yaml = require("js-yaml");
const windowsRelease = yaml.load(read(".github/workflows/release-windows.yml"));
const legacyRelease = yaml.load(workflow);

assert.equal(legacyRelease.on.push, undefined, "Windows tags must not trigger legacy macOS publishing");
assert.deepEqual(windowsRelease.on.push.tags, ["v*"]);
assert.deepEqual(Object.keys(windowsRelease.jobs).sort(), ["build-windows", "publish-release"]);
assert.equal(windowsRelease.jobs["build-windows"]["runs-on"], "windows-latest");
assert.equal(windowsRelease.jobs["publish-release"].needs, "build-windows");
const releaseUpload = windowsRelease.jobs["build-windows"].steps.find(step => step.uses?.startsWith("softprops/action-gh-release@"));
assert.equal(releaseUpload.with.draft, true, "release stays a draft until all artifacts exist");
for (const asset of ["dist/*.exe", "dist/*.exe.blockmap", "dist/latest.yml", "dist/SHA256SUMS.txt"]) {
  assert.ok(releaseUpload.with.files.includes(asset), `Windows release must publish ${asset}`);
}
assert.doesNotMatch(releaseUpload.with.files, /mac|\.dmg|\.zip/);
const lock = JSON.parse(read("package-lock.json"));
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].version, pkg.version);

for (const id of ["updateCurrentVersion", "updateStateBadge", "updateStatusTitle", "updateStatusDetail",
  "updateProgress", "updateCheckBtn", "updateDownloadBtn", "updateInstallBtn", "updateAutoCheckInput",
  "updateReleaseNotesBlock", "updateReleaseNotesText"]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing updater control ${id}`);
}
assert.match(html, /data-settings-tab="updates"/);
assert.match(html, /data-settings-panel="updates"/);

for (const method of ["getUpdateStatus", "checkForUpdates", "downloadUpdate", "installUpdate", "onUpdateStatus"]) {
  assert.match(preload, new RegExp(`\\b${method}\\b`), `preload must expose ${method}`);
  assert.match(renderer, new RegExp(`\\b${method}\\b`), `renderer must use ${method}`);
}
assert.doesNotMatch(preload, /openExternal|shell\./, "renderer bridge must not expose arbitrary external navigation");
assert.match(main, /updateAutoCheck:\s*true/);
assert.match(main, /setInterval\(check,\s*6\s*\*\s*60\s*\*\s*60\s*\*\s*1000\)/);
assert.match(main, /captureOwner[\s\S]*livePostprocessBusy/, "install must be gated by active capture and processing");
assert.match(main, /macReleaseCanAutoInstall\(\)/, "macOS updates must detect Developer ID signing");
assert.match(main, /openDownloadedFile:[\s\S]*shell\.openPath/, "unsigned macOS updates must open the local package");
assert.match(renderer, /installMode\s*===\s*["']manual["']/, "updater UI must explain manual macOS installation");

assert.equal(pkg.dependencies["electron-updater"], "6.8.9");
assert.deepEqual(pkg.build.publish, { provider: "github", owner: "liuniang3", repo: "open-voice-input" });
for (const artifactName of [pkg.build.nsis.artifactName, pkg.build.portable.artifactName, pkg.build.mac.artifactName]) {
  assert.match(artifactName, /^Open-Voice-Input-/, "update assets must keep a GitHub-safe name without spaces");
  assert.doesNotMatch(artifactName, /\$\{productName\}|\s/, "update metadata and uploaded asset names must match");
}
assert.match(updater, /owner:\s*"liuniang3"/);
assert.match(updater, /repo:\s*"open-voice-input"/);
assert.doesNotMatch(updater, /shell|openExternal/, "update service must not send users to a browser");
assert.doesNotMatch(updater, /github\.com\//, "manual installation must use the verified local package");

for (const asset of ["dist/latest.yml", "dist/*.exe.blockmap", "dist/latest-*-mac.yml", "dist/*.zip.blockmap"]) {
  assert.ok(workflow.includes(asset), `release workflow must publish ${asset}`);
}
assert.match(workflow, /mv dist\/latest-mac\.yml dist\/latest-\$\{\{ matrix\.arch \}\}-mac\.yml/);

console.log("Updater UI/release contract tests passed");
