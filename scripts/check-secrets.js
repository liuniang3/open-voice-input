const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EXCLUDED_DIRS = new Set([".git", "dist", "node_modules", "out", "recordings", "tmp"]);
const TEXT_EXTENSIONS = new Set([
  "",
  ".cmd",
  ".css",
  ".env",
  ".example",
  ".html",
  ".js",
  ".json",
  ".md",
  ".ps1",
  ".py",
  ".rs",
  ".toml",
  ".txt",
  ".vbs",
  ".yaml",
  ".yml"
]);
const SECRET_PATTERNS = [
  { name: "API key", pattern: /\b(?:sk|tp)-[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub token", pattern: /\bgh[ps]_[A-Za-z0-9]{30,}\b/g },
  // Aliyun AccessKeyId prefix (real keys look like LTAI5t…); allow short doc placeholders
  { name: "Aliyun AccessKeyId", pattern: /\bLTAI[A-Za-z0-9]{16,}\b/g }
];

const findings = [];
walk(ROOT);

if (findings.length) {
  console.error("Potential secrets detected. Build stopped:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.kind}`);
  }
  process.exit(1);
}

console.log("Secret scan passed: no real-looking API keys found in package inputs.");

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath);
      continue;
    }
    if (!entry.isFile() || !isTextFile(entry.name)) continue;
    inspectFile(absolutePath);
  }
}

function isTextFile(fileName) {
  if (fileName === ".env.example" || fileName === ".gitattributes" || fileName === ".gitignore") return true;
  return TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function inspectFile(absolutePath) {
  const content = fs.readFileSync(absolutePath, "utf8");
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      findings.push({
        file: path.relative(ROOT, absolutePath),
        kind: name
      });
    }
  }
}
