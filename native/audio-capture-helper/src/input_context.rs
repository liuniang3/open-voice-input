use std::io::{self, Write};
use windows::Win32::Foundation::{BOOL, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Ole::{SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::*;

fn rect_json(rect: RECT) -> serde_json::Value {
    serde_json::json!({ "x": rect.left, "y": rect.top,
        "width": rect.right - rect.left, "height": rect.bottom - rect.top })
}

unsafe fn range_rect(range: &IUIAutomationTextRange) -> Option<RECT> {
    let array = range.GetBoundingRectangles().ok()?;
    if array.is_null() { return None; }
    let result = (|| {
        let lower = SafeArrayGetLBound(array, 1).ok()?;
        let upper = SafeArrayGetUBound(array, 1).ok()?;
        if upper - lower < 3 { return None; }
        let mut values = [0.0_f64; 4];
        for (offset, value) in values.iter_mut().enumerate() {
            let index = lower + offset as i32;
            SafeArrayGetElement(array, &index, (value as *mut f64).cast()).ok()?;
        }
        if !values.iter().all(|v| v.is_finite() && v.abs() < 200000.0) || values[2] < 0.0 || values[3] <= 0.0 {
            return None;
        }
        Some(RECT { left: values[0].round() as i32, top: values[1].round() as i32,
            right: (values[0] + values[2]).round() as i32,
            bottom: (values[1] + values[3]).round() as i32 })
    })();
    let _ = SafeArrayDestroy(array);
    result
}

unsafe fn automation_rect(hwnd: HWND) -> Option<(RECT, &'static str)> {
    let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
    let focused = automation.GetFocusedElement().ok()?;
    // Browser accessibility elements may belong to a renderer PID, not the foreground host PID.
    let walker = automation.RawViewWalker().ok()?;
    let mut ancestor = focused.clone();
    let mut same_window = false;
    for _ in 0..24 {
        if let Ok(native) = ancestor.CurrentNativeWindowHandle() {
            if !native.is_invalid() && GetAncestor(native, GA_ROOT) == GetAncestor(hwnd, GA_ROOT) {
                same_window = true;
                break;
            }
        }
        match walker.GetParentElement(&ancestor) {
            Ok(parent) => ancestor = parent,
            Err(_) => break,
        }
    }
    if !same_window || focused.CurrentIsPassword().ok()?.as_bool() ||
        focused.CurrentIsOffscreen().ok()?.as_bool() { return None; }
    if let Ok(pattern) = focused.GetCurrentPatternAs::<IUIAutomationTextPattern2>(UIA_TextPattern2Id) {
        let mut active = BOOL(0);
        if let Ok(range) = pattern.GetCaretRange(&mut active) {
            if active.as_bool() {
                if let Some(rect) = range_rect(&range) { return Some((rect, "caret")); }
            }
        }
    }
    if let Ok(pattern) = focused.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
        if let Ok(selection) = pattern.GetSelection() {
            if selection.Length().ok() == Some(1) {
                if let Ok(range) = selection.GetElement(0) {
                    let _ = range.MoveEndpointByRange(TextPatternRangeEndpoint_Start, &range, TextPatternRangeEndpoint_End);
                    if let Some(rect) = range_rect(&range) { return Some((rect, "caret")); }
                }
            }
        }
    }
    let role = focused.CurrentControlType().ok()?;
    if role == UIA_EditControlTypeId || role == UIA_DocumentControlTypeId {
        let rect = focused.CurrentBoundingRectangle().ok()?;
        if rect.right > rect.left && rect.bottom > rect.top { return Some((rect, "input")); }
    }
    None
}

pub fn print_context() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() { return; }
        let mut pid = 0;
        let thread = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut window = RECT::default();
        let window_rect = GetWindowRect(hwnd, &mut window).ok().map(|_| rect_json(window));
        let mut context = serde_json::json!({ "type": "input-context", "target": (hwnd.0 as usize).to_string(),
            "coordinateSpace": "physical", "windowRect": window_rect, "rect": null, "source": null });
        println!("{context}");
        let _ = io::stdout().flush();

        let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        let caret = if GetGUIThreadInfo(thread, &mut info).is_ok() && !info.hwndCaret.is_invalid() &&
            GetAncestor(info.hwndCaret, GA_ROOT) == GetAncestor(hwnd, GA_ROOT) &&
            info.rcCaret.bottom > info.rcCaret.top {
            let mut origin = POINT { x: info.rcCaret.left, y: info.rcCaret.top };
            if ClientToScreen(info.hwndCaret, &mut origin).as_bool() {
                Some((RECT { left: origin.x, top: origin.y,
                    right: origin.x + info.rcCaret.right - info.rcCaret.left,
                    bottom: origin.y + info.rcCaret.bottom - info.rcCaret.top }, "caret"))
            } else { None }
        } else { None };
        let anchor = caret.or_else(|| {
            if crate::capture::init_com().is_err() { return None; }
            // Chromium may enable its accessibility tree only after the first UIA query.
            for attempt in 0..4 {
                if GetForegroundWindow() != hwnd { return None; }
                if let Some(anchor) = automation_rect(hwnd) { return Some(anchor); }
                if attempt < 3 { std::thread::sleep(std::time::Duration::from_millis(50)); }
            }
            None
        });
        if GetForegroundWindow() == hwnd {
            if let Some((rect, source)) = anchor {
                context["rect"] = rect_json(rect);
                context["source"] = source.into();
            }
        }
        println!("{context}");
    }
}
