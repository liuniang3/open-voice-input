//! Short-lived UIA observation of one post-injection range. No keyboard hooks,
//! clipboard, Value reads, document ranges, text logs, or persistence.
//! Four characters at each inserted boundary remain immutable. Only providers
//! preserving independently cloned ranges can support an interior correction.
//! A reset, boundary edit, outside selection, focus event, or uncertainty stops it.
//! Scope: >=12 Unicode scalars, <=4096 UTF-16 units, unique nonblank four-scalar
//! guards, <=256-unit growth, 500ms polls, 2s idle, <=45s lifetime. Some editors
//! have no TextPattern or return a child owner; both are intentionally rejected.
//! Submission is detectable only through clear/focus/range changes, not key input.

use std::io::{self, BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const MAX_TEXT: usize = 4096;
const MAX_PAYLOAD: u64 = 64 * 1024;
const POLL: Duration = Duration::from_millis(500);
const IDLE: Duration = Duration::from_secs(2);
static FOCUS_CHANGED: AtomicBool = AtomicBool::new(false);

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    target: String,
    text: String,
    timeout_ms: u64,
}

fn valid_text(text: &str) -> bool {
    !text.trim().is_empty() && !text.contains('\0') && text.encode_utf16().count() <= MAX_TEXT
}

fn guards(text: &str) -> Option<(String, String)> {
    let chars: Vec<char> = text.chars().collect();
    if !valid_text(text) || chars.len() < 12 {
        return None;
    }
    let left: String = chars[..4].iter().collect();
    let right: String = chars[chars.len() - 4..].iter().collect();
    if left.trim().is_empty()
        || right.trim().is_empty()
        || left == right
        || text.find(&left) != text.rfind(&left)
        || text.find(&right) != text.rfind(&right)
    {
        return None;
    }
    Some((left, right))
}

fn candidate_valid(before: &str, after: &str, left: &str, right: &str) -> bool {
    valid_text(after)
        && after.chars().count() > 8
        && after.encode_utf16().count() <= (before.encode_utf16().count() + 256).min(MAX_TEXT)
        && after.starts_with(left)
        && after.ends_with(right)
        && after.find(left) == after.rfind(left)
        && after.find(right) == after.rfind(right)
}

fn emit(value: serde_json::Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}
fn status(value: &str) {
    emit(serde_json::json!({"type": "status", "status": value}));
}

unsafe extern "system" fn focus_event(
    _: HWINEVENTHOOK,
    _: u32,
    _: HWND,
    _: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    // Only a cancellation bit; never query or retain the event's target.
    FOCUS_CHANGED.store(true, Ordering::SeqCst);
}

fn start_focus_watch() -> Option<Arc<AtomicBool>> {
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = Arc::clone(&stop);
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || unsafe {
        let foreground = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            HMODULE::default(),
            Some(focus_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let focus = SetWinEventHook(
            EVENT_OBJECT_FOCUS,
            EVENT_OBJECT_FOCUS,
            HMODULE::default(),
            Some(focus_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let ready = !foreground.is_invalid() && !focus.is_invalid();
        let _ = tx.send(ready);
        let mut message = MSG::default();
        while ready && !stopped.load(Ordering::SeqCst) {
            while PeekMessageW(&mut message, HWND::default(), 0, 0, PM_REMOVE).as_bool() {
                DispatchMessageW(&message);
            }
            thread::sleep(Duration::from_millis(10));
        }
        if !focus.is_invalid() {
            let _ = UnhookWinEvent(focus);
        }
        if !foreground.is_invalid() {
            let _ = UnhookWinEvent(foreground);
        }
    });
    if rx.recv_timeout(Duration::from_secs(1)).ok() == Some(true) {
        Some(stop)
    } else {
        stop.store(true, Ordering::SeqCst);
        None
    }
}

type Range = IUIAutomationTextRange;
type End = TextPatternRangeEndpoint;
const START: End = TextPatternRangeEndpoint_Start;
const END: End = TextPatternRangeEndpoint_End;

unsafe fn compare(a: &Range, ae: End, b: &Range, be: End) -> Option<i32> {
    a.CompareEndpoints(ae, b, be).ok()
}
unsafe fn move_exact(range: &Range, endpoint: End, count: i32) -> Option<()> {
    (range
        .MoveEndpointByUnit(endpoint, TextUnit_Character, count)
        .ok()?
        == count)
        .then_some(())
}
unsafe fn read_bounded(range: &Range, max: usize) -> Option<String> {
    // One extra UTF-16 unit detects overflow; never use GetText(-1).
    let text = range.GetText((max + 1) as i32).ok()?;
    if text.len() > max {
        return None;
    }
    String::from_utf16(text.as_wide()).ok()
}
unsafe fn selection(pattern: &IUIAutomationTextPattern) -> Option<Range> {
    let selection = pattern.GetSelection().ok()?;
    if selection.Length().ok()? != 1 {
        return None;
    }
    selection.GetElement(0).ok()
}
unsafe fn caret(pattern: &IUIAutomationTextPattern) -> Option<Range> {
    let range = selection(pattern)?;
    (compare(&range, START, &range, END)? == 0).then_some(range)
}

struct Observation {
    automation: IUIAutomation,
    element: IUIAutomationElement,
    pattern: IUIAutomationTextPattern,
    region: Range,
    left: Range,
    right: Range,
    left_text: String,
    right_text: String,
    target: HWND,
}

impl Observation {
    unsafe fn focused(&self) -> Option<()> {
        if FOCUS_CHANGED.load(Ordering::SeqCst) || GetForegroundWindow() != self.target {
            return None;
        }
        let current = self.automation.GetFocusedElement().ok()?;
        if !self
            .automation
            .CompareElements(&current, &self.element)
            .ok()?
            .as_bool()
            || current.CurrentIsPassword().ok()?.as_bool()
            || !current.CurrentHasKeyboardFocus().ok()?.as_bool()
            || !current.CurrentIsEnabled().ok()?.as_bool()
            || current.CurrentIsOffscreen().ok()?.as_bool()
        {
            return None;
        }
        Some(())
    }

    unsafe fn anchor(request: &Request) -> Option<Self> {
        let numeric = request.target.parse::<isize>().ok()?;
        if numeric <= 0 || numeric.to_string() != request.target {
            return None;
        }
        let target = HWND(numeric as *mut _);
        if GetForegroundWindow() != target || FOCUS_CHANGED.load(Ordering::SeqCst) {
            return None;
        }
        let (left_text, right_text) = guards(&request.text)?;
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let element = automation.GetFocusedElement().ok()?;
        let role = element.CurrentControlType().ok()?;
        if role != UIA_EditControlTypeId && role != UIA_DocumentControlTypeId {
            return None;
        }
        // Establish membership BEFORE reading text. Browser renderer PIDs can
        // differ; inspect bounded ancestor metadata, never ancestor text.
        let walker = automation.RawViewWalker().ok()?;
        let mut ancestor = element.clone();
        let mut belongs = false;
        for _ in 0..64 {
            if ancestor.CurrentIsPassword().ok()?.as_bool() {
                return None;
            }
            let native = ancestor.CurrentNativeWindowHandle().ok()?;
            if !native.is_invalid() && GetAncestor(native, GA_ROOT) == target {
                belongs = true;
                break;
            }
            ancestor = walker.GetParentElement(&ancestor).ok()?;
        }
        if !belongs
            || !element.CurrentHasKeyboardFocus().ok()?.as_bool()
            || !element.CurrentIsEnabled().ok()?.as_bool()
            || element.CurrentIsOffscreen().ok()?.as_bool()
        {
            return None;
        }
        let pattern = element
            .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .ok()?;
        let insertion_end = caret(&pattern)?;
        let region = insertion_end.Clone().ok()?;
        move_exact(
            &region,
            START,
            -(request.text.encode_utf16().count() as i32),
        )?;
        // Reject read-only or mixed/unsupported attributes before any text read.
        let read_only = region.GetAttributeValue(UIA_IsReadOnlyAttributeId).ok()?;
        if bool::try_from(&read_only).ok()? {
            return None;
        }
        // Exact comparison rejects provider character-unit/newline differences,
        // still-selected replacements, and caret races. No document-wide search.
        if GetForegroundWindow() != target
            || FOCUS_CHANGED.load(Ordering::SeqCst)
            || read_bounded(&region, request.text.encode_utf16().count())? != request.text
        {
            return None;
        }
        let left = region.Clone().ok()?;
        left.MoveEndpointByRange(END, &region, START).ok()?;
        move_exact(&left, END, left_text.encode_utf16().count() as i32)?;
        let right = region.Clone().ok()?;
        right.MoveEndpointByRange(START, &region, END).ok()?;
        move_exact(&right, START, -(right_text.encode_utf16().count() as i32))?;
        let watch = Self {
            automation,
            element,
            pattern,
            region,
            left,
            right,
            left_text,
            right_text,
            target,
        };
        watch.focused()?;
        let (current, _) = watch.sample(&request.text)?;
        if current != request.text {
            return None;
        }
        Some(watch)
    }

    unsafe fn sample(&self, before: &str) -> Option<(String, Range)> {
        self.focused()?;
        let selection = selection(&self.pattern)?;
        let read_only = self
            .region
            .GetAttributeValue(UIA_IsReadOnlyAttributeId)
            .ok()?;
        if bool::try_from(&read_only).ok()? {
            return None;
        }
        // Independent cloned guards must preserve their boundaries and order.
        // Dropped, expanded, collapsed, or inconsistently shifted ranges fail.
        if compare(&self.region, START, &self.left, START)? != 0
            || compare(&self.region, END, &self.right, END)? != 0
            || compare(&self.left, END, &self.right, START)? >= 0
            || compare(&selection, START, &self.region, START)? < 0
            || compare(&selection, END, &self.region, END)? > 0
        {
            return None;
        }
        for range in [&self.region, &self.left, &self.right] {
            let owner = range.GetEnclosingElement().ok()?;
            if !self
                .automation
                .CompareElements(&owner, &self.element)
                .ok()?
                .as_bool()
            {
                return None;
            }
        }
        if read_bounded(&self.left, self.left_text.encode_utf16().count())? != self.left_text
            || read_bounded(&self.right, self.right_text.encode_utf16().count())? != self.right_text
        {
            return None;
        }
        let limit = (before.encode_utf16().count() + 256).min(MAX_TEXT);
        let current = read_bounded(&self.region, limit)?;
        if !candidate_valid(before, &current, &self.left_text, &self.right_text) {
            return None;
        }
        // Changed text needs a caret inside the mutable interior. Appending a
        // message, typing beyond the insertion, and boundary edits stop the watch.
        let collapsed = compare(&selection, START, &selection, END)? == 0;
        if (current != before || !collapsed)
            && (compare(&selection, START, &self.left, END)? < 0
                || compare(&selection, END, &self.right, START)? > 0)
        {
            return None;
        }
        self.focused()?;
        Some((current, selection))
    }
}

#[derive(Default)]
struct IdleCandidate {
    value: Option<String>,
    since: Option<Instant>,
}
impl IdleCandidate {
    fn update(&mut self, before: &str, current: &str, caret_unchanged: bool, now: Instant) -> bool {
        if before == current {
            self.value = None;
            self.since = None;
            return false;
        }
        if self.value.as_deref() != Some(current) || !caret_unchanged {
            self.value = Some(current.to_owned());
            self.since = Some(now);
        }
        self.since
            .is_some_and(|since| now.duration_since(since) >= IDLE)
    }
}

pub fn run() {
    // Hard watchdog bounds blocked UIA providers and stdin independently. This
    // disposable mode owns no recording/file state, so forced exit is intentional.
    let started = Instant::now();
    let limit = Arc::new(AtomicU64::new(45_000));
    let gone = Arc::new(AtomicBool::new(false));
    let watchdog_limit = Arc::clone(&limit);
    let watchdog_gone = Arc::clone(&gone);
    thread::spawn(move || loop {
        if watchdog_gone.load(Ordering::SeqCst)
            || started.elapsed().as_millis() >= watchdog_limit.load(Ordering::SeqCst) as u128
        {
            std::process::exit(0);
        }
        thread::sleep(Duration::from_millis(20));
    });
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut payload = Vec::new();
        let valid = (&mut input)
            .take(MAX_PAYLOAD + 1)
            .read_until(b'\n', &mut payload)
            .is_ok()
            && payload.len() <= MAX_PAYLOAD as usize
            && payload.last() == Some(&b'\n');
        let request = if valid {
            serde_json::from_slice::<Request>(&payload).ok()
        } else {
            None
        };
        let _ = tx.send(request);
        // No further commands. EOF/extra input cancels, even during a UIA call.
        let mut extra = [0_u8; 1];
        let _ = input.read(&mut extra);
        gone.store(true, Ordering::SeqCst);
    });
    let Some(request) = rx.recv().ok().flatten() else {
        status("unsupported");
        return;
    };
    if !valid_text(&request.text) || request.timeout_ms == 0 || request.timeout_ms > 45_000 {
        status("unsupported");
        return;
    }
    limit.store(request.timeout_ms, Ordering::SeqCst);
    let Some(focus_stop) = start_focus_watch() else {
        status("unsupported");
        return;
    };
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            status("unsupported");
            return;
        }
        match Observation::anchor(&request) {
            None => status("unsupported"),
            Some(watch) => {
                status("observing");
                let mut idle = IdleCandidate::default();
                let mut previous_caret: Option<Range> = None;
                while started.elapsed().as_millis() < request.timeout_ms as u128 {
                    thread::sleep(POLL);
                    if watch.focused().is_none() {
                        status("focus-changed");
                        break;
                    }
                    let Some((current, selection)) = watch.sample(&request.text) else {
                        status("range-invalidated");
                        break;
                    };
                    // Selecting a word is normal correction behavior. Wait while
                    // the single selection stays inside the immutable guards.
                    if compare(&selection, START, &selection, END) != Some(0) {
                        idle = IdleCandidate::default();
                        previous_caret = None;
                        continue;
                    }
                    let unchanged = previous_caret.as_ref().is_some_and(|old| {
                        selection.Compare(old).ok().is_some_and(|v| v.as_bool())
                    });
                    if idle.update(&request.text, &current, unchanged, Instant::now()) {
                        // Final read and focus check before the sole emission.
                        if let Some((final_text, final_caret)) = watch.sample(&request.text) {
                            if final_text == current
                                && final_caret
                                    .Compare(&selection)
                                    .ok()
                                    .is_some_and(|v| v.as_bool())
                            {
                                emit(
                                    serde_json::json!({"type": "correction", "before": request.text, "after": final_text}),
                                );
                            }
                        }
                        break;
                    }
                    previous_caret = selection.Clone().ok();
                }
            }
        }
    }
    focus_stop.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    const BEFORE: &str = "Keep this wrong word safely.";
    const AFTER: &str = "Keep this right word safely.";

    #[test]
    fn boundary_and_ambiguity_checks() {
        let (left, right) = guards(BEFORE).unwrap();
        assert!(candidate_valid(BEFORE, AFTER, &left, &right));
        for value in [
            "",
            "Other unrelated document",
            "Keep this wrong word safely. appended",
            "Keepely.",
        ] {
            assert!(!candidate_valid(BEFORE, value, &left, &right));
        }
        assert!(guards("short").is_none());
        assert!(guards("same same same same").is_none());
        assert!(!candidate_valid(
            BEFORE,
            "Keep Keep new content safely.",
            &left,
            &right
        ));
        assert!(guards(
            "\u{4e2d}\u{6587}\u{5f00}\u{5934}some incorrect word\u{4e2d}\u{6587}\u{7ed3}\u{5c3e}"
        )
        .is_some());
    }

    #[test]
    fn debounce_resets_on_typing_caret_motion_and_revert() {
        let t = Instant::now();
        let mut idle = IdleCandidate::default();
        assert!(!idle.update(BEFORE, AFTER, true, t));
        assert!(!idle.update(BEFORE, AFTER, true, t + Duration::from_millis(1900)));
        assert!(!idle.update(BEFORE, AFTER, false, t + IDLE));
        assert!(!idle.update(BEFORE, "Keep this newer word safely.", true, t + IDLE * 2));
        assert!(!idle.update(BEFORE, BEFORE, true, t + IDLE * 3));
        assert!(!idle.update(BEFORE, AFTER, true, t + IDLE * 4));
        assert!(idle.update(BEFORE, AFTER, true, t + IDLE * 5));
    }

    #[test]
    fn bounded_text_and_strict_request() {
        assert!(!valid_text("\0"));
        assert!(!valid_text(&"x".repeat(MAX_TEXT + 1)));
        assert!(!valid_text(&"\u{1f600}".repeat(MAX_TEXT / 2 + 1)));
        assert!(serde_json::from_str::<Request>(
            r#"{"target":"1","text":"test","timeoutMs":1,"extra":true}"#
        )
        .is_err());
    }
}
