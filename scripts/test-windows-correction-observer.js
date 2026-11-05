"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");
const { startCorrectionObservation } = require("../src/platform/windows-correction-observer");

const BEFORE = "Keep this wrong word safely.";
const AFTER = "Keep this right word safely.";
const line = value => `${JSON.stringify(value)}\n`;
const armed = line({ type: "status", status: "observing" });
const corrected = (before = BEFORE, after = AFTER) => line({ type: "correction", before, after });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log(`PASS ${name}`);
}

function mock(options = {}) {
  const child = new EventEmitter();
  const writes = [], results = [], statuses = [], calls = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } });
  child.stdout = new PassThrough();
  child.kills = 0;
  child.kill = signal => { assert.equal(signal, "SIGKILL"); child.kills++; return true; };
  const baseline = process.listenerCount("exit");
  const handle = startCorrectionObservation({ helperPath: "synthetic-helper.exe", target: "123", text: BEFORE,
    onCorrection: value => results.push(value), onStatus: value => statuses.push(value.status),
    spawnImpl: (...args) => { calls.push(args); return child; }, ...options });
  return { child, writes, results, statuses, calls, handle, baseline,
    output: data => child.stdout.write(data), close: (code = 0, signal = null) => child.emit("close", code, signal) };
}

async function unit() {
  await test("one stdin payload; private argv; clean exit delivers exactly once", () => {
    const m = mock();
    assert.deepEqual(m.calls[0], ["synthetic-helper.exe", ["--watch-correction"],
      { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"] }]);
    assert.equal(m.writes.length, 1);
    assert.deepEqual(JSON.parse(m.writes[0]), { target: "123", text: BEFORE, timeoutMs: 45000 });
    assert.equal(m.child.stdin.writableEnded, false);
    m.output(armed + corrected());
    assert.equal(m.results.length, 0, "candidate waits for clean EOF/exit");
    m.close(); m.close(); m.handle.stop();
    assert.deepEqual(m.results, [{ before: BEFORE, after: AFTER }]);
    assert.equal(m.child.kills, 0);
    assert.equal(process.listenerCount("exit"), m.baseline);
  });
  await test("split UTF-8 and split JSON frames remain exact", () => {
    const text = "Keep this \u4e2d\u6587 wrong word safely.";
    const after = text.replace("wrong", "right");
    const m = mock({ text });
    for (const byte of Buffer.from(armed + corrected(text, after))) m.output(Buffer.from([byte]));
    m.close();
    assert.deepEqual(m.results, [{ before: text, after }]);
  });
  await test("stop is idempotent and discards queued/late correction", () => {
    const m = mock(); m.output(armed + corrected()); m.handle.stop(); m.handle.stop(); m.close();
    m.output(corrected());
    assert.equal(m.child.kills, 1); assert.equal(m.child.stdin.destroyed, true);
    assert.equal(m.results.length, 0); assert.equal(process.listenerCount("exit"), m.baseline);
  });
  await test("parent exit handler kills child and removes itself", () => {
    const prior = new Set(process.listeners("exit"));
    const m = mock();
    process.listeners("exit").find(listener => !prior.has(listener))();
    assert.equal(m.child.kills, 1); assert.equal(process.listenerCount("exit"), m.baseline);
  });
  await test("deadline kills pending helper; large timeout is capped", async () => {
    const m = mock({ timeoutMs: 15 }); m.output(armed + corrected());
    await delay(40); m.close();
    assert.equal(m.child.kills, 1); assert.equal(m.results.length, 0); assert.ok(m.statuses.includes("timeout"));
    const capped = mock({ timeoutMs: 999999 });
    assert.equal(JSON.parse(capped.writes[0]).timeoutMs, 45000); capped.handle.stop();
  });
  await test("all malformed/overlong/unexpected outputs fail closed", () => {
    const cases = ["not json\n", "[]\n", "null\n", "\n", "{}\n", "x".repeat(65537),
      Buffer.alloc(131073, 120), Buffer.from([0xc3, 0x28]), armed + armed,
      corrected(), armed + corrected() + corrected(), armed + corrected() + "garbage\n",
      armed + corrected() + "trailing", armed + corrected(BEFORE, BEFORE),
      armed + corrected("different original", AFTER), armed + corrected(BEFORE, ""),
      armed + corrected(BEFORE, "unrelated full document"),
      armed + corrected(BEFORE, AFTER + " appended"),
      armed + corrected(BEFORE, `Keep ${"x".repeat(300)} safely.`),
      armed + line({ type: "correction", before: BEFORE, after: AFTER, extra: "rejected" }),
      line({ type: "status", status: "provider error with sensitive details" }),
      line({ type: "status", status: "unsupported" }) + corrected()];
    for (const output of cases) {
      const m = mock(); m.output(output); m.close(); m.handle.stop();
      assert.equal(m.results.length, 0);
      assert.ok(m.statuses.includes("protocol-error"));
      assert.equal(process.listenerCount("exit"), m.baseline);
    }
  });
  await test("truncated UTF-8/JSON and nonzero/signal exits discard candidate", () => {
    for (const output of [armed + corrected().trimEnd(), Buffer.from([0xe4, 0xb8])]) {
      const m = mock(); m.output(output); m.close(); assert.equal(m.results.length, 0);
      assert.ok(m.statuses.includes("protocol-error"));
    }
    for (const [code, signal] of [[1, null], [null, "SIGKILL"]]) {
      const m = mock(); m.output(armed + corrected()); m.close(code, signal);
      assert.equal(m.results.length, 0);
    }
  });
  await test("spawn, stream and child errors are sanitized", () => {
    const statuses = [];
    const handle = startCorrectionObservation({ helperPath: "fixture", target: "1", text: BEFORE,
      onCorrection() { assert.fail(); }, onStatus: value => statuses.push(value.status),
      spawnImpl() { throw new Error("synthetic sensitive error"); } });
    handle.stop(); assert.deepEqual(statuses, ["spawn-error"]);
    for (const stream of ["child", "stdin", "stdout"]) {
      const m = mock(); const target = stream === "child" ? m.child : m.child[stream];
      target.emit("error", new Error("synthetic sensitive error")); m.close();
      assert.equal(m.results.length, 0); assert.equal(m.child.kills, 1);
      assert.ok(m.statuses.every(value => !value.includes("sensitive")));
    }
  });
  await test("invalid options rejected without spawning", () => {
    const options = { helperPath: "fixture", target: "1", text: BEFORE, onCorrection() {},
      spawnImpl() { assert.fail("must not spawn"); } };
    for (const target of ["", "0", "-1", "1;exit", "9223372036854775808", 123])
      assert.throws(() => startCorrectionObservation({ ...options, target }), /Invalid correction/);
    for (const text of ["", " ", "\0", "\ud800", "x".repeat(4097)])
      assert.throws(() => startCorrectionObservation({ ...options, text }), /Invalid correction/);
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5])
      assert.throws(() => startCorrectionObservation({ ...options, timeoutMs }), /Invalid correction/);
  });
  await test("async/sync caller failures cannot become unhandled rejections", async () => {
    let unhandled = 0;
    const listener = () => { unhandled++; };
    process.on("unhandledRejection", listener);
    try {
      const m = mock({ onCorrection: async () => { throw new Error("synthetic callback error"); },
        onStatus: async () => { throw new Error("synthetic callback error"); } });
      m.output(armed + corrected()); m.close();
      await delay(20); assert.equal(unhandled, 0);
      const n = mock({ onCorrection() { throw new Error("synthetic callback error"); } });
      n.output(armed + corrected()); n.close();
    } finally { process.removeListener("unhandledRejection", listener); }
  });
}

// Opt-in native tests use only this process-owned synthetic WPF editor.
// Existing user windows are never queried for text or used as the test target.
const fixtureScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Xaml
$references = @([System.Windows.Window].Assembly.Location, [System.Windows.Media.Visual].Assembly.Location, [System.Windows.Threading.Dispatcher].Assembly.Location, [System.Xaml.XamlReader].Assembly.Location)
Add-Type -ReferencedAssemblies $references -TypeDefinition @"
using System;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
public static class CorrectionFixture {
 [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr pid);
 [System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
 [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int show);
 [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void NotifyWinEvent(uint ev, IntPtr window, int objectId, int childId);
 static void Activate(Window form) {
  uint current = GetCurrentThreadId(), foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
  bool attached = current != foreground && AttachThreadInput(current, foreground, true);
  try { var hwnd = new WindowInteropHelper(form).Handle; ShowWindow(hwnd, 5); form.Activate(); SetForegroundWindow(hwnd); }
  finally { if (attached) AttachThreadInput(current, foreground, false); }
 }
 public static void Run() {
  var form = new Window { Title = "Synthetic correction observer test", Width = 660, Height = 280, Topmost = true };
  var panel = new StackPanel { Margin = new Thickness(10) };
  var box = new TextBox { AcceptsReturn = true, Height = 150 };
  var other = new TextBox { Text = "OTHER FIXTURE FIELD MUST NOT BE EMITTED" };
  var secret = new PasswordBox { Password = "SYNTHETIC PASSWORD", Visibility = Visibility.Collapsed };
  const string prefix = "OUTSIDE-LEFT|";
  const string before = "Keep this wrong word safely.";
  panel.Children.Add(box); panel.Children.Add(other); panel.Children.Add(secret); form.Content = panel;
  Action reset = () => { Activate(form); secret.Visibility = Visibility.Collapsed;
   box.IsReadOnly = false; box.Text = prefix + before + "|OUTSIDE-RIGHT"; box.Focus(); box.Select(prefix.Length + before.Length, 0); };
  Action<string> replace = value => { int start = box.SelectionStart; box.SelectedText = value; box.Select(start + value.Length, 0); };
  form.ContentRendered += (sender, args) => {
   form.Activate(); reset();
   Console.WriteLine("ready:" + new WindowInteropHelper(form).Handle.ToInt64()); Console.Out.Flush();
   var reader = new Thread(() => {
    string command;
    while ((command = Console.ReadLine()) != null) {
     var action = command;
     form.Dispatcher.BeginInvoke((Action)(() => {
      switch (action) {
       case "probe": Console.WriteLine("probe-state:" + (GetForegroundWindow() == new WindowInteropHelper(form).Handle) + ":" + box.IsKeyboardFocused + ":" + box.SelectionLength); break;
       case "reset": reset(); break;
       case "settle": {
        // A command acknowledgement is not a focus/dispatcher readiness barrier.
        // Check only our own fixture state; never reactivate during observation.
        var clock = System.Diagnostics.Stopwatch.StartNew();
        long stableSince = -1;
        var timer = new System.Windows.Threading.DispatcherTimer(System.Windows.Threading.DispatcherPriority.ApplicationIdle);
        timer.Interval = TimeSpan.FromMilliseconds(25);
        timer.Tick += (tickSender, tickArgs) => {
         bool ready = GetForegroundWindow() == new WindowInteropHelper(form).Handle && box.IsKeyboardFocused &&
          box.SelectionLength == 0 && box.SelectionStart == prefix.Length + before.Length &&
          box.Text == prefix + before + "|OUTSIDE-RIGHT" && !box.IsReadOnly;
         if (!ready) stableSince = -1;
         else if (stableSince < 0) stableSince = clock.ElapsedMilliseconds;
         if (ready && clock.ElapsedMilliseconds - stableSince >= 250) {
          timer.Stop(); Console.WriteLine("settle"); Console.Out.Flush();
         } else if (clock.ElapsedMilliseconds >= 3000) {
          timer.Stop(); Console.WriteLine("settle-failed:" + ready); Console.Out.Flush();
         }
        };
        timer.Start(); return;
       }
       case "select": box.Select(prefix.Length + before.IndexOf("wrong"), 5); break;
       case "replace": replace("right"); break;
       case "grow": replace("correct"); break;
       case "partial": replace("righx"); break;
       case "boundary": box.Select(prefix.Length, 4); box.SelectedText = "Lose"; break;
       case "outside": box.Select(0, 5); break;
       case "clear": box.Clear(); break;
       case "focus": other.Focus(); break;
       case "repeat-focus": NotifyWinEvent(0x8005, new WindowInteropHelper(form).Handle, -4, 0); NotifyWinEvent(3, new WindowInteropHelper(form).Handle, 0, 0); break;
       case "password": secret.Visibility = Visibility.Visible; secret.Focus(); break;
       case "readonly": box.IsReadOnly = true; break;
       case "quit": form.Close(); return;
      }
      Console.WriteLine(action); Console.Out.Flush();
     }));
    }
    try { form.Dispatcher.BeginInvoke((Action)(() => form.Close())); } catch { }
   });
   reader.IsBackground = true; reader.Start();
  };
  new Application().Run(form);
 }
}
"@
[CorrectionFixture]::Run()
`;

async function waitFor(predicate, message, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(message);
    await delay(20);
  }
}

async function native() {
  assert.equal(process.platform, "win32", "native fixture requires Windows");
  const helperPath = process.env.CORRECTION_TEST_HELPER ||
    path.resolve(__dirname, "../native/audio-capture-helper/target/debug/audio-capture-helper.exe");
  const fixture = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
    Buffer.from(fixtureScript, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const events = [];
  let fixtureClosed = false;
  fixture.on("error", () => { fixtureClosed = true; });
  fixture.on("close", () => { fixtureClosed = true; });
  fixture.stdin.on("error", () => {});
  const lines = readline.createInterface({ input: fixture.stdout });
  lines.on("line", value => events.push(value));
  async function command(value) {
    const count = events.length;
    const requestedAt = performance.now();
    fixture.stdin.write(`${value}\n`);
    await waitFor(() => events.slice(count).includes(value) || events.slice(count).some(event => event.startsWith("settle-failed:")),
      "synthetic fixture command failed");
    assert.ok(events.slice(count).includes(value), "fixture never reached stable foreground/focus/caret; observer not started");
    return requestedAt;
  }
  const active = [];
  try {
    await waitFor(() => fixtureClosed || events.some(value => value.startsWith("ready:")), "synthetic fixture startup failed", 15000);
    assert.equal(fixtureClosed, false, "synthetic fixture failed to launch");
    const target = events.find(value => value.startsWith("ready:")).slice(6);
    async function observe(text = BEFORE, setup = null) {
      await command("reset"); await command("settle");
      if (setup) { await command(setup); await delay(100); }
      await command("probe");
      const fixtureState = events.filter(value => value.startsWith("probe-state:")).at(-1);
      const results = [], statuses = [];
      let closed = false, child, correctedAt = null;
      const handle = startCorrectionObservation({ helperPath, target, text, timeoutMs: 12000,
        onCorrection: value => { correctedAt = performance.now(); results.push(value); }, onStatus: value => statuses.push(value.status),
        spawnImpl: (...args) => { child = spawn(...args); child.on("close", () => { closed = true; }); return child; } });
      const watch = { handle, results, statuses, fixtureState, get closed() { return closed; },
        get child() { return child; }, get correctedAt() { return correctedAt; } };
      active.push(watch);
      await waitFor(() => statuses.includes("observing") || closed, "native anchor did not respond");
      return watch;
    }
    await test("real UIA selects word for >500ms, then emits one idle correction confined to insertion", async () => {
      const watch = await observe();
      assert.ok(watch.statuses.includes("observing"), `synthetic anchor stopped: ${watch.statuses.join(",")}; ${watch.fixtureState}`);
      await command("select"); await delay(800);
      assert.equal(watch.closed, false, "interior selection must pause, not cancel");
      await command("partial"); await delay(700);
      assert.equal(watch.results.length, 0, "intermediate typing cannot be emitted");
      await command("select");
      const editRequestedAt = await command("replace");
      await delay(1500); assert.equal(watch.results.length, 0, "two-second idle guard");
      await waitFor(() => watch.closed, "native correction did not finish", 5000);
      assert.equal(watch.results.length, 1, `native correction stopped: ${watch.statuses.join(",")}`);
      assert.ok(watch.correctedAt - editRequestedAt >= 2000, "two-second idle measured before command dispatch, not after its acknowledgement");
      assert.deepEqual(watch.results, [{ before: BEFORE, after: AFTER }]);
    });
    await test("real UIA length-changing correction preserves guards and emits exactly the insertion", async () => {
      const watch = await observe(); assert.ok(watch.statuses.includes("observing"));
      await command("select"); await command("grow");
      await waitFor(() => watch.closed, "length edit did not finish", 5000);
      assert.deepEqual(watch.results, [{ before: BEFORE, after: BEFORE.replace("wrong", "correct") }]);
    });
    await test("redundant focus notifications keep the same input observable", async () => {
      const watch = await observe(); assert.ok(watch.statuses.includes("observing"));
      await command("repeat-focus"); await delay(800);
      assert.equal(watch.closed, false);
      await command("select"); await command("replace");
      await waitFor(() => watch.closed, "redundant-focus correction did not finish", 5000);
      assert.deepEqual(watch.results, [{ before: BEFORE, after: AFTER }]);
    });
    for (const action of ["boundary", "outside", "clear", "focus"]) {
      await test(`real UIA ${action} cancels without correction`, async () => {
        const watch = await observe(); assert.ok(watch.statuses.includes("observing"));
        await command(action); await waitFor(() => watch.closed, "native cancellation did not finish");
        assert.equal(watch.results.length, 0);
      });
    }
    await test("real UIA mismatched suffix fails closed", async () => {
      const watch = await observe(BEFORE.replace("wrong", "other"));
      await waitFor(() => watch.closed, "mismatched anchor did not close");
      assert.ok(watch.statuses.includes("unsupported")); assert.equal(watch.results.length, 0);
    });
    for (const setup of ["select", "password", "readonly"]) {
      await test(`real UIA initial ${setup} fails closed`, async () => {
        const watch = await observe(BEFORE, setup);
        await waitFor(() => watch.closed, "unsafe anchor did not close");
        assert.ok(watch.statuses.includes("unsupported")); assert.equal(watch.results.length, 0);
      });
    }
    await test("native EOF ends observation promptly", async () => {
      const watch = await observe(); assert.ok(watch.statuses.includes("observing"));
      watch.child.stdin.end();
      await waitFor(() => watch.closed, "EOF watchdog did not terminate", 1500);
      assert.equal(watch.results.length, 0);
    });
    await test("native second stdin payload cancels promptly", async () => {
      const watch = await observe(); assert.ok(watch.statuses.includes("observing"));
      watch.child.stdin.write("{}\n");
      await waitFor(() => watch.closed, "extra-input watchdog did not terminate", 1500);
      assert.equal(watch.results.length, 0);
    });
    await test("native watchdog expires with stdin open, independent of JS wrapper", async () => {
      await command("reset"); await command("settle");
      const child = spawn(helperPath, ["--watch-correction"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      let closed = false, spawnFailed = false, code = null, observing = false;
      child.on("close", exitCode => { closed = true; code = exitCode; });
      child.on("error", () => { spawnFailed = true; });
      const output = readline.createInterface({ input: child.stdout });
      output.on("line", value => { try { if (JSON.parse(value).status === "observing") observing = true; } catch {} });
      child.stdin.on("error", () => {});
      const start = Date.now();
      child.stdin.write(line({ target, text: BEFORE, timeoutMs: 1200 }));
      try {
        await waitFor(() => closed, "native hard watchdog failed", 3000);
        assert.equal(spawnFailed, false); assert.equal(code, 0); assert.equal(observing, true);
        assert.ok(Date.now() - start >= 1100, "deadline, not early rejection, ends native process");
        assert.ok(Date.now() - start < 2500);
      } finally {
        if (!closed) child.kill("SIGKILL");
        await waitFor(() => closed, "watchdog child cleanup failed", 1500);
        output.close();
      }
    });
  } finally {
    for (const watch of active) watch.handle.stop();
    fixture.stdin.end();
    if (!fixtureClosed) fixture.kill("SIGKILL");
    await waitFor(() => fixtureClosed && active.every(watch => watch.closed), "fixture cleanup failed", 5000);
    lines.close();
  }
}

(async () => {
  await unit();
  if (process.argv.includes("--native")) await native();
  console.log(`${passed} correction observer tests passed${process.argv.includes("--native") ? " (including isolated native UIA)" : " (mock lifecycle/parser; native opt-in: --native)"}.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
