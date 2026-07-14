const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const distDir = path.resolve(__dirname, "..", "dist");
const executables = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).filter((file) => file.toLowerCase().endsWith(".exe")).sort()
  : [];

if (!executables.length) {
  console.error("No .exe artifacts were found in dist/.");
  process.exit(1);
}

const lines = executables.map((file) => {
  const contents = fs.readFileSync(path.join(distDir, file));
  const hash = crypto.createHash("sha256").update(contents).digest("hex");
  return `${hash}  ${file}`;
});

const outputPath = path.join(distDir, "SHA256SUMS.txt");
fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "ascii");
console.log(`Wrote ${path.relative(process.cwd(), outputPath)} for ${executables.length} artifact(s).`);
