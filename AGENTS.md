# Project Development Rules

- Maintain Windows and macOS together. Shared features belong in shared services/UI; isolate native capture, permissions, hotkeys, paste and packaging by platform.
- Every feature or fix must consider both desktop targets. Run applicable shared tests and the Windows/macOS CI matrix. Do not label native macOS capture or paste as verified without a macOS build and hardware check.
- Meeting realtime transcription preserves immutable native audio, full-length WAV exports, ordered raw text and persisted retry checkpoints. ASR uploads may be segmented; local audio must not be truncated to satisfy provider limits.
- Keep recording, ASR requests and the 30-second Markdown autosave independent. Cleanup is an explicit post-recording action and writes a separate result.
- Never commit keys, local settings, user audio/transcripts, diagnostic screenshots or provider response bodies. Do not print credentials while debugging. Keep each model's credentials isolated.
- Preserve existing user edits. Do not permanently delete files; use the system recycle bin when deletion is requested.
- No external model delegation unless the user explicitly authorizes it. Native subagents are permitted only when authorized; at most three concurrent model tasks INCLUDING the main agent.

