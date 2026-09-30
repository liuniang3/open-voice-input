"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require(process.env.SHARP_MODULE_PATH || "sharp");
const root = path.resolve(__dirname, "..");

async function main() {
  const svg = await fs.readFile(path.join(root, "assets/mimo-icon.svg"));
  await sharp(svg).resize(1024, 1024).png().toFile(path.join(root, "assets/mimo-icon.png"));
  await sharp(svg).resize(32, 32).png().toFile(path.join(root, "assets/mimo-tray.png"));
  const template = await fs.readFile(path.join(root, "assets/tray-template.svg"));
  for (const [name, size] of [["mimo-trayTemplate.png", 18], ["mimo-trayTemplate@2x.png", 36]]) {
    await sharp(template).resize(size, size).png().toFile(path.join(root, "assets", name));
  }
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const size of sizes) frames.push(await sharp(svg).resize(size, size).png().toBuffer());
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  for (let index = 0; index < frames.length; index++) {
    const at = 6 + index * 16;
    header[at] = sizes[index] === 256 ? 0 : sizes[index]; header[at + 1] = header[at];
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(frames[index].length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += frames[index].length;
  }
  await fs.writeFile(path.join(root, "assets/mimo-icon.ico"), Buffer.concat([header, ...frames]));
  await fs.copyFile(path.join(root, "assets/mimo-icon.svg"), path.join(root, "src/renderer/brand/app.svg"));
  console.log("App, feature and platform tray icons rendered.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
