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

for (const id of ["updateCurrentVersion", "updateStateBadge", "updateStatusTitle", "updateStatusDetail",
  "updateProgress", "updateCheckBtn", "updateDownloadBtn", "updateInstallBtn", "updateAutoCheckInput"]) {
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

assert.equal(pkg.dependencies["electron-updater"], "6.8.9");
assert.deepEqual(pkg.build.publish, { provider: "github", owner: "liuniang3", repo: "open-voice-input" });
for (const artifactName of [pkg.build.nsis.artifactName, pkg.build.portable.artifactName, pkg.build.mac.artifactName]) {
  assert.match(artifactName, /^Open-Voice-Input-/, "update assets must keep a GitHub-safe name without spaces");
  assert.doesNotMatch(artifactName, /\$\{productName\}|\s/, "update metadata and uploaded asset names must match");
}
assert.match(updater, /owner:\s*"liuniang3"/);
assert.match(updater, /repo:\s*"open-voice-input"/);
assert.doesNotMatch(updater, /shell|openExternal/, "update service must not send users to a browser");

for (const asset of ["dist/latest.yml", "dist/*.exe.blockmap", "dist/latest-*-mac.yml", "dist/*.zip.blockmap"]) {
  assert.ok(workflow.includes(asset), `release workflow must publish ${asset}`);
}
assert.match(workflow, /mv dist\/latest-mac\.yml dist\/latest-\$\{\{ matrix\.arch \}\}-mac\.yml/);

console.log("Updater UI/release contract tests passed");
