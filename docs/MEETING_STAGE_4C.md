# Meeting Stage 4C — Enhanced Diarization (OSS + Fun-ASR system)

Status: **backend + renderer UI**（默认仍为 basic / no-Bucket）

Date: 2026-07-20

## 目标

在 Stage 2A/2B 会后处理之上增加 **可选 enhanced** 路径：

| 模式 | 麦克风 | 系统轨 | 原文写入 | 上传 |
| --- | --- | --- | --- | --- |
| **basic**（默认） | Qwen Base64 分段 | Qwen Base64；`remote_unknown` | 2A 直接写 `raw-transcript.json` | **零上传** |
| **enhanced** | **仅** Qwen；**不**提前 finalize 权威 raw | **仅** Fun-ASR diarization（需公网 HTTPS URL） | mic+sys merge 后 **一次原子写** raw | 系统轨 MP3 → OSS 私有对象 + ≥60min 签名 URL；成功 raw 后删除对象 |

## 约束（诚实）

- basic 行为与指纹默认不变；未显式 `mode=enhanced` 时不走 OSS/Fun。
- enhanced 下 Qwen **不**转写 system；system 不做 Qwen 分段。
- **懒解析凭证**：`hasMic` 才 resolve Qwen；`hasSys` 才 resolve Fun + OSS/建 publisher。mic-only 不需 Fun/OSS；system-only 不需 Qwen。缺失侧 modelId 在 fingerprint/raw 中为 `null`。
- 权威原文仅 enhanced merge 后写入一次；Qwen job 使用 `skipTranscriptWrite` / `transcriptDeferred`。
- 上传码率：`32 | 48 | 64` kbps，**默认 48**（`meetingUploadBitrateKbps` / IPC `bitrateKbps`）。
- OSS：私有对象；`signatureUrl` 过期 **≥ 3600s**；put 期间监听 `AbortSignal`（`client.cancel` + race）；**禁止**把签名 URL / AccessKey 写入 job/session/日志。
- Fun-ASR：`funTaskId` 持久化；job.json **白名单**落盘（无 url/key）；`lastError` 脱敏。
- **同 fingerprint + completed + 权威 raw 存在**：`process:start` **短路**返回 completed，不再 poll / 改写 raw。源/模型/码率变化才新 generation。
- **失败/取消**：`process:start` 同 fp 仍要求显式 `meeting:process:retry`。
  - failed（含坏 taskId）→ retry 默认 **forceResubmit**（清 task、重 encode/upload/submit；提交前 best-effort 删旧 object）。
  - cancelled + taskId / polling / merging → **优先 resume** 避免重复计费。
  - raw 写失败时 fun job 停在 `merging`，retry 可 resume 成功 task。
- 失败/取消时远端对象 **保留**，status 标明 `remoteCleanup: "pending_retained"`，用户可重试；成功 raw 后删除。
- basic ↔ enhanced **指纹 mode 隔离**（`no_bucket` vs `enhanced_mic` + enhanced Fun fingerprint）。
- 短语音 IPC / voice-pipeline **隔离**。

## 凭证（运行时，不落盘）

**Qwen（basic / enhanced mic）**：同 Stage 2B（`meetingQwen*` / `OVI_MEETING_QWEN_*`）。

**Fun-ASR**

1. `OVI_MEETING_FUN_ASR_API_KEY`
2. `DASHSCOPE_API_KEY`
3. `FUN_ASR_API_KEY`
4. `meetingFunAsrApiKey`

**不**回退 `meetingQwenApiKey` / 短语音 ASR profile。

**OSS**

- `OVI_MEETING_OSS_REGION` / `BUCKET` / `ACCESS_KEY_ID` / `ACCESS_KEY_SECRET`
- 可选 `ENDPOINT` / `PREFIX`（默认 `meeting`）
- 或 settings：`meetingOssRegion` 等

缺 OSS → `meeting_oss_credentials_missing`（仅 hasSys 的 enhanced 启动失败；basic / mic-only enhanced 不受影响）。

## IPC allowlist 增量

| Channel | 字段 |
| --- | --- |
| `meeting:process:start` | `sessionId`, `mode`\|`processMode`, `bitrateKbps` |
| `meeting:process:retry` | + `forceResubmit?` |
| `meeting:enhanced:test` | `target?` = `fun` \| `oss` \| `all` |

`meeting:enhanced:test`：Fun 官方 sample `testConnection` + OSS 小探针 put/sign/delete。DTO 仅 `ok` / `target` / `latencyMs` / 错误码，**不**回 bucket/region/URL/key。

`DEFAULT_SETTINGS` 含 meeting OSS/Fun/bitrate/processMode 空默认。

## Renderer UI（本阶段）

工作台处理区：

- **基础 / 增强** 模式按钮（`aria-pressed`）；basic 默认、无上传提示；enhanced 显示 32/48/64 kbps 分段（约 14/21/28 MB/小时，默认 48）。
- 开始/重试携带当前 `mode` + `bitrateKbps`；处理中禁用模式/码率切换。
- 状态 phase 映射：压缩 / 上传 / 识别 / 合并 / 清理；`remoteCleanup` 为 `pending_retained` / `delete_failed` 时进度区警告。

设置 → 会议：

- 默认处理模式与上传质量；Fun-ASR model/base/key；OSS region/endpoint/bucket/accessKeyId/accessKeySecret/prefix。
- 敏感字段显示/复制；Fun / OSS 分别「测试连接」+ `aria-live` 结果。
- load/save 全字段；工作台切换模式会持久化，不打断进行中任务。

说话人：select + 名称 input + 保存名称；从 raw/corrected 提取唯一 speaker；`self`→我，`remote_N`→远端N；点击转写块可选；A/B session guard 不退化。

视觉：中文 app-owned frameless 浅色毛玻璃；主操作绿 / 录制珊瑚 / 警告琥珀；圆角 ≤8px；按钮 min-height 34px；无装饰渐变/嵌套卡片。

## 模块

| 路径 | 职责 |
| --- | --- |
| `transcription/encode-upload-mp3.js` | archive WAV → 16k mono MP3 |
| `publish/aliyun-oss-publisher.js` | 私有 put + abort race + 签名 URL + delete |
| `transcription/fun-asr-diarize-service.js` | encode→upload→Fun structured；taskId；白名单 job；原子 raw 辅助 |
| `processing/oss-credentials.js` / `fun-asr-credentials.js` | 运行时解析 |
| `processing/session-processor.js` | basic / enhanced 编排 + connection test |
| `renderer/*` | 模式/码率/设置/说话人 UI |

## 测试

```powershell
npm run test:meeting:ui
npm run test:meeting:4c
npm run test:meeting:2a
npm run test:meeting:2b
npm run test:pipeline
```

`dist` 门禁含 `test:meeting:ui` 与 `test:meeting:4c`。`check:secrets` 含 `LTAI…` AccessKeyId 形态。

## 明确未做

- 回声消除、转写前混音
- 跨进程 job 锁
- 自动 stop→process

## 相关

- [MEETING_STAGE_2A.md](./MEETING_STAGE_2A.md)
- [MEETING_STAGE_2B.md](./MEETING_STAGE_2B.md)
- [MEETING_STAGE_1A.md](./MEETING_STAGE_1A.md)
