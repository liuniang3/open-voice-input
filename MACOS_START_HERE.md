# macOS 共创接手入口

这份交接包用于帮助新的开发者及其 AI 接手 Open Voice Input 的 macOS 版本。

- 整理日期：2026-10-20（Asia/Shanghai）。
- 源码基线：v0.4.25，提交 e595ff823476cc8d90e43a72b6bef20f87991a79。
- 官方仓库：https://github.com/liuniang3/open-voice-input
- 包中包含源码与协作文档，不含依赖、构建产物、Git 历史、本机配置、密钥或用户录音。
- 这是可构建的源码交接包，不是可以直接安装的 Mac 应用。已构建安装包在 GitHub Releases。

## 先读哪些文件

1. [AGENTS.md](AGENTS.md)：必须遵守的双平台、音频保存、隐私与协作约束。
2. [macOS 共创说明](docs/MACOS_HANDOFF.md)：当前功能、架构、开发命令、已知限制、协作与发布流程。
3. [macOS 真机验收清单](docs/MACOS_ACCEPTANCE.md)：需要朋友在 Mac 上逐项验证的项目和结果模板。
4. [v0.4.25 更新日志](docs/releases/v0.4.25.md)：这次交接所依据的最新已发布行为。
5. [macOS 开发接管记录](docs/MACOS_DEVELOPMENT.md)：接管后的实际改动、验证与剩余事项。后续修复以此和当前源码恢复上下文。

本机 Codex 可使用 `$open-voice-input-dev` 接管开发。Mac 版每次更新的标题和说明必须明确写出“Mac 版（macOS）”及具体改善；尚未发布的修复先记入 `CHANGELOG.md`，正式版本号由维护者统一。

当前协作只承接 Mac 部分，不改 Windows 专用实现或发布流程。Mac 独立更新采用 `macos-v*` 标签和 `macos-updates` 更新源；发布前阅读 [Mac 发布流程](docs/MACOS_RELEASE.md)。旧 Mac 安装版首次切换需要手动安装接入独立通道的版本。

旧 README 和阶段文档中存在过时的剪贴板输入、独立校订与说话人分离描述。不要据此恢复已经移除的功能；遇到冲突时以当前源码、测试及上述交接说明为依据。

## 可以直接交给 AI 的说明

将下面这段话交给朋友使用的 AI，并把工作目录设为源码根目录：

> 你正在接手 Open Voice Input 的 macOS 共创工作。先阅读 AGENTS.md、MACOS_START_HERE.md、docs/MACOS_HANDOFF.md、docs/MACOS_ACCEPTANCE.md 和 docs/releases/v0.4.25.md，再阅读相关源码。
>
> 第一阶段先建立当前 Mac 的测试基线，记录芯片架构、macOS、Node、Xcode/Swift 版本，安装依赖、构建并检查原生 helper、准备 FFmpeg、运行共享测试。当前已经有 Mac 实现，不要重新写一个独立应用或另做一套业务逻辑。
>
> 优先验证打包后的应用：麦克风/屏幕音频/辅助功能权限、语音快捷键、前台与托盘状态、无剪贴板直接输入、光标附近弹窗、实时会议的三种音源和完整音频保存。源码启动与最终应用的系统权限归属可能不同，必须分别记录。
>
> 根据真机复现来修复问题。共享行为在共享模块修复，平台差异放进 src/platform/ 或原生 helper；每个修复都考虑 Windows 回归。修改前检查 git status，保护现有编辑，使用独立 codex/ 分支并提交 PR，不直接推送 main、不创建发布标签，除非维护者另行授权。
>
> 不要记录或提交 API Key、个人配置、真实音频/转写或未脱敏响应。真实 API 测试使用开发者自己在本机配置的凭证，先用合成数据测试，明确区分 mock、CI 与真机实测。未经授权不调用其他外部模型；并发约束以 AGENTS.md 为准。
>
> 长会议的原生音频不可改写或截短；ASR 分段、30 秒默认 Markdown 自动保存及显式会后处理相互独立。保持原文有序、草稿与确认文本分离、重试检查点可恢复。不要为了修复 Mac 改坏 Windows 或覆盖历史数据。
>
> 最后提交简洁报告：复现条件、根因、改动文件、测试结果、尚未验收的项目，以及 Windows/macOS CI 链接。没有真实硬件证据的项目标为未验证，不能用打包成功代替功能验收。

## 建议采用哪份源码

正式协作建议从官方仓库克隆并新建分支，方便提交 PR：

~~~bash
git clone https://github.com/liuniang3/open-voice-input.git
cd open-voice-input
git switch -c codex/macos-hardware-validation
~~~

把本包中新增的这三个交接文档放入克隆目录的相同位置即可。克隆得到的是当时最新 main；若已经超出本包基线，先检查差异，再按最新代码验收。若只想复现交接基线，可从 v0.4.25 新建测试分支。

直接解压也可以安装依赖和构建，但其中没有 .git，不能当作可直接推送的 Git 工作区。不要在此目录重新初始化仓库并覆盖远端历史。

## 包的完整性

压缩包外的 SHA256SUMS.txt 校验 ZIP；包内 HANDOFF_MANIFEST.json 列出每个文件的路径、字节数和 SHA-256。本次交接新增文档与发布源码分开列出；源码基线不包含这些新文档对应的 Git 提交。
