const { spawnSync } = require("node:child_process");

if (!process.env.CI) {
  process.env.ELECTRON_MIRROR ||= "https://npmmirror.com/mirrors/electron/";
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= "https://npmmirror.com/mirrors/electron-builder-binaries/";
}

const cliPath = require.resolve("electron-builder/cli.js");
const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error.message || String(result.error));
  process.exit(1);
}

process.exit(result.status ?? 1);
