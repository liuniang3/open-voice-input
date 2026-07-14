# Open Voice Input

一个支持可插拔 ASR 供应商和可选 LLM 文本清理的 Windows 语音输入助手。

Open Voice Input 目前是 Electron MVP，不是真正的 Windows 输入法驱动。它会录制语音，通过用户选择的 ASR 供应商转写文本，再按需调用文本模型清理口头词、重复片段和标点，最后写入剪贴板，并尝试粘贴到之前光标所在的应用里。

英文文档见：[README.md](README.md)

## 当前版本更新

- 第一阶段已改为可插拔 ASR：优先适配专用 `mimo-v2.5-asr`，并支持 Qwen3-ASR 和 Fun-ASR。
- Qwen3-ASR 与 Fun-ASR 支持 WebSocket 实时预览；MiMo 使用周期性音频片段预览，最终结果始终由完整录音重新转写。
- `Stable` 模式将原始 ASR 文本交给 MiMo 或 OpenAI 兼容小模型进行口头词、重复片段和标点清理；`Fast` 模式只执行 ASR。
- 设置窗口已按工作方式、输入设备、ASR、文本清理和通用凭证重新分区，并支持自定义麦克风、模型、API 地址和快捷键。
- 新增 Windows x64 安装版、单文件便携版、GitHub Release 自动构建和 SHA-256 校验。
- 构建过程不会打包 `.env` 或本机用户设置，并会在生成发布包前扫描疑似真实 API Key。

## 推荐配置

当前项目对小米 MiMo V2.5 系列的适配度最好。如果选择第一步语音后端，推荐优先使用 `mimo-v2.5-asr` 作为专用 ASR 模型。项目也支持 Qwen3-ASR 和 Fun-ASR，但 MiMo 的普通 API 地址、流式返回解析、请求链路和本地兜底清理规则目前适配得最充分。

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
- 本地兜底清理常见口头词、重复片段和提示词泄漏式输出

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

- Windows
- Node.js 20 或更新版本
- npm

安装依赖：

```powershell
npm install
```

可选环境变量文件：

```powershell
Copy-Item .env.example .env
```

你可以在设置界面填写 Key，也可以使用环境变量：

```text
MIMO_API_KEY
MIMO_BASE_URL
DASHSCOPE_API_KEY
QWEN_ASR_API_KEY
FUN_ASR_API_KEY
CLEANER_API_KEY
CLEANER_BASE_URL
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

## 使用

1. 启动程序。
2. 右键任务栏托盘图标，打开 `设置`。
3. 设置 ASR 供应商、文本清理供应商、API 凭证、麦克风和全局快捷键。
4. 按全局快捷键呼出录音窗口。
5. 悬浮窗显示录音或实时转写时开始说话。
6. 按 `Enter` 结束录音。
7. 程序会把最终文本写入剪贴板，并尝试粘贴到之前光标所在位置。

默认全局快捷键：`Ctrl+Alt+M`。

## 供应商

ASR 供应商：

- `MiMo`：默认使用官方 `mimo-v2.5-asr` 专用 ASR 模型，支持普通 MiMo API 地址和流式返回解析，是目前本项目适配度最高的第一步语音后端。
- `Qwen3-ASR`：通过 DashScope/OpenAI 兼容配置接入专用 ASR，支持非实时和实时模式。
- `Fun-ASR`：通过 DashScope 接入专用 ASR。本地麦克风录音使用 WebSocket 实时协议；公网音频 URL 可走官方 REST 批处理。

文本清理供应商：

- `MiMo`：通过 MiMo 聊天模型清理文本。
- `OpenAI 兼容接口`：通过任意兼容聊天接口清理文本。第二步推荐使用 GPT-5.4 mini 或其他小模型。

## 转写模式

`Fast` 模式只执行 ASR。延迟更低，适合 ASR 模型本身已经足够干净的情况。

`Stable` 模式执行两步：

1. ASR 供应商返回原始转写文本。
2. 文本清理供应商删除口头词、合并重复片段并补标点。

每次录音都会使用录音开始时锁定的设置快照，因此录音处理中途修改设置只会影响下一次录音。

实时模式中的文字只作为录音过程中的预览。Qwen3-ASR 和 Fun-ASR 使用供应商的实时 WebSocket；MiMo `mimo-v2.5-asr` 目前按官方文件式接口做周期性片段预览，并不是真正的低延迟 WebSocket 实时识别。按 `Enter` 结束录音后，程序会用同一段完整录音重新生成最终转写；如果当前是 `Stable` 模式，最终转写还会继续进入第二步文本清理。这样可以减少实时分段、短暂停顿和供应商临时标点对最终输入结果的影响。

## 隐私

程序只上传本次录音和用户主动填写的短上下文到配置的供应商端点。它不会读取整屏内容，也不会自动上传剪贴板内容。

如果在设置中保存 API Key，Key 会存放在 Electron 用户数据目录，不会进入程序安装包。公开仓库、演示或交给他人使用时，建议使用环境变量或本地 `.env`，不要把真实 Key 提交到 Git。

运行日志路径：

```text
%APPDATA%\open-voice-input\open-voice-input.log
```

## 当前缺点

- 这不是真正的 Windows IME，只是全局语音输入助手。它依赖剪贴板和粘贴动作，部分软件可能拦截、延迟或拒绝粘贴。
- 焦点恢复和自动粘贴受目标应用、管理员权限窗口、远程桌面、浏览器输入策略和 Windows 安全策略影响，不保证所有场景都成功。
- 实时 ASR 质量受麦克风、网络延迟、供应商行为和模型版本影响。
- 如果第一步 ASR 已经听错，第二步文本清理只能整理已有文本，不能恢复没有听准的内容。
- 口头词和重复词清理仍有启发式规则，可能漏删“呃、嗯、就是”等填充词，也可能误删用户本来想保留的重复表达。
- 目前没有自动更新和代码签名。未签名的发布版可能触发 Windows SmartScreen，公开分发时需要用户手动确认运行。

## 许可证

MIT
