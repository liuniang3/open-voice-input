//! Dual-track durable writer: frame-aligned seal, .part -> atomic rename, journal.
//!
//! States: preparing → recording → finished | faulted
//! abort_preparing must not leave recording=true in manifest.
//! L0 = device-negotiated raw PCM. No HQ resample here.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[derive(Debug, Clone)]
pub struct L0Format {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub block_align: u16,
    pub format_tag: u16,
    pub sub_format: String,
    pub wave_format_bytes_b64: Option<String>,
}

impl L0Format {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sampleRate": self.sample_rate,
            "channels": self.channels,
            "bitsPerSample": self.bits_per_sample,
            "blockAlign": self.block_align,
            "formatTag": self.format_tag,
            "subFormat": self.sub_format,
            "waveFormatBytesB64": self.wave_format_bytes_b64,
            "layer": "L0",
            "note": "device-negotiated capture format; not L1 48k s16le mono"
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriterState {
    Preparing,
    Recording,
    Finished,
    Faulted,
}

impl WriterState {
    pub fn as_str(self) -> &'static str {
        match self {
            WriterState::Preparing => "preparing",
            WriterState::Recording => "recording",
            WriterState::Finished => "finished",
            WriterState::Faulted => "faulted",
        }
    }
}

/// Per-buffer / per-segment timing for l0_chunk_v1.
/// devicePos is frame-exact. clockPos/qpc are point samples unless noted —
/// not interpolated end times (avoid false precision).
#[derive(Debug, Clone, Default)]
pub struct ChunkTiming {
    pub device_pos_start: u64,
    pub device_pos_end: u64,
    pub clock_pos_start: u64,
    pub clock_pos_end: u64,
    pub qpc_start: u64,
    pub qpc_end: u64,
    pub session_origin_qpc: u64,
    pub qpc_frequency: u64,
    pub clock_frequency: u64,
    pub silent_frames: u64,
    pub discontinuity_count: u64,
    /// When true, clock/qpc end is a point sample at packet time, not frame-interpolated.
    pub clock_qpc_point_sample: bool,
}

pub struct TrackWriter {
    track_dir: PathBuf,
    journal_path: PathBuf,
    index_path: PathBuf,
    manifest_path: PathBuf,
    part_path: PathBuf,
    part_file: Option<File>,
    seq: u64,
    bytes_in_part: u64,
    frames_in_part: u64,
    subchunk_frames: u64,
    subchunk_bytes: u64,
    format: L0Format,
    session_id: String,
    track: String,
    role: String,
    state: WriterState,
    total_frames: u64,
    // Open part timing accumulators
    part_timing: ChunkTiming,
    part_has_timing: bool,
}

impl TrackWriter {
    pub fn create(
        output_dir: &Path,
        session_id: &str,
        track: &str,
        role: &str,
        format: L0Format,
        subchunk_ms: u64,
    ) -> io::Result<Self> {
        let track_dir = output_dir.to_path_buf();
        fs::create_dir_all(&track_dir)?;
        let block = format.block_align.max(1) as u64;
        // frames = floor(sampleRate * ms / 1000); bytes = frames * blockAlign — no half frames
        let frames = ((format.sample_rate as u64) * subchunk_ms.max(100) / 1000).max(1);
        let subchunk_bytes = frames * block;
        let mut writer = Self {
            journal_path: track_dir.join("journal.jsonl"),
            index_path: track_dir.join("index.jsonl"),
            manifest_path: track_dir.join("manifest.json"),
            part_path: track_dir.join("current.part"),
            track_dir,
            part_file: None,
            seq: 0,
            bytes_in_part: 0,
            frames_in_part: 0,
            subchunk_frames: frames,
            subchunk_bytes,
            format,
            session_id: session_id.to_string(),
            track: track.to_string(),
            role: role.to_string(),
            state: WriterState::Preparing,
            total_frames: 0,
            part_timing: ChunkTiming::default(),
            part_has_timing: false,
        };
        writer.write_manifest(false)?;
        writer.open_part()?;
        writer.append_journal(
            "open",
            serde_json::json!({
                "seq": writer.seq,
                "track": writer.track,
                "role": writer.role,
                "state": writer.state.as_str()
            }),
        )?;
        Ok(writer)
    }

    pub fn subchunk_bytes(&self) -> u64 {
        self.subchunk_bytes
    }

    pub fn subchunk_frames(&self) -> u64 {
        self.subchunk_frames
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn bytes_in_part(&self) -> u64 {
        self.bytes_in_part
    }

    pub fn frames_in_part(&self) -> u64 {
        self.frames_in_part
    }

    pub fn state(&self) -> WriterState {
        self.state
    }

    pub fn total_frames(&self) -> u64 {
        self.total_frames
    }

    /// Mark recording after both tracks Start succeed. Manifest recording=true only here.
    pub fn mark_recording(&mut self) -> io::Result<()> {
        self.state = WriterState::Recording;
        self.write_manifest(true)?;
        self.append_journal(
            "recording",
            serde_json::json!({ "track": self.track, "role": self.role }),
        )
    }

    /// Prepare/start failed: close without recording=true residual.
    pub fn abort_preparing(mut self, reason: &str) -> io::Result<serde_json::Value> {
        self.state = WriterState::Faulted;
        if let Some(f) = self.part_file.take() {
            drop(f);
        }
        let _ = fs::remove_file(&self.part_path);
        self.write_manifest(false)?;
        self.append_journal(
            "abort_preparing",
            serde_json::json!({
                "reason": reason,
                "track": self.track,
                "role": self.role
            }),
        )?;
        Ok(serde_json::json!({
            "aborted": true,
            "track": self.track,
            "role": self.role,
            "recording": false,
            "state": self.state.as_str()
        }))
    }

    fn write_manifest(&self, recording: bool) -> io::Result<()> {
        let body = serde_json::json!({
            "sessionId": self.session_id,
            "track": self.track,
            "role": self.role,
            "state": self.state.as_str(),
            "recording": recording && self.state == WriterState::Recording,
            "schema": "l0_track_manifest_v1",
            "actualL0Format": self.format.to_json(),
            "targetL1Format": {
                "sampleRate": 48000,
                "channels": 1,
                "bitsPerSample": 16,
                "encoding": "s16le",
                "layer": "L1",
                "note": "future archive target; not produced in Stage 0B"
            },
            "archivePending": true,
            "archiveReason": "hq_conversion_not_implemented_stage_0b_l0_raw_bypass",
            "durableSubchunkMsDefault": 1000,
            "durableSubchunkSeal": true,
            "frameAlignedSeal": true,
            "subchunkFrames": self.subchunk_frames,
            "captureScope": if self.track == "system" { "endpoint_mix" } else { "microphone" },
            "funAsrRoleHint": self.role,
            "updatedAt": now_ms()
        });
        let tmp = self.manifest_path.with_extension("json.tmp");
        {
            let mut f = File::create(&tmp)?;
            f.write_all(serde_json::to_vec_pretty(&body).unwrap_or_default().as_slice())?;
            f.flush()?;
            flush_file_buffers(&f)?;
        }
        fs::rename(&tmp, &self.manifest_path)?;
        Ok(())
    }

    fn open_part(&mut self) -> io::Result<()> {
        let f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.part_path)?;
        self.part_file = Some(f);
        self.bytes_in_part = 0;
        self.frames_in_part = 0;
        self.part_timing = ChunkTiming::default();
        self.part_has_timing = false;
        Ok(())
    }

    /// Write PCM for `frames` samples. Bytes must equal frames * block_align.
    /// Splits across subchunks with per-segment devicePos (frame-exact) and
    /// proportional silentFrames. discontinuity_count only on first segment of packet.
    pub fn write_pcm_frames(
        &mut self,
        data: &[u8],
        frames: u64,
        timing: &ChunkTiming,
    ) -> io::Result<()> {
        if frames == 0 || data.is_empty() {
            return Ok(());
        }
        let block = self.format.block_align.max(1) as usize;
        let expected = frames as usize * block;
        if data.len() != expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "pcm length {} != frames {} * blockAlign {}",
                    data.len(),
                    frames,
                    block
                ),
            ));
        }

        let mut offset = 0usize;
        let mut frames_left = frames;
        let mut frames_done: u64 = 0;
        let mut disc_remaining = timing.discontinuity_count;

        while frames_left > 0 {
            if self.part_file.is_none() {
                self.open_part()?;
            }
            let room_frames = self
                .subchunk_frames
                .saturating_sub(self.frames_in_part)
                .max(1);
            let take_frames = frames_left.min(room_frames);
            let take_bytes = take_frames as usize * block;
            let chunk = &data[offset..offset + take_bytes];

            // Frame-exact device position for this segment
            let seg_device_start = timing.device_pos_start.saturating_add(frames_done);
            let seg_device_end = seg_device_start.saturating_add(take_frames);
            // silentFrames proportional to take
            let seg_silent = if frames > 0 {
                timing.silent_frames * take_frames / frames
            } else {
                0
            };
            // discontinuity only on first related segment of this packet
            let seg_disc = if disc_remaining > 0 {
                let d = disc_remaining;
                disc_remaining = 0;
                d
            } else {
                0
            };

            let seg = ChunkTiming {
                device_pos_start: seg_device_start,
                device_pos_end: seg_device_end,
                clock_pos_start: timing.clock_pos_start,
                clock_pos_end: timing.clock_pos_end,
                qpc_start: timing.qpc_start,
                qpc_end: timing.qpc_end,
                session_origin_qpc: timing.session_origin_qpc,
                qpc_frequency: timing.qpc_frequency,
                clock_frequency: timing.clock_frequency,
                silent_frames: seg_silent,
                discontinuity_count: seg_disc,
                clock_qpc_point_sample: timing.clock_qpc_point_sample,
            };

            if !self.part_has_timing {
                self.part_timing = seg.clone();
                self.part_has_timing = true;
            } else {
                self.part_timing.device_pos_end = seg.device_pos_end;
                self.part_timing.clock_pos_end = seg.clock_pos_end;
                self.part_timing.qpc_end = seg.qpc_end;
                self.part_timing.silent_frames = self
                    .part_timing
                    .silent_frames
                    .saturating_add(seg.silent_frames);
                self.part_timing.discontinuity_count = self
                    .part_timing
                    .discontinuity_count
                    .saturating_add(seg.discontinuity_count);
                if self.part_timing.session_origin_qpc == 0 {
                    self.part_timing.session_origin_qpc = seg.session_origin_qpc;
                }
                if self.part_timing.qpc_frequency == 0 {
                    self.part_timing.qpc_frequency = seg.qpc_frequency;
                }
                if self.part_timing.clock_frequency == 0 {
                    self.part_timing.clock_frequency = seg.clock_frequency;
                }
            }

            {
                let f = self
                    .part_file
                    .as_mut()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "part file missing"))?;
                f.write_all(chunk)?;
            }
            self.bytes_in_part += take_bytes as u64;
            self.frames_in_part += take_frames;
            self.total_frames += take_frames;
            offset += take_bytes;
            frames_done += take_frames;
            frames_left -= take_frames;
            if self.frames_in_part >= self.subchunk_frames {
                self.seal_current_part()?;
            }
        }
        Ok(())
    }

    /// Backward-compatible raw write (frame count derived from length). Prefer write_pcm_frames.
    pub fn write_pcm(&mut self, data: &[u8]) -> io::Result<()> {
        let block = self.format.block_align.max(1) as usize;
        if block == 0 || data.is_empty() {
            return Ok(());
        }
        // only whole frames
        let frames = (data.len() / block) as u64;
        let usable = frames as usize * block;
        let timing = ChunkTiming::default();
        self.write_pcm_frames(&data[..usable], frames, &timing)
    }

    fn seal_current_part(&mut self) -> io::Result<Option<PathBuf>> {
        let Some(mut f) = self.part_file.take() else {
            return Ok(None);
        };
        if self.bytes_in_part == 0 || self.frames_in_part == 0 {
            drop(f);
            let _ = fs::remove_file(&self.part_path);
            self.part_has_timing = false;
            return Ok(None);
        }
        // frame-aligned: drop trailing partial frame bytes if any (should not happen)
        let block = self.format.block_align.max(1) as u64;
        let aligned_bytes = self.frames_in_part * block;
        if self.bytes_in_part != aligned_bytes {
            // truncate conceptual: we only index frame-aligned portion
            self.bytes_in_part = aligned_bytes;
        }
        f.flush()?;
        flush_file_buffers(&f)?;
        drop(f);

        self.seq += 1;
        let name = format!("{:06}.l0.pcm", self.seq);
        let final_path = self.track_dir.join(&name);
        let sealed_bytes = self.bytes_in_part;
        let sealed_frames = self.frames_in_part;
        let frame_start = self.total_frames.saturating_sub(sealed_frames);
        let frame_end = self.total_frames;
        fs::rename(&self.part_path, &final_path)?;
        let t = &self.part_timing;
        let entry = serde_json::json!({
            "schema": "l0_chunk_v1",
            "seq": self.seq,
            "file": name,
            "bytes": sealed_bytes,
            "frames": sealed_frames,
            "frameStart": frame_start,
            "frameEnd": frame_end,
            "devicePosStart": t.device_pos_start,
            "devicePosEnd": t.device_pos_end,
            "clockPosStart": t.clock_pos_start,
            "clockPosEnd": t.clock_pos_end,
            "qpcStart": t.qpc_start,
            "qpcEnd": t.qpc_end,
            "sessionOriginQpc": t.session_origin_qpc,
            "qpcFrequency": t.qpc_frequency,
            "clockFrequency": t.clock_frequency,
            "silentFrames": t.silent_frames,
            "discontinuityCount": t.discontinuity_count,
            "clockQpcPointSample": t.clock_qpc_point_sample,
            "timingNote": "devicePos is frame-exact; clockPos/qpc are point samples not interpolated ends",
            "track": self.track,
            "role": self.role,
            "format": self.format.to_json(),
            "committedAt": now_ms()
        });
        self.append_index(&entry)?;
        self.append_journal("commit", entry)?;
        self.bytes_in_part = 0;
        self.frames_in_part = 0;
        self.part_has_timing = false;
        self.open_part()?;
        Ok(Some(final_path))
    }

    pub fn commit_part_if_any(&mut self) -> io::Result<Option<PathBuf>> {
        self.seal_current_part()
    }

    pub fn record_hole(&mut self, reason: &str, detail: serde_json::Value) -> io::Result<()> {
        self.append_journal(
            "hole",
            serde_json::json!({
                "reason": reason,
                "detail": detail,
                "track": self.track,
                "role": self.role,
                "at": now_ms()
            }),
        )
    }

    pub fn mark_faulted(&mut self, reason: &str) -> io::Result<()> {
        self.state = WriterState::Faulted;
        self.write_manifest(false)?;
        self.append_journal(
            "fault",
            serde_json::json!({ "reason": reason, "track": self.track }),
        )
    }

    pub fn finish(mut self) -> io::Result<serde_json::Value> {
        let last = self.commit_part_if_any()?;
        if self.bytes_in_part == 0 {
            if let Some(f) = self.part_file.take() {
                drop(f);
            }
            let _ = fs::remove_file(&self.part_path);
        }
        if self.state != WriterState::Faulted {
            self.state = WriterState::Finished;
        }
        self.write_manifest(false)?;
        self.append_journal(
            "finish",
            serde_json::json!({
                "lastFile": last.as_ref().map(|p| p.display().to_string()),
                "totalFrames": self.total_frames,
                "state": self.state.as_str()
            }),
        )?;
        Ok(serde_json::json!({
            "seq": self.seq,
            "track": self.track,
            "role": self.role,
            "trackDir": self.track_dir.display().to_string(),
            "totalFrames": self.total_frames,
            "state": self.state.as_str(),
            "archivePending": true,
            "actualL0Format": self.format.to_json()
        }))
    }

    fn append_journal(&self, kind: &str, detail: serde_json::Value) -> io::Result<()> {
        let line = serde_json::json!({
            "t": now_ms(),
            "kind": kind,
            "detail": detail
        });
        append_jsonl(&self.journal_path, &line)
    }

    fn append_index(&self, entry: &serde_json::Value) -> io::Result<()> {
        append_jsonl(&self.index_path, entry)
    }
}

fn append_jsonl(path: &Path, value: &serde_json::Value) -> io::Result<()> {
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    let mut bytes = serde_json::to_vec(value).unwrap_or_default();
    bytes.push(b'\n');
    f.write_all(&bytes)?;
    f.flush()?;
    flush_file_buffers(&f)?;
    Ok(())
}

fn flush_file_buffers(file: &File) -> io::Result<()> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::FlushFileBuffers;
        let handle = HANDLE(file.as_raw_handle() as _);
        unsafe {
            FlushFileBuffers(handle)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Ok(())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn test_format() -> L0Format {
        L0Format {
            sample_rate: 1000,
            channels: 1,
            bits_per_sample: 16,
            block_align: 2,
            format_tag: 1,
            sub_format: "WAVE_FORMAT_PCM".to_string(),
            wave_format_bytes_b64: None,
        }
    }

    #[test]
    fn seals_multiple_subchunks_to_committed_files() {
        let dir = env::temp_dir().join(format!(
            "ovi-persist-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // 1000 Hz * 2 bytes = 2000 B/s; 100ms subchunk => 100 frames => 200 bytes.
        let mut writer =
            TrackWriter::create(&dir, "sess-test", "microphone", "self", test_format(), 100)
                .unwrap();
        assert_eq!(writer.subchunk_frames(), 100);
        assert_eq!(writer.subchunk_bytes(), 200);
        writer.mark_recording().unwrap();

        let payload = vec![0xABu8; 450];
        let mut timing = ChunkTiming::default();
        timing.session_origin_qpc = 1;
        timing.qpc_frequency = 10_000_000;
        timing.qpc_start = 100;
        timing.qpc_end = 200;
        writer
            .write_pcm_frames(&payload[..450 / 2 * 2], 225, &timing)
            .unwrap();
        // 225 frames => 2 full seals (100+100) + 25 tail
        assert_eq!(writer.seq(), 2);
        assert_eq!(writer.frames_in_part(), 25);

        assert!(dir.join("000001.l0.pcm").is_file());
        assert!(dir.join("000002.l0.pcm").is_file());
        assert_eq!(fs::metadata(dir.join("000001.l0.pcm")).unwrap().len(), 200);

        let index = fs::read_to_string(dir.join("index.jsonl")).unwrap();
        let first: serde_json::Value =
            serde_json::from_str(index.lines().next().unwrap()).unwrap();
        assert_eq!(first["schema"], "l0_chunk_v1");
        assert_eq!(first["frames"], 100);
        assert!(first.get("sessionOriginQpc").is_some());
        assert!(first.get("qpcFrequency").is_some());

        let finish = writer.finish().unwrap();
        assert_eq!(finish["seq"], 3);
        assert!(dir.join("000003.l0.pcm").is_file());
        assert!(!dir.join("current.part").exists());

        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["recording"], false);
        assert_eq!(manifest["role"], "self");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn abort_preparing_leaves_recording_false() {
        let dir = env::temp_dir().join(format!(
            "ovi-persist-abort-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let writer =
            TrackWriter::create(&dir, "sess", "system", "remote_mix_for_diarization", test_format(), 1000)
                .unwrap();
        let r = writer.abort_preparing("peer_failed").unwrap();
        assert_eq!(r["recording"], false);
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["recording"], false);
        assert_eq!(manifest["state"], "faulted");
        let _ = fs::remove_dir_all(&dir);
    }
}
