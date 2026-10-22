# macOS 开发接管记录

接管日期：2026-10-20（Asia/Shanghai）。本页用于后续开发恢复上下文；完整功能与约束见 `MACOS_HANDOFF.md`，真机验收见 `MACOS_ACCEPTANCE.md`。

## 2026-10-22：Mac 版独立更新通道（未发布）

用户明确本协作只接受 Mac 部分。Windows 专用实现和现有 `release.yml` 保持原样；共享修复继续做回归检查，不代表发布 Windows。两项会议修复的上一提交 `e9b44ee` 已通过 Ubuntu、Windows x64、Mac x64/arm64 全部 CI（run `39778370771`）；本项的新提交仍以 PR 最新检查为准。

旧 Mac 更新器虽然按架构读取清单，仍先查询 GitHub 全局 latest，无法独立发布 Mac 更新。现在仅在 `darwin` 路由到 `src/platform/macos-updates.js` 的固定 GenericProvider 源，继续区分 x64/arm64、禁止降级，并保留未签名安装包的手动打开与安装前任务保护。Mac 打包配置同步写入相同更新源；Windows 的 provider、配置和发布行为保持原样。

新增 `release-macos.yml`，只响应 `macos-v*`，构建 Mac 两架构；两端成功并校验版本、架构、SHA-256、SHA-512、尺寸和 blockmap 后，再发布 Mac 包及独立清单。版本 Release 与 `macos-updates` 通道都使用 GitHub prerelease 和 `latest=false`，避免占用 Windows 的全局 stable/latest。独立清单包含具体 Mac 改进说明和带版本的绝对下载地址，旧任务不能回退通道或替换相同版本。完整流程与首次手动迁移限制见 [MACOS_RELEASE.md](MACOS_RELEASE.md)。

本轮验证：

- 新通道回归在旧代码中失败，证实旧 Mac 会查询全局 release feed；修复后 13 项通过，使用实际 electron-updater Provider 与模拟 HTTP 响应检查两架构 Mac 路由、Windows 原路径、版本和说明；另覆盖包校验、错误架构/Windows 包拒绝、两清单先验证后写入和防回退。
- 完整共享回归通过 77/77 脚本，包含前两项会议修复；敏感信息扫描、skill 校验和差异检查通过。
- Mac arm64 未签名开发 `.app` 和 ZIP/ZIP blockmap 均构建成功。分发包中的 `app-update.yml` 指向独立 Mac 源；打包更新器、平台配置、会议预览和摘要 UI 与源码一致，实际 ZIP 的 SHA-512、尺寸、版本及架构清单核对通过。

新工作流只做静态配置和合成包验证，尚未通过正式标签执行；未创建 Mac 版本 Release、通道或正式标签，也未运行线上下载/安装验收。版本仍为 0.4.25 开发版；旧 Mac 安装版首次接入须手动安装，不能自动迁移。真实阿里云长会议、TCC 权限、录音和文字输入仍按真机清单验收。

## 2026-10-22：Mac 版会议摘要模型设置记忆（未发布）

本项继续在 `codex/macos-meeting-resume-preview` 分支和 PR #1 中维护。用户确认问题位于会议页左下角的“摘要模型”，对应文本供应商的 `summary` 槽位。

旧页面的模型切换事件仅重新渲染，没有保存偏好；重新打开页面时会再次读取旧默认值。共享会议界面现使用 `TextSupplierUi.applySelection` 保存供应商与模型配对，同时同步兼容字段 `meetingAnalysisModel`。保存前读取最新设置，保持独立的 `cleanup` 表达整理选择；写入只包含模型标识，不复制供应商连接或凭证。失败时显示错误并恢复已保存的选项。

新会议启动时还会用主进程返回的最新设置刷新摘要模型，避免沿用页面加载时的默认值。切换偏好不生成摘要；已有原文和摘要保持独立，生成仍须显式点击。修改限于 `src/renderer/live-meeting-ui.js`，两平台共用。

本轮新加四个回归场景，在旧代码中全部失败，修复后会议 UI 27/27 项通过；覆盖重新打开、新会议、同名模型的不同供应商、最新表达整理偏好保持、保存失败与重试。完整 `npm run test:all` 再次通过 76/76 脚本，包含上一项暂停预览修复的回归。Mac arm64 开发应用重新构建成功，包内会议 UI 和预览源码与当前文件一致；远端 Windows / Mac 双架构结果以 PR 最新检查为准。真实供应商调用和真实硬件验收仍未执行，应用保持 0.4.25 开发版本且未正式发布。

## 2026-10-22：Mac 版实时会议暂停恢复修复（未发布）

开发分支：`codex/macos-meeting-resume-preview`。修改基于接管提交 `c7d71de`；应用版本仍为 0.4.25，正式版本号、合并和发布标签由维护者统一。本机已安装并校验 `$open-voice-input-dev` skill；以后接管仍应先读取本页、仓库规则和实际 Git 状态。

### 问题与修复

用户反馈阿里云实时会议长时间录制后暂停，再继续时预览没有新文字。原生归档保留暂停时间空洞；完整 WAV 以零样本表达这段时间。旧预览从暂停前游标继续，以接近实时的速率上传全部空洞，导致后续讲话积压，停止时还可能触发预览收尾超时。合成测试跨过两次十分钟连接轮换后暂停 562 秒，旧代码复现了这段多余上传。

共享预览服务现在在暂停恢复后，以每次不超过 40 秒的有界读取跳过连续的精确零样本；遇到第一个非零样本即停止跳过。跳过区间单独保存检查点且不算作已上传，后续 ASR 窗口从完整时间轴中的真实位置开始。原生 PCM、完整 WAV、普通静音处理和自动保存流程保持原有职责；最轻的非零声音也完整上传。

若双轨迟到音频覆盖跳过区间，原有归档失效机制将其标记为失败并允许显式重试。读取期间的取消同样保留可重试区间，不会让过期读取把失败检查点重新标成完成。实现位于 `src/meeting/realtime/preview.js`，Windows 与 macOS 共用，未修改 Swift/Rust 采集实现。

### 本轮实际验证

| 检查 | 2026-10-22 结果 |
| --- | --- |
| 旧代码复现 | 新长暂停回归在旧实现失败：上传了 562 秒空白及后续声音；修复后仅上传后续声音 |
| 预览回归 | 36 项通过，覆盖长连接轮换、长暂停、重复暂停、分批零样本、最小非零声音、迟到音频失效与重试、读取取消及重启恢复 |
| 会议集成 | 15/15 通过；恢复后草稿和确认文字可达，原生 PCM 不变、完整 WAV 保留时间空洞，时间戳准确 |
| 完整共享回归 | `npm run test:all`：76/76 脚本通过，包含阿里协议、平台路由及 Mac 原生合成归档/暂停检查 |
| 安全与差异检查 | Mac 构建前敏感信息扫描通过；提交前另执行敏感信息与差异检查 |
| Mac arm64 开发包 | `build:dir:mac` 成功，未签名 `.app`；打包 JS 与修复源码一致，Electron/helper/FFmpeg 均为 arm64，helper 与 FFmpeg 的 SHA-256 匹配构建输入，打包二进制探测通过 |
| Windows / Mac x64 / Mac arm64 CI | 随 PR 运行，以 PR 最新检查为准；本机结果不代表远端矩阵已通过 |
| 真实供应商与硬件 | 本轮未运行真实阿里云 API、真实采集或权限/文字输入验收；尚需按验收清单进行 30 分钟以上录制、暂停 8–10 分钟、恢复和双轨检查 |

开发包仍位于 `dist/mac-arm64/Open Voice Input.app`，未安装到“应用程序”，未生成正式 DMG/ZIP 或发布更新。历史会议中的失败区间不会被自动重新发送，可在停止后使用既有重试入口。

后续每次 Mac 更新都必须在标题和说明中写出 **Mac 版（macOS）**，列明具体改善及验证范围。本轮内容已写入 `CHANGELOG.md` 的未发布条目，真实硬件项在 `MACOS_ACCEPTANCE.md` 中继续保持未勾选。

## 仓库与基线

- 上游：`liuniang3/open-voice-input`。
- 交接源码：v0.4.25，`e595ff823476cc8d90e43a72b6bef20f87991a79`。
- 接管时远端 main 与交接源码相同，使用完整 Git 克隆保留历史。
- 交接包清单的 352 个文件 SHA-256 全部通过；额外的三份交接文档已从包中导入。
- 初始开发分支：`codex/macos-hardware-validation`。
- 本次先建立开发基线。原生功能修改应根据真机复现单独形成 PR。

## 已梳理的代码入口

| 责任 | 代码入口 | 开发时保持的边界 |
| --- | --- | --- |
| Electron 生命周期、窗口、快捷键与 IPC | `src/main.js`、`src/preload.js` | 页面与后台任务分离；避免为平台修复大规模重排主进程 |
| 共享界面 | `src/renderer/` | 普通 HTML/CSS/JavaScript；两平台共用 |
| 短语音 ASR 与表达整理 | `src/providers/voice-pipeline.js`、`src/providers/asr/`、`src/providers/cleaner/` | 按模型能力选择协议；每次请求持有自己的设置快照，凭证按角色隔离 |
| Mac 权限与直接输入适配 | `src/platform/macos.js` | Electron 权限预检，调用原生 helper；输入通过 stdin 传递，失败向上报告 |
| Mac 原生工具与 JSONL 分派 | `native/macos-audio-capture-helper/Sources/Main.swift` | 协议版本 1、helper 0.2.0；stdout 只承载协议或显式工具输出 |
| Mac 光标与输入框几何 | `native/macos-audio-capture-helper/Sources/InputContext.swift` | 查询几何，避免读取输入框内容；缺权限时允许定位回退 |
| Mac 原生采集 | `native/macos-audio-capture-helper/Sources/Capture.swift` | AVAudioEngine 麦克风与 ScreenCaptureKit 系统音频；仅系统模式不创建麦克风引擎 |
| 原生音频归档 | `native/macos-audio-capture-helper/Sources/Archive.swift` | 不可变 PCM、独立音轨、持久化索引与日志；暂停保留时间空洞 |
| helper 进程与会话管理 | `src/meeting/supervisor.js`、`src/meeting/index.js` | JSONL 命令与应答、超时、父进程退出及会话恢复 |
| 实时会议 | `src/meeting/realtime/` | 采集、ASR、Markdown 自动保存相互独立；草稿与确认文本分开 |
| 文件导入与摘要 | `src/meeting/import/`、`src/meeting/processing/file-summary.js`、`src/meeting/realtime/postprocess.js` | FFmpeg 只处理派生音频；摘要显式生成，不覆盖原文 |
| 打包与 CI | `package.json`、`scripts/run-electron-builder.js`、`.github/workflows/` | helper、Electron、FFmpeg 架构一致；Mac 与 Windows 都需回归 |

短语音流程是全局快捷键捕获目标应用、renderer 录音、ASR 与可选表达整理，再经主进程调用 `--type-text PID` 发送 Unicode 键盘事件。自动输入保持剪贴板原样。

实时会议先由原生 helper 保存音频，再由服务读取归档执行 ASR 和独立热保存，停止后封存完整音频。文件导入经 FFmpeg 形成归档，转写与摘要复用共享服务。不得把长会议保存能力缩减到供应商单次上传限制。

## 本机环境

| 字段 | 2026-10-20 接管结果 |
| --- | --- |
| 架构 | Apple Silicon / arm64 |
| macOS | 27.0，build 26A428 |
| Node | 22.23.3 / arm64；`.nvmrc` 记录该版本 |
| npm | 11.9.0 |
| Swift | Apple Swift 6.3.3，使用 Xcode Command Line Tools |
| Xcode 工具链 | 当前选择 Command Line Tools；本次未使用完整 Xcode |
| macOS SDK | 26.5（`xcrun --show-sdk-version`） |
| Electron | 39.8.9（项目锁定版本） |

系统默认 Node 是 24.14.0；本次验证显式使用独立 Node 22 环境。全局 npm 缓存存在旧权限问题，依赖安装改用独立缓存成功，无需修改全局权限。

## 本次检查结果

| 检查 | 实际结果 |
| --- | --- |
| 依赖安装 | `npm ci` 成功，安装 400 个包；使用独立 npm 缓存 |
| Swift release helper | arm64 编译成功 |
| helper 协议及架构 | `npm run check:helper` 通过 |
| FFmpeg | 准备与检查通过，arm64 |
| 敏感信息扫描 | 通过 |
| 完整共享回归 | `npm run test:all`：76/76 脚本通过 |
| Mac 原生合成检查 | Swift 归档、系统 PCM 暂停/继续/尾段、JSONL 协议、EOF 和父进程退出检查通过；未采集真实音频 |
| 应用打包 | `--dir --mac --arm64 --publish never` 成功，得到未签名的 0.4.25 `.app` |
| 打包资源检查 | Electron、helper、FFmpeg 均为 arm64；helper 协议和 FFmpeg 执行通过；原生资源与已验证输入的 SHA-256 一致 |
| GitHub 协作连接 | origin 已配置；分支推送预演通过，本次未执行实际推送 |
| Windows / Intel Mac CI | 本次未新建 PR 或运行远端 CI；交接文档中的既有 CI 结果仅作为历史记录 |
| 界面与真实硬件 | 本次未执行最终 `.app` 的 GUI、权限、真实采集或文字输入验收 |

开发应用位于仓库内 `dist/mac-arm64/Open Voice Input.app`；本次未生成 DMG/ZIP，也未执行安装、签名或公证。

Swift 6.3.3 编译时，`Capture.swift` 的 CoreAudio 设备名称读取产生一条 CFString 与 `UnsafeMutableRawPointer` 警告，编译未失败。该警告已记录，实际设备枚举行为留待针对性检查。

打包与合成测试不表示麦克风、屏幕音频、辅助功能或文字输入已通过真实使用验收；验收清单保持未勾选。

## 后续开发顺序

1. 先用打包后的 arm64 应用检查首次启动及三类权限，分别记录 Electron 宿主和 helper 的实际授权归属。
2. 验证短语音快捷键与目标应用恢复，在 TextEdit、浏览器和实际常用编辑器中测试中文、英文、emoji、长文本、换行与剪贴板保持。
3. 验证会议的麦克风、仅系统、双轨模式，检查暂停、尾段、完整音频与恢复；随后测试真实 ASR 的断线、连接轮换和长会议。
4. 根据实机复现做小范围修复；添加有意义的针对性回归，运行完整共享测试，再由 PR 执行 Windows x64、Mac x64/arm64 CI。
5. 权限与数据完整性稳定后，再处理多屏定位、动画、设备切换、签名、公证及更新体验。

Intel Mac、真实供应商请求和长期硬件稳定性需要各自的实测记录。保留验收清单中未完成项，避免用已有 CI 记录代替本机验证。

## 常用命令

先使用 `.nvmrc` 指定的 Node 版本，再在仓库根目录运行：

```sh
npm ci
npm run build:helper
npm run check:helper
npm run prepare:ffmpeg
npm run check:ffmpeg
npm run check:secrets
npm run test:all
npm start
```

Apple Silicon 开发包：

```sh
OVI_TARGET_ARCH=arm64 CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:dir:mac
```

需要 DMG/ZIP 时再执行 `npm run dist:mac`，保持相同架构和签名环境设置。构建脚本默认不发布。

协作采用独立分支和 PR。构建产物、密钥、个人设置、真实音频/转写及诊断截图均不进入 Git。不要直接推 main 或创建发布标签。
