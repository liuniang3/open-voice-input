use serde::{Deserialize, Serialize};

pub const HELPER_NAME: &str = "audio-capture-helper";
pub const HELPER_VERSION: &str = "0.2.0";
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Hello {
        id: String,
    },
    Ping {
        id: String,
    },
    QueryDevices {
        id: String,
    },
    Configure {
        id: String,
        session_root: String,
        #[serde(default)]
        parent_pid: Option<u32>,
    },
    Start {
        id: String,
        session_id: String,
        /// "dual" (Stage 0B) or omitted/"microphone" for mic-only (0A compat).
        #[serde(default)]
        capture_mode: Option<String>,
        #[serde(default = "default_track")]
        track: String,
        #[serde(default)]
        device_id: Option<String>,
        #[serde(default)]
        output_dir: Option<String>,
        #[serde(default)]
        subchunk_ms: Option<u64>,
        #[serde(default)]
        microphone: Option<TrackStartSpec>,
        #[serde(default)]
        system: Option<TrackStartSpec>,
    },
    Pause {
        id: String,
    },
    Resume {
        id: String,
    },
    Stop {
        id: String,
    },
    Shutdown {
        id: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct TrackStartSpec {
    #[serde(default)]
    pub device_id: Option<String>,
    pub output_dir: String,
}

fn default_track() -> String {
    "microphone".to_string()
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Hello {
        name: String,
        version: String,
        protocol_version: u32,
        capabilities: Vec<String>,
        notes: Vec<String>,
    },
    Ack {
        id: String,
        command: String,
    },
    Result {
        id: String,
        result: serde_json::Value,
    },
    Error {
        id: Option<String>,
        code: String,
        message: String,
    },
    Progress {
        session_id: String,
        track: String,
        event: String,
        detail: serde_json::Value,
    },
}

pub fn parse_line(line: &str) -> Result<Command, String> {
    serde_json::from_str(line).map_err(|e| e.to_string())
}

pub fn encode_line(event: &Event) -> String {
    serde_json::to_string(event).unwrap_or_else(|_| {
        r#"{"type":"error","code":"encode_failed","message":"failed to encode event"}"#.to_string()
    })
}

pub fn ok_result(data: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "ok": true, "data": data })
}

pub fn error_result(code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": { "code": code, "message": message } })
}

pub fn stage0b_capabilities() -> Vec<String> {
    vec![
        "dual_track".to_string(),
        "system_loopback_shared".to_string(),
        "dual_start_single_rpc".to_string(),
        "query_devices_capture_and_render".to_string(),
        "clock_qpc_ticks_iaudioclock".to_string(),
        "pause_holes_shared_qpc".to_string(),
        "durable_subchunk_seal_frame_aligned".to_string(),
        "mic_shared".to_string(),
        "query_devices".to_string(),
        "pause_resume".to_string(),
        "durable_subchunk_seal".to_string(),
        "l0_device_format".to_string(),
        "parent_pid_watch".to_string(),
    ]
}

pub fn stage0b_notes() -> Vec<String> {
    vec![
        "stage_0b_dual_track".to_string(),
        "endpoint_mix_loopback_not_process".to_string(),
        "includes_this_app_audio_if_playing".to_string(),
        "drm_may_silence_loopback".to_string(),
        "no_asr".to_string(),
        "no_2h_reliability_claim".to_string(),
        "l0_raw_bypass_no_hq_resample".to_string(),
        "job_object_parent_bind_disabled".to_string(),
        "default_role_emultimedia".to_string(),
        "fun_asr_role_reserved_self_and_remote_mix".to_string(),
    ]
}
