//! Bounded dual-track phase coordination (no unbounded Barrier wait).
//!
//! Phases: prepare → (shared origin) → start clients → commit recording → capture.
//! Abort is cooperative: coordinator sets abort; workers poll and exit without hanging.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Shared abort + optional generation for phase waits.
#[derive(Clone)]
pub struct AbortFlag {
    inner: Arc<AtomicBool>,
}

impl AbortFlag {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set(&self) {
        self.inner.store(true, Ordering::SeqCst);
    }

    pub fn is_set(&self) -> bool {
        self.inner.load(Ordering::SeqCst)
    }
}

/// One-shot phase signal: coordinator opens the gate; workers wait with timeout + abort poll.
pub struct PhaseGate {
    mu: Mutex<GateState>,
    cv: Condvar,
}

struct GateState {
    open: bool,
    aborted: bool,
}

impl PhaseGate {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            mu: Mutex::new(GateState {
                open: false,
                aborted: false,
            }),
            cv: Condvar::new(),
        })
    }

    pub fn open(&self) {
        let mut g = self.mu.lock().unwrap_or_else(|e| e.into_inner());
        g.open = true;
        self.cv.notify_all();
    }

    pub fn abort(&self) {
        let mut g = self.mu.lock().unwrap_or_else(|e| e.into_inner());
        g.aborted = true;
        g.open = true; // wake waiters
        self.cv.notify_all();
    }

    /// Wait until open or abort. Returns Ok(()) if opened cleanly, Err if aborted/timeout.
    pub fn wait(&self, timeout: Duration, abort: &AbortFlag) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut g = self.mu.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if g.aborted || abort.is_set() {
                return Err("phase_aborted".to_string());
            }
            if g.open {
                return Ok(());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("phase_wait_timeout".to_string());
            }
            let slice = (deadline - now).min(Duration::from_millis(50));
            let (guard, _) = self
                .cv
                .wait_timeout(g, slice)
                .unwrap_or_else(|e| e.into_inner());
            g = guard;
        }
    }
}

pub fn recv_timeout_abort<T>(
    rx: &Receiver<T>,
    timeout: Duration,
    abort: &AbortFlag,
) -> Result<T, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if abort.is_set() {
            return Err("aborted".to_string());
        }
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            return Err("recv_timeout".to_string());
        }
        let slice = remain.min(Duration::from_millis(50));
        match rx.recv_timeout(slice) {
            Ok(v) => return Ok(v),
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return Err("channel_disconnected".to_string());
            }
        }
    }
}

/// Join a handle with timeout; on timeout returns Err and detaches (thread may exit via abort).
pub fn join_timeout<T: Send + 'static>(
    handle: JoinHandle<T>,
    timeout: Duration,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    let watcher = thread::spawn(move || {
        let r = handle.join();
        let _ = tx.send(r);
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(v)) => {
            let _ = watcher.join();
            Ok(v)
        }
        Ok(Err(_)) => {
            let _ = watcher.join();
            Err("thread_panicked".to_string())
        }
        Err(_) => Err("join_timeout".to_string()),
    }
}

/// Test-only: hang prepare until abort (env OVI_TEST_HANG_PREPARE=microphone|system|both).
pub fn test_hang_prepare_if_configured(track: &str, abort: &AbortFlag) {
    let key = std::env::var("OVI_TEST_HANG_PREPARE").unwrap_or_default();
    if key.is_empty() {
        return;
    }
    let key = key.to_ascii_lowercase();
    let hit = key == "both"
        || key == track
        || (key == "mic" && track == "microphone")
        || (key == "sys" && track == "system");
    if !hit {
        return;
    }
    // Bounded spin so a forgotten env cannot hang forever without abort.
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if abort.is_set() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_gate_timeout_returns() {
        let gate = PhaseGate::new();
        let abort = AbortFlag::new();
        let err = gate
            .wait(Duration::from_millis(80), &abort)
            .unwrap_err();
        assert!(err.contains("timeout") || err.contains("phase"));
    }

    #[test]
    fn phase_gate_abort_wakes() {
        let gate = PhaseGate::new();
        let abort = AbortFlag::new();
        let g2 = Arc::clone(&gate);
        let a2 = abort.clone();
        let h = thread::spawn(move || g2.wait(Duration::from_secs(5), &a2));
        thread::sleep(Duration::from_millis(30));
        abort.set();
        gate.abort();
        let r = h.join().unwrap();
        assert!(r.is_err());
    }

    #[test]
    fn join_timeout_bounded() {
        let h = thread::spawn(|| {
            thread::sleep(Duration::from_secs(30));
            1
        });
        let err = join_timeout(h, Duration::from_millis(50)).unwrap_err();
        assert!(err.contains("timeout"));
    }
}
