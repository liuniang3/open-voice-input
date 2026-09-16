const { spawnSync } = require("node:child_process");

if (!process.env.CI) {
  process.env.ELECTRON_MIRROR ||= "https://npmmirror.com/mirrors/electron/";
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= "https://npmmirror.com/mirrors/electron-builder-binaries/";
}

const cliPath = require.resolve("electron-builder/cli.js");
const args = process.argv.slice(2);
// Release workflows upload audited artifacts explicitly after every build/check succeeds.
if (!args.some(arg => arg === "--publish" || arg.startsWith("--publish="))) args.push("--publish", "never");
const result = spawnSync(process.execPath, [cliPath, ...args], {
  env: process.env,
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error.message || String(result.error));
  process.exit(1);
}

process.exit(result.status ?? 1);
