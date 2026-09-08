"use strict";

/**
 * Cross-shell Windows builder for native/audio-capture-helper.
 * Finds cargo (PATH or %USERPROFILE%\.cargo\bin) and MSVC via VsDevCmd,
 * then runs: cargo build --release --manifest-path ...
 *
 * Does not install toolchains. Fails clearly if cargo or MSVC is missing.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "native", "audio-capture-helper", "Cargo.toml");
const RELEASE_EXE = path.join(
  ROOT,
  "native",
  "audio-capture-helper",
  "target",
  "release",
  "audio-capture-helper.exe"
);

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findCargo() {
  const fromPath = spawnSync("where.exe", ["cargo"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (fromPath.status === 0) {
    const first = String(fromPath.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first && existsFile(first)) return first;
  }
  const homeCargo = path.join(process.env.USERPROFILE || "", ".cargo", "bin", "cargo.exe");
  if (existsFile(homeCargo)) return homeCargo;
  return null;
}

function findVsDevCmd() {
  const vswhereCandidates = [
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "Installer",
      "vswhere.exe"
    ),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft Visual Studio", "Installer", "vswhere.exe")
  ];
  for (const vswhere of vswhereCandidates) {
    if (!existsFile(vswhere)) continue;
    try {
      const out = execFileSync(
        vswhere,
        [
          "-latest",
          "-products",
          "*",
          "-requires",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
          "-find",
          "Common7\\Tools\\VsDevCmd.bat"
        ],
        { encoding: "utf8", windowsHide: true }
      );
      const line = String(out || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (line && existsFile(line)) return line;
    } catch {
      // try next
    }
  }

  const hardcoded = [
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "2022",
      "BuildTools",
      "Common7",
      "Tools",
      "VsDevCmd.bat"
    ),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "2022",
      "Community",
      "Common7",
      "Tools",
      "VsDevCmd.bat"
    ),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "2022",
      "Professional",
      "Common7",
      "Tools",
      "VsDevCmd.bat"
    ),
    path.join(
      process.env.ProgramFiles || "C:\\Program Files",
      "Microsoft Visual Studio",
      "2022",
      "BuildTools",
      "Common7",
      "Tools",
      "VsDevCmd.bat"
    )
  ];
  for (const p of hardcoded) {
    if (existsFile(p)) return p;
  }
  return null;
}

function fail(messageEn, messageZh) {
  console.error(messageEn);
  if (messageZh) console.error(messageZh);
  process.exit(1);
}

function main() {
  if (process.platform !== "win32") {
    fail(
      "audio-capture-helper build is Windows-only (WASAPI).",
      "audio-capture-helper 仅支持在 Windows 上构建（WASAPI）。"
    );
  }
  if (!existsFile(MANIFEST)) {
    fail(`Cargo.toml not found: ${MANIFEST}`, `未找到 Cargo.toml：${MANIFEST}`);
  }

  const cargo = findCargo();
  if (!cargo) {
    fail(
      "cargo not found. Install Rust (rustup) and ensure cargo is on PATH or at %USERPROFILE%\\.cargo\\bin\\cargo.exe.",
      "未找到 cargo。请安装 Rust（rustup），并确保 cargo 在 PATH 中，或位于 %USERPROFILE%\\.cargo\\bin\\cargo.exe。"
    );
  }

  const vsDevCmd = findVsDevCmd();
  if (!vsDevCmd) {
    fail(
      "MSVC / VsDevCmd.bat not found. Install Visual Studio 2022 Build Tools with C++ workload (VC tools x64).",
      "未找到 MSVC / VsDevCmd.bat。请安装 Visual Studio 2022 Build Tools 并勾选 C++ 桌面开发（x64 工具链）。"
    );
  }

  const cargoBinDir = path.dirname(cargo);
  // Prefer relative manifest path so cmd.exe does not mangle non-ASCII repo paths.
  const relativeManifest = path.relative(ROOT, MANIFEST).split(path.sep).join("\\");
  // Pin toolchain explicitly: some machines have a broken default "stable" install.
  // rust-toolchain.toml also pins 1.85.1; +channel makes the requirement obvious.
  const toolchain = "1.85.1";
  const probe = spawnSync(cargo, [`+${toolchain}`, "-V"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (probe.status !== 0) {
    fail(
      `Rust toolchain ${toolchain} is not available via cargo +${toolchain}. Install with: rustup toolchain install ${toolchain}`,
      `未找到 Rust 工具链 ${toolchain}。请执行：rustup toolchain install ${toolchain}`
    );
  }

  // Write a short .cmd so paths with spaces (Program Files (x86)) are reliable.
  const tmpDir = require("node:os").tmpdir();
  const batPath = path.join(tmpDir, `ovi-build-helper-${process.pid}.cmd`);
  const batBody = [
    "@echo off",
    "setlocal",
    `call "${vsDevCmd}" -arch=x64`,
    "if errorlevel 1 exit /b 1",
    `set "PATH=${cargoBinDir};%PATH%"`,
    // Explicit +1.85.1 avoids a broken default stable toolchain on some hosts.
    `cargo +${toolchain} build --release --locked --manifest-path "${relativeManifest}"`,
    "exit /b %ERRORLEVEL%"
  ].join("\r\n");
  fs.writeFileSync(batPath, batBody, "utf8");

  console.log(`Using cargo: ${cargo}`);
  console.log(`Using toolchain: ${toolchain}`);
  console.log(`Using VsDevCmd: ${vsDevCmd}`);
  console.log(`Manifest: ${relativeManifest}`);
  console.log("Building audio-capture-helper (release)...");

  let result;
  try {
    result = spawnSync("cmd.exe", ["/d", "/c", batPath], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${cargoBinDir};${process.env.PATH || ""}`
      },
      stdio: "inherit",
      windowsHide: true
    });
  } finally {
    try {
      fs.unlinkSync(batPath);
    } catch {
      // ignore temp cleanup failure
    }
  }

  if (result.error) {
    fail(result.error.message || String(result.error));
  }
  if (result.status !== 0) {
    fail(
      `cargo build --release failed with exit code ${result.status}`,
      `cargo build --release 失败，退出码 ${result.status}`
    );
  }

  if (!existsFile(RELEASE_EXE)) {
    fail(
      `Build finished but EXE missing: ${RELEASE_EXE}`,
      `构建结束但未找到 EXE：${RELEASE_EXE}`
    );
  }

  console.log(`audio-capture-helper release ready: ${RELEASE_EXE}`);
  process.exit(0);
}

main();
