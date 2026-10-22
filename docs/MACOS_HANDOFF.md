# Open Voice Input：macOS 共创交接

交接日期：2026-10-20。基线为 v0.4.25 / e595ff823476cc8d90e43a72b6bef20f87991a79。本文基于当前仓库代码整理，不包含原始聊天历史或任何真实凭证。

## 目标与完成标准

把已有 macOS 实现通过真实设备验证、修复到可持续使用，并与 Windows 共用业务逻辑。不是重新开发 Mac 产品，也不是把当前应用改写成系统输入法驱动。

首阶段应交付：可复现的 Mac 环境、填好的真机验收记录、针对已复现问题的小范围 PR、共享测试与 Windows/macOS CI 结果。优先解决不能录音、不能输入、数据丢失和快捷键失效，再打磨窗口、权限提示和分发体验。

“能编译”“CI 通过”“在 Mac 上运行过”“真实用户场景通过”是不同证据。没有真机结果的条目保持未验证。

## 项目现在做什么

| 功能 | 当前行为及不能破坏的约束 |
| --- | --- |
| 语音输入法 | 快捷键录音；Fast 输出识别结果，Stable 再做表达整理。整理理解上下文并写成连贯段落，保留含义及尾句，不应机械删除正常叠词。自动输入使用原生键盘事件，不改写剪贴板。 |
| 实时预览 | 根据所选 ASR 模型能力使用对应协议，不能把非实时 MiMo 请求当作阿里 WebSocket。短语音小窗固定尺寸，文字滚动，背景频谱、透明圆角、跟随光标附近展开。 |
| 文件转写 | 独立页面导入音频或视频；FFmpeg 提取/转换音频，按供应商限制分段，保存原文，再显式生成摘要。支持 Markdown、TXT、Word 导出。 |
| 实时会议 | 麦克风、仅系统音频、两者同时录制。阿里流式区分临时草稿与确认文本；MiMo ASR 可做非实时分段备用。暂停、停止、重试、历史及完整音频保留独立于页面显示。 |
| 会后摘要 | 文件和实时会议共用生成逻辑：左侧层级思维导图，右侧按上下文重写的连贯正文；可附带 MiMo 全音频复核作为第二份证据。不是简单纪要列表，不自动替换原文。 |
| 设置与供应商 | 左侧四个设置页：语音识别、表达整理、语音识别历史、关于与更新。ASR 与文本供应商分开；文本供应商支持自定义多个连接和 Chat Completions/Responses，模型列表动态获取并可设置能力参数。 |
| 主页、历史与更新 | 主页显示快捷键、用量、两个功能入口和分类历史。菜单栏/托盘可开识别历史并设置其快捷键；支持 GitHub 更新与可选开机自启。 |

语音识别的其他功能默认选择应跟随用户实际在用的模型，避免在 Mac 分支重新写死默认值。相关解析从 src/asr-defaults.js、src/settings/ 与当前 UI 逻辑追踪，不只看 main.js 的初始常量。

## 已完成与仍需验证

v0.4.25 发布时，76 个共享回归脚本、Windows x64、Intel Mac x64、Apple Silicon Mac arm64 CI 与正式包构建均通过。对应记录：

- [发布源码平台 CI](https://github.com/liuniang3/open-voice-input/actions/runs/39230410878)
- [正式发布构建](https://github.com/liuniang3/open-voice-input/actions/runs/39230410244)
- [Release 与安装包](https://github.com/liuniang3/open-voice-input/releases/tag/v0.4.25)

Windows 有实际快捷键、普通/富文本框直接输入、Codex 输入框定位及弹窗录屏证据。Mac 的原生采集、系统权限归属、直接输入、三指拖动、光标定位和动画尚未完成硬件验收。双架构构建成功不能代替这些验收。

Mac 当前包未签名、未公证。权限、系统安全提示和后续更新行为必须用最终打包 app 验证；不要全局关闭系统安全机制来掩盖问题。Developer ID 签名、公证以及签名材料应单独规划，私钥和证书不进入 Git 仓库。

## 技术结构与入口

应用使用 Electron 39.8.9，前端是共享 HTML/CSS/普通 JavaScript，Node 侧使用 CommonJS；没有 React/Vite 重构要求。Windows 采集是 Rust/WASAPI，Mac 采集是 Swift/AVAudioEngine + ScreenCaptureKit。FFmpeg 随平台打包。

| 修改目标 | 优先读取的文件 |
| --- | --- |
| 生命周期、窗口、IPC、快捷键与本机设置 | [src/main.js](../src/main.js)、[src/preload.js](../src/preload.js)、[src/hotkeys/validate-hotkey.js](../src/hotkeys/validate-hotkey.js) |
| 主页、设置、快速上手、识别历史 | src/renderer/home-ui.js、settings-workspace.js、onboarding-ui.js、voice-history-ui.js、index.html |
| 短语音录制与小窗 | src/renderer/renderer.js、src/dictation-preview.js、src/renderer/dictation-preview.js、src/renderer/recording-spectrum.js |
| 光标定位、窗口动画 | src/dictation-placement.js、src/window-motion.js、src/renderer/dictation-motion.js |
| Mac 权限、目标进程、直接输入 | [src/platform/macos.js](../src/platform/macos.js)、[native/macos-audio-capture-helper/Sources/Main.swift](../native/macos-audio-capture-helper/Sources/Main.swift)、Sources/InputContext.swift |
| Mac 双轨录音和不可变归档 | [原生组件说明](../native/macos-audio-capture-helper/README.md)、Sources/Capture.swift、Sources/Archive.swift、src/meeting/supervisor.js、src/meeting/protocol.js |
| Windows 对应实现 | native/audio-capture-helper/、src/platform/windows-text-input.js、src/win-hotkey-helper.ps1 |
| 会议实时与悬浮窗 | src/meeting/realtime/、src/renderer/live-meeting-ui.js、live-meeting.css、meeting-preview.js、src/settings/meeting-window.js |
| 文件导入与页面 | src/meeting/import/、src/meeting/processing/、src/renderer/file-ui.js、file-workspace.css |
| 摘要生成与思维导图 | src/meeting/realtime/postprocess.js、src/meeting/processing/file-summary.js、src/renderer/summary-reader.js、src/meeting/summary-budget.js |
| ASR、请求协议及文本整理 | src/providers/voice-pipeline.js、src/providers/asr/、src/providers/cleaner/text-cleanup-method.js、src/providers/model-sdk-stream.js、src/providers/summary-request-policy.js |
| 供应商配置和模型能力 | src/settings/provider-connections.js、text-suppliers.js、connection-profiles.js、model-capabilities.js；src/providers/provider-model-catalog.js |
| 拖动/缩放/侧边栏 | src/renderer/app-shell.css、workspace-sidebars.js、workspace-sidebars.css、src/renderer/reading-layout.js |
| 更新、自启、隐私日志 | src/updater.js、src/platform/login-startup.js、src/runtime-log.js |
| 构建与发布 | package.json、scripts/build-audio-capture-helper.js、scripts/prepare-ffmpeg.js、build/entitlements.mac.plist、.github/workflows/platform.yml、release.yml |

不要因文件仍存在就恢复旧功能：analysis/、speaker-map、OSS/说话人分离组件以及 MEETING_STAGE_* 文档保留了历史兼容实现，当前主入口不提供旧会议工作台和说话人分离。

## 三条主链路

~~~text
短语音：全局快捷键 -> 捕获原输入目标 -> renderer 录音/实时预览
     -> 按所选 ASR 完成全文 -> Fast 或 Stable 表达整理
     -> 主进程平台适配 -> Mac helper --type-text PID -> 原生输入

实时会议：Swift 原生双轨归档 -> 持续读取已保存音频 -> ASR 实时/分段
       -> 有序确认文本与检查点 -> 独立 Markdown 自动保存
       -> 用户停止 -> 完整 WAV 收尾 -> 用户按需摘要/全音频复核

文件：导入任务 -> FFmpeg -> 本地归档 -> 分段 ASR 与原文
   -> 显式生成摘要 -> 与实时会议共用后处理/思维导图/正文 -> 导出
~~~

输入文本通过 UTF-8 stdin 传给 helper，不能放入 shell 字符串或日志。旧的 --paste-to-app 工具仍存在不代表自动输入应该恢复剪贴板写入。失败应展示结果供用户操作，不能伪报输入成功。

## Mac 开发启动

推荐使用与 CI 一致的 Node.js 22，以及 Xcode Command Line Tools（项目 Swift tools 5.9）。最低系统为 macOS 13，支持 arm64 与 x64。使用本机架构的 Node：Apple Silicon 不要在 Rosetta x64 Node 下拼装 arm64 helper/FFmpeg。

~~~bash
xcode-select --install
node --version
node -p "process.arch"
xcrun swift --version
npm ci
npm run check:secrets
npm run build:helper
npm run check:helper
npm run prepare:ffmpeg
npm run check:ffmpeg
npm run test:all
npm start
~~~

已有 Command Line Tools 时不需要重复安装。源码无预填 API Key，先在界面中配置自己的 ASR 及可选文本模型；没有 Key 也能构建、跑合成回归和验收大部分 UI。npm run check 仅检查环境变量，不代表所有 UI 中保存的供应商都不可用，不要将其当作必须通过的启动条件。

helper 构建产物位于 native/macos-audio-capture-helper/.build/release/audio-capture-helper。其 stdin/stdout 是逐行 JSON 协议，协议版本 1、helper 版本 0.2.0。stdout 不得混入调试文本；需要诊断时使用受控 stderr 或脱敏事件。

## 打包与架构

~~~bash
# Apple Silicon 本机
OVI_TARGET_ARCH=arm64 CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac

# Intel 本机，另选匹配架构的机器执行
OVI_TARGET_ARCH=x64 CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
~~~

两条命令是不同架构机器各自运行，不是在一台机器上先后交叉构建。OVI_TARGET_ARCH 必须匹配 process.arch。输出在 dist/，含对应架构 DMG、ZIP、ZIP blockmap、更新清单和校验和。构建脚本不会自行发布，推 v* 标签才会触发正式发布流程。

先用源码验证逻辑，再将打包 app 放入“应用程序”目录，验证最终身份下的授权、启动、输入和更新。不要把开发时的 Terminal/Electron 权限当作发布 app 或嵌套 helper 已获授权。

## 权限与 Mac 平台边界

- 短语音麦克风与长会议原生采集是不同入口，都要验证。麦克风采集不能导致腾讯会议等应用失去输入；与真实会议软件同时测试。
- 仅系统音频使用 ScreenCaptureKit，不创建麦克风引擎，不应该请求麦克风权限。Mac 系统音源不是 Windows 硬件输出端点，不能直接复用设备枚举假设。
- 直接输入、前台目标与光标几何由辅助功能权限支持。没有权限时定位可回退，输入失败必须清晰展示；拒绝权限不应崩溃，也不应输入到错误窗口。
- 宿主 app 与 helper 可能拥有不同 TCC 权限归属。屏幕录制重新授权可能需要重启；分别验证拒绝、撤销、重新授权及替换 app 后的状态。
- 无边框窗口依靠原生可拖动区域支持三指拖动；可点击控件、可选正文和边缘缩放需要正确排除。不要为拖动开启全窗口鼠标穿透或禁用所有文本选择。

## 音频、状态及隐私底线

Mac 默认用户目录为 ~/Library/Application Support/open-voice-input；Windows 为 %APPDATA%/open-voice-input。此目录包含 settings.json、open-voice-input.log、识别历史、统计及 meeting-sessions，不能打包发给他人或加入仓库。

会议会话内的 audio/microphone/ 与 audio/system/ 保留原生 PCM、索引及日志。完整 WAV 是派生产物；ASR 上传的时间/大小上限只能影响上传片段，不能裁剪本地音频。暂停不伪造静音，保留时间空洞信息；停止需封存尾段。

录音、ASR 网络、Markdown 自动保存是三条独立工作。默认自动保存为 30 秒，用户可改；ASR 连接轮换或失败不应停止本地录音或热保存。实时草稿不可混入确认文本；明确截断的输出要恢复拆分重试，不能默默显示完成。

会后摘要为显式任务，在主进程/服务继续，切页不取消。生成结果单独保存，不改写原文；重试复用成功检查点。不要通过固定缩小最大输出来掩盖模型能力/协议错误，也不要把所有模型上下文写死为一个值。

凭证按选定供应商/模型解析；ASR、MiMo 复核和文本整理不能互相借用 URL/Key。日志不要输出配置对象、认证头、请求正文、输入框内容或供应商响应正文。安全扫描是辅助检查，不等于所有隐私风险已被自动识别。

## 测试策略

每个修复先添加或调整能验证实际行为的针对性回归，再跑 npm run test:all 和敏感信息检查。浏览器/native 选项可能需要额外安装 Playwright；普通共享测试不会自动替你完成真实输入或采集验收。

| 关注点 | 现有脚本 |
| --- | --- |
| 跨平台 helper 与生命周期 | scripts/test-platform.js、test-meeting-system-capture.js、test-meeting-native-system.js |
| 短语音路由、快捷键、预览 | test-settings-shortcuts.js、test-dictation-placement.js、test-dictation-preview.js、test-qwen-short-streaming.js |
| 直接输入、工作区快捷键 | test-direct-text-input.js、test-hotkey-workspace.js；其中 --native / --electron 的真实输入/按键部分是 Windows 专用，不能宣称在 Mac 已验证 |
| 窗口与布局 | test-window-motion.js、test-window-resize-contract.js、test-meeting-transparent-preview.js、test-file-workspace-ui.js |
| 会议录音/确认顺序/恢复 | test-meeting-realtime.js、test-meeting-streaming-integration.js、test-asr-segment-recovery.js |
| 摘要/后台处理/供应商隔离 | test-meeting-file-summary.js、test-summary-background.js、test-summary-stability.js、test-provider-role-isolation.js |
| 登录项、更新与设置 | test-login-startup.js、test-updater.js、test-settings-workspace.js、test-supplier-manager.js |

测试环境使用临时 userData、合成音频和 mock 请求，避免覆盖开发者真实配置。真实 API 只做有界验证并记录模型 ID、协议和脱敏错误，不把 Key 和响应附进 PR。硬件清单见 [MACOS_ACCEPTANCE.md](MACOS_ACCEPTANCE.md)。

## 已知资料差异

旧 README 的“自动复制剪贴板”“粘贴失败仍计成功”、独立校订步骤，以及早期会议阅读区拖动条描述并非全部适用于 v0.4.25。摘要现在采用共享后处理与连贯正文，独立校订结果主要作为旧历史兼容；页面大阅读区随窗口自适应，侧边栏可折叠调宽，小窗仍有自己的显示偏好。

优先级为：本次需求与 AGENTS.md -> 当前源码与测试 -> 最新发布说明 -> 旧 README/阶段设计。文档矛盾要记录或修正文档，不能反过来改坏已经确认的行为。

## 协作与发布约定

1. 从最新 main 拉取，使用 codex/macos-* 分支；每个 PR 解决一个可验收问题，说明影响范围和 Windows 风险。
2. 共享服务/界面保持一份实现，Mac 差异限制在平台层及 Swift helper。不要复制整套 Windows 业务或大规模重排 main.js 来完成小修复。
3. PR 写清设备、macOS、是否打包版、授权状态、复现步骤、根因、回归结果及剩余限制。未通过真机项应明确标注，诊断截图和真实音频不提交到 Git。
4. .github/workflows/platform.yml 在 PR 上检查 Ubuntu 子集、Windows x64、Mac x64/arm64；通过后由维护者合并。文档变更推 main 不一定触发路径过滤后的平台 CI，需要时手动运行。
5. 当前协作只承接 Mac；不改 Windows 专用代码或 `release.yml`。Mac 发布由维护者协调版本号和锁文件，准备 `docs/releases/macOS-v版本.md`，再按 [MACOS_RELEASE.md](MACOS_RELEASE.md) 使用 `macos-v*` 标签和独立更新源。原 `v*` 全平台流程仍由原维护者管理；不要用 Mac 修复触发它，也不要用个人测试标签触发生产发布。
6. 两位开发者同时工作时先对齐改动文件；每次 PR 合并后更新 main，避免共享设置结构和 IPC 契约长期分叉。

## 如何邀请朋友进入 GitHub 仓库

仓库是个人账号 liuniang3 名下的 public 仓库。维护者打开仓库 Settings -> Collaborators -> Add people，输入朋友的 GitHub 用户名，核对账号并发送邀请。朋友通过邮件或 GitHub 通知接受邀请后即可作为 collaborator 参与。

协作者对个人仓库有写入权限，并不只能改 Mac 目录。建议双方约定独立分支 + Pull Request，必要时给 main 设置规则要求 PR 和 CI。没有写入权限时也可以 fork 后发 PR。现在只整理交接包，没有代你发送任何邀请或修改仓库权限。

- [邀请协作者的 GitHub 官方说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/inviting-collaborators-to-a-personal-repository)
- [个人仓库权限说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/permission-levels-for-a-personal-account-repository)
