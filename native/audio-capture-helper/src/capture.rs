//! Stage 0B WASAPI dual-track capture.
//!
//! COM objects stay on each worker thread. Dual start uses bounded PhaseGates
//! (no unbounded Barrier wait). Pause journal is begin/end only.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::{
    eCapture, eMultimedia, eRender, IAudioCaptureClient, IAudioClient, IAudioClock, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

use crate::dual_sync::{
    join_timeout, recv_timeout_abort, test_hang_prepare_if_configured, AbortFlag, PhaseGate,
};
use crate::persist::{ChunkTiming, L0Format, TrackWriter};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;

const PHASE_TIMEOUT: Duration = Duration::from_secs(15);
const JOIN_TIMEOUT: Duration = Duration::from_secs(5);

pub type ProgressFn = Arc<dyn Fn(String, String, String, serde_json::Value) + Send + Sync>;

pub fn init_com() -> Result<(), String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| format!("CoInitializeEx: {e}"))
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceLists {
    pub capture: Vec<DeviceInfo>,
    pub render: Vec<DeviceInfo>,
    pub devices: Vec<DeviceInfo>,
}

pub fn list_devices() -> Result<DeviceLists, String> {
    unsafe {
        let _com = ComGuard::new()?;
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("MMDeviceEnumerator: {e}"))?;
        let capture = enum_flow(&enumerator, eCapture, "capture")?;
        let render = enum_flow(&enumerator, eRender, "render")?;
        let devices = capture.clone();
        Ok(DeviceLists {
            capture,
            render,
            devices,
        })
    }
}

pub fn list_capture_devices() -> Result<Vec<DeviceInfo>, String> {
    Ok(list_devices()?.capture)
}

unsafe fn enum_flow(
    enumerator: &IMMDeviceEnumerator,
    flow: windows::Win32::Media::Audio::EDataFlow,
    flow_name: &str,
) -> Result<Vec<DeviceInfo>, String> {
    let default_id = enumerator
        .GetDefaultAudioEndpoint(flow, eMultimedia)
        .ok()
        .and_then(|d| device_id_str(&d).ok());
    let collection = enumerator
        .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
        .map_err(|e| format!("EnumAudioEndpoints({flow_name}): {e}"))?;
    let count = collection.GetCount().map_err(|e| format!("GetCount: {e}"))?;
    let mut out = Vec::new();
    for i in 0..count {
        let device = collection.Item(i).map_err(|e| format!("Item({i}): {e}"))?;
        let id = device_id_str(&device)?;
        let name = device_friendly_name(&device).unwrap_or_else(|_| {
            if flow_name == "render" {
                "Speakers".to_string()
            } else {
                "Microphone".to_string()
            }
        });
        let is_default = default_id.as_ref().map(|d| d == &id).unwrap_or(false);
        out.push(DeviceInfo {
            id,
            name,
            is_default,
            flow: Some(flow_name.to_string()),
        });
    }
    Ok(out)
}

struct ComGuard {
    active: bool,
}

impl ComGuard {
    fn new() -> Result<Self, String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| format!("CoInitializeEx: {e}"))?;
        }
        Ok(Self { active: true })
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.active {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct TrackParams {
    pub device_id: Option<String>,
    pub output_dir: PathBuf,
}

#[derive(Clone)]
pub struct DualStartParams {
    pub session_id: String,
    pub microphone: TrackParams,
    pub system: TrackParams,
    pub subchunk_ms: u64,
    pub progress: Option<ProgressFn>,
}

#[derive(Clone)]
pub struct MicOnlyStartParams {
    pub session_id: String,
    pub device_id: Option<String>,
    pub output_dir: PathBuf,
    pub subchunk_ms: u64,
    pub progress: Option<ProgressFn>,
}

enum SessionKind {
    Dual(DualInner),
    MicOnly(MicOnlyInner),
}

struct DualInner {
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    pause_gen: Arc<AtomicU64>,
    session_fault: Arc<AtomicBool>,
    abort: AbortFlag,
    mic_join: Option<JoinHandle<Result<serde_json::Value, String>>>,
    sys_join: Option<JoinHandle<Result<serde_json::Value, String>>>,
}

struct MicOnlyInner {
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    pause_gen: Arc<AtomicU64>,
    join: Option<JoinHandle<Result<serde_json::Value, String>>>,
}

pub struct CaptureSession {
    kind: SessionKind,
    info: serde_json::Value,
    pub session_id: String,
    pub output_dir: PathBuf,
    pub system_output_dir: Option<PathBuf>,
    pub capture_mode: String,
}

impl CaptureSession {
    pub fn start_dual(params: DualStartParams) -> Result<Self, String> {
        let session_id = params.session_id.clone();
        let mic_out = params.microphone.output_dir.clone();
        let sys_out = params.system.output_dir.clone();

        let stop_flag = Arc::new(AtomicBool::new(false));
        let pause_flag = Arc::new(AtomicBool::new(false));
        let pause_gen = Arc::new(AtomicU64::new(0));
        let session_fault = Arc::new(AtomicBool::new(false));
        let abort = AbortFlag::new();

        let shared_origin = Arc::new(Mutex::new(None::<SharedClock>));
        let prepare_gate = PhaseGate::new();
        let start_gate = PhaseGate::new();
        let commit_gate = PhaseGate::new();

        let (mic_ready_tx, mic_ready_rx) = mpsc::channel::<Result<TrackReadyInfo, String>>();
        let (sys_ready_tx, sys_ready_rx) = mpsc::channel::<Result<TrackReadyInfo, String>>();
        let (mic_started_tx, mic_started_rx) = mpsc::channel::<Result<(), String>>();
        let (sys_started_tx, sys_started_rx) = mpsc::channel::<Result<(), String>>();
        let (mic_commit_tx, mic_commit_rx) = mpsc::channel::<Result<(), String>>();
        let (sys_commit_tx, sys_commit_rx) = mpsc::channel::<Result<(), String>>();

        let progress = params.progress.clone();

        let mic_ctx = WorkerCtx {
            session_id: session_id.clone(),
            track: "microphone".to_string(),
            role: "self".to_string(),
            flow: TrackFlow::Capture,
            device_id: params.microphone.device_id.clone(),
            output_dir: mic_out.clone(),
            subchunk_ms: params.subchunk_ms,
            stop_flag: Arc::clone(&stop_flag),
            pause_flag: Arc::clone(&pause_flag),
            pause_gen: Arc::clone(&pause_gen),
            session_fault: Arc::clone(&session_fault),
            abort: abort.clone(),
            shared_origin: Arc::clone(&shared_origin),
            prepare_gate: Arc::clone(&prepare_gate),
            start_gate: Arc::clone(&start_gate),
            commit_gate: Arc::clone(&commit_gate),
            ready_tx: mic_ready_tx,
            started_tx: mic_started_tx,
            commit_tx: mic_commit_tx,
            progress: progress.clone(),
        };
        let sys_ctx = WorkerCtx {
            session_id: session_id.clone(),
            track: "system".to_string(),
            role: "remote_mix_for_diarization".to_string(),
            flow: TrackFlow::RenderLoopback,
            device_id: params.system.device_id.clone(),
            output_dir: sys_out.clone(),
            subchunk_ms: params.subchunk_ms,
            stop_flag: Arc::clone(&stop_flag),
            pause_flag: Arc::clone(&pause_flag),
            pause_gen: Arc::clone(&pause_gen),
            session_fault: Arc::clone(&session_fault),
            abort: abort.clone(),
            shared_origin: Arc::clone(&shared_origin),
            prepare_gate: Arc::clone(&prepare_gate),
            start_gate: Arc::clone(&start_gate),
            commit_gate: Arc::clone(&commit_gate),
            ready_tx: sys_ready_tx,
            started_tx: sys_started_tx,
            commit_tx: sys_commit_tx,
            progress: progress.clone(),
        };

        let mic_join = thread::Builder::new()
            .name("wasapi-mic".into())
            .spawn(move || run_track_worker(mic_ctx))
            .map_err(|e| format!("spawn mic worker: {e}"))?;

        let sys_join = match thread::Builder::new()
            .name("wasapi-system-loopback".into())
            .spawn(move || run_track_worker(sys_ctx))
        {
            Ok(h) => h,
            Err(e) => {
                abort.set();
                stop_flag.store(true, Ordering::SeqCst);
                prepare_gate.abort();
                start_gate.abort();
                commit_gate.abort();
                let _ = join_timeout(mic_join, JOIN_TIMEOUT);
                return Err(format!("spawn system worker: {e}"));
            }
        };

        // --- Prepare: wait both ready (bounded) ---
        let mic_ready = recv_timeout_abort(&mic_ready_rx, PHASE_TIMEOUT, &abort);
        let sys_ready = recv_timeout_abort(&sys_ready_rx, PHASE_TIMEOUT, &abort);
        let prepare_ok = matches!((&mic_ready, &sys_ready), (Ok(Ok(_)), Ok(Ok(_))));
        if !prepare_ok {
            let mic_err = flatten_err(&mic_ready);
            let sys_err = flatten_err(&sys_ready);
            abort.set();
            stop_flag.store(true, Ordering::SeqCst);
            prepare_gate.abort();
            start_gate.abort();
            commit_gate.abort();
            let _ = join_timeout(mic_join, JOIN_TIMEOUT);
            let _ = join_timeout(sys_join, JOIN_TIMEOUT);
            return Err(format!(
                "prepare failed mic={:?} system={:?}",
                mic_err, sys_err
            ));
        }
        let mic_info = mic_ready.unwrap().unwrap();
        let sys_info = sys_ready.unwrap().unwrap();

        let (origin_qpc, qpc_freq) = match qpc_now_and_freq() {
            Ok(v) => v,
            Err(e) => {
                abort.set();
                stop_flag.store(true, Ordering::SeqCst);
                prepare_gate.abort();
                start_gate.abort();
                commit_gate.abort();
                let _ = join_timeout(mic_join, JOIN_TIMEOUT);
                let _ = join_timeout(sys_join, JOIN_TIMEOUT);
                return Err(e);
            }
        };
        {
            let mut g = shared_origin.lock().map_err(|e| e.to_string())?;
            *g = Some(SharedClock {
                session_origin_qpc: origin_qpc,
                qpc_frequency: qpc_freq,
            });
        }
        prepare_gate.open();

        // --- Start clients ---
        let mic_started = recv_timeout_abort(&mic_started_rx, PHASE_TIMEOUT, &abort);
        let sys_started = recv_timeout_abort(&sys_started_rx, PHASE_TIMEOUT, &abort);
        if !matches!((&mic_started, &sys_started), (Ok(Ok(())), Ok(Ok(())))) {
            abort.set();
            stop_flag.store(true, Ordering::SeqCst);
            start_gate.abort();
            commit_gate.abort();
            let _ = join_timeout(mic_join, JOIN_TIMEOUT);
            let _ = join_timeout(sys_join, JOIN_TIMEOUT);
            return Err(format!(
                "start failed mic={:?} system={:?}",
                flatten_err(&mic_started),
                flatten_err(&sys_started)
            ));
        }
        start_gate.open();

        // --- Commit recording (both mark_recording) ---
        let mic_commit = recv_timeout_abort(&mic_commit_rx, PHASE_TIMEOUT, &abort);
        let sys_commit = recv_timeout_abort(&sys_commit_rx, PHASE_TIMEOUT, &abort);
        if !matches!((&mic_commit, &sys_commit), (Ok(Ok(())), Ok(Ok(())))) {
            abort.set();
            stop_flag.store(true, Ordering::SeqCst);
            commit_gate.abort();
            let _ = join_timeout(mic_join, JOIN_TIMEOUT);
            let _ = join_timeout(sys_join, JOIN_TIMEOUT);
            return Err(format!(
                "commit recording failed mic={:?} system={:?}",
                flatten_err(&mic_commit),
                flatten_err(&sys_commit)
            ));
        }
        commit_gate.open();

        let info = serde_json::json!({
            "started": true,
            "sessionId": session_id,
            "captureMode": "dual",
            "shareMode": "shared",
            "sessionOriginQpc": origin_qpc,
            "qpcFrequency": qpc_freq,
            "clockUnitNote": "GetBuffer/IAudioClock QPC are QPC ticks; Initialize REFERENCE_TIME is 100ns — do not mix. clockPos/qpc end fields are point samples not interpolated.",
            "archivePending": true,
            "microphone": {
                "track": "microphone",
                "role": "self",
                "deviceId": mic_info.device_id,
                "deviceName": mic_info.device_name,
                "outputDir": mic_out.display().to_string(),
                "actualL0Format": mic_info.format_json,
                "captureScope": "microphone"
            },
            "system": {
                "track": "system",
                "role": "remote_mix_for_diarization",
                "deviceId": sys_info.device_id,
                "deviceName": sys_info.device_name,
                "outputDir": sys_out.display().to_string(),
                "actualL0Format": sys_info.format_json,
                "captureScope": "endpoint_mix",
                "loopback": true,
                "processIsolation": false,
                "notes": [
                    "endpoint full mix including this app if playing",
                    "DRM content may be silent",
                    "no process loopback"
                ]
            },
            "funAsrReserved": {
                "microphoneRole": "self",
                "systemRole": "remote_mix_for_diarization",
                "apiNotCalled": true
            }
        });

        Ok(Self {
            kind: SessionKind::Dual(DualInner {
                stop_flag,
                pause_flag,
                pause_gen,
                session_fault,
                abort,
                mic_join: Some(mic_join),
                sys_join: Some(sys_join),
            }),
            info,
            session_id,
            output_dir: mic_out,
            system_output_dir: Some(sys_out),
            capture_mode: "dual".to_string(),
        })
    }

    pub fn start_mic_only(params: MicOnlyStartParams) -> Result<Self, String> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let pause_flag = Arc::new(AtomicBool::new(false));
        let pause_gen = Arc::new(AtomicU64::new(0));
        let session_id = params.session_id.clone();
        let output_dir = params.output_dir.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let stop_t = Arc::clone(&stop_flag);
        let pause_t = Arc::clone(&pause_flag);
        let pause_g = Arc::clone(&pause_gen);
        let progress = params.progress.clone();
        let sid = session_id.clone();
        let out = output_dir.clone();
        let sub = params.subchunk_ms;
        let dev = params.device_id.clone();

        let join = thread::Builder::new()
            .name("wasapi-mic-capture".into())
            .spawn(move || {
                run_mic_only_loop(sid, dev, out, sub, stop_t, pause_t, pause_g, ready_tx, progress)
            })
            .map_err(|e| format!("spawn capture thread: {e}"))?;

        let abort = AbortFlag::new();
        match recv_timeout_abort(&ready_rx, PHASE_TIMEOUT, &abort) {
            Ok(Ok(info_track)) => {
                let info = serde_json::json!({
                    "started": true,
                    "sessionId": session_id,
                    "captureMode": "microphone",
                    "track": "microphone",
                    "role": "self",
                    "deviceId": info_track.device_id,
                    "deviceName": info_track.device_name,
                    "outputDir": output_dir.display().to_string(),
                    "shareMode": "shared",
                    "actualL0Format": info_track.format_json,
                    "archivePending": true
                });
                Ok(Self {
                    kind: SessionKind::MicOnly(MicOnlyInner {
                        stop_flag,
                        pause_flag,
                        pause_gen,
                        join: Some(join),
                    }),
                    info,
                    session_id,
                    output_dir,
                    system_output_dir: None,
                    capture_mode: "microphone".to_string(),
                })
            }
            Ok(Err(e)) | Err(e) => {
                stop_flag.store(true, Ordering::SeqCst);
                let _ = join_timeout(join, JOIN_TIMEOUT);
                Err(e)
            }
        }
    }

    pub fn info_json(&self) -> serde_json::Value {
        self.info.clone()
    }

    pub fn matches_dual(
        &self,
        session_id: &str,
        mic: &std::path::Path,
        sys: &std::path::Path,
    ) -> bool {
        self.session_id == session_id
            && self.capture_mode == "dual"
            && self.output_dir == mic
            && self.system_output_dir.as_deref() == Some(sys)
    }

    pub fn matches_mic(&self, session_id: &str, output_dir: &std::path::Path) -> bool {
        self.session_id == session_id
            && self.capture_mode == "microphone"
            && self.output_dir == output_dir
    }

    pub fn is_faulted(&self) -> bool {
        match &self.kind {
            SessionKind::Dual(d) => d.session_fault.load(Ordering::SeqCst),
            SessionKind::MicOnly(_) => false,
        }
    }

    pub fn pause(&mut self) -> Result<serde_json::Value, String> {
        let hole_qpc = qpc_now().unwrap_or(0);
        match &mut self.kind {
            SessionKind::Dual(d) => {
                d.pause_flag.store(true, Ordering::SeqCst);
                d.pause_gen.fetch_add(1, Ordering::SeqCst);
            }
            SessionKind::MicOnly(m) => {
                m.pause_flag.store(true, Ordering::SeqCst);
                m.pause_gen.fetch_add(1, Ordering::SeqCst);
            }
        }
        Ok(serde_json::json!({
            "paused": true,
            "policy": "keep_audioclient_running_discard_buffers_record_hole",
            "holeQpc": hole_qpc,
            "broadcast": true
        }))
    }

    pub fn resume(&mut self) -> Result<serde_json::Value, String> {
        match &mut self.kind {
            SessionKind::Dual(d) => {
                d.pause_flag.store(false, Ordering::SeqCst);
                d.pause_gen.fetch_add(1, Ordering::SeqCst);
            }
            SessionKind::MicOnly(m) => {
                m.pause_flag.store(false, Ordering::SeqCst);
                m.pause_gen.fetch_add(1, Ordering::SeqCst);
            }
        }
        Ok(serde_json::json!({ "paused": false }))
    }

    pub fn stop(mut self) -> Result<serde_json::Value, String> {
        match &mut self.kind {
            SessionKind::Dual(d) => {
                d.abort.set();
                d.stop_flag.store(true, Ordering::SeqCst);
                let mic = d
                    .mic_join
                    .take()
                    .map(|h| join_timeout(h, JOIN_TIMEOUT))
                    .transpose()?;
                let sys = d
                    .sys_join
                    .take()
                    .map(|h| join_timeout(h, JOIN_TIMEOUT))
                    .transpose()?;
                let mic_r = mic.unwrap_or(Ok(serde_json::json!({})));
                let sys_r = sys.unwrap_or(Ok(serde_json::json!({})));
                let faulted = d.session_fault.load(Ordering::SeqCst);
                // Prefer stop ok even if one track faulted during run
                let mic_val = mic_r.unwrap_or_else(|e| serde_json::json!({"error": e}));
                let sys_val = sys_r.unwrap_or_else(|e| serde_json::json!({"error": e}));
                Ok(serde_json::json!({
                    "stopped": true,
                    "captureMode": "dual",
                    "sessionFaulted": faulted,
                    "microphone": mic_val,
                    "system": sys_val
                }))
            }
            SessionKind::MicOnly(m) => {
                m.stop_flag.store(true, Ordering::SeqCst);
                match m.join.take() {
                    Some(handle) => join_timeout(handle, JOIN_TIMEOUT)?,
                    None => Ok(serde_json::json!({ "stopped": true, "idempotent": true })),
                }
            }
        }
    }
}

fn flatten_err<T: Clone>(r: &Result<Result<T, String>, String>) -> Option<String> {
    match r {
        Err(e) => Some(e.clone()),
        Ok(Err(e)) => Some(e.clone()),
        Ok(Ok(_)) => None,
    }
}

#[derive(Clone)]
struct SharedClock {
    session_origin_qpc: u64,
    qpc_frequency: u64,
}

#[derive(Clone)]
struct TrackReadyInfo {
    device_id: String,
    device_name: String,
    format_json: serde_json::Value,
}

#[derive(Clone, Copy)]
enum TrackFlow {
    Capture,
    RenderLoopback,
}

struct WorkerCtx {
    session_id: String,
    track: String,
    role: String,
    flow: TrackFlow,
    device_id: Option<String>,
    output_dir: PathBuf,
    subchunk_ms: u64,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    pause_gen: Arc<AtomicU64>,
    session_fault: Arc<AtomicBool>,
    abort: AbortFlag,
    shared_origin: Arc<Mutex<Option<SharedClock>>>,
    prepare_gate: Arc<PhaseGate>,
    start_gate: Arc<PhaseGate>,
    commit_gate: Arc<PhaseGate>,
    ready_tx: Sender<Result<TrackReadyInfo, String>>,
    started_tx: Sender<Result<(), String>>,
    commit_tx: Sender<Result<(), String>>,
    progress: Option<ProgressFn>,
}

fn emit_progress(ctx: &WorkerCtx, event: &str, code: &str, message: &str) {
    if let Some(p) = &ctx.progress {
        p(
            ctx.session_id.clone(),
            ctx.track.clone(),
            event.to_string(),
            serde_json::json!({
                "code": code,
                "message": message,
                "track": ctx.track,
                "sessionId": ctx.session_id
            }),
        );
    }
}

fn run_track_worker(ctx: WorkerCtx) -> Result<serde_json::Value, String> {
    let _com = ComGuard::new()?;
    let track = ctx.track.clone();
    let role = ctx.role.clone();

    test_hang_prepare_if_configured(&track, &ctx.abort);
    if ctx.abort.is_set() {
        let _ = ctx.ready_tx.send(Err("aborted".into()));
        return Err("aborted".into());
    }

    let opened = match open_device(ctx.flow, ctx.device_id.as_deref()) {
        Ok(o) => o,
        Err(e) => {
            let _ = ctx.ready_tx.send(Err(e.clone()));
            return Err(e);
        }
    };
    if ctx.abort.is_set() {
        let _ = ctx.ready_tx.send(Err("aborted".into()));
        return Err("aborted".into());
    }

    let mut writer = match TrackWriter::create(
        &ctx.output_dir,
        &ctx.session_id,
        &track,
        &role,
        opened.format.clone(),
        ctx.subchunk_ms,
    ) {
        Ok(w) => w,
        Err(e) => {
            let msg = format!("TrackWriter::create: {e}");
            let _ = ctx.ready_tx.send(Err(msg.clone()));
            return Err(msg);
        }
    };

    let ready = TrackReadyInfo {
        device_id: opened.device_id.clone(),
        device_name: opened.device_name.clone(),
        format_json: opened.format.to_json(),
    };
    if ctx.ready_tx.send(Ok(ready)).is_err() {
        let _ = writer.abort_preparing("coordinator_gone");
        return Err("coordinator gone".into());
    }

    // Wait prepare gate (origin published)
    if let Err(e) = ctx.prepare_gate.wait(PHASE_TIMEOUT, &ctx.abort) {
        let _ = writer.abort_preparing(&e);
        return Err(e);
    }
    if ctx.abort.is_set() {
        let _ = writer.abort_preparing("aborted");
        return Err("aborted".into());
    }

    let clock = {
        let g = ctx.shared_origin.lock().map_err(|e| e.to_string())?;
        g.clone()
            .ok_or_else(|| "shared clock origin missing".to_string())?
    };

    unsafe {
        if let Err(e) = opened.client.Start() {
            let msg = format!("IAudioClient::Start({track}): {e}");
            let _ = ctx.started_tx.send(Err(msg.clone()));
            let _ = writer.abort_preparing(&msg);
            return Err(msg);
        }
    }
    let _ = ctx.started_tx.send(Ok(()));

    if let Err(e) = ctx.start_gate.wait(PHASE_TIMEOUT, &ctx.abort) {
        unsafe {
            let _ = opened.client.Stop();
        }
        let _ = writer.abort_preparing(&e);
        return Err(e);
    }
    if ctx.abort.is_set() {
        unsafe {
            let _ = opened.client.Stop();
        }
        let _ = writer.abort_preparing("aborted_after_start");
        return Err("aborted_after_start".into());
    }

    // mark_recording then report; coordinator opens commit_gate only if both ok
    match writer.mark_recording() {
        Ok(()) => {
            let _ = ctx.commit_tx.send(Ok(()));
        }
        Err(e) => {
            let msg = format!("mark_recording: {e}");
            let _ = ctx.commit_tx.send(Err(msg.clone()));
            unsafe {
                let _ = opened.client.Stop();
            }
            let _ = writer.abort_preparing(&msg);
            return Err(msg);
        }
    }

    if let Err(e) = ctx.commit_gate.wait(PHASE_TIMEOUT, &ctx.abort) {
        // Peer failed commit — roll back recording flag
        unsafe {
            let _ = opened.client.Stop();
        }
        let _ = writer.abort_preparing(&e);
        return Err(e);
    }
    if ctx.abort.is_set() {
        unsafe {
            let _ = opened.client.Stop();
        }
        let _ = writer.abort_preparing("aborted_commit");
        return Err("aborted_commit".into());
    }

    let result = capture_loop(
        &opened,
        &mut writer,
        &clock,
        &ctx.stop_flag,
        &ctx.pause_flag,
        &ctx.pause_gen,
        &ctx.session_fault,
        &ctx.abort,
        &track,
        &ctx.session_id,
        ctx.progress.clone(),
    );

    unsafe {
        let _ = opened.client.Stop();
    }

    match result {
        Ok(stats) => {
            let finish = writer.finish().map_err(|e| format!("finish: {e}"))?;
            Ok(serde_json::json!({
                "stopped": true,
                "track": track,
                "role": role,
                "deviceId": opened.device_id,
                "deviceName": opened.device_name,
                "actualL0Format": opened.format.to_json(),
                "stats": stats,
                "finish": finish
            }))
        }
        Err(e) => {
            if !ctx.session_fault.swap(true, Ordering::SeqCst) {
                emit_progress(&ctx, "track_fault", "capture_fault", &e);
                emit_progress(&ctx, "session_fault", "session_fault", &e);
            }
            let _ = writer.mark_faulted(&e);
            let finish = writer.finish().unwrap_or(serde_json::json!({}));
            Err(format!("{e}; sealed={finish}"))
        }
    }
}

fn capture_loop(
    opened: &OpenedDevice,
    writer: &mut TrackWriter,
    clock_shared: &SharedClock,
    stop_flag: &AtomicBool,
    pause_flag: &AtomicBool,
    pause_gen: &AtomicU64,
    session_fault: &AtomicBool,
    abort: &AbortFlag,
    track: &str,
    _session_id: &str,
    _progress: Option<ProgressFn>,
) -> Result<serde_json::Value, String> {
    unsafe {
        let client = &opened.client;
        let capture: IAudioCaptureClient = client
            .GetService::<IAudioCaptureClient>()
            .map_err(|e| format!("GetService IAudioCaptureClient: {e}"))?;
        let clock: IAudioClock = client
            .GetService::<IAudioClock>()
            .map_err(|e| format!("GetService IAudioClock: {e}"))?;

        let mut frames_written: u64 = 0;
        let mut discontinuities: u64 = 0;
        let mut silent_frames: u64 = 0;
        let mut pause_begin_count: u64 = 0;
        let mut pause_end_count: u64 = 0;
        let frequency: u64 = clock.GetFrequency().unwrap_or(0);
        let mut was_paused = false;
        let mut discarded_frames: u64 = 0;
        let mut discard_first_qpc: Option<u64> = None;
        let mut discard_last_qpc: Option<u64> = None;
        let mut pause_gen_at_begin: u64 = 0;

        let mut loop_err: Option<String> = None;
        while !stop_flag.load(Ordering::SeqCst)
            && !session_fault.load(Ordering::SeqCst)
            && !abort.is_set()
        {
            let _ = WaitForSingleObject(opened.event, 200);

            let paused = pause_flag.load(Ordering::SeqCst);
            let gen = pause_gen.load(Ordering::SeqCst);
            if paused && !was_paused {
                was_paused = true;
                discarded_frames = 0;
                discard_first_qpc = None;
                discard_last_qpc = None;
                pause_gen_at_begin = gen;
                let hole_qpc = qpc_now().unwrap_or(0);
                let _ = writer.record_hole(
                    "pause_begin",
                    serde_json::json!({
                        "holeQpc": hole_qpc,
                        "sessionOriginQpc": clock_shared.session_origin_qpc,
                        "qpcFrequency": clock_shared.qpc_frequency,
                        "pauseGen": gen,
                        "track": track
                    }),
                );
                pause_begin_count += 1;
            } else if !paused && was_paused {
                was_paused = false;
                let hole_qpc = qpc_now().unwrap_or(0);
                let _ = writer.record_hole(
                    "pause_end",
                    serde_json::json!({
                        "holeQpc": hole_qpc,
                        "sessionOriginQpc": clock_shared.session_origin_qpc,
                        "qpcFrequency": clock_shared.qpc_frequency,
                        "pauseGen": pause_gen_at_begin,
                        "discardedFrames": discarded_frames,
                        "firstQpc": discard_first_qpc,
                        "lastQpc": discard_last_qpc,
                        "track": track
                    }),
                );
                pause_end_count += 1;
                discarded_frames = 0;
            }

            loop {
                let packet_length = match capture.GetNextPacketSize() {
                    Ok(n) => n,
                    Err(e) => {
                        loop_err = Some(format!("GetNextPacketSize: {e}"));
                        break;
                    }
                };
                if packet_length == 0 {
                    break;
                }

                let mut data_ptr: *mut u8 = std::ptr::null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;
                let mut device_position: u64 = 0;
                let mut qpc_position: u64 = 0;

                if let Err(e) = capture.GetBuffer(
                    &mut data_ptr,
                    &mut num_frames,
                    &mut flags,
                    Some(&mut device_position),
                    Some(&mut qpc_position),
                ) {
                    loop_err = Some(format!("GetBuffer: {e}"));
                    break;
                }

                let process_result = (|| -> Result<(), String> {
                    let mut clock_pos: u64 = 0;
                    let mut clock_qpc: u64 = 0;
                    let _ = clock.GetPosition(&mut clock_pos, Some(&mut clock_qpc));

                    let disc_bit = AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32;
                    let silent_bit = AUDCLNT_BUFFERFLAGS_SILENT.0 as u32;
                    let is_disc = (flags & disc_bit) != 0;
                    let is_silent = (flags & silent_bit) != 0;
                    let mut disc_count = 0u64;
                    if is_disc {
                        discontinuities += 1;
                        disc_count = 1;
                        let _ = writer.record_hole(
                            "discontinuity",
                            serde_json::json!({
                                "devicePosition": device_position,
                                "qpc": qpc_position,
                                "clockPos": clock_pos,
                                "clockQpc": clock_qpc,
                                "frequency": frequency,
                                "bufferFrames": num_frames,
                                "flags": flags,
                                "packetFlag": true,
                                "sessionOriginQpc": clock_shared.session_origin_qpc,
                                "qpcFrequency": clock_shared.qpc_frequency
                            }),
                        );
                    }

                    let block = opened.format.block_align.max(1) as usize;
                    let nbytes = num_frames as usize * block;

                    if pause_flag.load(Ordering::SeqCst) {
                        // In-memory only — no per-packet journal
                        discarded_frames =
                            discarded_frames.saturating_add(u64::from(num_frames));
                        if discard_first_qpc.is_none() {
                            discard_first_qpc = Some(qpc_position);
                        }
                        discard_last_qpc = Some(qpc_position);
                    } else if num_frames > 0 {
                        let silent_f = if is_silent {
                            u64::from(num_frames)
                        } else {
                            0
                        };
                        if is_silent {
                            silent_frames += silent_f;
                        }
                        let timing = ChunkTiming {
                            device_pos_start: device_position,
                            device_pos_end: device_position.saturating_add(u64::from(num_frames)),
                            clock_pos_start: clock_pos,
                            clock_pos_end: clock_pos,
                            qpc_start: qpc_position,
                            qpc_end: qpc_position,
                            session_origin_qpc: clock_shared.session_origin_qpc,
                            qpc_frequency: clock_shared.qpc_frequency,
                            clock_frequency: frequency,
                            silent_frames: silent_f,
                            discontinuity_count: disc_count,
                            clock_qpc_point_sample: true,
                        };
                        if is_silent || data_ptr.is_null() {
                            let zeros = vec![0u8; nbytes];
                            writer
                                .write_pcm_frames(&zeros, u64::from(num_frames), &timing)
                                .map_err(|e| format!("write_pcm silent: {e}"))?;
                        } else {
                            let slice = std::slice::from_raw_parts(data_ptr, nbytes);
                            writer
                                .write_pcm_frames(slice, u64::from(num_frames), &timing)
                                .map_err(|e| format!("write_pcm: {e}"))?;
                        }
                        frames_written += u64::from(num_frames);
                    }
                    Ok(())
                })();

                let release = capture.ReleaseBuffer(num_frames);
                if let Err(e) = release {
                    loop_err = Some(format!("ReleaseBuffer: {e}"));
                    break;
                }
                if let Err(e) = process_result {
                    loop_err = Some(e);
                    break;
                }
            }
            if loop_err.is_some() {
                break;
            }
        }

        // Flush open pause if stopped while paused
        if was_paused {
            let hole_qpc = qpc_now().unwrap_or(0);
            let _ = writer.record_hole(
                "pause_end",
                serde_json::json!({
                    "holeQpc": hole_qpc,
                    "sessionOriginQpc": clock_shared.session_origin_qpc,
                    "qpcFrequency": clock_shared.qpc_frequency,
                    "pauseGen": pause_gen_at_begin,
                    "discardedFrames": discarded_frames,
                    "firstQpc": discard_first_qpc,
                    "lastQpc": discard_last_qpc,
                    "track": track,
                    "reasonNote": "stop_while_paused"
                }),
            );
            pause_end_count += 1;
        }

        if session_fault.load(Ordering::SeqCst) && loop_err.is_none() {
            let _ = writer.mark_faulted("peer_track_fault");
        }

        if let Some(err) = loop_err {
            return Err(err);
        }

        Ok(serde_json::json!({
            "framesWritten": frames_written,
            "discontinuities": discontinuities,
            "silentFrames": silent_frames,
            "pauseBeginCount": pause_begin_count,
            "pauseEndCount": pause_end_count,
            "clockFrequency": frequency,
            "sessionOriginQpc": clock_shared.session_origin_qpc,
            "qpcFrequency": clock_shared.qpc_frequency
        }))
    }
}

fn run_mic_only_loop(
    session_id: String,
    device_id: Option<String>,
    output_dir: PathBuf,
    subchunk_ms: u64,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    pause_gen: Arc<AtomicU64>,
    ready_tx: Sender<Result<TrackReadyInfo, String>>,
    progress: Option<ProgressFn>,
) -> Result<serde_json::Value, String> {
    let _com = ComGuard::new()?;
    let opened = match open_device(TrackFlow::Capture, device_id.as_deref()) {
        Ok(o) => o,
        Err(e) => {
            let _ = ready_tx.send(Err(e.clone()));
            return Err(e);
        }
    };
    let mut writer = match TrackWriter::create(
        &output_dir,
        &session_id,
        "microphone",
        "self",
        opened.format.clone(),
        subchunk_ms,
    ) {
        Ok(w) => w,
        Err(e) => {
            let msg = format!("TrackWriter::create: {e}");
            let _ = ready_tx.send(Err(msg.clone()));
            return Err(msg);
        }
    };

    let (origin_qpc, qpc_freq) = match qpc_now_and_freq() {
        Ok(v) => v,
        Err(e) => {
            let _ = ready_tx.send(Err(e.clone()));
            let _ = writer.abort_preparing(&e);
            return Err(e);
        }
    };
    let clock_shared = SharedClock {
        session_origin_qpc: origin_qpc,
        qpc_frequency: qpc_freq,
    };

    unsafe {
        if let Err(e) = opened.client.Start() {
            let msg = format!("IAudioClient::Start: {e}");
            let _ = ready_tx.send(Err(msg.clone()));
            let _ = writer.abort_preparing(&msg);
            return Err(msg);
        }
    }
    writer
        .mark_recording()
        .map_err(|e| format!("mark_recording: {e}"))?;

    let _ = ready_tx.send(Ok(TrackReadyInfo {
        device_id: opened.device_id.clone(),
        device_name: opened.device_name.clone(),
        format_json: opened.format.to_json(),
    }));

    let fault = AtomicBool::new(false);
    let abort = AbortFlag::new();
    let result = capture_loop(
        &opened,
        &mut writer,
        &clock_shared,
        &stop_flag,
        &pause_flag,
        &pause_gen,
        &fault,
        &abort,
        "microphone",
        &session_id,
        progress,
    );
    unsafe {
        let _ = opened.client.Stop();
    }
    match result {
        Ok(stats) => {
            let finish = writer.finish().map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "stopped": true,
                "track": "microphone",
                "role": "self",
                "deviceId": opened.device_id,
                "deviceName": opened.device_name,
                "actualL0Format": opened.format.to_json(),
                "stats": stats,
                "finish": finish,
                "sessionOriginQpc": origin_qpc,
                "qpcFrequency": qpc_freq
            }))
        }
        Err(e) => {
            let _ = writer.mark_faulted(&e);
            let finish = writer.finish().unwrap_or(serde_json::json!({}));
            Err(format!("{e}; finish={finish}"))
        }
    }
}

struct OpenedDevice {
    device_id: String,
    device_name: String,
    client: IAudioClient,
    format: L0Format,
    mix_format_ptr: *mut WAVEFORMATEX,
    event: HANDLE,
}

impl Drop for OpenedDevice {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
            if !self.event.is_invalid() {
                let _ = CloseHandle(self.event);
                self.event = HANDLE::default();
            }
            if !self.mix_format_ptr.is_null() {
                CoTaskMemFree(Some(self.mix_format_ptr as _));
                self.mix_format_ptr = std::ptr::null_mut();
            }
        }
    }
}

unsafe impl Send for OpenedDevice {}

fn open_device(flow: TrackFlow, device_id: Option<&str>) -> Result<OpenedDevice, String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("MMDeviceEnumerator: {e}"))?;

        let data_flow = match flow {
            TrackFlow::Capture => eCapture,
            TrackFlow::RenderLoopback => eRender,
        };

        let device: IMMDevice = match device_id {
            Some(id) if !id.is_empty() => {
                let wide = to_wide(id);
                enumerator
                    .GetDevice(PCWSTR(wide.as_ptr()))
                    .map_err(|e| format!("GetDevice: {e}"))?
            }
            _ => enumerator
                .GetDefaultAudioEndpoint(data_flow, eMultimedia)
                .map_err(|e| format!("GetDefaultAudioEndpoint: {e}"))?,
        };

        let resolved_id = device_id_str(&device)?;
        let device_name =
            device_friendly_name(&device).unwrap_or_else(|_| "Audio Device".to_string());

        let client: IAudioClient = device
            .Activate::<IAudioClient>(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate IAudioClient: {e}"))?;

        let mut mix_ptr: *mut WAVEFORMATEX = client
            .GetMixFormat()
            .map_err(|e| format!("GetMixFormat: {e}"))?;
        if mix_ptr.is_null() {
            return Err("GetMixFormat returned null".to_string());
        }

        let mut closest: *mut WAVEFORMATEX = std::ptr::null_mut();
        let support =
            client.IsFormatSupported(AUDCLNT_SHAREMODE_SHARED, mix_ptr, Some(&mut closest));
        if support.is_err() && !closest.is_null() {
            CoTaskMemFree(Some(mix_ptr as _));
            mix_ptr = closest;
        } else if !closest.is_null() && closest != mix_ptr {
            CoTaskMemFree(Some(closest as _));
        }

        let event =
            CreateEventW(None, false, false, None).map_err(|e| format!("CreateEventW: {e}"))?;

        let hns_buffer: i64 = 200_000;
        let stream_flags = match flow {
            TrackFlow::Capture => AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            TrackFlow::RenderLoopback => {
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
            }
        };
        if let Err(e) = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            stream_flags,
            hns_buffer,
            0,
            mix_ptr,
            None,
        ) {
            let _ = CloseHandle(event);
            CoTaskMemFree(Some(mix_ptr as _));
            return Err(format!("IAudioClient::Initialize(SHARED): {e}"));
        }

        if let Err(e) = client.SetEventHandle(event) {
            let _ = client.Stop();
            let _ = CloseHandle(event);
            CoTaskMemFree(Some(mix_ptr as _));
            return Err(format!("SetEventHandle: {e}"));
        }

        let format = l0_from_wave_format(mix_ptr);
        Ok(OpenedDevice {
            device_id: resolved_id,
            device_name,
            client,
            format,
            mix_format_ptr: mix_ptr,
            event,
        })
    }
}

fn l0_from_wave_format(fmt: *const WAVEFORMATEX) -> L0Format {
    unsafe {
        let f = &*fmt;
        let mut sub = "pcm_or_extensible".to_string();
        let base = std::mem::size_of::<WAVEFORMATEX>();
        let bytes_len = base + f.cbSize as usize;
        let raw = std::slice::from_raw_parts(fmt as *const u8, bytes_len.max(base));
        let b64 = Some(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            raw,
        ));
        if f.wFormatTag == 0xFFFE {
            let ext = fmt as *const WAVEFORMATEXTENSIBLE;
            let sub_format = std::ptr::addr_of!((*ext).SubFormat).read_unaligned();
            sub = format!("{sub_format:?}");
        } else if f.wFormatTag == 1 {
            sub = "WAVE_FORMAT_PCM".to_string();
        } else if f.wFormatTag == 3 {
            sub = "WAVE_FORMAT_IEEE_FLOAT".to_string();
        }
        L0Format {
            sample_rate: f.nSamplesPerSec,
            channels: f.nChannels,
            bits_per_sample: f.wBitsPerSample,
            block_align: f.nBlockAlign,
            format_tag: f.wFormatTag,
            sub_format: sub,
            wave_format_bytes_b64: b64,
        }
    }
}

unsafe fn device_id_str(device: &IMMDevice) -> Result<String, String> {
    let pwstr = device.GetId().map_err(|e| format!("GetId: {e}"))?;
    let s = pwstr.to_string().map_err(|e| format!("id utf16: {e}"))?;
    CoTaskMemFree(Some(pwstr.0 as _));
    Ok(s)
}

unsafe fn device_friendly_name(device: &IMMDevice) -> Result<String, String> {
    let store: IPropertyStore = device
        .OpenPropertyStore(STGM_READ)
        .map_err(|e| format!("OpenPropertyStore: {e}"))?;
    let var = store
        .GetValue(&PKEY_Device_FriendlyName)
        .map_err(|e| format!("GetValue FriendlyName: {e}"))?;
    let pwstr =
        PropVariantToStringAlloc(&var).map_err(|e| format!("PropVariantToStringAlloc: {e}"))?;
    let s = pwstr.to_string().map_err(|e| format!("name utf16: {e}"))?;
    CoTaskMemFree(Some(pwstr.0 as _));
    Ok(s)
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn qpc_now() -> Result<u64, String> {
    unsafe {
        let mut v: i64 = 0;
        QueryPerformanceCounter(&mut v).map_err(|e| format!("QueryPerformanceCounter: {e}"))?;
        Ok(v as u64)
    }
}

fn qpc_now_and_freq() -> Result<(u64, u64), String> {
    unsafe {
        let mut freq: i64 = 0;
        QueryPerformanceFrequency(&mut freq)
            .map_err(|e| format!("QueryPerformanceFrequency: {e}"))?;
        let mut v: i64 = 0;
        QueryPerformanceCounter(&mut v).map_err(|e| format!("QueryPerformanceCounter: {e}"))?;
        Ok((v as u64, freq as u64))
    }
}
