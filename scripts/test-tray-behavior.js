"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const start = source.indexOf("function createTray()");
const end = source.indexOf("function configureApplicationMenu()", start);
assert(start >= 0 && end > start, "createTray implementation must exist");

const createTraySource = source.slice(start, end);
assert.match(createTraySource, /tray\.on\("double-click",\s*showSettings\)/,
  "double-clicking the tray icon must open the default settings view");
assert.doesNotMatch(createTraySource, /tray\.on\("click",\s*showWindowOnly\)/,
  "a tray click must not flash the compact ready window before settings opens");

console.log("Tray double-click settings behavior checks passed.");
