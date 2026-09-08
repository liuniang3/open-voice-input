# Meeting Stage 2B — 会后处理 IPC（无 Bucket）

Status: **foundation backend**（无会议 UI、无 OSS、无总结）

Date: 2026-07-20

## 目标

在 Stage 0B 采集 + Stage 1A 归档 + Stage 2A no-Bucket Qwen 之上，提供 **显式** 的主进程会后处理编排，并通过窄 IPC 暴露。

| 约束 | 说明 |
| --- | --- |
| 采集 stop | **仅本地**，不触发 export/ASR |
| 处理 | `meeting:process:start` 显式调用 |
| 默认 ASR | Qwen3-ASR-Flash Base64（2A） |
| 单飞 | **进程内** per-session；无跨进程锁 |
| 短语音 | IPC/状态完全隔离 |

## 凭证与 Base URL（运行时，不落盘）

**Key 优先序**

1. `OVI_MEETING_QWEN_API_KEY`
2. `QWEN_ASR_API_KEY`
3. `DASHSCOPE_API_KEY`
4. 已有会议专用设置字段 `meetingQwenApiKey`（若存在）

**不**静默绑定当前短语音 `asrApiKey` / provider profile。

**Base URL 优先序**

1. `OVI_MEETING_DASHSCOPE_BASE_URL`（主名，兼容已有配置）
2. `OVI_MEETING_QWEN_BASE_URL`（别名）
3. `QWEN_ASR_BASE_URL`
4. `OVI_DASHSCOPE_WORKSPACE_ID` → `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
5. 公共 `https://dashscope.aliyuncs.com/compatible-mode/v1`

路径为 **`/api/v1`**（且无 `compatible-mode`）→ `meeting_base_url_invalid`，**不**自动改写。

## IPC

| Channel | 入参 allowlist | 说明 |
| --- | --- | --- |
| `meeting:devices:query` | — | id/name/kind/default only |
| `meeting:process:start` | `sessionId` | export 1A + run 2A |
| `meeting:process:status` | `sessionId` | 纯读 |
| `meeting:process:retry` | `sessionId`, `resetAttempts?` | 仅 failed/cancelled/部分 |
| `meeting:process:cancel` | `sessionId` | AbortController |
| `meeting:transcript:get` | `sessionId` | **含原文**；status/list **不含** |

`meeting:capture:stop` 返回 `processing.hint`，不启动处理。

## 编排保证（诚实）

- **processSession**：export 后先比较 artifact SHA + model + track 集合指纹。
  - **指纹变化**（含旧 job 为 FAILED/CANCELLED）：`prepare` 新 generation 后 `run()`，不强制 retry 旧 job。
  - **指纹相同**且 RUNNING/PAUSED/READY/COMPLETED：resume `run()`（含 recoverJob）。
  - **指纹相同**且 FAILED/CANCELLED：`process_needs_retry`，必须显式 `retryProcess`。
- **崩溃窗口**：2A 对 PENDING/RUNNING 段在 ASR 前校验结果文件；有效 `textSha256`+`segmentContentSha256` → 零计费复用。
- **cancel**：abort + 等待 settle；超时返回 `stage=cancelling`（非假 cancelled）；锁由 run `finally` 释放。
- **getProcessStatus**：只读 session + job 合并计数；**不**因读取创建 in-memory handle / 不改盘。
- **单飞**：进程内 per-session；无跨进程锁。
- **sessionId**：仅 `[A-Za-z0-9._-]+`，拒绝会被 path sanitize 改写的值。

## 测试

```powershell
npm run test:meeting:2b
```

## 相关

- [MEETING_STAGE_2A.md](./MEETING_STAGE_2A.md)
- [MEETING_STAGE_1A.md](./MEETING_STAGE_1A.md)

