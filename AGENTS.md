# Project Development Rules

- Maintenance ownership: Codex maintains Windows; the project collaborator maintains macOS. Do not independently change macOS native capture, permissions, input or packaging unless the user explicitly requests it. Shared fixes must preserve the cross-platform API and describe relevant changes for the macOS maintainer.
- Shared features belong in shared services/UI; isolate native capture, permissions, hotkeys, input and packaging by platform. Run applicable shared tests and Windows checks; run the existing Windows/macOS CI matrix for shared changes without claiming macOS hardware validation.
- Meeting realtime transcription preserves immutable native audio, full-length WAV exports, ordered raw text and persisted retry checkpoints. ASR uploads may be segmented; local audio must not be truncated to satisfy provider limits.
- Keep recording, ASR requests and the 30-second Markdown autosave independent. Cleanup is an explicit post-recording action and writes a separate result.
- Never commit keys, local settings, user audio/transcripts, diagnostic screenshots or provider response bodies. Do not print credentials while debugging. Keep each model's credentials isolated.
- Preserve existing user edits. Do not permanently delete files; use the system recycle bin when deletion is requested.
- No external model delegation unless the user explicitly authorizes it. Native subagents are permitted only when authorized; at most three concurrent model tasks INCLUDING the main agent.

