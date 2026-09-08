# Meeting Stage 4B-core — 导入 / 导出 / 说话人显示名 / 回放 / 虚拟列表

## 范围

在 Stage 4A 工作台之上补齐会话运维与结果消费能力，**不**引入视频导入，**不**另起第二套 ASR：

| 能力 | 说明 |
|------|------|
| 重命名 | `meeting:session:rename`，标题净化 ≤200 |
| 列表元数据 | source / 日期 / hasRaw / hasSummary；搜索覆盖标题、来源、日期 |
| Speaker map | 会话目录 `speaker-map.json` sidecar；仅装饰显示与导出；**永不**改 raw-transcript 字节/哈希 |
| 导出 | Markdown / JSON / TXT / SRT；系统保存对话框；JSON 消毒；SRT 无时间戳则写 `export-report.json`，不伪造 |
| WAV 导入 | 打开对话框；源文件只复制；RIFF/WAVE 校验；16 kHz mono PCM16 archive + sidecar_v1；`source=import`、停止态；**不**自动 ASR/分析 |
| 处理复用 | `session-processor.exportTracks` 对完整且 hash 匹配的 import archive 复用，之后用户显式「生成原文」走既有 Qwen no-bucket + 3A |
| 回放 | `mimo-meeting://play/{token}`；token 严格限制在 `sessionsRoot/{id}/archive/*.wav` |
| 虚拟列表 | 长转写窗口化渲染，`textContent` 安全 |

## 4B-video 媒体导入（补充）

- FFmpeg（`ffmpeg-static` → `native/ffmpeg` / packaged `resources/native/ffmpeg.exe`）抽取首音轨 → 同一 canonical archive。
- `meeting:import:media` + UI「导入媒体…」；角色 personal/mix → mic/self 或 system/remote_unknown。
- 默认仍无 OSS；说话人分离非默认能力。详见 `docs/FFMPEG_MEDIA_IMPORT.md`、`THIRD_PARTY_NOTICES.md`。

## 非目标（后续）

- 双轨同步 scrub、波形
- 会话删除 / 云同步
- OSS 上传
- 宣称全 codec / 超长视频已测

## 关键路径

- `src/meeting/import/import-wav.js`
- `src/meeting/export/session-export.js`
- `src/meeting/speaker-map.js`
- `src/meeting/playback/media-token.js`
- `src/meeting/processing/session-processor.js`（import archive 复用）
- `src/main.js` / `src/preload.js` / `src/renderer/*`

## 测试

```bash
npm run test:meeting:4b
```

覆盖：导入 hash / 不删源、路径拒绝、process 复用、speaker map 不改 raw、四导出与 SRT 降级、playback containment、虚拟列表与 rename 净化。
