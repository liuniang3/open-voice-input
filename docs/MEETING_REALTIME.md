# 会议实时转录

会议实时转录使用独立于短语音输入的会话、原生录音和持久化状态。Windows 使用 WASAPI，macOS 使用 AVAudioEngine 与 ScreenCaptureKit（macOS 13+）。录制时可选择阿里流式识别，或在阿里服务不可用时改用 `mimo-v2.5-asr` 非实时分段转录；停止后仍可选择 MiMo 全音频复核、独立 LLM 校订，并单独生成详细总结与思维导图。

本文描述当前开发版。阿里模型提供实时草稿，MiMo 备用模型按用户选择的转录间隔提交已落盘音频，不伪装成实时流。转录间隔与 Markdown 自动保存间隔分别设置、互不等待，默认均为 30 秒。

## 模型和凭证

| 环节 | 当前模型 / 接口 | 何时调用 |
| --- | --- | --- |
| 会议转录 | 默认 `qwen-audio-3.0-asr-flash-streaming`，可选 `fun-asr-realtime`；备用 `mimo-v2.5-asr` 非实时分段模式 | 阿里模型持续流式发送；MiMo 按所选间隔提交独立片段；停止后均可重试缺口 |
| 音频复核 | 可选 `mimo-v2.5-asr`，普通 MiMo ASR API | 停止并完成音频收尾后，勾选复核并执行校订 |
| 文本校订 | 单独选择、配置的 MiMo 或 OpenAI 兼容 LLM | 用户明确执行校订 |
| 总结 / 思维导图 | 界面当前所选的校订 / 摘要 LLM | 用户单独点击“生成摘要” |

两个阿里实时模型使用 `/api-ws/v1/inference` 的 `run-task` / `finish-task` 协议，默认地址为 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`。应配置与模型、地域及账号相匹配的地址和 Key。常见 HTTPS REST 基址会转换为同主机的 WebSocket 路径；不会因为切换模型而替换成另一个模型的凭证。

`qwen3-asr-flash-realtime` 使用不同的 `/realtime` 协议，不能当作新 Streaming 模型使用；普通 `fun-asr` 文件接口也不是 `fun-asr-realtime`。当前会议流式传输只接受上述两个准确的阿里模型 ID。`mimo-v2.5-asr` 走普通 MiMo 文件式 ASR API，不建立 WebSocket，也不会显示尚未定稿的实时草稿。

MiMo 会议转录和会后复核都使用共享的普通 MiMo API 地址与普通 API Key，不接受 Token Plan。阿里实时识别、MiMo ASR 和 LLM 各按所选模型解析配置，不跨供应商借用 URL 或 Key。选择阿里转录且不开启复核时不会要求 MiMo 凭证。

## 音源和权限

| 模式 | Windows | macOS |
| --- | --- | --- |
| 仅麦克风 | WASAPI capture 端点 | AVAudioEngine，需要麦克风权限 |
| 仅系统声音 | WASAPI render 端点 loopback | ScreenCaptureKit，需要屏幕/系统音频录制权限 |
| 麦克风 + 系统声音 | 两条独立 WASAPI 音轨 | AVAudioEngine + ScreenCaptureKit，需要对应两类权限 |

**仅系统声音不打开麦克风、不请求麦克风权限。** macOS 的此模式也不创建 AVAudioEngine。Windows 在激活音频客户端前校验所选端点方向；错误设备或不支持的新模式会报错，不能回落到麦克风。

macOS 系统音源是显示器过滤的系统混音，不是 Windows 的硬件输出端点。ScreenCaptureKit 的视频回调立即丢弃，不保存屏幕画面。自动粘贴另需辅助功能权限，与会议录音分开。屏幕权限变更可能要求重新启动，最终签名应用的权限归属仍需 Mac 实机检查。

## 使用流程

1. 在会议模型设置中配置所选模型：阿里 Streaming / Fun-ASR 使用阿里连接，`mimo-v2.5-asr` 使用普通 MiMo 连接。会后需要校订时，另行配置 LLM。
2. 打开“会议实时转录”，选择仅系统声音、仅麦克风或双轨，可提前选择 Markdown 文件路径，并分别选择转录间隔和自动保存间隔。
3. 点击开始，或按设置中的会议快捷键。再次按快捷键只置前当前会话。
4. 录音始终先写入本地。阿里模式再以有界 PCM 数据包发送到 WebSocket，实时草稿可以被后续草稿替换，只有确认句子进入已确认原文。MiMo 模式按转录间隔封存并提交独立片段，界面明确显示“非实时分段转录”。
5. 录制时可切换悬浮窗、精简视图和置顶，再返回详情；窗口切换不新建录音、不触发模型处理。暂停/继续保留同一会话，也可在暂停时停止。
6. Markdown 按所选自动保存间隔独立保存，默认 30 秒，暂停和停止时也会保存。网络请求不会阻塞原生音频落盘，自动保存不以 ASR 返回为前提；调整保存间隔不会改变转录分段。
7. 停止后等待原生尾段封存、WAV 收尾以及流式或分段任务结束确认。超时或连接失败会保留缺口供重试，不能当作全部转写完成。停止本身不触发会后复核或 LLM。
8. 按需执行下述校订与总结。录制或暂停状态都不能运行会后处理；实时流程不做讲话人分离。

## 暂停和悬浮窗

暂停前封存当前未满分块的音频；原生日志写入 `pause_begin` / `pause_end`。继续录制沿用原来的文件序号与音轨，不重新覆盖音频。Windows 暂停/继续结果会有界等待各写入线程确认；macOS 通过串行归档队列完成封存和日志操作。

暂停期间的源音频帧被丢弃，不作为录音内容保存；暂停不等于释放音频设备或撤销权限。系统-only 始终没有麦克风采集。WAV 保留已采集音频及时间轴空洞，不能把暂停区间理解为实际录到的声音。实时连接在暂停时收尾，继续后从后续归档位置发送，显示时长在暂停时冻结。

悬浮、精简、置顶都是会议窗口状态。录音状态以后台确认结果为准，恢复详情不会重启会话；退出应用仍需完成停止和最终保存。

## 会后复核与校订

“校订”使用独立选择的 LLM；可选项“MiMo 音频复核”决定是否先重新识别完整保存音频。

- **开启复核：** 按时间顺序覆盖完整录音，包含已保存的静音区间。当前 MiMo 适配器每个请求最多 30 秒、2 MiB，在上限附近尽量找安静边界。每段音频和结果均有检查点，完成的段落校验后可复用。复核处理的是全部音频，不只取开头、尾部或已有转写缺口。
- **不开启复核：** LLM 只依据实时原文校订，不调用 MiMo ASR，也无法凭文本恢复没有识别出的音频内容。
- **独立 LLM 校订：** 有复核结果时结合阿里原文与 MiMo 证据，按有界文本窗口处理。要求修正有依据的识别错误、删除无语义口头词，不做压缩总结；保留有意义的重复、数字、否定和条件。存在分歧或边界不确定时标记待确认，并保留来源版本供核对。

源引用、格式和内容保留检查可以阻止一部分错误输出，但不能证明模型语义判断正确。原始转写、MiMo 复核稿和校订稿分别保留，人工复核仍应对照音频。更改模型、来源或处理选项可能产生新的任务与结果；不要把旧检查点视为不同模型的可互换结果。

## 总结和思维导图

“生成摘要”是独立操作，不会因录音停止、复核或校订完成而自动运行。已有完成的校订结果时使用校订稿，否则使用原文。可在执行前重新选择校订 / 摘要模型；它与实时 ASR、可选复核 ASR 的凭证独立。

结果包括讨论详情、决策、行动事项、分歧和待确认问题，以及带层级的思维导图。长文本分批生成再合并，条目和导图节点附带来源证据，不应编造负责人、期限或结论。界面显示层级结构；Markdown 导出包含嵌套列表形式的导图和详细纪要，不承诺独立图片文件。重新校订后需重新生成相应总结。

## 文件保留

- 未指定位置时，在系统“文稿/Documents”下的 `Open Voice Input/Meetings/` 新建唯一 Markdown 文件。
- 如果所选 Markdown 已存在，会在文件中追加本次会议的独立标记区块，热保存只更新该区块，保留区块外原笔记及后续编辑。界面显示实际输出路径。
- 如果录制时用外部编辑器修改本次会议的标记区块，自动保存会提示冲突；最新原文仍保存在本机会话记录中，外部修改不被覆盖。停止后点“重试未完成片段”会在默认目录新建恢复稿；最终保存成功前退出会被阻止。避免让多个程序同时重写同一会议区块，文件系统不提供跨编辑器的事务锁。
- 会话目录在 Electron 的 `userData/meeting-sessions/<会话编号>/` 下。Windows 默认 `%APPDATA%/open-voice-input`，macOS 默认 `~/Library/Application Support/open-voice-input`。
- 启用音轨的 `audio/microphone/`、`audio/system/` 保留原生采样格式 PCM、索引和日志。创建会话可能预建空目录；仅系统模式不会写入麦克风录音。已有录音目录禁止作为新的原生写入器目标。
- 启用音轨分别写入 `realtime/microphone-complete.wav`、`realtime/system-complete.wav`，保留完整 16 kHz 单声道音频。没有按 API 上限截断；超过 RIFF 上限时使用 RF64 头。原生 PCM 保持不变，WAV 是派生完整音频。
- 转写将两个来源按时间窗口混合，不生成讲话人标签。使用耳机可减少扬声器声音再次被麦克风录入造成的重复；目前没有回声消除。
- `realtime/state.json` 保存音频读取位置、流式窗口、确认文本和失败状态。实时草稿如写入 Markdown，会单独标注“尚未确认的实时文字”，不能混作确认原文。
- 原始 `.md` 之外，可选复核写入 `.reviewed.md`，校订写入 `.cleaned.md`，详细总结与导图写入 `.summary.md`。派生文件已存在时另选文件名，界面显示实际路径，保留以前的输出和用户编辑。
- `realtime/postprocess/<内容指纹>/` 保存复核、校订、总结的任务检查点和结构化结果。分段、缓存、网络重试都不删除或缩短本地音频。

## 失败与恢复

转录从持续写入的完整归档读取有界音频。阿里模式轮换流式连接窗口，MiMo 模式按所选转录间隔建立独立分段任务；两者都不限制会议总长度，也不会为满足供应商限制而截断本地音频。断线或请求失败后，未完成窗口、未发送区间、分段任务及已确认句子保留检查点。失败项不会因为后续请求成功而消失，停止后可以明确重试；不能仅按文本相同就删除真实重复发言。

重启会读取历史会话及持久化状态，修复音频头和未登记的已落盘尾段。不会自动启动录音或发送 API 请求，用户可选择会话后重试。恢复依赖已经写入磁盘的内容，突然断电时尚未提交的操作系统/设备缓冲不能保证恢复。

MiMo 复核、LLM 校订和总结分别保留有界任务及检查点。超时、截断返回、无效 JSON 或缺乏有效证据会留下可重试状态，不能发布为完整成功。恢复时对音频和任务输入进行校验，复用匹配的已完成结果；失败任务由显式操作继续，不自动重跑整场会议。

原生采集、转写网络请求和可配置的 Markdown 自动保存计时器相互独立。ASR 网络故障不应停止录音；磁盘写入失败或设备故障仍可能使原生采集停止，此时应保留已提交音频并恢复，不能继续宣称录制正常。

## 开发接口和验证

先调用 `createAndPrepareSession()` 取得 `sessionId`，再调用共享采集服务：

```js
await service.start({ sessionId, captureMode: "system", systemDeviceId });
await service.pause(sessionId);
await service.resume(sessionId);
await service.stop(sessionId);
```

`captureMode` 支持 `microphone`、`dual`、`system`，默认 `dual`。兼容接口 `startMicrophone()`、`startDual()` 保留，并新增 `startSystem()`。系统单轨要求 helper hello 声明 `system_only`；旧 helper 会报 `helper_capability_missing`，应重新构建，不能用双轨静音麦克风来替代。

```text
npm run build:helper
npm run check:helper
node scripts/test-meeting-system-capture.js
node scripts/test-meeting-native-system.js
node scripts/test-ali-meeting-stream.js
node scripts/test-meeting-preview.js
node scripts/test-meeting-postprocess.js
npm run test:all
```

Windows 原生单元测试需在 MSVC 开发环境执行 `cargo +1.85.1 test --locked --manifest-path native/audio-capture-helper/Cargo.toml`。`test:all` 自动发现新增测试。平台 CI 包含 Windows x64、macOS Intel 和 Apple Silicon 构建；提供 CI 配置不等于本次未提交改动已经在这些 runner 上通过。

## 验证边界

自动化覆盖三种音源的共享接口、旧 helper 拦截、暂停/恢复、原生合成 PCM 封存、流式协议和重试、完整音频复核、独立校订/总结、凭证隔离及窗口控制。协议和模型测试使用模拟响应；不代表真实供应商账号、地域或服务质量已验证。

本次原生开发验证在 Windows 完成 release 构建、Rust 单元测试和无硬件录音的协议检查。开发机原有 release EXE 被占用时，曾在 `native/audio-capture-helper/target/system-only-validation/` 独立构建；旧进程退出后，默认打包路径 `native/audio-capture-helper/target/release/audio-capture-helper.exe` 已通过正常构建更新并通过 `npm run check:helper`，原二进制以重命名文件保留。新增原生测试可用 `OVI_SYSTEM_CAPTURE_HELPER` 指定待测二进制。

macOS 的 Swift SDK 构建、系统-only 权限行为、真实采集和粘贴均需在 Mac 上分别验证，本次不作已通过的声明。多小时真实会议、设备拔插、睡眠唤醒、权限拒绝后重新授权、DRM 静音和双轨回声仍需实测。原生 helper 不执行 ASR、校订或总结。
