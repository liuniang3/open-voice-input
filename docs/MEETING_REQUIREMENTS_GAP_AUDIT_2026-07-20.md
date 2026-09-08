# 会议系统需求缺口审计（2026-07-20）

> 对照：`MEETING_SYSTEM_REQUIREMENTS.md`（含 §11 阶段补充与 §14 非范围）  
> 证据：阶段文档 `docs/MEETING_STAGE_*.md` + 当前代码符号/路径  
> 原则：**不把 mock / synthetic / vendor-smoke 写成真实验证**；结论克制。

## 0. 验证层级标签

| 标签 | 含义 |
| --- | --- |
| **mocked** | 单元/集成用假 helper、假音频、fixture JSON |
| **synthetic** | 合成文本/短 PCM，无真实会议内容 |
| **vendor-smoke** | 短时真实供应商调用（如 Qwen Base64 冒烟），非长会 soak |
| **real-soak** | 长时真实场景（2h 腾讯会议、断网/强杀/装机恢复等）——**当前基本缺失** |

---

## 1. 已完成且已验证（有路径/符号 + 测试或阶段门禁）

下列能力在代码中落地，并以 **mocked / synthetic / 短时 vendor-smoke** 为主验证；**均未达到 §12 的 2h 真实验收**。

### 1.1 双轨采集（WASAPI 共享）

| 项 | 证据 |
| --- | --- |
| 麦克风共享 + 系统 endpoint mix loopback | `native/audio-capture-helper`；`docs/MEETING_STAGE_0B.md`；`src/meeting/constants.js`：`system_loopback_shared`、`pause_holes_shared_qpc` |
| 双轨单 RPC、共享 QPC 原点 | Stage 0B TwoPhaseDualSession；`src/meeting/supervisor.js` `pause`/`start` |
| 分段落盘 ~1s seal | Stage 0A/0B durable subchunk；`session-store` 能力说明含 dual-track |
| 暂停空洞记 journal | `export-track-wav.js` pause hole 解析；`pauseHolePolicy: explicit_metadata_no_wav_silence` |

验证层级：**mocked + 本机短时 smoke**（文档明确 **非** 2h / **非** 腾讯会议共存门禁）。

### 1.2 归档与时间线

| 项 | 证据 |
| --- | --- |
| L0 → mono PCM16 WAV + sidecar | `src/meeting/archive/export-track-wav.js`、`l0-format.js` |
| 时间线合并（session 时间优先） | `src/meeting/timeline/merge-timeline.js`（`echoCancellation: false` 显式） |
| 内容哈希校验 | `verifyArchiveIntegrity` / `contentSha256`（Stage 1A） |

验证层级：**mocked/synthetic**（`npm run test:meeting:1a` 等阶段脚本）。

### 1.3 会后转写：默认 no-bucket Qwen + 可选 enhanced Fun+OSS

| 项 | 证据 |
| --- | --- |
| 默认 Qwen Base64 分段，零上传 | `src/meeting/transcription/no-bucket-service.js`；`docs/MEETING_STAGE_2A.md` |
| 说话人：mic=`self`，sys=`remote_unknown`（basic） | Stage 2A 策略；无 diarization 不臆造远端 id |
| 显式 IPC 触发，stop 不自动 ASR | Stage 2B；`session-processor.js` |
| enhanced：系统轨 OSS + Fun diarization | `fun-asr-diarize-service.js`、`aliyun-oss-publisher.js`、`docs/MEETING_STAGE_4C.md` |
| 处理模式 basic/enhanced + 码率 | renderer 4C UI；`meeting:process:start` mode/bitrate |

验证层级：默认路径有 **vendor-smoke** 记录（2A 文档「人工真云冒烟」）；enhanced 以测试与 UI 门禁为主，**非**长会 soak。

### 1.4 校订 + 结构化总结（分层管线）

| 项 | 证据 |
| --- | --- |
| correct → extract → rolling → hierarchical merge → local verify | `src/meeting/analysis/pipeline.js`、`batching.js`、`rolling.js`、`token-budget.js` |
| 结论带 `sourceItemIds`；无 id 丢弃 | `src/meeting/analysis/evidence.js` `validateClaimList` / `no_valid_sourceItemIds` |
| 三版本分离：raw 不可变 + corrected + summary | Stage 3A 布局；`analysis/corrected-transcript.json`、`summary.json` |
| 凭证与短语音 cleaner 隔离 | `analysis/credentials.js`：`OVI_MEETING_ANALYSIS_*` / `meetingAnalysis*` |

验证层级：**mocked**（`test:meeting:3a`）+ 合成模型基准（见评测报告）；**非**真实长会语义验收。

### 1.5 工作台 UI / 导入导出 / 回放 / 虚拟列表

| 项 | 证据 |
| --- | --- |
| 独立 meeting 窗口、录制控制、显式「生成原文」「校订并总结」 | `docs/MEETING_STAGE_4A.md`；`src/renderer/meeting-ui.js` |
| WAV/媒体导入 → canonical archive | `import-wav.js`、`import-media.js`、`ffmpeg-runner.js`（**首音轨**） |
| 导出 MD/JSON/TXT/SRT | `export/session-export.js` |
| 说话人显示名 sidecar（装饰） | `speaker-map.js`（**不改** raw 字节） |
| 受控回放 token | `playback/media-token.js`；`mimo-meeting://` |
| 长转写虚拟列表 | Stage 4B-core；renderer 窗口化 + `textContent` |
| 4C 基础/增强 UI、Fun/OSS 设置与测试连接 | `docs/MEETING_STAGE_4C.md` |

验证层级：**mocked UI/集成测试**（`test:meeting:ui`、`4b`、`4c`）；截图/playwright 产物存在，**非** real-soak。

---

## 2. 基础实现但未达需求

| 需求要点 | 现状 | 证据 | 差距 |
| --- | --- | --- | --- |
| 长时会话暂停/恢复 | 采集层 pause/resume 有；会话状态可 `paused` | `supervisor.js`、`index.js` `pause` | 无 **real-soak**；无完整磁盘/网络/队列仪表 |
| 崩溃恢复分段落盘 | L0 seal + session 扫描 | Stage 0A/0B/1A | **无**强制结束/装机版/便携版一致性 **real-soak** |
| 任务暂停 | job 状态机含 `PAUSED`；no-bucket `pause()` | `transcription/constants.js`、`no-bucket-service.js` | **导入任务**无真正暂停续跑；处理暂停未产品化验收 |
| 证据核验 | 本地 ID 存在性 + owner/due 子串 | `evidence.js` | **缺**语义支持/矛盾二次核验、抽样回原文对抗 |
| 说话人重命名 | UI + `speaker-map.json` | `speaker-map.js`、4C UI | **装饰映射**；不回写 raw；与「同步更新校订/总结权威字段」完整产品语义有距离 |
| 模型配置 | 单一 `meetingAnalysis*` 上下文/输出/超时 | `credentials.js`、`constants.js` `DEFAULT_CONTEXT_WINDOW` | **无**多模型能力档案；**无** extract/final **分模型路由** |
| 媒体导入 | FFmpeg 首音轨 → 16k mono | `import-media.js` `first audio stream`；`downmix*` | 多声道仅 downmix；**无**独立多轨转写选择；**无**暂停续跑 |
| 双轨重复/回声 | 时间线可重叠保留 | Stage 1A/2A；`merge-timeline.js` `echoCancellation: false` | **无** AEC、**无**双轨重复去重 |
| 基础模式说话人 | 单一 `remote_unknown` | Stage 2A | 符合 2A 策略，但 **未达** §3.5「远端参与者分离」完整目标（需 enhanced+OSS+Fun） |
| Key 管理 | 设置字段 + 环境变量运行时解析 | 各 `*-credentials.js` | 需求要求迁移 **DPAPI/Credential Manager**；**仍明文 settings 风险** |
| 监控 | 部分状态 phase/错误码 | processor/UI phase | **无**完整磁盘/网络/队列/丢帧仪表盘 |

---

## 3. 明确未实现

### 3.1 验收与韧性（§12 / §9）— 均为未做 real-soak

- **无**真实 **2 小时腾讯会议**连续录制验收。  
- **无**断网 / API 限流下「只断处理、不断录音」的系统级验收。  
- **无**强杀进程 / 电源异常后恢复的正式门禁。  
- **无**录中 **设备切换**、装机版与便携版数据目录一致性 soak。  
- **无**腾讯会议麦克风共存的**书面通过门禁**（0A/0B 仅列手动 follow-up）。

### 3.2 录中体验（§3.1 / §7）

- **无**录中会议**实时转写**页（会后权威 ASR ≠ 录中实时预览会议轨）。  
- **无**书签 / 临时文字笔记（`notes.jsonl` 需求结构未产品化）。  
- **无**完整磁盘空间、网络、转写队列深度、丢帧的控制台仪表。

### 3.3 音频高级能力（§3.2）

- **无**进程级 loopback（按应用捕获腾讯会议）。  
- **无** AEC / 监听返送治理。  
- **无**双轨内容重复检测与最终原文去重。  
- **无**实时漂移校正；**无**录中热切换设备的完整策略。  
- **无**自应用播放音频排除策略（0B 已诚实写明 endpoint mix 含本应用声音）。

### 3.4 校订 UX 与证据（§3.6 / §4）

- **无**原文↔校订 **diff 视图**。  
- **无**单条修改**回退**。  
- 证据校验主要为 **ID 存在性**（及有限 owner/due 子串），**缺**语义蕴含/矛盾二次核验。

### 3.5 模型体系（§5）

- 仅 **单长内容模型**配置槽位。  
- **无**模型能力档案库（价格、限流、适合 extract/final/verify 的结构化档案）。  
- **无** extract 与 final **分模型路由**（基准亦不能指导 extract 选型，见评测报告）。

### 3.6 导入任务（§6）

- 导入 **只取首音轨 / downmix**，非保留多声道独立转写。  
- 导入任务 **无真正暂停续跑**（与「大文件可暂停恢复」需求不符）。

### 3.7 隐私合规与会话治理（§8）

- **无**会话删除（4B 明确非目标）。  
- **无**数据保留策略配置。  
- **无**会议录音授权/合规提示产品文案闭环。  
- Key **未** DPAPI；仍可能明文落在 settings（需求已点名后续迁移）。

### 3.8 其它产品页

- 历史页删除/保留策略不完整。  
- 结果页缺 diff、完整双轨 scrub/波形（4B 非目标）。

---

## 4. §14 非范围（第一版明确不做）

以下**不**计为缺口债务（除非产品后续扩 scope）：

- 自动加入在线会议的机器人  
- 多用户云端协作编辑  
- 云同步与跨设备账号  
- 实时翻译  
- 自动读日历并静默开录  
- 未经用户明确启动的后台录音  

---

## 5. 优先级建议

### P0（正确性 / 安全 / 验收底线）

1. **真实场景 soak 设计并执行**：≥1 次接近 2h 的双轨录制 + 腾讯会议 mic 共存观察；断网/强杀恢复用例。  
2. **密钥**：settings 明文 Key → DPAPI 或 Credential Manager；日志/导出持续扫密。  
3. **会话删除 + 保留策略**最小闭环（含派生文件）。  
4. **证据层**：在 ID 校验之上增加抽样语义/矛盾检查，或明确产品降级文案。  
5. **合规提示**：录音授权与本地法律提示进入设置/首次录制。

### P1（核心体验与模型）

1. 录中状态仪表：磁盘 / 队列 / 错误（可先只读指标）。  
2. 校订 diff + 单条回退。  
3. 模型能力档案 + **extract / final 分路由**（当前基准中 Grok 4.5 High 与 GPT-5.5 High 质量并列，Grok 更快；生产默认仍待长上下文管线验证）。  
4. 导入：多声道策略说明或可选轨；任务暂停续跑。  
5. enhanced 路径长会成本/失败恢复 runbook（OSS 残留 `remoteCleanup`）。

### P2（增强音频与体验）

1. 进程 loopback 可行性验证（Windows 版本矩阵）。  
2. AEC / 双轨去重 / 漂移校正。  
3. 录中实时转写（可与短语音 ASR 隔离的只读预览）。  
4. 书签与临时笔记。  
5. 双轨同步 scrub / 波形。  
6. 自应用音频排除。

---

## 6. 重点结论（审计摘要）

1. **没有**真实 2 小时腾讯会议、断网/强杀/设备切换/安装版恢复的 **real-soak** 验收。  
2. **没有**录中会议实时转写、书签/临时笔记、完整磁盘/网络/队列/丢帧仪表。  
3. **没有**进程级 loopback、AEC、双轨重复去重、实时漂移校正/录中设备切换、自应用音频排除。  
4. **没有**校订 diff 与单条回退；证据校验主要是 **ID 存在性**，缺语义支持/矛盾二次核验。  
5. **只有**单长内容模型配置，**无**模型能力档案与 extract/final 分模型路由。  
6. 导入 **只首音轨/downmix**；任务 **无**真正暂停续跑。  
7. **无**会话删除/保留策略/合规提示；Key 仍明文 settings 风险，**未** DPAPI。  
8. **基础模式**不分远端说话人；**增强模式**需 OSS+Fun；speaker rename 是 **装饰映射**。  
9. **已实现且应公允列出**：双轨共享 WASAPI、分段落盘/恢复基础、no-bucket Qwen、可选 Fun+OSS enhanced、三版本结果、分层 merge+本地 ID 证据、媒体导入/导出/回放/虚拟列表、4A–4C 工作台。

---

## 7. 阶段文档与代码索引

| 阶段 | 文档 | 主要代码根 |
| --- | --- | --- |
| 0A mic | `docs/MEETING_STAGE_0A.md` | `native/audio-capture-helper`，`src/meeting/supervisor.js` |
| 0B dual | `docs/MEETING_STAGE_0B.md` | helper 0.2 + `src/meeting/index.js` |
| 1A archive | `docs/MEETING_STAGE_1A.md` | `archive/`，`timeline/merge-timeline.js` |
| 2A/2B ASR | `docs/MEETING_STAGE_2A.md`，`2B` | `transcription/no-bucket-service.js`，`processing/session-processor.js` |
| 3A analysis | `docs/MEETING_STAGE_3A.md` | `analysis/pipeline.js`，`evidence.js` |
| 4A UI | `docs/MEETING_STAGE_4A.md` | `renderer/meeting-ui.js`，`main.js` IPC |
| 4B import/export | `docs/MEETING_STAGE_4B_CORE.md` | `import/*`，`export/*`，`speaker-map.js`，`playback/*` |
| 4C enhanced | `docs/MEETING_STAGE_4C.md` | `fun-asr-diarize-service.js`，`aliyun-oss-publisher.js` |
| 模型评测 | `docs/MEETING_ANALYSIS_MODEL_EVALUATION_2026-07-20.md` | `experiments/meeting-analysis/*` |

---

## 8. 诚实边界

- 阶段测试与 synthetic 基准证明的是 **管线可运行与回归不回退**，不是 §12 产品验收完成。  
- vendor-smoke（如 Qwen 短音频）≠ 长会稳定与成本可控。  
- enhanced diarization 依赖用户 OSS 与 Fun，默认 basic **不得**宣传为多人分离已完成。  
- 本审计**只更新文档**，不修改代码、测试或 README。
