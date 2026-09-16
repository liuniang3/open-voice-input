"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const files = fs.readdirSync(__dirname)
  .filter(name => /^test-.*\.js$/.test(name) && fs.statSync(path.join(__dirname, name)).isFile())
  .sort();
if (!files.length) throw new Error("No scripts/test-*.js regression tests found");
if (process.argv.includes("--list")) {
  for (const file of files) console.log(`scripts/${file}`);
} else {
  const failures = [];
  for (const file of files) {
    console.log(`\nRunning scripts/${file}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
      cwd: root, stdio: "inherit", shell: false, windowsHide: true, timeout: 300000
    });
    if (result.error || result.status !== 0) {
      failures.push(file);
      console.error(`FAILED ${file}: ${result.error?.message || result.signal || `exit ${result.status}`}`);
    }
  }
  console.log(`\nShared regression: ${files.length - failures.length}/${files.length} scripts passed.`);
  if (failures.length) {
    console.error(`Failed scripts: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}
