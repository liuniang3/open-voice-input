# 会议分析模型评测报告（2026-07-20）

> 范围：合成短/中文案上的**单次** correct + summarize JSON 冒烟/排序。  
> **不是**两小时真实会议、**不是**生产分批管线等价评测。  
> 合并数字以下文「已重评分合并事实」为准；本文不改写这些数字。

## 1. 方法

| 项 | 说明 |
| --- | --- |
| 工具 | `scripts/benchmark-meeting-analysis.js` + `experiments/meeting-analysis/score.js` |
| 调用渠道 | 本机 `opencode` CLI（`opencode run -m provider/model [--variant high]`）；密钥留在 opencode 配置，不进入仓库/报告 |
| 任务形态 | **单次请求**同时完成校订（`correctedItems`）与结构化总结（meeting/personal 模板字段） |
| 输入 | 合成 `rawItems`（约 9 条短/中片段），无真实音频、无 ASR 噪声链路 |
| 输出约束 | `experiments/meeting-analysis/output-schema.json`：单一 JSON 对象；每条输入 id 须有 `correctedText`（错键如 `correctText` 直接 schema 失败） |
| 评分 | 自动：端到端延迟、call/JSON-schema、claim 关键词组+sourceId 重叠召回、`mustNot`（路径独立+局部否定窗口）、`mustPreserve`、span coverage、sourceId 合法性；`callOk=false` 或 `jsonOk=false` 时 **composite 强制为 0** |
| 重评分 | `--rescore` 保留 latency/model 元数据，按当前 scorer 重写 scores 与 summary |
| 合并口径 | 按模型跨 run 目录按 **attempt 次数加权**；`mustNotCleanRate` 仅在 `validRuns`（`callOk && jsonOk`）上计算；失败 attempt 的 composite/claim/preserve/coverage 按 0 计入全部 `runs` |

本基准**刻意排除**：生产 `batching` / `rolling` / hierarchical merge / evidence scrub、导出 UI、真实 token/价格记账。

## 2. A / B / C 案例

| Id | 文件 | 意图 |
| --- | --- | --- |
| **A** | `cases/case-a-multi-party.json` | 多人短会：最终决定、被否决方案、owner/due、说话人、前中后事实、不确定专名 |
| **B** | `cases/case-b-personal-monologue.json` | 个人独白：分层观点、口误/ASR 风格错误、必须保留的数字与术语 |
| **C** | `cases/case-c-adversarial-no-decision.json` | 对抗：无决定/无行动项；讨论但未采纳选项（幻觉压力） |

每案含 `goldClaims`、`mustNotClaims`、`mustPreserve`、`allowedCorrections`。**无真实用户数据。**

## 3. 严格 schema 与自动指标

- **严格 schema**：可解析的单一对象 + 必填结构；`correctedItems[].correctedText` 非空字符串；错误字段名不计分。
- **门控**：无效输出 composite=0，避免「空金标段」虚高。
- **claim recall**：金标关键词组命中 + `sourceItemIds` 重叠（非全文精确匹配）。
- **must-not**：仅在列出路径上独立判定；局部否定/纠正窗口（如「不是…」「未采纳…」）不记为断言禁令。
- **preserve / coverage**：必保留数字术语（允许阿拉伯↔中文数字变体）；early/mid/late span。
- **Case C**：期望空 `decisions` / `actionItems`。

## 4. 调用渠道与合并口径

### 4.1 渠道

- Provider/model 形如：`nowcoding/grok-4.5`、`gpt-aixoras/gpt-5.5`、`alibaba-cn/glm-5.2`、`gpt-aixoras/gpt-5.4-mini`、`alibaba-cn/qwen3.5-plus`、`opencode/mimo-v2.5-free`。
- High 变体：Grok 4.5 / GPT-5.5 使用 `--variant high`。
- 解析路径记录为 opencode 全局安装二进制（报告不写绝对用户路径）。
- **不是**各模型厂商原生 API 的等价对照；延迟含 CLI/会话开销。

### 4.2 参与合并的 rescore 目录（摘要）

| 模型 | 主要 run 目录（rescore 后） | attempts |
| --- | --- | --- |
| Grok 4.5 High | `20260720-214503468-22640`（3）+ `20260720-215623408-6628`（6） | 9 |
| GPT-5.5 High | `20260720-214503493-53136`（3）+ `20260720-215623408-41696`（6） | 9 |
| GLM 5.2 | `20260720-220147253-26852`（3）+ `20260720-220517859-23372`（6） | 9 |
| GPT-5.4 mini | `20260720-220147253-53012` | 3 |
| Qwen3.5 Plus | `20260720-214503469-1928` | 3 |
| MiMo V2.5 Free | `20260720-214503469-50112` | 3 |

早期 dry-run / 超时/空输出探测 run 不进入下列合并表。

## 5. 结果表（已重评分合并事实）

| 模型 | runs | valid | 严格 schema | composite | claim recall | must-not（valid） | preserve / coverage | median 延迟 | 延迟 range |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **Grok 4.5 High** | 9 | 9 | 100% | **98.3** | **93.3%** | **100%** | **100% / 100%** | **31716 ms** | 25164–38231 |
| **GPT-5.5 High** | 9 | 9 | 100% | **98.3** | **93.3%** | **100%** | **100% / 100%** | **53313 ms** | 47490–56002 |
| GLM 5.2 | 9 | 6 | **66.7%** | **66.7** | （随失败摊薄） | **100%**（valid） | （valid 侧高，全量因失败摊薄） | **46558 ms** | 33368–132633 |
| GPT-5.4 mini | 3 | 2 | ~67% | **65** | — | valid 侧清洁 | — | **36122 ms** | （样本内） |
| Qwen3.5 Plus | 3 | 2 | ~67% | **65** | — | valid 侧清洁 | — | **42727 ms** | （样本内） |
| MiMo V2.5 Free | 3 | **0** | 0% | **0** | 0 | 0（无 valid） | 0 | — | — |

### 5.1 分案 claim recall（Grok / GPT-5.5 High）

| Case | Grok / GPT-5.5 观察 |
| --- | --- |
| **A** | 事实召回均为 **80%**（金标中**一个非核心事实**持续漏提；非崩溃性失败） |
| **B** | **100%** |
| **C** | **100%**（空决定/行动项与禁令控制表现稳定） |

## 6. 逐模型判断

### Grok 4.5 High（`nowcoding/grok-4.5` + high）

- 9/9 严格有效；composite 与 GPT-5.5 并列顶尖；must-not / preserve / coverage 全满。
- 中位延迟约 **31.7 s**，约为 GPT-5.5 的 **60%**（约快 40%）。
- A 案 80% 与 GPT 同型，属金标非核心漏提，非模型独有缺陷。
- **适合**：同质量下更看重速度/成本的最终整理候选（本渠道）。

### GPT-5.5 High（`gpt-aixoras/gpt-5.5` + high）

- 9/9 有效；指标与 Grok 数值对齐（98.3 / 93.3% / 100%）。
- 中位约 **53.3 s**，更慢但样本内方差相对可控（约 47–56 s）。
- **适合**：默认「质量稳定优先」的最终整理（本渠道观察期内无 schema 翻车）。

### GLM 5.2（`alibaba-cn/glm-5.2`）

- 9 run 仅 **6 valid**，严格 schema **66.7%**，composite **66.7**（失败计 0 后）。
- 主要失败：`correctedText` 误写为 **`correctText`**；summary schema 不完整。
- valid 样本上 must-not 仍 100%，说明「能出对结构时」内容纪律尚可，但**结构服从不稳定**。
- 延迟跨度大（约 33 s–133 s），不适合作为默认最终整理。

### GPT-5.4 mini（`gpt-aixoras/gpt-5.4-mini`）

- 3 run / 2 valid，composite **65**；样本过小，仅作轻量参考。
- 有空输出/调用失败；不可与 High 档并列推荐。

### Qwen3.5 Plus（`alibaba-cn/qwen3.5-plus`）

- 3 run / 2 valid，composite **65**；至少一次 `json_parse_failed`。
- 有效案可接近满分，但稳定性不足以默认启用。

### MiMo V2.5 Free（`opencode/mimo-v2.5-free`）

- 3/0 valid，composite **0**。
- 一次 **OpenCode database lock** 属**基础设施干扰**，非模型语义结论。
- 另有未闭合/超长 JSON，导致解析失败。
- **不得外推**至 MiMo V2.5 Pro 或其它 MiMo 付费档。

## 7. 推荐策略

| 优先级 | 策略 | 依据 |
| --- | --- | --- |
| **本基准速度质量综合优先** | **Grok 4.5 High** | 与 GPT-5.5 的质量、召回和 9/9 有效率相同，中位延迟约快 **40%** |
| **同质量备选** | **GPT-5.5 High** | 9/9 全有效，但本轮没有证据证明其比 Grok 更稳定，且延迟更高 |
| 不默认 | GLM 5.2 / mini / Qwen3.5 Plus | schema 或样本稳定性不足 |
| 不据此结论 | MiMo V2.5 Free | 0 valid + 基建噪声；**不外推 Pro** |

**明确不能从本基准推出的结论：**

- **不能**确定生产管线中的**片段提取（extract）模型**选型——本基准是单次 correct+summarize，不是 `correct → extract → rolling → hierarchical merge → evidence verify`。
- **不能**替代真实长会、真实 ASR 噪声、token 成本与限流验收。
- **不能**将 opencode 渠道延迟/稳定性等同于厂商原生 API。

本轮不足以确定生产默认模型。生产配置仍应走应用内 `meetingAnalysis*` / `OVI_MEETING_ANALYSIS_*` 单模型配置，并在真实长会和生产分批管线上复验（见缺口审计）。

## 8. 局限

1. **合成 9-item 短/中内容**，非数小时真实会议。  
2. **无真实音频 / ASR**；输入已是干净/半干净文本片段。  
3. **单次请求**，不含生产 batching、rolling、evidence scrub、导出。  
4. **无价格、无真实 token** 记账。  
5. **每模型样本量有限**（顶尖档 9，次级档 3）。  
6. **经 opencode 渠道**，非厂商原生 API 等价测试；含 CLI/会话开销与偶发基建故障（如 database lock）。  
7. Case A 统一 80% 召回提示金标中存在易漏的非核心事实；自动关键词评分可能低估「换说法但正确」的表述。  
8. 未测 reasoning 等级网格、温度、多语言、极长上下文压测。

## 9. 下一步

1. 在**真实/半真实**会后转写上复跑（含 Qwen no-bucket 与 enhanced Fun 路径产出的 raw）。  
2. 拆成与生产一致的 **extract vs final** 分模型基准（短上下文提取 + 高能力归并）。  
3. 扩大 repeats；记录 token/费用；可选原生 API 对照。  
4. 对 GLM 等：强化 schema 约束提示或结构化输出通道，观察 `correctText` 类失败是否消失。  
5. 单独评估 MiMo V2.5 **Pro**（勿用 Free 结果外推）。  
6. 将 A 案漏提的非核心金标项做人工复核，区分「模型漏」与「评分过严」。

## 10. 相关路径

- `experiments/meeting-analysis/README.md`
- `experiments/meeting-analysis/output-schema.json`
- `experiments/meeting-analysis/score.js`
- `experiments/results/meeting-analysis/<run-id>/summary.json`（gitignore）
- 生产分析管线：`src/meeting/analysis/pipeline.js`、`evidence.js`、`prompts.js`
