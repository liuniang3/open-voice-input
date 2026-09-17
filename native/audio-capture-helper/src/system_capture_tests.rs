use super::*;

#[test]
fn system_single_track_uses_only_render_loopback_identity() {
    assert_eq!(TrackFlow::RenderLoopback.track(), "system");
    assert_eq!(
        TrackFlow::RenderLoopback.role(),
        "remote_mix_for_diarization"
    );
    assert_eq!(TrackFlow::Capture.track(), "microphone");
}

#[test]
fn rapid_pause_resume_waits_for_each_worker_transition() {
    let flag = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let transitions = Arc::new(AtomicU64::new(0));
    let (f, a, s, t) = (
        flag.clone(),
        seen.clone(),
        stop.clone(),
        transitions.clone(),
    );
    let join = thread::spawn(move || {
        while !s.load(Ordering::SeqCst) {
            let next = f.load(Ordering::SeqCst);
            if a.load(Ordering::SeqCst) != next {
                thread::sleep(Duration::from_millis(20));
                t.fetch_add(1, Ordering::SeqCst);
                a.store(next, Ordering::SeqCst);
            }
            thread::sleep(Duration::from_millis(1));
        }
        Ok(serde_json::json!({ "stopped": true }))
    });
    let mut session = CaptureSession {
        kind: SessionKind::Single(SingleInner {
            stop_flag: stop,
            pause_flag: flag,
            pause_gen: Arc::new(AtomicU64::new(0)),
            pause_qpc: Arc::new(AtomicU64::new(0)),
            pause_seen: seen,
            join: Some(join),
        }),
        info: serde_json::json!({}),
        session_id: "system-test".into(),
        output_dir: PathBuf::from("system"),
        system_output_dir: Some(PathBuf::from("system")),
        capture_mode: "system".into(),
    };
    for i in 0..3 {
        assert_eq!(session.pause().unwrap()["paused"], true);
        assert_eq!(transitions.load(Ordering::SeqCst), i * 2 + 1);
        assert_eq!(session.pause().unwrap()["idempotent"], true);
        assert_eq!(session.resume().unwrap()["paused"], false);
        assert_eq!(transitions.load(Ordering::SeqCst), i * 2 + 2);
    }
    assert!(!session.matches_single("system-test", std::path::Path::new("system"), "microphone"));
    session.stop().unwrap();
}

#[test]
fn system_archive_pause_seal_preserves_all_frames_and_refuses_restart() {
    use crate::persist::{ChunkTiming, L0Format, TrackWriter};
    let dir = std::env::temp_dir().join(format!(
        "ovi-system-archive-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let format = L0Format {
        sample_rate: 1000,
        channels: 1,
        bits_per_sample: 16,
        block_align: 2,
        format_tag: 1,
        sub_format: "WAVE_FORMAT_PCM".into(),
        wave_format_bytes_b64: None,
    };
    let mut writer = TrackWriter::create(
        &dir,
        "system-test",
        "system",
        "remote_mix_for_diarization",
        format.clone(),
        100,
    )
    .unwrap();
    writer.mark_recording().unwrap();
    writer
        .write_pcm_frames(&vec![7u8; 50], 25, &ChunkTiming::default())
        .unwrap();
    writer.commit_part_if_any().unwrap();
    writer
        .record_hole("pause_begin", serde_json::json!({"holeQpc": 100}))
        .unwrap();
    let first = std::fs::read(dir.join("000001.l0.pcm")).unwrap();
    writer
        .record_hole("pause_end", serde_json::json!({"holeQpc": 200}))
        .unwrap();
    writer
        .write_pcm_frames(&vec![9u8; 350], 175, &ChunkTiming::default())
        .unwrap();
    assert_eq!(writer.finish().unwrap()["totalFrames"], 200);
    assert_eq!(std::fs::read(dir.join("000001.l0.pcm")).unwrap(), first);
    let all = ["000001.l0.pcm", "000002.l0.pcm", "000003.l0.pcm"]
        .iter()
        .flat_map(|name| std::fs::read(dir.join(name)).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(all, [vec![7u8; 50], vec![9u8; 350]].concat());
    let manifest = std::fs::read(dir.join("manifest.json")).unwrap();
    assert!(TrackWriter::create(
        &dir,
        "new",
        "system",
        "remote_mix_for_diarization",
        format,
        100
    )
    .is_err());
    assert_eq!(std::fs::read(dir.join("manifest.json")).unwrap(), manifest);
}
