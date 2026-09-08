//! Stage 0A parent-death safety.
//!
//! Do NOT put the helper into a KILL_ON_JOB_CLOSE job and then try to add the
//! Electron parent: if AssignProcessToJobObject(parent) fails and the job handle
//! is closed, the helper would be killed.
//!
//! Stage 0A strategy:
//! - jobObject is always false for parent binding (not used for parent).
//! - parent PID polling watcher requests shutdown when the parent disappears.
//! - stdin EOF is the primary lifecycle signal from the supervisor.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct ParentBindReport {
    pub job_object: bool,
    pub parent_watcher: bool,
    pub note: String,
}

/// Stage 0A: never assign parent into a kill-on-close job with self.
pub fn configure_parent_policy(parent_pid: Option<u32>) -> ParentBindReport {
    if parent_pid.is_some() {
        ParentBindReport {
            job_object: false,
            parent_watcher: true,
            note: "Stage 0A uses parent PID polling + stdin EOF; Job Object parent bind disabled (Electron often already in a job; failed parent assign must not kill helper)".to_string(),
        }
    } else {
        ParentBindReport {
            job_object: false,
            parent_watcher: false,
            note: "no parent_pid; rely on stdin EOF only".to_string(),
        }
    }
}

pub fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };
        unsafe {
            let handle = match OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                pid,
            ) {
                Ok(h) => h,
                Err(_) => return false,
            };
            let wait = WaitForSingleObject(handle, 0);
            let _ = CloseHandle(handle);
            wait == WAIT_TIMEOUT
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        true
    }
}

/// Background watcher: when parent PID is gone, set `parent_gone` true.
/// Drop only stops the watcher thread; it does not set parent_gone.
pub struct ParentWatcher {
    thread_stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl ParentWatcher {
    pub fn start(parent_pid: u32, parent_gone: Arc<AtomicBool>, interval_ms: u64) -> Self {
        let thread_stop = Arc::new(AtomicBool::new(false));
        let thread_stop_t = Arc::clone(&thread_stop);
        let join = thread::Builder::new()
            .name("parent-pid-watch".into())
            .spawn(move || {
                let interval = Duration::from_millis(interval_ms.max(100));
                while !thread_stop_t.load(Ordering::SeqCst) {
                    if !process_alive(parent_pid) {
                        eprintln!(
                            "audio-capture-helper: parent pid {parent_pid} gone; requesting stop"
                        );
                        parent_gone.store(true, Ordering::SeqCst);
                        break;
                    }
                    thread::sleep(interval);
                }
            })
            .ok();
        Self { thread_stop, join }
    }
}

impl Drop for ParentWatcher {
    fn drop(&mut self) {
        self.thread_stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
    }
}
