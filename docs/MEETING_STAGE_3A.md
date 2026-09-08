# Meeting Stage 3A — 上下文校订与结构化总结（后端）

Status: **foundation backend**（无会议 UI、无 OSS、无媒体导入）

Date: 2026-07-20

## 目标

在不可变的 Stage 2A `raw-transcript.json` 之上，生成：

1. **校订转写** `analysis/corrected-transcript.json`
2. **结构化总结** `analysis/summary.json`（meeting | personal）

每条结论必须带 `sourceItemIds`；本地校验丢弃无证据声明。

## 布局

```text
sessions/<id>/
  transcription/qwen-no-bucket/raw-transcript.json   # 只读权威源
  analysis/
    job.json
    g1/ ... gN/          # 代际目录（无 symlink）
    corrected-transcript.json
    summary.json
```

`job.activeGenerationDir` 为相对路径标识（如 `analysis/g1`）。

## 流水线（统一，短文本自然单批）

```text
fingerprint → plan_batches
  → per batch: correct → extract → rolling_state (capped)
  → hierarchical merge (budget-bounded groups/levels, all extracts)
  → local verify → finals (only if verification.passed)
```

- 单 merge 单元超预算 → `analysis_merge_over_budget`，**不**发起该次 API。
- 滚动状态仅作后续 batch 背景，**不能**替代全量 extracts 合并。
- 阶段文件 `inputHash`/`outputSha256` 可崩溃复用；路径禁止 `..`/绝对路径。
- 校订：重复/未知 id、过度改写 → 失败；不确定项保留原文或标记。
- owner/due 仅当引用原文含子串时保留，否则 null。
- 时间范围本地从 source IDs 推导（优先 sessionBegin/EndMs）。

## 凭证（运行时，不落盘）

- `OVI_MEETING_ANALYSIS_API_KEY` / `BASE_URL` / `MODEL` / `CONTEXT_WINDOW` / `MAX_OUTPUT` / `REASONING` / `TIMEOUT`
- 可选设置：`meetingAnalysis*` only
- **不**回退短语音 cleaner/ASR Key

## IPC

| Channel | 说明 |
| --- | --- |
| `meeting:analysis:start` | `{ sessionId, template? }` |
| `meeting:analysis:status` | 无正文 |
| `meeting:analysis:retry` / `cancel` | 同 2B 语义 |
| `meeting:analysis:corrected` / `summary` | 返回全文 |

## 保证

- raw 字节哈希在每次模型调用前与最终写入前校验，否则 `analysis_raw_changed`
- 匹配 fingerprint 的有效阶段文件零计费复用（含 hash 重算）
- FAILED/CANCELLED 同指纹需显式 retry（保留 templateRequested）
- 进程内 per-session 单飞；status 不含转写/总结正文
- JSON：仅允许单个对象（可 fence）；尾随内容/双对象拒绝

## 测试

```powershell
npm run test:meeting:3a
```

## 相关

- [MEETING_STAGE_2B.md](./MEETING_STAGE_2B.md)
- [MEETING_SYSTEM_REQUIREMENTS.md](../MEETING_SYSTEM_REQUIREMENTS.md)
