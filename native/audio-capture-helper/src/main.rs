//! Stage 0B audio-capture-helper
//!
//! Dual-track WASAPI shared-mode: microphone + device-level render loopback.
//! No process loopback. No cpal. No ASR.
//! stdout = JSONL protocol only. stderr = logs only.
//!
//! Parent death: stdin EOF + parent PID polling. Job Object parent bind is disabled.

mod capture;
mod dual_sync;
mod job;
mod persist;
mod protocol;
mod session_guard;

use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use protocol::{
    encode_line, error_result, ok_result, parse_line, stage0b_capabilities, stage0b_notes, Command,
    Event, HELPER_NAME, HELPER_VERSION, PROTOCOL_VERSION,
};
use session_guard::SessionRootGuard;

struct AppState {
    session_root: Mutex<Option<SessionRootGuard>>,
    parent_pid: Mutex<Option<u32>>,
    capture: Mutex<Option<capture::CaptureSession>>,
    parent_watcher: Mutex<Option<job::ParentWatcher>>,
    shutting_down: AtomicBool,
    parent_gone: Arc<AtomicBool>,
}

fn main() {
    if let Err(err) = capture::init_com() {
        eprintln!("audio-capture-helper: COM init failed: {err}");
        std::process::exit(2);
    }

    let parent_gone = Arc::new(AtomicBool::new(false));
    let state = Arc::new(AppState {
        session_root: Mutex::new(None),
        parent_pid: Mutex::new(None),
        capture: Mutex::new(None),
        parent_watcher: Mutex::new(None),
        shutting_down: AtomicBool::new(false),
        parent_gone: Arc::clone(&parent_gone),
    });

    emit_event(Event::Hello {
        name: HELPER_NAME.to_string(),
        version: HELPER_VERSION.to_string(),
        protocol_version: PROTOCOL_VERSION,
        capabilities: stage0b_capabilities(),
        notes: stage0b_notes(),
    });

    let state_stdin = Arc::clone(&state);
    let stdin_thread = thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            if state_stdin.shutting_down.load(Ordering::SeqCst)
                || state_stdin.parent_gone.load(Ordering::SeqCst)
            {
                break;
            }
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match parse_line(line) {
                Ok(cmd) => handle_command(&state_stdin, cmd),
                Err(err) => {
                    emit_event(Event::Error {
                        id: None,
                        code: "parse_error".to_string(),
                        message: err,
                    });
                }
            }
        }
        state_stdin.shutting_down.store(true, Ordering::SeqCst);
    });

    while !state.shutting_down.load(Ordering::SeqCst) {
        if state.parent_gone.load(Ordering::SeqCst) {
            eprintln!("audio-capture-helper: parent gone; stopping capture and exiting");
            break;
        }
        thread::sleep(Duration::from_millis(50));
        if stdin_thread.is_finished() {
            break;
        }
    }

    state.shutting_down.store(true, Ordering::SeqCst);
    if let Ok(mut guard) = state.capture.lock() {
        if let Some(session) = guard.take() {
            let _ = session.stop();
        }
    }
    if let Ok(mut w) = state.parent_watcher.lock() {
        *w = None;
    }
    let _ = stdin_thread.join();
}

fn handle_command(state: &Arc<AppState>, cmd: Command) {
    match cmd {
        Command::Hello { id } => {
            emit_ack(&id, "hello");
            emit_result(
                &id,
                ok_result(serde_json::json!({
                    "name": HELPER_NAME,
                    "version": HELPER_VERSION,
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": stage0b_capabilities()
                })),
            );
        }
        Command::Ping { id } => {
            emit_ack(&id, "ping");
            emit_result(&id, ok_result(serde_json::json!({ "pong": true })));
        }
        Command::QueryDevices { id } => {
            emit_ack(&id, "query_devices");
            match capture::list_devices() {
                Ok(lists) => emit_result(
                    &id,
                    ok_result(serde_json::json!({
                        "capture": lists.capture,
                        "render": lists.render,
                        "devices": lists.devices
                    })),
                ),
                Err(err) => {
                    emit_result(&id, error_result("device_enum_failed", &err.to_string()))
                }
            }
        }
        Command::Configure {
            id,
            session_root,
            parent_pid,
        } => {
            emit_ack(&id, "configure");
            match SessionRootGuard::new(&session_root) {
                Ok(guard) => {
                    if let Ok(mut slot) = state.session_root.lock() {
                        *slot = Some(guard);
                    }
                    if let Ok(mut slot) = state.parent_pid.lock() {
                        *slot = parent_pid;
                    }

                    if let Ok(mut slot) = state.parent_watcher.lock() {
                        *slot = None;
                    }
                    state.parent_gone.store(false, Ordering::SeqCst);

                    let report = job::configure_parent_policy(parent_pid);
                    if let Some(pid) = parent_pid {
                        if report.parent_watcher {
                            let watcher =
                                job::ParentWatcher::start(pid, Arc::clone(&state.parent_gone), 500);
                            if let Ok(mut slot) = state.parent_watcher.lock() {
                                *slot = Some(watcher);
                            }
                        }
                    }

                    emit_result(
                        &id,
                        ok_result(serde_json::json!({
                            "configured": true,
                            "jobObject": report.job_object,
                            "parentWatcher": report.parent_watcher,
                            "note": report.note
                        })),
                    );
                }
                Err(err) => emit_result(&id, error_result("invalid_session_root", &err)),
            }
        }
        Command::Start {
            id,
            session_id,
            capture_mode,
            track,
            device_id,
            output_dir,
            subchunk_ms,
            microphone,
            system,
        } => {
            emit_ack(&id, "start");
            let root_guard = state.session_root.lock().ok();
            let root = match root_guard.as_ref().and_then(|g| g.as_ref()) {
                Some(r) => r,
                None => {
                    emit_result(
                        &id,
                        error_result("not_configured", "configure session_root first"),
                    );
                    return;
                }
            };

            let mode = capture_mode
                .as_deref()
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    if microphone.is_some() && system.is_some() {
                        "dual".to_string()
                    } else {
                        "microphone".to_string()
                    }
                });

            let sub_ms = subchunk_ms.unwrap_or(1000);

            if mode == "dual" {
                let mic_spec = match &microphone {
                    Some(m) => m,
                    None => {
                        emit_result(
                            &id,
                            error_result(
                                "invalid_start",
                                "capture_mode=dual requires microphone{device_id,output_dir}",
                            ),
                        );
                        return;
                    }
                };
                let sys_spec = match &system {
                    Some(s) => s,
                    None => {
                        emit_result(
                            &id,
                            error_result(
                                "invalid_start",
                                "capture_mode=dual requires system{device_id,output_dir}",
                            ),
                        );
                        return;
                    }
                };

                let mic_out = match root.resolve_under_root(&mic_spec.output_dir) {
                    Ok(p) => p,
                    Err(err) => {
                        emit_result(&id, error_result("path_denied", &err));
                        return;
                    }
                };
                let sys_out = match root.resolve_under_root(&sys_spec.output_dir) {
                    Ok(p) => p,
                    Err(err) => {
                        emit_result(&id, error_result("path_denied", &err));
                        return;
                    }
                };
                drop(root_guard);

                // Short lock: check busy / idempotent only
                {
                    let slot = match state.capture.lock() {
                        Ok(g) => g,
                        Err(_) => {
                            emit_result(&id, error_result("internal", "capture lock poisoned"));
                            return;
                        }
                    };
                    if let Some(existing) = slot.as_ref() {
                        if existing.matches_dual(&session_id, &mic_out, &sys_out) {
                            emit_result(
                                &id,
                                ok_result(serde_json::json!({
                                    "started": true,
                                    "idempotent": true,
                                    "sessionId": session_id,
                                    "captureMode": "dual"
                                })),
                            );
                            return;
                        }
                        emit_result(
                            &id,
                            error_result(
                                "already_capturing",
                                &format!(
                                    "capture already active for session {}",
                                    existing.session_id
                                ),
                            ),
                        );
                        return;
                    }
                }

                // Heavy work outside capture mutex
                match capture::CaptureSession::start_dual(capture::DualStartParams {
                    session_id: session_id.clone(),
                    microphone: capture::TrackParams {
                        device_id: mic_spec.device_id.clone(),
                        output_dir: mic_out,
                    },
                    system: capture::TrackParams {
                        device_id: sys_spec.device_id.clone(),
                        output_dir: sys_out,
                    },
                    subchunk_ms: sub_ms,
                    progress: Some(make_progress_fn()),
                }) {
                    Ok(session) => {
                        let info = session.info_json();
                        if let Ok(mut slot) = state.capture.lock() {
                            if slot.is_some() {
                                // Race: another start won; stop ours
                                let _ = session.stop();
                                emit_result(
                                    &id,
                                    error_result("already_capturing", "capture became active"),
                                );
                                return;
                            }
                            *slot = Some(session);
                        }
                        emit_result(&id, ok_result(info));
                    }
                    Err(err) => emit_result(&id, error_result("start_failed", &err)),
                }
                return;
            }

            // microphone-only (0A compat)
            if track != "microphone" && mode != "microphone" {
                emit_result(
                    &id,
                    error_result(
                        "unsupported_track",
                        "use capture_mode=dual with microphone+system, or track=microphone",
                    ),
                );
                return;
            }

            let out_str = if let Some(m) = &microphone {
                m.output_dir.clone()
            } else if let Some(o) = output_dir {
                o
            } else {
                emit_result(
                    &id,
                    error_result("invalid_start", "output_dir or microphone.output_dir required"),
                );
                return;
            };
            let mic_device = microphone
                .as_ref()
                .and_then(|m| m.device_id.clone())
                .or(device_id);

            let out = match root.resolve_under_root(&out_str) {
                Ok(p) => p,
                Err(err) => {
                    emit_result(&id, error_result("path_denied", &err));
                    return;
                }
            };
            drop(root_guard);

            {
                let slot = match state.capture.lock() {
                    Ok(g) => g,
                    Err(_) => {
                        emit_result(&id, error_result("internal", "capture lock poisoned"));
                        return;
                    }
                };
                if let Some(existing) = slot.as_ref() {
                    if existing.matches_mic(&session_id, &out) {
                        emit_result(
                            &id,
                            ok_result(serde_json::json!({
                                "started": true,
                                "idempotent": true,
                                "sessionId": session_id
                            })),
                        );
                        return;
                    }
                    emit_result(
                        &id,
                        error_result(
                            "already_capturing",
                            &format!(
                                "capture already active for session {}",
                                existing.session_id
                            ),
                        ),
                    );
                    return;
                }
            }
            match capture::CaptureSession::start_mic_only(capture::MicOnlyStartParams {
                session_id: session_id.clone(),
                device_id: mic_device,
                output_dir: out,
                subchunk_ms: sub_ms,
                progress: Some(make_progress_fn()),
            }) {
                Ok(session) => {
                    let info = session.info_json();
                    if let Ok(mut slot) = state.capture.lock() {
                        if slot.is_some() {
                            let _ = session.stop();
                            emit_result(
                                &id,
                                error_result("already_capturing", "capture became active"),
                            );
                            return;
                        }
                        *slot = Some(session);
                    }
                    emit_result(&id, ok_result(info));
                }
                Err(err) => emit_result(&id, error_result("start_failed", &err)),
            }
        }
        Command::Pause { id } => {
            emit_ack(&id, "pause");
            let mut slot = match state.capture.lock() {
                Ok(g) => g,
                Err(_) => {
                    emit_result(&id, error_result("internal", "capture lock poisoned"));
                    return;
                }
            };
            match slot.as_mut() {
                Some(session) => match session.pause() {
                    Ok(info) => emit_result(&id, ok_result(info)),
                    Err(err) => emit_result(&id, error_result("pause_failed", &err.to_string())),
                },
                None => emit_result(&id, error_result("not_started", "no active capture")),
            }
        }
        Command::Resume { id } => {
            emit_ack(&id, "resume");
            let mut slot = match state.capture.lock() {
                Ok(g) => g,
                Err(_) => {
                    emit_result(&id, error_result("internal", "capture lock poisoned"));
                    return;
                }
            };
            match slot.as_mut() {
                Some(session) => match session.resume() {
                    Ok(info) => emit_result(&id, ok_result(info)),
                    Err(err) => emit_result(&id, error_result("resume_failed", &err.to_string())),
                },
                None => emit_result(&id, error_result("not_started", "no active capture")),
            }
        }
        Command::Stop { id } => {
            emit_ack(&id, "stop");
            let session = {
                let mut slot = match state.capture.lock() {
                    Ok(g) => g,
                    Err(_) => {
                        emit_result(&id, error_result("internal", "capture lock poisoned"));
                        return;
                    }
                };
                slot.take()
            };
            match session {
                Some(session) => match session.stop() {
                    Ok(info) => emit_result(&id, ok_result(info)),
                    Err(err) => emit_result(&id, error_result("stop_failed", &err.to_string())),
                },
                None => emit_result(
                    &id,
                    ok_result(serde_json::json!({ "stopped": true, "idempotent": true })),
                ),
            }
        }
        Command::Shutdown { id } => {
            emit_ack(&id, "shutdown");
            state.shutting_down.store(true, Ordering::SeqCst);
            if let Ok(mut slot) = state.capture.lock() {
                if let Some(session) = slot.take() {
                    let _ = session.stop();
                }
            }
            emit_result(&id, ok_result(serde_json::json!({ "shutdown": true })));
        }
    }
}

fn emit_ack(id: &str, command: &str) {
    emit_event(Event::Ack {
        id: id.to_string(),
        command: command.to_string(),
    });
}

fn emit_result(id: &str, result: serde_json::Value) {
    emit_event(Event::Result {
        id: id.to_string(),
        result,
    });
}

fn emit_event(event: Event) {
    let line = encode_line(&event);
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn make_progress_fn() -> capture::ProgressFn {
    use std::sync::Arc;
    Arc::new(
        |session_id: String, track: String, event: String, detail: serde_json::Value| {
            emit_event(Event::Progress {
                session_id,
                track,
                event,
                detail,
            });
        },
    )
}
