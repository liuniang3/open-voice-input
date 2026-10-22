# Project Development Rules

- Maintain Windows and macOS together. Shared features belong in shared services/UI; isolate native capture, permissions, hotkeys, paste and packaging by platform.
- Every feature or fix must consider both desktop targets. Run applicable shared tests and the Windows/macOS CI matrix. Do not label native macOS capture or paste as verified without a macOS build and hardware check.
- Meeting realtime transcription preserves immutable native audio, full-length WAV exports, ordered raw text and persisted retry checkpoints. ASR uploads may be segmented; local audio must not be truncated to satisfy provider limits.
- Keep recording, ASR requests and the 30-second Markdown autosave independent. Cleanup is an explicit post-recording action and writes a separate result.
- Never commit keys, local settings, user audio/transcripts, diagnostic screenshots or provider response bodies. Do not print credentials while debugging. Keep each model's credentials isolated.
- Preserve existing user edits. Do not permanently delete files; use the system recycle bin when deletion is requested.
- No external model delegation unless the user explicitly authorizes it. Native subagents are permitted only when authorized; at most three concurrent model tasks INCLUDING the main agent.

## macOS development handoff

- This collaboration accepts macOS work only. Do not change Windows-specific code or its release workflow. Necessary shared fixes still require regression checks; they do not authorize a Windows release.
- Before continuing macOS work, read `MACOS_START_HERE.md`, `docs/MACOS_HANDOFF.md`, `docs/MACOS_ACCEPTANCE.md`, and `docs/MACOS_DEVELOPMENT.md` when present.
- If present, `.codex/local/MACOS_WORKSTATION.md` records private workstation paths and runtime commands. Keep this local material out of commits.
- Use a `codex/macos-*` branch and keep native differences in the platform layer or Swift helper. Contribute through a pull request; main and release tags are maintained separately.
- Keep synthetic/native protocol checks, application packaging, and hardware acceptance as separate evidence. Update the development baseline with actual results and leave untested permissions, audio capture, and text injection explicitly unverified.
- The reusable local Codex skill is `$open-voice-input-dev`. Keep the repository handoff and development records current so a new session can take over from them.
- Mac update titles and release notes must explicitly say **Mac 版（macOS）**, describe concrete user-visible improvements and distinguish tested behavior from outstanding hardware checks. Record unreleased fixes in `CHANGELOG.md`; coordinate official version numbers and tags with the maintainer.
- Mac releases use `macos-v*` and the independent `macos-updates` feed, never the repository-wide latest release. Keep both Mac releases and the feed marked as GitHub prereleases with `latest=false`, so existing Windows updaters ignore them. See `docs/MACOS_RELEASE.md`; do not alter `release.yml` or publish `v*` tags for Mac-only work.
- Standing user authorization (2026-10-22): after each bug fix, recycle obsolete project installers and App copies, build a new Mac installer, and push the source plus the independent Mac release. Increment to an unused patch version, keep the PR workflow, and do not ask again for routine delivery. Preserve running Apps and user data; retain cleanup receipts. Main merges remain separate. Honor an explicit per-task request to skip packaging or publishing.

