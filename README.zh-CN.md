# Open Voice Input

当前开发版支持 Windows/macOS 和 **会议实时转录**：默认阿里 `qwen-audio-3.0-asr-flash-streaming`，也可选 `fun-asr-realtime`，实时草稿与已确认原文分开显示。支持仅麦克风、仅系统声音、双轨、悬浮窗和暂停/继续；完整音频持续保留，Markdown 独立每 30 秒自动保存。停止后可选 MiMo 全音频复核，再由独立配置的 LLM 校订；详细总结与思维导图另行触发。详见 [会议实时转录与恢复说明](docs/MEETING_REALTIME.md)。

macOS 使用 AVAudioEngine 采集麦克风、ScreenCaptureKit 采集系统声音（macOS 13+）。仅系统模式不会打开麦克风，也不会请求麦克风权限，但仍需要屏幕/系统音频录制权限；自动粘贴另需辅助功能权限。已提供 Apple Silicon/Intel 构建配置，本次更新不宣称通过 Mac 真机采集或粘贴验证。在装有 Xcode Command Line Tools 的 Mac 上执行 `npm run dist:mac`，Windows 继续执行 `npm run dist`。

一个支持可插拔 ASR 供应商和可选 LLM 文本清理的桌面语音输入助手。

Open Voice Input 目前是 Electron MVP，不是真正的 Windows 输入法驱动。它会录制语音，通过用户选择的 ASR 供应商转写文本，再按需调用文本模型清理口头词、重复片段和标点，最后写入剪贴板，并尝试粘贴到之前光标所在的应用里。

英文文档见：[README.md](README.md)

## 当前版本更新

- 会议实时转录改用阿里 Streaming 或 Fun-ASR 实时接口；停止后可选 MiMo 全音频复核、独立 LLM 校订，再单独生成详细总结和思维导图。
- 会议新增真正的仅系统声音采集、悬浮/精简窗口、可选置顶和暂停/继续；保留完整 WAV、原生音频及独立的 30 秒 Markdown 自动保存。
- 第一阶段已改为可插拔 ASR：优先适配专用 `mimo-v2.5-asr`，并支持 Qwen3-ASR 和 Fun-ASR。
- Qwen3-ASR 与 Fun-ASR 支持 WebSocket 实时预览；MiMo 使用周期性音频片段预览，最终结果始终由完整录音重新转写。
- `Stable` 模式将原始 ASR 文本交给 MiMo 或 OpenAI 兼容小模型进行口头词、重复片段和标点清理；`Fast` 模式只执行 ASR。
- 设置已整合进无边框主界面，并新增独立的“供应商连接”页。
- MiMo 全部模型共用一套 MiMo 连接，Qwen/Fun-ASR 共用一套阿里连接，GPT/OpenAI 模型共用一套 OpenAI 连接。OpenAI URL 可以填写 NowCoding 等自定义网关，并可选择 Responses 或 Chat Completions；Grok、GLM 等其他供应商仍按模型独立保存连接。
- API Key 支持显示、隐藏和一键复制，便于本机检查配置；Key 仍只保存在 `%APPDATA%\\open-voice-input\\settings.json`，不会进入安装包或仓库。
- 录音统一转换为 16 kHz、单声道、16-bit PCM WAV；长录音会按当前 ASR 供应商上限自动分段、提前转写并缓存，结束后按顺序拼接。
- 新增独立文件转写工作区：可导入音频或视频、单独选择 ASR 模型、生成校订文本与结构化总结，并导出 Markdown、TXT 或 Word。
- 设置、会议和文件工作区支持自绘最小化、最大化/恢复、窗口拖动与边缘缩放。
- 新增 Windows x64 安装版、单文件便携版、GitHub Release 自动构建和 SHA-256 校验。
- 构建过程不会打包 `.env` 或本机用户设置，并会在生成发布包前扫描疑似真实 API Key。

## 推荐配置

**会议实时转录**选择 `qwen-audio-3.0-asr-flash-streaming` 或 `fun-asr-realtime`，只需配置一次阿里根地址和 Key；程序会从同一连接派生兼容、REST 和 `/api-ws/v1/inference` 地址。可选的会后 MiMo 复核使用共享的普通 MiMo 连接。校订/摘要模型使用所属供应商连接，不借用其他供应商凭证。

**短语音输入**仍优先适配专用 `mimo-v2.5-asr` 及普通 MiMo API，也支持 Qwen3-ASR 和 Fun-ASR。此推荐不改变会议工作区的阿里流式默认模型。

第二步文字清洗不需要很大的模型。推荐使用 GPT-5.4 mini，或其他兼容 OpenAI 接口的小模型，用来删除口头词、合并重复片段并补充标点。

## 功能

- 全局快捷键录音
- 小型悬浮实时转写窗口
- 任务栏托盘菜单进入设置
- 可配置麦克风、快捷键、API Key、Base URL、供应商和模型
- ASR 供应商：MiMo-V2.5-ASR、Qwen3-ASR、Fun-ASR
- 文本清理供应商：MiMo 聊天清理、OpenAI 兼容接口清理
- `Fast` 模式：只做 ASR，延迟更低
- `Stable` 模式：先 ASR，再用 LLM 清理口头词、重复片段和标点
- 转写后写入剪贴板，并尝试粘贴到之前的焦点应用
- MiMo/Qwen 批处理长录音自动分段，稳定模式只在完整拼接后执行一次文本清理
- 本地兜底清理常见口头词、重复片段和提示词泄漏式输出
- **独立文件转写**：从托盘或主界面进入，导入音频/视频后选择 ASR，按“原始转写 → 校订文本 → 结构化总结”处理，并导出 Markdown、TXT 或 Word。
- **会议工作台媒体导入**（WAV 与常见音视频，经打包 FFmpeg）：源流式复制，只抽取**首音轨**，生成本地 16 kHz 单声道 archive，需手动点「生成原文」。**基础模式不需要 OSS。** 默认 Qwen no-Bucket **不会**凭空做说话人分离。
- **会议增强转写（可选）**：工作台可选「增强」模式，系统轨经 OSS 私有上传 + Fun-ASR 说话人分离（32/48/64 kbps）；设置页配置 Fun/OSS 并分别测试连接。详见 [docs/MEETING_STAGE_4C.md](docs/MEETING_STAGE_4C.md)。

**媒体导入限制：** 仅首音轨；未验证全部 codec/容器；未宣称真实超长视频验收。安装包/便携版额外约 **80MB**（单个 FFmpeg）。二进制为 **FFmpeg 6.1.1**（gyan.dev essentials GPL，经构建时 `ffmpeg-static@5.3.0`）。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [docs/FFMPEG_MEDIA_IMPORT.md](docs/FFMPEG_MEDIA_IMPORT.md)。

## 音频大小与模型上限

下述分段和内存缓存说明适用于**短语音输入**。会议实时转录会持久化重试检查点，保留完整原生音频及 WAV。可选 MiMo 复核通过有界请求覆盖整段录音，不因供应商上限截短本地文件；当前会议适配器每次请求最多 30 秒、2 MiB，并尽量在安静区间划分边界。

客户端以 16 kHz、单声道、16-bit PCM WAV 作为统一上传格式。Base64 体积约为每分钟 2.6 MB，约为此前常见 48 kHz 录音的三分之一，同时保留语音识别所需频段。

- MiMo `mimo-v2.5-asr`：官方限制 Base64 编码后的字符串不超过 10 MB。客户端在约 180 秒后优先寻找停顿分段，最晚约 210 秒强制封存，保留安全余量。
- Qwen3-ASR-Flash：官方限制单文件不超过 10 MB、时长不超过 5 分钟。批处理使用与 MiMo 相同的安全分段区间；实时模式直接持续发送 16 kHz PCM 流。
- Fun-ASR：官方异步文件接口支持不超过 2 GB、12 小时；本项目的本地麦克风使用 WebSocket 流式传输，并按较长区间分段保护重试数据。

分段文本只保存在当前进程内存中，不写入磁盘。`Fast` 模式直接拼接各段原始转写；`Stable` 模式先拼接全部转写，再调用一次清理模型，避免每段分别清理导致上下文割裂。

来源：[MiMo-V2.5-ASR 语音识别](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition)、[阿里云非实时语音识别](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide)、[阿里云实时语音识别](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)。

## 安装

推荐从 GitHub Releases 下载 Windows 发布版：

- `Open Voice Input-Setup-<版本>-x64.exe`：安装版，创建开始菜单和桌面快捷方式。
- `Open Voice Input-Portable-<版本>-x64.exe`：单文件便携版，复制到另一台 Windows 电脑后直接运行。

发布版不需要安装 Node.js、npm 或 Electron。首次启动没有可用 API Key 时会自动打开设置窗口；填写 ASR 和可选文本清理 API 后即可使用。

安装版和便携版都把本机配置保存在：

```text
%APPDATA%\open-voice-input\settings.json
```

因此把便携版复制到另一台电脑不会同时复制原电脑的 API Key。

### 从源码运行

需要：

- Windows，或 macOS 13+（Mac 原生采集/粘贴仍需真机验证）
- Node.js 20 或更新版本
- npm
- 原生会议采集需要 Windows 上的 Rust 1.85.1 与 MSVC C++ Build Tools，或 Mac 上的 Xcode Command Line Tools；执行 `npm run build:helper` 和 `npm run check:helper`。

安装依赖：

```powershell
npm install
```

可选环境变量文件：

```powershell
Copy-Item .env.example .env
```

桌面端推荐直接在每个模型自己的配置中填写 Key。为兼容自动化部署，Qwen、Fun-ASR、清理模型和会议模块仍支持各自的环境变量作为空配置兜底；已保存的模型配置优先：

```text
DASHSCOPE_API_KEY
QWEN_ASR_API_KEY
FUN_ASR_API_KEY
CLEANER_API_KEY
CLEANER_BASE_URL
OVI_MEETING_QWEN_API_KEY
OVI_MEETING_FUN_ASR_API_KEY
OVI_MEETING_ANALYSIS_API_KEY
```

## 启动

发布版直接双击安装后的快捷方式或便携版 `.exe`。

从源码运行时，无控制台窗口双击启动：

```text
Start Open Voice Input.vbs
```

带调试控制台双击启动：

```text
Start Open Voice Input.cmd
```

命令行启动：

```powershell
npm start
```

## 构建发布版

生成安装版和便携版：

```powershell
npm install
npm run dist
```

构建产物位于 `dist/`。构建前会自动运行 API Key 扫描和测试；`.env`、日志、录音和用户设置不会进入安装包。

推送 `v*` 标签后，`.github/workflows/release.yml` 会在 GitHub Actions 中构建两个 Windows `.exe`、生成 `SHA256SUMS.txt`，并上传到 GitHub Releases。

## 短语音使用

1. 启动程序。
2. 右键任务栏托盘图标，打开 `设置`。
3. 设置 ASR 供应商、文本清理供应商、API 凭证、麦克风和全局快捷键。
4. 按全局快捷键呼出录音窗口。
5. 悬浮窗显示录音或实时转写时开始说话。
6. 按 `Enter` 结束录音。
7. 程序会把最终文本写入剪贴板，并尝试粘贴到之前光标所在位置。

默认短语音快捷键：`Ctrl+Alt+M`。默认长内容转录快捷键：`Ctrl+Alt+Shift+M`，触发后会打开并置前会议工作台。设置快捷键时会检查应用内重复、Windows 保留组合和已被其他程序占用的全局组合；Windows 无法提供占用程序的名称。

## 会议实时工作流

1. 配置所选阿里实时模型，打开会议工作区，选择音源和 Markdown 保存位置。
2. 开始录制。实时草稿可以变化，已确认句子按顺序保留；Markdown 每 30 秒独立保存，不等待 ASR 返回，各启用音轨同时保留完整音频。
3. 可切换悬浮窗或精简视图、选择置顶，再返回详情；暂停/继续操作的是同一个会话。暂停期间的声音不会作为录音内容保存，原生日志记录暂停空洞，也可在暂停状态直接停止。
4. 停止后等待音频收尾和流式任务完成；有转写缺口时从保留音频重试。停止不会自动调用 MiMo 或 LLM。
5. 按需勾选 **MiMo 音频复核**、选择其 ASR 配置，再用单独选择的 LLM 执行**校订**。复核以有界分段覆盖全部保存音频；不勾选时只校订实时原文。保留有意义的重复及尚未解决的分歧，原文始终保留。
6. 单独点击**生成摘要**，得到详细纪要与层级思维导图。已有完成的校订稿时以它为依据，否则使用原文；校订完成不会自动生成总结。

输出分别为原始 `.md`、可选 `.reviewed.md`、校订 `.cleaned.md` 和包含纪要及思维导图的 `.summary.md`。派生文件重名时另选文件名，已有文件不覆盖，以界面显示的实际路径为准。原生 PCM、完整 WAV 和重试检查点保存在会话目录。权限、恢复和文件结构详见 [完整说明](docs/MEETING_REALTIME.md)。

## 供应商

ASR 供应商：

- `MiMo`：默认使用官方 `mimo-v2.5-asr` 专用 ASR 模型，支持普通 MiMo API 地址和流式返回解析，是目前本项目适配度最高的第一步语音后端。
- `Qwen3-ASR`：通过 DashScope/OpenAI 兼容配置接入专用 ASR，支持非实时和实时模式。
- `Fun-ASR`：通过 DashScope 接入专用 ASR。本地麦克风录音使用 WebSocket 实时协议；公网音频 URL 可走官方 REST 批处理。

文本清理供应商：

- `MiMo`：通过 MiMo 聊天模型清理文本，可选择 MiMo V2.5 或 MiMo V2.5 Pro。
- `OpenAI 兼容接口`：通过任意兼容聊天接口清理文本，内置 GPT-5.4 mini 和 Grok 4.5 模型预设，并继续支持自定义模型 ID。

目前综合推荐使用 GPT-5.4 mini。MiMo 的 ASR、清理和复核共用 MiMo 连接；Qwen 与 Fun-ASR 共用阿里连接；GPT 清理和分析共用 OpenAI 连接。OpenAI 连接既可填写官方地址，也可填写 NowCoding 等兼容网关，并选择 Responses 或 Chat Completions。Grok、GLM 等其他兼容模型继续独立保存 URL/Key，避免凭证跨供应商串用。

## 短语音转写模式

`Fast` 模式只执行 ASR。延迟更低，适合 ASR 模型本身已经足够干净的情况。

`Stable` 模式执行两步：

1. ASR 供应商返回原始转写文本。
2. 文本清理供应商使用保守的“删除跨度”方法，仅删除明确的口头词、结巴、假启动和意外重复，并补充标点。

清洗模型被禁止改写、扩写、重排或总结。程序还会在本地验证模型结果：清洗文本必须来自原文字符顺序，且不能删除过量内容；验证失败、JSON 格式错误或清洗请求失败时直接回退到原始 ASR 文本，不让已经成功的语音识别一并失败。

每次录音都会使用录音开始时锁定的设置快照，因此录音处理中途修改设置只会影响下一次录音。

实时模式中的文字只作为录音过程中的预览。Qwen3-ASR 和 Fun-ASR 使用供应商的实时 WebSocket；MiMo `mimo-v2.5-asr` 目前按官方文件式接口做周期性片段预览，并不是真正的低延迟 WebSocket 实时识别。按 `Enter` 结束录音后，程序会用同一段完整录音重新生成最终转写；如果当前是 `Stable` 模式，最终转写还会继续进入第二步文本清理。这样可以减少实时分段、短暂停顿和供应商临时标点对最终输入结果的影响。

## 隐私

程序将所选会话音频发送到配置的 ASR 端点，仅在明确执行会后处理时将转写证据发送给所选 LLM。可选 MiMo 复核会通过有界请求上传全部保存音频，不会自动上传剪贴板内容。macOS 的 ScreenCaptureKit 需要屏幕/系统音频权限，但视频回调会被丢弃，不归档屏幕画面。

如果在设置中保存 API Key，Key 会存放在 Electron 用户数据目录，不会进入程序安装包。公开仓库、演示或交给他人使用时，建议使用环境变量或本地 `.env`，不要把真实 Key 提交到 Git。

运行日志路径：

```text
%APPDATA%\open-voice-input\open-voice-input.log
```

## 会议工作台（现状）

历史会议工作台与[会议实时工作流](docs/MEETING_REALTIME.md)并存。原生采集支持仅麦克风、仅系统、双轨；Windows 使用 WASAPI 输出端点混音，macOS 使用 ScreenCaptureKit 显示器过滤的系统声音。采集层说明见 [docs/MEETING_STAGE_0B.md](docs/MEETING_STAGE_0B.md)；增强分离见 [docs/MEETING_STAGE_4C.md](docs/MEETING_STAGE_4C.md)。

**已实现：** L0 采集与会话恢复；基础转写（Qwen no-Bucket，无需 OSS，但仍向 ASR 发送音频）；可选说话人分离（系统轨 OSS + Fun-ASR）；校订/总结；媒体导入（首音轨）；导出/回放/说话人显示名；设置页 Fun/OSS 配置与连接测试。实时 `fun-asr-realtime` 不依赖此 OSS 流程，也不生成讲话人标签。

**当前限制：**

- **基础转写**不分多人说话人（系统侧多为 `remote_unknown`）。
- **说话人分离**需配置 Fun-ASR + OSS；仅系统轨走 Fun，麦克风仍走 Qwen。
- 媒体导入只取**首音轨**；未宣称全 codec / 超长视频验收。
- **未做**回声消除（AEC）、进程级 loopback 隔离、真实多小时腾讯会议共存验收、L1 高质量转换。
- DRM 可能使系统轨静音；采集可能含本应用自身声音。

```powershell
npm run build:helper
npm run check:helper
npm run test:meeting
npm run test:meeting:ui
npm run test:meeting:4c
```

## 当前缺点

- 这不是真正的 Windows IME，只是全局语音输入助手。它依赖剪贴板和粘贴动作，部分软件可能拦截、延迟或拒绝粘贴。
- 焦点恢复和自动粘贴受目标应用、管理员权限窗口、远程桌面、浏览器输入策略和 Windows 安全策略影响，不保证所有场景都成功。
- 实时 ASR 质量受麦克风、网络延迟、供应商行为和模型版本影响。
- 如果第一步 ASR 已经听错，第二步文本清理只能整理已有文本，不能恢复没有听准的内容。
- 文本清理模型仍可能把有意义的重复误判为结巴，或过于保守地保留自我修正。当前已关闭本地重复词正则，并通过最小编辑提示词和结果校验降低误伤，但无法从纯文本中彻底消除语义歧义。
- 目前没有自动更新和代码签名。未签名的发布版可能触发 Windows SmartScreen，公开分发时需要用户手动确认运行。
- 会议：基础不分多人；增强依赖 Fun+OSS；首音轨导入；无 AEC / 未做真实多小时验收（见上文与 docs/MEETING_STAGE_4C.md）。

## 许可证

MIT
