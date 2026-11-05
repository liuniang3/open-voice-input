"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const renderer = path.resolve(__dirname, "../src/renderer");
const html = fs.readFileSync(path.join(renderer, "index.html"), "utf8");
const source = fs.readFileSync(path.join(renderer, "hotwords.js"), "utf8");
const markup = html.match(/<section id="hotwordsPanel"[\s\S]*?<\/section>/)?.[0];

function contracts() {
  assert.ok(markup, "a standalone hotword section exists");
  const asr = html.slice(html.indexOf('id="settingsAsrPanel"'), html.indexOf('id="settingsHotwordsPanel"'));
  const dictionary = html.slice(html.indexOf('id="settingsHotwordsPanel"'), html.indexOf('id="settingsCleanerPanel"'));
  assert.ok(!asr.includes(markup), "hotwords no longer belong to ASR settings");
  assert.ok(dictionary.includes(markup), "hotwords belong to the dictionary tab");
  assert.deepEqual([...html.matchAll(/data-settings-tab="([^"]+)"/g)].map(match => match[1]), ["asr", "hotwords", "cleaner", "history", "updates"]);
  assert.equal((html.match(/src="\.\/hotwords.js"/g) || []).length, 1);
  assert.match(markup, /仅用于短语音输入，不用于会议或文件转写/);
  assert.match(markup, /qwen-audio-3.0-asr-flash-streaming/);
  assert.match(markup, /须手动确认/);
  assert.match(markup, /XLSX 读取全部工作表/);
  assert.match(markup, /搜狗 SGPU BIN/);
  assert.doesNotMatch(markup, /可见工作表/);
  assert.match(markup, /data-hotwords="observe"[^>]*disabled/);
  assert.doesNotMatch(markup.match(/<input data-hotwords="observe"[^>]*>/)[0], /checked/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|localStorage|fetch\(|getSettings|navigator\.|clipboard|console\./);
  const window = { document: { readyState: "loading", addEventListener(name, callback) {
    assert.equal(name, "DOMContentLoaded"); this.init = callback;
  }, getElementById(id) { assert.equal(id, "hotwordsPanel"); return null; } } };
  vm.runInNewContext(source, { window });
  assert.equal(typeof window.HotwordsPanel.create, "function");
  window.document.init();
  console.log("Hotword UI placement, short-dictation scope, privacy and bootstrap contracts passed.");
}

const initial = {
  enabled: true, observeCorrections: false, observationAvailable: true, limit: 100000, requestLimit: 100,
  entries: [{ id: "e1", text: "量子光学", enabled: true }, { id: "e2", text: "冷原子", enabled: false }],
  candidates: [{ id: "c1", from: "量子光雪", to: "量子光学", count: 3 },
    { id: "c2", from: "冷元子", to: "冷原子", count: 1 }]
};

async function fixture(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, "http://hotwords.test", "fixture must not contact external services");
    if (url.pathname === "/") {
      const fixtureHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
        .replace("</body>", '<script src="./hotwords.js"></script></body>');
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: fixtureHtml });
    }
    const file = path.resolve(renderer, `.${decodeURIComponent(url.pathname)}`);
    assert.ok(file.startsWith(renderer + path.sep));
    if (file === path.join(renderer, "hotwords.js")) return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: source });
    if (/\.(css|svg)$/.test(file) && fs.existsSync(file)) return route.fulfill({ path: file });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.addInitScript(({ snapshot, missing, failReads, failSubscribe }) => {
    const clone = value => structuredClone(value);
    const listeners = new Set();
    const state = window.hotwordsTest = {
      snapshot, calls: [], reads: 0, subscriptions: 0, unsubscribes: 0,
      failReads, failSubscribe, failNext: null, holdRead: false, pendingReads: [], holdWrite: false,
      emit(patch = {}) { Object.assign(state.snapshot, clone(patch)); for (const callback of listeners) callback(); }
    };
    if (missing) return;
    window.mimoInput = new Proxy({
      async previewHotwordImport() {
        state.calls.push({ action: "previewImport" });
        if (state.holdWrite) await new Promise(resolve => { state.releaseWrite = resolve; });
        if (state.failPreview) {
          const code = state.failPreview; state.failPreview = null;
          throw new Error(`${code} synthetic-private-preview-error`);
        }
        return clone(state.preview ?? null);
      },
      async commitHotwordImport(payload) {
        state.calls.push(clone(payload));
        if (state.holdWrite) await new Promise(resolve => { state.releaseWrite = resolve; });
        if (state.failNext) {
          const code = state.failNext; state.failNext = null;
          throw new Error(`${code} synthetic-private-commit-error`);
        }
        if (!state.reply) throw new Error("Missing fixture response");
        state.snapshot = clone(state.reply); state.reply = null;
        if (state.emitOnSave) state.emit();
        return clone(state.snapshot);
      },
      async getHotwords() {
        state.reads++;
        if (state.failReads > 0) { state.failReads--; throw new Error("synthetic-private-read-error"); }
        const value = clone(state.snapshot);
        if (state.holdRead) return new Promise(resolve => state.pendingReads.push(() => resolve(value)));
        return value;
      },
      async updateHotwords(payload) {
        state.calls.push(clone(payload));
        if (state.holdWrite) await new Promise(resolve => { state.releaseWrite = resolve; });
        if (state.failNext) {
          const code = state.failNext; state.failNext = null;
          throw new Error(`Error invoking remote method: ${code} synthetic-private-error`);
        }
        if (!state.reply) throw new Error("Missing fixture response");
        state.snapshot = clone(state.reply); state.reply = null;
        if (state.emitOnSave) state.emit();
        return clone(state.snapshot);
      },
      onHotwordsUpdated(callback) {
        if (state.failSubscribe) { state.failSubscribe = false; throw new Error("synthetic-private-subscribe-error"); }
        state.subscriptions++; listeners.add(callback);
        return () => { state.unsubscribes++; listeners.delete(callback); };
      }
    }, { get(target, key) {
      if (!Object.hasOwn(target, key)) throw new Error("Unexpected API access");
      return target[key];
    } });
  }, { snapshot: { ...initial, ...options.snapshot }, missing: Boolean(options.missing), failReads: options.failReads || 0,
    failSubscribe: Boolean(options.failSubscribe) });
  await page.goto("http://hotwords.test/");
  await page.evaluate(() => {
    document.body.className = "settings-open";
    document.getElementById("settingsPanel").hidden = false;
    document.getElementById("settingsAsrPanel").hidden = true;
    document.getElementById("settingsAsrPanel").classList.remove("is-active");
    document.getElementById("settingsHotwordsPanel").hidden = false;
    document.getElementById("settingsHotwordsPanel").classList.add("is-active");
    const root = document.getElementById("hotwordsPanel");
    window.hotwordsTest.panel = window.HotwordsPanel.create({ root, api: window.mimoInput });
  });
  const panel = page.locator("#hotwordsPanel");
  return { page, panel, pageErrors, close: async () => {
    assert.deepEqual(pageErrors, []); await page.close();
  } };
}

const control = (page, name) => page.locator(`#hotwordsPanel [data-hotwords="${name}"]`);
const action = (page, name, id) => page.locator(`#hotwordsPanel [data-hotwords-action="${name}"]${id ? `[data-id="${id}"]` : ""}`);
async function reply(page, patch) {
  await page.evaluate(patch => { window.hotwordsTest.reply = { ...window.hotwordsTest.snapshot, ...patch }; }, patch);
}
async function saved(page, payload) {
  await page.waitForFunction(() => document.getElementById("hotwordsPanel").getAttribute("aria-busy") === "false");
  assert.deepEqual(await page.evaluate(() => window.hotwordsTest.calls.at(-1)), payload);
  assert.equal(await control(page, "error").isVisible(), false);
}
async function emit(page, patch) {
  await page.evaluate(patch => window.hotwordsTest.emit(patch), patch);
}

async function browserTests(browser) {
  await libraryTests(browser);
  const f = await fixture(browser);
  const { page, panel } = f;
  assert.equal(await page.evaluate(() => window.hotwordsTest.subscriptions), 1, "self-init and explicit create share an instance");
  assert.equal(await control(page, "enabled").isChecked(), true);
  assert.equal(await control(page, "observe").isChecked(), false);
  assert.equal(await page.evaluate(() => window.hotwordsTest.calls.length), 0, "loading never opts in or accepts candidates");
  assert.equal(await control(page, "pending").innerText(), "待确认 2");
  assert.equal(await control(page, "editor").isVisible(), true);
  const firstRow = control(page, "entries").locator("li").first();
  assert.equal(await firstRow.locator(":scope > input").count(), 1, "only selection stays on the left");
  assert.equal(await firstRow.locator(".hotwords-word input").count(), 0, "the word itself is separate from enablement");
  assert.equal(await firstRow.locator(".hotwords-entry-toggle").innerText(), "启用");
  assert.equal(await action(page, "select", "e1").getAttribute("aria-label"), "选择词条：量子光学");
  assert.equal(await action(page, "toggle", "e1").getAttribute("aria-label"), "启用词条：量子光学");
  await action(page, "select", "e1").check();
  assert.equal(await action(page, "toggle", "e1").isChecked(), true);
  assert.equal(await page.evaluate(() => window.hotwordsTest.calls.length), 0, "selection never toggles enablement");
  await action(page, "select", "e1").uncheck();
  assert.equal(await control(page, "help").evaluate(el => el.open), false);
  assert.equal(await page.locator("#hotwordsPrivacy").isVisible(), false);
  assert.equal(await control(page, "observation-note").isVisible(), true);
  assert.match(await control(page, "observation-note").innerText(), /已关闭/);
  assert.equal(await control(page, "observation-note").getAttribute("role"), "status");
  for (const name of ["enabled", "observe", "text"]) {
    const ids = (await control(page, name).getAttribute("aria-describedby")).split(/\s+/);
    for (const id of ids) assert.equal(await page.locator(`[id="${id}"]`).count(), 1, `description ${id} remains bound`);
  }
  await control(page, "help").locator("summary").focus(); await page.keyboard.press("Enter");
  assert.equal(await page.locator("#hotwordsPrivacy").isVisible(), true);
  assert.equal(await page.locator("#hotwordsObservationHelp").isVisible(), true);
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#hotwordsPrivacy").isVisible(), false);

  await reply(page, { enabled: false }); await control(page, "enabled").uncheck();
  await saved(page, { action: "configure", enabled: false });
  assert.equal(await control(page, "observe").isDisabled(), true, "disabled dictionary suspends observation");
  assert.match(await control(page, "observation-note").innerText(), /观察已暂停/);
  await reply(page, { enabled: true }); await control(page, "enabled").check();
  await saved(page, { action: "configure", enabled: true });
  await reply(page, { observeCorrections: true }); await control(page, "observe").check();
  await saved(page, { action: "configure", observeCorrections: true });
  await emit(page, { observationStatus: "range-invalidated" });
  assert.match(await control(page, "observation-note").innerText(), /文本范围发生变化/);
  assert.equal(await control(page, "observation-note").isVisible(), true, "live status stays visible while help is collapsed");
  await emit(page, { observationStatus: "observing" });
  assert.equal(await control(page, "observation-note").innerText(), "正在观察本次输入。");
  await reply(page, { observeCorrections: false }); await control(page, "observe").uncheck();
  await saved(page, { action: "configure", observeCorrections: false });
  const added = { id: "e3", text: "磁光阱", enabled: true };
  await reply(page, { entries: [...initial.entries, added] });
  await control(page, "text").fill("  磁光阱  "); await control(page, "text").press("Enter");
  await saved(page, { action: "upsert", text: "磁光阱" });
  assert.equal(await control(page, "text").inputValue(), "");
  await action(page, "edit", "e2").click(); await control(page, "text").fill("冷原子钟");
  await reply(page, { entries: [initial.entries[0], { ...initial.entries[1], text: "冷原子钟" }, added] });
  await control(page, "save").click();
  await saved(page, { action: "upsert", id: "e2", text: "冷原子钟", enabled: false });
  await reply(page, { entries: [initial.entries[0], { id: "e2", text: "冷原子钟", enabled: true }, added] });
  await action(page, "toggle", "e2").check();
  await saved(page, { action: "upsert", id: "e2", text: "冷原子钟", enabled: true });
  await reply(page, { entries: [initial.entries[0], added] }); await action(page, "remove", "e2").click();
  await saved(page, { action: "remove", id: "e2" });
  await reply(page, { candidates: [initial.candidates[1]] }); await action(page, "accept", "c1").click();
  await saved(page, { action: "accept", id: "c1" });
  await reply(page, { candidates: [] }); await action(page, "dismiss", "c2").click();
  await saved(page, { action: "dismiss", id: "c2" });
  assert.equal(await control(page, "candidates-empty").isVisible(), true);
  console.log("Browser: dictionary and observation toggles, CRUD, disabled-entry editing and accept/dismiss passed.");

  const beforeInvalid = await page.evaluate(() => window.hotwordsTest.calls.length);
  for (const value of ["中".repeat(16), "a ".repeat(8).trim(), "a".repeat(81)]) {
    await control(page, "text").fill(value); await control(page, "save").click();
    assert.equal(await control(page, "text").getAttribute("aria-invalid"), "true");
  }
  await control(page, "text").fill("   "); assert.equal(await control(page, "save").isDisabled(), true);
  await control(page, "text").fill("输入法候选");
  await control(page, "text").dispatchEvent("compositionstart");
  await control(page, "editor").dispatchEvent("submit");
  assert.equal(await page.evaluate(() => window.hotwordsTest.calls.length), beforeInvalid);
  await control(page, "text").dispatchEvent("compositionend");
  for (const value of ["中".repeat(15), "a b c d e f g", "a".repeat(80)]) {
    await reply(page, {}); await control(page, "text").fill(value); await control(page, "save").click();
    await saved(page, { action: "upsert", text: value });
  }
  const errorCases = { hotword_invalid_term: "词条格式不符", hotword_duplicate: "词条已存在", hotword_not_found: "已被移除",
    hotwords_limit: "词典已达上限", hotwords_active_limit: "最多启用 100", hotwords_unavailable: "暂不可用", unknown_failure: "保存失败" };
  for (const [code, expected] of Object.entries(errorCases)) {
    await page.evaluate(code => { window.hotwordsTest.failNext = code; }, code);
    await control(page, "text").fill("重试词条"); await control(page, "save").click();
    await page.waitForFunction(() => !document.querySelector('[data-hotwords="error"]').hidden);
    assert.ok((await control(page, "error").innerText()).includes(expected));
    assert.doesNotMatch(await panel.innerText(), /synthetic-private/);
    assert.equal(await control(page, "text").inputValue(), "重试词条");
    assert.equal(await control(page, "save").isEnabled(), true);
  }
  await page.evaluate(() => { window.hotwordsTest.failNext = "hotwords_unavailable"; });
  await control(page, "enabled").click();
  await page.waitForFunction(() => document.querySelector('[data-hotwords="enabled"]').checked);
  await action(page, "refresh").click();
  await page.waitForFunction(() => document.querySelector('[data-hotwords="error"]').hidden);
  console.log("Browser: Chinese/ASCII limits, IME composition, safe error codes, draft retention and checkbox rollback passed.");

  await action(page, "edit", "e1").click(); await control(page, "text").fill("编辑中的草稿");
  await emit(page, { candidates: initial.candidates });
  assert.equal(await control(page, "text").inputValue(), "编辑中的草稿");
  await control(page, "text").press("Escape"); assert.equal(await control(page, "text").inputValue(), "");
  await action(page, "edit", "e1").click(); await control(page, "text").fill("保留草稿");
  await emit(page, { entries: [added] });
  await page.waitForFunction(() => document.querySelector('[data-hotwords="save"]').textContent === "添加");
  assert.equal(await control(page, "text").inputValue(), "保留草稿");

  await page.evaluate(() => { window.hotwordsTest.holdRead = true; void window.hotwordsTest.panel.refresh(); });
  await page.waitForFunction(() => window.hotwordsTest.pendingReads.length === 1);
  await reply(page, { enabled: false }); await control(page, "enabled").uncheck();
  await saved(page, { action: "configure", enabled: false });
  await page.evaluate(async () => {
    window.hotwordsTest.holdRead = false; window.hotwordsTest.pendingReads.shift()();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(await control(page, "enabled").isChecked(), false, "stale reads cannot undo a saved setting");
  assert.equal(await control(page, "observe").isDisabled(), true, "disabled vocabulary also suspends observation");
  await page.evaluate(() => { window.hotwordsTest.holdWrite = true; window.hotwordsTest.emitOnSave = true; });
  await reply(page, { enabled: true }); await control(page, "enabled").check();
  assert.equal(await control(page, "save").isDisabled(), true);
  await emit(page, { candidates: [] });
  await page.evaluate(() => { window.hotwordsTest.holdWrite = false; window.hotwordsTest.releaseWrite(); });
  await saved(page, { action: "configure", enabled: true });
  assert.equal(await control(page, "enabled").isChecked(), true);

  // All content is fixture-only; term strings must remain inert, including IDs.
  await emit(page, { entries: [{ id: 'e"]<>', text: "<img src=x onerror=alert(1)>", enabled: true }],
    candidates: [{ id: "long", from: "A".repeat(80), to: "测".repeat(15), count: 100 }] });
  assert.equal(await panel.locator("img,script").count(), 0);
  const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-hotwords-ui-"));
  for (const width of [1200, 620, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await panel.scrollIntoViewIfNeeded();
    const geometry = await panel.evaluate(root => {
      const bounds = root.getBoundingClientRect();
      const visible = [...root.querySelectorAll("input, button, p, li, summary")].filter(element => element.getClientRects().length);
      return { overflow: root.scrollWidth > root.clientWidth + 1,
        outside: visible.some(element => { const box = element.getBoundingClientRect(); return box.left < bounds.left - 1 || box.right > bounds.right + 1; }),
        unnamed: [...root.querySelectorAll("button")].some(button => !button.textContent.trim() && !button.getAttribute("aria-label")) };
    });
    assert.deepEqual(geometry, { overflow: false, outside: false, unnamed: false }, `panel geometry at ${width}px`);
    const rowLayout = await control(page, "entries").locator("li").first().evaluate(row => {
      const selectors = ['[data-hotwords-action="select"]', ".hotwords-word", ".hotwords-entry-toggle", '[data-hotwords-action="edit"]', '[data-hotwords-action="remove"]'];
      const boxes = selectors.map(selector => row.querySelector(selector).getBoundingClientRect());
      return boxes.every((box, i) => box.width > 0 && (!i || boxes[i - 1].right <= box.left + 1));
    });
    assert.equal(rowLayout, true, `selection, word, labeled enablement and actions remain ordered without overlap at ${width}px`);
    await panel.screenshot({ path: path.join(screenshotDir, `${width}.png`) });
  }
  console.log(`Browser: draft/event races, single-flight writes, inert text, accessible names and 1200/620/390px layouts passed. Screenshots: ${screenshotDir}`);

  await emit(page, { limit: 100, entries: Array.from({ length: 100 }, (_, i) => ({ id: `full-${i}`, text: `词条${i}`, enabled: true })) });
  assert.equal(await control(page, "text").isDisabled(), true);
  assert.equal(await control(page, "limit").isVisible(), true);
  await action(page, "edit", "full-0").click(); assert.equal(await control(page, "text").isEnabled(), true);
  await action(page, "cancel").click(); assert.equal(await control(page, "text").isDisabled(), true);
  await page.evaluate(() => { window.hotwordsTest.holdRead = true; void window.hotwordsTest.panel.refresh(); });
  const beforeDestroy = await panel.innerHTML();
  await page.evaluate(async () => {
    const state = window.hotwordsTest;
    state.panel.destroy(); state.panel.destroy();
    state.pendingReads.shift()(); state.emit({ entries: [] });
    await state.panel.refresh(); await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(await page.evaluate(() => window.hotwordsTest.unsubscribes), 1);
  assert.equal(await control(page, "entries").locator("li").count(), 100);
  assert.ok(beforeDestroy.includes("full-0"));
  await f.close();

  for (const platform of ["darwin", "linux"]) {
    const other = await fixture(browser, { snapshot: { observationAvailable: false, observeCorrections: true, entries: [], candidates: [] } });
    await other.page.evaluate(platform => { document.documentElement.dataset.platform = platform; }, platform);
    assert.equal(await control(other.page, "observe").isDisabled(), true);
    assert.equal(await control(other.page, "observe").isChecked(), false);
    assert.match(await control(other.page, "observation-note").innerText(), /当前平台不可用/);
    assert.equal(await control(other.page, "enabled").isEnabled(), true);
    assert.equal(await control(other.page, "entries-empty").isVisible(), true);
    assert.equal(await other.page.evaluate(() => window.hotwordsTest.calls.length), 0);
    await other.close();
  }
  const failed = await fixture(browser, { failReads: 1, failSubscribe: true });
  assert.equal(await control(failed.page, "enabled").isDisabled(), true);
  assert.equal(await control(failed.page, "error").isVisible(), true);
  assert.doesNotMatch(await failed.panel.innerText(), /synthetic-private/);
  await action(failed.page, "refresh").click();
  await failed.page.waitForFunction(() => !document.querySelector('[data-hotwords="enabled"]').disabled);
  assert.equal(await failed.page.evaluate(() => window.hotwordsTest.subscriptions), 1);
  await failed.close();
  const absent = await fixture(browser, { missing: true });
  assert.equal(await control(absent.page, "error").isVisible(), true);
  assert.equal(await control(absent.page, "enabled").isDisabled(), true);
  await absent.close();
  console.log("Browser: capacity, destroy/unsubscribe, unavailable observation on macOS/Linux, retry and missing API passed.");

  const integrated = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  try {
    const { prepareBrowser } = require("./test-meeting-live-ui");
    const pageErrors = await prepareBrowser(integrated);
    await integrated.evaluate(async snapshot => {
      window.mockApiOverrides = { getHotwords: async () => snapshot };
      await window.mockOpenSettings();
      await window.HotwordsPanel.create({ root: document.getElementById("hotwordsPanel"), api: window.mimoInput }).refresh();
    }, initial);
    await integrated.locator('[data-settings-tab="hotwords"]').click();
    assert.equal(await integrated.locator("#saveSettingsBtn").isVisible(), false);
    await action(integrated, "edit", "e1").click();
    await control(integrated, "text").press("Escape");
    assert.equal(await control(integrated, "text").inputValue(), "");
    assert.equal(await integrated.evaluate(() => currentWindowMode), "settings", "Escape cancels word editing without closing settings");
    await integrated.evaluate(() => { window.mockCalls.length = 0; });
    await control(integrated, "text").press("Control+Enter");
    assert.equal(await integrated.evaluate(() => window.mockCalls.some(call => ["injectText", "hide"].includes(call.name))), false,
      "editing hotwords must not send a stale dictation result");
    assert.deepEqual(pageErrors, []);
    console.log("Browser: integrated renderer hotword Escape/Ctrl+Enter stays inside settings.");
  } finally { await integrated.close(); }
}

async function libraryTests(browser) {
  const entries = Array.from({ length: 205 }, (_, i) => ({ id: `word-${i}`, text: `术语${i}`, enabled: i < 100 }));
  const f = await fixture(browser, { snapshot: { entries, candidates: [] } });
  const { page, panel } = f;
  try {
    assert.equal(await control(page, "entries").locator("li").count(), 100);
    assert.match(await control(page, "page").innerText(), /1 \/ 3/);
    assert.match(await control(page, "request-limit").innerText(), /最多使用 100.*当前启用 100/);
    await action(page, "select-results").click();
    assert.match(await control(page, "selection").innerText(), /已选 205 条/);
    await action(page, "clear-selection").click();
    await control(page, "search").fill("术语20");
    await action(page, "select-results").click();
    assert.match(await control(page, "selection").innerText(), /已选 6 条/);
    await action(page, "clear-selection").click();
    await control(page, "search").fill("");
    await action(page, "edit", "word-0").click();
    await control(page, "text").fill("批量管理中的草稿");
    await control(page, "select-page").check();
    await action(page, "next").click();
    await action(page, "select", "word-100").check();
    assert.equal(await control(page, "select-page").evaluate(el => el.indeterminate), true);
    await control(page, "search").fill("术语204");
    assert.equal(await control(page, "entries").locator("li").count(), 1);
    await control(page, "select-page").check();
    assert.match(await control(page, "selection").innerText(), /已选 102 条（本页 1 条）/);
    await action(page, "remove-many").click();
    assert.match(await control(page, "delete-message").innerText(), /102.*其他页及搜索结果之外/);
    assert.equal(await control(page, "search").isDisabled(), true);
    await action(page, "delete-cancel").click();
    assert.equal(await page.evaluate(() => window.hotwordsTest.calls.length), 0);
    assert.equal(await control(page, "text").inputValue(), "批量管理中的草稿");
    await action(page, "remove-many").click();
    await page.evaluate(() => { window.hotwordsTest.failNext = "hotwords_unavailable"; });
    await action(page, "delete-confirm").click();
    await page.waitForFunction(() => !document.querySelector('[data-hotwords="error"]').hidden);
    assert.equal(await control(page, "delete-confirmation").isVisible(), true);
    assert.match(await control(page, "selection").innerText(), /已选 102/);
    const ids = [...entries.slice(0, 101).map(entry => entry.id), "word-204"];
    await reply(page, { entries: entries.filter(entry => !ids.includes(entry.id)) });
    await action(page, "delete-confirm").click();
    await saved(page, { action: "removeMany", ids });
    assert.equal(await control(page, "search").evaluate(el => el === document.activeElement), true);
    assert.equal(await control(page, "text").inputValue(), "批量管理中的草稿");
    assert.equal(await control(page, "save").innerText(), "添加");
    assert.equal(await control(page, "entries-empty").innerText(), "没有匹配的词条。");
    await control(page, "search").fill("");
    await action(page, "next").click();
    assert.equal(await control(page, "entries").locator("li").count(), 3);
    await control(page, "select-page").check();
    await emit(page, { entries: entries.slice(101, 201) });
    await page.waitForFunction(() => document.querySelector('[data-hotwords="page"]').textContent.includes("1 / 1"));
    assert.match(await control(page, "selection").innerText(), /已选 0/);
    assert.equal(await action(page, "remove-many").isDisabled(), true);

    // Native picker cancellation and parsing failures must leave the editor untouched.
    await action(page, "import").click();
    await saved(page, { action: "previewImport" });
    assert.equal(await control(page, "import-preview").isVisible(), false);
    assert.equal(await control(page, "text").inputValue(), "批量管理中的草稿");
    const errorCases = {
      hotwords_import_encoding: "编码", hotwords_import_size: "16 MiB", hotwords_import_too_many_rows: "10 万",
      hotwords_import_workbook_limit: "工作簿", hotwords_import_format: "文件格式", hotwords_import_sogou_format: "仅支持搜狗 SGPU .bin 词库；此文件版本不受支持或文件已损坏。",
      hotwords_import_timeout: "超时", hotwords_import_busy: "稍后重试", hotwords_import_expired: "已过期", unknown: "无法预览"
    };
    for (const [code, expected] of Object.entries(errorCases)) {
      await page.evaluate(code => { window.hotwordsTest.failPreview = code; }, code);
      await action(page, "import").click();
      await page.waitForFunction(() => !document.querySelector('[data-hotwords="error"]').hidden);
      assert.ok((await control(page, "error").innerText()).includes(expected));
      assert.doesNotMatch(await panel.innerText(), /synthetic-private/);
      assert.equal(await action(page, "import").isEnabled(), true);
      assert.equal(await control(page, "text").inputValue(), "批量管理中的草稿");
    }

    const words = Array.from({ length: 205 }, (_, i) => `新词${i}`);
    const preview = { token: "fixture-token", fileName: "<img src=x onerror=alert(1)>.xlsx", words,
      stats: { total: 211, valid: 205, invalid: 2, duplicates: 3, existing: 1, available: 99900 } };
    await page.evaluate(preview => { window.hotwordsTest.preview = preview; window.hotwordsTest.holdWrite = true; }, preview);
    const beforePreview = await page.evaluate(() => window.hotwordsTest.calls.length);
    await action(page, "import").click();
    assert.equal(await panel.getAttribute("aria-busy"), "true");
    assert.equal(await action(page, "import").isDisabled(), true);
    await action(page, "import").dispatchEvent("click");
    assert.equal(await page.evaluate(() => window.hotwordsTest.calls.length), beforePreview + 1);
    await emit(page, { entries: entries.slice(101, 201) });
    await page.evaluate(() => { window.hotwordsTest.holdWrite = false; window.hotwordsTest.releaseWrite(); });
    await saved(page, { action: "previewImport" });
    assert.equal(await control(page, "import-preview").isVisible(), true);
    assert.equal(await control(page, "import-words").locator("li").count(), 100);
    assert.equal(await control(page, "import-words").locator("input").count(), 0);
    assert.match(await control(page, "import-stats").innerText(), /新有效 205.*无效 2.*重复 3.*已存在 1.*剩余容量 99900/);
    assert.equal(await panel.locator("img,script").count(), 0);
    await action(page, "import-next").click(); await action(page, "import-next").click();
    assert.equal(await control(page, "import-words").locator("li").count(), 5);
    assert.equal(await action(page, "import-next").isDisabled(), true);
    await action(page, "import-prev").click();
    assert.match(await control(page, "import-page").innerText(), /2 \/ 3/);
    await action(page, "import-cancel").click();
    assert.equal(await page.evaluate(() => window.hotwordsTest.calls.length), beforePreview + 1, "preview and cancellation never commit");
    assert.equal(await control(page, "text").inputValue(), "批量管理中的草稿");

    await page.evaluate(() => { window.hotwordsTest.preview.stats.available = 204; });
    await action(page, "import").click();
    await saved(page, { action: "previewImport" });
    assert.equal(await action(page, "import-confirm").isDisabled(), true, "preview capacity wins over the larger snapshot capacity");
    assert.match(await control(page, "import-capacity").innerText(), /需要 205.*剩余 204/);
    assert.equal(await control(page, "import-words").locator("li").count(), 100, "over-capacity words stay in preview");
    await action(page, "import-cancel").click();
    await page.evaluate(() => { window.hotwordsTest.preview.words = []; window.hotwordsTest.preview.stats.valid = 0; });
    await action(page, "import").click(); await saved(page, { action: "previewImport" });
    assert.equal(await action(page, "import-confirm").isDisabled(), true);
    await action(page, "import-cancel").click();

    await page.evaluate(preview => { window.hotwordsTest.preview = preview; }, preview);
    await action(page, "import").click(); await saved(page, { action: "previewImport" });
    const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-hotwords-import-ui-"));
    for (const width of [1200, 620, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1), false, `import layout fits ${width}px`);
      await control(page, "import-preview").screenshot({ path: path.join(screenshots, `${width}.png`) });
    }
    await page.evaluate(() => { window.hotwordsTest.failNext = "hotwords_import_expired"; });
    await action(page, "import-confirm").click();
    await page.waitForFunction(() => !document.querySelector('[data-hotwords="error"]').hidden);
    assert.match(await control(page, "error").innerText(), /已过期/);
    assert.equal(await control(page, "import-preview").isVisible(), true);
    assert.equal(await control(page, "text").inputValue(), "批量管理中的草稿");
    await action(page, "import-cancel").click();
    await action(page, "import").click(); await saved(page, { action: "previewImport" });
    const imported = words.map((text, i) => ({ id: `import-${i}`, text, enabled: i < 100 }));
    await reply(page, { entries: [...entries.slice(101, 201), ...imported] });
    await page.evaluate(() => { window.hotwordsTest.holdWrite = true; window.hotwordsTest.emitOnSave = true; });
    await action(page, "import-confirm").click();
    assert.equal(await action(page, "import-cancel").isDisabled(), true);
    assert.equal(await action(page, "import-confirm").isDisabled(), true);
    await action(page, "import-confirm").dispatchEvent("click");
    await page.evaluate(() => { window.hotwordsTest.holdWrite = false; window.hotwordsTest.releaseWrite(); });
    await saved(page, { token: "fixture-token" });
    assert.equal(await action(page, "import").evaluate(el => el === document.activeElement), true);
    assert.equal(await control(page, "import-preview").isVisible(), false);
    assert.equal(await control(page, "text").inputValue(), "批量管理中的草稿");
    assert.match(await control(page, "count").innerText(), /305 \/ 100000/);
    await control(page, "search").fill("新词");
    await action(page, "next").click();
    assert.equal(await action(page, "toggle", "import-100").isChecked(), false);
    assert.match(await control(page, "page").innerText(), /共 205 条/);
    console.log(`Browser: cross-page search/selection/delete confirmation, preview cancellation/capacity/errors, token-only commit, draft retention and import layouts passed. Screenshots: ${screenshots}`);

    await emit(page, { entries: Array.from({ length: 100000 }, (_, i) => ({ id: `large-${i}`, text: `大词库${i}`, enabled: i < 100 })) });
    await control(page, "search").fill("");
    assert.equal(await control(page, "entries").locator("li").count(), 100);
    assert.match(await control(page, "page").innerText(), /1 \/ 1000.*共 100000/);
    await control(page, "search").fill("大词库99999");
    assert.equal(await control(page, "entries").locator("li").count(), 1);
    await action(page, "select", "large-99999").check();
    await action(page, "clear-selection").click();
    assert.match(await control(page, "selection").innerText(), /已选 0/);
    console.log("Browser: 100,000-entry dictionary renders only 100 rows per page and remains searchable.");
  } finally { await f.close(); }
}

async function reviewScreenshots(browser) {
  const page = await browser.newPage();
  const output = path.resolve(renderer, "../../tmp/hotwords-ui-review");
  fs.mkdirSync(output, { recursive: true });
  const { prepareBrowser } = require("./test-meeting-live-ui");
  const pageErrors = await prepareBrowser(page);
  try {
    await page.evaluate(async () => {
      const terms = ["激光稳频", "冷原子钟", "磁光阱", "光学平台", "真空腔体", "频率梳", "量子传感", "光纤耦合"];
      const snapshot = { enabled: true, observeCorrections: false, observationAvailable: true, requestLimit: 100, limit: 100000,
        entries: Array.from({ length: 237 }, (_, i) => ({ id: `review-${i}`, text: `${terms[i % terms.length]}${String(i + 1).padStart(3, "0")}`, enabled: i < 100 })),
        candidates: [{ id: "review-candidate", from: "磁光井", to: "磁光阱", count: 2 }] };
      window.mockApiOverrides = {
        getHotwords: async () => structuredClone(snapshot),
        previewHotwordImport: async () => ({ token: "synthetic-review-token", fileName: "合成示例词库.xlsx",
          words: Array.from({ length: 126 }, (_, i) => `示例新词${String(i + 1).padStart(3, "0")}`),
          stats: { total: 135, valid: 126, invalid: 4, duplicates: 3, existing: 2, available: 99763 } })
      };
      await window.mockOpenSettings();
      await window.HotwordsPanel.create({ root: document.getElementById("hotwordsPanel"), api: window.mimoInput }).refresh();
    });
    await page.locator('[data-settings-tab="hotwords"]').click();
    await action(page, "edit", "review-0").click();
    await control(page, "text").fill("待保存的示例草稿");
    await action(page, "select", "review-0").check();
    await action(page, "select", "review-1").check();
    await action(page, "next").click();
    await action(page, "select", "review-100").check();
    for (const { name, width, height } of [{ name: "desktop", width: 1200, height: 900 }, { name: "narrow", width: 540, height: 760 }]) {
      for (const state of ["list", "import"]) {
        await page.setViewportSize({ width, height });
        if (state === "import") {
          await action(page, "import").click();
          await page.waitForFunction(() => !document.querySelector('[data-hotwords="import-preview"]').hidden);
          await action(page, "import-next").click();
          assert.equal(await control(page, "import-words").locator("li").count(), 26);
          await action(page, "import-prev").click();
          assert.equal(await action(page, "import-confirm").isEnabled(), true);
          await action(page, "import-cancel").scrollIntoViewIfNeeded();
        } else {
          assert.match(await control(page, "page").innerText(), /2 \/ 3/);
          await action(page, "prev").click(); await action(page, "next").click();
          await action(page, "next").scrollIntoViewIfNeeded();
        }
        const geometry = await page.locator("#hotwordsPanel").evaluate(root => {
          const bounds = root.getBoundingClientRect();
          const visible = [...root.querySelectorAll("button,input,p,h3,li")].filter(el => el.getClientRects().length);
          return { overflow: root.scrollWidth > root.clientWidth + 1, outside: visible.some(el => {
            const box = el.getBoundingClientRect(); return box.left < bounds.left - 1 || box.right > bounds.right + 1;
          }) };
        });
        assert.deepEqual(geometry, { overflow: false, outside: false }, `${name} ${state} controls fit`);
        await page.screenshot({ path: path.join(output, `${name}-${state}-viewport.png`), fullPage: true });
        if (state === "list") {
          await page.locator(".settings-tab-content").evaluate(el => { el.scrollTop = 0; });
          await control(page, "entries").evaluate(el => { el.scrollTop = 0; });
          assert.equal(await page.locator(".settings-tab-content").evaluate(el => el.scrollTop), 0);
          const switchesInViewport = await page.locator('[data-hotwords="enabled"], [data-hotwords="observe"]').evaluateAll(nodes => nodes.every(el => {
            const box = el.getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight;
          }));
          assert.equal(switchesInViewport, true, "initial viewport includes both dictionary switches");
          await page.screenshot({ path: path.join(output, `${name}-list-top-viewport.png`) });
        }
        // Expand only the capture height so the complete settings tab is visible, retaining its actual width and layout.
        const contentHeight = await page.locator(".settings-tab-content").evaluate(el => el.scrollHeight + el.getBoundingClientRect().top + 40);
        await page.setViewportSize({ width, height: Math.ceil(contentHeight) });
        await page.locator(".settings-tab-content").evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path: path.join(output, `${name}-${state}-full.png`), fullPage: true });
        if (state === "import") await action(page, "import-cancel").click();
        assert.equal(await control(page, "text").inputValue(), "待保存的示例草稿");
      }
    }
    assert.deepEqual(pageErrors, []);
    console.log(`Synthetic whole-tab desktop/narrow screenshots and viewport checks: ${output}`);
  } finally { await page.close(); }
}

if (require.main === module) (async () => {
  contracts();
  if (!process.argv.includes("--browser") && !process.argv.includes("--screenshots")) return;
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
  try {
    if (process.argv.includes("--browser")) await browserTests(browser);
    if (process.argv.includes("--screenshots")) await reviewScreenshots(browser);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { contracts, browserTests };
