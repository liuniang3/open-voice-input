# Meeting Stage 2A — 无 Bucket 默认 Qwen 转写基础

Status: **foundation**（无 UI、无 OSS 上传；默认 no-Bucket）

Date: 2026-07-20

## 目标

在 **不要求用户自有对象存储** 的前提下，为会议双轨归档音频提供可恢复的本地分段转写基础：

| 项 | 默认（2A） |
| --- | --- |
| 引擎 | Qwen3-ASR-Flash（Base64 / data URI） |
| 说话人 | 麦克风 = `self`；系统轨 = 单一 `remote_unknown` |
| 远端分离 | **不支持**（Qwen 无 diarization） |
| 时间戳精度 | **段级** `timestampPrecision: "segment"` |
| 清理/总结 | 不调用 LLM cleaner / summary |
| Fun-ASR + 公网 URL | 可选后续能力，**仅**用于远端多说话人分离，非本阶段默认 |

## 配置（无密钥）

北京工作区 OpenAI 兼容 Base URL 模板（官方）：

```text
https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
```

- 将 `{WorkspaceId}` 替换为实际工作区 ID。
- 此端点路径为 **`/compatible-mode/v1`**；**不要**使用 `/api/v1`（对该 MaaS 兼容端点不正确）。
- API Key 仅由运行时调用方解析，不写入仓库、文档示例或日志。

## 质量与成本权衡（诚实）

**优点**

- 开箱即用：无需配置 OSS/Bucket/公网 URL。
- 本地优先：分段、任务状态、原文结果均落在会话目录。
- 与短语音路径隔离；Qwen `transcribeRaw` 行为保持不变。

**代价**

- 系统轨无法区分多个远端说话人（全部 `remote_unknown`）。
- 无词级/句级官方时间戳；仅有段边界（约默认 180s）。
- 受 Qwen 文档限制：单段 **≤ 5 分钟**、Base64 输入 **≤ 约 10 MB**；默认目标段长 **180s**（16 kHz mono PCM16）。硬预检 duration≤300s，但 **10 MiB Base64 对应有效 PCM 约 ≤245s @16k mono**（先触达体积上限）；300s PCM 会在联网前被 size preflight 拒绝。
- 长会 = 多段顺序请求 → 延迟与费用随时长线性上升；默认串行，避免突发限流。
- 线性重采样到 16 kHz（确定性、跨读边界有状态），非 HQ 档案级重采样。

若需要远端多说话人：后续可选 **Fun-ASR + 可产生 HTTPS 公网 URL 的 publisher**（Stage 1A 已定义边界；2A **不**实现上传，OSS 仍为可选）。

## 人工真云冒烟（2026-07-20）

本机手动验证（无 OSS）：

- 路径：Stage 1A mono WAV → 16 kHz mono 分段 → Qwen3-ASR-Flash Base64 → 任务 `completed`，`raw-transcript` 非空。
- 未使用对象存储 / 公网 URL 上传。
- 本文档不记录转写正文、API Key 或 Workspace 真实 ID。

## 架构

```text
Stage 1A archive mono WAV + sidecar
  → segment-prep (RIFF 稳健解析, 16k 重采样, 180s 段, SHA, 预检)
  → job-store (transcription/qwen-no-bucket/job.json + results/)
  → runner (注入 transcribeSegment; AbortSignal; 重试; 崩溃恢复)
  → raw-transcript.json (段级时间 + self / remote_unknown)
```

### 模块

| 路径 | 职责 |
| --- | --- |
| `src/meeting/transcription/wav-reader.js` | 走 RIFF chunk；校验 mono PCM16 |
| `src/meeting/transcription/resample.js` | 有状态线性重采样 |
| `src/meeting/transcription/segment-prep.js` | 分段 WAV + 元数据 + 预检 + 复用 |
| `src/meeting/transcription/job-store.js` | 原子 JSON 任务/结果 |
| `src/meeting/transcription/no-bucket-service.js` | `createNoBucketMeetingTranscriptionService` |
| `src/providers/asr/qwen3-asr-provider.js` | `transcribeMeetingSegment`（raw，不 clean） |

### 任务状态

Job: `preparing` → `ready` → `running` ↔ `paused` → `completed` | `failed` | `cancelled`  

Segment: `pending` | `running` | `completed` | `failed`  

- **进程内 single-flight**：同一 service 实例上并发 `run()` 返回 `job_already_running`。**无跨进程锁**（后续可加 lockfile）。
- `getStatus()` **只读** `loadJob`，不触发 recover、不改盘。
- 磁盘恢复：仅在 `run()` 且当前无 in-process run 时 `recoverJob`（running→ready/pending）。
- 已完成段复用：结果文件必须同时校验 `segmentContentSha256` 与 `textSha256`；失败则降为 pending 重转。
- `failed`（attempts 用尽）/ `cancelled` 为终端态，直至 `retryFailed({ resetAttempts: true })`。
- 源音频或 model 变更时 `generation++`，旧结果不可复用。

### 隐私

- 日志只记 task/segment id、状态、错误码；**不写转写正文、不写 Key**。
- 原文在 `results/*_seg_XXXX.json` 与 `raw-transcript.json`。
- `job.json` 只存 provider/model **标识**，永不存 apiKey。

### API（无 IPC）

```js
const { createNoBucketMeetingTranscriptionService } = require("./src/meeting");

const service = createNoBucketMeetingTranscriptionService({
  sessionDir,
  sessionId,
  transcribeSegment: ({ audioDataUrl, signal }) =>
    qwenProvider.transcribeMeetingSegment({ audioDataUrl, signal })
});

await service.prepare({
  microphone: { wavPath, sidecarPath, role: "self" },
  system: { wavPath, sidecarPath, role: "remote_mix_for_diarization" }
});
await service.run({ signal });
const transcript = await service.getTranscript();
```

错误路径应明确：**no-bucket 无远端 diarization**；多说话人需 Fun-ASR + 公网 URL。

## 明确未做

- 会议 UI / renderer IPC  
- OSS 上传 / Fun-ASR 作为默认路径（仍为远端 diarization 的可选后续）  
- 回声消除、转写前混音  
- LLM 校订与总结  

自动化测试仍以注入 mock 为主（无密钥、不依赖外网）；真云连通性见上文人工冒烟。

## 测试

```powershell
npm run test:meeting:2a
npm run test:meeting:1a
npm run test:meeting
npm run test:pipeline
```

`dist` 门禁包含 `test:meeting:2a`。

## 相关

- [MEETING_STAGE_1A.md](./MEETING_STAGE_1A.md)
- [MEETING_STAGE_0B.md](./MEETING_STAGE_0B.md)
- [MEETING_SYSTEM_REQUIREMENTS.md](../MEETING_SYSTEM_REQUIREMENTS.md)
