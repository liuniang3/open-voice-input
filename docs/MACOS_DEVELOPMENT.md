# macOS 开发接管记录

接管日期：2026-10-20（Asia/Shanghai）。本页用于后续开发恢复上下文；完整功能与约束见 `MACOS_HANDOFF.md`，真机验收见 `MACOS_ACCEPTANCE.md`。

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
